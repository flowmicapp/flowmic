// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:register / pc:reconnect /
//     pc:refresh-code / pc:release-mobile / pc:list-mobiles)
//     ⚠️ this line used to read 「acks = PcRegisterAck / PcReconnectAck /
//     PcListMobilesAck」. Those TS interfaces were deleted on 2026-07-31 (RV-36):
//     nothing ever imported them, so the compiler never checked them against the
//     objects below, and they had already drifted three fields behind the wire
//     (expires_in_ms / connectedMobiles / schema_ver). The ack shapes' only real
//     guard is the `safeAck({...})` literals in this file plus the tests that
//     read them (machine-identity / pc-list-mobiles / pairing-reuse). Do not
//     re-add a parallel declaration nothing consumes — if these acks need a type,
//     it has to be one the emitter itself parses.
//   docs/rebuild/05-DATA-MODEL.md §1/§7 (pc_devices row, device_token)
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §7.3 (absence reason: write
//     site ② is the pc:reconnect account gate; both join legs erase)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-8 (paired-phones table)
//   *** HUMAN-AUDIT SENSITIVE (auth/pairing) — reviewable in isolation ***
//
// The PC side of pairing. register/reconnect flows connect with NO token (auth
// middleware leaves auth=null), obtain their token here, and the handler stamps
// socket.data.auth + roomUuid and joins the RoomStore. Every failure is a
// whitelisted error code (errorPayload) — no bare throw crosses the wire.
//
// Account identity: standalone is single-user ('default', seeded at boot). A
// saas JWT→userId resolution is a later card (this handler reads a fixed userId
// injected by bootstrap so the seam is explicit, not hardcoded here).

import type { Server, Socket } from 'socket.io';
import { PROTOCOL_SCHEMA_VERSION, safeParseEvent } from '@flowmic/protocol';
import type { Registry } from '../../room/registry';
import type { RoomStore } from '../../room/store';
import { errorPayload } from '../../errors';
import { probeMobileLiveness, type LivenessDeps } from '../../room/liveness';
import { pcAbsenceReasons } from '../../room/pc-absence';
import type { ReleaseSuppression } from '../../room/release-suppression';
import { log } from '../../log';
import type { WriterOnlyGuard } from '../../node/writer-only';
import type { TokenReadThroughSeam } from '../../auth/middleware';
import { logAuthRefusal } from '../../auth/refusal-log';
import { getAccount, getAccountAuthError, getAuth, safeAck, setAuth, setRoomUuid, type ActingIdentity } from '../wire';
import { registerPcListMobilesHandler } from './pc-list-mobiles';

export interface PcHandlerDeps {
  io: Server;
  registry: Registry;
  store: RoomStore<Socket>;
  /** Acting user for this connection: standalone → {userId:'default'}; saas →
   *  the handshake-JWT sub / in-session login identity, or the fail-loud code
   *  when a saas socket is unauthenticated (never a silent 'default' fallback). */
  resolveActingUser(socket: Socket): ActingIdentity;
  /** GA-07: the pc:reconnect liveness-probe seam (budget + timer + nonce).
   *  Omitted in production → 04 §3.2 defaults (1.5 s, real timers). Injected by
   *  tests so the zombie path runs with no real sleep. */
  /**
   * 2026-08-29 multi-node — record that this PC is now reachable through THIS
   * node (`pc_devices.home_node`). Called on BOTH admission legs, register and
   * reconnect, because a PC that only ever reconnects would otherwise never be
   * located and its phone would be sent to the wrong node forever.
   *
   * 🔴 UNCONDITIONAL, not `if (changed)`. A PC that moves from srvny to srvjp
   * has a home_node that is stale rather than absent, and「only write when it is
   * empty」 is how a phone ends up dialling the node its PC left. See
   * pc.repo.ts setHomeNode.
   *
   * Optional because a single-node deployment has no node to name — absent means
   * 「there is no such fact here」, never 「skip recording it」.
   */
  stampHomeNode?: (pcId: string) => void;
  liveness?: LivenessDeps;
  /** GA-08: the shared reconnect-suppression window "disconnect" writes and
   *  `mobile:reconnect` reads. Omitted → a release still disconnects, but the
   *  phone may return immediately (the pre-GA-08 behaviour). Production wires the
   *  ONE instance bootstrap creates; tests inject a fake-clock instance. */
  suppression?: ReleaseSuppression;
  /**
   * 2026-08-29 multi-node — 「must this node refuse a writer-only event?」
   *
   * 🔴 REQUIRED, NEVER OPTIONAL, and for the reason `restriction` in
   * MobileHandlerDeps spells out: an `?` here makes a forgotten wiring into a
   * silently disabled gate with a green test suite, and the gate this one
   * disables is the one standing between a user and a registration that is
   * accepted and then erased. A node that can write passes `NODE_CAN_WRITE`,
   * which is a decision anyone reading bootstrap can see was made.
   */
  writerOnly: WriterOnlyGuard;
  /**
   * 2026-08-31 — REPLICA ONLY: ask the writer to mint this PC's pairing code.
   *
   * Optional, and here the `?` is honest rather than dangerous (contrast
   * `writerOnly` above): absent means「there is nobody to ask」, which is the
   * truth on a writer and on every single-node deployment, and the code path it
   * gates FALLS BACK TO THE EXISTING REFUSAL. A forgotten wiring therefore
   * restores 2026-08-30's behaviour — visibly broken in the way that was already
   * documented — rather than silently disabling a gate.
   */
  mintCodeOnWriter?: (pcId: string) => Promise<{ short_code: string; expires_in_ms: number | null } | null>;
  /**
   * 2026-09-02 (B1) — the SAME handshake read-through `mobile:reconnect` has
   * had since Z4, missing here. `pc:reconnect` resolved its token with a
   * LOCAL-ONLY `registry.reconnectPc` — the exact asymmetry this repo's own
   * `TokenReadThroughSeam` doc calls out by name: "`pc_devices` has the same
   * gap whenever a PC re-selects a node it has not been on."
   *
   * 🔴 WHY THE HANDSHAKE'S OWN COPY (authMiddleware) WAS NOT ENOUGH: a PC that
   * just REGISTERED on the writer reconnects with a token minted seconds ago,
   * on a socket admitted before this event even fires — the handshake ran its
   * read-through against a database state from before the row existed. And a
   * replication pull racing us can erase a row the handshake DID land, between
   * that middleware tick and this one. Both leave `registry.reconnectPc` with a
   * local miss that is a MAYBE, not a NO.
   *
   * ⚠️ THE COST OF NOT HAVING THIS ONE, MEASURED: desktop `pairing.rs` treats
   * this event's `AUTH_TOKEN_INVALID` as terminal — `clear_token` (destroying a
   * device credential replication had simply not delivered yet) followed by
   * `emit_register`, which a replica refuses by name (`NODE_IS_REPLICA`,
   * writerOnly above), landing the desktop in `cloud_err_wrong_node` until the
   * next redial. A mobile hitting the identical race gets one retry and a
   * session; a PC hitting it loses its credential outright.
   *
   * Optional for the same reason as `mintCodeOnWriter`: absent means "there is
   * nobody to ask" (the writer, every single-node deployment), and the miss
   * falls back to today's refusal — a forgotten wiring restores the
   * already-documented gap rather than silently disabling a gate.
   */
  resolveTokenOnWriter?: TokenReadThroughSeam;
  /**
   * 2026-09-02 (WP-6, B5) — REPLICA ONLY: ask the writer to perform a
   * `pc:release-mobile` this node cannot (node/writer-only.ts
   * `registry.revokeMobile` row — "a revoke that comes back", the same class
   * of defect `mintCodeOnWriter` closed for the code mint).
   *
   * Before this existed a PC on a replica could never disconnect or revoke any
   * phone: PC_BUSY eviction was unavailable, and a revoked phone's row would be
   * restored by the next replication pull while the desktop showed success.
   *
   * Optional for the same reason `mintCodeOnWriter` is: absent means "there is
   * nobody to ask" (the writer, every single-node deployment), and the caller
   * falls back to the honest `NODE_IS_REPLICA` refusal — a forgotten wiring
   * restores the already-documented gap rather than silently disabling a gate.
   *
   * The result carries `released_ids` — which pairings the WRITER actually
   * touched — so THIS node can still do the one thing only it can do: find and
   * disconnect a live local socket for any of them (node/forward-sync.ts never
   * touches sockets; it cannot see a room that lives in this process).
   */
  forwardReleaseMobile?: (req: {
    pc_id: string;
    user_id: string;
    room_uuid: string;
    revoke: boolean;
    reason: 'manual' | 'busy';
    mobile_id?: string;
  }) => Promise<
    | { status: 'ok'; result: { target_ids: string[]; revoke: boolean; revoked_count: number; suppressed_ms: number } }
    | { status: 'refused'; error: string }
  >;
  /** OPS-1 (2026-09-02) — this node's id, purely for the auth-refusal log
   *  lines below (auth/refusal-log.ts). Same value bootstrap.ts already
   *  computes as `socketNodeId` for `registerMobileHandlers`; absent on a
   *  single-node deployment. */
  nodeId?: string;
}

export function registerPcHandlers(socket: Socket, deps: PcHandlerDeps): void {
  const { registry, store } = deps;

  // GA-07 + GA-26 — the roster seed. ONE implementation, called from BOTH
  // pairing legs (register and reconnect), because 0.2.1 shipped two copies of
  // "what is this PC called" and only one of them ever got fixed: the copy nobody
  // updates is always the one running on the machine with the bug.
  //
  // `connectedMobiles` is the ACTIVELY CONFIRMED set (04 §3.2), never the raw
  // store snapshot. The snapshot is only a list of CANDIDATES: a force-stopped
  // phone survives in it for up to socket.io's 20 s pingTimeout, so seeding a
  // PC from it is exactly how a ghost phone gets counted. Each candidate is
  // asked to prove itself with sys:ping{nonce}; the ones that do not pong inside
  // the budget are evicted from the store, disconnected, and left OUT of the
  // answer. The ack is therefore delayed by at most the budget — a deliberate
  // trade: a slightly later truth beats an instant lie.
  //
  // Never rejects. A throw in here would mean a bug in the probe, and a PC left
  // without an ack is worse than one seeded conservatively empty.
  const confirmedMobiles = async (roomUuid: string): Promise<string[]> => {
    const candidates = (store.snapshot(roomUuid)?.mobile_ids ?? []).flatMap((mobile_id) => {
      const s = store.getMobile(roomUuid, mobile_id);
      return s ? [{ mobile_id, socket: s }] : [];
    });
    try {
      const { alive, dead } = await probeMobileLiveness(candidates, deps.liveness ?? {});
      for (const mobile_id of dead) {
        const zombie = store.getMobile(roomUuid, mobile_id);
        store.leaveMobile(roomUuid, mobile_id, zombie?.id);
        // Kill the socket too: an unproven peer must not be able to speak into
        // the room later as if it had been present all along. Its own disconnect
        // hook then finds nothing to remove (leaveMobile already returned true
        // here), so no phantom pc:mobile-left is emitted.
        zombie?.disconnect(true);
        log.warn('liveness: evicted unresponsive mobile', { room_uuid: roomUuid, mobile_id });
      }
      return alive;
    } catch (err) {
      log.error('liveness: probe failed', { room_uuid: roomUuid, err: String(err) });
      return [];
    }
  };

  // F-3 Fix#2 — CONSUME `joinPc`'s `previous`. Both legs below used to throw it
  // away, and that discard IS the defect: `RoomStore.joinPc` REPLACES the room's
  // PC slot, so the socket it hands back is left connected, authenticated, and
  // permanently deaf — every frame addressed to the room now goes to the new
  // owner, and nothing will ever be addressed to it again. W9 experiment (A)
  // measured that state 6/6 (last registrant owns the room; the loser stays
  // alive). It is the server half of F-3: the desktop's devices page says
  // "no phone connected currently" while a phone is connected and text is landing.
  //
  // WHY A DISCONNECT AND NOT A LOG OR A NEW EVENT — the three candidates:
  //   · log only: nothing the peer can act on ever changes. That is F-3's OWN
  //     shape (the desktop already writes 「No further CONNECTION frames will
  //     reach the UI」 and nobody consumes it); repeating it one layer up would
  //     produce a second sentence nobody reads.
  //   · a 「you were displaced」 event: needs a protocol slot (owner gate), and an
  //     unregistered event name is SILENTLY DISCARDED by every desktop already in
  //     the field — so it would change nothing out there for months.
  //   · a transport close: a true statement on the wire we already have — 「this
  //     link is over」. `connected === true` on a deaf socket is the lie; closing
  //     it makes the transport agree with the room. The peer's reconnect ladder
  //     and its RV-26 register watchdog are exactly the machinery already shipped
  //     to act on that fact, on every desktop version in the field.
  // It is also byte-for-byte what the MOBILE leg has done with the identical
  // `previous`, from the identical store, since GA-26 (mobile.handler
  // `joinAndNotify`): "the same fact handled two different ways" is a shape this repo has paid for.
  //
  // THE TWO LEGS DO NOT DIFFER, and that was checked rather than assumed. Both
  // resolve ONE pc_devices row (register by client_instance_id/machine_uid,
  // reconnect by token) and both join THAT row's room_uuid, so `previous` is
  // always an older session of the SAME machine in both. The one asymmetry —
  // registerPc may have just ROTATED device_token, leaving the displaced socket
  // holding a dead credential — argues for the same action, harder. So: ONE
  // implementation, called from both, for the reason `confirmedMobiles` above
  // gives verbatim — 0.2.1 shipped two copies of "what is this PC called" and only one
  // ever got fixed.
  //
  // 🔴 `previous.id === socket.id` IS NOT A DISPLACEMENT. A second register on
  // ONE live socket (the RV-26 register watchdog re-firing, or register followed
  // by reconnect on the same connection) would otherwise kill the very session
  // just admitted — before its ack was sent. Same guard as the mobile leg.
  //
  // FAILURE DIRECTION: never throws, and never reaches the caller's `try` — that
  // one answers the ack, and a failed disconnect must not turn a successful
  // registration into an error ack. If this whole function were skipped, the
  // result is exactly today's behaviour, which is the bar.
  //
  // KNOWN RESIDUAL (recorded, deliberately NOT given an invented recovery path):
  // if TWO genuinely live desktop sessions ever share one pc row, each will
  // reconnect and re-register, and they will trade the slot — the 「endless
  // re-register ping-pong」 registry.ts already names as the reason machine_uid
  // folds in the Windows user. Not observed; the log line below is its evidence (the
  // same two socket ids alternating at speed).
  const dropDisplacedPc = (roomUuid: string, previous: Socket | null, current: Socket): void => {
    if (previous === null || previous.id === current.id) return;
    try {
      log.warn('pc slot displaced — closing the previous session', {
        room_uuid: roomUuid,
        previous_socket_id: previous.id,
        socket_id: current.id,
      });
      previous.disconnect(true);
    } catch (err) {
      log.error('pc slot displacement: disconnect failed', { room_uuid: roomUuid, err: String(err) });
    }
  };

  socket.on('pc:register', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:register', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    // 🔴 BEFORE registerPc, which is EIGHT writes — including the short code this
    // PC is about to print on screen. On a replica all eight are erased by the
    // next pull and both ends report success; refusing by name is the difference
    // between a user who knows and a user who reads a pairing code that has
    // already stopped existing. node/writer-only.ts carries the measurement.
    const replica = deps.writerOnly();
    if (replica) return safeAck(ack, replica);
    // saas: an unauthenticated socket must NOT provision under the shared
    // 'default' user (F-2094 red line) — fail loud with the truthful code.
    const acting = deps.resolveActingUser(socket);
    if ('error' in acting) return safeAck(ack, { error: acting.error });
    try {
      const userId = acting.userId;
      const { pc, token } = registry.registerPc({
        device_name: parsed.data.device_name,
        user_id: userId,
        ...(parsed.data.client_instance_id !== undefined ? { client_instance_id: parsed.data.client_instance_id } : {}),
        ...(parsed.data.machine_uid !== undefined ? { machine_uid: parsed.data.machine_uid } : {}),
      });
      setAuth(socket, { userId, deviceId: pc.id, kind: 'pc' });
      deps.stampHomeNode?.(pc.id);
      setRoomUuid(socket, pc.room_uuid);
      dropDisplacedPc(pc.room_uuid, store.joinPc(pc.room_uuid, socket).previous, socket);
      // card ACC-1 — this machine now serves THIS account, so its rows under
      // other accounts describe a PC that cannot return (single-account app).
      // The registry has revoked their pairings; eject any live phone sockets
      // so the reconnect ladder meets the dead token and the phone renders its
      // existing 「电脑上已取消这台手机的配对，请重新配对连接」 instead of
      // waiting forever in a room whose PC will never come back (measured
      // stranding, relay journal 2026-08-15 11:06→11:17). Order matters: the
      // revoke happened first, so an ejected phone cannot be re-admitted.
      for (const stranded of registry.reapCrossAccountSiblings(parsed.data.machine_uid, userId)) {
        log.info('pc:register reaped cross-account siblings', {
          room: stranded.room_uuid, pairings: stranded.pairing_ids.length,
        });
        for (const pairingId of stranded.pairing_ids) {
          store.getMobile(stranded.room_uuid, pairingId)?.disconnect(true);
        }
      }
      // book 18 §7.3 — same erase as the reconnect leg, and it belongs here too:
      // registerPc RECOGNISES a known machine and keeps its existing row and
      // room, so a desktop that cleared its credentials comes back through this
      // leg into the very room an absence reason may still be filed against.
      // IT-13: registerPc may have rotated device_token; clearFor keys off the
      // NEW token + the stable room. The old token digest is an orphan slot
      // until TTL — see clearFor's header (recorded, not coupled into registry).
      pcAbsenceReasons.clearFor(pc);
      // GA-18 (additive ack field): the code was minted RIGHT HERE, so the
      // desktop can start a truthful countdown from the same governor that will
      // later refuse the expired code — instead of re-deriving 5 min in the UI
      // and drifting from it. Read BEFORE the roster probe below, so adding that
      // field cannot shift what THIS one means (it stays "how much longer the just-minted code has left").
      const expiresInMs = registry.shortCodeExpiresInMs(pc.id);
      const finish = (connectedMobiles: string[]): void => {
        safeAck(ack, {
          device_id: pc.id,
          pc_id: pc.id,
          pc_instance_id: pc.client_instance_id,
          room_uuid: pc.room_uuid,
          short_code: pc.short_code,
          expires_in_ms: expiresInMs,
          // 0.2.66 (additive ack field, owner 2026-08-14): this PC's PUBLIC
          // addressing id, so the desktop can print it next to the code and put
          // it in the cloud QR. OMITTED (never null) in standalone — the phone
          // and the desktop both read absence as 「this deployment has no PCIDs」,
          // which is the truth on the LAN, and a null would make them render an
          // empty field instead (04 §3.1 PCID addressing).
          ...(pc.pcid ? { pcid: pc.pcid } : {}),
          token,
          // RV-08 (additive ack field, byte-identical in shape and meaning to the
          // pc:reconnect ack's): GA-26 only ever seeded the RECONNECT leg. But a
          // desktop that cleared its credentials — or was reinstalled — comes back
          // through pc:register, and registerPc recognises the machine and keeps
          // its EXISTING row and room, phones and all. The ack said nothing about
          // them, so the desktop's mobile_count stayed 0, `server_ready` never
          // opened (pump.rs), focus:state was never mirrored, and the tray reported
          // 0 phones with a phone sitting in the room.
          //
          // Seeded UNCONDITIONALLY, with no 「was this an existing row」 branch: a
          // genuinely new room has no members, so probeMobileLiveness
          // short-circuits on the empty candidate list and the answer is an honest
          // empty roster at zero added latency. Asking the registry for an
          // existing-row flag would invent a second source of truth for something
          // the room itself already knows.
          connectedMobiles,
          schema_ver: PROTOCOL_SCHEMA_VERSION,
        });
      };
      void confirmedMobiles(pc.room_uuid).then(finish);
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  });

  // GA-07 + GA-26: the ack's `connectedMobiles` is the liveness-CONFIRMED set —
  // see `confirmedMobiles` above, which both this leg and pc:register answer with.
  // ⚠️ ASYNC for the same reason mobile.handler.ts's `mobile:reconnect` is: the
  // only thing that awaits is the replica read-through below, so a local hit —
  // every hit on a writer, on a single node, and the overwhelming majority on a
  // replica — reaches `safeAck` in the same tick it always did.
  socket.on('pc:reconnect', async (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:reconnect', payload);
    if (!parsed.success) {
      // OPS-1 (2026-09-02): best-effort token for the log line only — a
      // malformed payload never reaches `parsed.data`, so this reads the raw
      // field directly rather than trusting its shape for anything else.
      const rawToken = (payload as { token?: unknown } | null | undefined)?.token;
      logAuthRefusal({
        code: 'AUTH_TOKEN_INVALID',
        where: 'pc:reconnect-parse',
        kind: 'pc',
        node: deps.nodeId,
        token: typeof rawToken === 'string' ? rawToken : null,
      });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    // Zombie-room gate (#6 P0): a socket whose handshake PRESENTED an account
    // JWT that failed verification must not re-enter its room on the device
    // token alone. The handshake itself never rejects (middleware contract),
    // and the auth:expired watchdog is armed only for a VERIFIED jwt — so
    // without this gate a cloud PC whose socket bounces across its key's exp
    // instant reconnects with the stale JWT and sits in the room indefinitely
    // under a dead login, with /api/pc/presence answering pc_online:true.
    // Standalone is untouched by construction: the JWT handshake config exists
    // only in saas (bootstrap), so accountAuthError can never be set there.
    // The code is the caller's OWN credential verdict (AUTH_TOKEN_EXPIRED vs
    // AUTH_TOKEN_INVALID) — the desktop routes EXPIRED to its key-clearing
    // hook and keeps the pairing credential (socket/pairing.rs).
    const accountAuthError = getAccountAuthError(socket);
    if (accountAuthError !== null) {
      // book 18 §7.3 write site ② — the refusal above is the ONLY moment anyone
      // learns that this machine's cloud login is dead while it is NOT in its
      // room, so it is the only place that can put that fact where presence can
      // read it. Filed by device token because this gate still refuses to JOIN
      // the room; the token digest is what pc-absence.ts stores.
      //
      // ONLY the EXPIRED verdict is recorded. AUTH_TOKEN_INVALID says 「this key
      // did not verify」, which may not even be this PC calling — spelling that
      // 「its login expired」 would be inventing a fact, so that branch degrades
      // to today's answer (a bare 「not here」).
      //
      // IT-13 — grade before filing: a read-only findPcByToken (not reconnectPc,
      // which would setOnline) decides whether this presentation may claim a
      // slot. Unresolved tokens are dropped; the refusal ack is unchanged.
      // Fail-safe: a genuine expired desktop still holds a real device token
      // ⇒ still resolves ⇒ still records. Silencing that write when a limit
      // bites would make the devices page lie harder than the flood we stop.
      if (accountAuthError === 'AUTH_TOKEN_EXPIRED') {
        const resolved = registry.findPcByToken(parsed.data.token) !== null;
        pcAbsenceReasons.noteByDeviceToken(parsed.data.token, 'auth_expired', resolved);
      }
      logAuthRefusal({ code: accountAuthError, where: 'pc:reconnect-zombie-room', kind: 'pc', node: deps.nodeId, token: parsed.data.token });
      return safeAck(ack, { error: accountAuthError });
    }
    // A2 cross-account gate (owner 2026-08-11 cloud logout / switch account):
    // a socket whose handshake carried a VERIFIED account JWT for user X must
    // not re-enter a room on a device token minted under user Y. Without this,
    // "log out → paste another account's KEY" reconnects the desktop into the OLD
    // account's row (`setAuth(userId: pc.user_id)` below adopts the token's
    // user wholesale), so the machine keeps speaking as the account it just
    // signed out of — the cross-account cousin of crossed IDs.
    //
    // The refusal code is deliberately the EXISTING `AUTH_TOKEN_INVALID`, no
    // new code: on the desktop that verdict already means 「device token is
    // dead → clear it, re-register」 (socket/pairing.rs on_reconnect_ack), and
    // the fresh pc:register resolves its acting user from the CURRENT verified
    // JWT — i.e. the refusal is precisely what routes the machine into the new
    // account. `AUTH_TOKEN_EXPIRED` must NOT be borrowed here: the desktop
    // routes that one to its Cloud-Key-clearing hook, which would wipe the key
    // the user just pasted.
    //
    // Read-only lookup (findPcByToken, NOT reconnectPc): the gate must decide
    // before anything calls setOnline(true), or a refused PC would be marked
    // present (the same trap IT-13 documents on the expiry branch above).
    // Standalone is untouched by construction: no jwt handshake config exists
    // there, so `getAccount` is always null. An unresolved token falls through
    // to reconnectPc's own null → AUTH_TOKEN_INVALID, byte-identical to today.
    const account = getAccount(socket);
    if (account !== null) {
      const owned = registry.findPcByToken(parsed.data.token);
      if (owned !== null && owned.user_id !== account.userId) {
        logAuthRefusal({
          code: 'AUTH_TOKEN_INVALID',
          where: 'pc:reconnect-cross-account',
          kind: 'pc',
          node: deps.nodeId,
          token: parsed.data.token,
          userId: account.userId,
        });
        return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      }
    }
    // B12 (2026-09-02, WP-6) — same truthiness `writerOnly()` guards every
    // other per-role decision in this file with; not acted on as a refusal
    // here (pc:reconnect is deliberately SERVED on a replica), only read to
    // stop `reconnectPc` minting a PCID that would just churn — see that
    // method's own doc.
    const skipPcidBackfill = deps.writerOnly() !== null;
    try {
      let result = registry.reconnectPc(
        parsed.data.token,
        parsed.data.client_instance_id,
        parsed.data.machine_uid,
        { skipPcidBackfill },
      );
      // ── LOCAL MISS (B1, 2026-09-02) ────────────────────────────────────
      //
      // 🔴 ON A REPLICA A LOCAL MISS IS A MAYBE, NOT A NO — the same asymmetry
      // `mobile:reconnect` already answers on the identical seam. Exactly ONE
      // retry, and only after rows actually landed: the read-through is
      // authoritative, so a second attempt on the same answer could only
      // produce the same miss.
      //
      // 🔴 CORRECTED (B2-S, 2026-09-02) — this used to ask only the boolean
      // `resolve()`, which A11/F2-a (WP-8, node/token-read-through.ts) documents
      // as collapsing THREE outcomes into one `false`: 'writer-confirmed-absent'
      // (the writer itself does not know this token) and 'unverifiable' (writer
      // unreachable, budget spent, or a row that would not land — a fault on
      // THIS node, not a statement about the credential) both fell through to
      // the same AUTH_TOKEN_INVALID below, and the desktop's DeadToken branch
      // (socket/pairing.rs) deletes a good token over the latter. Only
      // 'writer-confirmed-absent' may still answer AUTH_TOKEN_INVALID;
      // 'unverifiable' now answers AUTH_TOKEN_UNVERIFIABLE, the retryable code
      // the desktop (reconnect_ack.rs) already keeps the credential over.
      let refusal: 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_UNVERIFIABLE' = 'AUTH_TOKEN_INVALID';
      if (!result && deps.resolveTokenOnWriter) {
        const seam = deps.resolveTokenOnWriter;
        const outcome = seam.resolveDetailed
          ? await seam.resolveDetailed(parsed.data.token)
          : (await seam.resolve(parsed.data.token)) ? 'landed' : 'writer-confirmed-absent';
        if (outcome === 'landed') {
          result = registry.reconnectPc(
            parsed.data.token,
            parsed.data.client_instance_id,
            parsed.data.machine_uid,
            { skipPcidBackfill },
          );
        } else if (outcome === 'unverifiable') {
          refusal = 'AUTH_TOKEN_UNVERIFIABLE';
        }
      }
      if (!result) {
        logAuthRefusal({ code: refusal, where: 'pc:reconnect', kind: 'pc', node: deps.nodeId, token: parsed.data.token });
        return safeAck(ack, { error: refusal });
      }
      const { pc } = result;
      setAuth(socket, { userId: pc.user_id, deviceId: pc.id, kind: 'pc' });
      deps.stampHomeNode?.(pc.id);
      setRoomUuid(socket, pc.room_uuid);
      dropDisplacedPc(pc.room_uuid, store.joinPc(pc.room_uuid, socket).previous, socket);
      // book 18 §7.3 — back in the room ⇒ any recorded reason for its absence is
      // now false. Erased here (and on the register leg) rather than left to the
      // TTL, so that the NEXT ordinary shutdown cannot be reported as 「login
      // expired」 by a leftover entry.
      pcAbsenceReasons.clearFor(pc);
      const finish = (connectedMobiles: string[]): void => {
        safeAck(ack, {
          device_id: pc.id,
          pc_id: pc.id,
          pc_instance_id: pc.client_instance_id,
          room_uuid: pc.room_uuid,
          short_code: pc.short_code,
          // 0.2.66 — same additive field as the register ack. A desktop that
          // comes back through THIS leg (the common case: it has credentials)
          // must still learn its PCID, or the pairing dialog would show one only
          // in the session where the PC happened to re-register.
          ...(pc.pcid ? { pcid: pc.pcid } : {}),
          connectedMobiles,
          schema_ver: PROTOCOL_SCHEMA_VERSION,
        });
      };
      void confirmedMobiles(pc.room_uuid).then(finish);
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  });

  socket.on('pc:refresh-code', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:refresh-code', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    // Mints a code and stamps its TTL — both erased by the next pull, while the
    // PC displays the dead code to the user. See pc:register above.
    const replicaCode = deps.writerOnly();
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'pc' || !auth.deviceId) {
      logAuthRefusal({ code: 'AUTH_TOKEN_INVALID', where: 'pc:refresh-code', kind: auth?.kind ?? null, node: deps.nodeId, userId: auth?.userId });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    if (replicaCode) {
      // ── 🔴 2026-08-31 — THE REFUSAL THAT HAD NO WAY OUT ────────────────────
      //
      // Until this branch existed, this event was simply refused here, and the
      // consequence was not 「one action fails」 — it was that A PC WHICH LANDS ON
      // A REPLICA CAN NEVER ADD A PHONE AGAIN. `pc:reconnect` is deliberately
      // served on a replica (refusing it would stop the node doing the only job
      // it has), and a token reconnect leaves `short_code` null BY CONSTRUCTION,
      // so this event is the sole way to mint one. The session meanwhile looks
      // perfect: registered, transcribing, injecting. Measured 2026-08-31 on the
      // owner's PC against srvjp; the desktop sat on 「no valid pairing code yet」
      // with no QR and no reason, because the desktop drops a refusal it does not
      // classify as an account fact (socket/outbound.rs is_account_validity_refusal).
      //
      // node_select.rs routes a PC to the writer when it must REGISTER. Minting a
      // code is the SECOND writer-only operation on that path, and nothing routed
      // it — so the fix is a forward, not another client-side rule. Doing it here
      // rather than in the client also fixes every ALREADY-SHIPPED desktop, which
      // a client-side rule could not.
      //
      // ⚠️ AUTH IS CHECKED ABOVE THIS BRANCH NOW, and that is a real change: the
      // refusal used to be returned before the auth check, so an unauthenticated
      // socket could observe NODE_IS_REPLICA. It has to move, because forwarding
      // needs a device id — and 「who are you」 was always the more honest first
      // question. What a replica answers an anonymous socket becomes
      // AUTH_TOKEN_INVALID, exactly like the writer.
      const forward = deps.mintCodeOnWriter;
      if (!forward) return safeAck(ack, replicaCode);
      const pcId = auth.deviceId;
      void forward(pcId)
        .then((minted) => {
          // `null` = the writer does not know this PC. Nothing was minted, so the
          // honest refusal stands. NEVER a fabricated code.
          if (!minted) return safeAck(ack, replicaCode);
          safeAck(ack, { short_code: minted.short_code, expires_in_ms: minted.expires_in_ms });
        })
        // A writer that could not be reached is the SAME visible outcome as a
        // node that cannot mint — and that is correct rather than lazy: both mean
        // 「no code exists for you right now」, both are transient, and the copy
        // NODE_IS_REPLICA carries (「reconnect and try again」) is the action that
        // helps in either case. What must never happen is a code, or silence.
        .catch(() => safeAck(ack, replicaCode));
      return;
    }
    try {
      const short_code = registry.refreshShortCode(auth.deviceId);
      // GA-18: same additive field as the register ack. Read AFTER the mint, so
      // it is the new code's remaining life (a full TTL), never the old one's.
      //
      // 🔴 0.2.66 — `pcid` is DELIBERATELY ABSENT here, unlike the register and
      // reconnect acks. This event mints a new SECRET; the ADDRESS is unchanged
      // by construction (stampPcid never rotates an existing pcid), and the
      // desktop already holds it from the register/reconnect ack that opened
      // this session. Echoing it would put a second source for one value on the
      // wire and quietly imply 「refreshing the code may change your PCID」, which
      // is the opposite of what a PCID is for. The design doc's §5.5 listed all
      // three acks; this narrowing is deliberate — recorded in that file's
      // implementation notes rather than silently deviated from.
      safeAck(ack, { short_code, expires_in_ms: registry.shortCodeExpiresInMs(auth.deviceId) });
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  });

  // GA-08 — "disconnect" and "revoke", one event, two meanings (04 §3.1 additive
  // `revoke`). The pre-GA-08 handler only called `socket.disconnect(true)`: the
  // pairing row and its token survived, so the phone's reconnect ladder was back
  // in the room within seconds. Both halves of that are fixed here:
  //   · disconnect (`revoke` absent/false) — disconnect the socket AND park the pairing
  //     in the suppression window, so the phone stays out for RELEASE_SUPPRESS_MS
  //     and then returns by itself. Nothing is deleted; the token stays valid.
  //   · revoke (`revoke: true`)        — delete the mobile_pairings row (05 §7),
  //     which is what actually kills the token, THEN disconnect. The phone's
  //     next reconnect gets AUTH_TOKEN_INVALID from the normal token lookup and
  //     its existing fail-loud path clears the local session (zero mobile change).
  //
  // OWNERSHIP (the security core of this card): the addressable set is exactly
  // THIS PC's pairing rows, resolved from the socket's OWN deviceId — the same
  // three-gate shape as pc:list-mobiles below, plus the room match. A pairing
  // belonging to another PC (same user or another user) is not in that set, so it
  // can be neither disconnected nor revoked, and the ack for it is byte-identical
  // to the ack for an id that never existed: `{ok:true, released:0, revoked:0}`.
  // That one shape carries BOTH required properties — no existence oracle, and a
  // repeat revoke of an already-deleted row still acks ok (idempotent).
  //
  // `pc:mobile-left` is not emitted here: the mobile's own disconnect hook owns
  // that announcement (and its GA-04 grace), exactly as before.
  // Emits `mobile:released` + disconnects a local socket for every id in
  // `targetIds` — the ONE thing only this node can do, whichever database the
  // mutation itself landed on. Shared by the direct path and the forwarded
  // path below so the emit shape (and the emit-before-disconnect ordering,
  // load-bearing per the comment on the call site) has one author.
  const applyLocalReleaseEffects = (roomUuid: string, targetIds: string[], revoke: boolean, suppressedMs: number): number => {
    let released = 0;
    for (const pairingId of targetIds) {
      const mobileSocket: Socket | null = store.getMobile(roomUuid, pairingId);
      if (mobileSocket) {
        // owner 2026-08-20 — SAY IT BEFORE CLOSING THE DOOR.
        // (`docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md`)
        //
        // Until today the next line was the whole story: a bare `disconnect(true)`.
        // On the phone that arrives as `socket.drop io_reason=io server disconnect`
        // — BYTE-IDENTICAL to its own Wi-Fi dying (measured on the owner's machine).
        // Two causes, one observation, and opposite correct actions: a phone whose
        // network blipped should climb its ladder, while a phone a person just
        // evicted should stop and go back to the list. The phone could only tell
        // them apart by dialling back in and being refused with `PAIR_RELEASED` —
        // and that dial IS the retry the ruling forbids, because it lands inside
        // the suppression window and hands the incumbent its 60-second reservation.
        //
        // 🔴 THE SERVER ALWAYS KNEW. This branch has the reason, the pairing and the
        // budget in hand; it simply never said so, and let the phone go and ask.
        // Nothing here is new information — only the decision to publish it.
        //
        // Emitted BEFORE `disconnect(true)`, which is load-bearing: socket.io drops
        // anything queued on a closed socket, so the order is the delivery.
        mobileSocket.emit('mobile:released', {
          // 0 for a revoke — the pairing row is gone, so there is no window to
          // wait out. The phone must NOT render that as「retry in 0 seconds」,
          // which is why `revoked` is a separate field rather than a magic zero.
          retry_after_ms: revoke ? 0 : suppressedMs,
          revoked: revoke,
        });
        mobileSocket.disconnect(true);
        released++;
      }
    }
    return released;
  };

  socket.on('pc:release-mobile', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:release-mobile', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    // 🔴 A REVOKE THAT COMES BACK is the worst member of this family: the row is
    // deleted, both ends say OK, and the next pull restores the pairing the user
    // just removed. A security control that silently fails to apply is worse
    // than one that visibly refuses — so on a replica with nobody to forward to,
    // it refuses. `replicaRelease` is computed eagerly and used in THREE places
    // below (no forwarder wired, forward refused, forward unreachable) — same
    // shape as `pc:refresh-code`'s `replicaCode`.
    const replicaRelease = deps.writerOnly();
    const auth = getAuth(socket);
    const roomUuid = (socket.data as { roomUuid?: string }).roomUuid;
    // Auth is checked BEFORE the replica branch — same fix `pc:refresh-code`
    // made and for the same reason: forwarding needs a device id, and "who are
    // you" is always the more honest first question than "where do I live".
    if (!auth || auth.kind !== 'pc' || !auth.deviceId || !roomUuid) {
      logAuthRefusal({ code: 'AUTH_TOKEN_INVALID', where: 'pc:release-mobile', kind: auth?.kind ?? null, node: deps.nodeId, userId: auth?.userId });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    const pc = registry.findPc(auth.deviceId);
    if (!pc || pc.user_id !== auth.userId || pc.room_uuid !== roomUuid) {
      logAuthRefusal({ code: 'AUTH_TOKEN_INVALID', where: 'pc:release-mobile', kind: auth.kind, node: deps.nodeId, userId: auth.userId });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    const revoke = parsed.data.revoke === true;
    // Absent `reason` = 'manual' — an older desktop's frame keeps its exact
    // pre-GA-29 meaning without any version negotiation.
    const reason = parsed.data.reason ?? 'manual';
    // A revoke MUST name its target. "revoke all" is not offered by this wire, so an
    // omitted id is a malformed revoke — refused loudly rather than silently
    // widened into a mass revocation (or silently narrowed into a no-op).
    if (revoke && parsed.data.mobile_id === undefined) {
      return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD', message: 'revoke requires mobile_id' });
    }

    if (replicaRelease) {
      // 🔴 2026-09-02 (B5, WP-6) — THE REFUSAL THAT HAD NO WAY OUT. A PC on a
      // replica could never disconnect or revoke a phone: PC_BUSY eviction was
      // unavailable, and a revoke would flatten to `dev_release_failed` on the
      // desktop while the pairing row (and its live token) survived the next
      // pull unchanged. Forward the write to the writer, exactly as
      // `pc:refresh-code` forwards its mint; fall back to the honest refusal
      // when there is nobody to ask or the ask fails.
      const forward = deps.forwardReleaseMobile;
      if (!forward) return safeAck(ack, replicaRelease);
      void forward({
        pc_id: pc.id, user_id: auth.userId, room_uuid: roomUuid, revoke, reason,
        ...(parsed.data.mobile_id !== undefined ? { mobile_id: parsed.data.mobile_id } : {}),
      })
        .then((outcome) => {
          if (outcome.status !== 'ok') return safeAck(ack, replicaRelease);
          const { target_ids, revoked_count, suppressed_ms } = outcome.result;
          const released = applyLocalReleaseEffects(roomUuid, target_ids, revoke, suppressed_ms);
          log.info('pc:release-mobile (forwarded)', {
            pc_id: pc.id, revoke, targets: target_ids.length, released, revoked: revoked_count,
          });
          safeAck(ack, { ok: true, released, revoked: revoked_count, suppressed_ms: suppressed_ms });
        })
        // A writer that could not be reached is the SAME visible outcome as a
        // node that cannot forward — both mean "this release did not happen",
        // and NEVER a fabricated `{ok:true}`.
        .catch(() => safeAck(ack, replicaRelease));
      return;
    }

    const owned = registry.listMobilesForPc(pc.id).map((m) => m.id);
    const targets = parsed.data.mobile_id !== undefined
      ? owned.filter((id) => id === parsed.data.mobile_id)
      : owned;

    let revoked = 0;
    let suppressedMs = 0;
    for (const pairingId of targets) {
      if (revoke) {
        if (registry.revokeMobile(pc.id, pairingId)) revoked++;
        // The row is gone — a suppression entry for it would outlive the thing it
        // describes (and the token is dead anyway).
        deps.suppression?.clear(pairingId);
      } else {
        // GA-29: a `busy` refusal earns a SECONDS-long window, not the minute a
        // deliberate disconnect earns — the second phone must be able to return the
        // moment the capsule frees up, and it never asked to be disconnected.
        suppressedMs = deps.suppression?.suppress(pairingId, reason) ?? 0;
      }
    }
    const released = applyLocalReleaseEffects(roomUuid, targets, revoke, suppressedMs);
    log.info('pc:release-mobile', { pc_id: pc.id, revoke, targets: targets.length, released, revoked });
    safeAck(ack, {
      ok: true,
      released,
      revoked,
      // How long the released phones are held out — 0 for a revoke (permanent, no
      // window) and 0 when no suppression is wired, so the number is never a
      // claim the server cannot keep.
      suppressed_ms: suppressedMs,
    });
  });

  registerPcListMobilesHandler(socket, { registry, store });
}

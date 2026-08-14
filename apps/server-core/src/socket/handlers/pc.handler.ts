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
import { getAccount, getAccountAuthError, getAuth, safeAck, setAuth, setRoomUuid, type ActingIdentity } from '../wire';

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
  liveness?: LivenessDeps;
  /** GA-08: the shared reconnect-suppression window "disconnect" writes and
   *  `mobile:reconnect` reads. Omitted → a release still disconnects, but the
   *  phone may return immediately (the pre-GA-08 behaviour). Production wires the
   *  ONE instance bootstrap creates; tests inject a fake-clock instance. */
  suppression?: ReleaseSuppression;
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
      setRoomUuid(socket, pc.room_uuid);
      dropDisplacedPc(pc.room_uuid, store.joinPc(pc.room_uuid, socket).previous, socket);
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
  socket.on('pc:reconnect', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:reconnect', payload);
    if (!parsed.success) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
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
        return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      }
    }
    try {
      const result = registry.reconnectPc(
        parsed.data.token,
        parsed.data.client_instance_id,
        parsed.data.machine_uid,
      );
      if (!result) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      const { pc } = result;
      setAuth(socket, { userId: pc.user_id, deviceId: pc.id, kind: 'pc' });
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
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'pc' || !auth.deviceId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
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
  socket.on('pc:release-mobile', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:release-mobile', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    const auth = getAuth(socket);
    const roomUuid = (socket.data as { roomUuid?: string }).roomUuid;
    if (!auth || auth.kind !== 'pc' || !auth.deviceId || !roomUuid) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const pc = registry.findPc(auth.deviceId);
    if (!pc || pc.user_id !== auth.userId || pc.room_uuid !== roomUuid) {
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
    const owned = registry.listMobilesForPc(pc.id).map((m) => m.id);
    const targets = parsed.data.mobile_id !== undefined
      ? owned.filter((id) => id === parsed.data.mobile_id)
      : owned;

    let released = 0;
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
      const mobileSocket: Socket | null = store.getMobile(roomUuid, pairingId);
      if (mobileSocket) {
        mobileSocket.disconnect(true);
        released++;
      }
    }
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

  // R6 T-8 — "paired phones" table for the desktop device page.
  //
  // OWNERSHIP (three gates, all of them structural rather than trusting input):
  //   1. the socket must be an authenticated PC (auth.kind === 'pc' + deviceId);
  //   2. the pc_devices row is resolved from that OWN deviceId — the payload is
  //      `{}` and carries no addressable id, so there is nothing to spoof;
  //   3. the row's user_id must equal the socket's userId (defence in depth for
  //      the saas multi-tenant case; standalone collapses to 'default').
  //   Rows are then read by pc_device_id, so a mobile paired to ANOTHER PC — of
  //   this user or any other — is not reachable from this query at all.
  //
  // PROJECTION: five public fields, spelled out one by one. `mobile_token` is a
  // bearer secret (05 §7) and NEVER crosses this wire — the raw record is read
  // into `m` and only named fields leave it (same rule as the REST
  // /api/cloud/devices projection).
  //
  // `online` is REAL presence: the live RoomStore membership of THIS PC's room,
  // keyed by the same pairing id the mobile joined under (mobile.handler
  // store.joinMobile(room, mobile.id, socket)) — never the persisted
  // last_seen_at replayed as if it were live.
  socket.on('pc:list-mobiles', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:list-mobiles', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    const auth = getAuth(socket);
    if (!auth || auth.kind !== 'pc' || !auth.deviceId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const pc = registry.findPc(auth.deviceId);
    if (!pc || pc.user_id !== auth.userId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const mobiles = registry.listMobilesForPc(pc.id).map((m) => ({
      pairing_id: m.id,
      mobile_name: m.mobile_name,
      paired_at: m.paired_at,
      last_seen_at: m.last_seen_at,
      // v0.2.4 — which physical handset this row belongs to, so the desktop can
      // say "these two rows are the same phone" across the LAN and relay lists instead of
      // showing two identical rows. Null (pre-0.2.4 pairing) groups with NOTHING.
      device_uid: m.device_uid,
      // the lead's ruling (GA-04 ↔ GA-07 crossover): the ROSTER answers "is this phone's
      // socket up right now」, which a slot in mobile-drop grace is NOT. The
      // grace exists to keep the audio SESSION alive and to debounce the
      // presence announcement — it is not a claim that the phone is online,
      // and reporting it here would be exactly the fabricated status G12
      // guards against. Two different questions, two different answers.
      online: store.getMobile(pc.room_uuid, m.id)?.connected === true,
    }));
    safeAck(ack, { mobiles });
  });
}

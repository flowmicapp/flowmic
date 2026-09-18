// SPEC-REF:
//   src/socket/handlers/mobile.handler.ts (the ONE caller, `mobile:reconnect`)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (mobile:reconnect; acks = MobilePairAck)
//
// 2026-09-09 — MOVED VERBATIM out of mobile.handler.ts, which stood at 800 of
// its 800-line cap (verify/lint/file-size.mjs) — same pressure and same
// remedy as this file's own siblings (mobile-ack-fields.ts,
// mobile-room-admission.ts) and as disconnect.handler.ts's split out of
// bootstrap.ts's connection callback (that file's header names the same
// pattern: a curried `make*Handler(socket, deps): (...) => ...` factory, bound
// per-connection at the ONE call site). Every comment travelled with the code
// it explains; nothing about the behaviour changed by this move.
//
// `MobileHandlerDeps` and `refuseRestricted` both live in the sibling
// mobile-handler-deps.ts, not in mobile.handler.ts: importing either from
// mobile.handler.ts (which imports THIS file's factory) would close a cycle
// (verify/lint/circular.mjs). `refuseRestricted` also guards mobile:pair —
// mobile.handler.ts imports it from the same shared file and re-exports it,
// so this is the SAME function, not a second one answering the same question.
//
// `pcOnline` / `meteringInput` / `noteMeteringSwitch` are the three local
// closures `registerMobileHandlers` builds once per connection (over `store`,
// `now`, `deps`) and shares with mobile:pair — passed in as `helpers` rather
// than rebuilt here, for the same reason every shared instance in this codebase
// is passed rather than rebuilt: a second closure over the same inputs is a
// second place the two admission legs could disagree.

import type { Socket } from 'socket.io';
import {
  safeParseEvent,
  type MobileReconnectAckAudioFields,
  type MobileReconnectAckNodeFields,
} from '@flowmic/protocol';
import type { PcRecord } from '../../db/repos/pc.repo';
import { errorPayload } from '../../errors';
import { logAuthRefusal } from '../../auth/refusal-log';
import { safeAck, setAuth, setRoomUuid } from '../wire';
import { adoptAudioSession, peekAudioLastContiguousSeq } from '../../engine/audio-registry';
import { budgetAckFields } from './budget-frames';
import { meteringPrincipal, type MeteringPrincipalInput } from '../../auth/metering-principal';
import { joinAndNotify, liveContender } from './mobile-room-admission';
import { RECOVERY_CAPABILITY_ACK, targetCapsAck } from './mobile-ack-fields';
import { log } from '../../log';
import { type MobileHandlerDeps, refuseRestricted } from './mobile-handler-deps';

/** The three per-connection closures `mobile:reconnect` shares with
 *  `mobile:pair` (see `registerMobileHandlers`) — SAME instances, not rebuilt. */
export interface MobileReconnectHelpers {
  pcOnline: (pc: PcRecord) => boolean;
  meteringInput: (
    pc: PcRecord,
    mobile: { id: string; user_id: string | null; client: string | null; trial_user_id: string | null; device_uid: string | null },
    opts: { mayMint: boolean },
  ) => MeteringPrincipalInput;
  noteMeteringSwitch: (p: { userId: string; switched: boolean }, roomUuid: string) => void;
}

/** Build the `mobile:reconnect` listener for one socket. Bound per-connection
 *  in `registerMobileHandlers`
 *  (`socket.on('mobile:reconnect', makeMobileReconnectHandler(socket, deps, helpers))`). */
export function makeMobileReconnectHandler(
  socket: Socket,
  deps: MobileHandlerDeps,
  helpers: MobileReconnectHelpers,
): (payload: unknown, ack: unknown) => Promise<void> {
  const { registry, store } = deps;
  const { pcOnline, meteringInput, noteMeteringSwitch } = helpers;
  // An `async` function runs synchronously to its first `await`, so a local hit —
  // every hit on a writer, on a single node, and the overwhelming majority on a
  // replica — reaches `safeAck` in the same tick it always did. The socket.io
  // wrapper already handles a thenable handler (error-handling.ts inspects the
  // return value and attaches a rejection reporter), so this is not a new
  // containment shape either.
  return async (payload: unknown, ack: unknown): Promise<void> => {
    const parsed = safeParseEvent('mobile:reconnect', payload);
    if (!parsed.success) {
      // OPS-1 (2026-09-02): best-effort token for the log line only, same as
      // pc:reconnect's identical guard — a malformed payload never reaches
      // `parsed.data`.
      const rawToken = (payload as { token?: unknown } | null | undefined)?.token;
      logAuthRefusal({
        code: 'AUTH_TOKEN_INVALID',
        where: 'mobile:reconnect-parse',
        kind: 'mobile',
        node: deps.nodeId,
        token: typeof rawToken === 'string' ? rawToken : null,
      });
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    try {
      let result = registry.reconnectMobile(parsed.data.token, parsed.data.device_uid);
      // ── LOCAL MISS ──────────────────────────────────────────────────────
      //
      // 🔴 ON A REPLICA A LOCAL MISS IS A MAYBE, NOT A NO — the same asymmetry
      // `authMiddleware` and `/api/node/locate` already answer, on the one other
      // seam that resolves a pairing token against this node's own database.
      // Replication makes rows arrive late (and, when a pull races a
      // read-through, arrive and then LEAVE); it never invents them.
      //
      // 🔴 THIS REFUSAL IS THE EXPENSIVE ONE. A handshake-level
      // AUTH_TOKEN_INVALID and this ack-level one are read by the same phone
      // code, and BOTH set `invalid` (mobile_reconnect_flow.dart) ⇒ the local
      // pairing is DELETED. A replica answering from a lagging database was
      // therefore able to destroy a credential that was valid the whole time.
      // After this, a refusal here means the WRITER does not know the token.
      //
      // Exactly ONE retry, and only after rows actually landed: the read-through
      // is authoritative, so a second attempt on the same answer could only
      // produce the same miss.
      //
      // 🔴 CORRECTED (B2-S, 2026-09-02) — this used to ask only the boolean
      // `resolve()`, which A11/F2-a (WP-8, node/token-read-through.ts) documents
      // as collapsing THREE outcomes into one `false`: 'writer-confirmed-absent'
      // (the writer itself does not know this token — the WRITER refusal this
      // comment block above is about) and 'unverifiable' (writer unreachable,
      // budget spent, or a row that would not land — a fault on THIS node, not
      // a statement about the credential) both fell through to the same
      // AUTH_TOKEN_INVALID below, deleting a good pairing over the latter too.
      // Only 'writer-confirmed-absent' may still answer AUTH_TOKEN_INVALID;
      // 'unverifiable' now answers AUTH_TOKEN_UNVERIFIABLE, the retryable code
      // the phone (mobile_reconnect_flow.dart) already keeps the pairing over.
      let refusal: 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_UNVERIFIABLE' = 'AUTH_TOKEN_INVALID';
      if (!result && deps.resolveTokenOnWriter) {
        const seam = deps.resolveTokenOnWriter;
        const outcome = seam.resolveDetailed
          ? await seam.resolveDetailed(parsed.data.token)
          : (await seam.resolve(parsed.data.token)) ? 'landed' : 'writer-confirmed-absent';
        // ── A1 (2026-09-02) — THE SOCKET THAT ASKED MAY BE GONE ────────────
        //
        // A phone that dials and drops mid-handshake (a flaky hop, an app
        // killed in the background) can disconnect DURING this await.
        // socket.io fires 'disconnect' the instant the transport closes —
        // before this handler has ever called `setAuth` — so the disconnect
        // handler's own `if (!roomUuid || !auth) return;` guard finds
        // nothing to clean up (disconnect.handler.ts). Proceeding past this
        // point would unconditionally `setAuth` + `joinAndNotify` a socket
        // socket.io itself has already forgotten: no SECOND 'disconnect'
        // event will ever fire for it, so it stays in the room — and in
        // `pc:list-mobiles`'s count — until the process restarts.
        if (!socket.connected) {
          log.info('mobile:reconnect — socket disconnected during the writer read-through, dropping the join', {
            outcome,
          });
          return;
        }
        if (outcome === 'landed') {
          result = registry.reconnectMobile(parsed.data.token, parsed.data.device_uid);
        } else if (outcome === 'unverifiable') {
          refusal = 'AUTH_TOKEN_UNVERIFIABLE';
        }
      }
      if (!result) {
        logAuthRefusal({ code: refusal, where: 'mobile:reconnect', kind: 'mobile', node: deps.nodeId, token: parsed.data.token });
        return safeAck(ack, { error: refusal });
      }
      const { mobile, pc } = result;
      // A2-3 — the identity this socket is ABOUT to be given, computed ONCE and
      // read by both the gate below and `setAuth` further down. A gate that
      // judges a different value from the one it then admits is a gate on paper.
      // Card W4-05 — as on the pair leg; the gate below and `setAuth` still read ONE value.
      //
      // 🔴 Card R-1 — `mayMint: false`. This leg runs on replicas (through the
      // handshake read-through), and a trial identity minted there would be two
      // rows in a database the writer's snapshot replaces every 30 seconds: the
      // visitor's minutes would vanish mid-session and the next admission would
      // hand them a fresh 120 s. So a reconnect SPENDS what the writer minted
      // and never mints its own. A web instance whose row carries no identity —
      // one paired before this build, or one whose identity the 48-hour sweep
      // took — is metered exactly as it is today until it pairs again.
      const principal = meteringPrincipal(meteringInput(pc, mobile, { mayMint: false }));
      // card MP-0 — a far end this build cannot classify is refused rather than
      // billed to a guess (design §5). Retryable and token-preserving on purpose:
      // see `refuseUnbillableRoom` in mobile.handler.ts for why this code and not
      // `AUTH_TOKEN_INVALID`, which would make the phone delete its pairing.
      if (principal === null) {
        log.error('reconnect refused — this build cannot tell who pays for that room', {
          where: 'mobile:reconnect', pc_id: pc.id, room_kind: pc.room_kind, node: deps.nodeId,
        });
        return safeAck(ack, { error: 'PC_HANDSHAKE_PENDING' });
      }
      const actingUserId = principal.userId;
      // 🔴 A2-3, AND IT OUTRANKS THE HOLD-OUT CHECK BELOW — the order is a
      // decision, not the order I happened to type. Both can be true of one
      // phone and only one can be the answer: `PAIR_RELEASED` / `PC_BUSY` say
      // 「come back in N ms」, which for a restricted account promises a recovery
      // that will not arrive, costs a round trip to disprove, and (because those
      // two are the codes that carry a budget) arms the phone's hold-out timer
      // to go and be refused again. This is the same ordering argument
      // console-routes.ts makes for restriction-before-verification: the true
      // sentence that names an action the user cannot complete is the wrong one.
      //
      // ⚠️ It runs AFTER `reconnectMobile`, so `last_seen_at` is still stamped —
      // deliberate and identical to the hold-out refusal below: a refused
      // reconnect is still a genuine contact from that phone.
      if (refuseRestricted(deps, actingUserId, ack)) return;
      // GA-08 "disconnect": the PC ended this session moments ago. The pairing is
      // still VALID — this is a pause, not a revocation — so the refusal carries
      // PAIR_RELEASED and never AUTH_TOKEN_INVALID: the mobile ladder keeps its
      // token on an unknown code and backs off, and would DELETE the pairing on
      // AUTH_TOKEN_INVALID (mobile_reconnect_flow.dart). `retry_after_ms` is the
      // real remaining window, so the phone is told when, not just no.
      // Refused BEFORE joining the room: a suppressed phone must not be present,
      // must not adopt a lingering audio session, and must not raise
      // pc:mobile-joined. (It does keep last_seen_at's touch from the lookup
      // above — a refused reconnect is still a genuine contact from that phone.)
      const suppressedFor = deps.suppression?.remainingMs(mobile.id) ?? 0;
      if (suppressedFor > 0) {
        // GA-29: the two hold-out reasons are two different facts and must not
        // share a sentence. "The computer just disconnected this phone" tells the user someone
        // pressed a button; "another phone is already in use" tells them to wait their turn.
        // Both are retryable and both keep the token — only the words and the
        // window differ.
        const busy = deps.suppression?.reasonFor(mobile.id) === 'busy';
        return safeAck(ack, {
          error: busy ? 'PC_BUSY' : 'PAIR_RELEASED',
          retryable: true,
          retry_after_ms: suppressedFor,
        });
      }
      // A12/F2-b — no PRE-EXISTING suppression, but the room may still be held
      // by a phone that never triggered one: THE FIRST TIME two phones contend,
      // there is no suppression entry yet for either of them (`ReleaseSuppression`
      // only ever gets an entry from a PC's OWN `pc:release-mobile{busy}` call —
      // see the header above `liveContender`). Checked here, after the existing
      // hold-out, so a phone already serving a window gets the ORIGINAL reason
      // and remaining time rather than a fresh one for the same fact.
      const contender = liveContender(store, pc.room_uuid, mobile.id);
      if (contender) {
        const suppressedMs = deps.suppression?.suppress(mobile.id, 'busy') ?? 0;
        return safeAck(ack, { error: 'PC_BUSY', retryable: true, retry_after_ms: suppressedMs });
      }
      // card MP-6 — same three facts as the pair leg, from the same one rule.
      setAuth(socket, {
        userId: actingUserId, pairingId: mobile.id, deviceId: pc.id, kind: 'mobile',
        payerReason: principal.reason,
        ...(principal.capUserId !== null ? { capUserId: principal.capUserId } : {}),
        // card MP-1 — the key travels across a reconnect too. Without it a page
        // that reloaded would go on recording against the integrator's whole
        // plan while the console showed a sub-quota that stopped moving.
        ...(principal.integratorKeyId !== null ? { integratorKeyId: principal.integratorKeyId } : {}),
        ...(principal.speakerRef !== null ? { speakerRef: principal.speakerRef } : {}),
        // card MP-10 — and across a reconnect too: a page that reloaded and came
        // back signed in must not leave the desktop still reading 「a guest is
        // speaking」 from the admission before it.
        speakerSignedIn: principal.speakerSignedIn,
      });
      setRoomUuid(socket, pc.room_uuid);
      joinAndNotify(store, pc.room_uuid, mobile, socket, deps.armWebLiveness);
      // GA-04: re-bind an audio session still inside its mobile-drop grace, so a
      // sub-30s blip resumes on the SAME orchestrator (SeqTracker intact) and the
      // PC never learns the phone was gone. mobile:pair does not need this — it
      // mints a new pairing row, so no session can be keyed to it yet.
      adoptAudioSession(socket, pc.room_uuid, mobile.id);
      // SEG-1 (R5, docs/strategy/2026-08-11-unified-transcription-session-design.md):
      // tell the returning phone how far the surviving session has already
      // contiguously observed, so its 30 s ring replay can trim to 「seq >
      // watermark」 (card SEG-2) instead of re-sending everything. ABSENCE is
      // the no-session signal — when the peek answers null the field is
      // OMITTED, never sent as null and never as a -1 sentinel; `-1` on the
      // wire only ever means 「session live, zero chunks observed yet」. A phone
      // that never sees the field (old server, stripped by an old relay,
      // pre-SEG-2 build) replays in full and hasObserved() dedupes server-side
      // — fail toward duplication, never loss (protocol-schemas-auth.ts, on
      // the field).
      const audioSeq = peekAudioLastContiguousSeq(socket, pc.room_uuid, mobile.id);
      const audioAckFields: MobileReconnectAckAudioFields =
        audioSeq === null ? {} : { audio_last_contiguous_seq: audioSeq };
      // 2026-08-29 multi-node — where this PC is, and where this ack came from.
      // The phone's question is a COMPARISON, so both halves ride one ack at one
      // instant; see protocol-schemas-auth.ts on these fields. Both omitted on a
      // single-node deployment, which is every deployment until it is not.
      const nodeAckFields: MobileReconnectAckNodeFields = {
        ...(pc.home_node ? { home_node: pc.home_node } : {}),
        ...(deps.nodeId ? { node: deps.nodeId } : {}),
      };
      safeAck(ack, {
        ...RECOVERY_CAPABILITY_ACK, // card PR-1
        // card S2-01 — RE-READ AT THIS INSTANT, not carried over from the pair
        // ack: the target may have been replaced in between, and a claim from a
        // connection that has ended is a claim nobody present has made.
        ...targetCapsAck(pc),
        pairing_id: mobile.id,
        pc_id: pc.id,
        pc_instance_id: pc.client_instance_id,
        pc_machine_uid: pc.machine_uid,
        pc_name: pc.device_name,
        room_uuid: pc.room_uuid,
        pc_online: pcOnline(pc),
        ...audioAckFields,
        ...nodeAckFields,
        // card S2-02 (addendum §1.5); card MP-6 — and the site demo's per-browser
        // ceiling, so a visitor who reloads is quoted their own grant rather than
        // the demo account's month.
        ...budgetAckFields(actingUserId, deps.budget, principal.capUserId, principal.integratorKeyId),
      });
      noteMeteringSwitch(principal, pc.room_uuid); // card W4-05
    } catch (err) {
      safeAck(ack, errorPayload(err));
    }
  };
}

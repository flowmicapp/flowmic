// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request / inject:result /
//     control:key / focus:state mirror)
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (0.2.27: the server
//     stores no transcripts, so it records no status either — the VERDICT still
//     travels, and its owner writes it down)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D4 (inject provenance via entry_id/
//     request_id exact echo — no FIFO mis-attribution)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md (card S:
//     both channels are "pass-through, not storage" — the delivery frame now CARRIES the PC's row, and
//     this file hands it over without writing a byte; plus the 🔴 no-crosstalk
//     target check the owner calls "the line of life and death")
//   docs/strategy/2026-07-31-b3-protocol-round-plan.md (0.2.33: the known compat gap
//     below — an address-less frame forwarded unchecked — is CLOSED as a named
//     refusal, INJECT_PC_UNSPECIFIED)
//   *** HUMAN-AUDIT SENSITIVE (injection path) — reviewable in isolation ***
//
// PC↔mobile mirror relay within a room. inject:request + control:key go
// mobile→PC; inject:result + focus:state go PC→mobiles.
//
// 0.2.27 — WHAT CHANGED AND WHAT DID NOT. The server used to also write the true
// delivery status onto `transcript_history` (injected / cached / failed) as each
// inject:result passed through. That table is gone (owner's architecture ruling), so the
// write-back is gone. **The verdict itself is untouched**: every result — the
// PC's own, and the ones this file authors when a frame never reaches a PC — is
// still mirrored to the room's mobiles with request_id/entry_id echoed verbatim,
// which is how the row's OWNER (the phone that holds it, or the PC's local
// timeline) learns the outcome and records it. "No silent failure" is about the
// verdict travelling, not about who persists it; the one thing that would break
// the red line here is dropping a verdict. One drop window exists and is now at
// least LOUD: an inject:result arriving on a socket with no auth/room (buffered
// frames flushing on reconnect before re-registration — the same reachable
// window RCA-v3 documented for inject:request) cannot be mirrored, because
// without a room there is nobody to mirror it to; that guard logs a breadcrumb
// instead of a bare return, so the loss is visible in the journal.

import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { RoomStore } from '../../room/store';
import type { InjectPendingRegistry } from '../inject-pending';
import type { CloudImagePolicy } from '../cloud-image-policy';
import { getAuth, getRoomUuid } from '../wire';
import { log } from '../../log';
// V2-05 (requirement ⑥): t2/t3 of the server-clock latency segmentation. See obs/latency.ts
// for why every boundary is taken here and none on the phone.
import { markInjectRequest, markInjectResult } from '../../obs/latency';

// A dropped mirror frame used to be a SILENT return (13 §3 D1 — no silent
// failure). We still drop (behavior unchanged: a malformed frame never crosses
// the mirror), but now leave a forensic breadcrumb so a phone shipping an
// off-contract payload is diagnosable instead of vanishing. The zod issue is
// summarized (path+code), never the raw payload (may carry user text).
function logDrop(event: string, socket: Socket, err: { issues: { path: (string | number)[]; code: string }[] }): void {
  const first = err.issues[0];
  log.warn('relay: dropped malformed frame', {
    event,
    socket: socket.id,
    reason: first ? `${first.path.join('.') || '(root)'}: ${first.code}` : 'invalid',
    issues: err.issues.length,
  });
}

export interface RelayHandlerDeps {
  store: RoomStore<Socket>;
  /** 2026-07-30: waiters from the HTTP image-upload route (inject-pending.ts).
   *  Every parsed inject:result is offered to it; a result nobody waits on is
   *  the normal socket-path case. Optional so existing tests are untouched. */
  pending?: InjectPendingRegistry;
  /** RV-87 (owner 2026-08-01): the cloud relay's image policy — 1 MiB and 200
   *  pictures / 24 h, per ACCOUNT. ONE instance per server (bootstrap), because a
   *  per-connection limiter would limit nothing — the same trap ReleaseSuppression
   *  and InjectPendingRegistry carry notes about.
   *
   *  ⚠️ Optional here, and that is NOT a knowing compat gap of the
   *  `target_pc_id` kind: the object itself NOOPs in standalone, so the only
   *  caller that can legitimately omit it is a test that is not about this gate.
   *  Production wires it in both modes (bootstrap.ts) and the mode inside decides.
   *  Absent ⇒ every image passes, which is the pre-RV-87 behaviour and is exactly
   *  right for the LAN sidecar. */
  cloudImages?: CloudImagePolicy;
}

export function registerRelayHandlers(socket: Socket, deps: RelayHandlerDeps): void {
  const { store } = deps;

  // Pluck the two correlation echoes out of a frame that FAILED validation, so
  // the reject verdict below can still land on the row the phone is watching.
  // The raw payload is untrusted: only two string fields, length-bounded, are
  // ever read — nothing else from a malformed frame is interpreted.
  const rawEcho = (payload: unknown): { request_id?: string; entry_id?: string } => {
    if (typeof payload !== 'object' || payload === null) return {};
    const raw = payload as Record<string, unknown>;
    const pick = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
    const request_id = pick(raw['request_id']);
    const entry_id = pick(raw['entry_id']);
    return { ...(request_id ? { request_id } : {}), ...(entry_id ? { entry_id } : {}) };
  };

  /** The same two echoes off a frame that PASSED validation. Factored out the
   *  moment a SECOND typed refusal needed them (card S): two hand-written copies
   *  are how one reject site ends up echoing `request_id` only, leaving the
   *  sender's row on ⏳ forever because the verdict named an id it wasn't
   *  watching. */
  const echoOf = (data: { request_id?: string; entry_id?: string }): { request_id?: string; entry_id?: string } => ({
    ...(data.request_id ? { request_id: data.request_id } : {}),
    ...(data.entry_id ? { entry_id: data.entry_id } : {}),
  });

  // A server-authored inject:result carrying a verdict the PC never got to
  // give. 2026-07-29 (owner live repro): an image frame over the 5.5M zod cap
  // was dropped WITH a log but WITHOUT an answer — the phone sat out its full
  // 20 s watchdog and could only say "the computer did not respond". A drop is a verdict, and
  // every verdict must travel (red line: no silent failure, both directions). `mode` is
  // schema-required; 'cached' is the least-false value for "nothing was ever
  // attempted on the PC" — the mobile settles ✗ off `ok:false` alone.
  //
  // 0.2.27: this used to ALSO stamp `failed` on the server row so it would not
  // sit at ⏳. There is no server row; the echoed `entry_id` on this very frame is
  // what lets the sender's own store move its row off ⏳ — one verdict, delivered
  // to the end that owns the row, instead of a verdict plus a second copy of it.
  //
  // ⚠️ `mode` HERE IS NOT `inject:request.mode`. Same name, different question,
  // different domain: on the REQUEST it is the three-mode enum saying how the
  // entry was produced (realtime/translate/organize); on the RESULT it says HOW
  // it was delivered (sendinput/clipboard/cached). Copying one onto the other
  // because the key matches would be this repo's #1 bug shape and would not even
  // parse — which is luck, not a guard, so it is written down here instead.
  const answerReject = (
    error: 'INJECT_FRAME_TOO_LARGE' | 'INJECT_FRAME_INVALID' | 'INJECT_PC_OFFLINE'
      | 'INJECT_PC_MISMATCH' | 'INJECT_PC_UNSPECIFIED'
      | 'INJECT_CLOUD_IMAGE_TOO_LARGE' | 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
    echo: { request_id?: string; entry_id?: string },
  ): void => {
    socket.emit('inject:result', { ok: false, mode: 'cached', error, ...echo });
  };

  // mobile → PC: injection request
  socket.on('inject:request', (payload: unknown) => {
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (!auth || auth.kind !== 'mobile' || !roomUuid) {
      // 2026-07-30 (RCA-v3): this guard was the LAST silent drop on the relay
      // path — and a REACHABLE one: a client that noticed its dead link buffers
      // the emit and socket.io flushes that buffer on reconnect BEFORE the app
      // re-registers/rejoins, so the frame lands exactly here. It used to
      // vanish (no log, no answer), indistinguishable from a frame that never
      // left the phone. A verdict must travel: answer the socket directly
      // (there is no userId to write a row for — the row write-back stays the
      // authenticated paths' job).
      log.warn('relay: inject:request on a socket with no auth/room', {
        socket: socket.id,
        authed: auth !== null,
        kind: auth?.kind ?? null,
      });
      socket.emit('inject:result', { ok: false, mode: 'cached', error: 'INJECT_NOT_IN_ROOM', ...rawEcho(payload) });
      return;
    }
    const parsed = safeParseEvent('inject:request', payload);
    if (!parsed.success) {
      logDrop('inject:request', socket, parsed.error);
      const first = parsed.error.issues[0];
      const tooLarge = first !== undefined
        && first.path.join('.') === 'image_b64'
        && first.code === 'too_big';
      answerReject(
        tooLarge ? 'INJECT_FRAME_TOO_LARGE' : 'INJECT_FRAME_INVALID',
        rawEcho(payload),
      );
      return;
    }
    // ── 🔴 card S · cross-wiring identifiers is strictly forbidden (owner 2026-07-31 iron law, "the line of life and death, must not be violated") ────────
    //
    // "The delivery id" and "the target PC's id" must correspond. A sentence typed into the wrong
    // person's computer is not a degraded delivery — it is the single failure this
    // red line exists to make impossible. So a frame that names a PC other than
    // the one this connection is bound to is REFUSED: never re-routed, never
    // delivered "anyway", and never silently — the sender gets a verdict.
    //
    // THE EVIDENCE IS THIS CONNECTION'S TOKEN BINDING, NEVER "who is in the room right now".
    // On a mobile socket `auth.deviceId` IS `pc_devices.id` of the PC this phone
    // is paired to, resolved from its token and from nothing else
    // (auth/middleware.ts:169-172 → `mobileRow.pc_device_id`; mobile.handler.ts
    // :134/:180/:235 → `deviceId: pc.id`). `target_pc_id` is written in that exact
    // convention: it is the `pc_id` the phone was handed in its pairing ack — the SAME
    // `pc.id`, from the same three admission sites (mobile.handler.ts :143/:186/
    // :245), which the phone persists as `MobileSession.pcId`. One column, both
    // sides of the comparison.
    //
    // ⚠️ DO NOT "opportunistically optimize" THIS INTO `store.getPc(roomUuid)`'s identity. That
    // value answers "who is connected in the room at this instant" — a different question, and one whose
    // answer changes when a PC reconnects into the room or when a queue drains
    // later than it was filled (owner: "never infer 'who is current' when draining a queue"). The
    // room says WHERE the frame is about to go; the token says WHO it was
    // addressed to. Only comparing the second pair can ever catch a cross-wired id — asking
    // the room would compare the destination against itself and always agree.
    //
    // Checked BEFORE the room lookup on purpose: a mis-addressed frame must be
    // refused as mis-addressed even when the room happens to be empty, or the
    // sender would be told INJECT_PC_OFFLINE — "retry later" about a frame that
    // must never be delivered here at all.
    //
    // Fails CLOSED: an absent `auth.deviceId` proves nothing about the address, so
    // it takes the refusal branch too (`undefined !== 'pc-x'`). All four
    // production mobile auth sites set it, so that is unreachable today — but the
    // direction it fails in is the one that cannot type into a stranger's machine.
    const targetPcId = parsed.data.target_pc_id;
    if (targetPcId !== undefined && targetPcId !== auth.deviceId) {
      log.warn('relay: inject:request addressed to another PC — REFUSED', {
        socket: socket.id,
        // BOTH halves, because "who it wants to send to / who it is actually bound to" together are the
        // diagnosis; either one alone is unreadable. Both are device-row ids, not
        // user content — the same class of value already logged on this path.
        target_pc_id: targetPcId,
        bound_pc_id: auth.deviceId ?? null,
        room_uuid: roomUuid,
      });
      answerReject('INJECT_PC_MISMATCH', echoOf(parsed.data));
      return;
    }
    if (targetPcId === undefined) {
      // ── 0.2.33 (window B3): THE COMPAT GAP IS CLOSED ────────────────────────────
      //
      // This branch used to FORWARD and merely log. That was a knowing tolerance,
      // written down as one: a 0.2.28 phone could not stamp `target_pc_id`, and
      // refusing address-less frames would have broken every handset in the field.
      // The condition it named for its own closure has been met — 0.2.32 senders
      // stamp the field on all four emission paths — named by SYMBOL because the
      // line numbers this used to carry drifted within one window: mobile
      // `chat_utterance.dart` `_deliverDirect`, `manual_delivery.dart` `deliverText`
      // + `reInject`, `image_send_controller.dart` `_send` — so absence
      // stopped being "this phone just doesn't say it yet" and became a protocol violation.
      //
      // WHAT IT COSTS, on purpose: a phone older than that is now refused instead
      // of served. owner authorised exactly this
      // (docs/decisions/2026-07-31-owner-b3-image-resend-and-protocol-round.md),
      // and the refusal is the point — an unaddressed frame cannot be checked
      // against anything, so forwarding it means the red line has a branch where it
      // simply does not apply. The user is not left guessing: the verdict travels,
      // by name, with a sentence that names the one action that helps.
      //
      // ITS OWN CODE, NOT INJECT_PC_MISMATCH — "you didn't say which one to send to" vs "the one you want to
      // send to isn't this one" put the user in two different places; see the long note at
      // INJECT_PC_UNSPECIFIED in error-codes.ts.
      //
      // WHY THE BREADCRUMB IS NOW PER-FRAME (it was once-per-connection): that
      // argument was "the same harmless fact repeating would bury the log". It is
      // not a harmless fact any more — every line here is a delivery the user lost,
      // and collapsing ten losses into one line would hide how much was lost. Same
      // level and same shape as the mismatch branch above, because they are now the
      // same kind of event.
      log.warn('relay: inject:request carries no target_pc_id — REFUSED', {
        socket: socket.id,
        bound_pc_id: auth.deviceId ?? null,
        room_uuid: roomUuid,
      });
      answerReject('INJECT_PC_UNSPECIFIED', echoOf(parsed.data));
      return;
    }
    // ── RV-87 · the cloud relay's image policy (owner 2026-08-01) ──────────────────────────
    //
    // owner, verbatim: "If it's the relay channel, the server should uniformly block the client —
    // images over 1M should not be allowed through, to prevent
    // the relay from being used as a photo-sync tool" + "cap it at 200 photos... need a rule that excludes automated sends by machines".
    //
    // "The server uniformly blocks the client" is why this is HERE and not only on the phone: the
    // phone's own ceiling (image_payload.dart) answers "is it worth even making the trip" and is
    // worth having for owner's two stated reasons (user experience + saving the server's connection), but
    // a modified build is not bound by it. This one answers "is it allowed at all", and it is
    // the only one of the two that is a defence. Two gates, two questions — R4
    // satisfied rather than violated.
    //
    // THE CHANNEL JUDGEMENT IS THE SERVER'S OWN `config.mode` (inside the policy
    // object), never anything the frame claims. In standalone it NOOPs, which is
    // what keeps the refusal's own advice — "connecting to the same LAN lets it send" — true.
    //
    // WHY HERE, AFTER THE ADDRESSING GATES AND BEFORE THE ROOM LOOKUP:
    //   · after the cross-wired-id check — a mis-addressed frame must be refused AS mis-addressed no
    //     matter what else is wrong with it; the red line outranks a policy;
    //   · before `getPc` — otherwise an over-size picture sent while the PC
    //     happens to be away is answered INJECT_PC_OFFLINE, i.e. "retry later"
    //     about a picture that this channel will never carry. Same ordering rule,
    //     and the same reason, as the mismatch branch above.
    //
    // `judge` STAMPS NOTHING. The count is stamped at the emit below, so a picture
    // that is legal but reaches an empty room has not spent a slot — the phone's
    // outbox will retry it, and charging for the failed attempt would make an
    // offline PC eat a user's daily budget.
    if (parsed.data.source === 'image' && parsed.data.image_b64 !== undefined && deps.cloudImages) {
      const verdict = deps.cloudImages.judge(auth.userId, parsed.data.image_b64);
      if (!verdict.admit) {
        log.warn('relay: image refused by the cloud relay policy', {
          socket: socket.id,
          error: verdict.error,
          // The picture's SIZE and the account's COUNT, never the picture: this
          // is the same class of value already logged on this path (ids and
          // magnitudes), and it is what makes "who got blocked, and at what number"
          // answerable from the log alone.
          ...verdict.detail,
          user_id: auth.userId,
          room_uuid: roomUuid,
        });
        answerReject(verdict.error, echoOf(parsed.data));
        return;
      }
    }
    const pc = store.getPc(roomUuid);
    if (!pc) {
      // The `?.` here used to be a total void — no log, no mirror, a 20 s
      // mystery on the phone. A room with no PC is a real, nameable verdict.
      log.warn('relay: inject:request but no PC in room', {
        socket: socket.id,
        source: parsed.data.source,
      });
      answerReject('INJECT_PC_OFFLINE', echoOf(parsed.data));
      return;
    }
    // t2 — marked BEFORE the relay so the inject segment covers the PC's real
    // work, not our own emit. A dropped/invalid frame is deliberately not marked:
    // it never reached the PC, so timing it would attribute someone else's delay.
    markInjectRequest(roomUuid, parsed.data.entry_id ?? null);
    // Pass through, not storage (owner's architecture ruling 2026-07-31). `parsed.data` — not a rebuilt
    // object — is what crosses, so the card P row fields (created_at / source_text /
    // entry_type / thumb_b64 / device_label / target_pc_id) reach the PC exactly
    // as the phone wrote them. That is load-bearing rather than incidental: zod
    // objects STRIP unknown keys, so a relay whose protocol dist predates card P
    // does not refuse the new frame — it quietly delivers a frame with the row
    // fields cut out, and the PC renders a row that lost its timestamp and its
    // original text with nothing anywhere reporting a loss. Pinned by
    // test/relay-pc-target.test.ts ('all six row fields cross verbatim').
    // Nothing is written to any table on this path — the whole point of pass-through.
    pc.emit('inject:request', parsed.data);
    // RV-87: the slot is spent HERE — on the line after the picture actually
    // crossed — and nowhere else. Kept apart from `judge` above rather than folded
    // into it for exactly one reason: the refusal that sits BETWEEN the two —
    // INJECT_PC_OFFLINE, an entirely legal picture that found an empty room — must
    // cost the user nothing, because the phone's outbox will retry it and a flaky
    // PC would otherwise eat a day's budget. If this line is ever deleted the
    // ceiling silently stops existing, which is why the count is asserted end to
    // end (G15 relays 200 and expects the 201st refused) and not only in a unit
    // test of the policy object.
    if (parsed.data.source === 'image' && parsed.data.image_b64 !== undefined) {
      deps.cloudImages?.record(auth.userId);
    }
  });

  // mobile → PC: discrete control key
  socket.on('control:key', (payload: unknown) => {
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (!auth || auth.kind !== 'mobile' || !roomUuid) {
      // Same reachable window as inject:request above. control:key has no
      // result event to answer with (a key has no delivery row), so the
      // breadcrumb is the honest maximum here — never a bare `return`.
      log.warn('relay: control:key on a socket with no auth/room', {
        socket: socket.id,
        authed: auth !== null,
        kind: auth?.kind ?? null,
      });
      return;
    }
    const parsed = safeParseEvent('control:key', payload);
    if (!parsed.success) return logDrop('control:key', socket, parsed.error);
    store.getPc(roomUuid)?.emit('control:key', parsed.data);
  });

  // PC → mobiles: injection result + delivery-truth status writeback
  socket.on('inject:result', (payload: unknown) => {
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (!auth || auth.kind !== 'pc' || !roomUuid) {
      // Same reachable window as inject:request above (buffered frames flushing
      // on reconnect before re-registration). A verdict is the one thing this
      // file must never drop SILENTLY (header contract) — it cannot be mirrored
      // without a room, so the breadcrumb is the honest maximum here, exactly
      // as the control:key guard below does. Never a bare `return`.
      log.warn('relay: inject:result on a socket with no auth/room — verdict dropped', {
        socket: socket.id,
        authed: auth !== null,
        kind: auth?.kind ?? null,
      });
      return;
    }
    const parsed = safeParseEvent('inject:result', payload);
    if (!parsed.success) return logDrop('inject:result', socket, parsed.error);
    // t3 — closes the measurement and emits the `latency.segment` line. Marked
    // for EVERY result, ok or not: a failed injection still took time, and the
    // slow-failure case is exactly the one worth being able to see.
    markInjectResult(roomUuid, parsed.data.entry_id ?? null);
    // 2026-07-30: hand the verdict to any HTTP upload waiting on this
    // request_id (inject-pending.ts). No-op for the socket path.
    deps.pending?.resolve(parsed.data);
    // 0.2.27: the server-side status write-back that stood here is gone with
    // `transcript_history` (owner's architecture ruling). Note what it also took with it: the
    // GA-05 cross-tenant guard it needed (a PC on account A could stamp a status
    // onto account B's row by naming its id) is not weakened but MOOT — there is
    // no row on this side to address. The mirror below was never id-addressed: it
    // is scoped by ROOM, so a result can only reach the mobiles of the room the
    // reporting PC is actually in.
    //
    // `inject_target` (F-3112: "where did this message go") is still on this frame and
    // still reaches the phone verbatim; the server simply no longer keeps a copy.
    for (const m of store.getMobiles(roomUuid)) m.emit('inject:result', parsed.data);
  });

  // PC → mobiles: foreground focus mirror (transient, never persisted)
  socket.on('focus:state', (payload: unknown) => {
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (!auth || auth.kind !== 'pc' || !roomUuid) return;
    const parsed = safeParseEvent('focus:state', payload);
    if (!parsed.success) return logDrop('focus:state', socket, parsed.error);
    // WP-R4-4 (§4.1 source ②): capture the latest focus process_name for the
    // room so compose:start can resolve the app-scenario descriptor. Transient
    // (in-memory), cleared on PC disconnect / room switch by the store.
    store.setFocusProcess(roomUuid, parsed.data.process_name);
    // 2026-07-29: also keep the WHOLE payload, so a mobile arriving between two
    // foreground changes can be handed the current focus on join (this event is
    // change-only; without a pull the late listener is blind until the user
    // happens to switch windows — owner: "the top doesn't show the focus, but exiting and reconnecting shows it again").
    store.setLastFocus(roomUuid, parsed.data);
    for (const m of store.getMobiles(roomUuid)) m.emit('focus:state', parsed.data);
  });
}

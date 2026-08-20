// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 (protocol whitelist — canonical 54 as of
//     the 2026-07-31 stage-5 cleanup; the §3 tables still list the four removed
//     names and need a doc pass)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.8 (timeline sync, v2.0 — A-49)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md (rename window)
//
// Single source of truth for the socket.io event whitelist. Any event
// name emitted/received by client or server code MUST appear in
// EVENT_NAMES below. The protocol-whitelist lint walks the codebase and
// fails CI on unknown event names.
//
// WP-R0-1 rename window (one-shot, then whitelist-locked): three names were
// RENAMED to sys:ping / sys:pong / control:key — the count was unchanged at 55,
// none added or removed. Full old→new mapping:
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//
// R6 T-8: ONE additive name — `pc:list-mobiles` (55 → 56). The PC-side mirror of
// the already-whitelisted `mobile:list-pcs`: the desktop device page could only
// ever show 「N 台在线」 because no wire face existed for「this PC's paired
// phones」 (the rows were in mobile_pairings the whole time; the REST
// /api/cloud/devices face is console-only and saas-only, so a standalone PC
// socket could not reuse it). Query-only, ack-shaped, zero-secret projection —
// no existing event's shape changed.
//
// 2026-07-31 stage-5 protocol cleanup (owner approved) — the FIRST subtractive
// window since the line began: 58 → 54. A whitelist entry is a PROMISE that the
// wire verb exists; four of them promised nothing. Each was removed only after a
// three-end grep (server-core / desktop TS+Rust / mobile) proved there is
// neither a sender nor a receiver in production code:
//   · `history:create-local` — the F-2367 compose-watchdog local-fallback upload.
//     Never ported: no mobile emitter, no server handler, no desktop reference.
//   · `mobile:switch-pc`     — same-server PC switching. 04 §3.1 has carried the
//     note「0.1.0 无实现：换 PC 走连接页断连重连」since GA-17; switching really is
//     a disconnect/reconnect, so the name was pure reserved vocabulary.
//   · `audio:heartbeat`      — the mobile emitted it every 5 s and NOBODY
//     listened (a façade: sent, nobody received). Its one payload field,
//     `last_chunk_seq`, exists solely to drive gap detection, and that loop was
//     never built. Plain `heartbeat` rides the SAME 5 s timer and DOES have a
//     server handler, so liveness loses nothing.
//   · `audio:resend-request` — the mirror façade (listened, nobody sent): the
//     mobile has a complete handler, the server has never emitted one. What it
//     was for — lossless recovery of chunks lost across a blip — is already
//     SHIPPED by a different mechanism: on every reconnect the mobile replays
//     its whole 30 s ring (signaling/reconnect.dart) and the server's
//     SeqTracker.hasObserved() dedupes. Keeping the name would advertise a
//     second recovery path that has no server half.
// RETAINED against the same sweep: `timeline:grant-request` / `timeline:grant`.
// They are the E2EE web-authorization handshake and their payload carries the
// `e2e:v1:` half of the double-prefix red line (enc:v1: server-decryptable vs e2e:v1:
// blind-stored, never interchangeable). Per the 2026-07-31 E5 ruling E2EE was
// not in the pre-release batch and the two names sat declared-not-built for a
// while; since GRANT-1 (2026-08-11) the SERVER half is real — server-core
// registers handlers for both and emits `timeline:grant` to the requesting web
// socket (grant.handler.ts, symbol `registerGrantHandlers`). Client emitters
// are cards GRANT-2 (phone) / GRANT-3 (web repo).

export const EVENT_NAMES = [
  // §3.1 Authentication / pairing
  'pc:register',
  'pc:reconnect',
  'pc:refresh-code',
  'pc:release-mobile',
  // R6 T-8 additive (55 → 56): PC → server query for the mobiles paired to THIS
  // PC. (No apostrophes inside this array literal — the protocol-whitelist lint
  // parses it with a single-quote regex and an apostrophe swallows the names.)
  'pc:list-mobiles',
  'pc:mobile-joined',
  'pc:mobile-left',
  'mobile:pair',
  'mobile:reconnect',
  'mobile:unpair',
  'mobile:list-pcs',
  'mobile:login',
  'mobile:logout',
  // 54 → 55 (owner approved 2026-08-20, in the same breath as the ruling this
  // exists to serve: `docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md`).
  //
  // WHY A FIELD WOULD NOT DO, and it is the same test `stt:refined` had to pass.
  // The server already ENDS this socket — `pc.handler.ts` does
  // `mobileSocket.disconnect(true)` — so there is no later frame to hang a field
  // on. What is missing is a sentence said BEFORE the close, and a close carries
  // no payload.
  //
  // 🔴 WHY IT CANNOT RIDE `PAIR_RELEASED` INSTEAD. That code already exists and
  // says the same thing — but it only reaches the phone on the NEXT
  // `mobile:reconnect`, i.e. after the phone has dialled back in. That round trip
  // IS the retry owner just ruled must not happen. Measured on the reporting
  // machine, the drop the phone sees is `socket.drop io_reason=io server
  // disconnect` — byte-identical to its own network dying. Two causes, one
  // observation, opposite correct actions: this event is what separates them at
  // the only moment that matters, which is before the phone decides to dial.
  //
  // ⚠️ FAILURE DIRECTION, and it dictates the deploy order. An old phone does not
  // listen for this and simply falls back to what it does today (drop → dial →
  // `PAIR_RELEASED`), so a relay that emits it is safe for every existing client.
  // A NEW phone against an OLD relay never hears it and also falls back. Both
  // degrade to the behaviour that ships today rather than to a worse product ⇒ **deploy the
  // relay BEFORE shipping the APK**, same rule and same reason as error code 60.
  'mobile:released',
  'auth:expired',

  // §3.2 Heartbeat / liveness
  'heartbeat',
  'sys:ping',
  'sys:pong',

  // §3.3 Audio / STT
  'audio:start',
  'audio:chunk',
  'audio:pause',
  'audio:resume',
  'audio:stop',
  'audio:auto-stopped',
  'stt:interim',
  'stt:final',
  'stt:error',
  'stt:engine-status',
  'stt:level',
  // GA-14 two-pass refine (06 §5). The FIRST new event name since the 0.2.0
  // freeze, and a deliberate one: owner approved 56 → 57 on 2026-07-26 because a
  // field would have been a lie. It could not ride `stt:final` — a second final
  // for a finished utterance is exactly the FSM-wedging class GA-03 fixed — and
  // it could not ride `history:updated`, because the PHONE owns the row (only
  // the mobile emits history:create), so the server has nothing to write back to.
  'stt:refined',

  // §3.4 LLM / Compose
  'compose:start',
  'compose:chunk',
  'compose:done',
  'compose:error',

  // §3.5 Inject / control
  'inject:request',
  'inject:result',
  // §3.5 F-3113 focus-target mirror (v2r2 batch1 — A-54). Took the canonical
  // whitelist 54 → 55.
  'focus:state',
  'control:key',

  // §3.6 History sync
  'history:list',
  'history:list-result',
  'history:create',
  'history:update',
  'history:updated',
  'history:delete',
  'history:deleted',
  'history:inject',

  // §3.7 Settings sync
  'settings:list',
  'settings:update',
  'settings:updated',

  // §3.8 Timeline sync (v2.0 — A-49). Four shipped in Phase 1; the two grant:*
  // names gained their SERVER half in GRANT-1 (2026-08-11) — client emitters
  // are still pending (GRANT-2 phone / GRANT-3 web). See the header note.
  'timeline:push',
  'timeline:pull',
  'timeline:pull-result',
  'timeline:tombstone',
  'timeline:grant-request',
  'timeline:grant',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const EVENT_NAME_SET: ReadonlySet<EventName> = new Set(EVENT_NAMES);

// Kept deliberately through the 2026-07-31 dead-export sweep even though no
// PRODUCTION call site exists (handlers validate with safeParseEvent, and the
// unknown-event gate is static — verify/lint/protocol-whitelist.mjs). This is
// the whitelist module's own definitional predicate and it is what the count
// guard uses to prove「no orphan schema」; deleting it would only push the same
// membership check into the test by hand. Its sibling `parseEvent` was removed
// in that sweep for the opposite reason: a THROWING parse variant on a socket
// path is a live trap, not just an unused symbol.
export function isKnownEvent(name: string): name is EventName {
  return EVENT_NAME_SET.has(name as EventName);
}

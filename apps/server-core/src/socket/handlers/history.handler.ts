// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (owner's architecture ruling:
//     "phone↔PC does not do cloud storage sync, the cloud does not store
//     transcripts" — the plaintext room-sync link is
//     retired and `transcript_history` is dropped)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.6 (history:list/create/update/delete/
//     inject — the NAMES survive this retirement; see below for why)
//   CLAUDE.md red line: no silent failures (both directions forbidden)
//
// ── THIS FLOW WAS RETIRED IN 0.2.27 ────────────────────────────────────────
//
// The server no longer stores transcripts. `transcript_history` is DROPPED, every
// read and write path over it is gone, and each end now OWNS its own timeline
// (PC: 0.2.26 local ownership + local search; phone: sqflite). Nothing here can
// list, create, edit, delete or re-inject a server row, because there is no
// server row.
//
// WHY THIS FILE STILL EXISTS — the reason it is kept: a client still running 0.2.26 keeps
// emitting these five frames (the phone's reflush queue, the desktop's timeline
// edit/delete/re-inject). An event name that is NOT registered is SILENTLY
// DISCARDED by socket.io — and silence is the red line. So every one of the five
// names stays registered and answers, out loud, with `HISTORY_SYNC_RETIRED`
// ("The server no longer saves transcript history; this one stays local only.").
//
// The refusal code is deliberately NEW and deliberately NOT one of the two codes
// that were already lying around:
//   · SETTINGS_SYNC_FAIL + 'no such entry' — the phone HARDCODES that answer as
//     "the other side deleted this row" (timeline_sync.dart) and physically DELETEs the local row.
//     Reusing it after dropping the table would turn a retirement into silent
//     user-data destruction, at 100% hit rate.
//   · CLOUD_SESSION_NO_HISTORY — blames the SESSION TYPE ("the cloud session
//     does not save history on the server"), which after this change is true of EVERY session. A half-true
//     reason is still a lie (0.2.18 PC_BUSY paid for this lesson).
//
// The KNOWLEDGE removed with the code is not lost: the C5 conflict criterion
// (LWW + "the loser must be notified") lives on as design in
// docs/strategy/2026-07-30-c5-conflict-criteria-design.md, whose header names the
// light-record multi-device (轻记录多设备) case that will reuse it.
//
// NOT retired, and not to be confused with this link: `timeline:*` (the e2e:v1:
// blind store) and `inject:request` / `inject:result` (delivery + its verdict,
// relay.handler). Deferred re-delivery (补投) now travels as an `inject:request` that CARRIES ITS TEXT —
// the row's owner supplies it, since the server cannot look it up any more.

import type { Socket } from 'socket.io';
import { safeAck } from '../wire';
import { log } from '../../log';

export function registerHistoryHandlers(socket: Socket): void {
  // First refusal per event per socket is logged; the repeats are answered but
  // not re-logged. A 0.2.26 phone re-flushes its whole pending queue on every
  // reconnect, so logging each frame would bury the log — while answering each
  // frame is mandatory (that is the red line, not the log).
  const announced = new Set<string>();
  const refuse = (event: string, ack: unknown): void => {
    if (!announced.has(event)) {
      announced.add(event);
      // No version number in this string, deliberately (CLAUDE.md: if a number
      // can be removed, remove it).
      // It said "retired in 0.2.27" and shipped in a build reporting 0.2.28 — the
      // round burned a version number (see the window-A handoff §5), and a log line
      // that names a release is one more face that can drift. `/api/health` is where
      // "which version" gets answered; this line only has to answer "why was it refused".
      log.info('history: refused, server-side transcript sync is retired', {
        socket: socket.id,
        event,
      });
    }
    // No zod parse first: the answer does not depend on the frame's shape, and
    // parsing to reject would let a malformed frame get a DIFFERENT (schema)
    // answer than a well-formed one about the same non-existent flow.
    safeAck(ack, { error: 'HISTORY_SYNC_RETIRED' });
  };

  // All five names written out literally, not looped over an array: verify/lint's
  // protocol-whitelist scans `.on()` string literals, and a loop would hide every
  // name from it. `history:list-result` / `history:updated` / `history:deleted`
  // are SERVER→CLIENT names — there was never an `.on()` for them here, and now
  // there is no producer either.
  socket.on('history:list', (_payload: unknown, ack: unknown) => refuse('history:list', ack));
  socket.on('history:create', (_payload: unknown, ack: unknown) => refuse('history:create', ack));
  socket.on('history:update', (_payload: unknown, ack: unknown) => refuse('history:update', ack));
  socket.on('history:delete', (_payload: unknown, ack: unknown) => refuse('history:delete', ack));
  socket.on('history:inject', (_payload: unknown, ack: unknown) => refuse('history:inject', ack));
}

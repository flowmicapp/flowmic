// Split out of audio.handler.ts (2026-09, structural only — zero behaviour
// change). That file crossed its line budget; this module carries ONE
// coherent family lifted out VERBATIM: the `audio:start` refusal gate — which
// gate turned a press away (StartRefusalGate) and the function that turns a
// refusal into a wire event and a log line (refuseStart). The three billing
// call sites (recordSttUsage / recordLlmUsage / ensureQuota) stay in
// audio.handler.ts on purpose — apps/server-core/test/billing-call-sites.test.ts
// asserts their exact file location by source census, and moving them would
// break that census without moving the invariant it protects.
//
// `refuseStart` used to be a nested function closing over `socket` inside
// `registerAudioHandlers`. Here it is a small factory (`createRefuseStart`)
// that takes `socket` explicitly and returns the same closure shape — every
// existing call site in audio.handler.ts (`refuseStart(e, at)`) is unchanged.

import type { Socket } from 'socket.io';
import type { Delivery } from '@flowmic/protocol';
import { getRoomUuid } from '../wire';
import { log } from '../../log';

/**
 * card K-5 — WHICH of `audio:start`'s four gates turned this press away.
 *
 * Before QTA-2 the log line "audio:start refused" + a code was enough, because
 * there was exactly one account and exactly one thing that could refuse. There
 * are now TWO accounts (acting phone / PC owner) and the same `QUOTA_EXCEEDED`
 * string comes out of both, so the line could name the failure without naming
 * WHOSE ledger produced it — and telling those two apart is precisely what cost
 * an afternoon of archaeology in the QTA-1 diagnosis.
 *
 * Ids, codes and the delivery intent only; never payload text (error-handling.ts
 * PRIVACY: audio frames carry user speech, the log file must not).
 */
// 'operation' — card PR-2 (2026-09-06): a re-send that named an operation this
// account already registered against DIFFERENT audio. Its own value rather than
// a reuse of 'payload': the frame is well-formed, and an operator triaging
// 「why was this press refused」 must be able to tell a malformed frame from a
// client whose recovery bookkeeping has drifted — two different bugs, in two
// different codebases.
export type StartRefusalGate =
  'auth' | 'payload' | 'verify_grace' | 'acting' | 'pc_owner' | 'engine' | 'operation';

/**
 * 🔴 QTA-1 (2026-08-15) — SAY THE REFUSAL OUT LOUD, on the wire and in the log.
 *
 * MEASURED, tablet TB335ZC + relay journal, 2026-08-15 17:21:40Z+8:
 * held the talk button 4 s inside a cloud-relay PC instance. `AudioRecord ...
 * 16000 Hz packageName app.flowmic.android` in logcat (the mic really opened),
 * one live TLS socket to the relay (`/proc/net/tcp`, uid 10309 → :443), and
 * then: NOTHING. No route selection, no `audio intake`, no line of any kind in
 * the relay journal — and nothing on the phone either. The same gesture in the
 * record-only instance two minutes earlier logged the full trace.
 *
 * Cause: the two refusal arms below returned through `safeAck` ALONE, and
 * `quota-guard.ts`'s own header already records that nobody reads that ack —
 * the phone emits `audio:start` fire-and-forget (`ptt_session.dart` pttDown).
 * So an over-quota account got: no text, no error, no log. Both ends silent
 * about a user being turned away is the red line ("没有静默失败"), and it also
 * cost an afternoon of archaeology to attribute, which is the second reason
 * the `log.warn` is here and not only the frame.
 *
 * ⚠️ WHY `stt:error` AND NOT A NEW EVENT / A FIXED ACK READER: this arrives at
 * every phone ALREADY IN THE FIELD. `ptt_inbound.dart` has caught terminal
 * `stt:error` since ENG-3 and `onSttTerminalError` deliberately handles the
 * RECORDING case ("exactly when a cold-open failure on `audio:start` arrives"),
 * latching it until the press ends; `sttStallBannerMessage` then keys on the
 * WIRE CODE. So a 0.3.1 build that will never be updated still says something
 * true. Zero protocol change: same whitelisted event, same schema, same
 * direction — only which frames survive the trip.
 *
 * 🔴 IT NOW COVERS THE `AUTH_TOKEN_INVALID` ARM TOO — this paragraph used to
 * say it deliberately did not, and the argument it gave was half right.
 * 「Dressing an auth failure as an engine fault would be the 0.2.53 shape」 is
 * true, and it is an argument about the PHONE'S COPY, not about whether the
 * refusal should leave the server. What actually happened while this arm was
 * excluded: `audio:start` is emitted WITHOUT an ack callback (ptt_session), so
 * the ack this arm filled was read by nobody — a phone whose account had been
 * deleted held the mic, recorded, and was told nothing at all. 「It has its own
 * re-pair surface」 was a claim about a path that only runs if something else
 * happens to notice.
 * ⇒ The refusal leaves the server (QTA-1), and the 0.2.53 half is honoured
 * where it belongs: `sttStallBannerMessage` has a NAMED arm for this code that
 * says the phone is no longer signed in — never the generic engine sentence.
 * Owner ruling 2026-08-27 §R1 追加: every relay refusal must reach the screen.
 */
// 🔴 NR-2a widened the FIRST parameter from `ErrorPayload` to a structural
// `{error: string}`. That is not a loosening for convenience: the grace
// refusal is an ACK-LOCAL name and deliberately NOT a protocol `ErrorCode`
// (auth/verification-grace.ts states why), so it cannot be typed as one — and
// routing it around this function instead would have given `audio:start` a
// SECOND refusal path, one of which emits `stt:error` and one of which does
// not. The phone reads `stt:error` and does not read this ack (QTA-1, and the
// quota-guard correction block); a refusal that skipped this function would
// therefore be a silent failure by construction. `ErrorPayload` still
// satisfies the parameter, so every existing call site is unchanged.
export function createRefuseStart(
  socket: Socket,
): (
  e: { error: string; message?: string },
  at: {
    gate: StartRefusalGate;
    /** The account this gate JUDGED — not always the acting one (see K-5). */
    userId: string | null;
    /** null only on the payload arm, where there is no parsed frame to read it from. */
    delivery: Delivery | null;
  },
) => void {
  function refuseStart(e: { error: string; message?: string }, at: {
    gate: StartRefusalGate;
    /** The account this gate JUDGED — not always the acting one (see K-5). */
    userId: string | null;
    /** null only on the payload arm, where there is no parsed frame to read it from. */
    delivery: Delivery | null;
  }): void {
    log.warn('audio:start refused', {
      code: e.error,
      message: e.message ?? null,
      room: getRoomUuid(socket),
      gate: at.gate,
      user_id: at.userId,
      delivery: at.delivery,
    });
    socket.emit('stt:error', {
      code: e.error,
      message: e.message ?? 'audio:start refused',
      retryable: false,
      // WP-9 (findings-crossend-quota.md #3) — additive, and only meaningful
      // for QUOTA_EXCEEDED: `at.gate === 'pc_owner'` is set ONLY when the
      // quota try-block above judged the PC OWNER's ledger (QTA-2), never the
      // acting phone's own. Omitted for every other refusal so nothing about
      // this frame changes for a code the field was not built for.
      ...(e.error === 'QUOTA_EXCEEDED' ? { judged_account: at.gate === 'pc_owner' ? 'pc_owner' : 'self' } : {}),
    });
  }

  return refuseStart;
}

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
import { getAuth, getRoomUuid } from '../wire';
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
// 'integrator_key' — card MP-1 (2026-09-11): the per-key sub-quota on a
// third-party host room. Its OWN value for `trial_cap`'s reason and one more:
// this is the only gate here whose ceiling is not an ACCOUNT at all, so an
// operator reading 「refused」 beside an integrator's healthy plan needs the line
// itself to say which of the two ran out.
// 'trial_cap' — card MP-6 (2026-09-11): the site demo's per-browser ceiling.
// Its OWN value rather than a reuse of 'acting', because the two name different
// ledgers and an operator triaging 「why was this press refused」 must be able to
// tell 「this account is out of minutes」 from 「this browser has used its two」 —
// the second is fixed by signing in, the first is not.
export type StartRefusalGate =
  'auth' | 'payload' | 'verify_grace' | 'acting' | 'pc_owner' | 'trial_cap' | 'integrator_key' | 'engine' | 'operation';

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
/**
 * card MP-1 — 「may this press run against the integrator key this room was
 * minted with」, or null when nothing here refuses.
 *
 * 🔴 ITS OWN CODE, NOT `QUOTA_EXCEEDED`. The speaker on an integrator page is a
 * visitor on somebody else's site; `INTEGRATOR_QUOTA_EXCEEDED`'s registry entry
 * carries the whole argument, and the short version is that 「本月套餐用量已达上
 * 限」 is false in both halves for this reader — it is not their plan, and
 * upgrading would not move this ceiling by a second, because signing in does not
 * change who pays (owner §11 追认 item 1).
 *
 * 🔴🔴 CORRECTION (card MP-12, owner 2026-09-11 §11 追认 item 3) — THIS ARM NOW
 * WRITES A `usage_events` REFUSAL ROW. The paragraph this replaces is kept
 * verbatim below because it was the reasoning MP-1 shipped on, and it is half
 * right in a way worth keeping visible:
 *
 *   「AND IT WRITES NO `usage_events` REFUSAL ROW, unlike the quota gate beside
 *    it. That row's subject is an ACCOUNT whose ceiling was hit
 *    (`refused_user_id`), and here the integrator's account is fine — what ran
 *    out is one of their keys. A row saying 「this account was refused」 would
 *    have the wrong subject, which is the exact defect `refused_user_id` was
 *    added to stop. The refusal is still SAID on the wire and still logged with
 *    `gate:'integrator_key'`, which is what an operator greps.」
 *
 * What that argument got right: the row must not claim T's PLAN ran out. What it
 * got wrong: it concluded 「so write nothing」, which left the integrator with no
 * durable record of the one number they need — 「how many visitors did my site
 * turn away this cycle」. A journal line is not that record: it rotates, and it
 * is the operator's surface, not T's.
 *
 * ⇒ The row IS written, and `integrator_key_id` is the column that keeps its
 * subject honest — 「this key refused a press」 rather than 「this account is out
 * of minutes」. The write itself is at the call site (`audio.handler.ts`), beside
 * the quota gate's, because the handler is the layer that knows which ceiling
 * said no; this function still answers one question and writes nothing.
 *
 * ⚠️ THE ROW AND THE COUNT ARE BEHIND `FLOWMIC_USAGE_EVENTS_ENABLED`, WHICH IS
 * OFF ON THE RELAY (`db/schema-integrator.ts` states this, which is why the
 * sub-quota's own counter is a column and not a query over this log). So the
 * console's `refused_count` reads 0 in production until an operator turns
 * collection on. Named here rather than discovered later.
 *
 * 🔴 AN ABSENT READER REFUSES. `?? 0` and never a default of Infinity: a
 * process that cannot read the counter (a replica, an unwired deployment) must
 * lean toward refusing (design §5), because the alternative is serving an
 * integrator's page against a ceiling nothing is enforcing.
 */
export function integratorKeyRefusal(
  auth: { integratorKeyId?: string },
  keys: { remainingMs(keyId: string, at: number): number } | undefined,
  now: number,
): { error: 'INTEGRATOR_QUOTA_EXCEEDED' } | null {
  const keyId = auth.integratorKeyId;
  if (keyId === undefined) return null;
  if ((keys?.remainingMs(keyId, now) ?? 0) > 0) return null;
  return { error: 'INTEGRATOR_QUOTA_EXCEEDED' };
}

/**
 * WHOSE LEDGER THIS `QUOTA_EXCEEDED` IS ABOUT — `'self'` (the speaker's own) or
 * `'pc_owner'` (the other side's).
 *
 * 🔴 Card MP-11 — IT ASKS THE ADMISSION, NOT THE GATE, and that is the fix.
 * WP-9 read `at.gate === 'pc_owner'`, which was right while a SECOND gate
 * existed to judge the far end's ledger separately. Card MP-10 retired that
 * gate: under 「far end pays」 the room owner is not a second ledger checked
 * after the speaker's, it is THE ledger, checked once, through `gate:'acting'`
 * — because by then `auth.userId` IS the owner. So the old test answered
 * `'self'` for every refusal the product can actually produce, and the sentence
 * `sttStallQuotaExceededPcOwner` (mobile recording_strings.dart:357) became
 * unreachable: a phone whose OWNER'S computer is out of minutes was told its
 * own account was, which is the status-truth red line (R11) — the word was
 * wrong, and the user's only true remedy (ask the other side) was not on
 * screen.
 *
 * 🔴 `payerReason === 'peer'` IS THE WHOLE TEST, because it is the one value
 * that MEANS「the ledger being spent is the far end's, and the speaker is not
 * that account」 (auth/metering-principal.ts `resolvePayer`, the `'app'`/`'web'`
 * branch). It is stamped ONCE, at admission, by the same decision that chose
 * the account — so this cannot disagree with whose minutes actually moved.
 *
 * ⚠️ EVERY OTHER VALUE KEEPS `'self'`, unchanged, and two of them deliberately:
 *  · `'host'` (an integrator room) and `'demo'` — the speaker is a stranger on
 *    somebody else's page, and the far end there is not a「PC owner」the copy
 *    could name. That copy question is not this card's, and inventing an answer
 *    here would put a sentence about a computer on a page that has none. A
 *    `QUOTA_EXCEEDED` on those rooms is registered as still saying `'self'`.
 *  · UNDEFINED — a standalone box, a LAN room, or any admission that ran before
 *    `payerReason` was stamped. `?? 'self'` matches what budget-frames.ts does
 *    with the same field for the same reason: absence is not evidence of a far
 *    end, and the pre-MP-10 answer was `'self'` too.
 *
 * `at.gate === 'pc_owner'` is still honoured first. It is unreachable in
 * production today (metering-principal.ts `pcOwnerQuotaGate` answers null on
 * every branch), but it is the value whose ONLY meaning is this one, and
 * dropping the mapping would mean re-deriving it if that gate ever comes back.
 */
function judgedAccount(socket: Socket, gate: StartRefusalGate): 'self' | 'pc_owner' {
  if (gate === 'pc_owner') return 'pc_owner';
  return (getAuth(socket)?.payerReason ?? 'self') === 'peer' ? 'pc_owner' : 'self';
}

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
      // for QUOTA_EXCEEDED. Omitted for every other refusal so nothing about
      // this frame changes for a code the field was not built for.
      ...(e.error === 'QUOTA_EXCEEDED' ? { judged_account: judgedAccount(socket, at.gate) } : {}),
    });
  }

  return refuseStart;
}

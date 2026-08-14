// The DETACHED polish pass (card RT-1's second delivery mode) — and the account of
// why it computes a correction and delivers nothing.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs SRC_MAX), not by an architectural claim — the bridge
// was sitting at 795. Read the seam as "this family happened to be movable as a
// whole block", not as "detached
// polish is now a layer" — same wording, and the same reason, as the earlier
// `stt-session-autostop.ts` split. The one caller is `stt-session.ts`
// `kickPolish`, which is now wiring and nothing else.
//
// 🔴 WHAT MOVED AND WHAT CHANGED — enumerated, because a blanket "verbatim" is
// exactly the claim that rots. Every comment and every statement below is
// byte-for-byte what it was inside `SttSessionBridge`, with these mechanical
// edits and no others:
//   (1) the whole family is de-indented by two spaces (class member → module
//       scope). No line's CONTENT changed;
//   (2) `kickPolish` → `export function kickDetachedPolish`. The config it used
//       to read off `this.deps.polish` is now its first parameter, so the line
//       `const polish = this.deps.polish;` is gone and the caller reads that
//       field instead;
//   (3) `runDetachedPolish` → `export async function`, same two parameters plus
//       the two things its body used to take off `this`;
//   (4) `this.now()` → `now()` (2 sites) and `this.meterPolish(…)` →
//       `meterPolish(…)` (1 site).
// **Any other difference is a bug.**
//
// 🔴 THE CLOCK AND THE METER ARE HANDED IN, NOT REBUILT. `meterPolish`'s own doc
// says why it is 「ONE copy, shared by both delivery modes」 — two copies of a
// billing call is how the numbers drift, and the census in
// billing-call-sites.test.ts counts FILES, so a second copy in a NEW file is
// precisely the one it would not have caught. Same for `now`: the session's
// injected clock, never `Date.now`.
//
// 🔴 THIS IS STILL NOT REACHABLE FROM PRODUCTION, and the move does not change
// that. The mode is selected by a dep and `test/polish-delivery-census.test.ts`
// fails if any file under `src/` selects it; moving an implementation moves no
// selector.

import { polishFinalText, type PolishDeps } from '../stt/stt-polish';
import { refinedTextOrNull } from '../stt/stt-refine';
import type { SelectedLlmConfig } from '../compose/llm-config';
import { log } from '../log';

/** ADDED BY THE SPLIT (it had no name while both halves lived in one class):
 *  the shape of [[SttSessionBridge.meterPolish]], which is passed in rather than
 *  re-implemented. */
export type MeterPolish = (
  polish: { llm: SelectedLlmConfig },
  result: { usage?: { tokensIn: number; tokensOut: number } },
) => void;

/**
 * 🔴 RT-1 — the DETACHED polish pass. NOT REACHABLE FROM PRODUCTION: it runs
 * only when a caller asks for `polishDelivery: 'detached'`, and a census fails
 * if any file under `src/` ever does. See [[SttSessionDeps.polishDelivery]] for
 * the activation triple. Kept complete and test-driven rather than deleted —
 * the mechanism is correct; only its activation is premature.
 *
 * Nothing awaits it, by construction: `finish()` bills and settles, the audio
 * handler's `.finally(dispose)` tears the session down, and this task outlives
 * both. That is owner's async shape — the utterance's latency must not contain
 * the LLM's.
 *
 * 🔴 The `.catch` is P0, not tidiness. `installProcessGuards`
 * (error-handling.ts) routes `unhandledRejection` → onFatal → graceful close →
 * `exit(FATAL_EXIT_CODE)`: a rejection escaping a detached task KILLS THE RELAY
 * for every online user. The synchronous path carries the same guard at its own
 * call site (「seam ③」) and this is its counterpart.
 */
export function kickDetachedPolish(
  polish: { llm: SelectedLlmConfig; deps?: PolishDeps } | undefined,
  pureText: string,
  now: () => number,
  meterPolish: MeterPolish,
): void {
  if (polish === undefined) return;
  void runDetachedPolish(polish, pureText, now, meterPolish).catch((err) => {
    log.error('stt.polish detached pass failed unexpectedly — the bare final stands', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function runDetachedPolish(
  polish: { llm: SelectedLlmConfig; deps?: PolishDeps },
  pureText: string,
  now: () => number,
  meterPolish: MeterPolish,
): Promise<void> {
  const startedAt = now();
  // The config was resolved ONCE, at audio:start, and frozen into this dep with
  // its provenance (stt-factory resolvePolishDep). It is NEVER re-resolved here:
  // a second resolve would drop `source` and hand the meter a BYOK verdict
  // derived from key shape — the exact "one value answers two questions" that M4 deleted.
  const result = await polishFinalText(pureText, polish.llm.cfg, polish.deps ?? {});
  meterPolish(polish, result);
  // ── delivery ────────────────────────────────────────────────────────────
  //
  // 🔴🔴 THERE IS NO SAFE CARRIER FOR THIS RESULT TODAY, SO IT IS NOT SENT.
  //
  // The obvious carrier is `stt:refined` (GA-14's event). It was designed into
  // this card and then withdrawn on evidence, so the reasoning is recorded here
  // rather than left for the next person to rediscover:
  //
  //   · the phone cannot correlate. `ptt_session.dart` exposes a bare
  //     `Stream<String>`; `chat_utterance.dart` `_applyRefined` applies it to
  //     `store.entries` — the newest ROW by createdAt, UNFILTERED by entry type
  //     or owner, guarded only on `edited` and `processedText != null`;
  //   · `_entries` has five insertion callers and only ONE is an utterance. The
  //     others include an image sent to the PC, a record-only image, and a typed
  //     note / quick-phrase tap. `buildDeliveryRow` defaults `edited:false` +
  //     `processedText:null`, so a row the USER AUTHORED passes both guards
  //     (`edited` is set only by `applyEdit` — it protects text the user
  //     corrected, never text the user wrote);
  //   ⇒ a refinement arriving 0.8–6 s late can overwrite an image label or the
  //     user's own typed text, persisted, with no UI path to recover it.
  //
  // A server-side 「only if this is still the most recent UTTERANCE」 gate does
  // NOT fix it: the server enforces 「no newer utterance」 while the phone asserts
  // 「no newer ROW」, and rows the server never sees are exactly the dangerous
  // ones. And `request_id` cannot rescue it either — `audio:start` carries no
  // client id, `stt:final` has no id field, and the row's `clientId` is
  // phone-minted and never travels, so there is no identifier to echo.
  //
  // 🔴 UNBLOCKING CONDITION (one thing, in an area this card may not touch):
  // `_applyRefined` must select the target row the way the repo has ALREADY
  // solved this twice in the same package — `punctuation_append.dart` refuses to
  // touch an image row, and `chat_control_keys.dart` was corrected by card F2 to
  // use `entriesForOwners(owners)`. `_applyRefined` is the third sibling and got
  // neither. Once it filters by entry type + owner, this branch delivers.
  //
  // Until then the pass runs, is metered, and is recorded — and the user keeps
  // the bare final. Stated openly: that means a user who switched polish ON is currently
  // PAYING for a correction they do not receive. That is a fork for the
  // supervisor, not something this file may decide, and it is reported as one.
  const elapsedMs = now() - startedAt;
  if (result.reason !== undefined) {
    // timeout / llm_error / empty_output / guard_reject.
    log.warn('stt.polish produced nothing to deliver — the bare final stands', {
      reason: result.reason,
      wire: result.skipReason,
      chars: pureText.length,
      elapsedMs,
    });
    return;
  }
  // D-3 (as corrected): NEVER blank a row and NEVER emit a no-op are INHERITED
  // from stt-refine.ts rather than re-stated — one red line must not have two
  // answers — and `refinedTextOrNull` is the whole of both.
  //
  // ⚠️ The 「never on a short utterance」 rule is deliberately NOT imported. It is
  // refine-specific economics (「a second full transcription is a second engine
  // bill」) and its 15 s floor would land on top of stt-polish.ts's MEASURED note
  // that 4–12 s utterances polish fine while 24–61 s ones time out — i.e. it
  // would disable polish over exactly the range measured to work, which is that
  // file's own 「an off switch that nobody knew was on」.
  const deliverable = refinedTextOrNull(pureText, result.text);
  if (deliverable === null) {
    log.info('stt.polish made no difference — nothing to deliver', { chars: pureText.length, elapsedMs });
    return;
  }
  log.info('stt.polish produced a correction but there is no safe carrier — withheld', {
    chars: pureText.length,
    elapsedMs,
    blocked_on: 'mobile _applyRefined must filter by entry type + owner',
  });
}

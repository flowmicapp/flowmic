// The SYNC terminal-polish family — the SHIPPED path that polishes the
// utterance-closing final and then emits it, and the `polish` field every OTHER
// final carries.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs SRC_MAX), not by an architectural claim — the bridge
// was sitting at 784 and card INC-1 (design
// docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md §6 INC-1b)
// is about to add to it. Same reading as `stt-session-autostop.ts`,
// `stt-session-detached-polish.ts` and `stt-session-refine.ts` — a movable
// family, not a new layer. The callers are `stt-session.ts`
// `runPolishedFinal` / `polishWireForFinal`, two one-line wrappers that keep
// the SAME names so every [[runPolishedFinal]] / [[polishWireForFinal]]
// reference in the class comments still resolves.
//
// 🔴 WHAT MOVED AND WHAT CHANGED — enumerated, because a blanket "verbatim" is
// exactly the claim that rots. Every comment and every statement below is
// byte-for-byte what it was inside `SttSessionBridge`, with these mechanical
// edits and no others:
//   (1) both blocks are de-indented by two spaces (class member → module
//       scope). No line's CONTENT changed;
//   (2) `private async runPolishedFinal(` → `export async function
//       runPolishedFinal(` with a new first parameter `ctx` (one added line);
//       `private polishWireForFinal(isSegment…` → `export function
//       polishWireForFinal(deps: SttSessionDeps, isSegment…`;
//   (3) in runPolishedFinal: `this.deps.polish!` → `ctx.polish` (the
//       non-null assertion moved to the wrapper, which reads the same field at
//       the same synchronous point); `this.deps.userId` → `ctx.userId`;
//       `this.meterPolish(…)` → `ctx.meter(…)`; `this.disposed` →
//       `ctx.disposed()`; `this.emitFinal(…)` → `ctx.emitFinal(…)`;
//       `this.kickRefine(…)` → `ctx.kickRefine(…)`;
//   (4) in polishWireForFinal: `this.deps.` → `deps.` (2 sites).
// **Any other difference is a bug.**
//
// 🔴 THE METER, THE EMIT AND THE LATCH ARE HANDED IN, NOT REBUILT.
// `meterPolish` stays in the class — it is the ONE metering seam, and the census
// in billing-call-sites.test.ts counts FILES, so a second copy in a NEW file is
// precisely the one it would not catch. `emitFinal` stays because it is the ONE
// place a `stt:final` leaves the bridge and the ONE place `deliveredChars`
// moves. `disposed` is handed over as a THUNK so it is read at EMIT time, after
// the polish answered — the same reason the refine pass's `emitterClosed` is a
// thunk (`stt-session-refine.ts` `RefineContext`). The `polishDelivery()`
// accessor also stays: it holds the literal the census reads.

import { observedPolishFinalText } from '../obs/terminal-polish-timing'; import { polishWireSignalFor, type PolishSkipReason, type PolishWireSignal } from '../stt/stt-polish'; import { observePolishSignal } from '../stt/llm-reject-latch';
import { keepOpenEnd } from '../stt/seam-artifact'; // card SEAM-2
import { log } from '../log';
import type { SttSessionDeps } from './stt-session-deps';
import type { MeterPolish } from './stt-session-detached-polish';
import type { PolishClock } from './stt-session-polish-timing';
import type { PolishSpeculation } from './stt-session-speculation';

/** ADDED BY THE SPLIT: what [[runPolishedFinal]] used to read off `this` —
 *  parameters rather than `this.` reads, the same shape as `RefineContext`. */
export interface PolishedFinalContext {
  /** Card INC-1c — this final's clock; the speculative path stamps its stats on it. */
  clock?: PolishClock;
  /** Card INC-1f — present only on an armed session (stt-session-speculation.ts). */
  speculation?: PolishSpeculation;
  polish: NonNullable<SttSessionDeps['polish']>;
  userId: SttSessionDeps['userId'];
  /** The session's ONE metering seam ([[SttSessionBridge.meterPolish]]). */
  meter: MeterPolish;
  /** Read at EMIT time — true once the session was torn down mid-polish. */
  disposed: () => boolean;
  /** [[SttSessionBridge.emitFinal]] — the one exit for `stt:final`. */
  emitFinal: (text: string, rest: Record<string, unknown>) => void;
  /** [[SttSessionBridge.kickRefine]] — the second pass on the delivered text. */
  kickRefine: (deliveredText: string) => void;
}

/**
 * The SHIPPED path: run the bounded polish on the pure two-stage text, then
 * emit `stt:final` with the honest wire signal. `polishFinalText` never throws
 * and never blocks delivery — on any skip it returns the pure text + a reason;
 * the try/catch is defense-in-depth (seam ③). On a session torn down
 * mid-polish the emit is dropped (the session is gone; nothing consumes it).
 */
export async function runPolishedFinal(
  ctx: PolishedFinalContext,
  pureText: string,
  base: { confidence: number; language: string; segment_idx: number; is_segment: boolean; duration_ms: number; utterance_id?: string },
  openEnd = false, // card SEAM-2 — this segment row's cut stripped an open mark (`seam_open` on the orchestrator's final)
): Promise<void> {
  const polish = ctx.polish;
  let text = pureText;
  // Default to an honest skipped('llm_error') so an unexpected throw below still
  // surfaces as a real failure signal, never a silent 'applied' (red line).
  let signal: PolishWireSignal = { polish: 'skipped', polish_reason: 'llm_error' };
  try {
    // Card INC-1f: the final assembled from pieces polished while speaking, or —
    // when nothing usable was requested for it (the one-span rule) — today's call.
    const spec = ctx.speculation?.polishFinal(pureText, base.segment_idx, base.is_segment) ?? null;
    const assembled = spec === null ? null : await spec;
    if (assembled !== null && ctx.clock !== undefined) ctx.clock.spec = assembled.stats;
    // Card POL-3: true once the stage-1 hold cap already sent this row raw (stt-session-units.ts).
    const afterCap = (): boolean => ctx.clock?.holdCapHit === true;
    const result = assembled?.result ?? await observedPolishFinalText(pureText, polish.llm, polish.deps ?? {}, base.utterance_id, base.is_segment, undefined, ctx.clock?.stage, afterCap); // POL-1: stage
    text = result.text;
    // NR-130: `model_rejected` only for a config the user owns (not our managed key).
    signal = polishWireSignalFor(result, polish.llm.source);
    // NR-130: the desktop's `capability.llm.rejected` fact (stt/llm-reject-latch.ts).
    observePolishSignal(ctx.userId, polish.llm.cfg, signal);
    ctx.meter(polish, result);
    if (afterCap()) {
      // POL-3: the row already left raw with skipped/timeout; this answer is never delivered,
      // so the WARN below ("delivering pure text") would describe a delivery that is not this one.
      log.info('stt.polish late_after_cap — answer not used, the row already left raw', { segment_idx: base.segment_idx, answered: result.reason !== 'cancelled' }); // no `wire`: a cap cancel maps to llm_error there
    } else if (signal.polish === 'skipped') {
      // Forensic (WP-R4-6 ④): the internal fine-grained reason stays here; only
      // the normalized 4-value reason reaches the wire.
      log.warn('stt.polish skipped — delivering pure two-stage text', { wire: signal.polish_reason });
    }
  } catch (err) {
    text = pureText;
    log.error('stt.polish threw — delivering pure two-stage text', { error: err instanceof Error ? err.message : String(err) });
  }
  if (ctx.disposed()) return;
  // Card SEAM-2 — the polish may not close a row the cut left open, unless the speaker dictated the mark (book 06 §5 SEAM-2 block).
  if (signal.polish === 'applied') text = keepOpenEnd(pureText, text, openEnd, base.language);
  ctx.emitFinal(text, { ...base, ...signal });
  // Delivered — so this is the string the second pass smooths. Kicked AFTER
  // the emit, never before: the pass is an improvement to text the user
  // already has, and nothing about it may reorder itself in front of the
  // frame that gives them that text.
  ctx.kickRefine(text);
}

/**
 * The `polish` field for a final emitted WITHOUT waiting for a polish result —
 * i.e. every final except the `'sync'` armed terminal one, which
 * [[runPolishedFinal]] stamps with the full `applied|skipped` signal.
 *
 * There is exactly one thing this can honestly say. "Polish was ON and could
 * not run AT ALL" is known before the final leaves, is permanent for the
 * session (usually until the user fixes their config), and is the one skip the
 * user can act on. Everything else is either pending or unknowable here.
 *
 * D-5: the field is left working on purpose. `polish:'skipped'` is what paints
 * PolishSkippedMark; removing it would make that widget permanently invisible
 * with nothing going red.
 *
 * ⚠️ Under `'detached'` an armed session returns `{}` here and the LATE skips
 * (timeout / llm_error / empty_output / guard_reject) reach nobody: they are
 * decided after the final has shipped and `SttRefinedSchema` has no polish
 * field to carry them. That honesty gap is one more thing the activation
 * triple has to answer for, and it is why `'sync'` is not merely the
 * conservative default — it is the only mode that keeps WP-R4-6 ⑦'s promise.
 */
export function polishWireForFinal(deps: SttSessionDeps, isSegment: boolean): { polish?: 'skipped'; polish_reason?: PolishSkipReason } {
  // Card SEG-1 — a soft-segment final of a press is its own row in realtime
  // (book 15 §2.0-c), so 「polish was asked for and could not run」 is as true of
  // it as of the terminal final and is stamped the same way. Before SEG-1 this
  // returned {} for every segment (WP-R4-6 ③), and that row read unpolished
  // text with no mark. Continuous recordings keep the old contract
  // and recovery legs ([[segmentKeepsPreSeg1Contract]]).
  if (isSegment && segmentKeepsPreSeg1Contract(deps)) return {};
  // Armed ⇒ the answer is pending, and a pending answer is not a signal.
  if (deps.polish !== undefined) return {};
  const unavailable = deps.polishUnavailable;
  if (unavailable === undefined) return {};
  return { polish: 'skipped', polish_reason: unavailable };
}

/**
 * Card SEG-1 — the sessions whose soft-segment finals stay on the pre-SEG-1
 * contract: emitted at once, never polished, no polish field, never held.
 *   · a continuous recording (`audio:start.continuous`): polishing every row of
 *     a half-hour recording is a cost / live-view decision SEG-1 did not take;
 *   · a recovery leg (`deps.recoveryLeg`, card SEG-1b): the phone re-feeds owed
 *     audio and its recovery `audio:start` does not carry `continuous`
 *     (apps/mobile/lib/src/ptt/ptt_backfill.dart), so the first test alone
 *     would polish a re-fed long recording (MAIN ruling 2026-10-13).
 *     🔴 NOT `deps.recovery !== undefined`, which is what this read until
 *     SEG-1b: every live press of a phone with first-frame retention carries
 *     that echo too (`attempt_kind:'live'`, mobile `liveStartFields`), so on
 *     every shipped phone build no soft segment was ever polished or marked
 *     (device check 2026-10-13, relay 0.3.111, Play 0.3.107).
 * That those segments are unpolished AND unmarked is a known open account,
 * tracked by MAIN as its own card.
 */
export function segmentKeepsPreSeg1Contract(deps: Pick<SttSessionDeps, 'continuous' | 'recoveryLeg'>): boolean {
  return deps.continuous === true || deps.recoveryLeg === true;
}

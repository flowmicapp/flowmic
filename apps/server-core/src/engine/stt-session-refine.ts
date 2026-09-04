// The second pass (refine) — kicked after the terminal final has been
// DELIVERED, delivered back on `stt:refined`, and matched to its row by
// `utterance_id` (2026-09-03, owner Q2 b / design D7 ①②③).
//
// 🔴 2026-09-04, owner: WHAT THE SECOND PASS IS CHANGED, THE DELIVERY DID NOT.
// It used to re-run a BATCH STT engine over the retained PCM. It is now an LLM
// SMOOTHING pass over the FULL delivered text of the utterance (「二次改顺」) —
// see stt/stt-refine-llm.ts for the whole account of why the old question was
// the wrong one. Consequences that live in THIS file:
//   · no [[RetainedAudio]] any more. The session retains no audio at all, so a
//     refine session's memory profile is now the same as any other session's,
//     and the 6-minute in-memory cap (and its overflow skip) are gone with it;
//   · the floor is asked about the UTTERANCE's audio duration, which the bridge
//     already counts as `totalAudioMs`. Card N1-B1b's lesson survives the
//     rewrite intact: the gate must be asked about the thing its decision is
//     about, never about the last segment's `duration_ms` (a user releasing two
//     seconds past a soft-segment rollover would otherwise never be refined —
//     exactly the long dictations this feature exists for);
//   · engine-independent. There is no batch-engine requirement left, so this
//     runs on Soniox and FunASR — i.e. on production — for the first time.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs SRC_MAX), not by an architectural claim. Same
// reading as `stt-session-autostop.ts` and `stt-session-detached-polish.ts` — a
// movable family, not a new layer. The one caller is `stt-session.ts`
// `kickRefine`, which is wiring and nothing else.

import type { SttEmitter, SttSessionDeps } from './stt-session-deps';
import type { SelectedLlmConfig } from '../compose/llm-config';
import { shouldRefine } from '../stt/stt-refine';
import { refineFinalText } from '../stt/stt-refine-llm';
import { trace, traceEnabled, tracedText } from '../trace/pipeline-trace';
import { log } from '../log';

/** What one second pass needs from the bridge — parameters rather than `this.`
 *  reads, so the pass is drivable without constructing a session. */
export interface RefineContext {
  refine: SttSessionDeps['refine'];
  emitter: SttEmitter;
  utteranceId: string;
  /** Read at EMIT time. True ⇔ the phone's socket is really gone
   *  (`SttSessionBridge.emitterClosed`). */
  emitterClosed: () => boolean;
  /** The session's ONE metering seam ([[SttSessionBridge.meterPolish]]), handed
   *  over rather than re-implemented. This pass spends LLM tokens on the same
   *  config polish does, so it is billed through the same call — a second copy
   *  of a billing call is how the numbers drift, and the census in
   *  billing-call-sites.test.ts counts FILES, so a copy in a NEW file is
   *  precisely the one it would not catch. */
  meter: (llm: { llm: SelectedLlmConfig }, result: { usage?: { tokensIn: number; tokensOut: number } }) => void;
  /** Correlation id for the pipeline trace. */
  traceId?: string;
}

function traceSkip(ctx: RefineContext, reason: string, extra: Record<string, unknown> = {}): void {
  if (!traceEnabled()) return;
  trace('refine.skipped', ctx.traceId ?? 'no-session', { reason, ...extra });
}

/**
 * The optional second pass, started AFTER the terminal final has gone out.
 *
 * Deliberately not awaited by anything on the production path: refine improves
 * text the user already has, so it may never hold up the utterance, the billing
 * settle, or the teardown. The promise is returned and kept on
 * `SttSessionBridge.pendingRefine` so the pass is observable.
 *
 * 🔴 `deliveredText` IS THE DELIVERED TEXT — post-dictionary, post-normalizer
 * AND post-polish — not the pure two-stage string. Smoothing a different string
 * than the one on the user's screen would produce a "second draft" that silently
 * undoes the correction pass, and the phone would then show a row that no stage
 * of the pipeline ever produced.
 *
 * 🔴 The emit is gated on [[RefineContext.emitterClosed]], NOT on the session's
 * `disposed` flag. The audio handler runs `finish().finally(() => s.dispose())`,
 * so `disposed` is true milliseconds after the terminal final while this pass
 * takes seconds: gating on it ate every normal-path refine (the defect D7 ②
 * removed, pinned in test/stt-session-refine-delivery.test.ts).
 */
export function kickRefine(
  ctx: RefineContext,
  deliveredText: string,
  utteranceMs: number,
): Promise<void> | null {
  const refine = ctx.refine;
  if (!refine) return null;
  if (!shouldRefine(refine.cfg, utteranceMs)) {
    // The common case (a genuinely short utterance) and silent in the log as it
    // always was — but no longer silent in the TRACE, because "why did my long
    // recording not get smoothed" is the one question a fire-and-forget pass
    // could never answer about itself.
    traceSkip(ctx, 'below-floor', { utterance_ms: Math.round(utteranceMs) });
    return null;
  }
  if (deliveredText.trim().length === 0) {
    traceSkip(ctx, 'empty-final');
    return null;
  }
  if (traceEnabled()) {
    trace('refine.decision', ctx.traceId ?? 'no-session', {
      armed: true,
      utterance_ms: Math.round(utteranceMs),
      chars: deliveredText.length,
    });
  }
  return refineFinalText(deliveredText, refine.llm.cfg, { ...(refine.deps ?? {}), traceId: ctx.traceId })
    .then((result) => {
      // Metered on EVERY path the model answered on, verdict or not: those
      // tokens were spent whatever we then decided to do with the text.
      ctx.meter(refine, result);
      if (result.text === null) {
        log.info('stt.refine produced nothing to deliver — the delivered text stands', {
          reason: result.reason,
          chars: deliveredText.length,
        });
        traceSkip(ctx, result.reason ?? 'unknown');
        return;
      }
      if (ctx.emitterClosed()) {
        traceSkip(ctx, 'emitter-closed');
        return;
      }
      // The phone owns the timeline row (only the mobile emits history:create),
      // so this is a NOTIFICATION, not a write-back. It carries no FSM meaning:
      // the utterance is settled and stays settled. Payload = exactly
      // SttRefinedSchema's declared fields; `utterance_id` is the key the phone
      // matches the row on (D7 ③).
      ctx.emitter.emit('stt:refined', { text: result.text, utterance_id: ctx.utteranceId });
      if (traceEnabled()) {
        trace('refine.delivered', ctx.traceId ?? 'no-session', {
          utterance_id: ctx.utteranceId,
          ...tracedText(result.text),
        });
      }
      log.info('stt.refine smoothed the utterance', {
        utterance_ms: Math.round(utteranceMs),
        chars_in: deliveredText.length,
        chars_out: result.text.length,
      });
    })
    // 🔴 P0, not tidiness: `installProcessGuards` routes an `unhandledRejection`
    // → onFatal → graceful close → exit, so a rejection escaping this detached
    // task would take the relay down for every online user.
    .catch((err) => log.error('stt.refine delivery failed unexpectedly — the delivered text stands', {
      error: err instanceof Error ? err.message : String(err),
    }));
}

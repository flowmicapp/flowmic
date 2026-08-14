// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (the order from engine to landing for
//     a final: ① dictionary replacement (F-2118, deterministic, pure) →
//     ② final-text-normalizer (F-2249, pure) → fan-out stt:final + journal +
//     history persisted to the DB)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (deterministic replacement leg)
//   apps/server-core/src/engine/stt-factory.ts (the ONE production call site —
//     builds a per-audio-session pipeline snapshot and injects it into the bridge)
//   CLAUDE.md red line: no silent failure (a corrupt scenario.card throws in the resolver
//     upstream, never a silent empty replacer)
//
// Composes the TWO PURE final-text stages in the 06 §5 order into a single
// reusable transform:
//   ① dictionary replace FIRST (alias→canonical, ≤300 entries, <5ms, pure)
//   ② final-text-normalizer SECOND (trim + CJK disfluency/whitespace grooming +
//      terminal punctuation ONLY on the utterance-closing final)
// then the caller (the STT session bridge) fans the result out as stt:final so
// EVERY consumer — mobile, PC, and the mobile-driven history:create — sees the
// same processed text (no raw-vs-processed split brain). No LLM, no I/O: the
// optional stt.polish LLM layer (06 §5) is a SEPARATE opt-in card and is NOT
// built here — realtime default is passthrough after these two pure stages.

import type { DictionaryReplacer } from '../compose/dictionary-replace';
import { normalizeFinalText } from './final-text-normalizer';

/** Pure transform applied to FINAL text only (interim is never touched). `ctx`
 *  carries the two facts the pipeline needs: whether this is a soft-SEGMENT
 *  final (no forced terminal punctuation) vs the utterance-closing final, and
 *  the resolved language (drives the normalizer's CJK-vs-Latin punctuation). */
export type FinalTextTransform = (
  text: string,
  ctx: { isSegment: boolean; language: string },
) => string;

/**
 * Build the per-session final-text pipeline from a pre-built (snapshotted)
 * dictionary replacer. The returned transform is pure and reused for every final
 * in the session — the settings snapshot happened when the replacer was built at
 * audio:start, so there is zero I/O at final time (the <5ms pure budget).
 *
 * Order is 06 §5: replace THEN normalize. Terminal punctuation is gated on
 * `!isSegment` so soft-segment finals get dict + grooming but are never
 * force-closed mid-utterance (06 §2.2).
 */
export function makeFinalTextPipeline(replacer: DictionaryReplacer): FinalTextTransform {
  return (text, ctx) => {
    const replaced = replacer.apply(text); // ① dictionary replace (F-2118)
    return normalizeFinalText(replaced, {   // ② normalizer (F-2249)
      language: ctx.language,
      ensureTerminalPunctuation: !ctx.isSegment,
    });
  };
}

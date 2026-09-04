// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.refine` {enabled, min_utterance_ms})
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-14
//   owner ruling 2026-09-04 — the second pass is an LLM SMOOTHING pass
//     (「二次改顺」), not a second transcription.
//   CLAUDE.md red line: no silent failures
//
// THE SECOND PASS — the decision core, with no engine, no LLM and no socket in
// it. Everything here is a rule about not making things worse, and every one of
// them survived the 2026-09-04 change of producer unchanged, because none of
// them was ever about HOW the second draft was made:
//
//   · NEVER on a short utterance. `min_utterance_ms` (default 15 s) is not a
//     performance tweak — a second pass is a second bill, and a short utterance
//     rarely needs smoothing in the first place.
//   · NEVER blank a row. An empty or whitespace-only second pass is a FAILED
//     pass, not a better text. The user can read the first one.
//   · NEVER emit a no-op. Identical text (modulo whitespace) produces nothing at
//     all: an 「已优化」 signal for text that did not change is noise that teaches
//     the user to ignore the real ones.
//   · NEVER touch what was injected. This module returns TEXT; what the phone
//     does with it is a timeline update, and the PC keeps the words it typed.
//     That is 06 §5's 「已注入 PC 的文本永不回改」 and it is why refine is not
//     allowed anywhere near the inject path.
//
// 🔴 WHAT LEFT THIS FILE ON 2026-09-04, so nobody looks for it: `RetainedAudio`,
// `RETAINED_BYTES_PER_MS` and `runRefine`. They existed to hold one utterance's
// PCM in memory and hand it to a BATCH STT engine for a re-transcription. The
// pass no longer re-transcribes anything — it smooths the delivered TEXT
// (stt/stt-refine-llm.ts) — so the buffer, its 6-minute cap and its overflow
// semantics all had exactly zero remaining callers. Deleted rather than kept
// "in case": a retained-audio class nothing retains audio into is an
// audio-at-rest surface with no purpose.

import type { SttRefine } from '@flowmic/protocol';
import { STT_REFINE_MIN_UTTERANCE_MS } from '@flowmic/protocol';

/** The effective floor for this config, with the shipped default. */
export function refineFloorMs(cfg: SttRefine): number {
  return cfg.min_utterance_ms ?? STT_REFINE_MIN_UTTERANCE_MS;
}

/**
 * Is this utterance worth a second pass?
 *
 * 🔴 Card N1-B1b — `durationMs` must be the duration of THE WHOLE UTTERANCE
 * (`SttSessionBridge.totalAudioMs`, the audio this session actually received).
 * It is NOT 「the final that triggered this」. The distinction was free while a
 * whole utterance was one final; card N1-B1 made every soft segment carry its
 * own `duration_ms`, and feeding THAT number here asks the floor a question
 * about a 2-second tail of a ten-minute recording — the gate would then refuse
 * exactly the long dictations this feature exists to serve, and refuse them
 * silently, because refine is fire-and-forget by construction.
 *
 * ⚠️ The 2026-09-04 change of producer did not weaken this rule; it moved where
 * the honest number comes from. It used to be `RetainedAudio.durationMs` (the
 * bytes about to be re-transcribed). Nothing retains audio any more, so it is
 * now the session's own audio tally — the same quantity, measured one layer up.
 */
export function shouldRefine(cfg: SttRefine | null, durationMs: number): boolean {
  if (cfg === null || !cfg.enabled) return false;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  return durationMs >= refineFloorMs(cfg);
}

/** Whitespace-insensitive sameness. The two passes may punctuate or space
 *  differently without meaning anything different; only a real change is news. */
export function isSameTranscript(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/gu, '').trim();
  return norm(a) === norm(b);
}

/**
 * Decide what (if anything) the second pass produced that is worth sending.
 * Returns the refined text, or `null` for 「nothing to say」.
 *
 * Separated from the engine call so every rule above is provable without a
 * transcription service.
 */
export function refinedTextOrNull(firstPass: string, secondPass: string): string | null {
  const next = secondPass.trim();
  if (next === '') return null;                       // a failed pass, not a better one
  if (isSameTranscript(firstPass, next)) return null; // no news
  return next;
}

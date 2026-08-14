// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.refine` = two-pass toggle + min_utterance_ms)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (after the final transcript, a fire-and-forget full re-transcription)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-14
//
// The value schema for the `stt.refine` user_settings key.
//
// OFF by default, and the default is load-bearing rather than shy: a second full
// transcription doubles the engine bill for that utterance, so it has to be a
// thing the user turned on. `min_utterance_ms` is the other half of the same
// judgement — short utterances are already accurate and never worth a second
// pass, so the floor exists to stop the feature spending money on 「好的」("okay").

import { z } from 'zod';

/** 05 §5: the shipped floor. Utterances shorter than this are never refined. */
export const STT_REFINE_MIN_UTTERANCE_MS = 15_000;

export const SttRefineSchema = z.object({
  enabled: z.boolean(),
  /** Utterance floor in ms. Clamped by the server to a sane band so a corrupt
   *  profile cannot turn every 「嗯」("um") into a paid batch transcription. */
  min_utterance_ms: z.number().int().min(1_000).max(300_000).optional(),
});

export type SttRefine = z.infer<typeof SttRefineSchema>;

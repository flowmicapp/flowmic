// SPEC-REF:
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §4a
//     (🔴 STREAMING_ENGINES is this card's #1 trap — one value drives three things at once)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (VAD billing gate)
//
// 🔴 EXTRACTED FROM `engine-factory.ts` 2026-08-02 (L2) FOR ONE MECHANICAL
// REASON, not for tidiness: the pool layer (`pool-config.ts`, `pool-health.ts`)
// needs this answer, and `engine-factory.ts` now imports the pool layer. Leaving
// it there made `engine-factory → pool-routing → pool-config → engine-factory` a
// module cycle. `engine-factory.ts` RE-EXPORTS both symbols, so every existing
// importer (`http/probe-routes.ts`, `stt/batch-transcribe.ts`, tests) keeps its
// import line unchanged — this move is invisible to them by design.
//
// The content is unmoved and the trap is unchanged; it is restated here because
// the next person will read this file, not the one it came from.

import type { SttEngineId } from '@flowmic/protocol';

/** Streaming (persistent-session) engines — the ones a metered managed
 *  deployment bills by connection/audio time, so silence matters (§2.3). The
 *  batch engines (whisper/custom-openai/funspeech/sherpa-local) have no
 *  persistent session and are not gated.
 *
 *  🔴 card §4a: THIS SET IS THE HEAD TRAP OF THE WHOLE CARD. It has no exhaustive
 *  check (a Set cannot have one), and `isStreamingEngine()` drives THREE things
 *  at once — none of which fails at compile time:
 *    1. the VAD billing gate (`gated` in engine-factory) → forgetting to add it here ⇒ silence is
 *       streamed to a per-second-billed vendor and paid for;
 *    2. `probeKindFor` (http/probe-routes.ts) → forgetting to add it here ⇒ the diagnostics page
 *       tries a BATCH transcribe against a streaming-only engine;
 *    3. `batchEngineIdFor` (stt/batch-transcribe.ts) → forgetting to add it here ⇒ second-pass
 *       refine picks an engine that has no batch mode at all.
 *  Since 2026-08-02 it drives a FOURTH: `pool-health.ts` only waits out the
 *  in-band settle window for a streaming route, and `pool-config.ts` derives a
 *  route's `streaming` flag (hence whether a failover onto it is a CAPABILITY
 *  DOWNGRADE) from it.
 *  `soniox` is streaming (card §3: persistent ws, tokens pushed continuously,
 *  300-minute per-connection ceiling). Acceptance asserts the EFFECTIVE value
 *  (`gated === true`), not just membership — D1's rule. */
export const STREAMING_ENGINES: ReadonlySet<SttEngineId> = new Set([
  'funasr', 'deepgram', 'openai-realtime', 'soniox',
]);

export function isStreamingEngine(id: SttEngineId): boolean {
  return STREAMING_ENGINES.has(id);
}

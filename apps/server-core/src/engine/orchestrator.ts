// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (stt/ orchestrator; compose/
//     orchestrator — domain modules behind the socket handlers)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-3 (audio/stt engines), WP-R1-4 (compose)
//   CLAUDE.md red line: no silent failure; an LLM failure must not silently fall
//     back to injecting the raw STT text
//
// The engine mount points. WP-R1-2 lands the socket handlers + orchestrator
// interfaces; the engine implementations are R1-3 (STT) / R1-4 (compose). Until
// they are assembled, the handlers FAIL LOUD via EngineNotWiredError — an
// explicit, whitelisted error code on stt:error / compose:error, NEVER a
// swallowed promise or a silent fallback. The interfaces below are the seams
// R1-3/R1-4 implement against.

import { ServerError } from '../errors';

/** STT orchestrator seam (R1-3): drives an audio session through an engine and
 *  emits stt:interim / stt:final / stt:error. Defined here so the audio handler
 *  and the R1-3 implementation share one contract. Implemented by
 *  engine/stt-session.ts (the bridge onto the stt/ engine driver). */
export interface SttOrchestrator {
  /** Push a decoded PCM chunk (base64 on the wire) into the live session.
   *  `tsMs` is the client chunk timestamp (audio:chunk.ts_ms) — feeds the
   *  server replay ring buffer + reconnect window (06 §2.1). */
  pushChunk(seq: number, dataB64: string, tsMs: number): void;
  /** Finalize the utterance; resolves when the engine has flushed final text. */
  finish(): Promise<void>;
  /** Tear down without emitting further events. */
  dispose(): void;
  /** SEG-1 (R5) — the session's SeqTracker.lastContiguousSeq (-1 before any
   *  chunk), surfaced READ-ONLY so AudioSessionRegistry.peekLastContiguousSeq
   *  can put it on the mobile:reconnect ack (`audio_last_contiguous_seq`).
   *  OPTIONAL on the seam on purpose: an implementation that does not answer
   *  (test fakes) leaves the ack without a watermark, and the phone falls back
   *  to its full 30 s ring replay — fail toward duplication, never loss
   *  (design §2-R5 failure direction). Implemented by SttSessionBridge
   *  (engine/stt-session.ts). */
  readonly lastContiguousSeq?: number;
}

/** Compose orchestrator seam (R1-4): runs one translate/organize/draft_polish
 *  turn against the LLM and streams compose:chunk / compose:done, or fails loud
 *  with compose:error (never silently reinjects raw STT text). */
export interface ComposeOrchestrator {
  run(input: { task: 'translate' | 'organize' | 'draft_polish'; source_text: string; source_lang?: string; target_lang?: string }): AsyncIterable<string>;
}

/** Fail-loud marker for "engine layer not assembled yet". Carries a real,
 *  whitelisted, bilingual error code so the client surfaces an explicit failure
 *  (0.1.0 skeleton: the engine truly is unavailable). Replaced by real
 *  orchestrators in R1-3/R1-4. */
export class EngineNotWiredError extends ServerError {
  constructor(layer: 'stt' | 'compose') {
    super(
      layer === 'stt' ? 'STT_CONFIG_MISSING' : 'LLM_PROBE_FAIL',
      `${layer} engine layer not assembled yet — deferred to WP-R1-${layer === 'stt' ? '3' : '4'}`,
    );
  }
}

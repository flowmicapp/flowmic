// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (batch engine: PCM accumulation →
//     44-byte WAV header → POST; final only, no interim), §5 (stt.refine two-pass)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-14
//
// One whole utterance through a BATCH engine, once.
//
// The batch adapters (whisper / custom-openai-compatible / funspeech-http)
// already do exactly this internally: accumulate PCM, wrap it in a 16 kHz mono
// WAV, POST it, emit one `final`. Refine therefore needs no new engine and no new
// HTTP client — it needs a way to hand an EXISTING adapter a buffer it did not
// stream itself. That is all this file is.
//
// A streaming engine cannot serve this: it has no whole-utterance mode, so
// resolving one here would mean inventing a second pass that never returns.
// [`batchEngineIdFor`] is the honest gate, and the factory logs when it says no —
// a switch that is ON and does nothing must at least be explainable.

import type { EventEmitter } from 'node:events';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, SttEngineConfig, FinalResult } from './engines/base';
import { defaultEngineFactory, isStreamingEngine } from './engine-factory';

/** How long one second pass may take before it is abandoned. Generous — this is
 *  a background improvement, not a path anyone is waiting on — but finite, so a
 *  hung endpoint cannot pin the retained audio in memory forever. */
export const REFINE_TIMEOUT_MS = 60_000;

/** The engine to use for a second pass, or `null` when this routing cannot do
 *  one. Batch-capable ⇒ itself; streaming ⇒ no substitute is invented. */
export function batchEngineIdFor(id: SttEngineId): SttEngineId | null {
  return isStreamingEngine(id) ? null : id;
}

/**
 * Transcribe a whole PCM buffer with a fresh batch engine instance.
 *
 * A FRESH instance per call on purpose: the live session owns its own engine and
 * its own accumulated state, and pushing an already-transcribed utterance back
 * into it would corrupt the very session that produced it.
 */
export async function transcribeBatch(
  cfg: SttEngineConfig,
  pcm: Buffer,
  opts: { timeoutMs?: number; createEngineImpl?: typeof defaultEngineFactory } = {},
): Promise<string> {
  const make = opts.createEngineImpl ?? defaultEngineFactory;
  // Every adapter is an EventEmitter (base.ts contract); the interface omits the
  // emitter surface, so the once() listeners are taken through it explicitly.
  const engine = make(cfg.id, cfg) as SttEngine & EventEmitter;
  const timeoutMs = opts.timeoutMs ?? REFINE_TIMEOUT_MS;

  try {
    await engine.open?.();
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`refine timed out after ${timeoutMs}ms`)), timeoutMs);
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      engine.once('final', (f: FinalResult) => settle(() => resolve(String(f.text ?? ''))));
      engine.once('error', (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
      engine.push(pcm, 0);
      // flush() is what makes a batch adapter POST; its own rejection is a real
      // failure and must not be swallowed into a silent timeout.
      engine.flush().catch((err) => settle(() => reject(err)));
    });
    return text;
  } finally {
    await engine.close().catch(() => undefined);
  }
}

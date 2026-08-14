// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (flush race: engine.flush() vs
//     timeout so stt:final always fires; offlineAccum authoritative), §2 (no
//     silent failure — flush-phase error settles as one-shot stt:error, never hangs)
//   Ported from legacy stt/flush-final.ts (mechanism unchanged from the legacy line, F-2050/F-2069).
//
// raceFlushFinal: settle a FinalResult from a flushing engine on whichever
// arrives first — a captured 'final', the flush() promise resolving, a
// flush-time 'error', or the flush-timeout cap. ALWAYS resolves (never
// rejects). `text` is the LATE-BOUND offline-accumulated finals so a final
// arriving DURING the flush still folds in.

import type { EventEmitter } from 'node:events';
import type { FinalResult, SttEngine } from './engines/base';
import { vadClosureSilenceBytes } from './tuning-env';

export interface FlushFinalDeps {
  /** The engine being flushed, or null (→ resolve immediately with offline text). */
  engine: (SttEngine & EventEmitter) | null;
  /** Late-bound accumulated offline finals; read at settle time. */
  getOfflineText: () => string;
  /** Language echoed into the FinalResult when nothing is captured. */
  language: string;
  /** Cap on engine.flush() before falling back to accumulated text. */
  timeoutMs: number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
}

/** Streaming engines (funasr/funspeech 2pass) get a 5s DEFAULT flush floor (the
 *  offline pass can exceed 3s); an EXPLICITLY configured cap wins. */
export function resolveFlushTimeoutMs(engineId: string, configuredMs: number, explicit: boolean): number {
  const streaming = engineId.startsWith('funasr') || engineId.startsWith('funspeech');
  return streaming && !explicit ? Math.max(configuredMs, 5_000) : configuredMs;
}

/** FunASR/FunSpeech 2pass VAD needs trailing silence to close the final word —
 *  feed 400ms of s16le zeros into the engine ONLY (never the session
 *  buffer/seq, so replay is unaffected). Server-side by design: mobile MUST NOT
 *  emit spurious audio:chunk.
 *
 *  ⚠️ CLOCK PROVENANCE (card M3-4b same-family scan, 2026-08-02): `nowMs` is the SERVER's
 *  clock, while every other `engine.push(payload, ts_ms)` in this codebase hands
 *  over the PHONE's capture timestamp (`orchestrator-core.ts` pushChunk /
 *  replayBufferTail). So this one parameter is fed by two different machines'
 *  clocks depending on the call site. That is INERT TODAY ONLY BECAUSE NO ENGINE
 *  READS IT — checked 2026-08-02: deepgram / funasr / funspeech-http /
 *  openai-realtime / openai-whisper / sherpa-local / custom-openai-compatible
 *  all declare `push(chunk: Buffer)` and ignore the second argument, and
 *  `packages/stt-cloud/src/engines/soniox.ts`'s `SonioxEngine.push` says so in
 *  as many words (symbol-only citation on purpose, no `:NNN` — that package is
 *  EXCLUDEd from the public tree by `scripts/opensource-manifest.mjs`, so a
 *  line-number coordinate into it can never resolve there; see the EXCLUDE-tree
 *  paragraph in `verify/lint/coordinate-anchors.mjs`'s header).
 *  🔴 The day an engine starts using `ts_ms` for anything (timeline alignment,
 *  segment offsets, its own retention), this line becomes a real defect and the
 *  right fix is to give it the phone-clock timestamp of the last real chunk —
 *  not to leave it answering a question with the wrong watch. */
export function feedVadClosureSilence(
  engine: (SttEngine & { state?: string }) | null,
  nowMs: number,
): void {
  const eid = engine?.id ?? '';
  if (!eid.startsWith('funasr') && !eid.startsWith('funspeech')) return;
  if (!engine || engine.state !== 'open') return;
  try { engine.push(Buffer.alloc(vadClosureSilenceBytes()), nowMs); } catch (err) { console.error('[feedVadClosureSilence] engine.push error (flush proceeds):', err); }
}

/**
 * What {@link raceFlushFinal} settled on.
 *
 * 🔴 `timedOut` is here because the caller has to be able to tell "the engine
 * answered, and its answer was empty" from "the engine returned not a single
 * character within the timeout window, and this text is something we cobbled
 * together ourselves". Those are two different facts and the FinalResult alone answers neither —
 * both look like `text: ''`. The distinction is not academic: L9 (2026-08-02)
 * found a live Soniox adapter whose `flush()` NEVER resolved, so every single
 * utterance settled on the cap, and the wire showed a perfectly ordinary
 * `stt:final` with no error attached. One value answers only one question.
 */
export interface FlushOutcome {
  readonly result: FinalResult;
  /** true ⇒ the cap fired; the engine never finished flushing. */
  readonly timedOut: boolean;
}

export function raceFlushFinal(d: FlushFinalDeps): Promise<FlushOutcome> {
  const empty: FinalResult = { kind: 'final', text: '', confidence: 0, language: d.language, duration_ms: 0 };
  const engine = d.engine;
  if (!engine) return Promise.resolve({ result: { ...empty, text: d.getOfflineText() }, timedOut: false });
  return new Promise<FlushOutcome>((resolve) => {
    let captured: FinalResult | null = null;
    let settled = false;
    let timedOut = false;
    const onFinal = (e: FinalResult): void => { captured = e; }; // last final wins
    const finish = (r: FinalResult): void => {
      if (settled) return;
      settled = true;
      engine.off('final', onFinal);
      engine.off('error', onError);
      d.clearTimeoutFn(timer);
      // offlineAccum is authoritative. On timeout fallback only, if captured.text
      // is longer and contains offlineText as a prefix, use captured — the
      // engine's final may have the tail word offlineAccum lacks.
      const offline = d.getOfflineText();
      if (timedOut && captured && captured.text.length > offline.length && captured.text.startsWith(offline)) {
        resolve({ result: { ...r, text: captured.text }, timedOut });
      } else {
        resolve({ result: { ...r, text: offline }, timedOut });
      }
    };
    const onError = (): void => finish(captured ?? empty); // settle, don't hang
    engine.on('final', onFinal);
    engine.on('error', onError);
    const timer = d.setTimeoutFn(() => {
      timedOut = true;
      console.warn(`[raceFlushFinal] engine.flush() timeout ${d.timeoutMs}ms — using accumulated offline finals (${d.getOfflineText().length} chars)`);
      finish(captured ?? empty);
    }, d.timeoutMs);
    engine.flush().then(() => finish(captured ?? empty)).catch(() => finish(captured ?? empty));
  });
}

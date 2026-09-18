// NR-50 — the flush cap for the local engine, and what a cap hit DELIVERS.
//
// Two halves that were ruled inseparable (ledger §33 / §38): moving the local
// terminal decode off the event loop (`decodeAsync`) makes `raceFlushFinal`'s
// cap fire against it for the first time, and until this card the cap's
// fallback was `foldConfirmedWithDraft(offlineAccum, onlineDraft)` — for
// sherpa-local, the LAST PREVIEW, decoded without left context — delivered as
// an ordinary terminal `stt:final`. A preview shipped as the transcript, with
// nothing on the wire saying so (15 §4 R11 + "no silent failure").
//
// What is pinned:
//   · the cap SCALES with the audio the leg was fed (`localFlushCapMs`), so a
//     flat 3 s can no longer fail every whisper utterance over ~2 s
//     (measured: whisper-turbo RTF ≈ 0.57 on dev-pc-a, 2026-09-16);
//   · on a cap hit (or a decode error) a preview-only engine gets NOTHING
//     delivered on its behalf: `refused`, text '', and the orchestrator emits a
//     TERMINAL `STT_ENGINE_TIMEOUT` and NO final at all — because an EMPTY final
//     would be read by the phone as the flush-cap placeholder that keeps the
//     preview on screen as the transcript (`segment_buffer.dart` `put`);
//   · the streaming engines' fallback is byte-for-byte what it was (control);
//   · a late engine final after the cap changes nothing (zero finals still).
//
// 🔴 Reverse control, actually seen red (2026-09-16, dev-pc-a): with the
// `refused` branch in `raceFlushFinal.finish` disabled (the fold delivered as
// before), the orchestrator case below fails `expected 1 to be +0` on the final
// count, and that one final's text is 'preview words' — the exact defect shape,
// the preview sitting on the wire as the terminal transcript. Restored.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { EngineState, FinalResult, InterimResult, SttEngine } from '../src/stt/engines/base';
import { SttEngineError } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_FLUSH_TIMEOUT_MS } from '../src/stt/orchestrator-types';
import {
  FUNASR_FLUSH_HARD_CAP_MS,
  LOCAL_FLUSH_FLOOR_MS,
  LOCAL_FLUSH_RTF_CAP,
  localFlushCapMs,
  raceFlushFinal,
  resolveFlushTimeoutMs,
} from '../src/stt/flush-final';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.push({ id, fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await drain();
    }
    this.now = target;
    await drain();
  }
}
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** An engine shaped like sherpa-local at the seam the orchestrator sees: every
 *  push emits a cumulative PREVIEW interim, `flush()` parks until the test
 *  finishes the "decode" by hand, and it DECLARES `interimIsPreviewOnly`. */
class PreviewOnlyEngine extends EventEmitter implements SttEngine {
  readonly id = 'sherpa-local' as const;
  readonly interimShape = 'cumulative' as const;
  readonly interimIsPreviewOnly: boolean | undefined;
  state: EngineState = 'closed';
  private settle: (() => void) | null = null;
  constructor(private readonly previewText = 'preview words', declares = true) {
    super();
    this.interimIsPreviewOnly = declares ? true : undefined;
  }
  async open(): Promise<void> { this.state = 'open'; }
  push(_chunk: Buffer, _ts: number): void {
    const ev: InterimResult = { kind: 'interim', text: this.previewText, confidence: 1, language: 'zh' };
    this.emit('interim', ev);
  }
  flush(): Promise<void> { return new Promise<void>((resolve) => { this.settle = resolve; }); }
  /** The "decode" finishing: emit the real final, then let flush() resolve. */
  finishDecode(text: string): void {
    const ev: FinalResult = { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 1000 };
    this.emit('final', ev);
    const s = this.settle; this.settle = null; s?.();
  }
  async close(): Promise<void> { this.state = 'closed'; this.removeAllListeners(); }
}

/** The control: same shape, NO declaration — a streaming engine whose interims
 *  are the decoder's own running hypothesis. */
const streamingLikeEngine = (): PreviewOnlyEngine => new PreviewOnlyEngine('running hypothesis', false);

describe('NR-50 · the local flush cap scales with the audio the leg was fed', () => {
  it('sherpa-local: max(floor, audio × RTF cap); explicit config still wins; other engines unchanged', () => {
    expect(localFlushCapMs(1_000)).toBe(LOCAL_FLUSH_FLOOR_MS);
    expect(localFlushCapMs(45_000)).toBe(Math.round(45_000 * LOCAL_FLUSH_RTF_CAP));
    expect(resolveFlushTimeoutMs('sherpa-local', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 45_000)).toBe(90_000);
    expect(resolveFlushTimeoutMs('sherpa-local', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 0)).toBe(LOCAL_FLUSH_FLOOR_MS);
    expect(resolveFlushTimeoutMs('sherpa-local', 777, true, 45_000)).toBe(777);
    expect(resolveFlushTimeoutMs('funasr', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 45_000)).toBe(FUNASR_FLUSH_HARD_CAP_MS);
    expect(resolveFlushTimeoutMs('soniox', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 45_000)).toBe(DEFAULT_ENGINE_FLUSH_TIMEOUT_MS);
  });

  it('the cap is a hang detector above every measured decode, not a responsiveness limit', () => {
    // Measured wall on dev-pc-a 2026-09-16 (quiet box): the slowest
    // shipped row, whisper-turbo, 30 s → 16 887 ms. The cap for that span must
    // sit well above it, or the async decode would be refused on a healthy box.
    expect(localFlushCapMs(30_000)).toBeGreaterThan(16_887 * 2);
  });
});

describe('NR-50 · raceFlushFinal: a preview-only engine that did not answer gets nothing delivered', () => {
  function race(engine: PreviewOnlyEngine, clock: FakeClock, draft: string) {
    return raceFlushFinal({
      engine, getOfflineText: () => draft, language: 'zh', timeoutMs: 5_000,
      setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
  }

  it('cap hit ⇒ refused, text "" — the draft is withheld', async () => {
    const clock = new FakeClock();
    const engine = new PreviewOnlyEngine();
    await engine.open();
    const p = race(engine, clock, 'preview words');
    await clock.advance(5_000);
    const out = await p;
    expect(out.timedOut).toBe(true);
    expect(out.refused).toBe(true);
    expect(out.result.text).toBe('');
  });

  it('engine error ⇒ refused, text "" — same withholding, one branch over', async () => {
    const clock = new FakeClock();
    const engine = new PreviewOnlyEngine();
    await engine.open();
    const p = race(engine, clock, 'preview words');
    engine.emit('error', new Error('decode failed'));
    const out = await p;
    expect(out.refused).toBe(true);
    expect(out.result.text).toBe('');
  });

  it('the engine answered ⇒ not refused; its final is what settles (unchanged path)', async () => {
    const clock = new FakeClock();
    const engine = new PreviewOnlyEngine();
    await engine.open();
    const p = race(engine, clock, '');
    engine.finishDecode('the real transcript');
    const out = await p;
    expect(out.refused).toBe(false);
    expect(out.timedOut).toBe(false);
    // Text is the late-bound offline text (which the orchestrator folds the
    // engine final into); here the harness's draft is '' so the result is ''.
    expect(out.result.text).toBe('');
  });

  it('CONTROL — a streaming engine (no declaration) keeps the accumulated draft on a cap hit, as before', async () => {
    const clock = new FakeClock();
    const engine = streamingLikeEngine();
    await engine.open();
    const p = race(engine, clock, 'running hypothesis');
    await clock.advance(5_000);
    const out = await p;
    expect(out.timedOut).toBe(true);
    expect(out.refused).toBe(false);
    expect(out.result.text).toBe('running hypothesis');
  });
});

describe('NR-50 · orchestrator: on a cap hit nothing masquerades as the terminal final', () => {
  async function harness(engine: PreviewOnlyEngine) {
    const clock = new FakeClock();
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
    });
    session.start();
    const orch = new SttEngineOrchestrator(session, () => engine, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
    const finals: Array<{ text: string; is_segment?: boolean }> = [];
    const interims: Array<{ text: string }> = [];
    const errors: Array<{ code: string; message: string; retryable: boolean }> = [];
    orch.on('final', (p: { text: string; is_segment?: boolean }) => finals.push(p));
    orch.on('interim', (p: { text: string }) => interims.push(p));
    orch.on('error', (p: { code: string; message: string; retryable: boolean }) => errors.push(p));
    await orch.start({ language: 'zh', mode: 'realtime' });
    // 1 s of audio ⇒ leg audio 1 000 ms ⇒ cap = floor (5 000 ms).
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(32_000) });
    return { orch, clock, finals, interims, errors };
  }

  it('cap hit: ONE terminal STT_ENGINE_TIMEOUT (retryable:false), ZERO finals — before and after the late decode', async () => {
    const engine = new PreviewOnlyEngine('preview words');
    const h = await harness(engine);
    expect(h.interims.map((i) => i.text)).toContain('preview words'); // there WAS a preview to withhold
    const stopping = h.orch.stop();
    await drain();
    await h.clock.advance(LOCAL_FLUSH_FLOOR_MS - 1);
    expect(h.errors).toHaveLength(0);
    expect(h.finals).toHaveLength(0);
    await h.clock.advance(1);
    await stopping;
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe('STT_ENGINE_TIMEOUT');
    expect(h.errors[0]!.retryable).toBe(false);
    expect(h.errors[0]!.message).toContain('5000 ms cap');
    expect(h.finals).toHaveLength(0);
    // The decode finishes late, as a real worker would. It must change nothing.
    engine.finishDecode('the real transcript, too late');
    await drain();
    expect(h.finals).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    // And the withheld preview never appeared on the wire as a final, in any form.
    expect(h.finals.some((f) => f.text.includes('preview words'))).toBe(false);
  });

  it('POSITIVE CONTROL — the decode finishing inside the cap delivers the engine final, no error', async () => {
    const engine = new PreviewOnlyEngine('preview words');
    const h = await harness(engine);
    const stopping = h.orch.stop();
    await drain();
    await h.clock.advance(1_500);
    engine.finishDecode('the real transcript');
    await stopping;
    expect(h.errors).toHaveLength(0);
    expect(h.finals).toHaveLength(1);
    expect(h.finals[0]!.text).toBe('the real transcript');
  });

  it('decode error inside the cap: the engine error is the refusal (once), ZERO finals', async () => {
    const engine = new PreviewOnlyEngine('preview words');
    const h = await harness(engine);
    const stopping = h.orch.stop();
    await drain();
    // A non-retryable engine error is what sherpa-local now emits on a failed decode.
    engine.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', 'sherpa-local decode failed: boom', false));
    await stopping;
    expect(h.finals).toHaveLength(0);
    expect(h.errors.length).toBeGreaterThanOrEqual(1);
    expect(h.errors.every((e) => e.code === 'STT_ENGINE_TIMEOUT')).toBe(true);
    // Exactly one frame: the refusal exit must not repeat the engine's own error.
    expect(h.errors).toHaveLength(1);
  });
});

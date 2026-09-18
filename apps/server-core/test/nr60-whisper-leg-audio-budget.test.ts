// NR-60 — a whisper pack decodes only the FIRST 30 SECONDS of whatever span it
// is handed, and says so to stderr and nowhere else.
//
// ── THE WALL, AND WHERE IT WAS MEASURED ─────────────────────────────────────
// Not inferred from a log line and not modelled here on a hunch. The shipped
// decoder carries the sentence as a literal:
//
//   $ strings sherpa-onnx-win-x64@1.13.4/sherpa-onnx-c-api.dll | grep 'waves less'
//   Only waves less than 30 seconds are supported. We process only the first
//   30 seconds and discard the remaining data
//
// (2026-09-16, dev-pc-a. It is the ONLY audio-length limit string in that
// binary — SenseVoice / transducer / nemo / canary / moonshine have none.) It
// is NOT configurable: `OfflineWhisperModelConfig` in sherpa-onnx-node's
// `types.js` is `{encoder, decoder, language, task, tailPaddings}` and
// `tailPaddings` pads, it does not raise a ceiling. The 30 s is Whisper's
// encoder: a fixed-length mel window, not a tunable.
//
// ⚠️ WHAT IS DROPPED IS THE TAIL. "the first 30 seconds" — so a 45 s leg comes
// back as a transcript that reads complete and is missing its last third.
//
// ── WHY THE PRODUCT COULD HAND IT 45 s ──────────────────────────────────────
// `SoftSegmentCadence` bounds the ENGINE LEG by the clock only:
// `cadenceMs + graceMs` = 30 000 + 15 000 (orchestrator-types.ts). Audio fed is
// at most wall elapsed, so a leg could carry up to ~45 s — and every second of
// it past 30 reached a whisper recognizer and was thrown away.
//
// ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
// 🔴 The fake below MODELS the wall. A test whose fake models our own
// assumption proves nothing about the vendor (the FakeWs lesson, CLAUDE.md
// M3-1) — so the wall itself is NOT what these assertions are for; the binary
// above is the evidence for that, and the last `describe` below pins the number
// our code carries against the LOADER KIND in the real catalog. What IS pinned
// here is OUR half, and it is checkable on a machine with no whisper pack
// installed:
//   ① no flush is ever handed more audio than the engine declared it can decode
//      — the invariant, and the load-bearing assertion;
//   ② with the declaration absent (every engine's behaviour before this card,
//      and every network engine's after it) the 45 s leg reaches the decoder and
//      the transcript loses its tail — the CONTROL, run through the real
//      orchestrator, which is what makes ① a fix rather than a preference.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { EngineState, FinalResult, SttEngine } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { legAudioBudgetMs, LEG_AUDIO_BUDGET_MARGIN_MS } from '../src/stt/segment-boundary';
import { MODEL_CATALOG } from '../src/stt/sherpa/model-catalog';
import { maxDecodeAudioMsFor, WHISPER_MAX_DECODE_AUDIO_MS } from '../src/stt/sherpa/loader-config';
import { PCM_BYTES_PER_MS } from '../src/stt/tuning-env';

/** The measured wall, repeated here so the fake's behaviour and the number the
 *  engine declares are visibly the same one. */
const WHISPER_WALL_MS = 30_000;
const CHUNK_MS = 200;

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

/** One token per whole second of audio, so "the tail was dropped" is literally
 *  readable in the transcript instead of being a length comparison. */
function tokensFor(fromMs: number, toMs: number): string {
  const out: string[] = [];
  for (let s = Math.floor(fromMs / 1000); s < Math.ceil(toMs / 1000); s++) out.push(`t${s}`);
  return out.join(' ');
}

/**
 * An engine shaped like sherpa-local carrying a whisper pack: it accumulates
 * PCM, and one `flush()` decodes THE FIRST {@link WHISPER_WALL_MS} of it and
 * discards the rest, exactly as the binary's own sentence says it does.
 */
class WhisperLikeEngine extends EventEmitter implements SttEngine {
  readonly id = 'sherpa-local' as const;
  readonly interimIsPreviewOnly = true as const;
  state: EngineState = 'closed';
  private fedBytes = 0;
  private firstTsMs: number | null = null;
  constructor(
    /** shared across the session's legs — every span any leg was asked to decode */
    private readonly spansMs: number[],
    readonly maxDecodeAudioMs: number | undefined,
  ) { super(); }
  async open(): Promise<void> { this.state = 'open'; }
  push(chunk: Buffer, tsMs: number): void {
    if (this.firstTsMs === null) this.firstTsMs = tsMs;
    this.fedBytes += chunk.length;
  }
  async flush(): Promise<void> {
    const spanMs = this.fedBytes / PCM_BYTES_PER_MS;
    const from = this.firstTsMs ?? 0;
    this.fedBytes = 0; this.firstTsMs = null;
    if (spanMs === 0) return;
    this.spansMs.push(spanMs);
    const heardMs = Math.min(spanMs, WHISPER_WALL_MS); // ← THE WALL
    const ev: FinalResult = {
      kind: 'final', text: tokensFor(from, from + heardMs),
      confidence: 1, language: 'en', duration_ms: Math.round(spanMs),
    };
    this.emit('final', ev);
  }
  async close(): Promise<void> { this.state = 'closed'; }
}

/** Speak for [seconds] without a pause and without a sentence terminator — the
 *  shape that keeps a row open and lets the leg run to its bound (that is the
 *  whole point of SEG-4's cadence, and the owner's 102 s dictation had
 *  120 ms of silence in it, so it is not a contrived input). */
async function speak(seconds: number, declaredMaxMs: number | undefined): Promise<{ spansMs: number[]; transcript: string }> {
  const clock = new FakeClock();
  const spansMs: number[] = [];
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000,
  });
  session.start();
  const orch = new SttEngineOrchestrator(session, () => new WhisperLikeEngine(spansMs, declaredMaxMs), {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
  });
  const finals: Array<{ text: string }> = [];
  orch.on('final', (p: { text: string }) => finals.push(p));
  await orch.start({ language: 'en', mode: 'realtime' });
  const chunks = (seconds * 1000) / CHUNK_MS;
  for (let i = 0; i < chunks; i++) {
    orch.pushChunk({ seq: i, ts_ms: i * CHUNK_MS, payload: Buffer.alloc(CHUNK_MS * PCM_BYTES_PER_MS) });
    await clock.advance(CHUNK_MS);
  }
  await orch.stop();
  await drain();
  return { spansMs, transcript: finals.map((f) => f.text).join(' ') };
}

describe('NR-60 · a leg is bounded by the audio its engine can actually decode', () => {
  it('the budget leaves a margin under the declared wall, and 0 means "no declaration, no bound"', () => {
    expect(legAudioBudgetMs(WHISPER_WALL_MS)).toBe(WHISPER_WALL_MS - LEG_AUDIO_BUDGET_MARGIN_MS);
    expect(legAudioBudgetMs(undefined)).toBe(0);
    expect(legAudioBudgetMs(0)).toBe(0);
  });

  it('CONTROL — no declaration ⇒ a 50 s dictation hands one leg more than 30 s and the transcript loses its tail', async () => {
    const r = await speak(50, undefined);
    expect(Math.max(...r.spansMs)).toBeGreaterThan(WHISPER_WALL_MS);
    // t30..t39 were spoken, were delivered to the server, were handed to the
    // decoder, and are in no transcript anywhere. Nothing reported a failure.
    expect(r.transcript).toContain('t29');
    expect(r.transcript).not.toContain('t35');
  });

  it('declared ⇒ no span ever exceeds the budget, and every second spoken survives', async () => {
    const r = await speak(50, WHISPER_WALL_MS);
    expect(Math.max(...r.spansMs)).toBeLessThanOrEqual(legAudioBudgetMs(WHISPER_WALL_MS));
    for (let s = 0; s < 49; s++) expect(r.transcript).toContain(`t${s}`);
  });
});

describe('NR-60 · which shipped packs declare the wall', () => {
  it('every whisper row declares 30 s; no row of any other loader kind declares anything', () => {
    const whisper = MODEL_CATALOG.filter((m) => m.loader === 'whisper');
    expect(whisper.length).toBeGreaterThan(0); // else this assertion proves nothing
    for (const m of whisper) expect(maxDecodeAudioMsFor(m)).toBe(WHISPER_MAX_DECODE_AUDIO_MS);
    // The other seven kinds: sherpa-onnx-c-api.dll carries no length limit for
    // them, so they declare UNMEASURED rather than a number somebody guessed.
    for (const m of MODEL_CATALOG.filter((m) => m.loader !== 'whisper')) {
      expect(maxDecodeAudioMsFor(m)).toBeUndefined();
    }
  });

  it('the number the fake uses and the number the product declares are the same one', () => {
    expect(WHISPER_MAX_DECODE_AUDIO_MS).toBe(WHISPER_WALL_MS);
  });
});

// ⚠️ NOT PINNED HERE, and stated rather than left to be discovered:
// `SherpaLocalEngine.maxDecodeAudioMs` reads `activeRow`, which only
// `loadModelAndRecognizer()` sets — the production path, which needs the native
// addon and a 1.1 GB pack, so no test on this machine walks it. The wiring is
// therefore grep-evidence, not test-evidence: `this.activeRow = resolved.row`
// in `sherpa-local.ts`'s `loadModelAndRecognizer`, whose caller is the DEFAULT
// `openRecognizer` (production never passes the seam). The day a whisper pack is
// installed on a dev box, `scripts/drills/local-engine-lifecycle-probe.mjs`
// reports the kind and its declared window.

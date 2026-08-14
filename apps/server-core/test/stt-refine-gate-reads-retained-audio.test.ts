// Card N1-B1b — the refine gate must read the audio it is about.
//
// THE DEFECT THIS PINS
//
// GA-14's second pass is gated by `shouldRefine(cfg, durationMs)`, a FLOOR:
// 「never re-transcribe an utterance shorter than N seconds」 (default 15 s),
// because a second full transcription is a second engine bill.
//
// The bridge used to feed that gate the TERMINAL FINAL's `duration_ms`. That was
// the whole session's length — until card N1-B1 (24b75cc) made every final report
// the segment it closes, as book 15 §2.0-c requires (one segment = one row). After N1-B1 a user
// who releases a few seconds past a soft-segment rollover produces a terminal
// final of ~2 s, while `RetainedAudio` holds the ENTIRE recording. The floor then
// refuses exactly the long recordings the feature exists to serve.
//
// 🔴 And it refuses them SILENTLY. Refine is fire-and-forget by construction:
// nothing awaits it, nothing reports it, no frame is owed. A feature that stops
// running has, in this design, no observer at all — which is why the regression
// needs a test that watches the TRANSCRIBER, not the wire.
//
// The fix reads `RetainedAudio.durationMs` — the duration of the very buffer
// `take()` is about to hand the batch engine. The two directions below are the
// whole of it: the long-audio/short-final case must RUN, and the genuinely-short
// case must still NOT run (otherwise the fix has simply deleted the gate).

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { RETAINED_BYTES_PER_MS, RetainedAudio } from '../src/stt/stt-refine';
import { AUDIO_DEFAULTS, STT_REFINE_MIN_UTTERANCE_MS } from '@flowmic/protocol';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, SttRefine } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
}

interface Cap { event: string; payload: unknown }
interface Harness {
  bridge: SttSessionBridge;
  emitted: Cap[];
  orch: () => SttEngineOrchestrator;
  /** Every buffer the BATCH engine was actually asked to transcribe. The gate's
   *  honest truth: `stt:refined` can be withheld for four other reasons (no news, blank
   *  pass, engine error, `disposed`), so a test about the GATE must observe the
   *  call and not the frame. */
  passes: Buffer[];
}

function makeBridge(cfg: SttRefine): Harness {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  const passes: Buffer[] = [];
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => {
      orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    refine: {
      cfg,
      transcribe: async (pcm: Buffer) => { passes.push(pcm); return '第二遍的整句转写'; },
    },
    levelIntervalMs: 0,
  });
  return { bridge, emitted, orch: () => orchestrator!, passes };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** `ms` of silent 16 kHz mono s16le, base64 — the shape `pushChunk` takes. */
const chunk = (ms: number): string => Buffer.alloc(ms * RETAINED_BYTES_PER_MS).toString('base64');

/** Feed `totalMs` of audio in one-second chunks, the way the phone does. */
function speak(bridge: SttSessionBridge, totalMs: number): void {
  const step = 1_000;
  let seq = 0;
  for (let sent = 0; sent < totalMs; sent += step) {
    bridge.pushChunk(seq, chunk(Math.min(step, totalMs - sent)), seq * step);
    seq += 1;
  }
}

/** A soft-segment final: settles its own row, never triggers refine. */
function segmentFinal(orch: SttEngineOrchestrator, idx: number, durationMs: number): void {
  orch.emit('final', { text: `第${idx}段`, confidence: 1, language: 'zh', segment_idx: idx, is_segment: true, duration_ms: durationMs });
}
/** The terminal final: `is_segment:false` — the one that kicks refine. */
function terminalFinal(orch: SttEngineOrchestrator, idx: number, durationMs: number): void {
  orch.emit('final', { text: '收尾的一小句', confidence: 1, language: 'zh', segment_idx: idx, is_segment: false, duration_ms: durationMs });
}

describe('card N1-B1b — shouldRefine is asked about the retained audio, not about the last final', () => {
  it('🔴 REGRESSION: a long recording whose LAST segment is short still gets its second pass', async () => {
    // The exact post-N1-B1 shape: ~20 s spoken across soft-segment rollovers, and
    // the user lets go 2 s into the last one. The terminal final therefore says
    // 2000 ms — a third of the way to the 15 s floor — while the retained buffer
    // holds all 20 s.
    //
    // 🔴 Reverse control (seen RED): feed `finalDurationMs` to the gate instead of
    // `retained.durationMs`, i.e. 24b75cc's shipped behaviour, and this goes
    //   AssertionError: expected 0 to be 1  ⇒ passes.length
    // — the second pass simply never happens, with nothing else in the run
    // changing. That is the defect, stated as a measurement.
    const { bridge, orch, passes, emitted } = makeBridge({ enabled: true }); // floor = the shipped default
    await tick();

    speak(bridge, 20_000);
    segmentFinal(orch(), 0, 9_000);
    segmentFinal(orch(), 1, 9_000);
    terminalFinal(orch(), 2, 2_000);
    await settle();

    // The gate let it through …
    expect(passes.length).toBe(1);
    // … and it was handed ALL the audio, not the last segment. This second
    // assertion is not decoration: a 「fix」 that refined only the closing 2 s
    // would satisfy the count above while transcribing the wrong span, which is
    // the failure `RetainedAudio.take()` refuses to make in the overflow case.
    expect(passes[0]!.length).toBe(20_000 * RETAINED_BYTES_PER_MS);
    // Positive control on the wire, so 「the gate opened」 is not the only thing
    // measured — the pass really did reach the phone.
    expect(emitted.filter((e) => e.event === 'stt:refined').map((e) => (e.payload as { text: string }).text))
      .toEqual(['第二遍的整句转写']);
  });

  it('the floor STILL refuses a genuinely short utterance — the gate was not deleted', async () => {
    // The mirror. 2 s of audio, and this time the FINAL is the one that lies in
    // the generous direction (a terminal final claiming ten minutes). Both halves
    // matter: the pass must not run, AND the reason must be the audio rather than
    // the number on the frame.
    const { bridge, orch, passes } = makeBridge({ enabled: true });
    await tick();

    speak(bridge, 2_000);
    terminalFinal(orch(), 0, 600_000);
    await settle();

    expect(passes).toEqual([]);
  });

  it('the floor is exact at the boundary, in both directions', async () => {
    // A floor asserted only far from its edge is a floor whose edge is untested.
    // One millisecond of audio decides it, and the two runs differ by nothing else.
    const at = makeBridge({ enabled: true, min_utterance_ms: 4_000 });
    await tick();
    speak(at.bridge, 4_000);
    terminalFinal(at.orch(), 0, 10);
    await settle();
    expect(at.passes.length).toBe(1);

    const under = makeBridge({ enabled: true, min_utterance_ms: 4_000 });
    await tick();
    speak(under.bridge, 3_999);
    terminalFinal(under.orch(), 0, 10);
    await settle();
    expect(under.passes).toEqual([]);
  });

  it('refine OFF stays off however long the audio is', async () => {
    // The config still outranks the buffer — moving the gate's input must not
    // turn a disabled feature on.
    const { bridge, orch, passes } = makeBridge({ enabled: false });
    await tick();
    speak(bridge, 60_000);
    terminalFinal(orch(), 0, 60_000);
    await settle();
    expect(passes).toEqual([]);
  });
});

describe('card N1-B1b — the bytes→ms conversion is derived, not written down', () => {
  it('RETAINED_BYTES_PER_MS comes from the protocol capture format', () => {
    // Pinned two ways on purpose: the value today (32) and the derivation. If the
    // capture format ever changes, the derivation moves and this literal is the
    // line that says a human has to look — while the `BYTES_PER_SAMPLE` Record in
    // stt-refine.ts makes the compiler refuse the change outright.
    expect(RETAINED_BYTES_PER_MS).toBe(32);
    expect(AUDIO_DEFAULTS.sample_rate_hz).toBe(16_000);
    expect(AUDIO_DEFAULTS.channels).toBe(1);
    expect(AUDIO_DEFAULTS.encoding).toBe('pcm_s16le');
  });

  it('RetainedAudio.durationMs reports what it holds, and reports an overflow as nothing', () => {
    const r = new RetainedAudio(10 * RETAINED_BYTES_PER_MS);
    r.push(Buffer.alloc(4 * RETAINED_BYTES_PER_MS));
    expect(r.durationMs).toBe(4);

    // Overflow: `byteLength` already refuses a truncated buffer, so the duration
    // is 0 and `shouldRefine` rejects it on its own `durationMs <= 0` rule. A
    // partial span is not a shorter utterance — it is no utterance.
    r.push(Buffer.alloc(50 * RETAINED_BYTES_PER_MS));
    expect(r.overflowed).toBe(true);
    expect(r.durationMs).toBe(0);
  });

  it('the default cap still covers the 5-minute recording wall, expressed in ms', () => {
    // Same guarantee the existing RetainedAudio test states in bytes, restated in
    // the unit the gate now uses — the cap and the gate must not be able to
    // disagree about what a minute is.
    const r = new RetainedAudio();
    r.push(Buffer.alloc(5 * 60 * 1000 * RETAINED_BYTES_PER_MS));
    expect(r.overflowed).toBe(false);
    expect(r.durationMs).toBe(5 * 60 * 1000);
    expect(STT_REFINE_MIN_UTTERANCE_MS).toBeLessThan(r.durationMs);
  });
});

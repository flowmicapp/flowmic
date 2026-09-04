// Refine delivery on the NORMAL stop path (owner ruling Q2 b, 2026-09-03;
// design D7 ① ②) — engine/stt-session.ts + engine/stt-session-refine.ts.
//
// 🔴 2026-09-04 — WHAT THIS FILE NOW DRIVES. The second pass is an LLM SMOOTHING
// pass over the delivered text (「二次改顺」), not a batch STT re-transcription,
// so the seam a test gates is the LLM streamer, not a `transcribe(pcm)`
// callback. Every property below is about DELIVERY and none of them changed
// with the producer: the frame goes out after finish() → dispose(), it carries
// the terminal final's `utterance_id`, finish() does not wait for it, and a
// socket-gone dispose() drops it.
//
// WHAT CHANGED, in one sentence: the `stt:refined` emit used to be gated on
// `this.disposed`, and because the audio handler runs
// `finish().finally(() => s.dispose())`, `disposed` was true milliseconds after
// the terminal final while a batch re-transcription takes seconds — so on
// every normal audio:stop the second draft was never sent. The gate is now an
// "emitter closed" latch that `dispose()` sets ONLY when `finish()` did not
// own the teardown (the socket-gone paths), and both the terminal `stt:final`
// and the `stt:refined` carry the same server-minted `utterance_id`.
//
// 🔴 REVERSE CONTROL (executed 2026-09-03, this tree; restored byte-identical,
// sha256 compared). engine/stt-session.ts `dispose()` — replaced
// `if (!this.finishing) this.emitterClosed = true;` with an unconditional
// `this.emitterClosed = true;`, which is exactly what the old `this.disposed`
// gate amounted to → 3 red / 52 green across this file + stt-session-bridge.test.ts:
//     FAIL  stt-session-refine-delivery > 🔴 a refine that resolves AFTER finish() → dispose() is STILL emitted, with the utterance_id
//       AssertionError: expected [] to deeply equal [ '重转出来的整句' ]
//     FAIL  stt-session-refine-delivery > the emitted stt:refined carries the SAME utterance_id as the terminal stt:final
//       AssertionError: expected [] to have a length of 1 but got +0
//     FAIL  stt-session-bridge > ✅ 2026-09-03 (owner Q2 b, D7 ②) — GA-14 on the normal stop path is DELIVERED after finish() → dispose()
//       AssertionError: expected [] to deeply equal [ '重转出来的整句' ]
//   i.e. the exact defect this change removes, in the exact place it used to
//   be measured. The four that stayed green here are the ones that must: the
//   socket-gone drop, "finish() does not wait", the utterance_id on the final,
//   and the id generator itself. Restored; all green.
//
// ⚠️ The join this file cannot prove: that the PHONE puts the second draft on
// the right row. That is D7 ③ (WP-B, `_applyRefined` matching on utterance_id
// + entryType + owner); this file only proves the id is minted, shared by both
// frames, and that the frame actually leaves the server on the path users take.

// 🔴 REVERSE CONTROL for the floor (executed 2026-09-04, this tree; restored
// from a byte copy and re-run green). engine/stt-session-refine.ts — the guard
// `if (!shouldRefine(refine.cfg, utteranceMs))` was neutered to
// `if (false && !shouldRefine(...))`, i.e. the pass runs on every utterance
// regardless of length → 2 red / 10 green in this file:
//     FAIL  the second pass is an LLM smoothing pass over the delivered text >
//           🔴 skipped below the floor — a short utterance is not worth a second bill
//       AssertionError: expected [ { text: '重转出来的整句', …(1) } ] to deeply equal []
//     FAIL  the second pass is an LLM smoothing pass over the delivered text >
//           skipped when the switch is off — both ways it can be off
//       AssertionError: expected [ { text: '重转出来的整句', …(1) } ] to deeply equal []
//   The second one going red with it is the useful part: the OFF config is
//   refused by the same gate, so a change that unlocks the floor also unlocks
//   the switch. Restored; all 12 green.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SttSessionBridge, newUtteranceId } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { AudioSession } from '../src/stt/audio/session';
import { STT_REFINE_MIN_UTTERANCE_MS } from '@flowmic/protocol';
import type { LlmConfig, LlmProtocol, SttEngineId, SttRefine } from '@flowmic/protocol';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    if (this.finalOnFlush !== null) {
      this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 });
    }
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

const SR = 16_000;
const sine = (ms: number, amp = 0.3): Buffer => {
  const n = (SR * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b;
};
const b64 = (buf: Buffer): string => buf.toString('base64');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Cap { event: string; payload: unknown }
const refineCfg: SttRefine = { enabled: true, min_utterance_ms: 1 };
const RAW = '打开飞麦克';
const POLISHED = '打开FlowMic';
const REFINED = '重转出来的整句';

const LLM_CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };

/** A streamer that answers `full` only once `release()` has been called — the
 *  stand-in for a model that takes seconds on a long utterance. */
function gatedStreamerFor(full: string, gate: Promise<void>): (protocol: LlmProtocol) => LlmStreamer {
  return (_protocol) => async function* (): AsyncGenerator<LlmEvent> {
    await gate;
    yield { kind: 'done', full };
  };
}

/** A bridge with refine armed and a model that answers only when `release()` is called. */
function gatedBridge(): { bridge: SttSessionBridge; eng: FakeEngine; emitted: Cap[]; release: () => void } {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({
      orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
      isByok: false, gated: false,
    }),
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    refine: {
      cfg: refineCfg,
      llm: { cfg: LLM_CFG, source: 'user' },
      deps: { streamerFor: gatedStreamerFor(REFINED, gate) },
    },
    levelIntervalMs: 0,
  });
  return { bridge, eng, emitted, release };
}

const refinedFrames = (emitted: Cap[]): Record<string, unknown>[] =>
  emitted.filter((e) => e.event === 'stt:refined').map((e) => e.payload as Record<string, unknown>);
const terminalFinal = (emitted: Cap[]): Record<string, unknown> | undefined =>
  emitted.find((e) => e.event === 'stt:final' && (e.payload as { is_segment: boolean }).is_segment === false)?.payload as Record<string, unknown> | undefined;

describe('D7 ② — refine is delivered after the normal finish() → dispose() chain', () => {
  it('🔴 a refine that resolves AFTER finish() → dispose() is STILL emitted, with the utterance_id', async () => {
    const { bridge, eng, emitted, release } = gatedBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = RAW;
    await bridge.finish();
    bridge.dispose();          // exactly what audio.handler does next
    expect(refinedFrames(emitted)).toEqual([]); // nothing yet — the batch engine has not answered
    release();                 // the batch engine answers, "seconds" later
    await settle();
    expect(refinedFrames(emitted).map((f) => f.text)).toEqual([REFINED]);
  });

  it('the emitted stt:refined carries the SAME utterance_id as the terminal stt:final', async () => {
    const { bridge, eng, emitted, release } = gatedBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = RAW;
    await bridge.finish();
    bridge.dispose();
    release();
    await settle();
    const final = terminalFinal(emitted);
    expect(typeof final?.utterance_id).toBe('string');
    expect((final?.utterance_id as string).length).toBeGreaterThan(0);
    const refined = refinedFrames(emitted);
    expect(refined).toHaveLength(1);
    expect(refined[0]?.utterance_id).toBe(final?.utterance_id);
    // Exactly the declared keys — SttRefinedSchema's `text` + `utterance_id`.
    expect(Object.keys(refined[0]!).sort()).toEqual(['text', 'utterance_id']);
  });

  it('finish() does NOT wait for the refine (the 20 s audio:stop watchdog premise)', async () => {
    const { bridge, eng, emitted, release } = gatedBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = RAW;
    const t0 = Date.now();
    await bridge.finish();     // the transcriber is still gated — this must return regardless
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(terminalFinal(emitted)?.text).toBe(RAW);
    release();
    await settle();
  });

  it('🔴 failure direction: dispose() WITHOUT finish() (socket gone) closes the emitter and the late refine is dropped', async () => {
    // The six non-finish dispose paths (grace expiry, deliberate leave,
    // supersede, stopAll, the two local branches) — modelled by an auto-stop
    // style terminal final followed by a bare dispose(), no finish().
    const eng = new FakeEngine();
    const emitted: Cap[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    let orch: SttEngineOrchestrator | null = null;
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => {
        orch = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
        return { orchestrator: orch, isByok: false, gated: false };
      },
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => {},
      refine: {
        cfg: refineCfg,
        llm: { cfg: LLM_CFG, source: 'user' },
        deps: { streamerFor: gatedStreamerFor(REFINED, gate) },
      },
      levelIntervalMs: 0,
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    // A terminal final arrives (the refine is kicked) …
    orch!.emit('final', { text: RAW, confidence: 1, language: 'zh', segment_idx: 0, is_segment: false, duration_ms: 1234 });
    // … then the phone is gone: dispose with no finish().
    bridge.dispose();
    release();
    await settle();
    expect(refinedFrames(emitted)).toEqual([]);
  });

  it('only the TERMINAL final carries utterance_id; a soft-segment final does not', async () => {
    const eng = new FakeEngine();
    const emitted: Cap[] = [];
    let orch: SttEngineOrchestrator | null = null;
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => {
        orch = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
        return { orchestrator: orch, isByok: false, gated: false };
      },
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => {},
      levelIntervalMs: 0,
    });
    await tick();
    orch!.emit('final', { text: '第一段', confidence: 1, language: 'zh', segment_idx: 0, is_segment: true, duration_ms: 500 });
    orch!.emit('final', { text: '整句', confidence: 1, language: 'zh', segment_idx: 1, is_segment: false, duration_ms: 500 });
    const finals = emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload as Record<string, unknown>);
    expect(finals).toHaveLength(2);
    expect(finals[0]).not.toHaveProperty('utterance_id');
    expect(typeof finals[1]?.utterance_id).toBe('string');
    bridge.dispose();
  });

  it('newUtteranceId: 16 hex characters, fresh per call', () => {
    const a = newUtteranceId();
    const b = newUtteranceId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

// ── 2026-09-04: the pass is an LLM smoothing pass, so these four properties are
//    new and none of them was true (or even askable) of the batch-STT version ──
describe('the second pass is an LLM smoothing pass over the delivered text', () => {
  /** A bridge whose model answers immediately, with the engine id under test. */
  function bridge(opts: {
    engineId?: SttEngineId;
    cfg?: SttRefine;
    armed?: boolean;
    full?: string;
  } = {}): { bridge: SttSessionBridge; eng: FakeEngine; emitted: Cap[] } {
    const eng = new FakeEngine(opts.engineId ?? 'custom-openai-compatible');
    const emitted: Cap[] = [];
    const armed = opts.armed ?? true;
    const b = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
        isByok: false, gated: false,
      }),
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => {},
      ...(armed
        ? {
            refine: {
              cfg: opts.cfg ?? refineCfg,
              llm: { cfg: LLM_CFG, source: 'user' as const },
              deps: { streamerFor: gatedStreamerFor(opts.full ?? REFINED, Promise.resolve()) },
            },
          }
        : {}),
      levelIntervalMs: 0,
    });
    return { bridge: b, eng, emitted };
  }

  /** Drive one whole utterance: `ms` of audio, then a terminal final. */
  async function speak(h: { bridge: SttSessionBridge; eng: FakeEngine }, ms: number): Promise<void> {
    await tick();
    h.eng.finalOnFlush = RAW;
    // One chunk per 100 ms, because `totalAudioMs` is a tally of the audio the
    // session actually received — the number the floor is asked about.
    for (let sent = 0; sent < ms; sent += 100) h.bridge.pushChunk(sent / 100, b64(sine(100)), sent);
    await h.bridge.finish();
    h.bridge.dispose();
    await settle();
  }

  it('🔴 runs on a STREAMING engine (soniox) — there is no batch-engine requirement left', async () => {
    // The whole reason for the 2026-09-04 change: the previous pass demanded a
    // whole-utterance BATCH mode, which soniox and funasr do not have, so on
    // every production session the switch was ON and nothing happened. The
    // engine id is now not a party to the question at all.
    const h = bridge({ engineId: 'soniox' });
    await speak(h, 300);
    expect(refinedFrames(h.emitted).map((f) => f.text)).toEqual([REFINED]);
  });

  it('🔴 skipped below the floor — a short utterance is not worth a second bill', async () => {
    // 300 ms of audio against the shipped 15 s floor. The gate reads the WHOLE
    // utterance's audio (`totalAudioMs`), not the closing final's `duration_ms`
    // — see shouldRefine's own doc for why that distinction is load-bearing.
    const h = bridge({ cfg: { enabled: true, min_utterance_ms: STT_REFINE_MIN_UTTERANCE_MS } });
    await speak(h, 300);
    expect(refinedFrames(h.emitted)).toEqual([]);
  });

  it('runs once the utterance is long enough', async () => {
    // The positive control for the case above: same bridge, same floor, more
    // audio. Without it, "no frame" could equally mean the pass is broken.
    const h = bridge({ cfg: { enabled: true, min_utterance_ms: 1_000 } });
    await speak(h, 1_500);
    expect(refinedFrames(h.emitted).map((f) => f.text)).toEqual([REFINED]);
  });

  it('skipped when the switch is off — both ways it can be off', async () => {
    // (a) the factory did not arm the leg at all (the production shape: the dep
    // is simply absent), and (b) an armed dep carrying an OFF config.
    const unarmed = bridge({ armed: false });
    await speak(unarmed, 1_500);
    expect(refinedFrames(unarmed.emitted)).toEqual([]);

    const off = bridge({ cfg: { enabled: false, min_utterance_ms: 1 } });
    await speak(off, 1_500);
    expect(refinedFrames(off.emitted)).toEqual([]);
  });

  it('🔴 a guard rejection delivers NOTHING — never a partial, never a blanked row', async () => {
    // The model answers in another writing system. The guard refuses it and the
    // user keeps the text they already have; there is no half-way frame.
    const h = bridge({ full: 'open FlowMic please' });
    await speak(h, 300);
    expect(refinedFrames(h.emitted)).toEqual([]);
    // Positive control: the terminal final DID go out, so "no refined frame" is
    // a statement about the guard and not about a dead session.
    expect(terminalFinal(h.emitted)?.text).toBe(RAW);
  });

  it('smooths the DELIVERED text — the polished string, not the pure two-stage one', async () => {
    // The one join that decides whether the second draft agrees with the first.
    // Polish is ON and rewrites 打开飞麦克 → 打开FlowMic; the pass must be handed
    // THAT string, because smoothing the pre-polish text would hand the phone a
    // second draft that silently undoes the correction pass.
    const eng = new FakeEngine();
    const emitted: Cap[] = [];
    const seen: string[] = [];
    const b = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
        isByok: false, gated: false,
      }),
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => {},
      polish: {
        llm: { cfg: LLM_CFG, source: 'user' },
        deps: {
          streamerFor: (_p) => async function* (): AsyncGenerator<LlmEvent> {
            yield { kind: 'done', full: POLISHED };
          },
        },
      },
      refine: {
        cfg: refineCfg,
        llm: { cfg: LLM_CFG, source: 'user' },
        deps: {
          streamerFor: (_p) => async function* (opts): AsyncGenerator<LlmEvent> {
            seen.push(opts.user);
            yield { kind: 'done', full: REFINED };
          },
        },
      },
      levelIntervalMs: 0,
    });
    await tick();
    eng.finalOnFlush = RAW;
    b.pushChunk(0, b64(sine(300)), 0);
    await b.finish();
    b.dispose();
    await settle();
    expect(terminalFinal(emitted)?.text).toBe(POLISHED);
    expect(seen).toEqual([POLISHED]);
  });
});

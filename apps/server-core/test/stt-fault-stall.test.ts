// Card DR-0 — the TEST-ONLY fault hook `FLOWMIC_FAULT_STT_STALL_MS`
// (src/stt/fault-stall.ts), which makes the speech engine look dead while the
// socket stays alive so the real-device drill can reproduce scenario B-1 of
// docs/strategy/2026-09-06-audio-durability-device-drill.md (defect E7,
// docs/strategy/2026-08-27-project-status-log.md §A2-2).
//
// 🔴 WHAT THIS FILE HAS TO PROVE, AND WHY EACH HALF IS HERE.
//   ① The hook is UNREACHABLE IN SAAS BY CONSTRUCTION. The mode guard lives in
//      exactly one function; the saas case below drives the FULL fixture with the
//      variable set and demands behaviour byte-identical to unset. Reverse control
//      (run once, seen red): delete `if (mode !== 'standalone')` from
//      resolveSttFaultStallMs ⇒ the two saas cases below fail with
//      `AssertionError: expected 0 to be greater than 0` (the phone heard
//      nothing) and `expected 15000 to be +0`.
//   ② A stalled session still ACCEPTS AUDIO. `stt:level` keeps flowing and the
//      coverage receipt still counts the frames — that is the drill's whole point:
//      a moving level meter is not evidence that anything is being recognised.
//   ③ audio:stop inside the window FABRICATES NOTHING. The hook drops provider
//      events and nothing else, so the orchestrator's own empty-final path runs and
//      the phone sees what a genuinely dead vendor produces — NOT the text the fake
//      engine was holding.
//
// The positive control (same fixture, variable unset) is not decoration: without
// it, "zero interims" could just as well mean the fixture never produced any.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ServerMode, SttEngineId } from '@flowmic/protocol';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { resolveSttFaultStallMs, withSttFaultStall, FAULT_STT_STALL_ENV } from '../src/stt/fault-stall';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { SttEngine, EngineState, SttEngineConfig } from '../src/stt/engines/base';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    if (this.finalOnFlush !== null) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
  emitInterim(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 0.5, language: 'zh' }); }
}

const SR = 16_000;
const sine = (ms: number, amp = 0.3): Buffer => {
  const n = (SR * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b;
};
const b64 = (buf: Buffer): string => buf.toString('base64');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

interface Cap { event: string; payload: unknown }
const CFG: SttEngineConfig = { id: 'custom-openai-compatible', language: 'zh', sample_rate: 16_000 };

/**
 * The fixture wires the hook EXACTLY the way production does — the same two
 * calls, in the same order, `resolveSttFaultStallMs` first — so a change that
 * makes production stop honouring the mode is a change this fixture feels.
 * (Production: src/stt/engine-factory.ts, `const faultStallMs = …` at boot and
 * `withSttFaultStall(…)` around the terminology decorators per audio:start.)
 */
function makeSession(opts: { mode: ServerMode; env: NodeJS.ProcessEnv }): {
  bridge: SttSessionBridge; eng: FakeEngine; emitted: Cap[]; stallMs: number;
} {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  const stallMs = resolveSttFaultStallMs(opts.mode, opts.env);
  const factory = withSttFaultStall(() => eng, stallMs);
  const bridge = new SttSessionBridge({
    build: (session: AudioSession, _lang: string, _uid: string, _vad?: VadGate) => ({
      orchestrator: new SttEngineOrchestrator(session, () => factory('custom-openai-compatible', CFG), { engineFlushTimeoutMs: 200 }),
      isByok: false,
      gated: false,
    }),
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    levelIntervalMs: 0,
  });
  return { bridge, eng, emitted, stallMs };
}

const countOf = (emitted: Cap[], event: string): number => emitted.filter((e) => e.event === event).length;
const armed = { [FAULT_STT_STALL_ENV]: '600000' } as NodeJS.ProcessEnv; // 10 min: the window never lifts inside a test
type FinalPayload = { text: string; fed_frames?: number };

describe('FLOWMIC_FAULT_STT_STALL_MS — resolution and the mode guard', () => {
  it('is a number only in standalone', () => {
    expect(resolveSttFaultStallMs('standalone', { [FAULT_STT_STALL_ENV]: '15000' })).toBe(15_000);
  });

  it('🔴 saas ignores it — the one place the variable becomes a number answers 0', () => {
    expect(resolveSttFaultStallMs('saas', { [FAULT_STT_STALL_ENV]: '15000' })).toBe(0);
  });

  it('unset or empty is 0 in every mode (no wrapper is built at all)', () => {
    expect(resolveSttFaultStallMs('standalone', {})).toBe(0);
    expect(resolveSttFaultStallMs('standalone', { [FAULT_STT_STALL_ENV]: '  ' })).toBe(0);
    expect(resolveSttFaultStallMs('saas', {})).toBe(0);
  });

  it('a malformed value aborts start by name — it does not quietly disarm itself', () => {
    for (const bad of ['2s', '-1', '1.5', 'yes']) {
      expect(() => resolveSttFaultStallMs('standalone', { [FAULT_STT_STALL_ENV]: bad })).toThrow(FAULT_STT_STALL_ENV);
    }
  });

  it('withSttFaultStall returns the factory UNCHANGED when the stall is 0 (identity, not a no-op wrapper)', () => {
    const inner = (): SttEngine => new FakeEngine();
    expect(withSttFaultStall(inner, 0)).toBe(inner);
  });
});

describe('standalone + armed: the engine looks dead while the session stays alive', () => {
  it('accepts audio and keeps emitting stt:level, with zero stt:interim / stt:final', async () => {
    const { bridge, eng, emitted, stallMs } = makeSession({ mode: 'standalone', env: armed });
    expect(stallMs).toBe(600_000);
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.emitInterim('大家');
    bridge.pushChunk(1, b64(sine(200)), 200);
    eng.emitInterim('大家好');
    eng.emit('final', { kind: 'final', text: '大家好', confidence: 1, language: 'zh', duration_ms: 400 });
    await tick();

    expect(countOf(emitted, 'stt:interim')).toBe(0);
    expect(countOf(emitted, 'stt:final')).toBe(0);
    // ② the level meter keeps moving — the drill's exhibit A.
    expect(countOf(emitted, 'stt:level')).toBeGreaterThanOrEqual(2);
  });

  it('③ audio:stop inside the window produces the real empty-final path, never the engine text', async () => {
    const { bridge, eng, emitted } = makeSession({ mode: 'standalone', env: armed });
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    bridge.pushChunk(1, b64(sine(200)), 200);
    eng.finalOnFlush = 'the vendor would have said this'; // and must NOT reach the phone
    await bridge.finish();

    const finals = emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload as FinalPayload);
    expect(finals.map((f) => f.text)).not.toContain('the vendor would have said this');
    // The terminal final still carries the coverage receipt, and it still counts
    // the frames the dead provider was fed — `fed_frames` is what the phone checks
    // before deleting its only copy of the audio.
    const withReceipt = finals.find((f) => f.fed_frames !== undefined);
    expect(withReceipt?.fed_frames).toBe(2);
  });
});

describe('the window lifts on a session that survives it', () => {
  it('suppresses before the deadline and passes everything through after it', () => {
    // The clock is injected so this measures the DEADLINE, not the test runner's
    // scheduling luck — a sleep-based version of this assertion would be a timing
    // race dressed up as a contract.
    let nowMs = 1_000;
    const eng = new FakeEngine();
    const factory = withSttFaultStall(() => eng, 500, () => nowMs);
    // The seam the orchestrator subscribes through: every SttEngine is a concrete
    // EventEmitter, which the interface itself does not spell out (base.ts header).
    const built = factory('custom-openai-compatible', CFG) as unknown as EventEmitter;
    const seen: string[] = [];
    built.on('interim', (e: { text: string }) => seen.push(e.text));
    built.on('final', (e: { text: string }) => seen.push(`final:${e.text}`));
    // 'error' is deliberately NOT suppressed — a dead provider still reports
    // transport failures, and hiding them would model a different fault.
    const errors: string[] = [];
    built.on('error', (e: { message: string }) => errors.push(e.message));

    eng.emitInterim('swallowed');
    eng.emit('final', { kind: 'final', text: 'swallowed', confidence: 1, language: 'zh', duration_ms: 1 });
    eng.emit('error', { message: 'transport died' });
    expect(seen).toEqual([]);
    expect(errors).toEqual(['transport died']);

    nowMs += 500;
    eng.emitInterim('heard');
    eng.emit('final', { kind: 'final', text: 'heard', confidence: 1, language: 'zh', duration_ms: 1 });
    expect(seen).toEqual(['heard', 'final:heard']);
  });
});

describe('positive controls: the same fixture is loud when the hook is not armed', () => {
  it('standalone + unset ⇒ interims and the engine final reach the phone', async () => {
    const { bridge, eng, emitted } = makeSession({ mode: 'standalone', env: {} });
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.emitInterim('大家');
    eng.finalOnFlush = '大家好';
    await bridge.finish();

    expect(countOf(emitted, 'stt:interim')).toBeGreaterThan(0);
    expect(emitted.filter((e) => e.event === 'stt:final').map((e) => (e.payload as FinalPayload).text)).toContain('大家好');
  });

  it('🔴 saas + the variable SET behaves identically to unset', async () => {
    const { bridge, eng, emitted, stallMs } = makeSession({ mode: 'saas', env: armed });
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.emitInterim('大家');
    eng.finalOnFlush = '大家好';
    await bridge.finish();

    // 🔴 BEHAVIOUR FIRST, then the number. The other order would let this test
    // go red on `stallMs` before it ever drove a frame — and "the resolver
    // returned the wrong number" is a weaker fact than "the phone stopped
    // hearing itself", which is the one the mode guard actually protects.
    expect(countOf(emitted, 'stt:interim')).toBeGreaterThan(0);
    expect(emitted.filter((e) => e.event === 'stt:final').map((e) => (e.payload as FinalPayload).text)).toContain('大家好');
    expect(stallMs).toBe(0);
  });
});

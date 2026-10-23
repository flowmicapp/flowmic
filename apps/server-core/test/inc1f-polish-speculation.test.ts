// Card INC-1f — "polish while speaking" wired into the REAL bridge + orchestrator
// (only the engine and the LLM streamer are doubles). Design §7.1 T3/T4/T6–T10,
// T15 and §9; contract book 06 §5 (INC-1a block + 2026-10-14 addendum).
// Every case asserts on the WIRE (`stt:final` frames) and on the requests the
// model actually received.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest, POLISH_SYSTEM_PROMPT } from '../src/stt/stt-polish';
import { CONTEXT_CLOSE } from '../src/stt/stt-polish-piece';
import { readPolishSpeculativeFromEnv, speculationArmed } from '../src/engine/polish-speculation-env';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  pushes = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null && this.pushes > 0) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'en', duration_ms: 1000 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };
const pcm = (ms: number): string => {
  const n = (16_000 * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return b.toString('base64');
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

const A = 'so the first thing we need to do is look at the numbers for the third quarter.';
const B = 'then we compare them with the plan that the finance team sent over last week.';
const TAIL = 'and after that we decide';
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** The piece the model was asked to correct (the text after the context block). */
const pieceOf = (user: string): string => (user.includes(CONTEXT_CLOSE) ? user.slice(user.indexOf(CONTEXT_CLOSE) + CONTEXT_CLOSE.length + 1) : user);

interface Req { system: string; user: string; piece: string; at: 'speech' | 'after' }
interface Cap { event: string; payload: Record<string, unknown> }
interface Run { emitted: Cap[]; reqs: Req[]; meters: [number, number][]; bridge: SttSessionBridge; eng: FakeEngine; orch: () => SttEngineOrchestrator; phase: { after: boolean } }

function run(opts: { speculative?: boolean; fail?: (piece: string) => boolean; delayMs?: (piece: string) => number }): Run {
  const eng = new FakeEngine();
  const emitted: Cap[] = []; const reqs: Req[] = []; const meters: [number, number][] = [];
  const phase = { after: false };
  let orchestrator: SttEngineOrchestrator | null = null;
  const streamerFor = (_p: LlmProtocol): LlmStreamer => async function* (o): AsyncGenerator<LlmEvent> {
    const piece = pieceOf(o.user);
    reqs.push({ system: o.system, user: o.user, piece, at: phase.after ? 'after' : 'speech' });
    const d = opts.delayMs?.(piece) ?? 0;
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    if (opts.fail?.(piece)) { yield { kind: 'error', code: 'LLM_RATE_LIMITED', message: 'x' } as LlmEvent; return; }
    yield { kind: 'done', full: cap(piece), usage: { tokens_in: 10 + piece.length, tokens_out: piece.length } } as LlmEvent;
  };
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => { orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }); return { orchestrator, isByok: false, gated: false }; },
    emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
    userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
    onPolishUsage: (i, o) => meters.push([i, o]),
    polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor } },
    ...(opts.speculative ? { polishSpeculative: true } : {}),
    levelIntervalMs: 0,
  });
  return { emitted, reqs, meters, bridge, eng, orch: () => orchestrator!, phase };
}
const interim = (r: Run, text: string, stable: string | undefined, seg = 0): void => {
  r.orch().emit('interim', { text, confidence: 1, language: 'en', segment_idx: seg, ...(stable !== undefined ? { stable_text: stable } : {}) });
};
const finals = (r: Run): Cap['payload'][] => r.emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload);
/** Frames minus the two fields that differ between ANY two sessions (a fresh id, a wall-clock duration). */
const frames = (r: Run): Cap[] => r.emitted.filter((e) => e.event !== 'stt:level')
  .map((e) => ({ event: e.event, payload: Object.fromEntries(Object.entries(e.payload).filter(([k]) => k !== 'utterance_id' && k !== 'duration_ms')) }));

/** A long press: two committed sentences while speaking, a tail at release. */
async function longPress(r: Run, withStable = true): Promise<void> {
  await tick();
  r.bridge.pushChunk(0, pcm(300), 0);
  interim(r, `${A} then we`, withStable ? `${A} then` : undefined);
  await tick(10);
  interim(r, `${A} ${B} and after`, withStable ? `${A} ${B} and` : undefined);
  await tick(30);
  r.phase.after = true;
  r.eng.finalOnFlush = `${A} ${B} ${TAIL}`;
  await r.bridge.finish();
  r.bridge.dispose();
}

describe('card INC-1f — polish while speaking, on the wire', () => {
  beforeEach(() => __resetPolishCacheForTest());

  it('🔴 T6 pieces are requested while speaking, ONLY the tail after the final, and the frame carries the joined text as applied', async () => {
    const r = run({ speculative: true });
    await longPress(r);
    expect(r.reqs.filter((q) => q.at === 'speech').map((q) => q.piece)).toEqual([A, B]);
    expect(r.reqs.filter((q) => q.at === 'after').map((q) => q.piece)).toEqual([TAIL]);
    expect(r.reqs[0]!.system).toBe(POLISH_SYSTEM_PROMPT); // the first piece is the legacy request
    expect(r.reqs[1]!.user).toContain(A); // later pieces carry the earlier text as context
    const f = finals(r);
    expect(f).toHaveLength(1);
    // 🔴 T3 R11 at the frame: every piece of an `applied` frame came out of an accepted polish.
    expect(f[0]).toMatchObject({ is_segment: false, text: `${cap(A)} ${cap(B)} ${cap(TAIL)}`, polish: 'applied' });
  });

  it('🔴 T4 a span that fails at release ⇒ the WHOLE pure text, skipped + that reason (never a mixed text)', async () => {
    const r = run({ speculative: true, fail: (p) => p === TAIL });
    await longPress(r);
    expect(finals(r)[0]).toMatchObject({ text: `${A} ${B} ${TAIL}`, polish: 'skipped', polish_reason: 'llm_error' });
  });

  it('🔴 T10 every answered request is metered once, used or not', async () => {
    const r = run({ speculative: true });
    await longPress(r);
    expect(r.meters).toHaveLength(r.reqs.length);
    expect(r.meters.map(([i]) => i)).toEqual(r.reqs.map((q) => 10 + q.piece.length));
  });

  it('T7 stt:interim frames never carry stable_text', async () => {
    const r = run({ speculative: true });
    await longPress(r);
    const ims = r.emitted.filter((e) => e.event === 'stt:interim');
    expect(ims.length).toBeGreaterThan(0);
    for (const e of ims) expect('stable_text' in e.payload).toBe(false);
  });

  it('🔴 flag-off identity: the frames and the requests are what main produces, stable_text or not', async () => {
    const off = run({});
    await longPress(off);
    __resetPolishCacheForTest(); // the process LRU would answer the second run without a request
    const main = run({});
    await longPress(main, false);
    expect(off.reqs.map((q) => [q.system, q.user])).toEqual(main.reqs.map((q) => [q.system, q.user]));
    expect(off.reqs).toHaveLength(1);
    expect(off.reqs[0]!.user).toBe(`${A} ${B} ${TAIL}`);
    expect(frames(off)).toEqual(frames(main));
  });

  it('🔴 T9 a short press (< 60 committed characters) with the flag ON is exactly one legacy request and the same frame', async () => {
    const short = async (r: Run): Promise<void> => {
      await tick(); r.bridge.pushChunk(0, pcm(300), 0);
      interim(r, 'hello there. how', 'hello there. how'); await tick(10);
      r.phase.after = true; r.eng.finalOnFlush = 'hello there. how are you'; await r.bridge.finish(); r.bridge.dispose();
    };
    const on = run({ speculative: true }); await short(on);
    __resetPolishCacheForTest();
    const off = run({}); await short(off);
    expect(on.reqs.map((q) => [q.system, q.user])).toEqual([[POLISH_SYSTEM_PROMPT, 'hello there. how are you']]);
    expect(frames(on)).toEqual(frames(off));
  });

  it('paused, then released: the whole committed text is kicked at release and the final is a hit (no call after it)', async () => {
    const r = run({ speculative: true, delayMs: () => 30 });
    await tick(); r.bridge.pushChunk(0, pcm(300), 0);
    interim(r, 'we ship it today.', 'we ship it today.'); await tick(10);
    r.eng.finalOnFlush = 'we ship it today.';
    const done = r.bridge.finish();
    r.phase.after = true; // the kick happened synchronously inside finish()
    await done; r.bridge.dispose();
    expect(r.reqs.map((q) => [q.system, q.user, q.at])).toEqual([[POLISH_SYSTEM_PROMPT, 'we ship it today.', 'speech']]);
    expect(finals(r)[0]).toMatchObject({ text: 'We ship it today.', polish: 'applied' });
  });

  it('🔴 outbox order: a soft-segment final assembled from pieces is not overtaken by the next segment, and leaves without waiting for a new call', async () => {
    const r = run({ speculative: true, delayMs: (p) => (p === TAIL ? 80 : 0) });
    await tick(); r.bridge.pushChunk(0, pcm(300), 0);
    interim(r, `${A} ${B} x`, `${A} ${B} x`); await tick(30);
    const before = r.reqs.length;
    r.orch().emit('final', { text: `${A} ${B}`, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 1000 });
    interim(r, 'next segment words', undefined, 1);
    await tick(10);
    const order = r.emitted.filter((e) => e.event !== 'stt:level').map((e) => `${e.event}:${String(e.payload.segment_idx)}`);
    expect(order.indexOf('stt:final:0')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stt:final:0')).toBeLessThan(order.lastIndexOf('stt:interim:1'));
    expect(r.reqs.length).toBe(before); // the segment final was all hits
    expect(finals(r)[0]).toMatchObject({ is_segment: true, text: `${cap(A)} ${cap(B)}`, polish: 'applied' });
    r.eng.finalOnFlush = null; r.phase.after = true; await r.bridge.finish(); r.bridge.dispose();
  });
});

describe('card INC-1f — the release does not serialise behind an in-flight piece', () => {
  beforeEach(() => __resetPolishCacheForTest());
  it('🔴 the tail is requested while the last background piece is still in flight', async () => {
    const r = run({ speculative: true, delayMs: (p) => (p === B || p === TAIL ? 250 : 0) });
    await tick(); r.bridge.pushChunk(0, pcm(300), 0);
    interim(r, `${A} then we`, `${A} then`); await tick(10);
    interim(r, `${A} ${B} and after`, `${A} ${B} and`); await tick(10); // B is now in flight (250 ms)
    r.phase.after = true; r.eng.finalOnFlush = `${A} ${B} ${TAIL}`;
    const t0 = Date.now();
    await r.bridge.finish(); r.bridge.dispose();
    expect(Date.now() - t0).toBeLessThan(450); // serial would be >= 250 (B) + 250 (tail)
    expect(finals(r)[0]).toMatchObject({ text: `${cap(A)} ${cap(B)} ${cap(TAIL)}`, polish: 'applied' });
  });
});

describe('card INC-1f — the pause before a soft cut (design §9 addendum, measured)', () => {
  beforeEach(() => __resetPolishCacheForTest());
  it('🔴 an engaged segment that shows only committed text ending a sentence kicks the rest, so its final needs no new call', async () => {
    const r = run({ speculative: true });
    await tick(); r.bridge.pushChunk(0, pcm(300), 0);
    const SHORT = 'we stop here.';
    interim(r, `${A} we stop`, `${A} we`); await tick(10);
    interim(r, `${A} ${SHORT}`, `${A} ${SHORT}`); // the pause: everything shown is committed
    await tick(650);
    expect(r.reqs.map((q) => q.piece)).toEqual([A, SHORT]);
    const before = r.reqs.length;
    r.orch().emit('final', { text: `${A} ${SHORT}`, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 1000 });
    await tick(20);
    expect(r.reqs.length).toBe(before);
    expect(finals(r)[0]).toMatchObject({ is_segment: true, text: `${cap(A)} ${cap(SHORT)}`, polish: 'applied' });
    r.eng.finalOnFlush = null; r.phase.after = true; await r.bridge.finish(); r.bridge.dispose();
  });
});

describe('card INC-1f — the committed text comes from the real orchestrator', () => {
  beforeEach(() => __resetPolishCacheForTest());
  it('🔴 an engine interim carrying finalized_text kicks the piece through the real orchestrator (no hand-made stable_text)', async () => {
    const r = run({ speculative: true });
    await tick();
    r.bridge.pushChunk(0, pcm(300), 0);
    r.eng.emit('interim', { kind: 'interim', text: `${A} then we`, finalized_text: `${A} then`, confidence: 1, language: 'en' });
    await tick(20);
    expect(r.reqs.map((q) => q.piece)).toEqual([A]);
    r.phase.after = true; r.eng.finalOnFlush = `${A} then we go`; await r.bridge.finish(); r.bridge.dispose();
    expect(finals(r)[0]).toMatchObject({ text: `${cap(A)} ${cap('then we go')}`, polish: 'applied' });
  });
});

describe('card INC-1f — who may speculate', () => {
  it('🔴 T8 only realtime, polish armed, switch on, not continuous, not a recovery leg', () => {
    const base = { switchOn: true, polishArmed: true, mode: 'realtime' };
    expect(speculationArmed(base)).toBe(true);
    expect(speculationArmed({ ...base, switchOn: false })).toBe(false);
    expect(speculationArmed({ ...base, polishArmed: false })).toBe(false);
    expect(speculationArmed({ ...base, mode: 'translate' })).toBe(false);
    expect(speculationArmed({ ...base, mode: 'organize' })).toBe(false);
    expect(speculationArmed({ ...base, continuous: true })).toBe(false);
    expect(speculationArmed({ ...base, recoveryLeg: true })).toBe(false);
  });
  it('T15 the switch: unset/empty/off ⇒ off, on ⇒ on, anything else throws at boot', () => {
    expect(readPolishSpeculativeFromEnv({})).toBe(false);
    expect(readPolishSpeculativeFromEnv({ FLOWMIC_POLISH_SPECULATIVE: 'off' })).toBe(false);
    expect(readPolishSpeculativeFromEnv({ FLOWMIC_POLISH_SPECULATIVE: 'on' })).toBe(true);
    expect(() => readPolishSpeculativeFromEnv({ FLOWMIC_POLISH_SPECULATIVE: 'yes' })).toThrow(/FLOWMIC_POLISH_SPECULATIVE/);
  });
});

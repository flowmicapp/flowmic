// Card SEG-1 (real-device finding on 0.3.110, 2026-10-13): a press longer than
// the soft-segment window was cut at a pause; the segment final before the cut
// left UNPOLISHED with no polish field, and the terminal tail after the cut was
// empty, so its `polish:'skipped', polish_reason:'empty_output'` is hidden by the
// phone (`polish_badge.dart` `fromFinal`: empty text ⇒ no badge). In realtime a
// segment final is its own row (book 15 §2.0-c, `chat_utterance.dart`
// `_settleSpan`), so the user read ~500 unpolished characters and was told
// nothing — an R11 status lie.
//
// These cases drive the REAL bridge + orchestrator (only the engine and the LLM
// streamer are doubles) and assert, on the wire, the polish status of EVERY
// `stt:final` one press produces.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { PolishDeps, PolishSkipReason } from '../src/stt/stt-polish';

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
const SR = 16_000;
const sine = (ms: number): string => {
  const n = (SR * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b.toString('base64');
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Cap { event: string; payload: Record<string, unknown> }
interface Over {
  streamer?: (p: LlmProtocol) => LlmStreamer;
  polishUnavailable?: PolishSkipReason;
  continuous?: boolean;
  onPolishUsage?: (tIn: number, tOut: number, byok: boolean) => void;
  budgetMs?: number;
  recovery?: { recording_id?: string; attempt_id?: string; range_start_sample?: number; range_end_sample?: number };
  recoveryLeg?: boolean;
  onComplete?: () => void;
}
function makeBridge(over: Over): { bridge: SttSessionBridge; eng: FakeEngine; emitted: Cap[]; orch: () => SttEngineOrchestrator } {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  let orchestrator: SttEngineOrchestrator | null = null;
  const deps: PolishDeps = { streamerFor: over.streamer!, ...(over.budgetMs !== undefined ? { budgetMs: over.budgetMs } : {}) };
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => {
      orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
    userId: 'u', mode: 'realtime', sourceLang: 'en',
    onComplete: () => over.onComplete?.(),
    ...(over.recovery ? { recovery: over.recovery } : {}),
    ...(over.recoveryLeg ? { recoveryLeg: true } : {}),
    ...(over.onPolishUsage ? { onPolishUsage: over.onPolishUsage } : {}),
    ...(over.streamer ? { polish: { llm: { cfg: CFG, source: 'user' as const }, deps } } : {}),
    ...(over.polishUnavailable ? { polishUnavailable: over.polishUnavailable } : {}),
    ...(over.continuous ? { continuous: true } : {}),
    levelIntervalMs: 0,
  });
  return { bridge, eng, emitted, orch: () => orchestrator! };
}

/** An LLM double: answers each request with `answer(user)` after `delayMs`. */
function streamer(answer: (user: string) => LlmEvent, delayMs = 0, seen: string[] = []): (p: LlmProtocol) => LlmStreamer {
  return () => async function* (opts): AsyncGenerator<LlmEvent> {
    seen.push(opts.user);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield answer(opts.user);
  };
}
const finals = (emitted: Cap[]): Cap['payload'][] => emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload);

const SEG = 'so the first thing we need to do is look at the numbers for the third quarter';
const SEG_POLISHED = 'So the first thing we need to do is look at the numbers for the third quarter';

/** One press cut by the relay: a soft-segment final carrying words, then a
 *  terminal final whose tail is EMPTY (the device shape). */
async function cutPressWithEmptyTail(over: Over): Promise<{ emitted: Cap[]; eng: FakeEngine }> {
  const { bridge, eng, emitted, orch } = makeBridge(over);
  await tick();
  bridge.pushChunk(0, sine(300), 0);
  orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
  eng.finalOnFlush = null; // the tail after the cut carried nothing
  await bridge.finish();
  bridge.dispose();
  return { emitted, eng };
}

describe('card SEG-1 — every final of a cut press says whether it was polished', () => {
  beforeEach(() => __resetPolishCacheForTest());

  it('🔴 the segment before the cut is POLISHED and says applied; the empty tail says skipped(empty_output)', async () => {
    const seen: string[] = [];
    const { emitted } = await cutPressWithEmptyTail({ streamer: streamer(() => ({ kind: 'done', full: SEG_POLISHED }), 0, seen) });
    const f = finals(emitted);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ is_segment: true, segment_idx: 0, text: SEG_POLISHED, polish: 'applied' });
    expect(f[1]).toMatchObject({ is_segment: false, text: '', polish: 'skipped', polish_reason: 'empty_output' });
    expect(seen).toEqual([SEG]); // the empty tail is never sent to the model
  });

  it('🔴 an empty tail cannot mask an unpolished segment: a refused segment carries its OWN skipped reason', async () => {
    // The model times out on the segment. Before SEG-1 the segment frame carried
    // no polish field at all, and the only skip on the wire rode the empty tail —
    // which the phone deliberately hides.
    const { emitted } = await cutPressWithEmptyTail({ streamer: streamer(() => ({ kind: 'error', code: 'LLM_TIMEOUT', message: 'x' })) });
    const f = finals(emitted);
    expect(f[0]).toMatchObject({ is_segment: true, text: SEG, polish: 'skipped', polish_reason: 'timeout' });
  });

  it('polish requested but unarmable: the segment row is stamped like the terminal one', async () => {
    const { bridge, emitted, orch } = makeBridge({ polishUnavailable: 'not_configured' });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    expect(finals(emitted)[0]).toMatchObject({ is_segment: true, polish: 'skipped', polish_reason: 'not_configured' });
    bridge.dispose();
  });

  it('🔴 ORDER: nothing emitted after a held segment final overtakes it (interim of the next segment, the terminal final)', async () => {
    const { bridge, eng, emitted, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u.replace(/^so/, 'So') }), 60), budgetMs: 10_000 });
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    orch().emit('interim', { text: 'and then', confidence: 0.5, language: 'en', segment_idx: 1 });
    // Positive control: while the segment's polish is in flight, NOTHING is out yet.
    expect(emitted.filter((e) => e.event === 'stt:final' || e.event === 'stt:interim')).toEqual([]);
    eng.finalOnFlush = 'so and then the fourth';
    await bridge.finish();
    bridge.dispose();
    const order = emitted.filter((e) => e.event === 'stt:final' || e.event === 'stt:interim')
      .map((e) => `${e.event}#${String(e.payload.segment_idx)}${e.payload.is_segment === true ? 's' : ''}`);
    expect(order[0]).toBe('stt:final#0s');
    expect(order.indexOf('stt:interim#1')).toBeGreaterThan(0);
    expect(order[order.length - 1]?.startsWith('stt:final#')).toBe(true);
    expect(finals(emitted).every((p) => p.polish === 'applied')).toBe(true);
  });

  it('billing: each answered polish call is metered once (segment + terminal = 2)', async () => {
    const usage: number[] = [];
    const { bridge, eng, orch } = makeBridge({
      streamer: streamer((u) => ({ kind: 'done', full: u, usage: { tokens_in: 10, tokens_out: 5 } })),
      onPolishUsage: (tIn) => usage.push(tIn),
    });
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    eng.finalOnFlush = 'and the tail';
    await bridge.finish();
    bridge.dispose();
    expect(usage).toEqual([10, 10]);
  });

  it('continuous recordings keep the pre-SEG-1 contract: segment leaves at once, unpolished, no field', async () => {
    const seen: string[] = [];
    const { bridge, emitted, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u }), 0, seen), continuous: true });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    const f = finals(emitted);
    expect(f[0]).toMatchObject({ is_segment: true, text: SEG });
    expect(f[0]?.polish).toBeUndefined();
    expect(seen).toEqual([]);
    bridge.dispose();
  });

  it('a session torn down mid-segment-polish emits nothing for it or behind it', async () => {
    const { bridge, emitted, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u }), 40), budgetMs: 10_000 });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    orch().emit('interim', { text: 'queued behind it', confidence: 0.5, language: 'en', segment_idx: 1 });
    bridge.dispose();
    await tick(80);
    expect(finals(emitted)).toEqual([]);
    // …and what queued behind it is dropped too: a late frame for a torn-down
    // recording would land in whatever the phone is doing next.
    expect(emitted.filter((e) => e.event === 'stt:interim')).toEqual([]);
  });

  it('🔴 ORDER: stt:engine-status queues behind a held segment too (the phone clears its reconnect chip on any LATER interim)', async () => {
    const { bridge, emitted, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u }), 40), budgetMs: 10_000 });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    orch().emit('interim', { text: 'and then', confidence: 0.5, language: 'en', segment_idx: 1 });
    orch().emit('engine-status', { provider: 'soniox', status: 'reconnecting', retry_count: 1, retry_max: 3, retry_in_ms: 1_000, attempt_timeout_ms: 5_000 });
    await tick(120);
    // The leg's own 'connecting'/'ready' at start are before the hold and not this question.
    const order = emitted.filter((e) => e.event !== 'stt:engine-status' || e.payload.status === 'reconnecting').map((e) => e.event)
      .filter((e) => e === 'stt:final' || e === 'stt:interim' || e === 'stt:engine-status');
    expect(order).toEqual(['stt:final', 'stt:interim', 'stt:engine-status']);
    bridge.dispose();
  });

  it('MAIN 2026-10-13: a RECOVERY leg keeps the pre-SEG-1 contract — segment leaves at once, nothing reaches the LLM', async () => {
    const seen: string[] = [];
    const { bridge, emitted, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u }), 0, seen), recovery: { recording_id: 'r1', attempt_id: 'a1', range_start_sample: 0, range_end_sample: 960_000 }, recoveryLeg: true });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    const f = finals(emitted); // synchronously: not held
    expect(f[0]).toMatchObject({ is_segment: true, text: SEG });
    expect(f[0]?.polish).toBeUndefined();
    await tick(20);
    expect(seen).toEqual([]);
    bridge.dispose();
  });

  // Card SEG-1b (device check 2026-10-13, relay 0.3.111, Play 0.3.107, Notes
  // screen): every LIVE press of a phone with first-frame retention names its
  // recording on audio:start (mobile `liveStartFields`: attempt_kind:'live'), so
  // the bridge holds a recovery ECHO for it. Before SEG-1b the gate read that echo
  // as 「recovery leg」 and every segment of every real press left bare.
  it('🔴 SEG-1b: a LIVE press that carries the recovery echo is polished like any press — every row says applied', async () => {
    const seen: string[] = [];
    const TAIL = 'and then we can decide on the budget';
    const { bridge, eng, emitted, orch } = makeBridge({
      streamer: streamer((u) => ({ kind: 'done', full: u === SEG ? SEG_POLISHED : 'And then we can decide on the budget.' }), 0, seen),
      recovery: { recording_id: 'rec-live-1', attempt_id: 'att-live-1', range_start_sample: 0 },
    });
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    eng.finalOnFlush = TAIL;
    await bridge.finish();
    bridge.dispose();
    const f = finals(emitted);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ is_segment: true, segment_idx: 0, text: SEG_POLISHED, polish: 'applied' });
    expect(f[1]).toMatchObject({ is_segment: false, text: 'And then we can decide on the budget.', polish: 'applied' });
    expect(seen).toEqual([SEG, TAIL]);
  });

  it('SEG-1b: the same live press with polish requested but unarmable stamps the segment row too', async () => {
    const { bridge, emitted, orch } = makeBridge({ polishUnavailable: 'not_configured', recovery: { recording_id: 'rec-live-2', attempt_id: 'att-live-2', range_start_sample: 0 } });
    await tick();
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    expect(finals(emitted)[0]).toMatchObject({ is_segment: true, text: SEG, polish: 'skipped', polish_reason: 'not_configured' });
    bridge.dispose();
  });

  it('🔴 auto-stop drains a held segment final BEFORE billing/settle', async () => {
    const { bridge, emitted, orch } = makeBridge({
      streamer: streamer((u) => ({ kind: 'done', full: u }), 60), budgetMs: 10_000,
      onComplete: () => { finalsAtBilling.push(finals(emitted).length); },
    });
    const finalsAtBilling: number[] = [];
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    orch().emit('auto-stopped', { reason: 'hard_limit', limit_origin: 'engine_session' });
    await tick(200);
    expect(finalsAtBilling.length).toBeGreaterThan(0);
    expect(finalsAtBilling[0]).toBeGreaterThanOrEqual(1);
    bridge.dispose();
  });
});

describe('card SEG-1 — the polish timing line says which kind of final it timed', () => {
  let lines: { msg: string; fields: Record<string, unknown> }[] = [];
  beforeEach(() => {
    __resetPolishCacheForTest(); lines = [];
    for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation((msg: string, fields?: Record<string, unknown>) => { lines.push({ msg, fields: fields ?? {} }); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('🔴 segment polish logs is_segment:true, terminal polish logs is_segment:false', async () => {
    const { bridge, eng, orch } = makeBridge({ streamer: streamer((u) => ({ kind: 'done', full: u })) });
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    orch().emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
    eng.finalOnFlush = 'and the tail';
    await bridge.finish();
    bridge.dispose();
    const timing = lines.filter((l) => l.msg === 'stt.polish.timing').map((l) => [l.fields.chars_in, l.fields.is_segment]);
    expect(timing).toEqual([[SEG.length, true], ['and the tail'.length, false]]);
  });
});

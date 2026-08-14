// WP-R1-3 bridge tests (engine/stt-session.ts): the seam adapter maps driver
// events onto whitelisted socket payloads, drives stt:level from the VAD
// amplitude, calls the single recordSttUsage seam (onComplete) exactly once,
// bills the gated session ms for managed streaming, and propagates the router's
// SttConfigMissingError synchronously (#16 fail-loud).

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
// 🔴 THE DELIVERY JOIN reads the mode production selects instead of naming one.
// The census that pins that same literal lives in polish-delivery-census.test.ts;
// both sides share the scan so they cannot drift apart. See that module's header
// for why the two must be joined at all.
import { productionDelivery } from './polish-delivery-scan';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { SttConfigMissingError } from '../src/stt/engine-router';
import { makeFinalTextPipeline } from '../src/stt/final-text-pipeline';
import { buildDictionaryReplacer } from '../src/compose/dictionary-replace';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import type { Socket } from 'socket.io';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { SttEngineId, LlmConfig, LlmProtocol, SttRefine } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { FinalTextTransform } from '../src/stt/final-text-pipeline';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { LlmConfigSource, SelectedLlmConfig } from '../src/compose/llm-config';
import type { PolishDeps, PolishSkipReason } from '../src/stt/stt-polish';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> { if (this.finalOnFlush !== null) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  emitInterim(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 0.5, language: 'zh' }); }
}

const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };
/** A fake streamer dispatcher yielding fixed LLM events (no network). */
function fakeStreamerFor(events: LlmEvent[]): (protocol: LlmProtocol) => LlmStreamer {
  return (_protocol) => async function* (): AsyncGenerator<LlmEvent> { for (const e of events) yield e; };
}
/**
 * M4: the bridge takes the polish config as a SelectedLlmConfig — the config AND
 * the answer to 「who supplied it」 — so the BYOK flag it feeds the LLM meter is physically
 * derived from the same selection that produced the config. `source` is stated
 * here rather than defaulted, because a defaulted provenance is exactly the
 * assumption M4 exists to delete.
 */
function polishWith(events: LlmEvent[], source: LlmConfigSource = 'user'): { llm: SelectedLlmConfig; deps: PolishDeps } {
  return { llm: { cfg: CFG, source }, deps: { streamerFor: fakeStreamerFor(events) } };
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
interface BridgeOver {
  isByok?: boolean;
  gated?: boolean;
  finalText?: FinalTextTransform;
  polish?: { llm: SelectedLlmConfig; deps?: PolishDeps };
  polishUnavailable?: PolishSkipReason;
  polishDelivery?: 'sync' | 'detached';
  refine?: { cfg: SttRefine; transcribe: (pcm: Buffer) => Promise<string> };
  onPolishUsage?: (tIn: number, tOut: number, byok: boolean) => void;
}
function makeBridge(over: BridgeOver = {}): {
  bridge: SttSessionBridge; eng: FakeEngine; emitted: Cap[]; billed: () => { d: number; byok: boolean } | null; orch: () => SttEngineOrchestrator;
} {
  const eng = new FakeEngine();
  const emitted: Cap[] = [];
  let billed: { d: number; byok: boolean } | null = null;
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession, _lang: string, _uid: string, _vad?: VadGate) => {
      orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      return { orchestrator, isByok: over.isByok ?? false, gated: over.gated ?? false };
    },
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: (d, byok) => { billed = { d, byok }; },
    ...(over.onPolishUsage ? { onPolishUsage: over.onPolishUsage } : {}),
    ...(over.finalText ? { finalText: over.finalText } : {}),
    ...(over.polish ? { polish: over.polish } : {}),
    ...(over.polishUnavailable ? { polishUnavailable: over.polishUnavailable } : {}),
    ...(over.polishDelivery ? { polishDelivery: over.polishDelivery } : {}),
    ...(over.refine ? { refine: over.refine } : {}),
    levelIntervalMs: 0,
  });
  return { bridge, eng, emitted, billed: () => billed, orch: () => orchestrator! };
}

interface FinalCap { text: string; is_segment: boolean; polish?: string; polish_reason?: string }
const finalPayload = (emitted: Cap[]): FinalCap => emitted.find((e) => e.event === 'stt:final')?.payload as FinalCap;
const refinedTexts = (emitted: Cap[]): string[] =>
  emitted.filter((e) => e.event === 'stt:refined').map((e) => (e.payload as { text: string }).text);
/** Let a detached task and its awaits settle. Deliberately a real macrotask: the
 *  polish leg is fire-and-forget, so a microtask flush would not observe it. */
const settleDetached = async (ms = 30): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); };

describe('SttSessionBridge', () => {
  it('maps interim/final onto whitelisted payloads and emits stt:level', async () => {
    const { bridge, eng, emitted } = makeBridge();
    await tick(); // let orchestrator.start() open the engine
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.emitInterim('大家');
    eng.finalOnFlush = '大家好';
    await bridge.finish();

    const interim = emitted.find((e) => e.event === 'stt:interim')?.payload as { text: string; confidence: number; language: string; segment_idx: number };
    expect(interim).toMatchObject({ text: '大家', language: 'zh', segment_idx: 0 });
    expect(interim.confidence).toBeGreaterThanOrEqual(0);
    expect(interim.confidence).toBeLessThanOrEqual(1);

    const final = emitted.find((e) => e.event === 'stt:final')?.payload as { text: string; is_segment: boolean; duration_ms: number };
    expect(final).toMatchObject({ text: '大家好', is_segment: false });
    expect(Number.isInteger(final.duration_ms)).toBe(true);

    const level = emitted.find((e) => e.event === 'stt:level')?.payload as { amplitude_db: number };
    expect(typeof level.amplitude_db).toBe('number');
    expect(level.amplitude_db).toBeGreaterThan(-30); // loud sine
  });

  it('calls the recordSttUsage seam exactly once with the BYOK flag', async () => {
    const { bridge, eng, emitted, billed } = makeBridge({ isByok: true });
    await tick();
    bridge.pushChunk(0, b64(sine(500)), 0);
    eng.finalOnFlush = 'done';
    await bridge.finish();
    await bridge.finish(); // idempotent — must not double-bill
    expect(billed()).not.toBeNull();
    expect(billed()!.byok).toBe(true);
    expect(billed()!.d).toBeGreaterThanOrEqual(0);
    expect(emitted.filter((e) => e.event === 'stt:final')).toHaveLength(1);
  });

  it('bills the gated session ms (< raw audio ms) for a managed streaming session', async () => {
    const { bridge, eng, billed } = makeBridge({ isByok: false, gated: true });
    await tick();
    // 500ms speech + 2000ms silence → gated billing excludes the silence.
    bridge.pushChunk(0, b64(Buffer.concat([sine(500), Buffer.alloc(SR * 2 * 2)])), 0);
    eng.finalOnFlush = 'x';
    await bridge.finish();
    expect(billed()!.d).toBeGreaterThan(0);
    expect(billed()!.d).toBeLessThan(2500); // well under the 2500ms of raw audio
  });

  it('WP-R4-5: stt:final carries the dictionary-replaced + normalized text while interim stays verbatim', async () => {
    // The exact seam contract: the FINAL pipeline (dict replace → normalizer) is
    // applied at the stt:final fan-out — so mobile, PC, and the mobile-driven
    // history:create all read the SAME processed text — but interim is untouched.
    const finalText = makeFinalTextPipeline(
      buildDictionaryReplacer([{ canonical: 'FlowMic', aliases: ['飞麦克'] }]),
    );
    const { bridge, eng, emitted } = makeBridge({ finalText });
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.emitInterim('我在用飞麦克说话'); // interim: homophone present, NOT rewritten
    eng.finalOnFlush = '打开飞麦克';       // final: homophone → FlowMic + terminal 。
    await bridge.finish();

    const interim = emitted.find((e) => e.event === 'stt:interim')?.payload as { text: string };
    expect(interim.text).toBe('我在用飞麦克说话'); // verbatim: no dict replace, no punctuation

    const final = emitted.find((e) => e.event === 'stt:final')?.payload as { text: string; is_segment: boolean };
    expect(final).toMatchObject({ text: '打开FlowMic。', is_segment: false });
  });

  it('WP-R4-5: identity when no finalText transform is injected (adapter-only harness)', async () => {
    // The default (no pipeline) leaves the driver text byte-identical — the
    // processing is an INJECTED capability, wired in production by stt-factory.
    const { bridge, eng, emitted } = makeBridge();
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    const final = emitted.find((e) => e.event === 'stt:final')?.payload as { text: string };
    expect(final.text).toBe('打开飞麦克'); // untouched
  });

  it('propagates SttConfigMissingError synchronously (#16 fail-loud)', () => {
    expect(() => new SttSessionBridge({
      build: () => { throw new SttConfigMissingError('ko'); },
      emitter: { emit: () => {} },
      userId: 'u', mode: 'realtime', sourceLang: 'ko',
      onComplete: () => {},
    })).toThrow(SttConfigMissingError);
  });
});

// ── WP-R4-6 opt-in polish — THE SHIPPED PATH, still synchronous ──────────────
//
// 🔴 first-in-charge 2026-08-07 ruled option (c): production stays SYNCHRONOUS until the
// mobile fix ships AND reaches the field. owner's async ruling needs both halves
// — show early AND replace late — and the replacing half has no safe carrier yet
// (see the withholding block below), so shipping the showing half alone would
// bill a user for a correction they never receive. That is a NEW state, worse
// than today, not a degrade to the status quo.
//
// These assertions are therefore the ORIGINAL WP-R4-6 ones: the polished text
// arrives ON stt:final with an honest applied|skipped signal. The detached shape
// is exercised in its own blocks below, via `polishDelivery: 'detached'`.
describe('SttSessionBridge — WP-R4-6 polish, delivered synchronously (production)', () => {
  beforeEach(() => __resetPolishCacheForTest());

  it('polish OFF: stt:final has NO polish field (byte-identical to today)', async () => {
    const { bridge, eng, emitted } = makeBridge();
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    const f = finalPayload(emitted);
    expect(f.text).toBe('打开飞麦克');
    expect('polish' in (f as object)).toBe(false);
    expect(f.polish).toBeUndefined();
  });

  it("polish ON + guard-accepted change → stt:final polish:'applied' with the polished text", async () => {
    const { bridge, eng, emitted } = makeBridge({ polish: polishWith([{ kind: 'done', full: '打开FlowMic' }]) });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    const f = finalPayload(emitted);
    expect(f).toMatchObject({ text: '打开FlowMic', is_segment: false, polish: 'applied' });
    expect(f.polish_reason).toBeUndefined();
  });

  it('🔴 THE DELIVERY JOIN: the mode PRODUCTION selects really puts the polished text on stt:final', async () => {
    // 🔴 THE ASSERTION THAT WAS MISSING ALL ALONG (POLISH-1, owner 2026-08-11).
    //
    // Every other polish case in this file states its own delivery mode. So on
    // 2026-08-08, when stt-factory.ts began selecting 'detached' — a mode that
    // computes the correction, meters it, and ends at 「no safe carrier —
    // withheld」 — the capability vanished from the product and this suite stayed
    // entirely green. The only cases that spoke about detached delivery asserted
    // the DISCARD, so the suite agreed with the defect instead of catching it.
    // Nothing here connected 「what production selects」 to 「does the user get it」.
    //
    // This case is that connection, and it does not restate what production ought
    // to select: it reads the literal out of `src/` and drives the bridge with it.
    // It therefore fails on every way the delivery can be lost —
    //   · this line flipped back to 'detached'                → text never arrives
    //   · the src line deleted AND the accessor default flipped in stt-session.ts
    //     → same, because `undefined` here asks the accessor the same question
    //   · a future mode that emits something other than the corrected final
    // ⚠️ It asserts the TEXT first and the marker second, in that order and both:
    // a mode that stamped polish:'applied' onto the pure two-stage string would
    // pass a marker-only check while delivering nothing (R11's shape), and a mode
    // that delivered the text with no signal would fail the promise `polish_hint`
    // makes in four languages.
    // ⚠️ settleDetached() is deliberate slack, not tidiness: without it a detached
    // mode could be failed for being LATE rather than for being ABSENT, and those
    // are different defects. It gets its chance and still does not deliver.
    const chosen = productionDelivery();
    const { bridge, eng, emitted } = makeBridge({
      ...(chosen !== undefined ? { polishDelivery: chosen } : {}),
      polish: polishWith([{ kind: 'done', full: '打开FlowMic' }]),
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    await settleDetached();
    expect(finalPayload(emitted).text).toBe('打开FlowMic');
    expect(finalPayload(emitted).polish).toBe('applied');
  });

  it('🔴 sync is the DEFAULT: an armed session with no polishDelivery waits for the model', async () => {
    // The FLOOR, not production's selection: since POLISH-1 stt-factory.ts states
    // 'sync' explicitly, so this case no longer describes what production gets —
    // it describes what any caller that states nothing gets, which is the second
    // author of the mode and the one the file census cannot see. A dep that
    // silently began defaulting to 'detached' fails here even though no src file
    // changed, and the join above fails with it.
    let answered = false;
    const slow = (_p: LlmProtocol): LlmStreamer =>
      async function* (): AsyncGenerator<LlmEvent> {
        await new Promise((r) => setTimeout(r, 60));
        answered = true;
        yield { kind: 'done', full: '打开FlowMic' };
      };
    const { bridge, eng, emitted } = makeBridge({
      polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: slow, budgetMs: 10_000 } },
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    expect(answered).toBe(true);   // finish() waited for it …
    expect(finalPayload(emitted)).toMatchObject({ text: '打开FlowMic', polish: 'applied' });
  });

  it('polish runs AFTER the pure two-stage (dictionary → normalizer → polish order preserved)', async () => {
    // dict resolves 飞麦克→FlowMic and the normalizer adds the terminal 。 BEFORE
    // polish sees the text; the LLM echoes it → applied, no change.
    const finalText = makeFinalTextPipeline(buildDictionaryReplacer([{ canonical: 'FlowMic', aliases: ['飞麦克'] }]));
    const { bridge, eng, emitted } = makeBridge({ finalText, polish: polishWith([{ kind: 'done', full: '打开FlowMic。' }]) });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    expect(finalPayload(emitted)).toMatchObject({ text: '打开FlowMic。', polish: 'applied' });
  });

  it.each([
    ['LLM_TIMEOUT error', [{ kind: 'error', code: 'LLM_TIMEOUT', message: 'x' }] as LlmEvent[], 'timeout'],
    ['transport error', [{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'x' }] as LlmEvent[], 'llm_error'],
    ['empty output', [{ kind: 'done', full: '   ' }] as LlmEvent[], 'empty_output'],
    ['guard rejection', [{ kind: 'done', full: '我去' }] as LlmEvent[], 'guard_reject'],
  ])('polish ON + %s → stt:final skipped(%s) delivering the pure two-stage text', async (_label, events, reason) => {
    const raw = reason === 'guard_reject' ? '我不去' : '你好世界';
    const { bridge, eng, emitted } = makeBridge({ polish: polishWith(events) });
    await tick();
    eng.finalOnFlush = raw;
    await bridge.finish();
    expect(finalPayload(emitted)).toMatchObject({ text: raw, is_segment: false, polish: 'skipped', polish_reason: reason });
  });

  it('🔴 R11: a THROWING meter must not make the frame say applied over un-polished text', async () => {
    // The defect RT-1's shared meterPolish seam FIXES rather than preserves.
    // Pre-RT-1 the wire signal was computed BEFORE the meter ran, so a sqlite
    // throw fell into the outer catch, reverted `text` to the pure two-stage
    // string — and shipped it still carrying polish:'applied'. A frame claiming
    // the polish applied while carrying un-polished text is R11 exactly
    // (「every status word must be able to answer 『what makes you say that』」).
    const { bridge, eng, emitted } = makeBridge({
      polish: {
        llm: { cfg: CFG, source: 'managed-default' },
        deps: { streamerFor: fakeStreamerFor([{ kind: 'done', full: '打开FlowMic', usage: { tokens_in: 1, tokens_out: 1 } }]) },
      },
      onPolishUsage: () => { throw new Error('SQLITE_BUSY: database is locked'); },
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    // Text and signal AGREE: the polish really did apply, and the money loss is a
    // named log line instead of a corrupted status word.
    expect(finalPayload(emitted)).toMatchObject({ text: '打开FlowMic', polish: 'applied' });
  });

  // 🔴 THE PRIVACY INVARIANT. Three shipped surfaces in four languages
  // (desktop lib/strings/disclosure.ts, mobile settings/strings/
  // disclosure_strings.dart, docs/legal/privacy-policy.md) tell users that only
  // the CLOSING transcript of a recording is ever sent to the model, and that the
  // provisional words are never sent. Async-ification must change WHEN the answer
  // comes back, never WHICH text leaves the device.
  it('🔴 only the utterance-closing final ever reaches the vendor (interim + soft-segment never do)', async () => {
    const seen: string[] = [];
    const spyStreamer = (_p: LlmProtocol): LlmStreamer =>
      async function* (opts): AsyncGenerator<LlmEvent> {
        seen.push(opts.user);
        yield { kind: 'done', full: `${opts.user}!` };
      };
    const { bridge, eng, emitted, orch } = makeBridge({
      polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: spyStreamer } },
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.emitInterim('临时的字');
    orch().emit('final', { text: '这是一个软分段', confidence: 1, language: 'zh', segment_idx: 0, is_segment: true, duration_ms: 500 });
    eng.finalOnFlush = '终稿';
    await bridge.finish();
    await settleDetached();
    // The census, not a spot check: exactly one text left, and it is the terminal.
    expect(seen).toEqual(['终稿']);
    const seg = emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload as FinalCap);
    expect(seg.find((f) => f.is_segment)?.polish).toBeUndefined();
    expect((emitted.find((e) => e.event === 'stt:interim')?.payload as { polish?: string }).polish).toBeUndefined();
  });

  it('the recordSttUsage seam still fires exactly once, and settles WITHOUT the LLM', async () => {
    const { bridge, eng, emitted, billed } = makeBridge({ polish: polishWith([{ kind: 'done', full: '打开FlowMic' }]) });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    await bridge.finish(); // idempotent settle
    expect(emitted.filter((e) => e.event === 'stt:final')).toHaveLength(1);
    expect(billed()).not.toBeNull();
  });
});

// ── RT-1 §3.1 ① — the TIMING claim, measured ─────────────────────────────────
//
// 「stt:final emits immediately」 is the whole card. Asserted with a stub whose polish takes
// far longer than any budget, so 「the final did not wait」 is a measurement and
// not a hope: if the await came back, this test would take at least SLOW_MS.
// ⚠️ EVERY case in this block passes `polishDelivery: 'detached'` explicitly.
// That is not boilerplate — it is the reason these tests exist: the mechanism is
// complete and proven, and production still does not select it.
describe("SttSessionBridge — RT-1 'detached' timing: the final does not wait on the LLM", () => {
  beforeEach(() => __resetPolishCacheForTest());
  const SLOW_MS = 400;

  it('🔴 the final is on the wire before the LLM answers, and finish() does not contain the LLM time', async () => {
    let answered = false;
    const slow = (_p: LlmProtocol): LlmStreamer =>
      async function* (): AsyncGenerator<LlmEvent> {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        answered = true;
        yield { kind: 'done', full: '打开FlowMic' };
      };
    const { bridge, eng, emitted } = makeBridge({
      polishDelivery: 'detached',
      polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: slow, budgetMs: 10_000 } },
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    const t0 = Date.now();
    await bridge.finish();
    const finishMs = Date.now() - t0;
    // ① the final is already out, with the un-polished text …
    expect(finalPayload(emitted)).toMatchObject({ text: '打开飞麦克' });
    // ② … while the model has NOT answered. This is what makes ③ a measurement of
    //    「did not wait」 rather than of 「there was nothing to wait for」.
    expect(answered).toBe(false);
    // ③ … and the settle path did not spend the LLM's time. Half of SLOW_MS is a
    //    deliberately loose bar: the claim is 「not blocked」, and a tight one would
    //    turn CI jitter into a failure that says nothing.
    expect(finishMs).toBeLessThan(SLOW_MS / 2);
    // ④ the pass does complete, later, on its own.
    await settleDetached(SLOW_MS + 150);
    expect(answered).toBe(true);
  });

  it('🔴 failure direction: with the LLM entirely dead the final still ships, on time', async () => {
    // The structural reason this card chose async. A streamer that never answers
    // at all (the budget aborts it) must cost the utterance nothing.
    const dead = (_p: LlmProtocol): LlmStreamer =>
      async function* (): AsyncGenerator<LlmEvent> {
        await new Promise((r) => setTimeout(r, 5_000));
        yield { kind: 'done', full: 'never seen' };
      };
    const { bridge, eng, emitted } = makeBridge({
      polishDelivery: 'detached',
      polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: dead, budgetMs: 40 } },
    });
    await tick();
    eng.finalOnFlush = '你好世界';
    const t0 = Date.now();
    await bridge.finish();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(finalPayload(emitted)).toMatchObject({ text: '你好世界' });
    await settleDetached(120);
    expect(refinedTexts(emitted)).toEqual([]); // timeout ⇒ no frame, bare final stands
  });
});

// ── RT-1 — the detached pass must NOT deliver on `stt:refined` ───────────────
//
// 🔴 WHAT THIS BLOCK IS, RESTATED BY POLISH-1 (owner 2026-08-11), because its
// old title (「the detached polish result is computed and withheld」) named a
// SYMPTOM and the symptom then became the product. Production selected
// 'detached' from 0.2.59 until POLISH-1, and while it did, these cases were the
// only ones in this file describing the delivery production actually ran — and
// what they assert is that the user gets NOTHING. A suite whose only statement
// about the shipped behaviour is 「the correction is discarded」 cannot report
// that the correction is being discarded. Nothing here was wrong; it was aimed
// at a mechanism, and the mechanism became the product without these cases
// changing a character.
//
// So what they PROTECT is stated instead of what they observe: `stt:refined` is
// not an admissible carrier for a polish correction, because the phone cannot
// correlate it to the row it belongs to. That property is unchanged by POLISH-1
// — the carrier still does not exist and `runDetachedPolish` still ends in a
// withheld log — so these cases stay, aimed at the detached MECHANISM that sits
// beside production. What production does is asserted by THE DELIVERY JOIN in
// the production block above; do not read this block as a statement about it.
//
// The original reasoning, which is why the carrier is banned:
//
// 🔴 This block replaces one that asserted the opposite. The first design routed
// the detached polish onto `stt:refined` (GA-14's event) behind a server-side
// 「still the most recent utterance」 gate. An adversarial review killed it, and
// the reason is worth more than the code was:
//
//   the server can enforce 「no newer UTTERANCE」; the phone asserts 「no newer
//   ROW」. `chat_utterance.dart` `_applyRefined` takes `store.entries` unfiltered
//   by entry type or owner, guarded only on `edited` / `processedText`. Four of
//   the five row-insertion callers are not utterances — an image sent to the PC,
//   a record-only image, a typed note, a canned-phrase tap — and `buildDeliveryRow`
//   leaves both guards open on them. The rows that make the gate wrong are
//   exactly the rows the server never sees.
//
// So the stated safety argument (「sending one fewer correction = fall back to the bare final」) was false where it
// mattered: it failed toward silently overwriting a photo caption or the user's
// own typed text, persisted, with no way back. `request_id` could not have saved
// it either — there is no id in the audio path to echo.
//
// These tests therefore pin the CARRIER BAN, and they are written to go red the
// moment someone wires `stt:refined` back up without fixing the phone.
describe('SttSessionBridge — RT-1: the detached pass never delivers on stt:refined', () => {
  beforeEach(() => __resetPolishCacheForTest());

  const refineCfg: SttRefine = { enabled: true, min_utterance_ms: 1 };
  // 🔴 The polish output has to be one the meaning-preservation guard ACCEPTS, or
  // a test about delivery is really a test about the guard. My first draft used
  // first pass → polished version and two cases went green/red for reasons that had nothing to do
  // with the property under test. 打开飞麦克 → 打开FlowMic is the pair the block
  // above already proves passes.
  const RAW = '打开飞麦克';
  const POLISHED = '打开FlowMic';

  it('🔴 a guard-ACCEPTED correction does not go out on stt:refined', async () => {
    // The case is built on a correction the guard ACCEPTS on purpose: an output
    // the guard rejects would produce no frame for a reason that has nothing to
    // do with the carrier, and the case would pass while measuring the guard.
    const { bridge, eng, emitted } = makeBridge({ polishDelivery: 'detached', polish: polishWith([{ kind: 'done', full: POLISHED }]) });
    await tick();
    eng.finalOnFlush = RAW;
    await bridge.finish();
    bridge.dispose();
    await settleDetached();
    expect(refinedTexts(emitted)).toEqual([]);
    // Positive control on the OTHER side: the bare final is still there, so 「no
    // refined frame」 is 「that carrier was not used」 and not 「the utterance
    // vanished」. ⚠️ It is NOT a positive control for delivery — under this mode
    // the bare final is all the user ever gets, which is precisely why the
    // production block owns the delivery assertion and this block does not.
    expect(finalPayload(emitted)).toMatchObject({ text: RAW, is_segment: false });
  });

  it('🔴 the polish leg is not a producer of stt:refined AT ALL (a census of the emitter)', async () => {
    // Pinned as a census rather than as one absent frame: this is the assertion
    // that must fail if a future round re-wires the carrier before the phone can
    // pick the right row. ⚠️ A census of EVENT NAMES, so it says nothing about
    // whether the correction reached the user by some other route — that question
    // belongs to THE DELIVERY JOIN, and reading this case as an answer to it is
    // how the discard survived a whole release.
    const { bridge, eng, emitted } = makeBridge({ polishDelivery: 'detached', polish: polishWith([{ kind: 'done', full: POLISHED }]) });
    await tick();
    eng.finalOnFlush = RAW;
    await bridge.finish();
    await settleDetached();
    expect([...new Set(emitted.map((e) => e.event))].sort()).toEqual(['stt:engine-status', 'stt:final']);
  });

  it('GA-14 refine is UNCHANGED by this card — same gate, same shape', async () => {
    // Positive control for the two assertions above: `stt:refined` is still a
    // live event with a live producer, so 「polish emits nothing」 is a statement
    // about polish and not about a dead seam. The auto-stop path is used because
    // it is the one where GA-14's `disposed` gate lets a frame through.
    const { bridge, emitted, orch } = makeBridge({
      refine: { cfg: refineCfg, transcribe: async () => '重转出来的整句' },
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    orch().emit('final', { text: RAW, confidence: 1, language: 'zh', segment_idx: 0, is_segment: false, duration_ms: 1234 });
    await settleDetached();
    expect(refinedTexts(emitted)).toEqual(['重转出来的整句']);
  });

  it('the GA-14 frame carries exactly SttRefinedSchema — no undeclared keys', async () => {
    // `language` used to ride along off-contract. Nothing read it (the phone takes
    // data['text'] only; the desktop does not subscribe at all), and a key that is
    // not in the schema is a key no receiver may rely on.
    const { bridge, emitted, orch } = makeBridge({
      refine: { cfg: refineCfg, transcribe: async () => '重转出来的整句' },
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    orch().emit('final', { text: RAW, confidence: 1, language: 'zh', segment_idx: 0, is_segment: false, duration_ms: 1234 });
    await settleDetached();
    const frame = emitted.find((e) => e.event === 'stt:refined')?.payload as Record<string, unknown>;
    expect(Object.keys(frame).sort()).toEqual(['text']);
  });

  it('🔴 GA-14 on the normal stop path is eaten by dispose() — measured, and left alone', async () => {
    // The audio handler runs `finish().finally(() => s.dispose())`, so `disposed`
    // is true milliseconds after the terminal final while a batch re-transcription
    // takes seconds. This is a real defect AND it is currently the only thing
    // keeping the corruption path above shut for GA-14, so this card does not
    // touch it. Asserted so the fact is a measurement, not a paragraph.
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { bridge, eng, emitted } = makeBridge({
      refine: { cfg: refineCfg, transcribe: async () => { await gate; return '重转出来的整句'; } },
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = RAW;
    await bridge.finish();
    bridge.dispose();          // exactly what audio.handler does next
    release();                 // the batch engine answers, seconds later
    await settleDetached();
    expect(refinedTexts(emitted)).toEqual([]);
  });

  it('🔴 owner RT-4 — nothing on this path touches the inject leg', async () => {
    // 「once injected, this path has no say」. Structural, and asserted as a census of the events the
    // bridge produced rather than as a promise in a comment: an implementation
    // that reached the inject leg through history:* or timeline:* would pass a
    // startsWith('inject:') probe.
    const { bridge, eng, emitted } = makeBridge({ polishDelivery: 'detached', polish: polishWith([{ kind: 'done', full: POLISHED }]) });
    await tick();
    eng.finalOnFlush = RAW;
    await bridge.finish();
    await settleDetached();
    expect(emitted.filter((e) => e.event.startsWith('inject:'))).toEqual([]);
    expect([...new Set(emitted.map((e) => e.event))].sort()).toEqual(['stt:engine-status', 'stt:final']);
  });
});

// ── RT-1 — 「polish was ON and could not run」 is the ONE skip that still reaches
//    the user ──────────────────────────────────────────────────────────────────
describe('SttSessionBridge — RT-1 polishUnavailable', () => {
  it("polish requested but unarmable → stt:final says skipped(llm_error) — not silence", async () => {
    const { bridge, eng, emitted } = makeBridge({ polishUnavailable: 'llm_error' });
    await tick();
    eng.finalOnFlush = '你好世界';
    await bridge.finish();
    expect(finalPayload(emitted)).toMatchObject({ text: '你好世界', polish: 'skipped', polish_reason: 'llm_error' });
  });

  it('🔴 F-μ: the degraded final is NOT byte-identical to a polish-OFF final', async () => {
    // This is the assertion the RT ledger §6.1-b asked for, stated the way it asked
    // for it — as a DIFFERENCE between two payloads rather than as the presence of
    // a field. `polish_hint` promises four languages over that on failure the
    // unpolished text arrives 「with an explicit notice — never a silent fallback」.
    // RT-1a (426ccc0) made an unusable `llm.config` degrade to a bare final, and a
    // bare final is what 「polish was never on」 produces — so for one release that
    // promise had a hole in it and no surface anywhere could tell the two apart.
    // 🔴 The ledger's instruction was 「do not change that copy to match the behaviour — change the behaviour」,
    // and the behaviour was changed (polishWireForFinal, 6ac1d09). This pins it:
    // the copy is only true for as long as these two payloads differ.
    const off = await (async () => {
      const { bridge, eng, emitted } = makeBridge();
      await tick();
      eng.finalOnFlush = '你好世界';
      await bridge.finish();
      return finalPayload(emitted);
    })();
    const degraded = await (async () => {
      const { bridge, eng, emitted } = makeBridge({ polishUnavailable: 'llm_error' });
      await tick();
      eng.finalOnFlush = '你好世界';
      await bridge.finish();
      return finalPayload(emitted);
    })();

    // Same text — the recording is NOT refused, which is RT-1a's whole point.
    expect(degraded.text).toBe(off.text);
    // …and yet the two frames are distinguishable. Serialised, because 「a user-
    // visible difference」 means a difference that survives the wire, not one that
    // only exists in an object we happen to hold.
    expect(JSON.stringify(degraded)).not.toBe(JSON.stringify(off));
    expect(off.polish).toBeUndefined();
    expect(degraded).toMatchObject({ polish: 'skipped', polish_reason: 'llm_error' });
  });

  it('a SOFT-SEGMENT final never carries it (polish is an utterance-closing concern)', async () => {
    const { bridge, emitted, orch } = makeBridge({ polishUnavailable: 'llm_error' });
    await tick();
    orch().emit('final', { text: '软分段', confidence: 1, language: 'zh', segment_idx: 0, is_segment: true, duration_ms: 500 });
    expect(finalPayload(emitted).polish).toBeUndefined();
    bridge.dispose();
  });

  it('positive control: an ARMED session never reports unavailable (armed ≠ unarmable)', async () => {
    // Without this, `polishUnavailable` could be stamped unconditionally and the
    // assertions above would still pass. The armed session's own outcome is the
    // real polish verdict — here a guard reject, which is a DIFFERENT skip from
    // 「could not run at all」 and must not be confused with it.
    const { bridge, eng, emitted } = makeBridge({ polish: polishWith([{ kind: 'done', full: '我去' }]) });
    await tick();
    eng.finalOnFlush = '我不去';
    await bridge.finish();
    expect(finalPayload(emitted)).toMatchObject({ polish: 'skipped', polish_reason: 'guard_reject' });
  });

  it('positive control: an armed session that SUCCEEDS says applied, not skipped', async () => {
    const { bridge, eng, emitted } = makeBridge({ polish: polishWith([{ kind: 'done', full: '打开FlowMic' }]) });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    expect(finalPayload(emitted)).toMatchObject({ polish: 'applied' });
  });
});

// ── M4: the polish meter's BYOK flag is PROVENANCE, not key shape ────────────
//
// Card M4 (0.3.0). T7-b already fixed 「the STT key waiving the LLM tokens」 by making
// this site read the LLM config. M4 fixes the layer under it: the judgement asks
// 「who supplied it」, not 「is this key long」. A platform managed key is long, non-empty and
// not the 'EMPTY' sentinel — the old shape-only test called it BYOK, so the
// platform's own polish tokens were waived and no usage_records row was written.

describe('SttSessionBridge — M4 polish metering judges BYOK by provenance', () => {
  beforeEach(() => __resetPolishCacheForTest());

  const DONE_WITH_USAGE: LlmEvent[] = [{ kind: 'done', full: '打开FlowMic', usage: { tokens_in: 120, tokens_out: 30 } }];
  /** A key that is indistinguishable from a user's BY SHAPE. */
  const PLATFORM_KEY_CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1', api_key: 'sk-platform-account-key-0123456789', model: 'deepseek-chat' };

  // 🔴 CORRECTED 2026-08-11 (POLISH-1), and the original is worth keeping because
  // of what it shows. It read: 「RT-1: the meter now settles inside the DETACHED
  // task, i.e. after finish() returned and after settle() ran」, and the two
  // inline comments below said the session is gone before the meter fires.
  // MEASURED, on this tree: none of that is true of this harness. It passes no
  // `polishDelivery`, so it takes the accessor default — 'sync' — and the meter
  // fires inside finish(). Probe used (temporary, removed): `if (seen === null)
  // throw` immediately after `await bridge.finish()`; all 5 cases stayed GREEN,
  // i.e. the meter had already fired. `dispose()` + `settleDetached()` below are
  // therefore inert here, not the point of the case.
  // ⇒ What the block really pins is the BYOK judgement (owner's 「meter at polish completion
  // as usual」 by PROVENANCE), which is mode-independent because meterPolish is one
  // shared seam. It never covered detached metering, and it went on passing
  // unchanged through the entire window in which production ran detached — the
  // same drift between what a case SAYS it exercises and what it exercises that
  // let the delivery mode move unnoticed.
  async function runPolish(llm: SelectedLlmConfig): Promise<{ tIn: number; tOut: number; byok: boolean } | null> {
    let seen: { tIn: number; tOut: number; byok: boolean } | null = null;
    const { bridge, eng } = makeBridge({
      // 🔴 The STT routing is BYOK — the user's own microphone key. If the meter
      // ever reads THIS again (the T7-b bug) the assertions below flip.
      isByok: true,
      polish: { llm, deps: { streamerFor: fakeStreamerFor(DONE_WITH_USAGE) } },
      onPolishUsage: (tIn, tOut, byok) => { seen = { tIn, tOut, byok }; },
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    bridge.dispose();          // inert here (see the correction above), and kept:
    await settleDetached();    // it costs nothing and covers a detached harness.
    return seen;
  }

  it("a managed-default platform key is METERED however long it is (byok=false)", async () => {
    const seen = await runPolish({ cfg: PLATFORM_KEY_CFG, source: 'managed-default' });
    expect(seen).toEqual({ tIn: 120, tOut: 30, byok: false });
  });

  it('positive control: the SAME key shape supplied by the USER is waived (byok=true)', async () => {
    // Without this the assertion above could be satisfied by a hardcoded `false`,
    // which would bill every BYOK user for tokens they paid their own provider for.
    const seen = await runPolish({ cfg: PLATFORM_KEY_CFG, source: 'user' });
    expect(seen).toEqual({ tIn: 120, tOut: 30, byok: true });
  });

  it("the 'EMPTY' platform-endpoint sentinel on a user row is still metered", async () => {
    const seen = await runPolish({ cfg: CFG, source: 'user' }); // CFG.api_key === 'EMPTY'
    expect(seen).toEqual({ tIn: 120, tOut: 30, byok: false });
  });

  it('a `done` with NO provider usage records NOTHING (absent ≠ a free run)', async () => {
    let calls = 0;
    let ran = false;
    const noUsage = (_p: LlmProtocol): LlmStreamer =>
      async function* (): AsyncGenerator<LlmEvent> { ran = true; yield { kind: 'done', full: '打开FlowMic' }; };
    const { bridge, eng } = makeBridge({
      polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: noUsage } },
      onPolishUsage: () => { calls += 1; },
    });
    await tick();
    eng.finalOnFlush = '打开飞麦克';
    await bridge.finish();
    await settleDetached();
    // Positive control: polish really ran (so `calls === 0` is not a blind probe).
    expect(ran).toBe(true);
    expect(calls).toBe(0);
  });

  it('a GUARD-REJECTED answer is still metered — the tokens were spent before the verdict', async () => {
    let seen: { tOut: number; byok: boolean } | null = null;
    const { bridge, eng, emitted } = makeBridge({
      polish: {
        llm: { cfg: PLATFORM_KEY_CFG, source: 'managed-default' },
        deps: { streamerFor: fakeStreamerFor([{ kind: 'done', full: '我去', usage: { tokens_in: 120, tokens_out: 30 } }]) },
      },
      onPolishUsage: (_tIn, tOut, byok) => { seen = { tOut, byok }; },
    });
    await tick();
    eng.finalOnFlush = '我不去';
    await bridge.finish();
    await settleDetached();
    // No frame is sent (the guard rejected) — and the meter still moved.
    expect(finalPayload(emitted)).toMatchObject({ text: '我不去' });
    expect(refinedTexts(emitted)).toEqual([]);
    expect(seen).toEqual({ tOut: 30, byok: false });
  });
});

// ── RT-1 D-4: the DETACHED task must be structurally incapable of killing the
//    relay ───────────────────────────────────────────────────────────────────
//
// 🔴 This is W1.5's production incident in a new costume. `installProcessGuards`
// (src/error-handling.ts) hangs `unhandledRejection` off onFatal → graceful close
// → exit(FATAL_EXIT_CODE): ONE escaped rejection takes the relay down for every
// online user, and systemd restarts it into the same wall.
//
// Before RT-1 the polish meter ran inside a frame `finish()` awaited, so a
// throwing sqlite write surfaced through the audio handler's `.catch`. Detached,
// it lands after settle() and inside no caller's frame at all. Two separate
// guards, and each is asserted to be LOAD-BEARING rather than decorative:
//   · the outer `.catch` on the detached promise  — stops process death;
//   · the inner try/catch around onPolishUsage    — keeps the money loss named.
//
// ⚠️ The cases here select `polishDelivery: 'detached'`, because that is the mode
// whose lifecycle creates this exposure. The guard itself is shared with the
// shipped sync path (one meterPolish seam, not two), and its sync half is pinned
// by the R11 case in the WP-R4-6 block above.
describe("SttSessionBridge — RT-1 D-4: the 'detached' task cannot take the process down", () => {
  beforeEach(() => __resetPolishCacheForTest());

  /** Count real `unhandledRejection` events for the duration of one run. */
  async function withRejectionWatch<T>(fn: () => Promise<T>): Promise<{ result: T; rejections: unknown[] }> {
    const rejections: unknown[] = [];
    const onRej = (reason: unknown): void => { rejections.push(reason); };
    // vitest installs its own handler; adding ours does not remove theirs, and we
    // only ever read our own array.
    process.on('unhandledRejection', onRej);
    try {
      const result = await fn();
      // Node emits unhandledRejection on the tick AFTER the microtask queue
      // drains, so a macrotask wait is required — a flush would see nothing.
      await settleDetached(60);
      return { result, rejections };
    } finally {
      process.off('unhandledRejection', onRej);
    }
  }

  it('🔴 a meter that throws produces NO unhandled rejection, and names the loss in the log', async () => {
    // 🔴 The inner try/catch around onPolishUsage is asserted on the FORENSIC LINE,
    // because that is the only thing it now changes. Without it the throw still
    // reaches the outer `.catch` — so the process survives either way — but the
    // log would read 「stt.polish detached pass failed unexpectedly」, which does
    // not say that MONEY WAS NOT RECORDED and does not name the user. no silent failure
    // is not satisfied by recording that something failed, only by recording
    // enough to act on it.
    // ⚠️ open account: while the delivery is withheld this guard has no user-visible half.
    // It will regain one the day the carrier lands (a throwing meter must not also
    // cost the user the correction the model already produced).
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      written.push(String(chunk));
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      const { rejections } = await withRejectionWatch(async () => {
        const { bridge, eng } = makeBridge({
          polishDelivery: 'detached',
          polish: {
            llm: { cfg: CFG, source: 'managed-default' },
            deps: { streamerFor: fakeStreamerFor([{ kind: 'done', full: '打开FlowMic', usage: { tokens_in: 1, tokens_out: 1 } }]) },
          },
          onPolishUsage: () => { throw new Error('SQLITE_BUSY: database is locked'); },
        });
        await tick();
        eng.finalOnFlush = '打开飞麦克';
        await bridge.finish();
        bridge.dispose();
        await settleDetached();
        return null;
      });
      expect(rejections).toEqual([]);
      const loss = written.filter((l) => l.includes('llm usage NOT recorded'));
      expect(loss).toHaveLength(1);
      expect(loss[0]).toContain('SQLITE_BUSY');
      expect(loss[0]).toContain('"user_id":"u"');
      // …and NOT the generic line, which would mean the guard was bypassed.
      expect(written.filter((l) => l.includes('detached pass failed unexpectedly'))).toEqual([]);
    } finally {
      process.stderr.write = realWrite;
    }
  });

  it('positive control: this harness really does observe an unhandled rejection', async () => {
    // 🔴 Without this, a watcher that never fires would make the assertion above
    // pass by measuring nothing — the failure mode every negative assertion has.
    const { rejections } = await withRejectionWatch(async () => {
      void Promise.reject(new Error('REVERSE-CONTROL-PROBE'));
      return null;
    });
    expect(rejections).toHaveLength(1);
    expect((rejections[0] as Error).message).toBe('REVERSE-CONTROL-PROBE');
  });

  it('a streamer that THROWS (rather than yielding an error event) is contained too', async () => {
    const exploding = (_p: LlmProtocol): LlmStreamer =>
      // eslint-disable-next-line require-yield
      async function* (): AsyncGenerator<LlmEvent> { throw new Error('transport blew up'); };
    const { result: emitted, rejections } = await withRejectionWatch(async () => {
      const { bridge, eng, emitted: cap } = makeBridge({
        polishDelivery: 'detached',
        polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: exploding } },
      });
      await tick();
      eng.finalOnFlush = '你好世界';
      await bridge.finish();
      bridge.dispose();
      await settleDetached();
      return cap;
    });
    expect(rejections).toEqual([]);
    expect(finalPayload(emitted)).toMatchObject({ text: '你好世界' });
    expect(refinedTexts(emitted)).toEqual([]);
  });

  it('🔴 a throwing EMITTER on the detached polish path is contained (this is what reaches the outer .catch)', async () => {
    // The realistic escape route. polishFinalText is contracted never to throw and
    // the meter has its own guard, so the throw that actually reaches the detached
    // promise is the socket write in deliverRefinement — or the log line beside it.
    const { rejections } = await withRejectionWatch(async () => {
      const eng = new FakeEngine();
      const bridge = new SttSessionBridge({
        build: (session: AudioSession) => ({
          orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
          isByok: false, gated: false,
        }),
        emitter: { emit: (event) => { if (event === 'stt:refined') throw new Error('socket write failed'); } },
        userId: 'u', mode: 'realtime', sourceLang: 'zh',
        onComplete: () => {},
        polishDelivery: 'detached',
        polish: { llm: { cfg: CFG, source: 'user' }, deps: { streamerFor: fakeStreamerFor([{ kind: 'done', full: '打开FlowMic' }]) } },
        levelIntervalMs: 0,
      });
      await tick();
      eng.finalOnFlush = '打开飞麦克';
      await bridge.finish();
      bridge.dispose();
      await settleDetached();
      return null;
    });
    expect(rejections).toEqual([]);
  });

  it('🔴 GA-14 refine: a throwing emitter in the .then handler is contained (the missing .catch)', async () => {
    // `void runRefine({...}).then(...)` shipped with NO `.catch`. runRefine
    // swallows the TRANSCRIBER's failures, but the handler emits on a socket and
    // writes a log — either can throw. Dormant only because stt.refine defaults
    // OFF, which is not the same as impossible.
    const { rejections } = await withRejectionWatch(async () => {
      const eng = new FakeEngine();
      const bridge = new SttSessionBridge({
        build: (session: AudioSession) => ({
          orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
          isByok: false, gated: false,
        }),
        emitter: { emit: (event) => { if (event === 'stt:refined') throw new Error('socket write failed'); } },
        userId: 'u', mode: 'realtime', sourceLang: 'zh',
        onComplete: () => {},
        refine: { cfg: { enabled: true, min_utterance_ms: 1 }, transcribe: async () => '重转版本' },
        levelIntervalMs: 0,
      });
      await tick();
      bridge.pushChunk(0, b64(sine(300)), 0);
      eng.finalOnFlush = '第一遍';
      await bridge.finish();
      bridge.dispose();
      await settleDetached();
      return null;
    });
    expect(rejections).toEqual([]);
  });
});

// ── W1.5-P1a: an unclean ending is still a bill ──────────────────────────────
//
// settle() used to hang off finish() / onAutoStopped() — the two CLEAN endings.
// Every ending that tears the session down instead billed NOTHING, although the
// audio had already been streamed to the vendor and already been paid for:
// grace-window expiry after the phone drops, a new audio:start superseding the
// previous utterance, an unpaired socket disconnecting.
//
// 🔴 The production chain has TWO links and each is pinned in a DIFFERENT file.
// Neither test alone proves that a dropped phone gets billed, which is exactly
// why this comment names the other one:
//   · grace expiry → orchestrator.dispose()
//       audio-grace.test.ts 「grace expiry disposes the session AND only THEN
//       tells the PC pc:mobile-left」
//   · orchestrator.dispose() → the recordSttUsage seam
//       HERE
//
// The meter's own guards (standalone / BYOK / duration <= 0 all write nothing)
// are pinned in managed-default-billing.test.ts — 🔴 an earlier version of this
// comment said that when only ONE of the three (BYOK) was actually pinned. The
// other two were added when the adversarial review caught it, because this
// sentence is load-bearing twice over: it is the stated reason dispose() does
// not carry its own copy of the guard, AND the reason the 0 ms case below is
// allowed to fire the seam at all. An unanchored claim propping up two
// decisions is exactly anti-façade ④.
describe('SttSessionBridge — W1.5-P1a: a session that ends by dispose() is still metered', () => {
  function makeCountingBridge(over: { isByok?: boolean; gated?: boolean } = {}): {
    bridge: SttSessionBridge; eng: FakeEngine; calls: { d: number; byok: boolean }[];
  } {
    const eng = new FakeEngine();
    const calls: { d: number; byok: boolean }[] = [];
    const bridge = new SttSessionBridge({
      build: (session: AudioSession, _lang: string, _uid: string, _vad?: VadGate) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
        isByok: over.isByok ?? false,
        gated: over.gated ?? false,
      }),
      emitter: { emit: () => {} },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: (d, byok) => { calls.push({ d, byok }); },
      levelIntervalMs: 0,
    });
    return { bridge, eng, calls };
  }

  it('the phone dropped and never came back: dispose() alone bills the audio already consumed', async () => {
    const { bridge, calls } = makeCountingBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(800)), 0);
    // Deliberately NO finish() — this is the shape of grace expiry and of a
    // superseding audio:start, the two ways an utterance ends without a stop.
    bridge.dispose();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.d).toBeGreaterThan(0);
  });

  it('a dropped MANAGED STREAMING session bills the gated ms — same rule as a clean stop', async () => {
    const { bridge, calls } = makeCountingBridge({ gated: true });
    await tick();
    // 500ms speech + 2000ms silence, then the phone vanishes.
    bridge.pushChunk(0, b64(Buffer.concat([sine(500), Buffer.alloc(SR * 2 * 2)])), 0);
    bridge.dispose();
    expect(calls).toHaveLength(1);
    // 🔴 ASSERT THE MEASUREMENT, NOT A COINCIDENCE. This used to read
    // `toBeLessThan(2500)`, and 2500 is EXACTLY the raw ms of the buffer above
    // (80,000 B / 32 B per ms) — so a regression that billed raw instead of
    // gated failed by one millisecond, via an arithmetic accident stated
    // nowhere. Change either buffer length and the discrimination silently
    // evaporates. 780 = 500 ms voiced + the gate's 280 ms hangover, measured.
    expect(calls[0]!.d).toBe(780);
  });

  it('does not double-bill: finish() then dispose() is exactly ONE call', async () => {
    const { bridge, eng, calls } = makeCountingBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(500)), 0);
    eng.finalOnFlush = 'done';
    await bridge.finish();
    bridge.dispose(); // the audio handler's .finally(dispose) on the normal path
    bridge.dispose(); // and a second tear-down, because idempotence is the claim
    expect(calls).toHaveLength(1);
  });

  it('the drop path reports the BYOK flag rather than deciding to waive it itself', async () => {
    const { bridge, calls } = makeCountingBridge({ isByok: true });
    await tick();
    bridge.pushChunk(0, b64(sine(400)), 0);
    bridge.dispose();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.byok).toBe(true); // waived downstream, at the meter, not here
  });

  it('a session that never carried audio reports 0 ms (the meter is what drops it)', async () => {
    const { bridge, calls } = makeCountingBridge();
    await tick();
    bridge.dispose();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.d).toBe(0);
  });

  // 🔴 P0 REGRESSION (adversarial review, W1.5). The meter reaches a SYNCHRONOUS
  // node:sqlite write behind a foreign key with foreign_keys=ON, so it can throw
  // on a deleted account, SQLITE_BUSY or disk I/O. Three of the six paths into
  // dispose() come from a bare setTimeout or the shutdown loop, where an
  // uncaught throw is FATAL (error-handling.ts onFatal exits the process).
  // Before this test existed, one unbillable session in grace could take the
  // whole relay down and strand the vendor socket with it.
  it('🔴 a THROWING meter cannot abort teardown, escape, or strand the engine', async () => {
    const eng = new FakeEngine();
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
        isByok: false,
        gated: false,
      }),
      emitter: { emit: () => {} },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      levelIntervalMs: 0,
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);

    // ① it does not escape — the caller is a timer callback, so a throw here is
    //    process death, not a failed billing.
    expect(() => bridge.dispose()).not.toThrow();
    // ② teardown still completed: the engine was closed rather than leaked.
    //    This is why settle() runs LAST and not first.
    await tick();
    expect(eng.state).toBe('closed');
  });
});

// ── W1.5: the OTHER half of the chain, for the two paths I first missed ──────
//
// The bridge tests above prove 「dispose() bills」. They cannot prove 「a user who
// backs out of the instance list gets billed」, because the registry is not in
// their loop. audio-grace.test.ts pins the grace-EXPIRY edge; these two pin the
// edges my first enumeration left out, both of which the adversarial review
// found. expireGraceNow() is the most frequent non-stop ending in the product
// (a deliberate leave), and stopAll() fires on every SIGTERM.
describe('AudioSessionRegistry — the dispose edges the first enumeration missed', () => {
  const socketOf = (id: string): Socket => ({ id }) as unknown as Socket;
  function seatOne(reg: AudioSessionRegistry, key: string): { disposed: number } {
    const spy = { disposed: 0 };
    const entry = reg.put({ key, roomUuid: 'r', pairingId: 'p', socket: socketOf('s1'), fannedOut: false });
    entry.orchestrator = { pushChunk() {}, finish: async () => {}, dispose() { spy.disposed += 1; } };
    return spy;
  }

  it('expireGraceNow (the user backed out of the instance list) disposes the session', () => {
    const reg = new AudioSessionRegistry();
    const spy = seatOne(reg, 'k1');
    reg.beginGrace('k1', undefined, 's1');
    expect(spy.disposed).toBe(0);          // still armed — nothing torn down yet
    expect(reg.expireGraceNow('k1')).toBe(true);
    expect(spy.disposed).toBe(1);          // ⇒ reaches settle() via the bridge
  });

  it('stopAll (SIGTERM / fatal shutdown) disposes every live session', () => {
    const reg = new AudioSessionRegistry();
    const a = seatOne(reg, 'k1');
    const b = seatOne(reg, 'k2');
    reg.stopAll();
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);
    expect(reg.size()).toBe(0);
  });
});

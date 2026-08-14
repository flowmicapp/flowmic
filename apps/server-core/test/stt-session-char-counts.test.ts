// A2-5 / REQ-12-08 — the two character counts the metering seam now carries.
//
// SPEC-REF: src/engine/stt-session-deps.ts `SttCharCounts` (why the seam grew a
//             third argument instead of the table growing two zero columns)
//           src/engine/stt-session.ts `emitFinal` / `settle`
//           docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md
//           CLAUDE.md red line: R11 (does the layer making the judgement have the fact it needs)
//
// 🔴 WHY THESE ARE BRIDGE TESTS AND NOT METER TESTS. The meter cannot be wrong
// about these numbers — it receives two of them and writes them down. The only
// layer that can be wrong is this one, because it is the only one that ever sees
// text. So the acceptance for 「must not be a forever-0 column」 lives here, and
// test/usage-events.test.ts asserts the OTHER half: that the numbers survive the
// handler and reach the row.
//
// ⚠️ A FILE OF ITS OWN because test/stt-session-bridge.test.ts hit the 1200-line
// test cap (verify/lint/file-size.mjs) the moment this block was added — 1262.
// The block moved VERBATIM; what is duplicated below is the harness (a fake
// engine, a sine generator, a polish streamer), and duplicating a harness is the
// cheaper of the two available mistakes. The other one is a shared helper that
// grows options until neither file's setup is readable.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { LlmConfigSource, SelectedLlmConfig } from '../src/compose/llm-config';
import type { PolishDeps } from '../src/stt/stt-polish';

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
function fakeStreamerFor(events: LlmEvent[]): (protocol: LlmProtocol) => LlmStreamer {
  return (_protocol) => async function* (): AsyncGenerator<LlmEvent> { for (const e of events) yield e; };
}
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
/** Let a detached task and its awaits settle. Deliberately a real macrotask. */
const settleDetached = async (ms = 30): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); };

describe('SttSessionBridge — A2-5: transcript chars vs delivered chars', () => {
  // 🔴 MEASURED WHILE WRITING THIS BLOCK, and it cost a wrong conclusion: two
  // tests here polish the SAME input string, and `stt-polish.ts` caches by that
  // string — so the second one got the FIRST one's answer instantly, the held
  // streamer was never entered, and the 「torn down mid-polish」 case reported a
  // delivered count of 9 for a session that was supposed to have sent nothing.
  // The bug was in the harness, not in the counter; without this reset the test
  // would have been 「fixed」 by loosening the assertion it was right about.
  beforeEach(() => { __resetPolishCacheForTest(); });

  interface Settled { d: number; byok: boolean; transcript: number; delivered: number }
  function makeCharBridge(over: { polish?: { llm: SelectedLlmConfig; deps?: PolishDeps } } = {}): {
    bridge: SttSessionBridge; eng: FakeEngine; settled: () => Settled | null;
  } {
    const eng = new FakeEngine();
    let settled: Settled | null = null;
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => ({
        orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }),
        isByok: false,
        gated: false,
      }),
      emitter: { emit: () => {} },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: (d, byok, chars) => { settled = { d, byok, transcript: chars.transcript, delivered: chars.delivered }; },
      ...(over.polish ? { polish: over.polish } : {}),
      levelIntervalMs: 0,
    });
    return { bridge, eng, settled: () => settled };
  }

  it('a plain utterance reports the same non-zero count on both — what was transcribed WAS delivered', async () => {
    const { bridge, eng, settled } = makeCharBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = '大家好啊'; // 4
    await bridge.finish();
    // 🔴 The floor assertion is 「not zero」, and it is the one that fails if the
    // seam is wired but nothing ever counts — the exact 「forever-0 column」 shape.
    expect(settled()?.transcript).toBe(4);
    expect(settled()?.delivered).toBe(4);
  });

  it('🔴 polish REWRITES the text ⇒ the two numbers diverge, and each is the truth about its own question', async () => {
    // This is why one `chars` column could not have done the job. The engine
    // produced one string, the user received a different one, and a bill dispute
    // is about the second while a 「how many characters did the engine produce」 question is about the first.
    // The SAME pair this file's 「an armed session that SUCCEEDS」 control uses,
    // deliberately: a rewrite the output guard ACCEPTS. (A drastic rewrite is
    // rejected as `guard_reject` and the pure text ships, which would make the
    // two counts equal again and prove nothing.)
    const { bridge, eng, settled } = makeCharBridge({
      polish: polishWith([{ kind: 'done', full: '打开FlowMic' }]),
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = '打开飞麦克'; // 5 transcribed…
    await bridge.finish();
    expect(settled()?.transcript).toBe(5);
    expect(settled()?.delivered).toBe(9); // …9 delivered, after polish
  });

  it('🔴 torn down mid-polish: transcribed > 0 and delivered = 0 — a gap the pair can EXPRESS', async () => {
    // The state a single counter would have to lie about. The final was computed
    // (and the audio was billed), the emit never happened because the session was
    // gone. Counting `deliveredChars` inside the emit is what makes this honest;
    // counting it beside the two call sites is how it would silently report 4.
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    const { bridge, eng, settled } = makeCharBridge({
      polish: {
        llm: { cfg: CFG, source: 'user' },
        deps: {
          streamerFor: () => async function* (): AsyncGenerator<LlmEvent> {
            await held;
            yield { kind: 'done', full: '打开FlowMic' };
          },
        },
      },
    });
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.finalOnFlush = '打开飞麦克';
    const finishing = bridge.finish();
    await tick();
    bridge.dispose(); // grace expiry / supersede, while the polish is in flight
    release!();
    await finishing.catch(() => undefined);
    await settleDetached();
    expect(settled()?.transcript).toBe(5);
    expect(settled()?.delivered).toBe(0);
  });

  it('a soft-segment final counts too — 「how many characters this turn」 is about the utterance, not its last frame', async () => {
    const { bridge, eng, settled } = makeCharBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    // One segment final, then the terminal one on flush.
    eng.emit('final', { kind: 'final', text: '前半段', confidence: 1, language: 'zh', duration_ms: 500, is_segment: true });
    eng.finalOnFlush = '后半段';
    await bridge.finish();
    expect(settled()?.transcript).toBe(6);
    expect(settled()?.delivered).toBe(6);
  });

  it('interims are NOT counted — they are drafts of the same words', async () => {
    // Counting them would report a number several times larger than anything the
    // user said, on the surface whose whole job is to explain a bill.
    const { bridge, eng, settled } = makeCharBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(300)), 0);
    eng.emitInterim('大');
    eng.emitInterim('大家');
    eng.emitInterim('大家好');
    eng.finalOnFlush = '大家好啊';
    await bridge.finish();
    expect(settled()?.transcript).toBe(4);
  });
});


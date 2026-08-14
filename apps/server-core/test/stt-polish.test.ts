// WP-R4-6 — the opt-in LLM polish layer (engine face). This file carries the
// legacy F-3073 adversarial guard vectors + polishFinalText budget/cache/fallback
// vectors VERBATIM (ported from legacy stt-polish.test.ts), PLUS the two new-line
// contract points:
//   • the honest WIRE MAPPING (lead clarification 2026-07-24): a REASON ⇒
//     skipped + normalized 4-value reason; NO reason (incl. cache hit / LLM echo
//     identical to input) ⇒ applied, regardless of the legacy `applied` diff bit;
//   • the 4 normalized skip reasons (timeout / llm_error / empty_output /
//     guard_reject) driven through a fake streamer.
// Assertions reference only the spec-exposed contract: checkMeaningPreserved's
// accept/reject verdict, polishFinalText's {text, applied, reason, skipReason}
// shape, and polishWireSignal's {polish, polish_reason?} shape.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig, LlmProtocol } from '@flowmic/protocol';
import {
  checkMeaningPreserved,
  polishFinalText,
  polishWireSignal,
  polishBudgetMs,
  POLISH_BUDGET_MS,
  POLISH_BUDGET_MAX_MS,
  __resetPolishCacheForTest,
} from '../src/stt/stt-polish';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';

const CFG: LlmConfig = {
  protocol: 'openai-compatible',
  endpoint: 'http://test.invalid/v1',
  api_key: 'EMPTY',
  model: 'test-model',
};

beforeEach(() => __resetPolishCacheForTest());

// ─── ported §3.3 adversarial matrix — MUST-REJECT ─────────────────────
describe('checkMeaningPreserved — MUST-REJECT (ported F-3073 vectors)', () => {
  it('T-R1 negation removed (我不去 -> 我去) rejects', () => {
    expect(checkMeaningPreserved('我不去', '我去').ok).toBe(false);
  });
  it('T-R2 negation added (我去 -> 我不去) rejects', () => {
    expect(checkMeaningPreserved('我去', '我不去').ok).toBe(false);
  });
  it('T-R3 quantifier flip (大家都同意 -> 大家只同意) rejects', () => {
    expect(checkMeaningPreserved('大家都同意', '大家只同意').ok).toBe(false);
  });
  it('T-R4 modal flip (你可以走 -> 你必须走) rejects', () => {
    expect(checkMeaningPreserved('你可以走', '你必须走').ok).toBe(false);
  });
  it('T-R5 quantifier flip (all -> some) rejects', () => {
    expect(checkMeaningPreserved('all users passed', 'some users passed').ok).toBe(false);
  });
  it('T-R6 negation removed (it is not good -> it is good) rejects', () => {
    expect(checkMeaningPreserved('it is not good', 'it is good').ok).toBe(false);
  });
  it('T-R7 numeral change (他有三个 -> 他有五个) rejects', () => {
    expect(checkMeaningPreserved('他有三个', '他有五个').ok).toBe(false);
  });
  it('open-class multiset delta (他很高兴 -> 她真开心) rejects (single diff hunk, GAP-2)', () => {
    expect(checkMeaningPreserved('他很高兴', '她真开心').ok).toBe(false);
  });
  it('a wholesale unrelated rewrite is rejected by the cardinality bound', () => {
    expect(checkMeaningPreserved('今天天气很好我们去公园散步吧', '关于季度营收的会议纪要如下所示内容').ok).toBe(false);
  });
});

// ─── ported §3.3 adversarial matrix — MUST-ACCEPT ─────────────────────
describe('checkMeaningPreserved — MUST-ACCEPT (ported F-3073 vectors)', () => {
  it('T-A1 open-class homophone fix (打开飞麦克 -> 打开FlowMic) accepts', () => {
    const r = checkMeaningPreserved('打开飞麦克', '打开FlowMic');
    expect(r.ok, r.reason).toBe(true);
  });
  it('T-A2 punctuation-only (你好世界 -> 你好，世界。) accepts', () => {
    const r = checkMeaningPreserved('你好世界', '你好，世界。');
    expect(r.ok, r.reason).toBe(true);
  });
  it('T-A3 identical input/output is idempotent-accept', () => {
    const r = checkMeaningPreserved('这是一个测试', '这是一个测试');
    expect(r.ok, r.reason).toBe(true);
  });
});

// ─── fake streamer helper (yields fixed LLM events) ───────────────────
function fakeStreamerFor(events: LlmEvent[]): (protocol: LlmProtocol) => LlmStreamer {
  return (_protocol) => async function* (): AsyncGenerator<LlmEvent> {
    for (const e of events) yield e;
  };
}

// ─── ported polishFinalText — budget / cache / fallback (fetch-injected) ─
function fakeFetchOnce(body: string): typeof fetch {
  return (async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )) as unknown as typeof fetch;
}
function fakeFetchHttpError(status: number): typeof fetch {
  return (async () => new Response('err', { status })) as unknown as typeof fetch;
}
function fakeFetchHang(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;
}

describe('polishFinalText — ported budget / cache / fallback vectors', () => {
  it('applies a guard-accepted correction (applied=true)', async () => {
    const r = await polishFinalText('打开飞麦克', CFG, { fetch: fakeFetchOnce('打开FlowMic') });
    expect(r.applied).toBe(true);
    expect(r.text).toBe('打开FlowMic');
  });

  it('falls back to raw text on guard rejection (closed-class drift)', async () => {
    const r = await polishFinalText('我不去', CFG, { fetch: fakeFetchOnce('我去') });
    expect(r.applied).toBe(false);
    expect(r.text).toBe('我不去');
    expect(typeof r.reason).toBe('string');
    expect((r.reason as string).length).toBeGreaterThan(0);
  });

  it('rejects an output that drifts a protected dictionary term (lead ruling: polish never undoes the deterministic leg)', async () => {
    // live-chain evidence shape: dict leg produced `formatFlowMic`; the live vLLM "fixed" it
    // to `FormatFlow Mic` — small enough for the ported guard's calibration, but
    // it undoes the user's explicit canonical term ⇒ guard_reject.
    const r = await polishFinalText(
      '欢迎使用formatFlowMic语音输入。',
      CFG,
      { fetch: fakeFetchOnce('欢迎使用 FormatFlow Mic 语音输入。'), protectedTerms: ['FlowMic'] },
    );
    expect(r.applied).toBe(false);
    expect(r.text).toBe('欢迎使用formatFlowMic语音输入。');
    expect(r.reason).toBe('dict-term-drift:FlowMic');
    expect(r.skipReason).toBe('guard_reject');
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
  });

  it('drift is count-based both ways — an INVENTED protected-term occurrence also rejects', async () => {
    // Input has 1 `FlowMic`, output has 2 (the LLM "canonicalized" an extra spot
    // on its own): occurrence-count drift ⇒ reject. Only the deterministic leg
    // may introduce canonical terms.
    const r = await polishFinalText(
      '打开飞麦克然后用FlowMic',
      CFG,
      { fetch: fakeFetchOnce('打开FlowMic然后用FlowMic'), protectedTerms: ['FlowMic'] },
    );
    expect(r.skipReason).toBe('guard_reject');
    expect(r.reason).toBe('dict-term-drift:FlowMic');
  });

  it('accepts an output that keeps every protected term intact (punctuation-only fix)', async () => {
    const ok = await polishFinalText(
      '你好FlowMic世界',
      CFG,
      { fetch: fakeFetchOnce('你好，FlowMic世界。'), protectedTerms: ['FlowMic'] },
    );
    expect(ok.applied).toBe(true);
    expect(ok.text).toBe('你好，FlowMic世界。');
    expect(polishWireSignal(ok)).toEqual({ polish: 'applied' });
  });

  it('a cache hit is re-checked against THIS session\'s protected terms (cache key excludes them)', async () => {
    // Session 1 (no dictionary): output accepted and cached.
    const first = await polishFinalText('打开飞麦克', CFG, { fetch: fakeFetchOnce('打开FlowMic') });
    expect(first.applied).toBe(true);
    // Session 2 (dict protects 飞麦克 → its removal must reject) hits the cache:
    // the cached output drifts the protected term ⇒ honest guard_reject, pure
    // text delivered, no silent reuse.
    const second = await polishFinalText('打开飞麦克', CFG, { fetch: fakeFetchOnce('打开FlowMic'), protectedTerms: ['飞麦克'] });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('dict-term-drift:飞麦克');
    expect(second.skipReason).toBe('guard_reject');
    expect(second.text).toBe('打开飞麦克');
  });

  it('falls back to raw text on LLM HTTP error', async () => {
    const r = await polishFinalText('你好世界', CFG, { fetch: fakeFetchHttpError(500) });
    expect(r.applied).toBe(false);
    expect(r.text).toBe('你好世界');
    expect(r.reason).toBeTruthy();
  });

  it('falls back to raw text on budget timeout (worst case == today)', async () => {
    const r = await polishFinalText('你好世界', CFG, { fetch: fakeFetchHang(), budgetMs: 20 });
    expect(r.applied).toBe(false);
    expect(r.text).toBe('你好世界');
  });

  it('is idempotent via the content-hash cache (no second fetch call)', async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return fakeFetchOnce('打开FlowMic')(...args);
    }) as unknown as typeof fetch;
    const first = await polishFinalText('打开飞麦克', CFG, { fetch: countingFetch });
    const second = await polishFinalText('打开飞麦克', CFG, { fetch: countingFetch });
    expect(first.text).toBe(second.text);
    expect(calls).toBe(1);
  });

  it('skips empty input without calling the LLM', async () => {
    const r = await polishFinalText('   ', CFG, { fetch: fakeFetchHang() });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('empty-input');
  });
});

// ─── NEW: the honest wire mapping (lead clarification) ──────────────────
describe('polishWireSignal — reason presence drives applied vs skipped', () => {
  it('NO reason ⇒ applied (even when the legacy applied bit is false: LLM echoed input)', () => {
    // The success path returns applied=false when cleaned===input, but polish DID
    // run and succeed → the wire must read 'applied' (no "skipped" badge).
    expect(polishWireSignal({ text: 'x', applied: false })).toEqual({ polish: 'applied' });
    expect(polishWireSignal({ text: 'y', applied: true })).toEqual({ polish: 'applied' });
  });
  it('a reason ⇒ skipped + the normalized 4-value reason', () => {
    expect(polishWireSignal({ text: 'x', applied: false, reason: 'closed-class-drift:不', skipReason: 'guard_reject' }))
      .toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
    expect(polishWireSignal({ text: 'x', applied: false, reason: 'empty-input', skipReason: 'empty_output' }))
      .toEqual({ polish: 'skipped', polish_reason: 'empty_output' });
  });
});

describe('polishFinalText — wire-reason normalization via a fake streamer', () => {
  it("LLM echoes input identical ⇒ applied (no reason, applied bit false)", async () => {
    const r = await polishFinalText('大家好。', CFG, { streamerFor: fakeStreamerFor([{ kind: 'done', full: '大家好。' }]) });
    expect(r.reason).toBeUndefined();
    expect(r.applied).toBe(false);
    expect(polishWireSignal(r)).toEqual({ polish: 'applied' });
  });

  it("guard-accepted change ⇒ applied", async () => {
    const r = await polishFinalText('打开飞麦克', CFG, { streamerFor: fakeStreamerFor([{ kind: 'done', full: '打开FlowMic' }]) });
    expect(polishWireSignal(r)).toEqual({ polish: 'applied' });
    expect(r.text).toBe('打开FlowMic');
  });

  it("LLM_TIMEOUT error ⇒ skipped('timeout')", async () => {
    const r = await polishFinalText('你好世界', CFG, { streamerFor: fakeStreamerFor([{ kind: 'error', code: 'LLM_TIMEOUT', message: 'x' }]) });
    expect(r.skipReason).toBe('timeout');
    expect(r.text).toBe('你好世界');
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'timeout' });
  });

  it("a non-timeout transport error ⇒ skipped('llm_error')", async () => {
    const r = await polishFinalText('你好世界', CFG, { streamerFor: fakeStreamerFor([{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'x' }]) });
    expect(r.skipReason).toBe('llm_error');
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'llm_error' });
  });

  it("empty LLM output ⇒ skipped('empty_output')", async () => {
    const r = await polishFinalText('你好世界', CFG, { streamerFor: fakeStreamerFor([{ kind: 'done', full: '   ' }]) });
    expect(r.skipReason).toBe('empty_output');
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'empty_output' });
  });

  it("a guard rejection ⇒ skipped('guard_reject') and delivers the raw text", async () => {
    const r = await polishFinalText('我不去', CFG, { streamerFor: fakeStreamerFor([{ kind: 'done', full: '我去' }]) });
    expect(r.skipReason).toBe('guard_reject');
    expect(r.text).toBe('我不去');
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
  });
});

// ─── the latency budget scales with the job ──────────────────────────────
//
// Why these exist: the budget was a FLAT 800 ms, and everything stayed green —
// every test above passes a `budgetMs` explicitly or uses a streamer that
// answers instantly, so not one of them could see that real long dictations
// could never fit. The evidence came from owner's server.log, not from CI
// (4–12 s of audio polished; 24–61 s always LLM_TIMEOUT). These assertions are
// what turn that into something the suite can defend.
describe('polish latency budget scales with input length', () => {
  it('short input keeps the 06 §5 floor exactly', () => {
    expect(polishBudgetMs(1)).toBeGreaterThanOrEqual(POLISH_BUDGET_MS);
    // Degenerate input must degrade to the floor, never to 0 or NaN.
    expect(polishBudgetMs(0)).toBe(POLISH_BUDGET_MS);
    expect(polishBudgetMs(-5)).toBe(POLISH_BUDGET_MS);
    expect(polishBudgetMs(Number.NaN)).toBe(POLISH_BUDGET_MS);
  });

  it('a longer input gets a strictly larger budget', () => {
    // The one property the flat constant could not have: monotonicity.
    expect(polishBudgetMs(200)).toBeGreaterThan(polishBudgetMs(20));
    expect(polishBudgetMs(20)).toBeGreaterThan(polishBudgetMs(1));
  });

  it('the owner-observed failing lengths now fit, and the cap still bounds them', () => {
    // The four utterances that timed out on 2026-07-28 were 126/154/223/255
    // chars. Each must now get materially more than the old flat 800 ms.
    for (const chars of [126, 154, 223, 255]) {
      expect(polishBudgetMs(chars)).toBeGreaterThan(2_000);
    }
    // …but a runaway input can never buy unbounded time: a stalled model has to
    // fail loud rather than hold the utterance forever.
    expect(polishBudgetMs(100_000)).toBe(POLISH_BUDGET_MAX_MS);
  });

  it('polishFinalText USES the scaled budget (not the flat floor)', async () => {
    // The anti-façade half: a pure function nobody wired up would satisfy every
    // assertion above and change nothing in production. This drives the real
    // entry point and fails if `polishFinalText` ever goes back to a constant.
    vi.useFakeTimers();
    try {
      const long = '字'.repeat(200); // budget = 800 + 200*20 = 4800 ms
      let aborted = false;
      const streamer: LlmStreamer = async function* (opts) {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'aborted' } as LlmEvent;
      };
      const pending = polishFinalText(long, CFG, { streamerFor: () => streamer });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(aborted, 'the old flat 800ms floor would already have aborted here').toBe(false);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(aborted, 'the scaled 4800ms budget must eventually fire').toBe(true);

      const r = await pending;
      expect(r.skipReason).toBe('timeout');
      expect(r.text).toBe(long); // delivery is never blocked
    } finally {
      vi.useRealTimers();
    }
  });
});

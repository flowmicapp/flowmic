// QP-1 (2026-10-13) — Smooth -> Strict fallback. A smooth polish our guard
// refuses gets ONE strict attempt inside the same budget; the wire never learns
// a new value (applied / guard_reject exactly as before).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '@flowmic/protocol';
import {
  POLISH_FALLBACK_MIN_MS,
  POLISH_SMOOTH_SYSTEM_PROMPT,
  POLISH_SYSTEM_PROMPT,
  __resetPolishCacheForTest,
  polishFinalText,
  polishWireSignal,
} from '../src/stt/stt-polish';
import { log } from '../src/log';

const cfg: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://synthetic.invalid', model: 'synthetic', api_key: 'unused' };
const RAW = 'lets meet at 2 no wait 3 pm tomorrow';
// NR-245: smooth may now resolve the self-correction ("Let's meet at 3 pm
// tomorrow." is accepted, see the last case below), so the refused smooth
// output is the one that drops the REPAIR and keeps the reparandum.
const SMOOTH_OUT = "Let's meet at 2 pm tomorrow.";            // keeps 2, drops the repair 3: refused
const STRICT_OUT = "Let's meet at 2, no wait, 3 pm tomorrow."; // passes the strict guard

function scripted(bySystem: { smooth: string; strict: string }, calls: string[]) {
  return () => async function* (opts: { system: string }) {
    const which = opts.system === POLISH_SMOOTH_SYSTEM_PROMPT ? 'smooth' : opts.system === POLISH_SYSTEM_PROMPT ? 'strict' : 'other';
    calls.push(which);
    yield { kind: 'done' as const, full: which === 'smooth' ? bySystem.smooth : bySystem.strict, finish_reason: 'stop', usage: { tokens_in: 10, tokens_out: 5 } };
  };
}

beforeEach(() => {
  __resetPolishCacheForTest();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Smooth -> Strict fallback', () => {
  it('smooth refused by the guard, strict passes: strict text is delivered as applied', async () => {
    const calls: string[] = [];
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: scripted({ smooth: SMOOTH_OUT, strict: STRICT_OUT }, calls) as never });
    expect(calls).toEqual(['smooth', 'strict']);
    expect(r.text).toBe(STRICT_OUT);
    expect(r.reason).toBeUndefined();
    expect(polishWireSignal(r)).toEqual({ polish: 'applied' });
    expect(r.appliedStrength).toBe('strict');
    expect(r.firstReject).toMatch(/^closed-class-drift:/);
    expect(r.usage).toEqual({ tokensIn: 20, tokensOut: 10 }); // both calls billed
  });

  it('smooth empty output falls back too', async () => {
    const calls: string[] = [];
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: scripted({ smooth: '', strict: STRICT_OUT }, calls) as never });
    expect(calls).toEqual(['smooth', 'strict']);
    expect(r).toMatchObject({ text: STRICT_OUT, appliedStrength: 'strict', firstReject: 'empty-output' });
  });

  it('both refused: exactly today\'s guard_reject, raw text kept', async () => {
    const calls: string[] = [];
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: scripted({ smooth: SMOOTH_OUT, strict: SMOOTH_OUT }, calls) as never });
    expect(calls).toEqual(['smooth', 'strict']);
    expect(r.text).toBe(RAW);
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
    expect(r.reason).toBe(r.firstReject);
    expect(r.appliedStrength).toBeUndefined();
  });

  it('too little budget left: no second call', async () => {
    const calls: string[] = [];
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', budgetMs: POLISH_FALLBACK_MIN_MS - 1, streamerFor: scripted({ smooth: SMOOTH_OUT, strict: STRICT_OUT }, calls) as never });
    expect(calls).toEqual(['smooth']);
    expect(polishWireSignal(r)).toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
    expect(r.firstReject).toBe(r.reason);
  });

  it('a strict request never retries, and an accepted smooth never calls strict', async () => {
    const strictCalls: string[] = [];
    await polishFinalText(RAW, cfg, { strength: 'strict', streamerFor: scripted({ smooth: SMOOTH_OUT, strict: SMOOTH_OUT }, strictCalls) as never });
    expect(strictCalls).toEqual(['strict']);
    const smoothCalls: string[] = [];
    const ok = await polishFinalText('hey can you send me the report by friday', cfg, { strength: 'smooth', streamerFor: scripted({ smooth: 'Hey, can you send me the report by Friday?', strict: 'x' }, smoothCalls) as never });
    expect(smoothCalls).toEqual(['smooth']);
    expect(ok.appliedStrength).toBe('smooth');
  });

  it('an LLM error on smooth does not fall back', async () => {
    const calls: string[] = [];
    const failing = () => async function* () { calls.push('call'); yield { kind: 'error' as const, code: 'LLM_UPSTREAM_ERROR', message: 'x' }; };
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: failing as never });
    expect(calls).toHaveLength(1);
    expect(r.skipReason).toBe('llm_error');
  });
});

describe('the existing stt.polish.timing line records the fallback', () => {
  it('requested strength, applied strength and the first reject FAMILY (no raw term)', async () => {
    const { observedPolishFinalText } = await import('../src/obs/terminal-polish-timing');
    const info = vi.mocked(log.info);
    const calls: string[] = [];
    // The smooth output drops the user's own dictionary term: dict-term-drift.
    await observedPolishFinalText('open FlowMic now lets meet at 3', { source: 'user', cfg } as never, {
      strength: 'smooth', protectedTerms: ['FlowMic'],
      streamerFor: scripted({ smooth: "Open it now, let's meet at 3.", strict: "Open FlowMic now, let's meet at 3." }, calls) as never,
    });
    const line = info.mock.calls.find(([name]) => name === 'stt.polish.timing')![1] as Record<string, unknown>;
    expect(calls).toEqual(['smooth', 'strict']);
    expect(line).toMatchObject({ outcome: 'applied', strength: 'smooth', applied_strength: 'strict', first_reject: 'dict', attempts: 2, first_finish_reason: 'stop' });
    // ttfb/chars_out/finish_reason describe the strict call; the smooth call keeps its own.
    expect(line.chars_out).toBe("Open FlowMic now, let's meet at 3.".length);
    expect(line.first_chars_out).toBe("Open it now, let's meet at 3.".length);
    expect(JSON.stringify(line)).not.toContain('FlowMic');
  });

  it('NR-245: a smooth output that resolves the self-correction is accepted without the fallback', async () => {
    const calls: string[] = [];
    const r = await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: scripted({ smooth: "Let's meet at 3 pm tomorrow.", strict: STRICT_OUT }, calls) as never });
    expect(calls).toEqual(['smooth']);
    expect(r).toMatchObject({ text: "Let's meet at 3 pm tomorrow.", appliedStrength: 'smooth' });
  });

  it('NR-245: the session category decides whether a coding default term excuses a repair', async () => {
    const raw = 'run cube control get pods';
    const out = 'run kubectl get pods';
    const plain = await polishFinalText(raw, cfg, { strength: 'strict', streamerFor: scripted({ smooth: out, strict: out }, []) as never });
    expect(plain.text).toBe(raw);
    __resetPolishCacheForTest();
    const coding = await polishFinalText(raw, cfg, { strength: 'strict', appCategory: 'coding', streamerFor: scripted({ smooth: out, strict: out }, []) as never });
    expect(coding.text).toBe(out);
  });

  it('NR-245: a cached output is re-judged for THIS session (the key carries no category)', async () => {
    const raw = 'run cube control get pods';
    const out = 'run kubectl get pods';
    const coding = await polishFinalText(raw, cfg, { strength: 'strict', appCategory: 'coding', streamerFor: scripted({ smooth: out, strict: out }, []) as never });
    expect(coding.text).toBe(out);
    const calls: string[] = [];
    const plain = await polishFinalText(raw, cfg, { strength: 'strict', streamerFor: scripted({ smooth: out, strict: out }, calls) as never });
    expect(plain.timing?.cacheHit).toBe(true);
    expect(plain.text).toBe(raw);
    expect(polishWireSignal(plain)).toEqual({ polish: 'skipped', polish_reason: 'guard_reject' });
  });

  it('NR-245: the guard line says whether a self-correction was applied (a boolean, never text)', async () => {
    await new Promise((r) => setImmediate(r)); // earlier tests' guard lines land first
    vi.mocked(log.info).mockClear();
    await polishFinalText(RAW, cfg, { strength: 'smooth', streamerFor: scripted({ smooth: "Let's meet at 3 pm tomorrow.", strict: STRICT_OUT }, []) as never });
    await new Promise((r) => setImmediate(r));
    const lines = vi.mocked(log.info).mock.calls.filter((c) => c[0] === 'stt.polish.guard').map((c) => c[1] as Record<string, unknown>);
    expect(lines.map((l) => l.self_correction)).toEqual([true]);
  });
});

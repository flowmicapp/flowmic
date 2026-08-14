// FB-11 (LLM half) — THE LIVENESS DRILL for the managed LLM line, one-for-one with
// test/stt-live-drill.test.ts's "real/fake key drill".
//
// What §5 (docs/strategy/2026-08-06-w1-engine-switch-ledger.md) says delivered the
// STT failover was the DRILL: "failover drill is delivered by stt-live-drill.test.ts's real/fake key drill". This is that acceptance for the LLM line's health primitive
// (src/compose/llm-health.ts). Unlike the STT drill it does NOT hit a live network
// — there is no DeepSeek key on this machine — so the "kill" is a fetch that answers
// 401/429/refused, exercising the SAME production code path (managedLlmConfig →
// streamerFor → the real openai-compatible streamer's HTTP-status mapping) with the
// vendor socket replaced. What is production code here: llm-health.ts, llm-config.ts
// managedLlmConfig, the protocol dispatch, and the openai-compatible streamer. What
// is a fixture: the fetch, and the managed-line env rows (that is the operator's job).
//
// ── THE REVERSE CONTROL, watched (CLAUDE.md "a reverse control only counts if it has actually been seen red") ────────
// The drill's core assertion is "a dead key (401) is route-FATAL" — fatal is the one
// bit that would move traffic in the deferred failover consumer. It was watched go
// red on 2026-08-09 (dev-pc-b) by removing 'LLM_AUTH_FAIL' from
// LLM_ROUTE_FATAL_CODES in src/compose/llm-health.ts: the "dead key is fatal" case
// fails `Expected: true / Received: false`, while the "rate-limit is NOT fatal"
// positive control stays green (proving the assertion can distinguish the two, not
// that everything is trivially fatal). Restored; residue grep = 0.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  probeManagedLlmLiveness,
  probeLlmLiveness,
  LLM_ROUTE_FATAL_CODES,
} from '../src/compose/llm-health';
import type { LlmConfig } from '@flowmic/protocol';

/** A DeepSeek-shaped managed line, mirroring settings-provenance.test.ts's fixture
 *  (same key, same endpoint) so "who supplied it" reads identically across the two files. */
const MANAGED_LLM_ENV = {
  FLOWMIC_MANAGED_LLM_ENABLED: '1',
  FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: 'deepseek-chat',
  FLOWMIC_MANAGED_LLM_API_KEY: 'sk-platform-account-key-0123456789',
} as NodeJS.ProcessEnv;

/** An SSE Response the openai-compatible streamer will parse, mirroring the helper
 *  in compose-llm-protocols.test.ts. status !== 200 ⇒ a bodyless error response. */
function sseResponse(frames: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(`data: ${f}\n\n`));
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

const healthyFetch = (): typeof globalThis.fetch =>
  vi.fn().mockResolvedValue(sseResponse([
    JSON.stringify({ choices: [{ delta: { content: 'OK' } }], model: 'deepseek-chat' }),
    '[DONE]',
  ])) as unknown as typeof globalThis.fetch;

describe('FB-11 · managed LLM line liveness drill', () => {
  it('① HEALTHY — a live line answers ok, non-fatal, and echoes the served model', async () => {
    const v = await probeManagedLlmLiveness(MANAGED_LLM_ENV, { fetch: healthyFetch() });
    expect(v).not.toBeNull();
    expect(v!.ok).toBe(true);
    expect(v!.code).toBeNull();
    expect(v!.fatal).toBe(false);
    // model_echoed is what the PROVIDER said, not cfg.model parroted back.
    expect(v!.model_echoed).toBe('deepseek-chat');
  });

  it('② THE KILL — a dead key (401) is a route-FATAL verdict', async () => {
    const deadKeyFetch = vi.fn().mockResolvedValue(sseResponse([], 401)) as unknown as typeof globalThis.fetch;
    const v = await probeManagedLlmLiveness(MANAGED_LLM_ENV, { fetch: deadKeyFetch });
    expect(v).not.toBeNull();
    // Three separate assertions on purpose (D1 rule): "it failed", "it failed THIS
    // way" and "that verdict is route-fatal" are three questions, and only the third
    // one would move traffic in the deferred failover consumer.
    expect(v!.ok).toBe(false);
    expect(v!.code).toBe('LLM_AUTH_FAIL');
    expect(v!.fatal).toBe(true); // ← the watched reverse-control anchor (see header)
  });

  it('③ POSITIVE CONTROL — a throttle (429) is NOT fatal (waiting helps; do not evict)', async () => {
    const throttledFetch = vi.fn().mockResolvedValue(sseResponse([], 429)) as unknown as typeof globalThis.fetch;
    const v = await probeManagedLlmLiveness(MANAGED_LLM_ENV, { fetch: throttledFetch });
    expect(v).not.toBeNull();
    expect(v!.ok).toBe(false);
    expect(v!.code).toBe('LLM_RATE_LIMITED');
    expect(v!.fatal).toBe(false);
  });

  it('④ a refused connection is a non-fatal LLM_TIMEOUT (the line may come back)', async () => {
    const refusedFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof globalThis.fetch;
    const v = await probeLlmLiveness(
      { protocol: 'openai-compatible', endpoint: 'http://100.64.7.179:8000/v1', api_key: 'EMPTY', model: 'Qwen3.5-4B' } as LlmConfig,
      { fetch: refusedFetch },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('LLM_TIMEOUT');
    expect(v.fatal).toBe(false);
  });

  it('⑤ opened-but-empty — a stream that completes with no text is NOT healthy', async () => {
    const emptyFetch = vi.fn().mockResolvedValue(sseResponse(['[DONE]'])) as unknown as typeof globalThis.fetch;
    const v = await probeLlmLiveness(
      { protocol: 'openai-compatible', endpoint: 'http://lan/v1', api_key: 'EMPTY', model: 'm' } as LlmConfig,
      { fetch: emptyFetch },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('LLM_PROBE_FAIL');
    expect(v.fatal).toBe(false);
  });

  it('⑥ NOT CONFIGURED — no managed line ⇒ null, not a fake "ok" and not a fake "dead"', async () => {
    expect(await probeManagedLlmLiveness({} as NodeJS.ProcessEnv, { fetch: healthyFetch() })).toBeNull();
    expect(await probeManagedLlmLiveness({ FLOWMIC_MANAGED_LLM_ENABLED: '0' } as NodeJS.ProcessEnv, { fetch: healthyFetch() })).toBeNull();
  });

  it('⑦ ENABLED-but-INVALID env is a FATAL verdict, not a thrown exception', async () => {
    // A deploy-time misconfig (enabled, but MODEL missing). managedLlmConfig throws
    // for it; the managed probe turns that into a verdict a health surface can read,
    // never a 500. No fetch is reached, so none is supplied.
    const v = await probeManagedLlmLiveness({ ...MANAGED_LLM_ENV, FLOWMIC_MANAGED_LLM_MODEL: undefined } as NodeJS.ProcessEnv);
    expect(v).not.toBeNull();
    expect(v!.ok).toBe(false);
    expect(v!.code).toBe('LLM_INVALID_MODEL');
    expect(v!.fatal).toBe(true);
  });

  it('the fatal set is exactly the two irrecoverable codes (mirrors pool-health ROUTE_FATAL_CODES)', () => {
    expect([...LLM_ROUTE_FATAL_CODES].sort()).toEqual(['LLM_AUTH_FAIL', 'LLM_INVALID_MODEL']);
  });

  it('🔴 NOTHING IS BILLED — the module imports no billing/usage surface (structural, anti-façade)', () => {
    // The invariant probe-routes.ts pins for the same reason (its #2 "NOTHING IS
    // BILLED"): a liveness check cannot spend quota if it has no reference to
    // anything that could. Asserted on the source so a future edit that reaches for
    // the usage tracker is caught here, not in a billing audit months later.
    const src = readFileSync(new URL('../src/compose/llm-health.ts', import.meta.url), 'utf8');
    // Scan IMPORTS (not comment prose): no billing/usage/metering module is pulled in.
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    expect(imports).not.toMatch(/billing|usage-tracker|usage\.repo/);
    // …and no metering call site anywhere in the body.
    expect(src).not.toMatch(/recordLlmUsage\s*\(|ensureQuota\s*\(/);
  });
});

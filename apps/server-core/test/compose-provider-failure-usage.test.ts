// NR-124: real provider parsers -> compose handler -> real quota/event stores.
// No fake terminal events: failures must retain the provider's own counts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { LlmConfig } from '@flowmic/protocol';
import { createComposeRun, streamerFor } from '../src/compose';
import { registerComposeHandlers } from '../src/socket/handlers/compose.handler';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { polishFinalText, polishWireSignal, __resetPolishCacheForTest } from '../src/stt/stt-polish';

const TEXT = '今天下午开会。';
// Different from the raw input, but guard-acceptable on a successful finish.
const ANSWER = '今天下午开会';
const PERIOD = '2026-09';
const cfg = (protocol: LlmConfig['protocol']): LlmConfig => ({
  protocol, endpoint: 'http://provider.invalid/v1', model: 'test', api_key: 'test',
});

function response(frames: unknown[], broken = false): Response {
  const pending = frames.map(f => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = pending.shift();
      if (frame !== undefined) controller.enqueue(new TextEncoder().encode(frame));
      else if (broken) controller.error(new Error('provider connection lost'));
      else controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

const antStart = { type: 'message_start', message: { usage: { input_tokens: 37, output_tokens: 2 } } };
const antText = { type: 'content_block_delta', delta: { type: 'text_delta', text: ANSWER } };
const antDelta = (reason: string) => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 41 } });
const antStop = { type: 'message_stop' };
const oaiText = { choices: [{ delta: { content: ANSWER } }] };
const oaiUsage = { choices: [], usage: { prompt_tokens: 37, completion_tokens: 41 } };

interface FailureCase {
  name: string;
  protocol: LlmConfig['protocol'];
  reply: () => Response;
  code: string;
  message?: string;
  counts?: [number, number];
}

const openaiFailures: FailureCase[] = [
  ...['length', 'content_filter'].map(reason => ({
    name: `openai ${reason}`, protocol: 'openai-compatible' as const,
    // Usage is deliberately AFTER the finish frame, as on real OAI streams.
    reply: () => response([oaiText, { choices: [{ finish_reason: reason }] }, oaiUsage, '[DONE]']),
    code: 'COMPOSE_OUTPUT_REJECTED', message: `openai finish_reason ${reason}`,
  })),
  { name: 'openai early close', protocol: 'openai-compatible', code: 'LLM_TIMEOUT',
    message: 'openai stream ended without finish_reason or [DONE]',
    reply: () => response([oaiText, oaiUsage]) },
  { name: 'openai 404', protocol: 'openai-compatible', code: 'LLM_INVALID_MODEL', counts: [0, 0],
    message: 'openai-compatible http 404', reply: () => new Response(null, { status: 404 }) },
];

const failures: FailureCase[] = [
  ...['max_tokens', 'refusal'].map(reason => ({
    name: `anthropic ${reason}`, protocol: 'anthropic' as const,
    reply: () => response([antStart, antText, antDelta(reason), antStop]),
    code: 'COMPOSE_OUTPUT_REJECTED',
  })),
  { name: 'anthropic stream error', protocol: 'anthropic', code: 'LLM_RATE_LIMITED',
    reply: () => response([antStart, antText, antDelta('end_turn'), { type: 'error', error: { type: 'rate_limit_error' } }]) },
  { name: 'anthropic early close', protocol: 'anthropic', code: 'LLM_TIMEOUT',
    reply: () => response([antStart, antText, antDelta('end_turn')]) },
  { name: 'anthropic read failure', protocol: 'anthropic', code: 'LLM_TIMEOUT',
    reply: () => response([antStart, antText, antDelta('end_turn')], true) },
  { name: 'anthropic input and initial output only', protocol: 'anthropic', code: 'LLM_TIMEOUT', counts: [37, 2],
    reply: () => response([antStart, antText]) },
  { name: 'openai read failure', protocol: 'openai-compatible', code: 'LLM_TIMEOUT',
    reply: () => response([oaiText, oaiUsage], true) },
  ...openaiFailures,
];

async function compose(c: FailureCase, byok = false): Promise<void> {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr124-provider-usage-secret') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  try {
    const tracker = makeUsageTracker(db.usage, {
      mode: 'saas', periodKeyFor: () => PERIOD, usageEventsEnabled: true, events: db.usageEvents,
    });
    const record = vi.spyOn(tracker, 'recordLlmUsage');
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const socket = {
      data: { auth: { userId: 'u1' } },
      on: (event: string, fn: (payload: unknown) => Promise<void>) => handlers.set(event, fn),
      emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); return true; },
    } as unknown as Socket;
    registerComposeHandlers(socket, {
      io: {} as never, guard: { ensureQuota() {} } as never,
      usageTracker: tracker, store: { getFocusProcess: () => undefined } as never,
      composeFactory: () => createComposeRun(cfg(c.protocol), 'system', byok, {
        streamerFor, fetch: async () => c.reply(),
      }),
    });
    await handlers.get('compose:start')!({ task: 'organize', source_text: TEXT, request_id: 'nr124' });
    const errors = emitted.filter(e => e.event === 'compose:error');
    if (c.code) {
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toMatchObject({ code: c.code, request_id: 'nr124' });
      if (c.message) expect(errors[0]?.payload['message']).toBe(c.message);
      expect(emitted.filter(e => e.event === 'compose:done')).toEqual([]);
    } else {
      expect(errors).toEqual([]);
      expect(emitted.filter(e => e.event === 'compose:done')).toHaveLength(1);
    }
    const [input, output] = c.counts ?? [37, 41];
    expect(record).toHaveBeenCalledExactlyOnceWith('u1', { is_byok: byok }, input, output, {});
    const quota = db.usage.get('u1', PERIOD);
    expect(quota?.llm_tokens_in ?? 0).toBe(byok ? 0 : input);
    expect(quota?.llm_tokens_out ?? 0).toBe(byok ? 0 : output);
    const events = db.usageEvents.listForUser('u1', { from: 0, to: Number.MAX_SAFE_INTEGER, limit: 10 }).rows;
    if (input + output === 0) expect(events).toEqual([]);
    else {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ tokens_in: input, tokens_out: output, is_byok: byok ? 1 : 0 });
    }
  } finally { db.close(); }
}

beforeEach(() => __resetPolishCacheForTest());

describe('NR-124 provider usage survives failure', () => {
  for (const c of failures) {
    it(`managed compose commits ${c.name}`, async () => compose(c));
    it(`polish retains raw text and usage on ${c.name}`, async () => {
      const result = await polishFinalText(TEXT, cfg(c.protocol), { fetch: async () => c.reply() });
      expect(result.text).toBe(TEXT);
      expect(result.reason).toBe(c.code);
      // NR-130: a real vendor refusal of the config (401/403, 404) is `model_rejected`.
      const wire = c.code === 'LLM_TIMEOUT' ? 'timeout' : c.code === 'LLM_AUTH_FAIL' || c.code === 'LLM_INVALID_MODEL' ? 'model_rejected' : 'llm_error';
      expect(polishWireSignal(result)).toEqual({ polish: 'skipped', polish_reason: wire });
      if (c.counts?.[0] === 0 && c.counts[1] === 0) expect(result.usage).toBeUndefined();
      else expect(result.usage).toEqual({ tokensIn: c.counts?.[0] ?? 37, tokensOut: c.counts?.[1] ?? 41 });
    });
  }
  it('BYOK records reported usage without charging quota', async () => compose(failures[0]!, true));
  it('unreported usage writes no quota and no event', async () => compose({
    name: 'unreported', protocol: 'anthropic', code: 'LLM_TIMEOUT', counts: [0, 0],
    reply: () => response([antText]),
  }));
  it('successful stop still commits exactly once', async () => compose({
    name: 'stop', protocol: 'openai-compatible', code: '',
    reply: () => response([oaiText, { choices: [{ finish_reason: 'stop' }] }, oaiUsage, '[DONE]']),
  }));
});

describe('NR-124 OpenAI completion truth', () => {
  for (const c of openaiFailures) {
    it(`stream rejects ${c.name} with the developer message`, async () => {
      const events = [];
      for await (const e of streamerFor(c.protocol)({ cfg: cfg(c.protocol), system: 'system', user: TEXT, fetch: async () => c.reply() })) events.push(e);
      expect(events.filter(e => e.kind === 'done')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ kind: 'error', code: c.code, message: c.message });
      if (c.counts) expect(events.at(-1)).not.toHaveProperty('usage');
      else expect(events.at(-1)).toMatchObject({ usage: { tokens_in: 37, tokens_out: 41 } });
    });
  }
  for (const terminal of ['stop', '[DONE]'] as const) {
    it(`${terminal} alone proves stream completion`, async () => {
      const frames = [oaiText, oaiUsage, terminal === 'stop' ? { choices: [{ finish_reason: 'stop' }] } : terminal];
      const opts = { cfg: cfg('openai-compatible'), system: 'system', user: TEXT, fetch: async () => response(frames) };
      const events = [];
      for await (const e of streamerFor('openai-compatible')(opts)) events.push(e);
      expect(events.at(-1)).toMatchObject({ kind: 'done', full: ANSWER });
    });
    it(`${terminal} alone proves polish success`, async () => {
      const frames = [oaiText, oaiUsage, terminal === 'stop' ? { choices: [{ finish_reason: 'stop' }] } : terminal];
      const result = await polishFinalText(TEXT, cfg('openai-compatible'), { fetch: async () => response(frames) });
      expect(polishWireSignal(result)).toEqual({ polish: 'applied' });
      expect(result.text).toBe(ANSWER);
      expect(result.usage).toEqual({ tokensIn: 37, tokensOut: 41 });
    });
  }
});

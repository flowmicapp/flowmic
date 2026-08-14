// WP-R1-4: dual-protocol LLM client (node-native fetch, SSE). Mock fetch feeds a
// streaming body; asserts delta accumulation, terminal usage capture, HTTP error
// mapping, transport-failure → LlmError (never a throw, never raw-text fallback),
// and the platform-sentinel ('EMPTY') vs BYOK Authorization behaviour.

import { describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '@flowmic/protocol';
import { streamOpenAiCompatible, streamAnthropic, type LlmEvent } from '../src/compose';
// By path, not through the compose barrel: re-exporting names nothing production
// consumes is how a barrel turns into a façade (src/compose/index.ts says so).
import { PROTECTED_BODY_KEYS, mergeVendorBody } from '../src/compose/llm/vendor-body';

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

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const OAI: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://lan/v1', api_key: 'EMPTY', model: 'Qwen3.5-4B' };
const ANT: LlmConfig = { protocol: 'anthropic', endpoint: 'https://api.anthropic.com', api_key: 'user-key-abc', model: 'claude-sonnet-4-5' };

describe('openai-compatible streamer', () => {
  it('accumulates deltas and captures terminal usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hola' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' mundo' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      '[DONE]',
    ]));
    const evs = await collect(streamOpenAiCompatible({ cfg: OAI, system: 's', user: 'u', fetch: fetchImpl }));
    expect(evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Hola', ' mundo']);
    const done = evs.at(-1);
    expect(done).toMatchObject({ kind: 'done', full: 'Hola mundo', usage: { tokens_in: 12, tokens_out: 3 } });
  });

  it("sends NO Authorization for the 'EMPTY' platform sentinel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['[DONE]']));
    await collect(streamOpenAiCompatible({ cfg: OAI, system: 's', user: 'u', fetch: fetchImpl }));
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends a Bearer for a real user key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['[DONE]']));
    await collect(streamOpenAiCompatible({ cfg: { ...OAI, api_key: 'user-key-abc' }, system: 's', user: 'u', fetch: fetchImpl }));
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer user-key-abc');
  });

  it('maps HTTP 401→LLM_AUTH_FAIL, 429→LLM_RATE_LIMITED, 500→LLM_TIMEOUT', async () => {
    for (const [status, code] of [[401, 'LLM_AUTH_FAIL'], [429, 'LLM_RATE_LIMITED'], [500, 'LLM_TIMEOUT']] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(sseResponse([], status));
      const evs = await collect(streamOpenAiCompatible({ cfg: OAI, system: 's', user: 'u', fetch: fetchImpl }));
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ kind: 'error', code });
    }
  });

  it('a transport rejection becomes an LlmError (never throws, never falls back)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const evs = await collect(streamOpenAiCompatible({ cfg: OAI, system: 's', user: 'u', fetch: fetchImpl }));
    expect(evs).toEqual([{ kind: 'error', code: 'LLM_TIMEOUT', message: 'ECONNREFUSED' }]);
  });
});

// ── vendor request-body seam (llm/vendor-body.ts) ───────────────────────────
//
// The engine switch to DeepSeek needs `thinking` forced OFF (measured: default is
// ON, 2k–3k reasoning tokens a turn, p50 already on the 800 ms budget floor). The
// seam that carries it must be provably invisible when the deployment does not
// use it — vLLM/Ollama/LM Studio all sit behind this same client and an
// unrecognised body field is a legitimate 400.
//
// 🔴 These assertions are on the REQUEST BODY BYTES, not on "the merge function
// returned the right object". The thing that can break a self-hosted user is what
// goes on the wire, so that is what is pinned.
describe('openai-compatible vendor request body', () => {
  /** The exact bytes shipped before vendor-body.ts existed. A reordering, a stray
   *  key, or a dropped stream_options fails HERE rather than at a user's server.
   *
   *  🔴 UPDATED W2/FB-5: `"temperature":0` is now part of the default body. This
   *  pin caught the change, which is what it is for — it is being updated
   *  deliberately, not because it was in the way. The distinction that makes it
   *  safe: the field this file was written to contain (`thinking`) is
   *  vendor-specific and draws a legitimate 400 from a server that does not know
   *  it, whereas `temperature` is part of the OpenAI chat-completions request
   *  every compatible server implements. Rationale and the measured effect are
   *  on FAITHFULNESS_TEMPERATURE in openai-compatible.ts. */
  const BASELINE_BODY =
    '{"model":"Qwen3.5-4B","stream":true,"stream_options":{"include_usage":true},'
    + '"temperature":0,'
    + '"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}]}';

  const DEEPSEEK: LlmConfig = {
    protocol: 'openai-compatible',
    endpoint: 'https://api.deepseek.com/v1',
    api_key: 'platform-key',
    model: 'deepseek-v4-flash',
  };

  async function bodySentTo(cfg: LlmConfig, env: NodeJS.ProcessEnv): Promise<string> {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['[DONE]']));
    await collect(streamOpenAiCompatible({ cfg, system: 's', user: 'u', fetch: fetchImpl, env }));
    return (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string;
  }

  it('DEFAULT (no vendor env): body is byte-identical to the pre-seam request', async () => {
    expect(await bodySentTo(OAI, {})).toBe(BASELINE_BODY);
  });

  it('a deployment that enables it for a DIFFERENT endpoint leaves this one byte-identical', async () => {
    // The realistic production shape: the relay declares DeepSeek's thinking
    // switch, and a user whose llm.config still points at the seeded LAN vLLM
    // must be unaffected. This is the case that would break the working majority.
    const env = {
      FLOWMIC_LLM_VENDOR_BODY: '{"thinking":{"type":"disabled"}}',
      FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
    };
    expect(await bodySentTo(OAI, env)).toBe(BASELINE_BODY);
  });

  it('carries the field when the deployment enables it for THIS endpoint', async () => {
    const env = {
      FLOWMIC_LLM_VENDOR_BODY: '{"thinking":{"type":"disabled"}}',
      FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
    };
    const body = await bodySentTo(DEEPSEEK, env);
    expect(JSON.parse(body)).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
    });
    // ...and the appended key does not disturb the protected four.
    expect(body.startsWith('{"model":"deepseek-v4-flash","stream":true,"stream_options":{"include_usage":true},"temperature":0,"messages":')).toBe(true);
  });

  it('scope tolerates the meaningless trailing-slash difference only', async () => {
    const env = {
      FLOWMIC_LLM_VENDOR_BODY: '{"thinking":{"type":"disabled"}}',
      FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1/',
    };
    expect(JSON.parse(await bodySentTo(DEEPSEEK, env))).toHaveProperty('thinking');
    // A different HOST is not a near miss to be forgiven.
    const other = { ...env, FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com' };
    expect(JSON.parse(await bodySentTo(DEEPSEEK, other))).not.toHaveProperty('thinking');
  });

  it('an explicit scope key overrides the managed-endpoint default', async () => {
    const env = {
      FLOWMIC_LLM_VENDOR_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
      FLOWMIC_LLM_VENDOR_BODY_ENDPOINT: 'http://lan/v1',
    };
    expect(JSON.parse(await bodySentTo(OAI, env))).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.parse(await bodySentTo(DEEPSEEK, env))).not.toHaveProperty('thinking');
  });

  it('a misconfigured vendor env fails LOUD as an event — never a silent skip, never a throw', async () => {
    // Every rejection surfaces on the FIRST call of any kind, including a call to
    // an endpoint outside the scope: a dormant typo would mean DeepSeek keeps
    // thinking and nothing anywhere says so.
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ FLOWMIC_LLM_VENDOR_BODY: 'not json', FLOWMIC_MANAGED_LLM_ENDPOINT: 'http://lan/v1' }, /not valid JSON/],
      [{ FLOWMIC_LLM_VENDOR_BODY: '["thinking"]', FLOWMIC_MANAGED_LLM_ENDPOINT: 'http://lan/v1' }, /must be a JSON object/],
      [{ FLOWMIC_LLM_VENDOR_BODY: '{"temperature":0.2}', FLOWMIC_MANAGED_LLM_ENDPOINT: 'http://lan/v1' }, /not allowlisted/],
      [{ FLOWMIC_LLM_VENDOR_BODY: '{"stream":false}', FLOWMIC_MANAGED_LLM_ENDPOINT: 'http://lan/v1' }, /protected request-body key/],
      [{ FLOWMIC_LLM_VENDOR_BODY: '{"thinking":{"type":"disabled"}}' }, /no endpoint scope is configured/],
    ];
    for (const [env, message] of cases) {
      const fetchImpl = vi.fn();
      const evs = await collect(streamOpenAiCompatible({ cfg: OAI, system: 's', user: 'u', fetch: fetchImpl, env }));
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ kind: 'error', code: 'LLM_INVALID_MODEL' });
      expect((evs[0] as { message: string }).message).toMatch(message);
      expect(fetchImpl).not.toHaveBeenCalled(); // no half-formed request left the box
    }
  });

  it('the merge site refuses a protected key independently of the allowlist', () => {
    // 🔴 Not a duplicate of the allowlist test above: this is the latch that still
    // holds if somebody widens ALLOWED_VENDOR_KEYS. Asserted directly, so it is
    // a live branch rather than an unreachable one guarded by another check.
    for (const key of PROTECTED_BODY_KEYS) {
      expect(() => mergeVendorBody({ model: 'm' }, { [key]: 'hijacked' })).toThrow(/protected key/);
    }
    // The identity property the byte-identical claim rests on.
    const base = { model: 'm', stream: true };
    expect(mergeVendorBody(base, undefined)).toBe(base);
  });
});

describe('anthropic streamer', () => {
  it('accumulates text_delta and captures input/output usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bon' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'jour' } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }),
      JSON.stringify({ type: 'message_stop' }),
    ]));
    const evs = await collect(streamAnthropic({ cfg: ANT, system: 's', user: 'u', fetch: fetchImpl }));
    expect(evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['Bon', 'jour']);
    expect(evs.at(-1)).toMatchObject({ kind: 'done', full: 'Bonjour', usage: { tokens_in: 20, tokens_out: 7 } });
  });

  it('sends x-api-key + anthropic-version headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([JSON.stringify({ type: 'message_stop' })]));
    await collect(streamAnthropic({ cfg: ANT, system: 's', user: 'u', fetch: fetchImpl }));
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('user-key-abc');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

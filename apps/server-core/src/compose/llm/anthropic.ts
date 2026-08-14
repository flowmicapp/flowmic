// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (the `anthropic` protocol — Anthropic
//     Messages API is the second of the two clients covering every provider)
//   Ported streaming/SSE mechanism from legacy compose/llm-protocols/anthropic.ts;
//     extended to capture usage from message_start (input_tokens) + message_delta
//     (output_tokens) so billing gets real counts.
//   CLAUDE.md red line: no silent fallback (transport failure → LlmError, never raw text)
//
// POST {endpoint}/messages with x-api-key + anthropic-version: 2023-06-01,
// stream:true. Act on content_block_delta (text_delta) frames; message_stop
// ends. HTTP status map matches the openai client: 401/403→LLM_AUTH_FAIL,
// 429→LLM_RATE_LIMITED, other/transport→LLM_TIMEOUT.

import {
  type LlmEvent,
  type LlmStreamOpts,
  type LlmUsage,
  parseSseStream,
  stripTrailingSlash,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicFrame {
  type?: string;
  delta?: { type?: string; text?: string };
  /** GA-12: `message_start` carries the model the API actually served — the only
   *  honest source for the probe's model_echoed dimension. */
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

function mapHttpStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) return { code: 'LLM_AUTH_FAIL', message: `anthropic http ${status}` };
  if (status === 429) return { code: 'LLM_RATE_LIMITED', message: `anthropic http ${status}` };
  return { code: 'LLM_TIMEOUT', message: `anthropic http ${status}` };
}

export async function* streamAnthropic(opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${stripTrailingSlash(opts.cfg.endpoint)}/messages`;
  const body = JSON.stringify({
    model: opts.cfg.model,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    stream: true,
    max_tokens: DEFAULT_MAX_TOKENS,
  });

  let res: Response;
  try {
    const init: RequestInit = { method: 'POST', headers: buildHeaders(opts.cfg.api_key), body };
    if (opts.signal) init.signal = opts.signal;
    res = await fetchImpl(url, init);
  } catch (err) {
    yield { kind: 'error', code: 'LLM_TIMEOUT', message: (err as Error)?.message ?? 'fetch failed' };
    return;
  }

  if (!res.ok) return void (yield { kind: 'error', ...mapHttpStatus(res.status) });
  if (!res.body) return void (yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'response body missing' });

  let full = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let served: string | undefined;
  try {
    for await (const data of parseSseStream(res.body)) {
      let parsed: AnthropicFrame;
      try { parsed = JSON.parse(data) as AnthropicFrame; } catch { continue; }
      if (parsed.type === 'message_start') {
        tokensIn = parsed.message?.usage?.input_tokens ?? tokensIn;
        const m = parsed.message?.model;
        if (typeof m === 'string' && m.length > 0) served = m;
      } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string' && parsed.delta.text.length > 0) {
        full += parsed.delta.text;
        yield { kind: 'delta', text: parsed.delta.text };
      } else if (parsed.type === 'message_delta') {
        tokensOut = parsed.usage?.output_tokens ?? tokensOut;
      } else if (parsed.type === 'message_stop') {
        break;
      }
    }
  } catch (err) {
    yield { kind: 'error', code: 'LLM_TIMEOUT', message: (err as Error)?.message ?? 'stream read failed' };
    return;
  }

  const usage: LlmUsage = { tokens_in: tokensIn, tokens_out: tokensOut };
  yield { kind: 'done', full, usage, ...(served !== undefined ? { model: served } : {}) };
}

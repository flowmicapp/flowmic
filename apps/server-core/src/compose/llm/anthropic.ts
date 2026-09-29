// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (the `anthropic` protocol — Anthropic
//     Messages API is the second of the two clients covering every provider)
//   Ported streaming/SSE mechanism from legacy compose/llm-protocols/anthropic.ts;
//     extended to capture usage from message_start (input_tokens) + message_delta
//     (output_tokens) so billing gets real counts.
//   CLAUDE.md red line: no silent fallback (transport failure → LlmError, never raw text)
//
// POST [anthropicMessagesUrl](endpoint) with x-api-key + anthropic-version:
// 2023-06-01, stream:true. Act on content_block_delta (text_delta) frames;
// message_stop ends. HTTP status map: 401/403→LLM_AUTH_FAIL,
// 429→LLM_RATE_LIMITED, 404→LLM_INVALID_MODEL, other/transport→LLM_TIMEOUT.

import {
  type LlmEvent,
  type LlmFinishReason,
  type LlmStreamOpts,
  type LlmUsage,
  parseSseStream,
  stripTrailingSlash,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';
/** Unknown models and third-party "Anthropic-compatible" proxies: unchanged
 *  since before BYOK-ANT-1. Older / non-Claude models behind a proxy may cap
 *  output below a larger value and 400 the whole request on it. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Per-model request extras (BYOK-ANT-1), keyed on the EXACT model id.
 *
 * 🔴 Why a closed table and not "send it to every Claude-looking id": a field a
 * server does not understand is a 400 on EVERY turn, and this client also talks
 * to third-party proxies (same asymmetry as vendor-body.ts: absent-where-useful
 * costs latency, present-where-unknown costs the product). So an id not listed
 * here gets the body byte-identical to before this table existed — pinned as a
 * literal string in compose-llm-protocols.test.ts.
 *
 * Facts per the Claude API docs (claude-api skill, cached 2026-09-25):
 *   • claude-sonnet-5-5 thinks by default; `thinking:{type:'disabled'}` is a 400
 *     on it, and `{type:'between_tools'}` is its "no extended thinking" setting
 *     — accepted ONLY by Claude Sonnet 5.5, only at effort high or below (its
 *     default is high, and we send no effort), and with NO other field inside
 *     `thinking` (display/budget_tokens alongside it are a 400). With no tools
 *     in the request that means no thinking at all: lower first-token latency
 *     and no thinking tokens eating `max_tokens`.
 *   • claude-opus-5-5: thinking cannot be disabled (disabled and budget_tokens
 *     are both 400 at every effort), so no `thinking` field is sent; thinking
 *     tokens count toward `max_tokens`, hence the larger budget below.
 * max_tokens 16000 for both: they accept up to 128K output, and 4096 can cut
 * off a long organize/translate result (a 30-minute dictation runs 5–8k
 * characters) — which since this card is a loud COMPOSE_OUTPUT_REJECTED rather
 * than a silent half-answer, so the budget has to fit the real job. We stream,
 * so a larger value costs nothing unless the tokens are actually generated.
 * No temperature on any model: current Claude models reject non-default
 * sampling values (Sonnet 5.5: 400 on non-default; Opus 5.5: removed).
 */
interface AnthropicModelExtras {
  readonly maxTokens: number;
  readonly thinking?: { readonly type: 'between_tools' };
}
export const ANTHROPIC_MODEL_EXTRAS: Readonly<Record<string, AnthropicModelExtras>> = {
  'claude-sonnet-5-5': { maxTokens: 16000, thinking: { type: 'between_tools' } },
  'claude-opus-5-5': { maxTokens: 16000 },
};

function buildBody(opts: LlmStreamOpts): string {
  const extras = Object.prototype.hasOwnProperty.call(ANTHROPIC_MODEL_EXTRAS, opts.cfg.model)
    ? ANTHROPIC_MODEL_EXTRAS[opts.cfg.model]
    : undefined;
  return JSON.stringify({
    model: opts.cfg.model,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    stream: true,
    max_tokens: extras?.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(extras?.thinking !== undefined ? { thinking: extras.thinking } : {}),
  });
}

interface AnthropicFrame {
  type?: string;
  /** `content_block_delta` → `{type:'text_delta', text}`; `message_delta` →
   *  `{stop_reason}` (the only place the stream says WHY it stopped). */
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  /** `event: error` frames (`{"type":"error","error":{"type":"overloaded_error",…}}`)
   *  — the API can fail AFTER the HTTP 200, mid-stream. */
  error?: { type?: string; message?: string };
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

/**
 * The ONE place an Anthropic Messages API URL is built (BYOK-ANT-1).
 *
 * The route is `/v1/messages`. Users (and the `cloud-anthropic-claude` preset)
 * give a BASE, and both spellings of that base are in the wild: the bare host
 * (`https://api.anthropic.com`, what the preset ships) and the versioned one
 * (`https://api.anthropic.com/v1`, what many "Anthropic-compatible" proxies
 * document, e.g. `https://host/anthropic/v1`). So:
 *   • ends in `/v1/messages` → the user pasted the full route; use it as-is;
 *   • ends in `/v1`          → append `/messages`;
 *   • anything else          → append `/v1/messages`.
 * A trailing slash is dropped first.
 *
 * Measured 2026-09-29 (MAIN, invalid key): `POST https://api.anthropic.com/messages`
 * → 404, `POST https://api.anthropic.com/v1/messages` → 401. Before this builder
 * the adapter appended a bare `/messages` to the preset's bare host, so every
 * real BYOK Anthropic request 404'd. Pinned by compose-llm-protocols.test.ts
 * ("anthropicMessagesUrl").
 */
export function anthropicMessagesUrl(endpoint: string): string {
  const base = stripTrailingSlash(endpoint.trim());
  if (base.endsWith('/v1/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function mapHttpStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) return { code: 'LLM_AUTH_FAIL', message: `anthropic http ${status}` };
  if (status === 429) return { code: 'LLM_RATE_LIMITED', message: `anthropic http ${status}` };
  // 404 is `not_found_error`: "unknown endpoint, or model not found or not
  // available to your org". With the URL built above, the route is right, so a
  // 404 means the configured model (or a wrong proxy base) is unusable — a
  // CONFIG fault an operator/user must fix, which is exactly what
  // LLM_INVALID_MODEL says and why llm-health.ts LLM_ROUTE_FATAL_CODES treats it
  // as fatal. Reporting it as LLM_TIMEOUT sent the user to wait for a network
  // that was fine.
  if (status === 404) return { code: 'LLM_INVALID_MODEL', message: `anthropic http ${status}` };
  return { code: 'LLM_TIMEOUT', message: `anthropic http ${status}` };
}

/**
 * A mid-stream `event: error` frame, mapped by the API's own `error.type` onto
 * the SAME codes the HTTP-status path gives the equivalent status (the error
 * types are the HTTP errors, delivered after the 200): authentication/permission
 * → LLM_AUTH_FAIL, rate_limit → LLM_RATE_LIMITED, not_found → LLM_INVALID_MODEL,
 * everything else (overloaded_error = 529, api_error = 500, unknown) →
 * LLM_TIMEOUT, as 5xx already is in [mapHttpStatus].
 */
function mapStreamError(err: AnthropicFrame['error']): { code: string; message: string } {
  const type = err?.type ?? 'unknown';
  const message = `anthropic stream error ${type}${err?.message ? `: ${err.message}` : ''}`;
  if (type === 'authentication_error' || type === 'permission_error') return { code: 'LLM_AUTH_FAIL', message };
  if (type === 'rate_limit_error') return { code: 'LLM_RATE_LIMITED', message };
  if (type === 'not_found_error') return { code: 'LLM_INVALID_MODEL', message };
  return { code: 'LLM_TIMEOUT', message };
}

/** `stop_reason` values that mean "the model finished its answer". `null` /
 *  absent is tolerated too (some Anthropic-compatible proxies never send it;
 *  `message_stop` is then the completion proof). */
const COMPLETE_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence']);

/**
 * 🔴 Any OTHER stop_reason means the text we hold is NOT a complete answer, and
 * finishing with `done` would hand a half-written result to the injector as if
 * it were the result — the "no silent failure" red line (CLAUDE.md), and
 * exactly what this adapter did before BYOK-ANT-1 (it never read stop_reason):
 *   • `refusal`    — current Claude models decline as HTTP 200 + this stop
 *                    reason (Claude API docs, "refusal stop reason");
 *   • `max_tokens` — the output was cut off at our `max_tokens`;
 *   • anything else (`tool_use`, `pause_turn`, a value added later) — we send
 *                    no tools, so none of them can describe a finished answer;
 *                    unknown fails CLOSED rather than injecting a guess.
 *
 * Code: COMPOSE_OUTPUT_REJECTED — its registered sentence ("The AI's answer did
 * not meet the request, so we held it back" / 「AI 生成的内容不符合要求，已自动
 * 拦截并保留原文」, packages/protocol/src/error-codes.ts) is TRUE here: the model
 * answered, the answer is a refusal or is incomplete, and we deliver nothing.
 * Every LLM_* sentence is false here (nothing timed out, the key and model are
 * fine). ⚠️ This is a reuse, not a new code; whether a provider-side refusal
 * deserves its own code is an open question reported with BYOK-ANT-1, and
 * swapping it is this one line.
 */
function incompleteStop(stopReason: string): { code: string; message: string } {
  return { code: 'COMPOSE_OUTPUT_REJECTED', message: `anthropic stop_reason ${stopReason}` };
}

function telemetryFinishReason(stopReason: string | null): LlmFinishReason {
  if (stopReason === null) return 'none';
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'refusal') return 'content_filter';
  return 'other';
}

export async function* streamAnthropic(opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = anthropicMessagesUrl(opts.cfg.endpoint);
  const body = buildBody(opts);

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
  let sawUsage = false;
  const reportedUsage = (): { usage?: LlmUsage } => sawUsage
    ? { usage: { tokens_in: tokensIn, tokens_out: tokensOut } }
    : {};
  let served: string | undefined;
  let stopReason: string | null = null;
  let sawMessageStop = false;
  try {
    for await (const data of parseSseStream(res.body)) {
      let parsed: AnthropicFrame;
      try { parsed = JSON.parse(data) as AnthropicFrame; } catch { continue; }
      if (parsed.type === 'message_start') {
        if (parsed.message?.usage) sawUsage = true;
        tokensIn = parsed.message?.usage?.input_tokens ?? tokensIn;
        tokensOut = parsed.message?.usage?.output_tokens ?? tokensOut;
        const m = parsed.message?.model;
        if (typeof m === 'string' && m.length > 0) served = m;
      } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string' && parsed.delta.text.length > 0) {
        // Only text_delta reaches `full`. A stream may open with a `thinking`
        // block (thinking_delta / signature_delta) — reasoning, never output.
        full += parsed.delta.text;
        yield { kind: 'delta', text: parsed.delta.text };
      } else if (parsed.type === 'message_delta') {
        if (parsed.usage) sawUsage = true;
        tokensOut = parsed.usage?.output_tokens ?? tokensOut;
        const sr = parsed.delta?.stop_reason;
        if (typeof sr === 'string' && sr.length > 0) stopReason = sr;
      } else if (parsed.type === 'error') {
        return void (yield { kind: 'error', ...mapStreamError(parsed.error), ...reportedUsage(), finish_reason: telemetryFinishReason(stopReason) });
      } else if (parsed.type === 'message_stop') {
        sawMessageStop = true;
        break;
      }
    }
  } catch (err) {
    yield { kind: 'error', code: 'LLM_TIMEOUT', message: (err as Error)?.message ?? 'stream read failed', ...reportedUsage(), finish_reason: telemetryFinishReason(stopReason) };
    return;
  }

  // A body that closes without `message_stop` was cut off in transit — the
  // same partial-success shape as a mid-stream error, so the same loud answer.
  if (!sawMessageStop) {
    return void (yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'anthropic stream ended before message_stop', ...reportedUsage(), finish_reason: telemetryFinishReason(stopReason) });
  }
  if (stopReason !== null && !COMPLETE_STOP_REASONS.has(stopReason)) {
    return void (yield { kind: 'error', ...incompleteStop(stopReason), ...reportedUsage(), finish_reason: telemetryFinishReason(stopReason) });
  }

  const usage: LlmUsage = { tokens_in: tokensIn, tokens_out: tokensOut };
  yield { kind: 'done', full, usage, ...(served !== undefined ? { model: served } : {}), finish_reason: telemetryFinishReason(stopReason) };
}

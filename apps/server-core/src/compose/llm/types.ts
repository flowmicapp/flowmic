// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (LLM/Compose layer — two protocols
//     cover every provider: openai-compatible + anthropic; node-native fetch)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-4 (LLM client, dual protocol)
//   CLAUDE.md red line: LLM failure → explicit code, never a silent fallback
//
// The streamer contract shared by both protocol implementations. A streamer is
// an async generator that yields `delta` events as text arrives and terminates
// with EXACTLY ONE `done` (carrying the accumulated text + best-effort token
// usage) OR ONE `error` (a whitelisted @flowmic/protocol LLM_* code). A streamer
// NEVER throws — transport/parse failures become an `error` event — and NEVER
// yields the raw input back as output on failure (the red line lives one layer up in
// the orchestrator, which turns an `error` event into a thrown ServerError so
// the handler emits compose:error instead of injecting raw STT text).

import type { LlmConfig } from '@flowmic/protocol';

export type { LlmConfig };

/** Best-effort token accounting parsed off the provider's own stream. Absent
 *  fields stay 0 — the billing layer treats 0 as "unknown / unmetered", never
 *  fabricates a count. */
export interface LlmUsage {
  tokens_in: number;
  tokens_out: number;
}

export interface LlmStreamOpts {
  cfg: LlmConfig;
  /** Stable system prompt (scenario prefix + task template). */
  system: string;
  /** The utterance / draft text — the only per-turn variable. */
  user: string;
  /** Budget/cancel signal; abort surfaces as an LLM_TIMEOUT error event. */
  signal?: AbortSignal;
  /** Injectable fetch (tests). Defaults to node-native globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Deployment environment seam, read by the openai-compatible client to resolve
   * this endpoint's vendor request-body fields (llm/vendor-body.ts). Defaults to
   * process.env, so the four production call sites pass nothing and the
   * mechanism is env-driven end to end; tests hand it a fake env instead of
   * mutating process.env, which keeps the parsing/scoping/allowlist logic under
   * test rather than bypassed by a seam that injects the finished value.
   *
   * ⚠️ The anthropic client deliberately ignores this. A body field allowlisted
   * for the OpenAI-compatible wire shape is not automatically valid on the
   * Messages API (Anthropic's own `thinking` is a different object with required
   * sub-fields), so "extend it to the other protocol for symmetry" would be
   * inventing a contract, not honouring one.
   */
  env?: NodeJS.ProcessEnv;
}

export interface LlmDelta { kind: 'delta'; text: string }
/** GA-12 probe seam: `model` is the model id the PROVIDER echoed back on its own
 *  stream (openai-compatible frame `.model`, anthropic `message_start`
 *  `.message.model`) — NOT the one we asked for. It is the only honest source for
 *  the probe's `model_echoed` dimension: parroting `cfg.model` back would prove
 *  nothing. Absent whenever the provider does not say (→ the UI shows "not provided",
 *  never a fabricated value). Additive + optional: the compose orchestrator
 *  ignores it, so no existing consumer changes. */
export interface LlmDone { kind: 'done'; full: string; usage?: LlmUsage; model?: string }
export interface LlmError { kind: 'error'; code: string; message: string }
export type LlmEvent = LlmDelta | LlmDone | LlmError;

export type LlmStreamer = (opts: LlmStreamOpts) => AsyncGenerator<LlmEvent>;

/** Shared SSE frame reader: yields the joined `data:` payload of each frame
 *  (handles multi-line data continuations + CRLF). Used verbatim by both
 *  protocol files so the transport parsing lives in exactly one place. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = findFrameEnd(buf)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^(\r?\n){1,2}/, '');
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.length > 0) yield data;
    }
  }
}

function findFrameEnd(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

export function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

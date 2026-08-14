// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (one openai-compatible client covers
//     OpenAI/Azure/DeepSeek/Qwen/Ollama/vLLM/LM Studio/LocalAI/Moonshot),
//     §7 (LAN vLLM Qwen3.5-4B at http://100.64.7.179:8000/v1, Bearer EMPTY)
//   Ported streaming/SSE mechanism from legacy compose/llm-protocols/
//     openai-compatible.ts; extended with stream_options.include_usage so the
//     billing layer gets real token counts off the provider's own final frame.
//   CLAUDE.md red line: no silent fallback (transport failure → LlmError, never raw text)
//
// POST {endpoint}/chat/completions with stream:true, parse `data:` SSE frames
// terminated by `data: [DONE]`. HTTP status map: 401/403→LLM_AUTH_FAIL,
// 429→LLM_RATE_LIMITED, other/transport→LLM_TIMEOUT. api_key '' or 'EMPTY'
// (platform sentinel, 06 §4) sends no Authorization header.

import {
  type LlmEvent,
  type LlmStreamOpts,
  type LlmUsage,
  parseSseStream,
  stripTrailingSlash,
} from './types';
import { mergeVendorBody, vendorRequestBody } from './vendor-body';

/**
 * Sampling temperature for every LLM call THAT GOES THROUGH THIS STREAMER.
 *
 * ⚠️ That is narrower than "every LLM call this product makes", which is what an
 * earlier revision of this comment said and which is false: `anthropic.ts` builds
 * its own body with no temperature at all, and `cloud-anthropic-claude` is a
 * shipped BYOK preset (packages/protocol engine-presets), so a user on it still
 * gets the vendor default. Both production lines (DeepSeek, LAN vLLM) come
 * through here, which is why the fix was scoped this way — but the scope is a
 * decision, not a description of totality, and it is logged as an open account
 * in the W2 ledger rather than papered over.
 *
 * 🔴 W2 / FB-5 (owner: a life-or-death line). Until now no temperature was sent
 * at all, so every call inherited the vendor default — 1.0 on OpenAI-compatible
 * servers, i.e. the most exploratory setting available. That is the correct
 * default for a chat assistant and the wrong one for every task in this
 * product: translate, organize, draft_polish, the stt polish pass and the
 * app-scenario classifier are ALL faithfulness tasks. Not one of them is asking
 * the model to invent anything, which is precisely what owner reported it
 * doing — translate mode answering the content-to-be-translated as if it were
 * a question, organize mode going off on its own tangent.
 *
 * MEASURED, not assumed (verify/eval, 226 adversarial cases, this machine
 * dev-pc-a, one run per line per setting):
 *   self-hosted vLLM Qwen3.5-4B   default → 175/226 (77.4%)   t=0 → 195/226 (86.3%)
 *     of which organize            default →  57/84  (67.9%)   t=0 →  70/84  (83.3%)
 *   managed DeepSeek v4-flash     default → 210/226 (92.9%)   t=0 → 210/226 (92.9%)
 *
 * ⚠️ READ THE SECOND LINE BEFORE CITING THE FIRST. The gain is real on the
 * small self-hosted model and is NOT a general result: on the managed line the
 * total is unchanged (translate 92.0→93.2, organize 95.2→92.9 — inside run-to-run
 * noise at n=84, and only one run each). So this constant is not "the fix that
 * made the product faithful"; it is a correct default that helps a weak model
 * measurably and costs a strong one nothing. The independent reason to set it at
 * all is that leaving it unset means the behaviour of every task in this product
 * is decided by whatever each vendor picks today and may change tomorrow.
 *
 * The corpus and the exact commands are in verify/eval/; re-run before trusting
 * these numbers, and replace them rather than adding a second set.
 * ⚠️ An earlier revision of this comment quoted 64.2% → 74.3%. Those came from a
 * run whose harness passed camelCase field names to renderSystemPrompt, which
 * takes snake_case, so every translate case rendered as "from auto to en" and
 * the 12 en→zh cases were scored for not producing Chinese they were never asked
 * for. Corrected here rather than left as a second, plausible set of numbers.
 *
 * WHY IT IS SAFE TO PUT ON THE WIRE, when `thinking` needed a whole
 * endpoint-scoped seam to carry it: `temperature` is part of the OpenAI chat
 * completions request that every compatible server implements — vLLM, Ollama,
 * LM Studio, LocalAI, DeepSeek. The risk vendor-body.ts exists to contain is an
 * UNRECOGNISED field drawing a legitimate 400; this is not one.
 *
 * 🔴 THERE IS CURRENTLY NO SUPPORTED WAY FOR A DEPLOYMENT TO OVERRIDE THIS, and
 * an earlier revision of this comment said there was. It claimed
 * FLOWMIC_LLM_VENDOR_BODY would do it, on the grounds that `temperature` is not
 * in PROTECTED_BODY_KEYS. That is true and irrelevant: vendor-body.ts also has an
 * ALLOWLIST (`ALLOWED_VENDOR_KEYS` = thinking / reasoning_effort /
 * chat_template_kwargs) and rejects everything else. Worse, that validation runs
 * BEFORE the endpoint compare — deliberately, so a typo fails loudly — so an
 * operator following the old advice would have thrown on EVERY LLM call, of
 * every kind, surfacing as LLM_INVALID_MODEL: a code that names the model when
 * the problem is the env. The advice would have taken the product's LLM offline
 * and pointed the operator at the wrong thing.
 *
 * If a deployment genuinely needs another value, the change is to add
 * `temperature` to ALLOWED_VENDOR_KEYS — a real decision, argued in that file's
 * header, not a config someone can already reach today.
 */
const FAITHFULNESS_TEMPERATURE = 0;

interface OaiStreamFrame {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** GA-12: the model the SERVER says it served (vLLM/Ollama routinely rename or
   *  alias). Carried out on `done.model` for the probe's model_echoed dimension. */
  model?: string;
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // 'EMPTY' is the platform-endpoint sentinel (06 §4) — a placeholder, not a
  // credential; sending it as a Bearer would be wrong. Empty string likewise.
  if (apiKey && apiKey.length > 0 && apiKey !== 'EMPTY') headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function mapHttpStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) return { code: 'LLM_AUTH_FAIL', message: `openai-compatible http ${status}` };
  if (status === 429) return { code: 'LLM_RATE_LIMITED', message: `openai-compatible http ${status}` };
  return { code: 'LLM_TIMEOUT', message: `openai-compatible http ${status}` };
}

function usageOf(frame: OaiStreamFrame): LlmUsage | undefined {
  if (!frame.usage) return undefined;
  return { tokens_in: frame.usage.prompt_tokens ?? 0, tokens_out: frame.usage.completion_tokens ?? 0 };
}

export async function* streamOpenAiCompatible(opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${stripTrailingSlash(opts.cfg.endpoint)}/chat/completions`;

  // Deployment-declared vendor fields for THIS endpoint (vendor-body.ts). Off by
  // default: with the env unset the merge below is the identity, so the four keys
  // and their insertion order are exactly what shipped before that file existed.
  // A misconfigured env throws there — turned into an error EVENT here, never a
  // throw, because the streamer contract (types.ts) is that a streamer never
  // throws and never falls back.
  let vendor: Record<string, unknown> | undefined;
  try {
    vendor = vendorRequestBody(opts.cfg.endpoint, opts.env);
  } catch (err) {
    yield { kind: 'error', code: 'LLM_INVALID_MODEL', message: (err as Error)?.message ?? 'invalid vendor request body' };
    return;
  }

  const body = JSON.stringify(mergeVendorBody({
    model: opts.cfg.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: FAITHFULNESS_TEMPERATURE,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  }, vendor));

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
  let usage: LlmUsage | undefined;
  let served: string | undefined;
  try {
    for await (const frame of parseSseStream(res.body)) {
      if (frame === '[DONE]') break;
      let parsed: OaiStreamFrame;
      try { parsed = JSON.parse(frame) as OaiStreamFrame; } catch { continue; }
      if (served === undefined && typeof parsed.model === 'string' && parsed.model.length > 0) served = parsed.model;
      const u = usageOf(parsed);
      if (u) usage = u; // usage frame arrives with empty choices, at/near the end
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        full += delta;
        yield { kind: 'delta', text: delta };
      }
    }
  } catch (err) {
    yield { kind: 'error', code: 'LLM_TIMEOUT', message: (err as Error)?.message ?? 'stream read failed' };
    return;
  }

  yield {
    kind: 'done',
    full,
    ...(usage ? { usage } : {}),
    ...(served !== undefined ? { model: served } : {}),
  };
}

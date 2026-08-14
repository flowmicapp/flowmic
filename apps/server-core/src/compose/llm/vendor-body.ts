// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (ONE openai-compatible client covers
//     OpenAI/Azure/DeepSeek/Qwen/Ollama/vLLM/LM Studio/LocalAI/Moonshot — which
//     is exactly why a vendor-specific body field cannot simply be hardcoded),
//     §7 (the SEEDED default config is a LAN vLLM Qwen3.5-4B)
//   docs/strategy/2026-08-06-engine-switch-execution-brief.md §5-1 ("thinking
//     off passes through (openai-compatible.ts request body gains a controlled
//     field) — the only code that must change; zero protocol changes
//     (openai-compatible enum already covers it)")
//   docs/strategy/2026-07-31-qwen35-vs-deepseek-v4-flash-eval.md §3.6 【measured】
//     DeepSeek defaults thinking=ON; one thinking turn burns 2k–3k reasoning
//     tokens against a few dozen completion tokens non-thinking, and its p50
//     already sits at ~700 ms against the 800 ms compose/polish budget floor.
//   apps/server-core/src/compose/llm-config.ts managedLlmConfig() — the sibling
//     env resolver whose shape this one mirrors: explicit opt-in, and
//     switched-on-but-invalid is fail-loud, never a silent skip.
//
// A CONTROLLED seam for vendor-specific fields on the openai-compatible request
// body. It exists for exactly one product need — forcing DeepSeek's thinking mode
// OFF on the managed cloud relay — and is deliberately too narrow to be used for
// anything else.
//
// 🔴 WHY THIS IS NOT AN ARBITRARY PASSTHROUGH ("merge whatever JSON the config
// carries into the body"). The request body is a contract, not a bag, and four of
// its keys are load-bearing for things a settings row / env line has no business
// deciding:
//   • `stream`         — flip it to false and parseSseStream sees one JSON
//                        document, yields zero frames, and the turn ends as an
//                        EMPTY SUCCESS. That is the red-line case (no silent
//                        failure), and
//                        it would look like a model quality problem, not a config
//                        problem.
//   • `stream_options` — drop `include_usage` and the billing layer silently
//                        meters every managed turn as 0/0 tokens.
//   • `model`          — overwrite it and `done.model` (the GA-12 model_echoed
//                        dimension, whose whole point is to be the PROVIDER'S
//                        answer) starts corroborating a value we injected.
//   • `messages`       — overwrite it and the scenario/dictionary pipeline output
//                        is discarded with no error anywhere.
// So the seam is an ALLOWLIST of thinking/reasoning controls, plus a second,
// independent protected-key latch at the merge site ([mergeVendorBody]) that
// still holds if somebody later widens the allowlist without reading this.
//
// 🔴 WHY THE DEFAULT MUST BE ABSENT — not `false`, not `{}`, ABSENT. The two
// failure directions are not symmetric:
//   • field present where it is not understood → an OpenAI-compatible server is
//     entitled to reject the whole request. vLLM / Ollama / LM Studio / LocalAI
//     all sit behind this same client (06 §6) and the SEEDED default config is a
//     LAN vLLM ⇒ a body field added unconditionally risks a 400 on EVERY turn for
//     the working majority, to fix the new minority.
//   • field absent where it would have helped → DeepSeek thinks; slower and more
//     expensive, but the product still works.
// ⇒ unset env ⇒ this module returns `undefined` ⇒ the request body is
// BYTE-IDENTICAL to the one shipped before this file existed. That is not a claim
// to be taken on trust: compose-llm-protocols.test.ts pins the default body as a
// literal string, so any reordering or stray key fails there.
//
// 🔴 WHY THE SCOPE IS AN ENDPOINT AND NOT PROVENANCE ('managed-default' vs
// 'user'). A vendor body is a property of the VENDOR API being spoken to, not of
// whose key pays for it. `thinking:{type:'disabled'}` is correct for
// api.deepseek.com whether the key is ours or a user's own DeepSeek key, and is
// wrong for a self-hosted vLLM no matter who enabled it. Keying on provenance
// would get BOTH cases backwards. Endpoint equality is also exact — a string
// compare, not an inference — which is why this can be resolved inside the
// streamer and therefore covers all four call sites (compose/orchestrator.ts,
// compose/scenario-infer-store.ts, stt/stt-polish.ts, http/probe-routes.ts)
// without one of them being quietly left out.

import { stripTrailingSlash } from './types';

/** Env: the extra request-body fields, as a JSON object string. Unset or empty
 *  ⇒ the whole mechanism is off. */
export const VENDOR_BODY_ENV = 'FLOWMIC_LLM_VENDOR_BODY';

/** Env: the ONE endpoint those fields apply to. Defaults to
 *  FLOWMIC_MANAGED_LLM_ENDPOINT so the ordinary managed deployment only has to
 *  set VENDOR_BODY_ENV. Set explicitly only when the vendor body belongs to an
 *  endpoint that is not the managed default. */
export const VENDOR_BODY_ENDPOINT_ENV = 'FLOWMIC_LLM_VENDOR_BODY_ENDPOINT';

/** Read, not written: the scope falls back to the managed endpoint. Named here
 *  rather than imported from llm-config.ts to keep this module free of the
 *  provenance machinery it deliberately does NOT use (see the header). */
const MANAGED_ENDPOINT_ENV = 'FLOWMIC_MANAGED_LLM_ENDPOINT';

/**
 * Keys this seam may never emit, whatever the allowlist says. This is the SECOND
 * latch (the allowlist is the first) and it is the one that survives a future
 * widening of the allowlist by someone who did not read the header. Enforced at
 * the merge site, so it also protects any caller that builds a vendor body some
 * other way.
 */
export const PROTECTED_BODY_KEYS: readonly string[] = ['model', 'messages', 'stream', 'stream_options'];

/**
 * The allowlist, stated as a RULE rather than a list of one vendor's spellings:
 * **keys that steer how the model thinks, never what it is asked or how the
 * answer comes back**. All three are in-repo 【measured】 usages, not guesses —
 * scratch/llm-compare/run.mjs drove real traffic with each:
 *   • `thinking`              DeepSeek official API (`{type:'disabled'|'enabled'}`)
 *   • `reasoning_effort`      DeepSeek supplement run (`'low'`)
 *   • `chat_template_kwargs`  vLLM/Qwen (`{enable_thinking:false}`)
 * Adding a key here is a real decision: it must be provably incapable of changing
 * the model served, the prompt sent, or the transport shape.
 */
export const ALLOWED_VENDOR_KEYS: readonly string[] = ['thinking', 'reasoning_effort', 'chat_template_kwargs'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse + constrain the env JSON. Throws (fail loud) on every rejection — a
 * silently-dropped vendor body is the expensive direction here: DeepSeek would
 * keep thinking, at 2k–3k reasoning tokens a turn, and nothing anywhere would
 * say so. The caller ([streamOpenAiCompatible]) converts the throw into an
 * LLM_INVALID_MODEL event, because the streamer contract (types.ts) is that a
 * streamer never throws.
 */
export function parseVendorBody(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VENDOR_BODY_ENV} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${VENDOR_BODY_ENV} must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  for (const key of Object.keys(parsed)) {
    if (PROTECTED_BODY_KEYS.includes(key)) {
      throw new Error(`${VENDOR_BODY_ENV} may not set the protected request-body key '${key}'`);
    }
    if (!ALLOWED_VENDOR_KEYS.includes(key)) {
      throw new Error(
        `${VENDOR_BODY_ENV} key '${key}' is not allowlisted (allowed: ${ALLOWED_VENDOR_KEYS.join(', ')})`,
      );
    }
  }
  return parsed;
}

/**
 * The extra request-body fields for a call to `endpoint`, or undefined when this
 * deployment declares none for it (the default, and the byte-identical path).
 *
 * Validation runs BEFORE the endpoint compare on purpose: a typo in the env must
 * fail on the first LLM call of any kind, not lie dormant until the one user
 * whose config happens to point at the scoped endpoint speaks.
 */
export function vendorRequestBody(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  const raw = env[VENDOR_BODY_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;

  const scope = env[VENDOR_BODY_ENDPOINT_ENV] ?? env[MANAGED_ENDPOINT_ENV];
  if (scope === undefined || scope.trim().length === 0) {
    // An unscoped vendor body would be sprayed at every OpenAI-compatible server
    // this relay talks to, including users' self-hosted ones. Refusing is the
    // only answer that cannot damage somebody else's working setup.
    throw new Error(
      `${VENDOR_BODY_ENV} is set but no endpoint scope is configured (set ${VENDOR_BODY_ENDPOINT_ENV} or ${MANAGED_ENDPOINT_ENV})`,
    );
  }

  const fields = parseVendorBody(raw);
  if (Object.keys(fields).length === 0) return undefined;
  // Exact compare after normalising the one difference that is genuinely
  // meaningless ('.../v1' vs '.../v1/'). Deliberately NOT case-folded or
  // otherwise "helpfully" normalised: a scope that matches more than the
  // operator typed is the failure this whole module is built to avoid.
  if (stripTrailingSlash(endpoint) !== stripTrailingSlash(scope.trim())) return undefined;
  return fields;
}

/**
 * Merge vendor fields onto a request body, refusing to overwrite a protected key.
 *
 * Key insertion order is preserved for the base object, so an empty/absent vendor
 * body serialises to exactly the bytes the base does — that is what makes the
 * "unchanged by default" claim checkable rather than asserted.
 */
export function mergeVendorBody(
  base: Record<string, unknown>,
  vendor: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (vendor === undefined) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(vendor)) {
    if (PROTECTED_BODY_KEYS.includes(key)) {
      throw new Error(`vendor request body may not overwrite the protected key '${key}'`);
    }
    out[key] = value;
  }
  return out;
}

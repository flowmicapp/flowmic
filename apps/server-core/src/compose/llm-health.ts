// SPEC-REF:
//   apps/server-core/src/stt/pool-health.ts (probeRouteLiveness — the STT-side
//     liveness primitive this mirrors ONE FOR ONE: open the REAL production
//     adapter path, let the provider's own error channel speak, classify a verdict
//     fatal-vs-transient, and send NOTHING that would be billed)
//   docs/strategy/2026-08-06-w1-engine-switch-ledger.md §5 (FB-11: production
//     deliberately does not configure the STT pool ⇒ health probing/auto-failover
//     belongs to a later window; "the switchable half of the two lines" = the env
//     0/1 toggle-back)
//   docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md §2
//     (LLM half: first do config + health + visible usage + an operable
//     primary/backup switch; do not pre-build a whole pool model for two lines —
//     reuse the STT pool's shape once there are more lines)
//   apps/server-core/src/http/probe-routes.ts (probeLlm — the ad-hoc "test
//     connection" probe of a BODY-supplied config. THIS module is its managed-line
//     sibling: it probes the RESOLVED, env-gated managed line, using OUR key from
//     the environment, which no operator should have to paste into a request body.)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//
// LIVENESS of the platform's MANAGED LLM line — the runtime half of "is this line
// usable right now" for the DeepSeek↔LAN backup pair (FB-11, LLM half).
//
// ── 🔴 WHAT THIS IS, AND EXACTLY WHAT IT IS NOT ──────────────────────────────
// It is a MEASUREMENT primitive, not auto-failover and not an ops-console switch.
// §5 deliberately leaves the LLM line WITHOUT a production health/failover
// consumer: there is no LLM pool (the DeepSeek↔LAN switch is the env gate
// FLOWMIC_MANAGED_LLM_ENABLED 0/1 that llm-config.ts already implements), exactly
// as the STT side leaves `probeRouteLiveness` reachable in production only through
// the (prod-off) pool plus the live drill. This is that same primitive for the LLM
// line, and its acceptance is a DRILL (test/llm-line-health-drill.test.ts),
// one-for-one with test/stt-live-drill.test.ts's "real-vs-fake key drill". The PRODUCTION
// consumer — an ops read surface, or an auto-failover selector — is the deferred
// "ops console window" item §5 names, and building it here would need the saas ops surface
// (a cross-account HTTP route + its web-console reader) that this lane may not add.
//
// 🔴 It is therefore exported BY PATH, never re-exported through compose/index.ts.
// A barrel re-export of something no PRODUCTION code calls is the precise façade
// that barrel file's own header warns against; the drill imports it by path, the
// same way compose-llm-protocols.test.ts reaches vendor-body by path.
//
// 🔴 NOTHING IS METERED. This module imports no billing and no usage tracker — the
// import scan in the drill pins that structurally. A health check that spent quota
// would make "liveness probing" a billed activity, the same red line probe-routes.ts carries
// (its invariant #2「NOTHING IS BILLED」) and pool-health.ts carries (its「send NO
// audio, so an open-and-close costs no transcription minutes」).

import type { LlmProtocol } from '@flowmic/protocol';
import { managedLlmConfig } from './llm-config';
import { streamerFor as defaultStreamerFor, type LlmConfig, type LlmStreamer } from './llm';

/**
 * 🔴 The ONE definition of "this LLM line is broken beyond saving".
 *
 * Mirrors pool-health.ts ROUTE_FATAL_CODES, for the same reason it draws the line
 * where it does. These two say "broken for everyone, retrying/waiting won't help" — a wrong platform
 * key (LLM_AUTH_FAIL) or an unusable model/config (LLM_INVALID_MODEL) is broken
 * for every session, so an operator has to act. LLM_RATE_LIMITED and LLM_TIMEOUT
 * are deliberately NON-fatal: waiting or re-dialing can help and the line is
 * otherwise fine, so declaring them dead would evict the platform's primary over a
 * momentary throttle — the exact false-alarm pool-health.ts calls out for 429.
 */
export const LLM_ROUTE_FATAL_CODES: ReadonlySet<string> = new Set<string>([
  'LLM_AUTH_FAIL',
  'LLM_INVALID_MODEL',
]);

export interface LlmLivenessVerdict {
  readonly ok: boolean;
  /** The whitelisted LLM_* code when it failed, else null. */
  readonly code: string | null;
  /** Developer context / the provider's own words. Never shown to a user. */
  readonly message: string;
  /** true ⇒ do not send traffic here until an operator acts. */
  readonly fatal: boolean;
  readonly elapsed_ms: number;
  /** The model id the PROVIDER echoed back (`done.model`), or null when it said
   *  nothing. The same honest source as the probe's `model_echoed` — parroting
   *  `cfg.model` back would prove nothing. */
  readonly model_echoed: string | null;
}

export interface LlmLivenessOptions {
  /** Test seam: the protocol → streamer dispatcher. Production passes nothing. */
  streamerFor?: (protocol: LlmProtocol) => LlmStreamer;
  /** Injectable fetch handed to the streamer (tests / no network dependency). */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** The trivial connectivity turn. Kept identical in spirit to probe-routes.ts
 *  PROBE_SYSTEM/PROBE_USER, but defined LOCALLY rather than imported: http →
 *  compose would invert the layering (probe-routes.ts already depends on
 *  compose/llm). Deliberately trivial so the round trip costs ~nothing at a
 *  metered provider and can never be mistaken for a real compose turn. */
const PROBE_SYSTEM = 'Connectivity probe. Answer with the single word OK.';
const PROBE_USER = 'ping';
const DEFAULT_TIMEOUT_MS = 12_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open ONE LLM config through the real streamer and report what the provider
 * actually did. Never throws — a streamer that somehow throws (its contract says
 * it must not, see compose/llm/types.ts) is still a liveness failure, not an
 * exception to propagate.
 */
export async function probeLlmLiveness(
  cfg: LlmConfig,
  opts: LlmLivenessOptions = {},
): Promise<LlmLivenessVerdict> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const streamer = (opts.streamerFor ?? defaultStreamerFor)(cfg.protocol);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();

  let sawText = false;
  let modelEchoed: string | null = null;
  let error: { code: string; message: string } | null = null;
  try {
    const iter = streamer({
      cfg,
      system: PROBE_SYSTEM,
      user: PROBE_USER,
      signal: controller.signal,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    for await (const ev of iter) {
      if (ev.kind === 'delta') {
        if (ev.text.length > 0) sawText = true;
      } else if (ev.kind === 'done') {
        if (ev.full.length > 0) sawText = true;
        modelEchoed = ev.model ?? null;
      } else {
        error = { code: ev.code, message: ev.message };
      }
    }
  } catch (err) {
    error = { code: 'LLM_PROBE_FAIL', message: messageOf(err) };
  } finally {
    clearTimeout(timer);
  }

  const elapsed_ms = now() - t0;
  if (timedOut) {
    return { ok: false, code: 'LLM_TIMEOUT', message: `no answer within ${timeoutMs}ms`, fatal: false, elapsed_ms, model_echoed: modelEchoed };
  }
  if (error !== null) {
    return { ok: false, code: error.code, message: error.message, fatal: LLM_ROUTE_FATAL_CODES.has(error.code), elapsed_ms, model_echoed: modelEchoed };
  }
  if (!sawText) {
    // 🔴 A `done` with no text is NOT healthy. The line accepted the request and
    // completed the stream, but produced nothing — the「opened ≠ can produce
    // output」trap pool-health.ts's settle window exists to avoid on the STT side.
    // Reporting `ok:true` here would be one value ("the stream completed")
    // answering a different question ("will this line produce a compose turn").
    return { ok: false, code: 'LLM_PROBE_FAIL', message: 'stream completed with no output', fatal: false, elapsed_ms, model_echoed: modelEchoed };
  }
  return { ok: true, code: null, message: '', fatal: false, elapsed_ms, model_echoed: modelEchoed };
}

/**
 * Probe the RESOLVED managed LLM line (env-gated `managedLlmConfig`).
 *
 * Returns `null` when no managed line is configured — the honest "there's no
 * managed line to test", mirroring `managedLlmConfig()` returning null and the STT
 * pool's `resolve()` returning null when nothing is set. A configured-but-dead
 * line returns an `ok:false` verdict instead: "not configured" and "configured but
 * broken" are two different facts and must not collapse into one (one value
 * answers only one question).
 *
 * An ENABLED-but-INVALID env (FLOWMIC_MANAGED_LLM_ENABLED set while PROTOCOL /
 * ENDPOINT / MODEL is missing) is a deploy-time misconfiguration: `managedLlmConfig`
 * throws for it (fail loud), and here that throw is turned into a FATAL verdict
 * rather than propagated — a health probe that answers with an exception is exactly
 * what pool-health.ts (construction failure → fatal verdict) and probe-routes.ts
 * (「a probe NEVER answers 500」) both refuse to do. The fail-loud is NOT lost: every
 * real resolution path (compose/index.ts, stt-factory.ts) calls the resolver
 * directly and still throws.
 */
export async function probeManagedLlmLiveness(
  env: NodeJS.ProcessEnv = process.env,
  opts: LlmLivenessOptions = {},
): Promise<LlmLivenessVerdict | null> {
  let cfg: LlmConfig | null;
  try {
    cfg = managedLlmConfig(env);
  } catch (err) {
    return { ok: false, code: 'LLM_INVALID_MODEL', message: messageOf(err), fatal: true, elapsed_ms: 0, model_echoed: null };
  }
  if (cfg === null) return null;
  return probeLlmLiveness(cfg, opts);
}

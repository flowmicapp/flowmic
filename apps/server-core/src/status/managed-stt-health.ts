// SPEC-REF:
//   docs/strategy/2026-08-13-0263-design-task-book.md §9-1 (managed STT liveness:
//     no existing probe — `stt.pool` is an in-session log, not a probe ⇒ needs a
//     new probe), §9-2.6 (W-5a: STT probe + probe timer + GET /api/status; the
//     probe does not consume real session quota)
//   apps/server-core/src/stt/pool-health.ts (`probeRouteLiveness` — THE liveness
//     primitive this composes; its header carries the settle-window measurement
//     and the 「sends NO audio」 cost argument that make this cheap and honest)
//   apps/server-core/src/compose/llm-health.ts (`probeManagedLlmLiveness` — the
//     LLM-side twin whose SHAPE this copies one for one, including returning
//     `null` for "there is no managed line to probe" and turning a resolver throw into a fatal
//     verdict rather than propagating it)
//   apps/server-core/src/stt/managed-default.ts (`managedDefaultRouting` — the
//     env resolution this asks; the ONE definition of "whether the managed line is configured")
//
// LIVENESS of the platform's MANAGED STT line — the fact §9-1 lists as the only
// one of the three status-page rows with no existing source.
//
// ── 🔴 WHY THIS IS A COMPOSITION AND NOT A NEW PROBE ────────────────────────
// `probeRouteLiveness` already opens the REAL production adapter path, waits out
// a settle window because Soniox refuses IN BAND rather than during the
// handshake, and classifies the verdict. Writing a second, simpler probe here —
// a TLS connect, say — would be the trap that file's header measures in detail:
// three live runs where `open()` resolved 891–1944 ms before a
// `402 organization_balance_exhausted` refusal arrived. A connect-only probe
// reports OK for an account that cannot transcribe a single word. So this file
// resolves WHICH line to probe and delegates HOW to the primitive.
//
// ── 🔴 WHAT A GREEN VERDICT HERE ACTUALLY PROVES, AND WHAT IT DOES NOT ──────
// PROVES: the configured managed route could be constructed, the provider
// accepted the session, and it raised no error within the settle window.
// DOES NOT PROVE: that it will transcribe. No audio is sent (deliberately — see
// the cost note below), so nothing here exercises recognition, and a provider
// that accepts sessions while returning empty finals would read as `up`. It also
// speaks for ONE language ({@link STT_PROBE_LANGUAGE}); a per-language matrix is
// not v1. The status page must therefore be read as "this line can currently
// connect", never as "recognition is good" — two different questions, and this answers the first.
// This gap is NAMED rather than closed because closing it means sending billable
// audio on a timer, which is the one thing §9-2.6 forbids.
//
// ⚠️ NOTHING IS METERED, and it is structural rather than careful: metering
// happens in `SttSessionBridge.settle()` → `recordSttUsage`
// (billing/usage-tracker.ts, each-exactly-1 discipline). This module reaches the engine
// through the FACTORY directly and never builds a session bridge, so there is no
// path from here to the meter. `test/status-probes.test.ts` pins that as an
// import-graph assertion rather than as a promise in a comment.

import { defaultEngineFactory } from '../stt/engine-factory';
import type { EngineFactory, Routing } from '../stt/engine-router';
import { managedDefaultRouting } from '../stt/managed-default';
import { probeRouteLiveness, type LivenessOptions, type LivenessVerdict } from '../stt/pool-health';

/**
 * The language the probe opens with.
 *
 * 🔴 A language has to be CHOSEN, and that choice is a limit on the answer.
 * `managedDefaultRouting` carries `language: '*'` (it is consulted only after the
 * user's own routings miss, so its language is never matched on, only carried),
 * but `configFromRouting` puts whatever is passed here onto the wire — for Soniox
 * that becomes `language_hints` (packages/stt-cloud/src/engines/soniox.ts, symbol
 * `shortLang`). '*' is not a language any provider knows, so passing it through
 * would probe a config no real session ever uses.
 *
 * `'en'` is one of the four the phone can send
 * (`kSpokenLangs = ['zh','en','ja','ko']`). A green verdict therefore speaks for
 * this hint and not for the other three — stated in the header, not implied.
 */
export const STT_PROBE_LANGUAGE = 'en';

export interface ManagedSttProbeOptions extends LivenessOptions {
  /** Test seam. Production takes {@link defaultEngineFactory} — the REAL
   *  production switch, not a friendly stand-in. `pool-health.ts` forbids a
   *  default factory for its registry because a stand-in there would make every
   *  route look alive forever; defaulting HERE is the opposite move, because the
   *  default IS the production path. */
  factory?: EngineFactory;
  language?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe the RESOLVED managed STT line (env-gated `managedDefaultRouting`).
 *
 * Returns `null` when no managed line is configured — the honest "there is no
 * managed line to probe". A configured-but-dead line returns an `ok:false` verdict instead:
 * "not configured" and "configured but broken" are two different facts and the
 * status page renders them as two different words. Collapsing them would be one
 * value answering two questions, and in the direction that hurts: a deployment
 * that simply has no managed STT would be published as an outage.
 *
 * An ENABLED-but-INVALID env (`FLOWMIC_MANAGED_STT_ENABLED` set with a bad
 * `_ENGINE`) is a deploy-time misconfiguration: `managedDefaultRouting` throws
 * for it (fail loud), and here that throw becomes a FATAL verdict rather than
 * propagating — a health probe that answers with an exception is what
 * `pool-health.ts` (construction failure → fatal verdict) and `probe-routes.ts`
 * (「a probe NEVER answers 500」) both refuse to do. The fail-loud is NOT lost:
 * every real resolution path (`loadPool`, `engine-router`) calls the resolver
 * directly and still throws at startup.
 */
export async function probeManagedSttLiveness(
  env: NodeJS.ProcessEnv = process.env,
  opts: ManagedSttProbeOptions = {},
): Promise<LivenessVerdict | null> {
  let routing: Routing | null;
  try {
    routing = managedDefaultRouting(env);
  } catch (err) {
    return { ok: false, code: 'STT_CONFIG_MISSING', message: messageOf(err), fatal: true, elapsed_ms: 0 };
  }
  if (routing === null) return null;
  const { factory = defaultEngineFactory, language = STT_PROBE_LANGUAGE, ...liveness } = opts;
  return probeRouteLiveness(factory, routing, language, liveness);
}

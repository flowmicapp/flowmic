// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (Managed STT hosted default:
//     FLOWMIC_MANAGED_STT_{ENABLED,ENGINE,ENDPOINT,MODEL,API_KEY}; language
//     '*'; is_byok=false counts toward quota; explicit env-gated, NOT an
//     implicit fallback — consulted only after user routings miss)
//   Ported from legacy stt/managed-default.ts (mechanism follows the legacy line, F-2313).
//
// 🔴 T7 correction (card §-0f). The "is_byok=false counts toward quota" clause
// above is quoted from 06 §4 (06-STT-ENGINE-LAYER.md:86-87) and it is CORRECT
// — it is the behaviour contract. What was wrong was this file's own line 39
// + the old BYOK resolver: a keyed managed default
// (FLOWMIC_MANAGED_STT_API_KEY, see below) used to make `resolveByok` answer
// TRUE, so the platform's own traffic was billed as the user's own key and
// counting toward quota silently stopped happening. **The code was the
// deviant, not the contract** ⇒ per the doc-15 discipline the contract was
// NOT edited to match the bug; `engine-factory.ts resolveByok` was fixed to
// ask "whose key is it" instead of "is there a key". Do not re-open this by
// "aligning the doc".
//
// Platform-managed default STT routing. In saas mode a deployment may provision
// a server-reachable model so Free users transcribe out-of-box without per-user
// BYOK. Env-gated + explicit: the engine-router only consults it after the user's
// OWN routings miss, and only when FLOWMIC_MANAGED_STT_ENABLED is set. User/BYOK
// routings always win.
//
// 🔴 「user routings miss」 GOT SHARPER ON 2026-08-06 (0.3.0 W1), and until then it
// was a sentence that could never come true. Every account is born with SEEDED
// routings (settings/defaults.ts writes zh → LAN FunASR and '*' → LAN SenseVoice
// at every boot for every user), and those rows were indistinguishable from rows
// the user had authored ⇒ the user tier never missed ⇒ **this whole module was
// unreachable for every real account**. Seeded rows now carry a provenance marker
// and rank BELOW the managed default (settings/provenance.ts;
// engine-router.ts selectRoutingWithSource). What did not change: a routing the
// USER authored still wins over anything here, unconditionally.

import type { SttEngineId } from '@flowmic/protocol';
import type { Routing } from './engine-router';

/** Card §4 landing point #5. No exhaustive check (a Set cannot have one), but the failure
 *  mode is benign-by-design: a managed engine id that is missing here makes
 *  `FLOWMIC_MANAGED_STT_ENGINE=<it>` throw at startup — loud, immediate, and at
 *  deploy time. `soniox` is admitted for the managed (cloud relay) deployment;
 *  a self-hosted build that sets it will still fail later at
 *  `requireCloudEngine`, also by name, which is the intended H3 behaviour. */
export const VALID_ENGINES = new Set<SttEngineId>([
  'funasr', 'deepgram', 'openai-realtime', 'openai-whisper',
  'custom-openai-compatible', 'funspeech-http', 'sherpa-local', 'soniox',
]);

/**
 * Resolve the platform managed-default routing from the environment, or null
 * when disabled / misconfigured. Shape mirrors a user Routing with
 * `language: '*'` so the engine-router builds it like any other engine.
 * An ENABLED-but-invalid engine id is fail-loud (throws) — never a silent skip.
 */
export function managedDefaultRouting(env: NodeJS.ProcessEnv = process.env): Routing | null {
  const enabled = env.FLOWMIC_MANAGED_STT_ENABLED;
  if (enabled !== '1' && enabled !== 'true') return null;
  const engine_id = env.FLOWMIC_MANAGED_STT_ENGINE as SttEngineId | undefined;
  if (!engine_id || !VALID_ENGINES.has(engine_id)) {
    throw new Error(
      `FLOWMIC_MANAGED_STT_ENABLED set but FLOWMIC_MANAGED_STT_ENGINE is invalid: ${JSON.stringify(engine_id)}`,
    );
  }
  const routing: Routing = { language: '*', engine_id };
  if (env.FLOWMIC_MANAGED_STT_ENDPOINT) routing.endpoint = env.FLOWMIC_MANAGED_STT_ENDPOINT;
  if (env.FLOWMIC_MANAGED_STT_MODEL) routing.model = env.FLOWMIC_MANAGED_STT_MODEL;
  // 🔴 This key is OURS, on OUR account. It is deliberately still copied onto the
  // routing (the engine needs it to connect) — the fix for T7 is NOT to hide the
  // key, it is that provenance travels beside it: `selectRoutingWithSource`
  // stamps `source:'managed-default'` and `resolveByok` refuses to call a
  // platform key BYOK however long it is. See engine-factory.ts resolveByok.
  if (env.FLOWMIC_MANAGED_STT_API_KEY) routing.api_key = env.FLOWMIC_MANAGED_STT_API_KEY;
  return routing;
}

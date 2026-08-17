// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (routing has no implicit fallback —
//     restraint #16: exact-language match → wildcard '*' → managed-default
//     (env-gated) → throw SttConfigMissingError; re-resolved on every
//     audio:start)
//   Ported from legacy stt/engine-router.ts (mechanism follows the legacy line, F-602/#16).
//
// 🔴 0.3.0 W1 correction (2026-08-06): the §4 citation above is kept
// **verbatim** (it is the original text of the behavior contract, not to be
// changed just to accommodate the implementation), but **the implementation's
// order is no longer that**. A layer was inserted in the middle — "who wrote
// this row": the user's own row → managed-default → **the row we seed at
// boot**. The reason is that without that layer, a seeded row is completely
// indistinguishable from a user row, so the managed-default arm becomes
// unreachable for **any account that has ever booted**
// (`settings/provenance.ts` has the full argument and measurement).
// ⚠️ 06 §4 needs to be updated in sync per the "change the doc first, then
// the implementation" discipline — **this card did NOT change that doc**;
// it is recorded honestly in the delivery report, do not treat it as already
// changed.
//
// Per-language STT engine resolution. NO silent fallback. Selection (routing
// pick) is factored into `selectRouting` so the byok/billing resolver and the
// engine constructor share one algorithm.

import type { SttEngineId } from '@flowmic/protocol';
import { isSeedMarked } from '../settings/provenance';
import type { SttEngineConfig, SttEngine } from './engines/base';

/** Routing entry as read from settings `stt.routings` (untyped JSON at rest).
 *  engine_id is the protocol `SttEngineId` union — since WP-R23-0 that includes
 *  the 7th built-in `sherpa-local`. */
export interface Routing {
  language: string;
  engine_id: SttEngineId;
  endpoint?: string;
  api_key?: string;
  model?: string;
  /** SERVER-OWNED provenance marker (`settings/provenance.ts`). `'seed'` ⇒ the
   *  platform seeder wrote this row; ABSENT ⇒ the user authored it. Typed loose
   *  because it arrives as untyped JSON at rest — the real test is `isSeedMarked`,
   *  never a bare truthiness check. Re-derived on every write, so a client cannot
   *  set it. It is deliberately NOT copied into `SttEngineConfig`: it answers
   *  "who wrote it" and an engine has no business asking that. */
  provenance?: string;
}

/** Factory that builds a fresh `SttEngine` for the given engine id + config. */
export interface EngineFactory {
  (id: SttEngineId, cfg: SttEngineConfig): SttEngine;
}

/** Which registered sentence a routing-resolution failure has to be reported as.
 *
 *  🔴 TWO CODES, BECAUSE THERE ARE TWO FACTS (card C1, 2026-08-17). Selection
 *  returning null used to be answered with one code no matter what produced it,
 *  and on the relay that made the user read 「该语言尚未配置识别引擎」 ("no STT
 *  engine has been configured for this language") while several engines were
 *  configured and visible in the pool — the pool had simply refused. The full
 *  argument is at the `STT_POOL_NO_ROUTE` entry in
 *  `packages/protocol/src/error-codes.ts`. */
export type SttRoutingRefusalCode = 'STT_CONFIG_MISSING' | 'STT_POOL_NO_ROUTE';

/** Thrown when no routing matches the requested language and no universal `'*'`
 *  entry (and no managed default) is configured. Surfaced verbatim — there is
 *  NO implicit fallback to a default engine (#16).
 *
 *  🔴 THE CLASS NAME IS NOW NARROWER THAN THE CLASS. It covers every way §4
 *  selection can end in nothing, and [code] is what says WHICH of those it was.
 *  Renaming it would touch six call sites in three files for zero behaviour, and
 *  the name is what every existing `instanceof` test reads — so the honest move
 *  is to say so here rather than to leave a reader inferring 「config missing」
 *  from the identifier. Callers must report [code], never the literal. */
export class SttConfigMissingError extends Error {
  constructor(
    public readonly requested_language: string,
    /** Defaults to the historical code so every existing throw site is
     *  byte-identical in behaviour; only the pool arm passes the other one. */
    public readonly code: SttRoutingRefusalCode = 'STT_CONFIG_MISSING',
  ) {
    // The message is DIAGNOSTIC (it rides `stt:error.message`, which the phone
    // keeps for the diagnostic upload and never renders — the banner uses the
    // phone's own string table). It still has to be true: a pool refusal that
    // says "no STT engine configured" would put the false sentence back on the
    // one surface that survives into a support log.
    super(
      code === 'STT_POOL_NO_ROUTE'
        ? `The platform STT pool had no route for language ${requested_language}`
        : `No STT engine configured for language ${requested_language}`,
    );
    this.name = 'SttConfigMissingError';
  }
}

export interface EngineRouterDeps {
  /** Returns true if the engine id is eligible to serve a new session.
   *  Defaults to `() => true`. */
  engineHealthy?: (id: SttEngineId) => boolean;
  /** Platform-managed default routing (env-gated). null/absent ⇒ no managed
   *  default (preserves the §4 "no silent fallback" behaviour).
   *
   *  🔴 TAKES THE REQUESTED LANGUAGE (A6-3, 2026-08-02). It used to take nothing,
   *  because the one implementation (`managedDefaultRouting`) reads env and the
   *  env has no per-language dimension. The pool does: owner's route rows carry
   *  "the language it fits" and the whole point of the selection algorithm is to filter on it.
   *  A6 §4a is what makes this free — `audio:start` already carries `source_lang`,
   *  so the language is known before the first audio chunk and the resolution
   *  costs zero extra latency.
   *  ⚠️ A zero-arg resolver still satisfies this type (TS ignores extra args), so
   *  every existing caller keeps working unchanged. */
  managedDefault?: (language: string) => Routing | null;
}

export interface EngineRouter {
  pickEngine(language: string, userConfig: readonly Routing[], factory: EngineFactory): SttEngine;
}

/**
 * WHO supplied the selected routing. `'user'` = the user authored this row in
 * their `stt.routings` (so any api_key on it is the USER'S key). `'seed'` = the
 * platform seeder wrote it at boot from the engine presets — it lives in the
 * user's settings but nobody chose it. `'managed-default'` = the platform
 * env-gated fallback, whose api_key is OUR key on OUR account.
 *
 * 🔴 T7 (card §-0f): this distinction is load-bearing for money. Before it existed
 * the BYOK judgement asked "is there a key" instead of "whose key is it", so the moment a
 * platform managed default carried a key (any keyed engine — deepgram today,
 * soniox tomorrow) the platform's own traffic was classified BYOK and BOTH the
 * quota meter and the VAD billing gate silently switched themselves off.
 *
 * 🔴 `'seed'` was added 2026-08-06 (0.3.0 W1) because `'user'` was answering two
 * questions: "this row lives in the user's settings" and "the user chose it". Only the second one should
 * outrank the platform managed default, and conflating them made the managed arm
 * unreachable for every account — the full argument is in
 * `settings/provenance.ts`. For BYOK the two behave identically (neither is the
 * user's key), which is exactly why `resolveByok` tests `!== 'user'` and not
 * `=== 'managed-default'`.
 */
export type RoutingSource = 'user' | 'seed' | 'managed-default';

/** The §4 selection result WITH its provenance. Kept as one object so a caller
 *  physically cannot hold the routing without holding the answer to "who gave it". */
export interface SelectedRouting {
  routing: Routing;
  source: RoutingSource;
}

/**
 * The §4 selection algorithm, engine-construction-free, carrying the provenance
 * out with the routing. Callers that build an engine throw SttConfigMissingError
 * on null; the byok resolver reads BOTH halves.
 *
 * ORDER — AUTHORSHIP FIRST, SPECIFICITY SECOND (0.3.0 W1, 2026-08-06):
 *
 *   1. the user's own exact language match
 *   2. the user's own `'*'`
 *   3. the platform managed default / pool
 *   4. a SEEDED exact language match
 *   5. a SEEDED `'*'`
 *   6. null ⇒ SttConfigMissingError. Still no silent fallback (§4 #16).
 *
 * 🔴 Steps 4–5 used to sit at 1–2, because a seeded row and a user row were the
 * same thing to this function. That made step 3 unreachable for every account that
 * had ever booted (`settings/provenance.ts` header). The rows the platform seeded
 * are now the FALLBACK LINE they were always meant to be: they still serve when no
 * managed default is configured — which is every self-hosted build and every
 * deployment with `FLOWMIC_MANAGED_STT_ENABLED` off — and they step aside when one
 * is.
 *
 * 🔴 What did NOT change, and must not: a row the USER authored still outranks the
 * managed default, unconditionally. Making the platform's engine outrank a user's
 * own choice is forbidden; the fix here was to stop MISTAKING our own rows for
 * theirs. Classification, not precedence.
 *
 * ⚠️ Authorship dominates specificity ACROSS tiers, and that is a real behaviour
 * change worth knowing: a user's `'*'` row now beats a SEEDED `zh` row when the
 * language is Chinese, where before the seeded `zh` won on specificity. "The user
 * said to use X for all languages" is a choice; "we dropped in a zh row at
 * boot" is not. Within a tier the old
 * exact-then-wildcard order is untouched.
 *
 * ⚠️ A routing with no marker is `'user'`. That is the safe direction — with no
 * markers anywhere (an un-backfilled database, or any caller passing a hand-built
 * array, which is what every unit test does) this function behaves EXACTLY as it
 * did before.
 */
export function selectRoutingWithSource(
  language: string,
  userConfig: readonly Routing[],
  managedDefault?: (language: string) => Routing | null,
  engineHealthy: (id: SttEngineId) => boolean = () => true,
): SelectedRouting | null {
  const pick = (rows: readonly Routing[]): Routing | undefined => {
    const exact = rows.find((c) => c.language === language);
    if (exact && engineHealthy(exact.engine_id)) return exact;
    const universal = rows.find((c) => c.language === '*');
    if (universal && engineHealthy(universal.engine_id)) return universal;
    return undefined;
  };
  const authored = pick(userConfig.filter((c) => !isSeedMarked(c)));
  if (authored) return { routing: authored, source: 'user' };
  const managed = managedDefault?.(language);
  if (managed && engineHealthy(managed.engine_id)) return { routing: managed, source: 'managed-default' };
  const seeded = pick(userConfig.filter((c) => isSeedMarked(c)));
  if (seeded) return { routing: seeded, source: 'seed' };
  return null;
}

/**
 * Provenance-dropping view of `selectRoutingWithSource`, for the call sites that
 * only need to CONSTRUCT an engine (pickEngine) — those do not judge billing.
 * ⚠️ Anything that answers a billing/quota question must call
 * `selectRoutingWithSource` instead: this one cannot tell you whose key it is.
 */
export function selectRouting(
  language: string,
  userConfig: readonly Routing[],
  managedDefault?: (language: string) => Routing | null,
  engineHealthy: (id: SttEngineId) => boolean = () => true,
): Routing | null {
  return selectRoutingWithSource(language, userConfig, managedDefault, engineHealthy)?.routing ?? null;
}

/** Build the engine config handed to the factory. Stamps the requested language
 *  plus the fixed 16 kHz mono PCM sample rate (06 §1). */
export function configFromRouting(routing: Routing, language: string): SttEngineConfig {
  const cfg: SttEngineConfig = { id: routing.engine_id, language, sample_rate: 16_000 };
  if (routing.endpoint !== undefined) cfg.endpoint = routing.endpoint;
  if (routing.api_key !== undefined) cfg.api_key = routing.api_key;
  if (routing.model !== undefined) cfg.model = routing.model;
  return cfg;
}

/** Construct a router. The §4 algorithm is applied fresh per `pickEngine` call
 *  against the supplied `userConfig` snapshot — settings are re-resolved per
 *  session so updates take effect on the next audio:start. */
export function makeEngineRouter(deps: EngineRouterDeps = {}): EngineRouter {
  const engineHealthy = deps.engineHealthy ?? (() => true);
  return {
    pickEngine(language, userConfig, factory): SttEngine {
      const routing = selectRouting(language, userConfig, deps.managedDefault, engineHealthy);
      if (!routing) throw new SttConfigMissingError(language);
      return factory(routing.engine_id, configFromRouting(routing, language));
    },
  };
}

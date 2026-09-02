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
// The region-strip THIS repo already had, reused rather than re-derived. It is
// the same function the batch HTTP engines hand to their vendors, so a tag that
// routes to an engine and the tag that engine is asked to transcribe cannot
// disagree about what 「zh-CN」 means. `sherpa/model-catalog.ts baseLang()` is a
// third spelling of the same idea and is deliberately NOT imported here: it
// drags the whole model catalog into the router, and a router has no business
// knowing what packs exist.
import { toShortLang } from './engines/wav';

/** The catch-all routing language. Named because the normalisation rung below
 *  has to EXCLUDE it explicitly: `'*'.split('-')[0]` is `'*'`, so a wildcard row
 *  would otherwise match at the normalised rung and be promoted above the
 *  managed default — pinned by a control case in
 *  test/stt-routing-region-normalisation.test.ts. */
const WILDCARD_LANGUAGE = '*';

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
/** 🔴 THREE, since 2026-08-17 (owner grant). `STT_LANGUAGE_UNSUPPORTED` is the
 *  third fact and the only one where a route WAS found: the engine exists, was
 *  selected, and its model cannot recognise the language. The other two are both
 *  「nothing was selected」 — one because nothing is configured, one because the
 *  platform pool refused. Three actions, three codes; the full argument for each
 *  fold is at the registry entries in `packages/protocol/src/error-codes.ts`. */
export type SttRoutingRefusalCode =
  | 'STT_CONFIG_MISSING'
  | 'STT_POOL_NO_ROUTE'
  | 'STT_LANGUAGE_UNSUPPORTED';

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
function messageFor(code: SttRoutingRefusalCode, language: string): string {
  switch (code) {
    case 'STT_POOL_NO_ROUTE':
      return `The platform STT pool had no route for language ${language}`;
    case 'STT_LANGUAGE_UNSUPPORTED':
      // Names the selection AND the mismatch: a support log that only said
      // 「unsupported」 would leave the reader unable to tell this from
      // 「nothing was selected」, which is the whole reason the code was minted.
      return `The selected STT engine cannot recognise language ${language}`;
    case 'STT_CONFIG_MISSING':
      return `No STT engine configured for language ${language}`;
  }
}

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
    // ⚠️ A switch, not a ternary chain, and exhaustive on the union: a fourth
    // code added without a message here would otherwise silently inherit the
    // 「no STT engine configured」 sentence — the exact drift this whole class
    // of comment exists to prevent, on the one surface that reaches a support
    // log.
    super(messageFor(code, requested_language));
    this.name = 'SttConfigMissingError';
  }
}

export interface EngineRouterDeps {
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
 *
 * 🔴 2026-08-27 (owner ruling section 2-2): each tier's rungs are now
 * EXACT → REGION-NORMALISED → `'*'`, where the normalisation strips the region
 * from BOTH the requested tag and the row's. Before this, the comparison was raw
 * string equality, and the desktop's own placeholder row was authored as `zh-CN`
 * while the phone announces `zh` and the seeder writes `zh` — so a row the user
 * could see on their settings page could not be selected by anything they said.
 * It fell through to their `'*'`, or threw. One question ("what language is
 * this") answered in two vocabularies by a layer that held both.
 *
 * ⚠️ THE RUNG IS INSIDE A TIER, NOT ACROSS TIERS, and that placement is the whole
 * of the compatibility argument: a user's normalised row still beats a seeded
 * exact row, exactly as a user's exact row did. Hoisting normalisation above the
 * authorship split would have quietly reversed the 2026-08-06 provenance ruling
 * as a side effect of a language-matching fix.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT FUZZIER THAN THIS. `ja` does not reach a `zh`
 * row; the only tags that meet are ones sharing a base subtag. Over-eager
 * normalisation is a worse defect than the one it fixes — the user gets fluent,
 * confident, wrong text from an engine that cannot hear their language, instead
 * of an error that names the problem. `zh-TW` meeting `zh-CN` is the owner's
 * explicit intent (簡體/繁體 is one SPOKEN language), not a side effect.
 *
 * 🔴 card P2-5/WP-1 (2026-09-02) — a fourth per-candidate `engineHealthy`
 * predicate used to sit here too. DELETED: the only production call site
 * (`engine-factory.ts` `makeEngineRouter({ managedDefault })`) never supplied
 * one, so it was permanently `() => true` in every real session — a health
 * check nobody wired, this repo's #1 historical bug shape (「定义了没人调用的能力」).
 * Route-level health is a SOLVED, DIFFERENT problem: `pool-routing.ts`
 * `resolve()` already filters candidates through `RouteHealthRegistry` before
 * a `Routing` ever reaches this function, so a genuinely unhealthy managed
 * route is excluded upstream, not here. This parameter was a second, orphaned
 * answer to a question `pool-health.ts` already owns.
 */
export function selectRoutingWithSource(
  language: string,
  userConfig: readonly Routing[],
  managedDefault?: (language: string) => Routing | null,
): SelectedRouting | null {
  const wanted = toShortLang(language.trim());
  const pick = (rows: readonly Routing[]): Routing | undefined =>
    rows.find((c) => c.language === language) ??
    rows.find((c) => c.language !== WILDCARD_LANGUAGE && toShortLang(c.language.trim()) === wanted) ??
    rows.find((c) => c.language === WILDCARD_LANGUAGE);
  const authored = pick(userConfig.filter((c) => !isSeedMarked(c)));
  if (authored) return { routing: authored, source: 'user' };
  const managed = managedDefault?.(language);
  if (managed) return { routing: managed, source: 'managed-default' };
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
): Routing | null {
  return selectRoutingWithSource(language, userConfig, managedDefault)?.routing ?? null;
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
  return {
    pickEngine(language, userConfig, factory): SttEngine {
      const routing = selectRouting(language, userConfig, deps.managedDefault);
      if (!routing) throw new SttConfigMissingError(language);
      return factory(routing.engine_id, configFromRouting(routing, language));
    },
  };
}

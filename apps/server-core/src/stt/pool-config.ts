// SPEC-REF:
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §-0d (route fields),
//     §-0e (two-layer parsing), §-0f tail (production strategy = priority + health failover)
//   docs/decisions/2026-08-02-owner-stt-pool-groups-and-ops-phase1-scope.md
//     (owner ②③: applicable region = who is served; custom groups are a real
//      first-phase feature; the first Soniox route's initial config = all regions + all languages)
//   apps/server-core/src/pool/select-route.ts (the algorithm this feeds)
//
// WHERE THE POOL COMES FROM, THIS ROUND.
//
// 🔴 NOT from the database. The pool schema (A6-2) is still a document AWAITING REVIEW and
// a DB migration is one of this repo's four human-review gates; inventing a table
// here would put a schema into production ahead of that review. So the source is
// configuration, exactly like every other deployment fact on the relay
// (`/etc/flowmic-app/env`). When the ops console lands (O-7) it writes rows and
// THIS file is what changes — nothing downstream of it has to.
//
// ⚠️ The honest consequence: a route's `health` column is CONFIG here, not a
// measurement. Live liveness is a separate input (`pool-health.ts`) fed into
// `selectRoute`'s `isAvailable` seam. Two questions, two values.

import type { SttEngineId } from '@flowmic/protocol';
import {
  LANGUAGE_ANY, REGION_ANY,
  type PoolRoute, type RouteHealth, type RouteRole,
} from '../pool/select-route';
import type { Routing } from './engine-router';
import { managedDefaultRouting, VALID_ENGINES } from './managed-default';
import { isStreamingEngine } from './streaming-engines';

/** Inline JSON array of pool rows. Absent ⇒ the managed default (if any) is
 *  wrapped as a ONE-ROUTE pool — see {@link loadPool}. */
export const POOL_ENV = 'FLOWMIC_STT_POOL';
/** The group a connection with no entitlement of its own lands in. DATA, not an
 *  enum: owner ruled "'production'/'test' are only examples", so no group name is written in code
 *  except this configurable default. */
export const POOL_DEFAULT_GROUP_ENV = 'FLOWMIC_STT_POOL_DEFAULT_GROUP';
/* 🔴 THERE IS DELIBERATELY NO `FLOWMIC_STT_POOL_REGION`.
 * `RouteRequest.region` is PINNED to {@link REGION_ANY} this round —
 * `docs/strategy/2026-08-02-o5-pool-schema-final.md` §2-S3, and the reason is
 * mechanical rather than conservative: `packages/protocol` has NO region field
 * at all [measured: `grep -rn "region" packages/protocol/src/*.ts` → zero lines], so the
 * server cannot derive one. A knob here would let an operator set a request
 * region that nothing on the wire agrees with, and `tierOf` uses `===`, so the
 * mismatch would EXCLUDE routes rather than rank them — silently.
 * Restore the knob only together with a real wire source. */

export const DEFAULT_GROUP_ID = 'default';
/** Route id of the synthesized single-route pool. Named, not anonymous, so a
 *  forensic line saying `ranked_route_ids:['managed-default']` reads as
 *  "the pool only has this one managed-default route" rather than as a mystery. */
export const MANAGED_DEFAULT_ROUTE_ID = 'managed-default';

/** A pool row AS CONFIGURED — i.e. {@link PoolRoute} plus the secret. */
export interface PoolRouteConfig {
  id: string;
  group_id?: string;
  /** 🔴 The engine id. Named `provider` to match owner's field list (§-0d);
   *  validated against the `SttEngineId` union at parse time so a typo is a
   *  startup error, not a runtime `UnknownSttEngineId` mid-utterance. */
  provider: SttEngineId;
  model?: string;
  /** Endpoint. Maps onto `Routing.endpoint`. */
  api?: string;
  region?: string;
  languages?: string[];
  role?: RouteRole;
  enabled?: boolean;
  priority?: number;
  unit_price?: number;
  health?: RouteHealth;
  capacity?: number;
  /** Optional override; defaults to {@link isStreamingEngine} for the provider —
   *  which is the one place this repo already answers "can this engine stream". */
  streaming?: boolean;
  /** 🔴 SECRET. Stripped before the row is handed to `selectRoute`: that
   *  function's own doc says selection never needs the credential, and a
   *  function that cannot see a secret cannot log it. */
  api_key?: string;
}

export interface LoadedPool {
  /** Non-secret projection — the ONLY thing `selectRoute` ever sees. */
  readonly pool: readonly PoolRoute[];
  /** Route id → engine config needed to actually connect. */
  readonly routingOf: (routeId: string) => Routing | null;
  readonly defaultGroupId: string;
  readonly region: string;
  /**
   * Where the pool came from. 🔴 Load-bearing, not decoration:
   *   'pool-env'        — an operator configured routes ⇒ liveness probing and
   *                       failover are ON.
   *   'managed-default' — no pool configured; the single env-gated managed
   *                       default was wrapped so `selectRoute` still runs (and
   *                       so `ranked_route_ids.length === 1` shows up in
   *                       forensic as the degenerate case it is). Probing stays
   *                       OFF — with one route there is nothing to fail over to,
   *                       and refusing would replace the provider's real error
   *                       with "no recognition engine has been configured for this language yet", which is false.
   *   'none'            — nothing configured; the managed layer is absent, as
   *                       before.
   */
  readonly source: 'pool-env' | 'managed-default' | 'none';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const VALID_ROLES: ReadonlySet<string> = new Set(['primary', 'backup']);

/** SSOT §2-S2: `'*'` or a LOWERCASE ISO-3166-1 alpha-2 code. */
function isLegalRegion(v: string): boolean {
  return v === REGION_ANY || /^[a-z]{2}$/.test(v);
}

/**
 * 🔴 SSOT §2-S5 SAYS SOMETHING ELSE AND IT IS WRONG — registered, not silently
 * followed.
 *
 * That section pins the `languages` whitelist to "`'*'` + the tokens
 * `engine-presets.ts` uses for `language_hint`", i.e. `'zh-CN'`. But the value
 * `selectRoute` matches against is `audio:start.source_lang`, whose vocabulary is
 * BARE ISO 639-1:
 *   · `apps/mobile/lib/src/settings/app_settings.dart`
 *     `kSpokenLangs = ['zh','en','ja','ko']` — the only values a phone sends;
 *   · `apps/server-core/src/settings/defaults.ts` — the `routingFromPreset('zh', …)`
 *     / `routingFromPreset('*', …)` call pair — bare, too;
 *   · `language_hint` has ZERO runtime consumers [measured via grep: the only reads are
 *     one protocol test assertion; the desktop's `set_prefs_language_hint` is an
 *     unrelated UI string].
 * ⇒ A pool row written `'zh-CN'` would be excluded for every real request, in
 * EXACTLY the silent way §2-S1 warns about for `region: null` — one section
 * apart. So this validator pins the token space the WIRE actually uses and the
 * divergence is reported upward rather than implemented.
 */
function isLegalLanguage(v: string): boolean {
  return v === LANGUAGE_ANY || /^[a-z]{2,3}$/.test(v);
}
const VALID_HEALTH: ReadonlySet<string> = new Set(['healthy', 'degraded', 'down']);

/**
 * Parse one configured row into (non-secret projection, connect config).
 *
 * Fail-loud on anything malformed: a pool row that silently defaults its
 * `provider` or drops its `languages` is a route that will be selected for
 * traffic it cannot serve, and nothing downstream can tell that from a
 * deliberate configuration. Same paradigm as `managed-default.ts`
 * (ENABLED-but-invalid throws at startup).
 */
function parseRow(raw: unknown, index: number, defaultGroup: string): { route: PoolRoute; routing: Routing } {
  const at = `${POOL_ENV}[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} is not an object`);
  }
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  if (id === undefined) throw new Error(`${at}.id is required and must be a non-empty string`);
  const provider = str(r['provider']);
  if (provider === undefined) throw new Error(`${at}.provider is required (an SttEngineId)`);
  // 🔴 A REAL membership check, against the SAME set `managedDefaultRouting`
  // guards its env with — not a cast. `SttEngineId` is a compile-time union with
  // no runtime list, so `provider as SttEngineId` would type-check and then blow
  // up per-utterance as `UnknownSttEngineId` deep inside a recording. This is
  // the RV-newA shape (a hand-written narrowing is an assertion the compiler does
  // not check), so the assertion is executed instead of written.
  if (!VALID_ENGINES.has(provider as SttEngineId)) {
    throw new Error(
      `${at}.provider ${JSON.stringify(provider)} is not a known SttEngineId `
      + `(one of: ${[...VALID_ENGINES].join(', ')})`,
    );
  }
  const engine_id = provider as SttEngineId;

  // 🔴 REGION (SSOT §2-S1/S2). `null` is NOT a legal spelling of "unrestricted": `tierOf`
  // compares with `===`, so `null` matches neither the request nor REGION_ANY and
  // the whole route is EXCLUDED — "serves everyone" configured, "serves nobody" executed.
  // Refusing it by name is the only way that stays visible; coercing it to '*'
  // would let both spellings live on, which is the thing the SSOT exists to kill.
  if (r['region'] === null) {
    throw new Error(`${at}.region is null — "unrestricted" is spelled '${REGION_ANY}'; null makes the route silently unselectable (SSOT §2-S1)`);
  }
  const regionRaw = str(r['region']) ?? REGION_ANY;
  if (!isLegalRegion(regionRaw)) {
    throw new Error(
      `${at}.region ${JSON.stringify(regionRaw)} is not legal — must be '${REGION_ANY}' or a LOWERCASE `
      + `ISO-3166-1 alpha-2 code (SSOT §2-S2; 'CN' !== 'cn' under tierOf's === and both look legal)`,
    );
  }
  // 🔴 AND THE ONE THAT BITES TODAY (SSOT §2-S3): the request side is pinned to
  // '*', so ANY concrete region here makes this route unselectable — excluded,
  // not deprioritised. owner's "the first Soniox route = all regions" is therefore not merely a
  // conservative default, it is the only value that can be chosen at all today.
  // ⚠️ The next person who types 'us' gets a silently dead route. Refusing here
  // is deliberate: a dead route that parses looks exactly like a live one.
  if (regionRaw !== REGION_ANY) {
    throw new Error(
      `${at}.region ${JSON.stringify(regionRaw)} can never be selected: the request side has no region source `
      + `(zero region fields in packages/protocol), so requests are pinned to '${REGION_ANY}' and tierOf `
      + `excludes any route with a concrete region (SSOT §2-S3). Use '${REGION_ANY}' until a wire source exists.`,
    );
  }

  const languagesRaw = r['languages'];
  // 🔴 A hand-written narrowing is a claim the compiler does not check (RV-newA).
  // So the elements are filtered by an explicit typeof and the RESULT is
  // required to be non-empty — the failure mode that rule warns about is "the array
  // is forever empty", and an empty `languages` here would make the route match nothing while
  // looking configured.
  const languages = Array.isArray(languagesRaw)
    ? languagesRaw.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [LANGUAGE_ANY];
  if (languages.length === 0) {
    throw new Error(`${at}.languages is present but contains no usable string (owner §-0d: "suitable" languages, may be ['${LANGUAGE_ANY}'])`);
  }
  for (const tag of languages) {
    if (!isLegalLanguage(tag)) {
      throw new Error(
        `${at}.languages contains ${JSON.stringify(tag)}, which can never match. The lookup key is `
        + `\`audio:start.source_lang\`, and its vocabulary is BARE ISO 639-1 — `
        + `apps/mobile/lib/src/settings/app_settings.dart \`kSpokenLangs = ['zh','en','ja','ko']\` — `
        + `matched by exact string equality. Legal here: '${LANGUAGE_ANY}' or a lowercase 2–3 letter code.`,
      );
    }
  }

  const role = str(r['role']) ?? 'backup';
  if (!VALID_ROLES.has(role)) throw new Error(`${at}.role must be 'primary' or 'backup', got ${JSON.stringify(role)}`);
  const health = str(r['health']) ?? 'healthy';
  if (!VALID_HEALTH.has(health)) throw new Error(`${at}.health must be healthy|degraded|down, got ${JSON.stringify(health)}`);

  const api = str(r['api']);
  const model = str(r['model']);
  const streamingRaw = r['streaming'];

  const route: PoolRoute = {
    id,
    group_id: str(r['group_id']) ?? defaultGroup,
    provider,
    model: model ?? '',
    api: api ?? '',
    region: str(r['region']) ?? REGION_ANY,
    languages,
    role: role as RouteRole,
    enabled: r['enabled'] === undefined ? true : r['enabled'] === true,
    priority: num(r['priority'], 100),
    unit_price: num(r['unit_price'], 0),
    health: health as RouteHealth,
    capacity: num(r['capacity'], 0),
    streaming: typeof streamingRaw === 'boolean' ? streamingRaw : isStreamingEngine(engine_id),
  };

  // `language: '*'` mirrors what `managedDefaultRouting` produces — the router
  // consults this only AFTER the user's own routings miss, so the language on it
  // is never used for matching, only carried.
  const routing: Routing = { language: LANGUAGE_ANY, engine_id };
  if (api !== undefined) routing.endpoint = api;
  if (model !== undefined) routing.model = model;
  const key = str(r['api_key']);
  if (key !== undefined) routing.api_key = key;
  return { route, routing };
}

/**
 * Build the pool for this process from the environment.
 *
 * 🔴 THE SYNTHESIS BRANCH IS THE POINT. Wrapping a lone managed default as a
 * one-route pool is what makes `selectRoute` an UNCONDITIONAL production
 * consumer instead of one that only runs when someone remembers to configure a
 * pool. It also makes the degenerate case visible rather than invisible:
 * `ranked_route_ids.length === 1` is logged, and that is precisely the state the
 * card (§-0b) warns can be reported as "smart route selection is implemented" while nothing was ever
 * chosen.
 */
export function loadPool(env: NodeJS.ProcessEnv = process.env): LoadedPool {
  const defaultGroupId = str(env[POOL_DEFAULT_GROUP_ENV]) ?? DEFAULT_GROUP_ID;
  const region = REGION_ANY;   // pinned — see the note above POOL_DEFAULT_GROUP_ENV
  const raw = str(env[POOL_ENV]);

  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${POOL_ENV} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${POOL_ENV} must be a JSON array of route rows`);
    if (parsed.length === 0) throw new Error(`${POOL_ENV} is an empty array — unset it instead of configuring an empty pool`);
    const routes: PoolRoute[] = [];
    const routings = new Map<string, Routing>();
    parsed.forEach((row, i) => {
      const { route, routing } = parseRow(row, i, defaultGroupId);
      if (routings.has(route.id)) throw new Error(`${POOL_ENV}[${i}].id '${route.id}' is a duplicate — route ids address health and forensic, they must be unique`);
      routes.push(route);
      routings.set(route.id, routing);
    });
    return {
      pool: routes,
      routingOf: (id) => routings.get(id) ?? null,
      defaultGroupId,
      region,
      source: 'pool-env',
    };
  }

  const managed = managedDefaultRouting(env);
  if (managed === null) {
    return { pool: [], routingOf: () => null, defaultGroupId, region, source: 'none' };
  }
  const route: PoolRoute = {
    id: MANAGED_DEFAULT_ROUTE_ID,
    group_id: defaultGroupId,
    provider: managed.engine_id,
    model: managed.model ?? '',
    api: managed.endpoint ?? '',
    // owner ②: the first route's initial config = all regions + all languages.
    region: REGION_ANY,
    languages: [LANGUAGE_ANY],
    role: 'primary',
    enabled: true,
    priority: 0,
    unit_price: 0,
    health: 'healthy',
    // Not read by selectRoute (see its type doc); 0 = "no cap configured".
    capacity: 0,
    streaming: isStreamingEngine(managed.engine_id),
  };
  return {
    pool: [route],
    routingOf: (id) => (id === MANAGED_DEFAULT_ROUTE_ID ? managed : null),
    defaultGroupId,
    region,
    source: 'managed-default',
  };
}

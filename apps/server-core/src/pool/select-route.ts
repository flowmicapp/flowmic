// SPEC-REF:
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md
//     §-0d  pool entry fields + the four "one value answers two questions"
//           traps (registered as B17: Q1 role↔group, Q2 region, Q4 "all")
//     §-0e  the two-layer resolution. 🔴 Layer 1 (which GROUP) is decided by
//           the SERVER from what this connection's credential is bound to,
//           NEVER from a field the client asserts about itself. Same shape as
//           this repo's anti-crosstalk iron law: "the check is always what this
//           connection is bound to, never who is in the room right now."
//     §-0f tail  production strategy = priority + health failover. `region` and
//           `languages` filter the CANDIDATE SET; they never contribute to the
//           ranking score. `unit_price` orders only within an equivalent tier.
//     §-0b  🔴 the acceptance that matters: with a single provider the
//           candidate set is always a singleton, so "smart selection" can be
//           built, pass, and report success while never having chosen
//           anything. That is this repo's most painful delivery shape.
//   docs/decisions/2026-07-30-platform-ops-console-and-engine-pool.md
//     A6 §3 three layers. Layer 1 — "the user brought their own key (BYOK) or
//     self-hosts ⇒ the platform pool does not participate" — is a TRUST red
//     line, not an optimisation: silently substituting the platform's provider
//     for a user's own configured key is a trust incident.
//
// A6-3: the entire selection algorithm as ONE pure function. No I/O, no DB, no
// clock, no vendor names. Liveness enters through an injected probe so the
// function stays total and deterministic for a given input.
//
// 🔴 Placement: this file is src/pool/ and NOT src/stt/ because src/stt/ is
// being edited concurrently by another lane. It is also the honest location —
// nothing below is STT-specific; A6 wants the same algorithm for the LLM pool.
//
// 🔴 No vendor literal appears anywhere in this file. Owner's rule: "production
// prefers vendor X" must be a CONFIGURED fact (X is the lowest-`priority` route
// in the production group), never `if (provider === 'x')` — hard-coding it
// means there is no pool at all.

/* ────────────────────────────────────────────────────────────────────────────
 * Field semantics — the positions this module takes on B17 Q1/Q2/Q4.
 * These are load-bearing: two readings of one field is this repo's #1 bug
 * shape, so each is pinned here AND encoded in code that can be reviewed in
 * a few lines.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The `languages` wildcard — owner's "all".
 *
 *  🔴 SPELLED `'*'` ON PURPOSE, NOT `'all'`. Do not "helpfully" rename it back
 *  to match the owner's Chinese: `'*'` is already this subsystem's spelling for
 *  a universal STT language, in the adjacent selection code this module will
 *  eventually feed or replace —
 *    · `stt/engine-router.ts` — `rows.find((c) => c.language === '*')`
 *    · `stt/engine-router.ts` file header — the §4 order it quotes, the one that
 *      ends in `SttConfigMissingError`. (0.3.0 W1 added a tier BELOW the managed
 *      default for rows the platform seeded; the spelling of the wildcard, which
 *      is all this bullet is about, did not change.)
 *    · `packages/protocol/src/engine-presets.ts` — every `language_hint: '*'` row
 *  The owner's "all" is the right CONCEPT with a different TOKEN. Two spellings
 *  for one concept inside one subsystem is the silent-mismatch class this repo
 *  keeps paying for: the day someone writes a translation layer between them is
 *  the day one side starts matching what the other does not.
 *  ⚠️ Always reference this constant — never inline `'*'`. A named constant is
 *  how the next person finds the one definition.
 *
 *  🔴 Q4 — MANDATORY RULE: an exact language match BEATS this wildcard, always.
 *  It is encoded as candidate-set STRATIFICATION (see {@link CandidateTier}),
 *  not as a ranking bonus: the wildcard tier is only consulted after the exact
 *  tier is fully exhausted. Without this, one lazily-configured universal route
 *  swallows the entire table — and that failure is SILENT. */
export const LANGUAGE_ANY = '*';

/** The `region` wildcard. Same token as {@link LANGUAGE_ANY} so the pool has
 *  ONE vocabulary for "matches anything", and the same stratification rule: an
 *  exact region match beats it.
 *
 *  ⚠️ The TOKEN is settled; the SEMANTICS of `region` are not — see the Q2 note
 *  on {@link PoolRoute.region}. */
export const REGION_ANY = '*';

/** Stored health. `down` is excluded from the candidate set outright;
 *  `degraded` stays eligible but ranks behind `healthy`.
 *
 *  ⚠️ Lead-controller position, NOT an owner ruling: owner named the field but never
 *  defined `degraded`. Ranking health ahead of `priority` is the only reading
 *  under which `degraded` does anything at all — if it neither excluded nor
 *  reordered, the value would be inert, i.e. a façade. Registered as open. */
export type RouteHealth = 'healthy' | 'degraded' | 'down';

/** 🔴 Q1 POSITION — `role` is a DISPLAY ALIAS ONLY and is never read by the
 *  selection algorithm.
 *
 *  Owner's model already names groups "production-primary" / "production-
 *  backup", so `group_id`, `role` and `priority` were three candidate answers
 *  to one question ("who goes first"). Two truth sources produce two routes
 *  both calling themselves primary and nobody knowing which wins.
 *
 *  Pinned:
 *    · `group_id` = environment / purpose (a data row, addable and removable
 *      in the ops console — never an enum in code);
 *    · `priority` = the ONE ordering truth source within a group (lower first);
 *    · `role`     = a label for humans, DERIVED from that ordering.
 *
 *  Encoded two ways: {@link compareByConfig} structurally cannot read `role`
 *  (it is six lines, review them), and {@link auditRoleConsistency} surfaces a
 *  stored `role` that disagrees with the ordering instead of obeying it. */
export type RouteRole = 'primary' | 'backup';

/** One pool entry — owner's field set from §-0d.
 *
 *  🔴 `api_key` is DELIBERATELY ABSENT. Selection never needs the credential,
 *  and a function that cannot see the secret cannot leak it into a log line, a
 *  forensic record, or a ranking key. The caller resolves the `enc:v1:` key by
 *  `id` after selection returns. This type is the non-secret projection of the
 *  pool row, not the row itself.
 *
 *  ⚠️ `capacity` is carried but NOT read here: "is there headroom right now" is
 *  a runtime-load question a pure function cannot answer. Callers fold it into
 *  {@link SelectRouteInput.isAvailable}. A `capacity` compared against nothing
 *  would be a façade, so it is compared against nothing *here*, on purpose. */
export interface PoolRoute {
  readonly id: string;
  /** 🔴 DATA, not an enum. No group name is hard-coded anywhere in this file;
   *  the only group concept in code is "the one this credential defaults to". */
  readonly group_id: string;
  readonly provider: string;
  readonly model: string;
  /** Endpoint. Also the truth source for WHERE this route is deployed — which
   *  is why `region` is free to mean something else (Q2, below). */
  readonly api: string;
  /** ⚠️ B17 Q2 IS STILL OPEN — the owner has NOT ruled on what `region` means,
   *  and nothing below may be cited as settled. The web/ops lane deliberately
   *  kept `region` conservative pending that ruling; this module does the same.
   *  What IS settled is only the token ({@link REGION_ANY}) and the fact that
   *  `region` FILTERS and never ranks (§-0f tail).
   *
   *  Lead-controller position, offered as input to the ruling, not as its outcome:
   *  reading (i) — "which users does this route SERVE" — rather than (ii)
   *  "where is this route deployed". The argument: a filter is only evaluable
   *  if both sides answer the same question, and the request side can only ever
   *  know which serving scope the connection belongs to — it cannot know where
   *  a route is hosted. Under (ii) the field would be documentation-only, which
   *  is how a value acquires a second meaning later. Deployment location also
   *  already has a truth source in `api`'s host.
   *
   *  🔴 If the owner rules (ii), the CODE below does not change — matching stays
   *  a filter either way — but this comment and the ops-console form copy must,
   *  and the two readings must not be allowed to coexist. Degenerate today
   *  (one VPS), which is exactly why it is cheap to get wrong unnoticed. */
  readonly region: string;
  /** 🔴 CURATED "SUITABLE FOR", not "technically capable of" (§-0d). A model
   *  that transcribes a language badly simply does not list it, and therefore
   *  never becomes a candidate for it. This is what replaced the quality-tier
   *  proposal — do not re-read it as a capability list. May contain
   *  {@link LANGUAGE_ANY}. */
  readonly languages: readonly string[];
  /** Display alias only — see {@link RouteRole}. Never read by selection. */
  readonly role: RouteRole;
  readonly enabled: boolean;
  /** In-group ordering. Lower goes first. The ONE ordering truth source. */
  readonly priority: number;
  /** ⚠️ Orders only WITHIN an equivalent tier and only after `priority` ties.
   *  It must never by itself decide who is chosen: a local engine's unit_price
   *  is 0, and a pool that ranks by price hands every language to it — while
   *  the whole reason for buying a cloud vendor is the languages local does
   *  badly. "Costs nothing" answers a different question from "fits best". */
  readonly unit_price: number;
  readonly health: RouteHealth;
  /** Concurrency ceiling. Not read here — see the type doc above. */
  readonly capacity: number;
  /** Can this route carry interim/streaming results? Losing it on failover is
   *  a CAPABILITY DOWNGRADE and must be STATED — see {@link CapabilityDowngrade}. */
  readonly streaming: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layer 0 — the trust red line, and Layer 1 — group entitlement.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Where this connection's engine comes from.
 *
 *  🔴 This is PROVENANCE ("who supplied the key"), deliberately not presence
 *  ("is a key set"). Card §-0f documents a live landmine caused by the other
 *  reading: `resolveByok` decides BYOK from `api_key !== ''`, so the moment a
 *  platform-managed key is configured the quota gate and the VAD gate both go
 *  silently off. Requiring provenance at the type level means this module
 *  cannot inherit that bug. (This module does not FIX §-0f — it just refuses
 *  to accept the ambiguous input.) */
export type PoolParticipation =
  | { readonly kind: 'platform-pool' }
  | { readonly kind: 'byok' }
  | { readonly kind: 'self-hosted' };

/** What the SERVER knows about this connection after authenticating it.
 *
 *  🔴 Every group id this module can return comes out of THIS object. There is
 *  deliberately no code path from {@link RouteRequest} to a returned group id
 *  that does not pass through {@link ConnectionCredential.entitled_group_ids}
 *  or {@link ConnectionCredential.default_group_id}. */
export interface ConnectionCredential {
  readonly participation: PoolParticipation;
  /** Where a client that asks for nothing lands. Production clients send no
   *  `requested_group_id` at all and never need an entitlement check. */
  readonly default_group_id: string;
  /** Non-default groups this principal is allowed to address. Resolved
   *  server-side from the authenticated account (existing JWT/account system —
   *  owner ⑪ ruled no new dev token is to be invented). */
  readonly entitled_group_ids: readonly string[];
}

/** What the connection is asking for. */
export interface RouteRequest {
  /** From `audio:start`'s `source_lang` — known before the first audio chunk,
   *  so selection costs zero extra latency (A6 §4a). */
  readonly language: string;
  /** The serving scope of this connection — see the Q2 note on
   *  {@link PoolRoute.region}. */
  readonly region: string;
  /** 🔴 A REQUEST, NOT AN ASSERTION.
   *
   *  Owner ⑪ allows a dev client to ask for a group. The only reading that
   *  survives alongside "the group must never come from a client-asserted
   *  field" is: the ask is checked for entitlement and REFUSED BY NAME when
   *  unauthorized — never silently downgraded to the default group. Silent
   *  re-routing is precisely the failure the crosstalk law was written for.
   *  Production clients omit it entirely. */
  readonly requested_group_id?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Refusal codes. Four codes because they demand four DIFFERENT operator
 *  actions — collapsing them would make the message answer two questions.
 *
 *  ⚠️ These are module-local, machine-readable strings. Turning any of them
 *  into user-visible copy requires a protocol error code, which is a
 *  human-review gate (protocol face) and is NOT done here. */
export type PoolRefusalCode =
  /** The client asked for a group this credential may not address.
   *  🔴 Also returned when the requested group does not exist at all: an
   *  unentitled principal must not learn which group names are real. When the
   *  principal IS entitled, absence reports as `POOL_GROUP_UNKNOWN` instead —
   *  the distinction tracks WHO supplied the name, not what we know. */
  | 'POOL_GROUP_NOT_ENTITLED'
  /** No route in the pool carries this group id. Operator action: fix the
   *  binding / typo. */
  | 'POOL_GROUP_UNKNOWN'
  /** The group exists but every route in it is disabled or `health: 'down'`.
   *  Operator action: turn something back on. */
  | 'POOL_GROUP_EMPTY'
  /** Usable routes exist in the group, but none is suitable for this
   *  language/region. Operator action: fix the pool config. */
  | 'POOL_NO_CANDIDATE'
  /** Candidates existed and every one failed the live availability probe.
   *  Operator action: the providers are down — nothing to configure. */
  | 'POOL_ALL_UNAVAILABLE';

/** Candidate strata, most specific first.
 *
 *  🔴 This is a FILTERING concept, not a ranking score. A whole tier is
 *  exhausted before the next is consulted, which is what makes "exact beats
 *  all" (Q4) unconditional: a wildcard route with the best priority and the
 *  lowest price still cannot outrank an exact match.
 *
 *  Language specificity dominates region specificity because a language
 *  mismatch is a QUALITY failure (curated "suitable for") while a region
 *  mismatch is a LATENCY failure, and owner's mandatory rule is about
 *  languages. Emitted verbatim in the result so forensic can say which
 *  stratum a session came from. */
export type CandidateTier =
  | 'language-exact/region-exact'
  | 'language-exact/region-any'
  | 'language-any/region-exact'
  | 'language-any/region-any';

const TIER_ORDER: readonly CandidateTier[] = [
  'language-exact/region-exact',
  'language-exact/region-any',
  'language-any/region-exact',
  'language-any/region-any',
];

/** We did not land on the route the configuration intended. Distinct from
 *  {@link CapabilityDowngrade} on purpose: moving to an equally capable backup
 *  is a fact worth recording, but it is NOT a downgrade, and reporting it as
 *  one would be a false alarm — the other half of "no silent failure". */
export interface FailoverReport {
  readonly intended_route_id: string;
  readonly intended_provider: string;
  readonly intended_model: string;
  /** Ordered ids that were probed and rejected before the winner. */
  readonly skipped_route_ids: readonly string[];
}

/** 🔴 A capability the intended route had and the chosen one does not.
 *
 *  Red line: a downgrade must be STATED, never silent. This is why
 *  {@link selectRoute} returns a report object instead of a bare route — a
 *  caller that returns just the route has no way to tell the user, and a
 *  reviewer has no way to check that it did. Machine-checkable by construction:
 *  `downgrade !== null` is the whole test. */
export interface CapabilityDowngrade {
  readonly capability: 'streaming';
  readonly intended_route_id: string;
  readonly chosen_route_id: string;
  /** Always true — a downgrade is only reported when the intent HAD it. */
  readonly intended: boolean;
  /** Always false. Both sides are stated so a log line cannot be misread. */
  readonly chosen: boolean;
}

export type RouteSelection =
  | {
      /** 🔴 Layer 0. Not a success and not a failure — a third outcome, so no
       *  caller can mistake "the user runs their own engine" for "the pool
       *  failed" (or, worse, quietly serve the platform's provider instead). */
      readonly outcome: 'pool-not-consulted';
      readonly reason: 'byok' | 'self-hosted';
    }
  | {
      readonly outcome: 'refused';
      readonly code: PoolRefusalCode;
      /** The group we got as far as, or null if group resolution itself failed. */
      readonly group_id: string | null;
      readonly detail: string;
    }
  | {
      readonly outcome: 'selected';
      readonly group_id: string;
      readonly route: PoolRoute;
      readonly tier: CandidateTier;
      /** 🔴 THE ANTI-FAÇADE FIELD. The ordered candidate list this request was
       *  resolved against. `length === 1` means the pool never actually chose
       *  anything — the exact state in which "smart selection implemented" can
       *  be reported while nothing was ever selected (§-0b). Forensic must log
       *  it so that claim is falsifiable from production data rather than from
       *  a test fixture. */
      readonly ranked_route_ids: readonly string[];
      /** Ids actually handed to the availability probe, in order. */
      readonly probed_route_ids: readonly string[];
      readonly failover: FailoverReport | null;
      readonly downgrade: CapabilityDowngrade | null;
    };

export interface SelectRouteInput {
  readonly credential: ConnectionCredential;
  readonly request: RouteRequest;
  readonly pool: readonly PoolRoute[];
  /** Live availability probe — the ONLY non-deterministic input, injected so
   *  the function itself stays pure. Callers fold the live health check and
   *  `capacity` headroom in here. Defaults to "everything is available", which
   *  makes the default behaviour pure config resolution. */
  readonly isAvailable?: (route: PoolRoute) => boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ranking. Read these two comparators closely — the field access list IS the
 * proof that region/languages/role do not participate in ordering.
 * ──────────────────────────────────────────────────────────────────────────── */

const HEALTH_RANK: Readonly<Record<RouteHealth, number>> = {
  healthy: 0,
  degraded: 1,
  down: 2,
};

/** Config-time ordering: `priority`, then `unit_price` as a tie-break only,
 *  then `id` so the order is total and therefore deterministic under any input
 *  permutation. Reads no runtime state, so a derived role cannot flap. */
function compareByConfig(a: PoolRoute, b: PoolRoute): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.unit_price !== b.unit_price) return a.unit_price - b.unit_price;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Runtime ordering within one tier: stored `health` first, then config order.
 *  🔴 Four fields are read here — health, priority, unit_price, id. `region`,
 *  `languages` and `role` are absent, and that absence is the §-0f-tail
 *  requirement that filtering and ranking never collapse into one score. */
function compareWithinTier(a: PoolRoute, b: PoolRoute): number {
  const h = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
  if (h !== 0) return h;
  return compareByConfig(a, b);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Filtering (stratification).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Which stratum does this route occupy for this request, or null if it is not
 *  a candidate at all? Note "not a candidate" is exclusion, not a low score:
 *  a route that serves neither this language nor this region is never probed. */
function tierOf(route: PoolRoute, request: RouteRequest): CandidateTier | null {
  // A request whose language IS the wildcard literal is a caller bug; it
  // resolves to the same route set either way, so it is not special-cased.
  const langExact = route.languages.includes(request.language);
  const langAll = route.languages.includes(LANGUAGE_ANY);
  if (!langExact && !langAll) return null;

  const regionExact = route.region === request.region;
  const regionAll = route.region === REGION_ANY;
  if (!regionExact && !regionAll) return null;

  if (langExact) return regionExact ? 'language-exact/region-exact' : 'language-exact/region-any';
  return regionExact ? 'language-any/region-exact' : 'language-any/region-any';
}

interface RankedCandidate {
  readonly tier: CandidateTier;
  readonly route: PoolRoute;
}

/** Tier the routes, rank inside each tier, concatenate in tier order. Keeping
 *  this separate from {@link compareWithinTier} is the structural form of "do
 *  not collapse filtering and ranking into one score". */
function stratify(routes: readonly PoolRoute[], request: RouteRequest): readonly RankedCandidate[] {
  const buckets = new Map<CandidateTier, PoolRoute[]>();
  for (const t of TIER_ORDER) buckets.set(t, []);
  for (const r of routes) {
    const t = tierOf(r, request);
    if (t === null) continue;
    buckets.get(t)?.push(r);
  }
  const ranked: RankedCandidate[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (bucket === undefined) continue;
    for (const route of [...bucket].sort(compareWithinTier)) ranked.push({ tier, route });
  }
  return ranked;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Layer 1 — group resolution.
 * ──────────────────────────────────────────────────────────────────────────── */

export type GroupResolution =
  | { readonly ok: true; readonly group_id: string }
  | { readonly ok: false; readonly code: 'POOL_GROUP_NOT_ENTITLED'; readonly detail: string };

/**
 * 🔴 The iron law, in eight lines.
 *
 * Every `group_id` returned is a string read out of `credential` — never the
 * string the client sent. The client's `requested_group_id` is only ever used
 * as a comparison operand. A phone that could name its own group could route
 * itself into a dev group that may bill differently or point at private
 * machines, so an unauthorized ask is REFUSED BY NAME and never silently
 * downgraded to the default group.
 */
export function resolveGroup(
  credential: ConnectionCredential,
  request: RouteRequest,
): GroupResolution {
  const requested = request.requested_group_id;
  // Production clients send nothing and never need an entitlement check.
  if (requested === undefined) return { ok: true, group_id: credential.default_group_id };
  if (requested === credential.default_group_id) {
    return { ok: true, group_id: credential.default_group_id };
  }
  const entitled = credential.entitled_group_ids.find((g) => g === requested);
  if (entitled === undefined) {
    return {
      ok: false,
      code: 'POOL_GROUP_NOT_ENTITLED',
      detail: `group '${requested}' is not among the groups this credential may address`,
    };
  }
  return { ok: true, group_id: entitled };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The function.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve one connection + one request against the pool.
 *
 *   Layer 0  BYOK / self-hosted ⇒ the pool is not consulted AT ALL (trust).
 *   Layer 1  group, from the credential only.
 *   Layer 2  filter by languages/region into strata → rank by health then
 *            in-group order → first one the probe accepts.
 *
 * Returns a REPORT, not a route: the caller must be able to tell the user that
 * it failed over and that a capability was lost, and a reviewer must be able to
 * check that it can.
 */
export function selectRoute(input: SelectRouteInput): RouteSelection {
  const { credential, request, pool } = input;
  const isAvailable = input.isAvailable ?? (() => true);

  // ── Layer 0 ────────────────────────────────────────────────────────────────
  // 🔴 First statement of the function, before `pool` is touched in any way.
  const participation = credential.participation;
  if (participation.kind !== 'platform-pool') {
    return { outcome: 'pool-not-consulted', reason: participation.kind };
  }

  // ── Layer 1 ────────────────────────────────────────────────────────────────
  const group = resolveGroup(credential, request);
  if (!group.ok) {
    return { outcome: 'refused', code: group.code, group_id: null, detail: group.detail };
  }
  const groupId = group.group_id;

  // ── Layer 2 ────────────────────────────────────────────────────────────────
  const inGroup = pool.filter((r) => r.group_id === groupId);
  if (inGroup.length === 0) {
    return {
      outcome: 'refused',
      code: 'POOL_GROUP_UNKNOWN',
      group_id: groupId,
      detail: `no route in the pool belongs to group '${groupId}'`,
    };
  }

  const usable = inGroup.filter((r) => r.enabled && r.health !== 'down');
  if (usable.length === 0) {
    return {
      outcome: 'refused',
      code: 'POOL_GROUP_EMPTY',
      group_id: groupId,
      detail: `every route in group '${groupId}' is disabled or down (${inGroup.length} total)`,
    };
  }

  const ranked = stratify(usable, request);
  // `ranked[0]` is what the CONFIGURATION intends for this request. Failover
  // and downgrade are both measured against it — not against anything the
  // client asked for, because the client never asks for a capability.
  const intended = ranked[0];
  if (intended === undefined) {
    return {
      outcome: 'refused',
      code: 'POOL_NO_CANDIDATE',
      group_id: groupId,
      detail:
        `no route in group '${groupId}' is suitable for language '${request.language}' ` +
        `in region '${request.region}' (${usable.length} usable route(s) considered)`,
    };
  }

  const probed: string[] = [];
  let chosen: RankedCandidate | null = null;
  for (const candidate of ranked) {
    probed.push(candidate.route.id);
    if (isAvailable(candidate.route)) {
      chosen = candidate;
      break;
    }
  }
  if (chosen === null) {
    return {
      outcome: 'refused',
      code: 'POOL_ALL_UNAVAILABLE',
      group_id: groupId,
      detail: `all ${ranked.length} candidate route(s) in group '${groupId}' failed the availability probe`,
    };
  }

  const failover: FailoverReport | null =
    chosen.route.id === intended.route.id
      ? null
      : {
          intended_route_id: intended.route.id,
          intended_provider: intended.route.provider,
          intended_model: intended.route.model,
          // The winner is always the last id probed, so everything before it
          // was probed and rejected.
          skipped_route_ids: probed.slice(0, probed.length - 1),
        };

  const downgrade: CapabilityDowngrade | null =
    intended.route.streaming && !chosen.route.streaming
      ? {
          capability: 'streaming',
          intended_route_id: intended.route.id,
          chosen_route_id: chosen.route.id,
          intended: true,
          chosen: false,
        }
      : null;

  return {
    outcome: 'selected',
    group_id: groupId,
    route: chosen.route,
    tier: chosen.tier,
    ranked_route_ids: ranked.map((c) => c.route.id),
    probed_route_ids: probed,
    failover,
    downgrade,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Q1, encoded as a check the ops console can run.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RoleConflict {
  readonly group_id: string;
  readonly route_id: string;
  readonly stored_role: RouteRole;
  readonly derived_role: RouteRole;
}

/**
 * Find routes whose stored `role` disagrees with the ordering `priority`
 * actually produces.
 *
 * 🔴 This is the Q1 position made machine-checkable. Selection obeys
 * `priority`; `role` is a label. Where the two disagree the label is wrong, and
 * an ops console that shows a "primary" the engine will never pick is a value
 * answering a second question. Surfacing the disagreement is the alternative to
 * silently having two primaries.
 *
 * Disabled routes are skipped — a route that can never be picked has no role.
 */
export function auditRoleConsistency(pool: readonly PoolRoute[]): readonly RoleConflict[] {
  const byGroup = new Map<string, PoolRoute[]>();
  for (const r of pool) {
    if (!r.enabled) continue;
    const list = byGroup.get(r.group_id);
    if (list === undefined) byGroup.set(r.group_id, [r]);
    else list.push(r);
  }
  const conflicts: RoleConflict[] = [];
  for (const [group_id, routes] of byGroup) {
    const ordered = [...routes].sort(compareByConfig);
    ordered.forEach((route, index) => {
      const derived: RouteRole = index === 0 ? 'primary' : 'backup';
      if (route.role !== derived) {
        conflicts.push({
          group_id,
          route_id: route.id,
          stored_role: route.role,
          derived_role: derived,
        });
      }
    });
  }
  return conflicts;
}

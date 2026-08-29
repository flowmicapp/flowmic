// SPEC-REF:
//   docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md (the
//     CURRENT table — three tiers, USD monthly; supersedes the two-tier table of
//     2026-07-31-owner-window-a-four-rulings.md §3/§4)
//   docs/strategy/2026-07-31-owner-nine-rulings-batch.md A1 (tiers/price/quota
//     must not be hardcoded, must be configurable)
//   docs/strategy/2026-07-23-mock-billing-design.md §1 (the fair line only rises,
//     never falls), §8.4 (PLAN_LIMITS single source of truth, clients forbidden
//     from copying it)
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §4-2
//   docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md (owner: PC instances 2/3/10;
//     the ONE narrowing of the red line below — see 「THE ONE EXCEPTION」)
//
// The single source of truth for every quota number. Clients consume
// getQuota()'s returned numbers; they MUST NOT copy these constants (§8.4).
//
// ── owner 2026-08-02 table (CURRENT) ────────────────────────────────────────
//   free  $0   20 min     1M   token    2 PC / 2 phone   30 days
//   pro   $6   900 min    20M  token    3 PC / ∞ phone   365 days
//   max   $20  3,000 min  100M token   10 PC / ∞ phone   365 days
//
// Re-cut UPWARD on 2026-08-02 in two owner rulings on the same day:
//
//  1. MINUTES 10/60/300 → 20/900/3,000 ("Pick C; for the free tier go with your
//     suggestion"), after the competitor study in docs/decisions/2026-08-02-b12-
//     plan-minute-quota-resizing-options.md found the $6 pro tier (60 min ≈
//     9,000 words/month) carried roughly the capacity of Wispr Flow's FREE tier,
//     while every listed dictation rival sells its paid tier as unlimited.
//  2. TOKENS 100K/2M/10M → 1M/20M/100M ("All tiers can remove the TOKEN limit;
//     for safety, a maximum TOKEN count can be set").
//
// 🔴 What changed about llm_tokens on 2026-08-02 was its JOB, not just its
// value. Until 2026-08-27 it was a pure RUNAWAY CEILING: each tier's ceiling
// sat roughly 30-40x above what that tier's STT minutes could physically
// generate (900 min of speech ≈ 180K tokens of transcript; ~720K once
// organize-mode prompt+output is counted, against a then-20M pro ceiling), so
// in normal use the minutes bound first and the token meter never spoke.
//
// 🔴 owner's 2026-08-27 re-cut (pro 20M→5M, max 100M→15M; free unchanged at
// 1M — docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md) shrank
// that headroom on purpose: pro now sits roughly 25x above its
// minutes-implied floor, max roughly 5x. At MAX's ratio the cap is closer to
// a PRODUCT GATE than a pure safety valve — a heavy organize-mode account on
// max could plausibly reach it through ordinary use, not only through a
// looping client.
// ⇒ If you see a real user hit llm_tokens on FREE, or a light-usage PRO
// account hit it, that is still a BUG REPORT — find out what looped. On MAX
// it may legitimately mean "used the product a lot"; do not assume either
// without checking which.
//
// "Only rises, never falls" permits both moves unconditionally: raising is
// always allowed.
//
// 🔴 RED LINE "the cloud sells convenience, never sells capability": pro and max MUST have IDENTICAL
// `mobiles` / `history_days`. The only permitted difference between paid tiers
// is managed STT minutes, managed LLM tokens and PC instance count — a
// capability that exists on max and not on pro would be selling ability, not
// convenience. This is not left to a comment: assertNoCapabilityWall() below
// enforces it on the resolved table at boot, so a config override cannot
// quietly build the wall either (Rule ④: a comment claiming "X must hold" with
// nothing checking X is a façade's defence lawyer).
//
// ── 🔴 THE ONE EXCEPTION: `pcs` LEFT THIS LIST ON 2026-08-02 ────────────────
// owner ruled FREE/PRO/MAX = 2/3/10 PC instances, "if you need more, buy
// multiple subscriptions — an individual generally won't need 10 machine
// instances; if they do, it's basically certainly an enterprise use case"
// (docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md). His argument, entered
// verbatim so nobody has to reconstruct it: instance COUNT is SCALE, not
// capability. Every tier can do every thing; the paid tiers differ in how many
// machines they may do it on at once, which is the same axis as minutes and
// tokens. Selling scale is not selling ability, so "never sell capability" is intact —
// what shrank is the set of dimensions it happens to govern.
//
// ⚠️ THIS IS NOT A PRECEDENT FOR EMPTYING THE LIST. `mobiles` and
// `history_days` were NOT touched by that ruling and stay walled. A future
// argument for moving one of them out must be owner's, in a decision log, with
// its own reasoning — not 「pcs did it」.
//
// ⚠️ pro/max went ∞ → finite, which IS a cut. Permitted under the same clause
// that permitted 900→60 in D1: zero paying users, no checkout entry point yet.
// That window closes when payments open ⇒ this had to land BEFORE phase 3
// (the decision log says so in its own words).
//
// The vacated slot is not left unguarded — assertPcScaleLadder() replaces it:
// `pcs` must be FINITE and free ≤ pro ≤ max. Without it, an override could put
// free above pro and "the more expensive tier gets fewer computers" would boot happily (the same Rule ④ the
// paragraph above invokes: the comment does not police anything, the assert does).
//
// ── configurability (A1) ────────────────────────────────────────────────────
// Every cell is overridable via FLOWMIC_PLAN_LIMITS (JSON), parsed and
// validated in config.ts and applied through installPlanLimits(). Anything
// malformed — bad JSON, unknown tier, unknown limit key, illegal number,
// capability wall — FAILS THE BOOT. It never falls back to the defaults:
// "configured but had no effect" is this repo's #1 bug shape, and a silent fallback is
// exactly that bug wearing a helpful face.

import { isPlan, PLANS, type Plan } from '@flowmic/protocol';

export interface PlanLimits {
  /** Managed STT minutes per UTC month (BYOK / standalone uncounted). */
  stt_minutes: number;
  /** Managed LLM tokens per UTC month — enforced against OUTPUT tokens only
   *  (owner 2026-08-14; quota-guard.ts is the one enforcement read; input tokens
   *  are recorded as reference and never accrue).
   *  ⚠️ Until 2026-08-14 this line read 「(in+out)」 and the guard summed both.
   *  The header's 30-40x headroom arithmetic was computed against that sum, so
   *  output-only enforcement only WIDENS the margin — no ceiling moved.
   *  ⚠️ Token counts vary by LANGUAGE and by PROVIDER TOKENIZER (the same
   *  sentence can cost ~2x across providers/languages) — one more reason these
   *  ceilings are safety valves, never tightly-tuned product gates. */
  llm_tokens: number;
  /** GA-16: max registered PCs per user. 2 / 3 / 10 since 2026-08-02
   *  (docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md).
   *
   *  ⚠️ The type is still `number` and every enforcement site is still one
   *  `Number.isFinite` guard, even though NO TIER encodes ∞ any more — because
   *  room/registry.ts short-circuits to ∞ in standalone mode, and because the
   *  sibling `mobiles` cell below is genuinely ∞ on pro/max. Tightening this to a
   *  finite-only type would therefore break `mobiles`, not simplify anything.
   *  ⚠️ 2026-08-07 CORRECTION — this note used to add 「`BillingService.
   *  EXEMPT_LIMITS` does」, i.e. that the permanent_free exemption encoded ∞ PCs.
   *  It no longer does: owner capped the exemption at MAX's numbers, so its `pcs`
   *  is 10 (docs/decisions/2026-08-07-owner-permanent-free-becomes-max-and-test-
   *  accounts-reset-to-free.md ①). The exemption still never passes through this
   *  table.
   *
   *  Enforced in room/registry.ts (registerPc, new rows only); nothing else may
   *  hardcode it — `grep 'planLimits(\|deviceLimit(\|limitsOf('` over src/ comes
   *  back with exactly one `.pcs` decision point (2026-08-02, [measured]). */
  pcs: number;
  /** GA-16: max paired mobiles per user (same Infinity encoding). Enforced in
   *  room/registry.ts (pairMobile, new pairings only). */
  mobiles: number;
  /** Cloud retention in days (free 30 / pro 365 / max 365). */
  history_days: number;
  /**
   * Longest SINGLE continuous ("long-range") transcription, in minutes — free
   * 10 / pro 30 / max 30 (owner 2026-08-29, registered as a subscription item;
   * task unit docs/strategy/2026-08-29-continuous-recording-and-resumable-
   * transcription-task-unit.md).
   *
   * 🔴 WHY THIS IS A LIMIT KEY AND NOT `if (plan === 'free') 10 else 30`, which
   * is the shorter thing to write and is WRONG IN A WAY THAT BITES THE OWNER
   * FIRST. A `permanent_free` account resolves to plan `'free'` while its
   * NUMBERS come from BillingService.EXEMPT_LIMITS (max's tier, owner
   * 2026-08-07) — so a tier-name lookup hands the one account that exists to
   * test a 30-minute recording a 10-minute ceiling. Every other cell in this
   * interface already flows through the exempt solver; this one has to as well,
   * and being a key is what makes that automatic rather than remembered.
   * The same shape is spelled out one file over in console-routes.ts (the
   * summary route's 「why the console must be TOLD rather than look it up」).
   *
   * ⚠️ DELIBERATELY NOT IN {@link INFINITY_ALLOWED}: an unbounded continuous
   * recording is not a tier we would sell, it is a retained-audio budget nobody
   * bounded (15 册 §2.0-b caps the retained store at 128 MiB precisely because
   * this number is finite). `'unlimited'` here would make that cap unreachable
   * arithmetic instead of a ceiling.
   *
   * ⚠️ It is a SINGLE-SESSION ceiling and answers a different question from
   * {@link PlanLimits.stt_minutes}, which is the monthly budget. Free is
   * 20 min/month against a 10 min cap — i.e. two sessions — and the product
   * copy must state both numbers separately (owner 2026-08-29: 「最多 X 分钟，
   * 还剩 X 分钟」). Merging them into one figure is this repo's #1 defect shape.
   */
  continuous_minutes: number;
}

/** The limit keys, as data — so override validation can reject an unknown key
 *  instead of ignoring it (an ignored key IS "configured but had no effect"). */
export const PLAN_LIMIT_KEYS = ['stt_minutes', 'llm_tokens', 'pcs', 'mobiles', 'history_days', 'continuous_minutes'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** 🔴 THE CENSUS BIND — this array and {@link PlanLimits} are two hand-maintained
 *  answers to ONE question ("what are the limit dimensions"), which is a shape
 *  this repo has been bitten by before: `bump-version.mjs`'s hand-kept FACES
 *  table against the version lint's directory walk, where a new package is
 *  green the day it lands and red on the next bump.
 *
 *  Both directions are checked, and they cost different things:
 *
 *  ← a key here that is not on the interface: dead weight, caught cheaply.
 *  → an interface field that never reaches the array: THE EXPENSIVE ONE, and
 *    nothing at runtime would say so. `plan-view-resolution.test.ts`'s drift
 *    guard walks THIS ARRAY to prove every exempt cell still equals max's, so
 *    an unlisted dimension is one where `EXEMPT_LIMITS` may quietly fall behind
 *    max and hand the `permanent_free` account — the owner's own — the wrong
 *    number, which is precisely the defect `continuous_minutes` exists to
 *    avoid. Override validation would also reject the new key as "unknown",
 *    i.e. an operator configuring a real dimension is told it does not exist.
 *
 *  Zero runtime cost and zero emit: when either direction fails, the condition
 *  resolves to `false`, `false` does not satisfy `extends true`, and
 *  `pnpm verify:types` fails right here naming this alias.
 *
 *  🔴 REVERSE CONTROL, and it is worth stating which one, because the obvious
 *  one proves less than it looks like it does [both run 2026-08-29, measured]:
 *    · add a field to PlanLimits and NOTHING else → 5 errors, of which four are
 *      TS2741 on the tables. This bind is not load-bearing here; the compiler
 *      was already shouting.
 *    · add the field AND fill in every table, i.e. do exactly what those four
 *      TS2741s instruct you to do, leaving only this array behind →
 *      ONE error, TS2344 at this line. Nothing else in the codebase notices.
 *  That second case is the realistic one — the compiler marches you through
 *  every table by name, and this array is the one place it never points at. */
type _Assert<T extends true> = T;
export type _PlanLimitKeyCensus = _Assert<
  [keyof PlanLimits] extends [PlanLimitKey]
    ? ([PlanLimitKey] extends [keyof PlanLimits] ? true : false)
    : false
>;

/** The ONE dimension where ∞ is a legitimate value in a TIER.
 *
 *  ⚠️ `pcs` was in this set until 2026-08-02 and is not any more: owner's 2/3/10
 *  ruling made it a finite ladder, and {@link assertPcScaleLadder} refuses an
 *  infinite one. Leaving `'pcs'` here would let `{"pro":{"pcs":"unlimited"}}`
 *  through coerceCell and fail one line later with a message about ordering —
 *  two checks answering "can this dimension be ∞" is exactly one too many, and the
 *  operator would read the wrong one. It fails HERE, by name.
 *
 *  The other three are metered spend or a retention window: an infinite fair
 *  line is the "unlimited" escape the mock-billing design explicitly forbade, and an
 *  infinite retention window would make retention.ts compute a NaN cutoff. */
const INFINITY_ALLOWED: ReadonlySet<PlanLimitKey> = new Set<PlanLimitKey>(['mobiles']);

/** Dimensions that must be identical across every PAID tier — the red line
 *  above, as data. `free` is deliberately excluded: free being smaller is the
 *  convenience gap we do sell.
 *
 *  ⚠️ `'pcs'` was removed on 2026-08-02 (owner's 2/3/10 ruling). See "THE ONE
 *  EXCEPTION" in the header for WHY that is not a hole, and
 *  {@link assertPcScaleLadder} for what took over the slot. */
const NO_WALL_KEYS: readonly PlanLimitKey[] = ['mobiles', 'history_days'];
const PAID_PLANS: readonly Plan[] = ['pro', 'max'];

/** The tiers in SELLING order, cheapest first. Used only by
 *  {@link assertPcScaleLadder} — `PLANS` (protocol) is the same order today, but
 *  that array's contract is "which tiers exist", not "which is more expensive than which", and a ladder check that
 *  silently inherits an ordering from a list that never promised one is the kind
 *  of coupling this repo pays for later. Stated here, as its own fact. */
const PLAN_LADDER: readonly Plan[] = ['free', 'pro', 'max'];

/** Compiled-in DEFAULTS — 「what ships in the box」.
 *  ⚠️ NOT necessarily the effective numbers: a deployment may override any cell
 *  (FLOWMIC_PLAN_LIMITS). Read the EFFECTIVE table through planLimits(plan) or
 *  currentPlanLimits(); this constant only answers "what is the default". */
export const PLAN_LIMITS: Readonly<Record<Plan, Readonly<PlanLimits>>> = {
  free: {
    // 20, not the 30 of B12 candidate C: free is the ONLY tier open in launch
    // phase 1 (no checkout entry point), so this cell alone sets the burn rate
    // of an open-registration launch. "Only rises, never falls" forbids lowering it later but
    // permits raising, so starting tight and widening on real signup data is the
    // one-way door taken in the safe direction (B12 §7).
    stt_minutes: 20,
    llm_tokens: 1_000_000,
    pcs: 2,
    mobiles: 2,
    history_days: 30,
    // owner 2026-08-29: the free taste. 10 min against a 20 min monthly budget is
    // exactly two sessions, which is the shape owner chose knowingly.
    continuous_minutes: 10,
  },
  pro: {
    // Fair line: finite and fail-loud — NO Infinity escape (mock-billing
    // §1 "key difference from the old line"). Protected by "only rises, never falls" from 2026-08-01 onward; the
    // 900→60 re-cut of 2026-08-01 was the one allowed CUT (zero paying users),
    // and 60→900 on 2026-08-02 restores it in the always-permitted direction.
    stt_minutes: 900,
    // owner 2026-08-27: 20M → 5M (docs/decisions/2026-08-27-owner-quota-
    // gauge-and-token-caps.md). See the header for what this ratio now means.
    llm_tokens: 5_000_000,
    // owner 2026-08-02: 2/3/10. NOT identical to max — the ONE dimension where
    // paid tiers may differ beyond metered spend (header: 「THE ONE EXCEPTION」).
    pcs: 3,
    mobiles: Number.POSITIVE_INFINITY,
    history_days: 365,
    // owner 2026-08-29. Identical to max on purpose: this dimension is a session
    // ceiling, not metered spend, so the pro/max difference lives in
    // stt_minutes (900 vs 3000), not here.
    continuous_minutes: 30,
  },
  max: {
    stt_minutes: 3_000,
    // owner 2026-08-27: 100M → 15M (docs/decisions/2026-08-27-owner-quota-
    // gauge-and-token-caps.md). See the header for what this ratio now means.
    llm_tokens: 15_000_000,
    // owner 2026-08-02: "an individual generally won't need 10 machine instances;
    // if they do, it's basically certainly an enterprise use case" ⇒ past
    // this, the answer is MORE SUBSCRIPTIONS, not a bigger number here. That is
    // why the refusal copy for max must not say "upgrade your plan": no tier raises it.
    pcs: 10,
    // 🔴 identical to pro on purpose — see the red line at the top of this file.
    mobiles: Number.POSITIVE_INFINITY,
    history_days: 365,
    // owner 2026-08-29 — see pro.
    continuous_minutes: 30,
  },
} as const;

/** A single overridden cell. `'unlimited'` exists because JSON has no Infinity
 *  literal and `null` is not a number — without a sentinel, the ∞ encoding
 *  would be unconfigurable and A1 would be half-true. Accepted for `pcs` /
 *  `mobiles` only. */
export type PlanLimitOverride = number | 'unlimited';
/** Deep-partial overlay on PLAN_LIMITS: name only the cells you are changing. */
export type PlanLimitsOverrides = Partial<Record<Plan, Partial<Record<PlanLimitKey, PlanLimitOverride>>>>;

export class PlanLimitsConfigError extends Error {
  constructor(message: string) {
    super(`config: FLOWMIC_PLAN_LIMITS ${message}`);
    this.name = 'PlanLimitsConfigError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceCell(plan: string, key: PlanLimitKey, raw: unknown): number {
  if (raw === 'unlimited') {
    if (!INFINITY_ALLOWED.has(key)) {
      throw new PlanLimitsConfigError(
        `${plan}.${key} may not be "unlimited" — only ${[...INFINITY_ALLOWED].join('/')} accept an infinite value ` +
          `(an infinite fair line or retention window is not a plan, it is a missing limit)`,
      );
    }
    return Number.POSITIVE_INFINITY;
  }
  if (typeof raw !== 'number') {
    throw new PlanLimitsConfigError(`${plan}.${key} must be a number${INFINITY_ALLOWED.has(key) ? ' or "unlimited"' : ''} (got ${JSON.stringify(raw)})`);
  }
  if (raw === Number.POSITIVE_INFINITY) {
    if (!INFINITY_ALLOWED.has(key)) {
      throw new PlanLimitsConfigError(`${plan}.${key} may not be Infinity`);
    }
    return raw;
  }
  if (!Number.isInteger(raw) || raw < 0) {
    throw new PlanLimitsConfigError(`${plan}.${key} must be a non-negative integer (got ${String(raw)})`);
  }
  return raw;
}

/** 🔴 The red line, machine-checked. Runs on the RESOLVED table, so a config
 *  override cannot build the wall the defaults refuse to build. */
function assertNoCapabilityWall(table: Record<Plan, PlanLimits>): void {
  const [first, ...rest] = PAID_PLANS;
  if (first === undefined) return;
  for (const key of NO_WALL_KEYS) {
    for (const other of rest) {
      const a = table[first][key];
      const b = table[other][key];
      if (a !== b) {
        throw new PlanLimitsConfigError(
          `would build a capability wall: ${first}.${key}=${String(a)} but ${other}.${key}=${String(b)}. ` +
            `Paid tiers may differ ONLY in stt_minutes / llm_tokens ("the cloud sells convenience, never sells capability")`,
        );
      }
    }
  }
}

/** 🔴 What replaced `pcs` in {@link NO_WALL_KEYS} (owner 2026-08-02).
 *
 *  Two properties, both machine-checked on the RESOLVED table:
 *    ① FINITE — a tier with ∞ PCs would make the 2/3/10 ladder a claim the
 *      billing page makes and nothing enforces, and would leave "buy multiple subscriptions"
 *      answering a question that never gets asked;
 *    ② MONOTONE, cheapest-first — free ≤ pro ≤ max. Without it an override could
 *      hand free more machines than pro and the product would boot happily while
 *      telling a paying user to downgrade for more.
 *
 *  Deliberately NON-STRICT (≤, not <): two tiers may legitimately carry the same
 *  instance count (they did until this ruling), and refusing that would forbid
 *  the exact shape the red line still mandates for `mobiles`/`history_days`. The
 *  ladder polices DIRECTION, not that a difference exists.
 *
 *  It reads only `pcs` on purpose. `stt_minutes` / `llm_tokens` are NOT checked
 *  for monotonicity here — nobody has ruled that they must be, and inventing a
 *  boot-blocking invariant that no decision log backs is how a future legitimate
 *  configuration becomes an unexplainable crash. */
function assertPcScaleLadder(table: Record<Plan, PlanLimits>): void {
  let prevPlan: Plan | null = null;
  for (const plan of PLAN_LADDER) {
    const n = table[plan].pcs;
    if (!Number.isFinite(n)) {
      throw new PlanLimitsConfigError(
        `${plan}.pcs must be a FINITE instance count (got ${String(n)}). owner 2026-08-02 ruled 2/3/10 — ` +
          `an unlimited tier would make that ladder unenforceable ` +
          `(docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md)`,
      );
    }
    if (prevPlan !== null && n < table[prevPlan].pcs) {
      throw new PlanLimitsConfigError(
        `pcs must not shrink as tiers get more expensive: ${prevPlan}.pcs=${String(table[prevPlan].pcs)} ` +
          `but ${plan}.pcs=${String(n)}`,
      );
    }
    prevPlan = plan;
  }
}

/** Resolve the effective limits table = defaults + validated overrides.
 *  Throws (boot fails) on anything it cannot apply exactly as written.
 *
 *  The parameter is `unknown`, not `PlanLimitsOverrides`, on purpose: its real
 *  caller hands it freshly-JSON.parse'd env text, and typing the door as the
 *  shape we hope to receive would just move the lie one line upstream into a
 *  cast the compiler cannot check (book 13 §7 F1 ⑤). A `PlanLimitsOverrides`
 *  argument still compiles — the widening costs callers nothing. */
export function resolvePlanLimits(overrides?: unknown): Record<Plan, PlanLimits> {
  const table = Object.fromEntries(PLANS.map((p) => [p, { ...PLAN_LIMITS[p] }])) as Record<Plan, PlanLimits>;
  if (overrides === undefined || overrides === null) {
    assertNoCapabilityWall(table);
    assertPcScaleLadder(table);
    return table;
  }
  if (!isPlainObject(overrides)) {
    throw new PlanLimitsConfigError('must be a JSON object of {tier: {limit: value}}');
  }
  for (const [planKey, cells] of Object.entries(overrides)) {
    if (!isPlan(planKey)) {
      throw new PlanLimitsConfigError(`names unknown tier "${planKey}" (known: ${PLANS.join('|')})`);
    }
    if (!isPlainObject(cells)) {
      throw new PlanLimitsConfigError(`${planKey} must map to an object of limits (got ${JSON.stringify(cells)})`);
    }
    for (const [rawKey, rawValue] of Object.entries(cells)) {
      const key = PLAN_LIMIT_KEYS.find((k) => k === rawKey);
      if (key === undefined) {
        throw new PlanLimitsConfigError(`${planKey} names unknown limit "${rawKey}" (known: ${PLAN_LIMIT_KEYS.join('|')})`);
      }
      table[planKey][key] = coerceCell(planKey, key, rawValue);
    }
  }
  assertNoCapabilityWall(table);
  assertPcScaleLadder(table);
  return table;
}

// ── the effective table ─────────────────────────────────────────────────────
// planLimits(plan) keeps its ONE-ARGUMENT signature (quota-guard.ts,
// billing-service.ts, retention.ts and room/registry.ts all call it and none of
// them has, or should have, a config handle), so the resolved table has to live
// module-side.
//
// It is installed by loadConfig() — NOT by bootstrap. That placement is
// deliberate: a table that bootstrap must remember to install is a table that
// one forgotten line turns back into the defaults, silently, which is precisely
// the "configured but had no effect" failure this whole mechanism exists to prevent. There is
// no way to obtain a ServerConfig without going through loadConfig, so there is
// no way to have parsed FLOWMIC_PLAN_LIMITS and not applied it.
//
// installPlanLimits/resetPlanLimits stay exported for tests and for embedders
// that build a table by hand; calling install twice with the same table is a
// no-op, so a belt-and-braces call from bootstrap would also be harmless.
let ACTIVE: Readonly<Record<Plan, Readonly<PlanLimits>>> = PLAN_LIMITS;

/** Install the resolved table. Called by loadConfig(); idempotent. */
export function installPlanLimits(table: Readonly<Record<Plan, Readonly<PlanLimits>>>): void {
  ACTIVE = table;
}

/** Restore the compiled-in defaults (tests; any suite that installs an override
 *  table must call this in afterEach or it leaks into the next test). */
export function resetPlanLimits(): void {
  ACTIVE = PLAN_LIMITS;
}

/** The EFFECTIVE table currently in force (defaults unless overridden). */
export function currentPlanLimits(): Readonly<Record<Plan, Readonly<PlanLimits>>> {
  return ACTIVE;
}

/** Pure limit lookup against the effective table (defaults free for safety). */
export function planLimits(plan: Plan): PlanLimits {
  return ACTIVE[plan] ?? ACTIVE.free;
}

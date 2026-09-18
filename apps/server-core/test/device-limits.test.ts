// GA-16 — Free-plan device/pairing limits (PLAN_LIMITS.pcs / .mobiles).
//
// Before this card the entitlement matrix promised "Free 2 PC / 2 phones" and the
// numbers existed in PLAN_LIMITS, but NOTHING read them: registerPc/pairMobile
// minted rows forever. The Free boundary was a marketing claim, not a fact.
//
// What is pinned here (real sqlite + real Registry; only the plan resolver is a
// stub, standing in for billing.effectivePlan):
//   ① the ceiling holds and is fail-loud with the protocol codes;
//   ② the three short-circuits — standalone, UNLOCK_ALL/pro, and (the one that
//      is easiest to get wrong) reconnect/re-register of an ALREADY-counted
//      device, which must never be blocked by its own slot;
//   ③ the F-3140 virtual cloud-instance row does not eat a user slot.
//
// SPEC-REF: docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-16;
//           docs/strategy/2026-07-23-mock-billing-design.md §1 (entitlement matrix), §8.4
//           (PLAN_LIMITS single source, one place)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Plan } from '@flowmic/protocol';
import { CLOUD_INSTANCE_ID, Registry } from '../src/room/registry';
import { isRealPc } from '../src/room/registry-shared';
import {
  PLAN_LIMITS,
  installPlanLimits,
  planLimits,
  resetPlanLimits,
  resolvePlanLimits,
  type PlanLimits,
} from '../src/billing/plans';
import { BillingService } from '../src/billing/billing-service';
import { ServerError } from '../src/errors';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

type Db = ReturnType<typeof createDbConnection>;

let db: Db;

/** A registry wired the way bootstrap wires it, with a stub LIMITS solver.
 *  0.2.38 (D1 §6.1-bis): the stub used to hand back a `Plan` and the registry
 *  re-derived the numbers. It now hands back the numbers themselves, which is
 *  what lets the exemption case below be expressed at all. */
function makeRegistry(mode: 'standalone' | 'saas', plan: Plan = 'free'): Registry {
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode,
    limitsOf: () => planLimits(plan),
  });
}

/** A registry wired to a REAL BillingService — no stub between the exemption flag
 *  and the device wall. That is the whole point of the exemption test below: a
 *  stub could be made to return anything, so it could not prove the wiring. */
function makeRegistryWithBilling(mode: 'standalone' | 'saas'): Registry {
  const billing = new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    billing: db.billing,
    unlockAll: false,
  });
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode,
    limitsOf: (userId): PlanLimits => billing.effectiveLimits(userId),
  });
}

/** Registers a NEW pc (distinct client_instance_id => never the re-register path). */
function newPc(registry: Registry, user_id: string, n: number) {
  return registry.registerPc({ device_name: `PC-${n}`, user_id, client_instance_id: `inst-${n}` });
}

/** 0.2.66 — how a phone addresses `pc` when pairing.
 *
 *  This file is about DEVICE LIMITS; pairing is only how it reaches them. Since
 *  owner's 2026-08-14 ruling a SAAS pairing must name its target PC (a bare code
 *  is refused with PAIR_PCID_REQUIRED — registry.resolvePcByPcid), so every
 *  pairing here now says which PC it means. `?? undefined` keeps the STANDALONE
 *  rows working unchanged: they have no pcid, the field is absent, and the
 *  standalone resolve never looks at it. */
function pairAddr(pc: { short_code: string; pcid: string | null }) {
  return { short_code: pc.short_code, pcid: pc.pcid ?? undefined };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  // card NR-29 — a trial identity is a REAL `users` row (mobile_pairings
  // .trial_user_id is a foreign key with ON DELETE SET NULL, which is exactly
  // what makes a non-null value mean 「this row is living on a live anonymous
  // identity」). Faking the column with a bare string would pass a unit test and
  // could never happen in production.
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
});
afterEach(() => {
  db.close();
  // A module-level table a test installs and does not remove leaks into every
  // later test in this file (and, via the shared module, into the next one).
  resetPlanLimits();
});

/** Mint an anonymous trial identity row, the way billing/trial-ledger.ts does.
 *  Returns the id so the caller can stamp it onto a pairing. */
function anon(id: string): string {
  db.users.insert({ id, display_name: id, plan: 'free', anonymous: true });
  return id;
}

describe('GA-16 — the numbers live in exactly one place', () => {
  it('PLAN_LIMITS carries the Free 2/2 boundary and an Infinity-encoded phone count', () => {
    expect(PLAN_LIMITS.free.pcs).toBe(2);
    expect(PLAN_LIMITS.free.mobiles).toBe(2);
    expect(Number.isFinite(PLAN_LIMITS.pro.mobiles)).toBe(false);
  });
});

// ── owner 2026-08-02 — the PC instance ladder, 2/3/10 ───────────────────────
//
// 🔴 THE POINT OF THIS BLOCK (D1 rule): plan-limits.test.ts asserts what the TABLE
// says; this asserts what the WALL does. Those are two different claims, and the
// window-D1 post-mortem is the proof they can disagree — `PlanView` kept saying
// "pro" while `effectiveLimits` had stopped honouring the exemption, and every
// label-only assertion in that SSOT stayed green. So each tier is walked to its
// exact ceiling THROUGH `Registry.registerPc`, the production entry point.
//
// SPEC-REF: docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md
describe('owner 2026-08-02 — the PC ladder is 2/3/10 AT THE WALL, not just in the table', () => {
  const LADDER: ReadonlyArray<[Plan, number]> = [
    ['free', 2],
    ['pro', 3],
    ['max', 10],
  ];

  for (const [plan, ceiling] of LADDER) {
    it(`${plan}: registers exactly ${ceiling} PCs, and the next one is refused`, () => {
      const registry = makeRegistry('saas', plan);
      for (let i = 1; i <= ceiling; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
      expect(db.pcs.listByUser('u1')).toHaveLength(ceiling);

      let thrown: unknown;
      try {
        newPc(registry, 'u1', ceiling + 1);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ServerError);
      expect((thrown as ServerError).code).toBe('PCS_LIMIT_EXCEEDED');
      // fail-loud means fail-CLOSED: no half-minted row survived the throw.
      expect(db.pcs.listByUser('u1')).toHaveLength(ceiling);
      // "record" half: used/limit must be legible, or "does he really have that many machines, or is the quota mis-set"
      // has no answer. The DEVELOPER message carries them (the wire carries the
      // code; errors.ts: `message` is never rendered verbatim).
      expect((thrown as ServerError).message).toBe(`pc limit reached (${ceiling}/${ceiling})`);
    });
  }

  // 🔴 THE REVERSE CONTROL for this whole block. Break ONLY the enforced number —
  // every tier NAME, every other cell and every label stay exactly as shipped —
  // and the ladder cases above must go RED. If they stayed green they would be
  // asserting labels, which is the defect this control exists to rule out.
  // (Verified by hand on 2026-08-02 as well: pointing `pro` at 1 PC turned the
  // 'pro' case red at the SECOND registerPc, with the 'free'/'max' cases and the
  // whole of plan-limits.test.ts's `PLAN_LIMITS.*` name assertions still green.)
  it('🔴 reverse control: moving ONLY the enforced number moves the wall', () => {
    installPlanLimits(resolvePlanLimits({ free: { pcs: 1 }, pro: { pcs: 1 }, max: { pcs: 1 } }));
    const registry = makeRegistry('saas', 'max'); // the most generous tier NAME…
    newPc(registry, 'u1', 1);
    expect(() => newPc(registry, 'u1', 2)).toThrow(ServerError); // …walled at 1.
    // …and the tier's NAME is untouched: a label-only assertion still passes.
    expect(PLAN_LIMITS.max.pcs).toBe(10);
    resetPlanLimits();
  });

  it('the ceiling is per user — u2 is unaffected by u1 being full', () => {
    const registry = makeRegistry('saas', 'free');
    newPc(registry, 'u1', 1);
    newPc(registry, 'u1', 2);
    expect(() => newPc(registry, 'u2', 1)).not.toThrow();
  });
});

describe('GA-16 — PC registration ceiling', () => {

  it('standalone NOOPs (single user, no commercial boundary)', () => {
    const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'standalone' });
    for (let i = 1; i <= 5; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
  });

  it('an un-moded registry (the pre-GA-16 default) still NOOPs', () => {
    const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
    for (let i = 1; i <= 4; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
  });

  it('saas without a limits solver refuses to boot rather than silently unlimited', () => {
    expect(() => new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'saas' })).toThrow(/limitsOf/);
  });
});

// ── D1 §6.1-bis — the hole this round closed ────────────────────────────────
//
// 🔴 Until 0.2.38 the registry took `planOf` and did `planLimits(planOf(u))[kind]`.
// `users.permanent_free` is an EXEMPTION with no tier to be expressed as — owner
// resolves to `plan:'free'` on purpose (he bought nothing) — so an exempt account
// was walled at free's 2 PCs / 2 phones by that second derivation. A capability
// wall is a product red line, and this one was invisible until a third machine
// showed up. These run through a REAL BillingService: a stubbed `limitsOf` would
// prove only that the stub returns what the stub returns.
describe('D1 §6.1-bis — permanent_free is an exemption, and it reaches the DEVICE wall', () => {
  it('an exempt user registers a 3rd PC (the wall a Plan could not describe)', () => {
    db.users.setPermanentFree('u1', true);
    const registry = makeRegistryWithBilling('saas');
    for (let i = 1; i <= 4; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
    expect(db.pcs.listByUser('u1')).toHaveLength(4);
  });

  // ── owner 2026-08-02: "from now on, any round that moves quotas must first ask whether owner himself would be the first to hit the wall"
  //
  // 🔴 THE NUMBER, NOT THE LABEL. Before 2026-08-02 the paid tiers were ∞ PCs, so
  // "exempt user is not walled" was indistinguishable from "nothing is walled" —
  // the ladder makes the exemption falsifiable for the first time. This asserts
  // the value `Registry.deviceLimit` actually reads (`effectiveLimits(u).pcs`),
  // and then walks PAST max's 10 through the production entry point, because a
  // limits table that says ∞ while the wall says 10 is exactly the split D1's
  // post-mortem is about.
  //
  // ⚠️ `permanent_free` is still NOT mapped onto a sellable tier: `plan` stays
  // 'free' (he bought nothing) and 'free' is the SMALLEST rung. What owner ruled
  // on 2026-08-07 is that the exemption's NUMBERS are max's — the label did not
  // move, and this test asserts the two separately for exactly that reason.
  //
  // 🔴 CHANGED MEANING, 2026-08-07 — recorded rather than silently rewritten,
  // because the old assertion here was "the NUMBER is ∞, and 11 PCs land" and it
  // now FAILS at the 11th. Ruling: docs/decisions/2026-08-07-owner-permanent-free-
  // becomes-max-and-test-accounts-reset-to-free.md ①. Before the W1 engine switch
  // "unlimited" spent our own CPU; afterwards the same table meant unlimited
  // spending of a vendor's money, which nobody had agreed to. `pcs` is not vendor
  // spend, but it rides the same table and owner capped the table, not one cell.
  it('🔴 owner (permanent_free) gets MAX\'s 10 PCs — label free, number 10, wall at 11', () => {
    db.users.setPermanentFree('u1', true);
    const billing = new BillingService({
      settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false,
    });
    // ① the enforced number itself — max's, not free's and not ∞…
    expect(billing.effectiveLimits('u1').pcs).toBe(10);
    // ② …the tier label is still the SMALLEST rung, on purpose, and it is NOT
    //    the thing that produced the 10 (free would have produced 2)…
    expect(billing.getPlan('u1').plan).toBe('free');
    expect(billing.getPlan('u1').source).toBe('permanent_free');
    expect(billing.getPlan('u1').quota_exempt).toBe(true);
    expect(planLimits('free').pcs).toBe(2);
    // ③ …and the WALL behaves like the number rather than like either label:
    //    10 land, the 11th is refused. This branch was structurally unreachable
    //    for an exempt account until today (deviceLimit short-circuits on
    //    `!Number.isFinite`), so it is newly live, not merely re-numbered.
    const registry = makeRegistryWithBilling('saas');
    for (let i = 1; i <= 10; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
    expect(() => newPc(registry, 'u1', 11)).toThrow(ServerError);
    expect(db.pcs.listByUser('u1')).toHaveLength(10);
  });

  // 🔴 The positive control for the case above, in the ONE place it matters after
  // the re-cut: a NON-exempt max account IS stopped at 11. Without this, ③ could
  // pass because the ladder had quietly gone back to ∞ for everybody.
  it('🔴 positive control: a NON-exempt account on the richest tier is walled at 10', () => {
    const registry = makeRegistry('saas', 'max');
    for (let i = 1; i <= 10; i += 1) newPc(registry, 'u2', i);
    expect(() => newPc(registry, 'u2', 11)).toThrow(ServerError);
  });

  it('an exempt user pairs a 3rd phone', () => {
    db.users.setPermanentFree('u1', true);
    const registry = makeRegistryWithBilling('saas');
    const pc = newPc(registry, 'u1', 1).pc;
    for (const n of ['A', 'B', 'C']) {
      expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: n, user_id: 'u1' })).not.toThrow();
    }
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(3);
  });

  // 🔴 The positive control. Without it, the two assertions above could pass
  // because the wiring stopped enforcing ANYTHING — "was not blocked" must be shown to
  // mean "because of the exemption" and not "because the gate is broken" (CLAUDE.md: a negative assertion must carry its own positive control).
  it('the SAME wiring still walls a NON-exempt user at 2 PCs', () => {
    const registry = makeRegistryWithBilling('saas');
    newPc(registry, 'u2', 1);
    newPc(registry, 'u2', 2);
    expect(() => newPc(registry, 'u2', 3)).toThrow(ServerError);
  });

  // The exemption is per ACCOUNT, not a global switch someone flipped.
  it('marking u1 exempt does not lift u2 (the flag is a row, not a mode)', () => {
    db.users.setPermanentFree('u1', true);
    const registry = makeRegistryWithBilling('saas');
    for (let i = 1; i <= 3; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
    newPc(registry, 'u2', 11);
    newPc(registry, 'u2', 12);
    expect(() => newPc(registry, 'u2', 13)).toThrow(ServerError);
  });
});

describe('GA-16 — UNLOCK_ALL rides the same single solver', () => {
  // 🔴 CHANGED MEANING, 2026-08-02 — recorded because the old assertion here was
  // "4 PCs register" and it now FAILS at the 4th. `FLOWMIC_MOCK_UNLOCK_ALL`
  // resolves to `{plan:'pro', quota_exempt:false}` (billing-service computeView
  // step ③), and pro is a REAL rung of the ladder now — 3 machines — where it
  // used to be ∞. So the dev switch grants pro's numbers, NOT "no gate at all".
  //
  // ⚠️ Deliberately NOT "fixed" by making unlockAll set `quota_exempt`: that flag
  // means `permanent_free`, an account-level exemption a console surface renders,
  // and a dev env var that quietly claims it would be a second meaning for one
  // value. If a deployment genuinely needs unlimited machines, the honest lever
  // is `FLOWMIC_PLAN_LIMITS`, which is validated and visible.
  it("FLOWMIC_MOCK_UNLOCK_ALL grants PRO's numbers — which is now 3 PCs, not ∞", () => {
    // Registry never reads the env flag; it reads effectivePlan, which resolves
    // unlockAll at its ONE bypass point. Simulated exactly that way.
    const unlockAll = true;
    const registry = makeRegistry('saas', unlockAll ? 'pro' : 'free');
    for (let i = 1; i <= 3; i += 1) expect(() => newPc(registry, 'u1', i)).not.toThrow();
    expect(() => newPc(registry, 'u1', 4)).toThrow(ServerError);
    // Positive control that this is PRO and not free having leaked through.
    expect(db.pcs.listByUser('u1')).toHaveLength(3);
  });
});

describe('GA-16 — an already-counted device is never locked out by its own slot', () => {
  it('re-registering a KNOWN PC at the ceiling succeeds (rotates token, no new row)', () => {
    const registry = makeRegistry('saas', 'free');
    const a = newPc(registry, 'u1', 1);
    newPc(registry, 'u1', 2); // now at 2/2

    const again = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' });
    expect(again.pc.id).toBe(a.pc.id);
    expect(again.token).not.toBe(a.token);
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
  });

  it('token reconnect of a KNOWN PC at the ceiling is unchecked', () => {
    const registry = makeRegistry('saas', 'free');
    const a = newPc(registry, 'u1', 1);
    newPc(registry, 'u1', 2);
    expect(registry.reconnectPc(a.token)?.pc.id).toBe(a.pc.id);
  });

  it('token reconnect of a KNOWN mobile at the ceiling is unchecked', () => {
    const registry = makeRegistry('saas', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    const m1 = registry.pairMobile({ ...pairAddr(pc), mobile_name: 'A', user_id: 'u1' });
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'B', user_id: 'u1' }); // 2/2
    expect(registry.reconnectMobile(m1.token)?.mobile.id).toBe(m1.mobile.id);
  });
});

describe('GA-16 — mobile pairing ceiling', () => {
  it('free: the 3rd pairing fails loud with MOBILES_LIMIT_EXCEEDED', () => {
    const registry = makeRegistry('saas', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'A', user_id: 'u1' });
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'B', user_id: 'u1' });

    let thrown: unknown;
    try {
      registry.pairMobile({ ...pairAddr(pc), mobile_name: 'C', user_id: 'u1' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('MOBILES_LIMIT_EXCEEDED');
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(2);
  });

  it('the mobile budget is per USER, not per PC (2 PCs do not buy 4 phones)', () => {
    const registry = makeRegistry('saas', 'free');
    const pcA = newPc(registry, 'u1', 1).pc;
    const pcB = newPc(registry, 'u1', 2).pc;
    registry.pairMobile({ ...pairAddr(pcA), mobile_name: 'A', user_id: 'u1' });
    registry.pairMobile({ ...pairAddr(pcB), mobile_name: 'B', user_id: 'u1' });
    expect(() => registry.pairMobile({ ...pairAddr(pcB), mobile_name: 'C', user_id: 'u1' })).toThrow(
      ServerError,
    );
  });

  it('🔴 WP-9 (findings-crossend-quota.md #4): one PHYSICAL handset paired to two of the user\'s PCs is ONE mobile, not two', () => {
    // Before this fix `ensureMobileSlot` summed pairing ROWS across every real
    // PC — so free's 2-mobile ceiling was already spent by one phone the user
    // paired to two machines, before a second physical handset ever existed.
    const registry = makeRegistry('saas', 'free');
    const pcA = newPc(registry, 'u1', 1).pc;
    const pcB = newPc(registry, 'u1', 2).pc;
    // Same device_uid on both pairings: one handset, two of the user's PCs.
    registry.pairMobile({ ...pairAddr(pcA), mobile_name: 'phone-A', user_id: 'u1', device_uid: 'handset-1' });
    expect(() =>
      registry.pairMobile({ ...pairAddr(pcB), mobile_name: 'phone-A', user_id: 'u1', device_uid: 'handset-1' }),
    ).not.toThrow();
    // A SECOND, genuinely different handset still fits — the ceiling is 2 devices, not 2 rows already spent by the first.
    expect(() =>
      registry.pairMobile({ ...pairAddr(pcA), mobile_name: 'phone-B', user_id: 'u1', device_uid: 'handset-2' }),
    ).not.toThrow();
    // A third DEVICE is refused (2/2 devices reached, even though 3 rows exist).
    expect(db.mobiles.listByPc(pcA.id).length + db.mobiles.listByPc(pcB.id).length).toBe(3);
    let thrown: unknown;
    try {
      registry.pairMobile({ ...pairAddr(pcB), mobile_name: 'phone-C', user_id: 'u1', device_uid: 'handset-3' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('MOBILES_LIMIT_EXCEEDED');
  });

  // ── card NR-29 (RATIFIED 2026-09-15) · an unsigned web visitor is not a device ──
  //
  // 🔴 WHAT WAS MEASURED FIRST (originally golden g29-web-unsigned-trial.mjs,
  // RETIRED 2026-09-11 by card MP-6; the end-to-end assertion moved to
  // `verify/golden/g26-site-demo.mjs`): EVERY web instance — signed in or not —
  // consumed one of the PC OWNER's mobile slots, so the THIRD unsigned stranger
  // to scan a free account's QR code was answered MOBILES_LIMIT_EXCEEDED, from
  // the owner's plan, about a browser that was never going to spend one of the
  // owner's minutes (card R-1).
  //
  // ⚠️ THE DECISION WAS THE MAIN AGENT'S; IT IS NOW RATIFIED. The owner answered
  // "yes", verbatim, to the plain question this left open — a browser tab never
  // uses one of the account's phone slots, signed in or not; only real phones
  // count — docs/decisions/2026-09-15-owner-web-tab-never-takes-a-phone-slot.md.
  // Registered in
  // docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §16.
  //
  // 🔴 CARD MP-6 CHANGED THE COLUMN THE RULE READS, NOT THE RULE. The predicate
  // was 「a web row that carries a trial identity」; MP-6 stopped minting
  // identities outside site-demo rooms, so on the next deploy that predicate
  // would have answered 「counts」 for every unsigned guest and quietly restored
  // the defect above. It reads `client` now. The visible consequence is that a
  // SIGNED-IN web client stops counting too — which the paragraph this file
  // used to carry admits was already true in practice for any browser that
  // paired unsigned, because the anchor was never cleared.

  it('NR-29: web pairings take NO mobile slot, and the rule reads `client`', () => {
    const registry = makeRegistry('saas', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    // Two unsigned browsers, exactly as `mobile:pair` + auth/web-trial-identity.ts
    // leave them: the row is minted by the pair leg, the anchor is stamped by the
    // admission a moment later.
    // 🔴 NO `trial_visitor` AND NO `setTrialUser` — card MP-6. Those two lines
    // were the whole of the old shape: the caller declared the exemption because
    // the column that expressed it was written a moment later. The exemption is
    // now the row's own `client`, so this fixture is what `mobile:pair` really
    // writes, rather than a reconstruction of it.
    for (const uid of ['web-1', 'web-2']) {
      registry.pairMobile({ ...pairAddr(pc), mobile_name: uid, user_id: 'u1', device_uid: uid, client: 'web' });
    }
    // The THIRD unsigned visitor is admitted — this is the whole card.
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'web-3', user_id: 'u1', device_uid: 'web-3', client: 'web' });
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(3);
    // ...and so is a REAL handset: three strangers' browsers did not eat the two
    // slots the owner paid for. This is the assertion that would still be green if
    // the exemption were written as "web rows never count", so the next one exists.
    expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: 'phone-A', user_id: 'u1', device_uid: 'handset-1' })).not.toThrow();
  });

  it('🔴🔴 MP-6 — a SIGNED-IN web client takes NO slot either, and that asymmetry is gone on purpose', () => {
    // 🔴 THIS ASSERTION FLIPPED, AND THE OLD ONE WAS ONLY EVER HALF TRUE. It read
    // 「a SIGNED-IN web client counts like a phone (no trial anchor ⇒ it holds a
    // slot)」, and `registry-shared.ts` recorded in the same breath that a browser
    // which paired UNSIGNED and later signed in kept its anchor for life and went
    // on not counting. So the outcome depended on whether the visitor happened to
    // sign in before or after they first scanned — one rule with two answers.
    //
    // MP-6 had to move the predicate off `trial_user_id` (it is no longer minted
    // outside site-demo rooms, so the old one would have started counting every
    // unsigned guest again), and reading `client` makes the rule say one thing: a
    // browser tab is not a device on the account. A REAL handset still counts,
    // which is the control below and is what the ceiling is for.
    const registry = makeRegistry('saas', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    for (const uid of ['web-s1', 'web-s2', 'web-s3']) {
      registry.pairMobile({ ...pairAddr(pc), mobile_name: uid, user_id: 'u1', device_uid: uid, client: 'web' });
    }
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(3);
    // The POSITIVE CONTROL: the ceiling is still there, and two real handsets
    // still fill it. Without this, "three browsers were admitted" would be
    // equally true of a build whose mobile ceiling had simply stopped working.
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'phone-1', user_id: 'u1', device_uid: 'ph-1', client: 'app' });
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'phone-2', user_id: 'u1', device_uid: 'ph-2', client: 'app' });
    let thrown: unknown;
    try {
      registry.pairMobile({ ...pairAddr(pc), mobile_name: 'phone-3', user_id: 'u1', device_uid: 'ph-3', client: 'app' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('MOBILES_LIMIT_EXCEEDED');
  });

  it('NR-29 control: an APP pairing is untouched by the exemption even if a trial anchor were ever set on it', () => {
    // The predicate is a CONJUNCTION and this pins the half that keeps the phone
    // honest: `client` NULL / 'app' reads as an App row through the protocol's own
    // `clientOriginOf`, so no anchor can exempt a handset.
    const registry = makeRegistry('saas', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    const a = registry.pairMobile({ ...pairAddr(pc), mobile_name: 'A', user_id: 'u1', device_uid: 'handset-1' });
    anon('anon-should-not-matter');
    db.mobiles.setTrialUser(a.mobile.id, 'anon-should-not-matter');
    registry.pairMobile({ ...pairAddr(pc), mobile_name: 'B', user_id: 'u1', device_uid: 'handset-2' });
    expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: 'C', user_id: 'u1', device_uid: 'handset-3' })).toThrow(
      ServerError,
    );
  });

  it('pro / standalone are unlimited', () => {
    const pro = makeRegistry('saas', 'pro');
    const pcPro = newPc(pro, 'u1', 1).pc;
    for (const n of ['A', 'B', 'C', 'D']) {
      expect(() => pro.pairMobile({ ...pairAddr(pcPro), mobile_name: n, user_id: 'u1' })).not.toThrow();
    }
    const alone = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'standalone' });
    const pcAlone = newPc(alone, 'u2', 9).pc;
    for (const n of ['A', 'B', 'C', 'D']) {
      expect(() => alone.pairMobile({ ...pairAddr(pcAlone), mobile_name: n, user_id: 'u2' })).not.toThrow();
    }
  });
});

describe('GA-16 — the virtual cloud instance is not a user device', () => {
  it('admitCloudInstance does not consume a PC or a mobile slot', () => {
    const registry = makeRegistry('saas', 'free');
    registry.admitCloudInstance('u1'); // mints the F-3140 virtual pc + its pairing
    // Both real slots are still free.
    const pc = newPc(registry, 'u1', 1).pc;
    expect(() => newPc(registry, 'u1', 2)).not.toThrow();
    expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: 'A', user_id: 'u1' })).not.toThrow();
    expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: 'B', user_id: 'u1' })).not.toThrow();
    // ...and the 3rd real one is still refused.
    expect(() => registry.pairMobile({ ...pairAddr(pc), mobile_name: 'C', user_id: 'u1' })).toThrow(
      ServerError,
    );
  });

  it('admitCloudInstance stays idempotent for a user already at the ceiling', () => {
    const registry = makeRegistry('saas', 'free');
    newPc(registry, 'u1', 1);
    newPc(registry, 'u1', 2);
    const first = registry.admitCloudInstance('u1');
    const second = registry.admitCloudInstance('u1');
    expect(second.pc.id).toBe(first.pc.id);
    expect(second.mobile.id).toBe(first.mobile.id);
  });

  // owner 2026-07-27: the default was the bare literal 'Phone', so two paired
  // devices were indistinguishable on the devices page and in the pairing-success row —
  // the owner could not tell which entry was which, nor which had just joined.
  it('an unnamed pairing gets a UNIQUE default name, not a shared "Phone"', () => {
    const registry = makeRegistry('standalone', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    const a = registry.pairMobile({ ...pairAddr(pc), user_id: 'u1' });
    const b = registry.pairMobile({ ...pairAddr(pc), user_id: 'u1' });

    expect(a.mobile.mobile_name).toMatch(/^Phone-[0-9a-f]{4}$/);
    expect(b.mobile.mobile_name).toMatch(/^Phone-[0-9a-f]{4}$/);
    expect(a.mobile.mobile_name).not.toBe(b.mobile.mobile_name);
    // The suffix identifies THIS pairing, so a row can be traced to its record.
    expect(a.mobile.mobile_name.endsWith(a.mobile.id.replace(/-/g, '').slice(0, 4))).toBe(true);
  });

  it('a client-supplied mobile_name still wins over the generated default', () => {
    const registry = makeRegistry('standalone', 'free');
    const pc = newPc(registry, 'u1', 1).pc;
    const named = registry.pairMobile({ ...pairAddr(pc), mobile_name: '书房平板', user_id: 'u1' });
    expect(named.mobile.mobile_name).toBe('书房平板');
  });

});

// SECURITY (S2-04 crosscheck) — `isRealPc` decides "does not eat a plan slot"
// off `client_instance_id`, and that column arrives INSIDE a client frame on
// both admission legs (pc:register AND pc:reconnect pass
// `parsed.data.client_instance_id` straight through — pc.handler.ts). The
// only LEGITIMATE writer of the reserved literal is `admitCloudInstance`,
// which never reads it off the wire. Before the fix, ANY desktop could type
// `CLOUD_INSTANCE_ID` into its own `client_instance_id` and walk straight out
// of the ceiling above — the same one-line-opt-out shape `isWebRoom`'s own
// doc warns a client-reachable marker would be for the sibling exemption.
describe('SECURITY — a client frame cannot claim CLOUD_INSTANCE_ID to dodge the PC ceiling', () => {
  it('registerPc sanitizes a client-supplied CLOUD_INSTANCE_ID: the row is real and still eats a slot', () => {
    const registry = makeRegistry('saas', 'free'); // ceiling = 2
    const { pc } = registry.registerPc({
      device_name: 'attacker-pc',
      user_id: 'u1',
      client_instance_id: CLOUD_INSTANCE_ID, // a desktop typing the reserved literal
    });
    // Sanitized to "as if absent" — never stamped onto the row.
    expect(pc.client_instance_id).not.toBe(CLOUD_INSTANCE_ID);
    expect(isRealPc(pc)).toBe(true);
    // It occupies one of the two free-plan slots: one more registration is
    // fine, the THIRD is refused — the ceiling this predicate guards.
    expect(() => newPc(registry, 'u1', 2)).not.toThrow();
    expect(() => newPc(registry, 'u1', 3)).toThrow(ServerError);
  });

  it('registerPc refuses a NEW PC claiming CLOUD_INSTANCE_ID once the real ceiling is already reached', () => {
    const registry = makeRegistry('saas', 'free'); // ceiling = 2
    newPc(registry, 'u1', 1);
    newPc(registry, 'u1', 2);
    let thrown: unknown;
    try {
      registry.registerPc({
        device_name: 'attacker-pc-3',
        user_id: 'u1',
        client_instance_id: CLOUD_INSTANCE_ID,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('PCS_LIMIT_EXCEEDED');
  });

  it('reconnectPc cannot backfill CLOUD_INSTANCE_ID onto an already-counted row', () => {
    const registry = makeRegistry('saas', 'free'); // ceiling = 2
    // Registered with NO client_instance_id (the pre-0.2.4 shape), so the
    // column starts NULL — exactly the state claimClientInstance backfills.
    const { pc, token } = registry.registerPc({ device_name: 'PC-1', user_id: 'u1' });
    expect(pc.client_instance_id).toBeNull();
    const result = registry.reconnectPc(token, CLOUD_INSTANCE_ID);
    expect(result?.pc.client_instance_id).not.toBe(CLOUD_INSTANCE_ID);
    expect(isRealPc(result!.pc)).toBe(true);
    // Still one of the two slots: a second registration is fine, a third is not.
    expect(() => newPc(registry, 'u1', 2)).not.toThrow();
    expect(() => newPc(registry, 'u1', 3)).toThrow(ServerError);
  });

  it('positive control: admitCloudInstance (the LEGITIMATE writer) still gets the real exemption', () => {
    const registry = makeRegistry('saas', 'free');
    const { pc } = registry.admitCloudInstance('u1');
    expect(pc.client_instance_id).toBe(CLOUD_INSTANCE_ID);
    expect(isRealPc(pc)).toBe(false);
    // Both real slots are untouched by it.
    newPc(registry, 'u1', 1);
    expect(() => newPc(registry, 'u1', 2)).not.toThrow();
  });

  // 🔴 REVERSE CONTROL — restore the pre-fix predicate (trust the wire value
  // verbatim) and the FIRST test above must go red. Verified by hand:
  // replacing sanitizeClientInstanceId's body with `return id;` turns
  // 'registerPc sanitizes a client-supplied CLOUD_INSTANCE_ID…' red with
  // `expect(pc.client_instance_id).not.toBe(CLOUD_INSTANCE_ID)` failing
  // (received 'flowmic-cloud-instance') and the ceiling assertion failing
  // right behind it (the 3rd registration no longer throws), while every
  // other case in this file — including the two `admitCloudInstance`
  // exemption tests above — stays green, because the reverse-controlled
  // change belongs only to the CLIENT-FACING param and never touches the
  // registry's own `admitCloudInstance` call sites. Not left in the tree as
  // a toggle: that would be a bug shipped on purpose.
});

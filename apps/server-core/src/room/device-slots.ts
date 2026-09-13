// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md 16
//     (card NR-29 -- every web pairing row spent one of the PC owner's mobile slots)
//   ../auth/web-trial-identity.ts (card R-1 -- who owns an unsigned browser's
//     minutes; `trial_user_id` is minted there and nowhere else)
//   ./registry-shared.ts (`occupiesPcSlot` / `occupiesMobileSlot` -- the two
//     predicates this file counts through)
//   *** HUMAN-AUDIT SENSITIVE (billing ceilings) -- reviewable in isolation ***
//
// STRUCTURAL SPLIT + ONE NEW ENTRY POINT (card NR-29, 2026-09-10). Everything
// below the `makeDeviceSlots` factory arrived VERBATIM from `registry.ts` -- the
// GA-16 header paragraph, `countMobileDevices`, and the six members
// `realPcs` / `slotPcs` / `deviceLimit` / `refuse` / `ensurePcSlot` /
// `ensureMobileSlot` -- with ONE mechanical rewrite applied to all of them:
// `private x(...)` became `function x(...)` and `this.deps` became `deps`. Not a
// single comment was edited in the move, because this repo pays its file-size
// debt by moving reasoning out whole and never by deleting it
// (`verify/lint/file-size.mjs` states that rule at its own baseline list).
//
// WHY IT MOVED NOW: `registry.ts` was ALREADY 801 lines against an 800 cap when
// this card opened -- `pnpm verify:lint file-size` was red on `main` before a
// line of this card was written (recorded here because a gate that is red for
// somebody else's reason is the gate everybody learns to ignore). This card had
// to ADD to that file, so it repaid the debt in the shape the lint asks for
// instead of pinning a new baseline.

// GA-16 — device-count limits. PLAN_LIMITS.pcs/.mobiles (billing/plans.ts, the
// ONE place those numbers live) are enforced HERE and nowhere else, at exactly
// the two row-MINTING sites: registerPc's insert branch and pairMobile. Three
// deliberate short-circuits, mirroring QuotaGuard's shape:
//   · standalone NOOP — one user, no plans, no commercial boundary (mode gate);
//   · UNLOCK_ALL / subscription expiry / permanent_free — NOT re-decided here;
//     `limitsOf` is wired to billing.effectiveLimits, the single solver that
//     already resolves all three;
//   · reconnect/re-register never checks — an already-registered PC that comes
//     back would otherwise be locked out by its own slot (the classic off-by-one
//     that makes a limit un-recoverable). Only NEW rows consume a slot.
// This path only READS limits: no usage recorded, no ensureQuota call.
//
// 0.2.38 (D1 §6.1-bis) — the dep was `planOf: (u) => Plan` and this file called
// `planLimits(planOf(u))[kind]`. 🔴 That second derivation was a real hole, not a
// style point: `users.permanent_free` is an EXEMPTION with no tier to be
// expressed as, so an exempt owner resolves to `plan:'free'` (he bought nothing)
// and this file would have walled him at free's 2 PCs / 2 phones — a CAPABILITY
// wall, which is a product red line, and one that stays invisible until someone
// plugs in a third machine. Asking for the LIMITS deletes the second derivation.

import type { ServerMode } from '@flowmic/protocol';
import { ServerError } from '../errors';
import { log } from '../log';
import type { PlanLimits } from '../billing/plans';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import type { MobileRepo } from '../db/repos/mobile.repo';
import { isRealPc, occupiesMobileSlot, occupiesPcSlot } from './registry-shared';

/** GA-16 fix (WP-9, findings-crossend-quota.md #4) — the `mobiles` device
 *  count, DEDUPED BY PHYSICAL HANDSET rather than counted as pairing ROWS.
 *
 *  🔴 A `mobile_pairings` ROW IS ONE (PC, HANDSET) EDGE, NOT ONE DEVICE. Before
 *  this the free tier's 2-mobile ceiling was `Σ listByPc(pc.id).length` over
 *  every real PC — so ONE physical phone paired to TWO of the user's PCs (an
 *  ordinary thing to do, and the exact shape `device_uid` was minted to
 *  recognise — v0.2.4, `mobile.repo.ts`) counted as TWO mobiles and filled the
 *  free ceiling by itself, before a second handset ever existed. The console's
 *  device card and the registry's enforcement must answer "how many phones"
 *  with the same arithmetic (5-4 ① in the 2026-09-02 audit: a local table
 *  answering a question that needs the whole picture), so this is exported and
 *  used by BOTH (`ensureMobileSlot` below, `console-routes.ts` ③'s
 *  `mobile_count`).
 *
 *  Rows with no `device_uid` (paired by a pre-0.2.4 build, or before the first
 *  reconnect stamps one) CANNOT be deduped — there is no key to dedupe them
 *  BY — so each such row still counts on its own. This can only ever
 *  OVER-count relative to the true device number, never under, which keeps the
 *  refusal direction safe: a user is never let past a ceiling they have
 *  actually reached, only (at worst) refused one pairing later than the exact
 *  device count would allow. */
export function countMobileDevices(pcs: readonly PcRecord[], mobiles: Pick<MobileRepo, 'listByPc'>): number {
  const seen = new Set<string>();
  let undeduped = 0;
  for (const pc of pcs) {
    for (const m of mobiles.listByPc(pc.id)) {
      // card NR-29 (待 owner 追认) — an UNSIGNED web instance is a trial visitor,
      // not a device on this account. `registry-shared.ts` `occupiesMobileSlot`
      // holds the rule and the whole account of why; it is applied HERE, inside
      // the one arithmetic both the ceiling and the console read, because a
      // second filter at either call site is how 「Device 5 · PC 2」 happened.
      if (!occupiesMobileSlot(m)) continue;
      if (m.device_uid) seen.add(m.device_uid);
      else undeduped++;
    }
  }
  return seen.size + undeduped;
}

/** Exactly the slice of `RegistryDeps` these ceilings read. Stated as its own
 *  type so the factory cannot quietly grow a dependency on anything else in the
 *  registry -- the whole reason this family could move out at all is that it
 *  touches four fields and no registry state. */
export interface DeviceSlotDeps {
  pcs: PcRepo;
  mobiles: MobileRepo;
  mode?: ServerMode;
  limitsOf?: (user_id: string) => PlanLimits;
}

export interface DeviceSlots {
  /** Called ONLY before minting a new pc_devices row. */
  ensurePcSlot(user_id: string): void;
  /** Called ONLY before minting a new mobile_pairings row via code pairing. */
  ensureMobileSlot(user_id: string): void;
}

export function makeDeviceSlots(deps: DeviceSlotDeps): DeviceSlots {
  // ── GA-16 device slots ────────────────────────────────────────────────────

  /** The user's REAL registered PCs. The F-3140 cloud-instance row is a virtual
   *  device the server mints on cloud admission — the user never registered it,
   *  so it must not eat a plan slot (nor may its lone auto-pairing eat a mobile
   *  slot; excluding the PC here excludes that pairing from the mobile count
   *  below too, since mobiles are counted through their owning PC).
   *
   *  🔴 card S2-04 — THIS IS NO LONGER THE SET THE PC CEILING COUNTS. A browser
   *  room (`room_kind='web'`) is still a REAL pc row here, because its phones are
   *  real phones and must go on counting against the handset ceiling; it is
   *  `ensurePcSlot` that switched to `occupiesPcSlot`. Two predicates because
   *  there are two questions — registry-shared.ts states both. */
  function realPcs(user_id: string): PcRecord[] {
    return deps.pcs.listByUser(user_id).filter(isRealPc);
  }

  /** The user's PAID computer slots — `realPcs` minus the browser rooms
   *  (owner ruling W-3). The console's device counter reads the same predicate,
   *  so the number on that page and the ceiling that refuses cannot drift. */
  function slotPcs(user_id: string): PcRecord[] {
    return deps.pcs.listByUser(user_id).filter(occupiesPcSlot);
  }

  /** EFFECTIVE limit for one device dimension, or Infinity when unenforced.
   *  Infinity (not null) is the "unlimited" encoding so every callsite is a
   *  single `Number.isFinite` guard — identical to QuotaGuard's shape. */
  function deviceLimit(user_id: string, kind: 'pcs' | 'mobiles'): number {
    if (deps.mode !== 'saas') return Number.POSITIVE_INFINITY; // standalone NOOP
    const limitsOf = deps.limitsOf;
    // Unreachable (constructor guards it) — but never fall back to unlimited.
    if (!limitsOf) throw new Error('registry: limitsOf missing in saas mode');
    return limitsOf(user_id)[kind];
  }

  /** "Record" — owner 2026-08-02 asked for the instance limit to be "recorded
   *  and judged both on the billing page and when a PC instance connects".
   *  This is the RECORD half of the second one; the
   *  JUDGEMENT half is the throw at the callsite.
   *
   *  🔴 IT IS A SERVER LOG LINE, NOT AN `ops_audit_log` ROW, and that is a
   *  decision rather than an omission. `ops_audit_log` answers "what did **our
   *  own people** touch" (db/schema.ts table 10, verbatim): `actor_user_id` is NOT NULL and is
   *  defined as "a users.id already proven by a Bearer", and its only sanctioned writer is
   *  the admin gate (http/ops-audit-trail.ts, whose `route` parameter is a type
   *  fence over four admin-gated GETs). A user tripping his own plan ceiling on a
   *  socket handshake is not an operator action and there is no Bearer in sight;
   *  putting it in that table would make one table answer two questions — the
   *  exact defect its own DDL comment forbids one paragraph above the columns.
   *  ⚠️ Consequence, stated so nobody reads an absence as evidence: querying
   *  `ops_audit_log` for "who hit the limit" finds NOTHING, forever. It is in the server
   *  log (server.log / FLOWMIC_LOG_PATH), grep `device limit refused`.
   *
   *  `used`/`limit` both go in the line because "refused" without them cannot answer
   *  the only question worth asking next — "does he really have that many
   *  devices, or was the limit misconfigured". */
  function refuse(kind: 'pcs' | 'mobiles', user_id: string, used: number, limit: number): never {
    log.warn('device limit refused', { kind, user_id, used, limit });
    const code = kind === 'pcs' ? 'PCS_LIMIT_EXCEEDED' : 'MOBILES_LIMIT_EXCEEDED';
    const noun = kind === 'pcs' ? 'pc' : 'mobile';
    throw new ServerError(code, `${noun} limit reached (${used}/${limit})`);
  }

  /** Called ONLY before minting a new pc_devices row. */
  function ensurePcSlot(user_id: string): void {
    const limit = deviceLimit(user_id, 'pcs');
    if (!Number.isFinite(limit)) return;
    const used = slotPcs(user_id).length;
    if (used >= limit) refuse('pcs', user_id, used, limit);
  }

  /** Called ONLY before minting a new mobile_pairings row via code pairing. */
  function ensureMobileSlot(user_id: string): void {
    const limit = deviceLimit(user_id, 'mobiles');
    if (!Number.isFinite(limit)) return;
    // WP-9 — device count, not pairing-row count. See {@link countMobileDevices}.
    // card S2-04 — `realPcs`, NOT `slotPcs`: a handset paired to a browser room
    // is a handset. Counting through `slotPcs` would have made 「pair them all to
    // the web page」 a way around this ceiling.
    const used = countMobileDevices(realPcs(user_id), deps.mobiles);
    if (used >= limit) refuse('mobiles', user_id, used, limit);
  }


  return { ensurePcSlot, ensureMobileSlot };
}

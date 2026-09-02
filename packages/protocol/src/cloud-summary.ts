// SPEC-REF:
//   apps/server-core/src/http/console-routes.ts ③ (GET /api/cloud/summary)
//   apps/server-core/src/http/router.ts (GET /api/limits, standalone-only)
//   apps/mobile/lib/src/auth/cloud_summary.dart (the phone's own parser)
//   apps/desktop/src/lib/cloud-account.ts (the desktop's own parser)
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
//     §5-3/§5-4 ⑨ (「限额出口应进协议」)
//
// WP-9 (2026-09-02) — the limits/quota OUTLET, as a SHARED contract.
//
// 🔴 WHY THIS EXISTED NOWHERE BEFORE THIS CARD. `/api/cloud/summary` is the
// ONLY place any client learns its device/continuous-recording ceilings, and
// until now its body was three independent hand-rolled readers: the server's
// own `sendJson` call (console-routes.ts, a plain object literal), the phone's
// `parseCloudSummary` (defensive, Dart), and the desktop's `parseCloudAccount`
// (defensive, TS with hand-written `obj()`/`num()` coercion). Three readers of
// one wire shape, and nothing tied them to each other or to what the server
// actually sends — the exact shape `packages/protocol` exists to close for
// socket events, left open for this one HTTP body.
//
// 🔴 THIS DOES NOT RE-TYPE `PlanView` / `QuotaView`. Those are large,
// billing-internal shapes (`apps/server-core/src/billing/billing-service-
// types.ts`) that already carry their own extensive documentation, and copying
// their fields into a second, zod-shaped declaration here would be a new place
// for the two to quietly disagree (this repo's own `bump-version.mjs` FACES
// table / `PlanLimits` census bind are the named precedent for exactly that
// failure). `plan` and `quota` are therefore typed loosely (`z.record`) — this
// schema's job is the part of the body THIS repo has already been bitten by
// disagreeing about: the DEVICE LIMITS and the CONTINUOUS-RECORDING CEILING,
// which is why WP-9 exists (findings-crossend-quota.md #4/#5/struct).
//
// `devices` / `continuous_minutes` ARE typed exactly, because [server]
// validates its OWN output against this schema before it leaves
// console-routes.ts — a wire contract nothing checks is not a contract, it is
// a comment (rule ④).
import { z } from 'zod';

/** A device-count ceiling as it crosses the wire: `null` means "unlimited"
 *  (Infinity serializes to `null` via JSON.stringify regardless of how it is
 *  written, so `null` is the ONLY honest encoding — see console-routes.ts ③'s
 *  own comment on `finiteOrNull`). A finite ceiling is always a positive
 *  integer; `0` would mean "this account owns zero slots for a dimension it is
 *  being shown a count for", which is not a real product state. */
const DeviceLimit = z.number().int().positive().nullable();

export const CloudSummaryDevicesSchema = z.object({
  pc_count: z.number().int().nonnegative(),
  mobile_count: z.number().int().nonnegative(),
  pc_limit: DeviceLimit,
  mobile_limit: DeviceLimit,
});
export type CloudSummaryDevices = z.infer<typeof CloudSummaryDevicesSchema>;

/** The `continuous_minutes` field, shared verbatim between `/api/cloud/summary`
 *  (saas) and `/api/limits` (standalone). `null` means "we could not compute
 *  it" — see `PlanLimits.continuous_minutes`'s own doc for why it is
 *  deliberately NOT in the ∞-allowed set: an unbounded continuous recording
 *  would spend a retained-audio budget nobody sized for it. A client (mobile
 *  `CloudSummary.continuousMinutes`, desktop's equivalent) that receives
 *  `null` here must read it as "unavailable, retryable" — never as "no limit"
 *  and never as a locally-invented default. */
export const ContinuousMinutesSchema = z.number().int().positive().nullable();

/** `/api/cloud/summary` — saas only (console-routes.ts ③). `plan`/`quota` are
 *  the full `PlanView`/`QuotaView` bodies; see this file's header for why they
 *  are not reproduced field-by-field here. */
export const CloudSummarySchema = z.object({
  plan: z.record(z.unknown()),
  quota: z.record(z.unknown()),
  devices: CloudSummaryDevicesSchema,
  continuous_minutes: ContinuousMinutesSchema,
});
export type CloudSummaryWire = z.infer<typeof CloudSummarySchema>;

/** `/api/limits` — standalone only (http/router.ts). Standalone has no `plan`,
 *  no monthly quota and no device ceilings worth naming (registry.ts's
 *  `deviceLimit` already NOOPs to Infinity there, i.e. `null` on the wire) —
 *  the ONE thing a standalone instance can answer about itself today is the
 *  per-session continuous-recording ceiling. See the route's own header for
 *  the pre-ruling default this field carries until owner rules on A8
 *  (`docs/strategy/2026-09-01-week-consolidation-and-lan-fable-handoff.md`
 *  §5-A A8). Kept as its own schema, not `CloudSummarySchema.pick(...)`,
 *  because standalone's body has no `plan`/`quota`/`devices` at all — picking
 *  from the saas schema would imply a subset relationship that does not hold. */
export const StandaloneLimitsSchema = z.object({
  continuous_minutes: ContinuousMinutesSchema,
});
export type StandaloneLimitsWire = z.infer<typeof StandaloneLimitsSchema>;

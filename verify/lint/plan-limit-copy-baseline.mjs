// verify/lint/plan-limit-copy-baseline.mjs
// Baseline DATA for verify/lint/plan-limit-copy.mjs. Nothing else imports it and
// run-all.mjs never runs it — same shape as the other baselines here.
//
// 🔴 THIS IS NOT A DEBT REGISTER. It is one digest over the plan-limit VALUES in
// apps/server-core/src/billing/plans.ts. Changing it is not bookkeeping: it is a
// statement that somebody re-read the client copy that spells those numbers out
// and confirmed it still says the truth.
//
// Re-pinning is deliberately manual and deliberately lands in a diff. There is
// no --fix and there should not be: the whole value of this pin is that a human
// looked at another repo, and a flag that skipped that step would leave the
// digest correct and the pricing page wrong.
//
// Pinned 2026-08-29. Covers 3 tiers x 6 keys, from apps/server-core/src/billing/plans.ts.
// Re-pinning means: the numbers moved, and someone read the 27 web strings and
// the 8 mobile ones that describe them.
export const PLAN_LIMIT_VALUE_PIN = 'b4189d1c2d4f';

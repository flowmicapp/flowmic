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
//
// Re-pinned 2026-09-23 (NR-90: pro stt_minutes 900→1000, pro llm_tokens
// 5M→10M, max llm_tokens 15M→50M; docs/decisions/2026-09-23-owner-nr89-nr90-
// unshelve-price-and-token-caps.md). Read at re-pin time: the 9 mobile
// quotaRulesLine3 strings spell only the 120-second demo cap (not a plan
// limit, unchanged); of the 27 @flowmic/web planFeat* strings the 18
// planFeatPro/planFeatMax ones are updated to 1,000 min / 10M / 50M on that
// repo's lane/NR-90 branch (planFeatFree's numbers did not move).
// Previous pin: b4189d1c2d4f (2026-08-29).
export const PLAN_LIMIT_VALUE_PIN = '3ec5f307dd24';

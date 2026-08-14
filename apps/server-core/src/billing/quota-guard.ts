// SPEC-REF:
//   docs/strategy/2026-07-23-mock-billing-design.md §3 (STT/LLM interception: exactly
//     1 each at the audio:start / compose:start entries; standalone NOOP; BYOK exempt
//     from checks), §8 (Pro-tier STT is also intercepted now, no longer escaping via
//     Infinity)
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1-bis (quota comes from
//     BillingService.effectiveLimits, no longer back-derived from plan)
//   CLAUDE.md red line: over-quota only fails loud with an upgrade prompt
//     (QUOTA_EXCEEDED), silent downgrade is forbidden
//   Ported enforcement mechanism from legacy billing/quota-guard.ts.
//
// ensureQuota is called from EXACTLY TWO production sites (audio:start entry
// kind='stt', compose:start entry kind='llm'). Standalone NOOPs at the top so a
// misconfigured caller cannot enforce quotas off-mode. Over-quota throws a
// ServerError('QUOTA_EXCEEDED'). Every tier's STT is finite and DOES throw at the
// ceiling — no silent Infinity escape.
//
// 🔴 2026-08-07 CORRECTION (anti-façade ④). This header used to end 「→ the client
// shows an upgrade prompt」 and there is no such prompt. What the two sites
// actually do, verified by grep, is NOT symmetric:
//   · kind='llm' — the phone DOES render it: `aiErrorCode` in
//     apps/mobile/lib/src/settings/strings/compose_strings.dart, case
//     'QUOTA_EXCEEDED' → 「本月 AI 额度已用完」 ("this month's AI quota is used up") (four languages, NO upgrade CTA).
//   · kind='stt' — 🔴 NOTHING RENDERS IT. The phone emits `audio:start`
//     fire-and-forget (`transport.emit`, the single call site in
//     apps/mobile/lib/src/ptt/ptt_session.dart — not `emitWithAck`), so the ack
//     carrying this refusal is never read and the user is told nothing at all.
// That asymmetry did not matter while every account that could reach the STT
// ceiling was a paying one being warned by its own metering — but owner's
// 2026-08-07 ruling gives the `permanent_free` account a real 3,000-minute
// ceiling, so this path is now reachable by the one account nobody bills.
// REGISTERED as an open account for the window that owns apps/mobile; naming it
// here rather than leaving the old sentence, because "no silent failures" is a red
// line and a comment that says a prompt exists is how it stays unnoticed.
//
// 0.2.38 (D1 §6.1-bis) — this guard used to take `{ effectivePlan }` and look the
// numbers up itself via `planLimits(plan)`. It now takes `{ effectiveLimits }` and
// asks for the NUMBERS. The difference is not cosmetic: `users.permanent_free` is
// an EXEMPTION, not a tier, so it has no `Plan` to be expressed as — owner's
// account resolves to `plan:'free'` on purpose (he bought nothing), and a guard
// that re-derives limits from that tier would enforce free's 20 minutes on the one
// account the flag exists to leave alone. Asking the single solver for the limits
// removes the second derivation entirely.

import type { ServerMode } from '@flowmic/protocol';
import { ServerError } from '../errors';
import type { PlanLimits } from './plans';
import { currentMonth, type UsageRepo } from '../db/repos/usage.repo';

export type QuotaKind = 'stt' | 'llm';

export interface PlanLookup {
  /** EFFECTIVE limits for this user — post subscription-expiry, post unlock-all,
   *  post permanent_free exemption. MUST be `BillingService.effectiveLimits`, the
   *  single solver; never `planLimits(...)` re-derived from a tier. */
  effectiveLimits(user_id: string): PlanLimits;
}

export interface QuotaGuard {
  ensureQuota(user_id: string, kind: QuotaKind): void;
  remainingSttMs(user_id: string): number;
}

export function makeQuotaGuard(
  usageRepo: UsageRepo,
  planLookup: PlanLookup,
  config: { mode: ServerMode; now?: () => number },
): QuotaGuard {
  const clock = config.now ?? Date.now;
  function budget(user_id: string, kind: QuotaKind): { limit: number; used: number } {
    const limits = planLookup.effectiveLimits(user_id);
    const limit = kind === 'stt' ? limits.stt_minutes : limits.llm_tokens;
    const rec = usageRepo.get(user_id, currentMonth(clock));
    // 🔴 owner 2026-08-14: the LLM budget accrues on OUTPUT tokens ONLY.
    // `llm_tokens_in` stays fully RECORDED (usage_records / usage_events / the ops
    // routes all keep both columns) but is REFERENCE, never charged: input volume
    // is dominated by our own prompt scaffolding and by provider-tokenizer
    // differences across languages (the same sentence can cost ~2x more tokens on
    // one provider/language than another) — neither of which the user chose.
    // ⚠️ This line summed `llm_tokens_in + llm_tokens_out` from 2026-07-23 until
    // 2026-08-14; that sum was the original design, retired by
    // docs/decisions/2026-08-14-owner-llm-token-budget-output-only.md. The pin
    // test 「INPUT tokens alone never consume the LLM budget」 (plan-view-
    // resolution.test.ts) is what turns a quiet re-sum here red.
    const used = rec === null ? 0 : kind === 'stt' ? rec.stt_minutes : rec.llm_tokens_out;
    return { limit, used };
  }
  return {
    ensureQuota(user_id, kind): void {
      if (config.mode !== 'saas') return; // standalone NOOP
      const { limit, used } = budget(user_id, kind);
      if (!Number.isFinite(limit)) return;
      if (used >= limit) {
        // The message names used/limit, no longer `plan=`: this guard no longer
        // knows the tier, and printing one it did not read would be a guess in a
        // diagnostic. The tier belongs to /api/cloud/subscription, which answers
        // it once.
        // ⚠️ 2026-08-07: 「The user-facing 「upgrade」 copy is the client's, keyed off
        // the code」 used to stand here and was false in both directions — no
        // client copy for 'stt' at all, and the 'llm' copy deliberately carries no
        // upgrade CTA. See the header for the two call sites and the open account.
        throw new ServerError('QUOTA_EXCEEDED', `${kind} quota exceeded (used ${used}/${limit})`);
      }
    },
    remainingSttMs(user_id): number {
      if (config.mode !== 'saas') return Number.POSITIVE_INFINITY;
      const { limit, used } = budget(user_id, 'stt');
      if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY;
      return Math.max(0, limit - used) * 60_000;
    },
  };
}

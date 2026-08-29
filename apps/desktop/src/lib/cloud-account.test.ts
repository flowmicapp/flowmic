// L3 account card (L3 账号卡) —— the decision core's acceptance criteria. Design doc = docs/strategy/2026-08-02-l3-account-card-design.md §6.
//
// The four things this file must prove, each corresponding to one of this repo's written rules:
//   ① unreachable ⇒ neutral state, and **the previous value must never be treated as this time's answer** (unknown ≠ error ≠ stale value);
//   ② the free tier **does not render** subscription expiry (one value answering two questions on a user-visible surface, called out by owner 2026-08-02 by name);
//   ③ subscription validity and Cloud Key validity are **two different values**, each carrying its own label;
//   ④ 🔴 D1's lesson: **a test that asserts only the label stays green when "the label moved but the gate didn't"**. So for any tier/quota,
//      the **"name" (FREE/PRO) and the actual number in effect (900 minutes / unlimited) are asserted separately**.
//   ⑤ BILL-1 (2026-08-09): ④ above is asserted in zh-CN ONLY, and the sentence it
//      guards exists in four locales. A regression that re-asserts boundlessness in
//      just one of the other three would leave every existing test green. See the
//      last describe block.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveAccountCard,
  formatTokensM,
  gaugePct,
  LONG_LIVED_KEY_THRESHOLD_MS,
  parseLiveAccount,
  quotaGauge,
  type CloudAccountRaw,
} from './cloud-account';
import { EMPTY_CLOUD_STATUS, type CloudStatus } from './channel';
import { RESTRICTION_REASONS } from '@flowmic/protocol';
import { UI_LOCALES, setLocale, type UiLocale } from './strings/locale';

beforeEach(() => {
  setLocale('zh-CN');
});

/** A saved Cloud Key, exp = 2026-08-03 16:41 local time. */
const KEY_EXP_UNIX = Math.floor(new Date(2026, 7, 3, 16, 41, 0).getTime() / 1000);
const SIGNED_IN: CloudStatus = {
  ...EMPTY_CLOUD_STATUS,
  key_set: true,
  subject: 'u-1',
  // 🔴 These two are the JWT's own claims —— after this round, the card's tier **must never** come from them again.
  plan: 'free',
  expires_at: KEY_EXP_UNIX,
  readiness: 'ready',
};

const FETCHED_AT = Math.floor(new Date(2026, 7, 2, 16, 2, 0).getTime() / 1000);

/** A real-shaped `/api/me` + `/api/cloud/summary` response (field names copied
 *  verbatim from server-core's `publicUser` and `PlanView` / `QuotaView`). */
function okRaw(over: {
  plan?: string;
  source?: string;
  quota_exempt?: boolean;
  state?: string;
  expires_at?: string | null;
  used_min?: number;
  limit_min?: number | null;
  // owner 2026-08-27: the token meter is the gauge's right-hand end. The defaults
  // are the FREE tier's real pair (1M ceiling), so a fixture that says nothing about
  // tokens still describes an account the server could actually return.
  used_tokens?: number;
  limit_tokens?: number | null;
}): CloudAccountRaw {
  return {
    outcome: 'ok',
    fetched_at: FETCHED_AT,
    detail: null,
    me: { user: { id: 'u-1', email: 'owner@example.com', display_name: 'owner', plan: over.plan ?? 'free' } },
    summary: {
      plan: {
        plan: over.plan ?? 'free',
        source: over.source ?? 'none',
        quota_exempt: over.quota_exempt ?? false,
        cycle: null,
        state: over.state ?? 'none',
        expires_at: over.expires_at ?? null,
        paddle_subscription_id: null,
      },
      quota: {
        stt: { used_min: over.used_min ?? 3, limit_min: over.limit_min === undefined ? 20 : over.limit_min },
        llm: {
          used: over.used_tokens ?? 0,
          // `used_in` is on the wire too and is the REFERENCE meter — the desktop
          // must keep ignoring it (billing-service.ts split the two on 2026-08-14
          // so that one number stopped answering two questions). It is in the
          // fixture precisely so a parser that grabbed the wrong field would show up.
          used_in: 999_999_999,
          limit: over.limit_tokens === undefined ? 1_000_000 : over.limit_tokens,
        },
        month: '2026-08',
      },
      devices: { pc_count: 1, mobile_count: 1 },
    },
  };
}

function card(raw: CloudAccountRaw | null, lastLive: CloudAccountRaw | null = null, loading = false) {
  const remembered = lastLive === null ? null : { account: parseLiveAccount(lastLive)!, at: FETCHED_AT };
  return deriveAccountCard({ cloud: SIGNED_IN, raw, lastLive: remembered, loading });
}

describe('① unreachable → neutral state (unknown ≠ error ≠ stale value ≠ currently asking)', () => {
  it('never once reached ⇒ unknown: tier/usage/subscription-period — not one of them renders', () => {
    const c = card({ outcome: 'unreachable', fetched_at: null, detail: 'timeout', me: null, summary: null });
    expect(c.phase).toBe('unknown');
    // 🔴 anti-façade's negative assertion + its own built-in positive control (the 'live' case below proves these fields would otherwise have values).
    expect(c.planBadge).toBeNull();
    expect(c.gauge).toBeNull();
    expect(c.subExpiresText).toBeNull();
    expect(c.account).toBeNull();
    // Neutral, not an error: no loud red-line, but there is a "temporarily unreachable" sentence and a retry.
    expect(c.loud).toBeNull();
    expect(c.statusText).toBe('暂时问不到账号信息');
    expect(c.canRetry).toBe(true);
  });

  it('reached before, unreachable this time ⇒ stale: the old value stays on screen, but **it must self-report when it was learned**', () => {
    const c = card(
      { outcome: 'unreachable', fetched_at: null, detail: 'connect', me: null, summary: null },
      okRaw({ plan: 'pro', source: 'paddle', used_min: 128, limit_min: 900 }),
    );
    expect(c.phase).toBe('stale');
    expect(c.planBadge).toBe('PRO');
    // 🔴 This is this case's entire point: the old value may stay, but the sentence beside it must say it is old + what time.
    expect(c.statusText).toBe('暂时问不到，下面是 16:02 问到的');
    expect(c.canRetry).toBe(true);
  });

  it('401 ⇒ expired: loud and actionable, never merged into "temporarily unreachable", and never offers a retry doomed to fail', () => {
    const c = card(
      { outcome: 'unauthorized', fetched_at: null, detail: 'http 401', me: null, summary: null },
      okRaw({ plan: 'pro', source: 'paddle' }),
    );
    expect(c.phase).toBe('expired');
    // F5 / owner ruling ⑤ 2026-08-04: the original words "sign-in has expired, please sign in again." — fixed copy across all four languages.
    expect(c.loud).toBe('登录已过期，请重新登录。');
    // Even if there is an old value it does not render: after a 401 those numbers belong to an account we no longer have the right to read.
    expect(c.planBadge).toBeNull();
    expect(c.canRetry).toBe(false);
  });

  it('currently asking ⇒ loading: not unknown, the old value does not flash away', () => {
    const c = card(null, okRaw({ plan: 'pro', source: 'paddle' }), true);
    expect(c.phase).toBe('loading');
    expect(c.planBadge).toBe('PRO');
    expect(c.statusText).toBe('正在查询账号信息…');
  });

  it('no Cloud Key ⇒ signed_out: the whole block says nothing at all (including the Cloud Key validity)', () => {
    const c = deriveAccountCard({
      cloud: { ...EMPTY_CLOUD_STATUS },
      raw: null,
      lastLive: null,
      loading: false,
    });
    expect(c.phase).toBe('signed_out');
    expect(c.keyExpiresText).toBeNull();
    expect(c.statusText).toBeNull();
  });
});

describe('①-bis the account row (M3-8): email / unbound / the row does not exist at all — three facts, three answers', () => {
  it('a live answer exists ⇒ the email, MASKED', () => {
    // owner 2026-08-27:「所有显示账号的地方都要用星号遮盖」. This assertion read
    // `'owner@example.com'` until that ruling; it is the value that changed, not
    // the claim — the row still answers「which account am I signed in with」, and
    // `own***r` still tells `owner@` from `ownership@`, which is the whole
    // reason the rule keeps three characters instead of one.
    expect(card(okRaw({})).identityText).toBe('own***r@example.com');
    // 🔴 The property, stated separately from the vector: the raw address does
    // not leave this module. A future change that formats the line differently
    // has to keep passing this.
    expect(card(okRaw({})).identityText).not.toContain('owner@');
  });

  it('the server answered, but this account has no email ⇒ "no email bound" (`users.email` can be null — that is a real answer, not a read failure)', () => {
    const raw = okRaw({});
    (raw.me as { user: Record<string, unknown> }).user.email = null;
    expect(card(raw).identityText).toBe('未绑定邮箱');
  });

  it('🔴 unreachable / 401 / first-ever cold start ⇒ the row does not exist at all (not "—", and certainly not an internal id)', () => {
    const unreachable = card({ outcome: 'unreachable', fetched_at: null, detail: null, me: null, summary: null });
    expect(unreachable.phase).toBe('unknown');
    expect(unreachable.identityText).toBeNull();

    const expired = card(
      { outcome: 'unauthorized', fetched_at: null, detail: 'http 401', me: null, summary: null },
      okRaw({}),
    );
    expect(expired.phase).toBe('expired');
    expect(expired.identityText).toBeNull();

    const firstLoad = card(null, null, true);
    expect(firstLoad.phase).toBe('loading');
    expect(firstLoad.identityText).toBeNull();
  });

  it('stale ⇒ the email learned last time is still there (the old value may stay, sentence ⑦ is responsible for saying it is old)', () => {
    const c = card(
      { outcome: 'unreachable', fetched_at: null, detail: null, me: null, summary: null },
      okRaw({}),
    );
    expect(c.phase).toBe('stale');
    expect(c.identityText).toBe('own***r@example.com');
    expect(c.statusText).toBe('暂时问不到，下面是 16:02 问到的');
  });

  it('🔴 the parsing layer keeps no internal id at all: LiveAccount has no `account_id` field to fall back to', () => {
    const parsed = parseLiveAccount(okRaw({}))!;
    // `/api/me`'s body really does carry `user.id` (the next line proves it's
    // really what was fed in), but the parsed result does not have it — the
    // fallback is not forbidden by convention, it is **physically nothing to fall back on**.
    expect((okRaw({}).me as { user: { id: string } }).user.id).toBe('u-1');
    expect(Object.keys(parsed)).not.toContain('account_id');
  });
});

describe('② the free tier does not show subscription expiry (owner 2026-08-02)', () => {
  it('source=none (plain free) ⇒ the subscription-validity row does not exist', () => {
    const c = card(okRaw({ plan: 'free', source: 'none', expires_at: '2026-09-01T08:00:00.000Z' }));
    expect(c.phase).toBe('live');
    expect(c.planBadge).toBe('FREE');
    // 🔴 Not "—", it's null = the whole row does not render. There is no such
    // thing as subscription expiry on the free tier — writing any date (even
    // if the server happened to send one along) would be answering a question
    // that shouldn't be asked.
    expect(c.subExpiresText).toBeNull();
    expect(c.sourceBadge).toBeNull();
  });

  it('source=permanent_free (owner themselves) ⇒ still FREE, still no subscription expiry, but able to say "permanently free"', () => {
    const c = card(okRaw({ plan: 'free', source: 'permanent_free', quota_exempt: true, used_min: 128, limit_min: 3000 }));
    // 🔴 D1 §6.1-bis: permanent_free is not a sellable tier. `plan` must still
    //    be free, otherwise owner would be mapped into some tier and end up
    //    limited by it instead (D1 §2's written lesson).
    expect(c.planBadge).toBe('FREE');
    expect(c.sourceBadge).toBe('长期免费');
    expect(c.subExpiresText).toBeNull();
  });

  it('positive control: source=paddle with an expires_at ⇒ this row really does appear (otherwise the null above proves nothing)', () => {
    const c = card(okRaw({ plan: 'pro', source: 'paddle', expires_at: '2026-09-01T08:00:00.000Z' }));
    expect(c.subExpiresText).not.toBeNull();
    expect(c.sourceBadge).toBe('已订阅');
  });
});

describe('③ subscription validity and Cloud Key validity are two values', () => {
  it('both dates are on the card at once, and are never equal to each other', () => {
    const c = card(okRaw({ plan: 'pro', source: 'paddle', expires_at: '2026-09-01T08:00:00.000Z' }));
    const sub = c.subExpiresText;
    const key = c.keyExpiresText;
    expect(sub).not.toBeNull();
    expect(key).not.toBeNull();
    // 🔴 The inverse criterion of "one value answers two questions": two questions must have two answers.
    expect(sub).not.toBe(key);
    // The Cloud Key one still comes from the JWT's exp (2026-08-03 16:41), the subscription one comes from PlanView.
    expect(key).toBe('2026-08-03 16:41');
    expect(sub?.startsWith('2026-09-01')).toBe(true);
  });

  it('free tier: only the Cloud Key one is left —— so it can never again be read as subscription expiry', () => {
    const c = card(okRaw({ plan: 'free', source: 'none' }));
    expect(c.subExpiresText).toBeNull();
    expect(c.keyExpiresText).toBe('2026-08-03 16:41');
  });

  it('when a subscription is not active it states its status (canceled/past_due/paused each answer their own)', () => {
    expect(card(okRaw({ source: 'paddle', state: 'canceled' })).subStateText).toBe('已取消，到期后不再续费');
    expect(card(okRaw({ source: 'paddle', state: 'past_due' })).subStateText).toBe('扣款失败，正在重试');
    expect(card(okRaw({ source: 'paddle', state: 'active' })).subStateText).toBeNull();
  });
});

// ── ④-bis the gauge's arithmetic, on its own ────────────────────────────────
//
// owner 2026-08-27. These are the two pure functions the component pastes into a
// `style` and a `<span>`; they are tested WITHOUT a DOM on purpose, the same split
// the whole module is built on. A number that is wrong here is wrong on all three
// surfaces at once (phone / PC / web console draw the same gauge).
describe('④-bis gaugePct: each side\'s 100% is the CENTRE, so two meters share one rail', () => {
  it('half a meter fills a quarter of the rail (its own 50%, i.e. 25% of the whole)', () => {
    expect(gaugePct(10, 20)).toBe(25);
    expect(gaugePct(0, 20)).toBe(0);
  });

  it('🔴 a full meter stops exactly at the centre — never past it, so the two sides cannot collide', () => {
    expect(gaugePct(20, 20)).toBe(50);
    // Over quota: the bar is CLAMPED. Without this, 3x usage would draw 150% of the
    // rail and paint straight through the other meter's numbers.
    expect(gaugePct(60, 20)).toBe(50);
    expect(gaugePct(20_000_000, 1_000_000)).toBe(50);
  });

  it('a non-positive limit produces a width, never NaN%', () => {
    // `NaN%` is not an error anywhere — CSS drops the declaration and the bar
    // silently renders at zero, i.e. "you have used none of it".
    expect(gaugePct(0, 0)).toBe(0);
    expect(gaugePct(5, 0)).toBe(50);
    expect(Number.isNaN(gaugePct(0, 0))).toBe(false);
  });
});

describe('④-bis formatTokensM: millions, at most one decimal', () => {
  it('a whole number of millions carries no decimal point', () => {
    expect(formatTokensM(1_000_000)).toBe('1');
    expect(formatTokensM(5_000_000)).toBe('5');
    expect(formatTokensM(15_000_000)).toBe('15');
    expect(formatTokensM(0)).toBe('0');
  });

  it('a partial million keeps exactly one decimal', () => {
    expect(formatTokensM(450_000)).toBe('0.5');
    expect(formatTokensM(1_240_000)).toBe('1.2');
    expect(formatTokensM(12_345_678)).toBe('12.3');
  });

  it('🔴 it never emits the raw seven-digit count (the reason the unit exists)', () => {
    expect(formatTokensM(12_345_678)).not.toContain('345');
  });
});

describe('④ the name and "the actual number in effect" are asserted separately (D1: a test that asserts only the label stays green)', () => {
  it('pro: assert both the name PRO and the number 900 that is actually in effect', () => {
    const c = card(okRaw({ plan: 'pro', source: 'paddle', used_min: 128, limit_min: 900 }));
    expect(c.planBadge).toBe('PRO');
    expect(c.gauge?.minutes?.label).toBe('128 / 900 分钟');
    // The width is asserted next to the sentence, not instead of it: D1's law is
    // that the name and the number in effect are two claims, and on a gauge the
    // BAR is a third one — a label reading 128/900 above a full bar is the same
    // defect wearing a different shape.
    expect(c.gauge?.minutes?.pct).toBeCloseTo((128 / 900) * 50, 1);
    expect(c.gauge?.minutes?.over).toBe(false);
  });

  it("free: 20 minutes (B12's adjusted live criterion), the name and the number each asserted once", () => {
    const c = card(okRaw({ plan: 'free', source: 'none', used_min: 3, limit_min: 20 }));
    expect(c.planBadge).toBe('FREE');
    expect(c.gauge?.minutes?.label).toBe('3 / 20 分钟');
  });

  it('🔴 the token meter is the OTHER end of the same rail, and it is the ENFORCED number', () => {
    const c = card(
      okRaw({ plan: 'pro', source: 'paddle', used_min: 128, limit_min: 900, used_tokens: 1_240_000, limit_tokens: 5_000_000 }),
    );
    expect(c.gauge?.context?.label).toBe('上下文 1.2 / 5M');
    expect(c.gauge?.context?.pct).toBeCloseTo((1_240_000 / 5_000_000) * 50, 1);
    // 🔴 `used_in` (999,999,999 in the fixture) is the reference meter and is NOT
    // what is charged. If a future edit parsed `used + used_in`, this bar would be
    // full and this assertion is the only thing that would say so.
    expect(c.gauge?.context?.over).toBe(false);
    expect(c.gauge?.context?.label).not.toContain('999');
  });

  it('🔴 used ≥ limit ⇒ the bar reaches the centre and flags WARNING, and the numbers stay truthful', () => {
    const c = card(
      okRaw({ plan: 'free', source: 'none', used_min: 33, limit_min: 20, used_tokens: 2_000_000, limit_tokens: 1_000_000 }),
    );
    expect(c.gauge?.minutes?.over).toBe(true);
    expect(c.gauge?.minutes?.pct).toBe(50);
    // 🔴 R11: the warning colour does not get to round the number down to the
    // ceiling. What was used is what is printed — 33, not 20.
    expect(c.gauge?.minutes?.label).toBe('33 / 20 分钟');
    expect(c.gauge?.context?.over).toBe(true);
    expect(c.gauge?.context?.label).toBe('上下文 2 / 1M');
  });

  it('🔴 one meter unreadable ⇒ that END of the gauge is absent, the other one still draws', () => {
    // A zero-length bar would read as 「you have used none of it」, which is an
    // answer we do not have. Two questions, two answers — and one of them is
    // 「we could not read this」.
    const noTokens = card(okRaw({ plan: 'pro', source: 'paddle', used_min: 128, limit_min: 900, limit_tokens: null }));
    expect(noTokens.gauge?.context).toBeNull();
    expect(noTokens.gauge?.minutes?.label).toBe('128 / 900 分钟'); // positive control
  });

  it('🔴 a null limit is NOT rendered as "unlimited" — the premise for that reading died on 2026-08-07', () => {
    // The 2026-08-27 ruling's wording is 「limit 为 null（豁免/∞）⇒ 该侧文字「不限」」,
    // and its parenthesis names the premise: Infinity crossing the wire as null.
    // billing-service.ts's `QuotaView` retired that verbatim — every account,
    // exempt included, now gets a finite number, so a null can ONLY mean "we failed
    // to compute it". Calling that "unlimited" would print a boundless claim under
    // a live gate (R11), which is the very defect the 08-07 ruling removed.
    const g = quotaGauge({
      email: null,
      plan: 'free',
      source: 'permanent_free',
      quota_exempt: true,
      sub_state: 'none',
      sub_expires_at: null,
      used_min: 128,
      limit_min: null,
      used_tokens: 12,
      limit_tokens: null,
    });
    expect(g).toBeNull();
  });

  // 🔴 Rewritten 2026-08-07 (owner ruling ①: permanent_free capped at the
  // monthly MAX tier). The original assertion was "128 minutes · unlimited",
  // with the criterion being limit_min=null (Infinity crossing the wire
  // becomes null). Now the server really caps people at 3,000 ⇒ that
  // "unlimited" sentence was **the label and the number in effect
  // disagreeing**, exactly the R11 / D1 red line; and limit=null can no
  // longer be produced by exemption.
  it('🔴 exempt account: the name and the number in effect are asserted separately, and this row is no longer allowed to say "unlimited"', () => {
    const exempt = card(okRaw({ plan: 'free', source: 'permanent_free', quota_exempt: true, used_min: 128, limit_min: 3000 }));
    // ① The name: owner bought nothing, still FREE — what justifies it is answered by the badge alone.
    expect(exempt.planBadge).toBe('FREE');
    expect(exempt.sourceBadge).toBe('长期免费');
    // ② The number in effect: the server's 3,000 appears verbatim, together
    // with "not billed" — each of the three sentences is true on its own.
    expect(exempt.gauge?.minutes?.label).toBe('128 / 3000 分钟 · 不计费');
    // ③ 🔴 that sentence is no longer true, and this pins it down so it never
    //    comes back. Asserting ② alone is not enough: someone could paste
    //    "· unlimited" back in while {used}/{limit} stays as-is, and ② could
    //    still be turned green again.
    expect(exempt.gauge?.minutes?.label).not.toContain('不限额');
  });

  it('🔴 positive control: the same numbers, no exemption ⇒ it is a different sentence (quota_exempt really is selecting the sentence)', () => {
    // Without this case, the assertion above could go green just because "both branches rendered the same sentence".
    const paid = card(okRaw({ plan: 'max', source: 'paddle', quota_exempt: false, used_min: 128, limit_min: 3000 }));
    expect(paid.gauge?.minutes?.label).toBe('128 / 3000 分钟');
    expect(paid.gauge?.minutes?.label).not.toContain('不计费');
  });

  it('🔴 limit is empty ⇒ that side does not render, exempt or not, the same either way (null now has only one meaning)', () => {
    // Since 2026-08-07, an exempt account also gets a finite number, so
    // limit=null can only mean "we couldn't compute it". A missing bar is
    // better than a fabricated number — both branches must do this.
    const unknownPaid = card(
      okRaw({ plan: 'pro', source: 'paddle', quota_exempt: false, used_min: 12, limit_min: null, limit_tokens: null }),
    );
    expect(unknownPaid.gauge).toBeNull();
    expect(unknownPaid.planBadge).toBe('PRO'); // the name is still there, the number is not —— two questions, two answers
    const unknownExempt = card(
      okRaw({ source: 'permanent_free', quota_exempt: true, used_min: 128, limit_min: null, limit_tokens: null }),
    );
    expect(unknownExempt.gauge).toBeNull();
    expect(unknownExempt.sourceBadge).toBe('长期免费'); // same as above: what justifies still being able to answer
  });
});

describe('the parsing layer: a bad shape must never become a card full of zeroes', () => {
  it('ok but the body has no plan ⇒ parseLiveAccount returns null (not a zeroed-out account)', () => {
    const broken: CloudAccountRaw = { outcome: 'ok', fetched_at: FETCHED_AT, detail: null, me: null, summary: {} };
    expect(parseLiveAccount(broken)).toBeNull();
  });

  it('quota_exempt must be strictly true to count as exempt (a missing field must never be taken as true)', () => {
    const raw = okRaw({});
    const summary = raw.summary as { plan: Record<string, unknown> };
    delete summary.plan.quota_exempt;
    expect(parseLiveAccount(raw)?.quota_exempt).toBe(false);
  });

  it('an unknown outcome value degrades to bad_response, never impersonates ok', () => {
    const c = card({ outcome: 'ok', fetched_at: null, detail: null, me: null, summary: null });
    // ok, but the body can't be read ⇒ there is no account, so no number may be shown.
    expect(c.account).toBeNull();
    expect(c.planBadge).toBeNull();
  });
});

// ── ⑤ BILL-1 — the exempt line, in every UI locale ──────────────────────────
//
// WHAT THE SERVER ACTUALLY SENDS TODAY (measured 2026-08-09, read from the code):
//   BillingService.getQuota (billing-service.ts:511) reads effectiveLimits (:504),
//   which returns `{...EXEMPT_LIMITS}` for a quota-exempt account, and
//   EXEMPT_LIMITS.stt_minutes is 3_000 (:177, owner's 2026-08-07 ruling ①).
//   GET /api/cloud/summary ships that verbatim (console-routes.ts:325), so the
//   wire carries a FINITE 3000 for the owner's account — never Infinity, never null.
// ⇒ any locale that answers "unlimited" contradicts a gate that is live
//   right now, which is R11 ("every status word must be able to answer 'what
//   justifies saying so'") exactly.
//
// WHY THIS BLOCK EXISTS ON TOP OF ④. Describe ④ and cloud-account-card.test.ts both
// pin this — in zh-CN. The sentence lives in four locale tables (strings/cloud.ts),
// hand-maintained, and nothing else compares them for this claim: put "unlimited"
// back into the `en` row alone and the whole desktop suite stays green. That is the
// same shape as 0.2.53 (a code registered on one side, missing from the other table).
//
// The number is asserted SEPARATELY from the wording in every locale — D1's law is
// "the name" vs "the actual number in effect", and a locale that drops `{limit}` from its template
// would still pass a wording-only check while silently hiding the ceiling.
describe('⑤ BILL-1: the exemption sentence never claims boundlessness, in any locale', () => {
  // Each locale's own way of saying "there is no ceiling". Negative assertions, so
  // every one of them is paired with a positive control below (the repo's G13 rule:
  // a zero can also mean the probe went blind).
  const UNBOUNDED: Record<UiLocale, RegExp> = {
    'zh-CN': /不限|无限|無限/,
    en: /unlimited|unmetered|no limit/i,
    ja: /無制限|無限/,
    ko: /무제한|무한/,
    // 2026-08-14, five more languages. 🔴 A MISSING ROW HERE IS NOT A SILENT
    // PASS — `not.toMatch(undefined)` throws, which is how this table announced
    // itself the moment French shipped. That is the property worth keeping: the
    // annotation is `Record<UiLocale, …>`, so the compiler asks for the row and
    // the assertion refuses to run without it.
    'zh-TW': /不限|無限|無上限/,
    fr: /illimité|sans limite|non plafonné/i,
    es: /ilimitado|sin límite|sin limite/i,
    de: /unbegrenzt|unbeschränkt|ohne Limit/i,
    ru: /безлимит|неограничен|без ограничени/i,
  };

  // Other files in this suite assert zh-CN literals, and `S` is a process-wide
  // reactive object — leaving a switched locale behind would break them, not this one.
  afterEach(() => setLocale('zh-CN'));

  for (const loc of UI_LOCALES as readonly UiLocale[]) {
    it(`${loc}: renders the server's 3000 and does not call it boundless`, () => {
      setLocale(loc);
      const exempt = card(
        okRaw({ plan: 'free', source: 'permanent_free', quota_exempt: true, used_min: 128, limit_min: 3000 }),
      );
      const paid = card(okRaw({ plan: 'max', source: 'paddle', quota_exempt: false, used_min: 128, limit_min: 3000 }));

      // ① "the actual number in effect": the server's ceiling reaches the screen in this locale.
      //    This is also what catches a template that lost its `{limit}` placeholder.
      expect(exempt.gauge?.minutes?.label).toContain('3000');
      // ② the wording: no locale is allowed to answer "unlimited" any more.
      expect(exempt.gauge?.minutes?.label).not.toMatch(UNBOUNDED[loc]);
      // ②-bis owner 2026-08-27 put a SECOND label on this rail, and it is the one
      //    with no history of this defect — which is exactly why it is checked:
      //    「unlimited」 has been deleted from the minutes end, and re-introducing it
      //    at the token end would be the same lie in a place no assertion watched.
      expect(exempt.gauge?.context?.label).not.toMatch(UNBOUNDED[loc]);
      expect(exempt.gauge?.context?.label).toContain('1'); // the 1M ceiling really reached this locale
      // ③ POSITIVE CONTROL #1 — this locale really did render a usage line, so ②
      //    passing cannot mean 「the label was null/empty and matched nothing」.
      expect(exempt.gauge?.minutes?.label).not.toBeUndefined();
      expect(String(exempt.gauge?.minutes?.label).length).toBeGreaterThan(0);
      // ④ POSITIVE CONTROL #2 — `quota_exempt` still SELECTS a different sentence
      //    here. Without it, collapsing both branches into the paid string would
      //    satisfy ①②③ while quietly deleting the one thing that is still uniquely
      //    true of an exempt account (nothing is billed).
      expect(exempt.gauge?.minutes?.label).not.toBe(paid.gauge?.minutes?.label);
      expect(paid.gauge?.minutes?.label).toContain('3000');
    });
  }

  it('every exempt sentence is its own string — no locale fell back to another', () => {
    // locale-parity.test.ts proves the KEY exists everywhere; it cannot prove the
    // VALUE was translated. A row copy-pasted from zh-CN would pass every assertion
    // above (the zh-CN wording is correct) while shipping Chinese to a ko user.
    const rendered = (UI_LOCALES as readonly UiLocale[]).map((loc) => {
      setLocale(loc);
      return card(
        okRaw({ plan: 'free', source: 'permanent_free', quota_exempt: true, used_min: 128, limit_min: 3000 }),
      ).gauge?.minutes?.label;
    });
    expect(new Set(rendered).size).toBe(UI_LOCALES.length);
    // ⚠️ Deliberately NOT extended to the context label. 「上下文」 is the same word
    // in Simplified and Traditional Chinese, so zh-CN and zh-TW share that string
    // legitimately — a uniqueness check there would demand a difference that does
    // not exist and would be satisfied only by making one of them wrong.
  });
});

// ── ⑥ the Cloud Key row, after persistent login ──────────────────────────────
//
// Owner ruling 2026-08-27 §R1 (docs/decisions/2026-08-27-owner-persistent-login-
// and-routing-order.md) made the account JWT's default TTL 100 years. This row
// used to have exactly one shape — a date — and a date in the year 2126 is a
// TRUE number that answers a question nobody asked (「when do I have to sign in
// again?」 — never). So the row now has two arms, and BOTH are asserted here:
// dropping either one is how a fix in one direction becomes a lie in the other.
describe('⑥ Cloud Key validity: a far-out exp is a sentence, a near one is still a date', () => {
  const day = 24 * 60 * 60 * 1000;
  const NOW = new Date(2026, 7, 27, 12, 0, 0).getTime();

  function keyRow(expiresAt: number | null, nowMs = NOW): string | null {
    return deriveAccountCard({
      cloud: { ...SIGNED_IN, expires_at: expiresAt },
      raw: null,
      lastLive: null,
      loading: false,
      nowMs,
    }).keyExpiresText;
  }

  it('a 100-year key ⇒ the long-lived sentence, and NOT a date', () => {
    const row = keyRow(Math.floor((NOW + 100 * 365 * day) / 1000));
    expect(row).toBe('长期有效——本机退出登录前一直有效');
    // 🔴 The real failure mode is not「wrong words」, it is「a date leaked
    // through」. Asserted on the rendered value's SHAPE so a future rewording
    // cannot quietly restore one.
    expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('a 7-day legacy key ⇒ STILL a date (it really does lapse — same lie, other direction)', () => {
    const row = keyRow(Math.floor((NOW + 7 * day) / 1000));
    expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(row).not.toBe('长期有效——本机退出登录前一直有效');
  });

  it('the threshold is one year, and it is exercised from BOTH sides', () => {
    expect(LONG_LIVED_KEY_THRESHOLD_MS).toBe(365 * day);
    // one hour under ⇒ date; one hour over ⇒ sentence. A single-sided assertion
    // is satisfied by a constant that is merely「large」.
    expect(keyRow(Math.floor((NOW + 365 * day - 3600_000) / 1000))).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(keyRow(Math.floor((NOW + 365 * day + 3600_000) / 1000))).toBe('长期有效——本机退出登录前一直有效');
  });

  it('an expired / absent exp is unchanged: a past date renders, no key renders nothing', () => {
    expect(keyRow(Math.floor((NOW - 3 * day) / 1000))).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(keyRow(null)).toBeNull();
    expect(keyRow(0)).toBeNull();
  });

  it('every locale has its OWN long-lived sentence — none fell back to another', () => {
    const far = Math.floor((NOW + 100 * 365 * day) / 1000);
    const rendered = (UI_LOCALES as readonly UiLocale[]).map((loc) => {
      setLocale(loc);
      return keyRow(far);
    });
    // Positive control first: every locale rendered SOMETHING for this arm, so
    // the uniqueness check below cannot be satisfied by a pile of nulls.
    for (const r of rendered) expect(String(r).length).toBeGreaterThan(0);
    expect(new Set(rendered).size).toBe(UI_LOCALES.length);
  });
});

// ── a RESTRICTION is not an EXPIRY (owner ruling 2026-08-27 §R1 追加) ─────────
//
// Persistent login means the credential no longer expires on a clock, so the
// relay's per-call verdict is now the ONLY thing that can tell a user their
// account stopped being served. `403 ACCOUNT_RESTRICTED` used to arrive as
// outcome `unauthorized` and render as 「your login has expired, please sign in
// again」 — an instruction that succeeds and changes nothing, while the
// enumerated reason the Terms promise was thrown away one layer below.
describe('④ ACCOUNT_RESTRICTED: its own phase, its own sentence, and no button', () => {
  const restricted = (detail: string | null): CloudAccountRaw =>
    ({ outcome: 'restricted', fetched_at: null, detail, me: null, summary: null });

  it('phase is `restricted`, NOT `expired` — the two differ in what the user should do', () => {
    const c = card(restricted('terms_violation'));
    expect(c.phase).toBe('restricted');
    expect(c.phase).not.toBe('expired');
  });

  it('the red line says restricted and never tells the user to sign in again', () => {
    const c = card(restricted(null));
    expect(c.loud).toBe('这个账号已被限制使用，暂时无法使用云端中继。');
    // 🔴 The defect was not「wrong words」, it was「a dead-end action」. Asserted
    // on the rendered line so a rewording cannot quietly reintroduce one.
    expect(c.loud).not.toContain('重新登录');
    expect(c.loud).not.toBe(card({ outcome: 'unauthorized', fetched_at: null, detail: 'http 401', me: null, summary: null }).loud);
  });

  it('positive control: `unauthorized` still says "sign in again" — that arm is untouched', () => {
    const c = card({ outcome: 'unauthorized', fetched_at: null, detail: 'http 401', me: null, summary: null });
    expect(c.phase).toBe('expired');
    expect(c.loud).toBe('登录已过期，请重新登录。');
  });

  it('an enumerated reason is APPENDED from the protocol registry, not invented here', () => {
    const c = card(restricted('automated_or_bulk_use'));
    expect(c.loud).toContain('这个账号已被限制使用');
    // Read from RESTRICTION_REASONS, the same table the phone renders — so one
    // person cannot be told two different things by two of our screens.
    expect(c.loud).toContain(RESTRICTION_REASONS.automated_or_bulk_use.zh_CN);
  });

  it('a reason key this build does not know is KEPT and labelled, never dropped and never guessed', () => {
    const c = card(restricted('some_future_reason'));
    expect(c.loud).toContain('这个账号已被限制使用');
    // It is the one artefact the user could quote to us; inventing a sentence
    // would tell a real person something nobody decided about them.
    expect(c.loud).toContain('some_future_reason');
  });

  it('nothing else on the card is rendered, and there is no retry', () => {
    const c = card(restricted('terms_violation'));
    // Same stance as `expired`: no tier, no gauge, no stale numbers dressed as live.
    expect(c.account).toBeNull();
    expect(c.planBadge).toBeNull();
    expect(c.gauge).toBeNull();
    // 🔴 Re-asking returns the same 403. A button that must fail is the one this
    // repo has ruled against twice.
    expect(c.canRetry).toBe(false);
  });

  it('every locale has its OWN restricted sentence — none fell back to another', () => {
    const rendered = (UI_LOCALES as readonly UiLocale[]).map((loc) => {
      setLocale(loc);
      return card(restricted(null)).loud;
    });
    for (const r of rendered) expect(String(r).length).toBeGreaterThan(0);
    expect(new Set(rendered).size).toBe(UI_LOCALES.length);
  });
});

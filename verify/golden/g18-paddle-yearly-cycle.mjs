// verify/golden/g18-paddle-yearly-cycle.mjs
//
// G18 — annual-pay tier (window D1 Lane H), over a REAL saas server.
//
//   docs/strategy/2026-08-01-window-d1-handoff-report.md §1 (criterion grading), §2 last paragraph
//     (the assumption "this round does not do annual pay" was falsified that day by owner's action), §4 rule 2 (a test that only asserts the label is green on
//     "the label moved and the gate did not")
//   docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md (four prices)
//
// ── WHY A SEPARATE PATH FROM G17 ────────────────────────────────────────────
// G17 drives the collection chain end to end, and every frame it sends is
// MONTHLY. Three things are true only of an annual subscription and none of them
// is visible from there:
//   ① `billing_cycle` really does reach the read-out as "yearly" on the server
//      the product runs (G17 would pass unchanged if the field were dropped —
//      it never asserts a cycle other than 'monthly');
//   ② the expiry a yearly subscriber gets is the date PADDLE sent, a year out.
//      This is the expensive one: the tier lands correctly, nothing looks wrong
//      for four weeks, and then someone who paid for a year is silently cut to
//      free. "tier is right, expiry computed as monthly";
//   ③ the two annual prices owner created in the sandbox are wired to the right
//      TIERS ($60 → pro, $200 → max) rather than to each other's.
//
// ── owner 2026-08-01 ruling: test it thoroughly, but do not release ────────────────────────────────────
// "Test annual pay first; whether to open it is a phase-3 go-live call; you first need the integration tests solid; do not
// release it in launch phases 1–2". So this path also has to prove the WITHHOLDING mechanism, not
// just the feature: section ④ below is a second saas instance whose
// FLOWMIC_PADDLE_PRICE_TIERS simply does not name the annual prices, and there
// the very same shape of event moves nobody's tier. That is what makes
// "do not release in phases 1–2" an operational fact rather than an intention — the
// deployment does not have to carry a feature flag, it has to not carry a price.
//
// 🔴 EVERY TIER CLAIM IS ASSERTED TWICE — once on /api/cloud/subscription (what a
// console would show) and once on /api/cloud/summary's quota (what quota-guard.ts
// enforces). window D1 §4 rule 2: a test that only checks the label is GREEN on a build
// where the label moved and the gate did not.
//
// WHAT IT DOES NOT COVER, stated rather than glossed:
//   · Paddle itself — the bytes are signed here with the notification-secret
//     scheme (G17's header argues why that is still an independent oracle).
//   · the branches that need a fake clock or an unparseable payload: a NON-1
//     frequency (`year/2` must never be rounded into "yearly"), an absent /
//     explicitly-null billing_cycle, and the two-months-in downgrade proof.
//     Those are apps/server-core/test/paddle-webhook-handler.test.ts ⑥, which is
//     `requires`d below so the evidence cannot quietly disappear.
//   · any user-visible entry point to buying an annual plan. There is none, by
//     ruling — and it is not this file's job to assert an absence in the WEB
//     repo; that is a grep in the Lane H report.

import path from 'node:path';
import { ROOT, SERVER_DIST, startSaasServer, verifyRegisteredEmail, PASS, FAIL } from './harness.mjs';
import { paddleSignature, subscriptionFrame, diff } from './g17-paddle-billing-chain.mjs';

// ── the numbers, as LITERALS (same reasoning as G17/G15) ────────────────────
//
// 🔴 AUTHORITY, copied by hand from the ruling and deliberately NOT imported
// from apps/server-core/src/billing/plans.ts:
//   docs/decisions/2026-08-02-b12-plan-minute-quota-resizing-options.md §已裁
//   (owner 2026-08-02): minutes "pick C; free tier as you suggested" ⇒ 20 / 900 / 3,000,
//   tokens "free: 1M, pro: 20M, MAX 100M" ⇒ 1M / 20M / 100M.
//   ⇒ free $0 · 20 min · 1M / pro $6 · 900 min · 20M / max $20 · 3,000 min · 100M
//   The PRICE ids and the tier structure still come from the 2026-08-01 pricing
//   ruling cited in the header; B12 superseded only its QUOTA table (that
//   document's own header marks those numbers "no longer the current values").
// These six lines must be UPDATED BY HAND on the next ruling — see the longer
// note in g17-paddle-billing-chain.mjs for why that cost is the point.
const FREE_STT_MIN = 20;
const FREE_LLM = 1_000_000;
const PRO_STT_MIN = 900;
const PRO_LLM = 20_000_000;
const MAX_STT_MIN = 3_000;
const MAX_LLM = 100_000_000;

/** A throwaway notification-destination secret — never a real one. Different
 *  from G17's on purpose: two paths sharing one secret would let a bug that
 *  hard-codes it pass both. */
const WEBHOOK_SECRET = 'pdl_ntfset_g18_golden_secret_not_real_9876543210';

/** 🔴 owner's REAL Paddle SANDBOX price ids (product pro_01kyy5vssmc44azesvjh7dzad5).
 *  Not a secret — a price id is public the moment a checkout renders, and it
 *  carries no ability to charge anyone. They are written out verbatim rather than
 *  invented because the thing under test is "THESE four ids map to THOSE tiers",
 *  and a made-up id would test the mapping mechanism while saying nothing about
 *  the mapping owner actually configured. */
const PRICE_PRO_MONTHLY = 'pri_01kyy5yjgvgkmjm72ht50epkdf'; // $6 / month  → pro
const PRICE_PRO_YEARLY = 'pri_01kyy62zmgbxmb884xy1wy01vx'; //  $60 / year  → pro
const PRICE_MAX_YEARLY = 'pri_01kyy64thzy857jtn5xvjrve6w'; // $200 / year  → max

const YEARLY = { interval: 'year', frequency: 1 };
const MONTHLY = { interval: 'month', frequency: 1 };

const DAY_MS = 24 * 3600 * 1000;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Strictly increasing occurred_at stamps, in the microsecond precision Paddle
 *  really sends (envelope.ts must normalize them to 24 chars). */
const T1 = '2026-08-01T10:00:00.000000Z';
const T2 = '2026-08-01T11:00:00.000000Z';
const T3 = '2026-08-01T12:00:00.000000Z';

export const G18 = {
  id: 'G18',
  name: 'annual-pay tier (D1 Lane H: yearly→cycle+expires a year out+quota actually takes effect; reverse control=not configuring the price equals not released)',
  requires: [
    SERVER_DIST,
    // The yearly branches a wire test cannot reach: frequency ≠ 1 kept verbatim,
    // absent/null billing_cycle never defaulting to monthly, and the
    // two-months-in proof that needs a fake clock.
    path.join(ROOT, 'apps/server-core/test/paddle-webhook-handler.test.ts'),
  ],
  async fn() {
    const servers = [];
    try {
      /** Boot a saas instance whose Paddle block knows exactly `priceTiers`. */
      const boot = async (priceTiers) => {
        const s = await startSaasServer({
          FLOWMIC_PADDLE_ENABLED: '1',
          FLOWMIC_PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
          FLOWMIC_PADDLE_PRICE_TIERS: JSON.stringify(priceTiers),
          // Shaped like production (D1 §1: production mock billing is off). It also removes an
          // alternative explanation for every `source` below: with the mock
          // gateway off, `source:'none'` cannot be a mock artefact.
          FLOWMIC_MOCK_BILLING: '',
          // VERIFY-1 (2026-08-11): same gate + same internal code echo as G17's
          // note — signup() verifies each account through the real routes.
          FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO: '1',
        });
        servers.push(s);
        return `http://127.0.0.1:${s.port}`;
      };

      const post = async (url, rawBody) => {
        const res = await fetch(`${url}/api/paddle/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'paddle-signature': paddleSignature(rawBody, nowSec(), WEBHOOK_SECRET) },
          body: rawBody,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      const getJson = async (url, p, token) => {
        const res = await fetch(`${url}${p}`, { headers: { authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      /** ONE POST per account — /api/register and /api/login share a 5-per-10-min
       *  per-IP window, and the 201 already carries both the Bearer and the user
       *  id that goes into custom_data (G17's note explains this in full). */
      const signup = async (url, email) => {
        const res = await fetch(`${url}/api/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'longenough1', display_name: 'G18' }),
        });
        const body = await res.json().catch(() => null);
        if (res.status !== 201 || typeof body?.token !== 'string' || typeof body?.user?.id !== 'string') {
          throw new Error(`/api/register ${email} → ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
        }
        // VERIFY-1: pass the verification gate (send→confirm, code echoed).
        await verifyRegisteredEmail(url, body.token);
        return { id: body.user.id, token: body.token };
      };
      const planOf = async (url, token) => {
        const r = await getJson(url, '/api/cloud/subscription', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/subscription → ${r.status}`);
        return r.body?.subscription;
      };
      const quotaOf = async (url, token) => {
        const r = await getJson(url, '/api/cloud/summary', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/summary → ${r.status}`);
        return r.body?.quota;
      };
      const ledgerOf = async (url, token) => {
        const r = await getJson(url, '/api/cloud/billing/events', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/billing/events → ${r.status}`);
        return r.body?.events ?? [];
      };

      // The dates a real annual / monthly subscription would carry.
      const YEAR_END = new Date(Date.now() + 365 * DAY_MS).toISOString();
      const MONTH_END = new Date(Date.now() + 30 * DAY_MS).toISOString();

      // ════════════════════════════════════════════════════════════════════════
      // The instance that DOES sell annual plans — all four of owner's prices.
      // ════════════════════════════════════════════════════════════════════════
      const openUrl = await boot({
        [PRICE_PRO_MONTHLY]: 'pro',
        [PRICE_PRO_YEARLY]: 'pro',
        [PRICE_MAX_YEARLY]: 'max',
      });

      // ══ ① Pro ANNUAL: the tier, the cycle, the date — and the GATE ═══════════
      const proY = await signup(openUrl, 'g18-pro-yearly@flowmic.test');
      const beforeQuota = await quotaOf(openUrl, proY.token);
      if (beforeQuota?.stt?.limit_min !== FREE_STT_MIN) {
        // The "it moved" claims below are only worth anything if it started
        // somewhere else.
        return FAIL(`a brand-new account is not on the free line: ${JSON.stringify(beforeQuota)}`);
      }
      const proYearFrame = subscriptionFrame({
        event_id: 'evt_g18_pro_year', occurred_at: T1, notification_id: 'ntf_g18_pro_year',
        subscription_id: 'sub_g18_pro_year', price_id: PRICE_PRO_YEARLY, user_id: proY.id,
        period_end: YEAR_END, billing_cycle: YEARLY, customer_id: 'ctm_g18_golden',
      });
      const proYearRes = await post(openUrl, proYearFrame);
      if (proYearRes.status !== 200 || proYearRes.body?.outcome !== 'applied') {
        return FAIL(`a signed ANNUAL subscription.activated was not applied (${proYearRes.status} ${JSON.stringify(proYearRes.body)})`);
      }
      const proYearView = await planOf(openUrl, proY.token);
      const dY = diff(proYearView, {
        plan: 'pro', source: 'paddle', quota_exempt: false, state: 'active',
        cycle: 'yearly', expires_at: YEAR_END, paddle_subscription_id: 'sub_g18_pro_year',
      });
      if (dY) return FAIL(`the $60/year price did not read as 「pro, yearly, expiring on the date Paddle sent」 — ${dY}`);
      // 🔴 THE ONE THAT IS SILENT FOR FOUR WEEKS. `expires_at` being equal to the
      // string we sent is already asserted above; this says the same thing in the
      // units the failure is measured in, so a build that stored "a month from
      // now" fails here with a sentence a human can act on rather than a diff of
      // two ISO strings.
      const grantedDays = (Date.parse(proYearView.expires_at) - Date.now()) / DAY_MS;
      if (!(grantedDays > 300)) {
        return FAIL(`an ANNUAL subscriber was granted ${grantedDays.toFixed(1)} days — 档位对了、到期算成月付 is the exact failure this assertion exists for`);
      }
      const proYearQuota = await quotaOf(openUrl, proY.token);
      if (proYearQuota?.stt?.limit_min !== PRO_STT_MIN || proYearQuota?.llm?.limit !== PRO_LLM) {
        // window D1 §4 rule 2 — the label moved; this is the gate.
        return FAIL(`the console says pro/yearly but the QUOTA does not (expected ${PRO_STT_MIN} min / ${PRO_LLM}): ${JSON.stringify(proYearQuota)}`);
      }

      // ══ ② Max ANNUAL: a different price, a different tier, same cycle ═══════
      const maxY = await signup(openUrl, 'g18-max-yearly@flowmic.test');
      const maxYearFrame = subscriptionFrame({
        event_id: 'evt_g18_max_year', occurred_at: T2, notification_id: 'ntf_g18_max_year',
        subscription_id: 'sub_g18_max_year', price_id: PRICE_MAX_YEARLY, user_id: maxY.id,
        period_end: YEAR_END, billing_cycle: YEARLY, customer_id: 'ctm_g18_golden',
      });
      const maxYearRes = await post(openUrl, maxYearFrame);
      if (maxYearRes.status !== 200 || maxYearRes.body?.outcome !== 'applied') {
        return FAIL(`the $200/year price was not applied (${maxYearRes.status} ${JSON.stringify(maxYearRes.body)})`);
      }
      const maxYearView = await planOf(openUrl, maxY.token);
      const dM = diff(maxYearView, {
        plan: 'max', source: 'paddle', state: 'active', cycle: 'yearly',
        expires_at: YEAR_END, paddle_subscription_id: 'sub_g18_max_year',
      });
      if (dM) return FAIL(`the $200/year price did not read as 「max, yearly」 — ${dM}`);
      const maxYearQuota = await quotaOf(openUrl, maxY.token);
      if (maxYearQuota?.stt?.limit_min !== MAX_STT_MIN || maxYearQuota?.llm?.limit !== MAX_LLM) {
        return FAIL(`max/yearly does not enforce owner's numbers (${MAX_STT_MIN} min / ${MAX_LLM}): ${JSON.stringify(maxYearQuota)}`);
      }
      // …and the two annual accounts did not become each other. A server that
      // resolved every annual price to one tier would have passed ① and ② alone.
      if (proYearView.plan === maxYearView.plan) {
        return FAIL(`both annual prices resolved to the SAME tier (${proYearView.plan}) — the price→tier mapping is not being read`);
      }

      // ══ ③ 🔴 THE DISCRIMINATOR: a MONTHLY price on the SAME instance ════════
      //
      // Without this, every assertion above is also true of a build that answers
      // "yearly" to everything — including one that ignores `billing_cycle`
      // entirely and hard-codes the word.
      const proM = await signup(openUrl, 'g18-pro-monthly@flowmic.test');
      const proMonthFrame = subscriptionFrame({
        event_id: 'evt_g18_pro_month', occurred_at: T3, notification_id: 'ntf_g18_pro_month',
        subscription_id: 'sub_g18_pro_month', price_id: PRICE_PRO_MONTHLY, user_id: proM.id,
        period_end: MONTH_END, billing_cycle: MONTHLY, customer_id: 'ctm_g18_golden',
      });
      const proMonthRes = await post(openUrl, proMonthFrame);
      if (proMonthRes.status !== 200 || proMonthRes.body?.outcome !== 'applied') {
        return FAIL(`the $6/month price was not applied (${proMonthRes.status} ${JSON.stringify(proMonthRes.body)})`);
      }
      const proMonthView = await planOf(openUrl, proM.token);
      const dMo = diff(proMonthView, { plan: 'pro', source: 'paddle', state: 'active', cycle: 'monthly', expires_at: MONTH_END });
      if (dMo) return FAIL(`the monthly control did not read as 「pro, monthly」 — ${dMo}`);
      const monthDays = (Date.parse(proMonthView.expires_at) - Date.now()) / DAY_MS;
      if (!(monthDays < 40)) {
        return FAIL(`the MONTHLY control was granted ${monthDays.toFixed(1)} days — 「一年后到期」 above would be true of a server that grants a year to everyone`);
      }

      // ════════════════════════════════════════════════════════════════════════
      // ══ ④ 🔴 REVERSE CONTROL — the deployment that has NOT opened annual ════
      //
      // owner's ruling is that annual exists but is not released in phases 1–2.
      // The mechanism is simply NOT NAMING the annual prices in
      // FLOWMIC_PADDLE_PRICE_TIERS, and this section is what turns that sentence
      // into a tested fact: on an instance configured with the monthly price
      // ALONE, an annual event is recorded and changes nothing.
      // ════════════════════════════════════════════════════════════════════════
      const closedUrl = await boot({ [PRICE_PRO_MONTHLY]: 'pro' });
      const holdout = await signup(closedUrl, 'g18-holdout@flowmic.test');

      const holdoutYear = subscriptionFrame({
        event_id: 'evt_g18_holdout_year', occurred_at: T1, notification_id: 'ntf_g18_holdout_year',
        subscription_id: 'sub_g18_holdout_year', price_id: PRICE_PRO_YEARLY, user_id: holdout.id,
        period_end: YEAR_END, billing_cycle: YEARLY, customer_id: 'ctm_g18_golden',
      });
      const holdoutRes = await post(closedUrl, holdoutYear);
      // 200, not a 4xx: a refusal Paddle can retry would be redelivered forever
      // for an event we will never recognise.
      if (holdoutRes.status !== 200) {
        return FAIL(`an unconfigured annual price was answered ${holdoutRes.status} — Paddle would retry it forever: ${JSON.stringify(holdoutRes.body)}`);
      }
      if (holdoutRes.body?.outcome !== 'unmapped') {
        return FAIL(`an unconfigured annual price concluded as ${JSON.stringify(holdoutRes.body?.outcome)} — it must be recorded as unmapped, never silently ignored and never guessed into a tier`);
      }
      const holdoutView = await planOf(closedUrl, holdout.token);
      const dH = diff(holdoutView, { plan: 'free', source: 'none', state: 'none', cycle: null, expires_at: null, paddle_subscription_id: null });
      if (dH) return FAIL(`an unconfigured annual price moved somebody's plan — ${dH}`);
      const holdoutQuota = await quotaOf(closedUrl, holdout.token);
      if (holdoutQuota?.stt?.limit_min !== FREE_STT_MIN || holdoutQuota?.llm?.limit !== FREE_LLM) {
        return FAIL(`an unconfigured annual price moved the ENFORCED quota: ${JSON.stringify(holdoutQuota)}`);
      }
      const holdoutLedger = await ledgerOf(closedUrl, holdout.token);
      if (holdoutLedger.length !== 1 || holdoutLedger[0]?.outcome !== 'unmapped') {
        return FAIL(`the withheld annual event is not in the ledger as one unmapped row: ${JSON.stringify(holdoutLedger)}`);
      }
      if (!String(holdoutLedger[0]?.detail ?? '').includes(PRICE_PRO_YEARLY)) {
        // The ledger row is the ONLY place anyone will ever learn which price id
        // this deployment has not opened; a detail that does not name it is
        // useless on the day someone asks "why this customer did not get a plan".
        return FAIL(`the unmapped row does not name the annual price id: ${JSON.stringify(holdoutLedger[0]?.detail)}`);
      }

      // ── ④-bis THE POSITIVE CONTROL, on the SAME account and the SAME probes ─
      // The only difference between the refused event and this one is WHICH PRICE
      // ID it names. If the silence above were a blind probe (an instance that
      // cannot upgrade anyone, a webhook that 404s, a readout stuck on free) this
      // would be silent too — and section ④ would be proving nothing at all.
      const holdoutMonth = subscriptionFrame({
        event_id: 'evt_g18_holdout_month', occurred_at: T2, notification_id: 'ntf_g18_holdout_month',
        subscription_id: 'sub_g18_holdout_month', price_id: PRICE_PRO_MONTHLY, user_id: holdout.id,
        period_end: MONTH_END, billing_cycle: MONTHLY, customer_id: 'ctm_g18_golden',
      });
      const holdoutMonthRes = await post(closedUrl, holdoutMonth);
      if (holdoutMonthRes.status !== 200 || holdoutMonthRes.body?.outcome !== 'applied') {
        return FAIL(`the SAME account with a CONFIGURED price was not upgraded (${holdoutMonthRes.status} ${JSON.stringify(holdoutMonthRes.body)}) — the 「年付没生效」 assertions above proved nothing`);
      }
      const holdoutAfter = await planOf(closedUrl, holdout.token);
      if (holdoutAfter?.plan !== 'pro' || holdoutAfter?.cycle !== 'monthly') {
        return FAIL(`the positive control did not take effect: ${JSON.stringify(holdoutAfter)}`);
      }
      const holdoutAfterQuota = await quotaOf(closedUrl, holdout.token);
      if (holdoutAfterQuota?.stt?.limit_min !== PRO_STT_MIN) {
        return FAIL(`the positive control moved the label but not the gate: ${JSON.stringify(holdoutAfterQuota)}`);
      }

      return PASS(
        'real saas server (bootstrap-wired, paddle block resolved from its own env), owner\'s REAL sandbox price ids: '
        + `$60/year → {plan:pro, cycle:yearly}, expires_at EXACTLY the date Paddle sent and ${grantedDays.toFixed(0)} days out (>300), with the gate at ${PRO_STT_MIN} min/${PRO_LLM} asserted SEPARATELY from the label; `
        + `$200/year → {plan:max, cycle:yearly} enforcing ${MAX_STT_MIN} min/${MAX_LLM}, and the two annual prices provably did NOT resolve to the same tier; `
        + `discriminator: $6/month on the SAME instance → {cycle:monthly, ${monthDays.toFixed(0)} days} — so 「yearly」 above is a value that was read, not a word that is always printed; `
        + '🔴 reverse control (the withholding mechanism owner\'s ruling depends on): a second instance whose FLOWMIC_PADDLE_PRICE_TIERS does not name the annual prices answers the SAME annual event 200/unmapped — ledger row present and naming the price id, plan free/source none, ZERO movement in the enforced quota — and then the SAME ACCOUNT with a CONFIGURED price is upgraded to pro on the same probes, so the silence is provably not a blind probe. '
        + 'NOT covered here: Paddle itself (no sandbox delivery), a NON-1 frequency / absent / null billing_cycle and the two-months-in downgrade proof (fake-clock unit tests in apps/server-core/test/paddle-webhook-handler.test.ts ⑥, `requires`d), and any purchase entry point — there is none this round, by owner\'s ruling.',
      );
    } catch (e) {
      return FAIL(`threw: ${e.stack ?? e.message}`);
    } finally {
      for (const s of servers) {
        try { s.child.kill(); } catch { /* already gone */ }
      }
    }
  },
};

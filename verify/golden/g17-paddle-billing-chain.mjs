// verify/golden/g17-paddle-billing-chain.mjs
//
// G17 — the collection chain (window D1: Paddle sandbox), over a REAL saas server.
//
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §7 (this path, item by
//   item), §5.2/§5.3 (what is being driven), §3.3-bis (the redelivery assertions,
//   as corrected), §6.1/§6.1-bis (the single plan resolver + the exemption).
//
// WHY THIS PATH EXISTS AT ALL, given that signature / handler / repo / resolver
// each already have their own unit tests: every one of those constructs its own
// deps and its own clock. The question none of them can answer is "the server
// THE PRODUCT RUNS — booted from its own env, wiring its own config — takes money
// news from Paddle and turns it into the number the quota gate enforces". That
// spans five files owned by four lanes plus a router mount that is conditional on
// `mode === 'saas' && config.paddle.enabled`, and a mis-wire anywhere in it is
// invisible to all of them: `bootstrap` could simply not pass `paddle`, and every
// unit test in the repo would still be green while the endpoint 404s.
//
// 🔴 THE HEADLINE RED LINE OF THE WINDOW is "shows as upgraded but the server did not take effect" (or the
// reverse). So this path never asserts a LABEL without also asserting the NUMBER
// behind it: every tier transition below is checked twice — once on
// `GET /api/cloud/subscription` (what a console would show) and once on
// `GET /api/cloud/summary`'s quota (what `quota-guard.ts` will enforce). A build
// where those two drift apart passes a label-only test.
//
// WHAT IT DOES NOT COVER, stated rather than glossed:
//   · Paddle itself. Nothing here talks to sandbox.paddle.com — the bytes are
//     signed by this file with the notification-secret scheme, so what is proven
//     is "a sender holding the secret is believed, and one that does not is not".
//     Whether the fixture SHAPE matches what Paddle really posts is pinned by
//     apps/server-core/test/paddle-webhook-handler.test.ts's fixtures and, in the
//     end, only by a real sandbox delivery (D1 §9 — out of this round's scope).
//   · the out-of-order guard (`stale`) and the conflicting-tier refusal — those need a fake
//     clock and hand-built rows; they are `requires`d below so they cannot quietly
//     disappear.
//   · the web console's rendering of any of this (that half is the web repo:
//     BillingView + its "when the server returns an object, activePlan is pro" regression test).
//   · a public network / nginx / TLS between the ends — this server is loopback.
//     That half is deploy/cloud-chain.mjs §8 in the web repo (refusals only: it
//     runs against PRODUCTION and must never mint a fake subscription there).
//
// ⚠️ WHY THE SIGNATURE IS RE-IMPLEMENTED HERE rather than imported from
// `billing/paddle/signature.ts` (which exports `signPaddlePayload` for exactly
// this purpose). Two reasons, and the second is the real one:
//   ① golden runs `dist/index.js`; that export lives in the source tree and is
//      not part of any published entrypoint.
//   ② a request signed by the verifier's own module proves "the file agrees with
//      itself". The four lines below are derived from Paddle's published scheme
//      (`ts=<unix>;h1=<hex>` over `${ts}:${rawBody}`, HMAC-SHA256) and NOT from
//      our implementation, so a build that silently changed the signed payload
//      would fail here — which is the whole point of an independent oracle. The
//      module's own header makes the same argument about its unit test.

import path from 'node:path';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, SERVER_DIST, startSaasServer, verifyRegisteredEmail, PASS, FAIL } from './harness.mjs';

// ── the numbers, written as LITERALS on purpose ─────────────────────────────
//
// Same reasoning G15 states for repeating 1 MiB / 200: a harness that imported
// the same table the server imports could not tell "pro is 900 minutes" from
// "pro is whatever the constant happens to say". `plan-limits.test.ts` pins the
// constants to each other; THIS pins the running server to the numbers owner
// actually said.
//
// 🔴 WHERE THE AUTHORITY LIVES — copied by hand from the RULING, never imported:
//   docs/decisions/2026-08-02-b12-plan-minute-quota-resizing-options.md §已裁
//   (owner 2026-08-02, two rulings the same day):
//     ① minutes "pick C; free tier as you suggested"        ⇒ free 20 / pro 900 / max 3,000
//     ② tokens  "TOKEN limits can be dropped for all plans; for safety, set a max TOKEN count,
//                 free: 1M, pro: 20M, MAX 100M"  ⇒ free 1M / pro 20M / max 100M
//   ⇒ free $0 · 20 min · 1M / pro $6 · 900 min · 20M / max $20 · 3,000 min · 100M
//   The PRICES, the three-tier structure and the price_id→tier map still come
//   from 2026-08-01-owner-three-tier-pricing-usd-monthly.md — B12 superseded
//   only that document's QUOTA table, and its own header says so. Do not read
//   quota numbers out of it; it is explicitly marked "no longer the current values".
//
// 🔴 SO THESE SIX LINES HAVE TO BE EDITED BY HAND ON THE NEXT RULING. That is
// the design, not an oversight, and the cost has already been paid once: B12
// landed in an EARLIER round and left G17/G18 red until someone ran
// `pnpm verify:delivery` — which pre-commit does not run (the G12 shape:
// "a test written that nobody invokes = the runtime edition of a façade"). The alternative — importing
// PLAN_LIMITS — would have kept this path green through that re-cut and through
// every future one, including a silent one. A test that reads the value it is
// checking asserts nothing at all; red-until-updated IS the mechanism.
const FREE_STT_MIN = 20;
const FREE_LLM = 1_000_000;
const PRO_STT_MIN = 900;
const PRO_LLM = 20_000_000;
const MAX_STT_MIN = 3_000;
const MAX_LLM = 100_000_000;

/** config.ts's DEFAULT_PADDLE_TOLERANCE_SEC (the Paddle SDK default). Deliberately
 *  NOT set in this instance's env: the expired control below has to be refused by
 *  the tolerance this deployment runs with when nobody configures one. The stale
 *  stamp is pushed an hour out, so the control holds for any sane value — the
 *  literal is here to say WHICH window is being trusted, not to tune the test. */
const TOLERANCE_SEC = 5;

/** A throwaway notification-destination secret. 🔴 Never a real one: a production
 *  webhook secret in the repo would let anyone mint subscription events. */
const WEBHOOK_SECRET = 'pdl_ntfset_g17_golden_secret_not_real_0123456789';

/** The price ids this instance is configured to understand, and one it is not.
 *  `pri_g17_unconfigured` is the whole of item ⑧: an unmapped price must land in
 *  the ledger as `unmapped` and change nobody's tier — "must never be guessed as pro". */
const PRICE_PRO = 'pri_g17_pro_monthly';
const PRICE_MAX = 'pri_g17_max_monthly';
const PRICE_UNMAPPED = 'pri_g17_unconfigured';

/** occurred_at stamps, strictly increasing so the out-of-order guard never fires here (it
 *  has its own fake-clock coverage). Microsecond precision on purpose: that is
 *  what Paddle sends, and it is what envelope.ts must normalize to 24 chars. */
const T_ACTIVATE = '2026-08-01T10:00:00.000000Z';
const T_UPGRADE = '2026-08-01T11:00:00.000000Z';
const T_CANCEL = '2026-08-01T12:00:00.000000Z';

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paddle's `Paddle-Signature`, built from the published scheme (see ⚠️ above).
 *
 *  EXPORTED for g18-paddle-yearly-cycle.mjs, which drives the same webhook with
 *  its OWN secret and its own instances. That is the harness.mjs rule applied one
 *  level down: a second copy of "how a Paddle frame is signed" would be one more
 *  definition to forget to update, and the copy nobody updates is always the one
 *  running when it matters. The independent-oracle argument above is unaffected —
 *  this is still derived from Paddle's published scheme, not from our verifier. */
export function paddleSignature(rawBody, tsSec, secret) {
  return `ts=${tsSec};h1=${createHmac('sha256', secret).update(`${tsSec}:${rawBody}`).digest('hex')}`;
}

function signature(rawBody, tsSec) {
  return paddleSignature(rawBody, tsSec, WEBHOOK_SECRET);
}

/** A subscription notification, as bytes. Returns the STRING that gets signed and
 *  posted — never an object: re-serializing between signing and sending is the
 *  one mistake that makes every signature fail (and the one this repo's route
 *  header warns about).
 *
 *  `billing_cycle` defaults to the monthly shape every G17 step uses; G18 passes
 *  the annual one. It is a PARAMETER rather than a second fixture for the reason
 *  on `paddleSignature` above — and defaulting it keeps every existing caller
 *  byte-identical. */
export function subscriptionFrame({
  event_id, event_type = 'subscription.activated', occurred_at, notification_id,
  subscription_id, price_id, status = 'active', user_id, period_end, canceled_at = null,
  billing_cycle = { interval: 'month', frequency: 1 }, customer_id = 'ctm_g17_golden',
}) {
  return JSON.stringify({
    event_id,
    event_type,
    occurred_at,
    notification_id,
    data: {
      id: subscription_id,
      status,
      customer_id,
      items: [{ price: { id: price_id } }],
      billing_cycle,
      current_billing_period: { starts_at: '2026-08-01T00:00:00.000000Z', ends_at: period_end },
      custom_data: { flowmic_user_id: user_id },
      ...(canceled_at === null ? {} : { canceled_at }),
    },
  });
}

/** Every field of `expected` that the readout disagrees with — ALL of them, not
 *  just the first: a plan readout that is wrong in three places should say so
 *  once instead of costing three runs. */
export function diff(actual, expected) {
  const out = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual?.[k] !== v) out.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual?.[k])}`);
  }
  return out.length > 0 ? out.join('; ') : null;
}

export const G17 = {
  id: 'G17',
  name: 'collection chain (D1: Paddle webhook → signature check/idempotency/tier/exemption, two reverse controls)',
  requires: [
    SERVER_DIST,
    // The branches a wire test cannot reach, each `requires`d so the evidence
    // cannot vanish while this path keeps claiming the chain is covered:
    //   · the four refusal reasons + h1 rotation + "secret never in the verdict";
    path.join(ROOT, 'apps/server-core/test/paddle-signature.test.ts'),
    //   · the ordering guard, the timestamp normalization and the refusal to
    //     guess a tier when two items disagree — all fake-clock / hand-built rows;
    path.join(ROOT, 'apps/server-core/test/paddle-webhook-handler.test.ts'),
    //   · the resolver's full priority matrix (mock vs paddle vs exemption);
    path.join(ROOT, 'apps/server-core/test/plan-view-resolution.test.ts'),
    //   · the standalone clamp itself — "refuses even when bootstrap passes
    //     paddle in standalone" cannot be staged from out here.
    path.join(ROOT, 'apps/server-core/test/paddle-webhook-route.test.ts'),
  ],
  /** @param standaloneUrl the shared standalone instance every G is handed. */
  async fn(standaloneUrl) {
    // Its OWN saas instance, and — unlike every other G — a FILE database.
    // Two things this path has to do have no HTTP surface at all and never will:
    //   ① mark an account `permanent_free` (owner does it by hand; UserRepo has
    //      `setPermanentFree` and nothing routes to it — deliberately, D1 §3.1);
    //   ② let a subscription's `current_period_end` fall into the past, which in
    //      production is "time passed" and here has to be "the row changed",
    //      because a golden path cannot wait a month (same shape as G15's note
    //      about the 24-hour roll).
    // Both are done with the SAME SQL the product runs, against the SAME file,
    // and neither bypasses anything under test: the expiry decision is made at
    // READ time, in BillingService, on whatever the column says.
    let dir = null;
    let saas = null;
    let db = null;
    try {
      // ══ ⓪ the endpoint DOES NOT EXIST on the standalone product ═══════════
      // A webhook ingress on someone's LAN PC is pure attack surface: there is no
      // merchant of record there and nothing to bill. 404 and NOT 401 is the
      // assertion — a 401 would mean the route is mounted and merely declining,
      // which is one config edit away from being live. (This drives the shared
      // standalone instance as it is actually configured; the clamp that would
      // force `enabled=false` even if someone SET the env is owned by
      // test/paddle-webhook-route.test.ts, `requires`d above.)
      const onStandalone = await fetch(`${standaloneUrl}/api/paddle/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (onStandalone.status !== 404) {
        return FAIL(`the standalone product answers ${onStandalone.status} on /api/paddle/webhook — the route must not exist there at all`);
      }

      dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g17-'));
      const dbPath = path.join(dir, 'g17.sqlite');
      try {
        saas = await startSaasServer({
          FLOWMIC_DB_PATH: dbPath,
          FLOWMIC_PADDLE_ENABLED: '1',
          FLOWMIC_PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
          FLOWMIC_PADDLE_PRICE_TIERS: JSON.stringify({ [PRICE_PRO]: 'pro', [PRICE_MAX]: 'max' }),
          // Shaped like production (D1 §1: production mock billing is off). It also removes an
          // alternative explanation for every `source` below — with the mock
          // gateway off, `source:'none'` cannot be a mock artefact.
          FLOWMIC_MOCK_BILLING: '',
          // VERIFY-1 (2026-08-11): the console reads below (subscription/summary/
          // billing-events) now sit behind the email-verification gate; the
          // internal code echo (M1 reset-echo precedent) is how a spawned dist
          // server with no mail channel lets signup() pass it.
          FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO: '1',
        });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      const url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);

      // ── the wire helpers, all four of them ────────────────────────────────
      const post = async (rawBody, sig) => {
        const res = await fetch(`${url}/api/paddle/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(sig === undefined ? {} : { 'paddle-signature': sig }) },
          body: rawBody,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      const getJson = async (p, token) => {
        const res = await fetch(`${url}${p}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      /** ONE POST per account, and that is not laziness: /api/register and
       *  /api/login share a 5-per-10-min per-IP window (auth/register-rate-limit.ts),
       *  and this path needs three accounts. `saasJwt()` in the harness spends two
       *  attempts each (register + login), which would draw a 429 on the third
       *  account and report a rate limit as a billing failure. The 201 already
       *  carries both things needed here — the Bearer AND the user id that goes
       *  into `custom_data.flowmic_user_id`. */
      const signup = async (email, name) => {
        const res = await fetch(`${url}/api/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'longenough1', display_name: name }),
        });
        const body = await res.json().catch(() => null);
        if (res.status !== 201 || typeof body?.token !== 'string' || typeof body?.user?.id !== 'string') {
          throw new Error(`/api/register ${email} → ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
        }
        // VERIFY-1: pass the verification gate (send→confirm, code echoed) —
        // every console read below would otherwise honestly 403.
        await verifyRegisteredEmail(url, body.token);
        return { id: body.user.id, token: body.token };
      };
      const planOf = async (token) => {
        const r = await getJson('/api/cloud/subscription', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/subscription → ${r.status}`);
        return r.body?.subscription;
      };
      const quotaOf = async (token) => {
        const r = await getJson('/api/cloud/summary', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/summary → ${r.status}`);
        return r.body?.quota;
      };
      const ledgerOf = async (token) => {
        const r = await getJson('/api/cloud/billing/events', token);
        if (r.status !== 200) throw new Error(`GET /api/cloud/billing/events → ${r.status}`);
        return r.body?.events ?? [];
      };

      // ── the DB probes (see the note on the file database above) ───────────
      const countEvents = () => Number(db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n);
      const eventRow = (id) => db.prepare('SELECT * FROM billing_events WHERE event_id=?').get(id) ?? null;
      const subRow = (id) => db.prepare('SELECT * FROM paddle_subscriptions WHERE subscription_id=?').get(id) ?? null;

      const FUTURE_END = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      const PAST_END = new Date(Date.now() - 60 * 1000).toISOString();

      // ══ ① a brand-new account is free, and SAYS SO HONESTLY ═══════════════
      const payer = await signup('g17-payer@flowmic.test', 'G17 payer');
      const before = await planOf(payer.token);
      const d1 = diff(before, {
        plan: 'free', source: 'none', quota_exempt: false, state: 'none',
        expires_at: null, paddle_subscription_id: null, cycle: null,
      });
      if (d1) return FAIL(`a brand-new account should be {plan:free, source:none} — ${d1}`);
      const freeQuota = await quotaOf(payer.token);
      if (freeQuota?.stt?.limit_min !== FREE_STT_MIN || freeQuota?.llm?.limit !== FREE_LLM) {
        return FAIL(`free tier does not enforce owner's numbers (${FREE_STT_MIN} min / ${FREE_LLM}): ${JSON.stringify(freeQuota)}`);
      }
      if ((await ledgerOf(payer.token)).length !== 0) return FAIL('a brand-new account already has billing events');
      // The reconciliation ledger holds who paid what — it is Bearer-gated, and
      // the anonymous refusal is named rather than empty (an empty 200 would read
      // as "you have no events").
      const anonLedger = await getJson('/api/cloud/billing/events');
      if (anonLedger.status !== 401) return FAIL(`GET /api/cloud/billing/events without a Bearer should be 401, got ${anonLedger.status}`);

      // ══ ② a signed subscription.activated upgrades him, and the QUOTA moves ═
      const activate = subscriptionFrame({
        event_id: 'evt_g17_activate', occurred_at: T_ACTIVATE, notification_id: 'ntf_g17_first',
        subscription_id: 'sub_g17_a', price_id: PRICE_PRO, user_id: payer.id, period_end: FUTURE_END,
      });
      const act = await post(activate, signature(activate, nowSec()));
      if (act.status !== 200) return FAIL(`a correctly signed subscription.activated was answered ${act.status}: ${JSON.stringify(act.body)}`);
      if (act.body?.outcome !== 'applied' || act.body?.duplicate !== false) {
        return FAIL(`activation was accepted but not applied: ${JSON.stringify(act.body)}`);
      }
      const pro = await planOf(payer.token);
      const d2 = diff(pro, {
        plan: 'pro', source: 'paddle', quota_exempt: false, state: 'active',
        cycle: 'monthly', expires_at: FUTURE_END, paddle_subscription_id: 'sub_g17_a',
      });
      if (d2) return FAIL(`after a paid activation the read-out is wrong — ${d2}`);
      const proQuota = await quotaOf(payer.token);
      if (proQuota?.stt?.limit_min !== PRO_STT_MIN || proQuota?.llm?.limit !== PRO_LLM) {
        // 🔴 THE RED LINE OF THE WINDOW. A build that flips the label and not the
        // limit shows "upgraded" while the gate still enforces the free 20 minutes.
        return FAIL(`the console says pro but the QUOTA does not (expected ${PRO_STT_MIN} min / ${PRO_LLM}): ${JSON.stringify(proQuota)}`);
      }
      const stored = subRow('sub_g17_a');
      if (stored?.tier !== 'pro' || stored?.status !== 'active' || stored?.user_id !== payer.id) {
        return FAIL(`the stored subscription row disagrees with the read-out: ${JSON.stringify(stored)}`);
      }
      // The normalization the ordering guard rests on, end to end: Paddle sent
      // microseconds, the column must hold fixed-width 24-char UTC.
      if (stored.last_occurred_at !== '2026-08-01T10:00:00.000Z') {
        return FAIL(`occurred_at was not normalized on the real pipeline: ${JSON.stringify(stored.last_occurred_at)}`);
      }
      const led2 = await ledgerOf(payer.token);
      if (led2.length !== 1 || led2[0]?.event_id !== 'evt_g17_activate' || led2[0]?.outcome !== 'applied' || led2[0]?.redelivery_count !== 0) {
        return FAIL(`the ledger did not record the activation as one applied row: ${JSON.stringify(led2)}`);
      }

      // ══ ③ redelivery is a no-op that still leaves a trace ═════════════════
      //
      // D1 §3.3-bis: `event_id` is the PRIMARY KEY, so a retry CANNOT mint a
      // second row (the initial §7 draft asked for one and Lane A falsified it
      // before writing the code). What has to be true instead: same row count,
      // the row still says `applied`, `redelivery_count` 0 → 1, and the
      // subscription's `updated_at` did not move.
      const beforeCount = countEvents();
      const beforeSub = subRow('sub_g17_a');
      // ⚠️ Not politeness: `updated_at` is `new Date(now).toISOString()`, so two
      // writes inside the same millisecond would produce the SAME string and the
      // "was not rewritten" assertion below would pass vacuously. The gap makes a re-apply
      // necessarily visible.
      await sleep(20);
      const replay = await post(activate, signature(activate, nowSec()));
      if (replay.status !== 200) return FAIL(`a redelivery must be 200 or Paddle retries forever — got ${replay.status}`);
      if (replay.body?.duplicate !== true) return FAIL(`a redelivery was not reported as a duplicate: ${JSON.stringify(replay.body)}`);
      if (countEvents() !== beforeCount) return FAIL(`a redelivery minted a second ledger row (${beforeCount} → ${countEvents()})`);
      const afterReplay = eventRow('evt_g17_activate');
      if (afterReplay?.outcome !== 'applied') {
        return FAIL(`the redelivery overwrote the row's verdict (outcome is now ${JSON.stringify(afterReplay?.outcome)}) — 「它生效过」 is the fact that must survive`);
      }
      if (Number(afterReplay?.redelivery_count) !== 1) {
        return FAIL(`redelivery_count is ${JSON.stringify(afterReplay?.redelivery_count)} after one retry — 「Paddle 又送了几次」 must not be a silent drop`);
      }
      if (subRow('sub_g17_a')?.updated_at !== beforeSub?.updated_at) {
        return FAIL('a redelivery rewrote the subscription row — the idempotency gate is not stopping the state write');
      }

      // ── ③-bis 🔴 THE RETRY PADDLE ACTUALLY SENDS ──────────────────────────
      //
      // The verbatim replay above is D1 §7's literal wording, and on its own it
      // CANNOT tell an `event_id`-keyed gate from a `notification_id`-keyed one:
      // identical bytes carry an identical notification_id, so both implementations
      // answer "duplicate". Paddle mints a NEW ntf_ per delivery attempt — which
      // is precisely the mistake §3.3 calls out ("the idempotency table exists but never took effect even once"). So
      // the retry that matters is the same event under a different delivery id.
      const retryBytes = activate.replace('ntf_g17_first', 'ntf_g17_retry');
      if (retryBytes === activate) return FAIL('the retry fixture is identical to the first delivery — this control would prove nothing');
      await sleep(20);
      const replay2 = await post(retryBytes, signature(retryBytes, nowSec()));
      if (replay2.body?.duplicate !== true || replay2.status !== 200) {
        return FAIL(`the SAME event under a new notification_id was treated as new (${replay2.status} ${JSON.stringify(replay2.body)}) — the dedup key is the delivery attempt, not the event`);
      }
      const afterReplay2 = eventRow('evt_g17_activate');
      if (Number(afterReplay2?.redelivery_count) !== 2) return FAIL(`redelivery_count is ${JSON.stringify(afterReplay2?.redelivery_count)} after two retries`);
      if (afterReplay2?.notification_id !== 'ntf_g17_first' || afterReplay2?.last_notification_id !== 'ntf_g17_retry') {
        // first delivery and most recent are two questions and two columns (§3.3-bis).
        return FAIL(`the notification ids collapsed: first=${JSON.stringify(afterReplay2?.notification_id)} last=${JSON.stringify(afterReplay2?.last_notification_id)}`);
      }
      if (subRow('sub_g17_a')?.updated_at !== beforeSub?.updated_at) return FAIL('the second redelivery rewrote the subscription row');

      // ══ ④ 🔴 REVERSE CONTROL ①: one byte of the body changed in flight ════
      //
      // Built so that the refused request and the accepted one carry IDENTICAL
      // BYTES — the ONLY difference is the signature. That removes every other
      // explanation for the 401 (malformed json, unknown event type, a bad price)
      // and makes the positive control below exact.
      const upgrade = subscriptionFrame({
        event_id: 'evt_g17_upgrade', occurred_at: T_UPGRADE, notification_id: 'ntf_g17_upgrade',
        subscription_id: 'sub_g17_a', price_id: PRICE_MAX, user_id: payer.id, period_end: FUTURE_END,
      });
      const goodSigForOriginal = signature(upgrade, nowSec());
      // One character, same length — still valid JSON, still a coherent event.
      const tampered = upgrade.replace('evt_g17_upgrade', 'evt_g17_upgradz');
      if (tampered === upgrade || tampered.length !== upgrade.length) {
        return FAIL('the tamper fixture did not change exactly one byte — the control would not be testing what it says');
      }
      const countBeforeTamper = countEvents();
      const subBeforeTamper = subRow('sub_g17_a');
      const tamperRes = await post(tampered, goodSigForOriginal);
      if (tamperRes.status !== 401) {
        return FAIL(`a body altered in flight was answered ${tamperRes.status}, not 401: ${JSON.stringify(tamperRes.body)}`);
      }
      if (tamperRes.body?.error !== 'PADDLE_SIGNATURE_INVALID' || tamperRes.body?.reason !== 'mismatch') {
        return FAIL(`the tampered body was refused, but not by the right name/reason: ${JSON.stringify(tamperRes.body)}`);
      }
      if (JSON.stringify(tamperRes.body).includes(WEBHOOK_SECRET)) return FAIL('the refusal echoed the webhook secret');
      // 🔴 THE ASSERTION THAT MATTERS MORE THAN THE STATUS CODE (the G13 lesson):
      // an implementation that answers 401 and applies the event anyway passes a
      // code-only test while handing out plans to anyone who can POST.
      if (countEvents() !== countBeforeTamper) {
        return FAIL(`a request refused with 401 still wrote ${countEvents() - countBeforeTamper} ledger row(s)`);
      }
      if (eventRow('evt_g17_upgradz') !== null || eventRow('evt_g17_upgrade') !== null) {
        return FAIL('a request refused with 401 left a ledger row behind');
      }
      const subAfterTamper = subRow('sub_g17_a');
      if (subAfterTamper?.tier !== 'pro' || subAfterTamper?.updated_at !== subBeforeTamper?.updated_at
        || subAfterTamper?.last_event_id !== 'evt_g17_activate') {
        return FAIL(`a request refused with 401 still moved the subscription: ${JSON.stringify(subAfterTamper)}`);
      }
      const stillPro = await planOf(payer.token);
      if (stillPro?.plan !== 'pro') return FAIL(`the read-out changed after a refused request: ${JSON.stringify(stillPro)}`);
      const stillProQuota = await quotaOf(payer.token);
      if (stillProQuota?.stt?.limit_min !== PRO_STT_MIN) return FAIL('the enforced quota changed after a refused request');

      // ── ④-bis THE POSITIVE CONTROL, on the SAME probes ────────────────────
      // Byte-for-byte the request that was just refused, signed correctly. If the
      // silence above were a blind probe (a broken count query, a route that 404s,
      // an account that cannot be upgraded at all) this would be silent too.
      const upgradeRes = await post(tampered, signature(tampered, nowSec()));
      if (upgradeRes.status !== 200 || upgradeRes.body?.outcome !== 'applied') {
        return FAIL(`the SAME bytes with a valid signature were not applied (${upgradeRes.status} ${JSON.stringify(upgradeRes.body)}) — the 401 above proved nothing`);
      }
      if (countEvents() !== countBeforeTamper + 1) return FAIL('the accepted request did not add a ledger row — the count probe is blind');
      const maxView = await planOf(payer.token);
      const d4 = diff(maxView, { plan: 'max', source: 'paddle', state: 'active', paddle_subscription_id: 'sub_g17_a' });
      if (d4) return FAIL(`the accepted upgrade did not take effect — ${d4}`);
      const maxQuota = await quotaOf(payer.token);
      if (maxQuota?.stt?.limit_min !== MAX_STT_MIN || maxQuota?.llm?.limit !== MAX_LLM) {
        return FAIL(`max does not enforce owner's numbers (${MAX_STT_MIN} min / ${MAX_LLM}): ${JSON.stringify(maxQuota)}`);
      }

      // ══ ⑤ 🔴 REVERSE CONTROL ②: a correct signature with a stale timestamp ═
      //
      // Same two-part shape, and the discriminator is the REASON: this frame's
      // HMAC is right, so `expired` is the only honest answer. Asserting merely
      // "401" here would make this a second copy of control ④.
      const cancel = subscriptionFrame({
        event_id: 'evt_g17_cancel', event_type: 'subscription.canceled', occurred_at: T_CANCEL,
        notification_id: 'ntf_g17_cancel', subscription_id: 'sub_g17_a', price_id: PRICE_MAX,
        status: 'canceled', user_id: payer.id, period_end: FUTURE_END, canceled_at: T_CANCEL,
      });
      const countBeforeStale = countEvents();
      const subBeforeStale = subRow('sub_g17_a');
      // An hour PLUS the window, so the control holds whatever the deployment's
      // tolerance is — the literal is here to say which window is being trusted,
      // not to tune the margin.
      const staleTs = nowSec() - (TOLERANCE_SEC + 3600);
      const staleRes = await post(cancel, signature(cancel, staleTs));
      if (staleRes.status !== 401) return FAIL(`an hour-old timestamp was answered ${staleRes.status}, not 401: ${JSON.stringify(staleRes.body)}`);
      if (staleRes.body?.reason !== 'expired') {
        return FAIL(`a correctly-signed but stale frame was refused as ${JSON.stringify(staleRes.body?.reason)} — 「时钟不对」 and 「密钥不对」 are two different repairs and this one must not hide inside the other`);
      }
      if (countEvents() !== countBeforeStale) return FAIL('an expired-timestamp request still wrote a ledger row');
      if (eventRow('evt_g17_cancel') !== null) return FAIL('an expired-timestamp request left its ledger row behind');
      if (subRow('sub_g17_a')?.updated_at !== subBeforeStale?.updated_at) return FAIL('an expired-timestamp request still moved the subscription');
      const stillMax = await planOf(payer.token);
      if (stillMax?.plan !== 'max' || stillMax?.state !== 'active') return FAIL(`the read-out changed after an expired-timestamp request: ${JSON.stringify(stillMax)}`);

      // ══ ⑥ the same bytes with a fresh timestamp — and the tier is kept until period end ═══════
      // This doubles as ⑤'s positive control (identical bytes, only `ts` differs)
      // and as D1 §7 item 6's first half.
      const cancelRes = await post(cancel, signature(cancel, nowSec()));
      if (cancelRes.status !== 200 || cancelRes.body?.outcome !== 'applied') {
        return FAIL(`the SAME cancellation with a fresh timestamp was not applied (${cancelRes.status} ${JSON.stringify(cancelRes.body)}) — the 401 above proved nothing`);
      }
      const canceled = await planOf(payer.token);
      const d6 = diff(canceled, {
        plan: 'max', source: 'paddle', state: 'canceled',
        expires_at: FUTURE_END, paddle_subscription_id: 'sub_g17_a',
      });
      if (d6) return FAIL(`a cancellation must keep the tier until current_period_end — ${d6}`);
      const canceledQuota = await quotaOf(payer.token);
      if (canceledQuota?.stt?.limit_min !== MAX_STT_MIN) {
        return FAIL(`a cancelled-but-not-yet-expired subscriber lost his quota early: ${JSON.stringify(canceledQuota)}`);
      }

      // ══ ⑦ the period ends ⇒ free, but the SOURCE still says where from ════
      // The only thing that changes is the clock, and the clock is simulated by
      // pulling the column into the past (see the note at the top of `fn`).
      db.prepare('UPDATE paddle_subscriptions SET current_period_end=? WHERE subscription_id=?').run(PAST_END, 'sub_g17_a');
      const expired = await planOf(payer.token);
      const d7 = diff(expired, {
        plan: 'free', source: 'paddle', state: 'expired',
        expires_at: PAST_END, paddle_subscription_id: 'sub_g17_a', quota_exempt: false,
      });
      // 🔴 `source:'paddle'` after expiry is the point: "from that subscription, already expired" is a
      // different sentence from "never subscribed", and only the first one lets a human
      // reconcile against Paddle's dashboard.
      if (d7) return FAIL(`an expired subscription must read 「free, from that Paddle subscription」 — ${d7}`);
      const expiredQuota = await quotaOf(payer.token);
      if (expiredQuota?.stt?.limit_min !== FREE_STT_MIN || expiredQuota?.llm?.limit !== FREE_LLM) {
        return FAIL(`an expired subscriber still enforces a paid quota: ${JSON.stringify(expiredQuota)}`);
      }

      // ══ ⑧ permanent_free outranks everything, and it is an EXEMPTION ══════
      const ownerAcct = await signup('g17-permafree@flowmic.test', 'G17 owner');
      // The same UPDATE `UserRepo.setPermanentFree` runs. There is no route for
      // it by design (D1 §3.1) — owner marks his own account by hand.
      db.prepare('UPDATE users SET permanent_free=? WHERE id=?').run(1, ownerAcct.id);
      const exempt = await planOf(ownerAcct.token);
      const d8 = diff(exempt, {
        plan: 'free', source: 'permanent_free', quota_exempt: true,
        expires_at: null, paddle_subscription_id: null, state: 'none',
      });
      // 🔴 plan stays 'free': owner bought nothing. "no quota limit" is `quota_exempt`,
      // never a tier (D1 §6.1-bis — mapping it to 'pro' would have capped him at
      // pro's 900 minutes, the exact opposite of what the mark is for; the cap
      // moves with every re-pricing, the wrongness of capping him does not).
      if (d8) return FAIL(`the permanent_free exemption does not read as 「档位 free + 来源 permanent_free + 额度按 MAX 封顶」 — ${d8}`);
      const exemptQuota = await quotaOf(ownerAcct.token);
      // 🔴 CHANGED 2026-08-07 (owner ruling ①, docs/decisions/2026-08-07-owner-
      // permanent-free-becomes-max-and-test-accounts-reset-to-free.md). This used
      // to assert `limit_min === null` — "∞ serializes to null" — i.e. that the
      // exemption was handed NO fair line at all. It is now capped at the MONTHLY
      // MAX tier's numbers: before the W1 engine switch "unlimited" spent our own
      // CPU, and afterwards the same table meant unlimited spending of a VENDOR's
      // money, which nobody re-consented to.
      //
      // 🔴 THE LABEL AND THE NUMBER ARE CHECKED SEPARATELY, and they now say
      // different things — `d8` above proved "free / permanent_free / exempt",
      // this proves "and the enforced ceiling is MAX's". A build that keeps the
      // three labels while the ceiling drifts back to ∞ (or down to free's 20)
      // passes one and fails the other, which is the whole point.
      if (exemptQuota?.stt?.limit_min !== MAX_STT_MIN || exemptQuota?.llm?.limit !== MAX_LLM) {
        return FAIL(
          `a permanent_free account must be capped at the MAX tier's line (${MAX_STT_MIN} min / ${MAX_LLM}); `
          + `a null/∞ here means the pre-2026-08-07 uncapped table is back: ${JSON.stringify(exemptQuota)}`,
        );
      }
      // …and it is provably NOT the tier label's line: `plan` reads 'free', whose
      // fair line is FREE_STT_MIN. Without this the check above could pass on a
      // build that had simply stopped honouring the exemption in the other
      // direction — "counted as free" and "counted as max" are both finite numbers.
      if (exemptQuota?.stt?.limit_min === FREE_STT_MIN) {
        return FAIL('the exemption resolved to the FREE line — the tier label produced the number, which is the D1 §6.1-bis hole');
      }

      // …and it is not merely "no subscription events yet": send him the very
      // event that made the payer max, then check the exemption still wins.
      const ownerEvent = subscriptionFrame({
        event_id: 'evt_g17_owner', occurred_at: T_ACTIVATE, notification_id: 'ntf_g17_owner',
        subscription_id: 'sub_g17_owner', price_id: PRICE_MAX, user_id: ownerAcct.id, period_end: FUTURE_END,
      });
      const ownerRes = await post(ownerEvent, signature(ownerEvent, nowSec()));
      if (ownerRes.status !== 200 || ownerRes.body?.outcome !== 'applied') {
        return FAIL(`the exempt account's subscription event was not applied (${ownerRes.status} ${JSON.stringify(ownerRes.body)}) — the 「不受影响」 check below would be vacuous`);
      }
      const ownerRow = subRow('sub_g17_owner');
      if (ownerRow?.tier !== 'max') return FAIL(`the row that must be OUTRANKED was not written: ${JSON.stringify(ownerRow)}`);
      const stillExempt = await planOf(ownerAcct.token);
      const d8b = diff(stillExempt, {
        plan: 'free', source: 'permanent_free', quota_exempt: true, paddle_subscription_id: null,
      });
      if (d8b) return FAIL(`a real paddle row displaced the permanent_free exemption — ${d8b}`);
      const stillExemptQuota = await quotaOf(ownerAcct.token);
      // ⚠️ COVERAGE NOTE, 2026-08-07 — read before trusting this line. It used to
      // assert `=== null` (∞) against a paddle row worth MAX_STT_MIN, so the
      // NUMBER alone proved which of the two had won. Now that the exemption
      // resolves to MAX's own numbers, "the exemption won" and "that max subscription won" produce
      // an IDENTICAL quota by construction, and this assertion can no longer tell
      // them apart. It is kept because it must still hold (a drop to FREE_STT_MIN
      // here would mean the exemption was dropped AND the row misread), but the
      // DISCRIMINATOR is `d8b` above — `source:'permanent_free'` with
      // `paddle_subscription_id:null` while a real `sub_g17_owner` row is proven
      // to exist. Do not read this line as independent evidence of precedence.
      if (stillExemptQuota?.stt?.limit_min !== MAX_STT_MIN) {
        return FAIL(`the exemption survived on the label but not in the quota: ${JSON.stringify(stillExemptQuota)}`);
      }

      // ══ ⑨ an unmapped price_id: recorded, and NEVER guessed into a tier ═══
      const stranger = await signup('g17-unmapped@flowmic.test', 'G17 stranger');
      const unmapped = subscriptionFrame({
        event_id: 'evt_g17_unmapped', occurred_at: T_ACTIVATE, notification_id: 'ntf_g17_unmapped',
        subscription_id: 'sub_g17_unmapped', price_id: PRICE_UNMAPPED, user_id: stranger.id, period_end: FUTURE_END,
      });
      const unmappedRes = await post(unmapped, signature(unmapped, nowSec()));
      if (unmappedRes.status !== 200) {
        // 200 on purpose: a 4xx makes Paddle redeliver an event we will never
        // recognise, forever.
        return FAIL(`an unmapped price was answered ${unmappedRes.status} — Paddle would retry it forever: ${JSON.stringify(unmappedRes.body)}`);
      }
      if (unmappedRes.body?.outcome !== 'unmapped') {
        return FAIL(`an unmapped price was concluded as ${JSON.stringify(unmappedRes.body?.outcome)} — it must be recorded as unmapped, never silently ignored`);
      }
      const strangerView = await planOf(stranger.token);
      const d9 = diff(strangerView, { plan: 'free', source: 'none', paddle_subscription_id: null });
      // 🔴 "must never be guessed as pro" — and not 'max' either, and not even a paddle row
      // with a guessed tier: nothing was written at all.
      if (d9) return FAIL(`an unmapped price changed somebody's plan — ${d9}`);
      if (subRow('sub_g17_unmapped') !== null) return FAIL('an unmapped price still wrote a subscription row');
      const strangerQuota = await quotaOf(stranger.token);
      if (strangerQuota?.stt?.limit_min !== FREE_STT_MIN) return FAIL(`an unmapped price moved the enforced quota: ${JSON.stringify(strangerQuota)}`);
      const strangerLedger = await ledgerOf(stranger.token);
      if (strangerLedger.length !== 1 || strangerLedger[0]?.outcome !== 'unmapped') {
        return FAIL(`the unmapped event is not in this account's ledger: ${JSON.stringify(strangerLedger)}`);
      }
      if (!String(strangerLedger[0]?.detail ?? '').includes(PRICE_UNMAPPED)) {
        // The ledger row is the ONLY place anyone will ever learn which price id
        // nobody configured; a detail that does not name it makes the row useless.
        return FAIL(`the unmapped row does not name the price id: ${JSON.stringify(strangerLedger[0]?.detail)}`);
      }

      // ══ ⑩ the ledger is per-account (it holds who paid what and when) ═════
      const payerLedger = await ledgerOf(payer.token);
      if (payerLedger.some((e) => e.event_id === 'evt_g17_unmapped' || e.event_id === 'evt_g17_owner')) {
        return FAIL(`one account can read another's billing events: ${JSON.stringify(payerLedger.map((e) => e.event_id))}`);
      }
      if (!payerLedger.some((e) => e.event_id === 'evt_g17_activate')) {
        return FAIL('the payer cannot see his OWN events — the isolation check above is vacuous');
      }

      return PASS(
        'the standalone product does not serve /api/paddle/webhook at all (404, not a 401 from a mounted-but-declining route); '
        + 'real saas server (bootstrap-wired, paddle block resolved from its own env, FILE db): '
        + `new account free/none enforcing ${FREE_STT_MIN} min/${FREE_LLM}; a signed subscription.activated → pro/paddle with sub id echoed AND the quota moved to ${PRO_STT_MIN} min/${PRO_LLM} (label and limit checked separately — that pair IS the window's red line); `
        + 'a verbatim redelivery → 200 duplicate:true with the row count unchanged, outcome still applied, redelivery_count 0→1 and the subscription untouched; '
        + 'the SAME event under a NEW notification_id → still duplicate (first/last ntf kept in two columns) — the assertion an event_id-keyed gate passes and a notification_id-keyed one fails; '
        + '🔴 reverse ①: one byte of the body altered in flight → 401 mismatch with ZERO ledger rows, the subscription row byte-identical and the quota unmoved, then the SAME BYTES correctly signed → applied and max enforced at '
        + `${MAX_STT_MIN} min/${MAX_LLM} (the only difference between the refused and accepted request was the signature, so the probes are provably not blind); `
        + '🔴 reverse ②: a correctly-signed frame an hour old → 401 with reason 「expired」 specifically (not mismatch — two different repairs), zero side effects, then the same bytes with a fresh ts → applied; '
        + 'cancellation keeps the tier to current_period_end, and once that date passes the plan drops to free while source STAYS paddle (「来自那条订阅，已过期」); '
        + `permanent_free reads {plan:free, source:permanent_free, quota_exempt:true} and is CAPPED AT THE MAX TIER's line (${MAX_STT_MIN} min/${MAX_LLM}, owner 2026-08-07 — label and enforced number checked separately, and proven not to be free's ${FREE_STT_MIN}), and it OUTRANKS a real max row that was proven to be written (precedence evidenced by source/paddle_subscription_id, not by the quota — the two now yield the same numbers); `
        + 'an unmapped price is recorded as `unmapped` naming the price id and moves nobody\'s tier or quota; the ledger answers only the account that owns it. '
        + 'NOT covered here: Paddle itself (no sandbox delivery — the payload shape is pinned by apps/server-core/test/paddle-webhook-handler.test.ts), the ordering guard and h1 rotation (fake-clock unit tests, `requires`d above), the web console rendering (web repo), and any public network (loopback — deploy/cloud-chain.mjs §8 does the refusals against production).',
      );
    } catch (e) {
      return FAIL(`threw: ${e.stack ?? e.message}`);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
      if (saas) saas.child.kill();
      if (dir !== null) {
        // Windows keeps the file handle a moment after the child dies; retry
        // rather than leave a failure message about a temp directory.
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
      }
    }
  },
};

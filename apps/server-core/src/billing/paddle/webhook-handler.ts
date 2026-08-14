// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §5.3 (the ordered
//     pipeline and the event table below are from there), §5.2 (signature),
//     §3.2/§3.3 (the two tables), §3.3-bis (outcome vocabulary)
//   apps/server-core/src/db/repos/billing.repo.ts (the obligations its rule-④
//     HONESTY MARKER hands this file: normalize occurred_at, compare it, map
//     price_id → tier — all three are met below and nowhere else)
//   CLAUDE.md red line: no silent failure / one value answers only one question /
//     human review for four sensitive-path classes (billing)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The whole webhook decision, as a PURE-ish function: bytes in, `{status, body}`
// out, with the repo and the clock injected. No `req`, no `res`, no socket — so
// the ORDER of the steps (which is the security property; see below) is unit
// testable without an http server.
//
// D1 §5.3 order, not a single step may be reordered, and what each step protects:
//   1. bounded read ......... http/paddle-routes.ts (needs the stream)
//   2. verify signature ..... FIRST, so an unsigned body never reaches the DB
//   3. parse the envelope ... 400, and still no DB write
//   4. claimEvent ........... the idempotency gate; false ⇒ 200 duplicate, STOP
//   5. claim a human ........ unmapped + 200 (a 4xx makes Paddle retry forever)
//   6. route + ordering ..... stale events do not overwrite newer state
//   7. finishEvent .......... the ledger row gets its verdict, then 200
//
// ── WHY EVERY REFUSAL BELOW STEP 4 IS A 200 ────────────────────────────────
// Paddle retries any non-2xx, with backoff, for days. A 4xx for 「we could not
// tell whose subscription this is」 buys nothing — the next delivery is the same
// bytes and we will fail to recognise it again — while filling the ledger and
// the log with a loop. The refusal is recorded as an `outcome` instead, which is
// the visible half of no silent failure: nothing is dropped, it is written down.
// 401 (bad signature) and 400 (unreadable body) stay non-2xx because those two
// CAN come good on a retry: a rotated secret or a truncated body.

import type { Plan } from '@flowmic/protocol';
import type { BillingRepo, EventOutcome, PaddleSubRow } from '../../db/repos/billing.repo';
import type { UserRepo } from '../../db/repos/user.repo';
import { log } from '../../log';
import { parsePaddleEnvelope, readSubscriptionFacts, type PaddleEnvelope, type SubscriptionFacts } from './envelope';
import { verifyPaddleSignature } from './signature';

/** Refusal codes. HTTP-LOCAL strings, deliberately NOT protocol `ErrorCode`s —
 *  the same choice `PRESENCE_AUTH_REQUIRED` and the `DIAG_*` codes made. A
 *  protocol code is the cross-boundary vocabulary that carries bilingual
 *  user-facing copy and rides the count guard; these are read by Paddle's
 *  delivery log and by an operator with curl, never by a FlowMic client, and
 *  minting protocol codes with no client reader is exactly the façade this repo
 *  retired `CLOUD_SESSION_NO_HISTORY` for. */
export const PADDLE_SIGNATURE_INVALID = 'PADDLE_SIGNATURE_INVALID';
export const PADDLE_ENVELOPE_INVALID = 'PADDLE_ENVELOPE_INVALID';

/**
 * Events that describe THE SUBSCRIPTION ITSELF (D1 §5.3 table, all eight).
 *
 * They share ONE code path on purpose. The table's per-event prose —
 * "canceled ⇒ the tier is kept until current_period_end", "past_due ⇒ no
 * downgrade this round", "paused ⇒ the tier expires at current_period_end" —
 * describes CONSEQUENCES, not
 * different algorithms: all three fall out of storing Paddle's `status`
 * verbatim, carrying the tier over from the price mapping, and leaving the
 * expiry decision to the single solver in BillingService (D1 §6.1). Writing a
 * per-event branch that "downgrades" or "keeps" a tier would put a SECOND place
 * in the repo deciding "what tier is this user on", which is this window's headline red
 * line "shows upgraded but the server side never took effect" with the sides swapped.
 */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.resumed',
  'subscription.imported',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
]);

/** Events we RECOGNISE and deliberately do not act on (D1 §5.3 table:
 *  "record only, do not change the tier"). Recorded as `applied` with a detail that says so — see
 *  the note on `LEDGER_ONLY_DETAIL` for why not `ignored`. */
const LEDGER_ONLY_EVENTS: ReadonlySet<string> = new Set(['transaction.payment_failed', 'adjustment.created']);

/** 🔴 `applied`, NOT `ignored`, and the distinction is the whole point of the
 *  reconciliation view: `ignored` means 「we do not know this event type」, and
 *  an operator seeing it should ask whether we are missing something. These two
 *  ARE known and we chose to do nothing to the subscription. Marking them
 *  `ignored` would make "unknown event" and "known no-op" the same value — one
 *  value answering two questions, and the one that gets buried is the one that
 *  needs a human. */
const LEDGER_ONLY_DETAIL = 'ledger-only by policy (D1 §5.3): recorded, subscription state deliberately unchanged';

export interface PaddleWebhookDeps {
  repo: BillingRepo;
  /** ONLY `findById`, and it is not optional: `paddle_subscriptions.user_id` has
   *  `REFERENCES users(id)` and `PRAGMA foreign_keys = ON` is set in schema.ts,
   *  so upserting a user id that does not exist THROWS. That throw becomes a
   *  500, Paddle retries, the retry's claim returns false, and the event is
   *  never applied — while the ledger row sits at 'pending' forever. D1 §5.3
   *  step 5 says to read `custom_data.flowmic_user_id` but never says to check
   *  that it names a real account; this is that check. */
  users: Pick<UserRepo, 'findById'>;
  secret: string;
  toleranceSec: number;
  /** `config.paddle.priceTiers` — 🔴 THE ONLY price_id → tier mapping. An
   *  unmapped price is a ledger row, never a guessed tier (D1 §5.3). */
  priceTiers: Readonly<Record<string, Plan>>;
  now?: () => number;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/** price ids + config → the tier to store, or the sentence explaining why we
 *  will not guess one. */
type TierVerdict = { ok: true; tier: Plan; price_id: string | null } | { ok: false; detail: string };

function resolveTier(
  priceIds: readonly string[],
  priceTiers: Readonly<Record<string, Plan>>,
  existing: PaddleSubRow | null,
): TierVerdict {
  if (priceIds.length === 0) {
    // An event that names no price (some `subscription.paused` payloads) is not
    // a tier change — carry the row's tier over. With no row there is nothing to
    // carry and nothing to guess: 🔴 never default to 'pro', and not to 'free'
    // either (that would silently downgrade a paying account).
    if (existing !== null) return { ok: true, tier: existing.tier, price_id: existing.price_id };
    return { ok: false, detail: 'event names no price id and there is no existing subscription row to inherit a tier from' };
  }
  const hits: { id: string; tier: Plan }[] = [];
  for (const id of priceIds) {
    const tier = priceTiers[id];
    if (tier !== undefined) hits.push({ id, tier });
  }
  const first = hits[0];
  if (first === undefined) {
    return { ok: false, detail: `no configured tier for price id(s) ${priceIds.join(', ')} — see FLOWMIC_PADDLE_PRICE_TIERS` };
  }
  const distinct = new Set(hits.map((h) => h.tier));
  if (distinct.size > 1) {
    // A subscription whose items map to two different tiers has no single right
    // answer. Picking one (the first, the highest, the cheapest) would be a
    // guess wearing a rule; the ledger row says so and a human decides.
    return { ok: false, detail: `price ids map to conflicting tiers: ${hits.map((h) => `${h.id}=>${h.tier}`).join(', ')}` };
  }
  return { ok: true, tier: first.tier, price_id: first.id };
}

/** absent (`undefined`) ⇒ keep what the row has; explicitly `null` ⇒ clear it.
 *  The two cases are separated in envelope.ts's `statedString`; this is the one
 *  place that spends the distinction. */
function merge(stated: string | null | undefined, existing: string | null): string | null {
  return stated === undefined ? existing : stated;
}

export function handlePaddleWebhook(
  deps: PaddleWebhookDeps,
  input: { rawBody: string; signature: string | undefined },
): WebhookResponse {
  const nowMs = deps.now?.() ?? Date.now();
  const receivedAt = new Date(nowMs).toISOString();

  // ── step 2 · signature ────────────────────────────────────────────────────
  const verdict = verifyPaddleSignature(input.rawBody, input.signature, deps.secret, {
    nowMs,
    toleranceSec: deps.toleranceSec,
  });
  if (!verdict.ok) {
    // 🔴 D1 §5.2 ⑤ — the skew is logged on EVERY verification, pass or fail.
    // The window is five seconds wide; when someone eventually asks "why do we
    // occasionally refuse" this number is the only instrument that can answer, and a number
    // that is only recorded on the days nothing is wrong is not an instrument.
    // The secret is not here and never will be (signature.ts's own red line).
    log.warn('paddle webhook: signature refused', {
      reason: verdict.reason,
      ts_skew_sec: verdict.tsSkewSec ?? null,
      tolerance_sec: deps.toleranceSec,
      body_bytes: input.rawBody.length,
    });
    // The reason IS echoed. It gives an attacker nothing (they know their own
    // timestamp, and the HMAC is unforgeable either way) and it gives whoever
    // is holding a curl the one fact that separates "the clock is wrong" from "the key is wrong".
    return { status: 401, body: { ok: false, error: PADDLE_SIGNATURE_INVALID, reason: verdict.reason } };
  }
  log.info('paddle webhook: signature ok', { ts_skew_sec: verdict.tsSkewSec, tolerance_sec: deps.toleranceSec });

  // ── step 3 · envelope ─────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody);
  } catch {
    log.warn('paddle webhook: body is signed but is not JSON', { body_bytes: input.rawBody.length });
    return { status: 400, body: { ok: false, error: PADDLE_ENVELOPE_INVALID, detail: 'body is not JSON' } };
  }
  const parsed = parsePaddleEnvelope(raw);
  if (!parsed.ok) {
    log.warn('paddle webhook: envelope rejected', { reason: parsed.reason });
    return { status: 400, body: { ok: false, error: PADDLE_ENVELOPE_INVALID, detail: parsed.reason } };
  }
  const env = parsed.envelope;

  // ── step 4 · the idempotency gate ─────────────────────────────────────────
  // 🔴 Keyed on `event_id` (the EVENT), never `notification_id` (this DELIVERY
  // ATTEMPT — Paddle mints a new one per retry, so deduping on it would let
  // every retry through and the table would exist without ever having worked).
  const claimed = deps.repo.claimEvent({
    event_id: env.event_id,
    notification_id: env.notification_id,
    event_type: env.event_type,
    occurred_at: env.occurred_at,
    received_at: receivedAt,
  });
  if (!claimed) {
    // 🔴 200, or Paddle redelivers forever. Zero side effects: the repo's
    // conflict arm has already bumped `redelivery_count`, so "how many times it's been redelivered"
    // is recorded without touching `outcome` — two questions, two columns.
    log.info('paddle webhook: redelivery of an event we already own', {
      event_id: env.event_id,
      event_type: env.event_type,
      notification_id: env.notification_id,
    });
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const conclude = (
    outcome: EventOutcome,
    detail: string,
    ids: { subscription_id?: string | null; user_id?: string | null } = {},
  ): WebhookResponse => {
    deps.repo.finishEvent(env.event_id, { ...ids, outcome, detail });
    log.info('paddle webhook: concluded', {
      event_id: env.event_id,
      event_type: env.event_type,
      outcome,
      detail,
      ...(ids.user_id !== undefined ? { user_id: ids.user_id } : {}),
      ...(ids.subscription_id !== undefined ? { subscription_id: ids.subscription_id } : {}),
    });
    return { status: 200, body: { ok: true, duplicate: false, outcome } };
  };

  // ── step 6a · WHICH EVENT IS THIS — asked BEFORE 「whose is it」 ────────────
  //
  // ⚠️ THIS IS A DELIBERATE DEPARTURE from D1 §5.3's numbering, which puts claiming
  // the owner (step 5) ahead of routing by event_type (step 6). Taken literally, an unrelated
  // Paddle notification — `address.updated`, `payout.paid`, anything from a
  // product we do not sell — carries no `custom_data` and no subscription, so it
  // would fall out of step 5 as `unmapped` and never reach step 6 at all. The
  // ledger would then use ONE value for two different facts: 「a subscription
  // event whose owner we genuinely failed to identify」 (needs a human today) and
  // 「an event type we do not care about」 (needs nobody, ever) — and the first
  // would be buried under a permanent stream of the second. That is this repo's
  // #1 bug shape, in the very table built to prevent it. §5.3's own table footer
  // states the rule this ordering implements: "everything else uniformly gets outcome:'ignored' and is logged".
  const isSubscriptionEvent = SUBSCRIPTION_EVENTS.has(env.event_type);
  if (!isSubscriptionEvent && !LEDGER_ONLY_EVENTS.has(env.event_type)) {
    return conclude('ignored', 'event_type is not handled this round (D1 §5.3 table)');
  }

  const facts = readSubscriptionFacts(env.event_type, env.data);
  const existing = facts.subscription_id === null ? null : deps.repo.getSubscription(facts.subscription_id);

  // ── step 5 · WHOSE IS IT ──────────────────────────────────────────────────
  const userId = claimOwner(deps, facts, existing);
  if (userId === null) {
    return conclude('unmapped', unmappedOwnerDetail(facts), { subscription_id: facts.subscription_id });
  }

  if (!isSubscriptionEvent) {
    return conclude('applied', LEDGER_ONLY_DETAIL, { subscription_id: facts.subscription_id, user_id: userId });
  }
  if (facts.subscription_id === null) {
    return conclude('unmapped', 'subscription event carries no data.id — nothing to key a row on', { user_id: userId });
  }

  // ── step 6b · out-of-order guard ────────────────────────────────────────────────────
  //
  // ⚠️ `<`, where D1 §5.3 step 6 writes `occurred_at <= last_occurred_at ⇒
  // stale`. The stamps are truncated to milliseconds (envelope.ts explains why
  // the column's width is fixed at 24), while Paddle stamps to the microsecond —
  // so two genuinely different events microseconds apart normalize to the SAME
  // string, and `<=` would silently drop whichever arrived second. Paddle
  // routinely emits such pairs (`subscription.updated` immediately followed by
  // `subscription.canceled`), and dropping the second one there leaves an
  // account marked active with no expiry, forever.
  // `<` refuses only a STRICTLY older event, which is the whole point of the
  // guard ("an old event must not overwrite newer state"); an exact tie falls through to arrival order,
  // and the ledger records both rows either way.
  if (existing !== null && env.occurred_at < existing.last_occurred_at) {
    return conclude(
      'stale',
      `occurred_at ${env.occurred_at} is older than this subscription's ${existing.last_occurred_at} — not applied`,
      { subscription_id: facts.subscription_id, user_id: userId },
    );
  }

  // ── the tier, from the price id and NOWHERE ELSE ──────────────────────────
  const tier = resolveTier(facts.price_ids, deps.priceTiers, existing);
  if (!tier.ok) {
    return conclude('unmapped', tier.detail, { subscription_id: facts.subscription_id, user_id: userId });
  }
  const status = (typeof facts.status === 'string' ? facts.status : undefined) ?? existing?.status ?? null;
  if (status === null) {
    // `paddle_subscriptions.status` is NOT NULL and stores Paddle's own word.
    // With no word in the payload and no row to inherit from, there is nothing
    // truthful to write — and inventing 'active' here would be the fastest way
    // to hand someone a plan they did not buy.
    return conclude('unmapped', 'subscription event carries no status and there is no existing row to inherit one from', {
      subscription_id: facts.subscription_id,
      user_id: userId,
    });
  }

  const row: PaddleSubRow = {
    subscription_id: facts.subscription_id,
    user_id: userId,
    customer_id: merge(facts.customer_id, existing?.customer_id ?? null),
    status,
    tier: tier.tier,
    price_id: tier.price_id,
    cycle: merge(facts.cycle, existing?.cycle ?? null),
    current_period_end: merge(facts.current_period_end, existing?.current_period_end ?? null),
    canceled_at: merge(facts.canceled_at, existing?.canceled_at ?? null),
    last_event_id: env.event_id,
    last_occurred_at: env.occurred_at,
    // "when this first entered our database" — a later event cannot change it (the repo's
    // upsert leaves the column out of its DO UPDATE list for the same reason).
    created_at: existing?.created_at ?? receivedAt,
    updated_at: receivedAt,
  };
  // ⚠️ THE ONE WINDOW THIS DESIGN LEAVES OPEN, written down rather than hidden:
  // if this write throws (it is the only statement here that can), the request
  // 500s, Paddle retries, and the retry's claim returns false — so the state is
  // never applied and the ledger row stays 'pending' forever. That row IS the
  // trace (billing.repo.ts's OUTCOME_PENDING doc adopts exactly this failure as
  // the thing the reconciliation surface must show), so it is a recorded trace rather than silence. The most likely
  // cause — an unknown user id hitting the FK — cannot reach here at all,
  // because `claimOwner` has already proven the account exists.
  deps.repo.upsertSubscription(row);
  return conclude('applied', `${env.event_type} → status=${status}, tier=${tier.tier}`, {
    subscription_id: row.subscription_id,
    user_id: userId,
  });
}

/**
 * D1 §5.3 step 5 — claim the owner, in the order the design gives:
 *   ① `data.custom_data.flowmic_user_id`, the id WE put on the checkout — but
 *      only if it names an account that exists (see PaddleWebhookDeps.users);
 *   ② otherwise the user already attached to this subscription id.
 * A claim naming a stranger falls through to ② rather than being fatal: an
 * account deleted after checkout must not make its subscription unrecognisable.
 */
function claimOwner(deps: PaddleWebhookDeps, facts: SubscriptionFacts, existing: PaddleSubRow | null): string | null {
  const claimed = facts.claimed_user_id;
  if (claimed !== null && deps.users.findById(claimed) !== null) return claimed;
  return existing?.user_id ?? null;
}

/** The sentence the ledger keeps when nobody could be claimed. It names WHICH
 *  lookup was tried, because "carries no user id" and "carries one we don't recognize" are two
 *  different repairs and the row is the only place anyone will ever see them. */
function unmappedOwnerDetail(facts: SubscriptionFacts): string {
  const sub = facts.subscription_id ?? '(none in payload)';
  return facts.claimed_user_id === null
    ? `no custom_data.flowmic_user_id, and subscription ${sub} is not mapped to any account`
    : `custom_data.flowmic_user_id=${facts.claimed_user_id} is not a known account, and subscription ${sub} is not mapped either`;
}

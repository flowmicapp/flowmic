// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §5.3 step 3 (envelope
//     parsing), §3.2 (the columns these facts feed)
//   apps/server-core/src/db/repos/billing.repo.ts (ISO-STRING ORDERING header —
//     the normalization this file performs is the obligation that comment names)
//   CLAUDE.md red line: no silent failure / one value answers only one question
//
// Reading an untrusted Paddle payload into typed facts.
//
// ⚠️ WHY NOT ZOD, since D1 §5.3 step 3 says "parse the envelope with zod": `zod`
// IS NOT A DEPENDENCY OF @flowmic/server-core. It is a dependency of @flowmic/protocol
// only, and pnpm's non-hoisting layout means it does not resolve from here —
// verified, not assumed: `node -e "import('zod')"` run from apps/server-core
// exits ERR_MODULE_NOT_FOUND, and `grep -rn "from 'zod'" apps/server-core/src`
// has zero hits (the protocol schemas reach this package pre-compiled, through
// `safeParseEvent`). Adding the dependency is a package.json + lockfile change
// in another lane's blast radius mid-window.
//
// What replaces it has to give the same guarantee, so this file contains NO
// hand-written type predicate and NO `as` cast on payload data (13-LESSONS-LEARNED §7 F1 ⑤:
// `(x): x is T =>` is an assertion the compiler never checks, and this repo has
// already shipped one that made an array permanently empty on every machine).
// Every field below is read through an accessor that INSPECTS the value and
// returns a narrowed type or a miss. The output object is CONSTRUCTED, never
// asserted.

import type { EnvelopeParse, SubscriptionFacts, WebhookEnvelope } from '../webhook-types';

/** Fixed-width UTC RFC3339, to the millisecond: `2026-08-01T10:00:00.000Z`. */
const NORMALIZED_LENGTH = 24;

/** What we are willing to call a timestamp. Tight on purpose — `Date.parse` on
 *  its own accepts `"1"` (→ 2001-01-01) and a dozen other legacy shapes, so a
 *  garbage `occurred_at` would become a plausible date instead of a 400. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * 🔴 THE NORMALIZATION `paddle_subscriptions.last_occurred_at` DEPENDS ON.
 *
 * SQLite has no date type: the out-of-order guard compares two TEXT values with
 * `<`, and that equals chronological order ONLY while every stored stamp is the
 * same width, the same zone and the same precision. Paddle sends RFC3339 with an
 * offset and up to microsecond precision, so `2026-08-01T18:00:00+08:00` and
 * `2026-08-01T10:00:00.000Z` are the SAME INSTANT and sort three hours apart as
 * text — an offset from one delivery would silently disarm the ordering guard
 * on every later comparison. (This is where Lane A pushed the requirement back
 * to: billing.repo.ts's ISO-STRING ORDERING header states the requirement and
 * says the repo cannot detect the violation. This is where it is met.)
 *
 * ⚠️ THE PRECISION IS TRUNCATED to milliseconds, because 24-char
 * `toISOString()` is the width every other timestamp in this database already
 * uses and a mixed-width column sorts worse than a truncated one
 * (`…00.000Z` vs `…00.000000Z` compare 'Z' against '0' and put the SHORTER
 * string last). Two Paddle events under a millisecond apart therefore
 * normalize to the SAME string — which is exactly why the handler's staleness
 * test is `<` and not `<=`; see webhook-handler.ts.
 *
 * Its production callers are both in this file (`parsePaddleEnvelope` and
 * `statedStamp`); it is EXPORTED so `test/paddle-webhook-handler.test.ts` can
 * assert the offset/width property directly, rather than only inferring it from
 * a stored row.
 *
 * @returns the normalized stamp, or null when the input is not a timestamp.
 */
export function normalizeRfc3339(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!RFC3339.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Years outside 0000-9999 make toISOString() emit an expanded `±YYYYYY` form.
  // That is no longer fixed width, so it would sort arbitrarily against real
  // rows — refuse it rather than store a stamp that breaks the comparison.
  return iso.length === NORMALIZED_LENGTH ? iso : null;
}

/** A JSON object, or null. (`typeof null === 'object'` and arrays are objects —
 *  both would otherwise sail through an `in` check further down.) */
function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A non-blank string, or null. */
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 🔴 THE ABSENT / EXPLICITLY-NULL DISTINCTION, which is two questions and
 * therefore must not be one value.
 *
 *   `undefined` — the payload DID NOT MENTION this field. The row keeps what it
 *                 has.
 *   `null`      — the payload said `null`. The row's value is CLEARED.
 *
 * Collapsing them is a real bug, not a nicety: Paddle sends `canceled_at: null`
 * on `subscription.resumed`, so a merge that treated null as "no news" would
 * leave a resumed subscription flagged as cancelled forever.
 *
 * A field that is PRESENT but not a usable string reads as `undefined`
 * ("not stated") rather than `null` ("stated as empty"): destroying a real
 * stored value on the strength of a value we could not parse is the more
 * damaging of the two possible mistakes.
 */
function statedString(container: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in container)) return undefined; // not mentioned → keep the existing value
  const v = container[key];
  if (v === null) return null; // explicitly stated as empty → clear it
  return asString(v) ?? undefined; // unparseable → treat as not stated (see above)
}

/** Same three-way read, normalized as a timestamp. An unparseable stamp is
 *  "not stated" for the reason in statedString — never a silent clear. */
function statedStamp(container: Record<string, unknown>, key: string): string | null | undefined {
  const stated = statedString(container, key);
  if (stated === undefined || stated === null) return stated;
  return normalizeRfc3339(stated) ?? undefined;
}

/** The webhook envelope every provider's notification shares, re-exported here
 *  for callers that reach it through the Paddle-specific module path.
 *
 *  ⚠️ ONE SHAPE, NOT TWO. The envelope is identical at both providers once
 *  parsed — that is WHY the seven-step pipeline could be shared. What each
 *  field is filled FROM differs per provider and is documented at each parser.
 *
 *  🔴 2026-09-02 audit F9 — this file used to ALSO export a `PaddleEnvelope`
 *  type alias (`= WebhookEnvelope`) with a comment arguing it was "kept
 *  because ~20 call sites and two test files spell it". Grepped: zero call
 *  sites anywhere in apps/ or packages/, dead. Deleted rather than kept —
 *  the comment describing why it existed was itself the exact "past comment
 *  nobody re-checked" shape this repo's anti-façade rule exists to catch.
 *
 *  🔴 `notification_id` IS ALWAYS NULL FOR CREEM. Paddle distinguishes the event
 *  from this delivery of it; Creem does not, so 「how many times did the provider
 *  send this」 is a question only one of the two can answer. Anything reading
 *  that column must not treat null as 「once」. */
export type { EnvelopeParse, WebhookEnvelope } from '../webhook-types';

export function parsePaddleEnvelope(raw: unknown): EnvelopeParse {
  const root = asObject(raw);
  if (root === null) return { ok: false, reason: 'body is not a JSON object' };

  const event_id = asString(root.event_id);
  if (event_id === null) return { ok: false, reason: 'event_id missing or not a string' };
  const event_type = asString(root.event_type);
  if (event_type === null) return { ok: false, reason: 'event_type missing or not a string' };

  const occurred_at = normalizeRfc3339(root.occurred_at);
  if (occurred_at === null) {
    return { ok: false, reason: 'occurred_at missing or not an RFC3339 timestamp' };
  }
  const data = asObject(root.data);
  if (data === null) return { ok: false, reason: 'data missing or not a JSON object' };

  return {
    ok: true,
    envelope: { event_id, event_type, occurred_at, notification_id: asString(root.notification_id), data },
  };
}

/**
 * The subset of a Paddle `data` object this window stores. Three-way fields
 * (`string | null | undefined`) carry the absent/null distinction documented on
 * `statedString`; the two that are plain `string | null` are ones where "not
 * stated" and "stated as empty" lead to the same place (there is nothing to
 * preserve).
 */
export type { SubscriptionFacts } from '../webhook-types';

/**
 * WHERE EACH FIELD OF `SubscriptionFacts` COMES FROM IN A PADDLE BODY. The type
 * itself moved to `billing/webhook-types.ts` on 2026-08-29, when Creem became a
 * second producer of it; this table is the half that is Paddle-specific and
 * would have been wrong to move with it.
 *
 *   subscription_id ......... `data.id` on `subscription.*`, else `data.subscription_id`
 *   customer_id ............. `data.customer_id`
 *   status .................. `data.status`             (Paddle’s word, verbatim)
 *   price_ids ............... `data.items[].price.id`   (PRICE ids, not product ids)
 *   cycle ................... `data.billing_cycle.interval`
 *   current_period_end ...... `data.current_billing_period.ends_at`
 *   canceled_at ............. `data.canceled_at`
 *   claimed_user_id ......... `data.custom_data.flowmic_user_id`
 *   scheduled_change_action . `data.scheduled_change.action`
 *   scheduled_change_at ..... `data.scheduled_change.effective_at`
 *   next_billed_at .......... `data.next_billed_at`
 *   started_at .............. `data.started_at`
 *
 * 🔴 `scheduled_change` IS AN OBJECT HERE AND HAS NO COUNTERPART AT CREEM,
 * which states the same fact as a `status` of its own (`scheduled_cancel`).
 * Neither vocabulary was made the winner: `status` stores each provider’s word
 * verbatim, and the two `scheduled_change_*` fields carry the derived answer to
 * 「when does the service stop」. See billing/creem/envelope.ts for that
 * projection and for why its `null` arm is what makes a resume work.
 */

/**
 * 🔴 WHERE THE SUBSCRIPTION ID LIVES DEPENDS ON THE EVENT FAMILY, and D1 §5.3
 * does not say so — it says "look up the existing mapping in
 * paddle_subscriptions.subscription_id" without naming the field to look up.
 *
 *   · `subscription.*`  → `data.id` IS the subscription (sub_xxx);
 *   · everything else   → `data.id` is that object's own id (txn_xxx / adj_xxx)
 *                         and the subscription is `data.subscription_id`.
 *
 * Reading `data.id` for a transaction would hand `txn_…` to a lookup keyed on
 * `sub_…`, which misses every time — an idempotency-shaped failure: nothing
 * throws, the ledger fills with `unmapped`, and the cause is invisible.
 */
function subscriptionIdFor(eventType: string, data: Record<string, unknown>): string | null {
  return eventType.startsWith('subscription.') ? asString(data.id) : asString(data.subscription_id);
}

/** `data.items[].price.id` (and the flatter `price_id` some payloads carry).
 *  Every id is collected: deciding between them is the handler's job, and a
 *  reader that silently kept the first one would make a multi-item subscription
 *  resolve to a tier nobody could explain. */
function priceIdsIn(data: Record<string, unknown>): string[] {
  const items = data.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const entry of items) {
    const item = asObject(entry);
    if (item === null) continue;
    const nested = asObject(item.price);
    const id = (nested === null ? null : asString(nested.id)) ?? asString(item.price_id);
    if (id !== null) out.push(id);
  }
  return out;
}

/**
 * `data.billing_cycle` → the `cycle` column.
 *
 * `{interval:'month', frequency:1}` is monthly and `{interval:'year',
 * frequency:1}` is yearly — those two are the product's vocabulary. ANY OTHER
 * combination is stored as `3xmonth`-style raw text rather than being rounded
 * into one of the two, and `paddle_subscriptions.cycle` is `string | null`
 * precisely so an unforeseen cadence has somewhere honest to go (billing.repo.ts
 * has its own note on why it is not narrowed to `Cycle`).
 *
 * ⚠️ Supervisor human-audit 2026-08-01 — THIS COMMENT USED TO DEFEND ITSELF WITH
 * A CLAIM THAT GREPS TO ZERO. It said a quarterly plan recorded as "monthly" is
 * "a wrong renewal date shown to a paying user". There is no such date: `cycle` has ONE
 * reader in the whole server (it is copied into `PlanView.cycle`), the only code
 * that derives a date from a cycle is the mock state machine's `CYCLE_MS` (which
 * never touches a Paddle row), and the number of web views that render `cycle` is
 * zero — every expiry the product shows comes from `current_period_end`.
 * (13-LESSONS-LEARNED §7 F1 ④: a sentence a comment uses to justify a design is itself an
 * assertion, and it has to be greppable.)
 *
 * The narrowing is still right, but for the honest reason: this value is what we
 * would reach for the DAY someone does derive a date or render a cadence, and a
 * lossy round-off written today cannot be un-rounded then. It is a FORWARD GUARD,
 * not a fix for a live defect — and the tests that pin it say so, so the next
 * reader does not think something is being protected that isn't.
 */
function cycleIn(data: Record<string, unknown>): string | null | undefined {
  if (!('billing_cycle' in data)) return undefined;
  const bc = asObject(data.billing_cycle);
  if (bc === null) return data.billing_cycle === null ? null : undefined;
  const interval = asString(bc.interval);
  if (interval === null) return undefined;
  const frequency = typeof bc.frequency === 'number' && Number.isInteger(bc.frequency) ? bc.frequency : null;
  if (frequency === 1 && interval === 'month') return 'monthly';
  if (frequency === 1 && interval === 'year') return 'yearly';
  return `${frequency ?? '?'}x${interval}`;
}

/** `data.current_billing_period.ends_at` → the `current_period_end` column —
 *  the one date that decides "how long the tier is kept" for a cancelled or paused
 *  subscription (D1 §5.3). Absent period object ⇒ "not stated", so a later event that
 *  omits it cannot wipe the expiry a earlier one established. */
function periodEndIn(data: Record<string, unknown>): string | null | undefined {
  if (!('current_billing_period' in data)) return undefined;
  const period = asObject(data.current_billing_period);
  if (period === null) return data.current_billing_period === null ? null : undefined;
  return statedStamp(period, 'ends_at');
}

/**
 * `data.scheduled_change` → the two columns that answer 「is something going to
 * happen to this subscription, and when」.
 *
 * The tri-state is preserved through a NESTED object, which `statedString`
 * cannot do on its own, so it is spelled out here:
 *   · key absent                → `undefined` / `undefined`  (say nothing, keep the row)
 *   · `scheduled_change: null`  → `null` / `null`            (REVOKED — clear the row)
 *   · an object                 → whatever it states; an unreadable field inside
 *                                 a PRESENT object still means 「there is a
 *                                 scheduled change」, so the action falls back to
 *                                 `undefined` rather than clearing its partner.
 *
 * 🔴 THE TWO VALUES ARE RETURNED TOGETHER, from one read, on purpose. Read
 * separately they could come from different shapes of the payload and describe
 * different changes — an action from one event and a date from another is a
 * sentence neither event ever said.
 */
function scheduledChangeIn(data: Record<string, unknown>): {
  action: string | null | undefined;
  at: string | null | undefined;
} {
  if (!('scheduled_change' in data)) return { action: undefined, at: undefined };
  const v = data.scheduled_change;
  if (v === null) return { action: null, at: null };
  const obj = asObject(v);
  // Present but unreadable: we know a change EXISTS and cannot say what it is.
  // Clearing here would be the damaging direction (statedString's own rule).
  if (obj === null) return { action: undefined, at: undefined };
  const at = normalizeRfc3339(obj.effective_at);
  return { action: asString(obj.action) ?? undefined, at: at ?? undefined };
}

export function readSubscriptionFacts(eventType: string, data: Record<string, unknown>): SubscriptionFacts {
  const custom = asObject(data.custom_data);
  const scheduled = scheduledChangeIn(data);
  return {
    subscription_id: subscriptionIdFor(eventType, data),
    customer_id: statedString(data, 'customer_id'),
    status: statedString(data, 'status'),
    price_ids: priceIdsIn(data),
    cycle: cycleIn(data),
    current_period_end: periodEndIn(data),
    canceled_at: statedStamp(data, 'canceled_at'),
    claimed_user_id: custom === null ? null : asString(custom.flowmic_user_id),
    scheduled_change_action: scheduled.action,
    scheduled_change_at: scheduled.at,
    next_billed_at: statedStamp(data, 'next_billed_at'),
    started_at: statedStamp(data, 'started_at'),
  };
}

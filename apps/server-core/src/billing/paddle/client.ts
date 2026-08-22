// SPEC-REF:
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §3.2
//   https://developer.paddle.com/build/subscriptions/cancel-subscriptions/
//   apps/server-core/src/billing/paddle/webhook-handler.ts (the INBOUND half —
//     this file is the first outbound call this repo has ever made to Paddle)
//   CLAUDE.md red line: no silent failure / DI defaults are a real implementation
//     or a throw, never a friendly nothing
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// THE ONE PLACE THAT WRITES TO PADDLE.
//
// Until 0.3.25 this repo only ever RECEIVED from Paddle. `FLOWMIC_PADDLE_API_KEY`
// had been read into config since window D1 with a comment saying "stored, unused
// this round", and a grep for `api.paddle.com` across the whole tree returned
// nothing. Everything a user might want to do about their own subscription —
// cancel it, un-cancel it, exercise a statutory withdrawal — needs this file to
// exist, which is why it is the gate the rest of the compliance work sits behind.
//
// ── 🔴 TWO FAILURE DIRECTIONS, AND THEY ARE NOT THE SAME SHAPE ──────────────
// The split is copied deliberately from `mail/provider.ts`, which had to answer
// the identical question and answered it well:
//
//   · WRITES ARE OFF (`FLOWMIC_PADDLE_WRITE_ENABLED` unset/0) — THROWS.
//     This is not an outcome a user caused and not one they can act on; it is a
//     deployment that has not been switched on. It is the same class as
//     `MailNotConfiguredError`: an operator has to set a variable. Throwing is
//     what stops it being mistaken for 「Paddle said no」, and it is what stops
//     the 13 §7 F1 ② failure — a DI default that accepts the call and quietly
//     does nothing, on the one path where doing nothing keeps charging someone.
//
//   · PADDLE REFUSED, OR WE COULD NOT REACH IT — RETURNS `{ok:false, code}`.
//     These ARE outcomes: something happened, the user is entitled to a sentence
//     about it, and the two sentences differ (「try again」 vs 「that subscription
//     is not in a state we can cancel」). A caller must be able to tell them
//     apart without parsing a message, so they are named codes.
//
// ⇒ if you ever find yourself wanting `catch { return null }` here, the thing you
//   are about to hide is a subscription that is still being charged.
//
// ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
// It does not decide anything. It does not write to our database, it does not
// mark a subscription cancelled locally, and it does not interpret what a
// cancellation means for a tier. The local row's ONLY writer stays the webhook
// handler: Paddle tells us what happened and we record that. A client that also
// wrote the row would put two authors on one fact, and they would disagree on
// exactly the request where the network dropped after Paddle committed.

import { log } from '../../log';

/** The disabled-writes throw. A DISTINCT type, not a generic Error, for the
 *  reason `MailNotConfiguredError` is one: this failure's repair is 「an operator
 *  sets an environment variable」 and no other failure in this file shares it.
 *  A caller that catches `Error` broadly would otherwise report a switched-off
 *  deployment as 「Paddle had a bad minute」. */
export class PaddleWritesDisabledError extends Error {
  readonly code = 'PADDLE_WRITE_DISABLED';
  constructor(operation: string) {
    super(
      `paddle write refused: ${operation} was called while FLOWMIC_PADDLE_WRITE_ENABLED is off. ` +
        'This is a deployment switch, not a Paddle failure — nothing was sent and nothing changed.',
    );
    this.name = 'PaddleWritesDisabledError';
  }
}

/** Outcome codes. HTTP-LOCAL strings, deliberately NOT protocol `ErrorCode`s —
 *  the same choice `PADDLE_SIGNATURE_INVALID` made two files over. A protocol
 *  code is the cross-boundary vocabulary that carries four-language user copy
 *  and rides the count guard; these are read by our own route layer and by an
 *  operator reading logs. Minting protocol codes with no FlowMic client reading
 *  them is the façade this repo retired `CLOUD_SESSION_NO_HISTORY` for. The
 *  user-facing sentences live in the web console's nine locales. */
export const PADDLE_UNREACHABLE = 'PADDLE_UNREACHABLE';
export const PADDLE_REJECTED = 'PADDLE_REJECTED';

export type PaddleWriteResult<T> =
  | { ok: true; data: T }
  /** `detail` is for logs and operators. It may quote Paddle's own error code
   *  but never its message verbatim: a vendor message can name a customer. */
  | { ok: false; code: typeof PADDLE_UNREACHABLE | typeof PADDLE_REJECTED; detail: string };

/** The subset of Paddle's subscription object this repo reads back from a write.
 *
 *  🔴 NOT stored. It exists so a route can tell the caller 「Paddle accepted it,
 *  and here is what it now says」 in the same request, WITHOUT us writing the
 *  local row — the webhook remains the only writer. Treat it as a receipt, not
 *  as state. */
export interface PaddleSubscriptionSnapshot {
  id: string;
  status: string;
  scheduled_change: { action: string; effective_at: string | null } | null;
  next_billed_at: string | null;
}

export type CancelEffectiveFrom = 'next_billing_period' | 'immediately';

/** What a refund needs. `transaction_id` is Paddle's, not ours. */
export interface RefundInput {
  transaction_id: string;
  /** Free text Paddle stores on the adjustment. 🔴 NEVER a customer's words:
   *  this is our own reason string, one of a fixed set, so nothing a user typed
   *  ends up in a vendor's dashboard. */
  reason: string;
}

/** One completed transaction on a subscription — the thing a refund is issued
 *  against. Paddle refunds TRANSACTIONS, not subscriptions, so a withdrawal
 *  cannot be executed without first finding one. */
export interface PaddleTransactionSnapshot {
  id: string;
  /** Minor units (cents), as Paddle sends them: a string, kept as a number here
   *  only after an explicit parse. Shown to the user in the acknowledgement so
   *  the sentence 「we have requested a refund of X」 names a real amount rather
   *  than gesturing at one. */
  amount_minor: number;
  currency: string;
  billed_at: string | null;
}

/**
 * 🔴 THE ABSENT-vs-EMPTY WRAPPER, and it is load-bearing rather than ceremony.
 *
 * `call` treats a reader returning `null` as 「we got a 2xx we could not
 * understand」. A transaction LIST legitimately comes back empty, and if the
 * reader signalled that with `null` the two would be the same value — so
 * 「this subscription has never been charged」 would be reported as 「Paddle is
 * unreachable」, and the user would be told to try again forever. The wrapper
 * makes 「parsed fine, found nothing」 expressible.
 */
export interface FoundTransaction {
  found: PaddleTransactionSnapshot | null;
}

/** The subset of a Paddle adjustment we read back. */
export interface PaddleAdjustmentSnapshot {
  id: string;
  /** 🔴 Paddle's own word, verbatim, and on a live account it is usually
   *  `pending_approval`. It is carried all the way to the user-facing surface
   *  precisely so nothing in between can round 「requested」 up to 「refunded」. */
  status: string;
}

export interface PaddleClient {
  /**
   * `POST /subscriptions/{id}/cancel`.
   *
   * ⚠️ `immediately` DOES NOT REFUND ANYTHING (Paddle's docs are explicit, and
   * it is the single most expensive thing to get wrong here). A statutory
   * withdrawal is therefore TWO calls — cancel immediately, then create the
   * refund adjustment — and a caller that makes only the first one has taken the
   * service away and kept the money. B3 owns that pair; nothing in B2 passes
   * `immediately`.
   */
  cancelSubscription(subscriptionId: string, effectiveFrom: CancelEffectiveFrom): Promise<PaddleWriteResult<PaddleSubscriptionSnapshot>>;
  /**
   * `PATCH /subscriptions/{id}` with `scheduled_change: null` — the un-cancel.
   *
   * It exists for a product reason, not for symmetry: a user who changes their
   * mind and cannot undo it will cancel through their bank instead, and a
   * chargeback costs us the amount plus a fee and lands on Paddle's account.
   */
  clearScheduledChange(subscriptionId: string): Promise<PaddleWriteResult<PaddleSubscriptionSnapshot>>;
  /**
   * `POST /adjustments` — refund a transaction, in full.
   *
   * 🔴 THE SECOND HALF OF A WITHDRAWAL, AND IT IS NOT OPTIONAL. Cancelling
   * `immediately` does not refund anything (Paddle's docs say so plainly), so a
   * statutory withdrawal that only cancels has taken the service away and kept
   * the money — the single most expensive mistake available in this file.
   * Callers must treat the pair as one operation and must not report a
   * withdrawal as complete on the strength of the cancel alone.
   *
   * ⚠️ WHAT `ok: true` MEANS HERE IS WEAKER THAN ANYWHERE ELSE IN THIS FILE.
   * On a live Paddle account most refunds are created `pending_approval` and a
   * human at Paddle decides. So this resolves to 「the refund has been
   * REQUESTED」, never 「the money has moved」, and every surface downstream has
   * to say the weaker thing. `status` is returned verbatim so nobody has to
   * guess which it was.
   */
  createRefund(input: RefundInput): Promise<PaddleWriteResult<PaddleAdjustmentSnapshot>>;
  /**
   * `GET /transactions?subscription_id=…&status=completed` — the transaction a
   * withdrawal refunds, or `{found: null}` if the subscription has never
   * actually been charged.
   *
   * 🔴 IT EXISTS BECAUSE PADDLE REFUNDS TRANSACTIONS, NOT SUBSCRIPTIONS, and we
   * store no transaction ids: `paddle_subscriptions` was built to answer 「what
   * tier is this person on」 and nothing on it can name a payment. So a
   * withdrawal has to ask. Storing the id from a webhook instead was the
   * cheaper-looking option and is the wrong one — we do not subscribe to
   * `transaction.*` events at all, so the column would be empty for every
   * subscription that exists today and the right would silently not work.
   *
   * ⚠️ 「Never charged」 is a real and correct outcome, not an error: a
   * subscription in trial has nothing to give back. The caller must be able to
   * complete the withdrawal (cancel, acknowledge) with no refund at all.
   */
  findRefundableTransaction(subscriptionId: string): Promise<PaddleWriteResult<FoundTransaction>>;
  /** `GET /subscriptions/{id}` — read-back, used by tests and by an operator
   *  reconciling a subscription by hand. Still a WRITE-GATED call: it spends the
   *  API key, and a deployment that has not opted into talking to Paddle should
   *  not start doing it because someone opened a page. */
  getSubscription(subscriptionId: string): Promise<PaddleWriteResult<PaddleSubscriptionSnapshot>>;
}

export interface PaddleClientDeps {
  /** `config.paddle.writeEnabled`. */
  writeEnabled: boolean;
  /** `config.paddle.apiKey`. 🔴 NEVER logged, in any form, at any level. */
  apiKey: string | null;
  /** `config.paddle.env` — decides the host, and nothing else. */
  env: 'sandbox' | 'production';
  /** Wall-clock cap per request. A route holds a user's browser open on this. */
  timeoutMs?: number;
  /** Injected for tests. Production leaves it undefined and gets global fetch. */
  fetchImpl?: typeof fetch;
}

const HOSTS: Readonly<Record<'sandbox' | 'production', string>> = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Paddle's subscription object → our snapshot, by INSPECTION, never by cast.
 *  Same discipline as envelope.ts: a hand-written type predicate is an assertion
 *  the compiler does not check, and this repo has already shipped one that made
 *  an array permanently empty on every machine (13 §7 F1 ⑤). */
function readSnapshot(raw: unknown): PaddleSubscriptionSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  const status = typeof o.status === 'string' ? o.status : null;
  if (id === null || status === null) return null;
  let scheduled: PaddleSubscriptionSnapshot['scheduled_change'] = null;
  const sc = o.scheduled_change;
  if (typeof sc === 'object' && sc !== null) {
    const s = sc as Record<string, unknown>;
    if (typeof s.action === 'string') {
      scheduled = { action: s.action, effective_at: typeof s.effective_at === 'string' ? s.effective_at : null };
    }
  }
  return {
    id,
    status,
    scheduled_change: scheduled,
    next_billed_at: typeof o.next_billed_at === 'string' ? o.next_billed_at : null,
  };
}

/** Paddle's adjustment object → our snapshot, by inspection. Same discipline as
 *  `readSnapshot`: nothing is cast. */
function readAdjustment(raw: unknown): PaddleAdjustmentSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.status !== 'string') return null;
  return { id: o.id, status: o.status };
}

/** Paddle's transaction LIST → the most recent completed one, or an explicit
 *  「none」. Returns null only when the envelope itself is unreadable. */
function readTransactionList(raw: unknown): FoundTransaction | null {
  if (!Array.isArray(raw)) return null;
  let best: PaddleTransactionSnapshot | null = null;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    const totals = (o.details as Record<string, unknown> | undefined)?.totals as Record<string, unknown> | undefined;
    // Paddle sends money as a STRING of minor units. Parsed explicitly, and a
    // value that does not parse is treated as 0 rather than NaN — NaN would
    // reach the acknowledgement email and print 「refund of NaN」.
    const grand = typeof totals?.grand_total === 'string' ? Number.parseInt(totals.grand_total, 10) : Number.NaN;
    const snap: PaddleTransactionSnapshot = {
      id: o.id,
      amount_minor: Number.isFinite(grand) ? grand : 0,
      currency: typeof o.currency_code === 'string' ? o.currency_code : '',
      billed_at: typeof o.billed_at === 'string' ? o.billed_at : null,
    };
    // Most recent wins. `billed_at` is ISO-8601 UTC from Paddle, so string
    // comparison is chronological; a row without one loses to any row with one
    // rather than being ordered by accident.
    if (best === null) best = snap;
    else if (snap.billed_at !== null && (best.billed_at === null || snap.billed_at > best.billed_at)) best = snap;
  }
  return { found: best };
}

export function createPaddleClient(deps: PaddleClientDeps): PaddleClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? fetch;

  async function call<T>(
    operation: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    read: (raw: unknown) => T | null,
  ): Promise<PaddleWriteResult<T>> {
    // 🔴 THE SWITCH IS CHECKED HERE, IN THE ONE FUNCTION EVERY METHOD GOES
    // THROUGH, rather than in each method. A per-method check is a per-method
    // opportunity to forget one, and the method somebody forgets is the one that
    // spends money.
    if (!deps.writeEnabled) throw new PaddleWritesDisabledError(operation);
    // Enabled with no key is a misconfiguration, not a Paddle outcome, so it
    // takes the same exit as the switch: an operator has to fix it, and calling
    // it 「Paddle rejected us」 would send them to the wrong dashboard.
    if (deps.apiKey === null || deps.apiKey === '') {
      throw new PaddleWritesDisabledError(`${operation} (writes are enabled but FLOWMIC_PADDLE_API_KEY is empty)`);
    }

    const url = `${HOSTS[deps.env]}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Timeout, DNS, TLS, socket. 🔴 UNKNOWN OUTCOME, not a failed one: Paddle
      // may well have committed the change before the connection died. The code
      // says 「we could not reach it」 and the caller must not tell the user
      // 「nothing happened」 — the webhook is what settles it either way.
      const detail = e instanceof Error ? e.name : 'unknown transport failure';
      log.warn('paddle write: transport failure', { operation, env: deps.env, detail });
      return { ok: false, code: PADDLE_UNREACHABLE, detail };
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // Paddle answered and said no. Its error `code` is echoed because it is
      // the one fact that separates 「this subscription is already cancelled」
      // from 「your key is wrong」; the human-readable `detail` from Paddle is
      // NOT echoed, because a vendor message can carry a customer's name.
      let paddleCode = 'unknown';
      try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown } };
        if (typeof parsed.error?.code === 'string') paddleCode = parsed.error.code;
      } catch {
        /* a non-JSON body from Paddle is itself only worth its status */
      }
      log.warn('paddle write: refused', { operation, env: deps.env, http_status: res.status, paddle_code: paddleCode });
      return { ok: false, code: PADDLE_REJECTED, detail: `http ${res.status} / ${paddleCode}` };
    }

    let snapshot: T | null = null;
    try {
      const parsed = JSON.parse(text) as { data?: unknown };
      snapshot = read(parsed.data);
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      // 🔴 A 2xx WE CANNOT READ IS STILL A SUCCESS AT PADDLE. Reporting it as a
      // rejection would tell a user their cancellation did not happen when it
      // very likely did — and they would then cancel through their bank. It is
      // reported as unreachable-class instead ("we do not know what we got"),
      // and the log carries the shape so the parser can be fixed.
      log.warn('paddle write: 2xx with an unreadable body — treating the outcome as unknown', {
        operation,
        env: deps.env,
        http_status: res.status,
        body_bytes: text.length,
      });
      return { ok: false, code: PADDLE_UNREACHABLE, detail: `unreadable 2xx body (${text.length} bytes)` };
    }
    log.info('paddle write: accepted', {
      operation,
      env: deps.env,
      result: JSON.stringify(snapshot).slice(0, 200),
    });
    return { ok: true, data: snapshot };
  }

  return {
    cancelSubscription(subscriptionId, effectiveFrom) {
      return call(
        'cancelSubscription',
        'POST',
        `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
        { effective_from: effectiveFrom },
        readSnapshot,
      );
    },
    clearScheduledChange(subscriptionId) {
      return call(
        'clearScheduledChange',
        'PATCH',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { scheduled_change: null },
        readSnapshot,
      );
    },
    createRefund(input) {
      // `type: full` — a statutory withdrawal refunds the whole transaction.
      // Partial amounts belong to the discretionary path (B4) and are not
      // reachable from here, so this method cannot short-change a legal right.
      return call(
        'createRefund',
        'POST',
        '/adjustments',
        {
          action: 'refund',
          transaction_id: input.transaction_id,
          reason: input.reason,
          items: [{ type: 'full' }],
        },
        readAdjustment,
      );
    },
    findRefundableTransaction(subscriptionId) {
      return call(
        'findRefundableTransaction',
        'GET',
        `/transactions?subscription_id=${encodeURIComponent(subscriptionId)}&status=completed&order_by=billed_at[DESC]&per_page=20`,
        undefined,
        readTransactionList,
      );
    },
    getSubscription(subscriptionId) {
      return call(
        'getSubscription',
        'GET',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        undefined,
        readSnapshot,
      );
    },
  };
}

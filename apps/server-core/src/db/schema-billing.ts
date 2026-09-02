// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §3.2 / §3.3
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §3.1
//   apps/server-core/src/db/repos/billing.repo.ts (the reader of every column here)
//   *** HUMAN-AUDIT SENSITIVE (billing + schema) ***
//
// The billing domain's DDL, split out of db/schema.ts on 2026-08-21.
//
// 🔴 WHY IT MOVED, so nobody re-merges it: schema.ts stood at EXACTLY 800 lines
// of the repo's 800-line cap, so card D-2's table could not be added without
// either splitting the file or deleting an argument from it. The repo precedent
// (0.2.52) is to split and keep the evidence. Nothing about the migration
// changed: `BILLING_SQL` is interpolated into `INIT_SQL` unconditionally, in the
// same position, so the SQL that reaches `db.exec` is what it was plus the new
// table and columns.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts: this is ONE template literal, so a
// backtick anywhere inside it — even in a `--` SQL comment — terminates it early
// and breaks the whole server-core build, and the error surfaces at some later
// line so it reads as a broken toolchain. Quote identifiers with 「」 or ** **.
// (Measured twice now: schema.ts 2026-08-02, and again while writing this file.)

const BILLING_TABLES_SQL = /* sql */ `
-- 8. paddle_subscriptions (Window D1 §3.2 -- subscription truth)
-- status stores Paddle's raw value, not translated; translation is the tier
-- column's job. One column, one question.
-- last_occurred_at is the out-of-order guard's ruler: webhooks do not guarantee
-- order, an old event must never overwrite newer state
-- (the comparison happens in the handler, see §5.3 step 6 and the comment on
-- billing.repo.ts upsertSubscription).
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id     TEXT PRIMARY KEY,          -- sub_xxx
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id         TEXT,                      -- ctm_xxx
  status              TEXT NOT NULL,             -- the provider's raw value, not translated
  -- Which merchant of record owns this row.
  -- 🔴 NULL IS NOT 'unknown' HERE — IT IS 'paddle', and every reader must say so
  -- rather than default silently, because Paddle was the only writer that
  -- existed before 2026-08-29. Backfilling would be equally correct and is
  -- deliberately NOT done: an ALTER that also rewrites every row is a migration
  -- that can half-succeed, and a read-side default costs one line.
  provider            TEXT,
  tier                TEXT NOT NULL,             -- free|pro|max, mapped from price_id
  price_id            TEXT,
  cycle               TEXT,                      -- monthly|yearly|null
  current_period_end  TEXT,                      -- RFC3339
  canceled_at         TEXT,
  -- 0.3.25 B1 -- the compliance surface's four facts. All nullable, all
  -- additive (ADDITIVE_TEXT_COLUMNS in schema.ts reconciles them onto DBs that
  -- already exist).
  --
  -- 🔴 scheduled_change_* is NOT a second spelling of 'status'. A subscription
  -- scheduled to cancel at period end is 'active' at Paddle, because that is
  -- what it is -- so before these columns existed the console had ONE word for
  -- TWO facts (「active」 and 「active, and will not renew」) and could not tell a
  -- user the date their service stops. One column, one question.
  --
  -- 🔴 contract_concluded_at starts the EU 14-day withdrawal window (CRD art.
  -- 9). It is captured from the event payload because that is the only place it
  -- exists: a column added after the fact cannot be backfilled, and a
  -- subscription with no computable deadline has no withdrawal button. It is
  -- WRITE-ONCE -- absent from the upsert's DO UPDATE list, like created_at --
  -- so no later event can move a deadline that is already running.
  scheduled_change_action TEXT,                  -- cancel|pause|resume, Paddle's raw word
  scheduled_change_at     TEXT,                  -- RFC3339, when that change takes effect
  next_billed_at          TEXT,                  -- RFC3339, null once a cancel is scheduled
  contract_concluded_at   TEXT,                  -- RFC3339, from the FIRST event that stated it
  -- 2026-09-02 (audit F4) -- a LOCAL claim, taken BEFORE http/billing-routes.ts
  -- calls the provider, same order and same reasoning as
  -- 「one_time_purchases.refund_requested_at」 (billing/service-refund.ts's header
  -- argues the order at length). Without it, two withdraw clicks a moment apart
  -- both read this row as 'active' (Paddle's own cancellation only lands here
  -- LATER, via the webhook) and both call the cancel AND refund provider calls --
  -- relying on Paddle to reject the second one instead of us ever deciding to.
  -- 🔴 NOT the same column as 「canceled_at」: that one holds PADDLE'S word about
  -- when the subscription ended, written by the webhook; this one holds OUR OWN
  -- claim, taken synchronously, before any webhook could possibly have arrived.
  -- Collapsing them would be a row answering two questions with one value.
  withdrawal_claimed_at   TEXT,
  last_event_id       TEXT NOT NULL,
  last_occurred_at    TEXT NOT NULL,             -- ⚠️ out-of-order guard, see below
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paddle_subs_user ON paddle_subscriptions(user_id);

-- 8c. refund_requests (0.3.25 B3 -- the record of every refund we ask Paddle for)
--
-- 🔴 「kind」 HAS TWO VALUES AND THEY ARE NOT TWO FLAVOURS OF THE SAME THING.
--   'statutory_withdrawal' -- CRD art. 9/13. A RIGHT. There is no decision to
--       make: if the window is open we execute it, and 「approve/reject」 does not
--       apply to it at any point in its life.
--   'discretionary'        -- a request. Someone decides. (B4 writes these; this
--       round has no writer for them, and the column exists now so that B4 does
--       not have to migrate a table that is already carrying live legal records.)
-- Collapsing them into one value would put a reject button in front of a legal
-- obligation, and the person who eventually clicks it would be doing exactly
-- what the interface offered. Two values, and only one of them is ever decided.
--
-- ⚠️ 「state」 RECORDS WHAT PADDLE SAID, NOT WHAT WE WISH HAD HAPPENED:
--   'submitted' -- the adjustment was created at Paddle. On a live account this
--       normally means 「pending_approval」 THERE, so it does NOT mean the money
--       has moved, and no surface reading this column may say that it has.
--   'failed'    -- we asked and Paddle refused, or we could not reach it. The row
--       exists precisely so this is visible instead of being a gap.
--   'none_due'  -- the withdrawal was valid and executed, and there was nothing
--       to refund (a subscription that was never charged). A real, correct
--       outcome; folding it into 'failed' would raise an alarm about a case
--       where everything went right.
--
-- ⚠️ 「paddle_adjustment_id」 is nullable BECAUSE OF THE 'failed' AND 'none_due'
-- rows, not because it is optional on success.
CREATE TABLE IF NOT EXISTS refund_requests (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id      TEXT NOT NULL,
  transaction_id       TEXT,                     -- null when there was nothing to refund
  kind                 TEXT NOT NULL,            -- statutory_withdrawal | discretionary
  state                TEXT NOT NULL,            -- submitted | failed | none_due
  amount_minor         INTEGER,                  -- what we asked Paddle to return
  currency             TEXT,
  paddle_adjustment_id TEXT,
  paddle_status        TEXT,                     -- Paddle's word, verbatim
  detail               TEXT,                     -- why it failed, for an operator
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_requests_user ON refund_requests(user_id, created_at);

-- 8b. paddle_subscription_tombstones (0.3.25 B1 -- card D-2)
--
-- 🔴 THE DEFECT THIS EXISTS FOR, measured 2026-08-21. paddle_subscriptions
-- carries 'REFERENCES users(id) ON DELETE CASCADE', and POST /api/account/delete
-- calls nothing at Paddle. So closing an account did all of this at once:
--   · Paddle keeps billing the card, on schedule, forever;
--   · our only mapping from sub_xxx to a person is gone, so every later webhook
--     for it lands as outcome='unmapped' -- a row that names no one;
--   · and the delete response reports paddle_subscriptions among the tables it
--     cascaded, which is TRUE and reads as 「handled」.
-- The user's only remaining move is a chargeback, and a chargeback is charged to
-- Paddle and then deducted from our balance. It has never fired because nobody
-- can buy yet -- it is not a future risk, it is a defect waiting for launch day.
--
-- 🔴 NO FOREIGN KEY, and that is the entire point of a separate table rather
-- than a nullable column. The users row is gone by definition here; a row with
-- 'REFERENCES users(id)' could not survive the very event it exists to record.
-- Same family as USER_RETAINED_TABLES (billing_events / ops_audit_log), and it
-- is listed there for the same reason.
--
-- ⚠️ WHAT THIS TABLE DOES NOT DO: it does not stop the billing. Cancelling at
-- Paddle needs the outbound client, which lands in B2 and is what stamps
-- cancel_verified_at. Until then this table's job is narrower and stated
-- honestly: keep the identifier, so the cancellation IS still possible and the
-- orphaned webhooks can still be explained. NULL in that column means 「never
-- cancelled」, not 「unknown」.
--
-- ⚠️ NO EMAIL, NO NAME, NO ADDRESS. Erasing an account and then keeping its
-- owner's details in a table about that erasure would undo the erasure. Paddle
-- holds the customer record; this holds only the opaque ids needed to reach it.
CREATE TABLE IF NOT EXISTS paddle_subscription_tombstones (
  subscription_id     TEXT PRIMARY KEY,          -- sub_xxx, the handle into Paddle
  customer_id         TEXT,                      -- ctm_xxx, may be null on old rows
  status_at_deletion  TEXT NOT NULL,             -- Paddle's raw status when we let go
  tier_at_deletion    TEXT NOT NULL,
  current_period_end  TEXT,                      -- how long the payer had paid for
  reason              TEXT NOT NULL,             -- 'account_deleted' (the only writer today)
  created_at          TEXT NOT NULL,
  cancel_verified_at  TEXT                       -- set in B2 once Paddle confirms the cancel
);

-- 9. billing_events (Window D1 §3.3 -- idempotency ledger + reconciliation evidence)
-- 🔴 THE DEDUP KEY MUST BE event_id, NEVER notification_id: Paddle uses event_id
-- to identify the **event**, and notification_id to identify **this one delivery
-- attempt** — the latter changes on redelivery. Using the wrong one means the
-- idempotency table exists but never once takes effect (this repo's #1 bug
-- shape: one value answers a different question than it should).
-- ⚠️ Does NOT store the raw payload (contains address/tax PII etc. that we
-- neither need nor should hold). detail holds only
-- one sentence we produced ourselves.
-- ⚠️ user_id deliberately has NO FK: an event that cannot be claimed by any
-- account (outcome='unmapped') must still leave a trace --
-- a REFERENCES users(id) would make that row fail to write at all, turning
-- "discard but leave a trace" into a silent discard.
-- (Supervisor ruled 2026-08-01 to keep the status quo: a leftover ledger row
-- after account deletion is the visible cost of this trade-off, no FK added.)
--
-- §3.3-bis (Supervisor 2026-08-01): event_id is the primary key ⇒ a redelivery
-- structurally cannot produce a second row,
-- so "how many times was this Paddle event redelivered" would otherwise become
-- a silent discard. Two columns recover it:
--   redelivery_count     how many times this one was redelivered (first delivery = 0)
--   last_notification_id the ntf_xxx of the most recent delivery (= notification_id on first delivery)
-- 🔴 Two fields, two questions: outcome says "what happened to it in the end",
-- redelivery_count says
-- "how many times was it sent". It is **forbidden** to cram redelivery into
-- outcome (that is exactly this repo's #1 bug shape,
-- and it would let 'duplicate' overwrite 'applied', erasing the fact that "it
-- did take effect").
-- ⚠️ notification_id is the **first delivery's**, and never changes once written;
-- last_notification_id is the **most recent one's**.
-- For every row written from this round onward, last_notification_id is always
-- non-empty ⇒ NULL has exactly one meaning:
-- this row predates these two columns (backfilled by migration).
CREATE TABLE IF NOT EXISTS billing_events (
  event_id             TEXT PRIMARY KEY,      -- evt_xxx ← dedup key
  notification_id      TEXT,                  -- ntf_xxx ← logging only, never the dedup key
  event_type           TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  subscription_id      TEXT,
  user_id              TEXT,
  outcome              TEXT NOT NULL,         -- applied|stale|unmapped|ignored|pending
  detail               TEXT,
  redelivery_count     INTEGER NOT NULL DEFAULT 0,
  last_notification_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id, received_at);
`;

/**
 * One-time (non-subscription) purchases — today, the $200 Guided Setup service.
 *
 * 🔴 A SEPARATE TABLE FROM `paddle_subscriptions`, AND THE REASON IS NOT TIDINESS.
 * A subscription row answers 「what is this account entitled to, and until when」
 * and is read by the plan solver on every request. This answers 「what did this
 * person buy, and have we delivered it yet」 and is read by a human. Putting them
 * together would mean the plan solver has rows in its table that grant nothing,
 * and the first `WHERE user_id = ?` that forgot to filter would hand somebody a
 * tier they did not buy.
 *
 * 🔴 AND THE WITHDRAWAL LAW IS GENUINELY DIFFERENT, which is the part that would
 * have bitten later. A subscription's EU 14-day window runs from when the
 * contract was concluded and is answered by `contract_concluded_at`. A SERVICE
 * bought once loses that right only when it has been FULLY PERFORMED **and** the
 * buyer gave prior express consent to start inside the window **and**
 * acknowledged that performance would end the right (CRD art. 16(a) read with
 * art. 7(3)). Those are two extra facts that exist for no subscription, they are
 * captured at purchase, and they cannot be reconstructed afterwards — which is
 * the same argument `contract_concluded_at` won on its own table.
 *
 * ⚠️ `state` IS DELIVERY, NOT PAYMENT. Payment is settled the moment the row
 * exists (we only write on a paid order). These four values say where the SERVICE
 * has got to:
 *   'paid'      -- money in, nothing arranged yet. The only state a webhook writes.
 *   'scheduled' -- a session time has been agreed with the buyer.
 *   'delivered' -- the session happened. 🔴 Also the moment the withdrawal right
 *                  can lapse, but ONLY IF both consent stamps below are present;
 *                  the code that reads this must check them, not infer from here.
 *   'refunded'  -- the money went back. Terminal.
 * There is deliberately no 'pending'/'processing': every value above is something
 * a person did, and a state nobody can advance is the shape this repo forbids
 * ("不许给一个没有机制兑现的等待起名叫「待…」").
 *
 * ⚠️ NO FOREIGN KEY TO `users`, unlike paddle_subscriptions. A purchase is a
 * commercial record of money received; if the account is later deleted the
 * obligation (or the refund) does not disappear with it. Same reasoning as
 * paddle_subscription_tombstones, and it is why `user_id` is nullable here too:
 * a paid order whose buyer we could not resolve is a row that must still exist,
 * loudly, rather than not be written at all.
 */
const ONE_TIME_PURCHASE_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS one_time_purchases (
  -- 🔴 THE PROVIDER'S ORDER ID IS THE PRIMARY KEY, not our own mint and not the
  -- event id. The event id would let a redelivery of the same purchase write a
  -- second row; our own id would let it write a second row AND make the pair
  -- impossible to spot. This is the idempotency guarantee, in the schema, where
  -- no handler can forget it.
  order_id            TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,            -- 'creem' | 'paddle', never inferred
  user_id             TEXT,                     -- nullable ON PURPOSE, see header
  product_id          TEXT,
  checkout_id         TEXT,
  transaction_id      TEXT,                     -- what a refund names; null until resolved
  customer_id         TEXT,
  amount_minor        INTEGER,                  -- the provider's own minor units
  currency            TEXT,
  state               TEXT NOT NULL,            -- paid | scheduled | in_progress | delivered | refund_requested | refunded
  -- The two facts that decide whether the 14-day right survives performance.
  -- WRITE-ONCE in practice: they record what the buyer was shown and agreed to
  -- at purchase, and a later edit would be a claim about a past conversation.
  early_start_consent_at   TEXT,                -- RFC3339; buyer asked us to start inside the window
  withdrawal_waiver_ack_at TEXT,                -- RFC3339; buyer acknowledged full performance ends the right
  -- 🔴 WHICH WORDING those two stamps are against. A timestamp alone cannot
  -- answer the only question a dispute asks — WHAT did they agree to — because
  -- the copy will change and a stamp against words nobody kept is evidence of
  -- nothing. billing/guided-setup.ts holds each version's immutable text.
  consent_terms_version    TEXT,
  scheduled_at        TEXT,
  -- 2026-08-30 (gs-5) -- when the operator recorded that the session BEGAN.
  -- Part of the delivery picture with the two beside it. Forward-ported onto
  -- older databases by a guarded ALTER in connection.ts.
  started_at          TEXT,
  delivered_at        TEXT,
  -- 2026-08-30 -- the withdrawal half. THREE columns and not one, because they
  -- answer three different questions and only the last is the provider's:
  --   refund_requested_at -- when WE asked. Ours, and always knowable.
  --   refund_provider_id  -- the provider's handle, for a human. Creem has no
  --                          GET /v1/refunds (probed: 404), so nothing polls it.
  --   refund_status       -- the provider's own word, verbatim. Its 'pending'
  --                          and 'requiresAction' are documented NON-TERMINAL,
  --                          so this must never be read as "the money is back".
  -- 🔴 "the money is back" is state = 'refunded' plus refunded_at, and the
  -- refund webhook is their only writer.
  refund_requested_at TEXT,
  refund_provider_id  TEXT,
  refund_status       TEXT,
  refunded_at         TEXT,
  -- 2026-08-30 -- when we successfully EMAILED the buyer that their setup was
  -- complete.
  --
  -- 🔴 IT IS NOT A COPY OF delivered_at AND MUST NEVER BE DERIVED FROM ONE.
  -- delivered_at is when an operator asserted it; this is when the customer was
  -- told. They are two facts and an operator has to be able to see the second
  -- one missing while the first is set.
  --
  -- ⚠️ A RECORD OF THE EMAIL, AND NOTHING MORE (gs-5). It does not affect
  -- refundability: the no-reason refund closes at delivered_at whether or not
  -- this column is set, and the claim SQL never reads it. NULL on a delivered
  -- row means we still owe the buyer that email — a duty the operator queue
  -- surfaces, not a right the buyer keeps. (Under gs-3/gs-4 this column started
  -- a post-completion refund window; that window no longer exists.)
  --
  -- ⚠️ IT IS PART OF THE DELIVERY PICTURE, so advanceOneTimePurchase ASSIGNS it
  -- alongside the other stamps: walking a mis-marked delivery back clears it,
  -- and re-delivering sends a fresh notice.
  completion_notice_at TEXT,
  note                TEXT,                     -- operator's own words, never shown to the buyer
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- 2026-08-31 -- THE RELEASE PATH OUT OF 'refund_requested'.
  --
  -- Before these three, that state was a one-way door: only the provider's
  -- refund webhook could leave it, so a refund the provider never accepted
  -- (service-refund.ts claims the row BEFORE it calls out, deliberately) froze
  -- the purchase for ever -- the buyer reading the sentence "we have asked for
  -- your money back" with no button, and the operator console calling the row
  -- "Closed" when the money may not have moved at all.
  --
  -- 🔴 THREE COLUMNS AND NOT ONE, because they answer three questions:
  --   refund_released_at        -- WHEN a human took the row off that door.
  --   refund_release_reason     -- WHY, from a closed set. 🔴 IT IS NOT
  --                                COSMETIC: 'provider_declined' takes the row
  --                                off the unattended 14-day sweep for ever
  --                                (service-deadlines.ts argues it), and
  --                                'buyer_withdrew_request' deliberately does
  --                                not. One word, two behaviours, so the
  --                                operator has to say which happened.
  --   refund_external_reference -- the operator's PROOF that money moved
  --                                somewhere we cannot see (a lost webhook, a
  --                                bank transfer). NON-NULL is what makes a
  --                                human-asserted refund distinguishable for
  --                                ever from a provider-confirmed one.
  --
  -- 🔴 THAT DISTINCTION IS NOT ENCODED IN refund_status. That column holds the
  -- provider's own word, verbatim, and writing one of ours into it would make
  -- "what did the provider actually say" unanswerable on exactly the rows
  -- where the question matters most.
  --
  -- 🔴 DECLARED LAST, AFTER updated_at, and the position is load-bearing: the
  -- forward-port in connection.ts is an ALTER TABLE ... ADD COLUMN, which
  -- APPENDS. A column declared mid-table here would leave a migrated database
  -- and a fresh one with different column ORDER, which is the one thing
  -- "the forward-ported table is indistinguishable from a fresh one" compares.
  refund_released_at        TEXT,
  refund_release_reason     TEXT,
  refund_external_reference TEXT
);
CREATE INDEX IF NOT EXISTS idx_one_time_purchases_user ON one_time_purchases(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_one_time_purchases_state ON one_time_purchases(state);
`;

/** Everything the billing domain adds to `INIT_SQL`, in one value.
 *
 * ⚠️ CONCATENATED HERE RATHER THAN INTERPOLATED TWICE IN schema.ts, and the
 * reason is the same one that created this file: schema.ts sits EXACTLY at the
 * repo's 800-line cap, so every table added there costs a line it does not have.
 * A reader looking for 「what DDL runs」 still finds one export; a reader looking
 * for 「which tables」 finds them named above it.
 */
/**
 * Additive TEXT columns for the billing tables, reconciled by connection.ts's
 * guarded ALTER loop.
 *
 * 🔴 IT LIVES HERE, BESIDE THE DDL THAT DECLARES THEM. Two lists in two files
 * describing one set of columns is how one of them stops being edited.
 */
export const BILLING_ADDITIVE_TEXT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // 0.3.25 B1 + 2026-08-29 provider. All nullable TEXT with no default — what
  // the guarded loop emits — and NULL on a legacy row is the truth in each
  // case: no scheduled change was recorded, no next-billing date was read, for
  // a subscription predating the column we do not know when its contract was
  // concluded, and a row written before provider existed is Paddle's.
  // 🔴 That contract date has a CONSEQUENCE the withdrawal surface must respect:
  // a NULL contract_concluded_at means "we cannot compute your 14-day
  // deadline", NOT "your window has closed". B3 shows no withdrawal panel
  // rather than a refusal — claiming a right expired when we simply never
  // wrote the date down is the worst direction to fail.
  paddle_subscriptions: [
    'scheduled_change_action',
    'scheduled_change_at',
    'next_billed_at',
    'contract_concluded_at',
    'provider',
    // 2026-09-02 (audit F4) — see the DDL comment above the column: a local
    // claim taken before the outbound provider call, not Paddle's own
    // `canceled_at`. NULL on a legacy row is the truth: nobody has claimed a
    // withdrawal against that subscription (yet, or ever).
    'withdrawal_claimed_at',
  ],
  // 2026-08-30 — the withdrawal half of the one-time service. The table is
  // younger than any deployment, but a developer who booted this branch before
  // these columns existed has the old shape on disk, which is what this is for.
  one_time_purchases: [
    // 🔴 2026-09-02 audit P2-7 — this column shipped in the SAME commit
    // (94094001) as the comment that introduced it, but `git show 94094001 --
    // apps/server-core/src/db/schema-billing.ts` proves `early_start_consent_at`
    // and `withdrawal_waiver_ack_at` were NOT touched by that commit — only this
    // one column and its comment were added (`+` lines). None of the three was
    // additive-listed, so a database built from a commit between the table's
    // founding and 94094001 had `one_time_purchases` WITHOUT `consent_terms_
    // version` — and the first real purchase's INSERT (which states every
    // column by name) threw "no such column" rather than recording a sale.
    //
    // ⚠️ 2026-09-02 (audit B2-I) IN-PLACE CORRECTION to the sentence this
    // replaced: it claimed `early_start_consent_at` / `withdrawal_waiver_ack_at`
    // / `scheduled_at` were "the same shape of gap ... flagged for a follow-up
    // pass". Checked, that claim is false, and it is worth recording WHY rather
    // than silently dropping the three names — the next reader would otherwise
    // re-open a closed question. `git log --diff-filter=A -- .../schema-billing.
    // ts | grep one_time_purchases` finds exactly one commit that ever created
    // this table: f7532478. `git show f7532478 -- .../schema-billing.ts` shows
    // its ORIGINAL `CREATE TABLE` already declaring `early_start_consent_at`,
    // `withdrawal_waiver_ack_at` AND `scheduled_at` — they were born with the
    // table, not added to a live one afterwards, so no database has ever held
    // this table without them (the migration test's own literal legacy fixture,
    // `test/consent-terms-version-migration.test.ts`, keeps all three present
    // for exactly this reason — it is the "intermediate commit" shape, and they
    // are already in it). There is no gap here to close.
    'consent_terms_version',
    'refund_requested_at',
    'refund_provider_id',
    'refund_status',
    // 2026-08-30. ⚠️ NULL ON A LEGACY ROW IS THE TRUTH: a delivered purchase
    // written before this column existed was never notified through this
    // mechanism. A migration that back-filled it with `delivered_at` would put
    // a letter in the record that was never sent. (It affects no refund —
    // gs-5 closes the refund at delivery regardless — so NULL costs nothing but
    // honesty.)
    'completion_notice_at',
    // ⚠️ `started_at` (gs-5) IS DELIBERATELY NOT IN THIS LIST. A database that
    // predates it gets it from its own PRAGMA-guarded ALTER in connection.ts
    // (the shape users.email_verified_at uses). One column, one forward-port:
    // listing it here as well would give the same ALTER two owners.
  ],
};

export const BILLING_SQL = `${BILLING_TABLES_SQL}${ONE_TIME_PURCHASE_SQL}`;

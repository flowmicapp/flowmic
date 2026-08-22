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

export const BILLING_SQL = /* sql */ `
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
  status              TEXT NOT NULL,             -- Paddle's raw value, not translated
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

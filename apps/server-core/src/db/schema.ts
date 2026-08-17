// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (server SQLite, FK+WAL, additive
//     migration discipline), §5 (user_settings KV)
//   docs/rebuild/05-DATA-MODEL.md §1.0 (the migration mechanism, rewritten
//     2026-08-02 to describe THIS repo: an inlined INIT_SQL constant + guarded
//     reconcileSchema(), no migrations/ directory, no .sql file, no numbering)
//     ⚠️ this line used to cite §8.3 "migration numbering restarts at 001".
//     That half of §8.3 never happened — there is no 001 and never was — and the
//     doc now says so in place. Do not restore the old citation.
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (0.2.27: 05 §1's
//     seventh table, `transcript_history`, is DROPPED — SIX tables at that point,
//     per owner's architecture ruling)
//   docs/rebuild/13-LESSONS-LEARNED.md §4 (systemd drop lost the migration file →
//     crash loop; §4.2 inline the SQL as a constant so the bundled sidecar has
//     no runtime asset to lose)
//
// The migration is INLINED as a TS constant rather than a copied .sql asset:
// tsup bundles one file and there is no dist/migrations/ path to resolve at
// runtime. Idempotency comes from CREATE ... IF NOT EXISTS everywhere; the
// additive-column discipline is carried by reconcileSchema() in connection.ts.
//
// 🔴 INIT_SQL IS ONE TEMPLATE LITERAL, SO A BACKTICK ANYWHERE INSIDE IT — EVEN IN
// A `--` SQL COMMENT — TERMINATES IT EARLY AND BREAKS THE WHOLE server-core BUILD.
// esbuild then reports a TRANSFORM error at some later line and vitest collects
// zero tests, so the failure looks like a broken toolchain rather than like the
// edit that caused it (measured 2026-08-02 while adding table 10). Inside the
// literal, quote identifiers with 「」 or ** ** the way the existing comments do.
// Do NOT escape the backtick instead: that is three layers of quoting for a
// decoration, and the next person will copy it.
//
// TABLE COUNT, kept honest here because it is the number the migration-idempotency
// test asserts: 6 after 0.2.27, 8 after window D1 (the two billing tables), NINE
// since 0.2.47 (ops_audit_log), TEN since SALT-1 (timeline_keymeta, 2026-08-11),
// ELEVEN since GRANT-1 (timeline_grants, same batch), TWELVE since VERIFY-1
// (email_verifications, same batch — plus the guarded `users.email_verified_at`
// step in reconcileSchema, the one ALTER in this repo that also BACKFILLS),
// THIRTEEN since A2-5 / REQ-12-08 (usage_events, 2026-08-12 — one CREATE plus
// one index), FOURTEEN since the first-party site analytics card
// (site_daily_counts, 2026-08-15 — dd715e2c registered it in the three schema
// guards but this ledger line was missed; corrected 2026-08-17).
// ⚠️ That last entry used to end "no ALTER and no new reconcileSchema step".
// It was true the day it was written and is not any more: the same card's second
// round added `transcript_chars` / `delivered_chars` as NULLABLE columns, which
// cannot ride either ADDITIVE_* loop and therefore DO have a guarded step in
// connection.ts. Corrected rather than deleted — a sentence describing another
// file's behaviour is an assertion whose truth changes when that file does
// (anti-façade ④), and this is what that looks like when it expires.
// The de-facto registry is the `TABLES` array in test/migration-idempotency.test.ts
// — a new table that is not appended there is a table nothing checks.
//
// DUAL-PREFIX RED LINE (05 §2): user_settings.value api_key fields are enc:v1:
// (server-decryptable); timeline_blobs.ciphertext is e2e:v1: (server-blind). The
// two are NEVER interchangeable — enforced at the write path, not in SQL.

export const INIT_SQL = /* sql */ `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. users
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE,
  password_hash   TEXT,
  display_name    TEXT NOT NULL DEFAULT 'User',
  plan            TEXT NOT NULL DEFAULT 'free',
  locale          TEXT NOT NULL DEFAULT 'zh-CN',
  is_admin        INTEGER NOT NULL DEFAULT 0,
  -- Window D1 §3.1 (docs/strategy/2026-08-01-d1-paddle-sandbox-design.md):
  -- owner's private-domain account marker bit. owner ruled 2026-07-31
  -- (docs/decisions/2026-07-31-owner-window-a-four-rulings.md §4) "no trial —
  -- owner goes through a real permanent_free marker bit" — it is a real,
  -- queryable column, not an illusion temporarily bypassed at runtime by some
  -- environment variable.
  -- ⚠️ INTEGER, not TEXT: in SQLite a TEXT '0' arrives on the JS side as
  -- **truthy**, so an account with "permanently free = false" would be read as
  -- true because of it (the storage-face variant of this repo's #1 bug shape).
  -- It answers only "is this account exempt" — it does **not** answer "what
  -- tier is this account" — the latter is billing-service's PlanView.source
  -- (D1 §6.1); one column, one question.
  permanent_free  INTEGER NOT NULL DEFAULT 0,
  -- VERIFY-1 (docs/decisions/2026-08-11-owner-email-verification-gate-and-
  -- gmail-login.md D1): ms-since-epoch when the console verification gate
  -- OPENED for this account; NULL = the gate is closed (a fresh registration
  -- stays NULL until a successful confirm).
  -- 🔴 For accounts that predate the gate, reconcileSchema backfills this with
  -- the MIGRATION timestamp — for those rows the value answers "does the gate
  -- let them through", NOT "when was it verified" (no verification ever
  -- happened). The grandfather is not a
  -- courtesy: at deploy time production mail is not configured yet (MAIL-1's
  -- production half sits with the human batch), so an unverified-everyone state
  -- would lock every existing user — the owner included — behind a gate whose
  -- only key is a mail channel that cannot send. The backfill lives INSIDE the
  -- column-was-missing guard in reconcileSchema, so it runs exactly once per
  -- database and never stamps a row registered after the migration.
  -- INTEGER ms-epoch like timeline_keymeta.created_at, not this table's TEXT
  -- datetime shape; the one NULL/number → verdict conversion is
  -- auth/email-verification.ts "isEmailVerified".
  email_verified_at INTEGER,
  -- A2-3 "restricted use" (docs/strategy/2026-08-12-a2-3-restricted-use-design.md §8-1;
  -- owner ruling docs/decisions/owner-web-rulings/latest.md:71): ms-since-epoch
  -- when an operator RESTRICTED this account; NULL = not restricted.
  --
  -- 🔴 IT ANSWERS EXACTLY ONE QUESTION — "is this account restricted from use" —
  -- and it is a NEW column because no existing one can answer it. plan answers
  -- "what tier did they buy" (expressing a restriction as a tier would hand
  -- isPlan, effectiveLimits, the four-language tier copy and the web billing
  -- page a FAKE tier change); permanent_free answers "is it exempted";
  -- email_verified_at answers "has the email been verified or not", and its
  -- correct next action is the OPPOSITE of this one's (a code the
  -- user can fetch vs. a restriction with no appeal channel, owner ⑤).
  --
  -- 🔴 RESTRICTION IS NOT A REFUSAL TO SIGN IN. owner: "the user can still sign
  -- in, but sees only the restricted-use notice". Sign-in stays 200, the session
  -- is real, and the refusal
  -- lands on each capability route — see auth/account-restriction.ts.
  --
  -- INTEGER ms-epoch and NULLABLE like email_verified_at right above, for the
  -- same reason that column is not a boolean: a timestamp answers "is it
  -- restricted" AND carries "when did it start" without a second column, and
  -- NULL is the only honest value for "not restricted". It therefore CANNOT
  -- ride ADDITIVE_INT_COLUMNS: that loop
  -- emits INTEGER NOT NULL DEFAULT 0, and 0 is a legal ms-epoch (1970-01-01),
  -- i.e. every pre-existing account would read as restricted since the epoch.
  -- Its guarded step is in connection.ts reconcileSchema.
  --
  -- 🔴 AND THAT STEP BACKFILLS NOTHING, which is the exact opposite of
  -- email_verified_at's grandfather stamp. There the migration had to stamp
  -- existing rows or every account would be locked out; here any non-NULL
  -- backfill would RESTRICT EVERY ACCOUNT ON THE PLATFORM. Same column shape,
  -- opposite migration, because the two NULLs mean opposite things.
  --
  -- The one NULL/number → verdict conversion is auth/account-restriction.ts
  -- "isAccountRestricted"; nothing else may read this column and decide.
  restricted_at   INTEGER,
  -- Q2 (owner 2026-08-12, "enumerated reasons go to the user; the operator's
  -- free text goes only into the audit trail"): WHICH of the
  -- publishable reasons this account was restricted for -- a key from
  -- packages/protocol restriction-reasons.ts, never a sentence and never the
  -- operator's own words.
  --
  -- 🔴 THE OPERATOR'S FREE TEXT IS NOT IN THIS TABLE AND MUST NEVER BE. It goes
  -- to ops_audit_log.detail and stops there. The two answer different questions
  -- -- "why we internally did this" vs "what to tell this person" -- and the
  -- Terms promise only
  -- the second one. A column here holding the note would put an internal
  -- artefact one projection away from the account holder's screen.
  --
  -- TEXT and NULLABLE, and it rides ADDITIVE_TEXT_COLUMNS (unlike restricted_at
  -- one line up, which could not): NULL is legal and meaningful in two ways that
  -- are both honest -- the account is not restricted at all, or it was
  -- restricted before this column existed. Neither may be rendered as a reason.
  -- ⚠️ NOT an enum at the SQL level: SQLite has none, and a CHECK constraint
  -- would make adding a reason a MIGRATION. The membership test lives at the one
  -- write route (isRestrictionReason), where an untrusted string actually
  -- arrives.
  restriction_reason TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. pc_devices
CREATE TABLE IF NOT EXISTS pc_devices (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name        TEXT NOT NULL DEFAULT 'My PC',
  client_instance_id TEXT,
  machine_uid        TEXT,
  -- 0.2.66 PCID addressing (owner 2026-08-14). 9 decimal digits, minted
  -- server-side in SAAS mode only, public (printed on the PC). NULL on every
  -- standalone row and on the virtual cloud-instance row — see registry.ts.
  pcid               TEXT,
  device_token       TEXT NOT NULL UNIQUE,
  room_uuid          TEXT NOT NULL UNIQUE,
  short_code         TEXT NOT NULL,
  is_online          INTEGER NOT NULL DEFAULT 0,
  last_seen_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pc_devices_user ON pc_devices(user_id);

-- 3. mobile_pairings
CREATE TABLE IF NOT EXISTS mobile_pairings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  pc_device_id    TEXT NOT NULL REFERENCES pc_devices(id) ON DELETE CASCADE,
  mobile_token    TEXT NOT NULL UNIQUE,
  mobile_name     TEXT DEFAULT 'Phone',
  device_uid      TEXT,
  paired_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mobile_pairings_pc ON mobile_pairings(pc_device_id);

-- 4. user_settings (KV; value TEXT is JSON; api_key fields enc:v1: at rest)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- 5. (retired) transcript_history — DROPPED 2026-07-31 (0.2.27).
-- owner's architecture ruling docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md:
-- "phone↔PC does not do cloud storage sync, the cloud does not store transcripts
-- (existing rows are deleted outright)". The table, its two
-- indexes and its whole read/write surface are gone; each end owns its own
-- timeline now (PC local ownership 0.2.26, phone sqflite). The DROP for existing
-- databases lives in connection.ts reconcileSchema() — this file only describes
-- the world a FRESH database is created with, and that world no longer has this
-- table. The number 5 is left standing so the remaining comments' numbering keeps
-- matching the original 05-DATA-MODEL §1 ordering. (That doc was rewritten
-- 2026-08-02: its §1.1 now lists all nine live tables and this retirement.)
-- The e2e:v1: blind store (timeline_blobs, §7 below) is UNAFFECTED — it is the
-- other link, and it is where the lightweight record feature will land.

-- 6. usage_records (UPSERT accumulate; PK (user_id, month) = UTC YYYY-MM bucket)
CREATE TABLE IF NOT EXISTS usage_records (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,
  stt_minutes     REAL NOT NULL DEFAULT 0,
  llm_tokens_in   INTEGER NOT NULL DEFAULT 0,
  llm_tokens_out  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);

-- 7. timeline_blobs (E2EE blind store; ciphertext MUST be e2e:v1:)
CREATE TABLE IF NOT EXISTS timeline_blobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timeline_blobs_user_seq ON timeline_blobs(user_id, seq);

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
  last_event_id       TEXT NOT NULL,
  last_occurred_at    TEXT NOT NULL,             -- ⚠️ out-of-order guard, see below
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paddle_subs_user ON paddle_subscriptions(user_id);

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

-- 10. ops_audit_log (0.2.47 -- ops-action audit trail: who, did what, to whom, when)
--
-- 🔴 THIS IS NOT billing_events. That table answers "which webhooks did we
-- receive" -- it records **events sent to us by someone else**, has no actor
-- column, and never could. THIS table answers "what did **our own people** do".
-- Two questions, two tables; cramming ops actions into billing_events would be
-- this repo's #1 bug shape (one table answering
-- two questions), and besides, its primary key is event_id, and an ops action
-- has no such thing at all.
--
-- ⚠️ actor_user_id **deliberately has NO FK**, and the reason is NOT the same as
-- billing_events' reason:
-- a REFERENCES users(id) ON DELETE CASCADE would make "delete this account"
-- casually delete **the entire record of what they did**
-- -- an audit record that can be deleted is not an audit record, and account
-- deletion is exactly the kind of action
-- that most needs a trace. The cost of no FK is that this column may point to a
-- user that no longer exists; that is exactly the fact we want to SEE,
-- not an inconsistency to fix.
--
-- ⚠️ actor_user_id is **NOT NULL** (the opposite of billing_events.user_id): an
-- ops action has no
-- "anonymous" tier. The only writer is a route sitting behind an admin gate,
-- and that gate structurally already knows who the
-- caller is (http/account-auth.ts adminFromBearer returns userId). If we
-- cannot say who did it,
-- this action should not happen -- so the NOT NULL here is a real constraint,
-- not decoration.
--
-- 🔴 id is INTEGER PRIMARY KEY AUTOINCREMENT, the only table in this database
-- that does not use a TEXT primary key,
-- and this is **deliberate**, for two reasons:
--   ① strictly increasing ⇒ "A happened before B" has a precise answer. Sorting
--      two rows within the same millisecond by created_at
--      is a coin flip, and the order of audit records IS the evidence;
--   ② AUTOINCREMENT guarantees **a used number is never reused** ⇒ a hole in the
--      sequence itself means "there used to be a row here".
--      For a table that is intended to be append-only, this is the cheapest
--      tamper signal available.
-- (sqlite_sequence is a byproduct of AUTOINCREMENT, appearing only after the
-- first insert; both the schema snapshot and
--  the table-creation list filter by name NOT LIKE 'sqlite_%', so it never
--  enters any assertion.)
--
-- ⚠️ Append-only is a **repository-layer** constraint (the repo has only
-- append + read, no update/delete), not a
-- SQL trigger. The reason for not adding a trigger needs to be stated clearly:
-- this table's threat model is "an operator uses the product itself to erase
-- their own tracks", and the product side does not even have a single
-- UPDATE/DELETE statement; a trigger would not stop someone who has actually
-- gotten hold of the db file (they can delete the trigger), yet it would turn
-- any future retention-period policy from a single query into
-- a migration. The day there is "a writer that bypasses this process", that is
-- when a trigger starts to be worth the price.
--
-- ⚠️ detail holds only **one sentence we wrote ourselves** (same discipline as
-- billing_events.detail):
-- never the raw request body. This route family includes /api/password/reset,
-- whose body contains a plaintext password.
--
-- ⚠️ target is **two columns**, not one: target_kind answers "what kind of
-- thing", target_id answers
-- "which one". Synthesizing a single 'user:abc' string would turn "list every
-- action against an account" into a LIKE prefix
-- match -- yet another one-value-answers-two-questions. Both columns are
-- nullable: some actions **have no** target ("read an orphan view"
-- has none), and inventing a fake target for it is worse than leaving it empty.
CREATE TABLE IF NOT EXISTS ops_audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT NOT NULL,          -- who: a users.id already proven by Bearer
  action         TEXT NOT NULL,          -- did what: <domain>.<object>.<verb>
  target_kind    TEXT,                   -- to whom ①: the target's **kind** (user/pairing/...)
  target_id      TEXT,                   -- to whom ②: the id of **that one** target
  detail         TEXT,                   -- one sentence we wrote ourselves, never the request body
  created_at     TEXT NOT NULL           -- when: RFC3339, UTC, fixed width (stamped by the repo)
);
-- "what happened recently" -- this table's only read pattern, so the index is built for exactly that.
CREATE INDEX IF NOT EXISTS idx_ops_audit_created ON ops_audit_log(created_at DESC, id DESC);
-- "what did this person do" -- the second question when assigning blame. Without it, filtering by actor is a full table scan.
CREATE INDEX IF NOT EXISTS idx_ops_audit_actor ON ops_audit_log(actor_user_id, created_at DESC);

-- 11. timeline_keymeta (card SALT-1, 2026-08-11 -- per-account blind-store key
--     metadata: the Argon2id KDF salt + the passphrase-verification sentinel.
--     Design: docs/strategy/2026-08-11-design-e-multidevice-salt.md, section 3.1)
--
-- PLAINTEXT COLUMNS, DELIBERATELY. This row is what a second device reads
-- BEFORE it has any key, so it cannot ride the 「e2e:v1:」 envelope it exists to
-- unlock (the mobile-side analysis in blind_store_keyring.dart:36-39 stands).
-- Storing the sentinel adds ZERO new attacker capability: every stored
-- 「e2e:v1:」 blob in timeline_blobs is already an equivalent offline
-- passphrase-guessing oracle at the same Argon2id price per guess (design
-- section 2). The only defence is, and always was, the Argon2id cost of one
-- guess plus the passphrase's own strength -- identical with or without this row.
--
-- 🔴 FIRST WRITER WINS. The repo (timeline-keymeta.repo.ts putFirstWriter)
-- refuses to overwrite a differing row: replacing an account's salt orphans
-- every ciphertext sealed under the old key. Re-registration is a later,
-- explicit migration card -- never a PUT.
--
-- user_id carries FK CASCADE like timeline_blobs: account deletion (0.3.0 P4)
-- relies on the FK graph to be THE single answer to "which tables does deleting
-- an account delete", and key
-- metadata surviving its account would be exactly the leftover that list-based
-- deletes forget. (The design names only the columns; the FK follows the
-- established idiom of every per-account table here.)
--
-- created_at is INTEGER ms-since-epoch (design section 3.1 says INT), unlike
-- the TEXT timestamps elsewhere in this file; the repo stamps it.
CREATE TABLE IF NOT EXISTS timeline_keymeta (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt_b64    TEXT NOT NULL,
  sentinel    TEXT NOT NULL,
  schema_ver  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 12. timeline_grants (card GRANT-1, 2026-08-11 -- web-preview grant
--     AUTHORIZATION rows. Design: docs/strategy/2026-08-11-design-e-grant-web-
--     preview.md, section 3.2)
--
-- 🔴 THE WRAP IS NEVER STORED. This table holds AUTHORIZATION facts only
-- (who / which origin / until when / revoked or not). The wrapped master key
-- (the "timeline:grant" frame's wrap field) passes through the relay exactly
-- once, verbatim, from the phone to the requesting web socket -- the server
-- never persists any key material, wrapped or not (design section 3.2:
-- "the wrap is not stored -- it only passes through hands at the moment of
-- forwarding"). A column for it here would turn the
-- blind relay into a key-escrow table; grant.handler.ts never hands this
-- repo the wrap, and the repo has no column to put it in.
--
-- DURABLE (a table, not the in-memory pending store) for two stated reasons:
-- an hour-plus authorization must survive a relay restart, and this table IS
-- the data source for the REST list/revoke surface (GET/DELETE
-- /api/timeline/grants). The 90-second PENDING request that precedes a grant
-- stays in memory (grant.handler.ts GrantPendingStore, qr-grant.ts precedent:
-- sub-minute state does not warrant a schema change).
--
-- authorization is judged from THIS table (liveGrantFor: not revoked, not
-- expired), never from the wrap -- "the wrap is blind, the authorization is in
-- plain view, the two layers are kept
-- separate" (design section 3.1). expires_at / created_at are INTEGER ms-since-epoch
-- like timeline_keymeta's created_at (the repo stamps created_at).
--
-- revoked is INTEGER not TEXT for the ADDITIVE_INT_COLUMNS reason: a TEXT '0'
-- is truthy in JS and every live grant would read as revoked's opposite --
-- the storage-face variant of the repo's #1 bug shape.
--
-- FK CASCADE like every per-account table here: deleting the account deletes
-- its grants (a grant outliving its account would authorize reads of a blind
-- store whose rows the same cascade already destroyed -- an inert but
-- dishonest leftover).
CREATE TABLE IF NOT EXISTS timeline_grants (
  gid         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
-- 「this account's grants, newest first」 -- the REST list and liveGrantFor both
-- filter by user_id and order/scan by recency, so the index is (user_id,
-- created_at). Not unique: one account legitimately accumulates rows (every
-- re-authorization supersedes the last and leaves it revoked in place).
CREATE INDEX IF NOT EXISTS idx_timeline_grants_user ON timeline_grants(user_id, created_at);

-- 13. email_verifications (card VERIFY-1, 2026-08-11 -- the ONE active
--     email-verification code per account. Behavior contract:
--     docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-
--     login.md D1/D2)
--
-- 🔴 user_id is the PRIMARY KEY, which IS the 「one active code per account」
-- rule: a resend cannot add a second live code, it REPLACES the row (the
-- repo's put is INSERT OR REPLACE), so there is never a moment where two
-- codes are simultaneously valid and the older one quietly widens the guess
-- space.
--
-- 🔴 code_hash is the SHA-256 of the code, NEVER the code itself: a DB read,
-- a backup, or a log line quoting a row must not hand anyone a working code.
-- (Unsalted, and the repo's policy module says why that is honest: a 10^6
-- input space is enumerable offline either way -- the real defences are the
-- TTL and the attempt cap, both columns here.)
--
-- attempts counts WRONG confirm guesses against THIS code; at the cap
-- (auth/email-verification.ts 「EMAIL_VERIFICATION_MAX_ATTEMPTS」) the row is
-- deleted -- the code dies, the user must request a fresh one. sent_at is the
-- resend-cooldown anchor (durable on purpose: a relay restart must not reset
-- the cooldown). Both INTEGER ms-epoch like the two timeline tables above.
--
-- FK CASCADE like every per-account table here: a pending code outliving its
-- account would be a credential for a person that no longer exists. The row is
-- transient by nature (15-minute TTL) -- expiry is judged on read against
-- expires_at; there is no sweeper, the fail-closed liveGrantFor shape.
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL
);

-- 14. usage_events (card A2-5 / REQ-12-08, 2026-08-12 -- ONE ROW PER METERED
--     EVENT. Design: docs/strategy/2026-08-12-req1208-usage-log-storage-audit-
--     and-design.md section 5.2, which argues each column on its own.)
--
-- 🔴 THIS IS NOT usage_records AND IT MUST NEVER FEED THE QUOTA. Table 6 is the
-- month bucket the quota guard reads (billing/quota-guard.ts, symbol budget);
-- this is the per-event log behind it. The reconciliation relationship is
-- deliberately an INEQUALITY -- SUM over usage_events is <= usage_records --
-- and the ONE reason for the gap is that retention swept old events (table 6 is
-- never swept, db/retention.ts). Re-pointing ensureQuota here would give
-- "how much was used this month, in total" two answers that are GUARANTEED to
-- diverge, and the one
-- that drifts is the one that silently refunds quota nobody granted.
--
-- 🔴 NO CONTENT, AND THE COLUMN LIST IS THE WHITELIST (design 3.2/3.3): no
-- transcript, no excerpt, no summary, no keyword, no content-derived value
-- other than counts, no IP, no location, no window title, no target app, no
-- request id. A WHITELIST rather than a blacklist, for the M2-7 reason: a
-- blacklist leaks by default every field somebody adds later.
--
-- 🔴 WRITING A ROW IS BEHIND A SWITCH THAT DEFAULTS OFF
-- (FLOWMIC_USAGE_EVENTS_ENABLED, config.ts usageEventsEnabled; the shape and
-- the precedent are FLOWMIC_MANAGED_STT_ENABLED). The table, the repo, the
-- sweep and the read route all exist with the switch off -- what does not
-- happen is COLLECTION, because the published privacy policy owes users 30
-- days notice before this granularity begins and a later ruling cannot
-- un-collect a row that already exists. The switch is announced at startup
-- (billing/usage-tracker.ts) so no operator has to guess which state a machine
-- is in.
--
-- id INTEGER PRIMARY KEY AUTOINCREMENT, the second table here that is not
-- TEXT-keyed, for the SAME two reasons ops_audit_log states above: strictly
-- increasing so "A happened before B" has an exact answer (two rows in one
-- millisecond ordered by a timestamp is a coin flip), and a used number is
-- never reused so a hole in the sequence says "there used to be a row here". It is also the
-- keyset cursor the two read APIs page on (next_after_id).
--
-- occurred_at is INTEGER ms-since-epoch, NOT this file's older TEXT datetime
-- shape. TEXT timestamps in this database sort AS TEXT, and billing.repo.ts
-- carries the account of a +08:00 offset that silently shuffled a whole table.
-- Same INTEGER shape as timeline_keymeta / timeline_grants / email_verifications.
--
-- kind is 'stt' or 'llm' -- the SAME two values as QuotaKind
-- (billing/quota-guard.ts). Deliberately not a third word for the same idea.
--
-- stt_ms / tokens_in / tokens_out coexist and do not exclude one another: an
-- stt event carries tokens 0 and that 0 is a TRUE VALUE, not a missing one.
--
-- 🔴 transcript_chars / delivered_chars are NULLABLE, and every other count in
-- this table is NOT NULL DEFAULT 0. The difference is deliberate and it is the
-- "no permanently-zero column" rule made structural: the LLM leg has no text to
-- measure and never will, so NOT NULL DEFAULT 0 there would make every llm row
-- ASSERT "zero characters" about something nobody counted. NULL means "this leg
-- does not measure character counts";
-- 0 means "measured, and it was zero" (a silent utterance that still consumed audio ms). A
-- quota-refused row is NULL for the same reason — the session never ran, so
-- there was nothing to count, and outcome is what says so.
--   · transcript_chars = what the ENGINE produced for this utterance, summed
--     over every final AFTER the pure two-stage pipeline and BEFORE polish;
--   · delivered_chars  = what actually LEFT the server on stt:final frames,
--     i.e. post-polish and counted only where the emit really happened.
-- They differ for two real reasons rather than by rounding: polish rewrites the
-- text, and a session torn down mid-polish drops a final that was already
-- transcribed. 🔴 A SINGLE chars COLUMN COULD NOT SAY BOTH — that is this
-- repo's number-one shape, and "how much did I say" vs "how much did you
-- actually send out" is exactly the
-- pair a user disputing a bill asks about.
-- ⚠️ UTF-16 code units (JS String.length), not graphemes: it is the same
-- quantity stt.polish's "chars" log lines and stt-factory's interim
-- instrument already report, and two different definitions of "character
-- count" in one
-- system is worse than one imperfect definition. An emoji counts as 2.
-- 🔴 NOT A CONTENT FIELD, and the policy says so out loud: docs/legal/
-- privacy-policy.md "Character counts in usage events are counts only — not
-- excerpts, keywords, or summaries". A count is a function OF the content, which
-- is why it is named in the policy table rather than smuggled in as a number.
--
-- 🔴 is_byok is INTEGER, never TEXT. schema.ts already spells out why one
-- column up: a TEXT '0' is TRUTHY in JS, which is how permanent_free nearly
-- read every account as exempt. And unlike usage_records, a BYOK session DOES
-- get a row here (is_byok=1) while still being billed nothing -- the metering
-- early-return answered two questions at once, and a user looking at their own
-- usage page must not see a blank that is indistinguishable from "I just
-- wasn't talking during that stretch". The one line that decides this is named in billing/usage-tracker.ts.
--
-- 🔴 channel is NULLABLE, and since 2026-08-12 it IS written -- with 'cloud',
-- always, and never with 'lan'. owner closed ruling ⑨'s ambiguity that day
-- (docs/decisions/2026-08-12-owner-c5-usage-channel-is-cloud-relay.md):
-- "channel"
-- means the DELIVERY channel (a), and this detail table records ONLY traffic
-- that went through the cloud relay. The meter is unreachable outside
-- mode === 'saas', and a saas process IS the cloud relay, so the value is
-- derived from a fact this layer has rather than assumed -- the full argument
-- is at billing/usage-tracker.ts USAGE_EVENT_CHANNEL.
-- ⚠️ THIS PARAGRAPH USED TO SAY "NOTHING WRITES IT TODAY, on purpose … inventing
-- 'cloud' because the relay is the saas process would be a guess wearing a
-- measurement's clothes". That was TRUE while the word had two possible
-- meanings; the ruling is what retired it, not a change of mind about guessing.
-- The column stays NULLABLE because NULL is what a row written before the
-- ruling says, and "unknown" is not "lan". Same argument as
-- ops_audit_log.target_kind being nullable.
--
-- 🔴 outcome is a SEPARATE column from the numbers, and that separation is the
-- point: a quota refusal has stt_ms = 0, and "zero minutes" and "blocked" must
-- be two
-- statements. Folding the refusal into a zero makes one value mean both
-- "unused" and "not allowed to use" -- this repo's number-one bug shape.
-- ⚠️ The design also listed 'torn_down'. It is NOT here: SttSessionBridge
-- settles through the SAME onComplete seam from finish() and from dispose()
-- (engine/stt-session.ts), so the meter physically cannot tell a clean ending
-- from an unclean one. A value that can never appear would let a reader
-- conclude "no session was ever interrupted" from its absence -- an absence
-- read as evidence.
-- Adding it needs the seam to carry the fact first.
--
-- 🔴 refused_user_id (2026-08-17) -- WHOSE QUOTA SAID NO. Since QTA-2 there are
-- TWO accounts in front of an audio:start: the ACTING one (this row's user_id,
-- the account the minutes are metered to) and the PAIRED PC OWNER's, which is a
-- GATE only and is never billed. Either can refuse, and until this column the
-- row named only the acting one -- so a row reading "user_id=A, quota_refused"
-- asserted that A had hit A's ceiling when A's ceiling was fine. The SUBJECT of
-- the sentence was wrong, which is a worse failure than a missing one.
--   · equals user_id  -- the acting account's own quota refused;
--   · differs         -- the PC owner's quota did, and this account's is intact.
-- Same pair the refusal LOG line already names (audio.handler.ts K-5 writes
-- gate + the judged user_id); this makes it durable, since the journal rotates
-- and the ledger is what a billing question is answered from months later.
-- 🔴 IT DOES NOT CHANGE user_id's MEANING (owner's ruling, 2026-08-17): that
-- column still says whose attempt this was, so rows written before today keep
-- meaning exactly what they meant. NULL = "not recorded" -- a pre-column row,
-- or an outcome='ok' row where nobody refused anything. NOT backfilled: only
-- the refusal path knows the answer, and inventing user_id there would forge
-- the very statement this column exists to stop forging.
-- 🔴 NULLABLE TEXT WITH NO FK, DELIBERATELY. A second REFERENCES users(id) ON
-- DELETE CASCADE here would let the PC OWNER deleting their account delete the
-- PHONE user's usage rows -- one account erasing another's record. The FK count
-- on this table therefore stays at exactly one, pinned by the cascade census.
--
-- FK CASCADE to users like every per-account table here: the delete census
-- (http/account-lifecycle.ts USER_CASCADING_TABLES) relies on the FK graph
-- being THE answer to "which tables does deleting an account delete", and a
-- usage log outliving its account is
-- exactly what a hand-written delete list forgets.
CREATE TABLE IF NOT EXISTS usage_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_at  INTEGER NOT NULL,          -- ms since epoch (never TEXT)
  kind         TEXT NOT NULL,             -- 'stt' | 'llm' (= QuotaKind)
  stt_ms       INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  is_byok      INTEGER NOT NULL DEFAULT 0,-- 🔴 INTEGER, see above
  channel      TEXT,                      -- 'lan' | 'cloud' | NULL = unknown
  outcome      TEXT NOT NULL,             -- 'ok' | 'quota_refused'
  transcript_chars INTEGER,                -- 🔴 NULLABLE = "this leg does not measure character counts", see above
  delivered_chars  INTEGER,                -- 🔴 NULLABLE, same reason
  refused_user_id  TEXT                    -- 🔴 NULLABLE, and NO FK on purpose, see above
);
-- "this account's events, in the order they occurred" -- the ONLY read shape both APIs use, so the index
-- is exactly it. (user_id, id) rather than (user_id, occurred_at): id is both
-- the ORDER BY key and the keyset cursor, so this index seeks instead of
-- sorting. The occurred_at window is then a residual filter WITHIN one
-- account's own rows -- bounded by that account's history, not by the platform's
-- -- and the retention sweep deletes through the same prefix. If a single
-- account ever grows enough rows for that residual scan to matter, the fix is a
-- second index on (user_id, occurred_at); it is named here so nobody has to
-- rediscover it.
CREATE INDEX IF NOT EXISTS idx_usage_events_user_seq ON usage_events(user_id, id);

-- ── site_daily_counts (2026-08-15 — first-party public-site aggregate counts) ─
-- SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md
--
-- Daily BUCKETS only — never a per-visitor row. Primary key is the whole
-- dimension tuple so concurrent increments UPSERT rather than race into
-- duplicates. Not FK-linked to users: register_ok / login_ok are platform
-- totals, not account-scoped events (privacy: no visitor id, no account id).
-- Retention = 90 days (db/retention.ts SITE_COUNTS_RETENTION_DAYS), swept
-- table-wide because there is no per-account owner to walk.
CREATE TABLE IF NOT EXISTS site_daily_counts (
  day        TEXT NOT NULL,               -- UTC YYYY-MM-DD
  kind       TEXT NOT NULL,               -- pageview | download_click | register_ok | login_ok
  dim        TEXT NOT NULL,               -- path | locale | referrer_host | utm | src | _
  dim_value  TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, dim, dim_value)
);
CREATE INDEX IF NOT EXISTS idx_site_daily_counts_day ON site_daily_counts(day);
`;

/** Additive columns reconciled onto pre-existing DBs (guarded ADD COLUMN). On a
 *  fresh DB they already exist (CREATE above), so every ALTER is skipped — this
 *  is the "only add columns, never alter" discipline (05 §1), and the mechanism
 *  the migration-idempotency test exercises by running the migration twice. */
export const ADDITIVE_TEXT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // The `transcript_history` entry (entry_type / origin / attachment_ref /
  // device_label / processed_text / process_mode / process_params /
  // inject_target / thumb_b64) was removed on 2026-07-31 with the table itself —
  // reconcileSchema DROPs it before this loop runs, so an ALTER here would try to
  // add a column to a table that no longer exists.
  // v0.2.4 machine-level identity (owner 2026-07-29: "should be able to clearly
  // tell whether it's the same phone and the same PC each time"). Both are DERIVED digests, never the raw seed — see
  // protocol/protocol-primitives.ts DeviceUid.
  //
  // Deliberately NOT unique. Two rows CAN legitimately share one: a machine
  // that re-registered before this column existed left a second row behind,
  // and the whole point of the column is to be able to SEE that. A unique
  // constraint would make the migration fail on exactly the databases that
  // most need it, which is the worst possible time for a migration to throw.
  // 0.2.66 `pcid` — the PUBLIC addressing half of a cloud pairing (owner
  // 2026-08-14). Nullable TEXT with no default is the honest shape: a row that
  // predates this column has no PCID, and NULL says exactly that. It is filled
  // lazily on the row's next connection — register OR token reconnect
  // (registry.stampPcid; the reconnect leg was added in 0.3.1 after the
  // register-only backfill proved unreachable for established desktops) — the
  // same 「backfill on next connection」 shape `machine_uid` uses — deliberately NOT a
  // table sweep, because a row that has never reached the relay cannot be paired
  // by PCID anyway (its PCID has never been displayed to anyone).
  //
  // 🔴 UNLIKE its two neighbours here, this one IS unique — enforced by a PARTIAL
  // unique index created after the ALTER loop (connection.ts), `WHERE pcid IS NOT
  // NULL`. The partial predicate is what makes that safe on a legacy database:
  // every pre-existing row is NULL and NULLs are outside the index, so the
  // migration cannot fail on the databases that most need it (the failure mode
  // machine_uid's comment above is about). Uniqueness must be the DATABASE's
  // answer and not an application-level 「check then write」, which is a race with
  // no lock behind it.
  pc_devices: ['machine_uid', 'pcid'],
  mobile_pairings: ['device_uid'],
  // Q2 (2026-08-12) — `users.restriction_reason`, the enumerated reason shown to
  // a restricted account holder. 🔴 IT RIDES THIS LOOP AND ITS SIBLING
  // `restricted_at` DELIBERATELY CANNOT: that one is an INTEGER ms-epoch where
  // the INT loop's `NOT NULL DEFAULT 0` would read as「restricted since
  // 1970-01-01」on every legacy row, so it has a hand-written guarded step in
  // reconcileSchema. This one is a nullable TEXT with no default — exactly what
  // this loop emits — and NULL on a legacy row is the truth: nobody recorded a
  // reason, and the surfaces render nothing rather than guessing one.
  users: ['restriction_reason'],
  // Window D1 §3.3-bis. TEXT and nullable on purpose: on a row that predates this
  // column there IS no "most recent redelivery", and NULL is the only honest
  // value for it. Its INTEGER sibling `redelivery_count` rides the other loop.
  billing_events: ['last_notification_id'],
};

/** Additive INTEGER columns, reconciled the same way (guarded ADD COLUMN, same
 *  idempotency). Emitted as `INTEGER NOT NULL DEFAULT 0` — see the loop in
 *  connection.ts.
 *
 *  🔴 Why a SECOND table instead of one more entry in ADDITIVE_TEXT_COLUMNS:
 *  that loop emits `ADD COLUMN <col> TEXT`, so an int flag stored there arrives
 *  as the STRING `'0'` on every pre-existing database — and `'0'` is TRUTHY in
 *  JS. `permanent_free` would then read as "yes, exempt" for every account that
 *  was never marked, on exactly the databases that have real users on them
 *  (a fresh DB, where CREATE made it a real INTEGER, would be fine — which is
 *  the worst possible split: green in tests, wrong in production).
 *
 *  Why `NOT NULL DEFAULT 0` is the fixed shape rather than per-column config:
 *  SQLite REFUSES `ADD COLUMN ... NOT NULL` without a non-null default, and for
 *  an int flag/counter added to rows that predate it, 0 is the only value that
 *  asserts nothing. A column that needs a different default is not additive —
 *  it needs its own guarded step, written out in reconcileSchema. */
export const ADDITIVE_INT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['permanent_free'],
  // Window D1 §3.3-bis. A COUNTER, so the backfilled 0 is literally true for a row
  // that predates the column: we did not count its redeliveries, and 0 is what we
  // can honestly say we counted. (The unknowable part — whether it WAS redelivered
  // before we started counting — is why `last_notification_id` stays NULL there
  // rather than being invented.)
  billing_events: ['redelivery_count'],
};


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
  -- REVIEW-GRACE (2026-09-09, owner: 「延长时间到11月」): ms-since-epoch until
  -- which THIS ONE ACCOUNT's unverified grace runs, overriding the computed
  -- deadline when it is later. NULL = no override, i.e. the ordinary policy.
  --
  -- 🔴 NOT A STAMP ON email_verified_at, which was the cheaper write. The five
  -- store-review accounts hold @flowmic.test addresses (a reserved TLD; nothing
  -- can deliver to them), so nobody has verified or ever can, and that column is
  -- also what opens the web-console surfaces (auth/email-verification.ts
  -- "isEmailVerified") — a second, unasked-for change riding on the first. This
  -- column asserts only what is true: these accounts are not being asked to
  -- verify before the stated date.
  --
  -- 🔴 AN EXPIRY, NOT A FLAG, so the gate returns on its own: a boolean
  -- exemption needs somebody to remember to remove it, a date cannot be
  -- forgotten into permanence. The worst outcome of nobody touching the row
  -- again is that the ordinary policy resumes.
  --
  -- INTEGER ms-epoch and NULLABLE like email_verified_at above and restricted_at
  -- below, so it CANNOT ride ADDITIVE_INT_COLUMNS (INTEGER NOT NULL DEFAULT 0;
  -- 0 is a legal ms-epoch). 0 would be harmless arithmetically — max() never
  -- picks 1970 — but it would still be every row on the platform saying「grace
  -- extended until 1970-01-01」. Its guarded step is in connection.ts
  -- reconcileSchema and BACKFILLS NOTHING. The one place it becomes a verdict is
  -- auth/verification-grace.ts "verificationGrace"; nothing else may decide.
  verify_grace_until INTEGER,
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
  -- LOGIN-1 (owner ruling owner-web-rulings/latest.md:59-62 — 「要记，并同步改隐私
  -- 政策」/「approve_with_policy」): ms-epoch of the most recent SIGN-IN observed
  -- for this account; NULL = none recorded. ONE question — "when did this person
  -- last present a credential and get a session" — and a NEW column because the
  -- nearest values answer another (pc_devices/mobile_pairings.last_seen_at =
  -- "has that DEVICE been active"). auth/auth-service.ts 「recordSignIn」 is the
  -- ONLY writer and enumerates the paths that count; token verification is
  -- deliberately not one, or this becomes last-ACTIVITY labelled "last login".
  -- NULLABLE INTEGER like 「email_verified_at」/「restricted_at」, so it CANNOT ride
  -- ADDITIVE_INT_COLUMNS (「NOT NULL DEFAULT 0」 is a legal ms-epoch ⇒ every legacy
  -- row would read 「last signed in 1970-01-01」); guarded step in connection.ts.
  -- 🔴 THAT STEP BACKFILLS NOTHING — the THIRD distinct reason here:
  -- 「email_verified_at」 must backfill (else everyone is locked out),
  -- 「restricted_at」 must not (any value restricts the platform), and this one
  -- must not because THE ANSWER IS NOT KNOWABLE — nothing on disk records when
  -- anybody last signed in, so a stamp would be invented evidence about a person
  -- on the screen where an operator decides whether to restrict them.
  -- 🔴 COLLECTION IS BEHIND 「FLOWMIC_LOGIN_RECORD_ENABLED」, DEFAULT OFF; config.ts
  -- 「loginRecordEnabled」 holds the four preconditions for opening it.
  last_login_at   INTEGER,
  -- NR-1 (docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md
  -- §1; activation docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 2;
  -- the original 「record only」 entry is
  -- docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md ④):
  -- Google's 「sub」 claim for the Google account bound to this row; NULL = this
  -- account has never signed in with Google.
  --
  -- 🔴 IT IS THE IDENTITY, AND THE EMAIL IS NOT. Google's own guidance and this
  -- card's design both say 「sub」 is the only stable identifier: a person can
  -- change the address on a Google account, and two different Google accounts can
  -- present the same address over time. 「email」 is used ONCE, to find an EXISTING
  -- FlowMic row the first time (so signing in with Google does not silently mint a
  -- second account beside the password one); every sign-in after that resolves by
  -- this column. Matching on email forever would make 「which FlowMic account is
  -- this」 answerable two ways, and the day they disagree is the day someone lands
  -- in a stranger's console.
  --
  -- TEXT and NULLABLE, and it rides ADDITIVE_TEXT_COLUMNS' SHAPE but NOT that
  -- loop — because it also needs a UNIQUE index, and that index cannot be created
  -- before the ALTER has run. Its guarded step (ALTER + partial unique index) is
  -- in connection.ts reconcileSchema, next to the three nullable-INTEGER ones.
  --
  -- 🔴 THAT STEP BACKFILLS NOTHING, the FOURTH distinct reason on this table:
  -- 「email_verified_at」 must backfill, 「restricted_at」 must not (any value
  -- restricts the platform), 「last_login_at」 must not (the answer is not
  -- knowable) — and this one must not because ANY value would be a claim that a
  -- specific Google account belongs to this person. There is nothing to invent
  -- from: no row on this platform has ever been through Google.
  --
  -- ⚠️ NO 「UNIQUE」 KEYWORD HERE, deliberately: the constraint is a PARTIAL unique
  -- index (WHERE google_sub IS NOT NULL) in reconcileSchema, so that the fresh
  -- CREATE and the forward-ported ALTER converge on the SAME schema objects. A
  -- column-level UNIQUE would exist only on fresh databases and 「schemaSnapshot」
  -- would see two different shapes. SQLite treats NULLs as distinct in a unique
  -- index either way; the predicate states the intent and keeps the index off the
  -- (many) rows that will never have one.
  google_sub      TEXT,
  -- card M4-01 (docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md
  -- §2.4; owner ruling 11 of 2026-09-09): 1 = this row is an ANONYMOUS SITE-DEMO
  -- identity, minted by POST /api/web/anon for a visitor who never signed up.
  --
  -- 🔴 IT RIDES ADDITIVE_INT_COLUMNS, unlike its four hand-written neighbours
  -- above, and it is the one column on this table for which that loop's fixed
  -- 「INTEGER NOT NULL DEFAULT 0」 is exactly right: 0 means 「a real account」,
  -- which is true of every row that exists on every deployment the day this
  -- ships. There is nothing to invent and nothing to backfill.
  --
  -- ⚠️ INTEGER for the reason 「permanent_free」 is: a TEXT '0' arrives on the JS
  -- side as TRUTHY, and this flag decides whether an automatic sweep may DELETE
  -- the row. The one INTEGER→boolean conversion is repos/user.repo.ts 「toRecord」.
  --
  -- It answers ONE question — 「did anyone ever sign up for this account」 — and
  -- never 「what tier」 (plan), 「is it exempt」 (permanent_free) or 「may it be
  -- swept right now」 (that is the sweep's age test, db/anon-cleanup.ts).
  anonymous       INTEGER NOT NULL DEFAULT 0,
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
  -- 2026-08-29 multi-node: which relay node this PC is on (「srvny」/「srvjp」).
  -- NULL ⇒ 「dial the host you already have」. Also in the additive loop below,
  -- so fresh and migrated databases match. Design §4-2.
  home_node          TEXT,
  -- card S2-01 · WHAT KIND OF END holds this room, and what it can receive.
  -- client is 'app' | 'web' ('web' = a browser page acting as a target); NULL
  -- on every row written before the column, which READS as 'app' at exactly one
  -- place (protocol clientOriginOf) and is never backfilled here — a sweep would
  -- be asserting something about rows nobody looked at.
  -- target_caps is the JSON the target declared about itself, e.g.
  -- {"image":true}. NULL means UNDECLARED, which is a third state and not a
  -- no: the microphone end must ALLOW an image to an undeclared target, because
  -- that is where every installed FLOWMIC-PC sits on the day this ships.
  client             TEXT,
  client_version     TEXT,
  target_caps        TEXT,
  -- card S2-04 · WHO MINTED THIS ROW, and until when it is worth keeping.
  --
  -- 🔴 room_kind IS SERVER-MINTED AND A CLIENT CAN NEVER SET IT. That is the
  -- entire reason it exists as a column instead of being read off
  -- client_instance_id (a reserved 「web-」 prefix, which is what the design
  -- register proposed) or off client one line up. Both of those arrive INSIDE A
  -- CLIENT FRAME: pc:register takes client_instance_id from its payload and
  -- client is documented right here as 「a claim the client makes about
  -- itself」. room_kind is what occupiesPcSlot (via isWebRoom) consults to
  -- decide whether a row eats one of the account's paid PC slots (owner
  -- ruling W-3: a browser room must not) — NOT isRealPc, which never reads
  -- this column at all (registry-shared.ts: isRealPc answers a narrower
  -- question, 「is this the F-3140 virtual cloud-instance row」, and stays that
  -- narrow on purpose so pairing's two isRealPc call sites keep resolving a
  -- browser room instead of finding nothing to pair with),
  -- so a value any desktop could put in its own registration frame would be a
  -- one-line opt-out of a plan dimension we sell.
  --   NULL  = an ordinary PC row (every row that existed before this column, and
  --           every desktop registration since). NEVER backfilled: there is
  --           nothing to infer, and 「ordinary」 is exactly what NULL already says.
  --   'web' = minted by POST /api/web/rooms for a browser acting as a target.
  --
  -- room_expires_at is that room's TTL, written as an ISO-8601 UTC string —
  -- the spelling setOnline already uses for last_seen_at on this same table
  -- (new Date().toISOString()), NOT the space-separated form SQLite's own
  -- datetime('now') default puts in created_at. Read it with db/utc-stamp.ts
  -- parseUtcStamp, never a bare Date.parse: that helper accepts both
  -- spellings, and this table now contains both — see its header for the 8-hour
  -- production drift a bare parse caused on the Tokyo replica. NULL on every row
  -- that is not a web room, and there it means what it says: nothing expires.
  -- ⚠️ WHAT ENFORCES IT TODAY IS ONE PLACE ONLY — POST /api/web/rooms, which
  -- releases an expired room and mints a fresh one in its place. There is no
  -- sweeper on a 30-minute clock: an abandoned browser room therefore OUTLIVES
  -- its stamp until the account opens another one, or until the 90-day growth
  -- reaper (db/reaper.ts) takes it as an ordinary stale offline row. That is the
  -- safe direction of the two — a room that lasts longer than advertised
  -- degrades to today's behaviour, whereas a room deleted out from under a live
  -- page would be a session vanishing mid-sentence — but it is a HALF, and the
  -- half that is missing is the socket leg: a page holding a token for an
  -- expired room still reconnects. Stated here rather than in a report because
  -- the next reader of this column will assume the stamp is authoritative.
  room_kind          TEXT,
  room_expires_at    TEXT,
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
  -- card S2-01 · which kind of end PAIRED here, so the desktop's paired-devices
  -- table can mark a browser instead of showing it as an indistinguishable
  -- phone. Same NULL discipline as pc_devices.client above.
  client          TEXT,
  client_version  TEXT,
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

-- 8/8b/9. THE BILLING DOMAIN lives in ./schema-billing.ts (BILLING_SQL).
-- Split out on 2026-08-21 because this file stood at exactly 800 of the
-- 800-line cap, so the next table could not be added without either splitting
-- it or deleting an argument. The repo precedent is to split (0.2.52).
-- 🔴 The tables are NOT optional and NOT conditional: BILLING_SQL is
-- interpolated into INIT_SQL unconditionally below, so the emitted migration is
-- byte-for-byte what it was, in the same order, in one exec.

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


-- 10. THE OPS AUDIT TRAIL lives in ./schema-ops.ts (OPS_SQL): ops_audit_log plus
-- its two indexes, and the whole argument for why it is not billing_events, why
-- actor_user_id has no FK, and why target is two columns. Split out for the reason
-- BILLING_SQL was; interpolated the same way (unconditional, one exec), in this
-- position, so the STATEMENTS the migration emits are unchanged and in the same
-- order. Measured rather than asserted: rendering INIT_SQL before and after the
-- move differs only by these five comment lines and one blank line, which SQLite
-- ignores. NOT 「byte-for-byte identical」 — this comment is itself part of the
-- string now, and saying otherwise would be a claim nobody could check.

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

-- 15/16. THE RECOVERY DOMAIN lives in ./schema-recovery.ts (RECOVERY_SQL): the PR-2
-- operation registry and the metering-effect ledger, with the whole argument. Split
-- out for the reason BILLING_SQL was; interpolated the same way (unconditional, one exec).

-- 15. recovery_operations (card PR-2 -- the operation registry, audit A7-2)
--
-- 「Have I seen this request before?」 One row per (account, operation_id).
--
-- 🔴 THE BINDING COLUMNS ARE IMMUTABLE (A7-2: 「重发携带不同绑定 ⇒ 拒收，不是覆盖」).
-- A re-send that names the same operation with a DIFFERENT recording, range,
-- attempt kind or mode is refused; the stored row is left exactly as it was.
-- Overwriting would make the registry agree with whichever request arrived last,
-- which is the opposite of what a registry is for.
--
-- ⚠️ THERE IS NO CONTENT HASH COLUMN, and its absence is a KNOWN GAP rather than
-- a decision: §A7-2 names 「内容 hash + range + 模式」 as the binding, and the
-- wire (04 §3.3-a) carries no content hash today. Adding one is a protocol
-- change and belongs to the card that adds the field, not to this one. What is
-- bound here is everything the frame actually carries.
--
-- Nullable columns are nullable because the frame's recovery fields are all
-- optional (04 §3.3-a): NULL means 「this operation was registered by a frame
-- that named no such thing」, and 「named nothing」 must stay distinguishable from
-- 「named something else」 — that difference is exactly what the immutability
-- check compares. **mode** is the one NOT NULL column: an **audio:start** always has a
-- mode.
CREATE TABLE IF NOT EXISTS recovery_operations (
  user_id            TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id       TEXT    NOT NULL,
  recording_id       TEXT,
  range_start_sample INTEGER,
  range_end_sample   INTEGER,
  attempt_kind       TEXT,
  mode               TEXT    NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  -- How many times the SAME binding came back. 0 on first registration, so the
  -- number is 「re-sends」 and not 「requests」 -- two questions, and this column
  -- answers the one an operator asks (「is a client stuck in a loop」).
  resend_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_operations_last_seen ON recovery_operations(last_seen_at);

-- 16. usage_effects (card PR-2 -- the metering-effect ledger, audit A7-2)
--
-- 「Has this operation's metering of THIS KIND already been applied?」 The claim
-- row and the metering effect are written in ONE transaction
-- (db/repos/usage-effects.repo.ts), for the three-orderings reason
-- node/forward-ledger.ts spells out: claim-then-apply loses the minutes on a
-- throw, apply-then-claim double-charges on a crash, and only both-in-one
-- degrades to 「try again」.
--
-- 🔴 **kind** IS PART OF THE PRIMARY KEY. One recording can meter twice — the STT
-- minutes when the session settles, and the polish LLM's tokens — and those land
-- in different columns of **usage_records**. A key without **kind** would let the
-- first of them swallow the second.
--
-- ⚠️ THIS IS NOT exactly-once, and the word is banned from this subject (A7-2).
-- It is 「the user is metered once」. The vendor may well transcribe the same
-- audio twice, and under ruling O-9 (乙) that cost is ours.
CREATE TABLE IF NOT EXISTS usage_effects (
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  applied_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, operation_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_usage_effects_applied_at ON usage_effects(applied_at);


-- 17. THE SITE-DEMO TRIAL LEDGER lives in ./schema-trial.ts (TRIAL_SQL): card
-- M4-01's one table plus its two indexes. Split out for the reason RECOVERY_SQL
-- was; interpolated the same way (unconditional, one exec).

-- ── 17. trial_ledger (card M4-01, 2026-09-09 — the site-demo grant record) ──
-- SPEC-REF: docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.3
--
-- One row per ANONYMOUS IDENTITY. See schema-trial.ts for why there is no
-- 「ms_used」 column, why the token lives here, and why the two daily caps are
-- counts over these rows rather than counters beside them.
CREATE TABLE IF NOT EXISTS trial_ledger (
  -- The 「users」 row this grant belongs to (that row has anonymous=1). ON DELETE
  -- CASCADE so the cleanup sweep deletes ONE thing and cannot leave a ledger row
  -- pointing at an account that no longer exists.
  anon_user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- A HASH of the caller's IPv4 /32 or IPv6 /64, never the address itself
  -- (privacy policy: the site keeps no visitor IP). billing/trial-ip-bucket.ts
  -- owns the derivation and the argument for the salt.
  ip_bucket        TEXT NOT NULL,
  -- UTC YYYY-MM-DD, the same shape site_daily_counts.day uses. Stored rather
  -- than derived from created_at so the two daily caps and the daily summary
  -- line all read the same string, and a row cannot fall into a different
  -- bucket depending on which caller parsed its timestamp.
  day              TEXT NOT NULL,
  -- How many grants this IP bucket had ALREADY spent today when this row was
  -- minted — 0 for the first visitor of the day, 1 for the second, and so on.
  -- It is the INDEX INTO THE GRANT SEQUENCE, not a running total: that is what
  -- makes 「how long may this identity speak」 answerable from this row alone,
  -- forever, even after the bucket's later rows are swept.
  grants_used      INTEGER NOT NULL DEFAULT 0,
  -- Milliseconds of transcription this identity was granted. Written once, at
  -- mint. 0 is a legal value and means 「this network has used up today's demo」
  -- — the identity still exists, it just cannot speak.
  ms_granted       INTEGER NOT NULL DEFAULT 0,
  -- The opaque bearer token handed to the browser. NULL once it has been
  -- revoked or swept; the partial unique index below is what makes 「which
  -- identity is this token」 the database's answer rather than a scan.
  anon_token       TEXT,
  -- ms-since-epoch after which the token above is refused. NOT NULL: a token
  -- with no expiry is the one thing this credential must never be.
  token_expires_at INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
-- The two daily caps: 「identities from this bucket today」 and 「minutes granted
-- site-wide today」. Both are range scans on (day) with an equality on
-- ip_bucket, so one composite index serves both.
CREATE INDEX IF NOT EXISTS idx_trial_ledger_day_bucket ON trial_ledger(day, ip_bucket);
-- PARTIAL and UNIQUE for the same pair of reasons idx_users_google_sub is:
-- uniqueness of 「which identity does this token name」 has to be the database's
-- guarantee rather than a check-then-act in a route, and the partial predicate
-- keeps every swept (NULL) row out of the index so a populated database can
-- never fail this migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_ledger_token ON trial_ledger(anon_token) WHERE anon_token IS NOT NULL;


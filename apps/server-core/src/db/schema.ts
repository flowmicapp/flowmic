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
// STILL FOURTEEN after LOGIN-1 (2026-08-19): one column + one guarded step, no table.
// STILL FOURTEEN after NR-1 (2026-08-27, Google sign-in): `users.google_sub` —
// one column, one guarded step and one PARTIAL UNIQUE INDEX, no table. The index
// is the part that is easy to miss when counting 「what did this migration add」:
// it is a schema object like any other and `schemaSnapshot` compares it.
// The de-facto registry is the `TABLES` array in test/migration-idempotency.test.ts
// — a new table that is not appended there is a table nothing checks.
//
// DUAL-PREFIX RED LINE (05 §2): user_settings.value api_key fields are enc:v1:
// (server-decryptable); timeline_blobs.ciphertext is e2e:v1: (server-blind). The
// two are NEVER interchangeable — enforced at the write path, not in SQL.

import { BILLING_SQL } from './schema-billing';
import { OPS_SQL } from './schema-ops';
import { RECOVERY_SQL } from './schema-recovery';
import { SITE_SQL } from './schema-site';
import { TRIAL_SQL } from './schema-trial';
import { INTEGRATOR_SQL } from './schema-integrator';

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
  -- card R-1 (2026-09-10) · the ANONYMOUS TRIAL IDENTITY this pairing spends
  -- when it is a web end with nobody signed in. NULL for every App pairing and
  -- for every signed-in one.
  --
  -- 🔴 IT IS A SECOND COLUMN AND NOT user_id, AND THE DIFFERENCE IS THE WHOLE
  -- POINT. user_id above is ON DELETE CASCADE: writing a demo identity there
  -- would make db/anon-cleanup.ts's 48-hour sweep DELETE THIS PAIRING ROW, and
  -- the desktop's 「永不重复实例」 promise (card ID-1) would quietly expire two
  -- days after every visit. ON DELETE SET NULL says the other thing: the
  -- identity is temporary, the instance is not. When the sweep takes the
  -- identity, this column empties and the next unsigned admission mints a fresh
  -- one — still under that network's daily sequence, so a refresh buys nothing.
  --
  -- ⚠️ ALSO NOT user_id FOR A BILLING REASON: user_id is what
  -- registry.ensureMobileSlot counts against a plan's device limit, so a demo
  -- identity there would spend a slot on an account nobody signed into.
  -- (No backticks anywhere in this DDL: it lives inside a TS template literal,
  -- and one would end the string mid-schema.)
  trial_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
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
${BILLING_SQL}

-- 10. THE OPS AUDIT TRAIL lives in ./schema-ops.ts (OPS_SQL): ops_audit_log plus
-- its two indexes, and the whole argument for why it is not billing_events, why
-- actor_user_id has no FK, and why target is two columns. Split out for the reason
-- BILLING_SQL was; interpolated the same way (unconditional, one exec), in this
-- position, so the STATEMENTS the migration emits are unchanged and in the same
-- order. Measured rather than asserted: rendering INIT_SQL before and after the
-- move differs only by these five comment lines and one blank line, which SQLite
-- ignores. NOT 「byte-for-byte identical」 — this comment is itself part of the
-- string now, and saying otherwise would be a claim nobody could check.
${OPS_SQL}

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
-- 🔴 payer_reason / speaker_ref (2026-09-11, card MP-6) -- WHY THESE SECONDS
-- LANDED ON THIS ACCOUNT, and WHO WAS SPEAKING WHEN THEY DID. owner SS11 asks
-- that every second of recognition name a payer somebody can look up, so "how
-- much did the site demo burn this month" and "is a guest spending my minutes"
-- are answerable from the ledger.
--   . payer_reason -- 'self' | 'peer' | 'host' | 'demo': the branch of
--     auth/metering-principal.ts resolvePayer that chose user_id. A DIFFERENT
--     QUESTION from user_id, the separation refused_user_id above is built on:
--     user_id says WHOSE ledger moved, this says WHY -- one account appears with
--     opposite reasons for its owner recording and for a guest spending it.
--   . speaker_ref  -- WHO SPOKE: the speaker's users.id when signed in, else the
--     browser/device identity (mobile_pairings.device_uid). 🔴 NEVER AN EMAIL
--     and never anything else off the users row: this table's column list IS the
--     privacy whitelist (top of this DDL), and an opaque id already present
--     elsewhere adds no new fact about a person. It repeats user_id on a 'self'
--     row and differs everywhere else, so it is not redundant.
-- 🔴 integrator_key_id (2026-09-11, card MP-1) -- WHICH of T's publishable keys
-- spent these seconds, on a payer_reason='host' row. A THIRD question: user_id
-- says whose ledger moved, payer_reason why, this WHICH PAGE -- T may set a
-- different ceiling per key, and without this the ceiling is enforceable but not
-- auditable. NO FK (refused_user_id's reason, plus: an account deletion cascades
-- integrator_keys away and a usage row must not die because a key did).
-- Both NULLABLE TEXT, no default, NO BACKFILL, for refused_user_id's reason:
-- only the admission knows the answer and NULL says so -- inventing 'self' for a
-- pre-column row would manufacture the claim these columns exist to make
-- checkable. 🔴 AND NO FK ON speaker_ref, also for
-- refused_user_id's reason: it can hold ANOTHER account's id (a second cascade
-- would let one account's deletion erase another's usage rows) or a device uid,
-- which is not a users id at all. The FK count stays at exactly one.
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
  refused_user_id  TEXT,                   -- 🔴 NULLABLE, and NO FK on purpose, see above
  payer_reason     TEXT,                   -- 🔴 'self'|'peer'|'host'|'demo' -- WHY this account, see above
  speaker_ref      TEXT,                   -- 🔴 NULLABLE, NO FK, never an email, see above
  integrator_key_id TEXT                   -- 🔴 NULLABLE, NO FK -- WHICH key, see above
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

-- 20. SITE ANALYTICS BUCKETS live in ./schema-site.ts (SITE_SQL): 「site_daily_counts」
-- plus its index, moved VERBATIM for the 800-line cap. Interpolated like TRIAL_SQL.
${SITE_SQL}

-- 15/16. THE RECOVERY DOMAIN lives in ./schema-recovery.ts (RECOVERY_SQL): the PR-2
-- operation registry and the metering-effect ledger, with the whole argument. Split
-- out for the reason BILLING_SQL was; interpolated the same way (unconditional, one exec).
${RECOVERY_SQL}

-- 17. THE SITE-DEMO TRIAL LEDGER lives in ./schema-trial.ts (TRIAL_SQL): card
-- M4-01's one table plus its two indexes. Split out for the reason RECOVERY_SQL
-- was; interpolated the same way (unconditional, one exec).
${TRIAL_SQL}

-- 21/22. THE THIRD-PARTY INTEGRATION DOMAIN lives in ./schema-integrator.ts
-- (INTEGRATOR_SQL): card MP-1's publishable keys and the room-to-key edge, with
-- the whole argument for why BOTH are new tables and why 「pc_devices」 gains no
-- column. Split out for the reason TRIAL_SQL was; interpolated the same way
-- (unconditional, one exec).
${INTEGRATOR_SQL}
`;

// The two additive-column tables moved to ./schema-additive-columns.ts (card
// S2-01) when this file crossed the 800-line cap. Re-exported here so every
// existing `import { ADDITIVE_TEXT_COLUMNS } from './schema'` still resolves —
// the split is structural, and a consumer must not have to know it happened.
export { ADDITIVE_INT_COLUMNS, ADDITIVE_TEXT_COLUMNS } from './schema-additive-columns';

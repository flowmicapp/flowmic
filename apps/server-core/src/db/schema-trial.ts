// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (owner 2026-09-11 — one lifetime 120 s per BROWSER IDENTITY; this
//     SUPERSEDES the 120/60/30/0 per-IP-per-day sequence below)
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.3 (the
//     superseded sequence, and the in-place correction block on it), §2.4 (this
//     table is an owner gate), §3.1 gates 4 and 5 (the two ABUSE caps read off it)
//   ./schema.ts (INIT_SQL — the world a FRESH database is created in; TRIAL_SQL
//     is interpolated there unconditionally, in one exec, like BILLING_SQL)
//   ./repos/trial-ledger.repo.ts (the only reader/writer)
//   *** HUMAN-AUDIT SENSITIVE (schema) ***
//
// Card M4-01's DDL, split out of db/schema.ts for the same reason
// schema-recovery.ts was split out on 2026-09-06: that file stands at 775 of the
// 800-line cap and a table plus its argument does not fit in what is left.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts: this is ONE template literal, so a
// backtick anywhere inside it — even inside a `--` SQL comment — terminates it
// early and breaks the whole server-core build, with the error surfacing at some
// later line so it reads as a broken toolchain. Quote identifiers with 「」.
//
// ── WHAT ONE ROW IS ────────────────────────────────────────────────────────
// ONE ANONYMOUS IDENTITY. Not one visitor, not one session, not one day: the
// row is minted beside the 「users」 row it names, and it dies with it (the
// cleanup sweep deletes both). That is why the primary key is the user id
// alone rather than (user, day) — a row's 「day」 column records when it was born
// and is read by the abuse caps; it is not what the row is keyed by.
//
// 🔴 SINCE owner §10 (2026-09-11) A ROW OUTLIVES ITS DAY. The allowance is one
// lifetime 120 s per BROWSER IDENTITY, so the same 「device_uid」 coming back
// tomorrow must land on THIS row rather than on a fresh one. That is the whole
// of what 「device_uid」 below buys, and it is why the sweep's window (48 h) is
// now the only thing that ends a trial — see billing/trial-ledger.ts for the
// consequence that was accepted with it.
//
// ── WHY THE DAY AND THE IP BUCKET ARE COLUMNS AND NOT A SEPARATE COUNTER ───
// Both ABUSE caps this table serves — 「how many identities has this network
// minted today」 and 「how many minutes has the whole site handed out today」 —
// are COUNTS OVER THESE ROWS. A counter table beside them would be a second
// author for the same number, and the two would drift the first time a mint
// failed halfway. The index below is what makes the counts cheap.
//
// ⚠️ THEY ARE CAPS, NOT THE ALLOWANCE. Before owner §10 the per-bucket count
// ALSO picked how many seconds a visitor got (120/60/30/0); it no longer does,
// and 「grants_used」 below is now forensic only.
//
// ── 🔴 THERE IS NO 「ms_used」 COLUMN, AND ITS ABSENCE IS DELIBERATE ─────────
// The design register (§2.4) sketches the table with one. It is not here
// because nothing in this server could honestly write it: transcription spend
// is metered in ONE place (「usage_records」, written at settle by the billing
// meter), and a second column claiming to hold the same quantity would be a
// second answer to 「how much did this identity actually speak」 — this repo's
// #1 defect shape, on a number that decides whether the site stops handing out
// demos. The daily-spend read therefore JOINS 「usage_records」 (see
// repos/trial-ledger.repo.ts 「msUsedToday」) instead, so the meter stays
// singular and this table only records what was GRANTED.
//
// ── THE TOKEN LIVES HERE, NOT IN 「users」, AND NOT AS A JWT ────────────────
// An anonymous visitor's credential must open exactly one door: 「build me a web
// room」. An account JWT would open every account route on the server for an
// hour, for a row nobody authenticated — so the credential is an opaque
// 「fm_」 token (auth/token.ts) stored here, resolved by this table alone, and
// unknown to 「accountFromBearer」. Its expiry is a column rather than a
// convention so 「is this still good」 has one answer and it is on disk.

export const TRIAL_SQL = /* sql */ `
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
  -- 🔴 FORENSIC ONLY SINCE owner §10 (2026-09-11). It used to be the INDEX INTO
  -- A GRANT SEQUENCE (120/60/30/0); the allowance is now one lifetime 120 s per
  -- browser identity, so nothing reads this to decide how long anyone may speak.
  -- Still written, because 「how busy was this network when this visitor arrived」
  -- is what the abuse log is read for, and it cannot be recomputed later.
  grants_used      INTEGER NOT NULL DEFAULT 0,
  -- Milliseconds of transcription this identity was granted FOR ITS LIFETIME.
  -- Written once, at mint, and never re-granted: owner §10 「只有新的未注册用户才有
  -- 2 分钟」. 0 is still a legal value on a row minted by an older build.
  ms_granted       INTEGER NOT NULL DEFAULT 0,
  -- The BROWSER IDENTITY this grant belongs to — the 「wb-…」 uid the web client
  -- keeps in localStorage, as it arrives on 「mobile:pair」 and on the site
  -- demo's mint. NULL for a row minted before this column existed and for a
  -- caller that declared none (an older web build); such a row is reachable
  -- only through its own token or its pairing, which is what it was before.
  --
  -- 🔴 IT IS WHAT MAKES THE 120 s ONE-TIME. The same uid arriving through the
  -- marketing demo and through a PC pairing must find ONE row and ONE
  -- remainder — two rows would be two 120 s allowances wearing one label.
  -- Uniqueness is the database's answer (idx_trial_ledger_device, created in
  -- reconcileSchema() in ./connection.ts — see the note at the foot of this
  -- literal for why it cannot be created here) and not a
  -- SELECT-then-INSERT in the ledger, for the reason idx_pc_devices_pcid states.
  device_uid       TEXT,
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
-- 🔴 THE PARTIAL UNIQUE INDEX ON 「device_uid」 IS NOT CREATED HERE, AND IT
-- MUST NOT BE. Its one owner is reconcileSchema() in ./connection.ts, in the
-- block that also creates idx_pc_devices_pcid and idx_pc_devices_web_room_owner
-- (search that file for 'idx_trial_ledger_device'). The reason is ORDER:
-- INIT_SQL runs on EVERY boot BEFORE the guarded ADD COLUMN loop, and on a
-- database whose trial_ledger predates 「device_uid」 (any deployment upgraded
-- from before R-1b) the CREATE TABLE above is skipped by IF NOT EXISTS while
-- the column arrives only from ADDITIVE_TEXT_COLUMNS later in that loop — so an
-- index statement here indexes a column that does not exist yet, which SQLite
-- rejects outright ('no such column: device_uid') and openDatabase rethrows as
-- 'FlowMic DB migration failed'. That is not hypothetical: it crash-looped the
-- JP replica on 2026-09-10 and forced an auto-rollback. IF NOT EXISTS does not
-- help — the index does not exist, the COLUMN does.
--
-- The same reasoning applies to any future index/view/trigger over a column
-- that arrives through the ALTER loop: it belongs beside its siblings in
-- reconcileSchema, after the loop, never in INIT_SQL.
`;

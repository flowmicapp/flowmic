// SPEC-REF:
//   ./schema.ts (INIT_SQL — the world a FRESH database is created in; OPS_SQL is
//     interpolated there unconditionally, in one exec, like BILLING_SQL)
//   ./repos/ops-audit.repo.ts (the only writer/reader)
//   docs/rebuild/05-DATA-MODEL.md §1 (server SQLite, additive migration discipline)
//   *** HUMAN-AUDIT SENSITIVE (schema) ***
//
// Table 10's DDL, split out of db/schema.ts for the same reason schema-billing.ts
// (2026-08-21), schema-recovery.ts (2026-09-06) and schema-trial.ts (2026-09-09)
// were: that file stood at the 800-line cap and the next change to it could not
// land without either splitting it or deleting an argument. The repo precedent is
// to split. THE MOVE IS VERBATIM — the SQL below, comments included, is the same
// bytes that lived in schema.ts, in the same order, and INIT_SQL still interpolates
// it in the same position. Measured: rendering INIT_SQL before and after the move
// differs only by the five-line pointer comment left behind in schema.ts and one
// blank line. No statement, and no byte of any statement, moved or changed.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts: this is ONE template literal, so a
// backtick anywhere inside it — even inside a `--` SQL comment — terminates it
// early and breaks the whole server-core build, with the error surfacing at some
// later line so it reads as a broken toolchain. Quote identifiers with 「」.

export const OPS_SQL = /* sql */ `
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
`;

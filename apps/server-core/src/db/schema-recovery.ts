// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A7-2 (the two keys, and why they may not be merged), §A9 stage 3, card PR-2
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//     (O-9 = 乙: no result caching; a re-send is re-recognised; the METERING
//      effect for one operation happens once and the user is never charged twice)
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (reader/writer of table 15)
//   apps/server-core/src/db/repos/usage-effects.repo.ts       (reader/writer of table 16)
//   apps/server-core/src/node/forward-ledger.ts (the transaction shape both reuse)
//   *** HUMAN-AUDIT SENSITIVE (billing + schema) ***
//
// Card PR-2's DDL, split out of db/schema.ts on 2026-09-06 for the same reason
// schema-billing.ts was split out on 2026-08-21: that file stood at 793 of the
// 800-line cap and two tables plus their argument do not fit in seven lines.
// Nothing about the migration changed — `RECOVERY_SQL` is interpolated into
// `INIT_SQL` unconditionally, in one exec, like `BILLING_SQL` beside it.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts AND schema-billing.ts: this is ONE
// template literal, so a backtick anywhere inside it — even in a `--` SQL
// comment — terminates it early and breaks the whole server-core build, with the
// error surfacing at some later line so it reads as a broken toolchain. Quote
// identifiers with 「」 or ** **.
//
// ── WHY TWO TABLES AND NOT ONE (§A7-2, 「两键不可混同」) ─────────────────────
// They are two different keys answering two different questions, and merging
// them would silently answer one of them wrong:
//   · `recovery_operations` is keyed `(user_id, operation_id)` and answers
//     「have I seen this REQUEST before, and did it say the same thing」;
//   · `usage_effects` is keyed `(user_id, operation_id, kind)` and answers
//     「has this operation's STT metering — or its LLM metering — already been
//     applied」. STT minutes and LLM tokens are separate columns of
//     `usage_records` and must not swallow each other, so `kind` is part of the
//     key rather than a payload column.
// One row of the first can therefore legitimately own two rows of the second.
//
// 🔴 BOTH TABLES CASCADE WITH THE ACCOUNT (`ON DELETE CASCADE`), and that is a
// privacy decision rather than tidiness. `recovery_operations` holds a per-
// utterance record — which recording, which sample range, which mode — of a
// named account; `usage_effects` holds that account's id beside a metering
// fact. Both are exactly the leftover `usage_events`' own DDL argues is the
// worst one an account deletion could miss, and 「it is only seven days」 is a
// retention argument, not an erasure one.
//
// ⚠️ AN EARLIER DRAFT OF THIS FILE OMITTED THE FK, arguing that a standalone
// sidecar admits sessions for identities with no `users` row. That was FALSE and
// measuring it is what settled it: bootstrap.ts `:213-214` inserts
// `STANDALONE_USER_ID = 'default'` at boot, and `usage_records` / `user_settings`
// have carried the same FK through every standalone build. The sentence is
// recorded rather than deleted because it is the shape this repo keeps paying
// for — an argument for a missing constraint, with nothing that could contradict
// it. ⇒ Both tables are in `USER_CASCADING_TABLES` and the census in
// test/account-lifecycle.test.ts re-derives that from the live schema.
//
// 🔴 THE RETENTION WINDOW IS A DECISION WITH A USER-VISIBLE COST, stated here
// rather than left to be discovered: a re-send of the SAME `operation_id` after
// the window has swept its rows is treated as a NEW operation — registered
// again, and METERED again. Seven days is the same 「a long weekend of
// unreachability」 figure `forward-ledger.ts` argues for, and per §A7-2 the
// residual is accepted rather than solved (the alternative is a table that only
// grows). Nothing in the product claims otherwise: the phone's own recovery
// queue gives up long before this.

/** How long a registered operation — and its metering markers — are remembered.
 *  Deliberately the same seven days as `FORWARD_LEDGER_RETENTION_MS`: a replica's
 *  forwarded metering record is deduped by THAT ledger over that window, and a
 *  shorter window here would mean the two halves of one promise expire on
 *  different days. */
/** Sweep cadence for both recovery tables. Daily, the same as db/retention.ts,
 *  db/reaper.ts and the forward ledger: a seven-day window does not need a
 *  tighter sweep than any of them. */
export const RECOVERY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const RECOVERY_SQL = /* sql */ `
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
`;

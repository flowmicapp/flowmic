// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §1 (「only add columns, never alter」)
//   ./schema.ts (INIT_SQL — the world a FRESH database is created in)
//   ./connection.ts reconcileSchema (the ONE consumer: the guarded ALTER loops)
//
// MOVED OUT OF schema.ts VERBATIM (2026-09-08, card S2-01) for the 800-line
// `file-size` lint, the same cap `mobile.handler.ts` and `pc.handler.ts` keep
// bumping against — NO BEHAVIOUR MOVED WITH THE CODE, and no comment was
// dropped on the way. Both tables are re-exported from schema.ts, so every
// existing `from './schema'` import is untouched.
//
// The billing domain's own additive columns live with their DDL in
// ./schema-billing.ts and are spread in below, exactly as before.

import { BILLING_ADDITIVE_TEXT_COLUMNS } from './schema-billing';

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
  // 2026-08-29 `home_node` (design §4-2) — 🔴 THE WHOLE OF THE CROSS-NODE DIRECTORY.
  // Rooms live in a per-process Map (room/store.ts 「Live socket presence ONLY」), so
  // the design does not synchronise them: the phone FOLLOWS the PC onto the same
  // node, and this column is what it follows. NULL must read as 「dial the host you
  // already have」 — a default would assert where a PC is with nothing having looked.
  // card S2-01 `client` / `client_version` / `target_caps` — nullable TEXT with
  // no default, which is exactly what this loop emits and exactly what the
  // fields mean on a legacy row: nothing declared. 🔴 ZERO BACKFILL, and unlike
  // `machine_uid`/`pcid` there is not even a 「stamp it on next connection」 sweep
  // to write here — the stamping IS the ordinary admission path (registry
  // registerPc / pairMobile, plus the pc:reconnect leg), because a row whose
  // owner never connects again has no client to describe.
  // card S2-04 `room_kind` / `room_expires_at` — nullable TEXT with no default,
  // which is exactly what this loop emits and exactly what both mean on a row
  // that predates them: an ordinary PC row with nothing to expire. ZERO
  // BACKFILL and no 「stamp it on next connection」 sweep either, unlike
  // `machine_uid`/`pcid`: those two describe a fact about a machine that will
  // reconnect, while these two describe WHO MINTED THE ROW — and no connection
  // can tell us that after the fact. A sweep here could only invent an answer.
  pc_devices: ['machine_uid', 'pcid', 'home_node', 'client', 'client_version', 'target_caps', 'room_kind', 'room_expires_at'],
  mobile_pairings: ['device_uid', 'client', 'client_version'],
  // Q2 (2026-08-12) — `users.restriction_reason`, the enumerated reason shown to
  // a restricted account holder. 🔴 IT RIDES THIS LOOP AND ITS SIBLING
  // `restricted_at` DELIBERATELY CANNOT: that one is an INTEGER ms-epoch where
  // the INT loop's `NOT NULL DEFAULT 0` would read as「restricted since
  // 1970-01-01」on every legacy row, so it has a hand-written guarded step in
  // reconcileSchema. This one is a nullable TEXT with no default — exactly what
  // this loop emits — and NULL on a legacy row is the truth: nobody recorded a
  // reason, and the surfaces render nothing rather than guessing one.
  users: ['restriction_reason'],
  // owner §10 (2026-09-11) — `trial_ledger.device_uid`, the browser identity a
  // lifetime 120 s belongs to. Nullable TEXT with no default is exactly what
  // this loop emits and exactly what NULL means on a row minted by the build
  // that shipped this table one day earlier: nobody recorded which browser it
  // was. ZERO BACKFILL and no 「stamp it on next connection」 sweep either — the
  // uid is declared by the caller at claim time, and a row whose visitor never
  // comes back has no browser to attribute it to. The PARTIAL UNIQUE index that
  // makes 「one identity per browser」 the database's answer is created after
  // this loop, in connection.ts.
  trial_ledger: ['device_uid'],
  // Window D1 §3.3-bis. TEXT and nullable on purpose: on a row that predates this
  // column there IS no "most recent redelivery", and NULL is the only honest
  // value for it. Its INTEGER sibling `redelivery_count` rides the other loop.
  billing_events: ['last_notification_id'],
  // The billing tables' additive columns live with their DDL, in
  // ./schema-billing.ts — including the `contract_concluded_at` note, which the
  // withdrawal surface has to respect and which belongs beside the column.
  ...BILLING_ADDITIVE_TEXT_COLUMNS,
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
  // card M4-01 (2026-09-09) — 「anonymous」, the site-demo identity flag. The
  // second entry on this table, and the loop's fixed 「INTEGER NOT NULL DEFAULT
  // 0」 is the honest shape for it in both directions: on a legacy database every
  // existing row IS a real account, and 0 says exactly that. Contrast its four
  // hand-written neighbours in reconcileSchema, each of which needed a different
  // default; this one needs the loop's.
  users: ['permanent_free', 'anonymous'],
  // Window D1 §3.3-bis. A COUNTER, so the backfilled 0 is literally true for a row
  // that predates the column: we did not count its redeliveries, and 0 is what we
  // can honestly say we counted. (The unknowable part — whether it WAS redelivered
  // before we started counting — is why `last_notification_id` stays NULL there
  // rather than being invented.)
  billing_events: ['redelivery_count'],
};

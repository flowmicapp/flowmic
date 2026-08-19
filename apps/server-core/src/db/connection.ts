// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (node:sqlite DatabaseSync, WAL, FK on),
//     §1.0 (the migration mechanism as it really is — inlined INIT_SQL constant
//     + this guarded reconcile, no migrations/ directory and no numbering; the
//     old citation here was §8.3 "fresh 001 numbering", which never happened)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (migration version-bump-without-
//     writer class of bug — reconcile is guarded + idempotent by construction)
//
// Opens (or creates) a SQLite DB, runs the inlined migration idempotently, and
// returns the repo set. Node 22.22 ships node:sqlite without a flag. Path from
// opts/env; ':memory:' when unset (tests). Migration idempotency: re-running
// exec(INIT_SQL) + reconcileSchema() on an already-migrated DB is a no-op
// (CREATE ... IF NOT EXISTS + PRAGMA-guarded ADD COLUMN) — proven by the
// migration-idempotency contract test.

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { ADDITIVE_INT_COLUMNS, ADDITIVE_TEXT_COLUMNS, INIT_SQL } from './schema';

// esbuild (via tsup) does not yet recognize the newer `node:sqlite` builtin and
// strips its `node:` prefix at bundle time (→ a bogus bare `sqlite` import).
// Resolve it through a runtime require with a non-static specifier so the
// bundler can't rewrite it; node loads the real builtin. The type import above
// is erased at compile time.
const nodeRequire = createRequire(import.meta.url);
const SQLITE_SPECIFIER = 'node:sqlite';
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire(SQLITE_SPECIFIER) as {
  DatabaseSync: new (path: string, opts?: { enableForeignKeyConstraints?: boolean }) => DatabaseSync;
};
import { makeUserRepo, type UserRepo } from './repos/user.repo';
import { makePcRepo, type PcRepo } from './repos/pc.repo';
import { makeMobileRepo, type MobileRepo } from './repos/mobile.repo';
import { makeSettingsRepo, type SettingsRepo } from './repos/settings.repo';
// `history.repo.ts` was DELETED on 2026-07-31 (0.2.27) with the
// `transcript_history` table — owner's architecture ruling (docs/decisions/
// 2026-07-31-no-cloud-sync-for-phone-pc.md): the server does not store
// transcripts. Every method it had was a read or a write over that table; after
// DROP TABLE its prepared statements could not even be built at construction
// time, so there was nothing to keep.
import { makeUsageRepo, type UsageRepo } from './repos/usage.repo';
import { makeUsageEventsRepo, type UsageEventsRepo } from './repos/usage-events.repo';
import { makeTimelineRepo, type TimelineRepo } from './repos/timeline.repo';
import { makeTimelineKeymetaRepo, type TimelineKeymetaRepo } from './repos/timeline-keymeta.repo';
import { makeTimelineGrantsRepo, type TimelineGrantsRepo } from './repos/timeline-grants.repo';
import { makeBillingRepo, type BillingRepo } from './repos/billing.repo';
import { makeOpsAuditRepo, type OpsAuditRepo } from './repos/ops-audit.repo';
import { makeEmailVerificationRepo, type EmailVerificationRepo } from './repos/email-verification.repo';
import { makeSiteCountsRepo, type SiteCountsRepo } from './repos/site-counts.repo';

export interface DbConnection {
  raw: DatabaseSync;
  users: UserRepo;
  pcs: PcRepo;
  mobiles: MobileRepo;
  settings: SettingsRepo;
  usage: UsageRepo;
  /** A2-5 / REQ-12-08 (2026-08-12) — the PER-EVENT usage log (`usage_events`).
   *
   *  🔴 A SEPARATE repo from `usage` above even though both are "usage", because
   *  they answer different questions and only ONE of them may be enforced on:
   *  `usage` is the month bucket the quota guard reads, this is the log behind
   *  it. Handed to exactly three consumers — the meter (billing/usage-tracker.ts,
   *  the only writer, and only with `FLOWMIC_USAGE_EVENTS_ENABLED`), the daily
   *  sweep (db/retention.ts, the only deleter) and the read route
   *  (http/usage-events-routes.ts) — each sliced to the methods it needs. */
  usageEvents: UsageEventsRepo;
  /** First-party public-site aggregate counts (`site_daily_counts`).
   *
   *  Written by site-collect-routes + auth success paths (when
   *  `FLOWMIC_SITE_ANALYTICS=1`); read by ops-site-routes; swept table-wide by
   *  retention (90 days). Not per-account — no FK to users. */
  siteCounts: SiteCountsRepo;
  timeline: TimelineRepo;
  /** SALT-1 (2026-08-11) — per-account blind-store key metadata (KDF salt +
   *  verification sentinel, `timeline_keymeta`). Consumed by the saas-only
   *  HTTP routes (http/timeline-keymeta-routes.ts) via bootstrap's `keymeta`
   *  dep — standalone never reads it (the routes 404 there). */
  timelineKeymeta: TimelineKeymetaRepo;
  /** GRANT-1 (2026-08-11) — web-preview grant authorization rows
   *  (`timeline_grants`). Written by the socket grant handshake
   *  (grant.handler.ts), read by the timeline pull gate and by the saas-only
   *  REST list/revoke routes (http/timeline-grants-routes.ts). The wrap is
   *  NEVER in here — see the DDL's argument in db/schema.ts. */
  timelineGrants: TimelineGrantsRepo;
  /** VERIFY-1 (2026-08-11) — the email-verification store (`email_verifications`
   *  + the one `users.email_verified_at` column it exists to set). Written by
   *  the saas-only verification routes (http/email-verification-routes.ts);
   *  read — through the narrow EmailVerifiedReader slice — by every D3 gate
   *  (console features, timeline-grants REST, the kind:'web' socket events).
   *  Standalone never consults it (no console surface is mounted there). */
  emailVerification: EmailVerificationRepo;
  /** Window D1 §3.4 — Paddle subscription truth + idempotency ledger. Consumed by the webhook handler
   *  (lane C) and the reconciliation reads (lane D). */
  billing: BillingRepo;
  /** 0.2.47 — ops-action audit trail (`ops_audit_log`). Constructed here so the repo lives
   *  wherever the DB lives.
   *
   *  ✅ 0.2.48 — wired up. bootstrap now hands this instance to BOTH Bearer-gated
   *  REST surfaces (`console: {opsAudit}` and `ops: {audit}`), and the single
   *  writer is `http/ops-audit-trail.ts` `adminGate`: every request that passes or
   *  is refused by the admin gate leaves one row. The 0.2.47 text here said
   *  "not wired: no production route calls it yet" — that sentence was true when it
   *  was written and is FALSE now, which is why it is replaced rather than
   *  softened. `test/ops-audit-wiring.test.ts` is the grep that keeps it honest:
   *  it asserts, from the source tree, that `append` has a production caller and
   *  that this repo reaches a route surface. If that test is ever deleted, the
   *  honest status reverts to [NOT WIRED] until somebody re-runs the grep by hand. */
  opsAudit: OpsAuditRepo;
  close(): void;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Forward-port additive columns onto pre-existing DBs and (re)assert guarded
 * indexes. Every step is idempotent: on a fresh DB the columns already exist
 * (INIT_SQL created them), so no ALTER runs; on a re-run nothing changes.
 */
export function reconcileSchema(db: DatabaseSync): void {
  // ── 0.2.27 DESTRUCTIVE migration: drop `transcript_history` ────────────────
  //
  // owner's architecture ruling 2026-07-31 (docs/decisions/2026-07-31-no-cloud-sync-for-phone-
  // pc.md): "phone↔PC does not do cloud storage sync, the cloud does not store
  // transcripts (existing rows are deleted outright)". Every server
  // read/write path over this table is gone in the same round (history.handler
  // refuses, relay/inject-routes no longer write status, GET /api/cloud/history
  // and the LIKE search are deleted), so the table can only be dead weight
  // holding user transcripts at rest that nothing is entitled to keep.
  //
  // ⚠️ THIS DELETES PRODUCTION USER DATA. The window-A plan requires an export
  // BEFORE deploy (three-way: `sqlite3 .backup` snapshot + table `.dump` + JSON)
  // and the supervisor owns running it — this line does not and cannot check for one.
  //
  // Placed HERE, in reconcileSchema, not in INIT_SQL: this function is exactly
  // "forward-port an existing DB to today's schema", and it is the only step that
  // ever runs against a database that predates a change. `IF EXISTS` makes it
  // idempotent by construction (second boot: nothing to drop, no error) — the
  // same discipline as every guarded ADD COLUMN below.
  //
  // The two indexes (idx_transcript_user_time / idx_transcript_pc_time) need no
  // separate DROP: SQLite drops a table's own indexes with it, and an index
  // CANNOT outlive its table — so these two lines are belt-and-braces only.
  // (Supervisor human-audit 2026-07-31 corrected the original justification here, which claimed
  // they converge "a database carrying the index without the table". That state
  // is not reachable in SQLite. Defensive code is fine; a defence that names an
  // impossible state is a comment the next reader would have trusted — this repo's
  // anti-façade ④: the sentence a comment uses to justify a design is itself an
  // assertion, and it has to be true.)
  //
  // FK safety: transcript_history is a CHILD (it references users / pc_devices /
  // mobile_pairings); nothing references IT, so dropping it under
  // `PRAGMA foreign_keys = ON` cannot violate a constraint.
  //
  // ⚠️ LOADED-GUN WARNING (supervisor human-audit): this DROP runs on EVERY boot, forever. If a
  // future round ever creates a table named `transcript_history` again — a
  // multi-device lightweight-record feature is the plausible one — this line will silently destroy it on the
  // next restart, and the symptom will be "the table is empty again every morning"
  // with nothing in the logs. Reusing that name REQUIRES deleting this line in the
  // same change. Prefer a new name.
  db.exec('DROP INDEX IF EXISTS idx_transcript_user_time');
  db.exec('DROP INDEX IF EXISTS idx_transcript_pc_time');
  db.exec('DROP TABLE IF EXISTS transcript_history');
  // Partial unique index: (user_id, client_instance_id) where the instance id
  // is set (05 §1). IF NOT EXISTS makes it idempotent.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_devices_user_instance
       ON pc_devices(user_id, client_instance_id) WHERE client_instance_id IS NOT NULL`,
  );
  // The WP-R1-1 `edited` guarded ALTER lived here and went with the table.
  for (const [table, cols] of Object.entries(ADDITIVE_TEXT_COLUMNS)) {
    const present = tableColumns(db, table);
    for (const col of cols) {
      if (!present.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
    }
  }
  // Window D1 §3.1: the same guarded ADD COLUMN, for INTEGER columns. A SEPARATE
  // loop because the emitted type differs and that difference is load-bearing —
  // see ADDITIVE_INT_COLUMNS in schema.ts for why an int flag must never ride
  // the TEXT loop ('0' is truthy in JS). `NOT NULL DEFAULT 0` is what makes this
  // legal on a table that already has rows: SQLite rejects ADD COLUMN NOT NULL
  // without a non-null default, and it BACKFILLS every existing row with it, so
  // an account that predates the column reads as "not exempt" — the honest
  // answer for a flag nobody has ever set.
  //
  // On a fresh DB the column already exists (INIT_SQL created it), so this ALTER
  // is skipped — same idempotency as the TEXT loop above, and the migration-
  // idempotency test proves both shapes converge on the same PRAGMA table_info.
  for (const [table, cols] of Object.entries(ADDITIVE_INT_COLUMNS)) {
    const present = tableColumns(db, table);
    for (const col of cols) {
      if (!present.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  // ── VERIFY-1 (2026-08-11): users.email_verified_at, guarded ADD COLUMN ─────
  //
  // Deliberately NOT in ADDITIVE_TEXT_COLUMNS / ADDITIVE_INT_COLUMNS: those
  // loops emit fixed shapes (TEXT NULL / INTEGER NOT NULL DEFAULT 0), and this
  // column is INTEGER NULL **with a one-time backfill** — schema.ts's own rule
  // for that case is 「a column that needs a different default is not additive —
  // it needs its own guarded step, written out in reconcileSchema」. This is
  // that step.
  //
  // 🔴 THE BACKFILL IS INSIDE THE COLUMN-WAS-MISSING GUARD, and that placement
  // is the whole design: it runs exactly once per database (the boot that
  // forward-ports the column), so a row registered AFTER the migration — which
  // is NULL by the CREATE/ALTER default — is never stamped by a later reboot's
  // reconcile pass. Grandfathering is for accounts that PREDATE the gate; the
  // DDL comment in schema.ts carries the argument (the stamp answers "does the
  // gate let them through or not", never "when was it verified", and without it every existing user including
  // the owner would be locked behind a mail channel production has not
  // configured). On a FRESH database the CREATE already made the column, the
  // guard sees it present, and no backfill runs — a fresh saas deployment's
  // first registrations correctly start unverified.
  //
  // Date.now() rather than an injected clock: reconcileSchema has no override
  // seam and needs none — the stamp's only consumer is a NULL/non-NULL verdict
  // (auth/email-verification.ts 「isEmailVerified」), so its exact value is
  // documentary, not load-bearing.
  {
    const usersCols = tableColumns(db, 'users');
    if (!usersCols.has('email_verified_at')) {
      db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
      db.prepare('UPDATE users SET email_verified_at = ?').run(Date.now());
    }
  }
  // ── A2-3 (2026-08-12): users.restricted_at, guarded ADD COLUMN, NO BACKFILL ─
  //
  // The SECOND hand-written users-column step, and it deliberately does NOT
  // look like the first one. It is not in ADDITIVE_INT_COLUMNS for the same
  // reason `email_verified_at` is not — that loop emits `INTEGER NOT NULL
  // DEFAULT 0`, and 0 is a legal ms-epoch, so every pre-existing account would
  // forward-port as「restricted since 1970-01-01」.
  //
  // 🔴 THERE IS NO `UPDATE` LINE HERE, AND ITS ABSENCE IS THE WHOLE STEP.
  // The block above stamps every legacy row on purpose (without it the gate
  // would lock out every existing user, owner included). This column's NULL
  // means the opposite: writing ANY non-NULL value here would restrict every
  // account on the platform in one migration. The two steps are adjacent, look
  // alike, and must never be made uniform — which is why this paragraph is
  // here rather than 「same as above」.
  //
  // Idempotent by the same guard: on a fresh DB the CREATE already made the
  // column, so no ALTER runs; on a re-run the column is present and this is a
  // no-op. `test/migration-idempotency.test.ts` drives both shapes and asserts
  // they converge on the same PRAGMA table_info.
  {
    const usersCols = tableColumns(db, 'users');
    if (!usersCols.has('restricted_at')) {
      db.exec('ALTER TABLE users ADD COLUMN restricted_at INTEGER');
    }
  }
  // ── LOGIN-1 (2026-08-19): users.last_login_at ──────────────────────────────
  //
  // The THIRD hand-written `users` column step, and it is hand-written for the
  // reason the two above are: `ADDITIVE_INT_COLUMNS` emits `INTEGER NOT NULL
  // DEFAULT 0`, and 0 is a legal ms-epoch, so every account that predates this
  // column would forward-port as「last signed in 1970-01-01」— a fabricated
  // sentence about a person, on the screen where an operator decides whether to
  // restrict them.
  //
  // 🔴 THERE IS NO `UPDATE` LINE HERE, AND ITS ABSENCE IS THE WHOLE STEP — the
  // third time this file says that, and the third DIFFERENT reason:
  //   · `email_verified_at` HAD to backfill (without it the gate locks every
  //     existing account out, owner included);
  //   · `restricted_at` MUST NOT (any non-NULL value restricts the platform);
  //   · this one must not because THE ANSWER IS NOT KNOWABLE. Nothing on disk
  //     records when anyone last signed in — that is the premise of the card —
  //     so every candidate stamp (`created_at`, a device's `last_seen_at`, the
  //     migration timestamp) would be a value invented here and read downstream
  //     as an observation. NULL is the only honest content, and the ops
  //     projection renders it as "nothing recorded yet" rather than as a date.
  // Three adjacent steps that look alike and must never be made uniform.
  //
  // Idempotent by the same guard as its neighbours: on a fresh DB the CREATE
  // already made the column, so no ALTER runs; on a re-run the column is present
  // and this is a no-op. test/migration-idempotency.test.ts drives both shapes.
  //
  // ⚠️ THE MIGRATION IS UNCONDITIONAL — it does NOT consult
  // `FLOWMIC_LOGIN_RECORD_ENABLED`. A schema that appears only when a switch is
  // on is a schema that differs between two machines running the same build, and
  // flipping the switch would then become a migration. The switch gates the
  // WRITE (auth/auth-service.ts `recordSignIn`), same division as
  // `FLOWMIC_USAGE_EVENTS_ENABLED`: table always, rows never until owner says so.
  {
    const usersLoginCols = tableColumns(db, 'users');
    if (!usersLoginCols.has('last_login_at')) {
      db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
    }
  }
  // ── A2-5 (2026-08-12): usage_events.{transcript_chars,delivered_chars} ─────
  //
  // The THIRD hand-written step, and it is here rather than in
  // ADDITIVE_INT_COLUMNS for that table's own stated rule: the loop emits
  // `INTEGER NOT NULL DEFAULT 0`, and 0 is a CLAIM here — 「we counted, it was
  // zero」 — about rows nobody ever counted. NULL is the only value that asserts
  // nothing, and the DDL (db/schema.ts `-- 14. usage_events`) argues at length
  // why these two columns are the one pair in this table that must be nullable.
  //
  // 🔴 NO BACKFILL, and unlike `restricted_at` above the reason is not danger —
  // it is arithmetic. A row written before these columns existed has a real
  // `stt_ms` and an unmeasured character count; stamping it 0 would put a
  // "0 chars / 40 seconds" line on a user's own usage page, which reads as a defect in
  // the product rather than as a gap in the record.
  // ⚠️ In practice there are no such rows on any deployment today: collection is
  // behind `FLOWMIC_USAGE_EVENTS_ENABLED`, which defaults OFF. That fact is a
  // convenience, NOT the argument — a migration that is only correct because a
  // switch happens to be off is a migration that becomes wrong the day it is
  // flipped.
  //
  // Idempotent by the same guard as the two steps above: on a fresh DB the
  // CREATE already made both columns, so no ALTER runs.
  //
  // ── 2026-08-17: usage_events.refused_user_id, in this SAME block ────────────
  //
  // 🔴 IT IS A NULLABLE TEXT COLUMN WITH NO DEFAULT — exactly what the
  // `ADDITIVE_TEXT_COLUMNS` loop emits — SO WHY IS IT NOT IN THAT LOOP. Because
  // that loop runs ~100 lines ABOVE this block, and on a database that predates
  // BOTH rounds it would append this column BEFORE the two character counts,
  // while a fresh `CREATE` appends it AFTER them. The two shapes would then
  // differ in column ORDER, and "the forward-ported usage_events is
  // INDISTINGUISHABLE from a fresh one" (test/migration-idempotency.test.ts)
  // compares `PRAGMA table_info` element by element. Keeping every ALTER for
  // this table in one block, in DDL order, is what makes that convergence hold
  // for every legacy shape rather than only for the ones a test happens to
  // build today.
  //
  // 🔴 NO BACKFILL, and here the reason is neither danger nor arithmetic — it is
  // that the answer is not knowable. Only the refusal path knows WHICH account's
  // quota threw; stamping legacy rows with their own `user_id` would manufacture
  // exactly the claim this column exists to stop manufacturing ("A hit A's
  // ceiling"), on the rows least able to defend themselves. NULL says "nobody
  // recorded it", which is the truth.
  {
    const usageEventCols = tableColumns(db, 'usage_events');
    if (!usageEventCols.has('transcript_chars')) {
      db.exec('ALTER TABLE usage_events ADD COLUMN transcript_chars INTEGER');
    }
    if (!usageEventCols.has('delivered_chars')) {
      db.exec('ALTER TABLE usage_events ADD COLUMN delivered_chars INTEGER');
    }
    // No `REFERENCES users(id)`: a second cascade into this table would let one
    // account's deletion erase another account's usage rows (schema.ts argues it
    // at the DDL). The cascade census pins the FK count at one.
    if (!usageEventCols.has('refused_user_id')) {
      db.exec('ALTER TABLE usage_events ADD COLUMN refused_user_id TEXT');
    }
  }
  // v0.2.4 machine-level identity lookups. Created AFTER the ALTER loop above —
  // on a pre-0.2.4 DB the columns do not exist until that loop has run, and an
  // index on a missing column is a hard error, not a skipped step.
  //
  // Plain indexes, NOT unique: see ADDITIVE_TEXT_COLUMNS for why two rows may
  // legitimately share one uid on a database that predates this.
  db.exec('CREATE INDEX IF NOT EXISTS idx_pc_devices_machine ON pc_devices(user_id, machine_uid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mobile_pairings_uid ON mobile_pairings(pc_device_id, device_uid)');
  // 0.2.66 PCID addressing. Created here for the same reason as the two above —
  // on a pre-0.2.66 DB the column does not exist until the ALTER loop has run.
  //
  // 🔴 UNIQUE, and PARTIAL on `pcid IS NOT NULL`, and both halves are load-bearing:
  //   · unique, because a PCID is the ONLY addressing a cloud pairing has (04
  //     §3.1). Two rows sharing one would make 「which PC」 have two answers, which
  //     is the defect shape this whole feature exists to remove — and the guard
  //     belongs in the database, because the minting loop's alternative (SELECT
  //     then INSERT) is a check-then-act race with nothing holding a lock;
  //   · partial, because every row that predates this column is NULL and SQLite
  //     treats NULLs as distinct in a plain unique index anyway — spelling the
  //     predicate out states the intent and keeps the index off those rows, so
  //     the migration cannot fail on a populated legacy database.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_devices_pcid ON pc_devices(pcid) WHERE pcid IS NOT NULL');
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSyncCtor(dbPath, { enableForeignKeyConstraints: true });
  try {
    db.exec(INIT_SQL);
    reconcileSchema(db);
  } catch (err) {
    db.close();
    throw new Error(`FlowMic DB migration failed: ${(err as Error).message}`);
  }
  return db;
}

export function createDbConnection(opts: { dbPath: string; encryptionKey: Buffer }): DbConnection {
  const db = openDatabase(opts.dbPath);
  return {
    raw: db,
    users: makeUserRepo(db),
    pcs: makePcRepo(db),
    mobiles: makeMobileRepo(db),
    settings: makeSettingsRepo(db, opts.encryptionKey),
    usage: makeUsageRepo(db),
    usageEvents: makeUsageEventsRepo(db),
    siteCounts: makeSiteCountsRepo(db),
    timeline: makeTimelineRepo(db),
    timelineKeymeta: makeTimelineKeymetaRepo(db),
    timelineGrants: makeTimelineGrantsRepo(db),
    emailVerification: makeEmailVerificationRepo(db),
    billing: makeBillingRepo(db),
    opsAudit: makeOpsAuditRepo(db),
    close(): void {
      db.close();
    },
  };
}

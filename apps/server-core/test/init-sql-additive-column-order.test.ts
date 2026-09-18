// THE STANDING SAME-SHAPE SCAN behind NR-33: no statement in `INIT_SQL` may
// reference a column that only arrives later, through `reconcileSchema()`'s
// guarded `ALTER TABLE … ADD COLUMN` steps.
//
// ── THE RULE, AND WHY IT IS A RULE AND NOT A STYLE ───────────────────────────
// `openDatabase` runs `INIT_SQL` first and `reconcileSchema` second
// (db/connection.ts). On a FRESH database that ordering is invisible: every
// `CREATE TABLE` runs with every column in it, so anything INIT_SQL says about
// any column is true. On an ALREADY-DEPLOYED database it is the only thing that
// matters: `CREATE TABLE IF NOT EXISTS` is skipped, the additive column does not
// exist yet, and an index/view/trigger over it is a hard error — `no such
// column: <name>` — which `openDatabase` rethrows as `FlowMic DB migration
// failed: …` and the process cannot boot.
//
// That is exactly what happened on 2026-09-10: `TRIAL_SQL` carried
// `CREATE UNIQUE INDEX … ON trial_ledger(device_uid)`, the JP replica
// crash-looped ten times and the deploy auto-rolled back (r-20260910-123458).
// Fixed in 5b83dcef by deleting the INIT_SQL copy and leaving the
// reconcile-path copy as the single owner.
//
// 🔴 `IF NOT EXISTS` DOES NOT HELP, and the reason is worth keeping in one
// sentence because it is the intuition that lets this defect through: the index
// really does not exist. Neither does the column.
//
// ── WHY A SCAN AND NOT A COMMENT ─────────────────────────────────────────────
// The sweep that followed the 2026-09-10 fix was run once, by hand, and found
// exactly one hit — the one already known. Nothing was left behind that would
// find the SECOND one. The rule was written into three comment blocks
// (db/schema-trial.ts, db/schema-additive-columns.ts, db/connection.ts), and a
// comment cannot fail. This file is that sweep turned into a gate, so the next
// additive column that gets an index beside its `CREATE TABLE` is caught on the
// machine that wrote it rather than on the node that boots it.
//
// ── COVERAGE: WHAT THIS SCAN LOOKS AT, AND WHAT IT DOES NOT ──────────────────
// LOOKS AT — every object `INIT_SQL` creates, discovered by EXECUTING it against
// an empty database and reading `sqlite_master`, rather than by pattern-matching
// the source text. That is deliberate: INIT_SQL is assembled from eight modules
// by template interpolation (db/schema.ts), so a source-text scan would have to
// re-implement that assembly, and a module added tomorrow without being added to
// the scan's file list would be invisible. Executing it cannot miss a statement
// that runs.
// Object types covered: `index`, `view`, `trigger` — everything in SQLite that
// can name a column outside a `CREATE TABLE`. (Measured below: this repository
// currently has no views and no triggers at all. The scan does not assume that.)
// COLUMNS TREATED AS "ARRIVES LATER" — the union of `ADDITIVE_TEXT_COLUMNS`,
// `ADDITIVE_INT_COLUMNS` (both the loop's registry) and every hand-written
// `ALTER TABLE <t> ADD COLUMN <c>` parsed out of db/connection.ts, because four
// columns needed a default the loop cannot emit and so ride their own guarded
// steps.
// DOES NOT LOOK AT — statements inside `reconcileSchema` itself (that is where
// these objects are SUPPOSED to live), the desktop's sidecar copy of anything,
// or any SQL built at runtime by a repo. It answers one question only.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADDITIVE_INT_COLUMNS, ADDITIVE_TEXT_COLUMNS, INIT_SQL } from '../src/db/schema';

const CONNECTION_TS = join(__dirname, '..', 'src', 'db', 'connection.ts');

/** Every `ALTER TABLE <t> ADD COLUMN <c>` written out by hand in
 *  `reconcileSchema`. Read from the source rather than listed here: a list here
 *  would be a second registry, and the one thing worse than no scan is a scan
 *  that silently stops covering the columns nobody remembered to add to it. */
function handWrittenAddColumns(): Map<string, Set<string>> {
  const src = readFileSync(CONNECTION_TS, 'utf8');
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
    const table = m[1] as string;
    const column = m[2] as string;
    if (!out.has(table)) out.set(table, new Set());
    out.get(table)!.add(column);
  }
  return out;
}

/** table → the columns that a deployed database may not have yet. */
function columnsThatArriveLater(): Map<string, Set<string>> {
  const out = handWrittenAddColumns();
  for (const registry of [ADDITIVE_TEXT_COLUMNS, ADDITIVE_INT_COLUMNS]) {
    for (const [table, columns] of Object.entries(registry)) {
      if (!out.has(table)) out.set(table, new Set());
      for (const c of columns) out.get(table)!.add(c);
    }
  }
  return out;
}

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** The index/view/trigger objects `INIT_SQL` alone creates. */
function objectsCreatedByInitSql(): SchemaObject[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(INIT_SQL);
    return db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as unknown as SchemaObject[];
  } finally {
    db.close();
  }
}

/** The whole judgement, in one place so the positive control below can drive it
 *  with a statement this repository does not contain.
 *
 *  The object's own SQL text is searched, not just `PRAGMA index_info`: a
 *  PARTIAL index's `WHERE` clause can name a column that is not in the index's
 *  key at all (`idx_pc_devices_web_room_owner` is `ON pc_devices(user_id) WHERE
 *  room_kind='web'`, and `room_kind` is additive), and index_info would not
 *  report it. A word-boundary match over the statement catches both halves. */
function offendingColumns(object: SchemaObject, later: Map<string, Set<string>>): string[] {
  const candidates = later.get(object.tbl_name);
  if (!candidates || !object.sql) return [];
  return [...candidates].filter((c) => new RegExp(`\\b${c}\\b`).test(object.sql!));
}

describe('INIT_SQL never references a column that arrives through the ALTER loop', () => {
  it('is not scanning an empty world (coverage, printed rather than assumed)', () => {
    const objects = objectsCreatedByInitSql();
    const later = columnsThatArriveLater();
    const laterCount = [...later.values()].reduce((n, s) => n + s.size, 0);

    // A scan over nothing is green for the wrong reason. These two numbers are
    // the scan's own controls: if either collapses, the test below stops
    // proving anything and this one says so first.
    expect(objects.length).toBeGreaterThan(10);
    expect(laterCount).toBeGreaterThan(10);
    expect(later.size).toBeGreaterThan(3);

    // Measured 2026-09-15: 19 objects, all of them indexes. Asserted as a
    // FLOOR and a type census rather than an exact count, so adding a table
    // does not make this red, but adding the repository's first view or
    // trigger does — at which point whoever adds it has to think about this
    // rule, which is the entire point.
    const types = new Set(objects.map((o) => o.type));
    expect([...types].sort()).toEqual(['index']);

    // eslint-disable-next-line no-console
    console.log(
      `[init-sql-additive-scan] ${objects.length} object(s) created by INIT_SQL; ` +
        `${laterCount} column(s) across ${later.size} table(s) arrive through reconcileSchema`,
    );
  });

  it('flags a statement that breaks the rule (positive control)', () => {
    // 🔴 THE SCAN'S PROOF THAT IT CAN SEE. This is the 2026-09-10 statement,
    // verbatim, fed to the same predicate the real test uses. Without this, a
    // predicate that always returned [] would be green for ever and would look
    // exactly like a healthy schema.
    const later = columnsThatArriveLater();
    const reconstructed: SchemaObject = {
      type: 'index',
      name: 'idx_trial_ledger_device',
      tbl_name: 'trial_ledger',
      sql: 'CREATE UNIQUE INDEX idx_trial_ledger_device ON trial_ledger(device_uid) WHERE device_uid IS NOT NULL',
    };
    expect(offendingColumns(reconstructed, later)).toEqual(['device_uid']);

    // And the partial-predicate half, which `PRAGMA index_info` cannot see.
    const partialOnly: SchemaObject = {
      type: 'index',
      name: 'idx_pc_devices_web_room_owner',
      tbl_name: 'pc_devices',
      sql: "CREATE UNIQUE INDEX idx_pc_devices_web_room_owner ON pc_devices(user_id) WHERE room_kind='web'",
    };
    expect(offendingColumns(partialOnly, later)).toEqual(['room_kind']);
  });

  it('finds no such statement in INIT_SQL', () => {
    const later = columnsThatArriveLater();
    const offenders = objectsCreatedByInitSql()
      .map((o) => ({ object: o, columns: offendingColumns(o, later) }))
      .filter((r) => r.columns.length > 0);

    expect(
      offenders.map(
        (r) =>
          `${r.object.type} ${r.object.name} on ${r.object.tbl_name} references ${r.columns.join(', ')}, ` +
          'which reconcileSchema adds AFTER INIT_SQL runs — move it into reconcileSchema, after the ALTER loop',
      ),
    ).toEqual([]);
  });
});

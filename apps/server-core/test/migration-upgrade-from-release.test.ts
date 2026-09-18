// THE MISSING GATE (card A / NR-33): open the CURRENT schema over a PREVIOUS
// RELEASE's DDL, taken out of that release's own commit.
//
// ── THE GAP THIS FILLS ───────────────────────────────────────────────────────
// On 2026-09-10 a deploy crash-looped the Japan replica ten times and
// auto-rolled back (r-20260910-123458). `TRIAL_SQL` had put a partial unique
// index over `trial_ledger(device_uid)` inside `INIT_SQL`, which runs on every
// boot BEFORE `reconcileSchema()` adds that column; a brand-new database was
// fine and every already-deployed node answered `no such column: device_uid`.
//
// 🔴 EVERY GATE WAS GREEN, AND THAT IS THE ACTUAL DEFECT. Goldens, unit tests
// and the whole migration-idempotency suite START FROM AN EMPTY DATABASE. Not
// one of them started from a previous version's DDL, so not one of them was ever
// on the path production is on. The only gate that sat on the upgrade path was
// the deploy script's health check — and that one fires in production, on real
// users, after the artefacts have shipped.
//
// ── WHY THE STARTING POINT IS READ OUT OF GIT AND NOT TYPED HERE ─────────────
// The suite already had two legacy fixtures (`LEGACY_USERS_PRE_D1`,
// `LEGACY_TRIAL_LEDGER_PRE_R1B`) and both are hand-transcribed. They are useful
// and they remain — but a hand-written "roughly the old table" is an ASSERTION
// about what shipped, not a reading of it, and nothing makes it go red when it
// drifts from what really shipped. The baselines below are rendered from the
// release bump commits themselves by `scripts/db-legacy-ddl.mjs`, and
// `scripts/db-legacy-ddl.test.mjs` re-renders them from git on every
// `verify:scripts` run and fails if the committed `.sql` has drifted by one
// byte. This file can therefore run anywhere, with no git and no network, while
// the claim "this is what 0.3.79 really created" stays machine-checked.
//
// Why commits and not tags: this repository has no tags at all.
//
// ── WHAT EACH BASELINE BUYS ──────────────────────────────────────────────────
// 0.3.77 — predates `trial_ledger` entirely, and predates the split of
//   `schema-additive-columns.ts` / `schema-ops.ts` / `schema-trial.ts` out of
//   `schema.ts`. It exercises TABLE arrival: several tables simply are not
//   there, and `CREATE TABLE IF NOT EXISTS` creates them complete. That half has
//   always worked; it is here so that a regression in it would be seen.
// 0.3.79 — the last release before R-1b added `trial_ledger.device_uid`. It
//   exercises COLUMN arrival on a table that ALREADY EXISTS, which is the half
//   that took production down, because there `CREATE TABLE IF NOT EXISTS` is
//   skipped and the column arrives only from the ALTER loop afterwards.
//
// 🔴 REVERSE CONTROL, ACTUALLY RUN (2026-09-15, lane/a-nr33-upgrade-gate): with
// the 2026-09-10 statement put back into `TRIAL_SQL`, the 0.3.79 case fails here
// with the production wording —
//   FlowMic DB migration failed: no such column: device_uid
// — while the 0.3.77 case, the fresh-database cases elsewhere in the suite and
// `pnpm verify:lane` all stay green. That asymmetry IS the defect's shape: it
// lives only on the upgrade path, and until this file existed nothing in the
// repository walked it.
//
// ── ONE THING THIS FILE DELIBERATELY DOES NOT ASSERT: COLUMN ORDER ───────────
// MEASURED 2026-09-15 on both baselines: the column SET converges everywhere,
// the column ORDER does not — `users`, `pc_devices`, `mobile_pairings` (from
// 0.3.77) and `trial_ledger`, `mobile_pairings` (from 0.3.79) each end up with
// the right columns in a different order from a fresh database, because a fresh
// database gets them from one `CREATE TABLE` while an upgraded one grows them by
// `ALTER` in reconcile order.
// That is NOT a new discovery and NOT a defect today: `node/replica-puller.ts`
// says so itself (grep anchors `NR-22-PROJECT-BY-NAME`, `NR-22-ORDER-CHECK`) and
// projects the cross-node copy by column NAME precisely so that a positional
// mismatch is safe. Asserting order here would therefore pin a divergence that
// is allowed, and would go red for a change that is correct. What is asserted is
// the guarantee that IS load-bearing: same tables, same columns, same declared
// types, same indexes.

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM tool, no types; see scripts/db-legacy-ddl.mjs
import { BASELINES, fixturePathFor, renderInitSql } from '../../../scripts/db-legacy-ddl.mjs';

interface Baseline {
  version: string;
  ref: string;
  why: string;
}

const REPO_ROOT = join(__dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'flowmic-upgrade-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; type: string }[])
    .map((c) => `${c.name}:${c.type}`)
    .sort();
}

function masterNames(db: DatabaseSync, type: 'table' | 'index'): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as unknown as { name: string }[]
  ).map((r) => r.name);
}

/** A database in exactly the state the named release created. */
function databaseAtRelease(baseline: Baseline): string {
  const ddl = readFileSync(join(REPO_ROOT, fixturePathFor(baseline)), 'utf8');
  const dbPath = join(tmp, `${baseline.version}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(ddl);
  db.close();
  return dbPath;
}

describe('the current schema opens over a previous release s schema', () => {
  it('the renderer that produced the baselines still reads this repo correctly', () => {
    // 🔴 THE ONE CHECK THAT CANNOT BE MADE AGAINST HISTORY. `db-legacy-ddl.mjs`
    // reads the schema modules as text; no historical ref can tell us whether it
    // read them RIGHT. The present can: render the WORKING TREE's own modules
    // through the same function and compare against the `INIT_SQL` server-core
    // actually imports. If the reader ever stops being faithful — a new module,
    // an interpolation it cannot resolve, a literal it mis-terminates — this
    // goes red here, on today's schema, rather than silently producing a
    // shorter baseline than some release really had.
    const dbDir = join(REPO_ROOT, 'apps', 'server-core', 'src', 'db');
    const sources = new Map<string, string>();
    for (const name of [
      'schema.ts',
      'schema-additive-columns.ts',
      'schema-billing.ts',
      'schema-integrator.ts',
      'schema-ops.ts',
      'schema-recovery.ts',
      'schema-site.ts',
      'schema-trial.ts',
    ]) {
      sources.set(name, readFileSync(join(dbDir, name), 'utf8'));
    }
    expect(renderInitSql(sources)).toBe(INIT_SQL);
  });

  for (const baseline of BASELINES as Baseline[]) {
    describe(`${baseline.version} (${baseline.ref}) — ${baseline.why}`, () => {
      it('boots, and converges on the shape a fresh database has', () => {
        const dbPath = databaseAtRelease(baseline);

        // The premise, asserted rather than assumed: this really is an OLD
        // database. A fixture that had quietly become the current schema would
        // make every assertion below pass for the wrong reason.
        const before = new DatabaseSync(dbPath);
        const beforeTables = masterNames(before, 'table');
        before.close();

        // ── the upgrade: exactly what a deploy + restart runs ──
        // 🔴 THIS LINE IS THE REGRESSION GUARD. An INIT_SQL statement over a
        // column that arrives later throws here, before any assertion below is
        // reached, with `FlowMic DB migration failed: no such column: …`.
        const upgraded = openDatabase(dbPath);
        const fresh = openDatabase(':memory:');

        expect(masterNames(upgraded, 'table')).toEqual(masterNames(fresh, 'table'));
        expect(beforeTables.length).toBeLessThanOrEqual(masterNames(upgraded, 'table').length);

        for (const table of masterNames(fresh, 'table')) {
          expect(columns(upgraded, table), `columns of ${table} after upgrading from ${baseline.version}`).toEqual(
            columns(fresh, table),
          );
        }
        expect(masterNames(upgraded, 'index')).toEqual(masterNames(fresh, 'index'));

        // ── idempotent, replayable, non-destructive ──
        // Re-running the whole migration changes nothing and throws nothing,
        // which is what makes a redeploy and a crash-loop restart safe.
        const settled = masterNames(upgraded, 'index').join(',');
        upgraded.exec(INIT_SQL);
        reconcileSchema(upgraded);
        reconcileSchema(upgraded);
        expect(masterNames(upgraded, 'index').join(',')).toBe(settled);
        upgraded.close();
        fresh.close();

        // …and a genuine restart on a fresh connection is likewise inert.
        const restarted = openDatabase(dbPath);
        expect(masterNames(restarted, 'index').join(',')).toBe(settled);
        restarted.close();
      });

      it('carries existing rows through rather than rebuilding the table', () => {
        // Non-destructive is half of "idempotent, replayable and
        // non-destructive", and it is the half a schema-shape assertion cannot
        // see: a migration that DROPped and recreated every table would satisfy
        // every convergence check above and lose every account on the node.
        const dbPath = join(tmp, `${baseline.version}-rows.db`);
        const seed = new DatabaseSync(dbPath);
        seed.exec(readFileSync(join(REPO_ROOT, fixturePathFor(baseline)), 'utf8'));
        seed.exec(
          "INSERT INTO users (id, display_name, plan) VALUES ('u-before-upgrade', 'Before the upgrade', 'free')",
        );
        seed.close();

        const upgraded = openDatabase(dbPath);
        expect(
          upgraded.prepare("SELECT display_name, plan FROM users WHERE id='u-before-upgrade'").get(),
        ).toMatchObject({ display_name: 'Before the upgrade', plan: 'free' });
        upgraded.close();
      });
    });
  }
});

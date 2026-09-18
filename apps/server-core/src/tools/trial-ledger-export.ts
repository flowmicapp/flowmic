// SPEC-REF:
//   docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//     (「打开开关之前先把现有全部 trial_ledger 行导出一份快照」 — this tool is
//     that step, and it is also how the archive is read back afterwards)
//   apps/server-core/src/db/schema-trial.ts (the two archives' columns)
//   apps/server-core/src/db/schema.ts table 6 (`usage_records`)
//
// ⚠️ THE FILE NAME IS NARROWER THAN THE TOOL. It started as the trial-ledger
// snapshot and now also carries the meter and the meter's archive (owner
// 2026-09-17, second half). Not renamed on purpose: the name is referenced by
// the build target, .gitignore, verify/lint/file-size.mjs and the deployment
// runbook, and a rename that misses one of those is worse than a name that is
// merely modest. `TABLES` below is the list that answers what it exports.
//   apps/server-core/src/tools/provenance-dryrun.ts (the read-only-tool
//     precedent this file follows: its own sqlite open, never db/connection.ts)
//
// READ-ONLY. It writes exactly one file — the JSONL you name — and touches the
// database with nothing but SELECTs.
//
// ── 🔴 WHY IT DOES NOT USE db/connection.ts ────────────────────────────────
// `openDatabase()` is the repo's only open path and it MIGRATES: INIT_SQL plus
// `reconcileSchema()`, which executes DROP/ALTER/CREATE INDEX. Running that
// against production to take a snapshot would be doing the one thing a snapshot
// is taken to avoid. The connection here is opened `readOnly: true` directly.
// (That still creates a `-shm`/`-wal` pair beside the file if none exists —
// SQLite building its wal-index, not a content change — so the DIRECTORY has to
// be writable. Stated because "read-only" would otherwise be read as a promise
// about the directory, which it is not.)
//
// ── WHAT IT REDACTS, AND WHY THAT IS NOT A HOLE IN THE DATA ────────────────
// 🔴 `anon_token` is a BEARER CREDENTIAL. In `trial_ledger` it is live: a file
// carrying it is a file carrying working credentials off the machine, and this
// output is meant to be copied to a laptop. So every token is replaced by
// `anon_token_present: true|false` and the value never leaves. Nothing is lost
// for analysis — the token answers 「which browser is holding this row」, which
// `device_uid` already answers, and it is the only column in either table that
// is a secret rather than a fact.
// Everything else is copied verbatim: `ip_bucket` is already a salted hash of a
// /32 or /64 and never an address (billing/trial-ip-bucket.ts), and neither
// table has ever held a transcript, an utterance or an email.

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// esbuild does not know the `node:sqlite` builtin and rewrites the specifier to
// a bare `sqlite` at bundle time — the same trap db/connection.ts documents. A
// runtime require through a non-static specifier is the workaround it uses too.
const nodeRequire = createRequire(import.meta.url);
const SQLITE_SPECIFIER = 'node:sqlite';

type DbCtor = new (path: string, opts?: { readOnly?: boolean }) => DatabaseSync;

const USAGE =
  'usage: node trial-ledger-export.mjs <path-to-db> --out <file.jsonl> [--force]';

/** The four tables this tool knows: the two live ones and the two the sweep
 *  copies them into. Either archive is absent on a deployment that predates
 *  owner's 2026-09-17 ruling — that is a legal state (it is exactly the state
 *  the FIRST snapshot is taken in), reported as a counted line rather than an
 *  error.
 *
 *  🔴 `usage_records` IS EXPORTED WHOLE, not filtered to anonymous identities,
 *  and that is a decision worth stating: filtering would need a JOIN to `users`
 *  and would silently drop rows whose `users` row is already gone — the exact
 *  rows a snapshot taken to study a destructive sweep is for. Four numbers, a
 *  month and a user id; no transcript, no address, no email. */
const TABLES = [
  'trial_ledger', 'trial_ledger_archive', 'usage_records', 'usage_records_archive',
] as const;

/** Rows per SELECT. Bounded so a large table is not materialised whole, and
 *  paged by `rowid` rather than OFFSET: OFFSET re-walks the rows it skipped. */
const PAGE = 500;

const out = (s: string): void => void process.stdout.write(`${s}\n`);

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name?: unknown } | undefined;
  return typeof row?.name === 'string';
}

/**
 * One row, as it will be written.
 *
 * `SELECT *` is used to read it, and here that is safe for the reason NR-22's
 * refusal rule exists to defend: `node:sqlite` returns each row as an object
 * KEYED BY COLUMN NAME, so nothing about this depends on column ORDER. (The
 * copy that NR-22 is about is `INSERT … SELECT *` BETWEEN two tables, where the
 * mapping IS positional. This tool never writes to the database at all.)
 */
function redact(row: Record<string, unknown>): Record<string, unknown> {
  // 🔴 KEYED ON THE COLUMN BEING THERE, not on the table name. `usage_records`
  // and its archive have no token column, and stamping them
  // `anon_token_present: false` would be this repo's #1 shape in miniature: one
  // field answering both 「this row's token is gone」 and 「this kind of row never
  // had one」.
  if (!('anon_token' in row)) return row;
  const { anon_token: token, ...rest } = row;
  return { ...rest, anon_token_present: typeof token === 'string' && token !== '' };
}

function exportTable(db: DatabaseSync, table: string, file: string): number {
  // `rowid` is spelled out in the projection because `SELECT *` does not include
  // it, and it is what the paging walks.
  const page = db.prepare(
    `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let after = 0;
  let written = 0;
  for (;;) {
    const rows = page.all(after, PAGE) as unknown as Record<string, unknown>[];
    if (rows.length === 0) break;
    const lines: string[] = [];
    for (const row of rows) {
      const { _rowid: rowid, ...rest } = row;
      after = Number(rowid);
      lines.push(JSON.stringify({ table, row: redact(rest) }));
    }
    appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    written += rows.length;
    if (rows.length < PAGE) break;
  }
  return written;
}

function run(dbPath: string, file: string, force: boolean): number {
  if (existsSync(file) && !force) {
    out(`refusing to overwrite an existing snapshot: ${file}`);
    out('pass --force if replacing it is what you mean.');
    return 2;
  }
  // Claim the path before opening the database, so a run that cannot write its
  // output fails before it has read anything.
  writeFileSync(file, '', 'utf8');

  const { DatabaseSync: Ctor } = nodeRequire(SQLITE_SPECIFIER) as { DatabaseSync: DbCtor };
  const db = new Ctor(dbPath, { readOnly: true });
  try {
    let total = 0;
    for (const table of TABLES) {
      if (!tableExists(db, table)) {
        // NOT an error, and named rather than silent: 「the archive is empty」 and
        // 「this build has no archive」 are different facts and the operator
        // reading this line is deciding whether the switch has been thrown yet.
        out(`${table}: table not present in this database (0 rows)`);
        continue;
      }
      const n = exportTable(db, table, file);
      total += n;
      out(`${table}: ${n} row(s)`);
    }
    out(`wrote ${total} line(s) to ${file}`);
    out('anon_token values are NOT in this file — trial rows carry anon_token_present instead.');
    return 0;
  } finally {
    db.close();
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const dbPath = argv[0];
  const outIdx = argv.indexOf('--out');
  const file = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const force = argv.includes('--force');
  if (
    dbPath === undefined || dbPath === '-h' || dbPath === '--help' ||
    dbPath.startsWith('--') || file === undefined || file.startsWith('--')
  ) {
    out(USAGE);
    return argv.length === 0 || dbPath === '-h' || dbPath === '--help' ? 0 : 2;
  }
  if (!existsSync(dbPath)) {
    out(`${USAGE}\nno such file: ${dbPath}`);
    return 2;
  }
  try {
    return run(dbPath, file, force);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such built-in module') || msg.includes('ERR_UNKNOWN_BUILTIN_MODULE')) {
      out('node:sqlite is not available unflagged on this runtime (it landed in v22.13.0 / v23.4.0).');
      out(`re-run as:  node --experimental-sqlite ${process.argv[1]} ${dbPath} --out ${file}`);
      return 4;
    }
    // Safe to print: every throw reaching here comes from this file, the sqlite
    // open, or the filesystem — never from row content (nothing here parses a
    // row, and JSON.stringify does not quote input in its errors).
    out(`FAILED: ${msg}`);
    return 4;
  }
}

process.exit(main());

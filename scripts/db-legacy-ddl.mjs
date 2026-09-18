// Render `INIT_SQL` AS IT STOOD AT A GIT REF, so the upgrade gate's starting
// point is a previous release's DDL rather than a hand-typed approximation of
// it.
//
// ── WHY THIS EXISTS (card A / NR-33, ledger §20) ──────────────────────────────
// On 2026-09-10 a deploy crash-looped the JP replica ten times and auto-rolled
// back (`r-20260910-123458`): `TRIAL_SQL` carried a partial unique index over
// `trial_ledger(device_uid)` inside INIT_SQL, which runs on EVERY boot BEFORE
// `reconcileSchema()`'s guarded ADD COLUMN loop, so on every already-deployed
// node the index ran against a table that did not have the column yet and
// SQLite answered `no such column: device_uid`.
//
// 🔴 EVERY GATE WAS GREEN, and the reason is structural rather than an
// oversight: goldens, unit tests and the migration-idempotency suite ALL START
// FROM AN EMPTY DATABASE. Not one of them started from the previous version's
// DDL, so not one of them was ever on the path production is on. The only gate
// that sat on the upgrade path was the deploy script's health check, and that
// one fires in production.
//
// ── WHY IT READS GIT AND NOT THE WORKING TREE ────────────────────────────────
// The migration suite already contains two legacy fixtures typed out by hand
// (`LEGACY_USERS_PRE_D1`, `LEGACY_TRIAL_LEDGER_PRE_R1B`). They are useful, and
// they are also an assertion about what shipped rather than a reading of it: a
// hand-written "roughly the old table" proves nothing about the databases that
// are actually out there, and nothing makes it go red when it drifts from what
// really shipped. What this module produces is read out of the release commit
// itself, and `scripts/db-legacy-ddl.test.mjs` re-reads it on every
// `verify:scripts` run and fails if the committed fixture has drifted by one
// byte.
//
// ── HOW IT RENDERS TS WITHOUT RUNNING TS ─────────────────────────────────────
// The schema modules are, deliberately, nothing but SQL inside template
// literals: `const X_SQL = /* sql */ \`…\`` plus `${OTHER_SQL}` interpolations
// of their siblings. There are no runtime imports to resolve and no expressions
// to evaluate, so a ~50-line reader is enough and this file stays free of a
// TypeScript loader, of esbuild, and of a checkout of the old tree.
//
// 🔴 THE ONE ASSUMPTION IS ALREADY ENFORCED ELSEWHERE: a backtick may not
// appear anywhere inside those literals. Both `db/schema.ts` and
// `db/schema-trial.ts` say so in their own headers, and the consequence there
// is worse than here — a backtick terminates the literal early and breaks the
// server-core build. So "read to the next backtick" is not a shortcut, it is
// the same invariant the build already depends on.
//
// 🔴 AND THE READER PROVES ITSELF AGAINST THE PRESENT, every test run:
// `apps/server-core/test/migration-upgrade-from-release.test.ts` renders the
// WORKING TREE's own schema modules through `renderInitSql` below and asserts
// the result is character-for-character the `INIT_SQL` that server-core
// actually imports. If this reader ever stops being faithful, that assertion
// goes red on the current schema — which is the only place we can check it,
// because no historical ref can tell us whether we read it correctly.
//
// CLI:
//   node scripts/db-legacy-ddl.mjs --check          verify every committed fixture
//   node scripts/db-legacy-ddl.mjs --write          (re-)generate every fixture
//   node scripts/db-legacy-ddl.mjs --ref <ref>      print one ref's INIT_SQL

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the schema modules live. Every `schema*.ts` in this directory is read;
 *  which ones exist is a property of the ref, not of today (0.3.77 had three,
 *  0.3.79 had seven, and the split that produced them is ongoing). */
const DB_DIR = 'apps/server-core/src/db';

/** The releases whose DDL the upgrade gate opens the current schema over.
 *
 *  🔴 THESE ARE COMMITS, NOT TAGS, AND THAT IS NOT A PREFERENCE: this
 *  repository has no tags at all (`git tag --list` prints nothing), so the
 *  release bump commit is the only durable handle a release has.
 *
 *  Why these two and not one:
 *    · 0.3.77 predates `trial_ledger` entirely and predates the split of
 *      `schema-additive-columns.ts` / `schema-ops.ts` / `schema-trial.ts` out of
 *      `schema.ts` — so opening the current schema over it exercises table
 *      ARRIVAL (several tables that simply are not there yet), which is the
 *      cheap half of an upgrade and the half that has always worked.
 *    · 0.3.79 is the last release before R-1b added `trial_ledger.device_uid`.
 *      It is the one that exercises COLUMN arrival on a table that already
 *      exists — the half that took production down, because `CREATE TABLE IF
 *      NOT EXISTS` is skipped there while the column arrives later.
 *  A newer baseline should be added when a release changes a table that already
 *  exists; an old one should not be deleted to make room. */
export const BASELINES = [
  { version: '0.3.77', ref: 'c9f40241', why: 'predates trial_ledger and the schema-module split — exercises table arrival' },
  { version: '0.3.79', ref: 'c6453f51', why: 'last release before R-1b added trial_ledger.device_uid — exercises column arrival on an existing table' },
];

/** Committed rendering of one baseline, relative to the repo root. */
export function fixturePathFor(baseline) {
  return `apps/server-core/test/fixtures/legacy-ddl/${baseline.version}-${baseline.ref}.sql`;
}

/** Every `const NAME = \`…\`` template literal in one module's source, as raw
 *  (still un-interpolated) bodies.
 *
 *  Anchored on the declaration rather than scanned sequentially, because the
 *  comments AROUND these literals are full of backticks (`device_uid` and
 *  friends) while the literals themselves contain none. Starting only at a
 *  declaration and reading to the next backtick therefore cannot be confused by
 *  prose — and the un-exported constants matter too (`BILLING_TABLES_SQL` and
 *  `ONE_TIME_PURCHASE_SQL` are module-private and `BILLING_SQL` is nothing but
 *  the two of them concatenated). */
export function extractSqlConstants(source) {
  const out = new Map();
  const decl = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=`]*)?=\s*(?:\/\*\s*sql\s*\*\/\s*)?`/g;
  let m;
  while ((m = decl.exec(source)) !== null) {
    const bodyStart = decl.lastIndex;
    const end = source.indexOf('`', bodyStart);
    if (end === -1) throw new Error(`unterminated template literal for const ${m[1]}`);
    out.set(m[1], source.slice(bodyStart, end));
    decl.lastIndex = end + 1;
  }
  return out;
}

/** Resolve `INIT_SQL` out of a set of schema module sources.
 *
 *  `sources` is filename → source text. Interpolations are resolved
 *  recursively and a `${…}` that does not name a known constant is a hard
 *  error rather than an empty string: an expression this reader cannot evaluate
 *  must stop the build of a fixture, not silently produce a shorter schema than
 *  the release really had. */
export function renderInitSql(sources) {
  const constants = new Map();
  for (const [file, source] of sources) {
    for (const [name, body] of extractSqlConstants(source)) {
      if (constants.has(name)) throw new Error(`duplicate SQL constant ${name} (second in ${file})`);
      constants.set(name, body);
    }
  }
  if (!constants.has('INIT_SQL')) throw new Error('no INIT_SQL constant found');

  const seen = new Set();
  const expand = (name) => {
    if (seen.has(name)) throw new Error(`circular SQL constant reference at ${name}`);
    seen.add(name);
    const body = constants.get(name);
    const rendered = body.replace(/\$\{([^}]*)\}/g, (_all, expr) => {
      const ref = expr.trim();
      if (!constants.has(ref)) {
        throw new Error(`INIT_SQL interpolates \${${ref}}, which is not a template-literal constant this reader can resolve`);
      }
      return expand(ref);
    });
    seen.delete(name);
    return rendered;
  };
  return expand('INIT_SQL');
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The schema module sources exactly as they stood at `ref`.
 *  NOT exported: `renderInitSqlAtRef` below is its only caller, and an exported
 *  symbol nobody outside this file reaches is the facade shape this repository
 *  hunts -- it looks like an offered capability and is really an implementation
 *  detail. Export it the day something actually needs the sources themselves. */
function readDbSourcesAtRef(ref) {
  const names = git(['ls-tree', '--name-only', `${ref}`, `${DB_DIR}/`])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\/schema[\w-]*\.ts$/.test(l));
  if (names.length === 0) throw new Error(`no schema modules found at ${ref}`);
  const sources = new Map();
  for (const name of names) sources.set(name, git(['show', `${ref}:${name}`]));
  return sources;
}

/** `INIT_SQL` as the release at `ref` would have executed it. */
export function renderInitSqlAtRef(ref) {
  return renderInitSql(readDbSourcesAtRef(ref));
}

function main(argv) {
  const refIdx = argv.indexOf('--ref');
  if (refIdx !== -1) {
    process.stdout.write(renderInitSqlAtRef(argv[refIdx + 1]));
    return 0;
  }
  const write = argv.includes('--write');
  let failures = 0;
  for (const baseline of BASELINES) {
    const path = join(REPO_ROOT, fixturePathFor(baseline));
    const rendered = renderInitSqlAtRef(baseline.ref);
    if (write) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, rendered);
      console.log(`wrote ${fixturePathFor(baseline)} (${rendered.length} chars, from ${baseline.ref})`);
      continue;
    }
    let onDisk;
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      console.error(`MISSING ${fixturePathFor(baseline)} — run with --write`);
      failures += 1;
      continue;
    }
    if (onDisk !== rendered) {
      console.error(`DRIFT ${fixturePathFor(baseline)} does not match INIT_SQL at ${baseline.ref}`);
      failures += 1;
    } else {
      console.log(`ok ${fixturePathFor(baseline)} matches INIT_SQL at ${baseline.ref} (${rendered.length} chars)`);
    }
  }
  if (failures > 0) {
    console.error(`${failures} baseline(s) out of date with git history`);
    return 1;
  }
  console.log(`${BASELINES.length} release baseline(s) match their commits`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

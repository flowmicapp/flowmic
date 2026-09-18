// NR-33 drill for scripts/db-legacy-ddl.mjs — the FRESHNESS half of the upgrade
// gate.
//
// WHAT IT GUARDS. `apps/server-core/test/migration-upgrade-from-release.test.ts`
// opens the current schema over two committed `.sql` baselines and claims they
// are what releases 0.3.77 and 0.3.79 really created. That claim is the whole
// value of the gate — a baseline that has quietly become "roughly the old
// schema" would let the gate pass while proving nothing about the databases
// that are actually out there. This file re-renders both baselines FROM THE
// RELEASE COMMITS and fails if the committed bytes differ.
//
// 🔴 WHY THE SPLIT: that vitest file must run with no git and no network (it
// runs in `verify:server-tests`, and it would also have to run in an exported
// tree whose history is not this one). This drill is the only piece that talks
// to git, it lives in `verify:scripts`, and it is the reason the other file is
// allowed to trust a checked-in `.sql`.
//
// EXIT CODES: 0 PASS, 1 FAIL, 2 SKIP.
//
// 🔴 THE SKIP IS FOR EXACTLY ONE SITUATION AND IT MUST STAY THAT NARROW: a
// checkout whose history is not this repository's, i.e. the open-source export
// tree, where the pinned release commits do not exist and `git show` can only
// answer "unknown revision". The public CI runs `verify:scripts`
// (.github/workflows/verify.yml), so without this the exported copy would go
// red on every public run for a reason that has nothing to do with the code.
//
// It is deliberately NOT a catch-all "git had a problem" skip. In this
// repository the refs are always present, so this drill never skips here — and
// a SKIP that printed on every run is a SKIP nobody reads, which is the failure
// mode this repo has already paid for once. The check is ref RESOLUTION only:
// if the commits are there, every section runs and a drifted fixture is a FAIL.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINES,
  extractSqlConstants,
  fixturePathFor,
  renderInitSql,
  renderInitSqlAtRef,
} from './db-legacy-ddl.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOTAL_SECTIONS = 5;

/** Does this checkout actually contain the release commits the baselines pin? */
function missingRefs() {
  return BASELINES.filter((b) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${b.ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  });
}

{
  const missing = missingRefs();
  if (missing.length > 0) {
    console.log(
      `SKIP: this checkout does not contain ${missing.map((b) => `${b.version} (${b.ref})`).join(', ')} — ` +
        'the pinned release commits are absent, so the committed baselines cannot be re-rendered from history here. ' +
        'Expected in the open-source export tree and nowhere else; in the private repository this drill never skips. ' +
        'The baselines themselves still gate the upgrade path through ' +
        'apps/server-core/test/migration-upgrade-from-release.test.ts, which needs no git.',
    );
    process.exit(2);
  }
}
let sectionsRun = 0;
let failures = 0;

function section(title) {
  sectionsRun += 1;
  console.log(`\n── ${title}`);
}
function assertTrue(cond, what) {
  if (cond) {
    console.log(`  ok  ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failures += 1;
  }
}

// ── §1 the reader reads what is really there ────────────────────────────────
// A reader that silently returned an empty map would make every comparison
// below compare nothing to nothing. These are its controls.
section('§1 the template-literal reader is not blind');
{
  const consts = extractSqlConstants(
    [
      '// a comment mentioning `device_uid` in backticks, outside any literal',
      'const A_SQL = /* sql */ `CREATE TABLE a (x TEXT);`;',
      'export const B_SQL = `${A_SQL}CREATE TABLE b (y TEXT);`;',
      'export const NOT_SQL: Readonly<Record<string, string>> = { a: 1 };',
    ].join('\n'),
  );
  assertTrue(consts.size === 2, `two literals found, not ${consts.size} (object literals and prose are not literals)`);
  assertTrue(consts.get('A_SQL') === 'CREATE TABLE a (x TEXT);', 'the private constant is read');
  assertTrue(consts.has('B_SQL'), 'the exported constant is read');

  const rendered = renderInitSql(new Map([['x.ts', 'const P_SQL = `p;`;\nexport const INIT_SQL = `${P_SQL}q;`;']]));
  assertTrue(rendered === 'p;q;', `interpolation is resolved recursively (got ${JSON.stringify(rendered)})`);

  // An expression this reader cannot evaluate must STOP a fixture being built,
  // never quietly produce a schema shorter than the release really had.
  let threw = false;
  try {
    renderInitSql(new Map([['x.ts', 'export const INIT_SQL = `${someFunction()}`;']]));
  } catch {
    threw = true;
  }
  assertTrue(threw, 'an unresolvable ${…} throws instead of rendering an empty string');
}

// ── §2 the baselines are still what those commits contain ───────────────────
section('§2 every committed baseline matches INIT_SQL at its release commit');
{
  for (const baseline of BASELINES) {
    const fromGit = renderInitSqlAtRef(baseline.ref);
    let onDisk = '';
    try {
      onDisk = readFileSync(join(ROOT, fixturePathFor(baseline)), 'utf8');
    } catch (err) {
      assertTrue(false, `${fixturePathFor(baseline)} is readable (${err.message})`);
      continue;
    }
    assertTrue(
      onDisk === fromGit,
      `${fixturePathFor(baseline)} is byte-identical to INIT_SQL at ${baseline.ref} (${fromGit.length} chars)`,
    );
  }
}

// ── §3 the baselines are actually OLD ───────────────────────────────────────
// The gate's premise. A fixture that had drifted forward into today's schema
// would make the upgrade test green while walking no upgrade at all — the exact
// failure mode ("every test starts from an empty database") this whole card is
// about, wearing a different hat.
section('§3 the baselines really predate what they are supposed to predate');
{
  const byVersion = Object.fromEntries(BASELINES.map((b) => [b.version, readFileSync(join(ROOT, fixturePathFor(b)), 'utf8')]));
  assertTrue(
    byVersion['0.3.77'] !== undefined && !/trial_ledger/.test(byVersion['0.3.77']),
    '0.3.77 has no trial_ledger table at all (it exercises TABLE arrival)',
  );
  assertTrue(
    byVersion['0.3.79'] !== undefined && /CREATE TABLE IF NOT EXISTS trial_ledger/.test(byVersion['0.3.79']),
    '0.3.79 does have trial_ledger',
  );
  const trialBlock = (byVersion['0.3.79'] ?? '').split('CREATE TABLE IF NOT EXISTS trial_ledger')[1]?.split(');')[0] ?? '';
  assertTrue(
    trialBlock.length > 0 && !/device_uid/.test(trialBlock),
    "0.3.79's trial_ledger has no device_uid column (it exercises COLUMN arrival on an existing table)",
  );
  const current = readFileSync(join(ROOT, 'apps', 'server-core', 'src', 'db', 'schema-trial.ts'), 'utf8');
  assertTrue(/device_uid/.test(current), 'while the CURRENT schema-trial.ts does declare device_uid — so the two really differ');
}

// ── §4 drift is detected, not merely describable ────────────────────────────
// Reverse control for this drill itself: change one byte of a baseline in
// memory and the comparison §2 performs must reject it. A comparison that could
// not fail would be a freshness check that never checks anything.
section('§4 a one-byte drift in a baseline is rejected');
{
  const baseline = BASELINES[0];
  const fromGit = renderInitSqlAtRef(baseline.ref);
  const tampered = `${fromGit}\n-- one extra byte\n`;
  assertTrue(tampered !== fromGit, 'a tampered baseline is not equal to the rendering from git');
  assertTrue(
    readFileSync(join(ROOT, fixturePathFor(baseline)), 'utf8') === fromGit,
    'and the real file on disk is the untampered one (the tamper stayed in memory)',
  );
}

// ── §5 the CLI's --check answers the same question ──────────────────────────
// The tool is meant to be runnable by a human before a release; a --check that
// disagreed with §2 would be a second answer to one question.
section('§5 `node scripts/db-legacy-ddl.mjs --check` agrees, and exits 0');
{
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'db-legacy-ddl.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assertTrue(code === 0, `--check exited 0 (got ${code})`);
  assertTrue(
    out.includes(`${BASELINES.length} release baseline(s) match their commits`),
    `--check reported all ${BASELINES.length} baselines matching`,
  );
}

console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ NR-33 legacy-DDL drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ NR-33 legacy-DDL drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ NR-33 legacy-DDL drill PASSED');

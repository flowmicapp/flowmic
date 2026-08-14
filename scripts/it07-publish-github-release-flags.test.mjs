// IT-07 argument-parsing drill for scripts/publish-github-release.mjs.
//
// IT-07: `--dry-run=1` and `--publish=1` must be rejected at parse time with a
// non-zero exit — never silently become a real run. Bare `--dry-run` /
// `--publish` remain the only accepted spellings.
//
// SAFETY: every spawn that reaches past flag parsing uses a valued boolean
// that exits before main(), OR bare `--dry-run`, which short-circuits before
// any GitHub API call. No release is created, no asset uploaded, and no token
// is read on the reject paths. Bare `--dry-run` may exit non-zero if ./publish
// has no artifacts — that is a later local gate, not a publish.
//
// WHY THIS IS ITS OWN FILE (cards IT-22 / IT-23). It used to share
// `it07-it11-publish-flags.test.mjs` with the publish-download-center drills.
// That file also imported scripts/publish-download-center.mjs, which is
// excluded from the open-source export, so under IT-12's "a test and its
// subject travel together or not at all" rule the whole file had to be
// excluded — taking these github-release assertions with it, and leaving the
// exported tree with zero `scripts/*.test.mjs`, which run-script-tests.mjs
// correctly refuses. The subject of THIS file is public, so this half ships
// with its subject and the exported `pnpm verify:scripts` stays honest.
// The pairing is no longer a rule someone has to remember: see
// checkTestSubjectPairs() in scripts/opensource-export.mjs.
//
// Run: `node scripts/it07-publish-github-release-flags.test.mjs`

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB = join(ROOT, 'scripts', 'publish-github-release.mjs');

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}

function run(script, scriptArgs) {
  return spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env },
  });
}

const rejectRe = (name) => new RegExp(
  String.raw`✗ --${name}=… is not accepted\. Use bare --${name} \(no =value\)\. Got: --${name}=`,
);

// ── IT-07: valued form rejected ───────────────────────────────────────────
section('IT-07 RED shape would have been: --dry-run=1 ⇒ DRY=false ⇒ real run');
section('IT-07 GREEN — publish-github-release.mjs --dry-run=1 rejected');
{
  const r = run(GITHUB, ['--dry-run=1']);
  console.log('--- stderr ---');
  console.log(r.stderr);
  console.log(`--- exit: ${r.status} ---`);
  assertTrue(r.status !== 0, 'exit non-zero');
  assertTrue(rejectRe('dry-run').test(r.stderr), 'stderr names bare --dry-run');
}

section('IT-07 GREEN — publish-github-release.mjs --publish=1 rejected (same hazard next door)');
{
  const r = run(GITHUB, ['--publish=1', '--dry-run']);
  // Both flags are parsed at top level in source order (publish-github-release.mjs:76-77:
  // `const DRY = boolFlag('dry-run')` then `const PUBLISH = boolFlag('publish')`). Bare
  // --dry-run is accepted, so the run must survive that far and then die on --publish=1.
  // argv order is irrelevant: boolFlag scans the whole argv (`args.find`, :68), so
  // whichever valued form it meets first is the one that exits.
  console.log('--- stderr ---');
  console.log(r.stderr);
  console.log(`--- exit: ${r.status} ---`);
  assertTrue(r.status !== 0, 'exit non-zero');
  assertTrue(rejectRe('publish').test(r.stderr), 'stderr names bare --publish');
  assertTrue(/Got: --publish=1/.test(r.stderr), 'stderr echoes --publish=1');
}

// ── IT-07 positive control: bare form still accepted ──────────────────────
// note-A (2026-08-07): "accepted" used to be a closed enumeration of the local
// failures publish-github-release.mjs's OWN LOCAL STATE can produce past flag
// parsing (no ./publish, no installers, no .sha256 sidecar), and did not include
// the two messages detectRepo() — the FIRST thing main() calls, before any of
// those — can produce. MEASURED (second-iteration ledger §7-3 note, reproduced
// here before this fix): a checkout with no "origin" remote (a tarball download,
// or `git remote remove origin`) gets `could not read git remote "origin"`; a
// checkout whose "origin" is not a github.com URL (a fork, or — as reproduced —
// a plain local-path clone) gets `does not look like a github.com remote`.
// Neither is the IT-07 flag-parsing bug this file exists to catch (that is
// asserted separately, immediately above, via rejectRe) — both are legitimate
// environment facts about a checkout that has every right to run this test.
// Widening `accepted` to include them does not weaken the real assertion: a
// regression that makes --dry-run wrongly rejected still fails on `must not
// reject bare --dry-run`, unconditionally, before this line is even reached.
const detectRepoLocalFailure = /could not read git remote "origin"|does not look like a github\.com remote/;
section('IT-07 positive control — bare --dry-run is NOT rejected (github-release)');
{
  const r = run(GITHUB, ['--dry-run']);
  console.log('--- stderr (first 400) ---');
  console.log((r.stderr ?? '').slice(0, 400));
  console.log(`--- exit: ${r.status} ---`);
  assertTrue(!rejectRe('dry-run').test(r.stderr ?? ''), 'must not reject bare --dry-run');
  const accepted =
    /Zero network requests were made/.test(r.stdout ?? '')
    || /no \.\/publish|no .+ installers|no \.sha256/.test(r.stderr ?? '')
    || detectRepoLocalFailure.test(r.stderr ?? '');
  assertTrue(accepted, 'reached main() local path (dry-run message, collectArtifacts local error, or a legitimate detectRepo() environment gap — no "origin", or "origin" not github-shaped)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;

#!/usr/bin/env node
// Drill for verify/lane-map.mjs — the path → stage table T1 reads.
//
// The table is data, and data rots in two directions. This drill exists for the
// direction that does NOT announce itself:
//
//   · A ROW THAT NO LONGER MATCHES ANYTHING. Rename a directory and the row
//     keeps sitting there looking authoritative while every path under the new
//     name falls through to "unmapped". That is safe (unmapped runs everything)
//     but it is silent, and a table with dead rows is a table nobody trusts
//     enough to read. So every row must match at least one path git actually
//     tracks today.
//   · A ROW THAT NAMES A STAGE THAT DOES NOT EXIST. `verify:server-test` for
//     `verify:server-tests` would be selected happily and then filtered out of
//     the lanes, because the lanes are built by intersecting with the real
//     step list — a typo would read as "that stage was not needed".
//   · THE PROTOCOL ROW SHRINKING. It is the one row with no scoping upside, and
//     the one somebody will "optimise" first. Design §9-2 names it explicitly.
//     Pinned against FULL_STAGES, which is itself derived from the parallel
//     gate's lane table, so the two cannot drift apart quietly.
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const map = await import(pathToFileURL(path.join(ROOT, 'verify', 'lane-map.mjs')).href);
const fast = await import(pathToFileURL(path.join(ROOT, 'verify', 'run-delivery-fast.mjs')).href);
const {
  RULES,
  FULL_STAGES,
  IGNORED_PATTERNS,
  DIST_READERS,
  globToRegExp,
  matchPath,
  selectStages,
  isIgnoredPath,
} = map;

let failures = 0;
let checks = 0;
const check = (ok, what) => {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL ${what}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

// POSITIVE CONTROL for the corpus itself. Every assertion below is "some real
// path does X"; if `git ls-files` came back empty (wrong cwd, no git) they
// would all fail for a reason that has nothing to do with the table, and a
// reader would spend the afternoon on the wrong file.
check(tracked.length > 1000, `git ls-files returned a real tree (${tracked.length} paths)`);

// ---------------------------------------------------------------------------
section('1 every rule still matches something in this tree');

const matchesOf = (patterns) => {
  const res = patterns.map(globToRegExp);
  return tracked.filter((p) => res.some((re) => re.test(p)));
};

for (const rule of RULES) {
  const hits = matchesOf(rule.patterns);
  if (hits.length === 0 && rule.patterns.every((pattern) => {
    const top = pattern.split('/')[0];
    return top !== '**' && !tracked.some((p) => p.split('/')[0] === top);
  })) {
    console.log(`  SKIP rule \`${rule.id}\`: every directory it names is absent from this checkout`);
    continue;
  }
  check(hits.length > 0, `rule \`${rule.id}\` (${rule.patterns.join(' ')}) matches a tracked path`);
}
// Each PATTERN, not just each rule: a rule with five patterns can go on passing
// on the strength of one while the other four point at renamed directories.
// A pattern can also point at a whole directory this CHECKOUT does not carry.
// The exported public tree has no `docs/`, so `docs/**` matches nothing there
// and the assertion above fails for a reason that has nothing to do with the
// table (measured on the public runner at 0.3.85 — RELEASE-IRONRULES 1-13: a
// test that assumes something only the private tree has). "The directory is
// absent here" and "the pattern rotted" are different answers, so the absent
// case says so by name instead of borrowing the other one's red.
const topLevelOf = (pattern) => pattern.split('/')[0];
const presentTops = new Set(tracked.map((p) => p.split('/')[0]));
for (const rule of RULES) {
  for (const pattern of rule.patterns) {
    const top = topLevelOf(pattern);
    if (top !== '**' && !presentTops.has(top)) {
      console.log(`  SKIP pattern \`${pattern}\` (rule ${rule.id}): this checkout tracks nothing under \`${top}/\``);
      continue;
    }
    check(matchesOf([pattern]).length > 0, `pattern \`${pattern}\` (rule ${rule.id}) matches a tracked path`);
  }
}
// REVERSE CONTROL. Without it the loop above also passes against a matcher that
// says yes to everything.
check(
  matchesOf(['zzz-this-directory-does-not-exist/**']).length === 0,
  'the same matcher finds nothing for a directory that does not exist (so the checks above are not blind)',
);

// The ignored rows are exempt from the rule above BY CONSTRUCTION — git never
// reports them, so they can never match a tracked path. Checked the other way
// instead: they must match the paths they claim to.
for (const [pattern, sample] of [
  ['.local/**', '.local/gate-receipt.json'],
  ['publish/**', 'publish/FlowMic-0.3.83-release.apk'],
  ['node_modules/**', 'node_modules/typescript/package.json'],
  ['apps/desktop/src-tauri/target/**', 'apps/desktop/src-tauri/target/debug/app.exe'],
  ['apps/desktop/src-tauri/resources/**', 'apps/desktop/src-tauri/resources/node.exe'],
]) {
  check(IGNORED_PATTERNS.includes(pattern), `\`${pattern}\` is still listed as ignored`);
  check(isIgnoredPath(sample), `isIgnoredPath('${sample}')`);
}
check(!isIgnoredPath('apps/desktop/src-tauri/src/main.rs'), 'a real source path is not treated as ignored');

// ---------------------------------------------------------------------------
section('2 every stage name is a real script');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const named = new Set([...RULES.flatMap((r) => r.stages), ...FULL_STAGES, ...DIST_READERS]);
for (const stage of [...named].sort()) {
  check(typeof scripts[stage] === 'string', `\`${stage}\` is a script in the root package.json`);
}
check(named.size >= 10, `the scan saw a real set of stage names (${named.size})`);
// REVERSE CONTROL for the lookup above.
check(typeof scripts['verify:this-stage-does-not-exist'] !== 'string', 'the manifest lookup can say no');

// ---------------------------------------------------------------------------
section('3 FULL_STAGES is the parallel gate, not a copy of it');

const fromLanes = fast.LANES.flatMap((l) =>
  l.steps.filter((s) => s.cmd === 'pnpm').map((s) => s.args[0]),
);
check(
  JSON.stringify(FULL_STAGES) === JSON.stringify(fromLanes),
  `FULL_STAGES equals the flattened lane table of verify/run-delivery-fast.mjs (${FULL_STAGES.length} vs ${fromLanes.length})`,
);
check(FULL_STAGES.length >= 13, `the full set is not a stub (${FULL_STAGES.length} stages)`);
check(new Set(FULL_STAGES).size === FULL_STAGES.length, 'no stage appears twice in the full set');

// ---------------------------------------------------------------------------
section('3b every row carries the two unconditional stages');

// RULING (MAIN, 2026-09-13). `verify:lint` for the whole-tree and sibling-repo
// checks it owns; `verify:scripts` because scripts/w2-eval-corpus.test.mjs is a
// resident gate on server-core PRODUCTION source (`:147` loads
// apps/server-core/src/compose/output-guard.ts through esbuild), so a row that
// scoped it away would skip a real gate to save the set's measured 10.9 s.
for (const rule of RULES) {
  check(rule.stages.includes('verify:lint'), `rule \`${rule.id}\` includes verify:lint`);
  check(rule.stages.includes('verify:scripts'), `rule \`${rule.id}\` includes verify:scripts`);
}
// REVERSE CONTROL: the same predicate must be able to say no, or the loop above
// passes against a table whose stage lists are all empty.
check(
  !RULES.some((r) => r.stages.includes('verify:this-stage-does-not-exist')),
  'the same membership test says no for a stage no row names',
);
// And the reason verify:scripts is unconditional has a second half: it reads
// the protocol dist, so selecting it must always bring the Stage 0 barrier.
// Measured, not assumed — see the DIST_READERS comment in verify/lane-map.mjs.
check(DIST_READERS.has('verify:scripts'), 'verify:scripts is registered as a protocol-dist reader');
check(
  selectStages(['docs/x.md']).stage0 === true,
  'so even a docs-only diff runs Stage 0 (a fresh worktree has no dist)',
);

// ---------------------------------------------------------------------------
section('4 the protocol row is the full set');

const protocolRule = RULES.find((r) => r.id === 'protocol');
check(protocolRule !== undefined, 'there is a protocol row');
check(
  [...protocolRule.stages].sort().join(',') === [...FULL_STAGES].sort().join(','),
  `the protocol row selects every stage (row has ${protocolRule.stages.length}, full set is ${FULL_STAGES.length})`,
);
const viaSelect = selectStages(['packages/protocol/src/constants.ts']);
check(
  viaSelect.stages.length === FULL_STAGES.length,
  `selecting on a real protocol path yields the full set (${viaSelect.stages.length})`,
);
check(viaSelect.stage0 === true, 'a protocol change needs the Stage 0 barrier');
check(viaSelect.unmapped.length === 0, 'a protocol path is not unmapped');

// ---------------------------------------------------------------------------
section('5 first-match order, where two rows genuinely overlap');

for (const [p, want] of [
  ['apps/desktop/src-tauri/tauri.conf.json', 'desktop-payload'],
  ['apps/desktop/src-tauri/tauri.macos.conf.json', 'desktop-payload'],
  ['apps/desktop/src-tauri/src/main.rs', 'desktop-rust'],
  ['verify/golden/run-golden.mjs', 'golden'],
  ['verify/lint/run-all.mjs', 'lints'],
  ['verify/run-delivery-fast.mjs', 'gate-tooling'],
  ['scripts/i18n/gen-mobile-dart.mjs', 'i18n-generators'],
  ['scripts/publish.mjs', 'gate-tooling'],
  ['docs/strategy/x.md', 'docs'],
  ['CLAUDE.md', 'docs'],
  ['pnpm-lock.yaml', 'dependencies'],
]) {
  check(matchPath(p)?.id === want, `\`${p}\` resolves to rule \`${want}\` (got ${matchPath(p)?.id ?? 'none'})`);
}

// ---------------------------------------------------------------------------
section('6 the docs row is the two unconditional stages only, and unknown paths are not');

for (const input of ['packages/protocol/src/error-codes.ts',
  'apps/desktop/src/main-window/TimelinePage.vue',
  'apps/desktop/src-tauri/tauri.conf.json', 'i18n/desktop/en.json',
  'scripts/i18n/gen-desktop-ts.mjs', 'scripts/linux-copy-render.mjs']) {
  check(selectStages([input]).stages.includes('verify:linux-copy-render'),
    `${input} must execute the rendered Linux reason gate`);
}

const docsOnly = selectStages(['docs/strategy/2026-09-13-gate-tiering-design.md', 'CHANGELOG.md']);
check(
  JSON.stringify(docsOnly.stages) === JSON.stringify(['verify:lint', 'verify:scripts']),
  `a docs-only change selects exactly the two unconditional stages (got ${JSON.stringify(docsOnly.stages)})`,
);
check(
  docsOnly.stages.length === 2,
  `and nothing else — no compiler, no suite, no golden (got ${docsOnly.stages.length})`,
);

const unknown = selectStages(['zzz/x.txt']);
check(unknown.unmapped.length === 1, 'an unknown path is reported as unmapped');
check(unknown.stages.length === FULL_STAGES.length, 'an unknown path selects every stage (fail closed)');

// ---------------------------------------------------------------------------
section('7 the glob matcher');

for (const [pattern, p, want] of [
  ['docs/**', 'docs/a/b.md', true],
  ['docs/**', 'docsx/a.md', false],
  ['*.md', 'README.md', true],
  ['*.md', 'docs/README.md', false],
  ['apps/mobile/pubspec.*', 'apps/mobile/pubspec.yaml', true],
  ['apps/mobile/pubspec.*', 'apps/mobile/pubspec/inner.yaml', false],
  ['**/node_modules/**', 'apps/x/node_modules/y.js', true],
  ['package.json', 'package.json', true],
  ['package.json', 'apps/desktop/package.json', false],
]) {
  check(globToRegExp(pattern).test(p) === want, `glob \`${pattern}\` vs \`${p}\` => ${want}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} lane-map: ${checks - failures}/${checks} checks`);
console.log(`ACCOUNTING: sections run 8/8, checks ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);

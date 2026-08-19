// Drill for verify/lint/changelog-release-sections.mjs (2026-08-19).
//
// That lint asks TWO questions about shipped release notes — does every
// released version still have a section, and does every released section still
// say what it said — and until this file existed it had no drill of any kind,
// unlike its siblings coordinate-anchors, oss-absent-sweep and
// module-reachability. Everything its header says about its own behaviour was a
// header claim, including the four measurements that are the reason it exists.
// Those four are pinned below as executable facts:
//
//   A. `## 0.3.9` -> `## 0.4.0`                        caught by presence
//   B. `## 0.3.9` -> `## 0.4.0` + combined-round form  INVISIBLE to presence
//   C. body deleted, heading left standing             INVISIBLE to presence
//   D. seven release commits spelled `chore(release): bump to x.y.z` were
//      outside the released list entirely, while the PASS line printed a
//      confident count of the ones it did see
//
// D is the one that matters most, and it is not a missed case — it is a RULER
// defect: the tool answered a narrower question than its PASS line claimed, and
// answered it confidently. Section 4 drives the real subject pattern over a
// synthetic history carrying BOTH spellings; section 4b re-runs that same tree
// through the pre-widening pattern to show the two disagree.
//
// ── WHY THIS FILE INJECTS A ROOT INSTEAD OF CALLING AN EXPORTED CORE ────────
//
// The sibling lints hand their drills a seam. coordinate-anchors exports
// `scanTree(rootAbs)`; another lint in this tree takes a root argument on its
// default export, so its drill runs it against temp trees. (That one is a
// private-package gate and is excluded from the public export, which is why it
// is described rather than named — a name the exported tree cannot resolve is a
// dangling reference, and the export refuses on it.) changelog-release-sections
// exports ONLY `default run()`, and run() reads `path.join(ROOT,'CHANGELOG.md')`
// where ROOT comes from _util.mjs, runs `git log` with `cwd: ROOT`, and imports
// the baseline directly. There is no argument and no env override: from the
// outside, the module can only ever be asked about the real repo.
//
// Re-implementing its rules here would be the shape this repo has already paid
// for — a copy that can disagree with the original while both stay green. So
// this file loads THE REAL MODULE FILE (same path, same bytes, no copy on disk)
// through an ESM loader hook that substitutes exactly two of its imports:
//
//   ./_util.mjs                                -> `export const ROOT = <fixture>`
//   ./changelog-release-sections-baseline.mjs  -> a mutable pins array
//
// Everything under test — the subject pattern, headings(), documentedVersions(),
// ownerHeading(), sectionText(), fingerprint(), parsePins(), the wording and the
// clause ordering — runs out of the repo file itself. Section 1 proves that
// rather than asserting it.
//
// 🔴 THE SEAMS THAT ARE MISSING, AND THE ONE LINE THAT WOULD FIX EACH. This
// machinery is a workaround for a testability gap, not a preference. Each of
// these would let the corresponding section drop the loader:
//
//   1. `export default function run(rootAbs = ROOT)`, threaded through the two
//      ROOT uses. Retires the _util.mjs substitution — and is exactly the
//      shape the root-parameterised sibling lint described above already has.
//   2. `export function releasedVersions(rootAbs = ROOT)` — already a function,
//      missing only the keyword and the parameter. Would let section 4 pin the
//      subject pattern head-on instead of inferring it from a verdict.
//   3. `export function fingerprint(text)` and `export function parsePins(raw)`,
//      both pure. Sections 5–7 currently reach them through a whole run() and
//      read the answer back out of a failure string.
//   4. `export const RELEASE_SUBJECT` — the one value the D incident was about.
//      Section 4b has to rewrite source text in a loader hook to get at it.
//
// ── WHAT IS SYNTHETIC, AND WHAT IS NOT ─────────────────────────────────────
//
// Synthetic: every CHANGELOG.md, every baseline array and every history below.
// The histories are real repositories — loose objects and refs written
// byte-by-byte with node:zlib and node:crypto, never by running a git command
// that writes — so the real `git log` really parses them. The repo's own
// CHANGELOG.md and .git are never written, never read as a fixture and never on
// the path of an assertion; section 8 re-hashes CHANGELOG.md at the end to prove
// it. That guard is not decorative: the pre-pin reverse controls recorded in the
// lint's header were run against the real file by hand, and one of them
// corrupted it.
//
// Not synthetic, and named as such: section 5 feeds the REAL baseline array
// through the REAL parser, because "do the shipped pins parse" is a property of
// shipped data and no fixture can answer it.
//
// ── NEGATIVE CONTROL, VERBATIM ─────────────────────────────────────────────
//
// Section 4b is a mutation control: the loader hands Node the real source with
// the widening token `(?:bump to\s+)?` removed — the pattern exactly as it stood
// before 2026-08-19 — and runs it over the SAME history and the SAME changelog.
// It must report PASS where the shipped pattern reports FAIL. Run once with that
// expectation inverted (asserting the mutant convicts too), this file printed:
//
//   === S4b the pre-widening pattern is BLIND to the same tree (mutation control) ===
//     PASS  the widening token appears exactly once in the lint source (found 1)
//     FAIL  INVERTED CONTROL: the pre-widening pattern also convicts (PASS: 1 released version(s): every one still has its own sect...)
//     PASS  ... and the shipped pattern convicts the same tree (1 released version(s) have no CHANGELOG section: 9.0.1....)
//     PASS  the two patterns disagree about the same tree, which is what makes the widening load-bearing (and proves the mutation applied)
//
//   ACCOUNTING: sections run 9/9, 1 assertion failure(s)
//
//   x changelog-release-sections drill FAILED (1 assertion(s))
//
// Read the FAIL line's parenthesis: the mutant's own verdict, `PASS: 1 released
// version(s)`, on a tree that is missing a shipped section. The inverted line
// was then restored (this file back to exit 0, 9/9). That reading is what makes
// 4b a control rather than a sentence — the old pattern really does return PASS
// where the shipped one convicts, so the widening is load-bearing and its
// removal is caught here.
//
// ── THREE THINGS THIS DRILL PINS AS LIMITS, NOT AS GOOD PROPERTIES ─────────
//
// Found while writing it; reported rather than fixed, because the lint is
// another agent's file this round. Section 8 pins each as behaviour so that a
// later change to it is visible, NOT as an endorsement:
//
//   · `releasedVersions()` returns null on ANY git failure and the SKIP says
//     "not a git checkout". Section 8 pins only the honest instance of that
//     message (no .git at all). The dishonest instances were measured
//     separately while building these fixtures and are NOT asserted below: a
//     hand-built repository with zero commits makes `git log` exit 128 —
//     verbatim `fatal: your current branch 'main' does not have any commits
//     yet` — and the gate calls that "not a git checkout" about a tree that is
//     one. Git missing from PATH or an unreadable object store read the same,
//     and every one of them turns the whole gate off while naming a cause that
//     is not the cause.
//   · A SHALLOW clone is indistinguishable from a squashed export: both make
//     the release list empty, and the SKIP blames the export by name.
//     actions/checkout defaults to fetch-depth 1; verify.yml, verify-linux.yml
//     and verify-macos.yml happen to set 0, but for an unrelated reason stated
//     in their own comments, so nothing ties this gate's liveness to that line.
//   · A tree with release commits and no CHANGELOG.md throws out of
//     readFileSync. run-all.mjs turns that into `FAIL threw: ENOENT …` — red,
//     which is right, with a message that is not an action.
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP. This file
// skips only where the lint module itself is absent.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINT_ABS = join(ROOT, 'verify', 'lint', 'changelog-release-sections.mjs');
const BASELINE_ABS = join(ROOT, 'verify', 'lint', 'changelog-release-sections-baseline.mjs');
const REPO_CHANGELOG = join(ROOT, 'CHANGELOG.md');

if (!existsSync(LINT_ABS)) {
  console.log('SKIP: verify/lint/changelog-release-sections.mjs is absent — nothing to drill');
  process.exit(2);
}

const LINT_SRC = readFileSync(LINT_ABS, 'utf8');
const RUN_ALL_SRC = readFileSync(join(ROOT, 'verify', 'lint', 'run-all.mjs'), 'utf8');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const REPO_CHANGELOG_SHA = existsSync(REPO_CHANGELOG) ? sha256(readFileSync(REPO_CHANGELOG)) : null;

// The combined-round heading spelling, assembled from escapes so this file stays
// pure ASCII (verify:lint no-cjk scans scripts/). Same discipline as cite() in
// scripts/coordinate-anchors-lint.test.mjs, which assembles the very shape its
// own subject lint would otherwise flag.
const FW_OPEN = '（';
const FW_CLOSE = '）';
const HAN_CONTAINS = '含';
const combined = (outer, inner) => `${outer}${FW_OPEN}${HAN_CONTAINS} ${inner}${FW_CLOSE}`;

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 9; // S1, S2, S3, S4, S4b, S5, S6, S7, S8
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

// ── fixture plumbing ───────────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'flowmic-changelog-pin-drill-'));
const FIXTURE_ROOT = join(TMP, 'fixture-root');
mkdirSync(FIXTURE_ROOT, { recursive: true });

// The widening token from measurement D, read out of the real source rather
// than re-typed as a rule: if it is gone, section 4b says so instead of
// pretending to control something.
const WIDENING_TOKEN = '(?:bump to\\s+)?';

const HOOKS_ABS = join(TMP, 'hooks.mjs');
writeFileSync(
  HOOKS_ABS,
  `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let cfg = null;
export async function initialize(data) { cfg = data; }
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('drill-fixture:')) return { url: specifier, shortCircuit: true };
  const parent = context.parentURL ?? '';
  if (/[?&]fx=/.test(parent)) {
    if (specifier === './_util.mjs') return { url: 'drill-fixture:util', shortCircuit: true };
    if (specifier.endsWith('changelog-release-sections-baseline.mjs')) {
      return { url: 'drill-fixture:pins', shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'drill-fixture:util') {
    return { format: 'module', shortCircuit: true, source: 'export const ROOT = ' + JSON.stringify(cfg.root) + ';' };
  }
  if (url === 'drill-fixture:pins') {
    // ONE live array, imported by the lint and by the drill, so the drill can
    // swap pins between runs without a second module instance disagreeing.
    return { format: 'module', shortCircuit: true, source: 'export const SHIPPED_SECTIONS = [];' };
  }
  if (url.startsWith('file:') && /[?&]mutate=narrow/.test(url)) {
    const src = readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
    return { format: 'module', shortCircuit: true, source: src.split(cfg.widening).join('') };
  }
  return nextLoad(url, context);
}
`,
  'utf8',
);

register(pathToFileURL(HOOKS_ABS).href, { data: { root: FIXTURE_ROOT, widening: WIDENING_TOKEN } });

const LINT_URL = pathToFileURL(LINT_ABS).href;
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
// Keep git from climbing out of the temp tree and answering about some other
// repository. Without this, the "no git at all" fixture could be measured
// against whatever repo happens to sit above tmpdir — the ruler answering a
// different question again.
process.env.GIT_CEILING_DIRECTORIES = TMP;

/** Write one git object by hand. No git command that writes is ever run. */
function writeObject(gitDir, type, body) {
  const store = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]);
  const sha = createHash('sha1').update(store).digest('hex');
  const dir = join(gitDir, 'objects', sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha.slice(2)), deflateSync(store));
  return sha;
}

/** Replace the fixture's history: one commit per subject, oldest first.
 *  `null` removes .git entirely. */
function setHistory(subjects) {
  const gitDir = join(FIXTURE_ROOT, '.git');
  rmSync(gitDir, { recursive: true, force: true });
  if (subjects === null) return;
  mkdirSync(join(gitDir, 'objects'), { recursive: true });
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
  const tree = writeObject(gitDir, 'tree', Buffer.alloc(0));
  let parent = null;
  let stamp = 1000000000;
  for (const subject of subjects) {
    const body = [`tree ${tree}`];
    if (parent) body.push(`parent ${parent}`);
    body.push(`author Drill <drill@example.invalid> ${stamp} +0000`);
    body.push(`committer Drill <drill@example.invalid> ${stamp} +0000`, '', subject, '');
    parent = writeObject(gitDir, 'commit', Buffer.from(body.join('\n'), 'utf8'));
    stamp += 60;
  }
  writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${parent}\n`);
}

const setChangelog = (text) => writeFileSync(join(FIXTURE_ROOT, 'CHANGELOG.md'), text, 'utf8');

const lint = (await import(`${LINT_URL}?fx=1`)).default;
const { SHIPPED_SECTIONS: PINS } = await import('drill-fixture:pins');
const setPins = (entries) => {
  PINS.length = 0;
  PINS.push(...entries);
};

/** Run the lint, optionally capturing the paste-ready lines it writes to
 *  stderr under CHANGELOG_PIN_DUMP. */
function runLint({ dump = false } = {}) {
  const captured = [];
  const original = process.stderr.write.bind(process.stderr);
  if (dump) {
    process.env.CHANGELOG_PIN_DUMP = '1';
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
  }
  try {
    const result = lint();
    return { ...result, dumped: captured.join('').split('\n').filter((l) => l.trim() !== '') };
  } finally {
    if (dump) {
      process.stderr.write = original;
      delete process.env.CHANGELOG_PIN_DUMP;
    }
  }
}

/** Both release-subject spellings, plus the two subjects the lint's comment
 *  says must NOT be adopted. Both shapes are real in this repo — measured on
 *  this tree: 45 `chore(release)` subjects, 35 of the plain spelling and 7 of
 *  `bump to`, the seven measurement D found sitting outside the gate. */
const HISTORY = [
  'chore(release): 9.0.0 - the plain spelling',
  'feat(fixture): unrelated work that mentions 9.9.9 in passing',
  'chore(release): bump to 9.0.1 - the spelling that was invisible',
  'chore(release): Cargo.lock back-fill 9.0.7',
  'chore(release): withdraw the 9.0.8 built from a bad pin',
];

const PREAMBLE = ['# Changelog', '', 'All notable changes to this fixture are documented here.', ''];
const SEC_901 = ['## 9.0.1', '- fixture entry one', '- fixture entry two', ''];
const SEC_900 = ['## 9.0.0', '- fixture entry alpha', '- fixture entry beta', '- fixture entry gamma', ''];
const changelogOf = (...sections) => [...PREAMBLE, ...sections.flat()].join('\n');
const BASE_CHANGELOG = changelogOf(SEC_901, SEC_900);

/** Seed pins the way a human is told to: from the lint's own dump. */
function pinsFromDump() {
  return runLint({ dump: true }).dumped.map((l) => l.trim().replace(/^'/, '').replace(/',$/, ''));
}

/** Reset to the known-green fixture before every case. */
const green = () => {
  setHistory(HISTORY);
  setChangelog(BASE_CHANGELOG);
  setPins(pinsFromDump());
};

try {
  // ── S1 ─────────────────────────────────────────────────────────────────
  section('S1 the module under test is the repo file, with two imports substituted');
  {
    green();
    assertTrue(
      LINT_URL.endsWith('/verify/lint/changelog-release-sections.mjs'),
      'the imported URL is the repo path itself — a query string, not a copy on disk',
    );
    assertTrue(
      sha256(readFileSync(LINT_ABS)) === sha256(readFileSync(fileURLToPath(LINT_URL))),
      'nothing was staged, patched or duplicated to make it importable',
    );
    assertTrue(
      !FIXTURE_ROOT.startsWith(ROOT),
      'the fixture tree lives outside the repo, so no lint or agent sees it as repo content',
    );
    // The substituted ROOT is proved by the verdict, not asserted: it can only
    // count versions that exist nowhere but in the fixture.
    const r = runLint();
    assertTrue(r.status === 'PASS', `the fixture tree starts green (${r.status}: ${r.detail.slice(0, 60)})`);
    assertTrue(
      r.detail.startsWith('2 released version(s)'),
      `the verdict counts the FIXTURE's two releases, not this repo's forty-odd (${r.detail.slice(0, 60)}...)`,
    );
  }

  // ── S2 ─────────────────────────────────────────────────────────────────
  section('S2 measurement A: a renamed heading is caught by the presence half');
  {
    green();
    setChangelog(changelogOf(['## 9.1.0', ...SEC_901.slice(1)], SEC_900));
    const r = runLint();
    assertTrue(r.status === 'FAIL', 'renaming a released heading is refused');
    assertTrue(
      r.detail.includes('1 released version(s) have no CHANGELOG section: 9.0.1'),
      `the presence clause names the version that lost its section (${r.detail.slice(0, 70)}...)`,
    );
    assertTrue(
      r.detail.includes('1 released version(s) no longer have a section to fingerprint: 9.0.1'),
      'the pin half reports the same fact in its OWN clause instead of borrowing the presence message',
    );
    assertTrue(
      r.detail.split(' | ').length === 2,
      'two questions, two clauses in one verdict — the merge is paid down where this repo usually pays for it',
    );
    assertTrue(
      !r.detail.includes('no longer match what was pinned'),
      'a vanished section is not ALSO reported as a changed section',
    );
  }

  // ── S3 ─────────────────────────────────────────────────────────────────
  section('S3 measurements B and C: the two shapes presence alone cannot see');
  {
    // B — the combined-round spelling. It is legitimate elsewhere in the real
    // CHANGELOG, so in a diff it reads as ordinary housekeeping.
    green();
    setChangelog(changelogOf([`## ${combined('9.1.0', '9.0.1')}`, ...SEC_901.slice(1)], SEC_900));
    const b = runLint();
    assertTrue(b.status === 'FAIL', 'B: folding a shipped section under the next version is refused');
    assertTrue(
      !b.detail.includes('have no CHANGELOG section'),
      'B: presence is SATISFIED — every number on a heading counts as documented, which is why this shape was invisible before the pin',
    );
    assertTrue(
      b.detail.includes('1 shipped section(s) no longer match what was pinned: 9.0.1'),
      'B: the pin is the only thing that catches it',
    );
    assertTrue(
      /9\.0\.1 \(pinned 3 lines\/[0-9a-f]{12}, now 3 lines\/[0-9a-f]{12}\)/.test(b.detail),
      `B: SAME line count, different digest — the reader is pointed at a retitle, not at folded-in entries (${b.detail.match(/9\.0\.1 \([^)]*\)/)?.[0]})`,
    );
    assertTrue(
      b.detail.includes('CHANGELOG_PIN_DUMP=1') && b.detail.includes('There is no --fix'),
      'B: the refusal names the deliberate re-pin ceremony and denies an automatic one',
    );

    // C — the body deleted, the heading left standing.
    green();
    setChangelog(changelogOf([SEC_901[0], ''], SEC_900));
    const c = runLint();
    assertTrue(c.status === 'FAIL', 'C: emptying a shipped section is refused');
    assertTrue(
      !c.detail.includes('have no CHANGELOG section'),
      'C: presence is SATISFIED — presence never looked at a body',
    );
    assertTrue(
      /9\.0\.1 \(pinned 3 lines\/[0-9a-f]{12}, now 1 lines\/[0-9a-f]{12}\)/.test(c.detail),
      `C: 3 lines -> 1 line, which is the diagnostic the redundant count exists for (${c.detail.match(/9\.0\.1 \([^)]*\)/)?.[0]})`,
    );
  }

  // ── S4 ─────────────────────────────────────────────────────────────────
  section('S4 measurement D: both release-subject spellings are in scope');
  {
    green();
    // 9.0.1 is released ONLY by a `bump to` subject. Drop its section: a narrow
    // pattern would not know the version exists, so it could not miss it.
    setChangelog(changelogOf(SEC_900));
    setPins(PINS.filter((p) => p.startsWith('9.0.0|')));
    const r = runLint();
    assertTrue(r.status === 'FAIL', 'a version released as `chore(release): bump to x.y.z` is inside the gate');
    assertTrue(
      r.detail.includes('1 released version(s) have no CHANGELOG section: 9.0.1'),
      `and it is named (${r.detail.slice(0, 70)}...)`,
    );

    // The two subjects the pattern must still refuse. Both shapes are real in
    // this repo's history; adopting either invents a release that never was.
    green();
    const ok = runLint();
    assertTrue(
      ok.status === 'PASS' && ok.detail.startsWith('2 released version(s)'),
      `'Cargo.lock back-fill 9.0.7' and 'withdraw the 9.0.8' are not releases of the versions they mention (${ok.status})`,
    );
    assertTrue(
      !ok.detail.includes('9.0.7') && !ok.detail.includes('9.0.8') && !ok.detail.includes('9.9.9'),
      'a version merely MENTIONED in a subject never enters the released list',
    );
  }

  // ── S4b ────────────────────────────────────────────────────────────────
  section('S4b the pre-widening pattern is BLIND to the same tree (mutation control)');
  {
    const occurrences = LINT_SRC.split(WIDENING_TOKEN).length - 1;
    assertTrue(occurrences === 1, `the widening token appears exactly once in the lint source (found ${occurrences})`);

    const mutant = (await import(`${LINT_URL}?fx=1&mutate=narrow`)).default;

    green();
    setChangelog(changelogOf(SEC_900));
    setPins(PINS.filter((p) => p.startsWith('9.0.0|')));
    const mutantVerdict = mutant();
    const realVerdict = runLint();

    assertTrue(
      mutantVerdict.status === 'PASS' && mutantVerdict.detail.startsWith('1 released version(s)'),
      `the pre-widening pattern reports PASS on a tree missing a shipped section (${mutantVerdict.status}: ${mutantVerdict.detail.slice(0, 55)}...)`,
    );
    assertTrue(
      realVerdict.status === 'FAIL' && realVerdict.detail.includes('9.0.1'),
      `... and the shipped pattern convicts the same tree (${realVerdict.detail.slice(0, 55)}...)`,
    );
    assertTrue(
      mutantVerdict.status !== realVerdict.status,
      'the two patterns disagree about the same tree, which is what makes the widening load-bearing (and proves the mutation applied)',
    );
  }

  // ── S5 ─────────────────────────────────────────────────────────────────
  section('S5 the baseline parser refuses instead of skipping, and the shipped pins parse');
  {
    green();
    const good = PINS.find((p) => p.startsWith('9.0.1|'));
    setPins([good.replace(/\|[0-9a-f]{12}\|/, '|nothex000000|'), ...PINS.filter((p) => p.startsWith('9.0.0|'))]);
    const malformed = runLint();
    assertTrue(
      malformed.status === 'FAIL' && malformed.detail.includes('baseline entry(ies) malformed or duplicated'),
      'a malformed entry FAILS',
    );
    assertTrue(
      malformed.detail.includes('1 released version(s) have no pin: 9.0.1'),
      'and it does not become a silent slot — the version it was meant to pin is reported unpinned in its own clause',
    );

    green();
    setPins([...PINS, PINS.find((p) => p.startsWith('9.0.1|'))]);
    const dup = runLint();
    assertTrue(
      dup.status === 'FAIL' && dup.detail.includes('(duplicate entry for 9.0.1)'),
      'a duplicated entry FAILS and names the version it duplicates',
    );

    green();
    setPins([...PINS, '7.7.7|000000000000|9']);
    const stale = runLint();
    assertTrue(
      stale.status === 'FAIL' && stale.detail.includes('1 pinned version(s) are not in the release list: 7.7.7'),
      'a pin for a version nobody released FAILS — it certifies nothing',
    );

    green();
    setPins(PINS.filter((p) => p.startsWith('9.0.0|')));
    const unpinned = runLint();
    assertTrue(
      unpinned.status === 'FAIL' && unpinned.detail.includes('1 released version(s) have no pin: 9.0.1'),
      'the release-day state — commit landed, pin not added yet — is RED by design, not quietly green',
    );

    // Not synthetic, and it cannot be: whether the SHIPPED pins parse is a
    // property of shipped data. Driven through the lint's own parser rather
    // than through a second copy of the format rule.
    green();
    const real = [...(await import(pathToFileURL(BASELINE_ABS).href)).SHIPPED_SECTIONS];
    setPins(real);
    const realParse = runLint();
    assertTrue(
      real.length > 0 && !realParse.detail.includes('malformed or duplicated'),
      `all ${real.length} shipped pins parse and none is duplicated`,
    );
  }

  // ── S6 ─────────────────────────────────────────────────────────────────
  section('S6 what the fingerprint normalises, and what it deliberately does not');
  {
    green();
    const pinned = PINS.slice();

    setChangelog(`${BASE_CHANGELOG.replace('- fixture entry one', '- fixture entry one   ')}\n\n\n`);
    setPins(pinned);
    assertTrue(runLint().status === 'PASS', 'trailing whitespace and trailing blank lines are not an edit');

    setChangelog(BASE_CHANGELOG.replace(/\n/g, '\r\n'));
    setPins(pinned);
    assertTrue(runLint().status === 'PASS', 'a CRLF checkout is not an edit either — this repo develops on Windows');

    setChangelog(changelogOf(['## 9.0.1', '- fixture', '  entry one', '- fixture entry two', ''], SEC_900));
    setPins(pinned);
    const rewrap = runLint();
    assertTrue(
      rewrap.status === 'FAIL' && rewrap.detail.includes('now 4 lines'),
      're-wrapping a shipped line IS an edit — normalisation stops well short of "same words"',
    );

    setChangelog(changelogOf(SEC_901, [`## ${combined('9.0.0', '8.9.9')}`, ...SEC_900.slice(1)]));
    setPins(pinned);
    const heading = runLint();
    assertTrue(
      heading.status === 'FAIL' && heading.detail.includes('9.0.0 (pinned 4 lines'),
      'the heading line is inside the digest, so re-spelling a heading is an edit like any other',
    );
  }

  // ── S7 ─────────────────────────────────────────────────────────────────
  section('S7 a combined heading does not steal ownership from a standalone section');
  {
    setHistory(HISTORY);
    setChangelog(changelogOf(
      [`## ${combined('9.0.1', '9.0.0')}`, '- rolled up', ''],
      SEC_900,
    ));
    setPins([]);
    const dumped = pinsFromDump();
    const forNine = dumped.find((e) => e.startsWith('9.0.0|'));
    assertTrue(
      forNine?.endsWith('|4'),
      `9.0.0 is fingerprinted from its OWN 4-line section, not from the 2-line combined heading above it (${forNine})`,
    );
    assertTrue(
      dumped.find((e) => e.startsWith('9.0.1|'))?.endsWith('|2'),
      'and 9.0.1 is fingerprinted from the combined heading, the only section that names it',
    );
    setPins(dumped);
    assertTrue(runLint().status === 'PASS', 'both are pinned by somebody — neither falls through the gap between them');
  }

  // ── S8 ─────────────────────────────────────────────────────────────────
  section('S8 skips state a reason, the dump cannot move a verdict, and the gate is called');
  {
    green();
    setHistory(['feat: a squashed export carries no release commits', 'docs: nor this one']);
    const squashed = runLint();
    assertTrue(
      squashed.status === 'SKIP' && /squashed export/.test(squashed.detail),
      'no release commits -> SKIP with a reason, never PASS after comparing an empty list to anything',
    );

    // git writes its own `fatal: not a git repository` to fd 2 on the next
    // case. That line is the child process, not this drill: the lint spawns git
    // without capturing stderr, so a caller sees it. Expected output, kept
    // rather than hidden — it is the evidence the SKIP is real.
    setHistory(null);
    const noGit = runLint();
    assertTrue(
      noGit.status === 'SKIP' && /not a git checkout/.test(noGit.detail),
      'no git at all -> SKIP with a reason',
    );

    // 🔴 PINNED AS A KNOWN LIMIT, NOT AS A GOOD PROPERTY. Three different
    // states produce the same two SKIPs, and neither message can tell them
    // apart: an export with squashed history, a SHALLOW clone (actions/checkout
    // defaults to fetch-depth 1, and only verify.yml / verify-linux.yml /
    // verify-macos.yml opt into 0 — for an unrelated reason), and a tree whose
    // recent commits simply are not releases. In all three the gate verifies
    // nothing while naming the export as the cause.
    green();
    setPins(PINS.filter((p) => p.startsWith('9.0.0|')));
    setHistory(['chore(release): 9.0.0 - the plain spelling', 'feat: one later commit']);
    const shallowish = runLint();
    assertTrue(
      shallowish.status === 'PASS',
      'a release commit anywhere in the history counts, not just at the tip',
    );
    setHistory(['feat: the only commit a fetch-depth-1 checkout would carry']);
    const shallow = runLint();
    assertTrue(
      shallow.status === 'SKIP' && shallow.detail === squashed.detail,
      'a shallow clone is indistinguishable from a squashed export here, and both blame the export',
    );

    // A tree that HAS release commits but no CHANGELOG.md throws out of
    // readFileSync. run-all.mjs catches it into `FAIL threw: …`, so it is red —
    // but the message is an ENOENT, not an action. Pinned so nobody "fixes" the
    // throw into a SKIP, which would make a changelog-less tree green.
    green();
    rmSync(join(FIXTURE_ROOT, 'CHANGELOG.md'));
    let threw = null;
    try {
      runLint();
    } catch (err) {
      threw = err;
    }
    assertTrue(
      threw !== null && /ENOENT/.test(String(threw.message)),
      'a tree with releases and no CHANGELOG.md throws rather than returning any status at all',
    );

    green();
    setChangelog(BASE_CHANGELOG.replace('- fixture entry two', '- fixture entry TWO'));
    const quiet = runLint();
    const loud = runLint({ dump: true });
    assertTrue(
      quiet.status === loud.status && quiet.detail === loud.detail,
      'CHANGELOG_PIN_DUMP changes what reaches stderr and nothing about the verdict',
    );
    assertTrue(
      loud.dumped.length === 2 && loud.dumped.every((l) => /^'\d+\.\d+\.\d+\|[0-9a-f]{12}\|\d+',$/.test(l.trim())),
      'the dump emits paste-ready baseline entries, one per released version',
    );
    // The property every section above leans on: the dump's output, pasted
    // back, is green. Asserted rather than assumed.
    setPins(loud.dumped.map((l) => l.trim().replace(/^'/, '').replace(/',$/, '')));
    assertTrue(runLint().status === 'PASS', "the dump's own output, pasted into the baseline, is green");

    assertTrue(
      /import changelogReleaseSections from '\.\/changelog-release-sections\.mjs';/.test(RUN_ALL_SRC)
        && /\{ name: 'changelog-release-sections', run: changelogReleaseSections \}/.test(RUN_ALL_SRC),
      'run-all.mjs both imports AND registers it — an import with no table row runs nothing',
    );
    const envUses = LINT_SRC.match(/process\.env\.[A-Z_]+/g) ?? [];
    assertTrue(
      envUses.length === 1 && envUses[0] === 'process.env.CHANGELOG_PIN_DUMP',
      `no env switch can soften this gate; the only one it reads is the dump (${envUses.join(', ') || 'none'})`,
    );
    assertTrue(
      !/writeFileSync|appendFileSync|writeFile\(/.test(LINT_SRC),
      'the lint cannot write a file at all, which is what "there is no --fix" means mechanically',
    );

    // The guard the corrupted-restore incident earns: this drill must leave the
    // repo's own CHANGELOG.md byte-identical.
    assertTrue(
      REPO_CHANGELOG_SHA !== null && sha256(readFileSync(REPO_CHANGELOG)) === REPO_CHANGELOG_SHA,
      `the repo's CHANGELOG.md is byte-identical to what it was before this drill ran (sha256 ${String(REPO_CHANGELOG_SHA).slice(0, 12)}...)`,
    );
  }
} finally {
  delete process.env.GIT_CEILING_DIRECTORIES;
  if (savedCeiling !== undefined) process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\nx changelog-release-sections drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\nx drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections - a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n+ changelog-release-sections drill PASSED');

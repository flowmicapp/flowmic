// Drill for scripts/build-stamp/require-clean-sha.mjs — card SC-5.
//
// The rule it drills: a build stamp names the commit its bytes came from, and
// bytes that match no commit do not get to claim one. Three states, three
// different outcomes, and the drill is here because two of them are refusals —
// a refusal nobody ever exercised is a refusal nobody knows still works.
//
// WHY IT LIVES AT scripts/ AND NOT scripts/build-stamp/: scripts/run-script-tests.mjs
// discovers `scripts/*.test.mjs` — ONE directory, deliberately (its header
// explains why discovery beats a hand-kept list). A drill one level down would
// be invisible to it, which is the exact 「测试写了没人叫 = façade 的运行时版」
// shape that runner exists to prevent. The subject it drills is named in full
// in the line below, so the export's test/subject pairing still resolves it:
//   subject: scripts/build-stamp/require-clean-sha.mjs
//
// The git seam is injected for the three deterministic cases (no temp repo, no
// disk, no chance of touching this working tree) and then the REAL repo is used
// once, because a rule proven only against a fake answers only about the fake.

import {
  ALLOW_DIRTY_ENV,
  ALLOW_NO_GIT_ENV,
  DIRTY_PREFIX,
  NOGIT_VALUE,
  REPO_ROOT,
  STAMP_PREFIX,
  resolveBuildSha,
  stampFor,
} from './build-stamp/require-clean-sha.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function throws(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, got a value');
}

const SHA = 'a1b2c3d4e5f6'.repeat(3) + 'abcd'; // 40 lowercase hex, like `git rev-parse HEAD`
const fakeGit = (status) => (args) => {
  if (args[0] === 'rev-parse') return `${SHA}\n`;
  if (args[0] === 'status') return status;
  return null;
};

console.log('\n§1 a clean tree stamps the commit');
check('clean -> the full sha, form=clean', () => {
  const r = resolveBuildSha({ env: {}, root: REPO_ROOT, git: fakeGit('') });
  assert(r.value === SHA, `expected ${SHA}, got ${r.value}`);
  assert(r.form === 'clean', `form ${r.form}`);
  assert(stampFor(r.value) === `${STAMP_PREFIX}${SHA}`, 'stampFor must prefix the value');
});

console.log('\n§2 a dirty tree is REFUSED, and the refusal says what to do');
check('dirty -> throws, naming the entries and the consequence', () => {
  const e = throws(() => resolveBuildSha({ env: {}, root: REPO_ROOT, git: fakeGit(' M apps/mobile/lib/main.dart\n?? scratch.txt\n') }));
  assert(/DIRTY tree \(2 entries\)/.test(e.message), `message did not count the entries: ${e.message}`);
  assert(e.message.includes('apps/mobile/lib/main.dart'), 'the refusal must name what is dirty');
  assert(e.message.includes('correspond to no commit'), 'the refusal must say WHY, not just that');
  assert(e.message.includes(ALLOW_DIRTY_ENV), 'the refusal must name its own override');
});
check('a failed `git status` is DIRTY, not clean', () => {
  const e = throws(() =>
    resolveBuildSha({
      env: {},
      root: REPO_ROOT,
      git: (args) => (args[0] === 'rev-parse' ? `${SHA}\n` : null),
    }),
  );
  assert(/DIRTY/.test(e.message), `an unknown answer must not read as the reassuring one: ${e.message}`);
});

console.log('\n§3 the override stamps `dirty-<sha>`, which the publish gate refuses BY NAME');
check('FLOWMIC_ALLOW_DIRTY_BUILD=1 -> dirty- prefix, sha preserved', () => {
  const r = resolveBuildSha({ env: { [ALLOW_DIRTY_ENV]: '1' }, root: REPO_ROOT, git: fakeGit(' M x\n') });
  assert(r.value === `${DIRTY_PREFIX}${SHA}`, `expected ${DIRTY_PREFIX}${SHA}, got ${r.value}`);
  assert(r.form === 'dirty', `form ${r.form}`);
  assert(r.sha === SHA, 'the sha itself is still carried, so a human can see which commit it diverged from');
});
check('the override is EXACTLY "1" — no truthiness', () => {
  const e = throws(() => resolveBuildSha({ env: { [ALLOW_DIRTY_ENV]: 'true' }, root: REPO_ROOT, git: fakeGit(' M x\n') }));
  assert(/DIRTY/.test(e.message), 'an override spelled differently must not open the door');
});

console.log('\n§4 no git answer -> refused, unless explicitly waived');
check('no git -> throws, naming the escape hatch and what it costs', () => {
  const e = throws(() => resolveBuildSha({ env: {}, root: REPO_ROOT, git: () => null }));
  assert(e.message.includes(ALLOW_NO_GIT_ENV), 'the refusal must name its own override');
  assert(e.message.includes('GATE 0f'), 'the refusal must say where the hazard becomes fatal');
});
check('FLOWMIC_BUILD_ALLOW_NO_GIT=1 -> `nogit`, which GATE 0f refuses by name', () => {
  const r = resolveBuildSha({ env: { [ALLOW_NO_GIT_ENV]: '1' }, root: REPO_ROOT, git: () => null });
  assert(r.value === NOGIT_VALUE, `expected ${NOGIT_VALUE}, got ${r.value}`);
  assert(r.sha === null, 'there is no sha to carry');
});
check('a TRUNCATED sha is not a sha', () => {
  const e = throws(() =>
    resolveBuildSha({ env: {}, root: REPO_ROOT, git: (a) => (a[0] === 'rev-parse' ? 'abc123\n' : '') }),
  );
  assert(e.message.includes('full commit id'), `short sha must be refused: ${e.message}`);
});

console.log('\n§5 against the REAL repository — a rule proven only against a fake answers only about the fake');
check('the real tree gets either its real HEAD or a refusal naming its real dirt', () => {
  let r = null;
  let err = null;
  try {
    r = resolveBuildSha({ env: {} });
  } catch (e) {
    err = e;
  }
  if (r) {
    assert(/^[0-9a-f]{40}$/.test(r.value), `a clean tree must stamp a 40-hex sha, got ${r.value}`);
    console.log(`       (this tree is clean: ${r.value.slice(0, 12)}…)`);
  } else {
    assert(/DIRTY tree/.test(err.message), `unexpected refusal: ${err.message}`);
    console.log(`       (this tree is dirty, and the refusal named it — first line: ${err.message.split('\n')[1]?.trim()})`);
  }
});

if (failures > 0) {
  console.log(`\nFAILED ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK all assertions passed');
process.exit(0);

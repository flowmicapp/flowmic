#!/usr/bin/env node
// Drill for verify/lint/worktree-location.mjs — the gate behind the owner's
// 2026-08-18 ruling that no project development tree goes on the system drive.
//
// WHY A DRILL AND NOT JUST THE LINT: on the day the rule was made, the two
// offending worktrees had already been deleted. A lint that is green because
// the machine happens to be clean proves the machine, not the gate. So the
// judgement lives in an exported pure function (`classifyWorktrees`) and this
// file feeds it a system-drive worktree this machine does not have. If the
// gate ever stops catching one, §2 goes red here rather than on the day
// someone parks 1.2 GB on C: again.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { tmpdir } from 'node:os';
import worktreeLocation, { classifyWorktrees, normalisePath } from '../verify/lint/worktree-location.mjs';

const BACKSLASH = String.fromCharCode(92); // written this way so no escape layer can eat it

let failures = 0;
let sections = 0;
const ok = (name) => console.log(`  ok  ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

// A Windows-shaped temp path and a POSIX-shaped one, so the drill measures the
// same rule on either platform rather than skipping half of itself.
// Fabricated paths on purpose: a real checkout path here would be a corporate
// absolute path shipped to the public tree (oss-absent-sweep refuses those, and
// caught exactly that on the first commit attempt of this file).
const WIN = process.platform === 'win32';
const REPO = WIN ? 'F:/repos/flowmic-app' : '/srv/flowmic-app';
const TMP = WIN ? 'C:/Users/someone/AppData/Local/Temp' : '/tmp';
const GOOD_LINKED = WIN
  ? 'F:/repos/flowmic-app-worktrees/task-1'
  : '/srv/flowmic-app-worktrees/task-1';
const IN_TEMP = `${TMP}/claude/session/scratchpad/rel064`;

console.log('=== §1 a clean layout reports no offender (positive control) ===');
sections += 1;
{
  const r = classifyWorktrees({ paths: [REPO, GOOD_LINKED], tmp: TMP });
  check(r.offenders.length === 0, 'sibling -worktrees/ dir on the repo volume is accepted', JSON.stringify(r.offenders));
  check(r.linked === 1, 'the linked worktree was actually examined, not skipped', `linked=${r.linked}`);
}

console.log('=== §2 REVERSE CONTROL: a worktree in system temp must be caught ===');
sections += 1;
{
  const r = classifyWorktrees({ paths: [REPO, IN_TEMP], tmp: TMP });
  check(r.offenders.length === 1, 'the temp-dir worktree is reported', JSON.stringify(r.offenders));
  check(
    r.offenders[0]?.why.includes('system temp'),
    'the reason names system temp, so the reader knows what to do',
    r.offenders[0]?.why
  );
  check(r.offenders[0]?.path === IN_TEMP, 'the offender is named by path', r.offenders[0]?.path);
}

console.log('=== §3 REVERSE CONTROL: a worktree on another volume must be caught ===');
sections += 1;
if (!WIN) {
  console.log('  --  volume test is vacuous on POSIX (one root) — see lint header');
  ok('skipped by design, not by accident');
} else {
  const r = classifyWorktrees({ paths: [REPO, 'C:/dev/flowmic-elsewhere'], tmp: TMP });
  check(r.offenders.length === 1, 'the off-volume worktree is reported', JSON.stringify(r.offenders));
  check(r.offenders[0]?.why.includes('volume'), 'the reason names the volume mismatch', r.offenders[0]?.why);
}

console.log('=== §4 the MAIN worktree is exempt (CI would be red otherwise) ===');
sections += 1;
{
  // CI checks out into the runner's own volume; on windows-latest that is D:\a.
  const r = classifyWorktrees({ paths: [`${TMP}/ci/checkout`], tmp: TMP });
  check(r.offenders.length === 0, 'a main worktree inside temp is not an offender', JSON.stringify(r.offenders));
  check(r.linked === 0, 'and it is counted as the main tree, not as a linked one', `linked=${r.linked}`);
}

console.log('=== §5 case and separator folding (AppData vs appdata, backslash vs slash) ===');
sections += 1;
{
  const winMixed = ['C:', 'Users', 'someone', 'AppData', 'Local', 'Temp', 'x', 'wt'].join(BACKSLASH);
  const r = classifyWorktrees({
    paths: [REPO, WIN ? winMixed : '/tmp/x/wt'],
    tmp: WIN ? 'c:/users/someone/appdata/local/temp' : '/tmp',
  });
  check(r.offenders.length === 1, 'a differently-cased/separated temp path is still caught', JSON.stringify(r.offenders));
  check(
    normalisePath(`F:${BACKSLASH}A${BACKSLASH}B${BACKSLASH}`) === normalisePath('f:/a/b'),
    'normalisePath folds case, separators and the trailing slash'
  );
}

console.log('=== §6 the lint itself runs on this tree and answers ===');
sections += 1;
{
  const res = await worktreeLocation();
  check(['PASS', 'FAIL', 'SKIP'].includes(res.status), 'lint returned a known status', res.status);
  check(typeof res.detail === 'string' && res.detail.length > 0, 'lint returned a human-readable detail');
  // Not asserting PASS: this drill must not depend on how the machine running
  // it happens to be laid out. §2/§3 are what prove the gate has teeth.
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
  check(
    !res.detail.includes('the parse is broken'),
    'the porcelain parse found at least the main worktree (check your ruler first)',
    res.detail
  );
}

console.log(
  `\n${failures === 0 ? '✔' : '✗'} worktree-location — sections run ${sections}/6, ` +
    `${failures} assertion failure(s), tmpdir=${tmpdir()}`
);
process.exit(failures === 0 ? 0 : 1);

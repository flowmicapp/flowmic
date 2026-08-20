// verify/lint/worktree-location.mjs
// Linked git worktrees must live on the repository's own volume, and never
// under the system temp directory.
//
// WHY THIS FILE EXISTS (measured 2026-08-18, owner ruling the same day):
// A disk sweep found two linked worktrees parked under the agent scratchpad at
// `C:\Users\...\AppData\Local\Temp\claude\...\scratchpad\{rel064,wp8-accept}`,
// holding 1.2 GB and 157 MB. The system volume had 8.5 GB free at the time.
// Neither worktree carried a commit that was not already in `main` — they were
// pure cost. The owner's ruling: no project development tree may be created on
// the system drive from now on.
//
// A worktree is not a scratch file. It is a full checkout plus whatever the
// build leaves behind (this repo's desktop `target/` alone measured 7.0 GB in
// the tree that triggered this sweep), and nothing prunes it when the session
// that made it ends. The harness points temporary files at a scratchpad on the
// system drive by design, and that is right for a few KB of notes; it is wrong
// for a checkout. This gate draws that line where a machine can see it.
//
// 🔴 WHAT THIS GATE DOES *NOT* COVER — read before trusting a PASS.
// It sees git worktrees, because `git worktree list` is a thing a machine can
// ask. It cannot see a hand-copied source tree, a stray `node_modules`, or a
// build output directory someone pointed at the system drive; those have no
// registry to enumerate. So a PASS here means "no linked worktree is misplaced",
// NOT "the rule was followed". The rest of the rule lives in CLAUDE.md and is
// carried by people. Saying otherwise would make this lint answer a question it
// did not measure — the shape this repo calls 一个值答了两个问题.
//
// ⚠️ The MAIN worktree is exempt on purpose, and that is not a hole. Its
// location is not a choice anyone makes at worktree-creation time: it is
// wherever the checkout already is, which on CI is the runner's own volume
// (`D:\a\...` on windows-latest, `/home/runner/work` on ubuntu). Flagging it
// would make this gate red on every CI run while measuring nothing anyone can
// act on.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, parse as parsePath, dirname, basename, join } from 'node:path';
import { ROOT as root } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/worktree-location.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

const BACKSLASH = String.fromCharCode(92);

/**
 * 🔴 WHY realpath AND NOT JUST A STRING FOLD (measured 2026-08-18, live reverse
 * control): on this machine `os.tmpdir()` answers with the 8.3 short name
 * `C:\Users\ADMINI~1\AppData\Local\Temp`, while `git worktree list` prints the
 * long name `C:\Users\Administrator\...`. Those two strings are not equal, so
 * the first version of this gate reported a real system-temp worktree as merely
 * "off-volume" and would have missed it entirely on a machine whose repo lives
 * on C:. The ruler and the thing measured were writing the same path two ways.
 * `realpathSync.native` resolves both to the same long form.
 *
 * 🔴 AND WHY A MISSING PATH RESOLVES ITS DEEPEST EXISTING ANCESTOR instead of
 * being folded as-is (measured 2026-08-20, the public repo's macOS gate): on
 * macOS `os.tmpdir()` lives under `/var/folders/…`, which is a symlink into
 * `/private/var/…` — and `/tmp` itself is a symlink to `/private/tmp`. The
 * ruler (tmpdir, which exists) resolved to `/private/...` while a fabricated
 * or already-deleted worktree path under it (which does not exist) kept its
 * `/tmp/...` spelling — the same one-place-two-spellings defect this comment
 * already records for Windows short names, just wearing a symlink. A real
 * worktree deleted without `git worktree prune` would have slipped through the
 * same hole in production use, so this is a lint fix, not a drill appeasement:
 * walk up to the deepest ancestor that IS on disk, resolve that, re-attach the
 * missing tail. A path with no existing ancestor at all (a fabricated volume)
 * stays as given.
 */
export function normalisePath(p) {
  const abs = resolve(p);
  const real = resolveExistingPrefix(abs);
  return real.split(BACKSLASH).join('/').replace(/\/+$/, '').toLowerCase();
}

function resolveExistingPrefix(abs) {
  let dir = abs;
  const tail = [];
  for (;;) {
    try {
      const resolved = realpathSync.native(dir);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs; // hit the root without finding anything on disk
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

function isUnder(child, parent) {
  if (!parent) return false;
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The whole judgement, as a pure function so the drill can feed it a path this
 * machine does not have. `scripts/worktree-location.test.mjs` calls this with a
 * fabricated system-drive worktree; without that, a green day would only prove
 * the day was green.
 *
 * @param {{paths: string[], tmp: string}} input — `paths[0]` is the main
 *   worktree (git always lists it first); the rest are linked.
 * @returns {{linked: number, volume: string, offenders: Array<{path: string, why: string}>}}
 */
export function classifyWorktrees({ paths, tmp }) {
  const [mainPath, ...linked] = paths;
  const tmpNorm = tmp ? normalisePath(tmp) : '';
  // parsePath().root is `F:\` on Windows and `/` on POSIX. On POSIX every path
  // shares one root, so the volume test is vacuously true there — deliberately
  // not faked into something stricter, because no POSIX failure has been seen.
  const mainVolume = parsePath(resolve(mainPath)).root;
  const mainVolumeNorm = normalisePath(mainVolume);

  const offenders = [];
  for (const p of linked) {
    const n = normalisePath(p);
    const reasons = [];
    if (tmpNorm && isUnder(n, tmpNorm)) reasons.push(`under the system temp directory (${tmp})`);
    if (normalisePath(parsePath(resolve(p)).root) !== mainVolumeNorm) {
      reasons.push(`on volume ${parsePath(resolve(p)).root} while the repo is on ${mainVolume}`);
    }
    if (reasons.length) offenders.push({ path: p, why: reasons.join('; ') });
  }
  return { linked: linked.length, volume: mainVolume, offenders };
}

export default async function worktreeLocation() {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // An export tarball or a non-git checkout has no worktrees to misplace.
    return { status: 'SKIP', detail: 'git worktree list unavailable — not a git checkout, or git is missing' };
  }

  const paths = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);

  if (paths.length === 0) {
    // git answered but named nothing: the parse is wrong, not the tree. Failing
    // loudly beats reporting "0 misplaced" from a broken read (先核你的尺子).
    return { status: 'FAIL', detail: 'git worktree list --porcelain named no worktree — the parse is broken, not the tree' };
  }

  const { linked, volume, offenders } = classifyWorktrees({ paths, tmp: tmpdir() });

  if (offenders.length) {
    const suggest = join(dirname(resolve(root)), basename(resolve(root)) + '-worktrees', '<name>');
    return {
      status: 'FAIL',
      detail:
        `${offenders.length}/${linked} linked worktree(s) off the repo volume or in system temp: ` +
        offenders.map((o) => `${o.path} — ${o.why}`).join(' | ') +
        `. Move it with \`git worktree move <old> <new>\`, or remove it if it holds no commit ` +
        `\`main\` lacks (check: git log --oneline main..<branch>). Convention here: ${suggest}`,
    };
  }

  return {
    status: 'PASS',
    detail:
      `${linked} linked worktree(s), all on ${volume} and outside ${tmpdir()} ` +
      `(main worktree exempt by design — see file header; hand-made non-git trees are NOT covered)`,
  };
}

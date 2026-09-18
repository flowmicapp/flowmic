// scripts/build-stamp/require-clean-sha.mjs
// Card SC-5 (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §4 R1,
// §5 SC-5). ONE place that answers "which commit are the bytes we are about to
// build made from", for every artifact this repo builds from source.
//
// ── THE RISK IT EXISTS FOR (R1) ─────────────────────────────────────────────
//
// The eight-minute ship chain starts `tauri build` and `flutter build` at t=0,
// in parallel with the gate, in warm worktrees with a warm `target/` and warm
// Gradle caches. Everything about that is faster and nothing about it is safer:
// the gate writes a receipt naming a sha (scripts/gate-receipt.mjs), and
// NOTHING in the old chain could tell whether the exe and the APK were made
// from that same commit. A rebuild that no-ops on a warm tree, a build started
// before the last `git commit`, a lane merged mid-flight — all three publish
// bytes the receipt does not describe, and all three look exactly like a
// correct round.
//
// server-core / stt-cloud / the web dist already stamp their commit
// (scripts/build-stamp/source-stamp.mjs, and the web repo's buildStampPlugin);
// the desktop exe and the APK were the two artifacts carrying no commit at all.
// This module is the rule they both now use, and scripts/publish.mjs GATE 0f is
// the reader that refuses when the stamp and the receipt disagree.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   clean tree                   -> `<sha40>`
//   dirty tree                   -> REFUSE. Those bytes correspond to no
//                                   commit, so no rollback can reproduce them
//                                   and no receipt can describe them.
//     ...with FLOWMIC_ALLOW_DIRTY_BUILD=1 -> `dirty-<sha40>`, a value GATE 0f
//                                   refuses BY NAME. The override exists so a
//                                   developer can build a half-finished tree,
//                                   not so a release can slip through: the
//                                   hazard stays loud at the only moment where
//                                   it is fatal.
//   not a git checkout / no git  -> REFUSE, ...with FLOWMIC_BUILD_ALLOW_NO_GIT=1
//                                   -> `nogit`, also refused by name. Same
//                                   stance, and deliberately the same spelling,
//                                   as the relay bundle stamp (source-stamp.mjs).
//
// 🔴 A NULL ANSWER IS TREATED AS DIRTY, NOT CLEAN. `git status` failing tells us
// nothing; reading "nothing came back" as "nothing is wrong" is how an unknown
// becomes the reassuring answer. Same stance as source-stamp.mjs.
//
// ── WHY DIRTINESS IS A BARE `git status --porcelain` HERE, UNLIKE source-stamp
//
// source-stamp.mjs scopes dirtiness to declared build inputs, because it runs
// from INSIDE a tsup config, at a moment when tsup has already written its own
// temp file into the package directory — a bare status would call every build
// dirty. This module runs BEFORE any builder starts, from a shell, so it has no
// such blind spot, and the stricter question is the right one: the receipt this
// stamp is compared against fingerprints the whole tree (tracked changes plus
// untracked, non-ignored files), so anything narrower would let the two
// disagree about what "this tree" means.
//
// ── WHO CALLS IT ────────────────────────────────────────────────────────────
//
//   · scripts/build-stamp/with-build-sha.mjs — the runner that puts the value
//     into the build: FLOWMIC_BUILD_SHA in the child env (read by
//     apps/desktop/src-tauri/build.rs) and substituted for `{sha}` in the
//     child argv (`--dart-define=FLOWMIC_BUILD_SHA={sha}` in
//     apps/mobile/Makefile). One rule, two delivery shapes.
//   · scripts/build-stamp/artifact-sha-gate.mjs — for STAMP_PREFIX and the
//     refused forms, so the gate refusal text and the builder output quote one
//     source instead of two.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** The literal the built artifact carries, immediately followed by the value.
 *  A prefix rather than a bare sha so the byte scan can tell three states
 *  apart: stamped with the right sha, stamped with something else, and not
 *  stamped at all. A bare 40-hex needle could only ever answer the first. */
export const STAMP_PREFIX = 'flowmic-build-sha:';

/** What the Rust/Dart side stamps when no build sha reached it at all — a plain
 *  `cargo check`, `flutter test`, an IDE build. NOT an error there: those builds
 *  are not artifacts. It is an error at publish time, which is where GATE 0f
 *  refuses it by this name. */
export const UNSTAMPED_VALUE = 'unstamped-dev';

export const DIRTY_PREFIX = 'dirty-';
export const NOGIT_VALUE = 'nogit';

export const ALLOW_DIRTY_ENV = 'FLOWMIC_ALLOW_DIRTY_BUILD';
export const ALLOW_NO_GIT_ENV = 'FLOWMIC_BUILD_ALLOW_NO_GIT';

/** The env var the builders read. Named here so build.rs, the Makefile, the
 *  runner and the gate all quote one string. */
export const BUILD_SHA_ENV = 'FLOWMIC_BUILD_SHA';

function realGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const STATUS_FAILED_LINE = '(git status failed - treated as dirty, see this module header)';

/**
 * Resolve the value to stamp into an artifact built from `root`.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.root]
 * @param {(args:string[], cwd:string)=>string|null} [opts.git] — the seam the
 *   drill drives; production passes nothing.
 * @returns {{value:string, form:'clean'|'dirty'|'nogit', sha:string|null, dirtyLines:string[]}}
 * @throws {Error} on a dirty tree or a missing git answer without the matching
 *   explicit override. The message names the artifact-level consequence, not
 *   just the condition — a refusal nobody can act on gets overridden.
 */
export function resolveBuildSha({ env = process.env, root = REPO_ROOT, git = realGit } = {}) {
  const headRaw = git(['rev-parse', 'HEAD'], root);
  const head = headRaw === null ? null : String(headRaw).trim();
  if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
    if (env[ALLOW_NO_GIT_ENV] === '1') {
      return { value: NOGIT_VALUE, form: 'nogit', sha: null, dirtyLines: [] };
    }
    throw new Error(
      'cannot stamp this build: `git rev-parse HEAD` did not return a full commit id ' +
        '(this is not a git checkout, or git is not on PATH).\n' +
        '  The stamp is what lets scripts/publish.mjs prove the exe/APK it is staging came from ' +
        'the commit the gate receipt names; bytes without one cannot answer that at all.\n' +
        `  Set ${ALLOW_NO_GIT_ENV}=1 to build anyway with a \`${NOGIT_VALUE}\` stamp — publish GATE 0f ` +
        'refuses that value by name.',
    );
  }

  const porcelain = git(['status', '--porcelain'], root);
  // null = the status call itself failed. Dirty, not clean: an unknown answer
  // must not read as the reassuring one.
  const dirtyLines =
    porcelain === null
      ? [STATUS_FAILED_LINE]
      : String(porcelain)
          .split('\n')
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0);

  if (dirtyLines.length > 0) {
    if (env[ALLOW_DIRTY_ENV] === '1') {
      return { value: `${DIRTY_PREFIX}${head}`, form: 'dirty', sha: head, dirtyLines };
    }
    const shown = dirtyLines.slice(0, 10).map((l) => `      ${l}`).join('\n');
    const more = dirtyLines.length > 10 ? `\n      ... ${dirtyLines.length - 10} more` : '';
    throw new Error(
      `refusing to stamp a build made from a DIRTY tree (${dirtyLines.length} ` +
        `${dirtyLines.length === 1 ? 'entry' : 'entries'}):\n` +
        `${shown}${more}\n` +
        '  These bytes correspond to no commit: nothing can rebuild them, no rollback can ' +
        'reproduce them, and the gate receipt cannot describe them.\n' +
        `  Commit (or stash) first. For a throwaway local build, ${ALLOW_DIRTY_ENV}=1 stamps ` +
        `\`${DIRTY_PREFIX}<sha>\` — publish GATE 0f refuses that value by name, deliberately.`,
    );
  }

  return { value: head, form: 'clean', sha: head, dirtyLines: [] };
}

/** The full literal an artifact carries for `value`. One function so the builder
 *  and the scanner cannot spell it differently. */
export function stampFor(value) {
  return `${STAMP_PREFIX}${value}`;
}

export function main() {
  try {
    const r = resolveBuildSha({ root: REPO_ROOT });
    // stdout is the VALUE alone, nothing else, so `$(node ...)` is usable; the
    // human sentence goes to stderr.
    process.stdout.write(`${r.value}\n`);
    if (r.form !== 'clean') {
      process.stderr.write(
        `warning: build stamp is \`${r.value}\` (${r.form}) — publish GATE 0f refuses it by name.\n`,
      );
    }
    return 0;
  } catch (e) {
    process.stderr.write(`x ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}

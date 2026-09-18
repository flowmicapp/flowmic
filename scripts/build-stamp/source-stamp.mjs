// scripts/build-stamp/source-stamp.mjs
// The one place that turns "which git commit is this working tree on" into the
// bytes stamped INTO a relay bundle at build time.
//
// ── WHY THIS EXISTS (ledger NR-51, §39) ─────────────────────────────────────
//
// The relay deploy (web repo, deploy/deploy-vps-app.py) used to assert only
// that apps/server-core/dist/index.js and packages/protocol/dist/index.js
// EXIST, and only that packages/stt-cloud/dist/index.cjs carries the right
// VERSION. Neither "exists" nor "version matches" can answer "was this built
// from the CURRENT HEAD" — src/ keeps changing inside one version, dist stays
// old, and every gate stays green (the stt-cloud stamp's own header admits it
// is "the stronger half of an incomplete pair"). NR-26 closed the web half by
// stamping the commit; this is the relay half, independent of that one because
// the two stamp DIFFERENT repos' HEADs (ledger §39: hard-sharing the web stamp
// would re-mix "which repo is stale").
//
// ── WHAT IT RETURNS, AND WHAT IT REFUSES ────────────────────────────────────
//
//   sourceStamp(prefix, version, buildInputs) → `${prefix}${version}+<sha40>[.dirty]`
//
// `<sha40>` is the full `git rev-parse HEAD`. `.dirty` is appended when the
// build-input paths (see below) carry uncommitted changes — those bytes
// correspond to no commit, so a rollback cannot reproduce them. A `null` status
// answer is treated as dirty, not clean: an unknown answer must not read as the
// reassuring one (the web repo's buildStampPlugin takes the same stance).
//
// git unavailable (a tarball build, git not on PATH, not a checkout) FAILS the
// build rather than stamping a lie — 宁红不盲, same stance the stt-cloud version
// stamp took about a malformed version. FLOWMIC_BUILD_ALLOW_NO_GIT=1 is the
// explicit escape hatch: it stamps `+nogit` (no sha), which the deploy gate
// refuses by name, so the hazard stays loud at the only moment where it is
// fatal.
//
// ── WHY DIRTINESS IS SCOPED TO buildInputs, NOT A BARE `git status` ─────────
//
// This function runs at the TOP of a tsup.config.ts, i.e. while tsup is still
// LOADING that config. Measured 2026-09-16: at that moment tsup has already
// written its own temporary bundled config — `apps/server-core/tsup.config.
// bundled_<rand>.mjs` (or the stt-cloud equivalent) — into the package dir, and
// a bare `git status --porcelain` sees that untracked temp file and reports the
// tree dirty on EVERY build, clean or not. The temp file is build machinery,
// not a build input, so dirtiness is judged against the paths that actually
// change the emitted bytes — the same stance the web repo's buildStampPlugin
// takes (its BUILD_INPUT_PATHS, "deliberately NOT a bare git status"). The list
// is a judgement and lives beside each caller; its known gaps (node_modules, the
// root package.json version the deploy compares against) are documented there.

import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} prefix — e.g. 'flowmic-stt-cloud-build@'
 * @param {string} version — the package version the caller already validated
 * @param {string[]} buildInputs — git pathspecs (repo-root-relative) whose
 *   content changes the bundle
 * @returns {string} `${prefix}${version}+<sha40>[.dirty]`, or throws.
 */
export function sourceStamp(prefix, version, buildInputs) {
  // tsup runs the config with cwd = the package dir (apps/server-core or
  // packages/stt-cloud). Pathspecs in buildInputs are repo-root-relative, so
  // every git call below runs from the repo toplevel — otherwise a pathspec like
  // `apps/server-core/src` would be re-anchored to the package dir and match
  // nothing, and the tree would read clean while actually dirty.
  const toplevel = git(['rev-parse', '--show-toplevel']);
  const head = git(['rev-parse', 'HEAD'], toplevel ?? undefined);
  if (head === null || !/^[0-9a-f]{40}$/.test(head)) {
    if (process.env.FLOWMIC_BUILD_ALLOW_NO_GIT === '1') {
      return `${prefix}${version}+nogit`;
    }
    throw new Error(
      `${prefix}: cannot stamp the bundle — \`git rev-parse HEAD\` did not return a ` +
        `full commit id (this is not a git checkout, or git is not on PATH). The stamp ` +
        `exists so a deploy can prove the bundle matches the tree it ships from; a build ` +
        `without one would be shipping bytes that cannot answer that question at all. ` +
        `Set FLOWMIC_BUILD_ALLOW_NO_GIT=1 to build anyway with a +nogit stamp — the deploy ` +
        `gate refuses +nogit by name.`,
    );
  }
  const porcelain = git(['status', '--porcelain', '--', ...buildInputs], toplevel ?? undefined);
  // null = the status call itself failed. Dirty, not clean, for the reason in
  // the header: an unknown answer must not read as the reassuring one.
  const dirty = porcelain === null || porcelain.length > 0;
  return `${prefix}${version}+${head}${dirty ? '.dirty' : ''}`;
}

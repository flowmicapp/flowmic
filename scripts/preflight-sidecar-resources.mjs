// BUILD-1 — make the missing staged sidecar payload say what to DO about it.
//
// THE DEFECT THIS CLOSES (WP3 review §3-1). Every one of the four paths in
// `tauri.conf.json`'s `bundle.resources` is gitignored (measured: `git
// check-ignore -v` names .gitignore lines 12 / 17 / 34 / 45). They are produced
// by `pnpm --filter @flowmic/desktop build:sidecar`. On a fresh clone — and in
// the open-source export tree, which is the case that matters, because that
// reader has no window in which someone tells them — the first cargo leg that
// carries `--features app` runs `tauri_build::build()` (see
// apps/desktop/src-tauri/build.rs) and dies with:
//
//     resource path `resources\node_modules` doesn't exist
//
// That sentence names a PATH. It does not name the command that creates the
// path, it does not say the path is supposed to be absent from git, and it does
// not say which of the four is missing when several are. A newcomer's honest
// next move is to `mkdir resources\node_modules`, which produces a build that
// gets further and is wrong.
//
// 🔴 WHY THIS DOES NOT AUTO-RUN `build:sidecar`, since that is the obvious
// "friendlier" version and it is the wrong one. Auto-running would make the
// dependency invisible: the gate would silently rebuild a 90 MB payload as a
// side effect of asking for a lint, and the day that build itself breaks the
// error surfaces somewhere with no relation to what anyone typed. The repo has
// a name for the shape where one action quietly performs a second, unrelated
// one. A preflight's whole job is to make a missing prerequisite VISIBLE and
// hand back the command — so the human runs it, once, knowing they ran it.
//
// 🔴 THE REQUIRED LIST IS DERIVED, NOT RETYPED. It is read out of the same
// `tauri.conf.json` that `tauri_build::build()` validates, so this check cannot
// drift from the thing it is standing in front of. A hand-kept copy of that
// array is exactly the two-mechanisms-one-question shape CLAUDE.md records for
// `bump-version.mjs`'s FACES table: green the day a resource is added, red only
// at the next unrelated run.
//
// ⚠️ WHAT THIS DOES NOT PROVE. It answers "does this path exist", not "is what
// is at this path any good". A truncated `server.js` or a wrong-architecture
// `node.exe` exists just as confidently as a correct one — that question is
// `scripts/verify-bundle.mjs`'s, and it answers it by RUNNING the binary rather
// than by `existsSync`, for precisely this reason. Two checks, two questions.
//
// Run: `node scripts/preflight-sidecar-resources.mjs`
// Exit: 0 = every declared resource is staged; 1 = at least one is missing.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const TAURI_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri');

/** 🔴 THE ONE STRING THIS FILE EXISTS TO PRINT. Exported so the drill asserts
 *  the real constant rather than a copy of it that can agree with itself while
 *  both drift away from `apps/desktop/package.json`. */
export const SIDECAR_BUILD_COMMAND = 'pnpm --filter @flowmic/desktop build:sidecar';

/** Base config + the per-platform overlays Tauri merges on top of it. Tauri
 *  REPLACES arrays rather than concatenating them, so an overlay that declares
 *  `bundle.resources` wins outright — which is why macOS is a different list
 *  (`resources/node`, no `node_modules`) and not the Windows list plus extras. */
const PLATFORM_CONF = {
  darwin: 'tauri.macos.conf.json',
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The `bundle.resources` array that `tauri_build::build()` will validate on
 * `platform`, read from the config files themselves.
 *
 * `platform` is a PARAMETER, not `process.platform` reached for internally, so
 * the macOS branch is exercisable from a Windows box. CLAUDE.md's rule is that
 * a Windows gate has zero proving power over `cfg(target_os = "macos")` Rust —
 * that is about code the compiler never sees. This is JavaScript that runs
 * everywhere, and the honest way to keep it honest is to make the platform an
 * input the drill can vary.
 */
export function declaredResources(platform = process.platform, tauriDir = TAURI_DIR) {
  const base = readJson(join(tauriDir, 'tauri.conf.json'));
  let resources = base?.bundle?.resources;
  const overlayName = PLATFORM_CONF[platform];
  if (overlayName !== undefined) {
    const overlayPath = join(tauriDir, overlayName);
    if (existsSync(overlayPath)) {
      const overlay = readJson(overlayPath);
      if (Array.isArray(overlay?.bundle?.resources)) resources = overlay.bundle.resources;
    }
  }
  if (!Array.isArray(resources) || resources.length === 0) {
    // Fail loud rather than report "nothing missing" off an empty list. A
    // preflight that silently verifies zero things is worse than no preflight:
    // it prints a green line and teaches the reader to trust it.
    throw new Error(
      `tauri.conf.json declares no bundle.resources for platform '${platform}' — `
      + 'refusing to report a green preflight over an empty list',
    );
  }
  return resources;
}

/** Declared resources that are not on disk, as repo-relative POSIX-ish paths
 *  for printing. Empty array = everything is staged. */
export function missingResources(platform = process.platform, tauriDir = TAURI_DIR) {
  return declaredResources(platform, tauriDir)
    .filter((rel) => !existsSync(join(tauriDir, rel)))
    .map((rel) => `apps/desktop/src-tauri/${rel.replace(/\\/g, '/')}`);
}

/** The refusal a human reads. Names the missing paths AND the command — the
 *  second half is the entire point (tauri already names paths). */
export function refusalMessage(missing) {
  return [
    '',
    '  ✗ FlowMic preflight: the staged sidecar payload is missing.',
    '',
    ...missing.map((p) => `      missing:  ${p}`),
    '',
    '  These files are gitignored build output, not source — a fresh clone never',
    '  has them. Run this first, then re-run what you just ran:',
    '',
    `      ${SIDECAR_BUILD_COMMAND}`,
    '',
    '  (Do NOT create the paths by hand. Tauri only checks that they exist; an',
    '   empty directory gets you a build that goes further and is wrong.)',
    '',
  ].join('\n');
}

/** @returns {number} process exit code. Pure enough to call from a drill. */
export function runPreflight({ platform = process.platform, tauriDir = TAURI_DIR, out = console } = {}) {
  const missing = missingResources(platform, tauriDir);
  if (missing.length === 0) {
    out.log(`  ✓ sidecar resources staged (${declaredResources(platform, tauriDir).length} declared)`);
    return 0;
  }
  out.error(refusalMessage(missing));
  return 1;
}

// 🔴 isMainModule guard — scripts/it27-publish-node-pin.test.mjs's header records
// what its absence costs: publish.mjs runs its whole side-effecting body on
// import, so tests may only read it as text. This module stays importable.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(runPreflight());
}

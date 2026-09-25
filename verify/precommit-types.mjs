#!/usr/bin/env node
// verify/precommit-types.mjs — T0's type check: incremental, and scoped to what
// is actually being committed. Design 2026-09-13 §1, path A.
//
// WHY IT EXISTS. `.husky/pre-commit` used to run `pnpm verify:types`, which
// chains `tsc --noEmit` over all four TS packages from cold every time —
// measured 23.4 s (docs/archive/strategy/2026-09-12-verify-delivery-speedup-plan.md
// §1.2 row 4). A commit hook that costs half a minute is a commit hook people
// pass `--no-verify` to, and a bypassed gate verifies nothing at all.
//
// TWO THINGS IT DOES, AND THE ORDER IS NOT NEGOTIABLE.
//
//  1. IF `packages/protocol/src/**` IS STAGED, REBUILD THE DIST FIRST.
//     `tsc` resolves `@flowmic/protocol` to `packages/protocol/dist/index.d.ts`
//     — there are no `paths` mappings anywhere in this repo, measured with
//     --traceResolution and recorded in both CLAUDE.md (2026-08-07) and
//     scripts/refresh-derived.mjs's header. So checking server-core against a
//     stale dist type-checks a contract that is not in the commit: a false
//     GREEN, and a faster one now that the check is incremental. The rule for
//     "did protocol move" is IMPORTED from scripts/refresh-derived.mjs
//     (REFRESHERS, id `protocol-dist`) rather than re-spelled here — two copies
//     of one predicate is how they drift.
//
//  2. RUN `tsc` ONLY FOR PACKAGES WHOSE tsconfig `include` COVERS A STAGED
//     FILE, with `--incremental --tsBuildInfoFile .local/tsbuildinfo/<pkg>`.
//
//     🔴 WHY THE EXPLICIT PATH — MEASURED ON THIS TREE (2026-09-13, tsc 5.9.3,
//     dev-pc-a), NOT QUOTED. The design says the CLI refuses
//     `--incremental` alongside `noEmit` unless `--tsBuildInfoFile` is given
//     (error TS5074). That diagnostic is real, but it does NOT apply to the
//     shape used here: `-p <tsconfig>` already IS "specified using tsconfig",
//     so the run succeeds. Both directions reproduced —
//       `tsc --noEmit --incremental src/index.ts`                  => TS5074
//       `tsc --noEmit --incremental -p …/tsconfig.typecheck.json`  => exit 0
//
//     What actually goes wrong without the flag is worse than an error, because
//     it succeeds: tsc writes the buildinfo next to the project. Measured for
//     apps/server-core, that is `apps/server-core/tsconfig.tsbuildinfo`, an
//     UNTRACKED file `git status --porcelain` then reports. That is the exact
//     list scripts/gate-receipt.mjs's `dirtyPaths()` fingerprints, so every
//     commit would dirty the tree the release gate is trying to prove has not
//     moved, and would add a path to the lane gate's own diff. `.local/` is
//     gitignored and pruned by every walker under verify/, so the flag is what
//     keeps a type check from having side effects on the evidence.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT CHECK, so the gap is visible rather than
// assumed covered: `apps/desktop` (vue-tsc over the whole SFC graph) stays out
// of the commit hook, exactly as the old hook's comment said. It runs in
// `pnpm verify:lane` (stage `verify:types:desktop`) and in both full gates.
//
// ⚠️ AND WHAT AN INCREMENTAL GREEN IS WORTH: the buildinfo is keyed on file
// versions, so a change made OUTSIDE the tsconfig graph (a dependency bump, a
// hand-edited `.d.ts` under node_modules) is invisible to it. That is true of
// every incremental compiler and is why the full `verify:types` still runs
// unconditionally in T2 and T3.
//
// Exit codes: 0 everything selected is clean (including "nothing selected"),
// 1 a tsc run failed or a prerequisite build failed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REFRESHERS } from '../scripts/refresh-derived.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
const TSBUILDINFO_DIR = path.join(ROOT, '.local', 'tsbuildinfo');

/** The rule for "protocol's dist is now stale", taken from the one place that
 *  already owns it. Throws rather than falling back if that id ever disappears:
 *  a silently absent prerequisite is the false green this file exists to stop. */
const protocolRule = REFRESHERS.find((r) => r.id === 'protocol-dist');
if (!protocolRule) {
  throw new Error(
    'verify/precommit-types.mjs: scripts/refresh-derived.mjs no longer exports a `protocol-dist` refresher'
  );
}

/**
 * The four TS packages the commit hook checks, each with the tsconfig its own
 * `typecheck` script uses and a predicate for "this staged path is inside that
 * project". The predicates mirror the `include` arrays; scripts/lane-gate.test.mjs
 * pins that each named tsconfig exists.
 */
export const TS_PROJECTS = [
  {
    id: 'protocol',
    dir: 'packages/protocol',
    project: 'packages/protocol/tsconfig.typecheck.json',
    covers: (p) => /^packages\/protocol\/(src|test)\/.*\.tsx?$/.test(p),
  },  {
    id: 'i18n-web',
    dir: 'packages/i18n-web',
    project: 'packages/i18n-web/tsconfig.typecheck.json',
    covers: (p) => /^packages\/i18n-web\/(src|test)\/.*\.tsx?$/.test(p),
  },
  {
    id: 'server-core',
    dir: 'apps/server-core',
    project: 'apps/server-core/tsconfig.json',
    covers: (p) => /^apps\/server-core\/(src|test)\/.*\.ts$/.test(p),
  },
];

/** Paths staged for this commit. `-z` for the reason
 *  scripts/gate-receipt.mjs's `dirtyPaths` documents: with core.quotePath a
 *  CJK filename comes back quoted and octal-escaped, and this repo has them. */
export function stagedPaths(cwd = ROOT) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null; // cannot tell => caller runs everything
  return `${r.stdout ?? ''}`
    .split('\0')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

/**
 * Which projects to check, and whether the protocol dist has to be rebuilt.
 *
 * 🔴 A STAGED PROTOCOL CHANGE SELECTS ALL FOUR, not just protocol. The other
 * three consume it through the dist, so "protocol compiles" says nothing about
 * whether its consumers still do — which is the whole failure mode step 1
 * exists for.
 */
export function selectProjects(paths, projects = TS_PROJECTS) {
  if (paths == null) {
    return { projects, rebuildProtocol: true, reason: 'git could not list the staged files' };
  }
  const rebuildProtocol = paths.some((p) => protocolRule.matches(p));
  if (rebuildProtocol) {
    return {
      projects,
      rebuildProtocol,
      reason: 'packages/protocol moved — its consumers read the rebuilt dist',
    };
  }
  const picked = projects.filter((proj) => paths.some((p) => proj.covers(p)));
  return { projects: picked, rebuildProtocol, reason: 'staged files inside these tsconfig includes' };
}

/** 🔴 EACH PACKAGE'S OWN typescript, NOT a root one — MEASURED, not preferred.
 *  pnpm's default (strict) layout does NOT hoist: there is no
 *  `node_modules/typescript` at this repo's root at all (`ls node_modules/.bin`
 *  on 2026-09-13 lists husky and nothing else), only
 *  `<pkg>/node_modules/typescript` symlinked into
 *  `node_modules/.pnpm/typescript@5.9.3`. A root-only lookup resolves to
 *  nothing, and this hook would then refuse to check anything. All four links
 *  point at the same store entry, so this is one compiler reached four ways. */
function tscBin(proj) {
  const bin = path.join(ROOT, proj.dir, 'node_modules', 'typescript', 'bin', 'tsc');
  return existsSync(bin) ? bin : null;
}

/** The exact argv a project is checked with — exported so the drill can assert
 *  `--tsBuildInfoFile` is present without running a compiler. */
export function tscArgs(proj) {
  return [
    '--noEmit',
    '-p',
    proj.project,
    '--incremental',
    '--tsBuildInfoFile',
    path.join('.local', 'tsbuildinfo', `${proj.id}.tsbuildinfo`),
  ];
}

function run(cmd, args, { shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function main() {
  const started = Date.now();
  const paths = stagedPaths();
  const { projects, rebuildProtocol } = selectProjects(paths);

  if (projects.length === 0) {
    process.stdout.write('· types: no staged file is inside a checked tsconfig — nothing to do\n');
    return 0;
  }

  if (rebuildProtocol) {
    process.stdout.write(`· types: ${protocolRule.command} (staged protocol change)\n`);
    // `shell: true` for the reason scripts/preflight-toolchain.mjs documents:
    // pnpm is a .cmd on Windows and Node refuses to spawn one without a shell.
    const code = await run(protocolRule.argv[0], protocolRule.argv.slice(1), { shell: true });
    if (code !== 0) {
      process.stderr.write('\nx could not rebuild @flowmic/protocol - the type check below would\n');
      process.stderr.write('  have run against the previous contract, so it was not run.\n');
      return 1;
    }
  }

  const missing = projects.filter((p) => tscBin(p) == null);
  if (missing.length > 0) {
    process.stderr.write(
      `x typescript is not installed for ${missing.map((p) => p.id).join(', ')} - run \`pnpm install\`.\n`
    );
    return 1;
  }
  mkdirSync(TSBUILDINFO_DIR, { recursive: true });

  process.stdout.write(`· types: ${projects.map((p) => p.id).join(', ')} (incremental)\n`);
  const codes = await Promise.all(
    projects.map((p) => run(process.execPath, [tscBin(p), ...tscArgs(p)]))
  );
  const bad = projects.filter((_, i) => codes[i] !== 0);
  const ms = Date.now() - started;
  if (bad.length > 0) {
    process.stderr.write(
      `\nx type errors in: ${bad.map((p) => p.id).join(', ')} (${(ms / 1000).toFixed(1)}s)\n`
    );
    return 1;
  }
  process.stdout.write(`· types ok in ${(ms / 1000).toFixed(1)}s\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code));
}

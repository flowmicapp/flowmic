#!/usr/bin/env node
// C10-3 — regenerate the derived artefacts a pull or a branch switch just
// invalidated, at the moment it happens instead of three commits later.
//
// THE TWO FAILURE CLASSES THIS REMOVES AT THE ROOT (release-friction ledger §1
// rows 4 and 5). Both cost a full round trip on release day, and both have the
// same shape: a file that is DERIVED from a tracked source, is itself either
// gitignored or regenerated, and that git will therefore never update for you.
//
//   · the generated i18n Dart (`lib/generated/`, `l10n/*.g.dart`) — gitignored,
//     so pulling a change to i18n/mobile/*.json leaves the old sentences on
//     disk. `verify:lint i18n-generated-fresh` catches it, in the pre-commit
//     hook, i.e. on the next commit you try to make about something else.
//   · `packages/protocol/dist` — gitignored, and `tsc` resolves
//     `@flowmic/protocol` to it (measured with --traceResolution: there is no
//     `paths` mapping anywhere). So a stale dist makes the TYPE CHECK run
//     against a contract that is not in the tree. It has produced a false RED
//     and, worse, a false GREEN — a new schema field silently stripped so that
//     a test which should have failed passed.
//
// 🔴 WHY IT IS DIFF-SCOPED AND NOT UNCONDITIONAL. A hook that rebuilds on every
// checkout is a hook people uninstall: `git checkout -` between two branches
// that share an i18n tree would pay for a rebuild that changes nothing. So the
// range git hands the hook is diffed, and if neither source moved this exits
// having printed nothing at all. Silence is the normal outcome.
//
// 🔴 WHY IT NEVER FAILS THE HOOK. git IGNORES the exit status of post-merge and
// post-checkout — the merge or the checkout has already happened, and there is
// nothing to abort. So an exit code here would be a signal with no receiver,
// and the honest alternative is the one this uses: print the failure LOUDLY,
// name the command that fixes it, and get out of the way. A silent failure here
// would be the worst of both, because the very next gate run would blame the
// stale artefact rather than the regeneration that did not happen.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT DO: it never runs `pnpm install`, never
// rebuilds the sidecar payload, and never touches Rust or Flutter build output.
// Those are minutes, not seconds, and a hook that quietly spends minutes is a
// hook that gets blamed for whatever else is slow that day. The two jobs here
// are second-scale and are the two the ledger measured.
//
// Usage (from a git hook):  node scripts/refresh-derived.mjs <oldRev> <newRev>
// Both revs may be omitted or be the all-zero sha (a fresh clone), in which case
// nothing is assumed to have moved and this exits silently — a clone's setup is
// CONTRIBUTING.md's job, not a hook's.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

const ZERO = /^0{7,40}$/;

/**
 * One row per derived artefact: which source paths invalidate it, and the one
 * command that rebuilds it.
 *
 * `command` is the SAME string a human would type, and the same one the failure
 * message prints — so a reader who wants to do it by hand, or who wants to know
 * what just ran, reads one string rather than reconstructing an argv.
 */
export const REFRESHERS = [
  {
    id: 'i18n',
    label: 'generated i18n catalogues (desktop Rust/TS, mobile Dart, web snapshot)',
    matches: (p) => p.startsWith('i18n/') || p.startsWith('scripts/i18n/'),
    command: 'pnpm i18n:gen',
    argv: ['pnpm', 'i18n:gen'],
  },
  {
    id: 'protocol-dist',
    label: '@flowmic/protocol dist (what tsc and the golden paths actually read)',
    matches: (p) => p.startsWith('packages/protocol/src/') || p === 'packages/protocol/package.json',
    command: 'pnpm --filter @flowmic/protocol build',
    argv: ['pnpm', '--filter', '@flowmic/protocol', 'build'],
  },
];

/** Paths that differ between two revisions, or null when the range is not
 *  usable (a clone, a detached first checkout, an unknown rev). Null means
 *  "cannot tell", and the caller's correct response to that is to do nothing:
 *  guessing would make this the unconditional rebuild it is written not to be. */
export function changedPaths(oldRev, newRev, cwd = REPO_ROOT) {
  if (!oldRev || !newRev || ZERO.test(oldRev) || ZERO.test(newRev) || oldRev === newRev) return null;
  const r = spawnSync('git', ['diff', '--name-only', '-z', oldRev, newRev], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return `${r.stdout ?? ''}`.split('\0').map((s) => s.trim()).filter(Boolean);
}

export function pick(paths, refreshers = REFRESHERS) {
  if (paths == null) return [];
  return refreshers.filter((r) => paths.some((p) => r.matches(p)));
}

export function main(argv = process.argv.slice(2)) {
  const due = pick(changedPaths(argv[0], argv[1]));
  if (due.length === 0) return 0; // silence is the normal outcome

  for (const r of due) {
    process.stdout.write(`· refreshing ${r.label} — ${r.command}\n`);
    // `shell: true` for the reason the toolchain preflight documents: pnpm is a
    // `.cmd` on Windows and Node refuses to spawn one without a shell.
    const run = spawnSync(r.argv[0], r.argv.slice(1), {
      cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', shell: true, windowsHide: true,
    });
    if (run.status === 0) continue;
    // Loud, and never silent — see the header on why the exit code cannot carry
    // this. The next gate run would otherwise blame the stale artefact.
    process.stderr.write('\n');
    process.stderr.write('  ⚠ COULD NOT REFRESH A DERIVED ARTEFACT AFTER THIS CHECKOUT/MERGE\n');
    process.stderr.write(`    ${r.label}\n`);
    process.stderr.write(`    Run it yourself before the next gate: ${r.command}\n`);
    const tail = `${run.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n      ');
    if (tail) process.stderr.write(`      ${tail}\n`);
    process.stderr.write('\n');
  }
  return 0;
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());

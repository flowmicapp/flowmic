// verify/lint/gate-covers-workspaces.mjs
// Lint 14/14 — every workspace package's own `test` / `typecheck` script must be
// reachable from `verify:delivery`.
//
// WHY THIS EXISTS, and why it is a lint rather than a card:
// This repo has now discovered the SAME hole four times, each time by accident and
// each time one member at a time:
//   · GATE-1 — `apps/desktop`'s vue-tsc was in no gate;
//   · GATE-2 — 455 Rust tests were in no gate, four of them pinning a P0 red line;
//   · GATE-3 — `@flowmic/protocol` (297) and `@flowmic/server-core` (1561) likewise,
//     and the protocol half was itself a correction to a card that named only
//     server-core;
//   · 2026-08-08 — `@flowmic/stt-cloud` reported by the lane that had just written
//     8 tests into it, and while confirming that I found `@flowmic/desktop`'s 922
//     vitest tests were ALSO absent. The report named one package; the class had two.
//
// "a red-list is also a sample" four times over. The answer is not a fifth card — it is a check that
// makes the NEXT package fail on the day it arrives, which is the only day anyone
// is looking at it. Same reasoning as version-sync: a hand-maintained list and an
// auto-discovered face answering one question by different means, with the
// discovered side authoritative.
//
// 🔴 WHAT IT DELIBERATELY DOES NOT DO: it does not check that a stage is *useful*,
// only that it is *reached*. A package whose `test` script is `exit 0` passes here.
// That is the honest boundary of a wiring check, and pretending otherwise would be
// the same false comfort this file exists to remove.
//
// 🔴🔴 GATE-5 (P3 window, 2026-08-08) — THE FIFTH TIME, AND THIS FILE WAS THE ONE THAT
// MISSED IT. Everything above was written to make「a suite outside every gate」fail
// on the day the package arrives. It then reported PASS for months while
// `apps/mobile` — 178 files, 1,871 tests, the largest suite in the repo — sat
// outside `verify:delivery` entirely (measured: `grep -rn "flutter test"` across the
// manifest, hooks and verify tree returned nothing). Five of those tests had been
// red on `main` since 060c225 and survived two human sign-offs, including one that
// ran `verify:delivery` and got EXIT=0, because the gate it ran does not contain
// them.
//
// The cause was not the coverage rule. It was `packageDirs()`: it discovered
// packages by looking for `package.json`, and a Flutter package carries
// `pubspec.yaml`. So the check drew a sample, answered honestly about the sample,
// and printed a sentence that every reader took to be about the repo.
//
// ⇒ THE LESSON THIS FILE NOW CARRIES, because it is the one that learned it:
// **a discovery mechanism is itself a sample, and this one failed toward
// confidence.** "A red-list is also a sample" applies to the thing that BUILDS the list, not
// only to the list. When you add a check, the second question after "what does it
// verify" is "what can it see" — and the answer must be measured, not assumed.
// REVERSE CONTROL, MEASURED (P3 window, 2026-08-08, dev-pc-a) — removing the
// `verify:mobile-tests` stage from `verify:delivery` turns this lint red with
// "apps/mobile has a test/ directory that verify:delivery never runs (flutter
// test)"; restored, and the whole run is back to 13/1/0 with 9 faces. So the new
// half can fail, which is the only thing that makes it a check.
//
// ⚠️ AND A RESIDUAL, WRITTEN DOWN RATHER THAN GLOSSED: **no test pins this file.**
// The first draft of this very comment claimed "pinned by
// gate-covers-workspaces.test.mjs" — a file that does not exist, in a repo with no
// lint-test harness at all (`ls verify/lint/*.test.mjs` ⇒ nothing). That sentence
// was written by the same hand that had just finished documenting how this file
// printed a reassuring PASS about a sample it could not see, which is the point:
// Anti-façade ④ is not a rule you outgrow by knowing about it. The measurement
// above is a one-time reading by a person; the day someone edits `dartPackageDirs`
// there is nothing that will notice. Registered as an open account (P3 ledger §6).
//
// ✅ CLOSED 2026-08-19 (lane L5): the filename the first draft invented now
// exists for real — scripts/gate-covers-workspaces.test.mjs drives coverageReport
// against synthetic trees under tmpdir (an uncovered pubspec workspace must FAIL
// BY NAME; a tree discovery cannot see must not read as clean) and against this
// repo, cross-checked with what `node verify/lint/run-all.mjs` actually prints.
// The day someone edits `dartPackageDirs`, the pubspec drill case goes red. Two
// mechanical changes carried it: the scan takes its root as a parameter
// (production behaviour unchanged — the default export still hands it ROOT), and
// a discovery that finds NOTHING now FAILS instead of printing a confident PASS
// about an empty set ("0 workspace face(s) reachable" was a sentence about the
// ruler, wearing the repo's clothes).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/gate-covers-workspaces.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

/** Packages exempt from a face, with the reason. An exemption must name why the
 *  script cannot be gated — "it is slow" is not a reason on its own (that argument
 *  kept vue-tsc out of BOTH gates for months while only being true of one). */
const EXEMPT = {
  // none today — every workspace package's test and typecheck are in the chain.
};

function packageDirs(rootDir) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const base = join(rootDir, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkg = join(base, name, 'package.json');
      if (existsSync(pkg)) out.push({ rel: `${group}/${name}`, pkg });
    }
  }
  return out;
}

/** Dart/Flutter packages: a `pubspec.yaml` with a `test/` directory beside it.
 *
 *  Discovered the same way as the node half — by walking the tree, not by being
 *  listed — because a hand-maintained list is what let the mobile suite go
 *  unnoticed. `test/` is required rather than assumed: a pubspec with no tests has
 *  nothing to gate, and demanding a stage for it would be a gate that fails for
 *  the wrong reason. */
function dartPackageDirs(rootDir) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const base = join(rootDir, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const rel = `${group}/${name}`;
      if (!existsSync(join(rootDir, rel, 'pubspec.yaml'))) continue;
      if (!existsSync(join(rootDir, rel, 'test'))) continue;
      out.push({ rel });
    }
  }
  return out;
}

/** The whole scan against an explicit tree root — exported so the drill
 *  (scripts/gate-covers-workspaces.test.mjs) can drive it over synthetic trees
 *  under tmpdir. Production behaviour is unchanged: the default export below
 *  hands it this repo's ROOT and nothing else calls it with anything else.
 *  Same parameterisation shape as worktree-location's classifyWorktrees. */
export function coverageReport(rootDir) {
  const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const scripts = root.scripts ?? {};
  const delivery = scripts['verify:delivery'];
  if (!delivery) return { status: 'FAIL', detail: 'root package.json has no verify:delivery' };

  // Expand the chain one level: verify:delivery calls named scripts, and those are
  // where the --filter lives. Resolved from the manifest rather than hardcoded, so
  // renaming a stage cannot silently drop a package out of coverage.
  const staged = delivery
    .split('&&')
    .map((s) => s.trim().replace(/^pnpm\s+/, ''))
    .filter(Boolean);
  const expanded = staged.map((name) => scripts[name] ?? name).join('\n');

  const missing = [];
  let checked = 0;
  for (const { rel, pkg } of packageDirs(rootDir)) {
    const manifest = JSON.parse(readFileSync(pkg, 'utf8'));
    const name = manifest.name;
    if (!name) continue;
    for (const face of ['test', 'typecheck']) {
      if (!manifest.scripts?.[face]) continue; // no such script => nothing to gate
      checked += 1;
      if (EXEMPT[name]?.includes(face)) continue;
      // Coverage = some stage filters this package AND runs this face. Both halves
      // matter: `--filter X typecheck` does not cover X's tests.
      const covered = expanded
        .split('\n')
        .some((line) => line.includes(`--filter ${name} `) && line.trim().endsWith(face));
      if (!covered) missing.push(`${name} (${rel}) has a \`${face}\` script that verify:delivery never runs`);
    }
  }

  // Dart half. There is no `--filter` to look for: these are not pnpm workspace
  // members, so coverage means "some stage cd's into this directory AND runs
  // flutter test". Both halves are required — a stage that runs `flutter test`
  // somewhere else does not cover this package, which is the same reason the node
  // half checks the filter and the face together rather than either alone.
  for (const { rel } of dartPackageDirs(rootDir)) {
    checked += 1;
    const covered = expanded
      .split('\n')
      .some((line) => line.includes(rel) && line.includes('flutter test'));
    if (!covered) {
      missing.push(`${rel} has a test/ directory that verify:delivery never runs (flutter test)`);
    }
  }

  // GATE-5's real lesson, enforced (2026-08-19): discovery is itself a sample,
  // and this one failed toward confidence — an empty sample used to print
  // "0 workspace face(s) reachable" as a PASS, a confident sentence about a set
  // the scanner could not see. A tree where NOTHING was checked is a statement
  // about the ruler, not the repo, and it fails as one.
  if (checked === 0) {
    return {
      status: 'FAIL',
      detail:
        'discovery found ZERO gateable faces (no package.json test/typecheck scripts, '
        + 'no pubspec.yaml with a test/ directory). That is a blind ruler, not a clean '
        + 'repo — if the workspace layout really changed, update packageDirs/'
        + 'dartPackageDirs in the same commit.',
    };
  }

  if (missing.length) {
    return {
      status: 'FAIL',
      detail:
        `${missing.length} ungated face(s): ${missing.join('; ')}. ` +
        'Add a stage to verify:delivery (with --fail-if-no-match, or the filter silently exits 0), ' +
        'or add an EXEMPT entry here naming why it cannot be gated.',
    };
  }
  return { status: 'PASS', detail: `${checked} workspace face(s) reachable from verify:delivery` };
}

export default async function gateCoversWorkspaces() {
  return coverageReport(ROOT);
}

// verify/lane-map.mjs — the path → stage table the T1 lane gate reads.
//
// This file is DATA. `verify/run-lane-gate.mjs` contains the mechanism; every
// judgement about "which stage can this change possibly break" lives here, in
// one table, so that a reader can audit the judgement without reading a runner.
// Design: docs/strategy/2026-09-13-gate-tiering-design.md §2.1.
//
// 🔴 THE ONLY DIRECTION THIS TABLE IS ALLOWED TO BE WRONG IN.
// A row that names too MANY stages costs wall clock. A row that names too FEW
// produces a green that means less than the reader thinks it means — this
// repo's most expensive recurring shape. So:
//   · a path matching no row runs EVERY stage (fail closed, §2.2), and the
//     runner prints `UNMAPPED <path>` so the omission is visible rather than
//     silently absorbed;
//   · the full set is not written down here as a literal. It is DERIVED from
//     `LANES` in verify/run-delivery-fast.mjs, so a stage added to the parallel
//     gate is in the full set the same day, without anyone remembering to copy
//     it. scripts/lane-map.test.mjs pins that every name in this table is a
//     real script in the root package.json.
//
// ⚠️ WHAT THIS TABLE STRUCTURALLY CANNOT SEE (design §2.1 hidden edge 2):
// the mirror lints (`admin-limit-mirror`, `password-policy-mirror`,
// `spoken-langs-mirror`, `mobile-web-tokens-mirror`, `commit-hook-mirror`) read
// SIBLING repositories. A change over there is in no diff this table is shown.
// That is the second reason `verify:lint` is on EVERY row and is never itself
// scoped: whenever the lane gate runs at all, those lints run whole. See
// `ALWAYS` below for the same argument applied to `verify:scripts`, which is
// unconditional for a different and sharper reason.
//
// ⚠️ GRANULARITY THIS TABLE CANNOT EXPRESS, stated rather than implied.
// The design's table says things like "verify:types(server-core)". There is no
// such script: the root package.json has ONE `verify:types` that chains all
// four packages (`pnpm --filter @flowmic/protocol … && … @flowmic/server-core`).
// Stage names here are real script names or nothing, so any row that needs any
// package type-checked selects `verify:types` and all four run. Splitting it
// would mean adding scripts to the root manifest, which `verify:delivery` and
// `gate-covers-workspaces` both read — out of this lane's scope.

import { LANES } from './run-delivery-fast.mjs';

/** Stage names, spelled exactly as the root package.json spells them. Kept as
 *  constants so a typo is a ReferenceError here instead of a stage that is
 *  silently never selected. */
export const S = {
  lint: 'verify:lint',
  webTargetCachedMode: 'verify:web-target-cached-mode',
  i18nDevPlaceholders: 'verify:i18n-dev-placeholders',
  types: 'verify:types',
  typesDesktop: 'verify:types:desktop',
  clippy: 'verify:clippy',
  rustTests: 'verify:rust-tests',
  doctests: 'verify:doctests',
  protocolTests: 'verify:protocol-tests',
  i18nWebTests: 'verify:i18n-web-tests',
  serverTests: 'verify:server-tests',
  desktopTests: 'verify:desktop-tests',
  linuxCopyRender: 'verify:linux-copy-render',
  mobileTests: 'verify:mobile-tests',
  scripts: 'verify:scripts',
  golden: 'golden',
};

const RUST = [S.clippy, S.rustTests, S.doctests];

/**
 * 🔴 THE TWO STAGES EVERY ROW CARRIES — a ruling (MAIN, 2026-09-13), not a
 * default, and each half has its own reason.
 *
 *   · `verify:lint`, because most of its checks walk the whole tree and several
 *     read SIBLING repositories (the mirror lints), which no diff of THIS repo
 *     can show us. Scoping it would mean each check declaring the roots it
 *     reads, and most of them do not.
 *   · `verify:scripts`, because it is not only release tooling. Measured:
 *     scripts/w2-eval-corpus.test.mjs:147 loads
 *     apps/server-core/src/compose/output-guard.ts — the production compose
 *     guard — and `:18` the production accumulator fold
 *     apps/server-core/src/stt/text-merge.ts, both through esbuild. So a
 *     resident gate on server-core production code lives under scripts/, and
 *     the earlier design's conditional skip (§4c) would have skipped it for a
 *     change to output-guard.ts. What that skip bought is 10.9 s — the whole
 *     scripts set's measured cost (ledger §7). A real gate is not worth 10.9 s.
 *
 * Spread at the head of each row rather than added in code, so that deleting it
 * from one row is a visible edit scripts/lane-map.test.mjs fails on — the same
 * reason the protocol row spells its full set out longhand.
 */
const ALWAYS = [S.lint, S.scripts];

/**
 * Every stage the parallel gate runs, in lane order — derived, never copied.
 *
 * `verify:sidecar-resources` is deliberately absent, for the reason
 * verify/run-delivery-fast.mjs states on its RUST lane: `verify:clippy` and
 * `verify:rust-tests` each already begin with `pnpm verify:sidecar-resources`
 * (grep the root package.json for those two scripts), so a row of its own would
 * run the same read-only check a third time.
 */
export const FULL_STAGES = LANES.flatMap((lane) =>
  lane.steps.filter((s) => s.cmd === 'pnpm').map((s) => s.args[0])
);

/**
 * Stages that READ `packages/protocol/dist`. When any of these is selected the
 * runner puts Stage 0 in front of them — the same barrier, for the same reason,
 * as hazard 1 in verify/run-delivery-fast.mjs: tsc resolves `@flowmic/protocol`
 * to `packages/protocol/dist/index.d.ts` and every vitest project imports the
 * same files, so a stale dist type-checks a contract that is not in the tree.
 *
 * `verify:mobile-tests` is NOT here on purpose: apps/mobile/tool/gen_protocol.mjs
 * reads `packages/protocol/src/…`, not the dist, and `make -C apps/mobile
 * gate-test` regenerates before it tests.
 *
 * `verify:lint` is NOT here — measured, not assumed: `grep -rn "protocol/dist"
 * verify/lint scripts` on 2026-09-13 returned only prose in comments
 * (run-golden.mjs, run-delivery-fast.mjs, gate-receipt.mjs,
 * refresh-derived.mjs), no lint reading it.
 *
 * 🔴 `verify:scripts` IS here, and this one was measured rather than reasoned
 * about — the reasoning gets it wrong. scripts/w2-eval-corpus.test.mjs bundles
 * real server-core production source through esbuild (`:50` imports
 * resolveEsbuild, `:147` loads apps/server-core/src/compose/output-guard.ts,
 * `:18` names the accumulator fold apps/server-core/src/stt/text-merge.ts). By
 * reading the graph you would conclude no dist is needed: the only protocol
 * reference on that path is `import type { SttEngineId }` at
 * apps/server-core/src/stt/engines/base.ts:14, and esbuild elides type-only
 * imports. The measurement says otherwise — with `packages/protocol/dist` moved
 * aside that drill prints `FAILED sections: replay, guard`, and with it back it
 * is green (2026-09-13, dev-pc-a). A fresh worktree has no dist, so without
 * this entry the lane gate would hand somebody a red about their checkout
 * rather than about their code.
 */
export const DIST_READERS = new Set([
  S.types,
  S.typesDesktop,
  S.protocolTests,
  S.i18nWebTests,
  S.serverTests,
  S.desktopTests,
  S.linuxCopyRender,
  S.scripts,
  S.golden,
]);

/** True when the selected set contains anything that reads the protocol dist,
 *  i.e. when Stage 0 must run before the lanes.
 *
 *  ⚠️ SINCE `verify:scripts` BECAME UNCONDITIONAL AND A DIST READER, THIS IS
 *  TRUE FOR EVERY NON-EMPTY SELECTION — including a docs-only one. The
 *  condition is kept rather than replaced by `true` because it still states
 *  WHY the barrier runs, and because the day `verify:scripts` stops bundling
 *  server-core source the condition is what will notice. The cost is real and
 *  should not be discovered later: a docs-only run went from 4 s to the wall
 *  clock reported by the runner's own summary. */
export const needsStage0 = (stages) => [...stages].some((s) => DIST_READERS.has(s));

/**
 * Paths that are never part of a diff because git never reports them. They are
 * listed for the reader, not for the matcher: `git status --porcelain` and
 * `git diff` both omit ignored paths, so nothing here can reach `matchPath`.
 * scripts/lane-map.test.mjs therefore exempts these from the "every rule
 * matches a real path" check — a rule that CANNOT match is the point of them.
 */
export const IGNORED_PATTERNS = [
  '.local/**',
  'publish/**',
  'node_modules/**',
  '**/node_modules/**',
  'apps/desktop/src-tauri/target/**',
  // 🔴 DESIGN §2.1 GIVES THIS A ROW OF ITS OWN; IN THIS TREE IT CANNOT HAVE ONE.
  // Every entry `apps/desktop/src-tauri/tauri.conf.json:57` lists as a resource
  // — server.js, package.json, node.exe / node, node_modules/ — is gitignored
  // (.gitignore:12,17,33,34,45), and the directory does not exist in a fresh
  // checkout at all. So no path under it can ever appear in a diff, and a rule
  // matching it would be a row that looks like coverage and never fires. What
  // IS reachable is the thing that DECIDES the resource list — tauri.conf.json
  // — and the scripts that build the payload; those are the `desktop-payload`
  // rule below.
  'apps/desktop/src-tauri/resources/**',
];

/**
 * Ordered rules; FIRST MATCH WINS. Three pairs genuinely overlap, so their
 * order is load-bearing and scripts/lane-map.test.mjs pins each pair by
 * asserting which rule a real overlapping path resolves to:
 *   · `apps/desktop/src-tauri/tauri*.conf.json` before `apps/desktop/src-tauri/**`
 *   · `verify/golden/**` and `verify/lint/**` before `verify/**`
 *   · `scripts/i18n/**`                     before `scripts/**`
 * (`apps/desktop/scripts/**` and `apps/desktop/src/**` do NOT overlap — every
 * pattern here is anchored at the start, so `scripts/**` cannot reach into
 * apps/desktop. Listed as a non-constraint so nobody re-derives it.)
 */
export const RULES = [
  {
    id: 'protocol',
    patterns: ['packages/protocol/**'],
    // Written out rather than `FULL_STAGES` so that shrinking this row is a
    // visible edit that scripts/lane-map.test.mjs fails on. Design §9-2.
    stages: [
      S.clippy,
      S.rustTests,
      S.doctests,
      S.lint,
      S.webTargetCachedMode,
      S.i18nDevPlaceholders,
      S.types,
      S.typesDesktop,
      S.protocolTests,
      S.i18nWebTests,
      S.serverTests,
      S.desktopTests,
      S.linuxCopyRender,
      S.scripts,
      S.golden,
      S.mobileTests,
    ],
    why: 'the protocol is every downstream: server-core bundles it (noExternal in apps/server-core/tsup.config.ts), tsc and vitest read its dist, the desktop TS and Rust import it, apps/mobile/tool/gen_protocol.mjs reads its src, and golden starts the server that embeds it — scoping it saves nothing and can only lie',
  },
  {
    id: 'server-core',
    patterns: ['apps/server-core/**'],
    stages: [...ALWAYS, S.types, S.serverTests, S.golden],
    why: 'golden rebuilds and starts server-core every run (verify/golden/run-golden.mjs); @flowmic/stt-cloud is reached by runtime dynamic import (apps/server-core/src/stt/engine-factory.ts), not statically, so its suite is not implicated',
  },  {
    id: 'i18n-web-pkg',
    patterns: ['packages/i18n-web/**'],
    stages: [...ALWAYS, S.types, S.i18nWebTests],
    why: 'no workspace package depends on it (packages/i18n-web/package.json has no dependencies)',
  },
  {
    id: 'desktop-payload',
    patterns: [
      'apps/desktop/scripts/**',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/tauri.*.conf.json',
    ],
    stages: [...ALWAYS, ...RUST, S.linuxCopyRender],
    why: 'scripts/preflight-sidecar-resources.mjs derives resources from tauri.conf.json; the rendering gate reads its minimum window dimensions too',
  },
  {
    id: 'desktop-rust',
    patterns: ['apps/desktop/src-tauri/**'],
    stages: [...ALWAYS, ...RUST],
    why: 'the three cargo commands share apps/desktop/src-tauri/target; platform-cfg-count and package-id-family read the .rs files',
  },
  {
    id: 'desktop-ts',
    patterns: ['apps/desktop/src/**'],
    stages: [...ALWAYS, S.typesDesktop, S.desktopTests, S.linuxCopyRender],
    why: 'vitest and vue-tsc cover the desktop tree; the rendered Linux cause check executes its real pages and CSS',
  },
  {
    id: 'mobile',
    patterns: [
      'apps/mobile/lib/**',
      'apps/mobile/test/**',
      // Host integration scenarios are imported by test/*_integration_test.dart;
      // Flutter's existing gate executes those wrappers (no release plugin).
      'apps/mobile/integration_test/**',
      'apps/mobile/tool/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/mobile/pubspec.*',
      'apps/mobile/Makefile',
    ],
    stages: [...ALWAYS, S.mobileTests],
    why: 'verify:mobile-tests is `make -C apps/mobile gate-test` (gen + flutter test); android/ios are read by android-install-permission, applink-declarations and package-id-family',
  },
  {
    id: 'i18n-mobile',
    patterns: ['i18n/mobile/**'],
    stages: [...ALWAYS, S.mobileTests, S.i18nWebTests, S.i18nDevPlaceholders],
    why: 'verify:i18n-dev-placeholders scans these catalogues for DEV placeholders (NR-83); scripts/i18n/gen-mobile-dart.mjs writes the (gitignored) Dart catalogues and scripts/i18n/gen-i18n-web.mjs reads the same directory; i18n-generated-fresh, disclosure-copy-mirror and plan-limit-copy all read these files',
  },
  {
    id: 'i18n-desktop',
    patterns: ['i18n/desktop/**', 'i18n/desktop-rust/**'],
    stages: [...ALWAYS, S.typesDesktop, S.desktopTests, S.linuxCopyRender, S.i18nDevPlaceholders, ...RUST],
    why: 'verify:i18n-dev-placeholders scans these catalogues for DEV placeholders (NR-83); the desktop TS and Rust catalogues generated from these are COMMITTED (apps/desktop/src/lib/strings/generated/*.g.ts, apps/desktop/src-tauri/src/ui_i18n_table.g.rs), so editing the JSON without `pnpm i18n:gen` turns i18n-generated-fresh red and compiles the old sentences',
  },
  {
    id: 'i18n-web-src',
    patterns: ['i18n/web/**'],
    stages: [...ALWAYS, S.i18nWebTests],
    why: 'scripts/i18n/gen-i18n-web.mjs reads i18n/web/subset.json into packages/i18n-web/src/generated',
  },
  {
    id: 'i18n-generators',
    patterns: ['scripts/i18n/**'],
    stages: [
      ...ALWAYS,
      S.mobileTests,
      S.i18nWebTests,
      S.typesDesktop,
      S.desktopTests,
      S.linuxCopyRender,
      ...RUST,
    ],
    why: 'equivalent to "every i18n source changed" (scripts/refresh-derived.mjs puts scripts/i18n/ and i18n/ in one rule), plus verify:scripts because the generators live under scripts/',
  },
  {
    id: 'golden',
    patterns: ['verify/golden/**'],
    stages: [...ALWAYS, S.golden],
    why: 'nothing but the golden runner reads them (beyond the two unconditional stages)',
  },
  {
    id: 'delivery-check-web-target',
    patterns: ['verify/delivery-checks/web-target-cached-mode.mjs'],
    stages: [...ALWAYS, S.webTargetCachedMode],
    why: 'the cross-repo producer check must execute when its own assertions change; the citation it compares lives in packages/protocol/src/inject-verdict-authorship.ts, whose row is the full set',
  },
  {
    id: 'delivery-check-dev-placeholders',
    patterns: ['verify/delivery-checks/i18n-dev-placeholders.mjs'],
    stages: [...ALWAYS, S.i18nDevPlaceholders],
    why: 'the placeholder scan must execute when its own assertions change (NR-83)',
  },
  {
    id: 'delivery-checks',
    patterns: ['verify/delivery-checks/**'],
    stages: [...ALWAYS, S.webTargetCachedMode, S.i18nDevPlaceholders],
    why: 'verify/delivery-checks/_cli.mjs is the entry shape of every delivery check; changing it re-runs them',
  },
  {
    id: 'lints',
    patterns: ['verify/lint/**'],
    stages: [...ALWAYS],
    why: 'several scripts/*.test.mjs spawn verify/lint/run-all.mjs or a single lint (e.g. scripts/gate-covers-workspaces.test.mjs) — which the unconditional verify:scripts already covers',
  },
  {
    id: 'linux-copy-render',
    patterns: ['scripts/linux-copy-render.mjs'],
    stages: [...ALWAYS, S.linuxCopyRender],
    why: 'the browser regression script must execute when its own assertions or server lifecycle change (acceptance R-3)',
  },
  {
    id: 'gate-tooling',
    patterns: ['verify/**', 'scripts/**', '.husky/**', '.github/workflows/**', 'package.json'],
    stages: [...ALWAYS],
    why: 'nothing beyond the two unconditional stages is implicated: scripts/run-script-tests.mjs discovers scripts/*.test.mjs, gate-covers-workspaces reads the root package.json, and the husky hooks are read by commit-hook-mirror and by scripts/c10-shift-left-gates.test.mjs',
  },
  {
    id: 'dependencies',
    // 🔴 DELIBERATE DEVIATION FROM THE DESIGN, and the direction matters.
    // Design §2.1 files pnpm-lock.yaml under the `gate-tooling` row (lint +
    // scripts). But a lockfile edit changes node_modules for every suite in the
    // repo, and the design's own §3.2 says the fingerprint mechanism cannot see
    // node_modules at all — "一个漏声明的输入 ⇒ 「SKIP (cached)」对着一个已经变了
    // 的世界". Selecting two stages after a dependency bump is that same shape
    // with a different label. Full set; reported to the window owner.
    patterns: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    stages: FULL_STAGES,
    why: 'a dependency change is an input to every stage, and no stage declares node_modules as an input it could check',
  },
  {
    id: 'docs',
    patterns: ['docs/**', '*.md'],
    stages: [...ALWAYS],
    why: 'the lints that read prose are all inside verify:lint — changelog-release-sections, no-cjk, outward-voice, version-sync anchors, scene-demo-english, file-size and no-cloud-keys walk the whole tree, and coordinate-anchors may point AT a doc; no compiler or suite opens a .md, so a docs-only diff is the two unconditional stages and nothing more',
  },
];

/** glob → RegExp. Supports `**` (any characters, `/` included), `*` (any
 *  characters except `/`) and literals. Deliberately not a full glob library:
 *  the table above uses exactly these two wildcards, and a dependency here
 *  would be a dependency in the gate's own boot path. */
export function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1; // `a/**/b` must also match `a/b`
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

const compiled = RULES.map((r) => ({ rule: r, res: r.patterns.map(globToRegExp) }));
const ignoredRes = IGNORED_PATTERNS.map(globToRegExp);

/** True for a path git would never have reported in the first place. Cheap
 *  belt-and-braces: the runner's inputs come from git, which already omits
 *  ignored paths. */
export const isIgnoredPath = (p) => ignoredRes.some((re) => re.test(p));

/** The first rule matching `p`, or null. Null is not an error — it is the
 *  fail-closed signal the runner turns into `UNMAPPED … → running every stage`. */
export function matchPath(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const { rule, res } of compiled) if (res.some((re) => re.test(norm))) return rule;
  return null;
}

/**
 * Turn a set of changed paths into a plan.
 *
 * Returns `{ stages, matched, unmapped, ignored, stage0 }` where `stages` is an
 * array in FULL_STAGES order (so two runs of the same diff print the same plan),
 * `matched` is `[{ rule, paths }]` for the report, and `stage0` says whether the
 * protocol-dist barrier has to run in front.
 */
export function selectStages(paths) {
  const matched = new Map();
  const unmapped = [];
  const ignored = [];
  const chosen = new Set();
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    if (isIgnoredPath(p)) {
      ignored.push(p);
      continue;
    }
    const rule = matchPath(p);
    if (!rule) {
      unmapped.push(p);
      for (const s of FULL_STAGES) chosen.add(s);
      continue;
    }
    if (!matched.has(rule.id)) matched.set(rule.id, { rule, paths: [] });
    matched.get(rule.id).paths.push(p);
    for (const s of rule.stages) chosen.add(s);
  }
  const stages = FULL_STAGES.filter((s) => chosen.has(s));
  return {
    stages,
    matched: [...matched.values()],
    unmapped,
    ignored,
    stage0: needsStage0(chosen),
  };
}

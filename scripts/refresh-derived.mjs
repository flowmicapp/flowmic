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
// ⚠️ WHAT THE HOOK MODE DELIBERATELY DOES NOT DO: it never runs `pnpm install`,
// never rebuilds the sidecar payload, and never touches Rust or Flutter build
// output. Those are minutes, not seconds, and a hook that quietly spends minutes
// is a hook that gets blamed for whatever else is slow that day. The two jobs in
// REFRESHERS are second-scale and are the two the ledger measured.
//
// Usage (from a git hook):  node scripts/refresh-derived.mjs <oldRev> <newRev>
// Both revs may be omitted or be the all-zero sha (a fresh clone), in which case
// nothing is assumed to have moved and this exits silently — a clone's setup is
// CONTRIBUTING.md's job, not a hook's.
//
// ── SECOND MODE: `--lane` (SC-3, 2026-09-17) ───────────────────────────
//
// Usage:  node scripts/refresh-derived.mjs --lane [--root <tree>] [--base <ref>]
//         node scripts/refresh-derived.mjs --lane --web-root <web lane tree>
//
// The ship-chain redesign (§2.5) replaces "open a fresh worktree per card" with
// three PERSISTENT slots (`flowmic-app-worktrees/lane-{a,b,c}`, and
// `flowmic-web-worktrees/lane-{a,b}` in the web repo). A slot is reused, so the
// thing that has to be cheap is not creating it but RE-POINTING it — and every
// derived artefact a checkout invalidates has to be brought back with it.
//
// Lane mode is therefore NOT diff-scoped: there is no (oldRev,newRev) range when
// a human types `git checkout -b lane/SC-7` inside a slot that was last used
// three cards ago. It STATES what is stale by measuring the tree, and it is
// idempotent — running it twice in a row prints `SKIP (fresh)` for every row the
// first run fixed. It prints exactly one line per task either way, because a task
// that says nothing is indistinguishable from a task that was never reached.
//
// 🔴 THE ONE THING IT MUST NEVER DO IS TOUCH SOMEBODY'S WORK. The base reset only
// ever runs on a SLOT branch (`lane/a`, `lane/b`, `lane/c`) that is clean and has
// zero commits of its own. A card branch — anything not named after a slot — is
// never reset, never checked out, never stashed, whatever state it is in. That is
// the repo's standing rule for executors ("绝不 `git checkout` / `git restore` /
// `git stash` 别人的文件") expressed as code rather than as a habit.
//
// 🔴 WHY server-core's dist DEPENDS ON protocol's — measured, not assumed
// (2026-09-17, this tree): `apps/server-core/dist/index.js` contains 5 copies of
// the protocol string `INJECT_NOT_IN_ROOM` and its sourcemap names
// `packages/protocol`, i.e. tsup INLINES protocol into the server bundle. So a
// protocol rebuild makes the server bundle stale even though nothing under
// `apps/server-core/src` moved, and a lane refresh that skipped it would leave
// exactly the false-green this file's header was written about. `stt-cloud`'s
// dist was checked the same way and does NOT contain protocol — so it is not
// declared as a dependent, because a dependency nobody measured is a guess.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function hookMain(argv = process.argv.slice(2)) {
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

// ═══════════════════════════════════════════════════════════════════════════
// LANE MODE (SC-3) — bring a persistent lane slot back to a usable state.
// ═══════════════════════════════════════════════════════════════════════════

/** A lane slot's branch name. `lane/a`…`lane/c` in the app repo, `lane/a`…`lane/b`
 *  in the web one — one pattern covers both, and anything else is a CARD branch
 *  that this file must not touch. */
export const SLOT_BRANCH = /^lane\/[a-z]$/;

/** Newest mtime under a path, in ms; 0 when the path does not exist. Directories
 *  are walked; a missing directory is 0 rather than a throw, because "the dist is
 *  not there" and "the dist is old" get the same treatment (rebuild) and the
 *  caller should not have to distinguish them to ask the question. */
export function newestMtimeMs(path) {
  let st;
  try { st = statSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = newestMtimeMs(join(path, entry.name));
    if (child > newest) newest = child;
  }
  return newest;
}

/**
 * The three bundles a lane tree needs before any gate stage can read it.
 *
 * `command` is again the string a human would type; `sources` are the paths whose
 * mtime invalidates `dist`. `dependsOn` is measured, not assumed — see the header.
 */
export const LANE_DISTS = [
  {
    id: 'protocol',
    label: '@flowmic/protocol dist',
    sources: ['packages/protocol/src', 'packages/protocol/package.json'],
    dist: 'packages/protocol/dist',
    dependsOn: [],
    command: 'pnpm --filter @flowmic/protocol build',
    argv: ['pnpm', '--filter', '@flowmic/protocol', 'build'],
  },
  {
    id: 'server-core',
    label: '@flowmic/server-core dist (protocol is INLINED into it — measured)',
    sources: ['apps/server-core/src', 'apps/server-core/package.json'],
    dist: 'apps/server-core/dist',
    dependsOn: ['protocol'],
    command: 'pnpm --filter @flowmic/server-core build',
    argv: ['pnpm', '--filter', '@flowmic/server-core', 'build'],
  },
  {
    id: 'stt-cloud',
    label: '@flowmic/stt-cloud dist',
    sources: ['packages/stt-cloud/src', 'packages/stt-cloud/package.json'],
    dist: 'packages/stt-cloud/dist',
    dependsOn: [],
    command: 'pnpm --filter @flowmic/stt-cloud build',
    argv: ['pnpm', '--filter', '@flowmic/stt-cloud', 'build'],
  },
];

/** The sidecar payload the desktop build stages. Presence-only on purpose: it is
 *  produced from the server-core SOURCE by its own bundler, so an mtime race with
 *  the dist rows above would just make this rebuild on every run. The failure this
 *  removes is the measured one — a fresh lane tree has no `resources/server.js` at
 *  all and `tauri build` dies on it minutes later. */
export const LANE_SIDECAR = {
  id: 'sidecar',
  label: 'desktop sidecar payload (apps/desktop/src-tauri/resources/server.js)',
  artefact: 'apps/desktop/src-tauri/resources/server.js',
  command: 'pnpm -F @flowmic/desktop build:sidecar',
  argv: ['pnpm', '-F', '@flowmic/desktop', 'build:sidecar'],
};

/** Is this bundle out of date? `stale` is true when anything under `sources` is
 *  newer than the newest file in `dist`. A missing dist is reported separately
 *  (`present:false`) because the two have different reasons even though they have
 *  the same fix. */
export function distState(root, spec) {
  const distMs = newestMtimeMs(join(root, spec.dist));
  const srcMs = Math.max(...spec.sources.map((p) => newestMtimeMs(join(root, p))));
  const applies = spec.sources.some((p) => existsSync(join(root, p)));
  return { id: spec.id, applies, present: distMs > 0, srcMs, distMs, stale: applies && srcMs > distMs };
}

/**
 * What a lane refresh WOULD do, with no side effects at all — this is what
 * `--dry-run` prints and what the drill asserts against, so that "it decided to
 * rebuild" can be tested without paying for a real bundler run.
 *
 * `rebuilt` carries the ids already rebuilt in this pass: a downstream row whose
 * dependency was rebuilt is stale by definition, even though its own sources did
 * not move.
 */
export function planDists(root, specs = LANE_DISTS, rebuilt = new Set()) {
  const plan = [];
  for (const spec of specs) {
    const st = distState(root, spec);
    if (!st.applies) { plan.push({ id: spec.id, action: 'skip', reason: 'not in this tree' }); continue; }
    const byDep = spec.dependsOn.find((d) => rebuilt.has(d));
    if (!st.present) plan.push({ id: spec.id, action: 'build', reason: 'dist missing', spec });
    else if (st.stale) plan.push({ id: spec.id, action: 'build', reason: 'source newer than dist', spec });
    else if (byDep) plan.push({ id: spec.id, action: 'build', reason: `${byDep} was rebuilt`, spec });
    else plan.push({ id: spec.id, action: 'skip', reason: 'fresh' });
  }
  return plan;
}

// ── the Playwright browser junction (web lane trees) ───────────────────────
//
// `playwright.config.ts` runs with PLAYWRIGHT_BROWSERS_PATH=0, i.e. the browsers
// live INSIDE node_modules — 707 MB of them, measured in the web checkout on
// 2026-09-17. A lane tree with its own `pnpm install` would download its own copy,
// per lane, per browser upgrade. Every web lane so far has been hand-junctioned to
// the main checkout's copy; this is that hand step, written down.

/** `node_modules/.pnpm/playwright-core@<ver>/node_modules/playwright-core`, or
 *  null when this tree has no Playwright (i.e. it is not a web tree, or nothing
 *  is installed yet — both mean "nothing to do", not "broken"). */
export function playwrightCoreDir(root) {
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  let entries;
  try { entries = readdirSync(pnpmDir); } catch { return null; }
  const hit = entries.filter((e) => e.startsWith('playwright-core@')).sort().pop();
  if (!hit) return null;
  const dir = join(pnpmDir, hit, 'node_modules', 'playwright-core');
  return existsSync(dir) ? dir : null;
}

/**
 * Where the junction goes and what it points at. `sourceRoot` is the checkout
 * that owns the real download — normally the main worktree, derived from
 * `--git-common-dir` so that nothing has to be configured.
 *
 * `applies:false` is returned (rather than an error) whenever either side has no
 * Playwright: a link into a directory that does not exist yet would be a junction
 * that resolves to nothing, which reads as "installed" to every caller.
 */
export function junctionState(root, sourceRoot) {
  const laneCore = playwrightCoreDir(root);
  const srcCore = sourceRoot ? playwrightCoreDir(sourceRoot) : null;
  if (!laneCore || !srcCore) return { applies: false, reason: 'no playwright-core on one side' };
  const link = join(laneCore, '.local-browsers');
  const target = join(srcCore, '.local-browsers');
  if (!existsSync(target)) return { applies: false, reason: 'the source checkout has no downloaded browsers' };
  if (resolve(link) === resolve(target)) return { applies: false, reason: 'this IS the source checkout' };
  return { applies: true, link, target, present: existsSync(link) };
}

/** Create the junction. Windows gets a real `mklink /J` (a symlink needs
 *  privileges a dev shell is not guaranteed to have, and the repo's own
 *  worktree-location lint learned the hard way that Windows path identity is not
 *  string identity); everything else gets a directory symlink. */
export function ensureJunction(state, exec = spawnSync) {
  if (!state.applies || state.present) return null;
  return process.platform === 'win32'
    ? exec('cmd', ['/c', 'mklink', '/J', state.link, state.target], { encoding: 'utf8', windowsHide: true })
    : exec('ln', ['-s', state.target, state.link], { encoding: 'utf8' });
}

// ── the base reset ─────────────────────────────────────────────────────────

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

/**
 * Is this slot IDLE — i.e. may its branch be thrown away and re-pointed at the
 * base? Three conditions, all of which must hold, and any one of which failing is
 * reported BY NAME rather than worked around:
 *   · the branch is a slot branch (`lane/<letter>`), not a card branch;
 *   · the working tree is clean (no unstaged, staged or untracked changes);
 *   · the branch is zero commits ahead of the base.
 *
 * ⚠️ The base is the LOCAL `main`/`develop`, not `origin/…`: that is the ref the
 * main checkout merges cards into, and it is what a lane must be based on. The
 * fetch in `refreshLane` only refreshes remote refs so that `git log` in the slot
 * is not lying; it is best-effort and an offline box is a normal outcome.
 */
export function slotState(root, base) {
  // 🔴 A NESTED DIRECTORY IS NOT ITS WORKTREE. `git` answers about the enclosing
  // repository no matter how deep you stand, so a caller that passed a fixture or
  // a subdirectory would get this worktree's branch back and — one line later —
  // `git reset --hard` applied to somebody's actual lane. The reset is therefore
  // gated on `root` BEING the worktree root, which is a structural guard rather
  // than a rule every caller has to remember.
  const top = `${git(root, ['rev-parse', '--show-toplevel']).stdout ?? ''}`.trim();
  const atRoot = top !== '' && resolve(top).toLowerCase() === resolve(root).toLowerCase();
  const branch = `${git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? ''}`.trim();
  const status = git(root, ['status', '--porcelain']);
  const clean = status.status === 0 && `${status.stdout ?? ''}`.trim() === '';
  const aheadRun = git(root, ['rev-list', '--count', `${base}..HEAD`]);
  const ahead = aheadRun.status === 0 ? Number.parseInt(`${aheadRun.stdout}`.trim(), 10) : Number.NaN;
  const isSlot = SLOT_BRANCH.test(branch);
  let reason = null;
  if (!atRoot) reason = `'${root}' is not a worktree root`;
  else if (!isSlot) reason = `on card branch '${branch}' — never reset, never checked out`;
  else if (!clean) reason = 'slot has uncommitted changes';
  else if (ahead !== 0) reason = Number.isNaN(ahead) ? `cannot compare against '${base}'` : `slot is ${ahead} commit(s) ahead`;
  return { branch, base, atRoot, isSlot, clean, ahead, idle: reason === null, reason };
}

/** The checkout that owns this worktree's object store — the main worktree. */
export function mainCheckoutOf(root) {
  const run = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (run.status !== 0) return null;
  const common = `${run.stdout ?? ''}`.trim();
  return common ? dirname(common) : null;
}

/**
 * Refresh one lane tree. Returns the lines it printed, so a caller (and the
 * drill) can assert on them rather than on a scrape of stdout. Exactly one line
 * per task, always — a task that says nothing is indistinguishable from a task
 * that was never reached.
 *
 * `exec` is injectable for the drill: the DECISIONS are what this file owns; the
 * bundlers are not, and paying 10 s of tsup inside `verify:scripts` to prove that
 * `spawnSync` spawns would be the second proof of the same tree that SC-3 exists
 * to delete.
 */
export function refreshLane(opts = {}) {
  const root = resolve(opts.root ?? REPO_ROOT);
  const base = opts.base ?? (existsSync(join(root, 'packages', 'protocol')) ? 'main' : 'develop');
  const dry = opts.dryRun === true;
  const exec = opts.exec ?? spawnSync;
  const lines = [];
  const say = (id, msg) => {
    const line = `lane[${id}] ${msg}`;
    lines.push(line);
    if (!opts.quiet) process.stdout.write(`${line}\n`);
  };

  // 1 — base reset, and only when the slot is idle.
  const slot = opts.skipBase === true ? { idle: false, reason: 'disabled by caller' } : slotState(root, base);
  if (!slot.idle) say('base', `SKIP (${slot.reason})`);
  else if (dry) say('base', `would reset ${slot.branch} → ${base}`);
  else {
    // Best effort, and BOUNDED: a lane refresh must not be able to sit at an ssh
    // password prompt or a hung remote. `GIT_TERMINAL_PROMPT=0` + `BatchMode`
    // turn "needs credentials" into an instant non-zero, and the timeout turns
    // "remote unreachable" into 20 s rather than forever. The exit status is
    // deliberately ignored: an offline box is a normal outcome, and the reset
    // below targets the LOCAL base either way.
    spawnSync('git', ['fetch', '--quiet'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
    });
    const r = git(root, ['reset', '--hard', base]);
    say('base', r.status === 0
      ? `reset ${slot.branch} → ${base}`
      : `FAILED to reset → ${base}: ${`${r.stderr}`.trim().split('\n').pop()}`);
  }

  // 2 — the bundles, in declaration order so a dependency is rebuilt first.
  const rebuilt = new Set();
  for (const spec of LANE_DISTS) {
    const [step] = planDists(root, [spec], rebuilt);
    if (step.action === 'skip') {
      say(spec.id, step.reason === 'fresh' ? 'SKIP (fresh)' : `SKIP (${step.reason})`);
      continue;
    }
    if (dry) { say(spec.id, `would rebuild (${step.reason}) — ${spec.command}`); rebuilt.add(spec.id); continue; }
    const r = exec(spec.argv[0], spec.argv.slice(1), {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', shell: true, windowsHide: true,
    });
    if (r.status === 0) { rebuilt.add(spec.id); say(spec.id, `rebuilt (${step.reason}) — ${spec.command}`); }
    else say(spec.id, `FAILED — run it yourself: ${spec.command}`);
  }

  // 3 — the sidecar payload, presence-only.
  const sidecarPath = join(root, LANE_SIDECAR.artefact);
  if (!existsSync(join(root, 'apps', 'desktop'))) say(LANE_SIDECAR.id, 'SKIP (not in this tree)');
  else if (existsSync(sidecarPath)) say(LANE_SIDECAR.id, 'SKIP (fresh)');
  else if (dry) say(LANE_SIDECAR.id, `would stage — ${LANE_SIDECAR.command}`);
  else {
    const r = exec(LANE_SIDECAR.argv[0], LANE_SIDECAR.argv.slice(1), {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', shell: true, windowsHide: true,
    });
    say(LANE_SIDECAR.id, r.status === 0
      ? `staged — ${LANE_SIDECAR.command}`
      : `FAILED — run it yourself: ${LANE_SIDECAR.command}`);
  }

  // 4 — the Playwright junction (web lane trees).
  const source = opts.sourceRoot ?? mainCheckoutOf(root);
  const j = junctionState(root, source);
  if (!j.applies) say('browsers', `SKIP (${j.reason})`);
  else if (j.present) say('browsers', 'SKIP (fresh)');
  else if (dry) say('browsers', `would junction ${j.link} → ${j.target}`);
  else {
    const r = ensureJunction(j, exec);
    say('browsers', r && r.status === 0 ? `junctioned → ${j.target}` : `FAILED to junction → ${j.target}`);
  }

  return lines;
}

export function laneMain(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : null; };
  const dryRun = argv.includes('--dry-run');
  const webRoot = flag('--web-root');
  const rootFlag = flag('--root');
  const base = flag('--base');
  // `--web-root` names the OTHER repo's lane tree, so it is refreshed IN ADDITION
  // to (not instead of) this one — one command per lane pair — unless it is the
  // only thing named.
  const targets = [];
  if (!webRoot || rootFlag) targets.push({ root: rootFlag ?? REPO_ROOT, base });
  if (webRoot) targets.push({ root: webRoot, base: base ?? 'develop' });
  for (const t of targets) refreshLane({ ...t, dryRun });
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--lane') || argv.includes('--web-root')) return laneMain(argv);
  return hookMain(argv);
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());

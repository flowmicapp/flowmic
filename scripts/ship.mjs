#!/usr/bin/env node
// SC-4 — ship.mjs: ONE GATE, ONE BUILD, FAN OUT.
// (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §2.2 graph,
//  §2.4 contract, §3.2 what stays outside the eight minutes, §4 R2/R3/R8,
//  §5 row SC-4.)
//
// WHAT THIS IS. A dependency-graph runner over the release scripts this repo
// ALREADY has. Every node is an existing script invoked by name; this file
// contributes exactly three things and deliberately nothing else:
//
//   1. the ORDER and the PARALLELISM (which is where the 57 minutes went — the
//      same tree was proved two, three and four times, sequentially);
//   2. one SHA read once, before the fork, handed to every child (§4 R2);
//   3. one log file per step and one final line, in place of the ~20 lines a
//      human used to assemble by hand.
//
// 🔴 WHAT IT MUST NEVER GROW (§4 R8). A switch that skips the gate. There is no
// flag, no environment variable, and no `--only`/`--skip` spelling that removes
// GATE or PRE from the plan: they carry no target name, so target selection
// cannot reach them, and naming them explicitly is refused with a message that
// says why. `scripts/ship-orchestrator.test.mjs` scans THIS FILE's bytes for
// the shapes such a switch would have to take. The only legitimate way around
// the gate remains a diff somebody can see.
//
// 🔴 WHAT IT MUST NEVER DO (§2.4). Re-implement a child's assertions, or undo a
// child's work. Each deploy script has its own provenance gate, its own byte
// probe and its own rollback; this file reads exit codes. When NY succeeds and
// JP fails, the targets are now on two different versions — the orchestrator
// says so, by name, and leaves the decision to a person. Rolling back a healthy
// release because a sibling failed is a decision, not a cleanup.
//
// Run:
//   node scripts/ship.mjs --dry-run                 plan only, zero side effects
//   node scripts/ship.mjs --only relay,go           just those targets
//   node scripts/ship.mjs --skip site,admin         everything but those
//   node scripts/ship.mjs --feature <marker>        byte criterion for the relay
//   node scripts/ship.mjs --last-deployed <sha>     base for the §1-23 diff
//
// Exit: 0 = every planned step succeeded. Non-zero otherwise.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEEP_FLAG } from './publish-adopted-artifact-gate.mjs';
import { DEFERRED_FLAG } from './publish-manifest-deferred.mjs';
import { adoptedKeepDecision } from './ship-adopted.mjs';
import { siblingRepos } from './ship-preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Windows drive letters are case-insensitive to the filesystem and NOT to pnpm.
 *  [measured 2026-09-18, dev-pc-a, first real ship run] launched from Git Bash,
 *  `import.meta.url` spells this tree `f:\…` while pnpm's own workspace root is
 *  `F:\…`; pnpm then prints `No projects matched the filters "f:\…" in "F:\…"`
 *  and — for a `-r` run — STOPS RECOGNISING THE CURRENT PROJECT AS THE ROOT, so
 *  it includes the root package in the recursion. flowmic-web's root `build` is
 *  itself `pnpm -r run build`, so the outer run and the nested one raced:
 *  `packages/core`'s `empty-dir.mjs dist` wiped the types while the outer run
 *  was type-checking `apps/demo-card` against them ⇒ 13 × `Cannot find module
 *  '@flowmic/web-core'` on a tree that builds green by hand.
 *  🔴 The failure did not look like a path problem at all — it looked like a
 *  broken workspace. Normalise once, here, so every cwd handed to a child is
 *  spelled the way the toolchain spells it. */
export function normalizeRoot(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string') return p;
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

export const REPO_ROOT = normalizeRoot(resolve(HERE, '..'));

// ── durations ────────────────────────────────────────────────────────────────
//
// The design's §2.2 table, in seconds. These are PLANNING numbers: they decide
// which chain the critical path runs through, not what anything waits for. The
// last real run overwrites them (`.local/ship/last-durations.json`), so the
// printed critical path stops being a design value the first time this is used
// for real — which is the whole point of writing the wall clocks back.
export const DESIGN_DURATIONS = Object.freeze({
  PRE: 5, DIST: 12, GATE: 159, BUILD_DESKTOP: 102, BUILD_APK: 95, BUILD_SITE: 39,
  BUILD_GO: 10, BUILD_ADMIN: 10, PUBLISH: 10, DEPLOY_NY: 110, DEPLOY_JP: 110,
  DEPLOY_GO: 40, DEPLOY_SITE: 40, DEPLOY_ADMIN: 30, MANIFEST: 10, VERIFY_MANIFEST: 10,
  CHAIN: 90,
});

// ⚠️ PUBLISH=10 is the design's number for the MECHANICAL half. `publish.mjs`
// chains `publish-download-center.mjs` itself (the design drew that ≈40 s upload
// as a separate branch off PUB), so a real PUBLISH wall clock will read nearer
// 50 s. The number is not corrected here on purpose: correcting a design
// estimate by hand is how an estimate starts passing for a measurement. The
// first real run replaces it with what actually happened.

export const DURATIONS_PATH = join(REPO_ROOT, '.local', 'ship', 'last-durations.json');

export function loadDurations(path = DURATIONS_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const merged = { ...DESIGN_DURATIONS };
    let measured = 0;
    for (const [k, v] of Object.entries(raw.seconds ?? {})) {
      if (Number.isFinite(v) && v > 0 && k in merged) { merged[k] = v; measured += 1; }
    }
    return { durations: merged, source: `${path} (${measured} measured, rest from the design table)` };
  } catch {
    return { durations: { ...DESIGN_DURATIONS }, source: 'design table §2.2 (no run has written wall clocks yet)' };
  }
}

// ── the graph ────────────────────────────────────────────────────────────────
//
// `target` is the name `--only`/`--skip` speak. A node with `target: null`
// cannot be selected away — that is PRE (the machine check, §5 SC-1) and GATE
// (the release authority, §4 R8).
//
// `heavy` marks the steps that eat a whole core group. The scheduler runs at
// most MAX_HEAVY of them at once and always gives GATE the first slot: SC-6
// measured the pairing (gate 175→198 s, tauri 91→139 s, but 205 s paired versus
// 266 s serial), so the cargo build is deliberately allowed to overlap the gate
// and deliberately capped (CARGO_BUILD_JOBS) rather than serialised.
export const MAX_HEAVY = 3;

const SPEC = [
  { name: 'PRE', target: null, needs: [], heavy: false, priority: 0, tool: 'node',
    args: ['scripts/ship-preflight.mjs'], cwd: 'root',
    note: 'SC-1: ProgramFiles(x86), toolchain, four clean trees, orphan gate processes, disk, ssh, .local/*.env, receipt' },

  // 🔴 DIST — the one writer of packages/protocol/dist, hoisted out of the
  // gate so it stops running underneath the readers.
  //
  // tsup builds that directory with `clean: true` (delete, then write). The
  // gate used to own that rebuild as its stage 0, and the desktop build's
  // `beforeBuildCommand` is a vite build that READS it — so the design's
  // biggest overlap (gate + tauri) was a data race the moment a version bump
  // changed protocol's output. [measured 2026-09-18, dev-pc-a: BUILD_DESKTOP
  // died 4 s in with `Could not load .../protocol/dist/chunk-FYD3DU22.js`.]
  // The interim fix serialised BUILD_DESKTOP behind GATE and cost 102 s of
  // critical path. This is the fix that does not: build the dist ONCE, in a
  // step both of them wait on, and hand the gate `--dist-ready` — which
  // verifies by content hash that the directory is the build of this source and
  // REFUSES if it is not (verify/run-delivery-release.mjs, and
  // scripts/protocol-dist-stamp.mjs for the judgment).
  //
  // `target: null` — not selectable, for the same reason GATE is not: every
  // step downstream reads what it produces, so "skip it" is never a choice a
  // flag may express.
  // `heavy: false` — deliberately: it must not take a slot from the builds that
  // start beside it, and it is short enough (about 12 s) that the gate's slot is
  // free by the time it ends. It is also the only step here that writes into a
  // directory other steps read, which is precisely why nothing else may run
  // while it does.
  { name: 'DIST', target: null, needs: ['PRE'], heavy: false, priority: 0, tool: 'pnpm',
    args: ['verify:protocol-dist'], cwd: 'root',
    note: 'builds packages/protocol/dist ONCE and stamps it; GATE and BUILD_DESKTOP both read that dist and both wait here' },

  { name: 'GATE', target: null, needs: ['PRE', 'DIST'], heavy: true, priority: 0, tool: 'pnpm',
    args: ['verify:delivery:release', '--dist-ready'], cwd: 'root',
    note: 'SC-6 parallel receipt gate; writes .local/gate-receipt.json — publish.mjs and delivery_gate.py both read it' },

  // 🔴 BUILD_DESKTOP waits for DIST, not for GATE — and that edge is
  // RELEASE-IRONRULES 1-11, not a scheduling preference. What 1-11 forbids is
  // the desktop build overlapping a REBUILD of packages/protocol/dist, and with
  // the rebuild hoisted into DIST there is no longer a rebuild to overlap: the
  // gate now runs with `--dist-ready` and does not touch that directory at all.
  //
  // This restores the design's single biggest overlap (2.2 paired 205 s vs
  // 266 s serial; the interim serialisation cost 384 s -> 486 s of planning
  // critical path, measured 2026-09-18). The PREMISE is different from the one
  // the original overlap rested on, and that difference is the whole point: it
  // used to be "they happen not to collide", which a version bump falsified. It
  // is now "nothing rebuilds that directory while either of them runs", which
  // the DIST edge enforces and the gate's stamp refusal checks.
  // BUILD_APK and BUILD_GO still start at t=0: neither reads that dist.
  { name: 'BUILD_DESKTOP', target: 'desktop', needs: ['PRE', 'DIST'], heavy: true, priority: 1, tool: 'pnpm',
    args: ['--filter', '@flowmic/desktop', 'tauri:build'], cwd: 'root',
    note: 'two WiX MSIs + the portable payload; runs beside GATE again because DIST owns the protocol/dist rebuild (§1-11)' },

  { name: 'BUILD_APK', target: 'apk', needs: ['PRE'], heavy: true, priority: 2, tool: 'make',
    args: ['-C', 'apps/mobile', 'release'], cwd: 'root',
    note: 'NEVER a bare `flutter build apk --release` (UP-7): the make target carries FLOWMIC_SELF_UPDATE=1' },

  { name: 'BUILD_SITE', target: 'site', needs: ['PRE'], heavy: true, priority: 3, tool: 'pnpm',
    args: ['build'], cwd: 'web',
    note: 'marketing site dist/, stamped with HEAD (deploy/dist_build_stamp.py reads it back)' },

  { name: 'BUILD_GO', target: 'go', needs: ['PRE'], heavy: true, priority: 4, tool: 'pnpm',
    args: ['-r', 'run', 'build'], cwd: 'go',
    note: '/go web client + the demo island' },

  { name: 'BUILD_ADMIN', target: 'admin', needs: ['PRE'], heavy: true, priority: 5, tool: 'pnpm',
    args: ['build'], cwd: 'admin', note: 'ops console dist/' },

  { name: 'PUBLISH', target: 'publish', needs: ['GATE', 'BUILD_DESKTOP', 'BUILD_APK'], heavy: false, priority: 6,
    tool: 'node', args: ['scripts/publish.mjs'], cwd: 'root',
    note: 'GATE 0 inside it reuses the receipt this round already earned; chains the download centre itself' },

  // 🔴 MANIFEST RUNS BEFORE THE RELAY DEPLOYS, AND THAT IS NOT A PREFERENCE.
  // `build-update-manifest.mjs` only WRITES publish/update-manifest.json — its
  // own closing lines say so ("this script only produces a file, it does not
  // publish"). The thing that puts that file on a relay is the relay deploy
  // itself: deploy/deploy-vps-app.py uploads MANIFEST_LOCAL (the main repo's
  // publish/update-manifest.json) to /etc/flowmic-app/updates.json, which is
  // what /api/updates/latest serves.
  // So the old edge (MANIFEST after both deploys) had two failures in one: the
  // manifest this round built reached nobody, and the deploys uploaded the
  // PREVIOUS round's file — advertising an older version from a round that
  // believed it had just announced itself.
  // It still needs PUBLISH, for the reason it always did: its gate ② verifies
  // every URL by fetching it, so the artifacts must already be on the download
  // centre before the manifest that points at them may be written.
  { name: 'MANIFEST', target: 'manifest', needs: ['PUBLISH'], heavy: false, priority: 7,
    tool: 'node', args: ['scripts/build-update-manifest.mjs'], cwd: 'root',
    note: 'writes publish/update-manifest.json; the relay deploys below are what carry it to /etc/flowmic-app/updates.json' },

  { name: 'DEPLOY_NY', target: 'relay', needs: ['PUBLISH', 'MANIFEST'], heavy: false, priority: 7, tool: 'py',
    args: ['-3', 'deploy/deploy-vps-app.py'], cwd: 'web', env: 'vps.env',
    note: 'writer node; its own GATE 0 reuses the receipt (SC-2); uploads publish/update-manifest.json' },

  { name: 'DEPLOY_JP', target: 'relay', needs: ['PUBLISH', 'MANIFEST'], heavy: false, priority: 7, tool: 'py',
    args: ['-3', 'deploy/deploy-vps-app.py'], cwd: 'web', env: 'vps-jp.env',
    note: 'read replica; §1-23 puts it FIRST on a round that alters the users table' },

  { name: 'DEPLOY_GO', target: 'go', needs: ['PUBLISH', 'BUILD_GO'], heavy: false, priority: 8, tool: 'bash',
    args: ['deploy/deploy-go-static.sh'], cwd: 'go', note: 'scp + verify-go-site.mjs' },

  { name: 'DEPLOY_SITE', target: 'site', needs: ['PUBLISH', 'BUILD_SITE'], heavy: false, priority: 8, tool: 'py',
    args: ['-3', 'deploy/deploy-vps-web.py'], cwd: 'web', note: 'timestamped release dir + symlink flip' },

  { name: 'DEPLOY_ADMIN', target: 'admin', needs: ['PUBLISH', 'BUILD_ADMIN'], heavy: false, priority: 8, tool: 'py',
    args: ['-3', 'deploy/deploy-vps-admin.py'], cwd: 'admin', note: 'ops console' },

  // 🔴 VERIFY_MANIFEST — ruling ①'s question, asked at the one node that can
  // answer it with a yes. publish.mjs used to ask it, and in this graph it
  // never could: the steps that make it true are downstream of PUBLISH, so the
  // gate failed every non-freeze round on a fact about the graph rather than
  // about the release. PUBLISH is therefore handed `--manifest-deferred` (see
  // attachCommands) and the SAME script runs here, after both relay nodes are
  // serving the new manifest. It needs BOTH of them because an installed client
  // may reach either.
  // ⚠️ `cloud-chain.mjs` does NOT cover this: it never reads
  // /api/updates/latest [grepped 2026-09-18 — zero hits for `updates` in that
  // file], so without this node a full round would end green with the update
  // service still naming the previous version. That is 0.2.61's evening, which
  // is the release ruling ① was written about.
  { name: 'VERIFY_MANIFEST', target: 'manifest', needs: ['DEPLOY_NY', 'DEPLOY_JP'], heavy: false, priority: 9,
    tool: 'node', args: ['scripts/verify-live-update-manifest.mjs'], cwd: 'root',
    note: 'the live /api/updates/latest must now advertise this round; red here fails the ship' },

  { name: 'CHAIN', target: 'chain', needs: ['VERIFY_MANIFEST'], heavy: false, priority: 10, tool: 'node',
    args: ['deploy/cloud-chain.mjs'], cwd: 'web', note: 'public end-to-end; ALL CHECKS PASSED' },
];

export const TARGETS = Object.freeze([...new Set(SPEC.map((s) => s.target).filter(Boolean))]);
const UNSELECTABLE = Object.freeze(SPEC.filter((s) => s.target === null).map((s) => s.name));

/**
 * Build the plan.
 *
 * @param only   target names to keep (empty = all)
 * @param skip   target names to drop
 * @param serialRelay  §1-23: put JP ahead of NY, serially
 * Returns { nodes, skipped, droppedEdges }. `skipped`/`droppedEdges` are the
 * material for the SKIP lines — nothing leaves the plan silently.
 */
export function buildGraph({ only = [], skip = [], serialRelay = false } = {}) {
  for (const name of [...only, ...skip]) {
    if (UNSELECTABLE.includes(name.toUpperCase())) {
      throw new Error(`\`${name}\` is not a target: PRE, DIST and GATE are not selectable. The gate is the release authority (design §4 R8), the preflight is what keeps a round from dying four minutes in, and DIST is the single writer of packages/protocol/dist that every step downstream reads. The only way past the gate is a diff somebody can see.`);
    }
    if (!TARGETS.includes(name)) {
      throw new Error(`unknown target \`${name}\` — known targets: ${TARGETS.join(', ')}`);
    }
  }
  const keep = (s) => {
    if (s.target === null) return true;
    if (only.length > 0) return only.includes(s.target);
    return !skip.includes(s.target);
  };
  const kept = SPEC.filter(keep);
  const keptNames = new Set(kept.map((s) => s.name));
  const skipped = SPEC.filter((s) => !keep(s)).map((s) => ({
    name: s.name,
    reason: only.length > 0 ? `target \`${s.target}\` is not in --only ${only.join(',')}` : `target \`${s.target}\` is in --skip ${skip.join(',')}`,
  }));
  const droppedEdges = [];
  const nodes = kept.map((s) => {
    const needs = [];
    for (const n of s.needs) {
      if (keptNames.has(n)) needs.push(n);
      else droppedEdges.push({ from: s.name, to: n });
    }
    return { ...s, needs };
  });
  // 🔴 EVERY step downstream of the gate must still be downstream of the gate
  // after target selection. Without this, `--only relay,go` drops PUBLISH and
  // the relay deploys — which only reached GATE *through* PUBLISH — become
  // roots, i.e. they start racing the gate they are supposed to be standing on.
  // That is a gate-skipping switch built out of two innocent flags, which is
  // exactly the shape §4 R8 says must not exist. So the edge is re-attached
  // directly rather than dropped.
  // ⚠️ Only for the steps the FULL graph puts downstream of the gate. The
  // builds are siblings of the gate, not children of it — running them at t=0
  // beside the gate is the design's single biggest overlap (§2.2), and making
  // them wait would undo it.
  if (keptNames.has('GATE')) {
    const reachesIn = (table, name, seen = new Set()) => {
      for (const d of table.get(name)?.needs ?? []) {
        if (d === 'GATE') return true;
        if (!seen.has(d)) { seen.add(d); if (reachesIn(table, d, seen)) return true; }
      }
      return false;
    };
    const full = new Map(SPEC.map((s) => [s.name, s]));
    const kept2 = new Map(nodes.map((n) => [n.name, n]));
    for (const n of nodes) {
      if (n.name === 'PRE' || n.name === 'DIST' || n.name === 'GATE') continue;
      if (!reachesIn(full, n.name)) continue;
      if (reachesIn(kept2, n.name)) continue;
      n.needs = [...n.needs, 'GATE'];
      droppedEdges.push({ from: n.name, to: null, regate: true });
    }
  }
  if (serialRelay) {
    const ny = nodes.find((n) => n.name === 'DEPLOY_NY');
    const jp = nodes.find((n) => n.name === 'DEPLOY_JP');
    // §1-23: the replica must carry the new column BEFORE the writer's snapshot
    // starts shipping it. Encoded as an edge so it survives the scheduler — a
    // comment saying "run JP first" survives nothing.
    if (ny && jp && !ny.needs.includes('DEPLOY_JP')) ny.needs = [...ny.needs, 'DEPLOY_JP'];
  }
  return { nodes, skipped, droppedEdges };
}

// ── critical path ────────────────────────────────────────────────────────────
//
// The longest chain of `needs`, weighted by duration — i.e. the wall clock this
// plan cannot go below no matter how many cores are thrown at it. Printed so a
// reader can tell a plan that got slower from a machine that got slower.
export function criticalPath(nodes, durations = DESIGN_DURATIONS) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const memo = new Map();
  const visit = (name, stack = []) => {
    if (memo.has(name)) return memo.get(name);
    if (stack.includes(name)) throw new Error(`cycle in the graph at ${name}: ${[...stack, name].join(' -> ')}`);
    const node = byName.get(name);
    const own = durations[name] ?? 0;
    let best = { seconds: own, path: [name] };
    for (const need of node.needs) {
      const up = visit(need, [...stack, name]);
      if (up.seconds + own > best.seconds) best = { seconds: up.seconds + own, path: [...up.path, name] };
    }
    memo.set(name, best);
    return best;
  };
  let best = { seconds: 0, path: [] };
  for (const n of nodes) {
    const r = visit(n.name);
    if (r.seconds > best.seconds) best = r;
  }
  return best;
}

export const mmss = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ── §1-23: does this round alter the users table? ────────────────────────────
//
// There is no migrations directory in this repo — every ALTER lives in
// `apps/server-core/src/db/*.ts` (connection.ts holds all five `ALTER TABLE
// users` today), applied at process start. So the question is asked of the diff
// itself, not of a filename.
//
// 🔴 FAIL CLOSED. Unknown base, git failure, unreadable diff ⇒ SERIAL. The cost
// of a needless serial round is 110 s; the cost of getting it wrong is a replica
// that stops replicating (NR-22, measured: `table main.users has 14 columns but
// 15 values were supplied`).
export const DB_DIFF_PATH = 'apps/server-core/src/db';
const USERS_DDL_RE = /^\+.*\b(?:ALTER\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+`?users`?\b/im;

export function usersMigrationTouched({ root = REPO_ROOT, base = null, head = 'HEAD', runGit = null } = {}) {
  if (!base) return { serial: true, reason: 'no last-deployed sha to diff against — fail closed (§1-23: unknown ⇒ replica first)' };
  const git = runGit ?? ((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }));
  const r = git(['diff', '--unified=0', `${base}..${head}`, '--', DB_DIFF_PATH]);
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') {
    return { serial: true, reason: `could not diff ${base}..${head} over ${DB_DIFF_PATH} — fail closed` };
  }
  if (USERS_DDL_RE.test(r.stdout)) {
    return { serial: true, reason: `${base.slice(0, 12)}..${head} adds DDL against the users table — §1-23 puts the replica (JP) first` };
  }
  return { serial: false, reason: `${base.slice(0, 12)}..${head} adds no users-table DDL — the two nodes may go in parallel` };
}

// ── environment ──────────────────────────────────────────────────────────────
//
// Moved to scripts/ship-env.mjs on 2026-09-18 (this file hit the 800-line cap;
// the four machine-facing helpers were the one family that comes out whole).
// Re-exported, not just imported: the drill and any future caller keep reading
// them from here, so the split is a fact about where the lines live and not a
// change to this file's surface.
import { childEnv, resolveProgramFilesX86, resolveTools, spawnPlan } from './ship-env.mjs';

export { childEnv, resolveProgramFilesX86, resolveTools, spawnPlan };
export { adoptedKeepDecision };

// ── the runner ───────────────────────────────────────────────────────────────

export const STATUS = Object.freeze({ OK: 'ok', FAIL: 'fail', BLOCKED: 'blocked' });

/**
 * Execute the graph.
 *
 * @param nodes    from buildGraph; each needs a `run(logStream)` supplied by
 *                 `attachCommands` (production) or by the drill (fakes).
 * @param maxHeavy concurrency cap for `heavy` nodes.
 * @param onEvent  ({kind,name,...}) for the one-line status stream.
 */
export async function runGraph(nodes, { maxHeavy = MAX_HEAVY, onEvent = () => {}, now = () => Date.now() } = {}) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const results = new Map();
  const order = [];
  let heavyRunning = 0;
  const running = new Set();
  const t0 = now();

  const ready = () => nodes
    .filter((n) => !results.has(n.name) && !running.has(n.name))
    .filter((n) => n.needs.every((d) => results.has(d)))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const startable = (n) => !(n.heavy && heavyRunning >= maxHeavy);

  await new Promise((done) => {
    // Loop until a pass changes nothing: blocking a node makes ITS dependents
    // eligible in the same tick, and a single pass over one `ready()` snapshot
    // would leave those stranded — the run would then simply stop with children
    // neither started nor accounted for, which is the silent kind of failure
    // this whole file exists to make impossible.
    const pump = () => {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const n of ready()) {
          const bad = n.needs.filter((d) => results.get(d)?.status !== STATUS.OK);
          if (bad.length > 0) {
            results.set(n.name, { status: STATUS.BLOCKED, ms: 0, blockedBy: bad });
            onEvent({ kind: 'blocked', name: n.name, blockedBy: bad });
            progressed = true;
            continue;
          }
          if (!startable(n)) continue;
          progressed = true;
          running.add(n.name);
          order.push(n.name);
          if (n.heavy) heavyRunning += 1;
          const started = now();
          onEvent({ kind: 'start', name: n.name, at: started - t0 });
          Promise.resolve()
            .then(() => n.run())
            .then((exit) => ({ exit }), (err) => ({ exit: -1, err }))
            .then(({ exit, err }) => {
              const ms = now() - started;
              running.delete(n.name);
              if (n.heavy) heavyRunning -= 1;
              const status = exit === 0 ? STATUS.OK : STATUS.FAIL;
              results.set(n.name, { status, ms, exit, error: err ? String(err.message || err) : null });
              onEvent({ kind: 'end', name: n.name, status, ms, exit });
              pump();
            });
        }
      }
      if (running.size === 0 && ready().length === 0) done();
    };
    pump();
  });

  // A node nobody ever ran because a heavy slot never freed cannot happen (the
  // pump re-runs on every completion), but a node whose needs were all blocked
  // can: mark it rather than leaving a hole in the table.
  for (const n of nodes) if (!results.has(n.name)) results.set(n.name, { status: STATUS.BLOCKED, ms: 0, blockedBy: n.needs });
  const ok = [...results.values()].every((r) => r.status === STATUS.OK);
  return { ok, results, order, totalMs: now() - t0, byName };
}

/** The fixed final line (§2.4). `targets=` carries one `NAME=status` per planned
 *  step, so the line that says FAIL also says WHAT failed — a final line that
 *  needs a second line to be actionable is how a summary becomes decoration. */
export function finalLine({ sha, ok, totalMs, criticalSeconds, results }) {
  const list = [...results.entries()].map(([name, r]) => `${name}=${r.status}`).join(',');
  return `SHIP ${sha} ${ok ? 'OK' : 'FAIL'} total=${mmss(totalMs / 1000)} critical=${mmss(criticalSeconds)} targets=${list}`;
}

// ── split state ──────────────────────────────────────────────────────────────
//
// §2.4's two functions (splitStateLine, probeVersions) moved to
// scripts/ship-split-state.mjs on 2026-09-18, VERBATIM, when this file hit the
// 800-line cap. Re-exported, not merely imported: the drill and every caller
// keep reading them from here.
import { probeVersions, splitStateLine } from './ship-split-state.mjs';

export { probeVersions, splitStateLine };

// ── wiring the real commands ─────────────────────────────────────────────────

const TOOL_NAMES = ['node', 'pnpm', 'make', 'py', 'bash', 'git'];

/** Where each step runs. The sibling directory names are NOT re-typed here:
 *  `ship-preflight.mjs` already owns that list (it is what it runs `git status`
 *  over), and a second copy would be both a second disclosure the open-source
 *  export has to waive and a value free to drift from the one the preflight
 *  actually checked. `cwd: 'web'` on a node means "the repo the preflight calls
 *  the web one". */
function repoDirs(root) {
  const siblings = siblingRepos(root).filter((r) => r.dir !== root);
  const pick = (matches, what) => {
    const hit = siblings.find(matches);
    if (!hit) throw new Error(`ship: the preflight's sibling list has no repo for ${what} — the two files have drifted`);
    return hit.dir;
  };
  // Siblings are spelled the same way the root is, for the reason normalizeRoot
  // gives — a sibling reached through a lowercase parent inherits the bug.
  const pickDir = (matches, what) => normalizeRoot(pick(matches, what));
  const web = pickDir((r) => r.name.endsWith('-app-web'), 'the marketing site and the deploy scripts');
  const admin = pickDir((r) => r.name.endsWith('-app-admin'), 'the ops console');
  // The /go client's repo is the one whose name ends in -web and is NOT the
  // marketing repo — matched by exclusion rather than by a second spelling.
  const go = pickDir((r) => r.name.endsWith('-web') && r.dir !== web, 'the /go client');
  return { root, web, go, admin };
}

/** Give every node a `run()` that spawns its real child and streams the whole
 *  output into `.local/ship/<sha>/<step>.log`. The log is the child's own
 *  words, verbatim — this file never summarises a child (§3.1's last row). */
export function attachCommands(nodes, { root = REPO_ROOT, tools, logDir, note, feature, sha, freezeRound = false, manifestDeferred = false, keepAdopted = false }) {
  const dirs = repoDirs(root);
  const cores = availableParallelism ? availableParallelism() : 4;
  for (const n of nodes) {
    const exe = tools[n.tool];
    const cwd = dirs[n.cwd];
    // 🔴 FLOWMIC_SHIP_RUN_PID is how a child tells "a test process from another
    // session" from "the step running beside me". The release gate refuses when
    // it sees a vitest it did not start — and BUILD_SITE's `pnpm build` in
    // the marketing-site repo runs `vitest run` as part of itself, so on the first real
    // parallel round GATE refused its OWN sibling before running a stage
    // [.local/ship/e32c929ef8df/GATE.log]. The gate takes the descendant closure
    // of this one pid; everything outside it is still refused, which is what
    // kept today's PRE right about another worktree's Playwright run.
    const extra = { FLOWMIC_SHIP_SHA: sha, FLOWMIC_SHIP_RUN_PID: String(process.pid) };
    if (n.name === 'BUILD_DESKTOP') extra.CARGO_BUILD_JOBS = String(Math.max(1, Math.floor(cores / 4)));
    if (n.env) { extra.FLOWMIC_VPS_ENV = join(dirs.web, 'deploy', n.env); extra.FLOWMIC_OSS_ROOT = dirs.root; }
    let args = [...n.args];
    // 🔴 The freeze round's exit, handed to publish.mjs by the only party that
    // can know this round has one: whoever decided the live manifest is not
    // being touched. `publish.mjs` otherwise ends on the ruling-① gate, which
    // demands the live /api/updates/latest already advertise this version — and
    // under the 2026-09-09 freeze nobody may make that true, so PUBLISH could
    // not end green and every DEPLOY_* behind it was unreachable through this
    // chain [measured 2026-09-18, first real run].
    // The flag is NOT a skip: publish stops in the same place and prints what
    // the live manifest still points at; it exits 0 because in this round that
    // state is the intended end. See scripts/publish-freeze-round.mjs.
    if (n.name === 'PUBLISH' && freezeRound) args = [...args, '--freeze-round'];
    // 🔴 The OTHER half of the same problem, and the opposite answer. When
    // MANIFEST *is* in the plan, ruling ①'s gate is not wrong — it is merely
    // asked too early: nothing downstream of PUBLISH has run yet, so the live
    // endpoint cannot possibly name this round. The flag moves the assertion to
    // VERIFY_MANIFEST, which runs the very same script after both relays carry
    // the new manifest and fails the ship if it is red. publish.mjs refuses the
    // flag unless FLOWMIC_SHIP_RUN_PID is set, so it can only ever be used by a
    // run that owns that later step (scripts/publish-manifest-deferred.mjs).
    if (n.name === 'PUBLISH' && manifestDeferred) args = [...args, DEFERRED_FLAG];
    if (n.name === 'PUBLISH' && keepAdopted) args = [...args, KEEP_FLAG];
    if (n.name === 'DEPLOY_NY' || n.name === 'DEPLOY_JP') {
      args = [...args, note, ...(feature ? ['--feature', feature] : ['--no-feature-markers'])];
    }
    const plan = spawnPlan(exe || n.tool, args);
    n.describe = `${n.tool} ${args.join(' ')}   (cwd ${n.cwd}${n.env ? `, ${n.env}` : ''})`;
    n.ready = { exe, cwd, plan };
    n.run = () => new Promise((done) => {
      if (!exe) { done(127); return; }
      if (!existsSync(cwd)) { done(127); return; }
      const log = createWriteStream(join(logDir, `${n.name}.log`));
      log.write(`$ ${plan.file} ${plan.args.join(' ')}\n$ cwd ${cwd}\n\n`);
      const child = spawn(plan.file, plan.args, { cwd, env: childEnv({ tools, extra }), windowsHide: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on('error', (e) => { log.end(`\n[spawn error] ${e.message}\n`); done(-1); });
      child.on('close', (code) => { log.end(`\n[exit ${code}]\n`); done(code ?? -1); });
    });
  }
  return nodes;
}

// ── handing the four outside queues to somebody who can wait (SC-9) ──────────
//
// §3.2: Apple's notary service, TestFlight processing, the public repo's CI and
// the download centre's rotation all finish on somebody else's clock, and none of
// them is allowed to hold the eight-minute line. So the last thing this file does
// is start `scripts/ship-watch.mjs` DETACHED and stop caring about it.
//
// 🔴 It is started, not awaited, and its first pass is not run here. A `--once`
// pass costs two ssh round trips to the Mac plus a GitHub call — small, but it is
// time spent inside the very window this whole design exists to shrink, buying an
// answer that is guaranteed to be PENDING (nothing external can have finished in
// the seconds since PUBLISH). The watcher writes its four PENDING rows the moment
// it starts, so the file exists immediately either way.
//
// 🔴 --adopt is NOT passed. Adoption uploads bytes to the download centre; it is
// an action, and actions belong to a person who typed them. A watcher left
// running by an orchestrator must be safe to forget about.
function startExternalWatch({ root, sha, version, logDir }) {
  const watcher = join(root, 'scripts', 'ship-watch.mjs');
  if (!existsSync(watcher)) {
    // The IT-33 treatment: "this capability was never shipped to you" and "this
    // step failed" are different sentences, and only one of them needs acting on.
    console.log('EXTERNAL not watched — scripts/ship-watch.mjs is not in this tree (the export omits the internal watcher).');
    return null;
  }
  try {
    const out = openSync(join(logDir, 'ship-watch.log'), 'a');
    const child = spawn(process.execPath, [watcher, sha, '--version', version], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    });
    child.unref();
    console.log(`EXTERNAL watching MAC, TESTFLIGHT, PUBLIC_CI, DC_ROTATION (pid ${child.pid}) -> ${join(root, '.local', 'ship', sha, 'external.status')}`);
    console.log('         read it any time with: node scripts/release-status.mjs');
    return child;
  } catch (err) {
    // Failing to start the watcher must not fail a release that actually shipped
    // — but it must not go quiet either, because the four queues are then nobody's.
    console.log(`EXTERNAL not watched — could not start ship-watch.mjs: ${err?.message ?? err}. Start it by hand: node scripts/ship-watch.mjs ${sha} --version ${version}`);
    return null;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function listFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a comma-separated list of targets (${TARGETS.join(', ')})`);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function valueFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

export function parseArgs(argv) {
  const known = new Set(['--dry-run', '--only', '--skip', '--feature', '--note', '--last-deployed']);
  for (const a of argv) {
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown option ${a} — known: ${[...known].join(' ')}`);
  }
  return {
    dryRun: argv.includes('--dry-run'),
    only: listFlag(argv, '--only'),
    skip: listFlag(argv, '--skip'),
    feature: valueFlag(argv, '--feature'),
    note: valueFlag(argv, '--note'),
    lastDeployed: valueFlag(argv, '--last-deployed'),
  };
}

export async function main(argv = process.argv.slice(2), { root = REPO_ROOT } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`ship: ${e.message}`); return 2; }

  // ONE sha, read ONCE, before any fork (§4 R2). Every child is handed this one;
  // no child re-reads HEAD, so a commit landing mid-round cannot make two
  // children disagree about what they are shipping — and each child's own
  // provenance gate refuses if HEAD has moved under it.
  const shaOut = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (shaOut.status !== 0) { console.error('ship: cannot read HEAD'); return 2; }
  const sha = shaOut.stdout.trim().slice(0, 12);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  const mig = usersMigrationTouched({ root, base: opts.lastDeployed });
  let plan;
  try { plan = buildGraph({ only: opts.only, skip: opts.skip, serialRelay: mig.serial }); }
  catch (e) { console.error(`ship: ${e.message}`); return 2; }

  // A freeze round is one where the live manifest is not going to be updated —
  // which this chain can only learn from the plan itself: MANIFEST is a step,
  // and if it is not in the plan then nothing in this round will announce the
  // version to installed clients.
  // ⚠️ The dispatch said "exactly when `manifest` is in --skip". This is that
  // rule GENERALISED to the way the same state can also be reached with
  // `--only` (`--only publish,relay` drops MANIFEST just as thoroughly), and it
  // is stated here rather than silently widened: the trigger is "PUBLISH will
  // run and MANIFEST will not", of which `--skip manifest` is the common case.
  const planNames = new Set(plan.nodes.map((n) => n.name));
  const freezeRound = planNames.has('PUBLISH') && !planNames.has('MANIFEST');

  const { durations, source } = loadDurations();
  const cp = criticalPath(plan.nodes, durations);

  console.log(`ship: ${version} @ ${sha}  (${plan.nodes.length} steps, durations from ${source})`);
  console.log(`§1-23 relay order: ${mig.serial ? 'SERIAL — JP (replica) then NY (writer)' : 'PARALLEL'} — ${mig.reason}`);
  for (const s of plan.skipped) console.log(`SKIP ${s.name} — ${s.reason}`);
  for (const e of plan.droppedEdges) {
    if (e.regate) console.log(`RE-GATE ${e.from} now waits on GATE directly (the step it reached the gate through is not in this plan) — target selection cannot be used to get around the gate`);
    else console.log(`SKIP-EDGE ${e.from} no longer waits for ${e.to} (${e.to} is not in this plan) — ${e.from} will run against whatever is already on disk; its own provenance gate is what decides whether that is shippable`);
  }
  // The same fact about the plan decides both flags, and they are opposites:
  // either nobody will update the live manifest this round (freeze), or a later
  // step of this run will and gets to be the one that asserts it (deferral).
  const manifestDeferred = planNames.has('PUBLISH') && planNames.has('MANIFEST');
  if (planNames.has('PUBLISH')) {
    console.log(freezeRound
      ? 'PUBLISH --freeze-round — MANIFEST is not in this plan, so publish stops at the internal download centre, prints what the live manifest still points at, and exits 0. Installed clients are told NOTHING this round (owner 2026-09-09 release freeze).'
      : 'PUBLISH --manifest-deferred — MANIFEST is in this plan, so the ruling-① live-manifest gate is not asked at PUBLISH (nothing downstream has run yet, so the only honest answer there is "not yet"). VERIFY_MANIFEST asks it after both relays carry the new manifest, and a red answer there fails the ship.');
  }
  if (plan.nodes.some((n) => n.target === 'relay') && !opts.feature) {
    console.log('NOTE relay deploy needs a byte criterion: pass --feature <marker>, or accept --no-feature-markers (this run would send the latter, which is a weaker deploy proof).');
  }
  console.log('\nGRAPH');
  for (const n of plan.nodes) {
    console.log(`  ${n.name.padEnd(15)} est=${String(durations[n.name] ?? 0).padStart(4)}s  needs=${n.needs.length ? n.needs.join('+') : '-'}${n.heavy ? '  [heavy]' : ''}`);
  }
  console.log(`\nCRITICAL PATH  ${cp.path.join(' -> ')}  = ${cp.seconds}s (${mmss(cp.seconds)})`);

  // The external queue's landing (design §3.2): a portable zip this machine
  // cannot build is already sitting in publish/ for THIS version. Decided here,
  // once, from the bytes — never from a flag someone remembered to type.
  let adopted = { keepAdopted: false, kept: [], why: 'PUBLISH is not in this plan' };
  if (planNames.has('PUBLISH')) {
    try { adopted = adoptedKeepDecision({ outDir: join(root, 'publish'), version }); }
    catch (e) {
      // A dry run must still be able to SHOW this refusal — that is what a dry
      // run is for — so it reports and keeps planning; a real round stops here.
      console.error(`ship: ${e.message}`);
      if (!opts.dryRun) return 2;
    }
    console.log(adopted.keepAdopted
      ? `PUBLISH ${KEEP_FLAG} — ${adopted.why}. They survive the clean step and the download-centre upload carries them; MANIFEST then advertises them.`
      : `PUBLISH (no ${KEEP_FLAG}) — ${adopted.why}.`);
  }


  if (opts.dryRun) {
    console.log('\n--dry-run: nothing was executed, nothing was written.');
    return 0;
  }

  const tools = resolveTools(TOOL_NAMES);
  const missing = [...new Set(plan.nodes.map((n) => n.tool))].filter((t) => !tools[t]);
  if (missing.length > 0) { console.error(`ship: tool(s) not on PATH: ${missing.join(', ')} — resolved once here so a PATH that changes mid-round cannot change what a child runs`); return 2; }

  const logDir = join(root, '.local', 'ship', sha);
  mkdirSync(logDir, { recursive: true });
  attachCommands(plan.nodes, { root, tools, logDir, sha, feature: opts.feature, freezeRound, manifestDeferred, keepAdopted: adopted.keepAdopted, note: opts.note || `${version} (${sha})` });

  console.log(`\nlogs: ${logDir}`);
  const res = await runGraph(plan.nodes, {
    onEvent: (e) => {
      if (e.kind === 'start') console.log(`  ▶ ${e.name.padEnd(15)} t+${mmss(e.at / 1000)}`);
      if (e.kind === 'end') console.log(`  ${e.status === STATUS.OK ? '✓' : '✗'} ${e.name.padEnd(15)} ${mmss(e.ms / 1000)} exit=${e.exit}`);
      if (e.kind === 'blocked') console.log(`  · ${e.name.padEnd(15)} BLOCKED by ${e.blockedBy.join(', ')}`);
    },
  });

  const seconds = {};
  for (const [name, r] of res.results) if (r.status === STATUS.OK) seconds[name] = Math.round(r.ms / 1000);
  try {
    mkdirSync(dirname(DURATIONS_PATH), { recursive: true });
    writeFileSync(DURATIONS_PATH, `${JSON.stringify({ sha, at: new Date().toISOString(), seconds }, null, 2)}\n`, 'utf8');
  } catch { /* a missing wall-clock write must not fail a green round */ }

  console.log('\nSTEP              STATUS   WALL     EST');
  for (const n of plan.nodes) {
    const r = res.results.get(n.name);
    console.log(`  ${n.name.padEnd(15)} ${r.status.padEnd(8)} ${mmss(r.ms / 1000)}   ${mmss(durations[n.name] ?? 0)}`);
  }
  const actual = criticalPath(plan.nodes, Object.fromEntries(plan.nodes.map((n) => [n.name, (res.results.get(n.name)?.ms ?? 0) / 1000])));
  console.log(`ACTUAL CRITICAL PATH  ${actual.path.join(' -> ')} = ${mmss(actual.seconds)}`);

  if (!res.ok) {
    const deployed = plan.nodes.filter((n) => n.name.startsWith('DEPLOY_') && res.results.get(n.name)?.status === STATUS.OK).map((n) => n.name);
    const attempted = plan.nodes.filter((n) => n.name.startsWith('DEPLOY_')).map((n) => n.name);
    if (deployed.length > 0 && deployed.length !== attempted.length) {
      console.log(splitStateLine(await probeVersions(attempted)));
      console.log('Nothing was rolled back: each deploy script owns its own rollback, and undoing a healthy release because a sibling failed is a decision, not a cleanup.');
    }
  }
  startExternalWatch({ root, sha, version, logDir });
  console.log(finalLine({ sha, ok: res.ok, totalMs: res.totalMs, criticalSeconds: actual.seconds, results: res.results }));
  return res.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}

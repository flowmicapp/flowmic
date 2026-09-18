// SC-4 drill for scripts/ship.mjs
// (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §2.2/§2.4, §4
//  R2/R3/R8, §5 row SC-4.)
//
// WHAT THIS PROVES, AND WHY EACH HALF NEEDS ITS OWN KIND OF EVIDENCE.
//
// The orchestrator makes two different sorts of claim and they cannot be tested
// the same way:
//
//   · SHAPE claims ("JP runs before NY on a users-table round", "the gate is
//     not selectable", "the critical path is this chain") are about the plan.
//     They are asserted against `buildGraph`/`criticalPath` directly, with no
//     process started, because the plan is the thing being claimed.
//
//   · TIMING claims ("these two really overlapped", "this one really waited")
//     cannot be asserted against the plan at all — a scheduler that ignored
//     every edge would still produce a correct-looking plan object. So §2-§4
//     run REAL child processes (node one-liners that sleep and then write a
//     marker carrying their own start and end) and read the ORDER AND OVERLAP
//     OUT OF THOSE TIMESTAMPS. That is the same distinction CLAUDE.md draws
//     about screens: the two ends of a wire can each be green while nothing
//     ever crossed the middle.
//
// The fake steps are node one-liners writing into a temp dir. One section (6b)
// does call `attachCommands` — it has to, because the thing being checked is
// what argument list publish.mjs would be handed — and it DELETES every `run`
// closure the moment it has read the args, before any assertion. Nothing in
// this file ever calls a wired `run()`, so no gate, build, publish, deploy or
// public check can be started by running it.
//
// EXIT CODES (scripts/run-script-tests.mjs header): 0 = PASS, 1 = FAIL, 2 = SKIP.
//
// Run: `node scripts/ship-orchestrator.test.mjs`

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DESIGN_DURATIONS,
  DURATIONS_PATH,
  STATUS,
  buildGraph,
  criticalPath,
  finalLine,
  mmss,
  resolveProgramFilesX86,
  resolveTools,
  attachCommands,
  runGraph,
  spawnPlan,
  splitStateLine,
  usersMigrationTouched,
  adoptedKeepDecision,
} from './ship.mjs';
import { invocationPids, orphanFindings } from '../verify/run-delivery-release.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHIP = join(HERE, 'ship.mjs');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 13;
const section = (t) => { sectionsRun += 1; console.log(`\n=== ${t} ===`); };
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures += 1; }
}

const tempDirs = [];
const makeTempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tempDirs.push(d); return d; };

/** A step that is a real child process: it sleeps, writes its own start/end
 *  into a marker file, and exits with the code we asked for. The marker is the
 *  evidence — not a callback this file could have fired itself. */
function fakeNode({ name, needs = [], ms = 120, exit = 0, heavy = false, priority = 0, dir }) {
  const marker = join(dir, `${name}.json`);
  return {
    name, needs, heavy, priority, target: 'fake', marker,
    run: () => new Promise((done) => {
      const code = [
        'const fs=require("fs");',
        `const start=Date.now();`,
        `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({name:${JSON.stringify(name)},start,end:Date.now()}));process.exit(${exit});},${ms});`,
      ].join('');
      const c = spawn(process.execPath, ['-e', code], { windowsHide: true });
      c.on('error', () => done(-1));
      c.on('close', (x) => done(x ?? -1));
    }),
  };
}
// A marker that is not there is itself an answer (the step never started), so
// this returns null rather than throwing — a drill that crashes tells you less
// than one that fails a named assertion, and the reverse control below is
// precisely the case where markers go missing.
const readMarker = (n) => (existsSync(n.marker) ? JSON.parse(readFileSync(n.marker, 'utf8')) : null);
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

const runShip = (args) => spawnSync(process.execPath, [SHIP, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });

try {
  // ── §1 the plan's shape: needs, the gate's unselectability, the path ───────
  section('§1 the plan matches the design graph, and the critical path is the design number');
  {
    const { nodes } = buildGraph({});
    // NOTE: copy before sorting. The first cut wrote need('MANIFEST').sort(),
    // which sorts the node's OWN needs array in place — and the next assertion,
    // about the critical path, then read a graph this test had quietly rewritten
    // (it reported DEPLOY_JP where the plan says DEPLOY_NY). 「先核你的尺子」in
    // four characters: the ruler edited the thing it was measuring.
    // `?? [...]` rather than a bare `.needs`: a step DELETED from the plan is
    // exactly what several of these assertions exist to catch, and a drill that
    // throws on it reports less than one that fails by name (measured while
    // reverse-controlling VERIFY_MANIFEST out of the graph: TypeError, no verdict).
    const need = (n) => nodes.find((x) => x.name === n)?.needs ?? ['(no such step in this plan)'];
    assertTrue(need('PRE').length === 0, 'PRE is the root');
    assertTrue(need('DIST').join() === 'PRE', 'DIST waits only for the preflight — it is the single writer of packages/protocol/dist and everything that reads it queues behind this one step');
    assertTrue([...need('GATE')].sort().join() === 'DIST,PRE', `GATE waits for the preflight and the dist build (so the 4-minute deaths happen in second 15) - got ${need('GATE').join()}`);
    for (const b of ['BUILD_APK', 'BUILD_SITE', 'BUILD_GO', 'BUILD_ADMIN']) {
      assertTrue(need(b).join() === 'PRE', `${b} starts at t=0 beside the gate, not behind it (that overlap IS the design)`);
    }
    // 🔴 BUILD_DESKTOP OVERLAPS THE GATE AGAIN — AND THE PREMISE IS NOT THE ONE
    // THE ORIGINAL OVERLAP RESTED ON. Three states, in order, because the
    // middle one is the interesting one:
    //
    //   1. Until 2026-09-18 this read `need('BUILD_DESKTOP') === 'PRE'` with the
    //      same comment as its siblings ("that overlap IS the design"). The
    //      first real ship run falsified it: the desktop build's
    //      beforeBuildCommand is a vite build that READS packages/protocol/dist,
    //      the gate's stage 0 rebuilt that directory with tsup `clean: true`,
    //      and BUILD_DESKTOP died 4 s in with `Could not load
    //      .../protocol/dist/chunk-FYD3DU22.js`
    //      [.local/ship/984c39901bb9/BUILD_DESKTOP.log]. So the assertion had
    //      been pinning a defect as the specification — this repo's 0.2.52 law,
    //      committed again.
    //   2. The interim fix serialised BUILD_DESKTOP behind GATE. Correct, and
    //      expensive: 384 s -> 486 s of planning critical path.
    //   3. Today the rebuild is a step of its own (DIST) that BOTH wait on, and
    //      the gate runs with `--dist-ready`, which makes it verify the dist by
    //      content hash and refuse rather than rebuild. RELEASE-IRONRULES 1-11
    //      forbids the desktop build overlapping a REBUILD of that directory —
    //      and there is no longer a rebuild to overlap.
    //
    // ⚠️ So this assertion looks like state 1 and means something different:
    // then it was "they happen not to collide", which a version bump falsified;
    // now it is "nothing rebuilds that directory while either of them runs",
    // which the DIST edge enforces. If DIST ever stops owning the rebuild, this
    // assertion is wrong again — and the two below (GATE also waits on DIST,
    // and the gate is invoked WITH --dist-ready) are what keep that from being
    // a silent change.
    assertTrue([...need('BUILD_DESKTOP')].sort().join() === 'DIST,PRE', `BUILD_DESKTOP waits for DIST, not for GATE — it runs BESIDE the gate again (got ${need('BUILD_DESKTOP').join()})`);
    const gateNode = nodes.find((n) => n.name === 'GATE');
    assertTrue(gateNode.args.includes('--dist-ready'), `and the gate is invoked with --dist-ready, which is what makes that overlap safe rather than lucky (args: ${gateNode.args.join(' ')})`);
    const distNode = nodes.find((n) => n.name === 'DIST');
    assertTrue(distNode.args.join(' ') === 'verify:protocol-dist' && distNode.heavy === false, `DIST is the protocol dist build and is not heavy (it must not take a slot from the builds beside it) — got \`${distNode.args.join(' ')}\`, heavy=${distNode.heavy}`);
    assertTrue([...need('PUBLISH')].sort().join() === 'BUILD_APK,BUILD_DESKTOP,GATE', 'PUBLISH waits for the gate and both client builds');
    // 🔴 MANIFEST MOVED UPSTREAM OF THE RELAY DEPLOYS on 2026-09-18, and the
    // assertion it replaces read `MANIFEST needs DEPLOY_JP,DEPLOY_NY` with the
    // comment "an installed client may reach either". That sentence was true
    // about the SERVING of the manifest and wrong about the BUILDING of it:
    // build-update-manifest.mjs only writes publish/update-manifest.json, and
    // the thing that carries that file to a node is the relay deploy itself
    // (deploy/deploy-vps-app.py uploads it to /etc/flowmic-app/updates.json).
    // So the old order built a manifest nothing shipped, while the deploys
    // uploaded the PREVIOUS round's copy — i.e. a round could finish green with
    // the update service naming an older version, which is exactly 0.2.61.
    assertTrue(need('MANIFEST').join() === 'PUBLISH', `the manifest is BUILT before the relay deploys, because those deploys are what upload it (got ${need('MANIFEST').join()})`);
    for (const d of ['DEPLOY_NY', 'DEPLOY_JP']) {
      assertTrue([...need(d)].sort().join() === 'MANIFEST,PUBLISH', `${d} waits for the manifest file it is going to upload (got ${need(d).join()})`);
    }
    assertTrue([...need('VERIFY_MANIFEST')].sort().join() === 'DEPLOY_JP,DEPLOY_NY', 'the ruling-① assertion waits for BOTH relay nodes — an installed client may reach either');
    const vm = nodes.find((n) => n.name === 'VERIFY_MANIFEST');
    assertTrue(vm !== undefined && vm.args.join(' ') === 'scripts/verify-live-update-manifest.mjs', `and it runs the same script publish.mjs used to run (got ${vm ? vm.args.join(' ') : 'no VERIFY_MANIFEST step at all'})`);
    assertTrue(need('CHAIN').join() === 'VERIFY_MANIFEST', 'the public end-to-end runs last, behind that assertion');
    const cp = criticalPath(nodes, DESIGN_DURATIONS);
    // 384 s (the original design) + DIST's 12 s. The desktop build is off the
    // critical path again; what replaced it is the one step that genuinely
    // cannot overlap anything, and it costs twelve seconds instead of a hundred.
    assertTrue(cp.path.join('->') === 'PRE->DIST->GATE->PUBLISH->MANIFEST->DEPLOY_NY->VERIFY_MANIFEST->CHAIN', `critical path runs through DIST and the gate, not through the desktop build (got ${cp.path.join('->')})`);
    // 396 s (DIST included) + VERIFY_MANIFEST's 10 s. MANIFEST did not move the
    // number: it was already on the path, on the other side of DEPLOY_NY.
    assertTrue(cp.seconds === 406 && mmss(cp.seconds) === '06:46', `and its length is 406 s / 06:46 = the design's 384 s, plus DIST's 12 s, plus the live-manifest assertion's 10 s (got ${cp.seconds}s)`);
  }

  // ── §2 order: a step really waits for the ones it needs ───────────────────
  section('§2 dependency order is respected by the RUNNER, measured from the children\'s own timestamps');
  {
    const dir = makeTempDir('ship-drill-order-');
    const a = fakeNode({ name: 'A', dir, ms: 120 });
    const b = fakeNode({ name: 'B', needs: ['A'], dir, ms: 120 });
    const c = fakeNode({ name: 'C', needs: ['B'], dir, ms: 120 });
    const res = await runGraph([a, b, c]);
    assertTrue(res.ok === true, 'all three succeeded');
    const [mA, mB, mC] = [readMarker(a), readMarker(b), readMarker(c)];
    assertTrue(mA && mB && mC, "all three actually started (a marker each)");
    if (mA && mB && mC) {
    assertTrue(mB.start >= mA.end, `B started only after A finished (A end ${mA.end}, B start ${mB.start})`);
    assertTrue(mC.start >= mB.end, 'C started only after B finished');
    }
    assertTrue(res.order.join() === 'A,B,C', 'and the runner reports the same order it actually ran');
  }

  // ── §3 parallelism: independent steps really overlap, heavy cap holds ─────
  section('§3 independent steps really overlap, the heavy cap holds, and GATE takes the first slot');
  {
    const dir = makeTempDir('ship-drill-par-');
    const pre = fakeNode({ name: 'PRE', dir, ms: 40, priority: 0 });
    const heavies = ['GATE', 'H1', 'H2', 'H3', 'H4'].map((n, i) => fakeNode({ name: n, needs: ['PRE'], dir, ms: 200, heavy: true, priority: i }));
    const res = await runGraph([pre, ...heavies], { maxHeavy: 3 });
    assertTrue(res.ok === true, 'all five heavy steps succeeded');
    assertTrue(res.order[0] === 'PRE' && res.order[1] === 'GATE', `GATE takes the first heavy slot (order: ${res.order.join(',')})`);
    const m = heavies.map(readMarker);
    assertTrue(m.every(Boolean), "every heavy step actually started");
    if (m.every(Boolean)) {
    assertTrue(overlaps(m[0], m[1]) && overlaps(m[1], m[2]), 'the first three heavy steps genuinely ran at the same time (intervals intersect)');
    // At no instant may more than three be in flight. Sweep every start.
    let worst = 0;
    for (const p of m) worst = Math.max(worst, m.filter((q) => q.start <= p.start && q.end > p.start).length);
    assertTrue(worst <= 3, `never more than 3 heavy steps at once (peak observed: ${worst})`);
    assertTrue(worst === 3, `and the cap was actually reached, so this is a measurement and not an empty schedule (peak ${worst})`);
    }
  }

  // 🔴 THE ONE OVERLAP THIS CHAIN IS BUILT AROUND, MEASURED RATHER THAN
  // ASSUMED: the gate and the desktop build really do run at the same time.
  // This assertion existed before 2026-09-18, was deleted when the desktop
  // build had to be serialised behind the gate (they were racing a tsup
  // `clean: true` over packages/protocol/dist), and is restored here on a
  // DIFFERENT premise: the rebuild now happens once, in DIST, which both of
  // them wait for — so there is no writer left to race. The shape below is the
  // real graph's shape (PRE -> DIST -> {GATE, BUILD_DESKTOP}), with fake steps.
  {
    const dir = makeTempDir('ship-drill-gate-desktop-');
    const pre = fakeNode({ name: 'PRE', dir, ms: 30, priority: 0 });
    const dist = fakeNode({ name: 'DIST', needs: ['PRE'], dir, ms: 60, priority: 0 });
    const gate = fakeNode({ name: 'GATE', needs: ['PRE', 'DIST'], dir, ms: 300, heavy: true, priority: 0 });
    const desktop = fakeNode({ name: 'BUILD_DESKTOP', needs: ['PRE', 'DIST'], dir, ms: 200, heavy: true, priority: 1 });
    const res = await runGraph([pre, dist, gate, desktop], { maxHeavy: 3 });
    assertTrue(res.ok === true, 'PRE -> DIST -> {GATE, BUILD_DESKTOP} all four succeeded');
    const [mDist, mGate, mDesk] = [readMarker(dist), readMarker(gate), readMarker(desktop)];
    assertTrue(mDist && mGate && mDesk, 'all three later steps actually started');
    if (mDist && mGate && mDesk) {
      assertTrue(mGate.start >= mDist.end && mDesk.start >= mDist.end, 'both of them really waited for DIST to finish (the dist is written before either reader opens it)');
      assertTrue(overlaps(mGate, mDesk), 'and then the gate and the desktop build really ran AT THE SAME TIME — the overlap this whole chain is built around, measured from the timestamps the children wrote themselves');
    }
  }

  // ── §4 R2: a failure blocks its dependents and the final line names it ────
  section('§4 R2 a failed step blocks its dependents; nothing downstream runs; the final line says FAIL and names it');
  {
    const dir = makeTempDir('ship-drill-fail-');
    const a = fakeNode({ name: 'A', dir, ms: 60 });
    const bad = fakeNode({ name: 'BAD', needs: ['A'], dir, ms: 60, exit: 3 });
    const down = fakeNode({ name: 'DOWN', needs: ['BAD'], dir, ms: 60 });
    const far = fakeNode({ name: 'FAR', needs: ['DOWN'], dir, ms: 60 });
    const sibling = fakeNode({ name: 'SIB', needs: ['A'], dir, ms: 60 });
    const res = await runGraph([a, bad, down, far, sibling]);
    assertTrue(res.ok === false, 'the run is not OK');
    assertTrue(res.results.get('BAD').status === STATUS.FAIL && res.results.get('BAD').exit === 3, 'the failing step keeps its own exit code');
    assertTrue(res.results.get('DOWN').status === STATUS.BLOCKED, 'its direct dependent is BLOCKED, not failed — the distinction is what tells an operator where to look');
    assertTrue(res.results.get('FAR').status === STATUS.BLOCKED, 'and so is the step behind that one');
    assertTrue(!existsSync(down.marker) && !existsSync(far.marker), 'neither blocked step ever started a process (no marker on disk)');
    assertTrue(res.results.get('SIB').status === STATUS.OK && existsSync(sibling.marker), 'a sibling that did not depend on the failure still ran — one red does not cancel the round');
    const line = finalLine({ sha: 'abc123abc123', ok: res.ok, totalMs: res.totalMs, criticalSeconds: 42, results: res.results });
    assertTrue(line.startsWith('SHIP abc123abc123 FAIL total='), `final line is the fixed format and says FAIL (got: ${line})`);
    assertTrue(/ critical=\d\d:\d\d targets=/.test(line), 'and carries critical= and targets=');
    assertTrue(line.includes('BAD=fail'), 'the final line NAMES the step that failed — a summary needing a second line to be actionable is decoration');
    assertTrue(line.includes('DOWN=blocked') && line.includes('FAR=blocked'), 'and names what that blocked');
  }

  // ── §5 R3: the users-table round puts the replica first ───────────────────
  section('§5 R3 a users-table migration flips JP ahead of NY, serially; no base at all also means serial (fail closed)');
  {
    const alter = "diff --git a/apps/server-core/src/db/connection.ts\n@@ -1 +1 @@\n+      db.exec('ALTER TABLE users ADD COLUMN new_col INTEGER');\n";
    const other = "diff --git a/apps/server-core/src/db/connection.ts\n@@ -1 +1 @@\n+      db.exec('ALTER TABLE usage_events ADD COLUMN new_col INTEGER');\n";
    const git = (stdout) => () => ({ status: 0, stdout });
    assertTrue(usersMigrationTouched({ base: 'aaa', runGit: git(alter) }).serial === true, 'an added ALTER TABLE users ⇒ serial');
    assertTrue(usersMigrationTouched({ base: 'aaa', runGit: git(other) }).serial === false, 'an ALTER against a DIFFERENT table does not trip it (the rule is about the users table, and a rule that fires on everything is not a rule)');
    assertTrue(usersMigrationTouched({ base: 'aaa', runGit: git('') }).serial === false, 'an empty diff ⇒ parallel');
    assertTrue(usersMigrationTouched({ base: null }).serial === true, 'NO last-deployed sha ⇒ serial — fail closed (a needless serial round costs 110 s; getting it wrong stops the replica)');
    assertTrue(usersMigrationTouched({ base: 'aaa', runGit: () => ({ status: 128, stdout: '' }) }).serial === true, 'a git failure ⇒ serial, for the same reason');

    const serial = buildGraph({ serialRelay: true });
    const ny = serial.nodes.find((n) => n.name === 'DEPLOY_NY');
    const jp = serial.nodes.find((n) => n.name === 'DEPLOY_JP');
    assertTrue(ny.needs.includes('DEPLOY_JP'), 'the writer waits for the replica — encoded as an EDGE, because a comment saying "run JP first" survives no scheduler');
    assertTrue(!jp.needs.includes('DEPLOY_NY'), 'and the replica does not wait for the writer (that would be a cycle, and the wrong order)');
    const parallel = buildGraph({ serialRelay: false });
    assertTrue(!parallel.nodes.find((n) => n.name === 'DEPLOY_NY').needs.includes('DEPLOY_JP'), 'without the migration the two nodes are independent again');
    const cpS = criticalPath(serial.nodes, DESIGN_DURATIONS);
    assertTrue(cpS.seconds === 516, `and the serial relay round still costs an extra 110 s (406 -> ${cpS.seconds})`);

    // Same claim, end to end, through the CLI a person actually types.
    const dryS = runShip(['--dry-run']);
    assertTrue(dryS.status === 0 && /SERIAL — JP \(replica\) then NY \(writer\)/.test(dryS.stdout), 'the CLI with no --last-deployed prints the serial plan and says why');
    // 🔴 Same trap as §6: the est= column is the MEASURED wall clock the last
    // real run wrote (.local/ship/last-durations.json), not the design table.
    // Pinning `110s` held only while nothing had been measured — the first real
    // chain clocked DEPLOY_NY at 103 s and this assertion went red on a
    // completely correct plan. The claim here is the EDGE (needs=), which is a
    // fact about the graph; the number is a fact about the last real run. The
    // 110 s is pinned deterministically three lines up, over DESIGN_DURATIONS.
    assertTrue(/DEPLOY_NY\s+est=\s*\d+s\s+needs=PUBLISH\+MANIFEST\+DEPLOY_JP/.test(dryS.stdout), 'and the printed graph shows the flipped edge (an est= is printed; its value comes from the last real run, so it is not pinned)');
  }

  // ── §6 --dry-run runs nothing, --skip says what it dropped ────────────────
  section('§6 --dry-run executes nothing and prints the critical path; --skip prints one line per dropped step');
  {
    const shipDirBefore = existsSync(join(ROOT, '.local', 'ship'));
    const durBefore = existsSync(DURATIONS_PATH) ? statSync(DURATIONS_PATH).mtimeMs : null;
    const dry = runShip(['--dry-run']);
    assertTrue(dry.status === 0, '--dry-run exits 0');
    // 🔴 The CHAIN is deliberately not pinned here. This is the CLI, and the
    // CLI weights the graph with the wall clocks the last real run wrote
    // (.local/ship/last-durations.json) — so which chain is longest is a fact
    // about the last run, not about the plan. Pinning `PRE -> DIST -> GATE`
    // held for exactly as long as no real run had measured anything: the
    // 2026-09-18 chain measured BUILD_APK at 169 s against the design's 95 s,
    // the longest chain moved to PRE -> BUILD_APK -> PUBLISH -> DEPLOY_NY, and
    // this assertion went red on a plan that was completely correct. §1 pins
    // the chain where it is deterministic — over DESIGN_DURATIONS. Here the
    // claim is only that the line is printed and starts at the root.
    assertTrue(/CRITICAL PATH {2}PRE -> \w/.test(dry.stdout), `it prints the critical path, rooted at PRE (the weights, and so the chain, come from the last real run)`);
    assertTrue(/nothing was executed, nothing was written/.test(dry.stdout), 'and says so in as many words');
    assertTrue(existsSync(join(ROOT, '.local', 'ship')) === shipDirBefore, '.local/ship was not created by a dry run');
    const durAfter = existsSync(DURATIONS_PATH) ? statSync(DURATIONS_PATH).mtimeMs : null;
    assertTrue(durAfter === durBefore, 'the wall-clock file was not touched by a dry run');

    const skipped = runShip(['--dry-run', '--skip', 'site,admin']);
    assertTrue(skipped.status === 0, '--skip exits 0');
    for (const n of ['BUILD_SITE', 'DEPLOY_SITE', 'BUILD_ADMIN', 'DEPLOY_ADMIN']) {
      assertTrue(skipped.stdout.includes(`SKIP ${n} —`), `${n} is dropped OUT LOUD, with a reason`);
    }
    assertTrue(!/^ {2}BUILD_SITE/m.test(skipped.stdout), 'and is really out of the graph, not merely announced');
    const only = runShip(['--dry-run', '--only', 'relay,go']);
    assertTrue(/RE-GATE DEPLOY_NY now waits on GATE directly/.test(only.stdout), 'dropping PUBLISH re-attaches the relay deploys to the GATE rather than orphaning them (otherwise two innocent flags build a gate-skipping switch)');
    const bogus = runShip(['--dry-run', '--only', 'nope']);
    assertTrue(bogus.status !== 0 && /unknown target/.test(bogus.stderr), 'an unknown target is refused, not silently ignored');
  }

  // ── §6b the freeze round's exit is decided here and announced here ────────
  //
  // publish.mjs ends on the ruling-① gate: the live /api/updates/latest must
  // already advertise this version. Under the owner's 2026-09-09 release freeze
  // nobody may make that true, so PUBLISH could not end green and every DEPLOY_*
  // behind it was unreachable through this chain [measured 2026-09-18, the first
  // real run: publish did everything, then died on that gate].
  // The flag is passed on a fact about the PLAN — "PUBLISH will run and MANIFEST
  // will not" — rather than on a human remembering, and it is printed either
  // way, because "this round told installed clients nothing" is exactly the kind
  // of thing that must not be inferable only from an absence.
  section('§6b --freeze-round reaches publish.mjs exactly when the manifest is not in the plan, and is announced either way');
  {
    const attach = (argv) => {
      const { nodes } = buildGraph(argv);
      const names = new Set(nodes.map((n) => n.name));
      const freezeRound = names.has('PUBLISH') && !names.has('MANIFEST');
      const manifestDeferred = names.has('PUBLISH') && names.has('MANIFEST');
      attachCommands(nodes, {
        root: ROOT, tools: { node: 'node', pnpm: 'pnpm', make: 'make', py: 'py', bash: 'bash', git: 'git' },
        logDir: makeTempDir('ship-drill-freeze-'), sha: 'aaaabbbbcccc', note: 'drill', freezeRound, manifestDeferred,
      });
      // Disarm immediately: the arg list is the evidence, the closure is a
      // loaded gun. Nothing below may be able to start a real publish.
      const publish = nodes.find((n) => n.name === 'PUBLISH');
      for (const n of nodes) n.run = () => { throw new Error('drill: production commands are never run here'); };
      return publish;
    };
    const full = attach({});
    assertTrue(full && !full.ready.plan.args.includes('--freeze-round'), 'a FULL round does not pass --freeze-round: the manifest is in the plan, so publish must still end on the live-manifest gate');
    const frozen = attach({ skip: ['site', 'admin', 'manifest', 'chain'] });
    assertTrue(frozen.ready.plan.args.includes('--freeze-round'), '--skip manifest passes --freeze-round to publish.mjs');
    const onlyFrozen = attach({ only: ['publish', 'relay'] });
    assertTrue(onlyFrozen.ready.plan.args.includes('--freeze-round'), 'and so does an --only that drops MANIFEST — the same state reached by the other flag (the dispatch named --skip; this is that rule generalised, deliberately)');

    const frozenOut = runShip(['--dry-run', '--skip', 'site,admin,manifest,chain']);
    assertTrue(/PUBLISH --freeze-round —/.test(frozenOut.stdout), 'the plan SAYS the round is frozen');
    assertTrue(/told NOTHING this round/.test(frozenOut.stdout), '  ...and says what that costs, in the words a reader needs (installed clients hear nothing)');
    const fullOut = runShip(['--dry-run']);
    assertTrue(/PUBLISH --manifest-deferred —/.test(fullOut.stdout), 'REVERSE CONTROL: a full round says the opposite out loud rather than staying silent — an absent line would be indistinguishable from a forgotten one');
  }

  // ── §6c the OTHER half: a full round defers ruling ①, and somebody downstream
  //    is holding the other end ────────────────────────────────────────────────
  //
  // publish.mjs ends on the ruling-① gate: the live /api/updates/latest must
  // already advertise this version. In THIS graph that can never be true at
  // PUBLISH — the manifest is built and carried to the relays by steps that run
  // after it — so a full round would have failed at the gate every single time,
  // on a fact about the graph rather than about the release. Since 2026-09-09
  // every round passed --freeze-round, so nobody had met it yet.
  // The fix keeps the ruling's meaning and moves the question: PUBLISH is told
  // the assertion is deferred, and VERIFY_MANIFEST makes it. The two halves are
  // asserted TOGETHER on purpose — a flag that silences a gate with nothing
  // downstream holding the other end is just the gate removed.
  section('§6c a full round defers ruling ① to VERIFY_MANIFEST — flag AND assertion, or neither');
  {
    const attach = (argv) => {
      const { nodes } = buildGraph(argv);
      const names = new Set(nodes.map((n) => n.name));
      attachCommands(nodes, {
        root: ROOT, tools: { node: 'node', pnpm: 'pnpm', make: 'make', py: 'py', bash: 'bash', git: 'git' },
        logDir: makeTempDir('ship-drill-defer-'), sha: 'aaaabbbbcccc', note: 'drill',
        freezeRound: names.has('PUBLISH') && !names.has('MANIFEST'),
        manifestDeferred: names.has('PUBLISH') && names.has('MANIFEST'),
      });
      for (const n of nodes) n.run = () => { throw new Error('drill: production commands are never run here'); };
      return nodes;
    };
    const full = attach({});
    const publish = full.find((n) => n.name === 'PUBLISH');
    assertTrue(publish.ready.plan.args.includes('--manifest-deferred'), 'a FULL round hands publish.mjs --manifest-deferred: at that point in the graph the live endpoint cannot yet name this round, and the honest answer is not a failure');
    assertTrue(!publish.ready.plan.args.includes('--freeze-round'), '  ...and never both flags: "nobody will announce it" and "a later step will" are opposite claims');
    const verify = full.find((n) => n.name === 'VERIFY_MANIFEST');
    assertTrue(verify !== undefined, '🔴 and the full plan CONTAINS the step that makes the deferred assertion');
    assertTrue(verify.args.join(' ') === 'scripts/verify-live-update-manifest.mjs', '  ...which is the same script publish.mjs would have spawned — the assertion is moved, not rewritten');
    assertTrue([...verify.needs].sort().join() === 'DEPLOY_JP,DEPLOY_NY', '  ...and it stands after BOTH relay nodes, which is the first moment the answer can be yes');

    const frozen = attach({ skip: ['site', 'admin', 'manifest', 'chain'] });
    const frozenPublish = frozen.find((n) => n.name === 'PUBLISH');
    assertTrue(!frozenPublish.ready.plan.args.includes('--manifest-deferred'), 'REVERSE CONTROL: a freeze round does NOT get the deferral flag — there is no later step to defer to, and it takes the freeze exit instead');
    assertTrue(frozen.find((n) => n.name === 'VERIFY_MANIFEST') === undefined, '  ...and drops the assertion with the target, rather than asserting something nobody made true');

    // The lock, read from publish.mjs's own module: the flag is not typeable at
    // a terminal, where there would be no later step at all.
    const { DEFERRED_FLAG, SHIP_PID_ENV, deferralRefusal } = await import('./publish-manifest-deferred.mjs');
    assertTrue(deferralRefusal([]) === null, 'without the flag the module says nothing (publish is unchanged)');
    const byHand = deferralRefusal([DEFERRED_FLAG], {});
    assertTrue(byHand !== null && /only meaningful inside/.test(byHand), '🔴 typed by hand it is REFUSED: outside a ship run nothing is holding the other end of the deferral');
    assertTrue(deferralRefusal([DEFERRED_FLAG], { [SHIP_PID_ENV]: '1234' }) === null, '  ...and accepted inside one, identified by the pid the orchestrator hands every child');
    const { freezeRefusal, FREEZE_FLAG } = await import('./publish-freeze-round.mjs');
    const both = freezeRefusal([FREEZE_FLAG, DEFERRED_FLAG]);
    assertTrue(both !== null && both.includes(DEFERRED_FLAG), '  ...and the freeze allowlist refuses the pair, so the two exits can never be taken in one run');
  }

  // ── §7 R8: there is no gate-skipping switch, and none can be typed ────────
  section('§7 R8 the orchestrator carries no way to skip the gate, and target selection cannot reach it');
  {
    const src = readFileSync(SHIP, 'utf8');
    // The shapes such a switch would have to take. Assembled rather than
    // written out, so this scan cannot match itself if this file were ever
    // concatenated with the source it is scanning.
    const forbidden = [['--skip', '-gate'], ['--no', '-gate'], ['skip', 'Gate'], ['SKIP', '_GATE'], ['--force', '-publish'], ['bypass', 'Gate']]
      .map(([a, b]) => a + b);
    const hits = forbidden.filter((f) => src.toLowerCase().includes(f.toLowerCase()));
    assertTrue(hits.length === 0, `no gate-skipping spelling appears anywhere in ship.mjs (hits: ${hits.join(', ') || 'none'})`);
    // Control: the scan is not blind. A string we KNOW is in the file must hit.
    assertTrue(src.includes('verify:delivery:release'), 'control — the scan reads real bytes (the gate command is in there)');
    let threw = null;
    try { buildGraph({ skip: ['gate'] }); } catch (e) { threw = e.message; }
    assertTrue(threw !== null && threw.includes('not a target'), `--skip gate is refused by the planner itself (got: ${threw})`);
    let threw2 = null;
    try { buildGraph({ only: ['pre'] }); } catch (e) { threw2 = e.message; }
    assertTrue(threw2 !== null, '--only pre is refused too — the preflight is not selectable either');
    const cli = runShip(['--dry-run', '--skip', 'gate']);
    assertTrue(cli.status !== 0 && /not a target/.test(cli.stderr), 'and the CLI refuses it with a non-zero exit');
  }

  // ── §8 environment and reporting helpers ─────────────────────────────────
  section('§8 ProgramFiles(x86) is guaranteed for children, shims are spawned safely, split state never folds UNKNOWN in');
  {
    const withVar = resolveProgramFilesX86({ 'ProgramFiles(x86)': 'D:\\PFx86' }, 'win32');
    assertTrue(withVar === 'D:\\PFx86', 'an already-set value is used as is');
    const without = resolveProgramFilesX86({ SystemDrive: 'Q:' }, 'win32');
    assertTrue(typeof without === 'string' && without.length > 0 && /Program Files \(x86\)$|\(x86\)/.test(without), `absent ⇒ a value is still produced (registry, else the SystemDrive default) — got ${without}`);
    assertTrue(resolveProgramFilesX86({}, 'linux') === null, 'and nothing is invented off Windows');

    const shim = spawnPlan('C:\\bin\\pnpm.cmd', ['build'], 'win32');
    assertTrue(shim.file !== 'C:\\bin\\pnpm.cmd' && shim.args.includes('/c') && shim.args.includes('C:\\bin\\pnpm.cmd'), 'a .cmd shim goes through ComSpec — Node refuses to spawn one directly, and string-building a command line is how quoting bugs get in');
    const plain = spawnPlan('/usr/bin/make', ['-C', 'x'], 'linux');
    assertTrue(plain.file === '/usr/bin/make' && plain.args.join() === '-C,x', 'a real executable is spawned as itself');

    assertTrue(splitStateLine([{ name: 'A', version: '1' }, { name: 'B', version: '1' }]).startsWith('SPLIT-STATE none'), 'same version everywhere ⇒ no split');
    const split = splitStateLine([{ name: 'A', version: '1' }, { name: 'B', version: '2' }]);
    assertTrue(split.includes('1: A') && split.includes('2: B'), `a real split names both sides (got ${split})`);
    const unk = splitStateLine([{ name: 'A', version: '1' }, { name: 'B', version: null, reason: 'probe exited 1' }]);
    assertTrue(unk.includes('UNKNOWN: B'), 'a version we could not read is UNKNOWN — R7: "could not ask" is never folded in with "is fine"');
    assertTrue(!unk.startsWith('SPLIT-STATE none'), 'and one UNKNOWN is enough to stop the line claiming agreement');
  }

  // ── §9 tool resolution picks something Windows can actually run ─────────
  section('§9 resolveTools prefers a spawnable hit on Windows (the extensionless pnpm shim)');
  {
    // [measured 2026-09-18, dev-pc-a] `where pnpm` answers the
    // extensionless POSIX shim FIRST, and CreateProcess cannot run it:
    // spawnSync of that path returns error ENOENT, which reads as "pnpm is not
    // installed" on a machine where pnpm works in every shell. The first real
    // ship run died on it.
    const fake = (exe, args) => {
      if (args[0] === 'pnpm') return { status: 0, stdout: 'C:\\nvm4w\\nodejs\\pnpm\r\nC:\\nvm4w\\nodejs\\pnpm.CMD\r\n' };
      if (args[0] === 'make') return { status: 0, stdout: 'C:\\choco\\make.exe\r\n' };
      if (args[0] === 'nope') return { status: 1, stdout: '' };
      return { status: 0, stdout: 'C:\\some\\thing\r\n' };
    };
    const t = resolveTools(['pnpm', 'make', 'nope'], { platform: 'win32', run: fake });
    assertTrue(/pnpm\.CMD$/i.test(t.pnpm), `the .CMD is chosen over the extensionless shim (got ${t.pnpm})`);
    assertTrue(t.make === 'C:\\choco\\make.exe', 'a single executable hit is still used as is');
    assertTrue(t.nope === null, 'and a tool that is genuinely absent stays null — "not found" must not turn into a wrong path');

    const onlyShim = resolveTools(['pnpm'], { platform: 'win32', run: () => ({ status: 0, stdout: 'C:\\nvm4w\\nodejs\\pnpm\r\n' }) });
    assertTrue(onlyShim.pnpm === 'C:\\nvm4w\\nodejs\\pnpm', 'when NOTHING on PATH has an executable extension we still hand back the first hit — failing loudly on spawn beats reporting the tool as missing');

    const posix = resolveTools(['pnpm'], { platform: 'linux', run: () => ({ status: 0, stdout: '/usr/bin/pnpm\n/usr/local/bin/pnpm\n' }) });
    assertTrue(posix.pnpm === '/usr/bin/pnpm', 'off Windows the first hit still wins — extensions carry no meaning there');
  }

  // -- S10 the gate must not refuse its own sibling ---------------------------
  //
  // [measured 2026-09-18, dev-pc-a, .local/ship/e32c929ef8df/GATE.log] GATE was
  // REFUSED before its first stage by "2 leftover test process(es)" that were
  // BUILD_SITE's own `vitest run` (the site repo's `pnpm build` chains it).
  // Ancestry could not see them: a sibling is ship's child, not the gate's
  // ancestor. The fix is the descendant closure of ONE anchor (ship's pid,
  // handed down as FLOWMIC_SHIP_RUN_PID) — narrow on purpose, so a run in
  // another worktree is still refused, which is what PRE got right the same day.
  section('§10 a vitest descended from THIS ship run is ignored; the same process outside it is still refused');
  {
    const SHIP_PID = 1000;
    const table = [
      { pid: SHIP_PID, ppid: 900, name: 'node.exe', cmd: 'node F:\repo\scripts\ship.mjs --feature x' },
      { pid: 1100, ppid: SHIP_PID, name: 'cmd.exe', cmd: 'cmd /c pnpm.CMD build' },            // BUILD_SITE
      { pid: 1101, ppid: 1100, name: 'node.exe', cmd: 'node .../vitest/vitest.mjs run' },      // its vitest
      { pid: 1200, ppid: SHIP_PID, name: 'cmd.exe', cmd: 'cmd /c pnpm.CMD verify:delivery:release' },
      { pid: 1201, ppid: 1200, name: 'node.exe', cmd: 'node verify/run-delivery-release.mjs' }, // us
      { pid: 2000, ppid: 1900, name: 'node.exe', cmd: 'node .../vitest/vitest.mjs run' },      // another session
    ];
    const anchored = orphanFindings(table, {
      selfPids: invocationPids(table, { pid: 1201, anchorPid: SHIP_PID }),
    });
    assertTrue(anchored.length === 1 && anchored[0].pid === 2000,
      `only the foreign vitest is flagged when ship's pid is the anchor (got ${JSON.stringify(anchored.map((o) => o.pid))})`);

    const noAnchor = orphanFindings(table, { selfPids: invocationPids(table, { pid: 1201 }) });
    assertTrue(noAnchor.some((o) => o.pid === 1101) && noAnchor.some((o) => o.pid === 2000),
      'REVERSE CONTROL: with no anchor (a gate run by hand) BOTH are flagged — this is the red the first real round produced, reproduced here');

    const recycled = invocationPids(table, { pid: 1201, anchorPid: 2000 });
    assertTrue(!recycled.has(1101),
      'a pid that is NOT ship (recycled number) is refused as an anchor — it degrades to ancestry rather than to a blanket exemption');
    const absent = invocationPids(table, { pid: 1201, anchorPid: 7777 });
    assertTrue(!absent.has(1101), 'and an anchor pid that is not in the table at all exempts nothing');
  }

  // -- S11 the external queue's landing is carried, but only if it verifies ----
  section('§11 a verified cross-machine artifact for THIS version puts --keep-adopted on the publish line; a bad sidecar refuses');
  {
    const V = '9.9.9';
    const ZIP = `FlowMic-${V}-portable-macos-arm64.zip`;
    const build = (sidecar) => {
      const dir = makeTempDir('ship-drill-adopt-');
      const bytes = Buffer.from('pretend this is a notarized mac zip');
      writeFileSync(join(dir, ZIP), bytes);
      const real = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(dir, `${ZIP}.sha256`), `${sidecar === 'match' ? real : 'f'.repeat(64)}  ${ZIP}\n`);
      return dir;
    };
    const good = adoptedKeepDecision({ outDir: build('match'), version: V });
    assertTrue(good.keepAdopted && good.kept.includes(ZIP), 'bytes that match their sidecar are carried');

    let refusal = null;
    try { adoptedKeepDecision({ outDir: build('mismatch'), version: V }); }
    catch (e) { refusal = e.message; }
    assertTrue(refusal !== null && refusal.includes(ZIP) && /hash to/.test(refusal),
      `REVERSE CONTROL: a sidecar that disagrees with the bytes REFUSES and names the file (got ${refusal ? refusal.split('\n')[0] : 'no throw'})`);

    const bare = makeTempDir('ship-drill-adopt-bare-');
    writeFileSync(join(bare, ZIP), 'x');
    let noSidecar = null;
    try { adoptedKeepDecision({ outDir: bare, version: V }); } catch (e) { noSidecar = e.message; }
    assertTrue(noSidecar !== null && /no .*\.sha256/.test(noSidecar), 'and an artifact with no sidecar at all refuses too — nothing vouches for those bytes');

    const none = adoptedKeepDecision({ outDir: makeTempDir('ship-drill-adopt-empty-'), version: V });
    assertTrue(!none.keepAdopted, 'an empty publish/ asks for nothing — the flag is never passed on a round that adopted nothing');

    const attach = (keepAdopted) => {
      const { nodes } = buildGraph({});
      attachCommands(nodes, {
        root: ROOT, tools: { node: 'node', pnpm: 'pnpm', make: 'make', py: 'py', bash: 'bash', git: 'git' },
        logDir: makeTempDir('ship-drill-keep-'), sha: 'aaaabbbbcccc', note: 'drill', keepAdopted,
      });
      const publish = nodes.find((n) => n.name === 'PUBLISH');
      for (const n of nodes) n.run = () => { throw new Error('drill: production commands are never run here'); };
      return publish;
    };
    assertTrue(attach(true).ready.plan.args.includes('--keep-adopted'), 'the decision reaches publish.mjs as --keep-adopted');
    assertTrue(!attach(false).ready.plan.args.includes('--keep-adopted'), 'REVERSE CONTROL: and is absent when nothing was adopted');

    const env = attach(true);
    assertTrue(/FLOWMIC_SHIP_RUN_PID/.test(readFileSync(SHIP, 'utf8')) && env !== null,
      'ship stamps FLOWMIC_SHIP_RUN_PID on every child (§10 anchor) — the gate cannot exempt a sibling it is never told about');
  }

} finally {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROL (2026-09-18, measured; documented rather than re-run on every
// pass, the convention this repo's other drills use). In `runGraph`'s readiness
// filter, `.filter((n) => n.needs.every((d) => results.has(d)))` was replaced
// with `.filter(() => true)` — the dependency edges no longer enforced at all.
// The drill went RED, exit 1, 9 failures:
//
//   === §2 dependency order is respected by the RUNNER … ===
//     FAIL  all three succeeded
//     FAIL  all three actually started (a marker each)
//     FAIL  and the runner reports the same order it actually ran
//   === §3 independent steps really overlap … ===
//     FAIL  all five heavy steps succeeded
//     FAIL  GATE takes the first heavy slot (order: PRE)
//     FAIL  every heavy step actually started
//   === §4 R2 a failed step blocks its dependents … ===
//     FAIL  the failing step keeps its own exit code
//     FAIL  a sibling that did not depend on the failure still ran …
//     FAIL  the final line NAMES the step that failed …
//
// 🔴 AND THE HALF THAT STAYED GREEN IS THE POINT. §1, §5, §6, §7 and §8 were
// untouched by that edit: with every edge ignored, `buildGraph` still produced a
// perfectly correct-looking plan, still refused `--skip gate`, still flipped JP
// ahead of NY on a users-table round, and `criticalPath` still printed 384 s.
// A drill written only against the plan object would have been fully green while
// the runner shipped a relay deploy alongside the gate it was supposed to be
// standing on. That is why §2-§4 spend real child processes on real timestamps.
//
// Restored (diffed byte-identical against the pre-edit copy) and re-run:
// `PASS: 8/8 sections ran, 0 failure(s)`.
// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0 || sectionsRun !== TOTAL_SECTIONS) {
  console.log(`\nFAIL: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, ${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nPASS: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, 0 failure(s)`);
process.exit(0);

// SC-1 drill for scripts/ship-preflight.mjs
// (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §5 row SC-1).
//
// WHAT SC-1 IS. Tonight's ship chain died ~4 minutes into the NY gate on a
// missing `ProgramFiles(x86)` — a fact `pnpm verify:delivery` had no reason to
// check, so the chain paid for `verify:preflight` + `verify:protocol-dist` +
// lint + types before `flutter test` finally said so. This file's job is to
// prove the standalone preflight names that (and the other measured stops:
// orphan processes on a contended machine, per CLAUDE.md's own rule "a gate on
// a contended machine is not a reading") in a few seconds, before any of that
// runs.
//
// FOLLOW-UP #1 (2026-09-17, this file's original version FOUND this): the
// first cut of the orphan rule bare-matched `dart`, and the very first live
// run on this machine FAILed on 6-8 PIDs that were a plain VS Code + Dart/
// Flutter extension's language server and tooling daemon — nothing to do with
// a leftover gate run. `dart` (and `node`) are now GATED like `vitest`
// (flagged only when the command line names an actual gate shape:
// flutter_tester/test/run-golden/vitest/verify), and the VS Code shapes are
// ALSO excluded by name explicitly, checked before either match rule. §3
// below asserts both halves; the live re-run with VS Code's dart processes
// still on the box (quoted in the acceptance report) is the actual proof —
// this file can only assert the DECISION LOGIC against a table it builds.
//
// FOLLOW-UP #2 (2026-09-17): the toolchain probe is now cached
// (.local/preflight-toolchain-cache.json, keyed by each tool binary's
// resolved path + mtime) and the toolchain/orphan-scan/four-git-status/ssh
// checks all run inside one Promise.all in runAllChecks — not tested directly
// here (that is `scripts/ship-preflight.mjs`'s own `main`, measured instead in
// the acceptance report's wall-clock numbers), but §3/§5/§7 below exercise the
// now-async `checkOrphanProcesses`/`listProcesses`/`checkRepoClean` through
// the same call sites `runAllChecks` uses.
//
// EXIT CODES (scripts/run-script-tests.mjs header): 0 = PASS, 1 = FAIL,
// 2 = SKIP.
//
// SAFETY: §5's live process is spawned under THIS test's own control, killed
// in a `finally`, and its command line carries a private marker
// (`--ship-preflight-drill-marker`) so nothing here can be confused with a
// real leftover gate process. Nothing here calls `git status`/`git commit` on
// the checkout it runs from; §6 uses the repo's OWN toplevel read-only, and §7
// uses a synthetic tmp git repo for the dirty-tree case so the test's own
// working tree is never at risk of being reported on (or mutated).
//
// Run: `node scripts/ship-preflight.test.mjs`

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ancestryOf,
  checkDiskHeadroom,
  checkOrphanProcesses,
  checkProgramFilesX86,
  checkRepoClean,
  checkVersionLine,
  judgeVersionLine,
  VERSION_LINE_REPOS,
  detectShell,
  expandHome,
  findOrphans,
  formatLine,
  listProcesses,
  probeSsh,
  siblingRepos,
  sshArgsFor,
  sshTargets,
  summarize,
} from './ship-preflight.mjs';

let failures = 0;
let sectionsRun = 0;
let skipReason = null;
const TOTAL_SECTIONS = 9;
const section = (title) => { sectionsRun += 1; console.log(`\n=== ${title} ===`); };
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures += 1; }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const tempDirs = [];
function makeTempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

try {
  // ── §1 ProgramFiles(x86): missing var → FAIL names it and the fix ─────────
  section('§1 ProgramFiles(x86) missing → FAIL names the variable and a working fix');
  {
    const withoutVar = { ...process.env };
    delete withoutVar['ProgramFiles(x86)'];

    const gitBashEnv = { ...withoutVar, MSYSTEM: 'MINGW64' };
    const rGitBash = checkProgramFilesX86(gitBashEnv);
    assertTrue(rGitBash.level === 'FAIL', 'git-bash shell, var absent ⇒ FAIL');
    assertTrue(rGitBash.name === 'ProgramFiles(x86)', 'names the variable, not a generic label');
    assertTrue(rGitBash.detail.includes('env "ProgramFiles(x86)=C:\\Program Files (x86)"'), 'names the Git-Bash-specific one-liner fix (env prefix, not export)');
    assertTrue(detectShell(gitBashEnv) === 'git-bash', 'detectShell reads MSYSTEM as git-bash');

    const psEnv = { ...withoutVar, PSModulePath: 'C:\\some\\path' };
    delete psEnv.MSYSTEM;
    const rPs = checkProgramFilesX86(psEnv);
    assertTrue(rPs.level === 'FAIL', 'powershell shell, var absent ⇒ FAIL');
    assertTrue(rPs.detail.includes('${env:ProgramFiles(x86)}'), 'names the PowerShell-specific fix, not the Git-Bash one');
    assertTrue(detectShell(psEnv) === 'powershell', 'detectShell reads PSModulePath as powershell');

    const unknownEnv = {};
    for (const k of Object.keys(withoutVar)) { if (k !== 'MSYSTEM' && k !== 'PSModulePath' && k !== 'ComSpec' && k !== 'PROMPT') unknownEnv[k] = withoutVar[k]; }
    const rUnknown = checkProgramFilesX86(unknownEnv);
    assertTrue(rUnknown.level === 'FAIL', 'unrecognized shell, var absent ⇒ still FAILs (never silently passes)');
    assertTrue(rUnknown.detail.includes('Git Bash:') && rUnknown.detail.includes('PowerShell:'), 'unknown shell ⇒ prints BOTH spellings rather than guessing wrong');
  }

  // ── §2 ProgramFiles(x86) present → PASS ────────────────────────────────────
  section('§2 ProgramFiles(x86) set → PASS and echoes the value');
  {
    const withVar = { ...process.env, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    const r = checkProgramFilesX86(withVar);
    assertTrue(r.level === 'PASS', 'var present ⇒ PASS');
    assertTrue(r.detail.includes('C:\\Program Files (x86)'), 'echoes the value it read, not just "ok"');
  }

  // ── §3 orphan-process decision logic (synthetic table, no live spawn) ─────
  section('§3 findOrphans: dart/node are GATED (not bare), VS Code tooling is explicitly excluded, ancestors excluded');
  {
    const procs = [
      { ProcessId: 100, ParentProcessId: 1, Name: 'bash.exe', CommandLine: 'the harness\'s own interactive shell' }, // self's ancestor — deliberately no gate-substring words
      { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', CommandLine: 'the process running this drill right now' }, // self — same reason
      { ProcessId: 300, ParentProcessId: 4, Name: 'cargo.exe', CommandLine: 'cargo build --release' }, // still bare-matched
      { ProcessId: 301, ParentProcessId: 4, Name: 'flutter_tester.exe', CommandLine: 'flutter_tester --enable-vm-service' }, // still bare-matched
      { ProcessId: 302, ParentProcessId: 4, Name: 'rustc.exe', CommandLine: 'rustc --version' }, // still bare-matched
      { ProcessId: 303, ParentProcessId: 4, Name: 'dart.exe', CommandLine: 'dart language-server --protocol=lsp --client-id=VS-Code' }, // REAL observed VS Code shape ⇒ must NOT be flagged
      { ProcessId: 304, ParentProcessId: 4, Name: 'dart.exe', CommandLine: 'dart tooling-daemon --machine' }, // REAL observed VS Code shape ⇒ must NOT be flagged
      { ProcessId: 305, ParentProcessId: 4, Name: 'dart.exe', CommandLine: 'dart devtools --machine --allow-embedding' }, // dart with no gate substring at all ⇒ not flagged
      { ProcessId: 306, ParentProcessId: 4, Name: 'dart.exe', CommandLine: 'dart run test --reporter compact' }, // dart WITH a gate substring ('test') ⇒ flagged
      { ProcessId: 400, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node scripts/run-golden.mjs' }, // gated, hits 'run-golden' substring
      { ProcessId: 401, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node some-unrelated-server.js' }, // gated, NO substring ⇒ not flagged
      { ProcessId: 402, ParentProcessId: 4, Name: 'vitest.exe', CommandLine: 'vitest run --coverage' }, // gated, hits 'vitest' substring (both name+cmdline)
      { ProcessId: 403, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node --language-server-for-test --verify' }, // WOULD hit the 'verify' substring, but the exclude list wins first
      { ProcessId: 404, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'npx-cli.js -y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics' }, // REAL observed shape: `@latest` CONTAINS 'test' => must NOT be flagged
      { ProcessId: 405, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node scripts/attest-something.mjs --greatest' }, // same class, two more words that merely contain 'test' => not flagged
      { ProcessId: 406, ParentProcessId: 4, Name: 'node.exe', CommandLine: 'node apps/mobile/foo.test.mjs' }, // word-initial after a dot => still flagged
      { ProcessId: 500, ParentProcessId: 4, Name: 'explorer.exe', CommandLine: 'C:\\Windows\\explorer.exe' }, // no name match at all
    ];
    const flaggedPids = findOrphans(procs, 200).map((o) => o.pid).sort((a, b) => a - b);
    assertTrue(JSON.stringify(flaggedPids) === JSON.stringify([300, 301, 302, 306, 400, 402, 406]), `flags exactly the matching non-ancestor, non-excluded PIDs (got ${JSON.stringify(flaggedPids)})`);
    assertTrue(!flaggedPids.includes(303) && !flaggedPids.includes(304), 'the two REAL VS Code dart shapes (language-server, tooling-daemon) are never flagged — the finding this follow-up exists to fix');
    assertTrue(!flaggedPids.includes(305), 'a bare "dart" with no gate substring at all is not flagged either (dart is gated, not bare, as of this follow-up)');
    assertTrue(flaggedPids.includes(306), 'a dart process that DOES carry a gate substring ("test") is still caught — narrowing did not turn the check off');
    assertTrue(!flaggedPids.includes(401), 'gated name WITHOUT a gate substring in its command line is not flagged (node runs plenty of things that are not the gate)');
    assertTrue(!flaggedPids.includes(403), 'the explicit exclude list wins even over a command line that WOULD otherwise hit a gate substring ("verify")');
    // 🔴 MEASURED at integration, 2026-09-17: the gate needles were plain
    // substrings, and the first preflight of the merged tree FAILed on two live
    // `chrome-devtools-mcp@latest` processes, because `@latest` contains `test`.
    // Neither was a gate and both come back whenever the editor reconnects its MCP
    // servers, so the rule made a clean machine unshippable — which is how a gate
    // becomes the thing everyone learns to skip. The needles are word-initial now.
    assertTrue(!flaggedPids.includes(404), 'a command line containing "@latest" is NOT flagged — `test` inside `latest` was a real, measured false positive');
    assertTrue(!flaggedPids.includes(405), '"attest"/"greatest" are not flagged either — a needle has to start a word');
    assertTrue(flaggedPids.includes(406), 'POSITIVE CONTROL: "foo.test.mjs" IS still flagged, so the boundary did not turn the needle off');
    assertTrue(!flaggedPids.includes(100) && !flaggedPids.includes(200), 'self and its ancestor shell are excluded even though 200 is literally "node.exe"');

    const checkResult = await checkOrphanProcesses(() => procs);
    const fails = checkResult.filter((r) => r.level === 'FAIL');
    assertTrue(fails.length === 7, `checkOrphanProcesses wraps findOrphans into one FAIL row per PID (got ${fails.length})`);
    assertTrue(fails.some((r) => r.detail.includes('PID 300') && r.detail.includes('cargo build --release')), 'each FAIL row names the PID and the actual command line, not just the process name');

    const cleanResult = await checkOrphanProcesses(() => [procs[0], procs[1], procs[procs.length - 1]]);
    assertTrue(cleanResult.length === 1 && cleanResult[0].level === 'PASS', 'no matching processes ⇒ a single PASS row, not zero rows (absence of evidence must still print a line)');

    const unreadable = await checkOrphanProcesses(() => null);
    assertTrue(unreadable.every((r) => r.level === 'WARN'), 'process table unreadable ⇒ WARN ("could not check"), never a silent PASS');

    // checkOrphanProcesses awaits whatever listProcessesFn returns — a plain
    // value (drill fixtures, above) or a real Promise (the async listProcesses
    // it defaults to) both have to work through the SAME call site.
    const viaPromise = await checkOrphanProcesses(() => Promise.resolve([procs[0], procs[1]]));
    assertTrue(viaPromise.length === 1 && viaPromise[0].level === 'PASS', 'a listProcessesFn that returns a real Promise (not just a value) resolves correctly too');
  }

  // ── §4 ancestryOf: walks parents, stops on missing/cyclic, caps depth ─────
  section('§4 ancestryOf walks the real chain and cannot loop forever on a cycle');
  {
    const chain = [
      { ProcessId: 1, ParentProcessId: 0 },
      { ProcessId: 10, ParentProcessId: 1 },
      { ProcessId: 20, ParentProcessId: 10 },
      { ProcessId: 30, ParentProcessId: 20 },
    ];
    const a = ancestryOf(30, chain);
    assertTrue([...a].sort((x, y) => x - y).join(',') === '0,1,10,20,30', `full ancestor chain up to the root (got ${[...a].join(',')})`);

    const cyclic = [
      { ProcessId: 1, ParentProcessId: 2 },
      { ProcessId: 2, ParentProcessId: 1 },
    ];
    const start = Date.now();
    const c = ancestryOf(1, cyclic);
    assertTrue(Date.now() - start < 1000, 'a two-node cycle terminates immediately, not an infinite loop');
    assertTrue(c.has(1) && c.has(2), 'both nodes of the cycle are recorded before it stops');
  }

  // ── §5 LIVE spawn: a real process with "vitest" in its command line is caught, by PID ──
  section('§5 a live leftover process carrying "vitest" in its command line is found and named by PID');
  {
    const marker = '--ship-preflight-drill-marker';
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', '--', '--vitest', marker], { windowsHide: true });
    let found = null;
    let procs = null;
    try {
      // Poll for up to 10s: measured on this machine, a single full
      // Win32_Process enumeration (1000+ processes, this box) costs
      // 2.0-2.8s BY ITSELF — a real cost this drill discovered, not an
      // assumption. `listProcesses` is now async (follow-up #2), so this
      // polls it with `await` instead of a blocking sleep.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && found == null) {
        procs = await listProcesses();
        if (procs == null) break; // WARN path exercised separately in §3; do not fail this section on a CIM outage.
        found = procs.find((p) => Number(p.ProcessId) === child.pid) ?? null;
        if (found == null) await sleep(200);
      }
      if (found == null) {
        skipReason = 'could not observe the spawned child in Win32_Process within 10s (PowerShell CIM unavailable or too slow on this box) — the live half of §5 was not verified, though §3\'s synthetic decision logic was';
      } else {
        assertTrue(String(found.CommandLine ?? '').includes('vitest'), 'the live process\'s real Windows command line contains "vitest" (not a fixture)');
        const orphans = findOrphans(procs, process.pid);
        const mine = orphans.find((o) => o.pid === child.pid);
        assertTrue(mine != null, `findOrphans flags the live spawned PID ${child.pid} by number, from the real process table`);
        assertTrue(mine != null && mine.cmdline.includes(marker), 'the flagged row carries the real command line (so a human can tell which process it is), not just a name');
      }
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  // ── §6 disk headroom: injectable statfs, both directions ──────────────────
  section('§6 disk-headroom: FAIL below 15 GiB, PASS above, both through the SAME repo-root reading');
  {
    const low = () => ({ bsize: 4096, bavail: Math.floor((10 * 1024 * 1024 * 1024) / 4096), blocks: Math.floor((100 * 1024 * 1024 * 1024) / 4096) });
    const high = () => ({ bsize: 4096, bavail: Math.floor((50 * 1024 * 1024 * 1024) / 4096), blocks: Math.floor((100 * 1024 * 1024 * 1024) / 4096) });
    const rLow = checkDiskHeadroom(process.cwd(), low);
    assertTrue(rLow.level === 'FAIL', '10 GiB free, 15 GiB required ⇒ FAIL');
    assertTrue(rLow.detail.includes('15 GiB'), 'names the threshold, not just the reading');
    const rHigh = checkDiskHeadroom(process.cwd(), high);
    assertTrue(rHigh.level === 'PASS', '50 GiB free ⇒ PASS');
  }

  // ── §7 repo-clean: a synthetic dirty git repo names the actual dirty file ─
  section('§7 checkRepoClean (now async, spawn-based): a real (synthetic) dirty tree is named by path, a clean one PASSes');
  {
    const dir = makeTempDir('flowmic-sc1-repo-');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'drill@example.invalid'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'drill'], { cwd: dir });
    writeFileSync(join(dir, 'committed.txt'), 'a');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

    const clean = await checkRepoClean({ name: 'synthetic', dir });
    assertTrue(clean.level === 'PASS', 'freshly committed tree ⇒ PASS');

    writeFileSync(join(dir, 'uncommitted.txt'), 'b');
    const dirty = await checkRepoClean({ name: 'synthetic', dir });
    assertTrue(dirty.level === 'FAIL', 'an untracked file ⇒ FAIL, not WARN (a dirty tree corrupts the gate reading, per design row)');
    assertTrue(dirty.detail.includes('uncommitted.txt'), 'names the actual dirty path, not just "dirty"');

    const missing = await checkRepoClean({ name: 'nowhere', dir: join(dir, 'does-not-exist') });
    assertTrue(missing.level === 'WARN', 'a repo not checked out on this machine ⇒ WARN (not every machine carries every sibling), never FAIL');
  }

  // ── §7b one product, one version line ───────────────────────────────
  //
  // Each repo's own version-sync lint compares that repo's faces against that
  // repo's package.json, so three repos can each be internally perfect and
  // still disagree with one another. [measured 2026-09-18, dev-pc-a: the round
  // before this check existed shipped /go from a repo sitting one number behind
  // the two that had been bumped, and it was noticed by a person reading a
  // handoff report, not by anything that runs.]
  section('§7b the three repos must be on ONE version, and every way of not knowing is not a PASS');
  {
    const agree = judgeVersionLine([
      { name: 'a', checkedOut: true, version: '0.3.91' },
      { name: 'b', checkedOut: true, version: '0.3.91' },
      { name: 'c', checkedOut: true, version: '0.3.91' },
    ]);
    assertTrue(agree.level === 'PASS' && /0\.3\.91 in all 3 repos/.test(agree.detail), `all three on one number ⇒ PASS (${agree.detail})`);

    // Names taken from the real list rather than typed: the export sweep pins
    // private repo names by exact line text, and a literal here would need its
    // own waiver for no gain (the judgment does not care what they are called).
    const [appRepo, webRepo, goRepo] = VERSION_LINE_REPOS;
    const drift = judgeVersionLine([
      { name: appRepo, checkedOut: true, version: '0.3.91' },
      { name: webRepo, checkedOut: true, version: '0.3.91' },
      { name: goRepo, checkedOut: true, version: '0.3.90' },
    ]);
    assertTrue(drift.level === 'FAIL', 'one repo a round behind ⇒ FAIL, not WARN: the artifacts are named after a number and cannot be un-named later');
    assertTrue(drift.detail.includes(`${goRepo}=0.3.90`), '  ...and the message names WHICH repo is behind and what it is on');
    assertTrue(/bump the laggard with ITS OWN bump script/.test(drift.detail), '  ...and the action, because each repo has its own bump script and the wrong one writes the wrong faces');

    const unreadable = judgeVersionLine([
      { name: 'a', checkedOut: true, version: '0.3.91' },
      { name: 'b', checkedOut: true, version: null, error: 'ENOENT' },
    ]);
    assertTrue(unreadable.level === 'FAIL', '🔴 a version we could NOT READ is a FAIL, never a pass — "I could not ask" is not "it agrees"');
    assertTrue(/UNREADABLE/.test(unreadable.detail), '  ...and says which question went unanswered');

    const partial = judgeVersionLine([
      { name: 'a', checkedOut: true, version: '0.3.91' },
      { name: 'b', checkedOut: false },
    ]);
    assertTrue(partial.level === 'WARN' && /not checked out/.test(partial.detail), 'a repo this machine does not carry ⇒ WARN (the check simply did not cover it), and it says so');

    // And the real reading, against the real trees on this machine.
    const real = checkVersionLine();
    assertTrue(['PASS', 'WARN', 'FAIL'].includes(real.level), `the real check produces a level on this machine: ${formatLine(real)}`);
    // ⚠️ This used to be a RegExp built out of a TEMPLATE LITERAL, and the
    // template ate the escapes: `0\.\d+\.\d+` became `0.d+.d+`, which matches
    // nothing a version face ever says. It passed anyway while this machine's
    // three repos DISagreed, because the FAIL text happens to contain a repo
    // name — and went red the moment they agreed and the PASS text stopped
    // naming repos. A ruler that only reads correctly when the thing it
    // measures is broken (「先核你的尺子」). Plain string tests, no escaping.
    const looksLikeAVersion = /[0-9]+\.[0-9]+\.[0-9]+/u;
    assertTrue(
      real.detail.includes(appRepo) || looksLikeAVersion.test(real.detail),
      `  ...with a detail that names a repo or a version rather than an empty string (got: ${real.detail})`,
    );
  }

  // ── §8 ssh credentials come from the deploy env files, not from defaults ──
  //
  // 2026-09-17, measured: this check reported NY (root@140.82.42.165) as
  // "unreachable or auth refused" while the box was up and about to be deployed
  // to. NY accepts key auth only, with a key named by `FLOWMIC_VPS_SSH_KEY` in
  // the web repo's `deploy/vps.env`; the probe dialled with whatever default
  // identity was on offer, and got refused. The refusal was OURS — a check whose
  // negative answer is produced by its own missing credentials is measuring
  // itself, not the host (CLAUDE.md 「先核你的尺子」). Every assertion below
  // exists because one half of that credential set was being ignored.
  section('§8 ssh probe reads user/host/key/host-key from the deploy env files and pins the same host key');
  {
    assertTrue(expandHome('~/.ssh/k', 'C:\\Users\\X') === join('C:\\Users\\X', '.ssh/k'), 'expandHome turns the env file\'s `~/…` into a real path (ssh -i does not do it for us)');
    assertTrue(expandHome('/abs/k', 'C:\\Users\\X') === '/abs/k', 'expandHome leaves an already-absolute path alone');

    // A synthetic sibling layout: <root>/../<web repo>/deploy/*.env, the exact
    // shape sshTargets walks. Nothing real is read and nothing is dialled. The
    // repo name is taken from siblingRepos() rather than typed again: one place
    // in this repo may spell a private sibling's directory name (the export's
    // absent-sweep pins that occurrence), and a second copy here would be both
    // a new disclosure and a value free to drift from the one under test.
    const fakeParent = makeTempDir('ship-preflight-ssh-');
    const fakeRoot = join(fakeParent, 'flowmic-app');
    const webRepoName = siblingRepos(join(fakeParent, 'flowmic-app')).find((r) => r.name.endsWith('-web')).name;
    const fakeDeploy = join(fakeParent, webRepoName, 'deploy');
    mkdirSync(fakeRoot, { recursive: true });
    mkdirSync(fakeDeploy, { recursive: true });
    writeFileSync(join(fakeDeploy, 'vps.env'), [
      '# a comment line the reader must skip',
      'FLOWMIC_VPS_SSH_HOST=203.0.113.9',
      'FLOWMIC_VPS_SSH_USER=deployer',
      'FLOWMIC_VPS_SSH_KEY=~/.ssh/nope_does_not_exist_flowmic_drill',
      'FLOWMIC_VPS_SSH_HOST_KEY=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIERSSUxMRFJJTExEUklMTERSSUxMRFJJTA',
      '',
    ].join('\n'), 'utf8');
    // The JP file is deliberately absent: "no env file" must stay a WARN that
    // says so, never a dial at an empty host.
    const targets = sshTargets(fakeRoot);
    const ny = targets.find((t) => t.label === 'NY');
    assertTrue(ny.host === '203.0.113.9' && ny.user === 'deployer', 'host and user come from the env file (user is not hard-coded to root)');
    assertTrue(ny.keyRaw === '~/.ssh/nope_does_not_exist_flowmic_drill', 'FLOWMIC_VPS_SSH_KEY is read — the variable whose absence produced the false "unreachable"');
    assertTrue(ny.key === expandHome(ny.keyRaw) && ny.key !== ny.keyRaw, 'ssh is handed the EXPANDED path while the raw spelling is kept for the message');
    assertTrue(typeof ny.hostKey === 'string' && ny.hostKey.startsWith('ssh-ed25519 '), 'FLOWMIC_VPS_SSH_HOST_KEY is read (the same pin the deploy scripts use)');
    const jp = targets.find((t) => t.label === 'JP');
    assertTrue(jp.host === null, 'a missing env file yields no host rather than a guess');

    const argvPinned = sshArgsFor({ ...ny, key: 'C:\\k\\id' }, 'C:\\kh\\known_hosts');
    assertTrue(argvPinned.includes('-i') && argvPinned[argvPinned.indexOf('-i') + 1] === 'C:\\k\\id', 'the named key is passed as -i <key>');
    assertTrue(argvPinned.includes('IdentitiesOnly=yes'), 'IdentitiesOnly=yes, so an agent key offered first cannot exhaust MaxAuthTries before ours is tried');
    assertTrue(argvPinned.includes('UserKnownHostsFile=C:\\kh\\known_hosts') && argvPinned.includes('StrictHostKeyChecking=yes'), 'the host key is PINNED (the question deploy-vps-app.py asks via RejectPolicy), not accept-new');
    assertTrue(argvPinned[argvPinned.length - 2] === 'deployer@203.0.113.9', 'destination is user@host as the env file spells them');
    const argvMac = sshArgsFor({ label: 'mac', host: 'flowmic-mac', user: null, key: null }, null);
    assertTrue(!argvMac.includes('-i') && argvMac.includes('StrictHostKeyChecking=accept-new'), 'the ssh-config alias keeps its own credentials and is not handed a pin we do not have');

    // The required case: a key path naming a file that is not on this machine.
    // WARN, name the VARIABLE, and never dial — dialling with the wrong identity
    // would report the HOST's refusal, which is the confusion this section ends.
    const r = await probeSsh(ny);
    assertTrue(r.level === 'WARN', 'a key path that resolves to no file is a WARN — not a silent PASS, and not a verdict about the host');
    assertTrue(r.detail.includes('FLOWMIC_VPS_SSH_KEY'), `the WARN names the variable to go fix (got: ${r.detail})`);
    assertTrue(r.detail.includes('never dialled'), 'the WARN says the host was never contacted, so nobody reads it as a verdict on the host');
    assertTrue(r.detail.includes(ny.keyRaw), 'the WARN quotes the raw spelling, which is the string a human greps for in the env file');
  }

  // ── formatLine / summarize: pure output-decision helpers ───────────────────
  {
    const okResults = [{ level: 'PASS', name: 'a', detail: '1' }, { level: 'WARN', name: 'b', detail: '2' }];
    const sOk = summarize(okResults, 1234);
    assertTrue(sOk.ok === true && sOk.finalLine.startsWith('PREFLIGHT OK'), 'no FAIL rows ⇒ overall OK, WARN rows do not block it');
    const badResults = [...okResults, { level: 'FAIL', name: 'c', detail: '3' }];
    const sBad = summarize(badResults, 1234);
    assertTrue(sBad.ok === false && sBad.finalLine === 'PREFLIGHT FAIL (1) (1234ms)', `one FAIL ⇒ overall FAIL and the count is exact (got "${sBad.finalLine}")`);
    assertTrue(formatLine({ level: 'FAIL', name: 'x', detail: 'y' }) === 'FAIL x — y', 'formatLine is "LEVEL name — detail", the shape the dispatch prompt specifies');
  }
} finally {
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROL (documented, run by hand — not re-executed on every drill
// run, matching the convention in publish-disk-space-gate.mjs's header): with
// `checkProgramFilesX86` temporarily patched to `return { name: 'ProgramFiles(x86)', level: 'PASS', detail: 'stubbed' };`
// unconditionally (i.e. the env check disabled), §1's very first assertion —
// `rGitBash.level === 'FAIL'` — went red:
//
//   FAIL  git-bash shell, var absent ⇒ FAIL
//
// eight more assertions in §1 cascaded red behind it (they all read fields of
// a FAIL row that no longer existed). Reverted (diffed byte-identical against
// the pre-edit copy) and reran: all green again. See the drill/gate summary
// quoted in the SC-1 acceptance report for the exact rerun output.
// ─────────────────────────────────────────────────────────────────────────────

if (failures > 0 || sectionsRun !== TOTAL_SECTIONS) {
  console.log(`\nFAIL: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, ${failures} failure(s)`);
  process.exit(1);
}
if (skipReason) {
  console.log(`\nSKIP: ${skipReason}`);
  process.exit(2);
}
console.log(`\nPASS: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, 0 failure(s)`);
process.exit(0);

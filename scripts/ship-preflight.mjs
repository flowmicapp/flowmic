#!/usr/bin/env node
// SC-1 — ship-preflight: the 2-5 s step that runs BEFORE any gate, build, or
// deploy, and names exactly what is wrong instead of letting the chain burn
// minutes (or an hour) finding out the MACHINE was the problem.
//
// THE MEASURED TRIGGER (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md
// §1.2, §5 row SC-1). Tonight's ship chain died at the NY gate ~4 minutes in on
// a missing `ProgramFiles(x86)` — a fact `pnpm verify:delivery` had no reason to
// check for itself (it is an environment fact, not a repo fact), so the chain
// paid the full cost of `verify:preflight` + `verify:protocol-dist` + lint +
// types before `flutter test` finally said so. This script asks that one
// question, and the others in the design row's list, before ANY of that runs.
//
// WHAT THIS DOES NOT REPLACE. `preflight-toolchain.mjs` (imported below) is the
// authority on "is a tool present and floor-compliant" — this file does not
// re-derive that logic, it calls it. `verify:receipt`/`gate-receipt.mjs` is the
// authority on whether a gate proof is still usable — this file reads it
// read-only (`--status` mode) and never writes one. `publish-disk-space-gate.mjs`
// is the authority on the round-cost-derived publish threshold (1998 MiB) — this
// file asks a DIFFERENT, cheaper question ("is there room to even start", 15 GiB,
// the design row's number) using the SAME `statfs`-through-the-repo-root method,
// because the LAN-IP-gate lesson (blind ⇒ say nothing) applies here too.
//
// WHY EACH CHECK IS FAIL vs WARN. A FAIL means: running the chain now is either
// certain to die (missing tool, missing env var) or would corrupt the reading
// (a dirty repo the gate would silently test, an orphan process already eating
// the CPU a timing-sensitive suite needs — CLAUDE.md's own rule: "a gate on a
// contended machine is not a reading"). A WARN means: the chain can still run
// and its own gates will catch the real problem if there is one (an unreachable
// deploy host says nothing about whether the BUILD will succeed; a missing
// `.local/*.env` only matters if this round actually deploys to that target).
//
// Run:   node scripts/ship-preflight.mjs [--require-hosts] [--json]
// Exit:  0 = PREFLIGHT OK (FAILs = 0; WARNs may be nonzero)
//        1 = PREFLIGHT FAIL (at least one FAIL)

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFreeSpace } from './publish-disk-space-gate.mjs';
import { probeTools, TOOLS } from './preflight-toolchain.mjs';
import { readValidReceipt, reuseBanner } from './gate-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** The design row's number (docs/strategy/2026-09-17-…§5 SC-1), not the
 *  round-cost-derived publish threshold — a different question asked the same
 *  way (statfs through the repo root, never the system volume or os.tmpdir()). */
export const MIN_FREE_GIB = 15;
const MIB_PER_GIB = 1024;

// ── (1) ProgramFiles(x86) ────────────────────────────────────────────────────
//
// MEASURED (docs/strategy/2026-09-13-gate-tiering-window-handoff-report.md,
// 2026-09-16 handoff, and this design's own §1.2): the flutter toolchain probes
// `%ProgramFiles(x86)%` and dies instantly without it. Node reads it fine
// through `process.env` regardless of the name's parentheses (Node reads the
// raw Win32 environment block; the string is just an object key to it) — the
// failure mode is specific to POSIX-shell layers, where a variable NAME cannot
// legally contain `(` or `)` at all, so Git Bash's `export` has no syntax that
// even attempts it, and a process launched with that shell's environ may never
// have carried the variable through in the first place.

/** Best-effort shell fingerprint, used only to pick the one-line repair that
 *  will actually work in THIS process — not to gate on (an unknown shell still
 *  gets a usable answer, just all three spellings instead of one). */
export function detectShell(env = process.env) {
  if (env.MSYSTEM) return 'git-bash'; // Git Bash / MSYS2 sets this; PowerShell and cmd never do.
  if (env.PSModulePath) return 'powershell';
  if (env.ComSpec && env.PROMPT !== undefined) return 'cmd';
  return 'unknown';
}

const FIX_BY_SHELL = {
  'git-bash':
    "run the command prefixed with: env \"ProgramFiles(x86)=C:\\Program Files (x86)\" <command>"
    + ' (Git Bash cannot `export` a variable whose NAME contains parentheses — there is no quoting that makes it legal shell syntax)',
  powershell:
    '${env:ProgramFiles(x86)} = "C:\\Program Files (x86)"  — set it in the SAME call as the command that needs it (a child process does not inherit a var a previous tool call set)',
  cmd: 'set "ProgramFiles(x86)=C:\\Program Files (x86)"',
  unknown:
    'set ProgramFiles(x86) to C:\\Program Files (x86) before running — Git Bash: env "ProgramFiles(x86)=C:\\Program Files (x86)" <cmd>; PowerShell: ${env:ProgramFiles(x86)} = "C:\\Program Files (x86)"',
};

export function checkProgramFilesX86(env = process.env) {
  const val = env['ProgramFiles(x86)'];
  if (val && val.trim() !== '') {
    return { name: 'ProgramFiles(x86)', level: 'PASS', detail: `set (${val})` };
  }
  const shell = detectShell(env);
  return {
    name: 'ProgramFiles(x86)',
    level: 'FAIL',
    detail: `missing from this process's environment (shell detected: ${shell}) — flutter dies on this instantly. Fix: ${FIX_BY_SHELL[shell]}`,
  };
}

// ── (2) toolchains reachable ─────────────────────────────────────────────────
//
// Reuses preflight-toolchain.mjs's own TOOLS table and probeTool logic rather
// than re-shelling the same four commands with a second, driftable copy of the
// version-floor logic (the exact "two mechanisms answering one question" trap
// CLAUDE.md's version-sync section names).
//
// CACHED (follow-up #2, measured 2026-09-17): `probeTools()` alone cost ~3.4s
// on this machine, almost entirely `flutter --version`'s Windows startup —
// paid on EVERY preflight run even though the four tool binaries almost never
// change between runs. The cache key is the resolved path + mtime of each
// tool's binary (via `where`/`which`, not a re-typed guess at install
// location): if none of the four binaries changed since the last run, the
// PREVIOUSLY MEASURED results are reused and `probeTools()` is never called.
// `probeTools()` itself is untouched on a miss — the cache wraps it, it does
// not re-derive it, so there is still exactly one place that knows how to
// probe a tool.
//
// A cache write failure (e.g. `.local/` briefly locked by another process)
// must not fail the check — this is bookkeeping, not the measurement itself.

const TOOLCHAIN_CACHE_PATH = join(REPO_ROOT, '.local', 'preflight-toolchain-cache.json');

/** Where a tool's binary actually is on THIS machine right now, via the
 *  platform's own resolver — never a hardcoded install path (that is exactly
 *  the "10.0.0.x reaches NY" mistake CLAUDE.md's cloud-deployment memory
 *  warns about, applied to a filesystem path instead of an IP). Returns the
 *  first match, matching how PATH resolution itself picks a winner. */
function resolveBinaryPath(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', shell: true, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout ?? ''}`.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/** One combined key over all four tools (not four independent keys): `probeTools()`
 *  probes all four in one call, so a cache that could invalidate a single tool
 *  without re-deriving that per-tool logic would just be `probeTools()` split
 *  into pieces — the exact duplication the reuse instruction rules out. If ANY
 *  binary's resolved path or mtime changed (including "was missing, now isn't"
 *  or vice versa), the whole toolchain is re-probed. */
export function toolchainCacheKey() {
  return TOOLS.map((t) => {
    const bin = resolveBinaryPath(t.argv[0]);
    if (!bin) return `${t.id}:unresolved`;
    try {
      return `${t.id}:${bin}:${statSync(bin).mtimeMs}`;
    } catch {
      return `${t.id}:${bin}:unstatable`;
    }
  }).join('|');
}

function readToolchainCache() {
  try {
    const raw = JSON.parse(readFileSync(TOOLCHAIN_CACHE_PATH, 'utf8'));
    if (raw && typeof raw.key === 'string' && Array.isArray(raw.results)) return raw;
  } catch { /* absent, corrupt, or unreadable — all treated as a miss */ }
  return null;
}

function writeToolchainCache(key, results) {
  try {
    mkdirSync(dirname(TOOLCHAIN_CACHE_PATH), { recursive: true });
    writeFileSync(TOOLCHAIN_CACHE_PATH, JSON.stringify({ key, results, cachedAt: Date.now() }, null, 2));
  } catch { /* best-effort bookkeeping — never fail the check over a write */ }
}

/** `results` → the FAIL/PASS rows this file reports. Shared by the cache-hit
 *  and cache-miss paths so the two can never disagree about what a `probeTools()`
 *  row means. */
function formatToolchainResults(results, { cacheHit }) {
  const suffix = cacheHit ? ' [cached — binaries unchanged since last preflight]' : '';
  return results.map((r) => {
    if (r.ok) return { name: `toolchain:${r.id}`, level: 'PASS', detail: `${r.version}${suffix}` };
    const tool = TOOLS.find((t) => t.id === r.id);
    return {
      name: `toolchain:${r.id}`,
      level: 'FAIL',
      detail: `${r.reason} (${r.detail}) — needed by: ${tool?.stages ?? 'unknown stage'}. Fix: ${tool?.fix ?? 'see preflight-toolchain.mjs'}${suffix}`,
    };
  });
}

export async function checkToolchain() {
  const key = toolchainCacheKey();
  const cached = readToolchainCache();
  if (cached && cached.key === key) {
    return formatToolchainResults(cached.results, { cacheHit: true });
  }
  const results = probeTools(); // UNCHANGED — see file header on why this is not re-derived here.
  writeToolchainCache(key, results);
  return formatToolchainResults(results, { cacheHit: false });
}

// ── (3) four repos, clean working trees ──────────────────────────────────────
//
// Resolved relative to THIS repo's toplevel (not a hardcoded absolute path —
// CLAUDE.md's own lesson about the web-repo path being "a past-true statement"
// applies here just as much): siblings under the same parent directory as
// `flowmic-app` itself, the shape every machine that has run this chain uses.

export function siblingRepos(root = REPO_ROOT) {
  const parent = resolve(root, '..');
  // Each private sibling name is written out exactly ONCE per line (a local
  // const here, the `name:` key below) — not a style preference: the
  // open-source export's absent-string sweep pins waivers by exact line text,
  // and a line naming the same private repo twice needs two indistinguishable
  // pins the validator itself refuses as a duplicate. One name per line keeps
  // every waiver below a plain 1-for-1 pin.
  const webDir = join(parent, 'flowmic-app-web');
  const adminDir = join(parent, 'flowmic-app-admin');
  return [
    { name: 'flowmic-app', dir: root },
    { name: 'flowmic-app-web', dir: webDir },
    { name: 'flowmic-web', dir: join(parent, 'flowmic-web') },
    { name: 'flowmic-app-admin', dir: adminDir },
  ];
}

/** `git status` via async `spawn` (not `spawnSync`) so the four sibling repos'
 *  checks run concurrently with each other and with the toolchain/orphan/ssh
 *  checks (follow-up #2) instead of blocking Node's one thread in sequence. */
function spawnCapture(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (err) {
      resolvePromise({ status: null, error: err, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolvePromise({ status: null, error: err, stdout, stderr }));
    child.on('exit', (code) => resolvePromise({ status: code, error: null, stdout, stderr }));
  });
}

export async function checkRepoClean(repo) {
  if (!existsSync(join(repo.dir, '.git'))) {
    return { name: `repo-clean:${repo.name}`, level: 'WARN', detail: `not checked out at ${repo.dir} — skipped (not every machine carries every sibling repo)` };
  }
  const r = await spawnCapture('git', ['status', '--porcelain'], { cwd: repo.dir });
  if (r.error || typeof r.status !== 'number' || r.status !== 0) {
    return { name: `repo-clean:${repo.name}`, level: 'WARN', detail: `\`git status\` could not run in ${repo.dir} (${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`})` };
  }
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { name: `repo-clean:${repo.name}`, level: 'PASS', detail: 'clean' };
  const shown = lines.slice(0, 5).join(', ');
  return {
    name: `repo-clean:${repo.name}`,
    level: 'FAIL',
    detail: `${lines.length} dirty path(s): ${shown}${lines.length > 5 ? ', …' : ''}`,
  };
}

// ── (3b) one product, one version line ───────────────────────────────────────
//
// owner 2026-07-29, still in force: the monorepo, the marketing/web repo and
// the /go client share ONE version line, and each repo bumps to the SAME
// explicit x.y.z every round — including rounds where a repo changed nothing,
// because the number says WHICH DELIVERY this is, not "did this repo change".
//
// 🔴 WHY A MACHINE HAS TO ASK. Nothing else in the chain does. Each repo's own
// `version-sync` lint compares that repo's faces against that repo's root
// package.json, so three repos can be internally perfect and still disagree
// with each other — and the disagreement is invisible until somebody reads a
// deployed page. [measured 2026-09-18, dev-pc-a: this repo and the marketing
// repo were both 0.3.90 while the repo `/go` is deployed from was 0.3.89, so
// the client that actually shipped that round carried the previous round's
// number. The round before, the same three-way read was done by hand and the
// miss was written up as an open item.]
//
// The admin console is deliberately NOT on this list: it sits at its own number
// (0.2.61, measured the same day) and never joined the line. Pinning it here
// would be asserting a rule nobody made.
//
// FAIL, not WARN, when two checked-out repos disagree: the whole round's
// artifacts are named after a number, and a round that ships two numbers cannot
// be un-named afterwards. A repo that is not checked out is a WARN (this
// machine simply may not carry it); a repo that IS checked out but whose
// version cannot be read is a FAIL — "I could not ask" is not "it agrees".
// ⚠️ DERIVED, not re-typed. `siblingRepos()` already spells each private repo
// name exactly once per line, because the open-source export's absent-string
// sweep pins waivers by exact line text and refuses two indistinguishable pins
// for one line. A second literal list here would need three more waivers and
// would be free to drift from the list the rest of the preflight uses.
export const VERSION_LINE_REPOS = Object.freeze(
  siblingRepos().map((r) => r.name).filter((n) => !n.endsWith('-admin')),
);

export function readRepoVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v.length > 0 ? { version: v } : { error: 'package.json has no version field' };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

/** Pure over already-read facts so the drill can drive every branch. */
export function judgeVersionLine(readings) {
  const present = readings.filter((r) => r.checkedOut);
  const unreadable = present.filter((r) => !r.version);
  const versions = [...new Set(present.filter((r) => r.version).map((r) => r.version))];
  const shown = readings
    .map((r) => `${r.name}=${r.checkedOut ? (r.version ?? `UNREADABLE(${r.error})`) : 'not checked out'}`)
    .join(', ');
  if (unreadable.length > 0) {
    return { name: 'version-line', level: 'FAIL', detail: `could not read the version of ${unreadable.map((r) => r.name).join(', ')} — ${shown}` };
  }
  if (versions.length > 1) {
    return { name: 'version-line', level: 'FAIL', detail: `the three repos are NOT on one version: ${shown}. One product, one version line (owner 2026-07-29) — bump the laggard with ITS OWN bump script to the explicit number, then re-run.` };
  }
  if (versions.length === 0) {
    return { name: 'version-line', level: 'WARN', detail: `none of [${VERSION_LINE_REPOS.join(', ')}] is checked out here — not checked` };
  }
  const missing = readings.filter((r) => !r.checkedOut);
  return {
    name: 'version-line',
    level: missing.length > 0 ? 'WARN' : 'PASS',
    detail: missing.length > 0
      ? `${versions[0]} across ${present.length} repo(s); ${missing.map((r) => r.name).join(', ')} not checked out here`
      : `${versions[0]} in all ${present.length} repos`,
  };
}

export function checkVersionLine(root = REPO_ROOT) {
  const byName = new Map(siblingRepos(root).map((r) => [r.name, r.dir]));
  const readings = VERSION_LINE_REPOS.map((name) => {
    const dir = byName.get(name);
    if (!dir || !existsSync(join(dir, 'package.json'))) return { name, checkedOut: false };
    const r = readRepoVersion(dir);
    return { name, checkedOut: true, version: r.version ?? null, error: r.error ?? null };
  });
  return judgeVersionLine(readings);
}

// ── (4) orphan processes ─────────────────────────────────────────────────────
//
// CLAUDE.md, verbatim: "a gate on a contended machine is not a reading" — the
// 2026-09-13 gate-tiering flaky (CE-6b) was exactly this shape, a fixed-timeout
// assertion racing whatever else the box happened to be running. A left-over
// `flutter_tester`/`cargo`/`rustc`/`vitest` process from an earlier, abandoned
// run is invisible to the chain itself (nothing in `verify:delivery` asks "is
// anything ELSE using this CPU/these ports right now") and produces exactly the
// symptom CE-6b had: a suite that is slow or flaky for a reason that looks like
// the code.
//
// Windows has no POSIX `ps` with command lines by default, so this shells out
// to PowerShell's CIM process table once (ProcessId, ParentProcessId, Name,
// CommandLine) rather than trying to reconstruct that from `tasklist`, which
// does not carry a command line at all.
//
// "Not started by this shell": ancestry is computed from THIS node process
// upward (ParentProcessId chain) and any live PID in that chain is excluded —
// it is, definitionally, part of the invocation that is asking the question,
// not a leftover from a previous one.
//
// 🔴 NARROWED (follow-up #1, measured 2026-09-17): the first version bare-
// matched `dart`, and the very first live run on this machine FAILed on 6-8
// PIDs that were a plain VS Code + Dart/Flutter extension's language server
// and tooling daemon — nothing to do with any gate. `dart` and `node` are now
// GATED, same as `vitest`: flagged only when their command line names one of
// the shapes a leftover GATE process actually has. `flutter_tester`/`cargo`/
// `rustc` stay bare-matched — nothing legitimate on a dev machine runs a
// process literally named `flutter_tester.exe`/`cargo.exe`/`rustc.exe` outside
// a build or test run, so there is no gate-vs-tooling ambiguity to resolve for
// those three the way there is for `dart` (a language server) and `node`
// (everything). The VS Code shapes are ALSO excluded by name explicitly
// (`language-server`, `tooling-daemon`) rather than relying only on the
// substring gate not matching them — belt and braces, because the gate not
// matching today is an absence of a false positive, not a rule against one.

const ORPHAN_BARE_NAMES = ['flutter_tester', 'cargo', 'rustc'];
const ORPHAN_GATED_NAMES = ['dart', 'node', 'vitest'];

/** 🔴 WORD-INITIAL, NOT SUBSTRING — measured on the integration run, 2026-09-17.
 *  These were plain `includes()` checks, and the first preflight of the merged
 *  tree FAILed on two `npx -y chrome-devtools-mcp@latest` processes: `@latest`
 *  contains `test`. Neither was a gate, neither was leftover, and both come back
 *  the moment the editor reconnects its MCP servers — so the rule as written
 *  made a clean machine unshippable, which is how a gate becomes the thing
 *  everyone learns to skip.
 *
 *  Each needle now has to START a word (preceded by start-of-string or a
 *  non-letter), which is what every real shape already looks like: `pnpm test`,
 *  `foo.test.mjs`, `flutter_tester`, `--filter test`. `latest`, `attest` and
 *  `greatest` stop matching, and `vitest` keeps matching on its own entry rather
 *  than by accident on `test`. A trailing boundary is deliberately NOT required:
 *  `test`, `tests`, `tester` and `test-runner` are all shapes we want. */
const ORPHAN_GATE_NEEDLES = ['flutter_tester', 'test', 'run-golden', 'vitest', 'verify'];
const ORPHAN_GATE_PATTERNS = ORPHAN_GATE_NEEDLES.map(
  (s) => new RegExp(`(^|[^a-z])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
);
/** Command-line shapes that are NEVER a leftover gate process, checked before
 *  either match above — an explicit denylist, not just an absent substring. */
const ORPHAN_EXCLUDE_SUBSTRINGS = ['language-server', 'tooling-daemon'];

/** Query the live process table via PowerShell CIM (name, pid, ppid, full
 *  command line), async (`spawn`, not `spawnSync`) so it runs concurrently
 *  with the git-status and ssh checks rather than blocking Node's single
 *  thread while they wait (follow-up #2). Resolves `null` on any failure —
 *  the caller must treat that as "could not check", never as "nothing found"
 *  (same rule publish-disk-space-gate.mjs applies to an unmeasurable statfs). */
export function listProcesses({ timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise) => {
    const cmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; resolvePromise(val); };
    child.stdout?.on('data', (d) => { stdout += d; });
    child.on('error', () => finish(null));
    const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(null); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (code !== 0) { finish(null); return; }
      try {
        const parsed = JSON.parse(stdout);
        finish(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        finish(null);
      }
    });
  });
}

/** The PID ancestry of `pid` (self included), walking ParentProcessId upward
 *  through `procs` until a parent is not found or a cap is hit. Exported so the
 *  drill can assert it directly against a synthetic process table. */
export function ancestryOf(pid, procs, { maxHops = 12 } = {}) {
  const byPid = new Map(procs.map((p) => [Number(p.ProcessId), p]));
  const chain = new Set([Number(pid)]);
  let cur = Number(pid);
  for (let i = 0; i < maxHops; i += 1) {
    const p = byPid.get(cur);
    if (!p) break;
    const ppid = Number(p.ParentProcessId);
    if (!Number.isFinite(ppid) || chain.has(ppid)) break;
    chain.add(ppid);
    cur = ppid;
  }
  return chain;
}

/** Pure decision function over an already-fetched process table — the drill
 *  builds one by hand instead of spawning PowerShell, so it can assert every
 *  branch (bare-name match, gated-name+substring match, ancestry exclusion)
 *  without depending on what else happens to be running on the test box. */
export function findOrphans(procs, selfPid = process.pid) {
  const ancestry = ancestryOf(selfPid, procs);
  const orphans = [];
  for (const p of procs) {
    const pid = Number(p.ProcessId);
    if (ancestry.has(pid)) continue;
    const name = String(p.Name ?? '').replace(/\.exe$/i, '').toLowerCase();
    const cmdline = String(p.CommandLine ?? '');
    if (ORPHAN_EXCLUDE_SUBSTRINGS.some((s) => cmdline.includes(s))) continue; // e.g. VS Code's dart language-server / tooling-daemon
    const bareHit = ORPHAN_BARE_NAMES.includes(name);
    const gatedHit = ORPHAN_GATED_NAMES.includes(name)
      && ORPHAN_GATE_PATTERNS.some((re) => re.test(cmdline));
    if (bareHit || gatedHit) {
      orphans.push({ pid, name: p.Name, cmdline });
    }
  }
  return orphans;
}

/** `listProcessesFn` may return a value or a promise — `await` resolves
 *  either, so the drill's synthetic fixtures (plain arrow functions) and the
 *  real async `listProcesses()` both work through the same call site. */
export async function checkOrphanProcesses(listProcessesFn = listProcesses) {
  const procs = await listProcessesFn();
  if (procs == null) {
    return [{ name: 'orphan-processes', level: 'WARN', detail: 'could not read the process table (powershell/CIM unavailable) — not checked' }];
  }
  const orphans = findOrphans(procs);
  if (orphans.length === 0) {
    return [{ name: 'orphan-processes', level: 'PASS', detail: `none of [${[...ORPHAN_BARE_NAMES, ...ORPHAN_GATED_NAMES].join(', ')}] found outside this invocation's own ancestry` }];
  }
  return orphans.map((o) => ({
    name: 'orphan-processes',
    level: 'FAIL',
    detail: `PID ${o.pid} (${o.name}) is already running and is not part of this invocation — ${o.cmdline || '(no command line readable)'}. A gate on a contended machine is not a reading; kill it (or confirm it is intentional) before proceeding.`,
  }));
}

// ── (5) disk headroom ────────────────────────────────────────────────────────

export function checkDiskHeadroom(root = REPO_ROOT, statfs = statfsSync) {
  const reading = readFreeSpace(root, statfs);
  if (reading.verdict === 'unmeasurable') {
    return { name: 'disk-headroom', level: 'WARN', detail: `could not measure ${reading.volume} — ${reading.reason}` };
  }
  const minMib = MIN_FREE_GIB * MIB_PER_GIB;
  if (reading.freeMib < minMib) {
    return {
      name: 'disk-headroom',
      level: 'FAIL',
      detail: `${(reading.freeMib / 1024).toFixed(1)} GiB free on ${reading.volume} (repo volume) — need ${MIN_FREE_GIB} GiB before a build/publish round starts`,
    };
  }
  return { name: 'disk-headroom', level: 'PASS', detail: `${(reading.freeMib / 1024).toFixed(1)} GiB free on ${reading.volume}` };
}

// ── (6) ssh reachability to deploy hosts ─────────────────────────────────────
//
// Read from the SAME env files `deploy-vps-app.py`/`deploy-vps-relay.py` read
// (never re-typed as a literal IP here — that is how "10.0.0.x reaches
// NY" outlived the machine it was ever true of, per CLAUDE.md's own cloud-
// deployment memory). WARN, not FAIL, unless `--require-hosts`: an unreachable
// deploy target says nothing about whether the BUILD half of the round will
// succeed, and the design row is explicit that these run in parallel so a slow
// or dead host does not multiply against the others.

function readEnvVar(path, key) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return null;
}


/** `~` and `~/x` are how the deploy env files spell a home-relative key path
 *  (`vps-recon.py` calls `Path(key_path).expanduser()`). OpenSSH's `-i` does NOT
 *  expand `~` on Windows, so a path copied verbatim from the env file resolves
 *  to a literal `./~/...` that does not exist — which is exactly how this check
 *  came to report a REACHABLE box as unreachable. */
export function expandHome(p, home = homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** One deploy target, read from the SAME env file the deploy script reads.
 *
 *  🔴 WHY THIS READS FOUR KEYS AND NOT ONE (2026-09-17, measured). The first cut
 *  read only `FLOWMIC_VPS_SSH_HOST` and dialled `ssh root@<host> true` with
 *  whatever default identity the agent offered. NY takes key auth ONLY, with a
 *  specific key named in `vps.env` — so every probe was refused, and preflight
 *  reported a machine that was up, reachable, and about to be deployed to as
 *  "unreachable or auth refused". A check whose negative answer is produced by
 *  its own missing credentials is not measuring the host; it is measuring
 *  itself (CLAUDE.md 「先核你的尺子」). `deploy-vps-app.py` never had this
 *  problem because `vps-recon.connect()` reads all four keys.
 *
 *  The pinning half matters just as much and for a different reason: the deploy
 *  scripts use `RejectPolicy()` with the host key added from
 *  `FLOWMIC_VPS_SSH_HOST_KEY`, i.e. they prove they reached the machine they
 *  meant to reach. If this probe used `StrictHostKeyChecking=accept-new` it
 *  would answer "something answered on that address", a weaker question wearing
 *  the same word. So the probe pins the same key the deploy pins. */
export function sshTargets(root = REPO_ROOT) {
  const parent = resolve(root, '..');
  const webDeploy = join(parent, 'flowmic-app-web', 'deploy');
  const fromEnvFile = (label, file) => {
    const path = join(webDeploy, file);
    const host = readEnvVar(path, 'FLOWMIC_VPS_SSH_HOST');
    if (!host) return { label, host: null, envFile: path };
    const rawKey = readEnvVar(path, 'FLOWMIC_VPS_SSH_KEY');
    return {
      label,
      host,
      user: readEnvVar(path, 'FLOWMIC_VPS_SSH_USER') || 'root',
      // Kept in BOTH spellings: the raw one is what a human has to go edit, the
      // expanded one is what ssh is handed. An error message that reported only
      // the expanded path would send them looking in the env file for a string
      // that is not in it.
      keyRaw: rawKey || null,
      key: rawKey ? expandHome(rawKey) : null,
      hostKey: readEnvVar(path, 'FLOWMIC_VPS_SSH_HOST_KEY'),
      envFile: path,
    };
  };
  return [
    fromEnvFile('NY', 'vps.env'),
    fromEnvFile('JP', 'vps-jp.env'),
    // ~/.ssh/config alias, not an env-file host: the Mac's credentials live in
    // the operator's ssh config, which is also where `scripts/mac-verify.sh`
    // and every mac recipe get them. Nothing here re-derives them.
    { label: 'mac', host: 'flowmic-mac', user: null, keyRaw: null, key: null, hostKey: null, envFile: null },
  ];
}

/** The argv for one probe, pure so the drill can assert what would be dialled
 *  without dialling anything. `knownHostsPath` is null when the target has no
 *  pinned host key (the mac alias), in which case ssh falls back to the
 *  operator's own known_hosts — the same file their `ssh flowmic-mac` uses. */
export function sshArgsFor(target, knownHostsPath) {
  const dest = target.user ? `${target.user}@${target.host}` : target.host;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
  if (target.key) {
    // IdentitiesOnly: without it ssh offers agent keys FIRST, and a box whose
    // `MaxAuthTries` is low enough refuses before it ever sees the right one —
    // a refusal that reads identically to "wrong key".
    args.push('-i', target.key, '-o', 'IdentitiesOnly=yes');
  }
  if (knownHostsPath) {
    args.push('-o', `UserKnownHostsFile=${knownHostsPath}`, '-o', 'StrictHostKeyChecking=yes');
  } else {
    args.push('-o', 'StrictHostKeyChecking=accept-new');
  }
  args.push(dest, 'true');
  return args;
}

/** Materialise `FLOWMIC_VPS_SSH_HOST_KEY` (a `<kind> <base64>` pair — the exact
 *  string `vps-recon.connect()` hands paramiko) into a throwaway known_hosts
 *  file, so OpenSSH pins the same key by the same bytes. Returns null when the
 *  target names no pinned key, and also when the value is malformed: no pin is
 *  honest, a wrong pin would fail the probe for a reason that is ours. */
function writePinnedKnownHosts(target) {
  if (!target.hostKey) return null;
  const parts = target.hostKey.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-ssh-pin-'));
  const file = join(dir, 'known_hosts');
  writeFileSync(file, `${target.host} ${parts[0]} ${parts[1]}\n`, 'utf8');
  return { file, dir };
}

/** One ssh probe, promise-based so all three run concurrently — the design
 *  row's explicit requirement ("ssh checks run in parallel"). `-o BatchMode=yes`
 *  refuses to hang on a password prompt; `-o ConnectTimeout=5` bounds it. */
export function probeSsh(target, { timeoutMs = 6000 } = {}) {
  return new Promise((resolvePromise) => {
    if (!target.host) {
      resolvePromise({ name: `ssh:${target.label}`, level: 'WARN', detail: 'no host configured for this target (env var missing) — not checked' });
      return;
    }
    // A configured-but-absent key is its OWN answer, and not the same answer as
    // "the host refused us": the repair is on this machine, and naming the
    // variable is what makes it actionable. Dialling anyway would offer the
    // wrong identity and report the host's refusal — the exact confusion this
    // block exists to remove.
    if (target.keyRaw && !existsSync(target.key)) {
      resolvePromise({
        name: `ssh:${target.label}`,
        level: 'WARN',
        detail: `FLOWMIC_VPS_SSH_KEY in ${target.envFile} names ${target.keyRaw} (-> ${target.key}), which does not exist on this machine — not checked (the host was never dialled)`,
      });
      return;
    }
    const pin = writePinnedKnownHosts(target);
    const dest = target.user ? `${target.user}@${target.host}` : target.host;
    const child = spawn('ssh', sshArgsFor(target, pin ? pin.file : null), { windowsHide: true });
    let settled = false;
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (b) => { stderr += b.toString(); });
    const cleanup = () => { if (pin) { try { rmSync(pin.dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
    const finish = (level, detail) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ name: `ssh:${target.label}`, level, detail });
    };
    const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish('WARN', `${dest}: no answer within ${timeoutMs}ms`); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(killer); finish('WARN', `${dest}: could not spawn ssh (${err.message})`); });
    child.on('exit', (code) => {
      clearTimeout(killer);
      const how = target.key ? `key ${target.keyRaw}` : 'ssh config';
      const pinned = pin ? ', host key pinned' : '';
      if (code === 0) finish('PASS', `${dest}: reachable (${how}${pinned})`);
      else finish('WARN', `${dest}: ssh exited ${code} (unreachable or auth refused) — ${stderr.trim().split('\n').pop() || 'no stderr'}`);
    });
  });
}

export async function checkSshTargets(root = REPO_ROOT, { requireHosts = false } = {}) {
  const targets = sshTargets(root);
  const results = await Promise.all(targets.map((t) => probeSsh(t)));
  if (!requireHosts) return results;
  return results.map((r) => (r.level === 'WARN' && r.detail.includes('unreachable') ? { ...r, level: 'FAIL' } : r));
}

// ── (7) local secret/env files present ───────────────────────────────────────

export function checkLocalEnvFiles(root = REPO_ROOT) {
  const parent = resolve(root, '..');
  const files = [
    join(root, '.local', 'download-center.env'),
    join(root, '.local', 'github.env'),
    join(root, '.local', 'cloudflare.env'),
    join(parent, 'flowmic-app-web', 'deploy', 'vps.env'),
  ];
  return files.map((f) => (
    existsSync(f)
      ? { name: `env-file:${f}`, level: 'PASS', detail: 'present' }
      : { name: `env-file:${f}`, level: 'WARN', detail: 'missing — anything that reads it will refuse at that point, not here' }
  ));
}

// ── (8) gate receipt status ──────────────────────────────────────────────────

export function checkGateReceipt(root = REPO_ROOT) {
  const r = readValidReceipt({ root });
  if (r.ok) {
    return { name: 'gate-receipt', level: 'PASS', detail: reuseBanner(r).split('\n')[1].trim() };
  }
  return { name: 'gate-receipt', level: 'WARN', detail: `no usable gate proof (${r.reason}) — next verify:delivery will run in full` };
}

// ── orchestration ────────────────────────────────────────────────────────────

export async function runAllChecks({ root = REPO_ROOT, requireHosts = false } = {}) {
  // Follow-up #2 (measured 2026-09-17): the toolchain probe (~3.4s on a cache
  // miss, mostly `flutter --version`), the orphan scan (~2s, a full
  // Win32_Process enumeration), the four git-status calls, and the ssh probes
  // are ALL kicked off here, in one Promise.all, before anything awaits any of
  // them. Node itself is single-threaded, so this alone would not make two
  // BLOCKING `spawnSync` calls overlap — the reason it works is that every one
  // of these is now `spawn` (async, non-blocking) EXCEPT the toolchain probe's
  // own cache-miss path, which still calls `probeTools()` unchanged (reuse,
  // not a rewrite) and therefore still blocks Node's event loop while it runs.
  // Every other child process here was already spawned (at the OS level) by
  // the time that blocking call starts, so they keep running on the OS
  // scheduler regardless of whether Node's own event loop is free to notice —
  // total wall time becomes roughly the LONGEST of the concurrent legs, not
  // their sum, on every run except a toolchain cache miss.
  //
  // Checks NOT in this Promise.all (ProgramFiles(x86), disk headroom, local
  // env-file presence, gate-receipt status): all measured under 5ms, in-
  // process, no subprocess — parallelizing them would add Promise overhead
  // for no measurable benefit, and the dispatch for this follow-up named the
  // four groups that actually cost time, not "the whole file".
  const [toolchainResults, orphanResults, repoResults, sshResults] = await Promise.all([
    checkToolchain(),
    checkOrphanProcesses(),
    Promise.all(siblingRepos(root).map((repo) => checkRepoClean(repo))),
    checkSshTargets(root, { requireHosts }),
  ]);

  const results = [];
  results.push(checkProgramFilesX86());
  results.push(...toolchainResults);
  results.push(...repoResults);
  results.push(checkVersionLine(root));
  results.push(...orphanResults);
  results.push(checkDiskHeadroom(root));
  results.push(...checkLocalEnvFiles(root));
  results.push(checkGateReceipt(root));
  results.push(...sshResults);
  return results;
}

export function formatLine(r) {
  return `${r.level} ${r.name} — ${r.detail}`;
}

/** Pure decision over an already-computed result list — separated from
 *  `main` so the drill can assert "all PASS/WARN ⇒ OK" and "one FAIL ⇒ FAIL(n)"
 *  without spawning powershell/ssh/git for real (same split
 *  `gate-receipt.mjs` draws between `readValidReceipt` and `status`). */
export function summarize(results, elapsedMs) {
  const fails = results.filter((r) => r.level === 'FAIL');
  const finalLine = fails.length === 0 ? `PREFLIGHT OK (${elapsedMs}ms)` : `PREFLIGHT FAIL (${fails.length}) (${elapsedMs}ms)`;
  return { ok: fails.length === 0, failCount: fails.length, finalLine };
}

export async function main(argv = process.argv.slice(2)) {
  const requireHosts = argv.includes('--require-hosts');
  const asJson = argv.includes('--json');
  const t0 = Date.now();
  const results = await runAllChecks({ requireHosts });
  const elapsedMs = Date.now() - t0;
  const { ok, finalLine } = summarize(results, elapsedMs);

  if (asJson) {
    console.log(JSON.stringify({ ok, elapsedMs, results }, null, 2));
  } else {
    for (const r of results) console.log(formatLine(r));
    console.log(finalLine);
  }
  return ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}

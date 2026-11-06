// scripts/ship-preflight-orphans.mjs — check (4) of scripts/ship-preflight.mjs,
// the orphan-process scan. Split out VERBATIM on 2026-11-03 because that file
// stood at 796 lines against the 800-line cap and this check was about to grow;
// nothing below changed in the move, and ship-preflight.mjs re-exports every
// name so no caller had to.

import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

import { ORPHAN_RULES } from '../verify/run-delivery-release.mjs';

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

// 🔴 NARROWED AGAIN (2026-11-03, the 0.3.119 round): ship's preflight FAILed on
// six node/Playwright processes from two OTHER projects on this machine
// (`G:\umby\…\@playwright\test\cli.js test-server`, `G:\CC-WORK\…\next start`):
// the word-initial `test` needle matched, and nothing asked whose they were.
// The release went out by hand. This check exists for what a leftover of OUR
// chain does — the cross-talk the release gate names (a sibling worktree's
// `flutter test` sharing ports and temp state, verify/run-delivery-release.mjs
// ORPHAN_RULES' header) and the abandoned run in the header above — and a
// stranger project's test server shares none of our paths. So each flagged
// process is now given an OWNER, read off its own command line:
//   ours     — any path in it (executable included) lies under one of our trees
//              (every checkout of every sibling repo, and each `<repo>-worktrees`
//              directory): FAIL, as before.
//   unknown  — no argument names a project path at all (relative paths only,
//              tool homes only, no command line): FAIL. "I cannot tell whose
//              this is" stays a refusal; the drill's relative fixtures live here.
//   foreign  — an argument names a project path and none is ours: WARN, printed
//              with its command line, never silently dropped. EXCEPT when the
//              release gate's own ORPHAN_RULES match it: that gate refuses those
//              shapes on any tree (a foreign cargo still starves the lanes), so
//              failing here in seconds says what it would say minutes later.
// The executable alone is never foreign evidence: our own runs use a global
// node/cargo whose install directory can be anywhere (C:\nvm4w on this box).

/** Path prefixes that are tool installs and caches, never a project — a path
 *  under one says nothing about which project a process belongs to. */
export function toolHomes(env = process.env) {
  const homes = ['APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot']
    .map((k) => env[k]).filter(Boolean);
  if (env.USERPROFILE) homes.push(`${env.USERPROFILE}\\.`); // .cargo, .rustup, .pub-cache, .gradle
  return homes.map(normPath);
}
/** Path segments that mark a package-manager cache wherever it was relocated. */
const TOOL_CACHE_SEGMENTS = ['\\_npx\\', '\\npm-cache\\', '\\.pnpm-store\\'];

function normPath(p) {
  return String(p).replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/["']+$/, '').toLowerCase();
}
const under = (p, root) => p === root || p.startsWith(root.endsWith('\\') || root.endsWith('.') ? root : `${root}\\`);

/** Every absolute drive path in a command line, the executable first. Quoted
 *  tokens are read whole, so `"C:\Program Files\…"` is one path, not two. */
export function commandLinePaths(cmdline) {
  const tokens = (String(cmdline).match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  return tokens.map((t, i) => {
    const at = t.search(/[A-Za-z]:[\\/]/);
    return at < 0 ? null : { path: normPath(t.slice(at)), exe: i === 0 };
  }).filter(Boolean);
}

/** @returns {'ours'|'foreign'|'unknown'} */
export function ownerOf(cmdline, { trees = [], homes = toolHomes() } = {}) {
  const roots = trees.map(normPath);
  const paths = commandLinePaths(cmdline);
  if (paths.some((p) => roots.some((r) => under(p.path, r)))) return 'ours';
  const evidence = paths.filter((p) => !p.exe
    && !homes.some((h) => under(p.path, h))
    && !TOOL_CACHE_SEGMENTS.some((s) => p.path.includes(s)));
  return evidence.length > 0 ? 'foreign' : 'unknown';
}

/** A lane slot `<repo>-worktrees/<slot>` maps back to `<repo>`, so a preflight
 *  run from a slot still counts the main checkout and its siblings as ours. */
export function mainCheckoutOf(dir) {
  const parent = dirname(dir);
  const m = /^(.*)-worktrees$/.exec(basename(parent));
  return m ? join(dirname(parent), m[1]) : dir;
}

/** Our trees: each repo directory, and the `<repo>-worktrees` beside it. */
export function ourTrees(repoDirs) {
  return [...new Set(repoDirs.flatMap((d) => [d, `${d}-worktrees`]))];
}

/** Pure decision function over an already-fetched process table — the drill
 *  builds one by hand instead of spawning PowerShell, so it can assert every
 *  branch (bare-name match, gated-name+substring match, ancestry exclusion)
 *  without depending on what else happens to be running on the test box.
 *  Without `trees` every hit is `unknown` (FAIL): the narrowing needs to be
 *  told what is ours, and is never applied by default. */
export function findOrphans(procs, selfPid = process.pid, { trees = [], homes = toolHomes() } = {}) {
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
      const owner = ownerOf(cmdline, { trees, homes });
      const gateRule = ORPHAN_RULES.find((r) => r.match({ pid, name: String(p.Name ?? ''), cmd: cmdline }));
      orphans.push({ pid, name: p.Name, cmdline, owner, gateRule: gateRule?.id ?? null });
    }
  }
  return orphans;
}

/** `listProcessesFn` may return a value or a promise — `await` resolves
 *  either, so the drill's synthetic fixtures (plain arrow functions) and the
 *  real async `listProcesses()` both work through the same call site. */
export async function checkOrphanProcesses(listProcessesFn = listProcesses, { trees = [], homes = toolHomes() } = {}) {
  const procs = await listProcessesFn();
  if (procs == null) {
    return [{ name: 'orphan-processes', level: 'WARN', detail: 'could not read the process table (powershell/CIM unavailable) — not checked' }];
  }
  const orphans = findOrphans(procs, process.pid, { trees, homes });
  if (orphans.length === 0) {
    return [{ name: 'orphan-processes', level: 'PASS', detail: `none of [${[...ORPHAN_BARE_NAMES, ...ORPHAN_GATED_NAMES].join(', ')}] found outside this invocation's own ancestry` }];
  }
  return orphans.map((o) => {
    const cmd = o.cmdline || '(no command line readable)';
    if (o.owner === 'foreign' && !o.gateRule) {
      return { name: 'orphan-processes', level: 'WARN', detail: `PID ${o.pid} (${o.name}) belongs to another project (no path in its command line is under our trees) — not refused, but it shares this machine's CPU: ${cmd}` };
    }
    const whose = o.owner === 'foreign'
      ? `belongs to another project, but the release gate refuses this shape on any tree [${o.gateRule}]`
      : o.owner === 'ours' ? 'runs from one of our trees' : 'cannot be attributed to any project from its command line';
    return {
      name: 'orphan-processes',
      level: 'FAIL',
      detail: `PID ${o.pid} (${o.name}) is already running, is not part of this invocation, and ${whose} — ${cmd}. A gate on a contended machine is not a reading; kill it (or confirm it is intentional) before proceeding.`,
    };
  });
}

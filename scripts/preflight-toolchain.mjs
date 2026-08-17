#!/usr/bin/env node
// C10-1 — the first second of `pnpm verify:delivery`: is the toolchain the
// chain needs actually reachable from THIS process?
//
// THE MEASURED TRIGGER (0.3.6 release, release-friction ledger rows 1-3).
// The gate died at the clippy stage three separate times with `cargo` not
// found, ~10 minutes of wall clock burned, and the diagnosis everybody reached
// first — "PATH is not configured" — was WRONG: cargo was in the user's PATH
// the whole time. What was stale was the PATH copy the tool process inherited
// when it started. Nothing in the chain could say that, because the chain has
// no step whose job is to say anything about the environment; it just walks
// into stage 3 and reports whatever cargo's absence looks like from inside
// `pnpm --filter`.
//
// So the product here is not a check. The checks already happened, three
// times, expensively. The product is A SENTENCE, delivered in the first second
// instead of the third minute, that names the tool, names the stages that need
// it, and names the one repair that is actually likely.
//
// 🔴 WHY A MISSING TOOL IS A HARD FAILURE, and what that costs.
// Every tool below is required by some stage of `verify:delivery`, so a run
// missing one was always going to end red — this only moves WHERE. The cost is
// real and is stated rather than hidden: a contributor with no Rust used to get
// lint + types + a full golden run before dying at clippy, and now gets nothing
// at all. That is why the refusal below prints the exact command line for the
// toolchain-free subset instead of just saying no. A gate that refuses without
// handing back the next move is how a gate becomes the thing everyone deletes.
//
// 🔴 WHAT THIS DOES NOT PROVE. `cargo -V` answering means a cargo exists and
// runs. It does not mean the toolchain is the right version, that the Rust
// target is installed, or that the sidecar resources cargo needs are staged —
// that last one has its own preflight (scripts/preflight-sidecar-resources.mjs)
// and the two are deliberately separate questions. Version FLOORS are checked
// only where the repo already declares one it can read (package.json engines);
// inventing floors here would be a second copy of a number that lives
// elsewhere, which is the shape this repo keeps paying for.
//
// Run:  node scripts/preflight-toolchain.mjs
// Exit: 0 = every tool answered; 1 = at least one did not.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** The one sentence this file exists to print when a tool is missing but the
 *  user is sure it is installed. It is the measured root cause of every stop
 *  in rows 1-3 of the ledger, and it is the repair nobody reaches on their own
 *  because "command not found" reads as "not installed". Exported so the drill
 *  asserts the real constant instead of a copy that can drift from it. */
export const STALE_PATH_HINT =
  'If you know this tool IS installed, the PATH this process inherited is stale — '
  + 'close and reopen the terminal (or restart the agent/editor that spawned it) and re-run. '
  + 'Measured on 0.3.6: cargo was on the user PATH the whole time and the gate still could not see it.';

/** The subset of the chain that needs no Rust and no Flutter. Printed with
 *  every refusal so "I only work on the TypeScript half" stays a supported
 *  workflow rather than a thing people rediscover by editing package.json. */
export const NODE_ONLY_SUBSET =
  'pnpm verify:lint && pnpm verify:types && pnpm verify:scripts && pnpm golden '
  + '&& pnpm verify:protocol-tests && pnpm verify:server-tests && pnpm verify:desktop-tests';

/**
 * One row per tool the delivery chain shells out to.
 *
 * `stages` is prose on purpose and NOT derived from package.json: the honest
 * mapping is "which stage's subprocess ends up invoking this binary", which is
 * not recoverable from the script strings (`pnpm verify:clippy` says nothing
 * about cargo until you expand it, and `flutter test` hides behind a `cd`).
 * A wrong derivation would be worse than a stated one — it would look checked.
 */
export const TOOLS = [
  {
    id: 'node',
    argv: ['node', '-v'],
    stages: 'every stage (and this script itself)',
    // The floor is READ, never retyped — package.json `engines` is where this
    // repo already answers "which Node", and node-version-pin lint guards it.
    floorFrom: 'node',
    fix: 'Install Node 22 or newer: https://nodejs.org  (or `nvm use 22` / `fnm use 22` if you manage versions)',
  },
  {
    id: 'pnpm',
    argv: ['pnpm', '-v'],
    stages: 'every stage — the chain IS a pnpm script chain',
    floorFrom: 'pnpm',
    fix: 'Enable it through the Node install: `corepack enable pnpm`  (or `npm i -g pnpm@9`)',
  },
  {
    id: 'cargo',
    argv: ['cargo', '-V'],
    stages: 'verify:clippy, verify:rust-tests, verify:doctests',
    fix: 'Install the Rust toolchain: https://rustup.rs  (then reopen the shell so PATH is refreshed)',
  },
  {
    id: 'flutter',
    argv: ['flutter', '--version'],
    stages: 'verify:mobile-tests',
    fix: 'Install Flutter 3.41 or newer: https://docs.flutter.dev/get-started/install',
  },
];

/** package.json `engines` — the repo's own declaration of its floors. Read
 *  rather than mirrored so this file can never disagree with the manifest that
 *  npm/pnpm themselves enforce. */
export function readEngines(root = REPO_ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines ?? {};
  } catch {
    return {};
  }
}

/**
 * Run one tool and report what happened. Never throws: a preflight that can
 * crash is a preflight that turns "your cargo is missing" into a stack trace.
 *
 * `shell: true` is load-bearing on Windows, not cosmetic — `flutter` is a
 * `.bat` and `pnpm` a `.cmd` there, and Node refuses to spawn either without a
 * shell (EINVAL, since the 2024 argument-injection fix). Without it this
 * preflight would report "flutter missing" on every Windows box that has it,
 * i.e. it would manufacture the exact false alarm it exists to prevent.
 */
export function probeTool(tool, { timeoutMs = 25_000 } = {}) {
  const [cmd, ...args] = tool.argv;
  let r;
  try {
    r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, timeout: timeoutMs, windowsHide: true });
  } catch (err) {
    return { id: tool.id, ok: false, reason: 'spawn-failed', detail: String(err?.message ?? err) };
  }
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { id: tool.id, ok: false, reason: 'timed-out', detail: `${cmd} did not answer within ${timeoutMs}ms` };
  }
  if (r.error) return { id: tool.id, ok: false, reason: 'spawn-failed', detail: String(r.error.message) };
  if (r.status !== 0) {
    return { id: tool.id, ok: false, reason: 'not-found', detail: `${cmd} exited ${r.status}` };
  }
  // First non-empty line: `flutter --version` prints a paragraph, the rest
  // print one line, and the first line is the version in both shapes.
  const line = `${r.stdout ?? ''}`.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return { id: tool.id, ok: true, version: line };
}

/** Probe every tool. Exported for gate-receipt.mjs, which records these
 *  readings inside a receipt: a toolchain that moved between the gate run and
 *  the publish run is a reason to refuse to reuse the proof. */
export function probeTools(tools = TOOLS, opts) {
  return tools.map((t) => probeTool(t, opts));
}

/** Major version parsed out of whatever the tool printed, or null. Deliberately
 *  loose: this only ever downgrades a hard floor check into "not checked", and
 *  a preflight that fails because it could not parse a banner would be worse
 *  than one that says nothing about the version. */
export function majorOf(versionLine) {
  const m = /(\d+)\.\d+(?:\.\d+)?/.exec(versionLine ?? '');
  return m ? Number(m[1]) : null;
}

/** `>=22` / `^9.1.0` / `9` → 22 / 9 / 9. Same looseness, same reason. */
export function floorMajor(range) {
  const m = /(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) : null;
}

function report(results, engines) {
  const missing = results.filter((r) => !r.ok);
  const below = [];
  for (const r of results.filter((x) => x.ok)) {
    const tool = TOOLS.find((t) => t.id === r.id);
    if (!tool?.floorFrom) continue;
    const need = floorMajor(engines[tool.floorFrom]);
    const got = majorOf(r.version);
    if (need != null && got != null && got < need) below.push({ r, need, got });
  }
  return { missing, below };
}

export function formatRefusal(missing, below) {
  const out = [];
  for (const m of missing) {
    const tool = TOOLS.find((t) => t.id === m.id);
    out.push(`✗ ${m.id} — ${m.reason} (${m.detail})`);
    out.push(`    needed by: ${tool.stages}`);
    out.push(`    fix: ${tool.fix}`);
  }
  for (const b of below) {
    const tool = TOOLS.find((t) => t.id === b.r.id);
    out.push(`✗ ${b.r.id} — ${b.r.version} is below the floor this repo declares (major ${b.need})`);
    out.push(`    needed by: ${tool.stages}`);
    out.push(`    fix: ${tool.fix}`);
  }
  if (missing.length > 0) {
    out.push('');
    out.push(`  ${STALE_PATH_HINT}`);
    out.push('');
    out.push('  To run only the part of the gate that needs neither Rust nor Flutter:');
    out.push(`    ${NODE_ONLY_SUBSET}`);
  }
  return out.join('\n');
}

export function main() {
  const engines = readEngines();
  const t0 = Date.now();
  const results = probeTools();
  const { missing, below } = report(results, engines);

  for (const r of results) {
    if (r.ok) console.log(`  ${r.id.padEnd(8)} ${r.version}`);
    else console.log(`  ${r.id.padEnd(8)} MISSING (${r.reason})`);
  }

  if (missing.length === 0 && below.length === 0) {
    console.log(`✓ toolchain preflight OK (${results.length} tools, ${Date.now() - t0}ms)`);
    return 0;
  }
  console.error('');
  console.error(formatRefusal(missing, below));
  console.error('');
  console.error('  Stopping here rather than at stage 3: the run was going to end red either way,');
  console.error('  and three minutes of lint and types would not have told you any of the above.');
  return 1;
}

const invokedDirectly = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());

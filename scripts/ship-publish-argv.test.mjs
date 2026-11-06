// Drill: every publish.mjs command line scripts/ship.mjs can build is one that
// publish.mjs accepts.
//
// WHY (measured 2026-11-03, the 0.3.119 round): ship's stage 1 had PUBLISH in
// its plan and MANIFEST out, so it handed publish `--freeze-round`; an adopted
// Mac/Linux zip in ./publish made it add `--keep-adopted`; and publish's freeze
// allowlist admitted only `--skip-lan`. Each half had its own green drill
// (ship-orchestrator.test.mjs §6b/§11 for what ship emits, the freeze module for
// what publish refuses), and nothing ever put the two together. The release
// was finished by hand.
//
// HOW IT CANNOT DRIFT AGAIN. Both sides are asked through the functions the
// production code calls, not through copies:
//   · ship side — `buildGraph` + `publishPlanFlags` + `attachCommands`, the
//     three calls ship.mjs main() makes, over EVERY `--only` target selection
//     (all subsets of ship's own TARGETS) and both answers of the adopted-
//     artifact decision;
//   · publish side — `publishArgvRefusal`, the one function publish.mjs asks
//     before it writes a byte, with the env ship hands every child.
// A flag ship starts emitting, or a refusal publish starts making, lands in
// this matrix with nobody having to remember it.
//
// Reverse control (2026-11-03): with `--keep-adopted`/`--discard-adopted`
// taken back out of FREEZE_COMPATIBLE_FLAGS this drill fails on every frozen
// selection with an adopted artifact — the exact 0.3.119 command line.
//
// Run: node scripts/ship-publish-argv.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGETS, attachCommands, buildGraph } from './ship.mjs';
import { publishPlanFlags } from './ship-publish-flags.mjs';
import { publishArgvRefusal } from './publish-argv.mjs';
import { SHIP_PID_ENV } from './publish-manifest-deferred.mjs';
import { KEEP_FLAG } from './publish-adopted-artifact-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = { node: 'node', pnpm: 'pnpm', make: 'make', py: 'py', bash: 'bash', git: 'git' };
let failures = 0;
const check = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
};

/** The publish argv ship would spawn for this selection, or null when the plan
 *  has no PUBLISH. Commands are attached and immediately disarmed: the arg list
 *  is the evidence, the closure is never run. */
function publishArgv(selection, keepAdopted, logDir) {
  let nodes;
  try { ({ nodes } = buildGraph(selection)); } catch { return { refusedByPlanner: true }; }
  const flags = publishPlanFlags(new Set(nodes.map((n) => n.name)));
  attachCommands(nodes, { root: ROOT, tools: TOOLS, logDir, sha: 'aaaabbbbcccc', note: 'drill', ...flags, keepAdopted });
  for (const n of nodes) n.run = () => { throw new Error('drill: production commands are never run here'); };
  const publish = nodes.find((n) => n.name === 'PUBLISH');
  if (!publish) return { argv: null, flags };
  const args = publish.ready.plan.args;
  const at = args.findIndex((a) => /publish\.mjs$/.test(a));
  return { argv: args.slice(at + 1), flags };
}

const logDir = mkdtempSync(join(tmpdir(), 'ship-publish-argv-'));
try {
  console.log('\n=== every ship selection x adopted decision yields a publish argv publish.mjs accepts ===');
  const env = { [SHIP_PID_ENV]: String(process.pid) };
  const selections = [{}];
  for (let mask = 1; mask < (1 << TARGETS.length); mask += 1) {
    selections.push({ only: TARGETS.filter((_, i) => mask & (1 << i)) });
  }
  let asked = 0;
  let frozenWithKeep = 0;
  let deferredWithKeep = 0;
  const refused = [];
  for (const selection of selections) {
    for (const keepAdopted of [false, true]) {
      const r = publishArgv(selection, keepAdopted, logDir);
      if (!r.argv) continue;
      asked += 1;
      if (r.flags.freezeRound && keepAdopted) frozenWithKeep += 1;
      if (r.flags.manifestDeferred && keepAdopted) deferredWithKeep += 1;
      const refusal = publishArgvRefusal(r.argv, env);
      if (refusal) refused.push(`${selection.only ? `--only ${selection.only.join(',')}` : '(full)'}${keepAdopted ? ' +adopted' : ''}: publish.mjs ${r.argv.join(' ')}\n      ${refusal.split('\n')[0]}`);
    }
  }
  check(asked > 100, `the matrix is not empty: ${asked} publish command lines asked (of ${selections.length} selections x 2)`);
  check(frozenWithKeep > 0, `  ...and it contains the 0.3.119 shape (freeze round + adopted artifact): ${frozenWithKeep} line(s)`);
  check(deferredWithKeep > 0, `  ...and the full-round shape (deferred manifest + adopted artifact): ${deferredWithKeep} line(s)`);
  check(refused.length === 0, `publish.mjs refuses none of them${refused.length ? `; first refusals:\n    ${refused.slice(0, 3).join('\n    ')}` : ''}`);

  console.log('\n=== the probe can see a refusal (positive control) ===');
  const stage1 = publishArgv({ only: ['publish'] }, true, logDir);
  check(stage1.argv.includes('--freeze-round') && stage1.argv.includes(KEEP_FLAG), `ship's stage 1 with an adopted zip emits ${stage1.argv.join(' ')}`);
  check(publishArgvRefusal([...stage1.argv, '--with-manifest'], env) !== null, 'the same line plus --with-manifest (writes the manifest a freeze forbids) IS refused, so a clean matrix is not a blind validator');
  check(publishArgvRefusal(['--manifest-deferred'], {}) !== null, 'and the deferral lock still refuses a hand-typed --manifest-deferred (no ship pid)');
} finally {
  rmSync(logDir, { recursive: true, force: true });
}

if (failures > 0) { console.log(`\nFAIL: ${failures} failure(s)`); process.exit(1); }
console.log('\nPASS: 0 failure(s)');

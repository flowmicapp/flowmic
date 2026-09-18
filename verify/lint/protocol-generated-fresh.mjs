// verify/lint/protocol-generated-fresh.mjs
//
// 🔴 A GENERATED FILE THAT CAN SILENTLY GO STALE IS A SECOND ANSWER TO A
// QUESTION THE PROTOCOL ALREADY ANSWERED.
//
// `apps/mobile/tool/gen_protocol.mjs` derives the phone's handshake schema
// version, the retired-relay list, BOTH pairing-link prefixes, the settings key
// names, the scenario caps and the dictionary pack ids from
// `packages/protocol/src/*`. Until card H-15 (2026-09-15) the only thing keeping
// its output fresh was `make -C apps/mobile gen` being a prerequisite of every
// Dart target — and the generator's own header said so, in as many words, as a
// known hole: editing `constants.ts` and forgetting to regenerate was INVISIBLE
// to `pnpm verify:lint`.
//
// That is this repo's #1 historical defect class wearing a build-tool costume,
// and it is the same one `i18n-generated-fresh` was written for. This lint is
// that lint's shape, pointed at the protocol codegen.
//
// ── WHY A SEPARATE LINT AND NOT A ROW IN i18n-generated-fresh ───────────────
// These artefacts are not i18n. That lint's PASS says 「N generated i18n
// artefact(s) match their source data」 and its FAIL says 「regenerate with
// `pnpm i18n:gen`」. Both sentences would be wrong here, and a repair
// instruction that sends someone to the wrong command is worse than none: they
// run it, nothing changes, and they conclude the gate is broken. The repair
// here is `make -C apps/mobile gen`.
//
// ── 🔴 WHAT A PASS HERE DOES NOT SAY ───────────────────────────────────────
//   · It does NOT say `flowmic_events.g.dart` agrees with
//     `packages/protocol/src/events.ts`. `--check` deliberately does not run the
//     protocol package's event codegen — a check that writes is not a check — so
//     it compares the phone's COPY against `packages/protocol/gen/dart/`. The
//     remaining hop is answered by `make gen` before anything compiles Dart, and
//     by nothing in `verify:lint`. Said out loud rather than left to be assumed.
//   · It does NOT say the artefacts exist. `*.g.dart` is gitignored, so on a
//     fresh clone 「never generated」 is the normal state and is skipped — the
//     same `--skip-missing` reasoning the mobile i18n rows carry. What is still
//     caught, and what this lint is for, is the case that matters: the artefact
//     is there, and it is behind its source.
//   · It does NOT cover 「generated once, then pulled」 any better than the i18n
//     rows do. A long-lived checkout whose gitignored artefacts predate the last
//     pull reports stale. That verdict is TRUE and it is not downgraded here:
//     nothing can ship from such a tree, because every mobile target depends on
//     `make gen`.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/protocol-generated-fresh.mjs` evaluates this module and
// exits 0 without checking anything -- a silence indistinguishable from a pass.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'protocol-generated-fresh';

/** The generator, and the flags that make it answer instead of write.
 *  One entry, deliberately: a table of one is still a table, and the next
 *  protocol-side generator gets a row rather than a second file. */
export const GENERATORS = [
  {
    label: 'mobile protocol constants (lib/generated/flowmic_{protocol,settings,events}.g.dart)',
    script: 'apps/mobile/tool/gen_protocol.mjs',
    args: ['--check', '--skip-missing'],
    repair: 'make -C apps/mobile gen',
  },
];

function runNode(scriptRel, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, scriptRel), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: String(err && err.message) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** The generator prints a lot of node warnings on some hosts (UNDICI etc.); the
 *  verdict is the LAST non-empty line it wrote. */
function lastLine(out) {
  return out.trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? '';
}

/**
 * The generator's exit code, turned into this suite's verdict. Pure, exported,
 * and drilled directly — because the interesting case (`2`, nothing comparable)
 * only happens on a tree where `make gen` has never run, and a check whose only
 * evidence is 「it was green on the machine that wrote it」 proves the machine.
 *
 * 🔴 `2` IS A SKIP, NEVER A PASS. With `--skip-missing` on a fresh clone every
 * artefact is absent, so the comparison loop finds nothing to disagree with.
 * Reporting that as PASS would be a check that covered zero claiming success —
 * the thing the product's own status red line forbids, and the reason
 * commit-hook-mirror keeps a SKIP bucket. run-all.mjs counts SKIP separately.
 */
export function classifyExit(code, out) {
  const line = lastLine(out);
  if (code === -1) return { kind: 'not-runnable', line };
  if (code === 0) return { kind: 'fresh', line };
  if (code === 2) return { kind: 'nothing-comparable', line };
  return { kind: 'stale', line };
}

export default async function run() {
  const stale = [];
  const notRunnable = [];
  const nothingComparable = [];
  const details = [];

  for (const g of GENERATORS) {
    const res = await runNode(g.script, g.args);
    const verdict = classifyExit(res.code, res.out);
    if (verdict.kind === 'not-runnable') {
      // The generator could not be started at all. Its own kind of failure, not
      // folded into "stale": a missing generator and a stale artefact need
      // different repairs, and collapsing them sends someone to regenerate a
      // file with a script that is not there.
      notRunnable.push(`${g.label} (${g.script}: ${verdict.line})`);
    } else if (verdict.kind === 'stale') {
      stale.push(`${g.label} — ${verdict.line} [repair: ${g.repair}]`);
    } else if (verdict.kind === 'nothing-comparable') {
      nothingComparable.push(`${g.label} — ${verdict.line}`);
    } else {
      details.push(verdict.line);
    }
  }

  if (notRunnable.length > 0) {
    return { status: 'FAIL', detail: `generator not runnable: ${notRunnable.join('; ')}` };
  }
  if (stale.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${stale.length} generated artefact(s) do not match their source data: ${stale.join('; ')}`,
    };
  }
  if (details.length === 0) {
    // Every generator answered "nothing comparable". Nothing verifiable
    // happened, so this is a SKIP — see classifyExit's header.
    return { status: 'SKIP', detail: nothingComparable.join('; ') };
  }
  return {
    status: 'PASS',
    detail:
      `${details.length} protocol codegen(s) re-derived and compared without writing: ` +
      `${details.join('; ')}` +
      (nothingComparable.length > 0
        ? `; ${nothingComparable.length} had nothing to compare: ${nothingComparable.join('; ')}`
        : '') +
      '. DOES NOT say flowmic_events.g.dart agrees with ' +
      'packages/protocol/src/events.ts — see file header',
  };
}

// verify/delivery-checks/_cli.mjs — the one entry shape every delivery check
// shares.
//
// A delivery check is a module with a default `run()` returning
// `{ status: 'PASS' | 'FAIL' | 'SKIP', detail }`, the same result shape a lint
// returns (verify/lint/run-all.mjs), so the same function can be imported by a
// test. What makes it a delivery check rather than a lint is WHERE it runs:
// in the delivery gates (`verify:delivery` and verify/run-delivery-fast.mjs,
// which scripts/gate-fast-runner.test.mjs holds to the same stage set), never
// in `verify:lint`, which pre-commit runs on every commit. A check belongs here
// when its answer is not about the commit being made: a sibling repository
// catching up, or a branch-in-flight state that must not reach delivery.
//
// SKIP exits 0 and PASS exits 0; only FAIL exits 1. The SKIP line always
// carries its reason, and the gate log prints it, so a SKIP is never read as
// "checked and fine".

import { isDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

export async function runAsCommand(moduleUrl, name, run) {
  if (!isDirectRun(moduleUrl)) return;
  const started = Date.now();
  let result;
  try {
    result = await run();
  } catch (error) {
    result = { status: 'FAIL', detail: `threw: ${error?.stack ?? error}` };
  }
  const line = `${result.status} ${name} (${Date.now() - started}ms) ${result.detail}`;
  if (result.status === 'FAIL') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  process.exit(result.status === 'FAIL' ? 1 : 0);
}

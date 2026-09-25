// verify/lint/lint-worker.mjs
// One lint check, executed on a `worker_threads` worker owned by run-all.mjs.
//
// WHY THIS FILE EXISTS (measured, 2026-09-12,
// docs/archive/strategy/2026-09-12-verify-delivery-speedup-plan.md §3.1)
// ---------------------------------------------------------------------------
// run-all.mjs used to fire all 40 checks with `Promise.all` on ONE thread and
// call that "concurrent". It is not: these checks are synchronous regex sweeps
// over 1000–2600 files each, so they only yield at the odd `await`, and the
// thread is time-sliced between them. The measurement that settled it:
//
//     check           inside the 40-way Promise.all      run on its own
//     file-size                     19.9 s                   1.86 s
//     no-cjk                        19.9 s                   2.57 s
//     no-cloud-keys                 21.3 s                   3.13 s
//
// 6.8–10.7× — and every check's self-reported time converged on the same
// number, which is the signature of "everybody finished when everybody
// finished", not of parallelism. Raising UV_THREADPOOL_SIZE to 32 changed
// nothing (20 753 ms vs 21 338 ms), which rules out the fs thread pool and
// leaves CPU contention on the single JS thread.
//
// A worker is a real OS thread with its own isolate, so a sweep in one no
// longer stalls a sweep in another.
//
// ⚠️ THE TIME THIS FILE REPORTS IS THE CHECK'S OWN COST, not its share of a
// queue. That is the point, and it means the per-line `(Nms)` numbers dropped
// by roughly an order of magnitude on the day this landed WITHOUT any check
// getting faster. Do not read the drop as an optimisation of the checks.
//
// The module is loaded by `await import('./<name>.mjs')` and its DEFAULT export
// is called. Every registered lint has exactly one row in run-all.mjs's LINTS
// table whose `name` is its filename minus `.mjs`; run-all.mjs proves that
// mapping on startup rather than trusting it (a name that resolved to nothing
// would otherwise be a check that silently never ran — the failure shape the
// whole suite exists to prevent).
//
// `refuseDirectRun` (scripts/module-entrypoint-guard.mjs), which every lint
// module calls at import time, does NOT fire in here: it compares the module's
// own path against `process.argv[1]`, and inside a worker `argv[1]` is THIS
// file's path, never the lint's. Measured on this machine, not assumed.

import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

if (!parentPort) {
  process.stderr.write(
    'lint-worker.mjs is a worker entry point, not a command.\n  use: pnpm verify:lint\n'
  );
  process.exit(2);
}

const VALID = new Set(['PASS', 'SKIP', 'FAIL']);

parentPort.on('message', async (msg) => {
  const name = msg && msg.name;
  const t0 = performance.now();
  let status = 'FAIL';
  let detail = '';
  try {
    const mod = await import(`./${name}.mjs`);
    const run = mod.default;
    if (typeof run !== 'function') {
      throw new Error(`./${name}.mjs has no default-exported run() — nothing to call`);
    }
    const result = await run();
    const raw = result && result.status;
    detail = result && result.detail != null ? String(result.detail) : '';
    if (VALID.has(raw)) {
      status = raw;
    } else {
      // Not silently coerced to PASS. An unrecognised verdict is a broken
      // check, and a broken check reported as green is the one outcome this
      // suite may never produce.
      status = 'FAIL';
      detail = `returned an unrecognised status ${JSON.stringify(raw)}${detail ? ` — ${detail}` : ''}`;
    }
  } catch (err) {
    status = 'FAIL';
    detail = `threw: ${err && err.message ? err.message : String(err)}`;
  }
  // Only strings cross the boundary: a lint that returned something exotic
  // would otherwise fail structured-clone and take the whole run with it.
  parentPort.postMessage({ name, status, detail, ms: Math.round(performance.now() - t0) });
});

// NR-161 deterministic lock reproduction; run from the repository root after
// building protocol and server-core. This runs the real G26 alongside G24,
// adding a real 200 ms writer at the exact section 9 seed that failed in CI.
// The worker changes no values and commits before the scenario continues.
// Usage: node verify/golden/g26-lock-loop.mjs 20 PASS
// Baseline: use FAIL; a named G26-only reverse control uses 1 PASS --g26-only.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const { G26 } = await import(pathToFileURL(path.join(root, 'verify/golden/g26-site-demo.mjs')));
const { G24 } = await import(pathToFileURL(path.join(root, 'verify/golden/g24-billing-budget.mjs')));
const iterations = Number(process.argv[2] ?? 20);
const expect = process.argv[3] ?? 'PASS';
const peerEnabled = !process.argv.includes('--g26-only');
assert(Number.isInteger(iterations) && iterations > 0, 'iterations must be positive');
assert(['PASS', 'FAIL'].includes(expect), 'expected G26 status must be PASS or FAIL');
const originalPrepare = DatabaseSync.prototype.prepare;
let injected = 0;
const workers = [];
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  if (!sql.includes('INSERT INTO usage_records (user_id, month, stt_minutes')) return statement;
  const file = originalPrepare.call(this, 'PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (path.basename(file) !== 'g26.sqlite') return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    // G26 section 9's exact seed, the public-CI failing call (42.975 min).
    if (Math.abs(args[2] - (43 * 60000 - 1500) / 60000) > 0.00001) return run(...args);
    const shared = new SharedArrayBuffer(4);
    const state = new Int32Array(shared);
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const state = new Int32Array(workerData.shared);
      let db;
      try {
        db = new DatabaseSync(workerData.file);
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE usage_records SET updated_at=updated_at WHERE user_id=?').run(workerData.userId);
        Atomics.store(state, 0, 1); Atomics.notify(state, 0);
        Atomics.wait(state, 0, 1, 200);
        db.exec('COMMIT');
        Atomics.store(state, 0, 2); Atomics.notify(state, 0);
      } catch (e) {
        Atomics.store(state, 0, -1); Atomics.notify(state, 0); throw e;
      } finally { db?.close(); }
    `, { eval: true, workerData: { shared, file, userId: args[0] } });
    workers.push(new Promise((resolve, reject) => { worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))); worker.once('error', reject); }));
    const deadline = Date.now() + 10000;
    while (Atomics.load(state, 0) === 0 && Date.now() < deadline) Atomics.wait(state, 0, 0, 100);
    assert.equal(Atomics.load(state, 0), 1, 'writer must hold a real SQLite write transaction before the seed');
    injected++;
    try { return run(...args); }
    finally {
      while (Atomics.load(state, 0) === 1) Atomics.wait(state, 0, 1, 1000);
      assert.equal(Atomics.load(state, 0), 2, 'writer committed');
    }
  };
  return statement;
};
let mismatches = 0;
for (let i = 1; i <= iterations; i++) {
  const start = Date.now();
  const [demo, peer] = await Promise.all([G26.fn(), peerEnabled ? G24.fn() : { status: 'SKIPPED' }]);
  await Promise.all(workers.splice(0));
  const matched = demo.status === expect && peer.status === (peerEnabled ? 'PASS' : 'SKIPPED')
    && (expect !== 'FAIL' || /database is locked[\s\S]*seedUsedMs/.test(demo.reason));
  if (!matched) mismatches++;
  console.log(JSON.stringify({ iteration: i, g26: demo.status, g24: peer.status, matched, ms: Date.now() - start,
    ...(demo.status === 'FAIL' ? { error: demo.reason } : {}), ...(peer.status === 'FAIL' ? { peerError: peer.reason } : {}) }));
}
assert.equal(injected, iterations, 'every iteration reached the exact failing seed');
console.log(JSON.stringify({ iterations, expected: expect, injected, mismatches }));
process.exitCode = mismatches ? 1 : 0;

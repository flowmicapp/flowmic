// Drill for scripts/module-entrypoint-guard.mjs.
//
// The guard sits at the top of two modules on the PUBLISH path
// (apk-self-update-marker, apk-disclosure-copy-marker) and one lint. A false
// positive there refuses to ship a good build, so the "does not fire under
// import" direction matters more than the direction the guard was written for.
//
// Both directions are driven for real — the guard calls process.exit, so it is
// exercised in child processes rather than by reasoning about its source.
//
// Run: `node scripts/module-entrypoint-guard.test.mjs`

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const GUARDED = [
  ['scripts/apk-self-update-marker.mjs', 'publish-apk-gates'],
  ['scripts/apk-disclosure-copy-marker.mjs', 'publish-apk-gates'],
  ['verify/lint/platform-cfg-count.mjs', 'verify:lint'],
];

console.log('direct run is refused, loudly and with a non-zero code');
for (const [rel, hint] of GUARDED) {
  const r = spawnSync(node, [path.join(ROOT, rel)], { encoding: 'utf8' });
  const err = r.stderr ?? '';
  // Exit 2, not 1: a caller grepping for a gate's own failure code must not
  // read "you invoked this wrong" as "the artifact failed".
  check(`${rel} exits 2`, r.status === 2, `got ${r.status}`);
  check(`${rel} names the right entry point`, err.includes(hint), err.slice(0, 120));
  check(
    `${rel} says why silence was dangerous`,
    /looks\s*\n?\s*exactly like a passing check/.test(err),
    err.slice(0, 120),
  );
}

console.log('\nimport does NOT fire the guard (publish path must not break)');
for (const [rel] of GUARDED) {
  const url = new URL(`file://${path.join(ROOT, rel).replace(/\\/g, '/')}`).href;
  const r = spawnSync(node, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('IMPORTED_OK');`], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  check(`${rel} imports cleanly`, r.status === 0 && r.stdout.includes('IMPORTED_OK'), `status=${r.status} ${r.stderr.slice(0, 160)}`);
}

console.log('\nreverse control: an UNGUARDED module still exits 0 in silence');
{
  // The exact shape the guard exists to catch, proven to still exist elsewhere.
  // If this ever flips, the guard became repo-wide and this drill's claim in
  // platform-cfg-count.mjs ("only this lint carries the guard") went stale.
  const r = spawnSync(node, [path.join(ROOT, 'verify', 'lint', '_util.mjs')], { encoding: 'utf8' });
  check(
    'verify/lint/_util.mjs exits 0 with no output (unguarded, as documented)',
    r.status === 0 && (r.stdout + r.stderr).trim() === '',
    `status=${r.status} out=${(r.stdout + r.stderr).slice(0, 120)}`,
  );
}

console.log(failed === 0 ? '\nPASS' : `\nFAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);

// Discovered by verify:scripts; mac-verify/Linux gate also run this native path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform === 'win32') {
  console.log('SKIP: sidecar-parent-death-test.py requires Unix SIGKILL and native Rust wiring');
  process.exit(2);
}
const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 300_000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);
  return result;
};
assert.equal(run('cargo', ['build', '--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--example', 'sidecar_parent']).status, 0);
const parent = resolve(process.env.CARGO_TARGET_DIR ?? 'apps/desktop/src-tauri/target', 'debug/examples/sidecar_parent');
const args = ['scripts/sidecar-parent-death-test.py', '--parent', parent,
  '--node', resolve('apps/desktop/src-tauri/resources/node'),
  '--server', resolve('apps/desktop/src-tauri/resources/server.js')];
for (const mode of ['guarded', 'pipe-only', ...(process.platform === 'linux' ? ['kernel-only'] : []), 'reclaim', 'refuse', 'live-owner']) {
  assert.equal(run('python3', [...args, '--mode', mode]).status, 0, mode);
}
const red = run('python3', [...args, '--mode', 'unguarded']);
assert.equal(red.status, 1, 'unguarded must go red on the named Python test');
assert.match(red.stderr, /FAIL sidecar survived parent SIGKILL or retained its port after 3 seconds/);
console.log('PASS native sidecar-parent-death-test.py; unguarded reverse control observed RED');

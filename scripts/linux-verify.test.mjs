// Exercise the real shell runner's failure aggregation with fake tool commands.
// This proves the verification instrument, never the Linux desktop product.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'scripts/linux-verify.sh');
const contents = readFileSync(source, 'utf8');
assert.match(contents, /run_stage clippy-core cargo clippy/);
assert.match(contents, /run_stage clippy-app cargo clippy/);
assert.match(contents, /run_stage tests-core cargo test/);
assert.match(contents, /run_stage tests-app cargo test/);
assert.match(contents, /run_stage desktop-build pnpm --filter @flowmic\/desktop tauri:build/);
assert.doesNotMatch(contents, /gate-receipt|pnpm verify:delivery\s/);
if (process.platform !== 'linux') {
  console.log('SKIP: Linux shell execution requires Linux; command wiring assertions ran only.');
  process.exit(2);
}

const parent = join(process.env.TMPDIR ?? join(root, '.local'), 'linux-runner-test');
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(join(parent, 'run-'));
try {
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'bin'));
  mkdirSync(join(fixture, 'apps/desktop'), {recursive:true});
  writeFileSync(join(fixture, '.node-version'), '22.22.3\n');
  copyFileSync(source, join(fixture, 'scripts/linux-verify.sh'));
  const executable = (name, text) => {
    const path = join(fixture, 'bin', name);
    writeFileSync(path, `#!/bin/bash\n${text}\n`);
    chmodSync(path, 0o755);
  };
  executable('git', 'if [ "$1" = rev-parse ]; then echo fixture-commit; fi');
  executable('node', 'if [ "$1" = --version ]; then echo "${FAKE_NODE_VERSION:-v22.22.3}"; else exit "${FAKE_NATIVE_EXIT:-0}"; fi');
  executable('pnpm', 'echo "pnpm $*"; exit 0');
  executable('cargo', 'echo "cargo $*"; if [ "${BREAK_CORE:-0}" = 1 ] && [ "$1" = clippy ]; then exit 42; fi; exit 0');
  const run = (broken, extra = {}) => spawnSync('bash', [join(fixture, 'scripts/linux-verify.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(fixture, 'bin')}:${process.env.PATH}`, BREAK_CORE: broken ? '1' : '0',
      CARGO_TARGET_DIR: join(fixture, 'target'), TMPDIR: join(fixture, 'tmp'), ...extra },
  });
  const positive = run(false);
  assert.equal(positive.status, 0, positive.stderr + positive.stdout);
  assert.match(positive.stdout, /LINUX GATE PASS .*tests-core, tests-app, production-preflight, doctests, desktop-build/);
  const blocked = run(false, {FAKE_NODE_VERSION:'v20.0.0', FAKE_NATIVE_EXIT:'1'});
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /PREREQUISITE NODE_PIN/);
  assert.match(blocked.stdout, /PREREQUISITE LINUX_NATIVE_DEPENDENCIES/);
  assert.match(blocked.stdout, /LINUX GATE BLOCKED/);
  assert.doesNotMatch(blocked.stdout, /RUN sidecar|LINUX GATE PASS/);
  const negative = run(true);
  assert.equal(negative.status, 1, negative.stderr + negative.stdout);
  assert.match(negative.stdout, /STAGE clippy-core EXIT=42/);
  assert.match(negative.stdout, /STAGE desktop-build EXIT=0/);
  assert.match(negative.stdout, /LINUX GATE FAIL .*failed: 2/);
  assert.doesNotMatch(negative.stdout, /LINUX GATE PASS/);
  console.log('PASS: Linux runner retains failure, continues stages, and distinguishes tool stubs from product proof.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

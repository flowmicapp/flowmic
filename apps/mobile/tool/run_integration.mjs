#!/usr/bin/env node
// WP-R3-1 integration harness: spawn server-core (standalone, ephemeral port,
// default settings route zh → LAN funasr), then run the mobile PTT full-chain
// integration test against it, then tear the server down.
//
// Usage: node apps/mobile/tool/run_integration.mjs
// Requires: server-core built (pnpm -C apps/server-core build) and the LAN
// funasr endpoint reachable (default stt.routings preset lan-funasr-ws).

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const ROOT = join(MOBILE, '..', '..');
const SERVER = join(ROOT, 'apps', 'server-core');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER,
      env: {
        ...process.env,
        FLOWMIC_MODE: 'standalone',
        FLOWMIC_PORT: '0',
        FLOWMIC_SETTINGS_SECRET: 'integration-secret-32-bytes-minimum',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(`[server] ${d}`);
      const m = /"port":(\d+)/.exec(out) || /^(\d+)/.exec(out.trim());
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
    setTimeout(() => reject(new Error('server start timeout')), 10000);
  });
}

async function main() {
  const { child, port } = await startServer();
  const url = `http://localhost:${port}`;
  console.log(`[harness] server up ${url}`);
  const code = await new Promise((resolve) => {
    const t = spawn(
      'flutter',
      ['test', 'test/integration_ptt_full_chain_test.dart'],
      { cwd: MOBILE, shell: true, stdio: 'inherit', env: { ...process.env, FLOWMIC_TEST_URL: url } },
    );
    t.on('exit', resolve);
  });
  child.kill();
  process.exit(code ?? 1);
}

main().catch((e) => {
  console.error('[harness] ERROR', e);
  process.exit(1);
});

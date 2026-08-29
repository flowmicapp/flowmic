// scripts/loadtest/lib/local-server.mjs
//
// Boots a LOCAL @flowmic/server-core instance for the load harness to hammer.
//
// This deliberately REUSES the boot precedent in verify/golden/harness.mjs
// (`startServer`) instead of inventing a second "how to start the server" —
// that file's own header explains why a second copy of a wire/boot helper is
// this repo's #1 bug shape aimed at its own harness, and that argument applies
// here just as much as it does inside verify/golden. The only things this
// module adds are (a) making sure the dist the golden harness spawns actually
// exists before spawning it, and (b) a thin readiness/shutdown wrapper sized
// for a load run instead of a single golden path.
//
// standalone mode, FLOWMIC_PORT=0 (OS-assigned free port) — this is also how
// the "always loopback by default" rule is enforced structurally: nothing here
// ever reads a --host flag to decide what to spawn, so a self-spawned server
// can only ever be reached at 127.0.0.1.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, SERVER_CORE, SERVER_DIST, run } from '../../../verify/golden/harness.mjs';

export { ROOT, SERVER_CORE, SERVER_DIST };

/** Builds @flowmic/protocol then @flowmic/server-core iff SERVER_DIST is
 *  missing. Mirrors verify/golden/run-golden.mjs's "always build" comment on
 *  WHY it does not do that here: a load run is not a correctness gate, it is
 *  expensive on purpose (it is about to spin up hundreds of sockets), and
 *  re-running a ~10s build on every invocation of a tool an operator may run
 *  repeatedly while tuning --clients is a cost with no matching benefit here.
 *  If you just edited server-core, rebuild it yourself first — the golden
 *  suite is what enforces freshness as a CORRECTNESS property; this tool
 *  enforces it only as an EXISTENCE property (dist must be there at all). */
export async function ensureServerBuilt({ log = console.log } = {}) {
  if (existsSync(SERVER_DIST)) return;
  log('[loadtest] apps/server-core/dist/index.js is missing — building @flowmic/protocol + @flowmic/server-core once …');
  for (const pkg of ['@flowmic/protocol', '@flowmic/server-core']) {
    const { code, out } = await run('pnpm', ['--filter', pkg, 'build']);
    if (code !== 0) {
      throw new Error(`[loadtest] build failed for ${pkg} (exit ${code}):\n${out}`);
    }
  }
  if (!existsSync(SERVER_DIST)) {
    throw new Error(`[loadtest] build finished but ${SERVER_DIST} still does not exist`);
  }
}

/** Spawn a standalone server-core instance on a random loopback port.
 *
 *  `extraEnv` is spread last so a caller can add to (never override the mode/
 *  port contract) the environment — e.g. FLOWMIC_LOADTEST_ENGINE_OFF, which
 *  this tool does not currently use (the "off" engine mode is driven over the
 *  wire via settings:update, see lib/phone-client.mjs) but is left as a seam
 *  for an operator who wants to boot the server pre-configured instead. */
export function spawnLocalServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_CORE,
      env: {
        ...process.env,
        FLOWMIC_MODE: 'standalone',
        FLOWMIC_PORT: '0',
        FLOWMIC_SETTINGS_SECRET: 'loadtest-settings-secret-32-bytes-min-xx',
        ...extraEnv,
      },
    });
    let out = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m && !settled) {
        settled = true;
        resolve({ child, port: Number(m[1]), url: `http://127.0.0.1:${Number(m[1])}` });
      }
    });
    child.stderr.on('data', () => { /* server's structured log; the caller can tee stderr itself if it wants it */ });
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`server exited before it reported a port (code ${code})`)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('server start timeout (8s)')); }
    }, 8000);
  });
}

export function stopLocalServer(server) {
  if (!server) return;
  try { server.child.kill(); } catch { /* already gone */ }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOADTEST_ROOT = path.resolve(HERE, '..');

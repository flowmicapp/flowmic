// owner 2026-07-27 P0 — LOGGING KILLED THE SERVER.
//
// The desktop can be force-killed; its sidecar survives, and a later desktop
// ADOPTS that orphan ("already attached to the existing local service"). The orphan's stderr pipe has no
// reader left, so the first burst of logging — which is exactly what SPEAKING
// produces — hit EPIPE, and an unhandled stdio error takes the whole Node
// process down. Reproduced on the tablet: connect fine, hold PTT ~12 s, the
// server pid is GONE, the port is free, and both ends report "connection lost".
//
// Pinned here: a write that cannot land is never fatal, and the lines have a
// home that outlives the pipe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

async function freshLog(logPath: string | undefined): Promise<typeof import('../src/log')> {
  // FLOWMIC_LOG_PATH is read once at module load (it cannot change under a
  // running server), so each case needs a fresh module instance.
  if (logPath === undefined) delete process.env.FLOWMIC_LOG_PATH;
  else process.env.FLOWMIC_LOG_PATH = logPath;
  vi.resetModules();
  return import('../src/log');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flowmic-log-')); });
afterEach(() => {
  delete process.env.FLOWMIC_LOG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('the server log survives what used to kill the server', () => {
  it('installs stdio error guards — an unhandled EPIPE here is a dead process', async () => {
    await freshLog(undefined);
    // This listener IS the fix: without one, Node turns the async EPIPE on a
    // dangling pipe into an uncaught exception.
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0);
  });

  it('writes every level to the durable file when FLOWMIC_LOG_PATH is set', async () => {
    const path = join(dir, 'nested', 'server.log'); // parent does not exist yet
    const m = await freshLog(path);
    m.initLogFile();
    m.log.info('server listening', { port: 41879 });
    m.log.warn('stt.polish skipped', { reason: 'empty-input' });
    m.log.error('boom');

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('INFO server listening {"port":41879}');
    expect(text).toContain('WARN stt.polish skipped {"reason":"empty-input"}');
    expect(text).toContain('ERROR boom');
  });

  it('no FLOWMIC_LOG_PATH → file logging is simply off, never an error', async () => {
    const m = await freshLog(undefined);
    expect(() => { m.initLogFile(); m.log.info('nothing to see'); }).not.toThrow();
  });

  it('an unwritable sink degrades instead of throwing', async () => {
    // A directory where a file is expected: appendFileSync throws EISDIR. The
    // old code had no catch anywhere on this path.
    const m = await freshLog(dir);
    m.initLogFile();
    expect(() => m.log.error('the log itself is broken')).not.toThrow();
  });

  it('rolls over at the cap instead of growing without bound', async () => {
    const path = join(dir, 'server.log');
    writeFileSync(path, 'x'.repeat(4 * 1024 * 1024 + 1)); // already over
    const m = await freshLog(path);
    m.initLogFile(); // carries the existing size forward
    m.log.info('the line that trips the rollover');

    expect(statSync(`${path}.1`).size).toBe(4 * 1024 * 1024 + 1);
    expect(readFileSync(path, 'utf8')).toContain('the line that trips the rollover');
  });
});

// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §4 (/api/health)
//   apps/server-core/src/http/router.ts  (HttpDeps.dbProbe / HttpDeps.pairing)
//   apps/server-core/src/bootstrap.ts    (the two production wirings under test)
//   CLAUDE.md anti-façade ①③: a DI default nobody passes the real thing to is the
//     repo's #1 historical bug class; green unit tests prove NOTHING about wiring
//
// 0.3.0 D3 + D6 — THE WIRING, not the seam.
//
// Both cards added a dep to `HttpDeps`, and both deps are optional with an
// honest absent-behaviour. That is precisely the shape that ships as a façade:
// `test/http-access-control.test.ts` proves the ROUTER does the right thing when
// handed a probe / a registry, and it would keep proving that forever if
// bootstrap never handed it either one. Nothing there can see the difference.
//
// So this file boots the REAL server through `startServer` and asks the two
// questions only a real boot can answer:
//   · D3 — does `/api/health` actually carry a `db` verdict in production shape,
//     and does a DEAD database actually turn it into a 503? (Both halves: a test
//     that only sees `db:'ok'` cannot tell a real probe from a hard-coded key.)
//   · D6 — does a real pairing token actually resolve on the diag upload, i.e.
//     did bootstrap hand the route the ONE registry this process has?
//
// Standalone is used for both because it is the mode where every dep involved is
// present at once; the saas-specific half (requireVerified) is pinned at the router
// level in http-access-control.test.ts, which does not need a real DB.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { diagLogPathBeside } from '../src/http/diag-routes';

const SECRET = 'health-db-probe-wiring-secret-32-bytes';

let server: BootstrapHandle | null = null;
let dir: string | null = null;
let savedLogPath: string | undefined;

afterEach(async () => {
  if (server) {
    // The dead-DB case closes the handle itself; bootstrap's own db.close() then
    // throws, which is correct behaviour and not what this file measures.
    await server.close().catch(() => undefined);
    server = null;
  }
  if (savedLogPath === undefined) delete process.env.FLOWMIC_LOG_PATH;
  else process.env.FLOWMIC_LOG_PATH = savedLogPath;
  savedLogPath = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

async function standalone(withLogSink = false): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-health-wiring-'));
  savedLogPath = process.env.FLOWMIC_LOG_PATH;
  // The diag sink is an env-gated mount (bootstrap.ts) — set BEFORE startServer
  // or the route legitimately answers DIAG_NO_SINK and the D6 case below would
  // be measuring the wrong refusal.
  if (withLogSink) process.env.FLOWMIC_LOG_PATH = join(dir, 'server.log');
  else delete process.env.FLOWMIC_LOG_PATH;
  const config = loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: join(dir, 'flowmic.sqlite') });
  server = await startServer(config);
  return `http://127.0.0.1:${server.port}`;
}

describe('D3 — /api/health carries a REAL database verdict on a real server', () => {
  it('a live server answers 200 with db:"ok", every pre-D3 key intact', async () => {
    const url = await standalone();
    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    // 🔴 The point of this line: `db` is absent unless bootstrap passed a probe.
    // Delete `dbProbe:` from bootstrap.ts and this assertion is the one that
    // goes red — the router tests stay green, which is exactly why this file
    // exists.
    expect(body.db, 'no db key ⇒ bootstrap never wired dbProbe (the D3 façade shape)').toBe('ok');
    expect(body).toMatchObject({ ok: true, mode: 'standalone' });
    expect(typeof body.version, 'the keys older readers parse must survive').toBe('string');
    expect('script' in body, 'the adopt probe’s field is never removed').toBe(true);
  });

  it('a DEAD database turns the same route into 503 {ok:false, db:"error"} — the probe is a measurement, not a constant', async () => {
    const url = await standalone();
    // Kill the database UNDER the running http server: the socket layer is
    // untouched, so a route that only proves 「node:http is still accepting」
    // would still answer 200 here. That is the pre-D3 behaviour this asserts is
    // gone.
    server!.db.close();
    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, db: 'error', mode: 'standalone' });
    // The 503 body still names the build: the ops preflight curls and the saas
    // console read `version`, and an unhealthy server is exactly when "which version"
    // matters most.
    expect(typeof body.version).toBe('string');
  });
});

describe('D6 — the diag upload gets the process’s real pairing registry from bootstrap', () => {
  it('a token that a real pairing row owns is judged authenticated, and the line lands as [phone]', async () => {
    const url = await standalone(true);
    const db = server!.db;
    // A real pairing, written through the same repos the pair flow writes: the
    // token under test is a row in `mobile_pairings`, not a fixture the route
    // was handed.
    db.pcs.insert({
      id: 'pc-wiring', user_id: 'default', device_name: 'PC', device_token: 'pc-token-wiring',
      room_uuid: 'room-wiring', short_code: '4321',
    });
    db.mobiles.insert({
      id: 'pair-wiring', user_id: 'default', pc_device_id: 'pc-wiring', mobile_token: 'fm_wiring_token',
    });

    const res = await fetch(`${url}/api/diag/mobile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fm_wiring_token' },
      body: JSON.stringify({ device: 'PLA-AL10', lines: ['edge: connected'] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    // 🔴 Remove `pairing: registry` from bootstrap.ts and this flips to false:
    // the route still answers 200 and still writes a block, it just calls the
    // owner's own phone UNVERIFIED forever. A 200-only assertion would not see
    // it.
    expect(body.authenticated, 'authenticated:false ⇒ bootstrap never wired the pairing registry').toBe(true);
    // IT-15: bootstrap wires diagLogPathBeside(FLOWMIC_LOG_PATH), not the ops
    // file itself. Assert the response path AND the sibling on disk — a test
    // that only read FLOWMIC_LOG_PATH would green against the pre-IT-15 wiring.
    const diagPath = diagLogPathBeside(process.env.FLOWMIC_LOG_PATH!);
    expect(body.written_to).toBe(diagPath);
    const written = readFileSync(diagPath, 'utf8');
    expect(written).toContain('origin=pairing:pair-wiring');
    expect(written).toContain('[phone] edge: connected');
    expect(
      existsSync(process.env.FLOWMIC_LOG_PATH!) ? readFileSync(process.env.FLOWMIC_LOG_PATH!, 'utf8') : '',
      'phone diagnostics must not land in the ops log',
    ).not.toContain('[phone] edge: connected');
  });

  it('the counter-case: a token no pairing owns is marked UNVERIFIED on the LAN leg (accepted, never impersonated)', async () => {
    const url = await standalone(true);
    const res = await fetch(`${url}/api/diag/mobile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fm_not_a_real_token' },
      body: JSON.stringify({ device: 'PLA-AL10', lines: ['edge: connected'] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(false);
    // Without this half the test above would pass against a registry that says
    // 「yes」 to everything.
    const diagPath = diagLogPathBeside(process.env.FLOWMIC_LOG_PATH!);
    expect(readFileSync(diagPath, 'utf8')).toContain('[phone-unverified] edge: connected');
  });
});

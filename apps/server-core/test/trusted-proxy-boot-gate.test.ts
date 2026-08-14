// fix-010 — the saas requirement for FLOWMIC_TRUSTED_PROXIES
// (config.ts, beside the FLOWMIC_JWT_SECRET and FLOWMIC_DB_PATH requirements).
//
// WHAT IS BEING PINNED, and why each half is here:
//
//   FORWARD — a saas deployment that never says what is in front of it must
//   REFUSE TO START. Behind nginx the direct peer of every public request is
//   127.0.0.1, and with an empty trust list `clientIpFrom` answers with that
//   peer, so every per-IP limiter in the product (register, login, password
//   reset, pairing) collapses into ONE bucket. Before this requirement such a
//   deploy booted completely clean — nothing anywhere reported it.
//
//   REVERSE CONTROL — a saas deployment that HAS declared its posture must start
//   and serve. This is the half that carries the proof: a requirement that
//   refused unconditionally would satisfy every forward assertion above and be
//   indistinguishable from a correct one. So the reverse cases do not merely
//   assert 「did not throw」 — they ask the running server a question over HTTP.
//
//   THE PRODUCTION SHAPE has its own test. index.ts calls `loadConfig(parseArgv(…))`,
//   and parseArgv only ever produces mode/port/dbPath — so a real deployment
//   passes NO `trustedProxies` override and can satisfy the requirement only
//   through the env. That is the case the card exists for, and it is asserted
//   through the env alone rather than through a hand-built overrides object.
//
//   standalone must be untouched in both directions. It is the desktop sidecar:
//   no proxy in front of it, its direct peer IS the client, and a check that
//   broke it would be worse than the bug.
//
// ⚠️ `trustedProxies: []` is a DECLARATION, not an exemption — 「nothing is in
// front of me」, which is the honest and correct answer for an in-process test
// server. What the requirement refuses is SILENCE. The distinction is load-
// bearing enough to be pinned directly: see 「declared [] is accepted while
// undefined is not」 below.
//
// *** HUMAN-AUDIT SENSITIVE (access control / rate-limit identity) ***

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS } from '../src/auth/register-rate-limit';
import { PAIR_IP_MAX_FAILURES } from '../src/room/pair-rate-limit';
import { TRUSTED_PROXIES_ENV } from '../src/http/trusted-proxy';

const SECRET = 'boot-gate-secret-32-bytes-minimum-xxxx';
const TOUCHED_ENV = [TRUSTED_PROXIES_ENV, 'FLOWMIC_MODE', 'FLOWMIC_JWT_SECRET', 'FLOWMIC_DB_PATH'] as const;

let server: BootstrapHandle | null = null;
let envBefore: Record<string, string | undefined> = {};

beforeEach(() => {
  // Snapshot/restore rather than delete: these are process-global, and a sibling
  // file sharing this worker must not inherit whatever this one last set.
  envBefore = Object.fromEntries(TOUCHED_ENV.map((k) => [k, process.env[k]]));
});

afterEach(async () => {
  for (const k of TOUCHED_ENV) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
  if (server) await server.close();
  server = null;
});

/** saas overrides that satisfy the two SIBLING requirements (secret, db path) so
 *  that whatever this file asserts is about the proxy posture and nothing else. */
function saasOverrides(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, ...extra };
}

/** The refusal is synchronous now — it happens while the config is resolved,
 *  before any server object exists. Fails loudly if the call SUCCEEDS, rather
 *  than returning '' (which would quietly satisfy a `toContain` on nothing). */
function refusalMessage(load: () => unknown): string {
  try {
    load();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('loadConfig resolved — it was expected to refuse');
}

describe('fix-010 forward case — saas with an undeclared proxy posture refuses', () => {
  it('🔴 THE PRODUCTION SHAPE: env-only saas, no overrides at all ⇒ refuses', () => {
    // Exactly what `node dist/index.js` does: mode/secret/db from the
    // environment, no overrides object in reach, and nobody having said a word
    // about proxies. This is the deploy the card exists to stop.
    delete process.env[TRUSTED_PROXIES_ENV];
    process.env.FLOWMIC_MODE = 'saas';
    process.env.FLOWMIC_JWT_SECRET = SECRET;
    process.env.FLOWMIC_DB_PATH = ':memory:';
    const msg = refusalMessage(() => loadConfig());
    expect(msg).toContain(`config: saas mode requires ${TRUSTED_PROXIES_ENV}`);
  });

  it('refuses when the variable is unset (overrides shape)', () => {
    delete process.env[TRUSTED_PROXIES_ENV];
    const msg = refusalMessage(() => loadConfig(saasOverrides()));
    expect(msg).toContain(`config: saas mode requires ${TRUSTED_PROXIES_ENV}`);
  });

  it('the message names the CONSEQUENCE, not just the setting', () => {
    delete process.env[TRUSTED_PROXIES_ENV];
    const msg = refusalMessage(() => loadConfig(saasOverrides()));

    // 「every per-IP limiter keys on the nginx peer」 — the mechanism, named.
    expect(msg).toContain('ONE bucket');
    expect(msg).toContain('127.0.0.1');
    expect(msg).toContain('X-Forwarded-For');
    expect(msg).toContain('clientIpFrom');
    // …and the four surfaces that collapse into it.
    expect(msg).toContain('registration, login, password reset and mobile pairing');

    // The blast radius, in numbers DERIVED from the limiters themselves — so a
    // future tuning of the real constants moves the message and this assertion
    // together instead of leaving a stale number in an operator-facing string.
    expect(msg).toContain(`About ${REGISTER_MAX_ATTEMPTS + 1} requests`);
    expect(msg).toContain(`for ${Math.round(REGISTER_WINDOW_MS / 60_000)} minutes`);
    expect(msg).toContain(`about ${PAIR_IP_MAX_FAILURES} wrong pairing codes`);
    expect(msg).toContain('EVERY user');

    // And what to actually set.
    expect(msg).toContain(`${TRUSTED_PROXIES_ENV}=127.0.0.1,::1`);
  });

  it('the message carries the append-style deployment contract', () => {
    delete process.env[TRUSTED_PROXIES_ENV];
    const msg = refusalMessage(() => loadConfig(saasOverrides()));
    expect(msg).toContain('DEPLOYMENT CONTRACT');
    expect(msg).toContain('$proxy_add_x_forwarded_for');
    expect(msg).toContain('pass-through');
    // 🔴 It must NOT imply that a pass-through regression is detected here. This
    // requirement checks configuration; it does not probe the proxy, and saying
    // so is the difference between a contract and a false claim of coverage.
    expect(msg).toContain('Nothing here detects such a regression');
  });

  it('🔴 follows the PARSED list, not the presence of the variable', () => {
    // Set, non-empty, and trusts nobody: hostnames are not literal IPs, so the
    // parse drops them. 「Is the variable present」 is the wrong question — this
    // deployment has exactly the same collapsed-bucket behaviour as an unset one.
    process.env[TRUSTED_PROXIES_ENV] = 'nginx.internal, not-an-ip';
    const msg = refusalMessage(() => loadConfig(saasOverrides()));
    expect(msg).toContain(`config: saas mode requires ${TRUSTED_PROXIES_ENV}`);
  });

  it('refuses at CONFIG RESOLUTION — no server is ever constructed', () => {
    // Placement control. The requirement sits with its two siblings in config.ts
    // rather than in bootstrap.ts, so 「what does saas require」 has one answer in
    // one file; the observable consequence is that the throw arrives before a
    // ServerConfig exists to hand to startServer at all.
    delete process.env[TRUSTED_PROXIES_ENV];
    expect(() => loadConfig(saasOverrides())).toThrow(/saas mode requires/);
  });
});

describe('fix-010 REVERSE CONTROL — a declared saas deployment still starts', () => {
  it('🔴 saas + a configured trust list starts AND serves', async () => {
    // Without this test, a requirement that threw unconditionally would pass
    // every forward assertion above.
    process.env[TRUSTED_PROXIES_ENV] = '127.0.0.1,::1';
    server = await startServer(loadConfig(saasOverrides()));
    expect(server.port).toBeGreaterThan(0);

    // Not 「it did not throw」 — the server is asked a question over HTTP, so a
    // handle that resolved without ever listening cannot pass.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('🔴 a DECLARED empty list is accepted while silence is not — same env, opposite outcomes', async () => {
    // The distinction the whole design rests on, asserted as one pair so it
    // cannot rot by halves: identical environment (nothing set), the ONLY
    // difference being whether the caller stated its posture.
    delete process.env[TRUSTED_PROXIES_ENV];
    expect(() => loadConfig(saasOverrides())).toThrow(/saas mode requires/);

    server = await startServer(loadConfig(saasOverrides({ trustedProxies: [] })));
    expect(server.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('a single trusted proxy is enough — the requirement asks 「any」, not 「both families」', async () => {
    process.env[TRUSTED_PROXIES_ENV] = '127.0.0.1';
    server = await startServer(loadConfig(saasOverrides()));
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('fix-010 — standalone is completely unaffected', () => {
  it('standalone + unset starts AND serves (the sidecar has no proxy in front of it)', async () => {
    delete process.env[TRUSTED_PROXIES_ENV];
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    expect(server.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('standalone + an unparseable value starts too — the requirement never runs there', async () => {
    process.env[TRUSTED_PROXIES_ENV] = 'nginx.internal';
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    expect(server.port).toBeGreaterThan(0);
  });
});

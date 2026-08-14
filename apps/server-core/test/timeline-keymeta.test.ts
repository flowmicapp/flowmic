// Card SALT-1 — GET/PUT /api/timeline/keymeta (per-account blind-store key
// metadata: Argon2id KDF salt + passphrase-verification sentinel), design
// docs/strategy/2026-08-11-design-e-multidevice-salt.md §3.1.
//
// Most cases run against a REAL in-process saas server (startServer, bootstrap
// wiring included), because the mounting decision and the Bearer seam live in
// the wiring — a hand-built router would only prove this test agrees with
// itself. The one hand-built router below exists to wire a MISTAKE on purpose
// (keymeta deps present in standalone) that bootstrap can never produce.
//
// 🔴 REVERSE CONTROL (run red once, then reverted): putFirstWriter's conflict
// branch was deliberately weakened to last-writer-wins (an UPDATE of
// salt_b64/sentinel + `return 'created'` where `return 'conflict'` stands),
// i.e. the exact bug this card exists to forbid. Red output, verbatim except
// that the two `❯ <file>:<line>:<col>` pointer lines are elided (coordinate
// citations rot; the failing assertions are named by symbol instead —
// coordinate-anchors lint, symbol-only escape hatch):
//
//   FAIL  test/timeline-keymeta.test.ts > keymeta: PUT first-writer-wins
//     three-state > first write 201 · identical replay 200 · differing write
//     409 and the row is unchanged
//   AssertionError: expected 201 to be 409 // Object.is equality
//   - Expected  409
//   + Received  201
//        (the `expect(clash1.status).toBe(409)` assertion below)
//
//   FAIL  test/timeline-keymeta.test.ts > keymeta: repo (unit, over a real
//     migrated :memory: DB) > three states: created → identical → conflict,
//     and the row keeps the first writer's bytes
//   AssertionError: expected 'created' to be 'conflict' // Object.is equality
//        (the first `.toBe('conflict')` assertion on repo.putFirstWriter)
//
//   Tests  2 failed | 19 passed (21)
//
// Both altitudes bit — the HTTP status AND the repo outcome — and the
// follow-up row assertions would have caught a 「refused on the wire, wrote
// anyway」 half-fix besides. Weakening removed, suite green again; residue
// grep for the drill marker = 0.
//
// *** HUMAN-AUDIT SENSITIVE (crypto-adjacent: key metadata) ***

import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ERROR_CODES, TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { resetPlanLimits } from '../src/billing/plans';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId, type AccountVerifier } from '../src/http/account-auth';
import {
  KEYMETA_CONFLICT,
  KEYMETA_INVALID,
  KEYMETA_NOT_FOUND,
  TIMELINE_KEYMETA_PATH,
} from '../src/http/timeline-keymeta-routes';
import {
  keymetaInvalidReason,
  makeTimelineKeymetaRepo,
} from '../src/db/repos/timeline-keymeta.repo';

const SECRET = 'keymeta-deploy-secret-32-bytes-min-x';

/** 16 raw bytes → canonical standard base64 (24 chars, '==' padding). */
const SALT_16 = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
/** A second, different-but-equally-valid salt for the conflict case. */
const SALT_16_B = Buffer.from('fedcba9876543210', 'utf8').toString('base64');
const SENTINEL = `${TIMELINE_E2E_PREFIX}sentinel-ciphertext-bytes`;
const SENTINEL_B = `${TIMELINE_E2E_PREFIX}a-DIFFERENT-ciphertext`;

let server: BootstrapHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

async function saasServer(): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  server = await startServer(loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] }));
  return `http://127.0.0.1:${server.port}`;
}
async function standaloneServer(): Promise<string> {
  server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
  return `http://127.0.0.1:${server.port}`;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function registerUser(url: string, email: string): Promise<string> {
  const r = await call('POST', `${url}/api/register`, { email, password: 'longenough1', display_name: 'K' });
  return r.json.token as string;
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('keymeta: PUT first-writer-wins three-state', () => {
  it('first write 201 · identical replay 200 · differing write 409 and the row is unchanged', async () => {
    const url = await saasServer();
    const token = await registerUser(url, 'three-state@k.co');
    const path = `${url}${TIMELINE_KEYMETA_PATH}`;

    // ① no row → write, 201.
    const first = await call('PUT', path, { salt_b64: SALT_16, sentinel: SENTINEL }, bearer(token));
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ ok: true, outcome: 'created' });

    // ② byte-identical replay → 200, idempotent.
    const replay = await call('PUT', path, { salt_b64: SALT_16, sentinel: SENTINEL }, bearer(token));
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true, outcome: 'identical' });

    // ③ differing sentinel → 409 by name; differing salt → 409 by name.
    const clash1 = await call('PUT', path, { salt_b64: SALT_16, sentinel: SENTINEL_B }, bearer(token));
    expect(clash1.status).toBe(409);
    expect(clash1.json.error).toBe(KEYMETA_CONFLICT);
    const clash2 = await call('PUT', path, { salt_b64: SALT_16_B, sentinel: SENTINEL }, bearer(token));
    expect(clash2.status).toBe(409);
    expect(clash2.json.error).toBe(KEYMETA_CONFLICT);

    // …and the row still carries the FIRST writer's exact bytes. This is the
    // assertion that catches a 「refused on the wire, overwrote in the store」
    // half-fix, which the status codes alone would let through.
    const after = await call('GET', path, undefined, bearer(token));
    expect(after.status).toBe(200);
    expect(after.json).toEqual({ salt_b64: SALT_16, sentinel: SENTINEL, schema_ver: 1 });
  });
});

describe('keymeta: GET', () => {
  it('absent → 404 KEYMETA_NOT_FOUND (a named 「not yet enrolled」, not an empty 200)', async () => {
    const url = await saasServer();
    const token = await registerUser(url, 'absent@k.co');
    const r = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(token));
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ ok: false, error: KEYMETA_NOT_FOUND });
  });

  it('present → the exact stored bytes, and NOTHING else on the wire', async () => {
    const url = await saasServer();
    const token = await registerUser(url, 'present@k.co');
    await call('PUT', `${url}${TIMELINE_KEYMETA_PATH}`, { salt_b64: SALT_16, sentinel: SENTINEL }, bearer(token));
    const r = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(token));
    expect(r.status).toBe(200);
    // toEqual on the WHOLE body: no created_at, no user_id, no surprise keys.
    expect(r.json).toEqual({ salt_b64: SALT_16, sentinel: SENTINEL, schema_ver: 1 });
  });

  it('two accounts are two rows — one user\'s enrolment never shows on another\'s GET', async () => {
    const url = await saasServer();
    const tokenA = await registerUser(url, 'a@k.co');
    const tokenB = await registerUser(url, 'b@k.co');
    await call('PUT', `${url}${TIMELINE_KEYMETA_PATH}`, { salt_b64: SALT_16, sentinel: SENTINEL }, bearer(tokenA));
    const a = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(tokenA));
    expect(a.status).toBe(200);
    const b = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(tokenB));
    expect(b.status).toBe(404);
    expect(b.json.error).toBe(KEYMETA_NOT_FOUND);
  });
});

describe('keymeta: auth — a named 401 for both verbs, nothing else happens', () => {
  it('anonymous GET → 401 AUTH_TOKEN_INVALID', async () => {
    const url = await saasServer();
    const r = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });

  it('anonymous PUT → 401, and a garbage Bearer is refused the same way', async () => {
    const url = await saasServer();
    const anon = await call('PUT', `${url}${TIMELINE_KEYMETA_PATH}`, { salt_b64: SALT_16, sentinel: SENTINEL });
    expect(anon.status).toBe(401);
    expect(anon.json).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    const forged = await call(
      'PUT',
      `${url}${TIMELINE_KEYMETA_PATH}`,
      { salt_b64: SALT_16, sentinel: SENTINEL },
      bearer('not-a-jwt'),
    );
    expect(forged.status).toBe(401);
    expect(forged.json).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });
});

describe('keymeta: standalone mounts NEITHER verb (saas-only, the reverse of the image inject route)', () => {
  it('GET and PUT both answer the router\'s plain 404 on a real standalone server', async () => {
    const url = await standaloneServer();
    const g = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`);
    expect(g.status).toBe(404);
    // The router's not-mounted 404, NOT the route's own row-absent 404 — the
    // two must stay distinguishable (「this deployment has no such surface」 vs
    // 「you have not enrolled yet」).
    expect(g.json?.error).not.toBe(KEYMETA_NOT_FOUND);
    const p = await call('PUT', `${url}${TIMELINE_KEYMETA_PATH}`, { salt_b64: SALT_16, sentinel: SENTINEL });
    expect(p.status).toBe(404);
    expect(p.json?.error).not.toBe(KEYMETA_CONFLICT);
  });

  it('🔴 refuses even when the deps ARE present, if the config says standalone (mis-wired bootstrap)', () => {
    // Simulates a bootstrap that wired `keymeta` where it should not have —
    // the case that makes router.ts's own `config.mode === 'saas'` test
    // load-bearing rather than decorative (the paddle mount pins the same
    // property for its route). The verifier THROWS if consulted: in standalone
    // the mode gate must short-circuit before anyone judges a Bearer.
    resetPlanLimits(); // loadConfig installs a plan table as a side effect
    const cfg = loadConfig({ mode: 'standalone', secret: SECRET });
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET) });
    const mustNotBeConsulted: AccountVerifier = {
      verifyToken: () => { throw new Error('verifier consulted on the standalone path'); },
      getUser: () => { throw new Error('verifier consulted on the standalone path'); },
    } as unknown as AccountVerifier;
    const handler = makeHttpHandler({
      config: cfg,
      billing: new BillingService({
        settings: db.settings, users: db.users, usage: db.usage, billing: db.billing,
        unlockAll: false,
      }),
      version: 'test',
      resolveUserId: makeResolveUserId({ mode: cfg.mode, standaloneUserId: 'default' }),
      // The mis-wiring, deliberately:
      keymeta: { auth: mustNotBeConsulted, repo: db.timelineKeymeta },
    });
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = 'GET';
    req.url = TIMELINE_KEYMETA_PATH;
    (req as { headers: Record<string, string> }).headers = { authorization: 'Bearer whatever' };
    (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '127.0.0.1' };
    let wrote = false;
    const res = {
      writeHead() { wrote = true; return res; },
      end() { wrote = true; },
      once() { return res; },
    } as unknown as ServerResponse;
    expect(handler(req, res)).toBe(false); // unhandled → the outer server's 404
    expect(wrote).toBe(false);
    db.close();
  });
});

describe('keymeta: validation — a named 400, and NOTHING is stored', () => {
  /** Each case: PUT → 400 KEYMETA_INVALID, then GET → still 404 (no row). */
  const CASES: Array<[string, { salt_b64?: string; sentinel?: string }]> = [
    ['salt is not base64 at all', { salt_b64: '!!!not-base64!!', sentinel: SENTINEL }],
    ['salt decodes to 8 bytes, not 16', { salt_b64: Buffer.from('8bytes!!', 'utf8').toString('base64'), sentinel: SENTINEL }],
    ['salt decodes to 17 bytes, not 16', { salt_b64: Buffer.from('0123456789abcdefX', 'utf8').toString('base64'), sentinel: SENTINEL }],
    // Lenient decoders read this as the same 16 bytes; the canonical round-trip
    // check refuses it, so a base64url/unpadded client learns at its FIRST PUT.
    ['salt is unpadded (non-canonical) base64', { salt_b64: SALT_16.replace(/=+$/, ''), sentinel: SENTINEL }],
    // The evil twin — the server-decryptable prefix must never be accepted
    // where a blind-store value belongs (dual-prefix red line).
    ['sentinel carries enc:v1: instead of e2e:v1:', { salt_b64: SALT_16, sentinel: 'enc:v1:wrong-family' }],
    ['sentinel has no prefix at all', { salt_b64: SALT_16, sentinel: 'just-some-bytes' }],
    ['salt missing', { sentinel: SENTINEL }],
    ['sentinel missing', { salt_b64: SALT_16 }],
    ['empty body', {}],
  ];

  for (const [name, body] of CASES) {
    it(`${name} → 400 KEYMETA_INVALID, no row written`, async () => {
      const url = await saasServer();
      const token = await registerUser(url, 'invalid@k.co');
      const r = await call('PUT', `${url}${TIMELINE_KEYMETA_PATH}`, body, bearer(token));
      expect(r.status).toBe(400);
      expect(r.json.error).toBe(KEYMETA_INVALID);
      expect(typeof r.json.message).toBe('string'); // the reason travels, named
      const after = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(token));
      expect(after.status).toBe(404); // nothing invalid ever reached storage
    });
  }
});

describe('keymeta: repo (unit, over a real migrated :memory: DB)', () => {
  function world(): ReturnType<typeof createDbConnection> {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET) });
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
    return db;
  }

  it('three states: created → identical → conflict, and the row keeps the first writer\'s bytes', () => {
    const db = world();
    const repo = makeTimelineKeymetaRepo(db.raw, () => 1_754_900_000_000);
    expect(repo.get('u1')).toBeNull();
    expect(repo.putFirstWriter('u1', SALT_16, SENTINEL)).toBe('created');
    expect(repo.putFirstWriter('u1', SALT_16, SENTINEL)).toBe('identical');
    expect(repo.putFirstWriter('u1', SALT_16, SENTINEL_B)).toBe('conflict');
    expect(repo.putFirstWriter('u1', SALT_16_B, SENTINEL)).toBe('conflict');
    expect(repo.get('u1')).toEqual({
      salt_b64: SALT_16,
      sentinel: SENTINEL,
      schema_ver: 1, // the DDL's DEFAULT — the repo never restates it
      created_at: 1_754_900_000_000,
    });
    db.close();
  });

  it('the write-path backstop throws on invalid input and stores nothing', () => {
    const db = world();
    const repo = makeTimelineKeymetaRepo(db.raw);
    expect(() => repo.putFirstWriter('u1', 'bad!!', SENTINEL)).toThrow(/timeline_keymeta write rejected/);
    expect(() => repo.putFirstWriter('u1', SALT_16, 'no-prefix')).toThrow(/timeline_keymeta write rejected/);
    expect(repo.get('u1')).toBeNull();
    db.close();
  });

  it('keymetaInvalidReason: one definition, every branch named', () => {
    expect(keymetaInvalidReason(SALT_16, SENTINEL)).toBeNull();
    // The bare prefix is a LEGAL sentinel here on purpose: the server is blind
    // and judges only the family marker, never whether the ciphertext could
    // open (that judgement is exclusively the phone's — design §2).
    expect(keymetaInvalidReason(SALT_16, TIMELINE_E2E_PREFIX)).toBeNull();
    expect(keymetaInvalidReason('', SENTINEL)).toMatch(/salt_b64 required/);
    expect(keymetaInvalidReason(SALT_16, '')).toMatch(/sentinel required/);
    expect(keymetaInvalidReason('!!!', SENTINEL)).toMatch(/canonical|not valid/);
    expect(keymetaInvalidReason(SALT_16.replace(/=+$/, ''), SENTINEL)).toMatch(/canonical/);
    expect(keymetaInvalidReason(Buffer.from('8bytes!!').toString('base64'), SENTINEL)).toMatch(/exactly 16 bytes \(got 8\)/);
    expect(keymetaInvalidReason(SALT_16, 'enc:v1:wrong')).toMatch(/e2e:v1:/);
  });
});

describe('keymeta: the protocol table does not move', () => {
  it('KEYMETA_* are HTTP-local names, NOT protocol error codes (the owner-gated 64-code table is untouched)', () => {
    // Same pin mail-password-reset.test.ts holds for MAIL_*: these strings are
    // route-local diagnostics on the DIAG_*/PRESENCE_AUTH_REQUIRED precedent;
    // minting protocol codes is an owner gate this card deliberately never
    // approaches (zero new socket events, zero new codes — design §3.1).
    for (const name of [KEYMETA_NOT_FOUND, KEYMETA_CONFLICT, KEYMETA_INVALID]) {
      expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, name)).toBe(false);
    }
  });
});

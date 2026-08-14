// 0.3.0 M3 — the trusted-proxy client-IP derivation (http/trusted-proxy.ts) and
// its two consumers under test here: the per-IP limiters (register/login via
// auth-routes, password via console-routes — the socket pair/login paths reuse
// clientIpFromHandshake, unit-pinned below) and local-only.ts's localness gate.
//
// THE THREE CONTRACT POINTS (from the M3 card, each one a test):
//   (a) same direct peer + different X-Forwarded-For ⇒ SEPARATE buckets when the
//       peer is a configured trusted proxy — this is the assertion that is RED
//       without the wiring (reverse-control run recorded in the delivery report);
//   (b) X-Forwarded-For from an UNtrusted peer is IGNORED — a forged header can
//       neither escape the shared bucket nor make a request count as local;
//   (c) config unset ⇒ behaviour byte-identical to before the module existed.
//
// *** HUMAN-AUDIT SENSITIVE (access control / rate-limit identity) ***

import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import {
  clientIpFrom,
  clientIpFromHandshake,
  parseTrustedProxies,
  trustedProxiesFromEnv,
} from '../src/http/trusted-proxy';
import { isLocalRequest, LOCAL_ONLY_ERROR } from '../src/http/local-only';

const SECRET = 'trusted-proxy-secret-32-bytes-min-xxxx';
let server: BootstrapHandle | null = null;

afterEach(async () => {
  delete process.env.FLOWMIC_TRUSTED_PROXIES;
  if (server) await server.close();
  server = null;
});

async function saasServer(): Promise<{ url: string; handle: BootstrapHandle }> {
  // No mockBilling: saas + mock gateway refuses to serve since 0.3.0 M5
  // (router.assertMockBillingMountable), and nothing here needs it.
  // fix-010 — the declared proxy posture of THIS process: an in-process test
  // server has nothing in front of it, so its direct peer IS the client. That is
  // the honest declaration, and saas now refuses to resolve a config without one
  // (config.ts, beside the JWT-secret and DB-path requirements).
  //
  // 🔴 It does NOT decide who is trusted at request time, and that separation is
  // what keeps the tests below meaningful: the per-request derivation reads
  // FLOWMIC_TRUSTED_PROXIES through trustedProxiesFromEnv(), so the env each test
  // sets (or deliberately leaves unset, as case (c) does) is still exactly what
  // clientIpFrom follows. Declaring `[]` here would otherwise have silently
  // turned 「config unset ⇒ shared bucket」 into an assertion about nothing.
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config);
  return { url: `http://127.0.0.1:${server.port}`, handle: server };
}
async function standaloneServer(): Promise<string> {
  server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
  return `http://127.0.0.1:${server.port}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** A fake req is enough for the pure gate: it reads only socket.remoteAddress
 *  and headers. */
function fakeReq(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe('parseTrustedProxies — safe parse of FLOWMIC_TRUSTED_PROXIES', () => {
  it('unset / empty ⇒ trust nobody (the fail-safe default)', () => {
    expect(parseTrustedProxies(undefined)).toEqual({ proxies: [], rejected: [] });
    expect(parseTrustedProxies('')).toEqual({ proxies: [], rejected: [] });
    expect(parseTrustedProxies(' , ,')).toEqual({ proxies: [], rejected: [] });
  });

  it('literal IPs are kept and normalised; junk is REJECTED, never trusted', () => {
    const parsed = parseTrustedProxies(' 127.0.0.1, ::1 , ::FFFF:10.0.0.1, nginx.local, 999.1.2.3, 10.0.0.0/8 ');
    expect(parsed.proxies).toEqual(['127.0.0.1', '::1', '10.0.0.1']);
    // Hostnames, out-of-range octets and CIDR are all dropped by design — a
    // config typo must shrink trust, never widen it.
    expect(parsed.rejected).toEqual(['nginx.local', '999.1.2.3', '10.0.0.0/8']);
  });

  it('trustedProxiesFromEnv re-reads a CHANGED env value (memo keyed on the raw string)', () => {
    delete process.env.FLOWMIC_TRUSTED_PROXIES;
    expect(trustedProxiesFromEnv()).toEqual([]);
    process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1';
    expect(trustedProxiesFromEnv()).toEqual(['127.0.0.1']);
    delete process.env.FLOWMIC_TRUSTED_PROXIES;
    expect(trustedProxiesFromEnv()).toEqual([]);
  });
});

describe('clientIpFrom — rightmost-untrusted derivation', () => {
  const TRUSTED = ['127.0.0.1', '::1', '10.9.9.9'];

  it('(c) empty trust list ⇒ the direct peer, X-Forwarded-For ignored', () => {
    expect(clientIpFrom('203.0.113.9', '198.51.100.7', [])).toBe('203.0.113.9');
  });

  it('(b) UNtrusted peer ⇒ its header is ignored — the forged-XFF pin', () => {
    expect(clientIpFrom('203.0.113.9', '198.51.100.7', TRUSTED)).toBe('203.0.113.9');
  });

  it('trusted peer + single appended hop ⇒ that hop', () => {
    expect(clientIpFrom('127.0.0.1', '198.51.100.7', TRUSTED)).toBe('198.51.100.7');
  });

  it('🔴 trusted peer + client-forged left hops ⇒ the RIGHTMOST untrusted hop wins, never the leftmost', () => {
    // The client sent 「X-Forwarded-For: 1.2.3.4」; the trusted proxy appended the
    // real TCP peer 198.51.100.7. Taking the leftmost would hand the attacker
    // their own bucket key (and 127.0.0.1 would hand them localness elsewhere).
    expect(clientIpFrom('127.0.0.1', '1.2.3.4, 198.51.100.7', TRUSTED)).toBe('198.51.100.7');
    expect(clientIpFrom('127.0.0.1', '127.0.0.1, 198.51.100.7', TRUSTED)).toBe('198.51.100.7');
  });

  it('intermediate trusted proxies are skipped (two-tier proxy chain)', () => {
    // client → edge(10.9.9.9, trusted) → nginx(127.0.0.1, trusted) → us.
    expect(clientIpFrom('127.0.0.1', '198.51.100.7, 10.9.9.9', TRUSTED)).toBe('198.51.100.7');
  });

  it('no header / all hops trusted ⇒ fall back to the peer (request born on the proxy chain)', () => {
    expect(clientIpFrom('127.0.0.1', undefined, TRUSTED)).toBe('127.0.0.1');
    expect(clientIpFrom('127.0.0.1', '10.9.9.9', TRUSTED)).toBe('127.0.0.1');
  });

  it('a malformed rightmost-untrusted hop falls back to the peer — junk must not become a Map key', () => {
    expect(clientIpFrom('127.0.0.1', 'not-an-ip', TRUSTED)).toBe('127.0.0.1');
    expect(clientIpFrom('127.0.0.1', '198.51.100.7, garbage', TRUSTED)).toBe('127.0.0.1');
  });

  it('IPv6-mapped IPv4 matches its dotted form on both the peer and the hops', () => {
    expect(clientIpFrom('::ffff:127.0.0.1', '::ffff:198.51.100.7', TRUSTED)).toBe('198.51.100.7');
  });

  it('clientIpFromHandshake derives identically from a socket.io handshake (pair/login socket limiters)', () => {
    const trusted = ['127.0.0.1'];
    // Trusted handshake peer ⇒ the appended client.
    expect(clientIpFromHandshake({ address: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.7' } }, trusted)).toBe('198.51.100.7');
    // Untrusted handshake peer ⇒ forged header ignored.
    expect(clientIpFromHandshake({ address: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }, trusted)).toBe('203.0.113.9');
    // No config ⇒ the address, unchanged.
    expect(clientIpFromHandshake({ address: '192.168.1.20', headers: {} }, [])).toBe('192.168.1.20');
  });

  it('a handshake WITHOUT a header bag falls back to the peer instead of throwing (rate-limiter path)', () => {
    // 🔴 This is not a defensive-coding nicety. clientIpFromHandshake runs inside
    // the mobile:pair / mobile:login limiter (mobile.handler.ts socketIp), so a
    // throw here aborts the handler that was about to admit or refuse a device —
    // it does not merely mis-bucket a limiter. Regression origin: the header read
    // shipped WITHOUT the optional chain while the doc comment already claimed the
    // fail-safe, and 13 presence-liveness tests died with
    // `Cannot read properties of undefined (reading 'x-forwarded-for')` —
    // a comment asserting behaviour the code did not have (anti-façade ④).
    const trusted = ['127.0.0.1'];
    expect(clientIpFromHandshake({ address: '203.0.113.9' }, trusted)).toBe('203.0.113.9');
    // Even a TRUSTED peer with no bag must answer the peer, never throw.
    expect(clientIpFromHandshake({ address: '127.0.0.1' }, trusted)).toBe('127.0.0.1');
    // A wholly absent handshake degrades to 「no evidence」, the empty deterministic bucket.
    expect(clientIpFromHandshake(undefined, trusted)).toBe('');
    expect(clientIpFromHandshake({}, trusted)).toBe('');
  });
});

describe('isLocalRequest × trusted proxy — XFF may only ever REVOKE localness', () => {
  it('(c) config unset: loopback peer stays local even with a remote XFF (unchanged behaviour)', () => {
    delete process.env.FLOWMIC_TRUSTED_PROXIES;
    expect(isLocalRequest(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(true);
  });

  it('trusted same-box proxy: a public caller now FAILS the localness gate (narrowed, the M3 point)', () => {
    process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
    expect(isLocalRequest(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    // While a genuinely local request — no proxy in between, no header — stays local.
    expect(isLocalRequest(fakeReq('127.0.0.1'))).toBe(true);
    // And a local client THROUGH the proxy (nginx appended 127.0.0.1) stays local.
    expect(isLocalRequest(fakeReq('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });

  it('🔴 (b) a forged XFF can NEVER mint localness — with or without the peer being trusted', () => {
    // Untrusted remote peer claiming to be loopback: refused (header ignored).
    delete process.env.FLOWMIC_TRUSTED_PROXIES;
    expect(isLocalRequest(fakeReq('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    // Even a TRUSTED remote peer cannot upgrade to local via the header: the raw
    // direct peer must be loopback regardless (condition ① in local-only.ts).
    process.env.FLOWMIC_TRUSTED_PROXIES = '203.0.113.9';
    expect(isLocalRequest(fakeReq('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('real server: /api/network (standalone, local-only) refuses a trusted-proxy request carrying a remote client', async () => {
    const url = await standaloneServer();
    // Without the config: loopback peer ⇒ 200 (today's behaviour, header ignored).
    const before = await fetch(`${url}/api/network`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(before.status).toBe(200);
    // With the same-box proxy trusted, the SAME request is now refused: the
    // derivation says the client is remote.
    process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
    const after = await fetch(`${url}/api/network`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toBe(LOCAL_ONLY_ERROR);
  });
});

describe('per-IP limiters behind nginx (the M3 DoS: one 5/10-min bucket for the world)', () => {
  // All requests below reach the server from the SAME direct peer (loopback —
  // exactly the shape nginx produces); only X-Forwarded-For varies.

  it('🔴 (a) trusted proxy: different XFF clients get SEPARATE password-limiter buckets', async () => {
    process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
    const { url } = await saasServer();
    const xffA = { 'x-forwarded-for': '198.51.100.1' };
    const xffB = { 'x-forwarded-for': '198.51.100.2' };
    for (let i = 0; i < 5; i++) {
      expect((await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' }, xffA)).status).toBe(200);
    }
    // Positive control: client A really is exhausted…
    const throttledA = await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' }, xffA);
    expect(throttledA.status).toBe(429);
    expect(throttledA.json.error).toBe('REGISTER_RATE_LIMITED');
    // …and the point of the card: client B — same direct peer — is NOT locked out.
    expect((await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' }, xffB)).status).toBe(200);
    // A direct (no-header) request from the proxy chain itself is a third bucket.
    expect((await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' })).status).toBe(200);
  });

  it('trusted proxy: register/login limiter (auth-routes) separates XFF clients the same way', async () => {
    process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
    const { url } = await saasServer();
    const xffA = { 'x-forwarded-for': '198.51.100.1' };
    const xffB = { 'x-forwarded-for': '198.51.100.2' };
    for (let i = 0; i < 5; i++) {
      expect((await post(`${url}/api/register`, { email: `a${i}@b.co`, password: 'longenough1' }, xffA)).status).toBe(201);
    }
    expect((await post(`${url}/api/register`, { email: 'a5@b.co', password: 'longenough1' }, xffA)).status).toBe(429);
    expect((await post(`${url}/api/register`, { email: 'b0@b.co', password: 'longenough1' }, xffB)).status).toBe(201);
  });

  it('🔴 (b) config UNSET: forged XFF cannot escape the shared bucket (reverse control)', async () => {
    const { url } = await saasServer();
    // Five attempts, each claiming a DIFFERENT client — all fold into the one
    // direct-peer bucket because nobody trusts the header.
    for (let i = 0; i < 5; i++) {
      const r = await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' }, { 'x-forwarded-for': `198.51.100.${i}` });
      expect(r.status).toBe(200);
    }
    const escapeAttempt = await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' }, { 'x-forwarded-for': '198.51.100.250' });
    expect(escapeAttempt.status).toBe(429);
    expect(escapeAttempt.json.error).toBe('REGISTER_RATE_LIMITED');
  });

  it('(c) config unset + no header: byte-identical to the old direct-peer throttle', async () => {
    const { url } = await saasServer();
    for (let i = 0; i < 5; i++) {
      expect((await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' })).status).toBe(200);
    }
    const sixth = await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' });
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toBe('REGISTER_RATE_LIMITED');
  });
});

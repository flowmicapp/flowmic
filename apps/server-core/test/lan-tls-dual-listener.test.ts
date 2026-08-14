// D2LAN-B1 — the seam, exercised end to end against a REAL server on a REAL port.
//
// 🔴 WHY THIS FILE AND NOT MORE UNIT TESTS. Everything this card is actually
// risking lives between components, not inside them: whether the desktop can
// still reach its own sidecar in plain (`sidecar/io.rs` is hand-rolled HTTP over
// a TcpStream and its header says "never TLS" — if that breaks, the desktop
// cannot talk to its own server at all), whether socket.io survives being handed
// a TLS-terminated duplex, and whether the fingerprint the server PUBLISHES is
// the fingerprint a PEER computes from the certificate it actually receives.
//
// 🔴 THE CROSS-CHECK IS THE POINT OF §「fingerprint」 BELOW. Asserting the
// published fingerprint against a stored constant, or against the same function
// that produced it, proves only that a value equals itself. Here the peer-side
// value is derived from `TLSSocket.getPeerCertificate()` — bytes that came off
// the wire — hashed independently, and only then compared with what the server
// says. Two computations, two sources, one comparison.

import { createServer as createHttpServer, get as httpGet, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createDualProtocolFront } from '../src/lan-tls/dual-listener';
import { loadOrMintLanTlsIdentity } from '../src/lan-tls/cert-store';
import { FP_BYTES } from '../src/lan-tls/fingerprint';

const SECRET = 'lan-tls-integration-secret-32-bytes-long';

const homes: string[] = [];
const servers: BootstrapHandle[] = [];

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'flowmic-lan-tls-int-'));
  homes.push(d);
  return d;
}

async function boot(lanTlsDir: string | null): Promise<BootstrapHandle> {
  const config = loadConfig({
    port: 0,
    dbPath: ':memory:',
    secret: SECRET,
    host: '127.0.0.1',
    lanTls: lanTlsDir === null ? null : { dir: lanTlsDir },
  });
  const handle = await startServer(config);
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.close();
  }
  while (homes.length > 0) {
    const h = homes.pop();
    if (h) rmSync(h, { recursive: true, force: true });
  }
});

// ── probes ──────────────────────────────────────────────────────────────────

/** Plain HTTP GET — the shape `sidecar/io.rs` speaks. */
function getPlain(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, (res: IncomingMessage) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/** HTTPS GET that trusts NOTHING — the certificate is examined by the caller. */
function getTls(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The SPKI fingerprint as a PEER computes it, from the certificate it received.
 *  Deliberately does not import `spkiFingerprint`: this side must be able to
 *  disagree with the server, or the comparison proves nothing. */
function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const der = socket.getPeerCertificate().raw;
      socket.end();
      const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
      resolve(createHash('sha256').update(spki).digest().subarray(0, FP_BYTES).toString('base64url'));
    });
    socket.on('error', reject);
  });
}

function connectSocketIo(url: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      rejectUnauthorized: false,
      timeout: 5000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

// ── the loopback regression ─────────────────────────────────────────────────

describe('loopback stays plain (design §3-2 — the desktop`s own client is never TLS)', () => {
  it('🔴 answers /api/health in PLAIN http with the TLS front installed', async () => {
    // THE regression on this card. `sidecar/io.rs` builds its request by hand on
    // a raw TcpStream and cannot speak TLS at all; if this ever fails, the
    // desktop can no longer reach the sidecar it just spawned.
    const server = await boot(tempHome());
    const res = await getPlain(server.port, '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('serves plain and TLS on ONE port — the QR carries only one', async () => {
    const server = await boot(tempHome());
    const plain = await getPlain(server.port, '/api/health');
    const secure = await getTls(server.port, '/api/health');
    expect(plain.status).toBe(200);
    expect(secure.status).toBe(200);
    expect(JSON.parse(secure.body)).toMatchObject({ ok: true });
  });

  it('accepts socket.io over ws AND over wss on that same port', async () => {
    // The transition requirement (design §4 compatibility and order): a 0.2.x phone speaks
    // `ws://` and must keep connecting, or shipping this locks out every phone in
    // the field.
    const server = await boot(tempHome());
    const plain = await connectSocketIo(`ws://127.0.0.1:${server.port}`);
    expect(plain.connected).toBe(true);
    plain.close();
    const secure = await connectSocketIo(`wss://127.0.0.1:${server.port}`);
    expect(secure.connected).toBe(true);
    secure.close();
  });

  it('behaves exactly as before when no LAN TLS home is configured', async () => {
    // The null path — every saas deployment and the whole existing test suite.
    const server = await boot(null);
    expect(server.lanTlsFingerprint).toBeNull();
    expect((await getPlain(server.port, '/api/health')).status).toBe(200);
    await expect(getTls(server.port, '/api/health')).rejects.toThrow();
  });
});

// ── the fingerprint, cross-checked ──────────────────────────────────────────

describe('the published fingerprint IS the served key', () => {
  it('🔴 peer-computed SPKI hash equals BootstrapHandle.lanTlsFingerprint', async () => {
    const server = await boot(tempHome());
    const fromWire = await peerFingerprint(server.port);
    expect(server.lanTlsFingerprint).not.toBeNull();
    expect(fromWire).toBe(server.lanTlsFingerprint);
  });

  it('🔴 survives a restart on the same home — every scanned QR stays valid', async () => {
    const home = tempHome();
    const first = await boot(home);
    const firstFp = await peerFingerprint(first.port);
    await first.close();
    servers.pop();

    const second = await boot(home);
    const secondFp = await peerFingerprint(second.port);
    expect(secondFp).toBe(firstFp);
    expect(second.lanTlsFingerprint).toBe(first.lanTlsFingerprint);
  });

  it('a DIFFERENT home is a different machine and a different fingerprint', async () => {
    // The positive control for the test above: if the fingerprint were a constant
    // (or if persistence silently did nothing), the restart test would pass for
    // the wrong reason. This is what makes that green mean something.
    const a = await boot(tempHome());
    const b = await boot(tempHome());
    expect(a.lanTlsFingerprint).not.toBe(b.lanTlsFingerprint);
    expect(await peerFingerprint(a.port)).not.toBe(await peerFingerprint(b.port));
  });
});

// ── "is THIS connection encrypted" (design §6-3) ────────────────────────────

describe('encryption is answerable per connection, from the connection', () => {
  it('req.socket.encrypted distinguishes two connections to the same server', async () => {
    // 🔴 The caveat that comes with sniffing: plain is still accepted from the
    // LAN during the transition, so no global flag can answer this. The answer
    // has to be a property of the connection itself — and it is.
    const home = tempHome();
    const identity = loadOrMintLanTlsIdentity(home);
    const seen: Array<boolean | undefined> = [];
    const httpServer = createHttpServer((req, res) => {
      seen.push((req.socket as { encrypted?: boolean }).encrypted);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const front = createDualProtocolFront({ httpServer, certPem: identity.certPem, keyPem: identity.keyPem });
    await new Promise<void>((resolve) => front.server.listen(0, '127.0.0.1', resolve));
    const address = front.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    await getPlain(port, '/probe');
    await getTls(port, '/probe');

    await front.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    homes.pop();

    // Two samples, one per direction — both measured, neither inferred.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(true); // plain: node leaves `encrypted` undefined
    expect(seen[1]).toBe(true); // TLS
  });
});

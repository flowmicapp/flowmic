// D2LAN-B2b — the transport between "the server knows the fingerprint" and "the QR prints the fingerprint".
//
// 🔴 WHY THIS FILE EXISTS AT ALL. Cards B1 and B2 both delivered COMPLETE and the
// feature was worth zero: B1 minted the certificate and published its fingerprint
// on `BootstrapHandle`, B2 taught the QR builder to carry a `fp=`, and nothing
// carried the value from one to the other. Every test on both sides was green.
// This file tests the first hop of the link — `/api/network` — and it tests it the
// only way that means anything:
//
// 🔴 THE COMPARISON IS AGAINST THE WIRE, NOT AGAINST OURSELVES. Asserting the
// route's `lan_tls_fp` against `BootstrapHandle.lanTlsFingerprint` would compare
// one variable with the same variable and pass even if the server were serving a
// completely different certificate. `peerFingerprint` below opens a real TLS
// connection, takes the certificate the server actually presents, and hashes it
// independently (the technique is borrowed verbatim from
// `test/lan-tls-dual-listener.test.ts`, which is the point: two computations, two
// sources, one comparison).

import { get as httpGet, type IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { FP_BYTES } from '../src/lan-tls/fingerprint';
import { makeHttpHandler, publishableLanTlsFingerprint } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import type { ServerResponse } from 'node:http';

const SECRET = 'lan-tls-route-integration-secret-32b';

const homes: string[] = [];
const servers: BootstrapHandle[] = [];

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'flowmic-lan-tls-route-'));
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

/** Plain HTTP GET — the shape `sidecar/io.rs` speaks (hand-rolled, never TLS). */
function getPlain(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, (res: IncomingMessage) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
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

// ── the link, cross-checked against the served certificate ──────────────────

describe('/api/network publishes the fingerprint of the key it is actually serving', () => {
  it('🔴 lan_tls_fp equals a PEER-computed hash of the presented certificate', async () => {
    const server = await boot(tempHome());
    const res = await getPlain(server.port, '/api/network');
    const body = JSON.parse(res.body) as { lan_tls_fp: string | null };

    // Independent derivation: bytes off the wire, hashed here.
    const fromWire = await peerFingerprint(server.port);

    expect(res.status).toBe(200);
    expect(body.lan_tls_fp).not.toBeNull();
    expect(body.lan_tls_fp).toBe(fromWire);
    // …and the same value the handle reports, which is the assertion that would
    // have passed on its own for the wrong reason. It is kept only BESIDE the one
    // above, never instead of it.
    expect(body.lan_tls_fp).toBe(server.lanTlsFingerprint);
  });

  it('keeps every pre-existing key (additive only — the desktop already reads them)', async () => {
    const server = await boot(tempHome());
    const body = JSON.parse((await getPlain(server.port, '/api/network')).body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['lan_ipv4', 'primary', 'candidates', 'port', 'lan_tls_fp']),
    );
    expect(Array.isArray(body.lan_ipv4)).toBe(true);
    // ⚠️ NOT asserted against `server.port`: this route reports the CONFIGURED
    // port, and this suite boots with `port: 0` (ephemeral). In production the two
    // are the same number (41879), so nothing here is broken — but the difference
    // is real and belongs in a comment rather than in an assertion that would read
    // as "this field answers the bound port" when it does not. Out of this card's scope.
    expect(typeof body.port).toBe('number');
  });

  it('🔴 serializes in the LITERAL shape the Rust reader looks for', async () => {
    // `sidecar/io.rs` (symbol `parse_lan_tls_fingerprint`) is a hand-rolled string
    // reader, not a JSON parser — same style as the two `/api/network` readers
    // beside it. It finds `"lan_tls_fp":` and takes the following quoted run. That
    // makes the SERIALIZED TEXT part of the contract, not just the parsed object,
    // so it is asserted as text here. A JSON.parse-only assertion would stay green
    // through a rename that silently broke the shell.
    const server = await boot(tempHome());
    const raw = (await getPlain(server.port, '/api/network')).body;
    expect(raw).toContain(`"lan_tls_fp":"${server.lanTlsFingerprint}"`);
  });
});

// ── the no-TLS path: today's behaviour, unchanged ───────────────────────────

describe('no certificate ⇒ no fingerprint ⇒ the QR keeps its pre-D2-LAN bytes', () => {
  it('🔴 answers lan_tls_fp:null rather than omitting the key', async () => {
    // Present-and-null vs absent matters to the reader downstream: the Rust parser
    // treats both as "absent" on purpose, but a key that is always present makes the
    // difference between "this server has TLS off" and "this server is too old to know this key"
    // visible to a human reading the body.
    const server = await boot(null);
    const body = JSON.parse((await getPlain(server.port, '/api/network')).body) as Record<string, unknown>;
    expect('lan_tls_fp' in body).toBe(true);
    expect(body.lan_tls_fp).toBeNull();
    expect(server.lanTlsFingerprint).toBeNull();
  });
});

// ── the malformed path: refused at the boundary, out loud ───────────────────

describe('a malformed fingerprint is refused where it is read', () => {
  it('🔴 publishes null and SAYS SO, rather than putting it on the QR', () => {
    // The sink is stderr (src/log.ts writes there directly, deliberately — see its
    // header on the EPIPE incident), so that is what is observed. Spying on
    // `console.error` would pass vacuously against a logger that logs nothing.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      // A truncation — the realistic corruption, and the one a length check finds.
      expect(publishableLanTlsFingerprint({ lanTlsFingerprint: () => 'oTA0pWG9421vmsx' })).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // 🔴 The refusal must be AUDIBLE. A silent null is indistinguishable from
    // "this server has TLS off", and those two need opposite responses.
    const said = written.join('');
    expect(said).toContain('malformed LAN TLS fingerprint');
    // The LENGTH identifies a truncation; the value itself is not the useful fact.
    expect(said).toContain('"length":15');
  });

  it.each([
    ['too short', 'oTA0pWG9421vmsx'],
    ['too long', 'oTA0pWG9421vmsxFi1ZoR4gsEXTRA'],
    ['a comma (would split the QR value)', 'oTA0pWG9421vmsx,i1ZoR4gs'],
    ['an ampersand (would start a new QR key)', 'oTA0pWG9421vmsx&i1ZoR4g'],
    ['whitespace', 'oTA0pWG9421vmsx i1ZoR4gs'],
    ['a base64 pad character', 'oTA0pWG9421vmsxFi1ZoR4g='],
    ['empty', ''],
  ])('refuses %s', (_name, bad) => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(publishableLanTlsFingerprint({ lanTlsFingerprint: () => bad })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a well-formed one through untouched (the positive control)', () => {
    // Without this, every assertion above would also pass against a function that
    // returned null unconditionally — i.e. against a feature that does nothing.
    const good = 'oTA0pWG9421vmsxFi1ZoR4gs';
    expect(publishableLanTlsFingerprint({ lanTlsFingerprint: () => good })).toBe(good);
  });

  it('reports null when no producer is wired at all', () => {
    expect(publishableLanTlsFingerprint({})).toBeNull();
  });
});

// ── the route still refuses non-local callers (RV-32 regression) ────────────

describe('the fingerprint does not widen who may ask', () => {
  it('a LAN caller is still refused the whole route', () => {
    // The value is public by nature, but the NIC inventory beside it is not the
    // LAN's business (RV-32). Adding a field must not be read as loosening the
    // gate, so the gate is re-asserted here with the new field in the body.
    const handler = makeHttpHandler({
      config: { mode: 'standalone', port: 41879, mockBilling: false } as never,
      billing: {} as never,
      version: '0.1.0',
      resolveUserId: makeResolveUserId({ mode: 'standalone', standaloneUserId: 'default' }),
      lanTlsFingerprint: () => 'oTA0pWG9421vmsxFi1ZoR4gs',
    });
    let status = 0;
    let raw = '';
    const res = {
      writeHead(s: number) { status = s; return res; },
      end(b?: string) { raw = b ?? ''; },
      setHeader() { return res; },
    } as unknown as ServerResponse;
    const handled = handler(
      { url: '/api/network', method: 'GET', socket: { remoteAddress: '10.0.0.44' } } as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(status).not.toBe(200);
    expect(raw).not.toContain('oTA0pWG9421vmsxFi1ZoR4gs');
  });
});

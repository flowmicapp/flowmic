// WP-R2-4 — the additive http surface: `/api/network` LAN-IP selection
// (collectLanIpv4) + the sidecar CLI parser (parseArgv). `/api/network` is an
// additive REST endpoint (07 §5, F-2343), NOT a socket event — no whitelist /
// count-guard involvement — so it is unit-covered here.

import { describe, expect, it } from 'vitest';
import { classifyLanIpv4, collectLanCandidates, collectLanIpv4, rankLanIpv4 } from '../src/http/router';
import { parseArgv } from '../src/index';

describe('collectLanIpv4 (/api/network LAN-IP selection)', () => {
  it('drops internal + link-local (APIPA), keeps real IPv4', () => {
    const ifaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      eth0: [{ family: 'IPv4', address: '10.0.0.78', internal: false }],
      wlan0: [{ family: 4, address: '10.8.66.78', internal: false }],
      apipa: [{ family: 'IPv4', address: '169.254.1.9', internal: false }],
      v6: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
    };
    const got = collectLanIpv4(ifaces as never);
    expect(got).toContain('10.0.0.78');
    expect(got).toContain('10.8.66.78');
    expect(got).not.toContain('127.0.0.1'); // internal
    expect(got).not.toContain('169.254.1.9'); // APIPA
    expect(got).not.toContain('fe80::1'); // IPv6
  });

  it('sorts RFC1918 private addresses first (the phone-dialable one)', () => {
    const ifaces = {
      // A public/CGNAT-ish address before a private one — private must win.
      tun: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
      lan: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    };
    const got = collectLanIpv4(ifaces as never);
    expect(got[0]).toBe('192.168.1.20');
  });

  it('accepts the numeric family (4) as well as the string form (IPv4)', () => {
    const ifaces = { e: [{ family: 4, address: '172.20.0.5', internal: false }] };
    expect(collectLanIpv4(ifaces as never)).toEqual(['172.20.0.5']);
  });

  it('returns [] when only loopback exists (→ primary null → QR suppressed)', () => {
    const ifaces = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
    expect(collectLanIpv4(ifaces as never)).toEqual([]);
  });
});

// GA-21 (owner real-device defect). The old split was binary — RFC1918 or not —
// so an office range like 100.64.7.x sank BELOW public addresses and could never
// be primary. owner's tablet could reach 100.64.7.78 while every QR pointed at
// 10.0.0.78: LAN pairing was broken out of the box.
describe('GA-21 LAN candidate ranking', () => {
  it('classifies the three tiers', () => {
    expect(classifyLanIpv4('192.168.1.5')).toBe('rfc1918');
    expect(classifyLanIpv4('10.0.0.5')).toBe('rfc1918');
    expect(classifyLanIpv4('172.20.0.5')).toBe('rfc1918'); // 172.16-31 IS RFC1918
    expect(classifyLanIpv4('100.64.7.78')).toBe('non-standard-private'); // owner's
    expect(classifyLanIpv4('100.100.0.1')).toBe('non-standard-private'); // CGNAT
    expect(classifyLanIpv4('198.18.0.1')).toBe('non-standard-private'); // RFC2544
    expect(classifyLanIpv4('93.184.216.34')).toBe('other'); // public
  });

  it('ranks non-standard private ABOVE public, below RFC1918 — and drops nothing', () => {
    const ranked = rankLanIpv4(['93.184.216.34', '100.64.7.78', '10.0.0.78']);
    expect(ranked.map((c) => c.address)).toEqual([
      '10.0.0.78',
      '100.64.7.78',
      '93.184.216.34',
    ]);
    // Ranking is a DEFAULT, never a filter: a hidden candidate the owner needs
    // is a silent failure, which is exactly how this defect stayed invisible.
    expect(ranked).toHaveLength(3);
    expect(ranked.find((c) => c.address === '100.64.7.78')?.nonStandardPrivate).toBe(true);
    expect(ranked.find((c) => c.address === '10.0.0.78')?.nonStandardPrivate).toBe(false);
  });

  it('keeps NIC order within a tier (stable sort — no arbitrary reshuffling)', () => {
    expect(rankLanIpv4(['192.168.1.2', '10.0.0.9', '192.168.1.3']).map((c) => c.address))
      .toEqual(['192.168.1.2', '10.0.0.9', '192.168.1.3']);
  });

  it("owner's box: the tablet-reachable address is offered even though the "
     + 'heuristic still prefers the other one', () => {
    const ifaces = {
      wsl: [{ family: 'IPv4', address: '100.64.7.78', internal: false }],
      lan: [{ family: 'IPv4', address: '10.0.0.78', internal: false }],
    };
    const got = collectLanCandidates(ifaces as never);
    expect(got[0]?.address).toBe('10.0.0.78'); // default guess, unchanged
    expect(got.map((c) => c.address)).toContain('100.64.7.78'); // …but pickable
    expect(got[1]?.nonStandardPrivate).toBe(true); // labelled, not demoted away
  });
});

describe('parseArgv (sidecar CLI: --mode/--port/--db)', () => {
  it('parses the sidecar spawn line', () => {
    expect(parseArgv(['--mode', 'standalone', '--port', '41879'])).toEqual({
      mode: 'standalone',
      port: 41879,
    });
  });

  it('accepts --key=value form and --db', () => {
    expect(parseArgv(['--port=41988', '--db=/tmp/x.sqlite'])).toEqual({
      port: 41988,
      dbPath: '/tmp/x.sqlite',
    });
  });

  it('ignores an invalid mode and an out-of-range port (env/default wins)', () => {
    expect(parseArgv(['--mode', 'bogus', '--port', '99999'])).toEqual({});
  });

  it('ignores unrecognized flags and bare args', () => {
    expect(parseArgv(['serve', '--verbose', '--mode', 'saas'])).toEqual({ mode: 'saas' });
  });
});

// ── owner 2026-07-27: /api/health carries the running script path ────────────
//
// The desktop's adopt-first probe used to accept ANY listener whose health said
// ok:true, so a stale orphan sidecar from a different build got adopted and the
// app silently ran a server it did not ship (booklet 13 D5: same version number, cannot tell old from new).
// `script` is the discriminator it compares against its own resolved server.js.
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import type { IncomingMessage, ServerResponse } from 'node:http';

// RV-32: the peer is now part of the question (the path is answered to this
// machine only), so it is explicit here rather than left to a bare object with no
// socket — which is what these tests used to pass.
function callHealth(scriptPath?: string, peer = '127.0.0.1'): { status: number; body: Record<string, unknown> } {
  const handler = makeHttpHandler({
    config: { mode: 'standalone', port: 41879, mockBilling: false } as never,
    billing: {} as never,
    version: '0.1.0',
    // The REAL resolver (standalone branch), not a stand-in: a test that hand-rolls
    // the seam it is wiring proves nothing about the seam production wires.
    resolveUserId: makeResolveUserId({ mode: 'standalone', standaloneUserId: 'default' }),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
  });
  let status = 0;
  let raw = '';
  const res = {
    writeHead(s: number) { status = s; return res; },
    end(b?: string) { raw = b ?? ''; },
  } as unknown as ServerResponse;
  const handled = handler(
    { url: '/api/health', method: 'GET', socket: { remoteAddress: peer } } as IncomingMessage,
    res,
  );
  expect(handled).toBe(true);
  return { status, body: JSON.parse(raw) as Record<string, unknown> };
}

describe('/api/health — build identity for the desktop adopt probe', () => {
  it('echoes the exact script path it was told it is running', () => {
    const { status, body } = callHealth('C:\Program Files\FlowMic\resources\server.js');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.script).toBe('C:\Program Files\FlowMic\resources\server.js');
  });

  it('keeps every pre-existing health field (additive only)', () => {
    const { body } = callHealth('/x/server.js');
    expect(body).toMatchObject({ ok: true, mode: 'standalone', port: 41879, version: '0.1.0' });
  });

  it('falls back to argv[1] rather than omitting the field', () => {
    // An omitted field reads to the probe as "pre-2026-07-27 build" and costs an
    // adopt; the running script is always knowable, so it is always reported.
    const { body } = callHealth();
    expect(typeof body.script).toBe('string');
  });

  // RV-32 — the adopt probe is ALWAYS on loopback (desktop dials SIDECAR_HOST),
  // while the route is reachable from the whole LAN. The reverse direction is the
  // one that matters: without it this suite would pass with no gate at all.
  it('withholds the path from a LAN caller, without removing the field', () => {
    const { status, body } = callHealth('/x/server.js', '10.0.0.44');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, mode: 'standalone', version: '0.1.0' });
    expect('script' in body).toBe(true);
    expect(body.script).toBeNull();
  });
});

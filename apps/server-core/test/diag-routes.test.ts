// POST /api/diag/mobile — the phone's diagnostic trail lands on the PC.
//
// owner 2026-07-29: "getting logs off the phone is inconvenient". What this pins is the honesty of the
// endpoint rather than its plumbing: every refusal is NAMED and nothing ever
// answers ok:true without a write having happened, because the whole value of
// the feature is being able to believe the log afterwards.
//
// RV-13 (2026-07-30) makes that last clause literal: an upload nobody
// authenticated must not be written down as if the paired phone sent it. The
// two-direction coverage for that (token → `[phone]`, no token → UNVERIFIED) and
// for the rate window lives in test/http-access-control.test.ts, where the route
// is exercised through the router that actually wires it.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  appendWithRotation,
  DIAG_MAX_PER_WINDOW,
  DIAG_ROTATE_BYTES,
  diagLogPathBeside,
  DiagUploadThrottle,
  tryHandleDiagRoutes,
  MAX_DIAG_BYTES,
} from '../src/http/diag-routes';
import type { PairingRegistry } from '../src/http/pairing-auth';
import { log } from '../src/log';

function request(method: string, url: string, body?: string, token?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers =
    token === undefined ? {} : { authorization: `Bearer ${token}` };
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '10.0.0.44' };
  return req;
}

function response(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let settle: (v: { status: number; body: unknown }) => void;
  const done = new Promise<{ status: number; body: unknown }>((r) => (settle = r));
  let status = 0;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      settle({ status, body: payload ? JSON.parse(payload) : null });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

describe('POST /api/diag/mobile', () => {
  it('appends the trail and reports how many lines landed', async () => {
    const append = vi.fn();
    const { res, done } = response();
    const handled = tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', JSON.stringify({ device: 'HUAWEI PLA-AL10-921d', lines: ['a', 'b', 'c'] })),
      res,
      { logPath: 'C:/tmp/server.log', append, now: () => '2026-07-29T13:00:00.000Z' },
    );
    expect(handled).toBe(true);
    const out = await done;
    expect(out.status).toBe(200);
    // No registry passed ⇒ nothing could be verified ⇒ the block says so. The
    // route never assumes a trust grade it had no way to check.
    expect(out.body).toMatchObject({ ok: true, lines: 3, authenticated: false });
    expect(append).toHaveBeenCalledTimes(1);
    const [path, text] = append.mock.calls[0]!;
    expect(path).toBe('C:/tmp/server.log');
    expect(text).toContain('HUAWEI PLA-AL10-921d');
    expect(text).toContain('[phone-unverified] a');
    expect(text).toContain('[phone-unverified] c');
  });

  it('the rate window refuses by name and writes nothing (RV-13 rate-limit)', async () => {
    const append = vi.fn();
    const throttle = new DiagUploadThrottle({ max: 1, windowMs: 60_000, now: () => 1_000 });
    const body = JSON.stringify({ lines: ['x'] });
    const first = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), first.res, { logPath: 'C:/tmp/x.log', append, throttle });
    expect((await first.done).status).toBe(200);

    const second = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), second.res, { logPath: 'C:/tmp/x.log', append, throttle });
    const out = await second.done;
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_RATE_LIMITED' });
    expect(append, 'a refused upload is never appended').toHaveBeenCalledTimes(1);
  });

  // IT-24 — the DIAG_RATE_LIMITED (429) arm used to be completely silent: its
  // comment claimed a warn was "already spent earlier", which was false on both
  // reachable paths (an accepted request only ever reaches log.info; a rejected
  // one never touched log.warn at all). Fixed with the same bounded shape as the
  // IT-14 401 arm: AT MOST ONE warn per rate-limit window per subject, never one
  // per rejected request — logging on every 429 would recreate the disk
  // amplification commit 2da57f0 already removed once.
  it('IT-24: over-budget refusals warn AT MOST ONCE per window, not per request', async () => {
    const append = vi.fn();
    const throttle = new DiagUploadThrottle({ max: 1, windowMs: 60_000, now: () => 1_000 });
    const body = JSON.stringify({ lines: ['x'] });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const first = response();
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), first.res, {
        logPath: 'C:/tmp/x.log', append, throttle,
      });
      expect((await first.done).status).toBe(200);
      expect(warn, 'an accepted upload never warns').not.toHaveBeenCalled();

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const { res, done } = response();
        tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), res, {
          logPath: 'C:/tmp/x.log', append, throttle,
        });
        statuses.push((await done).status);
      }
      expect(statuses.every((s) => s === 429), 'every over-budget call is still refused by name').toBe(true);
      const rateLimitWarns = warn.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('rate-limited'));
      expect(rateLimitWarns.length, 'bounded — one warn for the whole window, not one per refusal').toBe(1);
      expect(append, 'only the one accepted upload is ever appended — every refusal writes nothing')
        .toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('IT-24: the window reopening also reopens the once-per-window warn budget', async () => {
    let clock = 1_000;
    const throttle = new DiagUploadThrottle({ max: 1, windowMs: 60_000, now: () => clock });
    const body = JSON.stringify({ lines: ['x'] });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const a = response();
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), a.res, { logPath: 'C:/tmp/x.log', throttle });
      await a.done;
      const b = response(); // over budget, same window ⇒ warns once
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), b.res, { logPath: 'C:/tmp/x.log', throttle });
      expect((await b.done).status).toBe(429);

      clock += 60_001; // window rolls over
      const c = response();
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), c.res, { logPath: 'C:/tmp/x.log', throttle });
      await c.done;
      const d = response(); // over budget again, NEW window ⇒ warns a second time
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), d.res, { logPath: 'C:/tmp/x.log', throttle });
      expect((await d.done).status).toBe(429);

      const rateLimitWarns = warn.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('rate-limited'));
      expect(rateLimitWarns.length, 'a new window gets its own warn budget').toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('the window reopens once it has elapsed (a limiter, not a ban)', async () => {
    const append = vi.fn();
    let clock = 1_000;
    const throttle = new DiagUploadThrottle({ max: 1, windowMs: 60_000, now: () => clock });
    const body = JSON.stringify({ lines: ['x'] });
    const a = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), a.res, { logPath: 'C:/tmp/x.log', append, throttle });
    await a.done;
    clock += 60_001;
    const b = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), b.res, { logPath: 'C:/tmp/x.log', append, throttle });
    expect((await b.done).status).toBe(200);
  });

  it('never claims success when there is nowhere to write', async () => {
    const { res, done } = response();
    tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', JSON.stringify({ lines: ['x'] })),
      res,
      {}, // no logPath — the cloud relay case
    );
    const out = await done;
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_NO_SINK' });
  });

  it('a write that throws is reported, not swallowed', async () => {
    const { res, done } = response();
    tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', JSON.stringify({ lines: ['x'] })),
      res,
      {
        logPath: 'C:/tmp/server.log',
        append: () => {
          throw new Error('EACCES');
        },
      },
    );
    const out = await done;
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_WRITE_FAILED' });
  });

  it('names each malformed body instead of collapsing them', async () => {
    for (const [body, error] of [
      ['not json at all', 'DIAG_BODY_NOT_JSON'],
      [JSON.stringify({ lines: [] }), 'DIAG_EMPTY'],
      [JSON.stringify({ device: 'x' }), 'DIAG_EMPTY'],
    ] as const) {
      const { res, done } = response();
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', body), res, { logPath: 'C:/tmp/x.log', append: vi.fn() });
      const out = await done;
      expect(out.status).toBe(400);
      expect(out.body).toMatchObject({ ok: false, error });
    }
  });

  it('bounds the upload and says so', async () => {
    const append = vi.fn();
    const { res, done } = response();
    tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', 'x'.repeat(MAX_DIAG_BYTES + 1024)),
      res,
      { logPath: 'C:/tmp/x.log', append },
    );
    const out = await done;
    expect(out.status).toBe(413);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_TOO_LARGE' });
    expect(append, 'nothing over the cap is ever written').not.toHaveBeenCalled();
  });

  it('only answers POST, and only its own path', () => {
    const { res } = response();
    expect(tryHandleDiagRoutes(request('GET', '/api/health'), res, {})).toBe(false);
    const { res: res2, done } = response();
    expect(tryHandleDiagRoutes(request('GET', '/api/diag/mobile'), res2, {})).toBe(true);
    return expect(done).resolves.toMatchObject({ status: 405 });
  });
});

// ── D6 — the public (saas) leg REFUSES what standalone merely marks ──────────
//
// `requireVerified` is set by router.ts for saas only. Both directions pinned:
// the refusal exists AND the verified phone still gets through — a gate test
// that only proves the allowed caller works proves nothing about the gate.
describe('POST /api/diag/mobile — requireVerified (D6, the cloud leg)', () => {
  const registry = {
    reconnectMobile: (token: string) =>
      token === 'good-token'
        ? { mobile: { id: 'pair-7', user_id: 'u' }, pc: { id: 'pc-1', user_id: 'u', room_uuid: 'r' } }
        : null,
  } as unknown as PairingRegistry;

  const BODY = JSON.stringify({ device: 'PLA-AL10', lines: ['edge: connected'] });

  it('no token ⇒ 401 DIAG_UNVERIFIED, and nothing is written', async () => {
    const append = vi.fn();
    const { res, done } = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY), res, {
      logPath: 'C:/tmp/x.log', append, registry, requireVerified: true,
    });
    const out = await done;
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_UNVERIFIED' });
    expect(append, 'a refused upload leaves no trace in the evidence file').not.toHaveBeenCalled();
  });

  it('a token no pairing owns ⇒ the same 401 (forged = absent, on the public leg)', async () => {
    const append = vi.fn();
    const { res, done } = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY, 'stolen-or-revoked'), res, {
      logPath: 'C:/tmp/x.log', append, registry, requireVerified: true,
    });
    expect(await done).toMatchObject({ status: 401, body: { error: 'DIAG_UNVERIFIED' } });
    expect(append).not.toHaveBeenCalled();
  });

  it('a live pairing token ⇒ 200, written as [phone] — the refusal never locks out the real phone', async () => {
    const append = vi.fn();
    const { res, done } = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY, 'good-token'), res, {
      logPath: 'C:/tmp/x.log', append, registry, requireVerified: true,
    });
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, lines: 1, authenticated: true });
    const text = append.mock.calls[0]![1] as string;
    expect(text).toContain('origin=pairing:pair-7');
    expect(text).toContain('[phone] edge: connected');
  });

  it('requireVerified NOT set ⇒ the standalone two-stage posture is untouched (accept + mark)', async () => {
    const append = vi.fn();
    const { res, done } = response();
    tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY), res, {
      logPath: 'C:/tmp/x.log', append, registry,
    });
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, authenticated: false });
    expect(append.mock.calls[0]![1] as string).toContain('[phone-unverified]');
  });

  // IT-14 — saas refusal must not amplify disk work. log.warn → log.ts toFile is
  // a sync append; an unthrottled 401 path made 「no」 cost more than the route
  // budgeted for an unwanted request (file header: not even one body read).
  it('IT-14: saas unverified refusals stay 401 but warn at most DIAG_MAX_PER_WINDOW times per peer window', async () => {
    const append = vi.fn();
    const throttle = new DiagUploadThrottle({ max: DIAG_MAX_PER_WINDOW, windowMs: 60_000, now: () => 1_000 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < DIAG_MAX_PER_WINDOW + 5; i += 1) {
        const { res, done } = response();
        tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY), res, {
          logPath: 'C:/tmp/x.log', append, registry, requireVerified: true, throttle,
        });
        statuses.push((await done).status);
      }
      expect(statuses.every((s) => s === 401), 'auth refusal stays 401 — never promoted to 429').toBe(true);
      expect(append).not.toHaveBeenCalled();
      const refuseWarns = warn.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('no verified pairing on a public leg'));
      expect(refuseWarns.length, 'warn/disk spend is capped by the same throttle budget').toBe(DIAG_MAX_PER_WINDOW);
    } finally {
      warn.mockRestore();
    }
  });

  it('IT-14 POSITIVE CONTROL: a verified upload still succeeds after anonymous refusals spent the peer bucket', async () => {
    const append = vi.fn();
    const throttle = new DiagUploadThrottle({ max: DIAG_MAX_PER_WINDOW, windowMs: 60_000, now: () => 1_000 });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < DIAG_MAX_PER_WINDOW + 2; i += 1) {
        const { res, done } = response();
        tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY), res, {
          logPath: 'C:/tmp/x.log', append, registry, requireVerified: true, throttle,
        });
        await done;
      }
      const { res, done } = response();
      tryHandleDiagRoutes(request('POST', '/api/diag/mobile', BODY, 'good-token'), res, {
        logPath: 'C:/tmp/x.log', append, registry, requireVerified: true, throttle,
      });
      const out = await done;
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, authenticated: true, lines: 1 });
      expect(append).toHaveBeenCalledTimes(1);
      expect(append.mock.calls[0]![1] as string).toContain('[phone] edge: connected');
    } finally {
      warn.mockRestore();
    }
  });
});

// ── D12 — diag uploads go THROUGH the log rollover, not around it ────────────
//
// Before this card the default writer was a bare appendFileSync: diag bytes
// never counted toward log.ts's 4 MB threshold and never triggered a roll, so
// sustained uploads grew the forensic file without bound (the old comment's
// 「a flood cannot outrun the rotation」 was false — nothing was outrun because
// nothing was running). Real fs on purpose: the defect WAS the missing fs
// behaviour, so a spy that merely records calls could not see it.
describe('appendWithRotation — D12, bounded diag writes', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flowmic-diag-rot-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rolls the file to .1 past the threshold — the same one-generation policy as log.ts', () => {
    const p = join(dir, 'server.log');
    writeFileSync(p, 'x'.repeat(DIAG_ROTATE_BYTES + 1));
    appendWithRotation(p, 'NEW\n');
    expect(statSync(p).size, 'the live file restarts from the appended text alone').toBe(4);
    expect(statSync(`${p}.1`).size, 'history moves to the kept generation, not the void').toBe(DIAG_ROTATE_BYTES + 1);
  });

  it('sustained max-size uploads stay bounded: live file ≤ threshold + one upload, disk ≤ two generations', () => {
    const p = join(dir, 'server.log');
    const chunk = 'y'.repeat(280 * 1024); // ≈ one MAX_DIAG_BYTES upload incl. header lines
    for (let i = 0; i < 40; i += 1) { // ~11 MB written — pre-D12 the file simply held all of it
      appendWithRotation(p, chunk);
      expect(statSync(p).size).toBeLessThanOrEqual(DIAG_ROTATE_BYTES + chunk.length);
    }
    const total = statSync(p).size + statSync(`${p}.1`).size;
    expect(total).toBeLessThanOrEqual(2 * (DIAG_ROTATE_BYTES + chunk.length));
  });

  it('the ROUTE\'s default writer is the rotating one — the wiring, not just the class', async () => {
    const p = join(dir, 'server.log');
    writeFileSync(p, 'z'.repeat(DIAG_ROTATE_BYTES + 1));
    const { res, done } = response();
    tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', JSON.stringify({ device: 'd', lines: ['line-after-rotation'] })),
      res,
      { logPath: p }, // NO append seam — this exercises the production default
    );
    expect((await done).status).toBe(200);
    expect(statSync(p).size, 'the oversized file was rolled, not appended to').toBeLessThan(64 * 1024);
    expect(readFileSync(p, 'utf8')).toContain('line-after-rotation');
    expect(statSync(`${p}.1`).size).toBe(DIAG_ROTATE_BYTES + 1);
  });
});

// ── IT-15 — diag volume must not evict operational history ───────────────────
//
// Direction (a): sibling file via diagLogPathBeside. Measured pre-fix numbers
// (10/min × 256 KB vs 4 MB + .1) still describe how fast the DIAG file rolls;
// they must not describe how fast the OPS file disappears.
describe('IT-15 — diagnostic uploads cannot evict the ops log', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flowmic-diag-it15-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('diagLogPathBeside derives a sibling, never the ops path itself', () => {
    expect(diagLogPathBeside('/var/lib/flowmic/server.log')).toBe('/var/lib/flowmic/server-mobile-diag.log');
    expect(diagLogPathBeside('C:/FlowMic/server.log')).toBe('C:/FlowMic/server-mobile-diag.log');
    expect(diagLogPathBeside('/tmp/ops')).toBe('/tmp/ops-mobile-diag.log');
  });

  it('flooding the diag sink rotates ONLY the diag file — ops marker survives', () => {
    const opsPath = join(dir, 'server.log');
    const diagPath = diagLogPathBeside(opsPath);
    const OPS_MARKER = 'OPS_FORENSIC_MARKER_do_not_evict\n';
    writeFileSync(opsPath, OPS_MARKER);
    // One authenticated uploader at the measured ceiling: chunks just under the
    // per-upload cap, enough volume to force at least one diag rotation.
    const chunk = 'D'.repeat(280 * 1024);
    for (let i = 0; i < 20; i += 1) appendWithRotation(diagPath, chunk);
    expect(readFileSync(opsPath, 'utf8'), 'ops history must still be readable after diag rolls').toBe(OPS_MARKER);
    expect(statSync(diagPath).size).toBeLessThanOrEqual(DIAG_ROTATE_BYTES + chunk.length);
    expect(statSync(`${diagPath}.1`).size).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a legitimate upload still succeeds and remains readable afterwards', async () => {
    const opsPath = join(dir, 'server.log');
    const diagPath = diagLogPathBeside(opsPath);
    writeFileSync(opsPath, 'ops-line-before\n');
    const { res, done } = response();
    tryHandleDiagRoutes(
      request('POST', '/api/diag/mobile', JSON.stringify({
        device: 'PLA-AL10',
        lines: ['edge: connected', 'inject:result ok'],
      })),
      res,
      { logPath: diagPath, now: () => '2026-08-05T12:00:00.000Z' },
    );
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      lines: 2,
      written_to: diagPath,
    });
    const text = readFileSync(diagPath, 'utf8');
    expect(text).toContain('[phone-unverified] edge: connected');
    expect(text).toContain('[phone-unverified] inject:result ok');
    expect(readFileSync(opsPath, 'utf8')).toBe('ops-line-before\n');
  });
});

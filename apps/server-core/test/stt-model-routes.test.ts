// GET /api/stt/model/status · POST /api/stt/model/{download,cancel} — the
// §4 surface of docs/strategy/2026-08-19-local-model-onboarding-design.md.
//
// Two properties are pinned here that the controller's own suite cannot see,
// because they are decisions the ROUTER makes:
//
//   · IN SAAS THE ROUTES DO NOT EXIST. Not "are refused" — do not exist. The
//     assertion is that the handler does not own the request at all, which is
//     what makes the fallback 404 the answer, exactly as `/api/inject/image`
//     and `/api/probe/*` behave.
//   · STANDALONE IS NOT AN AUTH GATE (RV-32). standalone binds every interface,
//     so the mount decides nothing about WHO may call. A POST here makes this
//     machine pull 229 MB from a third party; a LAN peer must be refused BY
//     NAME and must not reach the controller at all.
//
// ── NEGATIVE CONTROL ─────────────────────────────────────────────────────────
// Run on dev-pc-a, 2026-08-19. Deleting the `isLocalRequest` guard from
// stt-model-routes.ts — leaving the standalone mount as the only gate, which is
// exactly the RV-32 defect — turned BOTH cases in the describe below red. The
// readings, verbatim:
//
//   FAIL test/stt-model-routes.test.ts > standalone: only this machine may ask
//   > a LAN peer is refused by name, and the controller is never touched
//   AssertionError: expected 200 to be 403 // Object.is equality
//
//   FAIL test/stt-model-routes.test.ts > standalone: only this machine may ask
//   > the refusal covers reading, too — a status poll is not exempt
//   AssertionError: expected 200 to be 403 // Object.is equality
//
// i.e. the route answered 10.0.0.44 with 200 and a live snapshot. Note
// which assertion fired: the STATUS one, before the spy one. Had the case only
// asserted 「the controller was not touched」, the same edit would still have
// been caught — but the case asserts both on purpose, because a gate that
// answers 403 while having already started the download is the other half of
// this defect and looks identical from the status code alone.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId, type AccountVerifier } from '../src/http/account-auth';
import { LOCAL_ONLY_ERROR } from '../src/http/local-only';
import {
  STT_MODEL_CANCEL_PATH, STT_MODEL_DOWNLOAD_PATH, STT_MODEL_ROUTE_PATHS, STT_MODEL_STATUS_PATH,
} from '../src/http/stt-model-routes';
import { SherpaModelController, resetSherpaModelControllers } from '../src/stt/sherpa/model-downloader';
import type { ModelFile } from '../src/stt/sherpa/model-manifest';

afterEach(() => {
  resetSherpaModelControllers();
  vi.restoreAllMocks();
});

const LOOPBACK = '127.0.0.1';
const LAN_PEER = '10.0.0.44';

const MODEL_BODY = Buffer.alloc(1_024, 8);
const FILES: ModelFile[] = [{
  path: 'model.bin',
  size: MODEL_BODY.length,
  sha256: createHash('sha256').update(MODEL_BODY).digest('hex'),
}];

function request(method: string, url: string, peer: string): IncomingMessage {
  const stream = Readable.from([]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = {};
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: peer };
  return req;
}

function response(): { res: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  let settle: (v: { status: number; body: Record<string, unknown> }) => void;
  const done = new Promise<{ status: number; body: Record<string, unknown> }>((r) => (settle = r));
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(payload?: string) { settle({ status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} }); },
    once() { return res; },
  } as unknown as ServerResponse;
  return { res, done };
}

const NO_ACCOUNTS: AccountVerifier = {
  verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }),
  getUser: () => null,
};

/** The router as bootstrap builds it, with only the two knobs these cases turn. */
function handlerFor(opts: { mode?: 'standalone' | 'saas'; controller?: SherpaModelController } = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const mode = opts.mode ?? 'standalone';
  return makeHttpHandler({
    config: { mode, port: 41879, mockBilling: mode === 'standalone' } as never,
    billing: {} as never,
    version: '0.3.9',
    // saas needs an account layer to construct at all; these cases never reach
    // an identity, so it is one that knows nobody (same seam http-access-control uses).
    resolveUserId: makeResolveUserId({ mode, standaloneUserId: 'default', ...(mode === 'saas' ? { account: NO_ACCOUNTS } : {}) }),
    scriptPath: 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js',
    ...(opts.controller ? { sttModel: { controller: opts.controller } } : {}),
  });
}

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  method: string,
  url: string,
  peer: string,
): { handled: boolean; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  const { res, done } = response();
  const handled = handler(request(method, url, peer), res);
  return { handled, done };
}

function readyController(): SherpaModelController {
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-route-ready-'));
  writeFileSync(join(dir, 'model.bin'), MODEL_BODY);
  return new SherpaModelController(dir, { files: FILES });
}

// ── the door is bricked up in saas ───────────────────────────────────────────

describe('saas: these paths do not exist', () => {
  it('none of the three is owned by the handler — the router 404s them', () => {
    const h = handlerFor({ mode: 'saas', controller: readyController() });
    for (const path of STT_MODEL_ROUTE_PATHS) {
      const method = path === STT_MODEL_STATUS_PATH ? 'GET' : 'POST';
      // `handled === false` is the whole assertion: a route that answered 403,
      // or 404 from inside the module, would still BE a route on the public
      // relay. Not-mounted is a different fact from refused, and the design
      // asked for the first one.
      expect(call(h, method, path, LOOPBACK).handled, `${method} ${path} must not exist in saas`).toBe(false);
    }
  });

  it('a controller wired by mistake in saas still cannot be reached', async () => {
    const c = readyController();
    const spy = vi.spyOn(c, 'snapshot');
    const h = handlerFor({ mode: 'saas', controller: c });
    call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK);
    // The mode gate is in the ROUTER, above the dep — so a misconfigured
    // deployment cannot open the door by wiring a dep it should not have.
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── standalone is a mode gate, not an auth gate (RV-32) ──────────────────────

describe('standalone: only this machine may ask', () => {
  it('a LAN peer is refused by name, and the controller is never touched', async () => {
    const c = readyController();
    const start = vi.spyOn(c, 'start');
    const h = handlerFor({ controller: c });
    const { handled, done } = call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LAN_PEER);
    expect(handled, 'the module must OWN the request so it can refuse it out loud').toBe(true);
    const out = await done;
    expect(out.status).toBe(403);
    expect(out.body['error']).toBe(LOCAL_ONLY_ERROR);
    expect(start, 'a LAN peer must not be able to make this machine fetch 229 MB').not.toHaveBeenCalled();
  });

  it('the refusal covers reading, too — a status poll is not exempt', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LAN_PEER).done;
    expect(out.status).toBe(403);
  });
});

// ── the snapshot on the wire ─────────────────────────────────────────────────

describe('GET /api/stt/model/status', () => {
  it('answers 200 with EXACTLY §4 field names — the desktop is written against them', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK).done;
    expect(out.status).toBe(200);
    expect(Object.keys(out.body).sort()).toEqual([
      'bytes_done', 'bytes_total', 'current_file', 'dir', 'error', 'files_done',
      'files_total', 'model_id', 'rate_bytes_per_sec', 'resumed_from_bytes',
      'source', 'state',
    ]);
    expect(out.body['state']).toBe('ready');
    expect(out.body['bytes_total']).toBe(MODEL_BODY.length);
    // The install directory is on the wire in EVERY state, because 「place the
    // files yourself」 is one of the two exits a failure has to offer.
    expect(typeof out.body['dir']).toBe('string');
  });

  it('?verify=1 is the 「check the files again」 button, and it re-reads the bytes', async () => {
    const c = readyController();
    const spy = vi.spyOn(c, 'snapshot');
    const h = handlerFor({ controller: c });
    await call(h, 'GET', `${STT_MODEL_STATUS_PATH}?verify=1`, LOOPBACK).done;
    expect(spy, 'the button must force a real re-read, or it reports 「checked」 without checking').toHaveBeenCalledWith(true);
    // …and the ordinary poll must NOT, or a 1 Hz card re-hashes 229 MB forever.
    await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK).done;
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it('refuses the wrong verb by name rather than answering something else', async () => {
    const h = handlerFor({ controller: readyController() });
    const post = await call(h, 'POST', STT_MODEL_STATUS_PATH, LOOPBACK).done;
    expect(post.status).toBe(405);
    const get = await call(h, 'GET', STT_MODEL_DOWNLOAD_PATH, LOOPBACK).done;
    expect(get.status).toBe(405);
  });
});

// ── download / cancel ────────────────────────────────────────────────────────

describe('POST /api/stt/model/download and /cancel', () => {
  it('download on an already-ready model starts nothing and says ready', async () => {
    const c = readyController();
    await c.snapshot(); // warm the memo, exactly as the settings card's first poll does
    const h = handlerFor({ controller: c });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK).done;
    expect(out.status).toBe(200);
    expect(out.body['state']).toBe('ready');
    expect(c.busy, 'a ready model must not be re-fetched by a stray button press').toBe(false);
  });

  it('cancel with nothing running answers the snapshot, not an error', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'POST', STT_MODEL_CANCEL_PATH, LOOPBACK).done;
    expect(out.status).toBe(200);
    expect(out.body['error']).toBe(null);
  });

  it('the POST is itself the consent — no environment variable is consulted', async () => {
    // Owner ruling DISC-2 made downloading opt-in; design §2-3 makes the button
    // the opt-in. Requiring BOTH would mean the button does not work, which is
    // the 「a control that changes nothing」 shape this repo has shipped before.
    const saved = process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
    delete process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
    try {
      const dir = mkdtempSync(join(tmpdir(), 'flowmic-route-consent-'));
      const c = new SherpaModelController(dir, {
        files: FILES,
        sources: [{ name: 'nowhere', base: 'http://127.0.0.1:1' }],
        tarballUrl: 'http://127.0.0.1:1/a.tar.bz2',
      });
      const h = handlerFor({ controller: c });
      const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK).done;
      expect(out.body['state'], 'the button pressed with the env unset must still start a download').toBe('downloading');
      await c.cancel();
    } finally {
      if (saved === undefined) delete process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
      else process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'] = saved;
    }
  });
});

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
  STT_MODEL_CANCEL_PATH, STT_MODEL_DOWNLOAD_PATH, STT_MODEL_ROOT_PATH, STT_MODEL_ROUTE_PATHS,
  STT_MODEL_STATUS_PATH,
} from '../src/http/stt-model-routes';
import { SherpaModelController, resetSherpaModelControllers } from '../src/stt/sherpa/model-downloader';
import { SENSE_VOICE_MODEL_ID } from '../src/stt/sherpa/model-catalog';
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

function request(
  method: string,
  url: string,
  peer: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = headers;
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: peer };
  return req;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  /** Every setHeader() call, lower-cased — the CORS cases read these. */
  headers: Record<string, string>;
}

function response(): { res: ServerResponse; done: Promise<Answer> } {
  let settle: (v: Answer) => void;
  const done = new Promise<Answer>((r) => (settle = r));
  let status = 0;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    writeHead(code: number) { status = code; return res; },
    end(payload?: string) {
      settle({
        status: status || (res as unknown as { statusCode: number }).statusCode,
        body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
        headers,
      });
    },
    once() { return res; },
  } as unknown as ServerResponse;
  return { res, done };
}

const NO_ACCOUNTS: AccountVerifier = {
  verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }),
  getUser: () => null,
};

/** The router as bootstrap builds it, with only the knobs these cases turn.
 *  LM-CAT: the dep became `controllerFor(row)`; handing back ONE controller
 *  for every row keeps each case's world exactly one model big. `env` is
 *  pointed at a temp APPDATA so no case can read or write this machine's real
 *  pointer/selection files. */
function handlerFor(opts: {
  mode?: 'standalone' | 'saas';
  controller?: SherpaModelController;
  busy?: SherpaModelController | null;
  env?: NodeJS.ProcessEnv;
} = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const mode = opts.mode ?? 'standalone';
  // Both app-data envs — see model-catalog.test.ts tempEnv(): on the public
  // repo's macOS/Linux runners APPDATA alone falls through to the runner's
  // real ~/.local/share.
  const tmpAppData = mkdtempSync(join(tmpdir(), 'flowmic-route-appdata-'));
  const env = opts.env ?? ({ APPDATA: tmpAppData, XDG_DATA_HOME: tmpAppData } as NodeJS.ProcessEnv);
  return makeHttpHandler({
    config: { mode, port: 41879, mockBilling: mode === 'standalone' } as never,
    billing: {} as never,
    version: '0.3.9',
    // saas needs an account layer to construct at all; these cases never reach
    // an identity, so it is one that knows nobody (same seam http-access-control uses).
    resolveUserId: makeResolveUserId({ mode, standaloneUserId: 'default', ...(mode === 'saas' ? { account: NO_ACCOUNTS } : {}) }),
    scriptPath: 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js',
    sttModel: {
      env,
      ...(opts.controller ? { controllerFor: () => opts.controller! } : {}),
      ...(opts.busy !== undefined ? { busyController: () => opts.busy! } : { busyController: () => null }),
    },
  });
}

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  method: string,
  url: string,
  peer: string,
  headers: Record<string, string> = {},
  body?: unknown,
): { handled: boolean; done: Promise<Answer> } {
  const { res, done } = response();
  const handled = handler(request(method, url, peer, headers, body), res);
  return { handled, done };
}

/** The body every download/cancel case sends — a REAL catalog id, because the
 *  route validates against the catalog before touching any controller. */
const SV = { model_id: SENSE_VOICE_MODEL_ID };

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
  it('answers 200 with the §4 names at top level PLUS the LM-CAT catalog surface', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK).done;
    expect(out.status).toBe(200);
    // Top level = the legacy §4 snapshot (SenseVoice row, byte-compatible for
    // any older reader) + the catalog additions of LM-CAT §7. Field names are
    // the contract; the desktop is written against them.
    expect(Object.keys(out.body).sort()).toEqual([
      'busy_model_id', 'bytes_done', 'bytes_total', 'catalog', 'current_file',
      'dir', 'error', 'files_done', 'files_total', 'model_id', 'models',
      'models_root', 'rate_bytes_per_sec', 'resumed_from_bytes',
      'selected_by_lang', 'source', 'spoken_langs', 'state',
    ]);
    expect(out.body['state']).toBe('ready');
    expect(out.body['bytes_total']).toBe(MODEL_BODY.length);
    // The install directory is on the wire in EVERY state, because 「place the
    // files yourself」 is one of the two exits a failure has to offer.
    expect(typeof out.body['dir']).toBe('string');
    // The catalog rides every status answer, one entry per row, and the
    // models array carries one five-state snapshot per row.
    const catalog = out.body['catalog'] as { model_id: string }[];
    const models = out.body['models'] as { model_id: string }[];
    expect(catalog.length).toBeGreaterThanOrEqual(8);
    expect(models.length).toBe(catalog.length);
    expect(out.body['spoken_langs']).toEqual(['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru']);
    const root = out.body['models_root'] as Record<string, unknown>;
    expect(typeof root['dir']).toBe('string');
    expect(typeof root['default_dir']).toBe('string');
    expect(root['configured']).toBe(false);
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
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, SV).done;
    expect(out.status).toBe(200);
    expect(out.body['state']).toBe('ready');
    expect(c.busy, 'a ready model must not be re-fetched by a stray button press').toBe(false);
  });

  it('cancel with nothing running answers the snapshot, not an error', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'POST', STT_MODEL_CANCEL_PATH, LOOPBACK, {}, SV).done;
    expect(out.status).toBe(200);
    expect(out.body['error']).toBe(null);
  });

  // 🔴 LM-CAT §7: a body-less download must FAIL LOUD. The pre-LM-CAT desktop
  // sent `{}` meaning "the one model"; silently mapping that onto SenseVoice
  // would make "the user picks which pack" a fiction.
  it('a download naming no model_id is refused by name, and nothing starts', async () => {
    const c = readyController();
    const start = vi.spyOn(c, 'start');
    const h = handlerFor({ controller: c });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, {}).done;
    expect(out.status).toBe(400);
    expect(out.body['error']).toBe('MODEL_ID_REQUIRED');
    expect(start).not.toHaveBeenCalled();
  });

  it('an id the catalog does not carry is a named 404', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, { model_id: 'not-a-model' }).done;
    expect(out.status).toBe(404);
    expect(out.body['error']).toBe('MODEL_UNKNOWN');
  });

  // LM-CAT §5/§8-③: the streaming row EXISTS in the catalog and refuses BOTH
  // doors by name this phase. Uses the production controllerFor (no seam), so
  // the refusal proven here is the shipped one — the throw happens before any
  // network or filesystem work.
  it('🔴 a streaming pack refuses download with a named reason (phase D not shipped)', async () => {
    const h = handlerFor({});
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, {
      model_id: 'sherpa-onnx-streaming-zipformer-fr-2023-04-14',
    }).done;
    expect(out.status).toBe(409);
    expect(out.body['error']).toBe('MODEL_STREAMING_UNSUPPORTED');
    expect(String(out.body['message'])).toMatch(/streaming/i);
  });

  // LM-CAT §7: machine-wide single flight — one pack at a time, and the
  // refusal NAMES the pack that is busy so the card can say which.
  it('a second pack is refused while another is downloading', async () => {
    const c = readyController();
    const other = readyController();
    const h = handlerFor({ controller: c, busy: other });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, SV).done;
    expect(out.status).toBe(409);
    expect(out.body['error']).toBe('MODEL_DOWNLOAD_BUSY');
    expect(out.body['busy_model_id']).toBe(other.modelId);
  });

  // LM-CAT §6-1: pressing a pack's button UNDER a language records the
  // selection, and the recorded pair must actually be honoured by the body.
  it('download with a lang records the per-language selection', async () => {
    const c = readyController();
    await c.snapshot();
    const h = handlerFor({ controller: c });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, { ...SV, lang: 'zh' }).done;
    expect(out.status).toBe(200);
    expect((out.body['selected_by_lang'] as Record<string, string>)['zh']).toBe(SENSE_VOICE_MODEL_ID);
  });

  it('a lang the pack does not claim is refused before anything persists', async () => {
    const c = readyController();
    const h = handlerFor({ controller: c });
    const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, { ...SV, lang: 'fr' }).done;
    expect(out.status).toBe(400);
    expect(out.body['error']).toBe('MODEL_LANG_MISMATCH');
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
      const out = await call(h, 'POST', STT_MODEL_DOWNLOAD_PATH, LOOPBACK, {}, SV).done;
      expect(out.body['state'], 'the button pressed with the env unset must still start a download').toBe('downloading');
      await c.cancel();
    } finally {
      if (saved === undefined) delete process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'];
      else process.env['FLOWMIC_SHERPA_AUTO_DOWNLOAD'] = saved;
    }
  });
});

// ── the models root is the user's to move (owner 2026-08-22) ─────────────────

describe('POST /api/stt/model/root', () => {
  it('re-points the root, and the status answer reflects it at once', async () => {
    const target = mkdtempSync(join(tmpdir(), 'flowmic-route-root-'));
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'POST', STT_MODEL_ROOT_PATH, LOOPBACK, {}, { dir: target }).done;
    expect(out.status).toBe(200);
    const root = out.body['models_root'] as Record<string, unknown>;
    expect(root['dir']).toBe(target);
    expect(root['configured']).toBe(true);
  });

  it('reset returns to the default directory', async () => {
    const target = mkdtempSync(join(tmpdir(), 'flowmic-route-root2-'));
    const appData2 = mkdtempSync(join(tmpdir(), 'flowmic-route-appdata2-'));
    const env = { APPDATA: appData2, XDG_DATA_HOME: appData2 } as NodeJS.ProcessEnv;
    const h = handlerFor({ controller: readyController(), env });
    await call(h, 'POST', STT_MODEL_ROOT_PATH, LOOPBACK, {}, { dir: target }).done;
    const out = await call(h, 'POST', STT_MODEL_ROOT_PATH, LOOPBACK, {}, { reset: true }).done;
    const root = out.body['models_root'] as Record<string, unknown>;
    expect(root['configured']).toBe(false);
    expect(root['dir']).toBe(root['default_dir']);
  });

  it('a relative path is refused at the button, with the reason', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'POST', STT_MODEL_ROOT_PATH, LOOPBACK, {}, { dir: 'not/absolute' }).done;
    expect(out.status).toBe(400);
    expect(out.body['error']).toBe('MODEL_ROOT_INVALID');
  });

  it('refused while a download is writing into the old root', async () => {
    const busyOne = readyController();
    const target = mkdtempSync(join(tmpdir(), 'flowmic-route-root3-'));
    const h = handlerFor({ controller: readyController(), busy: busyOne });
    const out = await call(h, 'POST', STT_MODEL_ROOT_PATH, LOOPBACK, {}, { dir: target }).done;
    expect(out.status).toBe(409);
    expect(out.body['error']).toBe('MODEL_ROOT_BUSY');
  });
});

// ── CORS: the one browser these routes serve ─────────────────────────────────
//
// Measured live on 0.3.13 (owner report 2026-08-20): the server answered
// `state:"ready"` in full while the settings card showed 「Failed to fetch」 —
// the WebView (http://tauri.localhost) is cross-origin to 127.0.0.1:PORT, the
// response carried no access-control-allow-origin, and the then-preflighted
// GET died on a 405 to OPTIONS. Invisible to every earlier test here because
// CORS is enforced by the BROWSER — the exact 「bug lives in the layer the
// double replaced」 shape, so these cases pin the headers the browser keys on.
describe('CORS for the app WebView', () => {
  const TAURI_WIN = 'http://tauri.localhost';
  const TAURI_MAC = 'tauri://localhost';

  it('a preflight OPTIONS from the WebView gets 204 with the grant, not 405', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'OPTIONS', STT_MODEL_STATUS_PATH, LOOPBACK, {
      origin: TAURI_WIN,
      'access-control-request-method': 'GET',
    }).done;
    expect(out.status).toBe(204);
    expect(out.headers['access-control-allow-origin']).toBe(TAURI_WIN);
    expect(out.headers['access-control-allow-methods']).toContain('GET');
  });

  it('a GET from the WebView carries the echoed origin, so the browser hands the body over', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK, { origin: TAURI_WIN }).done;
    expect(out.status).toBe(200);
    expect(out.headers['access-control-allow-origin']).toBe(TAURI_WIN);
    expect(out.headers['vary']).toBe('origin');
  });

  it('the macOS WebView origin form is granted too', async () => {
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK, { origin: TAURI_MAC }).done;
    expect(out.headers['access-control-allow-origin']).toBe(TAURI_MAC);
  });

  it('🔴 a foreign origin gets NO grant — drive-by localhost probing stays blocked', async () => {
    // `*` would let any page in the user\'s ordinary browser read this state
    // and start a 228 MB download by fetching 127.0.0.1. The allow-list echo
    // means such a page keeps getting exactly what it gets today: nothing.
    const h = handlerFor({ controller: readyController() });
    const out = await call(h, 'GET', STT_MODEL_STATUS_PATH, LOOPBACK, {
      origin: 'https://evil.example',
    }).done;
    expect(out.status).toBe(200);
    expect(out.headers['access-control-allow-origin']).toBeUndefined();
  });
});

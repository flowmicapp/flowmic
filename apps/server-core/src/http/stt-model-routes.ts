// SPEC-REF:
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §4 (the three
//     routes and the snapshot whose field names are the contract), §2-3 (the
//     button in the interface IS the consent that ruling DISC-2 requires)
//   apps/server-core/src/http/inject-routes.ts (THE mounting precedent: a
//     standalone-only route, and the door is BRICKED UP in saas rather than
//     merely unlocked — see below)
//   apps/server-core/src/http/local-only.ts (RV-32: a mode gate is not an auth gate)
//   CLAUDE.md red line: no silent failure
//
// GET  /api/stt/model/status    — the §4 snapshot
// POST /api/stt/model/download  — start the one download, or report the running one
// POST /api/stt/model/cancel    — stop at a resumable point
//
// ── STANDALONE ONLY, AND THE DOOR IS BRICKED UP IN SAAS ─────────────────────
// The built-in recogniser is a LOCAL engine: the model file lives in the app
// data directory of the machine that runs the sidecar, and the cloud relay
// neither loads it nor has anywhere to put it. So `http/router.ts` mounts this
// module under `config.mode === 'standalone'` and in saas these three paths
// fall through to the router's 404 — the same 「not mounted in this
// deployment」 answer `/api/network`, `/api/probe/*` and `POST
// /api/inject/image` give.
//
// That is a BRICKED-UP door, not an unlocked one, and the difference is worth
// stating because the next audit of 「is this route safe on the public relay?」
// deserves an answer rather than a hole: there is no credential to add here and
// no rate limit to tune, because in saas the code below is never reached. What
// WOULD have to come with it, on the day someone unbricks it for some other
// reason: a per-account notion of whose model this is (there is none — the
// install directory is a property of the host, not of a user), and a decision
// about a public endpoint that makes the server pull 229 MB from a third party
// on request. Neither is a line of code; both are the reason this stays local.
//
// ── AND A MODE GATE IS NOT AN AUTH GATE (RV-32) ─────────────────────────────
// standalone binds every interface, because a phone with no token yet has to be
// able to reach it. So 「standalone-only」 does NOT mean 「the owner only」: it
// would leave anyone on the owner's LAN able to POST /download and make the
// owner's PC pull 229 MB, over and over, from a source they chose out of our
// manifest. These routes therefore carry the same local-only refusal
// `/api/probe/*` does — the desktop shell interrogating its own sidecar is the
// only legitimate caller, and it is always on loopback.
//
// ── NOT IN THE ADMIN-GATE FENCE, AND THAT IS A DECISION ─────────────────────
// This file is deliberately absent from `ADMIN_GATED_ROUTES` (http/ops-audit-trail.ts)
// and from `test/console-admin-gate-coverage.test.ts`'s ROUTE_SOURCES, the same
// standing `status-routes.ts` records for itself. That fence classifies routes
// that carry an ACCOUNT credential; these carry none and cannot — standalone has
// no account layer at all, and the only caller is this machine's own shell.
// 🔴 The day this file grows a route that takes a credential or answers
// per-account, registering it there is part of shipping it: a route added where
// the scanner is not looking is invisible to the scanner, and that suite's
// header says it has caught the shape twice.
//
// ⚠️ ZERO PROTOCOL SURFACE: http routes, not socket events. No whitelist entry,
// no count guard, and no ErrorCode registry involvement — the `error.code` in
// the snapshot is a download-surface reason string with the same standing as
// `LOCAL_ONLY` (see model-status.ts ModelErrorCode for why it must not become a
// protocol code without the owner).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './body';
import { isLocalRequest, refuseNonLocal } from './local-only';
import { getSherpaModelController, type SherpaModelController } from '../stt/sherpa/model-downloader';
import { resolveSherpaModelDir } from '../stt/sherpa/model-manifest';

export const STT_MODEL_STATUS_PATH = '/api/stt/model/status';
export const STT_MODEL_DOWNLOAD_PATH = '/api/stt/model/download';
export const STT_MODEL_CANCEL_PATH = '/api/stt/model/cancel';

/** Every path this module owns. Exported so the router's mount and the tests
 *  agree on one list rather than each keeping its own copy. */
export const STT_MODEL_ROUTE_PATHS: readonly string[] = [
  STT_MODEL_STATUS_PATH,
  STT_MODEL_DOWNLOAD_PATH,
  STT_MODEL_CANCEL_PATH,
];

export interface SttModelRoutesDeps {
  /** Test seam: the controller under test. Production passes nothing and the
   *  module resolves the per-directory singleton — the SAME one the speak-time
   *  path uses, which is what makes the single flight single. */
  controller?: SherpaModelController;
}

/**
 * @returns true iff this module handled the request.
 */
export function tryHandleSttModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SttModelRoutesDeps = {},
): boolean {
  const raw = req.url ?? '/';
  const url = raw.split('?')[0] ?? '';
  if (!STT_MODEL_ROUTE_PATHS.includes(url)) return false;

  // RV-32 — before anything else, and before any work: a refused caller must
  // not be able to make this process stat a directory, let alone start a
  // download. Named 403 rather than a silent drop, per the red line.
  if (!isLocalRequest(req)) {
    refuseNonLocal(req, res, url);
    return true;
  }

  // ── CORS, for the ONE browser these routes serve ──────────────────────────
  //
  // The settings card fetches these routes from the app's own WebView, and a
  // WebView is a browser: its origin (http://tauri.localhost on Windows,
  // tauri://localhost on macOS) is cross-origin to 127.0.0.1:PORT, so without
  // these headers the browser discards the answer and the card reads
  // 「Failed to fetch」 forever. That is not a hypothesis: measured live on
  // 0.3.13 (owner report 2026-08-20) — the server answered `state:"ready"`
  // in full while the card showed 「未知」, because the response carried no
  // access-control-allow-origin and the preflight OPTIONS got this 405.
  //
  // 🔴 An ALLOW-LIST echo, deliberately not `*`: these are loopback routes,
  // and `*` would let any web page open in the user's ordinary browser read
  // this state and POST a 228 MB download by fetching 127.0.0.1 (drive-by
  // localhost probing). A page that is not our WebView gets no CORS header
  // and stays blocked, exactly as today.
  const origin = req.headers.origin;
  const webviewOrigin =
    typeof origin === 'string' && /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/.test(origin)
      ? origin
      : null;
  if (webviewOrigin !== null) {
    res.setHeader('access-control-allow-origin', webviewOrigin);
    res.setHeader('vary', 'origin');
  }

  const method = req.method ?? 'GET';
  // The preflight. The card's fetch is shaped to be a simple request (no
  // custom headers — see model-client.ts call()), so in the healthy world no
  // preflight arrives; this branch exists so that a header added in some
  // future refactor degrades to a working preflight instead of resurrecting
  // the silent 405 this comment's incident note describes.
  if (method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.statusCode = 204;
    res.end();
    return true;
  }
  const wanted = url === STT_MODEL_STATUS_PATH ? 'GET' : 'POST';
  if (method !== wanted) {
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: `${url} answers ${wanted}` });
    return true;
  }

  // 🔴 THE TWO POSTs TAKE NO INPUT AT ALL, and that is a property worth naming:
  // unlike `/api/probe/*` — which exists to dial an address the CALLER names,
  // and is local-only for exactly that reason — nothing here is parameterised.
  // The directory comes from the manifest, the sources come from the manifest,
  // the size comes from the manifest. There is no body to validate because
  // there is no field a caller could supply, and none may be added without
  // re-answering the question this comment settles.
  // The body is drained rather than read: a caller that sends one (the desktop
  // sends `{}`) must not leave unread bytes on a keep-alive connection.
  if (method === 'POST') req.resume();

  const controller = deps.controller ?? getSherpaModelController(resolveSherpaModelDir());

  void (async () => {
    try {
      if (url === STT_MODEL_STATUS_PATH) {
        // `?verify=1` re-reads every byte instead of trusting the stat-keyed
        // memo — it is what the settings card's 「check the files again」 button
        // must call, because the plain poll may answer from the memo and would
        // otherwise let that button report 「checked」 without checking.
        //
        // A QUERY PARAMETER rather than a fourth route: it asks the same
        // question status asks (are the files right), it just refuses to accept
        // a remembered answer. A separate path would imply a separate question
        // and would want its own entry in the §3 state machine, which it has
        // none of — the answer is still one of the same five states.
        const verify = /[?&]verify=1(&|$)/.test(raw);
        sendJson(res, 200, await controller.snapshot(verify));
        return;
      }
      if (url === STT_MODEL_DOWNLOAD_PATH) {
        // 🔴 THIS POST IS THE CONSENT (design §2-3). Nothing else on this path
        // consults an environment variable, and nothing may: the ruling that
        // made downloading opt-in asked for an explicit human decision, and
        // requiring BOTH the button and an env var would mean the button does
        // not work, which is the shape 「a control that changes nothing」.
        sendJson(res, 200, await controller.start());
        return;
      }
      sendJson(res, 200, await controller.cancel());
    } catch (err) {
      // The controller records failures in the snapshot rather than throwing,
      // so reaching here means the STATUS layer itself broke (an unreadable
      // directory, say). Answer it out loud instead of hanging the request:
      // a settings card that polls forever against a dead socket shows the user
      // a spinner that means nothing.
      sendJson(res, 500, {
        ok: false,
        error: 'MODEL_STATUS_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return true;
}

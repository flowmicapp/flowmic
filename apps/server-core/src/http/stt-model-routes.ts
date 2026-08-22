// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §7 (the routes grow on the existing three paths; download/cancel carry
//     `model_id`; a body-less download must fail loud, never silently fetch
//     SenseVoice; machine-wide single flight), owner addition 2026-08-22
//     (the models root must be user-changeable)
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §4 (snapshot
//     field names are the contract; bytes_total null-vs-0)
//   apps/server-core/src/http/inject-routes.ts (mounting precedent: bricked
//     up in saas), local-only.ts (RV-32: a mode gate is not an auth gate)
//   CLAUDE.md red line: no silent failure
//
// GET  /api/stt/model/status    — catalog + per-model snapshots + selection +
//                                 models root (+ legacy top-level SenseVoice
//                                 snapshot for anything still reading it)
// POST /api/stt/model/download  — {model_id, lang?}: start THE one download
//                                 (machine-wide single flight), or — when the
//                                 named model is already ready — record the
//                                 per-language selection and return at once
// POST /api/stt/model/cancel    — {model_id}: stop at a resumable point
// POST /api/stt/model/root      — {dir} | {reset:true}: re-point where model
//                                 packs are downloaded (owner 2026-08-22)
//
// ── STANDALONE ONLY, AND THE DOOR IS BRICKED UP IN SAAS ─────────────────────
// Unchanged from the pre-LM-CAT header: `http/router.ts` mounts this module
// only under `config.mode === 'standalone'`; in saas these paths 404. The
// cloud relay neither loads local models nor has anywhere to put them.
//
// ── AND A MODE GATE IS NOT AN AUTH GATE (RV-32) ─────────────────────────────
// Also unchanged: every path here carries the local-only refusal. The desktop
// shell interrogating its own sidecar is the only legitimate caller.
//
// ── THE POSTs NOW TAKE INPUT, AND THAT IS A RE-ANSWERED QUESTION ────────────
// The pre-LM-CAT file pinned "the two POSTs take no input at all" and said
// none may be added without re-answering it. Re-answered:
//   · `model_id` / `lang` are CLOSED-SET values — validated against the
//     catalog before anything touches the filesystem. A caller cannot name a
//     path, a URL or a size; it can only pick a row we shipped.
//   · `dir` (root route only) IS an arbitrary path, and that is the feature:
//     the user choosing where their own machine stores model packs — the same
//     authority any save-as dialog grants. It is loopback-only (RV-32 gate
//     above), absolute-path-validated, created and WRITE-PROBED before the
//     pointer moves, and refused outright while a download is writing into
//     the old root (`.part` files must not lose their directory mid-write).
//
// ⚠️ ZERO PROTOCOL SURFACE: http routes, not socket events; reason strings
// here (MODEL_UNKNOWN, MODEL_DOWNLOAD_BUSY, …) have the same standing as
// LOCAL_ONLY and must not become protocol ErrorCodes without the owner.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBounded, sendJson } from './body';
import { isLocalRequest, refuseNonLocal } from './local-only';
import {
  busyModelController, getModelController, ModelNotDownloadableError,
  type ModelStatusSnapshot,
} from '../stt/sherpa/model-downloader';
import {
  configuredModelsRoot, defaultModelsRoot, resolveModelsRoot, setModelsRoot,
} from '../stt/sherpa/model-manifest';
import {
  catalogModelById, CATALOG_SPOKEN_LANGS, MODEL_CATALOG, SENSE_VOICE_MODEL_ID,
  type CatalogModel,
} from '../stt/sherpa/model-catalog';
import { declaredTotalBytes } from '../stt/sherpa/model-status';
import { readModelSelection, writeModelSelection } from '../stt/sherpa/model-selection';

export const STT_MODEL_STATUS_PATH = '/api/stt/model/status';
export const STT_MODEL_DOWNLOAD_PATH = '/api/stt/model/download';
export const STT_MODEL_CANCEL_PATH = '/api/stt/model/cancel';
export const STT_MODEL_ROOT_PATH = '/api/stt/model/root';

/** Every path this module owns. Exported so the router's mount and the tests
 *  agree on one list rather than each keeping its own copy. */
export const STT_MODEL_ROUTE_PATHS: readonly string[] = [
  STT_MODEL_STATUS_PATH,
  STT_MODEL_DOWNLOAD_PATH,
  STT_MODEL_CANCEL_PATH,
  STT_MODEL_ROOT_PATH,
];

/** POST bodies are tiny JSON objects; anything past this is not one of ours. */
const BODY_CAP = 4_096;

export interface SttModelRoutesDeps {
  /** Test seam: resolve the controller for a catalog row. Production resolves
   *  the per-directory singleton — the SAME one the speak-time path uses,
   *  which is what makes the single flight single. */
  controllerFor?: (row: CatalogModel) => ReturnType<typeof getModelController>;
  /** Test seam: the machine-wide busy scan. */
  busyController?: typeof busyModelController;
  env?: NodeJS.ProcessEnv;
}

/** The read-only catalog projection the settings card renders (LM-CAT §7):
 *  facts about the PACK, not about this machine's disk — disk state rides in
 *  `models[]`. */
function catalogProjection(): unknown[] {
  return MODEL_CATALOG.map((m) => ({
    model_id: m.model_id,
    spoken: m.spoken,
    tier: m.tier,
    loader: m.loader,
    license_class: m.license_class,
    license: m.license_spdx_or_name,
    attribution: m.attribution,
    streaming: m.streaming,
    // Empty file list (streaming rows) ⇒ null, NOT the default manifest's
    // total — declaredTotalBytes' parameter default is the SenseVoice files
    // and reaching it from here would put SenseVoice's size on another row.
    bytes_total: m.files.length > 0 ? declaredTotalBytes(m.files) : null,
  }));
}

async function fullStatusBody(deps: SttModelRoutesDeps, opts: { verify?: boolean; verifyModelId?: string } = {}): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const controllerFor = deps.controllerFor ?? ((row: CatalogModel) => getModelController(row, env));
  const models: ModelStatusSnapshot[] = [];
  let legacy: ModelStatusSnapshot | null = null;
  for (const row of MODEL_CATALOG) {
    const verifyThis = opts.verify === true &&
      (opts.verifyModelId === undefined || opts.verifyModelId === row.model_id);
    const snap = await controllerFor(row).snapshot(verifyThis);
    models.push(snap);
    if (row.model_id === SENSE_VOICE_MODEL_ID) legacy = snap;
  }
  const busy = (deps.busyController ?? busyModelController)();
  return {
    // Legacy top-level shape: the SenseVoice row's snapshot, byte-compatible
    // with the pre-LM-CAT single-model contract so an older reader keeps
    // getting the answer it always got.
    ...(legacy ?? {}),
    catalog: catalogProjection(),
    models,
    selected_by_lang: readModelSelection(env),
    spoken_langs: CATALOG_SPOKEN_LANGS,
    models_root: {
      dir: resolveModelsRoot(env),
      default_dir: defaultModelsRoot(env),
      configured: configuredModelsRoot(env) !== null,
    },
    busy_model_id: busy ? busy.modelId : null,
  };
}

function parseBody(raw: string): Record<string, unknown> | null {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
  // (Unchanged from pre-LM-CAT; the incident note lives in git history and the
  // model-client.ts call() comment.) Allow-list echo, deliberately not `*`:
  // a drive-by page in the user's ordinary browser must not read this state
  // or POST a 500 MB download at 127.0.0.1.
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
  // The preflight: the card's fetches are shaped to be simple requests (no
  // custom headers), so in the healthy world no preflight arrives; this
  // branch keeps a future refactor from resurrecting the silent 405.
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

  void (async () => {
    try {
      if (url === STT_MODEL_STATUS_PATH) {
        // `?verify=1` re-hashes instead of trusting the stat-keyed memo — the
        // card's 「check the files again」 button. `&model_id=…` narrows the
        // re-hash to one row (re-hashing every installed pack is an explicit
        // choice, not a side effect of pressing one row's button).
        const verify = /[?&]verify=1(&|$)/.test(rawUrlOf(req));
        const m = /[?&]model_id=([^&]+)/.exec(rawUrlOf(req));
        sendJson(res, 200, await fullStatusBody(deps, {
          verify,
          ...(m?.[1] ? { verifyModelId: decodeURIComponent(m[1]) } : {}),
        }));
        return;
      }

      const rawBody = await readBounded(req, BODY_CAP);
      if (rawBody === 'TOO_LARGE') {
        sendJson(res, 413, { ok: false, error: 'BODY_TOO_LARGE', message: `body over ${BODY_CAP} bytes` });
        return;
      }
      const body = parseBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: 'BAD_BODY', message: 'body must be a JSON object' });
        return;
      }

      if (url === STT_MODEL_ROOT_PATH) {
        await handleRootChange(res, body, deps);
        return;
      }

      // download / cancel — both REQUIRE model_id (LM-CAT §7). The pre-LM-CAT
      // desktop sent `{}` meaning "the SenseVoice model"; answering that with
      // a silent SenseVoice fetch would make "the user picks which pack" a
      // fiction, so it is a loud 400 instead.
      const modelId = typeof body.model_id === 'string' ? body.model_id : '';
      if (modelId === '') {
        sendJson(res, 400, {
          ok: false, error: 'MODEL_ID_REQUIRED',
          message: 'body must name a catalog model_id — downloads are per-pack now',
        });
        return;
      }
      const row = catalogModelById(modelId);
      if (row === null) {
        sendJson(res, 404, { ok: false, error: 'MODEL_UNKNOWN', message: `'${modelId}' is not in the model catalog` });
        return;
      }
      const env = deps.env ?? process.env;
      const controller = (deps.controllerFor ?? ((r: CatalogModel) => getModelController(r, env)))(row);

      if (url === STT_MODEL_DOWNLOAD_PATH) {
        // 🔴 THIS POST IS THE CONSENT (design §2-3): the button names a pack,
        // this call fetches that pack, nothing else consults an env var.
        const lang = typeof body.lang === 'string' ? body.lang : '';
        if (lang !== '') {
          // Selection rides the same POST: pressing a pack's button UNDER a
          // language IS choosing that pack for that language (LM-CAT §6-1).
          // Validated before any network so a bad pair cannot be persisted.
          try {
            writeModelSelection(lang, modelId, env);
          } catch (err) {
            sendJson(res, 400, {
              ok: false, error: 'MODEL_LANG_MISMATCH',
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        // Machine-wide single flight (LM-CAT §7): one pack at a time. The
        // scan and the claim run in one synchronous stretch (claim() is
        // synchronous by contract), so two same-tick POSTs cannot both pass.
        const busy = (deps.busyController ?? busyModelController)();
        if (busy !== null && busy !== controller) {
          sendJson(res, 409, {
            ok: false, error: 'MODEL_DOWNLOAD_BUSY',
            busy_model_id: busy.modelId,
            message: `'${busy.modelId}' is downloading; one pack at a time`,
          });
          return;
        }
        const first = controller.start();
        await first;
        sendJson(res, 200, await fullStatusBody(deps));
        return;
      }

      // cancel
      await controller.cancel();
      sendJson(res, 200, await fullStatusBody(deps));
    } catch (err) {
      if (err instanceof ModelNotDownloadableError) {
        // The streaming row's named refusal (LM-CAT §5): the pack exists, the
        // loader for it does not ship yet — neither a 404 nor a mystery 500.
        sendJson(res, 409, { ok: false, error: 'MODEL_STREAMING_UNSUPPORTED', message: err.message });
        return;
      }
      // Reaching here means the STATUS layer itself broke (an unreadable
      // directory, say). Answer it out loud instead of hanging the request.
      sendJson(res, 500, {
        ok: false,
        error: 'MODEL_STATUS_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return true;
}

function rawUrlOf(req: IncomingMessage): string {
  return req.url ?? '/';
}

/** POST /api/stt/model/root — see the header's re-answered question for why a
 *  caller-named path is acceptable HERE and nowhere else in this module. */
async function handleRootChange(
  res: ServerResponse,
  body: Record<string, unknown>,
  deps: SttModelRoutesDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const busy = (deps.busyController ?? busyModelController)();
  if (busy !== null) {
    // Moving the root while `.part` files are being appended under the old
    // one would strand the very bytes the user is watching arrive.
    sendJson(res, 409, {
      ok: false, error: 'MODEL_ROOT_BUSY', busy_model_id: busy.modelId,
      message: 'a model is downloading; cancel it before changing the folder',
    });
    return;
  }
  const reset = body.reset === true;
  const dir = typeof body.dir === 'string' ? body.dir : '';
  if (!reset && dir === '') {
    sendJson(res, 400, { ok: false, error: 'MODEL_ROOT_INVALID', message: 'body must carry {dir} or {reset:true}' });
    return;
  }
  try {
    setModelsRoot(reset ? null : dir, env);
  } catch (err) {
    // Not absolute / not creatable / not writable — the refusal happens at
    // the button, with the reason, never later at download time.
    sendJson(res, 400, {
      ok: false, error: 'MODEL_ROOT_INVALID',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  sendJson(res, 200, await fullStatusBody(deps));
}

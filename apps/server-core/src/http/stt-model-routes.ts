// SPEC-REF:
//   docs/archive/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
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
// POST /api/stt/model/delete    — {model_id}: remove one pack's files and
//                                 report the bytes freed (NR-7, owner ruling
//                                 2026-09-02 §5)
//
// ── THE DELETE GUARD LIVES HERE, NOT ON A DISABLED BUTTON (NR-7) ────────────
// 「当前在用模型不许删」 is enforced in [handleDelete] below, against
// `model-in-use.ts`, BEFORE anything touches the filesystem. The desktop card
// also disables the control — but a card is a cached render of a fact that can
// change between the poll and the press (a selection made in another window,
// a recognizer loaded by an utterance that started a second ago), and a stale
// screen must not be able to delete the pack that is transcribing. The status
// body now carries `in_use_model_ids` so the button and this guard read ONE
// computation rather than two that can disagree. [MODEL_DELETE_GUARD]
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
import { clearModelSelectionFor, readModelSelection, writeModelSelection } from '../stt/sherpa/model-selection';
import { modelsInUse, type InUseReason } from '../stt/sherpa/model-in-use';
import { deleteModelDir, ModelDeleteRefused } from '../stt/sherpa/model-delete';
import { dropModelController } from '../stt/sherpa/model-downloader';
import { log } from '../log';

export const STT_MODEL_STATUS_PATH = '/api/stt/model/status';
export const STT_MODEL_DOWNLOAD_PATH = '/api/stt/model/download';
export const STT_MODEL_CANCEL_PATH = '/api/stt/model/cancel';
export const STT_MODEL_ROOT_PATH = '/api/stt/model/root';
export const STT_MODEL_DELETE_PATH = '/api/stt/model/delete';

/** Every path this module owns. Exported so the router's mount and the tests
 *  agree on one list rather than each keeping its own copy. */
export const STT_MODEL_ROUTE_PATHS: readonly string[] = [
  STT_MODEL_STATUS_PATH,
  STT_MODEL_DOWNLOAD_PATH,
  STT_MODEL_CANCEL_PATH,
  STT_MODEL_ROOT_PATH,
  STT_MODEL_DELETE_PATH,
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
  /** Test seam: which packs are in use. Production resolves the §6 ladder over
   *  the real catalog (model-in-use.ts), which needs byte-correct model files
   *  on disk — the same reason `model-resolve.ts` carries `ResolveSeams`. */
  inUse?: () => Promise<Map<string, InUseReason>>;
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
  // NR-7 — the SAME computation the delete guard runs, so the card's disabled
  // state and the refusal cannot answer differently. Ids only: the REASON is
  // per-refusal (it names the language or the live recognizer) and belongs on
  // the answer to a press, not on a poll every ten seconds.
  const inUse = await (deps.inUse ?? (() => modelsInUse(env)))();
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
    in_use_model_ids: [...inUse.keys()],
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

      if (url === STT_MODEL_DELETE_PATH) {
        await handleDelete(res, row, controller, deps, env);
        return;
      }

      if (url === STT_MODEL_DOWNLOAD_PATH) {
        // 🔴 THIS POST IS THE CONSENT (design §2-3): the button names a pack,
        // this call fetches that pack, nothing else consults an env var.
        //
        // 🔴 card B2-G (2026-09-02) — the busy check now runs BEFORE the
        // selection write, not after. This block used to persist "for this
        // language, use this pack" first and check single-flight second, so a
        // press that was refused with 409 (another pack already downloading)
        // still recorded the preference for a pack whose download never
        // started. `model-resolve.ts`'s §6 ladder degrades gracefully when the
        // selected pack is not ready (falls to rung 2), so this never crossed
        // the model-form red line (借用一个转录不了这个语言的模型) — but it did
        // let a REFUSED action silently change what the settings page reports
        // as the user's choice for that language, with nothing telling them
        // the pairing they see is not the one they pressed. A refused press
        // must persist nothing.
        const busy = (deps.busyController ?? busyModelController)();
        if (busy !== null && busy !== controller) {
          sendJson(res, 409, {
            ok: false, error: 'MODEL_DOWNLOAD_BUSY',
            busy_model_id: busy.modelId,
            message: `'${busy.modelId}' is downloading; one pack at a time`,
          });
          return;
        }
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

/**
 * POST /api/stt/model/delete — NR-7. [MODEL_DELETE_GUARD]
 *
 * Order is the whole design, and every step refuses BEFORE the next one can
 * change anything on disk:
 *   1. is a download writing into this pack right now?  ⇒ 409, nothing removed
 *      (the `.part` files it is appending to are exactly what a recursive
 *      remove would pull out from under it);
 *   2. is it IN USE?                                     ⇒ 409, nothing removed
 *      — the owner's ruling, enforced here rather than by the card's disabled
 *      button, because a card is a render of a fact that may have changed since
 *      the poll;
 *   3. containment                                       ⇒ 400, nothing removed
 *      (model-delete.ts owns this one);
 *   4. remove — a removal that fails PARTWAY is answered by name
 *      (`MODEL_DELETE_FAILED`, with the errno), not left to surface as the
 *      status layer's generic 500. NR-49: this is where the one reason the
 *      recognizer hold still had — a future onnxruntime that memory-maps its
 *      weights, under which Windows would refuse to unlink a mapped file — is
 *      handled. It is handled AT the failure instead of by refusing every
 *      delete in advance of it;
 *   5. clear the per-language pairings that named this pack (owner ruling
 *      2026-09-16 §1, 「已有的配对要留空」) and then forget the controller, so
 *      the status body this call answers with is already about the directory
 *      as it is now rather than about the pack that used to be there.
 *
 * ⚠️ ORDER INSIDE STEP 5 IS NOT COSMETIC: the pairings are cleared only after
 * the bytes are actually gone. A refused delete must persist nothing — the
 * same ordering rule card B2-G established on the download side.
 *
 * ⚠️ The reason strings below are MACHINE reasons in the same register as this
 * module's siblings (`MODEL_DOWNLOAD_BUSY`, `MODEL_ROOT_BUSY`): they reach the
 * desktop card's technical fold, not its body copy. The sentence a user reads
 * for a refused delete is a catalogue key, and as of this commit that key does
 * not exist yet — the card therefore keeps the control DISABLED for an in-use
 * pack and does not invent a sentence for the fold to contradict.
 */
async function handleDelete(
  res: ServerResponse,
  row: CatalogModel,
  controller: ReturnType<typeof getModelController>,
  deps: SttModelRoutesDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (controller.busy) {
    sendJson(res, 409, {
      ok: false, error: 'MODEL_DELETE_BUSY', busy_model_id: row.model_id,
      message: `'${row.model_id}' is downloading; cancel it before deleting it`,
    });
    return;
  }
  const inUse = await (deps.inUse ?? (() => modelsInUse(env)))();
  const reason = inUse.get(row.model_id);
  if (reason !== undefined) {
    sendJson(res, 409, {
      ok: false, error: 'MODEL_IN_USE', model_id: row.model_id, in_use_reason: reason,
      message: `'${row.model_id}' is the model that would open for a language in use`,
    });
    return;
  }
  let freed: number;
  try {
    freed = deleteModelDir(row.model_id, env).freed_bytes;
  } catch (err) {
    if (err instanceof ModelDeleteRefused) {
      sendJson(res, 400, { ok: false, error: err.refusal, message: err.message });
      return;
    }
    // NR-49 — the removal itself failed (EBUSY/EPERM on a platform that holds
    // the weight files open, a permission change under the root). Named here
    // so the card's technical fold gets the errno: the generic catch below
    // would have called this 'MODEL_STATUS_UNAVAILABLE', which is a true
    // sentence about the wrong subject. Nothing is cleared — the pairings
    // still point at a pack whose bytes may be partly there, which is what
    // the next status read will report as `partial`.
    sendJson(res, 500, {
      ok: false, error: 'MODEL_DELETE_FAILED', model_id: row.model_id,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // Owner ruling 2026-09-16 §1 — 「已有的配对要留空」. After the bytes, before
  // the status body: `fullStatusBody` re-reads the selection file, so the
  // `selected_by_lang` this response carries is already the cleared one and the
  // card cannot render one stale in-use chip even for a frame.
  const clearedLangs = clearModelSelectionFor(row.model_id, env);
  if (clearedLangs.length > 0) {
    // Where a support conversation gets the answer to 「why did my pick
    // disappear」 for a machine nobody is watching. It stays even though the
    // card now says it too: the response is read once, by one window, and is
    // gone; this line is on disk.
    log.info('stt.model delete cleared per-language pairings', {
      model_id: row.model_id, langs: clearedLangs,
    });
  }
  dropModelController(controller.dir);
  sendJson(res, 200, {
    ...(await fullStatusBody(deps)),
    deleted_model_id: row.model_id,
    freed_bytes: freed,
    // NR-49b — WHICH languages were emptied. Withheld in the first half of
    // NR-49 because nothing read it, and a field with no reader is this repo's
    // #1 shape; the reader now exists and is named:
    // LocalModelCard.vue's `model_cleared_langs` line, fed through
    // model-client.ts `modelStore.clearedLangs`.
    //
    // 🔴 WHY THE CARD CANNOT DERIVE IT FROM `selected_by_lang`. What the card
    // holds after adopting this body is the state AFTER the clear; the
    // languages that were emptied are exactly the keys that are no longer in
    // it, and a difference needs BOTH sides. The card could have diffed against
    // its previous poll — and then the sentence would be a function of whether
    // a poll happened to have landed, which is the shape where a screen is
    // right on a fast machine and silent on a slow one.
    //
    // 🔴 ALWAYS PRESENT, `[]` WHEN NOTHING WAS PAIRED — not omitted. `absent`
    // and `empty` are two facts, and a consumer that reads a missing key as
    // 「none」 cannot tell an old server from a delete that cleared nothing.
    cleared_langs: clearedLangs,
  });
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

// SPEC-REF:
//   docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md (LM-CAT)
//     §4 (SHERPA_REPO / SHERPA_MODEL_FILES demoted to aliases of the catalog's
//     SenseVoice row — no second source of "what is the current model id"),
//     the owner's 2026-08-22 addition (the models root must be changeable)
//   docs/strategy/spikes/sherpa-onnx-spike.md §6.3 (app-data install dir)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (engine #7 sherpa-local)
//
// Install-directory resolution for local STT models, plus the LEGACY aliases
// of the SenseVoice catalog row. Until LM-CAT this file WAS the whole model
// registry (one repo id, one file list); the registry is now
// `model-catalog.ts` and everything here is derived from it. Adding a model
// means adding a catalog row, never a constant here.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  catalogModelById, SENSE_VOICE_MODEL_ID, type CatalogModel,
} from './model-catalog';

export type { ModelFile, ModelSource } from './model-manifest-types';
export { sherpaModelCanRecognize } from './model-catalog';

// ── legacy aliases of the SenseVoice row ────────────────────────────────────
// Kept because scripts and the spike docs name them; each is a VIEW of the
// catalog row, so the two can never disagree.

const SENSE_VOICE_ROW: CatalogModel = (() => {
  const row = catalogModelById(SENSE_VOICE_MODEL_ID);
  if (!row) throw new Error(`model catalog lost its SenseVoice row (${SENSE_VOICE_MODEL_ID})`);
  return row;
})();

/** k2-fsa pre-exported SenseVoice model repo id — the catalog row's id. */
export const SHERPA_REPO = SENSE_VOICE_ROW.model_id;

/** The SenseVoice row's file manifest (size + pinned SHA-256 gates). */
export const SHERPA_MODEL_FILES = SENSE_VOICE_ROW.files;

/** The SenseVoice row's ordered per-file sources (HF → hf-mirror). */
export const SHERPA_PER_FILE_SOURCES = SENSE_VOICE_ROW.sources;

/** The SenseVoice row's whole-archive fallback URL. */
export const SHERPA_GITHUB_TARBALL = SENSE_VOICE_ROW.tarball!.url;

// ── the models root, and the owner-ruled way to change it ───────────────────
//
// Until 2026-08-22 the root was hard-wired to the per-user app data dir. The
// owner's addition to LM-CAT: 「模型下载的目录要能改」 — the download directory
// must be user-changeable. The chosen mechanism is a tiny POINTER FILE at a
// FIXED location (the app data dir we already own), because the pointer to a
// movable directory cannot itself live in the movable directory:
//
//   %APPDATA%/FlowMic/stt-models-root.json   { "models_root": "D:\\voice" }
//
// · No pointer file (or an invalid one) ⇒ the historical default
//   %APPDATA%/FlowMic/models. Existing installs see no change.
// · Changing the root does NOT move already-downloaded bytes — the settings
//   card says so in as many words. Models simply resolve absent under the new
//   root until downloaded (or moved by hand) there.
// · Read on every resolution rather than cached: the file is ~100 bytes, the
//   hot path stats a directory right afterwards anyway, and a cache would need
//   an invalidation story across the http route that writes it.

const ROOT_POINTER_FILE = 'stt-models-root.json';

function appDataBase(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
}

/** Where the pointer file itself lives — fixed, never under the movable root. */
export function modelsRootPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDataBase(env), 'FlowMic', ROOT_POINTER_FILE);
}

/** The default root when nobody configured one. */
export function defaultModelsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDataBase(env), 'FlowMic', 'models');
}

/** The configured root, or null when none/invalid. Never throws: an unreadable
 *  pointer means "not configured", loudly loggable by callers that care. */
export function configuredModelsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const raw = readFileSync(modelsRootPointerPath(env), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const dir = (parsed as { models_root?: unknown }).models_root;
    return typeof dir === 'string' && dir.length > 0 && isAbsolute(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** The directory all per-model subdirectories live under. */
export function resolveModelsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return configuredModelsRoot(env) ?? defaultModelsRoot(env);
}

/**
 * Persist a new models root (or reset to the default with `null`).
 * Validates hard — an invalid directory must fail HERE, at the button, not
 * later at download time when the user has walked away:
 *   · absolute path only (a relative one would silently key off the sidecar's
 *     cwd, which is not a place, it is a launch accident);
 *   · created if missing, then write-probed — "you may not write here" is the
 *     answer the card needs NOW, not mid-download.
 * Atomic pointer write (tmp + rename), same discipline as every other
 * settings file. THROWS on refusal; the http route turns that into a 400.
 */
export function setModelsRoot(dir: string | null, env: NodeJS.ProcessEnv = process.env): void {
  const pointer = modelsRootPointerPath(env);
  if (dir === null) {
    rmSync(pointer, { force: true });
    return;
  }
  const trimmed = dir.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new Error(`models root must be an absolute path (got '${dir}')`);
  }
  mkdirSync(trimmed, { recursive: true });
  const probe = join(trimmed, `.flowmic-write-probe-${process.pid}`);
  writeFileSync(probe, 'probe');
  rmSync(probe, { force: true });
  mkdirSync(join(pointer, '..'), { recursive: true });
  const tmp = `${pointer}.tmp`;
  writeFileSync(tmp, JSON.stringify({ models_root: trimmed }, null, 2));
  renameSync(tmp, pointer);
}

/**
 * Resolve the install directory for ONE catalog model.
 *
 * `FLOWMIC_SHERPA_MODEL_DIR` still overrides — it is the single-model debug
 * path the re-runnable spike/measure scripts depend on, and with it set EVERY
 * id resolves to the same directory (meaningful only when exactly one model is
 * being driven, which is what those scripts do). Production resolution is
 * `<models root>/<model_id>`.
 */
export function resolveModelDir(modelId: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWMIC_SHERPA_MODEL_DIR;
  if (override && override.length > 0) return override;
  return join(resolveModelsRoot(env), modelId);
}

/** Legacy name: the SenseVoice row's directory (probe-routes, spike scripts). */
export function resolveSherpaModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelDir(SHERPA_REPO, env);
}

/** True iff the models root pointer's PARENT app-data dir exists — a cheap
 *  sanity the http route uses to distinguish "fresh machine" from "broken
 *  write" in its refusal detail. */
export function modelsRootParentExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(appDataBase(env), 'FlowMic'));
}

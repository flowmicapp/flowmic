// SPEC-REF:
//   NR-7 / owner ruling 2026-09-02 §5 — see model-in-use.ts for the ruling and
//   for where 「in use」 is defined. THIS file does not decide whether a pack
//   may go; it decides WHERE a removal is allowed to reach and HOW MANY BYTES
//   it freed.
//
// ── THE ONE THING THIS FILE EXISTS FOR: CONTAINMENT ─────────────────────────
// `rmSync(dir, { recursive: true })` is the most destructive call in this
// package. Everything below is the assertion that `dir` is a DIRECT CHILD of
// the models root and nothing else — resolved first, so a `..` segment, an
// absolute id, or a symlinked model directory cannot make the recursion land
// somewhere the user never pointed us at. [MODEL_DELETE_CONTAINMENT]
//
// 🔴 THE OVERRIDE IS REFUSED, AND THAT IS THE POINT. `resolveModelDir` honours
// `FLOWMIC_SHERPA_MODEL_DIR` — the single-model debug path the spike/measure
// scripts stage by hand, frequently OUTSIDE the models root and frequently a
// directory holding other work. Under that override every id resolves to the
// same directory, so 「delete the compact pack」 would remove the staged
// everything. The containment assert refuses it without needing to know the
// override exists, which is the reason the check is on the RESOLVED PATH and
// not on the model id.
//
// ⚠️ MEASURED, NOT DECLARED. `freed_bytes` is a walk of the directory, not the
// manifest's declared total: what a deletion frees includes `.part` remainders
// and anything else living in the pack's folder, and the number the card
// showed before the press has to be the number that actually leaves the disk.

import { lstatSync, readdirSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveModelDir, resolveModelsRoot } from './model-manifest';

/** The refusals, named so the http route answers a code rather than prose. */
export class ModelDeleteRefused extends Error {
  // Named `refusal`, not `code`: the WP-8 sweep in
  // apps/mobile/test/stt_engine_error_sentence_coverage_test.dart looks for
  // the field name "code" paired with an ALL_CAPS literal and demands a
  // phone sentence for each one it finds, but this refusal is HTTP-only
  // (answered as JSON, see stt-model-routes.ts) and never reaches a phone.
  constructor(readonly refusal: 'MODEL_DELETE_OUTSIDE_ROOT', message: string) {
    super(message);
    this.name = 'ModelDeleteRefused';
  }
}

/** realpath when the path exists (defeats a symlinked root or pack), plain
 *  `resolve` when it does not (a pack that was never downloaded still has to
 *  produce a comparable absolute path). */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Windows paths compare case-insensitively; POSIX ones do not. Comparing the
 *  wrong way would either refuse a legitimate delete or accept a crafted one. */
function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * [MODEL_DELETE_CONTAINMENT] — throw unless `dir` is a direct child of `root`.
 * Exported so the property can be tested without staging a deletion.
 */
export function assertInsideModelsRoot(dir: string, root: string): void {
  const realRoot = realOrResolved(root);
  const realDir = realOrResolved(dir);
  const prefix = comparable(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  const target = comparable(realDir);
  if (target === comparable(realRoot) || !target.startsWith(prefix)) {
    throw new ModelDeleteRefused(
      'MODEL_DELETE_OUTSIDE_ROOT',
      `refusing to delete '${realDir}': it is not inside the models root '${realRoot}'`,
    );
  }
  // Exactly ONE segment below the root. A pack directory is `<root>/<model_id>`
  // and nothing deeper; accepting a deeper path would let a future caller that
  // built its own path delete a subtree of somebody else's pack.
  const rest = realDir.slice(realRoot.length).split(sep).filter((s) => s.length > 0);
  if (rest.length !== 1) {
    throw new ModelDeleteRefused(
      'MODEL_DELETE_OUTSIDE_ROOT',
      `refusing to delete '${realDir}': a model directory is exactly one level below '${realRoot}'`,
    );
  }
}

/**
 * Bytes a deletion of `dir` would free. Walks; does not follow directory
 * symlinks (their bytes do not live here, and counting them would inflate the
 * figure the card shows before the press). 0 when the directory is absent —
 * 「nothing there」 is a number, not an error.
 */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) total += dirSizeBytes(p);
    else total += st.size;
  }
  return total;
}

export interface ModelDeleteResult {
  dir: string;
  freed_bytes: number;
}

/**
 * Remove one pack's directory. Measures first, then removes, so the number
 * reported is the number that was there. Idempotent: a directory that is
 * already gone frees 0 and is not an error — the card may be a poll behind.
 *
 * THROWS [ModelDeleteRefused] when containment fails. Callers must have
 * decided the 「in use」 question already (model-in-use.ts) — this function
 * does not ask it, because two places asking it is two answers.
 */
export function deleteModelDir(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelDeleteResult {
  const root = resolveModelsRoot(env);
  const dir = resolveModelDir(modelId, env);
  assertInsideModelsRoot(dir, root);
  // A pack directory that is itself a symlink: the containment assert above
  // already resolved it, so removing `dir` here would remove the LINK and
  // leave the bytes. Refuse instead of reporting a freed size that is a lie.
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      throw new ModelDeleteRefused(
        'MODEL_DELETE_OUTSIDE_ROOT',
        `refusing to delete '${dir}': it is a symbolic link, not a model directory`,
      );
    }
  } catch (err) {
    if (err instanceof ModelDeleteRefused) throw err;
    // lstat failed = nothing there; fall through to the idempotent path.
  }
  const freed = dirSizeBytes(dir);
  rmSync(dir, { recursive: true, force: true });
  return { dir, freed_bytes: freed };
}

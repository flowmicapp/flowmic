// scripts/protocol-dist-stamp.mjs — "is packages/protocol/dist the build of
// THIS source?", answered by content and never by a timestamp.
//
// WHY. `packages/protocol/dist` has exactly one writer that matters — tsup with
// `clean: true`, which DELETES the directory and writes it again — and several
// readers: `tsc --noEmit` (there are no path mappings anywhere in this repo, so
// type-checking reads the dist), every vitest project, golden, the desktop
// build's `beforeBuildCommand` vite build, and apps/desktop/scripts/
// build-sidecar.mjs. A reader that overlaps that writer dies on a half-written
// directory; [measured 2026-09-18, dev-pc-a: BUILD_DESKTOP died 4 s in with
// `Could not load .../protocol/dist/chunk-FYD3DU22.js (imported by
// dist/index.js)` — the index had been written, its chunk had not yet].
//
// The release gate used to own that rebuild (its stage 0), so anything that
// wanted to read the dist had to wait out the whole gate. This file makes the
// rebuild a step of its own that both can wait on: whoever builds the dist
// stamps it, and the gate can then be told `--dist-ready` and verify — by
// content hash, in milliseconds — that the directory on disk is the build of
// the source on disk, instead of rebuilding it under the readers' feet.
//
// 🔴 A TIMESTAMP WOULD NOT DO. mtime answers "was this written after that",
// which is a different question from "is this the build of that" — a checkout,
// a stash pop, a branch switch and a partially-failed build all produce a dist
// newer than a source it does not match. The fingerprint below is the bytes of
// every build INPUT (src/**, the tsup config, tsconfig, and package.json, whose
// `exports` map decides what dist must contain), so the only way to satisfy it
// is to have actually built this source.
//
// 🔴 AND IT FAILS CLOSED. `--check` refuses on a missing stamp, an unreadable
// stamp, a mismatched fingerprint, and a dist directory that is absent or
// emptier than the stamp recorded. It never rebuilds anything on its own: the
// caller asked "may I skip the rebuild", and "I am not sure" must come back as
// "no", not as a silent rebuild in a directory somebody else is reading.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

export const PKG_DIR = join('packages', 'protocol');
export const DIST_DIR = join(PKG_DIR, 'dist');
export const STAMP_PATH = join('.local', 'protocol-dist.stamp');

/** Every file whose bytes decide what `dist` should contain.
 *  `gen/` and `test/` are NOT inputs (tsup's entry list covers `src/` only),
 *  and leaving them out is deliberate: a fingerprint that moves when a test
 *  moves would refuse runs it has no reason to refuse, and a gate people learn
 *  to re-run twice is a gate they learn to distrust. */
export const CONFIG_INPUTS = Object.freeze([
  join(PKG_DIR, 'package.json'),
  join(PKG_DIR, 'tsup.config.ts'),
  join(PKG_DIR, 'tsconfig.json'),
]);

function walk(dir, root, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** The content fingerprint of the build INPUTS, plus the file list itself (so a
 *  deleted source file changes the answer even though no surviving file did). */
export function fingerprintInputs(root = REPO_ROOT) {
  const h = createHash('sha256');
  const files = [
    ...walk(join(root, PKG_DIR, 'src'), root, []),
    ...CONFIG_INPUTS.map((p) => p.split(sep).join('/')),
  ].sort();
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    try { h.update(readFileSync(join(root, rel))); } catch { h.update('<unreadable>'); }
    h.update('\0');
  }
  return { hash: h.digest('hex'), fileCount: files.length };
}

/** A cheap shape reading of the built directory: how many files, how many
 *  bytes. Recorded in the stamp so a dist that was deleted or truncated after
 *  the stamp was written cannot pass the check on the strength of the source
 *  hash alone. */
export function distShape(root = REPO_ROOT) {
  const dir = join(root, DIST_DIR);
  if (!existsSync(dir)) return { present: false, fileCount: 0, bytes: 0 };
  const files = walk(dir, dir, []);
  let bytes = 0;
  for (const rel of files) {
    try { bytes += statSync(join(dir, rel)).size; } catch { /* counted as 0 */ }
  }
  return { present: true, fileCount: files.length, bytes };
}

export function stampPathIn(root = REPO_ROOT) { return join(root, STAMP_PATH); }

/** Write the stamp. Called by `verify:protocol-dist` AFTER tsup returns 0, so
 *  a failed build leaves the previous stamp — which the next `--check` will
 *  then reject on fingerprint, because the source it names is not what is on
 *  disk. (The one case it would wrongly accept — a build that failed while
 *  leaving the previous, matching dist intact — is a dist that IS the build of
 *  this source, which is the only claim the stamp makes.) */
export function writeStamp(root = REPO_ROOT, { now = () => new Date().toISOString() } = {}) {
  const inputs = fingerprintInputs(root);
  const dist = distShape(root);
  const payload = {
    stamp_version: 1,
    writtenAt: now(),
    fingerprint: inputs.hash,
    inputFileCount: inputs.fileCount,
    dist,
    by: 'pnpm verify:protocol-dist',
  };
  const p = stampPathIn(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function readStamp(root = REPO_ROOT) {
  try { return JSON.parse(readFileSync(stampPathIn(root), 'utf8')); } catch { return null; }
}

/**
 * The judgment, pure over already-read facts so a drill can drive every branch.
 * Returns { ok, reason } — `reason` is always populated, including on ok, so a
 * caller can print WHY it is allowed to skip a build step.
 */
export function judgeStamp({ stamp, inputs, dist }) {
  if (!stamp) {
    return { ok: false, reason: `no stamp at ${STAMP_PATH} — nothing has built packages/protocol/dist and said so. Run \`pnpm verify:protocol-dist\` (that is the step that writes it).` };
  }
  if (stamp.stamp_version !== 1 || typeof stamp.fingerprint !== 'string') {
    return { ok: false, reason: `the stamp at ${STAMP_PATH} is not a shape this version understands — treating it as absent rather than guessing.` };
  }
  if (stamp.fingerprint !== inputs.hash) {
    return { ok: false, reason: `packages/protocol has changed since the dist was built (stamp ${stamp.fingerprint.slice(0, 12)}…, source now ${inputs.hash.slice(0, 12)}…). The dist on disk is the build of a DIFFERENT source.` };
  }
  if (!dist.present) {
    return { ok: false, reason: `the stamp matches the source, but ${DIST_DIR} is not on disk at all.` };
  }
  if (dist.fileCount < (stamp.dist?.fileCount ?? 0) || dist.bytes < (stamp.dist?.bytes ?? 0)) {
    return {
      ok: false,
      reason: `${DIST_DIR} is smaller than when it was stamped (${dist.fileCount} files / ${dist.bytes} B now, ${stamp.dist?.fileCount} / ${stamp.dist?.bytes} B then) — something deleted or truncated it after the build.`,
    };
  }
  return {
    ok: true,
    reason: `${DIST_DIR} is the build of this source (fingerprint ${inputs.hash.slice(0, 12)}…, ${dist.fileCount} files, stamped ${stamp.writtenAt} by ${stamp.by}).`,
  };
}

export function checkStamp(root = REPO_ROOT) {
  return judgeStamp({ stamp: readStamp(root), inputs: fingerprintInputs(root), dist: distShape(root) });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `--write`  stamp the dist that is on disk now (run by verify:protocol-dist
//            after tsup succeeds; writing it anywhere else would be claiming a
//            build happened that did not).
// `--check`  exit 0 when the dist is the build of this source, 1 otherwise.
if (process.argv[1] && join(process.argv[1]) === join(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--write')) {
    const p = writeStamp();
    process.stdout.write(`protocol dist stamped: ${p.fingerprint.slice(0, 12)}… (${p.dist.fileCount} files, ${p.inputFileCount} inputs) -> ${STAMP_PATH}\n`);
    process.exit(0);
  }
  if (argv.includes('--check')) {
    const r = checkStamp();
    process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} protocol-dist: ${r.reason}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  process.stderr.write('usage: node scripts/protocol-dist-stamp.mjs --write | --check\n');
  process.exit(2);
}

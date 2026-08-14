// SPEC-REF:
//   docs/strategy/spikes/sherpa-onnx-spike.md §6.3 (downloader: on-demand,
//     HF → hf-mirror → GitHub three-source failover, SHA-256 fail-loud,
//     Range resumable download, integrity gate before load)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (the 7th engine), CLAUDE.md red line: no silent failure
//   Adapted from the spike scripts/download-model.mjs (mechanism kept as-is).
//
// On-demand model fetcher for the built-in engine. Multi-source failover per
// file (HF → hf-mirror), SHA-256 + size verification (fail-loud — never load a
// bad model), HTTP Range resume of partial `.part` files, atomic rename. When
// both per-file sources are unreachable, falls back to the GitHub int8 tarball
// (extracted via the system `tar`, present on Win10+/macOS/Linux).

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SHERPA_MODEL_FILES, SHERPA_PER_FILE_SOURCES, SHERPA_GITHUB_TARBALL, SHERPA_REPO,
  type ModelFile,
} from './model-manifest';

export interface DownloadProgress {
  (msg: string): void;
}

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(p), h);
  return h.digest('hex');
}

/** True iff `dest` exists and passes the size (+ sha256 if pinned) gate. */
export async function isFileValid(dest: string, file: ModelFile): Promise<boolean> {
  if (!existsSync(dest)) return false;
  const sz = statSync(dest).size;
  if (file.size && sz !== file.size) return false;
  if (file.sha256) return (await sha256File(dest)) === file.sha256;
  return true;
}

/** All manifest files present + valid in `dir` (the pre-load integrity gate). */
export async function isModelComplete(dir: string): Promise<boolean> {
  for (const f of SHERPA_MODEL_FILES) {
    if (!(await isFileValid(join(dir, f.path), f))) return false;
  }
  return true;
}

/** Download one file with per-source failover + Range resume + verification. */
async function downloadOne(dir: string, file: ModelFile, log: DownloadProgress): Promise<boolean> {
  const dest = join(dir, file.path);
  mkdirSync(dirname(dest), { recursive: true });
  if (await isFileValid(dest, file)) { log(`[skip] ${file.path} (verified)`); return true; }

  const part = `${dest}.part`;
  let start = existsSync(part) ? statSync(part).size : 0;
  let lastErr: unknown;
  for (const src of SHERPA_PER_FILE_SOURCES) {
    const url = `${src.base}/${file.path}`;
    try {
      const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-` } : {};
      const res = await fetch(url, { headers, redirect: 'follow' });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('empty body');
      // Server ignored Range (200 on a resume attempt) → restart clean.
      const append = res.status === 206 && start > 0;
      if (start > 0 && !append) start = 0;
      const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), out);
      const bytes = statSync(part).size;
      if (file.size && bytes !== file.size) throw new Error(`size ${bytes} != ${file.size}`);
      if (file.sha256) {
        const got = await sha256File(part);
        if (got !== file.sha256) throw new Error(`sha256 mismatch: ${got}`); // fail-loud
      }
      await rename(part, dest);
      log(`[ok] ${file.path} ${(bytes / 1e6).toFixed(2)} MB via ${src.name}`);
      return true;
    } catch (e) {
      lastErr = e;
      log(`[fail] ${file.path} via ${src.name}: ${(e as Error).message} — failing over`);
      start = existsSync(part) ? statSync(part).size : 0;
    }
  }
  log(`[per-file exhausted] ${file.path}: ${(lastErr as Error | undefined)?.message ?? 'unknown'}`);
  return false;
}

/** Third source: download + extract the GitHub int8 tarball, then copy the
 *  needed members into `dir`. Uses the system `tar` (bsdtar handles .tar.bz2). */
async function downloadViaGithubTarball(dir: string, log: DownloadProgress): Promise<void> {
  const work = join(tmpdir(), `flowmic-sherpa-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, 'model.tar.bz2');
  log(`[github] fetching tarball ${SHERPA_GITHUB_TARBALL}`);
  const res = await fetch(SHERPA_GITHUB_TARBALL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`github tarball HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(archive));
  const r = spawnSync('tar', ['-xjf', archive, '-C', work], { stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error(`tar extraction failed (status ${r.status ?? 'n/a'}) — is 'tar' on PATH?`);
  }
  // The archive extracts into a repo-named subdir (…-int8-…); copy needed files.
  const extractedRoot = join(work, `${SHERPA_REPO.replace('-2024-07-17', '-int8-2024-07-17')}`);
  for (const f of SHERPA_MODEL_FILES) {
    const src = join(extractedRoot, f.path);
    if (!existsSync(src)) throw new Error(`github tarball missing member ${f.path}`);
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    copyFileSync(src, join(dir, f.path));
  }
  rmSync(work, { recursive: true, force: true });
  log('[github] extracted + installed');
}

export interface EnsureModelOptions {
  /** Progress sink; defaults to console.log. */
  log?: DownloadProgress;
  /**
   * 🔴 Downloading is OPT-IN: only an explicit `true` fetches (owner ruling
   * 2026-08-09, DISC-2). Absent/undefined means NO network — the library itself
   * is fail-closed, so a future caller that forgets this option gets the loud
   * refusal, not a silent 228 MB fetch. The env-facing parse lives in
   * `sherpa-local.ts` `sherpaAutoDownloadEnabled`.
   */
  autoDownload?: boolean;
}

/**
 * Ensure the built-in model is present + integrity-verified in `dir`. Returns
 * when the pre-load gate passes; throws (fail-loud) when it cannot be satisfied.
 * Never loads/returns a model that failed size/SHA-256 verification, and never
 * touches the network unless `autoDownload` is explicitly `true`.
 */
export async function ensureSherpaModel(dir: string, opts: EnsureModelOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[sherpa-model] ${m}`));
  if (await isModelComplete(dir)) return;
  if (opts.autoDownload !== true) {
    throw new Error(
      `sherpa model incomplete at ${dir} and auto-download is off (the default). ` +
      `Place the model files there yourself, or opt in to a one-time download with ` +
      `FLOWMIC_SHERPA_AUTO_DOWNLOAD=1.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  let allPerFile = true;
  for (const f of SHERPA_MODEL_FILES) {
    if (!(await downloadOne(dir, f, log))) { allPerFile = false; break; }
  }
  if (!allPerFile) {
    log('[failover] per-file sources exhausted — trying GitHub tarball');
    await downloadViaGithubTarball(dir, log);
  }
  // Final integrity gate — never proceed on an unverified model.
  if (!(await isModelComplete(dir))) {
    throw new Error(`sherpa model failed post-download integrity gate at ${dir}`);
  }
}

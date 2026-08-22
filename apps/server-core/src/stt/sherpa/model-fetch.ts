// SPEC-REF:
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §3 (the state
//     machine's criteria), §4 (the snapshot whose field names are the contract)
//   docs/strategy/spikes/sherpa-onnx-spike.md §6.3 (downloader: on-demand,
//     HF → hf-mirror → GitHub three-source failover, SHA-256 fail-loud,
//     Range resumable download, integrity gate before load)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (the 7th engine)
//   CLAUDE.md red line: no silent failure
//
// The MECHANICS of fetching the built-in model: multi-source failover per file
// (HF → hf-mirror), SHA-256 + size verification (fail-loud — never load a bad
// model), HTTP Range resume of partial `.part` files, atomic rename, and the
// whole-archive GitHub fallback when both per-file sources are unreachable.
//
// This file moved out of `model-downloader.ts` (2026-08-19) unchanged in
// mechanism. What changed is WHO IT TALKS TO: the progress sink used to be
// `(msg: string) => void` defaulting to `console.log`, which meant every fact
// this code knows — which file, which source, whether it resumed and from where
// — was formatted into English prose and posted to a log where no interface
// could read it. The sink is now [ModelFetchEvent], a structured channel.
//
// 🔴 THE OLD SIGNATURE IS GONE, NOT DEPRECATED. Keeping a string callback
// alongside the structured one would be two ways to report one thing, and the
// repo's head defect shape is exactly that (CLAUDE.md: 一个值回答两个问题 / one
// value answering two questions). Whoever wants prose builds it from the event.
//
// 🔴 WHAT THIS CHANNEL DELIBERATELY DOES NOT CARRY: BYTES. There is no
// `bytes_received` event, and per-chunk counting was removed from the design
// rather than forgotten. The `.part` file on disk already answers 「how many
// bytes do we have」 — `statSync(part).size` — and it answers it for the bytes a
// PREVIOUS process downloaded too, which an in-memory counter cannot. A second
// counter pushed through here would be a second answer to that one question,
// and it would be the stale one every time a chunk lands between two events.
// The status layer (model-status.ts) reads the disk; this channel carries only
// the facts the disk cannot state: which file, which source, whether this
// attempt resumed, and from where.

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
  type ModelFile, type ModelSource,
} from './model-manifest';

/**
 * The archive fallback's source name. A CONSTANT rather than a literal typed
 * three times, because it is one of the values that reaches the snapshot's
 * `source` field and therefore the interface: a typo would render as a source
 * the UI has no label for, and nothing would fail.
 */
export const GITHUB_TARBALL_SOURCE = 'github-tarball';

/**
 * What the fetcher tells its caller, as it happens.
 *
 * A discriminated union rather than a mutable "current progress" object on
 * purpose: each variant carries exactly the fields that are true AT that
 * moment. A flat object would have to answer `resumed_from_bytes` while
 * verifying and `source` while skipping, and the honest answer there is "that
 * question does not apply", which a flat shape can only spell as a lie (`0`,
 * `''`) or as a null the reader has to guess the meaning of.
 */
export type ModelFetchEvent =
  /** We are about to DIAL `source` for `file` — emitted before the request, so
   *  the interface can name the source it is waiting on.
   *
   *  🔴 IT IS A SEPARATE EVENT FROM `file-start` ON PURPOSE, and the split is a
   *  measured requirement rather than taste. The gap between dialling and the
   *  first response header is precisely the stretch a person on a slow link is
   *  staring at, and the settings card prints 「Source: Hugging Face」 as their
   *  only evidence that anything is happening. Folding this into `file-start`
   *  (which cannot fire until the headers arrive, because only a 206 proves a
   *  resume) would leave that line BLANK for exactly as long as the connection
   *  is slow — the one moment it is load-bearing. */
  | { kind: 'file-attempt'; file: string; source: string }
  /** The response is in and bytes are coming. `resumed_from_bytes` is 0 for a
   *  fresh start and the `.part` size when the server honoured our Range header
   *  — this is the only place that number is ever observed. */
  | { kind: 'file-start'; file: string; source: string; resumed_from_bytes: number }
  /** Already on disk and past the integrity gate; no network was touched. */
  | { kind: 'file-skipped'; file: string }
  /** Hashing a completed `.part` before the atomic rename. Emitted because the
   *  SHA-256 of a 229 MB file takes seconds during which the byte count does
   *  not move — without this the interface cannot tell 「verifying」 from
   *  「stalled」, and those two want opposite reactions from the user. */
  | { kind: 'file-verifying'; file: string }
  | { kind: 'file-done'; file: string; source: string; bytes: number }
  /** One source failed for one file; the next source (if any) is about to be
   *  tried. NOT a terminal failure — see `per-file-exhausted`.
   *
   *  🔴 CARRIES THE RAW ERROR, NOT A FORMATTED REASON. A per-file failure that a
   *  LATER source's failure would otherwise paper over is often the one the user
   *  must act on (model-status.ts `pickReportableError`), and choosing between
   *  two failures means reading `err.cause.code` — which a formatted string has
   *  already thrown away. This sink is in-process; there is no serialisation
   *  boundary that would make an Error the wrong thing to hand over. */
  | { kind: 'source-failed'; file: string; source: string; error: unknown }
  /** Every per-file source failed for this file; the archive fallback follows. */
  | { kind: 'per-file-exhausted'; file: string; error: unknown }
  | { kind: 'archive-start'; source: typeof GITHUB_TARBALL_SOURCE; url: string }
  | { kind: 'archive-done'; source: typeof GITHUB_TARBALL_SOURCE };

export type ModelFetchSink = (event: ModelFetchEvent) => void;

/**
 * Thrown when the caller aborted. A NAMED type because the difference between
 * 「the user pressed cancel」 and 「the download failed」 decides the resulting
 * state (partial vs failed) and whether an error sentence is shown at all;
 * telling them apart by matching on a message string is how the two get
 * conflated the first time someone rewords the message.
 */
export class ModelFetchCancelled extends Error {
  constructor() {
    super('model download cancelled by request');
    this.name = 'ModelFetchCancelled';
  }
}

export interface ModelFetchOptions {
  /** Structured progress. Absent ⇒ no reporting (this library never logs on its
   *  own behalf; the caller owns where facts go). */
  onEvent?: ModelFetchSink;
  /** Cancellation. Aborting leaves every `.part` file exactly where it is —
   *  that is what makes a later resume a resume. */
  signal?: AbortSignal;
  /** Test seam: the manifest under test. Production passes nothing and gets
   *  [SHERPA_MODEL_FILES]. Declared so the suite can drive the real fetch/Range/
   *  resume path against a local server with kilobyte fixtures instead of
   *  pulling 229 MB from a third party on every run. */
  files?: readonly ModelFile[];
  /** Test seam: the ordered per-file sources. */
  sources?: readonly ModelSource[];
  /** Test seam: the archive fallback URL. */
  tarballUrl?: string;
  /** The directory name the archive extracts into. Every model's tarball has
   *  its own root (LM-CAT made this a parameter; the SenseVoice int8 root
   *  stays the default so legacy callers are byte-identical). */
  tarballRoot?: string;
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

/**
 * All manifest files present + valid in `dir` (the pre-load integrity gate, and
 * §3's criterion for `ready`).
 *
 * 🔴 THIS READS EVERY BYTE. On the shipped manifest that is a 229 MB SHA-256,
 * seconds of CPU. It is the right answer to 「are the files right」 and the wrong
 * thing to call on a 1 Hz poll — the status layer owns a stat-keyed cache over
 * it (model-status.ts `verifyComplete`) for exactly that reason. Do not make
 * THIS function cache: a predicate that sometimes reads the disk and sometimes
 * reports what it remembered is a predicate whose answer you cannot cite.
 */
export async function isModelComplete(
  dir: string,
  files: readonly ModelFile[] = SHERPA_MODEL_FILES,
): Promise<boolean> {
  for (const f of files) {
    if (!(await isFileValid(join(dir, f.path), f))) return false;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ModelFetchCancelled();
}

/** Download one file with per-source failover + Range resume + verification.
 *  Returns false when every source failed (the caller then tries the archive);
 *  THROWS [ModelFetchCancelled] on abort, because a cancelled attempt must not
 *  look like an exhausted one — the first leaves the `.part` for a resume, the
 *  second is a reason to go try a different source. */
async function downloadOne(
  dir: string,
  file: ModelFile,
  sources: readonly ModelSource[],
  opts: ModelFetchOptions,
): Promise<boolean> {
  const emit = opts.onEvent ?? ((): void => {});
  const dest = join(dir, file.path);
  mkdirSync(dirname(dest), { recursive: true });
  if (await isFileValid(dest, file)) { emit({ kind: 'file-skipped', file: file.path }); return true; }

  const part = `${dest}.part`;
  let start = existsSync(part) ? statSync(part).size : 0;
  let lastErr: unknown;
  for (const src of sources) {
    throwIfAborted(opts.signal);
    const url = `${src.base}/${file.path}`;
    try {
      // Before the dial — see `file-attempt`'s own note for why this cannot
      // wait for the response headers.
      emit({ kind: 'file-attempt', file: file.path, source: src.name });
      const headers: Record<string, string> = start > 0 ? { Range: `bytes=${start}-` } : {};
      const res = await fetch(url, { headers, redirect: 'follow', ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('empty body');
      // Server ignored Range (200 on a resume attempt) → restart clean.
      const append = res.status === 206 && start > 0;
      if (start > 0 && !append) start = 0;
      // Announced AFTER the response headers are in, never before: until the
      // server has answered 206 we do not know whether this attempt resumes or
      // restarts, and announcing an intention as a fact is how `resumed_from_bytes`
      // would come to mean 「we asked to resume」 instead of 「we did」.
      emit({ kind: 'file-start', file: file.path, source: src.name, resumed_from_bytes: append ? start : 0 });
      const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        out,
        ...(opts.signal ? [{ signal: opts.signal }] : []),
      );
      const bytes = statSync(part).size;
      if (file.size && bytes !== file.size) throw new Error(`size ${bytes} != ${file.size}`);
      if (file.sha256) {
        emit({ kind: 'file-verifying', file: file.path });
        const got = await sha256File(part);
        if (got !== file.sha256) throw new Error(`sha256 mismatch: ${got}`); // fail-loud
      }
      await rename(part, dest);
      emit({ kind: 'file-done', file: file.path, source: src.name, bytes });
      return true;
    } catch (e) {
      // An abort is not a source failure. Rethrow before the failover loop can
      // turn 「stop」 into 「try the next mirror」 — which is precisely how a
      // cancel button ends up downloading 229 MB from somewhere else.
      if (e instanceof ModelFetchCancelled || isAbortError(e)) throw new ModelFetchCancelled();
      lastErr = e;
      emit({ kind: 'source-failed', file: file.path, source: src.name, error: e });
      start = existsSync(part) ? statSync(part).size : 0;
    }
  }
  emit({ kind: 'per-file-exhausted', file: file.path, error: lastErr ?? new Error('no per-file source is configured') });
  return false;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'ModelFetchCancelled');
}

/** Third source (spike §3.2): download + extract the GitHub int8 tarball, then
 *  copy the needed members into `dir`. Uses the system `tar` (bsdtar handles
 *  .tar.bz2, present on Win10+/macOS/Linux). */
async function downloadViaGithubTarball(
  dir: string,
  files: readonly ModelFile[],
  opts: ModelFetchOptions,
): Promise<void> {
  const emit = opts.onEvent ?? ((): void => {});
  const url = opts.tarballUrl ?? SHERPA_GITHUB_TARBALL;
  const work = join(tmpdir(), `flowmic-sherpa-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, 'model.tar.bz2');
  emit({ kind: 'archive-start', source: GITHUB_TARBALL_SOURCE, url });
  const res = await fetch(url, { redirect: 'follow', ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`github tarball HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(archive),
    ...(opts.signal ? [{ signal: opts.signal }] : []),
  );
  const r = spawnSync('tar', ['-xjf', archive, '-C', work], { stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error(`tar extraction failed (status ${r.status ?? 'n/a'}) — is 'tar' on PATH?`);
  }
  // The archive extracts into a repo-named subdir; copy needed files. The
  // root differs per model (and, on the SenseVoice pack, from the repo id —
  // the int8 tarball inserts `-int8-`), so it is caller-declared.
  const extractedRoot = join(
    work,
    opts.tarballRoot ?? `${SHERPA_REPO.replace('-2024-07-17', '-int8-2024-07-17')}`,
  );
  for (const f of files) {
    const src = join(extractedRoot, f.path);
    if (!existsSync(src)) throw new Error(`github tarball missing member ${f.path}`);
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    copyFileSync(src, join(dir, f.path));
  }
  rmSync(work, { recursive: true, force: true });
  emit({ kind: 'archive-done', source: GITHUB_TARBALL_SOURCE });
}

/**
 * Fetch whatever of the model is missing into `dir`, then re-run the integrity
 * gate. Throws (fail-loud) when the gate does not pass; throws
 * [ModelFetchCancelled] when the caller aborted.
 *
 * ⚠️ NO CONSENT DECISION LIVES HERE. This function fetches when called. The
 * question 「is downloading allowed at all」 is answered one layer up
 * (model-downloader.ts `ensureSherpaModel` for the speak-time path, the
 * explicit POST for the interface path) — owner ruling 2026-08-09 / DISC-2 —
 * and it is answered there so that there is exactly one place to read it.
 */
export async function fetchSherpaModel(dir: string, opts: ModelFetchOptions = {}): Promise<void> {
  const files = opts.files ?? SHERPA_MODEL_FILES;
  const sources = opts.sources ?? SHERPA_PER_FILE_SOURCES;
  throwIfAborted(opts.signal);
  mkdirSync(dir, { recursive: true });
  let allPerFile = true;
  for (const f of files) {
    if (!(await downloadOne(dir, f, sources, opts))) { allPerFile = false; break; }
  }
  if (!allPerFile) {
    throwIfAborted(opts.signal);
    await downloadViaGithubTarball(dir, files, opts);
  }
  // Final integrity gate — never proceed on an unverified model.
  if (!(await isModelComplete(dir, files))) {
    throw new Error(`sherpa model failed post-download integrity gate at ${dir}`);
  }
}

// SPEC-REF:
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §3 (the five
//     states and the criterion each one is decided by), §4 (the snapshot —
//     「字段名即契约」/ the field names ARE the contract, and the
//     `bytes_total` null-vs-zero rule)
//   CLAUDE.md red line: no silent failure · 一个值只回答一个问题
//
// The STATUS half of the built-in model: what is on disk, what that means, and
// the snapshot shape the interface polls. No downloading happens here — the
// mechanics are model-fetch.ts and the single-flight controller is
// model-downloader.ts. This file owns the QUESTIONS.
//
// ── THE THREE QUESTIONS THAT LOOK LIKE ONE ──────────────────────────────────
// It is tempting to answer 「is the model ready」 with 「the directory has
// files」. §3 forbids that, and this file keeps the three apart by giving each
// its own function:
//
//   1. ARE THE FILES RIGHT?  [verifyComplete] — every manifest file passes size
//      AND SHA-256. This is the ONLY criterion for `ready`.
//   2. HOW FAR ALONG IS IT?  [readDiskFacts] — a stat sweep: bytes on disk,
//      files whose final name exists at the declared size, `.part` files.
//      Cheap, and deliberately NOT the readiness criterion: a file of the right
//      length with the wrong contents counts here and fails (1).
//   3. CAN THE RECOGNISER LOAD THEM?  — NOT ANSWERED HERE AND NOT FOLDED IN.
//      A missing onnxruntime DLL, a wrong CPU architecture, an addon that was
//      not shipped: all of those are true of a model whose files are perfect.
//      `ready` says the bytes are right; it does not promise the engine opens.
//      Folding the two together would produce a state that cannot tell the user
//      whether to re-download 229 MB (useless for a missing DLL) or to reinstall
//      the app (useless for a truncated file) — §3's 「不许合并」.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isModelComplete } from './model-fetch';
import { SHERPA_MODEL_FILES, SHERPA_REPO, type ModelFile } from './model-manifest';

/** §3's five states. */
export type ModelState = 'absent' | 'partial' | 'downloading' | 'ready' | 'failed';

/**
 * Why the last attempt ended badly.
 *
 * 🔴 THESE ARE NOT PROTOCOL ErrorCodes AND MUST NOT BECOME ONE WITHOUT THE
 * OWNER. The 69-entry registry in `@flowmic/protocol` is owner-gated (CLAUDE.md);
 * these are http-surface reason strings with the same standing as
 * `LOCAL_ONLY` / `METHOD_NOT_ALLOWED` — they never cross the socket contract,
 * never reach the phone, and are consumed by exactly one reader: the desktop
 * settings card, which renders its own sentence per code.
 */
export type ModelErrorCode =
  /** No source could be reached / answered usefully (DNS, refused, timeout, 4xx/5xx). */
  | 'MODEL_SOURCE_UNREACHABLE'
  /** Bytes arrived and failed the size or SHA-256 gate. Retrying a mirror can help; loading it never can. */
  | 'MODEL_INTEGRITY_MISMATCH'
  /** The disk filled up mid-write. */
  | 'MODEL_DISK_FULL'
  /** We are not allowed to write where the model goes. */
  | 'MODEL_WRITE_DENIED'
  /** Anything we could not classify — never silently mapped onto one of the four above. */
  | 'MODEL_DOWNLOAD_FAILED';

export interface ModelStatusError {
  code: ModelErrorCode;
  /**
   * The underlying detail, for the operator and the log. NOT the user's
   * sentence: the interface renders per `code` (the same discipline the phone's
   * inject-verdict notes and stt-stall copy follow — an unrecognised code shows
   * its raw identifier rather than getting a sentence invented for it). A UI
   * that printed this field would be showing the user 「HTTP 503」.
   */
  message: string;
}

/**
 * §4's snapshot. FIELD NAMES ARE THE CONTRACT — snake_case, matching the design
 * document verbatim, because the desktop is written against them.
 */
export interface ModelStatusSnapshot {
  state: ModelState;
  model_id: string;
  /** Absolute install directory. Present in EVERY state, not just failures: it
   *  is what a user needs to place the files by hand, which is one of the two
   *  exits §2-5 requires a failure to offer. */
  dir: string;
  /** Bytes of the model on disk right now — completed files plus any `.part`.
   *  Counts what a PREVIOUS process downloaded, which is what makes a resume
   *  visible as 「continue from 43%」 rather than starting the bar at zero. */
  bytes_done: number;
  /**
   * 🔴 NULL WHEN UNKNOWN, NEVER 0. The sum of the manifest's declared sizes,
   * and only when EVERY file declares one — `ModelFile.size` is optional, so a
   * manifest with one unpinned file has no knowable total. Zero would make the
   * interface compute `bytes_done / 0` and render `NaN%` or, worse, treat the
   * division's `Infinity` as complete; 「I do not know the total」 and 「the
   * total is nothing」 are different facts and only one of them is ever true
   * here. A partial sum would be the third and worst option: a number that
   * looks authoritative and is short by exactly the files nobody pinned.
   */
  bytes_total: number | null;
  /** Files whose final name is on disk at the declared size. A PROGRESS count
   *  (question 2 above), not an integrity verdict — see [readDiskFacts]. */
  files_done: number;
  files_total: number;
  /** The file being fetched right now; null when nothing is in flight, and also
   *  null during the archive fallback, which fetches all of them at once. */
  current_file: string | null;
  /** The source serving the current attempt: a `ModelSource.name` from the
   *  manifest (`huggingface` / `hf-mirror`) or `github-tarball`. Null when
   *  nothing is in flight. */
  source: string | null;
  /** Where the current (or most recent) attempt picked up. 0 means it did not
   *  resume — here 0 IS a fact, unlike `bytes_total` above, because 「resumed
   *  from nothing」 is exactly what a fresh start is. */
  resumed_from_bytes: number;
  /** Measured over a 5-second window of observed `bytes_done`; null when we
   *  have not observed 5 seconds yet, and null whenever nothing is downloading.
   *  Never an estimate of remaining TIME — §2-6. */
  rate_bytes_per_sec: number | null;
  error: ModelStatusError | null;
}

/** What a stat sweep of the install dir can say. Cheap: no file is read. */
export interface DiskFacts {
  bytes_done: number;
  /** Final name present AND at the declared size (or no size declared). */
  files_done: number;
  files_total: number;
  /** Any final file present at all, whatever its size. */
  files_present: number;
  /** `.part` files present — the resumable remainder. */
  parts_present: number;
}

export function readDiskFacts(dir: string, files: readonly ModelFile[] = SHERPA_MODEL_FILES): DiskFacts {
  let bytes = 0;
  let done = 0;
  let present = 0;
  let parts = 0;
  for (const f of files) {
    const dest = join(dir, f.path);
    const part = `${dest}.part`;
    if (existsSync(dest)) {
      const sz = sizeOf(dest);
      bytes += sz;
      present += 1;
      if (f.size === undefined || sz === f.size) done += 1;
    } else if (existsSync(part)) {
      bytes += sizeOf(part);
      parts += 1;
    }
  }
  return { bytes_done: bytes, files_done: done, files_total: files.length, files_present: present, parts_present: parts };
}

function sizeOf(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

/**
 * §4's `bytes_total`. Null unless every file declares a size — see the field's
 * own note for why a partial sum is worse than no answer.
 */
export function declaredTotalBytes(files: readonly ModelFile[] = SHERPA_MODEL_FILES): number | null {
  let total = 0;
  for (const f of files) {
    if (f.size === undefined) return null;
    total += f.size;
  }
  return total;
}

/**
 * §3's state criteria, as ONE function so that "how is this decided" has one
 * answer and one test. Order matters and each step is a criterion, not a guess:
 *
 *   1. `downloading` — this process has an attempt in flight. Asked FIRST
 *      because the disk mid-download looks exactly like `partial`, and a card
 *      that says 「incomplete, continue?」 while it is already downloading is
 *      the same defect as a progress bar that never moves.
 *   2. `ready` — every file passes size AND SHA-256. Wins over a remembered
 *      error: the question is 「are the files right」, and once they are, a
 *      failure from a previous attempt no longer describes anything (the
 *      controller drops it, so a `ready` snapshot never carries an error).
 *   3. `failed` — the last attempt ended in an error we have not superseded.
 *      Above `partial` on purpose: both can be true of the disk at once, and
 *      only one of them tells the user why the bar stopped.
 *   4. `partial` — something of the model is here: a `.part` to resume, or
 *      files that exist but do not all pass. Both mean the same next action.
 *   5. `absent` — nothing of it is here.
 */
export function deriveModelState(input: {
  downloading: boolean;
  complete: boolean;
  error: ModelStatusError | null;
  facts: DiskFacts;
}): ModelState {
  if (input.downloading) return 'downloading';
  if (input.complete) return 'ready';
  if (input.error) return 'failed';
  if (input.facts.parts_present > 0 || input.facts.files_present > 0) return 'partial';
  return 'absent';
}

/**
 * A stat-keyed memo over [isModelComplete].
 *
 * WHY IT EXISTS: `ready` costs a 229 MB SHA-256, and the settings card polls
 * this once a second. WHY IT IS SAFE TO SKIP: the key is every manifest file's
 * (size, mtimeMs) — any write to any of them changes it and the answer is
 * recomputed from the bytes. WHAT IT CANNOT SEE: a file replaced with different
 * contents of identical length AND identical mtime, which is why the `force` flag
 * exists and why the settings card has a 「re-verify」 button wired to it. The
 * memo is an optimisation of WHEN we read the bytes, never a substitute for
 * reading them.
 */
export class ModelVerificationCache {
  private key: string | null = null;
  private verdict = false;

  constructor(private readonly files: readonly ModelFile[] = SHERPA_MODEL_FILES) {}

  async verifyComplete(dir: string, force = false): Promise<boolean> {
    const key = this.stampOf(dir);
    if (!force && this.key === key) return this.verdict;
    this.verdict = await isModelComplete(dir, this.files);
    this.key = this.stampOf(dir); // re-stamped AFTER the read: hashing takes seconds and the file may have changed under us
    return this.verdict;
  }

  /**
   * The memoised verdict WITHOUT reading any bytes, or `null` when there is
   * none for the directory as it stands right now.
   *
   * 🔴 `null` MEANS "I DID NOT ANSWER", NOT "NO". The only caller that may use
   * this is one that treats null as 「ask properly」 (the controller's
   * single-flight claim). Reading it as `false` would turn a cold cache into
   * 「the model is not ready」 — a stat sweep answering the question only a
   * SHA-256 can answer, which is precisely the collapse §3 forbids.
   */
  cachedVerdict(dir: string): boolean | null {
    return this.key !== null && this.key === this.stampOf(dir) ? this.verdict : null;
  }

  /** Forget the memo (used after a download completes or a file is removed). */
  invalidate(): void {
    this.key = null;
  }

  private stampOf(dir: string): string {
    return this.files
      .map((f) => {
        const p = join(dir, f.path);
        try {
          const st = statSync(p);
          return `${f.path}:${st.size}:${st.mtimeMs}`;
        } catch {
          return `${f.path}:absent`;
        }
      })
      .join('|');
  }
}

/** The 5-second window §4 specifies for `rate_bytes_per_sec`. */
export const RATE_WINDOW_MS = 5_000;

/**
 * Sliding-window transfer rate over OBSERVED `bytes_done`.
 *
 * Sampled by whoever asks for a snapshot rather than by a background timer, on
 * purpose: a timer would have to be started, stopped, and `unref`ed correctly
 * or it keeps the sidecar process alive after a cancel, and it would measure a
 * rate nobody is watching. The cost is that a client which never polls gets
 * `null` — which is honest, because we then genuinely have not measured a rate.
 *
 * Returns null rather than a number when: fewer than [RATE_WINDOW_MS] of
 * observations exist, or the byte count went BACKWARDS (a `.part` restarted
 * clean because a server ignored our Range header). A negative rate is not a
 * slow download, it is a window whose basis changed underneath it — so the
 * window is dropped and rebuilt instead of averaging across the discontinuity.
 */
export class RateSampler {
  private samples: { t: number; bytes: number }[] = [];

  observe(bytes: number, now: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && bytes < last.bytes) this.samples = []; // basis changed — see above
    this.samples.push({ t: now, bytes });
    // Keep everything inside the window plus ONE older sample as its left edge:
    // dropping that one makes the span shorter than the window and the rate
    // permanently null at slow poll rates.
    let firstInside = 0;
    while (firstInside < this.samples.length && this.samples[firstInside]!.t < now - RATE_WINDOW_MS) firstInside += 1;
    if (firstInside > 0) this.samples = this.samples.slice(firstInside - 1);
  }

  rate(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const span = last.t - first.t;
    if (span < RATE_WINDOW_MS) return null;
    const delta = last.bytes - first.bytes;
    if (delta < 0) return null;
    return Math.round((delta * 1000) / span);
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Classify a thrown download failure into one of [ModelErrorCode].
 *
 * Reads the STRUCTURED cause first (`err.cause.code` — undici wraps the system
 * error of a failed `fetch` there, and node's fs errors carry `code` directly),
 * and only falls back to matching the message when there is no code to read.
 * The fallback is written down as a fallback because message matching is how a
 * classifier silently changes its answer the day someone rewords a sentence:
 * everything above it is structural, the strings below it are last resort.
 */
export function classifyDownloadError(err: unknown): ModelStatusError {
  const message = err instanceof Error ? err.message : String(err);
  const sys = systemCodeOf(err);
  if (sys === 'ENOSPC') return { code: 'MODEL_DISK_FULL', message };
  if (sys === 'EACCES' || sys === 'EPERM' || sys === 'EROFS') return { code: 'MODEL_WRITE_DENIED', message };
  if (sys !== null) return { code: 'MODEL_SOURCE_UNREACHABLE', message }; // ENOTFOUND / ECONNREFUSED / ETIMEDOUT / EAI_AGAIN …
  if (/sha256 mismatch|size \d+ != \d+|integrity gate/i.test(message)) {
    return { code: 'MODEL_INTEGRITY_MISMATCH', message };
  }
  if (/HTTP \d{3}|fetch failed|empty body|missing member|tar extraction/i.test(message)) {
    return { code: 'MODEL_SOURCE_UNREACHABLE', message };
  }
  return { code: 'MODEL_DOWNLOAD_FAILED', message };
}

/**
 * Which of several failures the user is actually shown.
 *
 * 🔴 WHY THIS EXISTS — MEASURED, 2026-08-19. One attempt can fail several times:
 * a mirror serves corrupt bytes, then the next mirror is unreachable, then the
 * archive 404s. Reporting the LAST one — the natural implementation, and the
 * one that shipped for exactly as long as it took a test to catch it — showed
 * `MODEL_SOURCE_UNREACHABLE` for a download whose bytes had ARRIVED. Reading
 * the test that caught it: `expected 'MODEL_SOURCE_UNREACHABLE' to be
 * 'MODEL_INTEGRITY_MISMATCH'`. That sends a user to check a network that is
 * working, which is the LLM_INVALID_MODEL failure shape one domain over: a true
 * sentence that hands somebody a task that cannot help them.
 *
 * The order is by WHICH NEXT ACTION EACH CODE NAMES, not by severity:
 *   1. the local conditions (disk full / write denied) — no source can fix
 *      them, and if one is present it is certainly why we stopped;
 *   2. integrity — bytes ARRIVED, so 「unreachable」 would be a false
 *      instruction about the very thing that demonstrably worked;
 *   3. unreachable — nothing arrived, and the action is to retry / check the
 *      connection;
 *   4. unclassified — kept last so it can never displace an answer we do have,
 *      and never silently folded into a neighbouring code.
 */
const REPORTABLE_ORDER: readonly ModelErrorCode[] = [
  'MODEL_DISK_FULL',
  'MODEL_WRITE_DENIED',
  'MODEL_INTEGRITY_MISMATCH',
  'MODEL_SOURCE_UNREACHABLE',
  'MODEL_DOWNLOAD_FAILED',
];

export function pickReportableError(errors: readonly ModelStatusError[]): ModelStatusError | null {
  for (const code of REPORTABLE_ORDER) {
    const hit = errors.find((e) => e.code === code);
    if (hit) return hit;
  }
  return errors[0] ?? null;
}

function systemCodeOf(err: unknown): string | null {
  let node: unknown = err;
  for (let depth = 0; depth < 4 && node instanceof Error; depth += 1) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) return code;
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

/** The model id every snapshot carries — the repo id, which is also the
 *  directory's last segment and the string the user would search for if they
 *  chose to place the files by hand. */
export const MODEL_ID = SHERPA_REPO;

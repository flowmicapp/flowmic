// SPEC-REF:
//   docs/strategy/2026-08-19-local-model-onboarding-design.md §2 (在能知道的最早
//     时刻告知 / tell them at the earliest moment we can know, not at the worst
//     moment we could fail), §3 (state machine), §4 (single-flight download,
//     cancel that leaves a resumable remainder)
//   docs/decisions ruling 2026-08-09 (DISC-2): downloading is OPT-IN
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (the 7th engine)
//   CLAUDE.md red line: no silent failure
//
// THE CONTROLLER: one place that decides whether a download is running, starts
// at most one, cancels it without throwing away what it already fetched, and
// answers §4's snapshot. The fetch mechanics are model-fetch.ts; the questions
// and the snapshot shape are model-status.ts.
//
// ── WHY A SINGLETON PER DIRECTORY ───────────────────────────────────────────
// CLAUDE.md lists 「a process-level singleton colliding with two channels」
// (进程级单例撞双通道) as one of four structural defect classes, so a module-level
// registry needs a reason. Here the shared resource IS the directory: two
// controllers over one install dir would each hold a correct single-flight and
// together hold none — two writers appending to the same `.part`, which is the
// one failure mode the `.part` design cannot survive. The registry is therefore
// keyed by the directory, not by the process, and a caller naming a different
// directory (the re-runnable spike scripts do, via FLOWMIC_SHERPA_MODEL_DIR)
// gets its own.
//
// ── WHO IS ALLOWED TO START ONE ─────────────────────────────────────────────
// Downloading is opt-in (owner ruling 2026-08-09, DISC-2). There are now TWO
// consents, not one, and neither is implicit:
//   · the user pressing the button in settings — that POST is the consent
//     (design §2-3: 「界面上的按钮就是那个同意」), and it reaches [start];
//   · `FLOWMIC_SHERPA_AUTO_DOWNLOAD=1`, the unattended/CI path, which reaches
//     [ensureSherpaModel] while somebody is already speaking.
// The library itself stays fail-closed: [ensureSherpaModel] with no option
// refuses, so a future caller that forgets gets the loud refusal rather than a
// silent 229 MB fetch.

import { log } from '../../log';
import {
  fetchSherpaModel, isModelComplete, ModelFetchCancelled,
  type ModelFetchEvent,
} from './model-fetch';
import {
  classifyDownloadError, declaredTotalBytes, deriveModelState, pickReportableError, readDiskFacts,
  ModelVerificationCache, RateSampler, MODEL_ID,
  type ModelStatusError, type ModelStatusSnapshot,
} from './model-status';
import { SHERPA_MODEL_FILES, type ModelFile, type ModelSource } from './model-manifest';

export type { ModelStatusSnapshot, ModelState } from './model-status';

/** How long [SherpaModelController.cancel] waits for the aborted attempt to
 *  settle before answering anyway. An abort reaches `fetch`/`pipeline` at once,
 *  but a cancel landing during the SHA-256 of a 229 MB file waits for that hash
 *  (createHash has no signal), and an http handler must answer either way. When
 *  the bound is hit the snapshot still reads `downloading`, which is true. */
const CANCEL_SETTLE_MS = 2_000;

export interface SherpaModelControllerOptions {
  /** Test seams, passed straight through to model-fetch. Production passes none. */
  files?: readonly ModelFile[];
  sources?: readonly ModelSource[];
  tarballUrl?: string;
}

/**
 * The one owner of "is the built-in model being downloaded right now".
 */
export class SherpaModelController {
  private inFlight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private cancelling = false;
  private lastError: ModelStatusError | null = null;
  /** The in-flight attempt's narrative facts — the ones the disk cannot state.
   *  `resumed_from` deliberately OUTLIVES the attempt: after a cancel the card
   *  wants to say 「it had resumed from 43%」, and after a failure the operator
   *  wants to know the retry will not start from zero. `file`/`source` do NOT
   *  outlive it: they answer 「what is being fetched now」, and a stale answer to
   *  that reads as an attempt that is still running. Which source FAILED lives
   *  in the error's message, where it cannot be mistaken for a live one. */
  private current: { file: string | null; source: string | null; resumed_from: number } =
    { file: null, source: null, resumed_from: 0 };
  private readonly cache: ModelVerificationCache;
  private readonly rate = new RateSampler();
  private readonly files: readonly ModelFile[];
  /** The RAW failure, kept beside the classified one because [ensure] rethrows
   *  it: the speak-time path wants the original error, the snapshot wants the
   *  code. Two readers, two shapes, one event. */
  private lastFailure: unknown = null;
  /** EVERY failure this attempt saw, not just the one that ended it — a
   *  three-source failover ends on the third failure, which is routinely not
   *  the one worth telling the user about (see pickReportableError). Reset per
   *  attempt so a previous run's reasons cannot leak into this one's verdict. */
  private attemptErrors: ModelStatusError[] = [];

  constructor(readonly dir: string, private readonly opts: SherpaModelControllerOptions = {}) {
    this.files = opts.files ?? SHERPA_MODEL_FILES;
    this.cache = new ModelVerificationCache(this.files);
  }

  /**
   * §4's `GET /api/stt/model/status`.
   *
   * `verify` forces every byte to be hashed again instead of trusting the
   * stat-keyed memo. It backs the settings card's 「check the files again」
   * button, and the split is the whole design:
   *
   *   · the PLAIN poll must stay cheap — the card polls while a download runs,
   *     and re-hashing 229 MB at 1 Hz would burn a core answering a question
   *     whose answer cannot have changed;
   *   · the BUTTON must actually check — a control that reports 「checked」
   *     without checking is worse than no control at all, and this repo has
   *     shipped that shape before.
   *
   * 🔴 WHAT THE CHEAP ANSWER STILL CATCHES, written down so nobody has to
   * guess: the memo is keyed on every manifest file's (size, mtimeMs), so a
   * deleted, truncated, replaced or re-downloaded file invalidates it and the
   * bytes ARE read again. It is not 「computed once at startup」. The one case
   * it cannot see is a file swapped for different contents of identical length
   * AND identical mtime — which is exactly what `verify` is for.
   *
   * ⚠️ This call OBSERVES `bytes_done` for the rate window (see RateSampler for
   * why sampling rides on the poll rather than on a background timer). It is
   * therefore not side-effect free, and that is deliberate rather than
   * overlooked.
   */
  async snapshot(verify = false): Promise<ModelStatusSnapshot> {
    const facts = readDiskFacts(this.dir, this.files);
    const downloading = this.inFlight !== null;
    if (downloading) this.rate.observe(facts.bytes_done, Date.now());
    // NOT verified while downloading: `downloading` is decided first (§3), so
    // the answer would not be read — and hashing 229 MB on a 1 Hz poll during
    // the very download that is writing those bytes is both wasted and wrong.
    const complete = downloading ? false : await this.cache.verifyComplete(this.dir, verify);
    const state = deriveModelState({ downloading, complete, error: this.lastError, facts });
    return {
      state,
      model_id: MODEL_ID,
      dir: this.dir,
      bytes_done: facts.bytes_done,
      bytes_total: declaredTotalBytes(this.files),
      files_done: facts.files_done,
      files_total: facts.files_total,
      current_file: downloading ? this.current.file : null,
      source: downloading ? this.current.source : null,
      resumed_from_bytes: this.current.resumed_from,
      rate_bytes_per_sec: downloading ? this.rate.rate() : null,
      // A `ready` model never carries an error: the question the error answered
      // ("why are the files not right") no longer has a subject.
      error: state === 'ready' ? null : this.lastError,
    };
  }

  /**
   * §4's `POST /api/stt/model/download` — SINGLE-FLIGHT.
   *
   * A second call while one is running returns the RUNNING snapshot: it does
   * not start a second download and it does not queue one. Queueing would be
   * the worse of the two — the second fetch would start the moment the first
   * finished, so a user who pressed the button twice would pay for 229 MB
   * twice with nothing on screen to explain the second time.
   *
   * 🔴 THE CLAIM IS SYNCHRONOUS. `inFlight` is assigned before this method
   * awaits anything, because two POSTs arriving in the same tick would both
   * pass an `if (this.inFlight)` written after an `await` — a single-flight
   * that is only single when nobody is in a hurry.
   */
  async start(): Promise<ModelStatusSnapshot> {
    if (this.inFlight) return this.snapshot();
    // Cheap (stat-only) reading of the memo: when we already KNOW the files are
    // right, do not claim a download just to abandon it a microtask later —
    // that would make one poll report `downloading` for a model that is ready.
    // `null` means "not known without reading 229 MB", and then run() decides.
    if (this.cache.cachedVerdict(this.dir) === true) return this.snapshot();
    this.claim();
    return this.snapshot();
  }

  /**
   * §4's `POST /api/stt/model/cancel` — stop at a RESUMABLE point.
   *
   * Nothing on disk is removed: the `.part` files are the whole reason a later
   * 「continue」 is a continue. The abort is not an error — `lastError` is
   * cleared, so the resulting state is `partial` (or `absent` if nothing had
   * landed yet), never `failed`. A cancel with nothing running is a no-op that
   * answers the current snapshot rather than an error: the button and the
   * download can always race, and refusing the loser tells the user about our
   * bookkeeping rather than about their model.
   */
  async cancel(): Promise<ModelStatusSnapshot> {
    if (this.inFlight) {
      this.cancelling = true;
      this.abort?.abort();
      await settleWithin(this.inFlight, CANCEL_SETTLE_MS);
    }
    return this.snapshot();
  }

  /**
   * The speak-time path: get the model onto disk, joining an already-running
   * download instead of starting a second one — the same single flight the
   * button uses.
   *
   * 🔴 THIS METHOD DOES NOT ASK WHETHER DOWNLOADING IS ALLOWED. Calling it IS
   * the decision, exactly as calling [start] is. The consent gate (owner ruling
   * DISC-2) lives in [ensureSherpaModel], one layer up, so that there is one
   * place to read it — putting a second check here would mean two answers to
   * 「may we fetch」 and, the day they disagree, no way to tell which one ran.
   */
  async ensure(): Promise<void> {
    if (!this.inFlight) this.claim();
    const flight = this.inFlight;
    if (flight) await flight;
    if (this.lastFailure) throw this.lastFailure;
  }

  /** Whether a download is in flight — for tests and for callers that must not
   *  ask a question whose answer would be a race. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Claim the single flight. SYNCHRONOUS by contract — see [start]. */
  private claim(): void {
    const abort = new AbortController();
    this.abort = abort;
    this.cancelling = false;
    this.lastError = null;
    this.lastFailure = null;
    this.attemptErrors = [];
    this.current = { file: null, source: null, resumed_from: 0 };
    this.rate.reset();
    this.inFlight = this.run(abort.signal);
  }

  /** Never rejects: the outcome is recorded, not thrown, because the only
   *  caller that can act on a throw is [ensure] and it reads `lastFailure`. */
  private async run(signal: AbortSignal): Promise<void> {
    try {
      if (await this.cache.verifyComplete(this.dir)) return; // already right; no network
      await fetchSherpaModel(this.dir, {
        onEvent: (e) => this.onEvent(e),
        signal,
        ...(this.opts.files ? { files: this.opts.files } : {}),
        ...(this.opts.sources ? { sources: this.opts.sources } : {}),
        ...(this.opts.tarballUrl ? { tarballUrl: this.opts.tarballUrl } : {}),
      });
    } catch (err) {
      if (err instanceof ModelFetchCancelled || this.cancelling) {
        // A cancel is not a failure and must not leave one behind: the next
        // snapshot has to read `partial` (resume from here), not `failed`.
        log.info('sherpa model: download cancelled', { dir: this.dir, bytes_done: readDiskFacts(this.dir, this.files).bytes_done });
      } else {
        // The failure that ENDED the attempt is only a candidate — it is the
        // last source's, and a failover's last source is rarely the one that
        // explains what the user should do next.
        this.lastError = pickReportableError([...this.attemptErrors, classifyDownloadError(err)]);
        this.lastFailure = err;
        log.warn('sherpa model: download failed', {
          dir: this.dir,
          code: this.lastError?.code ?? 'MODEL_DOWNLOAD_FAILED',
          detail: this.lastError?.message ?? '',
          // Every reason, not just the reported one: the operator debugging a
          // three-source failover needs the two that the interface dropped.
          all_reasons: [...this.attemptErrors, classifyDownloadError(err)].map((e) => e.code).join(','),
        });
      }
    } finally {
      this.inFlight = null;
      this.abort = null;
      this.current = { file: null, source: null, resumed_from: this.current.resumed_from };
      this.rate.reset();
      // The bytes on disk changed (or may have); the memo must not answer from
      // before the download.
      this.cache.invalidate();
    }
  }

  private onEvent(e: ModelFetchEvent): void {
    switch (e.kind) {
      case 'file-attempt':
        // Named from the DIAL, not from the first byte: `source` has to be
        // populated for the whole download, because the settings card prints it
        // as the one line that distinguishes 「moving on to the next mirror」
        // from 「stuck」. `resumed_from` is untouched here — whether this attempt
        // resumes is not known until the server answers 206.
        this.current = { ...this.current, file: e.file, source: e.source };
        break;
      case 'file-start':
        this.current = {
          file: e.file,
          source: e.source,
          // 🔴 FIRST NON-ZERO WINS, for the whole attempt. The manifest has more
          // than one file: a resumed 229 MB model followed by a fresh 300 KB
          // tokens.txt would otherwise end with `resumed_from_bytes: 0`, which
          // answers 「did this continue where it left off?」 with 「no」 about an
          // attempt that plainly did. Reset per attempt in [claim], never here.
          resumed_from: this.current.resumed_from || e.resumed_from_bytes,
        };
        break;
      case 'file-verifying':
        this.current = { ...this.current, file: e.file };
        break;
      case 'file-skipped':
        // Worth a line: it is the whole explanation for a 「download」 that
        // finished in two seconds, and without it that looks like a failure.
        log.info('sherpa model: file already on disk and verified', { file: e.file });
        break;
      case 'file-done':
        log.info('sherpa model: file installed', { file: e.file, source: e.source, bytes: e.bytes });
        break;
      case 'archive-done':
        log.info('sherpa model: archive installed', { source: e.source });
        break;
      case 'archive-start':
        // The archive fetches every file at once, so there is no current FILE.
        // `source` naming the archive is what tells the interface that
        // `bytes_done` cannot move for a while: the tarball lands in a temp dir
        // and only becomes model bytes at the end. Reporting the archive's own
        // byte count as `bytes_done` was rejected — it is measured against a
        // compressed whole, so it would answer a different question with the
        // same field, and the progress bar would jump backwards on the last step.
        this.current = { file: null, source: e.source, resumed_from: 0 };
        break;
      case 'source-failed':
      case 'per-file-exhausted': {
        // Collected, not just logged: a failure the failover walks past is
        // still evidence about what went wrong. `per-file-exhausted` repeats
        // the last `source-failed`; the duplicate is harmless because the pick
        // is by code, so no de-duplication is worth the code to do it.
        const classified = classifyDownloadError(e.error);
        this.attemptErrors.push(classified);
        log.warn('sherpa model: source failed', { file: e.file, code: classified.code, detail: classified.message });
        break;
      }
      default:
        break;
    }
  }
}

/** Per-directory controllers — see the header for why the registry is keyed by
 *  directory rather than being one process-wide instance. */
const CONTROLLERS = new Map<string, SherpaModelController>();

/**
 * ⚠️ NO OPTIONS PARAMETER, deliberately. A registry that accepts construction
 * options can only honour them for the FIRST caller; every later one would have
 * its options silently ignored, which is a lie that type-checks. Tests build a
 * [SherpaModelController] directly and hand it in (route deps / EnsureModelOptions).
 */
export function getSherpaModelController(dir: string): SherpaModelController {
  const existing = CONTROLLERS.get(dir);
  if (existing) return existing;
  const made = new SherpaModelController(dir);
  CONTROLLERS.set(dir, made);
  return made;
}

/** Test seam: drop the registry so a suite's temp directories do not leak a
 *  controller (and its remembered error) into the next case. */
export function resetSherpaModelControllers(): void {
  CONTROLLERS.clear();
}

/**
 * The refusal the user hits WHILE SPEAKING when the model is not on disk.
 *
 * 🔴 WHAT THIS REPLACED, AND WHY IT WAS WRONG. Until 2026-08-19 the sentence
 * was `sherpa model incomplete at <dir> and auto-download is off (the default).
 * Place the model files there yourself, or opt in to a one-time download with
 * FLOWMIC_SHERPA_AUTO_DOWNLOAD=1.` Every word of it is true, and it reached a
 * person who had just held a button and spoken. It names a filesystem path and
 * an environment variable — two things the speaker cannot act on from where
 * they are — and it does not name the one thing they can: the button in
 * settings. Design §5-C: keep the directory in the diagnostics, out of the
 * sentence.
 *
 * 🔴 A TRAP THE NEXT EDITOR WILL WALK INTO. `stt/engines/sherpa-local.ts`
 * decides which STT error code this becomes by RUNNING A REGEX OVER THIS
 * MESSAGE (`/HTTP|fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|tarball/i` ⇒
 * `STT_NETWORK_DROP`, otherwise `STT_CONFIG_MISSING`). So a reworded sentence
 * containing the word "fetch" would silently become a RETRYABLE network error,
 * the reconnect ladder would start climbing, and nothing would fail. The
 * sentences below are kept clear of those words on purpose, and
 * `test/sherpa-model.test.ts` pins the resulting code rather than trusting it.
 */
export class SherpaModelNotReadyError extends Error {
  constructor(readonly dir: string, readonly reason: ModelStatusError | null = null) {
    super(speakTimeRefusal());
    this.name = 'SherpaModelNotReadyError';
  }
}

/**
 * The sentence itself. The size comes from the manifest (§5-D: 「数字用 MB 且从
 * manifest 的声明大小算，不写死」 — MB, computed from the declared sizes, never
 * written down), and is omitted entirely when the manifest cannot state one
 * rather than guessed at.
 *
 * ⚠️ This is the SERVER's English fallback, not the product's copy. What the
 * user actually reads is rendered per error CODE by the client (the phone's
 * `sttStallConfigMissing` mirror, the desktop's settings card) in nine
 * languages. This string reaches the log, the diagnostics, and any surface that
 * has no per-code sentence yet — which is exactly why it must not be the old
 * developer sentence either.
 */
export function speakTimeRefusal(): string {
  const total = declaredTotalBytes();
  // 🔴 DIVISOR 1024², UNIT SPELLED `MB`, AND THE TWO SURFACES MUST AGREE.
  // This sentence and the desktop's model card describe the SAME 239,549,735
  // bytes: 228 by this arithmetic, 240 by the decimal one. Shipping both would
  // have put "about 240 MB" in the error a user reads while Settings said
  // "about 228 MB" — one file, two sizes, read as two files. The reasoning for
  // choosing this side (Explorer's size column and `du -sh` both show 228/229,
  // so it is the figure the user can check against) is written out once, at
  // `formatMb` in apps/desktop/src/lib/model-status.ts — read it there before
  // changing either. Decided by the main session on 2026-08-19 when the two
  // lanes' numbers were put side by side.
  const size = total === null ? '' : ` (about ${Math.round(total / (1024 * 1024))} MB, one time)`;
  return (
    `The built-in speech model is not ready yet. Download it${size} from Settings → Speech recognition, ` +
    `or switch this language to a different speech engine.`
  );
}

export interface EnsureModelOptions {
  /**
   * 🔴 Downloading is OPT-IN: only an explicit `true` fetches (owner ruling
   * 2026-08-09, DISC-2). Absent/undefined means NO network — the library itself
   * is fail-closed, so a future caller that forgets this option gets the loud
   * refusal, not a silent 229 MB fetch. The env-facing parse lives in
   * `sherpa-local.ts` `sherpaAutoDownloadEnabled`; the OTHER consent (the user
   * pressing the button) never comes through here — it reaches
   * [SherpaModelController.start] directly.
   */
  autoDownload?: boolean;
  /** Test seams (see SherpaModelControllerOptions). */
  controller?: SherpaModelController;
}

/**
 * Ensure the built-in model is present + integrity-verified in `dir`. Returns
 * when the pre-load gate passes; throws (fail-loud) when it cannot be
 * satisfied. Never loads a model that failed size/SHA-256 verification, and
 * never touches the network unless `autoDownload` is explicitly `true`.
 *
 * Routed through the controller so that the download it may start is THE SAME
 * single flight the settings button uses: a user who pressed 「download」 and
 * then held the mic button must not cause a second 229 MB fetch into the same
 * `.part` files.
 */
export async function ensureSherpaModel(dir: string, opts: EnsureModelOptions = {}): Promise<void> {
  const controller = opts.controller ?? getSherpaModelController(dir);
  if (await isModelComplete(dir)) return;
  if (opts.autoDownload !== true) {
    // The coordinates the sentence deliberately does not carry — logged, so the
    // operator's answer is in server.log where a support question can reach it.
    log.warn('sherpa model: not ready and auto-download is off', {
      dir,
      opt_in_env: 'FLOWMIC_SHERPA_AUTO_DOWNLOAD=1',
    });
    throw new SherpaModelNotReadyError(dir);
  }
  await controller.ensure();
  if (!(await isModelComplete(dir))) {
    const snap = await controller.snapshot();
    log.warn('sherpa model: still not ready after an authorised download', {
      dir,
      state: snap.state,
      code: snap.error?.code ?? 'none',
      detail: snap.error?.message ?? '',
    });
    throw new SherpaModelNotReadyError(dir, snap.error);
  }
}

/** Resolve when `p` settles or when `ms` elapses, whichever comes first. The
 *  timer is cleared on settle and `unref`ed so it can never hold the process
 *  open past a cancel. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
    void p.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

// SPEC-REF:
//   docs/strategy/spikes/sherpa-onnx-spike.md §6.1 (maps onto SttEngine: open=ensure
//     model + load recognizer; push=accumulate; flush=offline decode→final;
//     state open/closed/failed no reconnecting; only emits final/error/state), §6.2
//     (recommendation A: batch final-only, no interim), §2.1 (#3059: prepend
//     sherpa-onnx-win-x64 to PATH before init)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (the 7th engine), CLAUDE.md red line: no silent failure
//
// Built-in offline SenseVoice-small (int8) engine. The no-configuration/offline-fallback net: no
// network endpoint, no reconnect ladder. push() accumulates s16le PCM; flush()
// runs one offline decode → a single `final`. sherpa-onnx-node is loaded via a
// runtime require (a variable specifier) so tsup never tries to bundle the
// native addon, and win-x64 stays an optionalDependency (absent → fail-loud on
// open, never a silent stall).
//
// 🔴 IN-PLACE CORRECTION (REQ-12-05, 2026-08-12). The SPEC-REF above still points
// at spike §6.2 "recommendation A: batch final-only, no interim", and this engine really did
// emit no `interim` until today — measured on frozen 0.2.61 as an EMPTY "Transcribing…"
// row for the whole hold. The spike's own next paragraph offers the way out
// ("optional enhancement … segmented quasi-streaming, linear cost"), and that is now implemented in
// `sherpa-preview.ts`: push() additionally re-decodes the current UNCOMMITTED
// TAIL on a cadence and emits the cumulative text as `interim`.
// ⚠️ The FINAL path below is byte-for-byte unchanged: flush() still decodes the
// whole utterance buffer from scratch, and that decode is still the only thing
// that becomes the user's transcript. Previews can be late, wrong or absent
// without changing one character of it.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EngineState, FinalResult, InterimResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError } from './base';
import { resolveModelDir } from '../sherpa/model-manifest';
import { ensureSherpaModel, SherpaModelNotReadyError } from '../sherpa/model-downloader';
import {
  baseLang, catalogModelById, isLoadableThisPhase, SENSE_VOICE_MODEL_ID,
  sherpaModelCanRecognize, type CatalogModel,
} from '../sherpa/model-catalog';
import { loaderConfigEmbedsLanguage, maxDecodeAudioMsFor, offlineModelConfigFor } from '../sherpa/loader-config';
import { resolveReadyModelForLanguage, type ResolvedModel } from '../sherpa/model-resolve';
import { SherpaPreviewDecoder, type PreviewDisableReason } from './sherpa-preview';
import { log } from '../../log';

const SAMPLE_RATE = 16_000;
const nodeRequire = createRequire(import.meta.url);
// Variable specifier: keep the native addon out of the tsup bundle (esbuild
// can't statically resolve a non-literal require) — mirrors db/connection.ts.
const SHERPA_SPECIFIER = 'sherpa-onnx-node';

export interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  /** sherpa-onnx-node >= 1.13.4 — the same decode on a libuv worker. OPTIONAL
   *  on the type and checked at RUNTIME for the same reason `createAsync` is
   *  (see SherpaOfflineRecognizerCtor): the addon is whatever is on the
   *  machine, and a missing method degrades to the synchronous decode. */
  decodeAsync?: (stream: OfflineStream) => Promise<void>;
  getResult(stream: OfflineStream): { text?: string; lang?: string };
}
export interface OfflineStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
/** The addon's `OfflineRecognizer` export, both of its construction paths.
 *
 *  `createAsync` is OPTIONAL on the TYPE and checked at RUNTIME on purpose: the
 *  pin is `sherpa-onnx-node@1.13.4` (apps/server-core/package.json) which has
 *  it, but the addon is an optionalDependency resolved from whatever is on the
 *  machine, and a missing factory must degrade to the old synchronous path
 *  rather than crash the open. */
export interface SherpaOfflineRecognizerCtor {
  new (cfg: unknown): OfflineRecognizer;
  /** sherpa-onnx-node >= 1.13.4 — `addon.createOfflineRecognizerAsync`, which
   *  builds the ONNX session on a libuv worker instead of the JS thread. */
  createAsync?: (cfg: unknown) => Promise<OfflineRecognizer>;
}
export interface SherpaModule {
  OfflineRecognizer: SherpaOfflineRecognizerCtor;
}

/** Keep loaded recognizers hot across utterances (spike §7 risk 4: avoid the
 *  ~1s + 228 MB reload per recording). Keyed by model path + thread count.
 *
 *  🔴 NR-38: the value is the in-flight PROMISE, not the recognizer. The load
 *  became awaitable (see [constructRecognizer]) and an awaitable load opens a
 *  window the synchronous one did not have: two sessions cold-opening the same
 *  model at once would each build their own ~1 GB ONNX session. Caching the
 *  promise makes the second one join the first. A REJECTED load is dropped
 *  again below, because the synchronous version could never memoise a failure
 *  (the constructor threw before the `set`) and 「the model is permanently
 *  broken for this process」 is not something one failed load may decide. */
const RECOGNIZER_CACHE = new Map<string, Promise<OfflineRecognizer>>();

let dllPathPrepended = false;
/** #3059: prepend the bundled sherpa-onnx-win-x64 dir to PATH so its
 *  onnxruntime.dll wins over a stale C:\Windows\System32 copy. */
function prependNativeDllDir(): void {
  if (dllPathPrepended || process.platform !== 'win32') { dllPathPrepended = true; return; }
  const override = process.env.FLOWMIC_SHERPA_BIN_DIR;
  const binDir = override && existsSync(override) ? override : findWinBinDir();
  if (binDir && existsSync(binDir)) {
    process.env.PATH = `${binDir};${process.env.PATH ?? ''}`;
  }
  dllPathPrepended = true;
}

function findWinBinDir(): string | null {
  const tryResolve = (spec: string): string | null => {
    try { return dirname(nodeRequire.resolve(spec)); } catch { return null; }
  };
  // 1) direct dep (rare — win-x64 is nested under sherpa-onnx-node with pnpm).
  const direct = tryResolve('sherpa-onnx-win-x64/package.json');
  if (direct) return direct;
  // 2) sibling of the glue package (works for the pnpm nested layout). Try both
  //    the package.json export and the main entry (exports maps differ).
  for (const anchor of [tryResolve('sherpa-onnx-node/package.json'), tryResolve('sherpa-onnx-node')]) {
    if (!anchor) continue;
    const sibling = join(anchor, '..', 'sherpa-onnx-win-x64');
    if (existsSync(sibling)) return sibling;
  }
  return null;
}

function threadsFromEnv(): number {
  const raw = process.env.FLOWMIC_SHERPA_THREADS;
  if (!raw) return 2; // spike §4 sweet spot (28× realtime, memory doubles then stops)
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/**
 * NR-38 — build the recognizer WITHOUT taking the event loop hostage.
 *
 * THE DEFECT THIS IS THE FIX FOR (ledger §25, G10 root cause 2026-09-11): the
 * first press after a sidecar start spent ~8 s in `open()` and the 5 s
 * `raceSpawnTimeout` cap could not fire against it. Two costs were named there;
 * only ONE of them was ever the event loop's problem, and this machine measured
 * which (dev-pc-a, node v22.22.3, real
 * `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`, 239_233_841 bytes,
 * a 50 ms `setInterval` watching max tick latency):
 *
 *   the model SHA-256 (`model-fetch.ts` sha256File)   367–538 ms, max tick lag  0 ms
 *   `new OfflineRecognizer(cfg)`                    1_505 ms, max tick lag 1_455 ms (0 ticks ran)
 *   `OfflineRecognizer.createAsync(cfg)`            1_410 ms, max tick lag    14 ms (22 ticks ran)
 *
 * ⇒ the hash was ALREADY non-blocking — it is `createReadStream` piped into the
 * hash and it yields between chunks — so the「哈希同步阻塞」half of the ledger
 * entry is not what the loop was dying of. The native constructor was: it runs
 * the whole ONNX session build on the JS thread, so no timer, no socket read
 * and no ack could be serviced for its entire duration. `createAsync` does the
 * same work on a libuv worker and costs the same WALL time — the loop just
 * stays alive through it, which is what makes the spawn cap able to fire at all.
 *
 * ⚠️ WHAT THIS DOES NOT DO: the load is not faster. A 1 GB pack still takes as
 * long as it takes; what changed is that the process can answer while it does.
 */
export async function constructRecognizer(
  sherpa: SherpaModule,
  cfg: unknown,
): Promise<OfflineRecognizer> {
  const Ctor = sherpa.OfflineRecognizer;
  // Runtime check, not a version check: see SherpaOfflineRecognizerCtor.
  if (typeof Ctor.createAsync === 'function') return Ctor.createAsync(cfg);
  return new Ctor(cfg);
}

/**
 * 🔴 Model auto-download is OPT-IN (owner ruling 2026-08-09, DISC-2): a local /
 * self-hosted install must never fetch the model from huggingface/github on its
 * own — the operator supplies the model, or explicitly sets
 * FLOWMIC_SHERPA_AUTO_DOWNLOAD=1 (or =true). Anything else — unset, empty, "yes",
 * a typo — stays OFF, because the failure directions are not symmetric: an
 * unwanted download leaks the fact of the install to a third party and breaks
 * the "nothing leaves your own hardware" disclosure, while a refused download
 * is a loud, actionable STT_CONFIG_MISSING. Strict '1'/'true' follows
 * `managed-default.ts` (same idiom, same reason).
 */
export function sherpaAutoDownloadEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

function pcmS16leToFloat32(pcm: Buffer): Float32Array {
  const n = pcm.length >> 1; // 2 bytes / sample
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * REQ-13-19 — the silence floor for the pre-decode gate in `flush()`.
 *
 * Provenance (engine-direct measurement, 2026-08-13, HANBJ dev box,
 * `scratch/q1-silence-hallucination-findings-2026-08-13.md`): SenseVoice-small
 * hallucinates REAL WORDS on non-speech input — pure zeros (peak 0) → "我." (lit. "I."),
 * synthetic noise at float amp 1e-2 (peak ≈ 328) → "그." (Korean, a hallucinated fragment), with a passing
 * speech positive control. Non-autoregressive attention encoders emit tokens on
 * anything; the model will not stop doing this, so we must not feed it silence.
 *
 * 655 ≈ 2% of int16 full scale: 2× above the measured hallucination band
 * (≤ 328) and far below any plausible speech peak through a phone capture
 * chain (a quiet ROOM's ambient alone measured peak 2136). The failure
 * directions are asymmetric — a floor set too high silently eats soft speech
 * (red line), a floor set too low lets "我" (lit. "I") through (this defect) — so the
 * value hugs the proven-hallucination band rather than the speech band.
 *
 * 🔴 Why this is NOT the existing vad-gate: that gate is a BILLING gate
 * (voiced-seconds metering, wired only for managed streaming engines), and its
 * notion of "voiced" cannot discriminate here — the same quiet room measured
 * voicedMs 5260/5600. Reusing it would be one value answering two questions.
 */
export const SILENCE_PEAK_ABS_FLOOR = 655;

/** Peak |sample| over an s16le buffer. O(n) over ~80k samples per 5s — trivial
 *  next to the offline decode it can save. */
export function utterancePeakAbs(pcm: Buffer): number {
  let peak = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * REQ-13-19 — the post-decode content gate. True iff the text carries at least
 * one letter or digit in any script (Unicode L/N). The in-situ half of the
 * finding: ambient noise above the energy floor (quiet-room peak 2136) decodes
 * to "." (a bare period), which the phone itself counts as 0 characters yet still DELIVERS as a row.
 * A final with no lexical content is not a transcript; it takes the honest
 * empty-final path instead. "我."/"그." pass this test (they carry a letter)
 * — that is what the energy floor above is for. The two gates are complements,
 * not alternatives. What NEITHER catches: loud-noise hallucination of real
 * words (measured 25 chars in a noisy window) — that needs a real VAD in front
 * of the decode (finding's option ②, deliberately out of this fix's scope).
 */
export function hasLexicalContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** The one step of `open()` that needs 228 MB of model and a native addon. */
export interface SherpaLocalDeps {
  /** Resolve + verify the model directory and load (or reuse) a recognizer.
   *
   *  🔴 Injectable for ONE reason, stated so nobody mistakes it for a policy
   *  hook: the model is not in the repo and the addon is not installed in CI, so
   *  without this seam every test of `push()` / `flush()` / the live preview has
   *  to drive a re-implementation of this engine instead of this engine. The
   *  default IS the production implementation (a DI default must be the real
   *  thing or throw — CLAUDE.md anti-façade ②); production never passes this. */
  openRecognizer?: () => Promise<OfflineRecognizer>;
}

export class SherpaLocalEngine extends EventEmitter implements SttEngine {
  readonly id = 'sherpa-local';
  /**
   * 🔴 INT-2 (2026-08-12) — THE DECLARATION, and it is a fact about the code
   * three files away, not a preference.
   *
   * `push()` below publishes whatever `SherpaPreviewDecoder.push()` returns, and
   * that method returns `joinPreviewSpans(this.committed, tailDecode)` — the
   * frozen prefix plus a fresh decode of the whole uncommitted tail, i.e. THE
   * WHOLE UTTERANCE SO FAR, every time. It is also revisable in the middle:
   * SenseVoice punctuates as a function of the span, so a "。" (full stop) turns into a
   * "，" (comma) the moment more speech follows it.
   *
   * ⚠️ Anchored so this cannot rot into a claim about somebody else's code
   * (anti-façade ④): the property is pinned by `test/sherpa-preview.test.ts`
   * "every preview starts with the frozen prefix" and by the seam test's
   * `expect(r.rec.spans).toContain(last)` — if a future preview ever emits a
   * DELTA, that assertion is what turns red.
   */
  readonly interimShape = 'cumulative' as const;
  /**
   * NR-50 — the second declaration, and the one `raceFlushFinal` keys its
   * fallback on: every interim this engine emits is `SherpaPreviewDecoder`'s
   * tail re-decode — spans decoded WITHOUT their left context and cut at an
   * energy boundary (this file's `flush()` says so where it decodes the real
   * one). They are previews. When the terminal decode does not answer, the
   * accumulated preview is NOT delivered in its place; see `FlushOutcome.refused`.
   */
  readonly interimIsPreviewOnly = true as const;
  /**
   * card NR-60 — the third declaration, and the only one that changes with the
   * PACK rather than with this class: a whisper row's recognizer keeps the first
   * 30 s of any wave and discards the rest (`maxDecodeAudioMsFor` carries the
   * measurement). The orchestrator rotates the leg before a flush can hand one
   * more than this.
   *
   * ⚠️ `undefined` before `open()` resolves a row, and for the seam-injected
   * recognizer the preview tests drive — the same `activeRow === null` case the
   * preview gate reads one screen down. That is today's behaviour (no bound),
   * which is the right failure direction here: production always has a row by
   * the time a chunk is pushed, so the null case cannot silently shorten a leg
   * for an engine that did not need it.
   */
  get maxDecodeAudioMs(): number | undefined {
    return this.activeRow === null ? undefined : maxDecodeAudioMsFor(this.activeRow);
  }
  private _state: EngineState = 'closed';
  /**
   * NR-50 — one terminal decode at a time. `flush()` clears the utterance
   * buffer BEFORE it decodes and the decode now yields, so a second `flush()`
   * landing during the first would see an empty buffer and resolve with no
   * final while the first is still computing — two callers, two ideas of
   * 「done」. Chaining makes the second wait for the first. The orchestrator
   * never double-flushes a leg (`flushing` / `isLegBusy`), so this guards the
   * contract rather than a path production walks.
   */
  private flushChain: Promise<void> = Promise.resolve();
  /**
   * NR-50 — a terminal decode is on the libuv worker right now. Read by
   * `push()`: a preview re-decode would drive the SAME recognizer from the JS
   * thread while the worker holds it. Whether the addon tolerates two decodes
   * on one recognizer at once was NOT measured, and a preview is an
   * enhancement that already degrades to 「no interim」 by design — so it stands
   * down for the duration instead of betting on it. The audio still accumulates.
   */
  private finalDecodeInFlight = false;
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private rec: OfflineRecognizer | null = null;
  /** The catalog row open() resolved — decides the loader config AND whether
   *  the live preview runs (quasi rows only). Null until open() succeeds and
   *  for seam-injected recognizers, where preview stays on (the seam tests
   *  drive the preview path and predate the catalog). */
  private activeRow: CatalogModel | null = null;
  private readonly openRecognizer: () => Promise<OfflineRecognizer>;
  /** REQ-12-05 live preview. Built here rather than in open() so `decode` can
   *  close over `this.rec` and read it at CALL time — open() installs the
   *  recognizer after this constructor has run. */
  private readonly preview = new SherpaPreviewDecoder({
    decode: (pcm) => this.decodeSpan(pcm),
    onDisabled: (reason: PreviewDisableReason, detail) => {
      // A degraded enhancement is invisible to the user by design (they simply
      // see today's behaviour). It must not be invisible to the operator.
      log.warn('sherpa-local live preview disabled for this session', { reason, ...detail });
    },
  });

  constructor(private cfg: SttEngineConfig, deps: SherpaLocalDeps = {}) {
    super();
    this.openRecognizer = deps.openRecognizer ?? ((): Promise<OfflineRecognizer> => this.loadModelAndRecognizer());
  }

  get state(): EngineState { return this._state; }

  async open(): Promise<void> {
    if (this._state !== 'closed') {
      throw new Error(`SherpaLocalEngine.open: illegal in state ${this._state}`);
    }
    this.chunks = [];
    this.byteLength = 0;
    this.preview.reset();
    try {
      this.rec = await this.openRecognizer();
    } catch (err) {
      // An already-coded refusal (the debug-override language check below)
      // must pass through verbatim — re-wrapping would replace its precise
      // code with the generic CONFIG_MISSING.
      if (err instanceof SttEngineError) throw err;
      // fail-loud: model missing/integrity/load failure surfaces an explicit
      // stt:error — never a silently-degraded or bad-model session.
      const msg = err instanceof Error ? err.message : String(err);
      const network = /HTTP|fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|tarball/i.test(msg);
      throw new SttEngineError(
        network ? 'STT_NETWORK_DROP' : 'STT_CONFIG_MISSING',
        `sherpa-local open failed: ${msg}`,
        network,
      );
    }
    this.transition('open');
  }

  /** The production `openRecognizer`: DLL path fix → catalog resolution (which
   *  model serves this language, LM-CAT §6) → verify/opt-in download →
   *  typed recognizer load. The error mapping stays in open(). */
  private async loadModelAndRecognizer(): Promise<OfflineRecognizer> {
    prependNativeDllDir();
    const resolved = await this.resolveModelForOpen();
    this.activeRow = resolved.row;
    return this.loadRecognizer(resolved.row, resolved.dir);
  }

  /**
   * Which catalog row (and directory) this session opens.
   *
   *   · `FLOWMIC_SHERPA_MODEL_DIR` set — the single-model debug path the
   *     measure/smoke scripts depend on: that directory holds exactly one
   *     model, named by `FLOWMIC_SHERPA_MODEL_ID` (default: the SenseVoice
   *     row, which is what every pre-LM-CAT script staged there).
   *   · otherwise the §6 ladder over the catalog (selection → ready rows).
   *   · otherwise the unattended pair: `FLOWMIC_SHERPA_AUTO_DOWNLOAD=1`
   *     **and** `FLOWMIC_SHERPA_MODEL_ID` naming a row that claims the
   *     language — only the named row is fetched (LM-CAT §7: the env flag
   *     alone no longer implies "fetch SenseVoice"; an unattended machine
   *     must say WHICH pack, or nothing is fetched).
   *   · otherwise the loud refusal (→ STT_CONFIG_MISSING at open()).
   */
  private async resolveModelForOpen(): Promise<ResolvedModel> {
    const env = process.env;
    const autoDownload = sherpaAutoDownloadEnabled(env.FLOWMIC_SHERPA_AUTO_DOWNLOAD);
    const override = env.FLOWMIC_SHERPA_MODEL_DIR;
    if (override && override.length > 0) {
      const row = catalogModelById(env.FLOWMIC_SHERPA_MODEL_ID ?? '') ?? catalogModelById(SENSE_VOICE_MODEL_ID)!;
      // The debug override skips the catalog ladder, NOT the language gate:
      // German fed to a staged SenseVoice would come back as 「.」 — the exact
      // WP3 C13 defect — so the mismatch refuses with the precise code here.
      if (!sherpaModelCanRecognize(this.cfg.language, row)) {
        throw new SttEngineError(
          'STT_LANGUAGE_UNSUPPORTED',
          `sherpa-local (debug override): model '${row.model_id}' cannot recognise language ${this.cfg.language}`,
          false,
        );
      }
      await ensureSherpaModel(override, { autoDownload, model: row });
      return { row, dir: override };
    }
    const ready = await resolveReadyModelForLanguage(this.cfg.language);
    if (ready) return ready;
    if (autoDownload) {
      const named = catalogModelById(env.FLOWMIC_SHERPA_MODEL_ID ?? '');
      if (named && isLoadableThisPhase(named) && sherpaModelCanRecognize(this.cfg.language, named)) {
        const dir = resolveModelDir(named.model_id, env);
        await ensureSherpaModel(dir, { autoDownload: true, model: named });
        return { row: named, dir };
      }
      log.warn('sherpa-local: auto-download is on but FLOWMIC_SHERPA_MODEL_ID names no usable catalog row for this language — refusing rather than guessing a pack', {
        language: this.cfg.language,
        model_id_env: env.FLOWMIC_SHERPA_MODEL_ID ?? '(unset)',
      });
    }
    // No ready model claims this language: the same loud, non-network refusal
    // ensureSherpaModel raises — the user's action is the settings download.
    log.warn('sherpa-local: no ready local model claims this language', { language: this.cfg.language });
    throw new SherpaModelNotReadyError(resolveModelDir('')); // '' ⇒ the models root itself
  }

  private loadRecognizer(row: CatalogModel, modelDir: string): Promise<OfflineRecognizer> {
    const numThreads = threadsFromEnv();
    // Whisper/Canary embed the language in the model config itself, so those
    // kinds key the cache per language too — a French session must not reuse
    // the recognizer a German one built (loader-config.ts says why).
    const langFacet = loaderConfigEmbedsLanguage(row) ? baseLang(this.cfg.language) : '';
    const cacheKey = `${modelDir}::${numThreads}::${langFacet}`;
    // NR-49 (owner ruling 2026-09-16 §1): this used to call
    // `noteRecognizerLoaded(row.model_id)` so model-in-use.ts could refuse to
    // delete any pack this process had loaded. That hold is gone — its
    // mechanism was measured false on 2026-09-15 and the owner ruled the pack
    // deletable — so the call went with it rather than staying as bookkeeping
    // nothing reads. What did NOT change is this cache: a delete cannot free
    // a recognizer (the addon exposes no destructor, pinned by
    // test/sherpa-addon-surface.test.ts), and it does not need to — a deleted
    // pack fails the controller's readiness check, so the ladder never asks
    // for it again and this entry is simply unreachable.
    const cached = RECOGNIZER_CACHE.get(cacheKey);
    if (cached) return cached;
    const sherpa = nodeRequire(SHERPA_SPECIFIER) as SherpaModule;
    const pending = constructRecognizer(sherpa, {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      // The ONE writer of loader configs (LM-CAT §5) — the senseVoice-only
      // inline this replaces lives on only as that switch's senseVoice arm.
      modelConfig: offlineModelConfigFor(row, modelDir, this.cfg.language, numThreads),
    });
    RECOGNIZER_CACHE.set(cacheKey, pending);
    pending.catch(() => {
      // Only if it is still OURS — a later attempt may already have replaced it.
      if (RECOGNIZER_CACHE.get(cacheKey) === pending) RECOGNIZER_CACHE.delete(cacheKey);
    });
    return pending;
  }

  /** One offline decode of one PCM span, on the JS thread. THROWS — each caller
   *  decides what a failure means: for a preview it is a reason to stand down
   *  quietly (see SherpaPreviewDecoder). The TERMINAL decode no longer comes
   *  here — see {@link decodeSpanAsync}. */
  private decodeSpan(pcm: Buffer): string {
    if (!this.rec) throw new Error('recognizer not loaded');
    const stream = this.rec.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: pcmS16leToFloat32(pcm) });
    this.rec.decode(stream);
    const result = this.rec.getResult(stream);
    return typeof result.text === 'string' ? result.text : '';
  }

  /**
   * NR-50 — the terminal decode, off the event loop.
   *
   * THE DEFECT (ledger §33, measured 2026-09-15 and re-measured on
   * dev-pc-a 2026-09-16 with `--decode-cost`): `rec.decode()` is a
   * synchronous native call, and the whole-utterance decode ran inside it — so
   * for its entire duration not one timer, socket read or ack was serviced.
   * SenseVoice 45 s: 2 067 ms with `ticks 0`; whisper-turbo 30 s: 17 095 ms
   * with `ticks 0`. `decodeAsync` costs the SAME wall time (1 981 / 16 887 ms)
   * and the loop stays alive through it (65 / 553 ticks ran). Same shape, same
   * fix and same non-claim as NR-38's `createAsync`: not faster — answerable.
   *
   * Runtime check, not a version check (see the interface): an addon without
   * the method decodes synchronously, exactly as before this card.
   *
   * The recognizer is captured LOCALLY: `close()` nulls `this.rec` while the
   * worker may still be mid-decode, and `getResult` must be asked of the
   * recognizer that decoded the stream. THROWS like `decodeSpan`.
   */
  private async decodeSpanAsync(pcm: Buffer): Promise<string> {
    const rec = this.rec;
    if (!rec) throw new Error('recognizer not loaded');
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: pcmS16leToFloat32(pcm) });
    if (typeof rec.decodeAsync === 'function') await rec.decodeAsync(stream);
    else rec.decode(stream);
    const result = rec.getResult(stream);
    return typeof result.text === 'string' ? result.text : '';
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open') {
      throw new SttEngineError('STT_ENGINE_NOT_OPEN', `SherpaLocalEngine.push: not open (${this._state})`, true);
    }
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    // LM-CAT §5: the live preview is a QUASI-streaming behaviour of the
    // SenseVoice pack (cheap tail re-decodes). For a plain-offline row
    // (whisper / transducer / nemo / canary) a tail decode costs a full
    // encoder pass — seconds per preview — so those rows run final-only,
    // exactly as the task allows (「对 whisper/transducer 第一刀允许 preview
    // 缺席」). `activeRow === null` (seam-injected recognizer) keeps the
    // preview, because the preview suite drives this path.
    if (this.activeRow !== null && this.activeRow.streaming !== 'quasi') return;
    // NR-50: the recognizer is busy with the terminal decode on the worker —
    // the preview stands down (see `finalDecodeInFlight`); the chunk above is
    // already in the utterance buffer, so no audio is lost by this return.
    if (this.finalDecodeInFlight) return;
    // REQ-12-05. Ordered AFTER the accumulate on purpose: the utterance buffer
    // that produces the FINAL is written first and unconditionally, so no
    // preview outcome — including a throw that got past the decoder — can cost
    // the user audio.
    const text = this.preview.push(chunk);
    if (text === null) return;
    const ev: InterimResult = {
      kind: 'interim',
      text,
      // 1, matching this engine's `final`: SenseVoice reports no per-span
      // confidence, and inventing a lower number for a preview would be a
      // measurement nobody made.
      confidence: 1,
      language: this.cfg.language,
    };
    this.emit('interim', ev);
  }

  flush(): Promise<void> {
    // NR-50: serialised — see `flushChain`. A rejected run must not poison the
    // chain for the next caller; `flushOnce` never rejects (it emits), but the
    // chain is kept settled regardless.
    const run = this.flushChain.then(() => this.flushOnce());
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (this._state !== 'open' || this.byteLength === 0 || !this.rec) return;
    // 🔴 REQ-12-05 — ONE line per utterance saying what the previews actually
    // cost on THIS machine. Written before the terminal decode so it lands even
    // if that one throws.
    //
    // The self-limiting budget is an argument about `maxDecodeMs`, and until now
    // that number existed nowhere outside this process: the WARN only fired once
    // the verdict had already been reached, so "previews are fine here" and
    // "previews were never even attempted" left IDENTICAL logs (both silent).
    // `decodes:0` now separates them, and `emitted` separates "decoded, but the
    // text never changed" from "never decoded".
    // ⚠️ Counts only. The preview text is what the user said.
    log.info('sherpa-local preview cost for this utterance', {
      ...this.preview.stats,
      audio_ms: Math.round((this.byteLength / (SAMPLE_RATE * 2)) * 1000),
    });
    const pcm = Buffer.concat(this.chunks, this.byteLength);
    const durationMs = Math.round((this.byteLength / (SAMPLE_RATE * 2)) * 1000);
    this.chunks = [];
    this.byteLength = 0;
    try {
      // 🔴 The WHOLE utterance, decoded from scratch — never assembled from the
      // preview's frozen spans. Those were decoded without their left context
      // and split at an energy boundary; this one is the real transcript.
      //
      // REQ-13-19: two gates around that decode, because SenseVoice hallucinates
      // real words on non-speech input (constants above carry the measurements).
      // An utterance they reject emits an EMPTY final — the existing honest
      // path (no delivery row, the phone's own no-transcript notice) — never a
      // fabricated "我" (lit. "I") in the user's editor. The gates guard the FINAL only:
      // previews are deliberately un-gated (they deliver nothing, and hiding
      // them during near-silence is a UX call this fix does not make).
      const peak = utterancePeakAbs(pcm);
      let text: string;
      if (peak < SILENCE_PEAK_ABS_FLOOR) {
        // Skipping the decode is the point: on zero-energy input every token
        // the model would emit is fiction.
        log.info('sherpa-local silence gate: utterance below the energy floor, emitting an empty final', {
          peak_abs: peak, floor: SILENCE_PEAK_ABS_FLOOR, audio_ms: durationMs,
        });
        text = '';
      } else {
        // NR-50: off the loop. Everything below this await runs AFTER a yield,
        // so the leg may have been closed meanwhile (the orchestrator's flush
        // cap fired and it moved on, or the session ended) — a final emitted
        // then would land on a closed engine with no listeners, or worse, on
        // the next leg's accumulators. The state check is the guard; the
        // orchestrator-level pin is `nr50-local-flush-cap.test.ts`.
        this.finalDecodeInFlight = true;
        try {
          text = await this.decodeSpanAsync(pcm);
        } finally {
          this.finalDecodeInFlight = false;
        }
        if (this._state !== 'open') {
          // Counts only — the decoded text stays out of the log.
          log.warn('sherpa-local: terminal decode finished after the leg was closed; its result was dropped', {
            decoded_chars: text.length, audio_ms: durationMs,
          });
          return;
        }
        if (text !== '' && !hasLexicalContent(text)) {
          // Counts only — the decoded text stays out of the log (transcript
          // content never lands in server.log; same rule as the preview stats).
          log.info('sherpa-local content gate: decode carried no letter or digit, emitting an empty final', {
            decoded_chars: text.length, peak_abs: peak, audio_ms: durationMs,
          });
          text = '';
        }
      }
      const ev: FinalResult = {
        kind: 'final',
        text,
        confidence: 1,
        language: this.cfg.language,
        duration_ms: durationMs,
      };
      this.emit('final', ev);
    } catch (err) {
      if (this._state !== 'open') {
        log.warn('sherpa-local: terminal decode failed after the leg was closed; nothing to report it to', {
          audio_ms: durationMs, message: (err as Error).message,
        });
        return;
      }
      // NR-50: `retryable: false`. This is the flush phase of a LOCAL decode —
      // no ladder, no reconnect, nothing that a retry from the server's side
      // could change — and the phone reads a terminal `stt:error` as an
      // immediate stall that names the code, whereas `true` was only ever
      // diagnosed and let the preview be delivered as the final (the same
      // R11 breach as the cap, one branch over). `flushErrorVerdict` passes a
      // non-retryable engine error through verbatim.
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', `sherpa-local decode failed: ${(err as Error).message}`, false));
    }
  }

  close(): Promise<void> {
    // Detach from the (cached, hot) recognizer — do not free it (kept warm for
    // the next utterance). Clear the buffer only.
    //
    // 🔴 NR-45 (2026-09-15, measured on dev-pc-b against the installed
    // sherpa-onnx-node@1.13.4): 「do not free it」 is no longer a choice this
    // line makes — THERE IS NO FREE TO CALL. `OfflineRecognizer` offers
    // constructor / createAsync / createStream / setConfig / decode /
    // decodeAsync / getResult; `OfflineStream` offers constructor /
    // acceptWaveform / setOption; and not one of the addon's 99 native exports
    // matches free|destroy|release|dispose|unload. (The C library's
    // `SherpaOnnxDestroyOfflineRecognizer` IS linked into the addon binary, so
    // something inside it can destroy one — nothing reachable from here can.)
    // ⇒ the eviction path NR-45 asked for was deliberately NOT written: a
    // method named `release` that only drops a Map entry would claim a
    // capability the dependency does not have. Pinned by
    // `test/sherpa-addon-surface.test.ts`, which turns red the day upstream
    // adds one; re-measurable with
    // `scripts/drills/local-engine-lifecycle-probe.mjs --surface`.
    this.rec = null;
    this.activeRow = null;
    this.chunks = [];
    this.byteLength = 0;
    this.transition('closed');
    this.removeAllListeners();
    return Promise.resolve();
  }

  private transition(next: EngineState): void {
    this._state = next;
    this.emit('state', next);
  }
}

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
import { resolveSherpaModelDir } from '../sherpa/model-manifest';
import { ensureSherpaModel } from '../sherpa/model-downloader';
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
  getResult(stream: OfflineStream): { text?: string; lang?: string };
}
export interface OfflineStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
interface SherpaModule {
  OfflineRecognizer: new (cfg: unknown) => OfflineRecognizer;
}

/** Keep loaded recognizers hot across utterances (spike §7 risk 4: avoid the
 *  ~1s + 228 MB reload per recording). Keyed by model path + thread count. */
const RECOGNIZER_CACHE = new Map<string, OfflineRecognizer>();

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
  private _state: EngineState = 'closed';
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private rec: OfflineRecognizer | null = null;
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

  /** The production `openRecognizer`: DLL path fix → model resolve/verify (with
   *  the opt-in download) → recognizer load. VERBATIM the body that used to sit
   *  inside `open()`'s try block; the error mapping stays there. */
  private async loadModelAndRecognizer(): Promise<OfflineRecognizer> {
    prependNativeDllDir();
    const modelDir = resolveSherpaModelDir();
    await ensureSherpaModel(modelDir, {
      autoDownload: sherpaAutoDownloadEnabled(process.env.FLOWMIC_SHERPA_AUTO_DOWNLOAD),
    });
    return this.loadRecognizer(modelDir);
  }

  private loadRecognizer(modelDir: string): OfflineRecognizer {
    const numThreads = threadsFromEnv();
    const cacheKey = `${modelDir}::${numThreads}`;
    const cached = RECOGNIZER_CACHE.get(cacheKey);
    if (cached) return cached;
    const sherpa = nodeRequire(SHERPA_SPECIFIER) as SherpaModule;
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: join(modelDir, 'model.int8.onnx'),
          useInverseTextNormalization: 1,
          language: 'auto',
        },
        tokens: join(modelDir, 'tokens.txt'),
        numThreads,
        provider: 'cpu',
        debug: 0,
      },
    });
    RECOGNIZER_CACHE.set(cacheKey, rec);
    return rec;
  }

  /** One offline decode of one PCM span. THROWS — each caller decides what a
   *  failure means: for the final it is an engine error, for a preview it is a
   *  reason to stand down quietly (see SherpaPreviewDecoder). */
  private decodeSpan(pcm: Buffer): string {
    if (!this.rec) throw new Error('recognizer not loaded');
    const stream = this.rec.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: pcmS16leToFloat32(pcm) });
    this.rec.decode(stream);
    const result = this.rec.getResult(stream);
    return typeof result.text === 'string' ? result.text : '';
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open') {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `SherpaLocalEngine.push: not open (${this._state})`, true);
    }
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
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
    if (this._state !== 'open' || this.byteLength === 0 || !this.rec) return Promise.resolve();
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
        text = this.decodeSpan(pcm);
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
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', `sherpa-local decode failed: ${(err as Error).message}`, true));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    // Detach from the (cached, hot) recognizer — do not free it (kept warm for
    // the next utterance). Clear the buffer only.
    this.rec = null;
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

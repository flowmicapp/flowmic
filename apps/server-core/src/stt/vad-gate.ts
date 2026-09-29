// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (VAD gating: managed
//     streaming session-duration / audio-duration ≤ 1.3 — silence does not occupy billed streaming session time)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness; no silent failure)
//   docs/archive/strategy/R1-TASK-CARDS.md WP-R1-3 (VAD gating)
//
// Energy-based voice-activity gate. sherpa's Silero VAD (same stack as engine #7) is a
// heavier alternative; the spec explicitly permits energy-based gating, chosen here for a
// deterministic, native-dep-free, unit-testable baseline. For a metered
// STREAMING engine the bridge forwards audio ONLY while the gate is open, so
// silence never accumulates billed streaming-session time.
//
// sessionMs is analysed gate-open audio time, not vendor wall time or labelled
// speech. Settlement also caps it by unique accepted-and-answered audio.

import { MIN_PAUSE_MS } from './segment-boundary';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from './orchestrator-types';

// NR-103: local retained quiet/noisy material A measured 28.67%/23.28%
// gate-open time at -45 dBFS. A 1 s minimum window with 6/3 dB open/hold
// margins recovers >65%/>63%, while seeded stationary hiss (including a
// silence-to-hiss step) admits <3%. The -62 dBFS bound excludes near-silence
// after digital zero. These are corpus bounds, not universal speech labels.
// Keep the measured baseline's 20 ms analysis and 300 ms hangover: the
// fixtures do not justify longer padding. Existing 400 ms pre-roll remains
// owned by gate-preroll.ts. PCM format and -100 dB meter floor are unchanged.
const GATE = {
  bytesPerSample: 2, sampleScale: 32768, sampleRate: 16_000,
  frameMs: 20, hangoverMs: 300, fixedThresholdDb: -45, meterFloorDb: -100,
  absoluteFloorDb: -62, noiseWindowMs: 1000, openMarginDb: 6, holdMarginDb: 3,
} as const;

export interface VadGateOptions {
  /** PCM sample rate (16 kHz mono s16le fixed by 06 §1). */
  sampleRate?: number;
  /** Analysis frame length in ms (default 20 → 320 samples @16k). */
  frameMs?: number;
  /** Always-admit threshold in dBFS (default -45); adaptive detection may
   *  admit quieter audio. Env: FLOWMIC_STT_VAD_THRESHOLD_DB. */
  thresholdDb?: number;
  /** Keep the gate open this long after the last voiced frame (default 300 ms).
   *  Env: FLOWMIC_STT_VAD_HANGOVER_MS. */
  hangoverMs?: number;
}

/** card RC-6 — how often the gate CLOSED after having been open, and how long those closures ran (hangover
 *  excluded, gate time not wall time). The two thresholds are the relay's own: `MIN_PAUSE_MS` (600, the
 *  pause-cut arm, segment-boundary.ts) and the 3 s silence hang-up (`DEFAULT_ENGINE_IDLE_HANGUP_MS`). A closure
 *  still running at `finish()` is counted with the length it reached. */
export interface GateClosureCounts { count: number; ge_600ms: number; ge_3s: number }

export interface VadFrameResult {
  voiced: boolean;
  /** Gate state AFTER processing this frame. */
  gateOpen: boolean;
  amplitudeDb: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** RMS → dBFS for a frame of s16le samples in [start, end). */
function frameDb(pcm: Buffer, startSample: number, sampleCount: number): number {
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = pcm.readInt16LE((startSample + i) * GATE.bytesPerSample) / GATE.sampleScale;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, sampleCount));
  if (rms <= 0) return GATE.meterFloorDb;
  return Math.max(GATE.meterFloorDb, 20 * Math.log10(rms));
}

export class VadGate {
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly thresholdDb: number;
  private readonly hangoverMs: number;
  private residual: Buffer = Buffer.alloc(0);
  private _open = false;
  private silenceRunMs = 0;
  private _voicedMs = 0;
  private _sessionMs = 0;
  private _lastDb: number = GATE.meterFloorDb;
  private readonly noiseFrames: number;
  private readonly noiseHistory: number[] = [];
  private noiseIndex = 0;
  private _admitChunk = false;
  /** card RC-6 — the running closure (ms of gate time since it closed), or -1 while open / before first voice. */
  private closedRunMs = -1;
  private readonly _closures: GateClosureCounts = { count: 0, ge_600ms: 0, ge_3s: 0 };

  constructor(opts: VadGateOptions = {}) {
    this.sampleRate = opts.sampleRate ?? GATE.sampleRate;
    this.frameMs = opts.frameMs ?? GATE.frameMs;
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * this.frameMs) / 1000));
    this.thresholdDb = opts.thresholdDb ?? envNum('FLOWMIC_STT_VAD_THRESHOLD_DB', GATE.fixedThresholdDb);
    this.hangoverMs = opts.hangoverMs ?? envNum('FLOWMIC_STT_VAD_HANGOVER_MS', GATE.hangoverMs);
    this.noiseFrames = Math.max(1, Math.ceil(GATE.noiseWindowMs / this.frameMs));
  }

  get open(): boolean { return this._open; }
  /** Any admitted frame in the latest chunk, including padding before closure. */
  get admitChunk(): boolean { return this._admitChunk; }
  get voicedMs(): number { return this._voicedMs; }
  get sessionMs(): number { return this._sessionMs; }
  get lastAmplitudeDb(): number { return this._lastDb; }
  /** card RC-6 — a copy; read by the `audio intake` line (engine/stt-session.ts). */
  get closures(): GateClosureCounts { return { ...this._closures }; }

  /** sessionMs / voicedMs. 1 when no voiced audio has been seen (no billing). */
  ratio(): number {
    return this._voicedMs > 0 ? this._sessionMs / this._voicedMs : 1;
  }

  /**
   * Process a PCM chunk. Returns one result per full analysis frame consumed
   * (a partial tail frame is carried into the next call). The final per-frame
   * `gateOpen` is also exposed via `.open`.
   */
  process(chunk: Buffer): VadFrameResult[] {
    const buf = this.residual.length > 0 ? Buffer.concat([this.residual, chunk]) : chunk;
    const frameBytes = this.frameSamples * GATE.bytesPerSample;
    const results: VadFrameResult[] = [];
    this._admitChunk = false;
    let offset = 0;
    while (offset + frameBytes <= buf.length) {
      const db = frameDb(buf, offset / GATE.bytesPerSample, this.frameSamples);
      this._lastDb = db;
      const voiced = this.classify(db);
      this.step(voiced);
      this._admitChunk ||= this._open;
      results.push({ voiced, gateOpen: this._open, amplitudeDb: db });
      offset += frameBytes;
    }
    this.residual = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    // A sub-frame chunk cannot yet be classified; keep it when the gate is
    // already open. Full-frame timing/estimation still runs exactly once.
    if (results.length === 0) this._admitChunk = this._open;
    return results;
  }

  private classify(db: number): boolean {
    // A rolling minimum falls immediately and rises only once old low frames
    // expire. Compare BEFORE inserting this frame: an uncertain onset must not
    // train its own threshold. At startup keep audio above the absolute floor.
    const noiseDb = this.noiseHistory.length === 0
      ? GATE.meterFloorDb : Math.min(...this.noiseHistory);
    const margin = this._open ? GATE.holdMarginDb : GATE.openMarginDb;
    const threshold = Math.max(GATE.absoluteFloorDb, Math.min(this.thresholdDb, noiseDb + margin));
    this.noiseHistory[this.noiseIndex] = db;
    this.noiseIndex = (this.noiseIndex + 1) % this.noiseFrames;
    return db > threshold;
  }

  /** Advance the gate FSM by one frame; account voiced/session ms. */
  private step(voiced: boolean): void {
    if (voiced) {
      this.silenceRunMs = 0;
      this._voicedMs += this.frameMs;
      if (!this._open) { this._open = true; this.endClosure(); } // onset = first voiced frame
    } else if (this._open) {
      this.silenceRunMs += this.frameMs;
      if (this.silenceRunMs >= this.hangoverMs) { this._open = false; this.closedRunMs = 0; this._closures.count += 1; } // offset after hangover
    } else if (this.closedRunMs >= 0) {
      this.closedRunMs += this.frameMs;
    }
    if (this._open) this._sessionMs += this.frameMs;
  }

  /** Flush any residual tail as a final (short) frame and close the gate. */
  finish(): void {
    if (this.residual.length >= GATE.bytesPerSample) {
      const samples = this.residual.length >> 1;
      const db = frameDb(this.residual, 0, samples);
      this._lastDb = db;
      const voiced = this.classify(db);
      const partialMs = (samples / this.sampleRate) * 1000;
      if (voiced) { this._voicedMs += partialMs; if (!this._open) this._open = true; }
      if (this._open) this._sessionMs += partialMs;
    }
    this.residual = Buffer.alloc(0);
    this._open = false;
    this.endClosure();
  }

  /** card RC-6 — bucket the closure that just ended (or is cut short by `finish`). */
  private endClosure(): void {
    if (this.closedRunMs < 0) return;
    if (this.closedRunMs >= MIN_PAUSE_MS) this._closures.ge_600ms += 1;
    if (this.closedRunMs >= DEFAULT_ENGINE_IDLE_HANGUP_MS) this._closures.ge_3s += 1;
    this.closedRunMs = -1;
  }
}

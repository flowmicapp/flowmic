// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (VAD gating: managed
//     streaming session-duration / audio-duration ≤ 1.3 — silence does not occupy billed streaming session time)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness; no silent failure)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-3 (VAD gating)
//
// Energy-based voice-activity gate. sherpa's Silero VAD (same stack as engine #7) is a
// heavier alternative; the spec explicitly permits energy-based gating, chosen here for a
// deterministic, native-dep-free, unit-testable baseline. For a metered
// STREAMING engine the bridge forwards audio ONLY while the gate is open, so
// silence never accumulates billed streaming-session time.
//
// Metric (master-plan §2.3): ratio = sessionMs / voicedMs, where sessionMs is
// the wall-time the gate held open (billed) and voicedMs is the actual spoken
// audio. Hangover padding is the only overhead → ratio ≈ 1 + hangover/voiced.

const BYTES_PER_SAMPLE = 2;
const FLOOR_DB = -100;

export interface VadGateOptions {
  /** PCM sample rate (16 kHz mono s16le fixed by 06 §1). */
  sampleRate?: number;
  /** Analysis frame length in ms (default 20 → 320 samples @16k). */
  frameMs?: number;
  /** Voiced threshold in dBFS. Digital silence (zeros) is -inf → always below;
   *  clean speech sits well above (default -45). Env: FLOWMIC_STT_VAD_THRESHOLD_DB. */
  thresholdDb?: number;
  /** Keep the gate open this long after the last voiced frame (default 300 ms).
   *  Env: FLOWMIC_STT_VAD_HANGOVER_MS. */
  hangoverMs?: number;
}

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
    const s = pcm.readInt16LE((startSample + i) * BYTES_PER_SAMPLE) / 32768;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, sampleCount));
  if (rms <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(rms));
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
  private _lastDb = FLOOR_DB;

  constructor(opts: VadGateOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16_000;
    this.frameMs = opts.frameMs ?? 20;
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * this.frameMs) / 1000));
    this.thresholdDb = opts.thresholdDb ?? envNum('FLOWMIC_STT_VAD_THRESHOLD_DB', -45);
    this.hangoverMs = opts.hangoverMs ?? envNum('FLOWMIC_STT_VAD_HANGOVER_MS', 300);
  }

  get open(): boolean { return this._open; }
  get voicedMs(): number { return this._voicedMs; }
  get sessionMs(): number { return this._sessionMs; }
  get lastAmplitudeDb(): number { return this._lastDb; }

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
    const frameBytes = this.frameSamples * BYTES_PER_SAMPLE;
    const results: VadFrameResult[] = [];
    let offset = 0;
    while (offset + frameBytes <= buf.length) {
      const db = frameDb(buf, offset / BYTES_PER_SAMPLE, this.frameSamples);
      this._lastDb = db;
      const voiced = db > this.thresholdDb;
      this.step(voiced);
      results.push({ voiced, gateOpen: this._open, amplitudeDb: db });
      offset += frameBytes;
    }
    this.residual = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    return results;
  }

  /** Advance the gate FSM by one frame; account voiced/session ms. */
  private step(voiced: boolean): void {
    if (voiced) {
      this.silenceRunMs = 0;
      this._voicedMs += this.frameMs;
      if (!this._open) this._open = true; // onset = first voiced frame
    } else if (this._open) {
      this.silenceRunMs += this.frameMs;
      if (this.silenceRunMs >= this.hangoverMs) this._open = false; // offset after hangover
    }
    if (this._open) this._sessionMs += this.frameMs;
  }

  /** Flush any residual tail as a final (short) frame and close the gate. */
  finish(): void {
    if (this.residual.length >= BYTES_PER_SAMPLE) {
      const samples = this.residual.length >> 1;
      const db = frameDb(this.residual, 0, samples);
      this._lastDb = db;
      const voiced = db > this.thresholdDb;
      const partialMs = (samples / this.sampleRate) * 1000;
      if (voiced) { this._voicedMs += partialMs; if (!this._open) this._open = true; }
      if (this._open) this._sessionMs += partialMs;
    }
    this.residual = Buffer.alloc(0);
    this._open = false;
  }
}

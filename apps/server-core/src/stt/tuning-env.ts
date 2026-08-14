// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (FLOWMIC_STT_* tuning env — an illegal value at
//     startup is fail-loud, no silent fallback)
//   Ported from legacy stt/tuning-env.ts (mechanism unchanged from the old line).
//
// Pure parsers for STT tuning knobs. Unset env → baseline defaults (byte-
// identical to pre-plumbing constants). Malformed values throw immediately
// (fail-loud; no silent fallback — CLAUDE.md red line: no silent failure).

import type { OrchestratorOptions } from './orchestrator-types';

/** 16 kHz mono s16le → 32 bytes per millisecond. */
export const PCM_BYTES_PER_MS = 32;
/** Baseline VAD-closure silence duration (feed on flush for 2pass engines). */
export const DEFAULT_VAD_CLOSURE_MS = 400;
/** Baseline FunASR open-frame chunk_size / chunk_interval. */
export const DEFAULT_FUNASR_CHUNK_SIZE: readonly [number, number, number] = [5, 10, 5];
export const DEFAULT_FUNASR_CHUNK_INTERVAL = 10;

function requireNonNegInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name}: expected non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function requirePositiveInt(name: string, raw: string): number {
  const n = requireNonNegInt(name, raw);
  if (n <= 0) {
    throw new Error(`${name}: expected positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function requireBool(name: string, raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name}: expected "true" or "false", got ${JSON.stringify(raw)}`);
}

/** Orchestrator soft-segment / flush-timeout — omit fields when unset. */
export function readOrchestratorTuningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OrchestratorOptions, 'engineFlushTimeoutMs' | 'softSegmentMs'> {
  const out: Pick<OrchestratorOptions, 'engineFlushTimeoutMs' | 'softSegmentMs'> = {};
  const flush = env.FLOWMIC_STT_FLUSH_TIMEOUT_MS;
  if (flush !== undefined && flush !== '') {
    out.engineFlushTimeoutMs = requirePositiveInt('FLOWMIC_STT_FLUSH_TIMEOUT_MS', flush);
  }
  const soft = env.FLOWMIC_STT_SOFT_SEGMENT_MS;
  if (soft !== undefined && soft !== '') {
    out.softSegmentMs = requirePositiveInt('FLOWMIC_STT_SOFT_SEGMENT_MS', soft);
  }
  return out;
}

/** VAD-closure silence buffer length in bytes (default 12_800 = 400 ms). */
export function vadClosureSilenceBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FLOWMIC_STT_VAD_CLOSURE_MS;
  if (raw === undefined || raw === '') return DEFAULT_VAD_CLOSURE_MS * PCM_BYTES_PER_MS;
  return requireNonNegInt('FLOWMIC_STT_VAD_CLOSURE_MS', raw) * PCM_BYTES_PER_MS;
}

export function funasrItnFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FLOWMIC_STT_FUNASR_ITN;
  if (raw === undefined || raw === '') return true;
  return requireBool('FLOWMIC_STT_FUNASR_ITN', raw);
}

export interface FunasrChunkTuning {
  chunk_size: [number, number, number];
  chunk_interval: number;
}

/** Parse `FLOWMIC_STT_FUNASR_CHUNK` as "a,b,c/d" (default "5,10,5/10"). */
export function funasrChunkFromEnv(env: NodeJS.ProcessEnv = process.env): FunasrChunkTuning {
  const raw = env.FLOWMIC_STT_FUNASR_CHUNK;
  if (raw === undefined || raw === '') {
    return {
      chunk_size: [...DEFAULT_FUNASR_CHUNK_SIZE] as [number, number, number],
      chunk_interval: DEFAULT_FUNASR_CHUNK_INTERVAL,
    };
  }
  const m = /^(\d+),(\d+),(\d+)\/(\d+)$/.exec(raw);
  if (!m) {
    throw new Error(
      `FLOWMIC_STT_FUNASR_CHUNK: expected "a,b,c/d" (e.g. "5,10,5/10"), got ${JSON.stringify(raw)}`,
    );
  }
  return {
    chunk_size: [Number(m[1]), Number(m[2]), Number(m[3])],
    chunk_interval: Number(m[4]),
  };
}

/** Whisper temperature form field — undefined when unset (omit from FormData). */
export function whisperTemperatureFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.FLOWMIC_STT_WHISPER_TEMPERATURE;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `FLOWMIC_STT_WHISPER_TEMPERATURE: expected number in [0,1], got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function funspeechPuncFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FLOWMIC_STT_FUNSPEECH_PUNC;
  if (raw === undefined || raw === '') return true;
  return requireBool('FLOWMIC_STT_FUNSPEECH_PUNC', raw);
}

export function funspeechItnFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FLOWMIC_STT_FUNSPEECH_ITN;
  if (raw === undefined || raw === '') return true;
  return requireBool('FLOWMIC_STT_FUNSPEECH_ITN', raw);
}

/** Fail-loud at bootstrap: touch every knob's parser so bad env aborts start. */
export function assertSttTuningEnv(env: NodeJS.ProcessEnv = process.env): void {
  readOrchestratorTuningFromEnv(env);
  vadClosureSilenceBytes(env);
  funasrItnFromEnv(env);
  funasrChunkFromEnv(env);
  whisperTemperatureFromEnv(env);
  funspeechPuncFromEnv(env);
  funspeechItnFromEnv(env);
}

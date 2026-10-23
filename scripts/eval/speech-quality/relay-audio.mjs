// scripts/eval/speech-quality/relay-audio.mjs — scenario audio for run-relay.mjs
// (card EVAL-2). Builds the PCM a simulated phone streams, from the EVAL-1 WAVs.
//
// All buffers are 16 kHz mono s16le. Silence is digital zero, the same as
// gen-audio.mjs's onset variants, so the two harnesses' onset numbers compare.
// A real phone in a quiet room has a noise floor (around -60 dBFS); that is a
// known difference, not an oversight — the noise20 scenario is the other end.
//
// NOT A GATE. See README.md.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR, RESULTS_DIR, readJsonl, readWav } from './lib.mjs';

export const SAMPLE_RATE = 16000;
export const BYTES_PER_MS = 32; // 16 kHz * 2 bytes / 1000

export const silence = (ms) => Buffer.alloc(Math.round(ms) * BYTES_PER_MS);

/** Leading samples quieter than this (10 ms RMS, dBFS) count as silence. TTS
 *  output starts at about -50 dBFS breath/attack within ~100 ms. */
const ONSET_DBFS = -45;

function frameDbfs(pcm, startByte, lenBytes) {
  let sum = 0, n = 0;
  for (let i = startByte; i + 1 < Math.min(pcm.length, startByte + lenBytes); i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n++; }
  if (n === 0) return -Infinity;
  return 20 * Math.log10(Math.sqrt(sum / n) / 32768 + 1e-12);
}

/** Milliseconds of leading silence (first 10 ms frame above ONSET_DBFS). */
export function leadingSilenceMs(pcm) {
  const frame = 10 * BYTES_PER_MS;
  for (let off = 0; off < pcm.length; off += frame) if (frameDbfs(pcm, off, frame) > ONSET_DBFS) return off / BYTES_PER_MS;
  return pcm.length / BYTES_PER_MS;
}

/** The base WAV with its leading silence removed: speech starts at sample 0. */
export function trimLead(pcm) {
  const ms = leadingSilenceMs(pcm);
  return { pcm: pcm.subarray(Math.round(ms) * BYTES_PER_MS), trimmed_ms: ms };
}

/** EVAL-1's raw Soniox tokens per item (`base-stt-hints.jsonl`), used only to
 *  find a word boundary near the middle of an utterance for the mid-pause
 *  scenario. Token times are on the base WAV's own timeline. */
let tokensById = null;
function eval1Tokens(id) {
  if (tokensById === null) {
    tokensById = new Map();
    const p = join(RESULTS_DIR(), 'base-stt-hints.jsonl');
    if (existsSync(p)) for (const r of readJsonl(p)) if (!r.meta && r.variant === null && Array.isArray(r.tokens)) tokensById.set(r.id, r.tokens);
  }
  return tokensById.get(id) ?? null;
}

/** A word boundary near the middle: the inter-word gap whose midpoint is
 *  closest to half the speech time. Returns { split_ms, words_before } where
 *  words_before counts whole words in EVAL-1's final before the split (a proxy
 *  for the reference word index; EVAL-1's WER on these items is low). CJK has
 *  no spaces, so a boundary is any token gap there. */
export function midBoundary(id, lang) {
  const toks = eval1Tokens(id);
  if (!toks || toks.length < 4) return null;
  const cjk = lang !== 'en';
  const first = toks[0].s, last = toks[toks.length - 1].e;
  const mid = (first + last) / 2;
  let best = null;
  for (let i = 1; i < toks.length; i++) {
    const startsWord = cjk || /^\s/.test(toks[i].t);
    if (!startsWord) continue;
    const gapMid = (toks[i - 1].e + toks[i].s) / 2;
    if (best === null || Math.abs(gapMid - mid) < Math.abs(best.gapMid - mid)) best = { i, gapMid };
  }
  if (best === null) return null;
  const before = toks.slice(0, best.i).map((t) => t.t).join('');
  const words_before = cjk
    ? (before.match(/\p{Script=Han}|[A-Za-z0-9][A-Za-z0-9.':]*/gu) ?? []).length
    : before.trim().split(/\s+/).filter(Boolean).length;
  return { split_ms: Math.round(best.gapMid), words_before };
}

/**
 * One scenario's PCM.
 *   base          the EVAL-1 WAV as is (TTS lead ~100 ms)
 *   onset0        lead trimmed: speech at t=0, nothing before it
 *   onsetN        lead trimmed, then N s of silence (N = 1.5, 3, 5)
 *   midpause4     base WAV with 4 s of silence inserted at a mid-utterance word gap
 *   tailN         lead trimmed, then N s of silence AFTER the speech (card SEG-1)
 *   noise20       gen-audio.mjs's 20 dB SNR file
 *   stallN        base WAV unchanged, but the UPLINK stalls for N s at the middle of the
 *                 speech (card IDLE-1): run-relay.mjs holds every chunk from that point
 *                 back by N s, so the ones captured during the stall leave in a burst —
 *                 the shape of a phone whose socket buffered through a network stall
 * Returns null when the source file (or, for midpause, EVAL-1's token timing) is missing.
 */
export function scenarioPcm(item, scenario) {
  // item.audio (ML-0 FLEURS items) names a recording under AUDIO_DIR instead of <id>.wav.
  const basePath = join(AUDIO_DIR(), `${item.audio ?? item.id}.wav`);
  if (!existsSync(basePath)) return null;
  const base = readWav(basePath);
  if (scenario === 'base') return { pcm: base, speech_at_ms: leadingSilenceMs(base) };
  if (scenario === 'noise20') {
    const p = join(AUDIO_DIR(), `${item.id}__noise20.wav`);
    if (!existsSync(p)) return null;
    return { pcm: readWav(p), speech_at_ms: leadingSilenceMs(base) };
  }
  const onset = /^onset(\d+(?:\.\d+)?)$/.exec(scenario);
  if (onset) {
    const { pcm } = trimLead(base);
    const ms = Number(onset[1]) * 1000;
    return { pcm: Buffer.concat([silence(ms), pcm]), speech_at_ms: ms };
  }
  // card SEG-1: speech, then N s of silence before the release — the device shape where a
  // press past the soft-segment window is cut at that pause and the tail after the cut is empty.
  const tail = /^tail(\d+(?:\.\d+)?)$/.exec(scenario);
  if (tail) {
    const { pcm } = trimLead(base);
    return { pcm: Buffer.concat([pcm, silence(Number(tail[1]) * 1000)]), speech_at_ms: 0 };
  }
  const stall = /^stall(\d+(?:\.\d+)?)$/.exec(scenario);
  if (stall) {
    const lead = leadingSilenceMs(base);
    const speechMs = base.length / BYTES_PER_MS - lead;
    // on the 200 ms chunk grid, half way through the speech: mid-utterance, not at a pause
    const atMs = Math.round((lead + speechMs / 2) / 200) * 200;
    return { pcm: base, speech_at_ms: lead, stall: { at_ms: atMs, ms: Number(stall[1]) * 1000 } };
  }
  const mid = /^midpause(\d+(?:\.\d+)?)$/.exec(scenario);
  if (mid) {
    const b = midBoundary(item.id, item.lang);
    if (!b) return null;
    const cut = b.split_ms * BYTES_PER_MS;
    const pauseMs = Number(mid[1]) * 1000;
    return {
      pcm: Buffer.concat([base.subarray(0, cut), silence(pauseMs), base.subarray(cut)]),
      speech_at_ms: leadingSilenceMs(base),
      pause: { at_ms: b.split_ms, ms: pauseMs, words_before: b.words_before },
    };
  }
  throw new Error(`unknown scenario ${scenario}`);
}

/** Card POL-2 — every run of silence (10 ms frames under ONSET_DBFS) at least
 *  `minMs` long, as {at_ms, ms}. corpus-long.json plants a 2 s silence at each
 *  planned cut; run-two-stage.mjs --check-audio uses this to confirm that each
 *  planned silence falls past the relay's 30 s soft-segment window and that no
 *  natural pause before it is long enough to be cut on instead. */
export function silenceRuns(pcm, minMs) {
  const frame = 10 * BYTES_PER_MS;
  const runs = [];
  let start = null;
  for (let off = 0; off < pcm.length; off += frame) {
    const quiet = frameDbfs(pcm, off, frame) <= ONSET_DBFS;
    if (quiet && start === null) start = off;
    if (!quiet && start !== null) { if ((off - start) / BYTES_PER_MS >= minMs) runs.push({ at_ms: start / BYTES_PER_MS, ms: (off - start) / BYTES_PER_MS }); start = null; }
  }
  if (start !== null && (pcm.length - start) / BYTES_PER_MS >= minMs) runs.push({ at_ms: start / BYTES_PER_MS, ms: (pcm.length - start) / BYTES_PER_MS });
  return runs;
}

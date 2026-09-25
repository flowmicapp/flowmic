// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-T block: the gate-open pre-roll)
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §6.1 (「琥珀一号」→「破1号」: the onset lost when the
//     gate opens one chunk late on a leg that is already open), §8 RC-T
//
// card RC-T — WHEN THE VAD GATE GOES FROM CLOSED TO OPEN, THE LEG HEARS THE CLOSED RUN'S LAST ≤400 ms FIRST.
//
// The onset of a word after a pause can sit in the last chunk the gate still called silence (an h- or f-
// fricative below −45 dBFS). That chunk advanced the replay mark as it passed (RT-2: silence is never
// replayed), so no leg is ever given it. MEASURED (rerun-3 §6.1, offline probe straight from the WAV):
// the same audio with its first 100 ms cut reproduces 「破1号」 for 「琥珀一号」 character for character;
// from the onset it is right. Two earlier cards hand a tail over, each at one moment only — RC-5a when a
// row cut is DECIDED on a withheld chunk, RC-E when a silence hang-up REDIALS — and neither covers the
// path the device took: a row cut, a new leg already open, and the gate opening one chunk late.
//
// THE RULE, by where the audio would go:
//   · a leg open and not flushing ⇒ push the tail chunks it has not been handed yet, then the live chunk;
//   · a leg flushing (a rotation, a row cut, a silence hang-up) ⇒ it will not answer audio pushed after its
//     end-of-stream (F-2152, measured for Soniox), so the tail is recorded as audio owed to the next leg —
//     RC-L's unanswered floor, spent by the replay into that leg (`orchestrator-replay.ts` `replayIntoLeg`);
//   · no open leg (a dial or a ladder rung in flight) ⇒ lower the mark below the tail
//     (`takeRedialOnsetTail`, RC-E's rule), so the leg's replay starts there;
//   · hung up ⇒ nothing: the redial took the tail on this same chunk (`pushChunk`, RC-E).
//
// The pre-rolled chunks are not billed (the gate refused them: book 22 §4.9 RC-Q) and leave the pause
// account's withheld half, being in the leg's clock now (`segment-pause.ts` `notePreroll`).

import type { ClosedRunTail } from './pause-cut-boundary';
import type { LegFacts } from './leg-facts';
import type { SegmentPauseAccount } from './segment-pause';
import type { HeardAudioLedger } from './heard-audio';
import type { ReplayChunk } from './orchestrator-replay';
import { PCM_BYTES_PER_MS } from './tuning-env';

/** card RC-T — at most this much of the closed run is handed over: two of today's 200 ms chunks. An
 *  onset is at most a syllable's attack, and the probe that measured the loss cut 100–200 ms. */
export const GATE_OPEN_PREROLL_MS = 400;

/** What the pre-roll needs off the orchestrator — the structural-host pattern of `RolloverHost`. */
export interface GatePrerollHost {
  readonly engine: { readonly state: string; push(chunk: Buffer, ts_ms: number): void } | null;
  readonly flushing: boolean;
  readonly closedRunTail: ClosedRunTail;
  readonly legFacts: LegFacts;
  readonly pauseAccount: SegmentPauseAccount;
  readonly heard: HeardAudioLedger;
  readonly session: { replayTail(windowMs: number): ReplayChunk[] };
  readonly idle: { readonly isHungUp: boolean };
  engineFedBytes: number;
  legFedBytes: number;
  sessionFedBytes: number;
  unansweredFloorSeq: number | null;
  unheardVoice: boolean;
  takeRedialOnsetTail(): void;
}

/** Called on a chunk the gate ACCEPTED, before `ClosedRunTail.note` ends the run. A no-op when the gate
 *  was already open (the run is empty). */
export function gateOpenPreroll(h: GatePrerollHost): void {
  const tail = h.closedRunTail.lastSeqs(GATE_OPEN_PREROLL_MS);
  if (tail.length === 0 || h.idle.isHungUp) return;
  const engine = h.engine;
  if (engine !== null && h.flushing) {
    const floor = tail[0]! - 1;
    h.unansweredFloorSeq = Math.min(h.unansweredFloorSeq ?? floor, floor); h.unheardVoice = true;
    return;
  }
  if (engine === null || engine.state !== 'open') { h.takeRedialOnsetTail(); return; }
  const handed = h.legFacts.lastSeq;
  const want = new Set(tail.filter((s) => handed === null || s > handed));
  if (want.size === 0) return;
  let ms = 0;
  for (const c of h.session.replayTail(Number.POSITIVE_INFINITY)) {
    if (!want.has(c.seq)) continue;
    try { engine.push(c.payload, c.ts_ms); } catch (err) { console.error('[SttEngineOrchestrator] gate-open pre-roll push error (the live push reports the leg):', err); break; }
    h.engineFedBytes += c.payload.length; h.legFedBytes += c.payload.length; h.sessionFedBytes += c.payload.length;
    h.legFacts.noteLegChunk(c.seq, h.legFedBytes / PCM_BYTES_PER_MS);
    h.heard.noteFed(c.seq, c.payload.length, h.legFedBytes / PCM_BYTES_PER_MS);
    ms += c.payload.length / PCM_BYTES_PER_MS;
  }
  h.pauseAccount.notePreroll(ms);
}

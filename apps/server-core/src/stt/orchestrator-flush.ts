// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness: soft segmentation 30s / 5-minute hard cap /
//     engine reconnect ladder / no silent failure), §3 (spawn/flush timeout; segment dedup-merge)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` stood at 780 of its 800 lines and cards RC-A / RC-D /
// RC-E / RC-J (CR-12-E rerun root cause, 2026-09-24) all have to grow its chunk
// path. The family moved here is the FLUSH-AND-EMIT step: one leg's flush raced,
// its facts recorded, and its text leaving the class as a segment or terminal
// final. Behaviour is unchanged — this is a structural split, not a rewrite
// (repo convention, CLAUDE.md D-14; precedents `orchestrator-rollover.ts`,
// `orchestrator-terminal.ts`); every comment below carries the reasoning it
// carried inside the class, only the receiver changed from `this` to `host`.
//
// `flushAndEmitFinal` stays reachable under that name on the orchestrator (a thin
// wrapper that delegates here), because `RolloverHost` / `TerminalHost` call it
// by name and other files cite it by name.

import type { FinalResult } from './engines/base';
import type { SoftSegmentCadence } from './segment-boundary';
import type { SegmentPauseAccount } from './segment-pause';
import type { EngineSubscriber } from './orchestrator-types';
import type { FlushOutcome } from './flush-final';
import { seamText } from './segment-boundary';
import { engineBacklogMs } from './engine-backlog';

/** Everything the flush-and-emit step needs off the orchestrator — the same
 *  structural-interface pattern as `RolloverHost` / `TerminalHost`. */
export interface FlushEmitHost {
  engine: EngineSubscriber | null;
  terminated: boolean;
  terminalizing: boolean;
  flushErrored: boolean;
  flushing: boolean;
  accumEmittedByFinal: boolean;
  sessionProducedText: boolean;
  currentSegmentIdx: number;
  legFedBytes: number;
  readonly cadence: SoftSegmentCadence;
  readonly pauseAccount: SegmentPauseAccount;
  flushFinal(askEngine?: boolean, withholdOnTimeout?: boolean): Promise<FlushOutcome>;
  legVoicedBytes(): number;
  noteLegClosed(r: FinalResult): void;
  noteFlushRefused(timedOut: boolean): void;
  reportSilentEmptyFinal(text: string, timedOut: boolean): void;
  emitTerminalFinal(r: Pick<FinalResult, 'text' | 'confidence' | 'language'>, durationMs: number): boolean;
  emit(event: string, payload: unknown): boolean;
}

export async function flushAndEmitFinal(host: FlushEmitHost, isSegment: boolean, durationMs: number): Promise<boolean> {
  host.flushErrored = false; host.flushing = true;
  // card HANGUP-3 — the terminal flush takes HANGUP-2's empty-leg rule (`flushAndCloseLegForSilence`,
  // orchestrator-rollover.ts): a closing leg handed no audio is not asked, so a release within seconds
  // of a segment cut no longer earns 「No audio received」 ⇒ STT_NO_ENGINE_REACHED beside a full row.
  // Segment flushes keep asking (not ruled). Pinned by test/stt-empty-leg-and-owed-voice.test.ts.
  // card RC-2 — only the TERMINAL flush of an engine that reports a processed position withholds on
  // its cap (`withholdOnTimeout`); a segment flush that refused would end a live long recording.
  const { result: r, timedOut, refused } = await host.flushFinal(isSegment || host.legVoicedBytes() > 0, !isSegment && engineBacklogMs(host.engine, host.legFedBytes) !== null); // RC-5a: voice, not bytes
  host.flushing = false;
  // card CR-12-D — BEFORE every fence below, because this is a fact about the
  // LEG (how far its audio ran, where its words sat), and a final that is
  // withheld or dropped does not un-feed the audio. `first_word_ms` /
  // `last_word_ms` are absent on every engine but Soniox and on every flush
  // that captured no engine final; `segment-pause.ts` treats absence as its
  // own answer, never as 0.
  host.noteLegClosed(r);
  if (host.terminated || (isSegment && host.terminalizing)) return false;
  // NR-50 — a withheld local flush: NO final of any kind leaves here (an empty
  // one would be read by the phone as the flush-cap placeholder that keeps the
  // preview on screen as the transcript), and the refusal is said on the wire.
  if (refused) { host.noteFlushRefused(timedOut); return false; }
  if (host.flushErrored && r.text === '') return false; // no empty final on a flush error
  host.reportSilentEmptyFinal(r.text, timedOut);
  // card RT3-B: every final emitted below carries the accumulators out — see
  // `raceFlushFinal`, whose result text IS `getOfflineText()` on every branch
  // but one (timeout + a captured final that CONTAINS it as a prefix, i.e.
  // strictly more). Recording it here rather than at the two emit sites keeps
  // the fact in one place; {@link emitNoEngineTerminalFinal} is its only reader.
  host.accumEmittedByFinal = true; if (r.text !== '') host.sessionProducedText = true; // card EMPTY-1: BEFORE both exits, so one site covers segment and terminal finals alike
  if (!isSegment) return host.emitTerminalFinal(r, durationMs);
  // 🔴 card SEG-3 — the one place a segment's text leaves this class, so the one
  // place a full stop the SPAN produced (not the speaker) can be taken back off
  // on a 'leg' seam. F-2: a 'pause' cut keeps an engine-produced terminator.
  const pauseBeforeMs = host.pauseAccount.pauseBeforeMs();
  host.emit('final', {
    text: seamText(r.text, host.cadence.lastCutReason), confidence: r.confidence, language: r.language,
    segment_idx: host.currentSegmentIdx, is_segment: isSegment, duration_ms: durationMs,
    ...(pauseBeforeMs !== null ? { pause_before_ms: pauseBeforeMs } : {}),
  });
  return true;
}

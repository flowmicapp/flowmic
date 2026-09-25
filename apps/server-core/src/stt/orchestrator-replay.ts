// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.3 (5 s server replay window, measured
//     on recv_ms — card M3-4b), card RT-3 (unheard audio is not window-capped)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` sits on the 800-line cap. F-2 has to grow the
// chunk path and the pause-cut rollover; the standing answer is a STRUCTURAL
// split — move a coherent family out whole — never trim the reasoning a
// comment carries. The family here is the replay feed: reconnect (full 5 s)
// vs rollover (only seq > lastFed), plus the two clock facts that made this
// loop expensive to get wrong.
//
// Behaviour is unchanged. The log line names `replayBufferTail` so existing
// greps keep working.
//
// ⚠️ D-14 (2026-09-24, before cards RC-A/D/E/J): the orchestrator's own
// `replayBufferTail` body moved here too, as {@link replayIntoLeg} — the method
// that wraps {@link feedReplayBufferTail} with the leg's facts (RC-3b/4/5a/5b/5c,
// CR-12-D). VERBATIM; only the receiver changed from `this` to `orch` (the body
// already names its inner bag `host`). The orchestrator keeps a same-named
// wrapper, because `RolloverHost` / `TerminalHost` call it by that name.

import type { LegFacts } from './leg-facts';
import type { SegmentPauseAccount } from './segment-pause';
import { PCM_BYTES_PER_MS } from './tuning-env';
import { log } from '../log';

/** card RC-A — the WARN a gated replay logs when the ring no longer holds the
 *  chunk just above the mark, i.e. audio a leg is owed is already gone. */
export const STT_REPLAY_SHORT_EVENT = 'stt.replay_short';

export interface ReplayChunk {
  seq: number;
  ts_ms: number;
  payload: Buffer;
}

export interface ReplayFeedEngine {
  push(chunk: Buffer, ts_ms: number): void;
}

/**
 * Mutable counters the replay loop writes. Numbers are copied back by the
 * orchestrator because a plain bag would not mutate `this`.
 */
export interface ReplayTailHost {
  engine: ReplayFeedEngine | null;
  terminated: boolean;
  terminalizing: boolean;
  lastEngineFedSeq: number;
  engineFedBytes: number;
  sessionFedBytes: number;
  /** card CR-12-D — the highest seq the PREVIOUS leg was actually handed, or
   *  -1 when no previous leg shares audio with this one. Replayed chunks at or
   *  below it are audio that leg already heard (a duplicate at this leg's head);
   *  chunks above it were never heard by anyone. Only the first kind is an
   *  overlap between the two legs' clocks — see `segment-pause.ts`. */
  heardUpToSeq: number;
  /** card CR-12-D — OUT: bytes of the replay that were such duplicates. */
  overlapBytes: number;
  takeTail(): ReplayChunk[];
  armIdle(): void;
  /** card RC-4 overdue — called after each chunk is handed over (counters updated). Codex item 5: with its bytes. */
  onFed?(seq: number, bytes: number): void;
}

/** card RT-3 — is any engine still expected to be handed audio? Live, mid-rollover,
 *  or a reconnect rung armed. Once all three are false the ladder has given up
 *  and no replay will ever happen, so holding unheard audio would only leak. */
/// Re-feed buffered tail: RECONNECT (gateUnfed=false) full 5s; ROLLOVER (true) seq>lastFed.
export function feedReplayBufferTail(host: ReplayTailHost, gateUnfed = false): void {
  if (!host.engine || host.terminated || host.terminalizing) return;
  // card M3-4b: the window is measured on the RECEIVE clock, by the session that
  // stamped it — never `this.now()` against the phone's `ts_ms`. `chunk.ts_ms`
  // below is deliberately untouched: the engine wants CAPTURE order, and that
  // is the one question the phone's clock is the right answer to.
  // card RT-3, the READ half. The window still decides how much ALREADY-FED audio
  // is re-offered for context (so the duplication exposure measured in CASE 3
  // is unchanged, deliberately — owner already chose duplication over dropped content). What is
  // added is every chunk NO engine has heard, whatever its age: a window may
  // not decide whether unheard speech is delivered.
  const tail = host.takeTail();
  let fed = 0;
  for (const chunk of tail) {
    if (gateUnfed && chunk.seq <= host.lastEngineFedSeq) continue;
    try { host.engine.push(chunk.payload, chunk.ts_ms); host.engineFedBytes += chunk.payload.length; host.sessionFedBytes += chunk.payload.length; if (chunk.seq <= host.heardUpToSeq) host.overlapBytes += chunk.payload.length; host.lastEngineFedSeq = Math.max(host.lastEngineFedSeq, chunk.seq); fed += 1; host.onFed?.(chunk.seq, chunk.payload.length); } catch (err) { console.error('[SttEngineOrchestrator] replayBufferTail engine.push error (will surface via reconnect):', err); }
  }
  // card RT-2: replayed bytes are bytes the vendor received, so they restart the
  // silence countdown for the same reason a live push does.
  if (fed > 0) host.armIdle();
}

/** Everything {@link replayIntoLeg} needs off the orchestrator — the structural
 *  host pattern of `RolloverHost` / `TerminalHost`. */
export interface ReplayIntoLegHost {
  engine: ReplayFeedEngine | null;
  terminated: boolean;
  terminalizing: boolean;
  lastEngineFedSeq: number;
  engineFedBytes: number;
  sessionFedBytes: number;
  legHeardUpToSeq: number;
  legFedBytes: number;
  unheardVoice: boolean;
  pendingOverdueFloor: number | null;
  /** Codex item 5 → card RC-Q — the billing ledger (`heard-audio.ts`; `orchestrator-core.ts` `uniqueFedAudioMs`). */
  readonly heard: { noteFed(seq: number, bytes: number, legEndMs: number): void };
  /** card RC-L — the floor a dead leg left (`replay-debt.ts` `answeredFloorSeq`); spent here. */
  unansweredFloorSeq: number | null;
  /** card RC-A — see `replay-debt.ts` `retentionFloorSeq`; released here, by the replay that pays it. */
  retiringFloorSeq: number | null;
  readonly replayWindowMs: number;
  readonly session: { replayTail(windowMs: number, fedThroughSeq?: number): ReplayChunk[] };
  readonly idle: { arm(): void };
  readonly legFacts: LegFacts;
  readonly pauseAccount: SegmentPauseAccount;
}

/** card RC-3b — returns the bytes this replay handed the leg (the ladder's `ready.replayed_ms`). */
export function replayIntoLeg(orch: ReplayIntoLegHost, gateUnfed = false, whileClosing = false): number {
  const host = {
    engine: orch.engine, terminated: orch.terminated, terminalizing: orch.terminalizing && !whileClosing, // card HANGUP-1: see `dialLeg`
    lastEngineFedSeq: orch.lastEngineFedSeq, engineFedBytes: orch.engineFedBytes, sessionFedBytes: orch.sessionFedBytes,
    heardUpToSeq: gateUnfed ? orch.legHeardUpToSeq : -1, overlapBytes: 0,
    takeTail: () => orch.session.replayTail(orch.replayWindowMs, orch.lastEngineFedSeq),
    armIdle: () => { orch.idle.arm(); },
    onFed: (seq: number, bytes: number) => { const endMs = (orch.legFedBytes + host.engineFedBytes - fedBefore) / PCM_BYTES_PER_MS; orch.legFacts.noteLegChunk(seq, endMs); orch.heard.noteFed(seq, bytes, endMs); }, // RC-4 overdue; Codex item 5 → RC-Q
  };
  const handsOver = host.engine !== null && !host.terminated && !host.terminalizing; // feedReplayBufferTail's own fence
  if (handsOver) spendUnansweredFloor(orch, host, gateUnfed); // card RC-L — BEFORE anything reads the mark
  const fedBefore = host.engineFedBytes;
  if (handsOver && (!gateUnfed || orch.legHeardUpToSeq > orch.lastEngineFedSeq)) orch.legFacts.noteHeardReplay(); // RC-5b: BEFORE the feed — a final can land mid-replay
  if (handsOver) orch.legFacts.beginReplay(gateUnfed); // RC-5c: measure what of the closed leg's covered audio this leg re-hears
  if (handsOver) warnIfReplayShort(orch); // card RC-A — BEFORE the feed moves the mark
  feedReplayBufferTail(host, gateUnfed);
  orch.legFacts.endReplay(); // RC-5c
  if (handsOver) orch.legFacts.noteSeam((gateUnfed ? host.overlapBytes : host.engineFedBytes - fedBefore) / PCM_BYTES_PER_MS); // card RC-J
  orch.legFedBytes += host.engineFedBytes - fedBefore; // card HANGUP-2
  orch.legFacts.noteReplay({ gated: gateUnfed, voiceOwed: orch.unheardVoice, fedBytes: host.engineFedBytes - fedBefore }); // card RC-5a
  if (handsOver) { orch.unheardVoice = false; orch.pendingOverdueFloor = null; orch.retiringFloorSeq = null; } // card HANGUP-1: everything above the mark went to this leg (RC-4 overdue: the held replay happened; RC-A: so did the retiring flush's)
  orch.lastEngineFedSeq = host.lastEngineFedSeq;
  orch.engineFedBytes = host.engineFedBytes;
  orch.sessionFedBytes = host.sessionFedBytes;
  // card CR-12-D — the ONE place a new leg's audio clock gets its zero, which
  // is why the hook is here and not at the three call sites. `gateUnfed`
  // tells the two apart: a ROLLOVER/REDIAL replay follows a reset byte counter;
  // a LADDER RECONNECT re-feeds already-heard audio into a counter nobody
  // reset, so the mapping is unknowable and the segment's number is refused
  // rather than guessed.
  // 🔴 What is reported is the OVERLAP, not the whole replay: only the replayed
  // chunks the previous leg had ALREADY been handed are duplicated between the
  // two clocks. A redial after a silence hang-up replays audio that arrived
  // while NO leg was attached — subtracting that as well (this code's first
  // version did) deleted the dial latency from every quiet-room pause.
  orch.pauseAccount.noteLegReplay(gateUnfed ? host.overlapBytes / PCM_BYTES_PER_MS : null);
  orch.legHeardUpToSeq = -1;
  return host.engineFedBytes - fedBefore;

}

/**
 * card RC-L — a dead leg left audio it was handed and never answered (`orchestrator-core.ts`
 * `unansweredFloorSeq`, below the mark): this replay starts there. The mark is lowered on the orchestrator AND
 * on the bag the feed reads (`host`, built before this call). A gated replay files the re-heard chunks as the
 * previous leg's overlap (`legHeardUpToSeq`, the same move `rewindToFlushBoundary` makes), so the pause account
 * counts them once; a ladder replay's clock is refused anyway. Owed audio is voice (`unheardVoice`), so withheld
 * chunks cannot advance the mark past it before it is handed over.
 */
function spendUnansweredFloor(orch: ReplayIntoLegHost, host: { lastEngineFedSeq: number; heardUpToSeq: number }, gateUnfed: boolean): void {
  const floor = orch.unansweredFloorSeq;
  orch.unansweredFloorSeq = null;
  if (floor === null || floor >= orch.lastEngineFedSeq) return;
  if (gateUnfed) { orch.legHeardUpToSeq = Math.max(orch.legHeardUpToSeq, orch.lastEngineFedSeq); host.heardUpToSeq = orch.legHeardUpToSeq; }
  orch.lastEngineFedSeq = floor; host.lastEngineFedSeq = floor; orch.unheardVoice = true;
}

/**
 * card RC-A — 「the audio this leg is owed is already gone」 used to leave no trace
 * at all: `sinceOrUnfed` simply starts at the oldest chunk the ring still holds,
 * and the leg is fed a replay that begins later than the mark. The ring is FIFO
 * (it prunes from the head), so the chunk just above the mark is missing exactly
 * when the ring's oldest chunk lies above it. `short_ms` counts the missing seqs
 * at the size of that oldest chunk (the phone's chunks are one size; nothing pins it).
 */
function warnIfReplayShort(orch: ReplayIntoLegHost): void {
  const oldest = orch.session.replayTail(Number.POSITIVE_INFINITY)[0];
  const neededFrom = orch.lastEngineFedSeq + 1;
  if (oldest === undefined || oldest.seq <= neededFrom) return;
  log.warn(STT_REPLAY_SHORT_EVENT, { needed_from_seq: neededFrom, ring_oldest_seq: oldest.seq, short_ms: Math.round((oldest.seq - neededFrom) * oldest.payload.length / PCM_BYTES_PER_MS) });
}

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
  takeTail(): ReplayChunk[];
  armIdle(): void;
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
    try { host.engine.push(chunk.payload, chunk.ts_ms); host.engineFedBytes += chunk.payload.length; host.sessionFedBytes += chunk.payload.length; host.lastEngineFedSeq = Math.max(host.lastEngineFedSeq, chunk.seq); fed += 1; } catch (err) { console.error('[SttEngineOrchestrator] replayBufferTail engine.push error (will surface via reconnect):', err); }
  }
  // card RT-2: replayed bytes are bytes the vendor received, so they restart the
  // silence countdown for the same reason a live push does.
  if (fed > 0) host.armIdle();
}

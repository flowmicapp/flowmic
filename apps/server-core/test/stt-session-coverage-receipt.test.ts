// Card CV-1 — the coverage receipt on the TERMINAL `stt:final`.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b) (the SSOT)
//           src/engine/stt-session-receipt.ts (every rule, in prose)
//           packages/protocol/src/recovery-protocol.ts (the wire schema)
//           docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//
// 🔴 THE ASSERTIONS LAND ON EMITTED FRAMES, not on the tally object. The receipt
// exists so the PHONE can decide whether its local audio is still the only copy,
// and the only thing the phone ever sees is the frame. A test that read
// `CoverageReceiptTally.fields()` directly would be green for a build where the
// bridge forgot to spread it — which is the wiring half, i.e. the half that has
// historically been the broken one in this repo.
//
// ⚠️ A file of its own rather than a block in stt-session-bridge.test.ts, which
// is already near the 1200-line test cap; same reason stt-session-char-counts
// split off. The harness below is a deliberate duplicate of that file's.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { recoveryEchoOf, CoverageReceiptTally } from '../src/engine/stt-session-receipt';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { COVERAGE_RECEIPT_VERSION } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { FrameTally } from '../src/engine/stt-session-intake';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  /** Audit F3's test needs a WINDOW: the terminal fence is raised by
   *  `orchestrator.stop()` and lowered again when the final goes out, and the
   *  race being asserted is a chunk landing between those two. Zero by default,
   *  so every test written before this one behaves exactly as it did. */
  flushDelayMs = 0;
  async flush(): Promise<void> {
    if (this.flushDelayMs > 0) await new Promise((r) => setTimeout(r, this.flushDelayMs));
    if (this.finalOnFlush !== null) {
      this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 });
    }
  }
  async close(): Promise<void> { this._state = 'closed'; }
  /** Emit a final WITHOUT going through flush — the "engine ended it itself" shape. */
  emitFinal(text: string): void {
    this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 7 });
  }
}

const SR = 16_000;
const sine = (ms: number, amp = 0.3): Buffer => {
  const n = (SR * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b;
};
const b64 = (buf: Buffer): string => buf.toString('base64');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

type Frame = { event: string; payload: Record<string, unknown> };

function makeBridge(
  recovery?: Parameters<typeof recoveryEchoOf>[0],
  opts: { clampMs?: number } = {},
): {
  bridge: SttSessionBridge; eng: FakeEngine; frames: Frame[];
  finals: () => Record<string, unknown>[];
} {
  const eng = new FakeEngine();
  const frames: Frame[] = [];
  const echo = recovery === undefined ? undefined : recoveryEchoOf(recovery);
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({
      orchestrator: (() => {
        // Same technique as test/autostop-reason.test.ts: a tiny quota ceiling
        // makes the session auto-stop for real, through the production edge, so
        // `ended_normally:false` below is produced by the mechanism rather than
        // by a flag the test set.
        //
        // ⚠️ `setQuotaBudgetMs`, NOT the `clampHardLimitMs` alias that file uses:
        // test/quota-limit-origin.test.ts pins the alias's caller set at exactly
        // three and says in the same breath that a new caller "should be calling
        // setQuotaBudgetMs". Adding a fourth would have turned a census that is
        // doing its job into a line to be edited.
        if (opts.clampMs !== undefined) session.setQuotaBudgetMs(opts.clampMs);
        return new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      })(),
      isByok: false,
      gated: false,
    }),
    emitter: { emit: (event, payload) => { frames.push({ event, payload: payload as Record<string, unknown> }); } },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    ...(echo !== undefined ? { recovery: echo } : {}),
    levelIntervalMs: 0,
  });
  return {
    bridge, eng, frames,
    finals: () => frames.filter((f) => f.event === 'stt:final').map((f) => f.payload),
  };
}

describe('coverage receipt — the terminal final carries it', () => {
  it('a normal utterance: version, counters, and ended_normally true', async () => {
    const { bridge, eng, finals } = makeBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    bridge.pushChunk(1, b64(sine(200)), 200);
    bridge.pushChunk(2, b64(sine(200)), 400);
    eng.finalOnFlush = '大家好';
    await bridge.finish();

    const terminal = finals().find((f) => f.is_segment === false);
    expect(terminal).toBeDefined();
    expect(terminal?.coverage_receipt_version).toBe(COVERAGE_RECEIPT_VERSION);
    expect(terminal?.fed_frames).toBe(3);
    expect(terminal?.seq_gaps).toBe(0);
    expect(terminal?.drops).toBe(0);
    expect(terminal?.engine_leg_rollovers).toBe(0);
    expect(terminal?.ended_normally).toBe(true);
  });

  it('counts a seq gap as one OCCURRENCE, not as the number of missing seqs', async () => {
    const { bridge, eng, finals } = makeBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    // 1..4 never arrive; 5 lands ⇒ ONE interruption of the contiguous run.
    bridge.pushChunk(5, b64(sine(200)), 1_000);
    eng.finalOnFlush = 'x';
    await bridge.finish();
    const terminal = finals().find((f) => f.is_segment === false);
    expect(terminal?.seq_gaps).toBe(1);
    // Four seqs are missing and the counter still says 1 — the field answers
    // "was the run interrupted", not "how much is missing", and a later fill can
    // shrink the hole without un-happening the interruption.
    expect(terminal?.fed_frames).toBe(2);
  });

  it('counts a frame the bridge turned away, and does NOT count replay de-duplication', async () => {
    const { bridge, eng, finals } = makeBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    // An empty payload: taken off the wire, went nowhere ⇒ a drop.
    bridge.pushChunk(1, b64(Buffer.alloc(0)), 200);
    // A re-sent seq 0 — the ring-replay path. The orchestrator drops it ON
    // PURPOSE (hasObserved), and counting the mechanism working as audio lost
    // would make every reconnect look like damage.
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.finalOnFlush = 'x';
    await bridge.finish();
    const terminal = finals().find((f) => f.is_segment === false);
    expect(terminal?.drops).toBe(1);
    // The replayed frame still counts as accepted off the wire (the bridge took
    // it in and decoded it); what it did not do is add a drop.
    expect(terminal?.fed_frames).toBe(2);
  });

  it('echoes the identifiers the start frame carried, and invents none when it carried none', async () => {
    const withIds = makeBridge({
      recording_id: 'rec-7f3a', attempt_id: 'att-2',
      range_start_sample: 0, range_end_sample: 320_000,
    });
    await tick();
    withIds.bridge.pushChunk(0, b64(sine(200)), 0);
    withIds.eng.finalOnFlush = 'x';
    await withIds.bridge.finish();
    const echoed = withIds.finals().find((f) => f.is_segment === false);
    expect(echoed).toMatchObject({
      recording_id: 'rec-7f3a', attempt_id: 'att-2',
      range_start_sample: 0, range_end_sample: 320_000,
    });

    const bare = makeBridge();
    await tick();
    bare.bridge.pushChunk(0, b64(sine(200)), 0);
    bare.eng.finalOnFlush = 'x';
    await bare.bridge.finish();
    const plain = bare.finals().find((f) => f.is_segment === false);
    // 🔴 Structural absence, not a null: a server that filled one in would be
    // answering a question only the phone can answer.
    for (const k of ['recording_id', 'attempt_id', 'range_start_sample', 'range_end_sample']) {
      expect(k in (plain ?? {})).toBe(false);
    }
    // …while the counters are still there. The receipt does not become absent
    // just because the phone did not name a range.
    expect(plain?.coverage_receipt_version).toBe(COVERAGE_RECEIPT_VERSION);
  });

  it('recoveryEchoOf returns undefined for a frame that names nothing', () => {
    expect(recoveryEchoOf({})).toBeUndefined();
    expect(recoveryEchoOf({ attempt_id: 'att-1' })).toEqual({ attempt_id: 'att-1' });
  });
});

describe('ended_normally — false is the load-bearing half', () => {
  it('🔴 an AUTO-STOP end to end: the terminal final says ended_normally false', async () => {
    // The production-reachable abnormal ending that still DELIVERS a terminal
    // final, so it is the one the phone can actually read a `false` off. A 60 ms
    // budget stands in for "the minutes ran out"; the receipt does not care
    // which ceiling it was, only that the recording was ended for the speaker
    // rather than by them.
    const { bridge, eng, frames, finals } = makeBridge(undefined, { clampMs: 60 });
    eng.finalOnFlush = '额度用完前的最后一句';
    await new Promise((r) => setTimeout(r, 250));

    // Positive control first: a pass must not be able to mean "neither happened".
    expect(frames.some((f) => f.event === 'audio:auto-stopped')).toBe(true);
    const terminal = finals().find((f) => f.is_segment === false);
    expect(terminal).toBeDefined();
    expect(terminal?.ended_normally).toBe(false);
    // …and the rest of the receipt is intact. "We cannot tell you how it ended"
    // and "it ended badly" are different answers, and only the second is true.
    expect(terminal?.coverage_receipt_version).toBe(COVERAGE_RECEIPT_VERSION);
    bridge.dispose();
  });

  it('the WATCHDOG path emits no terminal final at all — so it can never say true', async () => {
    // 🔴 MEASURED, NOT ASSUMED, and it corrects what this card's brief expected.
    // The audio handler's AUDIO_STOP_FINISH_WATCHDOG_MS fallback calls
    // `dispose()` on a stuck `finish()`; `dispose()` runs `orchestrator.close()`,
    // which sets `terminated`, and `flushAndEmitFinal` checks that flag BEFORE it
    // emits (stt/orchestrator-core.ts). So there is no late frame to stamp
    // `ended_normally:false` onto — the phone gets NO receipt, and its rule for
    // "no receipt" is already the safe one (hold the audio).
    //
    // This test is therefore the honest shape of that path: the assertion worth
    // making is that nothing goes out claiming a clean ending.
    const { bridge, eng, finals } = makeBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    eng.finalOnFlush = 'late words';
    bridge.dispose();          // the watchdog's forced teardown
    eng.emitFinal('late words'); // whatever the engine still had
    await tick();

    expect(finals().filter((f) => f.ended_normally === true)).toEqual([]);
    expect(finals().find((f) => f.is_segment === false)).toBeUndefined();
  });
});

describe('audit F3 — every frame lands in exactly one bucket', () => {
  it('🔴 a chunk that arrives during the terminal flush is a DROP, not a feed', () => {
    // The race the audit names: `finish()` raises the orchestrator's terminal
    // fence, and a chunk already in flight from the phone lands behind it. It is
    // received and delivered nowhere. Before this fix the bridge counted it the
    // moment it decoded it, so the receipt told the phone we had fed two frames
    // when the pipeline took one — and `fed_frames` is precisely what the phone
    // compares against its send count before deleting its only copy of the audio.
    return (async (): Promise<void> => {
      const { bridge, eng, finals } = makeBridge();
      await tick();
      bridge.pushChunk(0, b64(sine(200)), 0);
      eng.finalOnFlush = 'x';
      eng.flushDelayMs = 60;
      const settled = bridge.finish();
      await tick(); // the fence is up and the flush is in flight
      bridge.pushChunk(1, b64(sine(200)), 200); // still in flight from the phone
      await settled;

      const terminal = finals().find((f) => f.is_segment === false);
      expect(terminal?.fed_frames).toBe(1);
      expect(terminal?.drops).toBe(1);
      // The identity, stated as the assertion rather than left to be read off the
      // two numbers above: two frames were handed to the bridge, and two frames
      // are accounted for.
      expect((terminal?.fed_frames as number) + (terminal?.drops as number)).toBe(2);
    })();
  });

  it('the positive control: the same two frames, no fence — both are fed', async () => {
    // Without this, the test above would pass on a bridge that had simply
    // stopped counting the second frame at all.
    const { bridge, eng, finals } = makeBridge();
    await tick();
    bridge.pushChunk(0, b64(sine(200)), 0);
    bridge.pushChunk(1, b64(sine(200)), 200);
    eng.finalOnFlush = 'x';
    await bridge.finish();
    const terminal = finals().find((f) => f.is_segment === false);
    expect(terminal?.fed_frames).toBe(2);
    expect(terminal?.drops).toBe(0);
  });

  it('🔴 the chunk that TRIPS the quota ceiling is a drop, not a feed', () => {
    // fix-025 made the push path the SECOND enforcement point for the ceiling, and
    // for a `quota_budget` deadline that means `autoStop`. The frame that noticed
    // is the frame that pays for it: it was taken off the wire, the session left
    // `recording` underneath it, and it was never buffered — but `pushChunk`
    // returned before touching `_droppedChunks`, so the orchestrator's delta read
    // zero and reported `'fed'`. The phone then compared `fed_frames` against its
    // own send count, found them equal, and was told its only copy of that audio
    // was redundant.
    //
    // Injected clock and timers so the deadline is crossed BY THE PUSH: with a
    // real timer the timeout fires first and the frame lands on the state guard,
    // which is the branch that already counted. That branch is a different bug.
    let t = 1_000;
    const session = new AudioSession({
      now: () => t,
      setTimeoutFn: () => 1,   // armed and never fired: the push is the enforcer
      clearTimeoutFn: () => {},
    });
    session.setQuotaBudgetMs(100);
    session.start();
    const orch = new SttEngineOrchestrator(session, () => new FakeEngine(), { now: () => t });
    const tally = new FrameTally();

    tally.note(orch.pushChunk({ seq: 0, ts_ms: 0, payload: sine(20) }));
    expect(session.droppedChunks).toBe(0);

    t = 1_200; // past `sessionStartedAt + 100`
    const intake = orch.pushChunk({ seq: 1, ts_ms: 20, payload: sine(20) });
    tally.note(intake);

    expect(intake).toBe('refused');
    expect(session.droppedChunks).toBe(1);
    // The identity the receipt rests on: two frames were handed to the pipeline
    // and two frames are accounted for. Asserted rather than read off the two
    // numbers above, because 'fed' for this frame breaks the identity silently.
    expect(tally.fed + tally.dropped).toBe(2);
    expect(tally.fed).toBe(1);
  });

  it('🔴 a session-refused frame is ONE drop on the receipt, not two', () => {
    // 🔴 THROUGH A REAL ORCHESTRATOR, and that is the point of this test. The
    // version it replaces drove `AudioSession` directly and asserted
    // `droppedChunks === 1` — a true statement about a counter, which said
    // nothing at all about the sum the receipt actually reports. It could not:
    // the addition it was named after (`bridgeDropped + session.droppedChunks`)
    // never ran in it, and no `FrameTally` was present to be the other term.
    //
    // The two terms were never disjoint. `orchestrator-core.pushChunk` DERIVES
    // its `'refused'` verdict from a delta on `droppedChunks`, so a frame the
    // session turns away increments that counter AND lands in `FrameTally`
    // — the receipt then summed them and reported one frame as two drops.
    const session = new AudioSession();
    session.start();
    const orch = new SttEngineOrchestrator(session, () => new FakeEngine());
    const tally = new FrameTally();
    const receipt = new CoverageReceiptTally();

    tally.note(orch.pushChunk({ seq: 0, ts_ms: 0, payload: sine(20) }));

    // `stop()` rather than the private `autoStop()`: both leave `recording`, and
    // the guard being asserted keys on the state, not on how it got there.
    session.stop();
    tally.note(orch.pushChunk({ seq: 1, ts_ms: 20, payload: sine(20) }));

    // Both terms of the old sum really did move — the double count was reachable,
    // not hypothetical.
    expect(session.droppedChunks).toBe(1);
    expect(tally.dropped).toBe(1);

    const fields = receipt.fields({
      session, acceptedFrames: tally.fed, droppedFrames: tally.dropped,
      finishing: true, disposed: false,
    });
    expect(fields.drops).toBe(1);
    // The identity the phone checks before deleting its only copy of the audio:
    // two frames handed to the pipeline, two frames accounted for. The old sum
    // made this 3.
    expect((fields.fed_frames as number) + (fields.drops as number)).toBe(2);
  });
});

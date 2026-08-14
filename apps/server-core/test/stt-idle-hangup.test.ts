// Card RT-2 — connection lifetime follows the voice.
//
// SPEC-REF:
//   docs/strategy/2026-08-08-030-unified-plan-and-ledger.md RT-2
//     (「silence ≥3s hang up / press again to redial; before taking the card, read the two measured rows on the RT-3 ledger」)
//   docs/strategy/2026-08-07-rt3-outage-resilience-ledger.md §1.1/§1.1b (the ring
//     prunes on EVERY push and the read side filters independently),
//     §1.3 (`stop()`'s no-engine branch), §5 RT3-C (the reconnect path has no
//     spawn cap — an OPEN account this card does not close)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.3, master-plan §2.3 (VAD gate: a
//     metered streaming session must not accrue billed time on silence)
//   CLAUDE.md: F-5「make 『replacing a live connection』 and 『a real drop』 two different things」/ no silent failure
//
// ── WHAT IS BEING DRIVEN ────────────────────────────────────────────────────
// Real production classes — AudioSession + RingBuffer + SeqTracker +
// SttEngineOrchestrator + the real reconnect ladder — on the shared RT-3 harness
// (`fixtures/stt-outage-harness.ts`). Only the ENGINE is a stand-in, and it is a
// PERFECT transcriber, so any word missing from the merged final is missing
// because of our pipeline. There is no socket at this layer: the orchestrator's
// only outside edge is the engine interface, which is exactly what a hang-up
// acts on.
//
// ── 🔴 THE SHAPE THIS FILE EXISTS TO CATCH: F-5 ─────────────────────────────
// A deliberate teardown that is indistinguishable from a failure. FlowMic has
// paid for it once already: `SocketCore.connect()` replaced a live socket and
// the internal `disconnect()` emitted `disconnected` — byte-identical to a real
// drop — so the reconnect ladder re-armed and dialled on its own, and the
// capsule flickered. A silence hang-up is the same category of act. Every test
// below that asserts 「nothing re-dialled」 is asserting THAT, not tidiness.
//
// ⚠️ WHAT IS MODELLED. The VAD gate is a boolean the test drives, not the real
// energy detector. That is the correct seam: the orchestrator consumes
// `shouldFeedEngine` as a predicate and has no opinion about how the answer is
// computed, and `vad-gate.ts` has its own tests. Driving it explicitly is what
// makes 「3 s of silence」 an exact quantity here instead of a signal-processing
// outcome.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import {
  CHUNK_MS, EN, FakeClock, T0, TranscribingEngine, ZH,
  frame, mergedFinalText, type Corpus, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

/** Chunks of continuous silence that add up to strictly more than the threshold.
 *  16 × 200 ms = 3200 ms > 3000 ms — one chunk of headroom, not a round number
 *  chosen to look tidy. */
const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;

interface Rig {
  readonly clock: FakeClock;
  readonly engines: TranscribingEngine[];
  readonly orch: SttEngineOrchestrator;
  readonly finals: ServerFinal[];
  readonly wire: WireFrame[];
  readonly errors: { code: string }[];
  readonly statuses: { status: string }[];
  /** Chunks the VAD gate ACCEPTS — the user is talking. */
  speak(chunks: number): Promise<void>;
  /** Chunks the VAD gate REFUSES. The phone streams continuously, so silence is
   *  still pushed at the session; it simply must not reach a metered vendor. */
  quiet(chunks: number): Promise<void>;
  merged(): string;
  /** Legs that have been opened over the whole run. */
  legCount(): number;
}

async function makeRig(corpus: Corpus, idleHangupMs: number): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 300_000,
  });
  session.start();
  const engines: TranscribingEngine[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      // finalEveryN: 0 — the flush is the ONLY final. That is the Soniox shape,
      // and Soniox is the platform's managed default, i.e. exactly the engine
      // this card is about (metered, streaming). It is also the strictest shape
      // for the flush-before-hang-up rule: with no mid-session finals, EVERYTHING
      // the leg has heard is lost if the hang-up forgets to flush.
      const e = new TranscribingEngine(corpus, clock, { open: 'ok', finalEveryN: 0 });
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      // Out of reach: this file measures the LEG's lifetime, not segmentation.
      softSegmentMs: 600_000,
      shouldFeedEngine: (): boolean => voiced,
      ...(idleHangupMs > 0 ? { idleHangupMs } : {}),
    },
  );
  const finals: ServerFinal[] = [];
  const wire: WireFrame[] = [];
  const errors: { code: string }[] = [];
  const statuses: { status: string }[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => {
    finals.push({ segment_idx: f.segment_idx, is_segment: f.is_segment, text: f.text });
    wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text });
  });
  orch.on('error', (e: { code: string }) => errors.push(e));
  orch.on('engine-status', (s: { status: string }) => statuses.push(s));
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  let seq = 0;
  const pump = async (chunks: number): Promise<void> => {
    for (let i = 0; i < chunks; i++) {
      orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
      seq += 1;
      await clock.advance(CHUNK_MS);
    }
  };
  return {
    clock, engines, orch, finals, wire, errors, statuses,
    speak: async (n) => { voiced = true; await pump(n); },
    quiet: async (n) => { voiced = false; await pump(n); },
    merged: () => mergedFinalText(wire),
    legCount: () => engines.length,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * DIRECTION 1 — it hangs up, and it hangs up SILENTLY.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-2 — silence hangs up the engine leg', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] ${DEFAULT_ENGINE_IDLE_HANGUP_MS} ms without voice closes the leg`, async () => {
      const rig = await makeRig(corpus, DEFAULT_ENGINE_IDLE_HANGUP_MS);
      await rig.speak(10);
      expect(rig.engines[0]!.state).toBe('open'); // positive control: it was up

      await rig.quiet(SILENCE_CHUNKS);

      expect(rig.engines[0]!.state).toBe('closed');
      expect(rig.legCount()).toBe(1); // hung up, NOT replaced
    });
  }

  it('🔴 F-5: a hang-up is not a drop — nothing re-dials, nothing is reported', async () => {
    const rig = await makeRig(ZH, DEFAULT_ENGINE_IDLE_HANGUP_MS);
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    // Give the ladder every chance to wake up on its own: 7 s is the SUM of its
    // own backoff rungs (1+2+4), i.e. longer than it could ever take to climb.
    await rig.clock.advance(7_000);

    // The ladder never woke: no rung, no status, no error, no second leg.
    expect(rig.statuses.map((s) => s.status)).not.toContain('reconnecting');
    expect(rig.statuses.map((s) => s.status)).not.toContain('failed');
    expect(rig.errors).toEqual([]);
    expect(rig.legCount()).toBe(1);
    // And the one status it DID emit is the honest one: the session became ready
    // and never stopped being able to transcribe the next word.
    expect(rig.statuses.map((s) => s.status)).toEqual(['ready']);
  });

  it('🔴 the hang-up FLUSHES first — the leg is never closed on unflushed speech', async () => {
    // With `finalEveryN: 0` the engine emits nothing until it is flushed, so if
    // the hang-up closed the leg without flushing, these ten chunks would exist
    // nowhere: not on the wire, not in an accumulator, not on the phone.
    const rig = await makeRig(ZH, DEFAULT_ENGINE_IDLE_HANGUP_MS);
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);

    expect(rig.engines[0]!.finalsEmitted.join('')).toBe(ZH.slice(0, 10));

    // …and the user gets it, because `stop()` with no leg attached now emits the
    // accumulators (card RT3-B). THIS ASSERTION IS THE COMPOSITION OF THE TWO CARDS
    // and it is why RT3-B had to land first: against the old unconditional
    // `text: ''`, RT-2 would have shipped a brand-new dropped-characters path — every recording
    // that ended after a pause would have delivered nothing — while looking like
    // a billing optimisation.
    await rig.orch.stop();
    expect(rig.finals.at(-1)).toEqual({ segment_idx: 0, is_segment: false, text: ZH.slice(0, 10) });
    expect(rig.merged()).toBe(ZH.slice(0, 10));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * DIRECTION 2 — it does NOT hang up while the user is talking.
 *
 * 🔴 A test suite that only proves the hang-up fires is green for an
 * implementation that hangs up constantly, which is the worse product: a cold
 * spawn in front of every word.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-2 — the leg survives speech', () => {
  it('continuous speech well past the threshold never hangs up', async () => {
    const rig = await makeRig(ZH, DEFAULT_ENGINE_IDLE_HANGUP_MS);
    await rig.speak(SILENCE_CHUNKS * 3); // ~9.6 s of talking, no pause

    expect(rig.engines[0]!.state).toBe('open');
    expect(rig.legCount()).toBe(1);
    expect(rig.errors).toEqual([]);
  });

  it('a pause SHORTER than the threshold does not hang up (the countdown resets)', async () => {
    // ⚠️ THE ARITHMETIC, written out because the first draft of this test got it
    // wrong and went red — which is the good kind of red: the threshold is EXACT,
    // not approximate. The countdown is armed by the push of the last voiced
    // chunk, and `pump` advances 200 ms AFTER each push. So a run of `m` silent
    // chunks measures `(m + 1) × 200` ms of silence, not `m × 200`. At
    // SILENCE_CHUNKS − 2 = 14 that is exactly 3000 ms — the timer is due at `<=`,
    // so it fires, and the leg was legitimately closed.
    const shortPause = SILENCE_CHUNKS - 3; // (13 + 1) × 200 = 2800 ms < 3000 ms
    expect((shortPause + 1) * CHUNK_MS).toBeLessThan(DEFAULT_ENGINE_IDLE_HANGUP_MS);

    const rig = await makeRig(ZH, DEFAULT_ENGINE_IDLE_HANGUP_MS);
    for (let i = 0; i < 4; i++) {
      await rig.speak(3);
      await rig.quiet(shortPause); // four pauses, each just under the line
    }
    expect(rig.engines[0]!.state).toBe('open');
    expect(rig.legCount()).toBe(1);
  });

  it('OFF by default: without `idleHangupMs` the leg is never hung up', async () => {
    // The default is opt-IN because the reason to hang up is a METERED leg, and
    // `engine-factory.ts` is the only place that knows. A local engine paying a
    // cold spawn per pause would be a regression bought with nothing.
    const rig = await makeRig(ZH, 0);
    await rig.speak(5);
    await rig.quiet(SILENCE_CHUNKS * 4);

    expect(rig.engines[0]!.state).toBe('open');
    expect(rig.legCount()).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * DIRECTION 3 — the voice comes back and the leg is dialled again, cleanly.
 *
 * 「Cleanly」 is three separate claims and each gets its own assertion: a NEW leg
 * exists; the words spoken after the pause arrive; and nothing is said twice.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-2 — speaking again re-dials', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] the whole utterance survives a pause: no dropped characters, no duplication`, async () => {
      const rig = await makeRig(corpus, DEFAULT_ENGINE_IDLE_HANGUP_MS);
      await rig.speak(10);                 // seq 0..9
      await rig.quiet(SILENCE_CHUNKS);     // hang up
      expect(rig.legCount()).toBe(1);

      await rig.speak(10);                 // the voice returns
      expect(rig.legCount()).toBe(2);      // a second leg was dialled
      expect(rig.engines[1]!.state).toBe('open');

      await rig.orch.stop();

      // 🔴 The acceptance criterion is the WORDS, not the connection count.
      // Silence carries no tokens, so the spoken text is the two voiced runs.
      const spoken = corpus.slice(0, 10) + corpus.slice(10 + SILENCE_CHUNKS, 20 + SILENCE_CHUNKS);
      expect(rig.merged()).toBe(spoken);
    });
  }

  it('🔴 the redial replays only what NO leg has heard — the banked silence is not re-fed', async () => {
    // RT-3's retention pin deliberately holds unheard audio 「whatever its age」.
    // If the VAD gate were only consulted when a leg happens to be attached, a
    // long pause would bank every silent chunk as 「unheard」 and hand the whole
    // pile to the fresh (metered) leg — the exact cost this card exists to avoid.
    const rig = await makeRig(ZH, DEFAULT_ENGINE_IDLE_HANGUP_MS);
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS * 5); // 16 s of silence, far past the 5 s window
    await rig.speak(4);

    expect(rig.legCount()).toBe(2);
    const silenceSeqs = Array.from({ length: SILENCE_CHUNKS * 5 }, (_, i) => 10 + i);
    expect(rig.engines[1]!.heard.filter((s) => silenceSeqs.includes(s))).toEqual([]);
    // Positive control: it DID hear the words — so the empty set above is the
    // gate working, not the leg being deaf.
    expect(rig.engines[1]!.heard.length).toBeGreaterThan(0);
    // And it heard no chunk the FIRST leg had already transcribed (no duplication).
    expect(rig.engines[1]!.heard.filter((s) => s < 10)).toEqual([]);
  });

  it('a redial that cannot connect hands over to the ladder — one owner, not two', async () => {
    // The failure has to LOOK like a failure; only the deliberate teardown is
    // silent. And recovery must have exactly one owner: if `hungUpOnSilence`
    // survived a failed dial, the next chunk would dial concurrently with a
    // ladder rung.
    const clock = new FakeClock(T0);
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      hardLimitMs: 300_000,
    });
    session.start();
    const engines: TranscribingEngine[] = [];
    let voiced = true;
    let handed = 0;
    const orch = new SttEngineOrchestrator(
      session,
      () => {
        const script = handed === 0 ? { open: 'ok' as const } : { open: 'reject' as const };
        handed += 1;
        const e = new TranscribingEngine(ZH, clock, { ...script, finalEveryN: 0 });
        engines.push(e);
        return e;
      },
      {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced,
        idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
      },
    );
    const statuses: { status: string }[] = [];
    const errors: { code: string }[] = [];
    orch.on('engine-status', (s: { status: string }) => statuses.push(s));
    orch.on('error', (e: { code: string }) => errors.push(e));
    orch.on('interim', () => { /* listener mandatory */ });
    orch.on('final', () => { /* listener mandatory */ });
    await orch.start({ language: 'zh', mode: 'realtime' });

    let seq = 0;
    const pump = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
        seq += 1;
        await clock.advance(CHUNK_MS);
      }
    };
    await pump(5);
    voiced = false; await pump(SILENCE_CHUNKS);   // hang up (silent, as proved above)
    voiced = true; await pump(2);                 // redial — and it is refused
    await clock.advance(10_000);                  // let the ladder climb and give up

    // Now it IS announced. The distinction the card turns on, in one file.
    expect(statuses.map((s) => s.status)).toContain('reconnecting');
    expect(errors.map((e) => e.code)).toContain('STT_NETWORK_DROP');
    await orch.close();
  });
});

// Card RT-3 · Resilience under reconnect / API outage — dropped characters and dropped segments.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (server_replay_buffer_ms 5000),
//     §2.3 (reconnect ladder 1/2/4s ×3 → replay the buffer → OPEN | FAILED)
//   CLAUDE.md red line: no silent failure / R11「status must be true」 / owner「dropped characters are a veto」
//
// 🔴 EVERY ASSERTION IN THIS FILE LANDS ON THE MERGED FINAL TEXT — the string the
// phone assembles and injects — never on 「did we reconnect」 or 「how many frames
// went out」. A reconnect that succeeds and loses two seconds of speech is a
// FAILURE by owner's rule, and it reports itself as a success everywhere else.
//
// ── WHAT IS BEING DRIVEN ────────────────────────────────────────────────────
// Real production classes: AudioSession + RingBuffer + SeqTracker +
// SttEngineOrchestrator + EngineSessionReconnectLadder, on their real default
// constants. Only the ENGINE is a stand-in, because the defect lives on the
// 「engine died, ladder climbed, buffer replayed」 path and nothing else can
// inject that fault. The stand-in is a PERFECT transcriber (fixtures header).
//
// ── THE ARITHMETIC THIS FILE TURNS INTO A MEASUREMENT ───────────────────────
//   DEFAULT_BACKOFF_MS  = [1000, 2000, 4000]   (engine-session.ts)
//   DEFAULT_MAX_RETRIES = 3                    (engine-session.ts)
//   DEFAULT_REPLAY_WINDOW_MS = 5000            (orchestrator-types.ts)
// Cumulative backoff before the THIRD attempt is 1000+2000+4000 = 7000 ms, and
// the ring prunes on EVERY push against its own 5000 ms window regardless of
// whether an engine exists to feed. So a recovery that needs the third rung
// re-feeds only the last 5 s and the 2 s before that were evicted unheard.
// 🔴 The relay→engine leg is the one with the 5 s ring. The phone→relay leg has
// its own 30 s ring + SeqTracker dedup and is HEALTHY throughout these cases —
// which is exactly why nothing reports a problem: every chunk the phone sent was
// received, acknowledged and buffered. It simply was never transcribed.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import {
  CHUNK_MS, EN, FakeClock, T0, TranscribingEngine, ZH,
  frame, mergedFinalText, type Corpus, type EngineScript, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

/** FunASR 2pass shape: an offline `final` every 10 chunks (2 s of speech). */
const SHAPE_MID_FINALS: Pick<EngineScript, 'finalEveryN'> = { finalEveryN: 10 };
/** Soniox shape: NO mid-session final at all. [code-read 2026-08-07]
 *  `packages/stt-cloud/src/engines/soniox.ts` — `emitFinal()` is guarded by a
 *  one-shot `finalEmitted` flag and its only call site is the end-of-stream
 *  handler, with the comment 「`final` is emitted ONLY here — at the end of the
 *  stream we ourselves asked for」. This is the PLATFORM'S MANAGED DEFAULT
 *  engine (CLAUDE.md), so this shape is a production path, not a hypothetical.
 *  🔴 in-place correction (REQ-14-01, 2026-08-14): the sentence above is now HALF true.
 *  Soniox still emits no mid-session final, but it now DECLARES
 *  `interimShape:'cumulative'` — so the production Soniox is
 *  {@link SHAPE_SONIOX_DECLARED}, and THIS undeclared shape has no production
 *  instance any more. It is kept because six engines remain undeclared and the
 *  behaviour it pins is theirs. */
const SHAPE_NO_MID_FINALS: Pick<EngineScript, 'finalEveryN'> = { finalEveryN: 0 };
/** REQ-14-01: the production Soniox as of 2026-08-14 — no mid-session final AND
 *  a declared cumulative interim stream, which is what gates the cross-leg
 *  draft bank (`orchestrator-core.ts` bankCumulativeDraftFromDeadLeg). */
const SHAPE_SONIOX_DECLARED: Pick<EngineScript, 'finalEveryN' | 'interimShape'> =
  { finalEveryN: 0, interimShape: 'cumulative' };

interface Rig {
  readonly clock: FakeClock;
  readonly finals: ServerFinal[];
  readonly wire: WireFrame[];
  readonly errors: { code: string; message: string }[];
  /** `engine-status` payloads. Recorded so 「nothing reports it」 is a bounded
   *  claim rather than a turn of phrase: the ladder DOES announce the outage. */
  readonly statuses: { status: string; retry_count?: number }[];
  readonly engines: TranscribingEngine[];
  readonly orch: SttEngineOrchestrator;
  speak(chunks: number): Promise<void>;
  /** Advance the clock WITHOUT sending anything — the user stops talking. No
   *  push means no prune, which is what isolates the read-time filter. */
  silence(ms: number): Promise<void>;
  /** Union of every seq handed to ANY engine — model-free: an engine cannot
   *  transcribe audio it was never given. */
  fedSeqs(): number[];
  merged(): string;
  /** High-water mark of the ring across the whole run — the pin's memory cost,
   *  sampled after every push rather than only at the end (the peak is what
   *  bounds the relay, and it is gone by the time the session stops). */
  readonly maxBufferSize: number;
  /** Entries in the ring RIGHT NOW. Used to show the audio was still physically
   *  present when the replay walked past it. */
  readonly ringSize: number;
}

async function makeRig(corpus: Corpus, scripts: EngineScript[]): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 300_000,
  });
  session.start();
  const engines: TranscribingEngine[] = [];
  let handed = 0;
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      const s = scripts[Math.min(handed, scripts.length - 1)]!;
      handed += 1;
      const e = new TranscribingEngine(corpus, clock, s);
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      // Soft segmentation pushed out of reach: this file measures the RECONNECT
      // path. The rollover seam is measured in stt-seam-duplication.test.ts.
      softSegmentMs: 600_000,
    },
  );
  const finals: ServerFinal[] = [];
  const wire: WireFrame[] = [];
  const errors: { code: string; message: string }[] = [];
  // 🔴 BOTH channels are recorded. The phone's slot content is a function of the
  // interim stream too — see PhoneSegmentBuffer's header for the ruler this
  // file got wrong once already.
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => {
    finals.push({ segment_idx: f.segment_idx, is_segment: f.is_segment, text: f.text });
    wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text });
  });
  orch.on('error', (e: { code: string; message: string }) => errors.push(e));
  const statuses: { status: string; retry_count?: number }[] = [];
  orch.on('engine-status', (s: { status: string; retry_count?: number }) => statuses.push(s));
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  let seq = 0;
  let peak = 0;
  return {
    clock, finals, wire, errors, statuses, engines, orch,
    get maxBufferSize(): number { return peak; },
    async speak(chunks: number): Promise<void> {
      for (let i = 0; i < chunks; i++) {
        orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
        peak = Math.max(peak, session.buffer.size);
        seq += 1;
        await clock.advance(CHUNK_MS);
      }
    },
    async silence(ms: number): Promise<void> { await clock.advance(ms); },
    get ringSize(): number { return session.buffer.size; },
    fedSeqs(): number[] {
      return [...new Set(engines.flatMap((e) => e.heard))].sort((a, b) => a - b);
    },
    merged(): string { return mergedFinalText(wire); },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 1 — dropped characters. Fault: the engine ws is killed, and the first two reconnect
 * attempts are refused, so recovery takes the ladder's full 7 s.
 *
 * Timeline (all on the FakeClock, T0-relative), derived from the constants and
 * written down BEFORE reading any output so the expectation is not the
 * implementation reflected back:
 *   0 ms      speak seq 0..19          (4.0 s, engine healthy)
 *   4000 ms   engine emits an unexpected close → rung 1 armed for 5000
 *   4000 ms+  the phone KEEPS SENDING (seq 20…) — buffered, fed to nothing
 *   5000 ms   attempt 1 → connect refused → rung 2 armed for 7000
 *   7000 ms   attempt 2 → connect refused → rung 3 armed for 11000
 *   11000 ms  attempt 3 → OPEN → replayBufferTail() with cutoff 11000−5000=6000
 *             ⇒ only chunks RECEIVED after 6000 ms replay ⇒ seq ≥ 31
 *   ⇒ seq 20..30 (11 chunks = 2.2 s of speech) reach NO engine, ever.
 * ═════════════════════════════════════════════════════════════════════════════ */

/**
 * The ring's worst case under the RT-3 pin, DERIVED — not chosen, not observed:
 *   replayWindow (5 000, orchestrator-types.ts)
 * + Σ DEFAULT_BACKOFF_MS (1 000+2 000+4 000, engine-session.ts)
 * = 12 000 ms of audio, ÷ the phone's 200 ms chunk period
 * = 60 chunks, PLUS the one sitting exactly on the cutoff — `prune` compares
 *   with `<`, which is pre-existing behaviour this card did not touch.
 * ⇒ 61 × 6 400 B ≈ 381 KB per active session, against 26 × 6 400 B ≈ 163 KB when
 *   nothing is wrong. 🔴 First written as 60 and measured at 61: the off-by-one
 *   is the boundary chunk, and it is recorded rather than rounded away.
 */
const MAX_RING_CHUNKS = (5_000 + 7_000) / CHUNK_MS + 1;

const PRE_DROP = 20;          // seq 0..19
const OUTAGE_AND_AFTER = 50;  // seq 20..69
const TOTAL = PRE_DROP + OUTAGE_AND_AFTER;
/** Derived above from backoff+window arithmetic, NOT read off a run. */
const HOLE_FROM = 20;
const HOLE_TO = 31; // exclusive
const HOLE_CHUNKS = HOLE_TO - HOLE_FROM;

async function runOutage(corpus: Corpus, shape: Pick<EngineScript, 'finalEveryN'>): Promise<Rig> {
  const rig = await makeRig(corpus, [
    { ...shape, open: 'ok' },      // the live engine
    { ...shape, open: 'reject' },  // rung 1 refused
    { ...shape, open: 'reject' },  // rung 2 refused
    { ...shape, open: 'ok' },      // rung 3 recovers
  ]);
  await rig.speak(PRE_DROP);
  rig.engines[0]!.emitDrop();
  await rig.clock.advance(0);
  await rig.speak(OUTAGE_AND_AFTER);
  await rig.orch.stop();
  return rig;
}

/* ── 🔴 MEASURED BEFORE THE FIX — dev-pc-a, 2026-08-07 [measured] ─────────
 * The rows below assert the FIXED behaviour. What they measured on the
 * unmodified source is kept here verbatim, because it is the evidence:
 *
 *   [zh] fed 59/70, missing seq 20..30 (11 chunks = 2.2 s), errors = []
 *     SPOKEN    今天的会议我们决定把上线时间推迟到下周三[并且请各位提前准备好测]试报告再把…
 *     DELIVERED 今天的会议我们决定把上线时间推迟到下周三試…  ← the bracketed 11 characters absent
 *   [en] fed 59/70, errors = []
 *     DELIVERED …prepare their test reports [before friday then send a risk
 *               register over to legal for ]one more review after which…
 *   [zh/en, Soniox shape] loss was 31 chunks (6.2 s) — the hole PLUS everything
 *     spoken before the drop.
 *
 * FIX = the retention pin. `ring-buffer.ts` setRetentionPin/prune/sinceOrUnfed,
 * `session.ts` replayTail+setRetentionPin, `orchestrator-core.ts`
 * replayStillOwed+pushChunk+replayBufferTail. 🔴 NO CONSTANT WAS CHANGED.
 * ────────────────────────────────────────────────────────────────────────── */

describe('RT-3 CASE 1 dropped characters — a 7 s recovery must not outrun the replay retention', () => {
  for (const corpus of [ZH, EN]) {
    /**
     * The model-free half. It does not depend on how the fake engine renders
     * text, on the merge functions, or on anything downstream: an engine cannot
     * transcribe audio it was never handed.
     */
    it(`[${corpus.lang}] EVERY seq reaches an engine (seq ${HOLE_FROM}..${HOLE_TO - 1} was the hole)`, async () => {
      const rig = await runOutage(corpus, SHAPE_MID_FINALS);
      const fed = rig.fedSeqs();

      // Positive control first: the probe can see audio when audio was fed.
      expect(fed, 'no engine was ever fed anything — every measurement below would be vacuous').not.toHaveLength(0);

      const missing = Array.from({ length: TOTAL }, (_, i) => i).filter((s) => !fed.includes(s));
      expect(missing, `${HOLE_CHUNKS} chunks (${HOLE_CHUNKS * CHUNK_MS} ms) reached no engine at all`).toEqual([]);
      expect(fed).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
      expect(rig.errors).toEqual([]);
    });

    /**
     * WHAT THE PIN COSTS, as an assertion rather than a promise. The ring may
     * hold at most `replayWindow + Σbackoff` = 5 000 + 7 000 ms of audio; at the
     * phone's 200 ms chunk period that is 60 chunks ≈ 384 KB per session,
     * against 25 chunks ≈ 160 KB when nothing is wrong. Both numbers are
     * DERIVED (window constant + the ladder's own schedule); neither is chosen.
     */
    it(`[${corpus.lang}] the pin's memory cost is bounded by the ladder's own budget`, async () => {
      const rig = await runOutage(corpus, SHAPE_MID_FINALS);
      expect(rig.maxBufferSize).toBeLessThanOrEqual(MAX_RING_CHUNKS);
      expect(rig.maxBufferSize, 'the pin never actually held anything — this row proves nothing').toBeGreaterThan(5_000 / CHUNK_MS);
    });

    /**
     * 🔴 THE ACCEPTANCE ASSERTION. Exact equality, both sides built from the
     * corpus (never from a pipeline output), so the failure message prints the
     * spoken text against the delivered text.
     */
    it(`[${corpus.lang}] merged final text carries the outage span (engine WITH mid-session finals)`, async () => {
      const rig = await runOutage(corpus, SHAPE_MID_FINALS);
      const got = rig.merged();

      expect(got).toBe(corpus.spoken(TOTAL));
      // Named separately so a regression reports WHICH span went missing rather
      // than just 「the two strings differ」.
      expect(got, 'the outage span is gone again — the retention pin is not holding')
        .toContain(corpus.slice(HOLE_FROM, HOLE_TO));
      expect(got).toContain(corpus.slice(0, HOLE_FROM));
      expect(got).toContain(corpus.slice(HOLE_TO, TOTAL));
    });

    /**
     * 🔴 AN OPEN ACCOUNT, NOT A PASS. The pin fixes the hole on this shape too,
     * and this shape is STILL LOSSY for a DIFFERENT reason.
     *
     * With no mid-session final, everything the dead engine heard lives only in
     * `onlineDraft`. The draft survives the reconnect — and is then wiped by the
     * NEW engine's flush final (`orchestrator-core.ts` final handler:
     * `offlineAccum = mergeOverlap(...); this.onlineDraft = ''`), whose span
     * cannot possibly cover it. A value meaning 「the CURRENT engine's
     * unconfirmed span」 is cleared by a fact about a DIFFERENT engine session.
     *
     * [measured dev-pc-a 2026-08-07] the pin moved this from losing 31 chunks
     * (6.2 s — the hole PLUS the pre-drop span) to losing 20 (4.0 s — the
     * pre-drop span only). The remainder is REPORTED, not fixed: the only
     * lossless repair is to fold the abandoned draft into `offlineAccum` when
     * its engine is abandoned, and that TRADES dropped characters FOR duplication on the replayed
     * span. Owner has ruled on that trade in the abstract; this lane will not
     * apply it to a new path silently.
     *
     * 🔴 in-place correction (REQ-14-01, 2026-08-14) — THE ACCOUNT IS NOW CLOSED FOR THE
     * ENGINE THIS ROW WAS NAMED AFTER, and the paragraph above is the design of
     * the fix: the abandoned draft IS folded into `offlineAccum` — but only when
     * the dead leg DECLARED `interimShape:'cumulative'` (which Soniox now does),
     * and the duplication cost the last sentence demanded be measured is
     * measured in the REQ-14-01 rows below (in this harness's perfect-transcriber
     * model it is ZERO: the new leg's flush final restates the banked tail as a
     * suffix→prefix overlap, exactly the shape `mergeOverlap` trims). THIS row
     * keeps the UNDECLARED shape, which still loses the pre-drop span — that is
     * the behaviour the six undeclared engines still get, pinned deliberately
     * (INT-2: undeclared keeps today's fold, byte-for-byte).
     */
    it(`[${corpus.lang}] UNDECLARED no-mid-final shape: outage span recovered, pre-drop span still lost`, async () => {
      const rig = await runOutage(corpus, SHAPE_NO_MID_FINALS);
      const got = rig.merged();

      // Closed by the pin: the outage span is back.
      expect(got).toContain(corpus.slice(HOLE_FROM, HOLE_TO));
      expect(got).toBe(corpus.slice(HOLE_FROM, TOTAL));
      // 🔴 Still open FOR UNDECLARED ENGINES. If this line ever starts FAILING,
      // somebody extended the draft bank past the cumulative declaration — check
      // they measured what it does to a 2pass engine's replayed span first
      // (banking a span its offline pass will re-finalise duplicates it).
      expect(got, 'the undeclared draft-wipe pin moved — see the REQ-14-01 rows before touching this').not.toContain(corpus.slice(0, HOLE_FROM));
      expect(rig.errors).toEqual([]);
    });

    /**
     * 🔴 REQ-14-01 — THE CLOSED ACCOUNT, measured. Same 7 s outage, but the
     * engine is the production Soniox shape: declared cumulative. At the first
     * respawn the dead leg's draft (seq 0..19, held only in `onlineDraft`) is
     * banked into `offlineAccum`; the recovered leg hears the pinned seq 20..69;
     * the terminal fold is banked + new — the WHOLE utterance, exactly.
     *
     * REVERSE CONTROL (must be run once when touching the bank): comment out the
     * `bankCumulativeDraftFromDeadLeg()` call in `spawnEngine` and this row
     * reports the pre-drop 20 chunks (4.0 s) gone — the UNDECLARED row's loss,
     * on the declared engine.
     */
    it(`[${corpus.lang}] REQ-14-01 CLOSED: declared-cumulative (Soniox) — the pre-drop span survives the ladder`, async () => {
      const rig = await runOutage(corpus, SHAPE_SONIOX_DECLARED);
      const got = rig.merged();

      // The headline: nothing lost, nothing doubled — character for character.
      expect(got).toBe(corpus.spoken(TOTAL));
      // Named separately so a regression reports WHICH half broke.
      expect(got, 'the banked pre-drop span is gone — the draft bank is not holding').toContain(corpus.slice(0, HOLE_FROM));
      expect(got, 'the outage span is gone — the retention pin regressed').toContain(corpus.slice(HOLE_FROM, HOLE_TO));
      expect(rig.errors).toEqual([]);
    });
  }

  /**
   * POSITIVE CONTROL FOR THE WHOLE FILE: the identical rig and corpus with NO
   * fault at all. The merged final must be the spoken text, character for
   * character.
   *
   * 🔴 Without this row every assertion in this file is compatible with 「this
   * harness always mangles text」 — which would make all of it vacuous.
   */
  for (const corpus of [ZH, EN]) {
    it(`CONTROL [${corpus.lang}] — no fault: the merged final IS the spoken text, exactly`, async () => {
      const rig = await makeRig(corpus, [{ ...SHAPE_MID_FINALS, open: 'ok' }]);
      await rig.speak(TOTAL);
      await rig.orch.stop();

      expect(rig.fedSeqs()).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
      expect(rig.merged()).toBe(corpus.spoken(TOTAL));
      expect(rig.errors).toEqual([]);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 1a — THE LOSS STARTS ON THE **FIRST** RUNG, NOT THE THIRD.
 *
 * 🔴 「1 000 + 2 000 + 4 000 = 7 000 > 5 000」 is the generous reading. The real
 * dead time is `1000 + T₁ + 2000 + T₂ + 4000`, where every T is the round trip
 * of a connect attempt and is BOUNDED BY NOTHING: `raceSpawnTimeout` has exactly
 * one call site in this codebase — the cold open in `SttEngineOrchestrator.
 * start()` — while `EngineSessionReconnectLadder.attemptReconnect()` does a bare
 * `await this.hooks.spawnEngine()`.
 *
 * ⇒ Any T₁ > 4 s already puts the FIRST — and successful — reconnect past the
 * 5 s window. No rung has to fail. Below: one drop, one reconnect, it WORKS, and
 * pre-fix it still lost the first three chunks of what the user said into it.
 *
 * (Correction supplied by the F-3-b lane's adversarial review; the fixed 7 000
 * figure came from this window's own dispatch note and understated the defect.)
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 CASE 1a dropped characters — a slow connect loses speech on the first, successful rung', () => {
  /** [measured dev-pc-a 2026-08-07] with the read half reverted this row
   *  reports `expected [ Array(57) ] to deeply equal [ Array(60) ]` — exactly 3
   *  chunks, 600 ms, gone on a reconnect that never failed once. */
  it('T₁ = 4.5 s ⇒ recovery at 5.5 s ⇒ pre-fix the first 3 chunks were dropped; now none are', async () => {
    const rig = await makeRig(ZH, [
      { ...SHAPE_MID_FINALS, open: 'ok' },
      // rung 1 SUCCEEDS — it is merely slow. Nothing fails anywhere in this run.
      { ...SHAPE_MID_FINALS, open: 'ok', openDelayMs: 4_500 },
    ]);
    await rig.speak(PRE_DROP);
    rig.engines[0]!.emitDrop();
    await rig.clock.advance(0);
    await rig.speak(40);
    await rig.orch.stop();

    // Only two engines: no rung ever failed, no retry ever escalated.
    expect(rig.engines).toHaveLength(2);
    expect(rig.errors).toEqual([]);
    expect(rig.statuses.map((s) => s.status)).toContain('reconnecting');

    // Dead time was 1 000 + 4 500 = 5 500 ms > the 5 000 ms window, so seq 20..22
    // (received 4 000/4 200/4 400 ms, i.e. before the 4 500 ms read cutoff) were
    // the casualties. They must all be present now.
    const fed = rig.fedSeqs();
    expect(fed).toEqual(Array.from({ length: PRE_DROP + 40 }, (_, i) => i));
    expect(rig.merged()).toBe(ZH.spoken(PRE_DROP + 40));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 1b — THE SAME LOSS WITH NO PRUNING INVOLVED AT ALL.
 *
 * 🔴 This case kills the most natural objection to CASE 1: 「if the user goes
 * quiet during the outage there are no pushes, so `prune()` never runs, so
 * nothing is evicted, so nothing can be lost」. The first three clauses are TRUE.
 * The conclusion is false, because there are TWO independent 5-second filters and
 * only one of them is on the write path:
 *   · WRITE: `RingBuffer.prune`, on every `push`;
 *   · READ:  `AudioSession.replayTail(windowMs)` → `buffer.since(now − windowMs)`.
 * With the user silent, the ring still PHYSICALLY HOLDS every chunk — and the
 * replay walks straight past all of them.
 *
 * (Raised by the F-3-b lane's adversarial review of this card. It is the one
 * scenario where the retention half of the fix is provably worth nothing on its
 * own, which is why it gets a case rather than a line in a comment.)
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 CASE 1b dropped characters — the read-time filter loses audio the ring never evicted', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] user falls silent mid-outage: the ring keeps the audio, the replay must not skip it`, async () => {
      const rig = await makeRig(corpus, [
        { ...SHAPE_MID_FINALS, open: 'ok' },
        { ...SHAPE_MID_FINALS, open: 'reject' },
        { ...SHAPE_MID_FINALS, open: 'reject' },
        { ...SHAPE_MID_FINALS, open: 'ok' },
      ]);
      await rig.speak(PRE_DROP);                 // 0..4000 ms, seq 0..19
      rig.engines[0]!.emitDrop();                // rung 1 armed for 5000
      await rig.clock.advance(0);
      await rig.speak(10);                       // 4000..6000 ms, seq 20..29
      const ringAtSilence = rig.ringSize;
      await rig.silence(6_000);                  // 6000..12000 ms — NOT ONE PUSH
      await rig.speak(5);                        // the user resumes after recovery
      await rig.orch.stop();

      // The audio was never evicted: no push happened after 6000 ms, so `prune`
      // was never called, so every one of those ten chunks was still in the ring
      // when the reconnect landed at 11000 ms.
      expect(ringAtSilence).toBeGreaterThanOrEqual(10);

      // …and it must therefore reach an engine. Pre-fix it did not: `since(11000
      // − 5000)` excludes everything received before 6000 ms.
      const fed = rig.fedSeqs();
      for (let s = PRE_DROP; s < PRE_DROP + 10; s++) {
        expect(fed, `seq ${s} sat in the ring and was never handed to any engine`).toContain(s);
      }
      expect(rig.merged()).toContain(corpus.slice(PRE_DROP, PRE_DROP + 10));

      // 🔴 WHAT IS AND IS NOT REPORTED — the honest sentence, as an assertion.
      // The ladder DOES announce the outage: the user is told we are
      // reconnecting. What no channel ever says is that N seconds of what they
      // said was discarded before the new engine arrived.
      expect(rig.statuses.map((s) => s.status)).toContain('reconnecting');
      expect(rig.errors, 'the eviction is announced somewhere after all').toEqual([]);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 2 — dropped segment. Fault: the STT API stays down. All three rungs are refused, the
 * ladder gives up, and the user then releases the button.
 *
 * TWO SEPARATE FACTS, and the second one corrects the first.
 *
 * ① THE SERVER THROWS THE TRANSCRIPT AWAY. `stop()`'s no-engine branch emits
 *    `text: ''` UNCONDITIONALLY. Its comment justifies that with 「whatever
 *    `offlineAccum` still holds was already emitted under the previous index」 —
 *    true of the ROLLOVER caller the branch was written for, FALSE of this one:
 *    no rollover ran, no index was spent, and every final the first engine
 *    confirmed is discarded. anti-façade ④ — a comment asserting another path's
 *    behaviour, whose truth depends on who arrived.
 *
 * ② AND THE USER STILL SEES THAT TEXT — because of a guard ON THE PHONE, written
 *    for a different reason. `segment_buffer.dart` `put`: 「finalized=true with
 *    empty text and non-empty prior → KEEP prior + lock (the orchestrator's empty
 *    fallback on flushFinal timeout must NOT wipe accumulated online text)」.
 *    🔴 THIS IS THE FINDING, not a downgrade of it: the server's terminal final
 *    is wrong, and what makes the product survive it is a defensive branch on
 *    the other side of the wire that looks, from here, like dead code. Anyone who
 *    tidies it away turns ① into a total loss of the utterance.
 *
 * WHAT IS ACTUALLY LOST HERE: everything spoken after the drop. It reached no
 * engine, so it produced no interim, so no slot ever held it — and no phone-side
 * guard can rescue text that was never sent.
 *
 * ── 🔴 card RT3-B CLOSED ① (2026-08-08). ② AND THE LAST PARAGRAPH STILL STAND. ──
 * Everything above is preserved verbatim because it was true when written and it
 * is the evidence the fix was built from. What changed, and only this:
 *
 *   `text: ''` is now an ASSERTION —「this segment produced no transcript」— and
 *   it is emitted only when the accumulators HAVE already left on some final.
 *   Contract: docs/rebuild/15 §2.0-d (edited first, per that document's §5).
 *   Mechanism: `orchestrator-core.ts` `accumEmittedByFinal` +
 *   `emitNoEngineTerminalFinal`. The rollover caller still gets `''` — proved by
 *   `stt-terminal-rollover-collision.test.ts`, not by argument.
 *
 * ⚠️ ② IS NOT NOW DEAD CODE and nothing here may be read as saying so. The
 * phone's guard was written for the FLUSH-TIMEOUT empty fallback, a path this
 * card does not touch; it still fires there. What is gone is only 「the server
 * held the text and sent an empty string anyway」.
 *
 * ⚠️ THE LAST PARAGRAPH IS UNTOUCHED AND IS THE POINT: the 8.0 s spoken into the
 * dead engine is still gone, and the assertions below still measure it. This card
 * recovered what was HELD, not what was never heard. Saying anything else about
 * that span would need a new error code = owner gate (book 15 §6 G-23).
 * ═════════════════════════════════════════════════════════════════════════════ */

const OUTAGE_TAIL = 40; // seq 20..59 — spoken into a dead engine

describe('RT-3 CASE 2 dropped segment — ladder exhaustion: the held transcript survives (RT3-B), the unheard 8 s does not', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] the terminal final CARRIES the ${PRE_DROP} confirmed chunks instead of ''`, async () => {
      const rig = await makeRig(corpus, [
        { ...SHAPE_MID_FINALS, open: 'ok' },
        { ...SHAPE_MID_FINALS, open: 'reject' },
        { ...SHAPE_MID_FINALS, open: 'reject' },
        { ...SHAPE_MID_FINALS, open: 'reject' },
      ]);
      await rig.speak(PRE_DROP);
      rig.engines[0]!.emitDrop();
      await rig.clock.advance(0);
      await rig.speak(OUTAGE_TAIL);   // the user keeps talking through the outage
      await rig.orch.stop();

      // Positive control: the text really did exist and the orchestrator really
      // did hold it — the engine emitted finals for exactly that span.
      expect(rig.engines[0]!.finalsEmitted.join('')).toBe(corpus.slice(0, PRE_DROP));

      // 🔴 ① CLOSED (RT3-B). The server's answer for the whole utterance is the
      // text it actually holds. This line used to assert `text: ''`.
      expect(rig.finals.at(-1)).toEqual({ segment_idx: 0, is_segment: false, text: corpus.slice(0, PRE_DROP) });

      // 🔴 ② The load-bearing half: a consumer that reads ONLY final frames — no
      // interims, no phone-side guard — now gets the transcript. That model is
      // exactly what this file first got wrong (header §1.3), and it is the one
      // that proves the fix does not depend on the other side of the wire.
      expect(mergedFinalText(rig.wire.filter((f) => f.kind === 'final'))).toBe(corpus.slice(0, PRE_DROP));

      // ⚠️ UNCHANGED, and it is the point: what the user ends up with is still
      // the pre-drop span and nothing else. RT3-B recovered what was HELD.
      // The 8 s spoken into the dead engine reached no engine, produced no
      // interim, and was in no accumulator — nothing here invents it.
      expect(rig.merged()).toBe(corpus.slice(0, PRE_DROP));
      expect(rig.merged()).not.toContain(corpus.slice(PRE_DROP, PRE_DROP + OUTAGE_TAIL));
      expect(OUTAGE_TAIL * CHUNK_MS).toBe(8_000); // 8.0 s of speech, unrecoverable

      // Not silent — but the one sentence it says is about the network, not
      // about the transcript it just threw away.
      expect(rig.errors.map((e) => e.code)).toContain('STT_NETWORK_DROP');
      expect(rig.errors.map((e) => e.message).join('|')).not.toMatch(/transcript|discard|lost/i);
    });
  }

  /**
   * POSITIVE CONTROL: same fault shape, but rung 3 recovers. The confirmed text
   * is delivered — so the empty final above is caused by the exhaustion branch,
   * not by the harness never producing text.
   */
  it('CONTROL — when rung 3 recovers, the confirmed pre-drop text IS delivered', async () => {
    const rig = await makeRig(ZH, [
      { ...SHAPE_MID_FINALS, open: 'ok' },
      { ...SHAPE_MID_FINALS, open: 'reject' },
      { ...SHAPE_MID_FINALS, open: 'reject' },
      { ...SHAPE_MID_FINALS, open: 'ok' },
    ]);
    await rig.speak(PRE_DROP);
    rig.engines[0]!.emitDrop();
    await rig.clock.advance(0);
    await rig.speak(OUTAGE_TAIL);
    await rig.orch.stop();

    expect(rig.merged()).toContain(ZH.slice(0, PRE_DROP));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 3 — duplication. Fault: the engine ws is killed and the FIRST reconnect attempt
 * succeeds — i.e. the ordinary, healthy, 1-second blip. Nothing is lost. Speech
 * is delivered TWICE instead.
 *
 * 🔴 FOUND BY THIS FILE'S OWN CONTROL ROW, which was written to prove the rig
 * could produce a perfect transcript and instead printed 3.8 s of speech twice.
 * Verbatim, first run, dev-pc-a:
 *   Expected: 今天的会议我们决定把上线时间推迟到下周三并且请各位…
 *   Received: 今天的会议我们决定把上线时间推迟到下周三天的会议我们决定把上线时间推迟到下周三并且请各位…
 *
 * MECHANISM. `replayBufferTail()` on the reconnect path is called with NO
 * argument ⇒ `gateUnfed = false` ⇒ it re-feeds the whole 5 s window, INCLUDING
 * chunks the dead engine had already transcribed and finalised. That is
 * deliberate (the new engine needs context), and the de-duplication is delegated
 * entirely to `mergeOverlap(offlineAccum, next)`.
 *
 * 🔴 AND `mergeOverlap` CANNOT DO IT, because it is a SUFFIX/PREFIX matcher and
 * the relation here is 「next is a span from the MIDDLE of accum」. The new
 * engine finalises on its own VAD boundaries, so its first final starts wherever
 * the replay started — 19 tokens back inside `offlineAccum`, not at its end.
 * `next.startsWith(accum)` false, `accum.startsWith(next)` false, `overlapLen`
 * 0 ⇒ concatenate. There is no branch for containment-in-the-middle, and no
 * value of `OVERLAP_MIN_CHARS` changes that: the floor gates whether a found
 * overlap is believed, and here the overlap found is zero.
 *
 * ⚠️ THIS IS THE CORRECT SIDE TO ERR ON and must stay that way (owner: dropped characters are a
 * veto; segment_buffer.dart states the same rule at length). The finding is not
 * 「stop duplicating」 — it is that the amount duplicated is decided by where the
 * vendor happens to place a final, i.e. by nothing we control or measure.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 CASE 3 duplication — an ordinary 1 s reconnect delivers the replayed span twice', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] the merged final carries seq 1..19 a second time (3.8 s duplicated)`, async () => {
      const rig = await makeRig(corpus, [
        { ...SHAPE_MID_FINALS, open: 'ok' },
        { ...SHAPE_MID_FINALS, open: 'ok' },   // rung 1 recovers after 1 s
      ]);
      await rig.speak(PRE_DROP);
      rig.engines[0]!.emitDrop();
      await rig.clock.advance(0);
      await rig.speak(OUTAGE_AND_AFTER);
      await rig.orch.stop();

      const got = rig.merged();
      const spoken = corpus.spoken(TOTAL);

      // Nothing was lost — every seq reached an engine. That is what makes this
      // the duplication case rather than the dropped-characters one.
      expect(rig.fedSeqs()).toEqual(Array.from({ length: TOTAL }, (_, i) => i));

      expect(got).not.toBe(spoken);
      expect(got).toBe(corpus.slice(0, PRE_DROP) + corpus.slice(1, TOTAL));
      expect(got.length).toBeGreaterThan(spoken.length);
      // 19 chunks × 200 ms of speech, said once and delivered twice.
      expect(got.length - spoken.length).toBe(corpus.slice(1, PRE_DROP).length);
      expect(rig.errors, 'the duplication is announced somewhere after all').toEqual([]);
    });
  }

  /**
   * CONTROL — the SAME fault, the same 1 s recovery, but the replay happens to
   * begin exactly where `offlineAccum` begins, so the new engine's first final
   * is a PREFIX of the accumulator and `mergeOverlap`'s containment branch fires.
   * Result: clean.
   *
   * 🔴 This is the row that makes the finding precise. The defect is NOT 「a
   * reconnect always duplicates」; it is 「whether it duplicates is decided by
   * where the vendor puts a final relative to where the ring happened to start」
   * — a coincidence, on both sides.
   */
  it('CONTROL — when the replay starts at the accumulator boundary, the merge is clean', async () => {
    const rig = await makeRig(ZH, [{ ...SHAPE_MID_FINALS, open: 'ok' }, { ...SHAPE_MID_FINALS, open: 'ok' }]);
    await rig.speak(10);                       // 2.0 s — the whole session fits the window
    rig.engines[0]!.emitDrop();
    await rig.clock.advance(0);
    await rig.speak(30);
    await rig.orch.stop();

    expect(rig.merged()).toBe(ZH.spoken(40));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * REQ-14-01 — THE DUPLICATION COST OF THE DRAFT BANK, measured on the blip.
 *
 * The OPEN-ACCOUNT row above refused to bank the abandoned draft 「silently」
 * because the fold trades dropped characters for duplication on the replayed span. This block is the
 * measurement that refusal asked for, on the worst case for duplication: a 1 s
 * blip where the full 5 s replay window overlaps audio the dead leg had already
 * heard AND banked.
 *
 * WHAT THE MEASUREMENT SAYS. Mid-hold, the wire interims DO carry the replayed
 * span twice (banked text + the new leg's cumulative hypothesis restating its
 * tail) — the visible, bounded error, deliberately chosen (dropped characters are a veto). At
 * the terminal it collapses to zero: the new leg's flush final restates the
 * banked text's TAIL FROM ITS START, i.e. a suffix-of-accum = prefix-of-next
 * overlap, which is precisely the shape `mergeOverlap` exists to trim — unlike
 * CASE 3's mid-final shape, where the vendor's final starts MID-accum and the
 * suffix/prefix matcher finds nothing. (In production the re-transcription of
 * the replayed audio may differ textually; then the trim misses and the seam is
 * delivered twice — the documented W2.5-H trade, visible and recoverable, where
 * the pre-bank behaviour silently deleted the pre-drop span instead.)
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('REQ-14-01 duplication cost — declared-cumulative blip: transient preview dup, clean terminal', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] 1 s reconnect: the merged final is the spoken text exactly, and nothing pre-drop is lost`, async () => {
      const rig = await makeRig(corpus, [
        { ...SHAPE_SONIOX_DECLARED, open: 'ok' },
        { ...SHAPE_SONIOX_DECLARED, open: 'ok' },   // rung 1 recovers after 1 s
      ]);
      await rig.speak(PRE_DROP);
      rig.engines[0]!.emitDrop();
      await rig.clock.advance(0);
      await rig.speak(OUTAGE_AND_AFTER);
      await rig.orch.stop();

      // Every seq reached an engine (the replayed span reached TWO — that is
      // what makes this the duplication-cost case).
      expect(rig.fedSeqs()).toEqual(Array.from({ length: TOTAL }, (_, i) => i));

      // 🔴 The terminal: exact. The banked draft ends with the very text the new
      // leg's final begins with, so `mergeOverlap` trims the restatement.
      expect(rig.merged()).toBe(corpus.spoken(TOTAL));

      // 🔴 The transient cost, pinned honestly instead of hidden: while the new
      // leg is live, the wire interim = banked(0..19) + hypothesis(1..69), so
      // the replayed span appears twice IN THE PREVIEW…
      const lastInterim = [...rig.wire].reverse().find((f) => f.kind === 'interim')!;
      const replayedOnce = corpus.slice(1, PRE_DROP);
      expect(lastInterim.text.split(replayedOnce).length - 1).toBe(2);
      // …and the terminal final REPLACES that slot (same segment_idx), which is
      // why the phone's assembled row above came out exact. Both facts asserted,
      // because they are the two halves of 「visible while held, converges after release」.
      expect(rig.errors).toEqual([]);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * CASE 4 — the outage is UNBOUNDED, not 7 s. Fault: the vendor accepts the TCP
 * connection and never completes the handshake (the ordinary shape of a stalled
 * API: no RST, no error, just silence).
 *
 * `SttEngineOrchestrator.start()` wraps the cold open in
 * `raceSpawnTimeout(..., engineSpawnTimeoutMs)`. `EngineSessionReconnectLadder.
 * attemptReconnect()` calls the SAME hook BARE: `await this.hooks.spawnEngine()`.
 * So a hanging connect on the reconnect path is bounded by nothing this codebase
 * controls.
 *
 * 🔴 THE RETENTION PIN DOES NOT FIX THIS AND IS NOT MEANT TO. The pin keeps the
 * audio; it cannot make an engine appear to receive it. This case is REPORTED as
 * an open card (give `attemptReconnect` the same `raceSpawnTimeout` the cold open
 * already has) rather than fixed here, because changing the ladder's timing
 * changes when users are told the session died — a product decision, not a bug
 * fix. What the pin DOES do here is bound the memory, which is asserted below:
 * without a bound this failure mode would trade a silent loss for a silent leak.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 CASE 4 — the reconnect path has no spawn timeout (open card), memory bounded', () => {
  it('a hung reconnect loses ALL speech after the drop, the ladder never advances, the ring stays bounded', async () => {
    const rig = await makeRig(ZH, [
      { ...SHAPE_MID_FINALS, open: 'ok' },
      { ...SHAPE_MID_FINALS, open: 'hang' },
    ]);
    await rig.speak(PRE_DROP);
    rig.engines[0]!.emitDrop();
    await rig.clock.advance(0);
    await rig.speak(150);            // 30 s of speech into a hung reconnect

    // The ladder is stuck INSIDE attempt 1: rung 2 was never armed, so the
    // 「3 retries then STT_NETWORK_DROP」 promise never fires either.
    expect(rig.engines).toHaveLength(2);
    expect(rig.errors, 'the ladder gave up after all — then this test is measuring the wrong thing').toEqual([]);

    // 30 s of audio was received, buffered, and handed to nobody.
    const fed = rig.fedSeqs();
    expect(Math.max(...fed)).toBe(PRE_DROP - 1);
    expect(TOTAL + 100 - fed.length).toBeGreaterThan(140);

    // …and the ring did NOT grow with the hang. `replayWindow + Σbackoff` worth
    // of chunks, and not one more, however long the vendor keeps the socket open.
    expect(rig.maxBufferSize).toBeLessThanOrEqual(MAX_RING_CHUNKS);
  });

  /** CONTROL — the COLD open is bounded, which is what makes the asymmetry the
   *  finding rather than a general property of `open()`. */
  it('CONTROL — the same hang on the COLD open is bounded by engineSpawnTimeoutMs', async () => {
    const clock = new FakeClock(T0);
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
    session.start();
    const orch = new SttEngineOrchestrator(
      session,
      () => new TranscribingEngine(ZH, clock, { open: 'hang' }),
      {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        engineSpawnTimeoutMs: 5_000,
      },
    );
    orch.on('error', () => { /* start() emits STT_NETWORK_DROP before rejecting */ });
    orch.on('engine-status', () => { /* noop */ });

    let settled: unknown = 'pending';
    void orch.start({ language: 'zh', mode: 'realtime' }).then(
      () => { settled = 'resolved'; },
      (e: Error) => { settled = e.message; },
    );
    await clock.advance(4_999);
    expect(settled).toBe('pending');
    await clock.advance(2);
    expect(settled).toMatch(/timeout/i);
  });
});

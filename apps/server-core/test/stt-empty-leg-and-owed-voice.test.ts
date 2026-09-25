// Card HANGUP-2 — two ways the closing path said the wrong thing.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §4 R11 (a status
//     word must answer 「what justifies saying so」) and the no-silent-failure
//     red line, BOTH directions
//   CLAUDE.md red line: no silent failure / owner「dropped characters are a veto」
//
// ── DEFECT 1: SUCCESS REPORTED AS FAILURE ───────────────────────────────────
// A segment cut opens a fresh leg. If the user stays quiet, that leg is hung up
// 3 s later having been handed NOTHING, and the hang-up used to flush it anyway:
// the end-of-stream frame reaches a Soniox session that never got audio, Soniox
// answers `[invalid_request] No audio received.`, stt-cloud maps it to
// `STT_NO_ENGINE_REACHED` (retryable:false), and — because this RECORDING did
// capture voice — ENG-4's suppression (`vendorNoAudioIsOurSilence`) correctly
// lets it through. The phone then showed 「This recording reached no speech
// engine, so nothing was transcribed」 next to a row holding every word.
// Measured live on card HANGUP-1: 2 of 6 runs, before and after that card.
//
// THE FIX (primary-owner ruling, HANGUP-2): a leg that was handed no audio is
// not asked for a transcript — the hang-up races no engine when
// `legFedBytes === 0`, so the vendor is never asked a question whose answer is
// already known. The alternative (widen ENG-4) would make that code answer both
// 「the engine could not be reached」 and 「this leg was empty」.
// ⚠️ The criterion is THIS LEG'S OWN count (`legFedBytes`, reset where a leg is
// born), not `engineFedBytes` (a ladder rung inherits it) and not any
// recording-wide fact.
// ⚠️ SCOPE: the hang-up, as ruled. A RELEASE inside 3 s of a cut asks the same
// empty leg through the terminal flush and still gets the same false error —
// left open for its own ruling (it was measured red here and removed).
// 🔴 card HANGUP-3 (2026-09-23) — that ruling came: the terminal flush takes the
// same rule (`flushAndEmitFinal` in orchestrator-core.ts, `isSegment ||
// legFedBytes > 0`). The release rows are the third describe block below.
// ⚠️ And a pause cut no longer hands the new leg the withheld chunk it was
// decided on (`pushChunk` marks it before the cut takes its boundary) — before
// this card every such leg got 200 ms of refused silence and was never empty.
// ⚠️ 更正（RC-5a，2026-09-24）：the sentence above is reversed on purpose. A row cut
// decided on a withheld chunk now replays the last ≤1 s of the closed run to the
// new leg (the next syllable's onset can hide there — 「是」, root-cause §3.1), so
// the new leg below is handed chunks 12..15 of silence. The empty-leg rule reads
// VOICE now (`leg-facts.ts` `voicedBytes`): those rows' CLAIMS are unchanged and
// still green; only the race controls that pinned 「handed nothing」 now pin
// 「handed only the withheld tail」.
//
// ── DEFECT 2: WORDS OWED AT RELEASE, DROPPED WITHOUT A WORD ─────────────────
// Voice that arrived while no leg was open waits for a replay (`unheardVoice`).
// If the button was released while that replay was still owed — the redial had
// failed and a ladder rung was waiting, or the leg had dropped and the rung was
// waiting — `stop()` cancelled the rung, found no engine, and emitted the
// accumulators: the owed words were gone and no frame said so.
// Now: a rung that was pending at release is run ONCE, capped, before the
// closing flush, and a segment-cut leg that lands after the release is kept
// for it — the words are delivered.
// ⛔ NOT CLOSED BY HANGUP-2: when that one dial fails too, the owed words were
// still lost with no frame saying so (book 15 §6 G-23 forbids borrowing
// STT_NETWORK_DROP for it).
// 🔴 card HANGUP-3 closed it FOR A CLIENT THAT DECLARED `stt.segment_not_transcribed`:
// `STT_SEGMENT_NOT_TRANSCRIBED` goes out before the final (owed-voice-verdict.ts;
// the last describe block). For an UNDECLARED client (every phone up to 0.3.94,
// the web client) the verdict stays silent on purpose — it would render the name
// raw — so the two HANGUP-2 rows below that end in a failed dial now assert
// exactly that silence, which is today's behaviour, not an acceptance of it.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import { SttEngineError } from '../src/stt/engines/base';
import {
  CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, drain,
  frame, mergedFinalText, type Corpus, type EngineScript, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;

/** The Soniox shape at the one point this card is about: an end-of-stream sent
 *  to a session that was handed no audio is refused with the vendor's own words
 *  (`packages/stt-cloud/src/engines/soniox.ts` `classifyNoAudio`). */
class SonioxLikeEngine extends TranscribingEngine {
  flushCalls = 0;
  override async flush(): Promise<void> {
    this.flushCalls += 1;
    if (this.heard.length === 0) {
      this.emit('error', new SttEngineError('STT_NO_ENGINE_REACHED', '[invalid_request] No audio received.', false));
      return;
    }
    return super.flush();
  }
}

function voicedOnly(base: Corpus, voiced: ReadonlySet<number>): Corpus {
  const render = (seqs: readonly number[]): string =>
    seqs.filter((s) => voiced.has(s)).map((s) => base.tokens[s % base.tokens.length]!).join('');
  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
  return { lang: base.lang, tokens: base.tokens, render, spoken: (n) => render(range(0, n)), slice: (a, b) => render(range(a, b)) };
}

interface Err { code: string; message: string; retryable: boolean }
interface Rig {
  readonly clock: FakeClock;
  readonly engines: SonioxLikeEngine[];
  readonly orch: SttEngineOrchestrator;
  readonly corpus: Corpus;
  readonly errors: Err[];
  readonly order: string[];
  speak(chunks: number): Promise<void>;
  quiet(chunks: number): Promise<void>;
  release(): Promise<void>;
  merged(): string;
  finals(): ServerFinal[];
}

/** `script(i)` scripts the i-th leg (0 = cold open). */
async function makeRig(opts: { softSegmentMs?: number; idleHangupMs?: number; script?: (i: number) => EngineScript; declared?: boolean } = {}): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
  });
  session.start();
  const voicedSeqs = new Set<number>();
  const corpus = voicedOnly(ZH, voicedSeqs);
  const engines: SonioxLikeEngine[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      const e = new SonioxLikeEngine(corpus, clock, { open: 'ok', finalEveryN: 0, ...(opts.script?.(engines.length) ?? {}) });
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: opts.softSegmentMs ?? 600_000,
      shouldFeedEngine: (): boolean => voiced,
      idleHangupMs: opts.idleHangupMs ?? DEFAULT_ENGINE_IDLE_HANGUP_MS,
    },
  );
  const wire: WireFrame[] = [];
  const finals: ServerFinal[] = [];
  const errors: Err[] = [];
  const order: string[] = [];
  // card HANGUP-3 — what stt-factory.ts writes from the admission's `client_caps`.
  orch.segmentNotTranscribedDeclared = opts.declared === true;
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => { wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text }); finals.push(f); order.push(f.is_segment ? 'segment-final' : 'final'); });
  orch.on('error', (e: Err) => { errors.push(e); order.push(`error:${e.code}`); });
  orch.on('error-suppressed', () => { /* ENG-4's log line; asserted elsewhere */ });
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  let seq = 0;
  const pump = async (chunks: number): Promise<void> => {
    for (let i = 0; i < chunks; i++) {
      if (voiced) voicedSeqs.add(seq);
      orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
      seq += 1;
      await clock.advance(CHUNK_MS);
    }
  };
  return {
    clock, engines, orch, corpus, errors, order,
    speak: async (n) => { voiced = true; await pump(n); },
    quiet: async (n) => { voiced = false; await pump(n); },
    // The drain comes first: a closing dial's open() resolves in microtasks, and
    // `advance` fires the earliest timer synchronously — without it the spawn
    // cap would fire at fake 5 s before a connect that takes no time at all.
    release: async () => { const p = orch.stop(); await drain(); await clock.advance(20_000); await p; },
    merged: () => mergedFinalText(wire),
    finals: () => finals,
  };
}

const codes = (r: Rig): string[] => r.errors.map((e) => e.code);

describe('HANGUP-2 defect 1 — a leg that was handed nothing is not asked for a transcript', () => {
  it('🔴 a segment cut, then quiet: the empty new leg is hung up and NO STT_NO_ENGINE_REACHED goes out', async () => {
    // 2 s cadence: speech 0..11 (2.4 s), then quiet ⇒ a pause cut 600 ms in
    // opens leg 1, which is handed nothing and hung up. The hang-up is 1 s here
    // only so it lands BEFORE the next 2 s cadence would cut again — production's
    // order (30 s cadence, 3 s hang-up); the rule under test does not read it.
    const rig = await makeRig({ softSegmentMs: 2_000, idleHangupMs: 1_000 });
    await rig.speak(12);
    await rig.quiet(10);

    // RACE CONTROL — the exact precondition of the defect, asserted: a second
    // leg exists, was handed NO VOICE (RC-5a: only the withheld tail 12..15 of
    // the closed run the cut stood on), and was closed by the hang-up before
    // the release.
    expect(rig.engines).toHaveLength(2);
    expect(rig.engines[1]!.heard).toEqual([12, 13, 14, 15]);
    expect(rig.engines[1]!.state).toBe('closed');
    // POSITIVE CONTROL — the words were delivered, on the segment final.
    expect(rig.finals().filter((f) => f.is_segment).map((f) => f.text)).toEqual([rig.corpus.slice(0, 12)]);

    // THE CLAIM.
    expect(codes(rig)).toEqual([]);
    // THE MECHANISM — the empty leg was never flushed at all.
    expect(rig.engines[1]!.flushCalls).toBe(0);

    await rig.release();
    expect(codes(rig)).toEqual([]);
    expect(rig.merged()).toBe(rig.corpus.slice(0, 12));
  });

  it('🔴 POSITIVE — a leg that WAS handed speech still says 「no audio received」 out loud', async () => {
    // The vendor refusing a leg we fed is the case the code was registered for.
    // This must stay loud, or the fix is a mute button.
    const rig = await makeRig({ softSegmentMs: 2_000 });
    await rig.speak(12);
    await rig.quiet(6);
    // Leg 1 is now fed, and its flush will be refused all the same.
    rig.engines[1]!.flush = async function (this: SonioxLikeEngine): Promise<void> {
      this.flushCalls += 1;
      this.emit('error', new SttEngineError('STT_NO_ENGINE_REACHED', '[invalid_request] No audio received.', false));
    };
    await rig.speak(3);
    // ⚠️ 更正（RC-T，2026-09-24）：原为 `[12, 13, 14, 15, 18, 19, 20]`. 16 and 17 are the closed run's last 400 ms, withheld
    // after this leg opened; the gate opening on 18 now hands them over first (`gate-preroll.ts`, book 06 §2 RC-T block).
    expect(rig.engines[1]!.heard).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]); // RC-5a: the withheld tail; RC-T: the pre-roll; then the 3 spoken chunks
    await rig.quiet(SILENCE_CHUNKS);
    expect(rig.engines[1]!.flushCalls).toBe(1);
    expect(codes(rig)).toContain('STT_NO_ENGINE_REACHED');
    await rig.release();
  });

  it('🔴 POSITIVE — voice that reached NO engine at all still ends in STT_NO_ENGINE_REACHED', async () => {
    // The engine becomes unreachable after the cold open: every later dial is
    // refused. The first leg is hung up empty (the fixed path — no flush), the
    // user then speaks, every redial and ladder rung fails, and the recording
    // ends having captured speech that no engine ever received.
    const rig = await makeRig({ script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    await rig.quiet(SILENCE_CHUNKS);
    expect(rig.engines[0]!.state).toBe('closed');
    expect(rig.engines[0]!.flushCalls).toBe(0);
    await rig.speak(3);
    await rig.quiet(80); // 16 s — the ladder (1+2+4 s) exhausts
    await rig.release();

    expect(codes(rig)).toContain('STT_NO_ENGINE_REACHED');
    expect(rig.errors.find((e) => e.code === 'STT_NO_ENGINE_REACHED')!.retryable).toBe(false);
    // The ladder spoke once when it gave up; the empty-leg rule added nothing.
    expect(codes(rig).filter((c) => c === 'STT_NETWORK_DROP')).toHaveLength(1);
  });
});

describe('HANGUP-2 defect 2 — words owed a replay when the button is released', () => {
  it('🔴 the leg dropped and the ladder is waiting: the owed words are delivered', async () => {
    const rig = await makeRig();
    await rig.speak(10);
    rig.engines[0]!.emitDrop(); // rung scheduled 1 s out
    await rig.speak(3);          // 10..12 — no leg to hear them
    expect(rig.engines).toHaveLength(1); // RACE CONTROL: the rung has not run
    await rig.release();

    expect(rig.merged()).toBe(rig.corpus.slice(0, 13));
    expect(codes(rig)).toEqual([]);
  });

  it('🔴 the redial after a hang-up failed and the ladder is waiting: the owed words are delivered', async () => {
    const rig = await makeRig({ script: (i) => (i === 1 ? { open: 'reject' } : {}) });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS); // hung up
    await rig.speak(2);              // 26, 27 — the redial is refused; a rung is scheduled
    expect(rig.engines).toHaveLength(2);
    expect(rig.engines[1]!.state).toBe('closed'); // RACE CONTROL
    await rig.release();

    expect(rig.merged()).toBe(rig.corpus.slice(0, 28));
    expect(codes(rig)).toEqual([]);
  });

  it('when the engine cannot be reached at release either: ONE closing dial, and what was heard is kept', async () => {
    const rig = await makeRig({ script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(2);           // the redial is refused ⇒ a rung is pending
    expect(rig.engines).toHaveLength(2);
    await rig.release();

    expect(rig.engines).toHaveLength(3); // exactly one closing dial
    expect(rig.merged()).toBe(rig.corpus.slice(0, 10));
    // 26, 27 are lost here. UNDECLARED client (the default): nothing says so — today's
    // behaviour, kept on purpose (card HANGUP-3; the declared row is below).
    expect(codes(rig)).toEqual([]);
  });

  it('a redial still connecting at release that then fails is not dialled a second time', async () => {
    const rig = await makeRig({ script: (i) => (i === 0 ? {} : { open: 'reject', openDelayMs: 600 }) });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(1); // the dial starts
    expect(rig.engines).toHaveLength(2);
    await rig.release();

    expect(rig.engines).toHaveLength(2); // bounded: two capped dials + the flush could outlast the phone's 15 s net
    expect(rig.merged()).toBe(rig.corpus.slice(0, 10));
    // UNDECLARED client: the owed chunk is lost and nothing says so (today's behaviour).
    expect(codes(rig)).toEqual([]);
  });

  it('🔴 a segment-cut leg still connecting at release is KEPT for the closing flush, not closed', async () => {
    // The rollover's spawn used to close any leg that landed after the release;
    // the words said while it was connecting were owed to exactly that leg.
    const rig = await makeRig({ softSegmentMs: 2_000, script: (i) => (i === 0 ? {} : { openDelayMs: 600 }) });
    await rig.speak(12);
    await rig.quiet(4);  // chunk 15 cuts; leg 1 starts connecting (600 ms)
    await rig.speak(1);  // 16 — no open leg to take it
    expect(rig.engines).toHaveLength(2);
    expect(rig.engines[1]!.state).not.toBe('open'); // RACE CONTROL: released while it connects
    await rig.release();

    expect(rig.engines[1]!.heard).toContain(16);
    expect(rig.merged()).toBe(rig.corpus.slice(0, 17));
    expect(codes(rig)).toEqual([]);
  });

  it('NEGATIVE CONTROL — nothing owed at release ⇒ no error (plain hold, and a quiet hang-up before release)', async () => {
    const plain = await makeRig();
    await plain.speak(10);
    await plain.release();
    expect(codes(plain)).toEqual([]);
    expect(plain.merged()).toBe(plain.corpus.slice(0, 10));

    const hung = await makeRig();
    await hung.speak(10);
    await hung.quiet(SILENCE_CHUNKS * 2);
    expect(hung.engines[0]!.state).toBe('closed');
    await hung.release();
    expect(codes(hung)).toEqual([]);
    expect(hung.merged()).toBe(hung.corpus.slice(0, 10));
  });
});

// REVERSE CONTROL (card HANGUP-3, 2026-09-23, run and SAW RED): `flushAndEmitFinal`'s
// `this.flushFinal(isSegment || this.legFedBytes > 0)` put back to `this.flushFinal()` ⇒ the first row
// below, 1 failed | 10 passed: `expected [ 'STT_NO_ENGINE_REACHED' ] to deeply equal []`.
// Restored from a byte backup (cmp identical), same command green again.
describe('HANGUP-3 — the release takes the same empty-leg rule', () => {
  it('🔴 a segment cut, then the button inside 3 s: the empty new leg is NOT asked and NO STT_NO_ENGINE_REACHED goes out', async () => {
    // Speech 0..11, then quiet: the pause cut opens leg 1 and the release lands
    // well before the 3 s hang-up — the commonest way a long recording ends.
    const rig = await makeRig({ softSegmentMs: 2_000 });
    await rig.speak(12);
    await rig.quiet(6);
    // RACE CONTROL — leg 1 exists, is still open (the hang-up has not fired) and was handed no
    // voice (RC-5a: only the withheld tail 12..15 of the closed run the cut stood on).
    expect(rig.engines).toHaveLength(2);
    expect(rig.engines[1]!.state).toBe('open');
    expect(rig.engines[1]!.heard).toEqual([12, 13, 14, 15]);
    await rig.release();

    // THE CLAIM.
    expect(codes(rig)).toEqual([]);
    // THE MECHANISM — the empty leg was never flushed.
    expect(rig.engines[1]!.flushCalls).toBe(0);
    // POSITIVE CONTROL — every word is on the rows, and the terminal final still goes out.
    expect(rig.merged()).toBe(rig.corpus.slice(0, 12));
    expect(rig.finals().filter((f) => !f.is_segment)).toHaveLength(1);
  });

  it('🔴 POSITIVE — a leg that WAS handed speech and is refused at release still says so out loud', async () => {
    const rig = await makeRig({ softSegmentMs: 2_000 });
    await rig.speak(12);
    await rig.quiet(6);
    rig.engines[1]!.flush = async function (this: SonioxLikeEngine): Promise<void> {
      this.flushCalls += 1;
      this.emit('error', new SttEngineError('STT_NO_ENGINE_REACHED', '[invalid_request] No audio received.', false));
    };
    await rig.speak(3);
    // ⚠️ 更正（RC-T，2026-09-24）：原为 `[12, 13, 14, 15, 18, 19, 20]`. 16 and 17 are the closed run's last 400 ms, withheld
    // after this leg opened; the gate opening on 18 now hands them over first (`gate-preroll.ts`, book 06 §2 RC-T block).
    expect(rig.engines[1]!.heard).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]); // RC-5a: the withheld tail; RC-T: the pre-roll; then the 3 spoken chunks
    await rig.release();
    expect(rig.engines[1]!.flushCalls).toBe(1);
    expect(codes(rig)).toContain('STT_NO_ENGINE_REACHED');
  });
});

describe('HANGUP-3 — words still owed at release are SAID, to a client that declared it can say them', () => {
  it('🔴 the closing dial fails: STT_SEGMENT_NOT_TRANSCRIBED, retryable:false, BEFORE the final; what was heard is kept', async () => {
    const rig = await makeRig({ declared: true, script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(2);           // the redial is refused ⇒ a rung is pending
    await rig.release();

    expect(rig.engines).toHaveLength(3); // RACE CONTROL: the one closing dial was made, and failed
    expect(rig.merged()).toBe(rig.corpus.slice(0, 10)); // POSITIVE CONTROL: the heard words are on the row
    expect(codes(rig)).toEqual(['STT_SEGMENT_NOT_TRANSCRIBED']);
    expect(rig.errors[0]!.retryable).toBe(false);
    expect(rig.order.slice(-2)).toEqual(['error:STT_SEGMENT_NOT_TRANSCRIBED', 'final']);
  });

  it('🔴 a redial still connecting at release that then fails: said, and not dialled a second time', async () => {
    const rig = await makeRig({ declared: true, script: (i) => (i === 0 ? {} : { open: 'reject', openDelayMs: 600 }) });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(1); // the dial starts
    await rig.release();

    expect(rig.engines).toHaveLength(2); // bounded
    expect(rig.merged()).toBe(rig.corpus.slice(0, 10));
    expect(codes(rig)).toEqual(['STT_SEGMENT_NOT_TRANSCRIBED']);
  });

  it('a permanent refusal on the closing dial is reported under its own code, not as a missing stretch', async () => {
    const rig = await makeRig({ declared: true, script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    await rig.speak(10);
    rig.engines[0]!.emitDrop();
    await rig.speak(2);
    const auth = new SttEngineError('STT_ENGINE_AUTH_FAIL', '[unauthorized] bad key', false);
    const realOpen = TranscribingEngine.prototype.open;
    TranscribingEngine.prototype.open = async function (): Promise<void> { throw auth; };
    try { await rig.release(); } finally { TranscribingEngine.prototype.open = realOpen; }

    expect(codes(rig)).toEqual(['STT_ENGINE_AUTH_FAIL']);
    expect(rig.errors[0]!.retryable).toBe(false);
  });

  it('ONE terminal frame — the ladder already named the cause, so the owed words add no second frame', async () => {
    const rig = await makeRig({ declared: true, script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    const auth = new SttEngineError('STT_ENGINE_AUTH_FAIL', '[unauthorized] bad key', false);
    const realOpen = TranscribingEngine.prototype.open;
    TranscribingEngine.prototype.open = async function (this: TranscribingEngine): Promise<void> {
      if (this === rig.engines[0]) return realOpen.call(this);
      throw auth;
    };
    try {
      await rig.speak(10);
      rig.engines[0]!.emitDrop();
      await rig.speak(2);           // owed
      await rig.quiet(10);          // the rung fires, is refused for good ⇒ the ladder speaks
      expect(codes(rig)).toEqual(['STT_ENGINE_AUTH_FAIL']);
      await rig.speak(2);           // still owed, and no rung is pending
      await rig.release();
    } finally { TranscribingEngine.prototype.open = realOpen; }

    expect(codes(rig)).toEqual(['STT_ENGINE_AUTH_FAIL']);
    expect(rig.merged()).toBe(rig.corpus.slice(0, 10));
  });

  it('voice that reached NO engine at all keeps STT_NO_ENGINE_REACHED — the two verdicts never both speak', async () => {
    const rig = await makeRig({ declared: true, script: (i) => (i === 0 ? {} : { open: 'reject' }) });
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(3);
    await rig.quiet(80); // the ladder (1+2+4 s) exhausts
    await rig.release();

    expect(codes(rig)).toContain('STT_NO_ENGINE_REACHED');
    expect(codes(rig)).not.toContain('STT_SEGMENT_NOT_TRANSCRIBED');
  });

  it('NEGATIVE CONTROL — nothing owed at release ⇒ no error, even for a declared client', async () => {
    const plain = await makeRig({ declared: true });
    await plain.speak(10);
    await plain.release();
    expect(codes(plain)).toEqual([]);

    const delivered = await makeRig({ declared: true });
    await delivered.speak(10);
    delivered.engines[0]!.emitDrop();
    await delivered.speak(3);   // owed, and the closing rung delivers them
    await delivered.release();
    expect(delivered.merged()).toBe(delivered.corpus.slice(0, 13));
    expect(codes(delivered)).toEqual([]);
  });
});

// Card RC-1 (2026-09-24) — the ladder must not be burnt by our own hands.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.4 (the cascade: a
//     pause cut landed inside a silence redial's connect window, closed the
//     opening leg, and three more of our own closes burnt the 3-rung ladder in
//     3 s ⇒ STT_NETWORK_DROP with the network fine), §5 RC-1
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 item 3, RC-1 correction block ①②
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §3.2
//     「我们自己关掉了一条正在建连的腿」
//
// The engine is a stand-in whose `open()` settles only when the test says so and
// whose `close()` rejects a pending open — the shape of the real Soniox adapter
// (`packages/stt-cloud` `SonioxEngine.open`: a close before 'open' rejects), and
// the only way to put a cut INSIDE the connect window deterministically.
//
// ── THE SEQUENCE (card RC-1, test 2) ────────────────────────────────────────
//   speak 6 s → pause ⇒ cut #1 (leg 1 born, cadence re-armed for 5 s)
//   3 s of silence ⇒ the silence hang-up closes leg 1
//   one voiced chunk ⇒ the redial dials leg D; its open() is held
//   the cadence deadline passes while D is opening (D is non-null ⇒ `due`)
//   ≥600 ms of closed gate ⇒ a pause cut is decided INSIDE D's connect window
//   D opens.
//
// REVERSE CONTROLS (SAW RED 〔2026-09-24, lane-c〕, logs under `.local/rc-relay-1/`):
//   ① the superseded return removed from `engine-session.ts handleEngineError`
//      ⇒ case B red on `reconnecting` frames (`collision-red-superseded.log`);
//   ② the `engineOpening` deferral removed from `orchestrator-rollover.ts
//      startRollover` ⇒ case A red on 「flushed while not open」
//      (`collision-red-deferral.log`).
// Each restored from the original text, same command green again.
//
// ── CASE C (card RC-F, 2026-09-24) — a SLOW connect, not a closed one ────────
// SPEC-REF: docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §4.1, §7 RC-F.
// The rerun's two `retry_count 1` frames (R8b) were NOT this file's collision:
// both times the leg a cut had just started took longer than
// `engineSpawnTimeoutMs` (5 s) to open — 3 s of injected delay plus a real
// Soniox connect over 2 s — and NR-96-A counted it as one rung, by design. A/B
// hold ONE leg and release it before the cap; nothing here had ever taken a leg
// past the cap. C pins both sides of that line with a clock-driven open on
// EVERY leg: 3 s under a 5 s cap ⇒ no rung at all, across the cold open, the
// cut's rollover and the silence redial; 5.5 s on one leg ⇒ exactly one rung,
// raised as SpawnTimeoutError, naming and closing THAT leg and nobody else.
// REVERSE CONTROLS (SAW RED 〔2026-09-24, lane-c〕, logs under `.local/rc2/`), each a
// temporary edit of the cap argument in `orchestrator-rollover.ts`, never committed:
//   ① rollover cap ×2 ⇒ C2 red, `expected [] to deeply equal [ 'SpawnTimeoutError' ]`
//      (`rcf-red-rollover-cap-x2.log`);
//   ② rollover cap ÷2 ⇒ C1 red, 「the cut's leg opened: expected 'closed'」
//      (`rcf-red-rollover-cap-half.log`);
//   ③ `dialLeg` cap ×2 ⇒ C3 red, `expected [] …` (`rcf-red-redial-cap-x2.log`).
// Each restored from the original file, same command green again.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

class Leg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  private _state: EngineState = 'closed';
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  heard = 0;
  flushedWhileOpen = 0;
  flushedWhileNotOpen = 0;
  closed = false;
  constructor(readonly name: string, private readonly held: boolean) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.held) await new Promise<void>((resolve, reject) => { this.pending = { resolve, reject }; });
    this._state = 'open';
  }
  finishOpen(): void { this.pending?.resolve(); this.pending = null; }
  // ⚠️ 更正（integ merge RC-relay-1 × RC-relay-2，2026-09-24）：原为 an interim on EVERY push. RC-5a now replays a
  // pause cut's withheld tail into the next leg, and a fake that 「hears words」 in silence banked them into this
  // row at the hang-up; a real vendor says nothing for silence, so neither does this one (the payload is 0 there).
  push(chunk: Buffer): void { this.heard += 1; if (chunk[0] !== 0) this.emit('interim', { kind: 'interim', text: `${this.name}${this.heard}`, confidence: 0.5, language: 'zh' }); }
  async flush(): Promise<void> {
    // Real Soniox: a flush on a socket that is not open resolves at once, no final.
    if (this._state !== 'open') { this.flushedWhileNotOpen += 1; return; }
    this.flushedWhileOpen += 1;
    this.emit('final', { kind: 'final', text: `${this.name}:${this.heard}`, confidence: 0.9, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> {
    this.closed = true; this._state = 'closed';
    this.pending?.reject(new Error('closed while connecting')); this.pending = null;
  }
}

interface Rig {
  clock: FakeClock;
  orch: SttEngineOrchestrator;
  legs: Leg[];
  errors: string[];
  statuses: string[];
  finals: Array<{ text: string; is_segment: boolean; after: string }>;
  setVoiced(v: boolean): void;
  pump(n: number): Promise<void>;
}

/** Legs are handed out in order; the one at `heldIdx` holds its open(). */
async function rig(heldIdx: number): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  const legs: Leg[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new Leg(`L${legs.length}`, legs.length === heldIdx);
    legs.push(leg);
    return leg;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 5_000, softSegmentGraceMs: 600_000, engineSpawnTimeoutMs: 5_000,
    shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
  });
  const r: Rig = {
    clock, orch, legs, errors: [], statuses: [], finals: [],
    setVoiced(v) { voiced = v; },
    async pump(n) {
      for (let i = 0; i < n; i++) {
        const payload = Buffer.alloc(CHUNK_BYTES, voiced ? 0x40 : 0);
        orch.pushChunk({ seq: seqNo++, ts_ms: clock.now, payload });
        await clock.advance(CHUNK_MS);
      }
    },
  };
  let seqNo = 0;
  orch.on('error', (e: { code: string }) => r.errors.push(e.code));
  orch.on('engine-status', (s: { status: string }) => r.statuses.push(s.status));
  orch.on('interim', () => { /* listener mandatory */ });
  orch.on('final', (f: { text: string; is_segment: boolean }) => r.finals.push({ text: f.text, is_segment: f.is_segment, after: legs.map((l) => l.state).join(',') }));
  await orch.start({ language: 'zh', mode: 'realtime' });
  return r;
}

/** Drives the sequence up to 「a pause cut is decided while D is opening」. Returns D. */
async function toCutInsideConnectWindow(r: Rig): Promise<Leg> {
  await r.pump(30);                 // 6 s of speech; `due` at 5 s
  r.setVoiced(false);
  await r.pump(4);                  // ≥600 ms closed ⇒ cut #1 ⇒ leg 1 born
  expect(r.finals.filter((f) => f.is_segment), 'precondition: cut #1 minted a row').toHaveLength(1);
  await r.pump(17);                 // 3 s idle ⇒ hang-up; leg 1 closed
  expect(r.legs[1]!.closed, 'precondition: the silence hang-up happened').toBe(true);
  r.setVoiced(true);
  await r.pump(1);                  // voice ⇒ the redial dials D (held)
  const d = r.legs[2]!;
  expect(d, 'precondition: the redial made a leg').toBeDefined();
  expect(d.state).toBe('closed');
  r.setVoiced(false);
  await r.pump(10);                 // the 5 s deadline (cut #1 + 5 s) passes with D non-null, gate closed ≥600 ms ⇒ the cut is decided
  return d;
}

describe('RC-1 — a pause cut inside a redial\'s connect window', () => {
  it('A: the cut waits for the leg to open, then ends the row from an OPEN leg; no rung, no error', async () => {
    const r = await rig(2);
    const d = await toCutInsideConnectWindow(r);
    expect(d.flushedWhileNotOpen, 'a leg still connecting must never be flushed').toBe(0);
    expect(d.closed, 'nor closed by the cut').toBe(false);
    expect((r.orch as unknown as { cutDeferred: boolean }).cutDeferred, 'precondition: a cut WAS decided inside the window').toBe(true);
    const rowsBefore = r.finals.filter((f) => f.is_segment).length;

    d.finishOpen();                 // D opens; the redial replays the owed voiced chunk into it
    await drain();
    await r.pump(1);                // the first chunk after ⇒ the deferred cut runs
    await drain();

    expect(d.flushedWhileOpen, 'the deferred cut flushed D once it was open').toBe(1);
    const rows = r.finals.filter((f) => f.is_segment);
    expect(rows.length, 'the cut still happened — deferred, not dropped').toBe(rowsBefore + 1);
    expect(rows[rows.length - 1]!.text, 'and the row carries what D heard (the words before the pause)').toMatch(/^L2:/);
    expect(r.statuses.filter((s) => s === 'reconnecting'), 'no rung').toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('B: a second spawner closing the opening leg (the stray double-spawn, §1.4 step 4) is not a failure', async () => {
    const r = await rig(2);
    const d = await toCutInsideConnectWindow(r);
    // What a ladder rung or a rollover does at `spawnEngine`'s entry: close the current leg — D, still opening.
    await (r.orch as unknown as { spawnEngine(): Promise<void> }).spawnEngine();
    await drain();
    const e = r.legs[3]!;
    expect(d.closed).toBe(true);
    expect(e.state, 'the newer leg opened').toBe('open');
    expect((r.orch as unknown as { engine: unknown }).engine, 'and it is the session\'s leg').toBe(e);
    await r.clock.advance(2_500);   // past the rung a counted failure would schedule (1 s), short of E's own 3 s hang-up
    expect(r.statuses.filter((s) => s === 'reconnecting'), 'D\'s rejection counted no rung').toEqual([]);
    expect(r.errors).toEqual([]);
    expect(e.closed, 'nobody closed the newer leg').toBe(false);
  });
});

// ── case C ──────────────────────────────────────────────────────────────────

/** A leg whose open() takes `delayMs` of FAKE clock; a close() while opening
 *  rejects the open, as the real Soniox adapter does. */
class SlowLeg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  private _state: EngineState = 'closed';
  private pending: { reject: (e: Error) => void; timer: unknown } | null = null;
  heard = 0;
  closed = false;
  closedWhileOpening = false;
  constructor(readonly name: string, private readonly delayMs: number, private readonly clock: FakeClock) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => { this.pending = null; resolve(); }, this.delayMs);
      this.pending = { reject, timer };
    });
    this._state = 'open';
  }
  push(chunk: Buffer): void { this.heard += 1; if (chunk[0] !== 0) this.emit('interim', { kind: 'interim', text: `${this.name}${this.heard}`, confidence: 0.5, language: 'zh' }); }
  async flush(): Promise<void> {
    if (this._state !== 'open') return;
    this.emit('final', { kind: 'final', text: `${this.name}:${this.heard}`, confidence: 0.9, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> {
    this.closed = true; this._state = 'closed';
    if (this.pending) {
      this.closedWhileOpening = true;
      this.clock.clearTimeout(this.pending.timer);
      this.pending.reject(new Error('closed before established'));
      this.pending = null;
    }
  }
}

interface SlowRig {
  clock: FakeClock;
  orch: SttEngineOrchestrator;
  legs: SlowLeg[];
  errors: string[];
  statuses: Array<{ status: string; retry_count?: number }>;
  /** What the ladder was handed: the error's class name and the leg it named. */
  ladderErrors: Array<{ name: string; leg: unknown }>;
  setVoiced(v: boolean): void;
  pump(n: number): Promise<void>;
}

/** Every leg opens after `delayFor(i)` ms of fake clock; the cold open pays it too. */
async function slowRig(delayFor: (idx: number) => number): Promise<SlowRig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  const legs: SlowLeg[] = [];
  let voiced = true;
  let seqNo = 0;
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new SlowLeg(`L${legs.length}`, delayFor(legs.length), clock);
    legs.push(leg);
    return leg;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 5_000, softSegmentGraceMs: 600_000, engineSpawnTimeoutMs: 5_000,
    shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
  });
  const r: SlowRig = {
    clock, orch, legs, errors: [], statuses: [], ladderErrors: [],
    setVoiced(v) { voiced = v; },
    async pump(n) {
      for (let i = 0; i < n; i++) {
        orch.pushChunk({ seq: seqNo++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, voiced ? 0x40 : 0) });
        await clock.advance(CHUNK_MS);
      }
    },
  };
  // The classification is the ladder's INPUT, so read it there: wrap the one
  // method every live-leg spawn failure is routed to (the cold open never
  // reaches the ladder). Pass-through — the behaviour under test is unchanged.
  const ladder = (orch as unknown as { ladder: { handleEngineError(err: Error, leg?: unknown): void } }).ladder;
  const handle = ladder.handleEngineError.bind(ladder);
  ladder.handleEngineError = (err: Error, leg?: unknown): void => { r.ladderErrors.push({ name: err.name, leg }); handle(err, leg); };
  orch.on('error', (e: { code: string }) => r.errors.push(e.code));
  orch.on('engine-status', (s: { status: string; retry_count?: number }) => r.statuses.push({ status: s.status, retry_count: s.retry_count }));
  orch.on('interim', () => { /* listener mandatory */ });
  orch.on('final', () => { /* rows are not this case's question */ });
  const started = orch.start({ language: 'zh', mode: 'realtime' });
  await clock.advance(delayFor(0));
  await started;
  return r;
}

const rungs = (r: SlowRig): Array<{ status: string; retry_count?: number }> => r.statuses.filter((s) => s.status === 'reconnecting');

/** speak 6 s → pause ⇒ the cut dials leg 1; keep speaking while it opens. */
async function cutThenSpeak(r: SlowRig, speakChunks: number): Promise<void> {
  await r.pump(30);                 // 6 s of speech; `due` at 5 s
  r.setVoiced(false);
  await r.pump(4);                  // ≥600 ms closed ⇒ cut ⇒ rollover dials leg 1
  expect(r.legs.length, 'precondition: the cut dialled a new leg').toBe(2);
  expect(r.legs[0]!.closed, 'precondition: the cut retired leg 0').toBe(true);
  r.setVoiced(true);
  await r.pump(speakChunks);
}

describe('RC-F — case C: a slow connect costs a rung only past the cap, and only the slow leg', () => {
  it('C1: every leg takes 3 s to open under a 5 s cap ⇒ no rung, no reconnecting, across cut, hang-up and redial', async () => {
    const r = await slowRig(() => 3_000);
    await cutThenSpeak(r, 25);      // leg 1 opens 3 s in, 2 s of speech after it
    expect(r.legs[1]!.state, "the cut's leg opened").toBe('open');
    expect(r.legs[1]!.heard, 'and was fed').toBeGreaterThan(0);

    r.setVoiced(false);
    await r.pump(20);               // 4 s of silence ⇒ the 3 s hang-up
    const beforeRedial = r.legs.length;
    expect(r.legs[beforeRedial - 1]!.closed, 'precondition: the silence hang-up closed the current leg').toBe(true);
    r.setVoiced(true);
    await r.pump(25);               // voice ⇒ the redial dials a leg that opens 3 s later
    const redial = r.legs[beforeRedial]!;
    expect(redial, 'precondition: the redial made a leg').toBeDefined();
    expect(redial.state, "the redial's leg opened").toBe('open');

    expect(r.legs.some((l) => l.closedWhileOpening), 'no leg was closed while it was still opening').toBe(false);
    expect(r.ladderErrors, 'the ladder was handed nothing').toEqual([]);
    expect(rungs(r), 'zero rungs').toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("C2: the cut's leg takes 5.5 s ⇒ exactly one rung, SpawnTimeoutError, and that leg is the one closed", async () => {
    const r = await slowRig((i) => (i === 1 ? 5_500 : 3_000));
    await cutThenSpeak(r, 50);      // 10 s: the 5 s cap ⇒ rung after its backoff ⇒ a 3 s leg opens
    const slow = r.legs[1]!;

    expect(r.ladderErrors.map((e) => e.name), 'one failure reached the ladder, classified as a spawn timeout').toEqual(['SpawnTimeoutError']);
    expect(r.ladderErrors[0]!.leg, 'naming the slow leg').toBe(slow);
    expect(slow.closedWhileOpening, 'the slow leg is the one closed').toBe(true);
    expect(rungs(r), 'exactly one rung').toEqual([expect.objectContaining({ retry_count: 1 })]);

    const replacement = r.legs[2]!;
    expect(r.legs.length, 'the rung made exactly one more leg').toBe(3);
    expect(replacement.state, 'which opened').toBe('open');
    expect(replacement.closed, 'and nobody closed it').toBe(false);
    expect((r.orch as unknown as { engine: unknown }).engine, "and it is the session's leg").toBe(replacement);
    expect(r.statuses[r.statuses.length - 1]!.status, 'the rung ended in ready').toBe('ready');
    expect(r.legs.filter((l) => l.closedWhileOpening), 'no other leg was closed while opening').toEqual([slow]);
    expect(r.errors).toEqual([]);
  });

  it("C3: the silence redial's leg takes 5.5 s ⇒ the same single rung, naming the redial's leg", async () => {
    // The rewritten §7-8 criterion allows injecting on the hang-up redial only;
    // this is what a 5.5 s injection there must produce.
    const r = await slowRig((i) => (i === 2 ? 5_500 : 3_000));
    await cutThenSpeak(r, 25);
    r.setVoiced(false);
    await r.pump(20);               // the hang-up closes leg 1
    expect(r.legs[1]!.closed, 'precondition: hung up').toBe(true);
    r.setVoiced(true);
    await r.pump(50);               // redial leg 2 (5.5 s) ⇒ timeout ⇒ rung ⇒ leg 3 (3 s) opens
    const slow = r.legs[2]!;

    expect(r.ladderErrors.map((e) => e.name)).toEqual(['SpawnTimeoutError']);
    expect(r.ladderErrors[0]!.leg).toBe(slow);
    expect(slow.closedWhileOpening).toBe(true);
    expect(rungs(r)).toEqual([expect.objectContaining({ retry_count: 1 })]);
    expect(r.legs[3]!.state).toBe('open');
    expect(r.legs.filter((l) => l.closedWhileOpening)).toEqual([slow]);
    expect(r.errors).toEqual([]);
  });
});

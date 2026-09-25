// NR-96 follow-up (2026-09-24) — the attempt-generation guard in
// `orchestrator-core.ts spawnEngine`.
//
// THE RACE. A spawn raced by `raceSpawnTimeout` is abandoned when the cap
// fires: the ladder (or `dialLeg`, which hands its failure to the ladder)
// closes the hung engine and, one backoff later, spawns the next one. If the
// abandoned `open()` rejects only AFTER that — a vendor that sat on the
// handshake and then refused — its catch used to call `closeEngine()`, which
// closes whatever `this.engine` is by then: the NEWER attempt's live leg. The
// session then has no engine, no error, and no rung scheduled.
//
// Both rows force exactly that ordering with a deferred `open()` and assert on
// the newer engine: still the orchestrator's leg, still open, still fed.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await drain();
    }
    this.now = target;
    await drain();
  }
}
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** `open()` settles only when the test says so — the late rejection is forced,
 *  not hoped for. `close()` deliberately does NOT settle it: the vendor decides
 *  when its handshake answers, not our socket teardown. */
class ControlledEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  pushes = 0;
  closed = false;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  constructor(private readonly mode: 'ok' | 'deferred' | 'reject', public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.mode === 'reject') throw new Error('connect refused');
    if (this.mode === 'deferred') await new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    this._state = 'open';
  }
  rejectLate(): void { this.settle?.reject(new Error('handshake refused, late')); }
  resolveLate(): void { this.settle?.resolve(); }
  say(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 0.5, language: 'zh' }); }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { /* noop */ }
  async close(): Promise<void> { this._state = 'closed'; this.closed = true; }
  drop(): void { this.emit('error', new Error('drop')); }
}

const liveLeg = (orch: SttEngineOrchestrator): unknown => (orch as unknown as { engine: unknown }).engine;
const chunk = (seq: number, now: number): { seq: number; ts_ms: number; payload: Buffer } => ({ seq, ts_ms: now, payload: Buffer.alloc(6_400, 1) });

describe('NR-96 stale-spawn guard — the ladder rung', () => {
  it('a timed-out rung whose open() rejects AFTER the next rung succeeded does not close the newer leg', async () => {
    const clock = new FakeClock();
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    session.start();
    const cold = new ControlledEngine('ok');
    const hung = new ControlledEngine('deferred');
    const next = new ControlledEngine('ok');
    const queue = [cold, hung, next];
    const orch = new SttEngineOrchestrator(session, () => queue.shift()!, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      engineSpawnTimeoutMs: 5_000, softSegmentMs: 600_000,
    });
    const errors: string[] = [];
    orch.on('error', (e: { code: string }) => errors.push(e.code));
    orch.on('engine-status', () => { /* recorded elsewhere */ });
    orch.on('interim', () => { /* listener mandatory */ });
    orch.on('final', () => { /* listener mandatory */ });
    await orch.start({ language: 'zh', mode: 'realtime' });

    cold.drop();
    await drain();
    await clock.advance(1_000 + 5_000);   // rung 1 dials `hung`; the cap abandons it
    expect(hung.closed, 'the abandoned attempt was torn down by the ladder').toBe(true);
    await clock.advance(2_000);           // rung 2 dials `next` and it opens
    expect(liveLeg(orch)).toBe(next);
    expect(next.state).toBe('open');

    hung.rejectLate();                    // the vendor finally answers rung 1: refused
    await drain();

    expect(liveLeg(orch), 'the late rejection must not take the newer leg down').toBe(next);
    expect(next.closed).toBe(false);
    orch.pushChunk(chunk(0, clock.now));
    await drain();
    expect(next.pushes, 'and the newer leg is still being fed').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

describe('NR-96 stale-spawn guard — dialLeg (silence redial)', () => {
  it('a timed-out redial whose open() rejects AFTER the ladder recovered does not close the recovered leg', async () => {
    const clock = new FakeClock();
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    session.start();
    const cold = new ControlledEngine('ok');
    const hungRedial = new ControlledEngine('deferred');
    const rung = new ControlledEngine('ok');
    const queue = [cold, hungRedial, rung];
    let voiced = true;
    const orch = new SttEngineOrchestrator(session, () => queue.shift()!, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      engineSpawnTimeoutMs: 5_000, softSegmentMs: 600_000,
      shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
    });
    orch.on('error', () => { /* none expected; asserted via the leg */ });
    orch.on('engine-status', () => { /* noop */ });
    orch.on('interim', () => { /* listener mandatory */ });
    orch.on('final', () => { /* listener mandatory */ });
    await orch.start({ language: 'zh', mode: 'realtime' });

    let seq = 0;
    const pump = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) { orch.pushChunk(chunk(seq++, clock.now)); await clock.advance(200); }
    };
    await pump(3);
    voiced = false; await pump(20);       // 4 s of silence: the leg is hung up
    expect(cold.closed, 'precondition: the silence hang-up happened').toBe(true);
    voiced = true; await pump(1);         // voice ⇒ dialLeg dials `hungRedial`
    await clock.advance(5_000);           // the cap abandons it ⇒ the ladder takes over
    expect(hungRedial.closed).toBe(true);
    await clock.advance(1_000);           // rung 1 dials `rung` and it opens
    expect(liveLeg(orch)).toBe(rung);

    hungRedial.rejectLate();
    await drain();

    expect(liveLeg(orch), 'the late redial rejection must not take the recovered leg down').toBe(rung);
    expect(rung.closed).toBe(false);
  });
});

// Card RC-7 (2026-09-24) — the other half of the same race: the abandoned rung's
// open() SUCCEEDS late, after the ladder has already said 「terminated」
// (CR-12-E root cause §1.9, follow-up row). Before RC-7 that leg became
// `this.engine`, was fed, produced interims, armed the hang-up countdown and
// rechecked the quota — the session answered 「is it dead」 twice (R11).
//
// REVERSE CONTROL (SAW RED 〔2026-09-24, lane-c〕): the `this.ladder.gaveUp`
// check removed from `orchestrator-core.ts spawnEngine` ⇒ this row red on the
// late leg becoming the session's leg. Log `.local/rc-relay-1/stale-spawn-red.log`;
// restored, same command green.
describe('RC-7 — a rung that opens after the ladder gave up does not revive the session', () => {
  it('no leg, no feed, no interim after the verdict; the terminal final carries none of it', async () => {
    const clock = new FakeClock();
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    let rechecks = 0;
    session.setQuotaRefresher(() => { rechecks += 1; return Number.POSITIVE_INFINITY; });
    session.start();
    const cold = new ControlledEngine('ok');
    const r1 = new ControlledEngine('reject');
    const r2 = new ControlledEngine('reject');
    const late = new ControlledEngine('deferred');
    const queue = [cold, r1, r2, late];
    const orch = new SttEngineOrchestrator(session, () => queue.shift()!, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      engineSpawnTimeoutMs: 5_000, softSegmentMs: 600_000, idleHangupMs: 3_000,
    });
    const errors: string[] = [];
    const interims: string[] = [];
    const finals: string[] = [];
    orch.on('error', (e: { code: string }) => errors.push(e.code));
    orch.on('engine-status', () => { /* noop */ });
    orch.on('interim', (e: { text: string }) => interims.push(e.text));
    orch.on('final', (f: { text: string }) => finals.push(f.text));
    await orch.start({ language: 'zh', mode: 'realtime' });
    orch.pushChunk(chunk(0, clock.now));  // the live leg heard something, so the verdict below is only the ladder's
    expect(cold.pushes).toBe(1);

    cold.drop();
    await drain();
    await clock.advance(1_000);          // rung 1 refused
    await clock.advance(2_000);          // rung 2 refused
    await clock.advance(4_000 + 5_000);  // rung 3 dials `late`; the cap abandons it ⇒ the ladder gives up
    expect(errors, 'precondition: the verdict was spoken').toEqual(['STT_NETWORK_DROP']);
    const rechecksAtVerdict = rechecks;

    late.resolveLate();                  // the vendor finally accepts rung 3
    await drain();
    expect(liveLeg(orch), 'the late leg must not become the session\'s leg').toBeNull();
    expect(late.closed, 'it is closed').toBe(true);
    orch.pushChunk(chunk(1, clock.now));
    late.say('late words');
    await drain();
    expect(late.pushes, 'and nothing is fed to it').toBe(0);
    expect(interims, 'no interim after the verdict').toEqual([]);
    expect(rechecks, 'no quota recheck for a leg that was not born').toBe(rechecksAtVerdict);
    await orch.stop();
    expect(finals.join(''), 'the terminal final carries none of the late leg').not.toContain('late words');
    expect(errors, 'one verdict, never a second answer').toEqual(['STT_NETWORK_DROP']);
  });
});
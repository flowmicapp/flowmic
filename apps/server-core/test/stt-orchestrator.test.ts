// WP-R1-3 orchestrator tests (mechanism-unchanged line): soft-segment rollover, reconnect
// ladder, hard-limit auto-stop, and interim = offlineAccum + onlineDraft
// accumulation. Deterministic via a FakeEngine + injected FakeClock.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { SttEngineError } from '../src/stt/engines/base';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    // Fire due timers in chronological order, draining microtasks between each.
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
const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** Controllable batch-style engine (id avoids the streaming flush floor). */
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  pushes = 0;
  finalOnFlush: string | null = null;
  failOpen = false;
  /** Card ENG-2 (fix-029): throw THIS from open() — lets a row pick the exact error
   *  shape (a named SttEngineError vs a bare connect Error). Wins over the
   *  boolean when both are set. Same field, same name and same semantics as the
   *  FakeEngine in no-engine-heard.test.ts, which pins the COLD-OPEN half of the
   *  card; these rows pin the RECONNECT half. */
  failOpenWith: Error | null = null;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { if (this.failOpenWith) throw this.failOpenWith; if (this.failOpen) throw new Error('open failed'); this._state = 'open'; }
  push(): void { this.pushes++; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  emitInterim(text: string): void { this.emit('interim', { kind: 'interim', text, confidence: 0.5, language: 'zh' }); }
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
  emitError(): void { this.emit('error', new Error('drop')); }
  /** A vendor refusal the engine itself declares permanent — the shape a live
   *  Soniox `402 organization_balance_exhausted` arrives in. */
  emitPermanentError(code = 'STT_ENGINE_AUTH_FAIL', message = '[organization_balance_exhausted] no funds'): void {
    this.emit('error', new SttEngineError(code, message, false));
  }
}

type EvKey = 'interim' | 'final' | 'engine-status' | 'error' | 'auto-stopped';

function harness(engines: FakeEngine[], opts: Record<string, unknown> = {}): { orch: SttEngineOrchestrator; clock: FakeClock; session: AudioSession; events: Record<EvKey, unknown[]> } {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, engineFlushTimeoutMs: 1_000,
    // card SEG-1: a zero grace makes the cadence deadline cut IMMEDIATELY, i.e.
    // exactly the pre-SEG-1 stopwatch. Pinned here on purpose — the rows in this
    // file are about index accounting, flush races and settlement fields, none of
    // which is a claim about WHERE a sentence should end. The boundary policy has
    // its own file (`stt-segment-boundary.test.ts`) and its own wiring rows in
    // `stt-segment-settlement.test.ts`; leaving it live here would make every one
    // of these tests depend on a second, unrelated decision.
    softSegmentGraceMs: 0,
    ...opts,
  });
  const events: Record<EvKey, unknown[]> = { interim: [], final: [], 'engine-status': [], error: [], 'auto-stopped': [] };
  for (const ev of Object.keys(events) as EvKey[]) orch.on(ev, (p: unknown) => events[ev].push(p));
  return { orch, clock, session, events };
}

describe('SttEngineOrchestrator', () => {
  it('emits interim = offlineAccum + onlineDraft and a terminal final on stop', async () => {
    const eng = new FakeEngine();
    const { orch, clock, events } = harness([eng]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(6400) });
    eng.emitInterim('大家'); // onlineDraft
    eng.emitFinal('大家好，'); // folds into offlineAccum, resets draft
    eng.emitInterim('欢迎'); // new draft on top of the offline accum
    const lastInterim = events.interim.at(-1) as { text: string };
    expect(lastInterim.text).toBe('大家好，欢迎');
    eng.finalOnFlush = '大家好，欢迎使用';
    await orch.stop();
    const fin = events.final.at(-1) as { text: string; is_segment: boolean };
    expect(fin.text).toBe('大家好，欢迎使用');
    expect(fin.is_segment).toBe(false);
    expect((events['engine-status'][0] as { status: string }).status).toBe('ready');
  });

  it('card SEG-4: the soft-segment timer rotates the LEG; the boundary delivers the row', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.finalOnFlush = 'segment one';
    await clock.advance(30_000); // deadline + zero grace ⇒ the LEG rotates…
    expect((events.final as { is_segment: boolean }[]).filter((f) => f.is_segment))
      .toHaveLength(0);          // …and NO row was minted by the clock
    expect(b.state).toBe('open');
    // The engine confirms a sentence in the new leg; the next chunk delivers.
    b.emitFinal('segment one 完毕。');
    orch.pushChunk({ seq: 0, ts_ms: clock.now, payload: Buffer.alloc(6400) });
    await drain();
    const seg = events.final.find((f) => (f as { is_segment: boolean }).is_segment) as { text: string; segment_idx: number; is_segment: boolean };
    expect(seg.is_segment).toBe(true);
    expect(seg.segment_idx).toBe(0);
    await orch.stop();
    const fin = events.final.at(-1) as { text: string; segment_idx: number; is_segment: boolean };
    expect(fin.segment_idx).toBe(1);
    expect(fin.is_segment).toBe(false);
  });

  it('runs the reconnect ladder on an unexpected engine error (reconnecting→ready)', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.emitError(); // unexpected drop
    await drain();
    const reconnecting = events['engine-status'].find((s) => (s as { status: string }).status === 'reconnecting') as { retry_count: number };
    expect(reconnecting.retry_count).toBe(1);
    await clock.advance(1_000); // backoff[0] → respawn
    const ready = events['engine-status'].filter((s) => (s as { status: string }).status === 'ready');
    expect(ready.length).toBeGreaterThanOrEqual(2); // initial + post-reconnect
  });

  it('surfaces a terminal STT_NETWORK_DROP after the reconnect budget is exhausted', async () => {
    // engine[0] opens fine, then drops; every RECONNECT spawn fails → the ladder
    // exhausts its 3-retry budget and surfaces the terminal error (S-API-8).
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine(), new FakeEngine()];
    for (let n = 1; n < engines.length; n++) engines[n]!.failOpen = true;
    const { orch, clock, events } = harness(engines, { reconnectBackoffMs: [1_000, 1_000, 1_000], maxRetries: 3 });
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitError(); // unexpected drop → ladder starts
    await drain();
    for (let n = 0; n < 4; n++) await clock.advance(1_000); // each reconnect spawn fails
    const failed = events['engine-status'].find((s) => (s as { status: string }).status === 'failed');
    expect(failed).toBeDefined();
    const err = events.error.find((e) => (e as { code: string }).code === 'STT_NETWORK_DROP');
    expect(err).toBeDefined();
    expect((err as { retryable: boolean }).retryable).toBe(false);
  });

  /**
   * 🔴 Card N1-B4 REWROTE THIS TEST, and the old assertions are quoted below rather
   * than deleted, because the change is a PRODUCT decision, not a bug fix.
   *
   * It used to read: 「auto-stops at the hard limit with a terminal final」 —
   *   expect(events['auto-stopped']).toHaveLength(1);
   *   expect(reason).toBe('hard_limit');
   *   expect(fin.is_segment).toBe(false);
   *   expect(session.state).toBe('auto_stopped');
   *
   * Design §2.3 (2026-08-08-design-n1-long-recording.md): the ceiling stops
   * applying to 「this user utterance」 and applies to 「the engine session」 — at five minutes the LEG
   * is recycled and the user keeps talking. `audio:auto-stopped` is kept for the
   * cases that really must stop (quota / resource / abnormal), which is the
   * narrowing N1-B1 prepared and which the sibling test in
   * stt-segment-settlement.test.ts still holds to the letter.
   */
  it('N1-B4: the 5-minute engine-session ceiling rolls the leg over — the recording continues', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, session, events } = harness([a, b], { hardLimitMs: 300_000 });
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.finalOnFlush = 'the whole utterance'; b.finalOnFlush = 'the whole utterance';
    await clock.advance(300_000); // the ceiling fires on the session
    await drain();

    // Nothing ended: no auto-stop reached the bridge, and the session — whose
    // state the phone's FSM mirrors — never left `recording`.
    expect(events['auto-stopped']).toHaveLength(0);
    expect(session.state).toBe('recording');
    // card SEG-4: the ceiling rotates the LEG and mints nothing at all now — a
    // vendor session limit is not allowed to end the user's sentence. A single
    // `is_segment:false` here would mean the phone had been told the recording
    // was over while the user was still holding the button.
    expect(events.final as unknown[]).toHaveLength(0);

    // Positive control: the terminal final still exists and carries the banked
    // text — it is the RELEASE that produces it, which is the point.
    await orch.stop();
    const fin = events.final.at(-1) as { is_segment: boolean; text: string };
    expect(fin.is_segment).toBe(false);
    expect(fin.text).toBe('the whole utterance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 2026-08-02 (L2): the ladder used to ignore `SttEngineError.retryable`.
// Found by the first REAL Soniox round-trip, not by reading — see
// docs/strategy/shots-2026-08-02-l2-soniox/README.md §4 for the live before/after.
//
// REVERSE CONTROL (run 2026-08-02, saw RED): deleting the `isPermanentEngineError`
// branch from `engine-session.ts handleEngineError` turns the first two tests
// below red —
//   AssertionError: expected undefined not to be undefined   // the honest code
//   AssertionError: expected 'reconnecting' to be 'failed'
// while 「still climbs the ladder for a RETRYABLE error」 and the existing
// STT_NETWORK_DROP test stay green. That pairing is the point: the change must
// alter ONLY the permanent case.
// ─────────────────────────────────────────────────────────────────────────────
describe('reconnect ladder honours `retryable` (no pointless climb, no false story)', () => {
  it('🔴 a PERMANENT engine error goes terminal immediately — no reconnect at all', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.emitPermanentError();
    await drain();
    // No 'reconnecting' rung: retrying a vendor that refuses every time is 7 s
    // of backoff spent on a certainty.
    expect(events['engine-status'].some((s) => (s as { status: string }).status === 'reconnecting')).toBe(false);
    expect((events['engine-status'].at(-1) as { status: string }).status).toBe('failed');
  });

  it("🔴 and it reports the ENGINE'S code + message, not a network story", async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.emitPermanentError();
    await drain();
    const err = events.error.at(-1) as { code: string; message: string; retryable: boolean };
    expect(err).not.toBeUndefined();
    // 「network interrupted, recognition session ended」 would be FALSE here: the network was fine and the
    // account was out of funds. The one sentence the operator needs is the
    // vendor's own — and the raw error_type has to survive, because we are not
    // allowed to mint a new ERROR_CODES entry (owner gate).
    expect(err.code).toBe('STT_ENGINE_AUTH_FAIL');
    expect(err.code).not.toBe('STT_NETWORK_DROP');
    expect(err.message).toContain('organization_balance_exhausted');
    // The phone's FSM branches on THIS field (ptt_inbound.dart), so it closes
    // PROCESSING at once instead of idling out its 15 s stall net.
    expect(err.retryable).toBe(false);
  });

  it('🔴 the SAME permanent error during FLUSH gets the SAME verdict — the phase is not the answer', async () => {
    // Found live: a run whose open() was ~1 s slower delivered the refusal after
    // flush() had begun, and the user got 「STT engine failed during flush /
    // retryable:true」 instead of the truth. Same event, two answers, decided by
    // a race. REVERSE CONTROL (2026-08-02, saw RED): removing the
    // `retryable === false` branch from `handleFlushError` turns this red with
    //   AssertionError: expected 'STT_ENGINE_TIMEOUT' to be 'STT_ENGINE_AUTH_FAIL'
    // while the generic-error case below stays green.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = async (): Promise<void> => { a.emitPermanentError(); };
    await orch.stop();
    const err = events.error.at(-1) as { code: string; message: string; retryable: boolean };
    expect(err.code).toBe('STT_ENGINE_AUTH_FAIL');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('organization_balance_exhausted');
  });

  it('positive control: a generic flush failure still gets the generic verdict', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = async (): Promise<void> => { a.emit('error', new Error('socket wobbled')); };
    await orch.stop();
    const err = events.error.at(-1) as { code: string; retryable: boolean };
    expect(err.code).toBe('STT_ENGINE_TIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('positive control: a RETRYABLE error still climbs the ladder exactly as before', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', 'blip', true));
    await drain();
    expect(events['engine-status'].some((s) => (s as { status: string }).status === 'reconnecting')).toBe(true);
    await clock.advance(1_000);
    expect(events['engine-status'].filter((s) => (s as { status: string }).status === 'ready').length).toBeGreaterThanOrEqual(2);
  });

  it("positive control: a plain Error (the ladder's own spawn-failure signal) still retries", async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, events } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.emitError();   // plain Error — no `retryable` at all
    await drain();
    expect(events['engine-status'].some((s) => (s as { status: string }).status === 'reconnecting')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 Card ENG-2 (fix-029), the RECONNECT half — the fourth site, and the only one
// where the engine's verdict was DESTROYED rather than re-coded.
//
// The L2 describe above proves a permanent engine error is honoured when it
// arrives on the engine's OWN 'error' channel, and no-engine-heard.test.ts's
// 「ENG-2」 describe proves it survives the COLD OPEN. Between them sat a third
// producer with no coverage at all: `attemptReconnect`'s catch, which bound
// nothing and handed the ladder a synthetic `new Error('Engine spawn failed
// during reconnect')`. So an engine refusing every re-handshake — a 402
// balance-exhausted on re-open, sherpa-local's STT_CONFIG_MISSING for a
// disappeared addon — was retried the whole budget and then reported as
// 「network interrupted, recognition session ended」: the exact story L2 removed, still being told one
// path over.
//
// REVERSE CONTROL — RUN and SAW RED (2026-08-13, machine dev-pc-a).
// Restore the blanket (`catch { this.handleEngineError(new Error('Engine spawn
// failed during reconnect')); }`) in engine-session.ts `attemptReconnect`:
// 1 failed / 17 passed in this file, verbatim —
//   × ENG-2: a RECONNECT spawn failure keeps the engine's own verdict >
//     🔴 a PERMANENT named error from a RECONNECT spawn keeps ITS code — and stops the climb
//       AssertionError: expected [] to deeply equal [ 'STT_ENGINE_AUTH_FAIL' ]
// while BOTH paired rows below (the unnamed failure, and the retryable named
// one) stayed green — which is what proves this narrows the flattening instead
// of moving it. Restored afterwards; residual grep = 0; suite re-run green.
//
// ⚠️ The red is `[]` and not `['STT_NETWORK_DROP']` because under the blanket
// the verdict has not been reached YET at that instant — the ladder is still
// climbing. Where the run ENDS up under the blanket was measured separately in
// the same session (probe: advance past the whole budget, print the codes) and
// it is the flattening this card is about, verbatim:
//   PROBE-EXHAUSTED-CODES: ["STT_NETWORK_DROP"]
// i.e. 7 s of backoff spent on a certainty, and then 「network interrupted, recognition session ended」 for
// an account that was out of funds. Both halves of that red are the defect;
// neither is visible from the fixed code's side, which is why they are written
// down here rather than described.
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-2: a RECONNECT spawn failure keeps the engine\'s own verdict', () => {
  /** engine[0] opens and then drops; every reconnect spawn is engine[1], whose
   *  open() throws whatever the row chose (the harness clamps the factory index,
   *  so b answers every later spawn too). */
  function laddered(bFails: (b: FakeEngine) => void): { a: FakeEngine; b: FakeEngine; rig: ReturnType<typeof harness> } {
    const a = new FakeEngine(); const b = new FakeEngine();
    bFails(b);
    const rig = harness([a, b], { reconnectBackoffMs: [1_000, 1_000, 1_000], maxRetries: 3 });
    return { a, b, rig };
  }
  const statuses = (events: Record<EvKey, unknown[]>, want: string): unknown[] =>
    events['engine-status'].filter((s) => (s as { status: string }).status === want);
  const codes = (events: Record<EvKey, unknown[]>): string[] =>
    (events.error as { code: string }[]).map((e) => e.code);

  it('🔴 a PERMANENT named error from a RECONNECT spawn keeps ITS code — and stops the climb', async () => {
    const { a, rig } = laddered((b) => {
      b.failOpenWith = new SttEngineError('STT_ENGINE_AUTH_FAIL', '[organization_balance_exhausted] no funds', false);
    });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    a.emitError();                       // a bare drop: rung 1 is armed, as always
    await drain();
    await rig.clock.advance(1_000);      // rung 1 spawns b, whose open() refuses

    // ONE verdict, delivered at the FIRST refusal, carrying the engine's own
    // code. Asserted as the WHOLE array rather than as `err.code`, because that
    // is what makes the reverse control's red name which failure came back:
    // `[]` = the ladder just kept climbing (no verdict at all yet), and
    // `['STT_NETWORK_DROP']` = it climbed and then told the network story. A
    // bare `err.code` assertion reds with a TypeError on the first shape and
    // says nothing (measured — that is exactly what it did).
    //
    // It also pins that the fallback does not fire ALONGSIDE the named code:
    // 「network interrupted」 next to 「balance exhausted」 is not two facts, it is one of them being
    // wrong — and the wrong one is the one that looks actionable.
    expect(codes(rig.events)).toEqual(['STT_ENGINE_AUTH_FAIL']);
    const err = rig.events.error.at(-1) as { code: string; message: string; retryable: boolean };
    // The message is the actionable half: it names the vendor's own reason.
    expect(err.message).toContain('organization_balance_exhausted');
    expect(err.retryable).toBe(false);
    expect((rig.events['engine-status'].at(-1) as { status: string }).status).toBe('failed');

    // Exactly ONE rung: the one that was already armed when the drop happened.
    // Retrying a vendor that refuses every handshake is backoff spent on a
    // certainty — the same waste L2 removed for the mid-session channel.
    expect(statuses(rig.events, 'reconnecting')).toHaveLength(1);
    await rig.clock.advance(10_000);     // nothing may wake up after the verdict
    expect(statuses(rig.events, 'reconnecting')).toHaveLength(1);
    expect(rig.events.error).toHaveLength(1);
  });

  it('🔴 PAIRED — an UNNAMED reconnect spawn failure still exhausts to STT_NETWORK_DROP', async () => {
    // The fallback, unchanged: a bare rejection carries no engine verdict, so
    // 「engine unreachable」 is what it has always said and still says (S-API-8 / 06 §2.3).
    const { a, rig } = laddered((b) => { b.failOpen = true; });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    a.emitError();
    await drain();
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000);

    const err = rig.events.error.at(-1) as { code: string; message: string; retryable: boolean };
    expect(err.code).toBe('STT_NETWORK_DROP');
    expect(err.retryable).toBe(false);
    // The S-API-8 fixed terminal message, pinned so 「the fallback still names the
    // code」 cannot quietly start carrying an engine's message instead.
    expect(err.message).toBe('Engine reconnect exhausted');
    expect(statuses(rig.events, 'reconnecting')).toHaveLength(3);
    expect((rig.events['engine-status'].at(-1) as { status: string }).status).toBe('failed');
  });

  it('🔴 PAIRED — a RETRYABLE named error still climbs the whole budget (only the permanent case moved)', async () => {
    // 429 is the engine saying 「later」, not 「never」. Passing the error object
    // through must not turn every named code into a fast fail — that would be
    // moving the defect, not removing it.
    //
    // ⚠️ This row also PINS THE OPEN ACCOUNT registered on `failTerminal`: the
    // exhausted verdict still overwrites this engine's own code with
    // STT_NETWORK_DROP. That is today's behaviour and today's behaviour contract
    // (06 §2.3); it is asserted here so the day someone rules on it, this row is
    // the one that goes red and says so.
    const { a, rig } = laddered((b) => {
      b.failOpenWith = new SttEngineError('STT_ENGINE_RATE_LIMITED', 'whisper http 429', true);
    });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    a.emitError();
    await drain();
    await rig.clock.advance(1_000);
    // Still climbing after the first refusal — no terminal verdict yet.
    expect(rig.events.error).toHaveLength(0);
    expect(statuses(rig.events, 'reconnecting')).toHaveLength(2);
    for (let n = 0; n < 3; n++) await rig.clock.advance(1_000);
    expect(codes(rig.events)).toEqual(['STT_NETWORK_DROP']);
    expect(statuses(rig.events, 'reconnecting')).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 2026-08-02 (L9): 「the engine returned not a single character」 used to be COMPLETELY SILENT.
//
// The live finding: the Soniox adapter's end-of-stream frame was the wrong TYPE,
// so `engine.flush()` never resolved and EVERY utterance settled on the flush
// cap. On the wire that produced an ordinary `stt:final` (sometimes empty) with
// `errors: []` — and the session was still billed. Nothing said the engine had
// never finished.
//
// REVERSE CONTROL (run 2026-08-02, saw RED): deleting the body of
// `orchestrator-core.ts reportSilentEmptyFinal` (early `return`) turns the first
// test below red —
//   AssertionError: expected undefined not to be undefined
// while ALL THREE positive controls stay green. That pairing is the whole point:
// the guard must fire on exactly one of the four shapes.
// ─────────────────────────────────────────────────────────────────────────────
describe('no silent empty final (no silent failure, the flush-cap half)', () => {
  /** flush() that never settles — the live Soniox shape before the L9 fix. */
  const hangingFlush = (e: FakeEngine): void => { e.flush = (): Promise<void> => new Promise<void>(() => { /* never */ }); };

  it('🔴 flush cap fires + empty text + audio WAS fed ⇒ a NAMED error, not silence', async () => {
    const a = new FakeEngine();
    const { orch, clock, events } = harness([a]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(6400) });
    expect(a.pushes).toBe(1); // the precondition this test rests on, asserted not assumed
    hangingFlush(a);
    const stopped = orch.stop();
    await clock.advance(1_000); // the flush cap (harness sets engineFlushTimeoutMs)
    await stopped;
    const err = events.error.at(-1) as { code: string; message: string; retryable: boolean } | undefined;
    expect(err).not.toBeUndefined();
    expect(err!.code).toBe('STT_ENGINE_TIMEOUT');
    // The byte count is the part an operator can act on: it separates 「fed in
    // but no answer」 from 「never fed at all」, which is the whole reason the guard has a
    // third condition.
    expect(err!.message).toContain('6400 bytes');
    // The final STILL fires. Suppressing it would leave the phone's FSM sitting
    // in PROCESSING until its 15 s stall net — a second failure, not a fix.
    expect(events.final).toHaveLength(1);
    expect((events.final[0] as { text: string }).text).toBe('');
  });

  it('positive control: cap fires but NOTHING was ever fed ⇒ silence is correct', async () => {
    // Nothing to transcribe. Blaming the engine here would be a false alarm in
    // the other direction.
    const a = new FakeEngine();
    const { orch, clock, events } = harness([a]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    hangingFlush(a);
    const stopped = orch.stop();
    await clock.advance(1_000);
    await stopped;
    expect(events.error).toEqual([]);
  });

  it('positive control: the engine FINISHED and returned nothing ⇒ still no error', async () => {
    // The vendor answered; the answer was 「I heard nothing」. Calling that a
    // timeout would be one code answering two questions.
    const a = new FakeEngine();
    const { orch, events } = harness([a]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(6400) });
    await orch.stop();                     // FakeEngine.flush resolves at once
    expect(events.error).toEqual([]);
    expect((events.final.at(-1) as { text: string }).text).toBe('');
  });

  it('positive control: cap fires but text was recovered ⇒ degraded, not absent', async () => {
    const a = new FakeEngine();
    const { orch, clock, events } = harness([a]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(6400) });
    a.emitInterim('大家好');               // lands in onlineDraft → survives the cap
    hangingFlush(a);
    const stopped = orch.stop();
    await clock.advance(1_000);
    await stopped;
    expect(events.error).toEqual([]);
    expect((events.final.at(-1) as { text: string }).text).toBe('大家好');
  });
});

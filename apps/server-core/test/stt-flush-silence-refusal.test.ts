// Card ENG-4, flush phase (2026-09-03) — the vendor's 「No audio received」 arriving
// through the IDLE HANG-UP's flush, not through the ladder.
//
// THE ACCOUNT is a production trace, measured three times 〔2026-09-03 06:50 /
// 06:54 / 06:57 UTC, production relay; docs/strategy/2026-09-03-realtime-
// utterance-lifecycle-trace.md §4 / §4-1〕. A held button that stays quiet for
// the first ~3 s: the VAD gate feeds the managed Soniox leg nothing, the 3.0 s
// idle hang-up runs `flushAndCloseLegForSilence`, the end-of-stream frame reaches
// a session that never got audio, Soniox answers `[invalid_request] No audio
// received.`, `packages/stt-cloud` remaps it to `STT_NO_ENGINE_REACHED`
// (retryable:false), and — because `flushing === true` — the error took
// `handleFlushError` → `flushErrorVerdict`, which passes a permanent engine code
// through verbatim. The phone showed 「This recording reached no speech engine」
// three runs out of three. `vendorNoAudioIsOurSilence` (the suppression written
// for EXACTLY this case, no-engine-heard.test.ts ENG-4) was wired to the
// reconnect ladder's hook only; the flush branch and the cold-open branch never
// consulted it. The negative control that proved it: `stt.no-voice: vendor
// refused an empty session` never printed once across the three runs.
//
// FIX: `SttEngineOrchestrator.emitEngineError` is now the ONE exit for a LIVE
// leg's engine error (ladder rung + flush phase), and the suppression runs
// there. The COLD-OPEN branch in `start()` deliberately stays outside it
// (owner-side ruling, 2026-09-03) — the POSITIVE row below pins that. No VAD threshold, hang-up
// timing, or vendor remap changed — the rows below drive the gate as a boolean,
// exactly as stt-idle-hangup.test.ts does (its header says why that seam is
// the right one), with the REAL hang-up, the REAL flush race and the real
// counter.
//
// ⚠️ WHY THE LATCH ROW EXISTS. `handleFlushError` used to set `flushErrored`
// unconditionally, and `flushAndEmitFinal` reads that latch to WITHHOLD an empty
// terminal final. A suppression that still latched would leave the phone with
// neither the banner nor 「没有听到语音」 (the empty final is what triggers that
// sentence) — a silent failure one layer below the one being fixed. The latch
// is now set only when the frame was spoken; the 「released before 3 s」 row
// pins it.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 REVERSE CONTROLS — both RUN and both SAW RED 〔2026-09-03, worktree
// wpf-eng4, machine dev-pc-a〕. Restored from a byte-level backup (cmp
// identical); `REVERSE-CONTROL-ENG4-FLUSH` greps to 0.
//
// ① THE MUTE BUTTON — `emitEngineError`'s predicate replaced by `true` in place
//    (suppress UNCONDITIONALLY). **2 failed | 4 passed**, verbatim:
//      × 🔴 PAIRED — speech DID pass the gate ⇒ the same refusal in the same phase goes out unchanged
//          AssertionError: expected [] to include 'STT_NO_ENGINE_REACHED'
//      × PAIRED — a DIFFERENT permanent code in the same phase over the same silence is untouched
//          AssertionError: expected [] to deeply equal [ 'STT_ENGINE_AUTH_FAIL' ]
//    Every suppression row stayed GREEN under the mute button — which is exactly
//    why the paired rows are the ones that matter: without them, 「the fix works」
//    and 「the fix hides every vendor refusal」 are indistinguishable.
//
// ② THE PRE-FIX WIRING — predicate replaced by `false` (never suppress: what the
//    flush and cold-open branches did before 2026-09-03). **4 failed | 2 passed**:
//      × quiet for >3 s ⇒ …        expected [ 'STT_NO_ENGINE_REACHED' ] to deeply equal []
//      × after a suppressed hang-up flush, speech arriving later …
//                                   expected [] to have a length of 1 but got +0
//      × released BEFORE 3 s …     expected [ 'STT_NO_ENGINE_REACHED' ] to deeply equal []
//      × through the bridge …      expected [ { event: 'stt:error', …(1) } ] to deeply equal []
//    The first of those IS the production symptom, reproduced by the test; the
//    two PAIRED rows stayed green, so ① and ② turn DISJOINT rows red — one
//    control could not tell 「the suppression works」 from 「it fires too widely」.
//    (The cold-open POSITIVE row was added after both runs; it does not pass
//    through `emitEngineError`, so neither control could have moved it.)
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import { SttEngineError, type SttEngine, type EngineState } from '../src/stt/engines/base';
import { SttSessionBridge } from '../src/engine/stt-session';
import { log } from '../src/log';
import type { VadGate } from '../src/stt/vad-gate';

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

/** A streaming engine in the Soniox shape: an interim per push, the flush is
 *  the only final — and, when told to, the flush answers with the vendor's
 *  refusal INSTEAD of a final (an end-of-stream frame sent to a session that
 *  was never handed audio). */
class RefusingEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  pushes = 0;
  refuseFlushWith: SttEngineError | null = null;
  /** Set ⇒ open() rejects with this — the cold-open shape. */
  failOpenWith: SttEngineError | null = null;
  constructor(public readonly id: SttEngineId = 'soniox') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { if (this.failOpenWith) throw this.failOpenWith; this._state = 'open'; }
  push(_payload: Buffer): void {
    this.pushes += 1;
    this.emit('interim', { kind: 'interim', text: `w${this.pushes}`, confidence: 0.5, language: 'en' });
  }
  async flush(): Promise<void> {
    if (this.refuseFlushWith) { this.emit('error', this.refuseFlushWith); return; }
    this.emit('final', { kind: 'final', text: this.pushes > 0 ? 'heard' : '', confidence: 1, language: 'en', duration_ms: 0 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

const CHUNK_MS = 200;
const CHUNK_BYTES = 6400;
/** Strictly more silence than the hang-up threshold — one chunk of headroom. */
const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;
/** The frame `packages/stt-cloud/src/engines/soniox.ts` `classifyNoAudio` produces. */
const noAudio = (): SttEngineError => new SttEngineError('STT_NO_ENGINE_REACHED', '[invalid_request] No audio received.', false);

type EvKey = 'interim' | 'final' | 'error' | 'error-suppressed' | 'engine-status';
interface Rig {
  orch: SttEngineOrchestrator;
  clock: FakeClock;
  engines: RefusingEngine[];
  events: Record<EvKey, unknown[]>;
  speak: (n: number) => Promise<void>;
  quiet: (n: number) => Promise<void>;
  codes: () => string[];
  errorFor: (code: string) => { code: string; message: string; retryable: boolean } | undefined;
  lastFinal: () => { text: string; is_segment: boolean };
}

function harness(): Rig {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const engines: RefusingEngine[] = [];
  let voiced = false;
  const orch = new SttEngineOrchestrator(session, () => { const e = new RefusingEngine(); engines.push(e); return e; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 600_000, engineFlushTimeoutMs: 1_000,
    // The production pair engine-factory.ts hands a gated managed leg: the gate
    // as a predicate, and the hang-up armed at its real default.
    shouldFeedEngine: (): boolean => voiced,
    idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
    reconnectBackoffMs: [1_000, 1_000, 1_000], maxRetries: 3,
  });
  const events: Record<EvKey, unknown[]> = { interim: [], final: [], error: [], 'error-suppressed': [], 'engine-status': [] };
  for (const ev of Object.keys(events) as EvKey[]) orch.on(ev, (p: unknown) => events[ev].push(p));
  let seq = 0;
  const pump = async (n: number): Promise<void> => {
    for (let k = 0; k < n; k++) {
      orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES) });
      seq += 1;
      await clock.advance(CHUNK_MS);
    }
  };
  const errs = (): { code: string; message: string; retryable: boolean }[] => events.error as { code: string; message: string; retryable: boolean }[];
  return {
    orch, clock, engines, events,
    speak: async (n) => { voiced = true; await pump(n); },
    quiet: async (n) => { voiced = false; await pump(n); },
    codes: () => errs().map((e) => e.code),
    errorFor: (code) => errs().find((e) => e.code === code),
    lastFinal: () => events.final.at(-1) as { text: string; is_segment: boolean },
  };
}

describe('ENG-4 (flush phase): a vendor "no audio" refusal through the idle hang-up is about OUR silence', () => {
  it('🔴 quiet for >3 s ⇒ the hang-up flush is refused, no stt:error goes out, the refusal is logged, the empty final still does', async () => {
    const rig = harness();
    await rig.orch.start({ language: 'en', mode: 'realtime' });
    rig.engines[0]!.refuseFlushWith = noAudio();
    await rig.quiet(SILENCE_CHUNKS);

    // The precondition the verdict rests on, ASSERTED not assumed: the gate fed
    // this leg nothing, and the hang-up really ran (the leg is closed).
    expect(rig.engines[0]!.pushes).toBe(0);
    expect(rig.engines[0]!.state).toBe('closed');
    // 🔴 The production symptom: this used to be ['STT_NO_ENGINE_REACHED'].
    expect(rig.codes()).toEqual([]);
    // 🔴 Suppressed ≠ dropped — this is the event the bridge turns into the
    // `stt.no-voice` log line (the bridge row below asserts the line itself).
    expect(rig.events['error-suppressed']).toHaveLength(1);
    expect((rig.events['error-suppressed'][0] as { message: string }).message).toContain('No audio received.');

    await rig.orch.stop();
    // The user is not left with silence: the empty terminal final is what makes
    // the phone say 「没有听到语音」 (SttStallReason.emptyTranscript).
    expect(rig.codes()).toEqual([]);
    expect(rig.lastFinal()).toMatchObject({ text: '', is_segment: false });
  });

  it('🔴 POSITIVE — the same code at a COLD OPEN stays loud: start() rejects AND stt:error goes out', async () => {
    // The one branch that deliberately bypasses `emitEngineError` (owner-side
    // ruling, 2026-09-03). At a cold open `voiceBytesCaptured` is 0 by
    // definition, so routing it through the suppression would mute EVERY
    // cold-open code and leave the phone with `engine-status: failed` alone —
    // the bridge narrates only SttConfigMissingError there.
    const clock = new FakeClock();
    const failing = new RefusingEngine();
    failing.failOpenWith = noAudio();
    const orch = new SttEngineOrchestrator(
      new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 }),
      () => failing,
      { now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, shouldFeedEngine: () => false, idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS },
    );
    const errors: { code: string; retryable: boolean }[] = []; const suppressed: unknown[] = [];
    orch.on('error', (e: { code: string; retryable: boolean }) => errors.push(e));
    orch.on('error-suppressed', (e: unknown) => suppressed.push(e));
    await expect(orch.start({ language: 'en', mode: 'realtime' })).rejects.toBe(failing.failOpenWith);

    expect(errors.map((e) => e.code)).toEqual(['STT_NO_ENGINE_REACHED']);
    expect(errors[0]!.retryable).toBe(false);
    expect(suppressed).toEqual([]);
  });

  it('🔴 PAIRED — speech DID pass the gate ⇒ the same refusal in the same phase goes out unchanged', async () => {
    // The case the code was registered for: we captured speech and the vendor
    // still says it got nothing. If this row ever goes green by accident the
    // flush-phase suppression has become a mute button — see the reverse
    // control in the header.
    const rig = harness();
    await rig.orch.start({ language: 'en', mode: 'realtime' });
    rig.engines[0]!.refuseFlushWith = noAudio();
    await rig.speak(5);
    await rig.quiet(SILENCE_CHUNKS);

    expect(rig.engines[0]!.pushes).toBe(5); // real voice was fed
    expect(rig.codes()).toContain('STT_NO_ENGINE_REACHED');
    expect(rig.errorFor('STT_NO_ENGINE_REACHED')!.retryable).toBe(false);
    expect(rig.errorFor('STT_NO_ENGINE_REACHED')!.message).toContain('No audio received.');
    expect(rig.events['error-suppressed']).toHaveLength(0);
    await rig.orch.stop();
  });

  it('PAIRED — a DIFFERENT permanent code in the same phase over the same silence is untouched', async () => {
    // Positive control on the narrowing: the condition is not 「we heard
    // nothing, so say nothing」.
    const rig = harness();
    await rig.orch.start({ language: 'en', mode: 'realtime' });
    rig.engines[0]!.refuseFlushWith = new SttEngineError('STT_ENGINE_AUTH_FAIL', '[unauthorized] bad key', false);
    await rig.quiet(SILENCE_CHUNKS);

    expect(rig.codes()).toEqual(['STT_ENGINE_AUTH_FAIL']);
    expect(rig.events['error-suppressed']).toHaveLength(0);
    await rig.orch.stop();
  });

  it('🔴 after a suppressed hang-up flush, speech arriving later still redials a fresh leg and produces interims', async () => {
    // The 「fourth run」 of the trace: the session must survive the suppressed
    // refusal so the user who pauses and then speaks is transcribed.
    const rig = harness();
    await rig.orch.start({ language: 'en', mode: 'realtime' });
    rig.engines[0]!.refuseFlushWith = noAudio();
    await rig.quiet(SILENCE_CHUNKS);
    expect(rig.events['error-suppressed']).toHaveLength(1);
    expect(rig.events.interim).toHaveLength(0);

    await rig.speak(5);
    expect(rig.engines).toHaveLength(2);
    expect(rig.engines[1]!.state).toBe('open');
    expect(rig.engines[1]!.pushes).toBeGreaterThan(0);
    expect(rig.events.interim.length).toBeGreaterThan(0);
    expect(rig.codes()).toEqual([]);

    await rig.orch.stop();
    expect(rig.codes()).toEqual([]);
    expect(rig.lastFinal().text).not.toBe('');
  });

  it('🔴 released BEFORE 3 s of silence ⇒ the terminal flush is refused, and the empty final is NOT withheld by the latch', async () => {
    // Same refusal, terminal path (`stop()` → `flushAndEmitFinal`). This is the
    // row that pins 「a suppressed refusal does not set flushErrored」: with the
    // latch set, `flushAndEmitFinal` returns without any final and the phone gets
    // nothing at all.
    const rig = harness();
    await rig.orch.start({ language: 'en', mode: 'realtime' });
    rig.engines[0]!.refuseFlushWith = noAudio();
    await rig.quiet(5); // 1 s — the hang-up never fires
    expect(rig.engines[0]!.state).toBe('open');
    await rig.orch.stop();

    expect(rig.codes()).toEqual([]);
    expect(rig.events['error-suppressed']).toHaveLength(1);
    expect(rig.lastFinal()).toMatchObject({ text: '', is_segment: false });
  });

  it('🔴 through the bridge: no stt:error on the wire, and the `stt.no-voice` line is what the log carries', async () => {
    // The wire-level assertion the trace's negative control was built on — the
    // three production runs had `stt.error emitted` and NO `stt.no-voice` line.
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const clock = new FakeClock();
      const engines: RefusingEngine[] = [];
      const emitted: { event: string; payload: unknown }[] = [];
      let orch: SttEngineOrchestrator | null = null;
      const bridge = new SttSessionBridge({
        build: (session: AudioSession, _lang: string, _uid: string, vad?: VadGate) => {
          // The production wiring shape (engine-factory.ts `gated` pair): the
          // bridge's REAL VadGate is the predicate, and all-zero PCM below keeps
          // it closed exactly as a quiet room does.
          orch = new SttEngineOrchestrator(session, () => { const e = new RefusingEngine(); engines.push(e); return e; }, {
            now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
            softSegmentMs: 600_000, engineFlushTimeoutMs: 1_000,
            shouldFeedEngine: (): boolean => vad!.open,
            idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
          });
          return { orchestrator: orch, isByok: false, gated: true };
        },
        emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
        userId: 'u', mode: 'realtime', sourceLang: 'en',
        onComplete: () => undefined,
        levelIntervalMs: 0,
      });
      await drain();
      engines[0]!.refuseFlushWith = noAudio();
      const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
      for (let seq = 0; seq < SILENCE_CHUNKS; seq++) {
        bridge.pushChunk(seq, silence, clock.now);
        await clock.advance(CHUNK_MS);
      }
      expect(engines[0]!.pushes).toBe(0);
      expect(engines[0]!.state).toBe('closed');

      expect(emitted.filter((e) => e.event === 'stt:error')).toEqual([]);
      const line = info.mock.calls.find((c) => c[0] === 'stt.no-voice: vendor refused an empty session');
      expect(line).toBeDefined();
      expect(line![1]).toMatchObject({ code: 'STT_NO_ENGINE_REACHED', message: '[invalid_request] No audio received.' });

      await bridge.finish();
      expect(emitted.filter((e) => e.event === 'stt:error')).toEqual([]);
      expect(emitted.find((e) => e.event === 'stt:final')?.payload).toMatchObject({ text: '', is_segment: false });
      // The renamed intake pair (trace §4-1's second finding): the billed,
      // gate-open figure under its own name and the real voiced counter next to it.
      const intake = info.mock.calls.find((c) => c[0] === 'audio intake');
      expect(intake![1]).toMatchObject({ gatedMs: 0, voicedMs: 0 });
      expect(intake![1]).not.toHaveProperty('sessionMs');
      bridge.dispose();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

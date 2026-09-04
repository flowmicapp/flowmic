// Card EMPTY-1 — 「the hold produced nothing, and the phone said nothing」.
//
// THE ACCOUNT, measured on real devices at 0.3.61 (both channels, one relay and
// one LAN sidecar):
//   · silence      `audio intake {"voicedMs":0}` → the phone's own 「No speech
//                  detected」 banner. Correct before this card and unchanged by it.
//   · Chinese spoken with the spoken-language setting on French, LAN sidecar,
//                  `sherpa-local`: `{"gatedMs":3060,"voicedMs":1280}`,
//                  `stt.final.raw chars 0`, NO error frame — and nothing on
//                  screen. The 「Transcribing」 row just disappeared.
// The engine did not fail; it finished and had nothing to say. No registered
// ErrorCode says that honestly, so the fact travels as the additive optional
// `stt:final.empty_reason` (adding a code is an owner gate here).
//
// 🔴 WHY THE ROWS BELOW ARE PAIRED. 「the field appears where it should」 and
// 「the field stays away where something else already spoke」 are different
// claims, and only the second one can catch the failure this card can actually
// cause: a SECOND, vaguer answer racing a named refusal the phone already
// renders per-code. Every positive row therefore has a negative twin.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROL — RUN, and it SAW RED (2026-09-04, machine dev-pc-a).
// Break: delete the `if (engineErrorEmitted) return null;` arm in
// `emptyFinalCause`. 5 red, 13 green, verbatim:
//   x the classifier refuses to speak over a registered code
//       AssertionError: expected 'heard_no_words' to be null
//   x PAIRED - an engine error already answered => the final stays silent  (x2, one per channel)
//       AssertionError: expected 'heard_no_words' to be undefined
//   x PAIRED - a cold-open refusal already answered => the final stays silent  (x2, one per channel)
//       AssertionError: expected 'no_voice' to be undefined
// Every positive row STAYED GREEN, which is the control on the control: the
// break widens the field's reach rather than removing it, and a positive-only
// suite would have called that a pass. Restored afterwards; `REVERSE-CONTROL`
// residue grep = 0.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { emptyFinalCause, EMPTY_FINAL_REASONS } from '../src/stt/empty-final-cause';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

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

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  pushes = 0;
  finalOnFlush: string | null = null;
  failOpen = false;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { if (this.failOpen) throw new Error('open failed'); this._state = 'open'; }
  push(): void { this.pushes++; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
  emitDrop(): void { this.emit('error', new Error('ws closed unexpectedly')); }
}

interface Frame { text: string; is_segment: boolean; empty_reason?: string }

function harness(engines: FakeEngine[], opts: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, engineFlushTimeoutMs: 1_000, softSegmentGraceMs: 0,
    reconnectBackoffMs: [1_000, 1_000, 1_000], maxRetries: 3, ...opts,
  });
  const finals: Frame[] = [];
  const errors: { code: string }[] = [];
  orch.on('final', (p: Frame) => finals.push(p));
  orch.on('error', (p: { code: string }) => errors.push(p));
  let seq = 0;
  return {
    orch, clock, finals, errors,
    speak: (n: number) => { for (let k = 0; k < n; k++) orch.pushChunk({ seq: seq++, ts_ms: seq * 200, payload: Buffer.alloc(6400) }); },
    terminal: (): Frame => finals.filter((f) => !f.is_segment).at(-1)!,
    codes: (): string[] => errors.map((e) => e.code),
  };
}

describe('emptyFinalCause — the rule on its own', () => {
  it('a final that HAS text is never explained', () => {
    expect(emptyFinalCause('hello', 0, false, false)).toBeNull();
    expect(emptyFinalCause('hello', 6400, false, false)).toBeNull();
  });

  it('the feed gate accepted nothing ⇒ no_voice', () => {
    expect(emptyFinalCause('', 0, false, false)).toBe('no_voice');
  });

  it('the feed gate accepted speech and no engine complained ⇒ heard_no_words', () => {
    expect(emptyFinalCause('', 6400, false, false)).toBe('heard_no_words');
  });

  it('🔴 the classifier refuses to speak over a registered code', () => {
    // The load-bearing arm. A network drop / auth failure / rate limit / timeout
    // / language refusal already left as `stt:error` with copy the phone renders
    // per-code; a second answer here would give one question two authors.
    expect(emptyFinalCause('', 6400, true, false)).toBeNull();
    expect(emptyFinalCause('', 0, true, false)).toBeNull();
  });

  it('🔴 a recording that DID produce words is never called wordless (N1-B2)', () => {
    // `text` is the terminal final, which after a rollover is the LAST SPAN
    // only, while the byte counter is recording-wide. Without this arm a silent
    // tail of a ten-minute dictation is reported as 「heard no words」 on a screen
    // already full of the words we heard.
    expect(emptyFinalCause('', 6400, false, true)).toBeNull();
  });

  it('every value it can produce is in the declared domain', () => {
    for (const v of [emptyFinalCause('', 0, false, false), emptyFinalCause('', 1, false, false)]) {
      expect(EMPTY_FINAL_REASONS).toContain(v);
    }
  });
});

// The orchestrator is the ONE code path both channels take: the LAN sidecar and
// the cloud relay run the same `server-core` build and differ only in which
// engine the router hands back. Each row below is therefore run twice, once with
// the id the LAN sidecar routes to and once with a cloud one — same rig, same
// assertions. A divergence could only come from the engine id, and these prove
// it does not.
const CHANNELS: { name: string; id: SttEngineId }[] = [
  { name: 'LAN standalone (sherpa-local)', id: 'sherpa-local' },
  { name: 'cloud relay (custom-openai-compatible)', id: 'custom-openai-compatible' },
];

describe.each(CHANNELS)('the terminal final explains itself — $name', ({ id }) => {
  it('silence ⇒ empty_reason no_voice, and NO error frame', async () => {
    const eng = new FakeEngine(id);
    const rig = harness([eng]);
    await rig.orch.start({ language: 'fr', mode: 'realtime' });
    eng.finalOnFlush = '';
    await rig.orch.stop();
    expect(rig.terminal().text).toBe('');
    expect(rig.terminal().empty_reason).toBe('no_voice');
    expect(rig.codes()).toEqual([]);
  });

  it('🔴 THE MEASURED GAP: speech in, no words out ⇒ empty_reason heard_no_words', async () => {
    const eng = new FakeEngine(id);
    const rig = harness([eng]);
    await rig.orch.start({ language: 'fr', mode: 'realtime' });
    rig.speak(5);                    // the gate accepts it; the engine is fed
    eng.finalOnFlush = '';           // …and answers with nothing at all
    await rig.orch.stop();
    expect(eng.pushes).toBeGreaterThan(0); // the precondition, asserted not assumed
    expect(rig.terminal().text).toBe('');
    expect(rig.terminal().empty_reason).toBe('heard_no_words');
    expect(rig.codes()).toEqual([]);       // nothing failed — that is the whole point
  });

  it('PAIRED — words came back ⇒ no explanation is attached', async () => {
    const eng = new FakeEngine(id);
    const rig = harness([eng]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(3);
    eng.finalOnFlush = 'hello there';
    await rig.orch.stop();
    expect(rig.terminal().text).toBe('hello there');
    expect(rig.terminal().empty_reason).toBeUndefined();
  });

  it('PAIRED — an engine error already answered ⇒ the final stays silent', async () => {
    // The ladder spends its budget and gives up: the recording leaves with a
    // named code (STT_NO_ENGINE_REACHED here, whose own copy the phone renders).
    const engines = [new FakeEngine(id), new FakeEngine(id), new FakeEngine(id), new FakeEngine(id)];
    for (let n = 1; n < engines.length; n++) engines[n]!.failOpen = true;
    const rig = harness(engines);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitDrop();
    await drain();
    rig.speak(5);
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000);
    await rig.orch.stop();
    expect(rig.codes().length).toBeGreaterThan(0);
    expect(rig.terminal().text).toBe('');
    expect(rig.terminal().empty_reason).toBeUndefined();
  });

  it('PAIRED — a cold-open refusal already answered ⇒ the final stays silent', async () => {
    const eng = new FakeEngine(id);
    eng.failOpen = true;
    const rig = harness([eng], { maxRetries: 0, reconnectBackoffMs: [] });
    // `start()` emits the refusal and RETHROWS (audio.handler's ack path owns the
    // throw); the frame we care about has already gone out by then.
    await expect(rig.orch.start({ language: 'zh', mode: 'realtime' })).rejects.toThrow();
    await rig.orch.stop();
    expect(rig.codes().length).toBeGreaterThan(0);
    expect(rig.terminal().empty_reason).toBeUndefined();
  });

  it('PAIRED — a rolled-over recording with a silent tail is not called wordless', async () => {
    const a = new FakeEngine(id); const b = new FakeEngine(id);
    const rig = harness([a, b]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    a.finalOnFlush = 'segment one';
    await rig.clock.advance(30_000);      // the leg rotates
    b.emitFinal('segment one 完毕。'); // the SEG-4 sentence verbatim: the cadence cuts on a terminator
    // Mirrors card SEG-4's row exactly: the chunk that carries the boundary is
    // stamped with the CURRENT clock, not a synthetic offset — the cadence reads
    // wall time, and a chunk timed at 200 ms after a 30 s advance is a different
    // scenario from the one this row means to set up.
    rig.orch.pushChunk({ seq: 0, ts_ms: rig.clock.now, payload: Buffer.alloc(6400) });
    await drain();
    expect(rig.finals.some((f) => f.is_segment)).toBe(true);
    b.finalOnFlush = '';                   // the tail span carries nothing
    await rig.orch.stop();
    expect(rig.terminal().text).toBe('');
    expect(rig.terminal().empty_reason).toBeUndefined();
  });
});

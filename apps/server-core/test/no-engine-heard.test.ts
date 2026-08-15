// Card fix-022 / G-23 — 「no engine heard this audio」 used to answer 「network drop」.
//
// THE ACCOUNT (owner ruling group #5-c, 2026-08-10). Audio was captured and
// handed to no engine at all; the only sentence the user got was
// `STT_NETWORK_DROP`「网络中断，识别会话终止」. That answers 「network」 while the
// question is 「where did what I said go」 — so it sends someone to check a WiFi connection
// that is working perfectly. `fix-019` registered `STT_NO_ENGINE_REACHED`;
// `orchestrator-core.ts` + `empty-final-verdicts.ts` produce it.
//
// 🔴 WHY EVERY VERDICT TEST HERE IS PAIRED. Narrowing a code and MOVING an
// ambiguity look identical from the new code's side — both make the new
// sentence appear. The difference is only visible from the OLD code's side, so
// each fault shape below is asserted twice: the new code appears where it can
// be proved, and `STT_NETWORK_DROP` still appears, unchanged, everywhere it did
// before.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROLS — both RUN and both SAW RED (2026-08-10, machine
// dev-pc-b). Restored afterwards; residual `REVERSE-CONTROL` grep = 0.
//
// ① Revert the verdict entirely — `noEngineReachedError` returns null always.
//    3 red, 6 green, verbatim:
//      × the WHOLE recording reached no engine
//          AssertionError: expected undefined not to be undefined
//      × PAIRED — the same run still answers STT_NETWORK_DROP
//          expected [ 'STT_NETWORK_DROP' ] to deeply equal [ 'STT_NETWORK_DROP', …(1) ]
//      × a reconnect that HANGS
//          expected [] to deeply equal [ 'STT_NO_ENGINE_REACHED' ]
//    Every STT_NETWORK_DROP-only row and every positive control stayed GREEN.
//    That pairing is the point: the change adds exactly one sentence, in
//    exactly one shape, and removes none.
//
// ② Un-narrow it — swap the session-wide `sessionFedBytes` for the per-leg
//    `engineFedBytes` (the counter that is reset for every new engine leg).
//    1 red, 8 green, verbatim:
//      × a rollover whose LAST leg heard nothing is NOT called unheard
//          expected [ 'STT_NO_ENGINE_REACHED' ] to not include 'STT_NO_ENGINE_REACHED'
//    That red IS the false alarm the narrowing exists to prevent: a user holding
//    a full transcript told 「这段录音没有到达任何识别引擎…请重新说一次」. Note that
//    ① and ② turn DIFFERENT rows red — a single control could not tell 「the
//    verdict works」 apart from 「the verdict fires too widely」.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { SttEngineError, type SttEngine, type EngineState } from '../src/stt/engines/base';

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
const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  pushes = 0;
  bytes = 0;
  finalOnFlush: string | null = null;
  failOpen = false;
  /** ENG-2 (fix-029): throw THIS from open() — lets a row pick the exact error
   *  shape (a named SttEngineError vs a bare connect Error). Wins over the
   *  boolean when both are set. */
  failOpenWith: Error | null = null;
  /** The CASE 4 shape: the vendor accepts the socket and never finishes the
   *  handshake. `this.engine` is assigned before `open()` is awaited, so the
   *  orchestrator holds an engine that can never be fed. */
  hangOpen = false;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.failOpenWith) throw this.failOpenWith;
    if (this.failOpen) throw new Error('open failed');
    if (this.hangOpen) return new Promise<void>(() => { /* never */ });
    this._state = 'open';
  }
  push(payload: Buffer): void { this.pushes++; this.bytes += payload.length; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
  /** An unexpected ws close — a plain Error, so the ladder climbs (the L2 branch
   *  for permanent errors is not what this file is about). */
  emitDrop(): void { this.emit('error', new Error('ws closed unexpectedly')); }
  /** A NAMED, permanent vendor refusal mid-session — the shape Soniox produces
   *  when it is closed without ever being handed audio (card ENG-4). */
  emitNamed(err: SttEngineError): void { this.emit('error', err); }
}

const CHUNK_BYTES = 6400;
// 'error-suppressed' (card ENG-4, 2026-08-15) is an orchestrator-internal event, never a
// wire frame: it carries a refusal we deliberately do not say to the user. Observing it
// here is what lets a row prove 「it was suppressed」 rather than 「nothing happened」 —
// two very different facts that an assertion on `events.error` alone cannot tell apart.
type EvKey = 'interim' | 'final' | 'engine-status' | 'error' | 'auto-stopped' | 'error-suppressed';
interface Rig {
  orch: SttEngineOrchestrator;
  clock: FakeClock;
  events: Record<EvKey, unknown[]>;
  speak: (n: number) => void;
  codes: () => string[];
  errorFor: (code: string) => { code: string; message: string; retryable: boolean } | undefined;
  lastFinal: () => { text: string; is_segment: boolean };
}

function harness(engines: FakeEngine[], opts: Record<string, unknown> = {}): Rig {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, engineFlushTimeoutMs: 1_000,
    reconnectBackoffMs: [1_000, 1_000, 1_000], maxRetries: 3, ...opts,
  });
  const events: Record<EvKey, unknown[]> = { interim: [], final: [], 'engine-status': [], error: [], 'auto-stopped': [], 'error-suppressed': [] };
  for (const ev of Object.keys(events) as EvKey[]) orch.on(ev, (p: unknown) => events[ev].push(p));
  let seq = 0;
  const errs = (): { code: string; message: string; retryable: boolean }[] => events.error as { code: string; message: string; retryable: boolean }[];
  return {
    orch, clock, events,
    speak: (n) => { for (let k = 0; k < n; k++) orch.pushChunk({ seq: seq++, ts_ms: seq * 200, payload: Buffer.alloc(CHUNK_BYTES) }); },
    codes: () => errs().map((e) => e.code),
    errorFor: (code) => errs().find((e) => e.code === code),
    lastFinal: () => events.final.at(-1) as { text: string; is_segment: boolean },
  };
}

/** engine[0] opens, then drops; every reconnect spawn fails to open ⇒ the ladder
 *  spends its whole budget and gives up (S-API-8). */
function exhaustingEngines(): FakeEngine[] {
  const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine(), new FakeEngine()];
  for (let n = 1; n < engines.length; n++) engines[n]!.failOpen = true;
  return engines;
}

describe('G-23: audio that reached no engine gets its own sentence', () => {
  it('🔴 the WHOLE recording reached no engine ⇒ STT_NO_ENGINE_REACHED', async () => {
    const engines = exhaustingEngines();
    const rig = harness(engines);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitDrop();          // drops before it is handed a single chunk
    await drain();
    rig.speak(5);                    // the user keeps talking into the outage
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000); // every rung fails
    await rig.orch.stop();

    // The precondition this whole verdict rests on, ASSERTED not assumed: not
    // one byte of this recording was ever handed to an engine.
    expect(engines.map((e) => e.pushes)).toEqual([0, 0, 0, 0]);

    const err = rig.errorFor('STT_NO_ENGINE_REACHED');
    expect(err).not.toBeUndefined();
    // 「this recording session ended」, not 「this sentence must not be said again」 — and false is what releases the
    // phone's FSM out of PROCESSING so the user can say it again at once.
    expect(err!.retryable).toBe(false);
    // Bytes that PASSED THE GATE. Never seconds: book 15 §6 G-23 forbids estimating
    // how much was lost, because `lastEngineFedSeq` is also advanced by chunks
    // the VAD gate refused ⇒ a duration would report silence as lost words.
    expect(err!.message).toContain(`${5 * CHUNK_BYTES} bytes`);
    expect(err!.message).not.toMatch(/\bseconds?\b|\bms\b/);

    // The registered copy promises 「没有转成文字」 — so the final going out with it
    // must really be empty, or the pair is one true sentence and one false one.
    expect(ERROR_CODES.STT_NO_ENGINE_REACHED.zh_CN).toContain('没有转成文字');
    expect(rig.lastFinal()).toMatchObject({ text: '', is_segment: false });
  });

  it('🔴 PAIRED — the same run still answers STT_NETWORK_DROP for the network', async () => {
    // Two questions, two codes. The ladder still says WHY the session died; the
    // new code says WHERE THE WORDS WENT. If this row ever goes green by the new
    // sentence REPLACING the old one, the ambiguity was moved, not removed.
    const engines = exhaustingEngines();
    const rig = harness(engines);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitDrop();
    await drain();
    rig.speak(5);
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000);
    await rig.orch.stop();

    const drop = rig.errorFor('STT_NETWORK_DROP');
    expect(drop).not.toBeUndefined();
    expect(drop!.retryable).toBe(false);
    expect(ERROR_CODES.STT_NETWORK_DROP.zh_CN).toBe('网络中断，识别会话终止。');
    expect((rig.events['engine-status'].at(-1) as { status: string }).status).toBe('failed');
    expect(rig.codes()).toEqual(['STT_NETWORK_DROP', 'STT_NO_ENGINE_REACHED']);
  });

  it('🔴 PAIRED — a PARTIAL outage keeps STT_NETWORK_DROP and gets NO new sentence', async () => {
    // The `stt-outage-loss.test.ts` CASE 2 shape: the engine heard and finalised
    // the first span, then died. 「这段录音没有到达任何识别引擎，没有转成文字」 would
    // be FALSE here and 「请重新说一次」 is the wrong advice for someone holding
    // half a transcript. That half stays open (book 15 §6 G-23) rather than being
    // answered with a sentence that does not fit it.
    const engines = exhaustingEngines();
    const rig = harness(engines);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(3);
    engines[0]!.emitFinal('前半句');
    engines[0]!.emitDrop();
    await drain();
    rig.speak(5);                    // spoken into the dead engine — really lost
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000);
    await rig.orch.stop();

    expect(engines[0]!.pushes).toBe(3); // positive control: it really did hear some
    expect(rig.codes()).toContain('STT_NETWORK_DROP');
    expect(rig.codes()).not.toContain('STT_NO_ENGINE_REACHED');
    // RT3-B unchanged: the held transcript still leaves on the terminal final.
    expect(rig.lastFinal().text).toBe('前半句');
  });

  it('🔴 PAIRED — the COLD OPEN still answers STT_NETWORK_DROP', async () => {
    // Nothing has been captured yet (the `audio:start` ack fails), so 「where did what I said
    // go」 has not been asked. The engine could not be reached, which is what
    // the old sentence has always said.
    //
    // ENG-2 (fix-029) SPLIT this row rather than deleting it: the site is no
    // longer untouched (STT_NETWORK_DROP became the FALLBACK there), but THIS
    // shape — a bare Error with no engine-named code — must keep the network
    // sentence, and this row is what pins that. The named-code half lives in
    // the 「ENG-2」 describe below.
    const a = new FakeEngine();
    a.failOpen = true;
    const rig = harness([a]);
    await expect(rig.orch.start({ language: 'zh', mode: 'realtime' })).rejects.toThrow(/open failed/);
    expect(rig.codes()).toEqual(['STT_NETWORK_DROP']);
  });

  it('🔴 a reconnect that HANGS — the shape that used to say nothing at all', async () => {
    // CASE 4: the vendor accepts the socket and never completes the handshake.
    // The ladder is stuck inside attempt 1, so it never reaches its own terminal
    // verdict; nothing was fed, so the flush-cap guard cannot fire either. Before
    // this card the user got an empty final and NOT ONE WORD about it.
    const a = new FakeEngine();
    const b = new FakeEngine();
    b.hangOpen = true;
    const rig = harness([a, b]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    a.emitDrop();
    await drain();
    await rig.clock.advance(1_000);  // rung 1 spawns b, whose open() never returns
    rig.speak(4);
    await rig.orch.stop();

    expect(b.pushes).toBe(0);        // an engine we hold and can never feed
    // 🔴 The ladder never gave up, so it never spoke. This row is what proves the
    // new code is not a rename of the old one: here it is the ONLY sentence.
    expect(rig.codes()).toEqual(['STT_NO_ENGINE_REACHED']);
    expect(rig.errorFor('STT_NO_ENGINE_REACHED')!.message).toContain(`${4 * CHUNK_BYTES} bytes`);
    expect(rig.lastFinal()).toMatchObject({ text: '', is_segment: false });
  });
});

describe('ENG-2 (fix-029): a NAMED engine code survives the cold open — STT_NETWORK_DROP is the fallback only', () => {
  // The P0 「LAN empty transcript」 honesty break, server half. sherpa-local's
  // open() throws a deliberate SttEngineError('STT_CONFIG_MISSING', …) when the
  // addon/model is missing (a PACKAGING problem); the cold-open catch used to
  // rewrite it to STT_NETWORK_DROP, sending the operator to check a network
  // that works. Each direction is pinned by its own row, because narrowing a
  // rewrite and MOVING it look identical from the new code's side (the same
  // argument this file's header already makes about pairing).
  //
  // REVERSE CONTROL — RUN and SAW RED (2026-08-11, machine dev-pc-b).
  // The cold-open emit was reverted to the old literal
  // `{ code: 'STT_NETWORK_DROP', … }` in place of `coldOpenErrorVerdict(err)`:
  // 1 red, 11 green, verbatim:
  //   × the ENGINE's STT_CONFIG_MISSING keeps its code AND its message
  //       expected [ 'STT_NETWORK_DROP' ] to deeply equal [ 'STT_CONFIG_MISSING' ]
  // — the red IS the flattening this card removes. Every STT_NETWORK_DROP row
  // (cold open, connect refusal, engine-named drop, all G-23 rows) stayed
  // green, which is what proves the change narrows the rewrite instead of
  // moving it. Restored afterwards; residual `REVERSE-CONTROL` grep = 0.

  it('🔴 the ENGINE\'s STT_CONFIG_MISSING keeps its code AND its message', async () => {
    const a = new FakeEngine();
    a.failOpenWith = new SttEngineError(
      'STT_CONFIG_MISSING',
      "sherpa-local open failed: Cannot find module 'sherpa-onnx-node'",
      false,
    );
    const rig = harness([a]);
    await expect(rig.orch.start({ language: 'zh', mode: 'realtime' })).rejects.toThrow(/sherpa-onnx-node/);
    expect(rig.codes()).toEqual(['STT_CONFIG_MISSING']);
    const err = rig.errorFor('STT_CONFIG_MISSING')!;
    // The message is the actionable half — it names the missing module. A code
    // that survives while its message is replaced would still strand the
    // operator one hop from the answer.
    expect(err.message).toContain("Cannot find module 'sherpa-onnx-node'");
    // The cold open failing is terminal for this run (start() re-throws, the
    // ack fails) — retryable stays false exactly as the old literal was.
    expect(err.retryable).toBe(false);
    expect((rig.events['engine-status'].at(-1) as { status: string }).status).toBe('failed');
    // The registered sentence this code carries must fit a missing engine —
    // that it already does is WHY no new code was minted (owner gate).
    expect(ERROR_CODES.STT_CONFIG_MISSING.en).toBe('No STT engine configured for this language.');
  });

  it('🔴 PAIRED — a connect refusal to a REMOTE engine host is STILL STT_NETWORK_DROP', async () => {
    // The other direction: a bare connect Error carries no engine-named code,
    // and reclassifying it toward config would be the same lie mirrored. The
    // message still rides the frame — the fallback names the code, it does not
    // eat the evidence.
    const a = new FakeEngine();
    a.failOpenWith = new Error('connect ECONNREFUSED 100.64.7.68:10095');
    const rig = harness([a]);
    await expect(rig.orch.start({ language: 'zh', mode: 'realtime' })).rejects.toThrow(/ECONNREFUSED/);
    expect(rig.codes()).toEqual(['STT_NETWORK_DROP']);
    expect(rig.errorFor('STT_NETWORK_DROP')!.message).toContain('ECONNREFUSED');
    expect(rig.errorFor('STT_NETWORK_DROP')!.retryable).toBe(false);
  });

  it('an engine-NAMED network drop keeps its code and the frame stays terminal', async () => {
    // sherpa's model DOWNLOAD failure throws SttEngineError('STT_NETWORK_DROP',
    // …, retryable:true). The code survives unchanged (it was already the
    // network sentence); `retryable` on the FRAME stays false because this
    // frame reports the RUN ending, not whether the error could recur better —
    // two questions, kept apart (one value answers one question).
    const a = new FakeEngine();
    a.failOpenWith = new SttEngineError('STT_NETWORK_DROP', 'sherpa-local open failed: tarball fetch ETIMEDOUT', true);
    const rig = harness([a]);
    await expect(rig.orch.start({ language: 'zh', mode: 'realtime' })).rejects.toThrow(/ETIMEDOUT/);
    expect(rig.codes()).toEqual(['STT_NETWORK_DROP']);
    expect(rig.errorFor('STT_NETWORK_DROP')!.retryable).toBe(false);
  });
});

describe('G-23 positive controls — 「I cannot tell」 must not become either answer', () => {
  it('a rollover whose LAST leg heard nothing is NOT called unheard', async () => {
    // 🔴 THE NARROWING, isolated. Segment 0 was transcribed and delivered; the
    // rollover then opened a fresh leg that was handed nothing, so the PER-LEG
    // counter is zero at the terminal final while the recording plainly reached
    // an engine. Reading the per-leg number here would tell a user holding a
    // full transcript that their recording reached no engine and they should say
    // it again — a false alarm strictly worse than the silence being fixed.
    const a = new FakeEngine();
    const b = new FakeEngine();
    const rig = harness([a, b]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(2);
    a.emitFinal('第一段');
    await rig.clock.advance(30_000); // soft-segment boundary: flush a, open b
    await rig.orch.stop();           // b was never fed a chunk

    expect(a.pushes).toBe(2);
    expect(b.pushes).toBe(0);
    expect((rig.events.final[0] as { text: string; is_segment: boolean })).toMatchObject({ text: '第一段', is_segment: true });
    expect(rig.codes()).not.toContain('STT_NO_ENGINE_REACHED');
  });

  it('the gate refused everything ⇒ silence is the correct answer', async () => {
    // Nothing the gate accepted means nothing worth transcribing. Saying 「这段
    // 录音没有到达任何识别引擎」 here would be a lie in the other direction — the
    // same argument the flush-cap guard's third condition already makes.
    const engines = exhaustingEngines();
    const rig = harness(engines, { shouldFeedEngine: () => false });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitDrop();
    await drain();
    rig.speak(5);
    for (let n = 0; n < 4; n++) await rig.clock.advance(1_000);
    await rig.orch.stop();

    expect(rig.codes()).toContain('STT_NETWORK_DROP');   // the network still answers
    expect(rig.codes()).not.toContain('STT_NO_ENGINE_REACHED');
  });

  it('a healthy recording says nothing new', async () => {
    const a = new FakeEngine();
    const rig = harness([a]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(3);
    a.finalOnFlush = '大家好，欢迎使用';
    await rig.orch.stop();

    expect(rig.events.error).toEqual([]);
    expect(rig.lastFinal().text).toBe('大家好，欢迎使用');
  });

  it('the flush-cap guard and this one can never both fire (L9 shape)', async () => {
    // Audio WAS fed and the engine never finished ⇒ `STT_ENGINE_TIMEOUT`, which
    // is a statement about the ENGINE. Per-leg bytes are a subset of session
    // bytes, so the two conditions are mutually exclusive by construction; this
    // row is that argument, run.
    const a = new FakeEngine();
    const rig = harness([a]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(1);
    a.flush = (): Promise<void> => new Promise<void>(() => { /* never settles */ });
    const stopped = rig.orch.stop();
    await rig.clock.advance(1_000);  // the flush cap
    await stopped;

    expect(rig.codes()).toEqual(['STT_ENGINE_TIMEOUT']);
    expect(rig.lastFinal().text).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Card ENG-4 (2026-08-15) — the same code arriving from BELOW, about a recording
// that had nothing in it.
//
// THE ACCOUNT is a production trace, not a hypothesis 〔measured 2026-08-15
// 15:49 CST, tablet TB335ZC on the cloud relay, machine dev-pc-a〕: a held
// button in a quiet room ⇒ `audio intake {audioMs:5280, voicedMs:0}`, Soniox
// answers `invalid_request / "No audio received."`, and the phone shows 「这段录音
// 没有到达任何识别引擎……请检查识别引擎设置」. Every clause is wrong: the engine
// answered, nothing was lost, and on the managed route there are no engine
// settings. The user reads that as 「云端连不上 STT」 — which is exactly how it
// was reported.
//
// 🔴 REVERSE CONTROL, RUN 〔2026-08-15, machine dev-pc-a〕. `vendorNoAudioIsOurSilence`
// was made to `return false` in place — i.e. the pre-fix behaviour, where the
// refusal always went out — and this file was re-run: **1 failed | 14 passed**,
// the one red being
//     × 🔴 our gate accepted nothing ⇒ the refusal never reaches the wire, and
//       the empty final still does
// The two PAIRED rows stayed green, which is the half that matters as much: the
// change removes exactly one sentence, in exactly one shape, and adds none.
// Restored from a byte-level backup; `REVERSE-CONTROL-ENG4` greps to 0.
describe('ENG-4: a vendor "no audio" refusal about OUR silence is not said to the user', () => {
  const noAudio = (): SttEngineError => new SttEngineError(
    'STT_NO_ENGINE_REACHED',
    '[invalid_request] No audio received.',
    false,
  );

  it('🔴 our gate accepted nothing ⇒ the refusal never reaches the wire, and the empty final still does', async () => {
    const a = new FakeEngine();
    // `shouldFeedEngine: () => false` IS the production condition, not a stand-in:
    // it is the same predicate the feed site consults, and voicedMs:0 means it
    // answered false for every chunk of that recording.
    const rig = harness([a], { shouldFeedEngine: () => false });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(5);
    a.emitNamed(noAudio());
    await drain();
    await rig.orch.stop();

    expect(rig.codes()).not.toContain('STT_NO_ENGINE_REACHED');
    // 🔴 NOT the same as 「nothing happened」: it was routed away, and this is
    // what the server log line hangs off. Suppressed ≠ dropped.
    expect(rig.events['error-suppressed']).toHaveLength(1);
    expect((rig.events['error-suppressed'][0] as { message: string }).message)
      .toContain('No audio received.');
    // 🔴 AND THE USER IS NOT LEFT WITH SILENCE — the banned direction. The empty
    // terminal final is what makes the phone say 「没有听到语音，请靠近麦克风再说
    // 一次」 (SttStallReason.emptyTranscript). Without this assertion the change
    // would be indistinguishable from swallowing the failure.
    expect(rig.lastFinal().text).toBe('');
    expect(rig.lastFinal().is_segment).toBe(false);
  });

  it('🔴 PAIRED — speech DID pass the gate and still reached no engine ⇒ the code goes out unchanged', async () => {
    // The case the code was registered for. If this row ever goes green by
    // accident the narrowing has become a mute button.
    const a = new FakeEngine();
    const rig = harness([a]);
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(5);
    a.emitNamed(noAudio());
    await drain();
    await rig.orch.stop();

    expect(rig.codes()).toContain('STT_NO_ENGINE_REACHED');
    expect(rig.events['error-suppressed']).toHaveLength(0);
    expect(rig.errorFor('STT_NO_ENGINE_REACHED')!.message).toContain('No audio received.');
  });

  it('PAIRED — a DIFFERENT permanent code over the same silence is untouched', async () => {
    // Positive control on the narrowing itself: the condition is not 「we heard
    // nothing, so say nothing」. An engine that cannot open still has to be
    // reported, silence or not.
    const a = new FakeEngine();
    const rig = harness([a], { shouldFeedEngine: () => false });
    await rig.orch.start({ language: 'zh', mode: 'realtime' });
    rig.speak(5);
    a.emitNamed(new SttEngineError('STT_CONFIG_MISSING', 'model files missing', false));
    await drain();
    await rig.orch.stop();

    expect(rig.codes()).toContain('STT_CONFIG_MISSING');
    expect(rig.events['error-suppressed']).toHaveLength(0);
  });
});

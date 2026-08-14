// REQ-12-05 / A3-1 — THE SEAM: does the text on the phone GROW while the button
// is held on the LAN leg?
//
// SPEC-REF:
//   docs/strategy/2026-08-12-req1205-interim-streaming-analysis.md §2 / §2.5
//   docs/strategy/2026-08-12-req1205-retest-sheet-round2.md
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (interim = offlineAccum + onlineDraft)
//
// ── WHY THIS FILE EXISTS NEXT TO sherpa-preview.test.ts ──────────────────────
// That file tests the preview POLICY through the policy object. It was 16/16
// green while the LAN leg shipped a preview that emitted ONE interim of ONE
// character per hold and then went quiet for the rest of the utterance —
// measured on a real device. Both defects behind that (see sherpa-preview.ts's
// header ① and ②) were INVISIBLE there because the rig fed the decoder a
// hand-tuned `intervalMs` and a decode that cost 0 ms, i.e. it drove the
// decoder past exactly the two conditions that break in production:
//   ① production runs at the DEFAULT interval with 200 ms chunks;
//   ② production's first decode pays the model's one-time initialisation.
// 🔴 rule: a test that supplies its own timings tests the policy, not the product.
// This file supplies production's.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
// REAL: `SherpaLocalEngine` (its own push/flush/decodeSpan/preview wiring),
//   `SherpaPreviewDecoder` at its DEFAULT interval/budget/tail settings,
//   `VadGate`, `SttEngineOrchestrator` (so `mergeOnlineDraft` really runs),
//   `AudioSession`, and `makeSttEmitter` (so the forensic instrument really runs).
// NOT REAL: the sherpa-onnx native recognizer — 228 MB of model that is not in
//   the repo and an addon that is not installed in CI. `FakeRecognizer` below
//   stands in for it, and it is built to model the ONE property this card turns
//   on: a recognizer transcribes THE AUDIO IT WAS HANDED, so more audio ⇒ more
//   characters. It reads the chunk indices back out of the PCM to do it, which
//   is why every assertion below can name WHICH audio produced a preview.
// NOT PROVEN: that a phone paints any of this, and what a decode really costs on
//   any particular CPU. Both are device-line's (retest sheet round 2).

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import type { RoomStore } from '../src/room/store';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { SherpaLocalEngine, type OfflineRecognizer, type OfflineStream } from '../src/stt/engines/sherpa-local';
import { makeSttEmitter } from '../src/engine/stt-factory';
import { log } from '../src/log';

/* ── production's audio shape ─────────────────────────────────────────────── */
// Device-line's own intake line for the utterance this card is about:
//   audio intake {"chunks":38,"bytes":238080,"peak":12133,"audioMs":7440,…}
// 238080/38 = 6265 ≈ 6400 ⇒ 200 ms chunks. Not a chosen number.
const CHUNK_MS = 200;
const CHUNK_BYTES = 6_400;
const SAMPLES_PER_CHUNK = CHUNK_BYTES / 2;

/** Amplitude base for a voiced chunk. The chunk's index rides on top of it so
 *  the fake recognizer can tell WHICH audio it was given; 8000 is ~-12 dBFS,
 *  far above the VAD's -45 dB threshold, and the device measured peak 12133. */
const VOICED_BASE = 8_000;

/** One character per voiced chunk — the fake recognizer's whole vocabulary. */
const SCRIPT = '跟你说个事明天下午三点在会议室开会麻烦提前十分钟到场带上上次那份材料谢谢';

function voicedChunk(idx: number): Buffer {
  const b = Buffer.alloc(CHUNK_BYTES);
  const amp = VOICED_BASE + idx;
  for (let i = 0; i < SAMPLES_PER_CHUNK; i += 1) b.writeInt16LE(i % 2 === 0 ? amp : -amp, i * 2);
  return b;
}
const silentChunk = (): Buffer => Buffer.alloc(CHUNK_BYTES);

/**
 * Stands in for sherpa's `OfflineRecognizer`.
 *
 * `getResult` recovers each 200 ms frame's amplitude, maps it back to the chunk
 * index that produced it, and returns those characters of SCRIPT. Silence
 * contributes nothing, which is what SenseVoice does with silence. So the text
 * is a function of the SPAN, exactly as the real one's is — a fake that returned
 * a longer string every call would make every assertion here vacuous.
 *
 * `decode()` is where the cost lives: it is the synchronous native call, so it
 * advances the (spied) clock. `warmupMs` is charged once — the ONNX arena,
 * thread pool and first graph run that any model pays on its first inference.
 */
class FakeRecognizer implements OfflineRecognizer {
  decodes = 0;
  readonly spans: string[] = [];
  constructor(
    private readonly clock: { ms: number },
    private readonly warmupMs: number,
    private readonly steadyMs: number,
  ) {}

  createStream(): OfflineStream {
    const samples: Float32Array[] = [];
    return {
      acceptWaveform: (w: { sampleRate: number; samples: Float32Array }): void => { samples.push(w.samples); },
      // Carried on the stream object the way the native one carries its state.
      __samples: samples,
    } as unknown as OfflineStream;
  }

  decode(_stream: OfflineStream): void {
    this.decodes += 1;
    this.clock.ms += this.decodes === 1 ? this.warmupMs : this.steadyMs;
  }

  /** The chunk indices carried by the span this stream was handed, in order.
   *  Split out (identical behaviour) so a recognizer that PUNCTUATES can reuse
   *  the same 「text is a function of the span」 property instead of inventing a
   *  second, weaker one. */
  protected indicesOf(stream: OfflineStream): number[] {
    const parts = (stream as unknown as { __samples: Float32Array[] }).__samples;
    const all = parts[0] ?? new Float32Array(0);
    const out: number[] = [];
    for (let off = 0; off + SAMPLES_PER_CHUNK <= all.length; off += SAMPLES_PER_CHUNK) {
      const amp = Math.round(Math.abs(all[off] ?? 0) * 32768);
      if (amp === 0) continue; // silence
      out.push(amp - VOICED_BASE);
    }
    return out;
  }

  getResult(stream: OfflineStream): { text?: string } {
    let text = '';
    for (const idx of this.indicesOf(stream)) text += SCRIPT[idx] ?? '?';
    this.spans.push(text);
    return { text };
  }
}

/** Characters per clause in {@link PunctuatingRecognizer}. */
const CLAUSE_CHARS = 6;

/**
 * 🔴 INT-2 — the SAME contract as {@link FakeRecognizer} (text is a function of
 * the span it was handed) plus the ONE property real SenseVoice has and that
 * fake does not: IT PUNCTUATES, and the punctuation is a function of the WHOLE
 * span.
 *
 * The consequence is the entire defect. A clause that ended a sentence stops
 * ending it the moment more speech follows, so re-decoding a LONGER tail does
 * not produce an EXTENSION of the previous hypothesis — it produces a REVISION
 * whose difference sits in the MIDDLE of the string:
 *
 *   span of  4 chunks → 「跟你说个。」
 *   span of  7 chunks → 「跟你说个事明，天。」   ← the 。 became a ，
 *
 * `FakeRecognizer` can never produce that shape (every longer span strictly
 * extends the shorter one, so `next.startsWith(draft)` always holds and the
 * merge's first branch answers), which is precisely why the seam suite above
 * was green while the device line watched a single sentence render twice.
 * ⇒ rule: a fake that can only produce the easy shape tests the easy shape.
 */
class PunctuatingRecognizer extends FakeRecognizer {
  override getResult(stream: OfflineStream): { text?: string } {
    const idx = this.indicesOf(stream);
    let text = '';
    for (let i = 0; i < idx.length; i += 1) {
      text += SCRIPT[idx[i] as number] ?? '?';
      const last = i === idx.length - 1;
      if (last) text += '。';
      else if ((i + 1) % CLAUSE_CHARS === 0) text += '，';
    }
    this.spans.push(text);
    return { text };
  }
}

interface Rig {
  frames: Array<{ event: string; text: string }>;
  interims: string[];
  finals: string[];
  rec: FakeRecognizer;
  /** Resolves once the engine is open — feeding before it is fed to nobody. */
  ready: Promise<void>;
  /** Feed one chunk and let 200 ms of wall time pass, as real audio does. */
  feed(chunk: Buffer): void;
  release(): Promise<void>;
}

function rig(opts: { warmupMs?: number; steadyMs?: number; punctuating?: boolean } = {}): Rig {
  const clock = { ms: 1_700_000_000_000 };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.ms);
  const Rec = opts.punctuating === true ? PunctuatingRecognizer : FakeRecognizer;
  const rec = new Rec(clock, opts.warmupMs ?? 900, opts.steadyMs ?? 120);

  const engine = new SherpaLocalEngine(
    { id: 'sherpa-local', language: 'zh', sample_rate: 16_000 },
    { openRecognizer: (): Promise<OfflineRecognizer> => Promise.resolve(rec) },
  );
  const session = new AudioSession({ hardLimitMs: 600_000 });
  session.start();
  const orch = new SttEngineOrchestrator(session, () => engine, {
    softSegmentMs: 600_000, // no rollover inside a 10 s utterance
    engineFlushTimeoutMs: 3_000,
  });

  const frames: Array<{ event: string; text: string }> = [];
  const socket = { emit: (event: string, p: unknown): void => { frames.push({ event, text: String((p as { text?: unknown }).text ?? '') }); } };
  const emitter = makeSttEmitter({
    resolveSocket: () => socket as unknown as Pick<Socket, 'emit'>,
    store: { getPc: () => undefined } as unknown as Pick<RoomStore<Socket>, 'getPc'>,
    roomUuid: 'room-req1205',
    delivery: 'inject',
  });

  // MIRROR of `engine/stt-session.ts` `wireEvents()` lines 120-125 / 169 — the
  // two lines that put an orchestrator event on the wire. Mirrored and not
  // driven through `SttSessionBridge` because that class also wants an LLM
  // config, a polish leg, a quota guard and a usage sink, none of which this
  // card touches. ⚠️ Mirrored code is a copy that can rot: what it must keep
  // faithful is only that the interim's `text` reaches the emitter unchanged.
  const interims: string[] = [];
  const finals: string[] = [];
  orch.on('interim', (e: { text?: unknown; segment_idx?: unknown }) => {
    interims.push(String(e.text ?? ''));
    emitter.emit('stt:interim', { text: String(e.text ?? ''), confidence: 1, language: 'zh', segment_idx: e.segment_idx ?? 0 });
  });
  orch.on('final', (e: { text?: unknown }) => {
    finals.push(String(e.text ?? ''));
    emitter.emit('stt:final', { text: String(e.text ?? ''), confidence: 1, language: 'zh', segment_idx: 0, is_segment: false });
  });

  let seq = 0;
  const started = orch.start({ language: 'zh', mode: 'realtime' });
  return {
    frames, interims, finals, rec,
    ready: started,
    feed(chunk: Buffer): void {
      orch.pushChunk({ seq: seq++, ts_ms: seq * CHUNK_MS, payload: chunk });
      clock.ms += CHUNK_MS;
    },
    async release(): Promise<void> { await orch.stop(); },
  };
}

/** Hold the button for `voiced` 200 ms chunks, with an optional pause. */
async function hold(r: Rig, voiced: number, pauseAfter?: number): Promise<void> {
  await r.ready; // the engine is installed and open before any audio is fed
  for (let i = 0; i < voiced; i += 1) {
    r.feed(voicedChunk(i));
    if (pauseAfter !== undefined && i === pauseAfter) for (let s = 0; s < 4; s += 1) r.feed(silentChunk());
  }
  await r.release();
}

afterEach(() => { vi.restoreAllMocks(); });

describe('REQ-12-05 — while the button is held, the visible text grows', () => {
  it('emits a SEQUENCE of interims whose text strictly grows and never rewrites its prefix', async () => {
    const r = rig();
    await hold(r, 20);

    // 🔴 THE REQUIREMENT. Owner's words: while holding to speak, the user must see the characters grow. One frame is
    // not a sequence, and this is the assertion the shipped code fails: it
    // emitted exactly one interim of one character.
    expect(r.interims.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < r.interims.length; i += 1) {
      const prev = r.interims[i - 1] as string;
      const cur = r.interims[i] as string;
      expect(cur.length).toBeGreaterThan(prev.length);
      // Growth is not enough: 「明天下午」→「下午三点」 grows and is still a
      // rewrite. What the user must see is the text they already read, plus more.
      expect(cur.startsWith(prev)).toBe(true);
    }

    // The first thing shown is a phrase, not a sliver. 1 char = the shipped
    // defect's signature (a 200 ms tail handed to the recognizer).
    expect((r.interims[0] as string).length).toBeGreaterThan(1);

    // H3 (the registered risk in the analysis §2.5): `mergeOnlineDraft` sits
    // between the engine and the wire and has a documented APPEND branch that
    // once tripled a sentence. Cumulative previews must fold to themselves.
    const last = r.interims.at(-1) as string;
    expect(last).toBe(SCRIPT.slice(0, last.length));

    // …and every one of them reached the wire, unchanged.
    const wire = r.frames.filter((f) => f.event === 'stt:interim').map((f) => f.text);
    expect(wire).toEqual(r.interims);
  });

  it('the terminal transcript is still the whole utterance decoded from scratch', async () => {
    const r = rig();
    await hold(r, 20);
    // 🔴 The red line of the whole enhancement: previews may be late, wrong or
    // absent, but the FINAL is the sentence the user gets. 20 voiced chunks ⇒
    // 20 characters, assembled by nobody's preview.
    expect(r.finals.at(-1)).toBe(SCRIPT.slice(0, 20));
  });

  it('a pause freezes the prefix — the words already read stay put', async () => {
    const r = rig();
    await hold(r, 20, 7); // 4 silent chunks (800 ms > 300 ms hangover) after #7
    expect(r.interims.length).toBeGreaterThanOrEqual(4);
    // The freeze is the mechanism that keeps this linear; if it committed the
    // wrong span the chain below breaks even though the text still grows.
    for (let i = 1; i < r.interims.length; i += 1) {
      expect((r.interims[i] as string).startsWith(r.interims[i - 1] as string)).toBe(true);
    }
    expect(r.finals.at(-1)).toBe(SCRIPT.slice(0, 20));
  });
});

describe('REQ-12-05 — the self-limiting budget judges the steady state, not the warm-up', () => {
  it('one slow first decode does NOT silence the rest of the hold', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // 900 ms warm-up against a 300 ms budget: three times over, on the decode
    // that by construction can never repeat. This is the shipped behaviour that
    // produced 「one interim, then nothing」.
    const r = rig({ warmupMs: 900, steadyMs: 40 });
    await hold(r, 20);
    expect(r.interims.length).toBeGreaterThanOrEqual(4);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('live preview disabled'))).toHaveLength(0);
  });

  it('a genuinely slow machine still stands down, and says so with its numbers', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    // Every decode over budget — not a warm-up, a machine that cannot keep up.
    const r = rig({ warmupMs: 900, steadyMs: 900 });
    await hold(r, 20);
    // Exactly two PREVIEW decodes are paid for (the strike count) and then the
    // loop is left alone. (`rec.decodes` is 3: the third is flush's terminal
    // decode, which is not a preview and is never suppressed.)
    const cost = info.mock.calls.filter((c) => String(c[0]).includes('preview cost'));
    expect(cost[0]?.[1]).toMatchObject({ decodes: 2, overBudget: 2, disabled: 'slow_decode' });
    expect(r.rec.decodes).toBe(3);
    const disabled = warn.mock.calls.filter((c) => String(c[0]).includes('live preview disabled'));
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.[1]).toMatchObject({ reason: 'slow_decode', budgetMs: 300, strikes: 2 });
    // 🔴 The failure direction stays safe: standing down returns the LAN leg to
    // the status quo (no interim), never to a worse state — the final is untouched.
    expect(r.finals.at(-1)).toBe(SCRIPT.slice(0, 20));
  });
});

describe('🔴 INT-2 — one sentence said once must not reach the phone twice', () => {
  // ── THE DEVICE-LINE EVIDENCE THIS BLOCK ENCODES ───────────────────────────
  // scratch/r7-req1205-round2-2026-08-12.md §2-2, run C — the CLEANEST input on
  // the sheet: a single, non-repeating 5 s sentence, played ONCE. On screen:
  //     转录中 3s · 16 字
  //     跟你说个事啊。跟你说个事啊，明天下午。
  // The sentence is ~13 characters and 「跟你说个事啊」 is on the screen twice.
  //
  // 🔴 The responsibility face is PINNED, not guessed: the SERVER's own
  // instrument reported `utterance summary {"last_chars":34}` — 34 characters
  // for a 13-character sentence — so the concatenation had already happened
  // BEFORE the frame left this process. The phone only painted it. Run B is the
  // same shape at a larger size (~26 chars of audio ⇒ `last_chars` 173).
  //
  // ⚠️ Runs A/B used double-played audio, so their doubled TEXT was legitimate
  // input; run C exists precisely to close that escape route, and so does the
  // second test below, which is its positive control.

  it('a mid-string revision of the cumulative preview REPLACES — the phone never sees the opening twice', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const r = rig({ punctuating: true, warmupMs: 120, steadyMs: 120 });
    await hold(r, 16);

    expect(r.interims.length).toBeGreaterThanOrEqual(3);
    const last = r.interims.at(-1) as string;

    // 🔴 THE INVARIANT, stated as the assertion. Every preview this engine emits
    // is the WHOLE utterance-so-far as the recognizer currently believes it
    // (sherpa-preview.ts returns `joinPreviewSpans(committed, tailDecode)`), so
    // whatever reaches the wire must be a hypothesis the recognizer ACTUALLY
    // PRODUCED — never two of them glued together. `rec.spans` is the record of
    // what it produced.
    expect(r.rec.spans).toContain(last);

    // …and the user-visible form of the same fact: the opening clause was
    // spoken once, so it appears once. (Two assertions on purpose: they are the
    // same fact only while the code is right, and this is the one a user
    // complains about.)
    expect(last.split('跟你说个').length - 1).toBe(1);

    // The prefix-stability property round 2 verified green must survive the fix:
    // the words already read stay put, they are only ever extended or
    // re-punctuated in place — never rewritten from the front.
    expect(last.startsWith('跟你说个')).toBe(true);

    // 🔴 THE DEVICE LINE'S OWN INSTRUMENT, asserted in the same units it reads.
    // `last_chars:34` for a 13-character sentence was the reading that pinned
    // this defect to the server; the summary must now agree with the recognizer.
    const summary = info.mock.calls.filter((c) => String(c[0]).includes('utterance summary'));
    expect(summary).toHaveLength(1);
    expect(summary[0]?.[1]).toMatchObject({ last_chars: last.length });

    // The terminal transcript was never part of this defect and must stay out of
    // it: flush decodes the whole utterance from scratch (16 voiced chunks).
    // Compared with this recognizer's punctuation removed, because punctuation
    // is the very thing it varies — what must be intact is the SPEECH.
    const final = r.finals.at(-1) as string;
    expect(final.replace(/[，。]/gu, '')).toBe(SCRIPT.slice(0, 16));
    expect(final.split('跟你说个').length - 1).toBe(1);
  });

  it('🔴 POSITIVE CONTROL: a sentence genuinely SAID TWICE still arrives twice', async () => {
    // The danger of every de-duplicating fix. Runs A/B on the sheet played the
    // same sentence twice on purpose, and their doubled text was CORRECT input —
    // a fix that cannot tell run A from run C has replaced a visible defect with
    // an invisible one (dropped characters, owner's veto).
    //
    // The audio here really does repeat: chunk indices cycle 0..5 twice, so the
    // recognizer — which transcribes what it was handed — produces the clause
    // twice inside ONE hypothesis. Nothing downstream may collapse that.
    const r = rig({ punctuating: true, warmupMs: 120, steadyMs: 120 });
    await r.ready;
    for (let i = 0; i < 12; i += 1) r.feed(voicedChunk(i % CLAUSE_CHARS));
    await r.release();

    const last = r.interims.at(-1) as string;
    expect(r.rec.spans).toContain(last);
    expect(last.split('跟你说个').length - 1).toBe(2);
    // …and the final, which is the sentence the user actually gets.
    expect((r.finals.at(-1) as string).split('跟你说个').length - 1).toBe(2);
  });
});

describe('REQ-12-05 — the instrument can tell 1 interim from 40', () => {
  it('logs a per-utterance count, not just the first frame', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const r = rig();
    await hold(r, 20);

    const first = info.mock.calls.filter((c) => String(c[0]).includes('first frame of this utterance'));
    const summary = info.mock.calls.filter((c) => String(c[0]).includes('utterance summary'));
    // 🔴 The reading device-line came back with was `chars:1` from the FIRST
    // line — which is equally true of 1 interim and of 40. The summary is the
    // line that separates them.
    expect(first).toHaveLength(1);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.[1]).toMatchObject({ interims: r.interims.length });
    expect((summary[0]?.[1] as { interims: number }).interims).toBeGreaterThan(1);

    // …and the cost of the previews on THIS machine leaves the process, so the
    // budget stops being an argument about an estimate.
    const cost = info.mock.calls.filter((c) => String(c[0]).includes('preview cost for this utterance'));
    expect(cost).toHaveLength(1);
    expect(cost[0]?.[1]).toMatchObject({ maxDecodeMs: 900, disabled: null });
    expect((cost[0]?.[1] as { decodes: number }).decodes).toBeGreaterThanOrEqual(4);
    // 🔴 INT-1 — the cost line now carries the TAIL that produced `maxDecodeMs`,
    // so the device line reads this machine's RTF by dividing two fields of one
    // log line. Round 2 could only pair `maxDecodeMs` with the utterance's
    // `audio_ms`, which is not the span any decode was handed.
    expect((cost[0]?.[1] as { maxDecodeTailMs: number }).maxDecodeTailMs).toBeGreaterThan(0);
  });
});

// Card RT-3 — shared harness for the outage/resilience red-line tests.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.3 (reconnect ladder 1/2/4s ×3 → replay
//     the 5s server buffer), §1 (server_replay_buffer_ms 5000)
//   CLAUDE.md red line: no silent failure / owner「dropped characters are a veto」
//
// WHY THIS FILE EXISTS. `test/stt-replay-clock.test.ts` already drives the real
// AudioSession + SttEngineOrchestrator + real ladder with a fake engine, and it
// asserts on WHICH CHUNKS THE ENGINE RECEIVED. That assertion is unarguable but
// it is not the acceptance criterion: owner's red line is about the WORDS THE
// USER GETS BACK. So this harness adds one thing — an engine that turns the
// audio it is handed into TEXT — so an assertion can land on the merged final.
//
// 🔴 THE ENGINE HERE IS A **PERFECT** TRANSCRIBER, ON PURPOSE. It renders exactly
// the chunks it was handed, never mishears, never drops. That is what makes the
// instrument honest: any word missing from the merged final is missing because of
// OUR pipeline, not because a model fumbled it. A "realistic" (lossy) engine would
// make every measurement below unattributable.
//
// ⚠️ WHAT IS MODELLED AND THEREFORE NOT MEASURED. Two vendor behaviours are
// parameters, not facts:
//   · `finalEveryN` — whether the engine emits mid-session offline finals
//     (FunASR 2pass) or only cumulative interims until flush (Soniox). The loss
//     cases are run under BOTH so the result cannot be an artefact of one shape.
//   · `seamPolicy` — whether a vendor's flush final includes audio that arrived
//     DURING the flush round-trip. `orchestrator-core.ts` F-2152 ASSERTS it does
//     not; W2.5-H (segment_buffer.dart) records that as an unverified assumption.
//     Both branches are driven here; neither is a claim about a real vendor.

import { EventEmitter } from 'node:events';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState, InterimShape, SttEngine } from '../../src/stt/engines/base';
import { unexpectedCloseError } from '../../src/stt/engines/base';

/** 200 ms @ 16 kHz mono s16le — the chunk size the phone actually emits. */
export const CHUNK_BYTES = 6_400;
export const CHUNK_MS = 200;
/** Fixed epoch ms; never 0 (a negative cutoff hides a class of boundary bugs). */
export const T0 = 1_754_100_000_000;

// The reconnect path chains several awaits inside ONE timer callback
// (spawnEngine → engine.open() reject → closeEngine → catch → handleEngineError),
// so the drain must outlast that chain or the next rung is scheduled late and
// every timing assertion below drifts. 24 is ~4× the longest observed chain.
const drainTicks = 24;
export const drain = async (): Promise<void> => {
  for (let i = 0; i < drainTicks; i++) await Promise.resolve();
};

/** Copied verbatim from test/stt-replay-clock.test.ts (prefer moving over rewriting) — the same
 *  clock that pinned card M3-4b. Timers fire in due order; microtasks drain after
 *  each one so an `await` inside a timer callback completes before the next. */
export class FakeClock {
  now: number;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  constructor(start: number) { this.now = start; }
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id;
  };
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

/* ────────────────────────────────────────────────────────────────────────────
 * Corpora. One token per 200 ms chunk.
 *
 * ⚠️ THAT MAPPING IS DENSE ON PURPOSE and is the instrument's own unit, not a
 * claim about speech: it makes every lost chunk visible as exactly one lost
 * token. Real speech is sparser (≈ 4–5 CJK syllables/s, ≈ 2.5 English words/s),
 * so the TOKEN counts below are an upper bound on tokens-per-second, while the
 * SECONDS lost — chunks × 200 ms — is the hard number and the one to quote.
 * ────────────────────────────────────────────────────────────────────────── */

export interface Corpus {
  readonly lang: 'zh' | 'en';
  readonly tokens: readonly string[];
  render(seqs: readonly number[]): string;
  /** The text the user actually spoke over seqs [0, n). */
  spoken(n: number): string;
  slice(from: number, toExclusive: number): string;
}

// ⚠️ Tokens are self-delimiting (English ones carry their own trailing space) and
// rendering is a bare join(''). That is deliberate: the pipeline concatenates
// SPANS with no separator (`mergeOverlap` → `accum + next.slice(k)`), so baking
// the space into the token keeps a span boundary readable instead of producing
// 「reportsthen」 and inviting someone to "fix" a harness artefact in production.
function makeCorpus(lang: 'zh' | 'en', tokens: readonly string[]): Corpus {
  const render = (seqs: readonly number[]): string =>
    seqs.map((s) => tokens[s % tokens.length]!).join('');
  return {
    lang, tokens, render,
    spoken: (n) => render(Array.from({ length: n }, (_, i) => i)),
    slice: (a, b) => render(Array.from({ length: b - a }, (_, i) => a + i)),
  };
}

/** 64 distinct CJK syllables — no two adjacent tokens repeat, so a coincidental
 *  suffix/prefix overlap cannot manufacture (or mask) a merge result. */
export const ZH: Corpus = makeCorpus('zh', [
  '今', '天', '的', '会', '议', '我', '们', '决', '定', '把',
  '上', '线', '时', '间', '推', '迟', '到', '下', '周', '三',
  '并', '且', '请', '各', '位', '提', '前', '准', '备', '好',
  '测', '试', '报', '告', '再', '把', '风', '险', '清', '单',
  '发', '给', '客', '户', '确', '认', '一', '遍', '然', '后',
  '安', '排', '一', '次', '联', '调', '演', '练', '别', '忘',
  '记', '录', '结', '论',
]);

/** 64 English tokens, same construction; each carries its own trailing space. */
export const EN: Corpus = makeCorpus('en', [
  'today ', 'the ', 'meeting ', 'agreed ', 'that ', 'we ', 'should ', 'move ', 'launch ', 'back ',
  'until ', 'next ', 'wednesday ', 'and ', 'everyone ', 'must ', 'prepare ', 'their ', 'test ', 'reports ',
  'before ', 'friday ', 'then ', 'send ', 'a ', 'risk ', 'register ', 'over ', 'to ', 'legal ',
  'for ', 'one ', 'more ', 'review ', 'after ', 'which ', 'ops ', 'will ', 'book ', 'an ',
  'integration ', 'rehearsal ', 'window ', 'with ', 'both ', 'vendors ', 'so ', 'nothing ', 'blocks ', 'release ',
  'please ', 'record ', 'every ', 'decision ', 'in ', 'writing ', 'twice ', 'because ', 'memory ', 'fades ',
  'faster ', 'than ', 'anyone ', 'admits ',
]);

/* ────────────────────────────────────────────────────────────────────────── */

export type OpenBehaviour = 'ok' | 'reject' | 'hang';
/** Does the vendor's flush final include audio that arrived DURING the flush? */
export type SeamPolicy = 'vendor-includes-late-audio' | 'vendor-excludes-late-audio';

export interface EngineScript {
  open?: OpenBehaviour;
  /** ms the connect takes before it resolves/rejects, on the FakeClock. This is
   *  the `T` in the reconnect path's real dead time
   *  `1000 + T₁ + 2000 + T₂ + 4000` — unbounded, because `attemptReconnect`
   *  calls `spawnEngine()` WITHOUT `raceSpawnTimeout` (only the cold open in
   *  `start()` has it). A slow connect therefore pushes recovery past the replay
   *  window on the FIRST rung, not the third. */
  openDelayMs?: number;
  /** Emit an engine `final` every N pushes (FunASR 2pass shape). 0 = never
   *  before flush (Soniox shape: one cumulative hypothesis, finalised at flush). */
  finalEveryN?: number;
  /** ms the flush() round-trip takes, on the FakeClock. */
  flushDelayMs?: number;
  seamPolicy?: SeamPolicy;
  /** REQ-14-01: the engine's declared `InterimShape` (base.ts / INT-2). Absent =
   *  undeclared, i.e. the orchestrator keeps guessing with `mergeOnlineDraft` —
   *  which is every engine in this harness before REQ-14-01, so every existing
   *  case is byte-identical with the field unset. Soniox declares 'cumulative'
   *  in production, and only the declared shape is banked across legs. */
  interimShape?: InterimShape;
}

/**
 * A perfect streaming transcriber over the harness corpus.
 *
 * · `push(payload)` decodes the seq from the payload's first two bytes and
 *   appends the corresponding corpus token to what this engine has heard.
 * · `interim` after every push: the whole current hypothesis SINCE THIS ENGINE'S
 *   LAST FINAL. That is Soniox's shape when `finalEveryN = 0` (one span for the
 *   whole session) and FunASR's when it is > 0 (per-VAD-span), so one rule
 *   covers both vendors instead of two divergent fakes.
 * · `final` (mid-session) covers the span since the previous final — NOT
 *   cumulative, which is what `mergeOverlap` is written against.
 * · `flush()` answers after `flushDelayMs`, emitting the final for whatever the
 *   seam policy says it managed to include.
 */
export class TranscribingEngine extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  /** REQ-14-01 — see {@link EngineScript.interimShape}. */
  readonly interimShape: InterimShape | undefined;
  private _state: EngineState = 'closed';
  /** Every seq handed to THIS engine, in order — live pushes AND replay. */
  readonly heard: number[] = [];
  /** Index into `heard`: everything below it is already covered by a final. */
  private finalizedUpTo = 0;
  readonly finalsEmitted: string[] = [];
  private flushStartedAt = -1;

  constructor(
    private readonly corpus: Corpus,
    private readonly clock: FakeClock,
    private readonly script: EngineScript = {},
  ) { super(); this.interimShape = script.interimShape; }

  get state(): EngineState { return this._state; }

  async open(): Promise<void> {
    const b = this.script.open ?? 'ok';
    if (b === 'hang') return new Promise<void>(() => { /* never settles */ });
    const delay = this.script.openDelayMs ?? 0;
    if (delay > 0) await new Promise<void>((res) => { this.clock.setTimeout(() => res(), delay); });
    if (b === 'reject') throw new Error('connect refused');
    this._state = 'open';
  }

  push(chunk: Buffer, _ts_ms: number): void {
    // A VAD-closure silence frame carries no seq (flush-final.ts feeds zeros to
    // funasr/funspeech only, so this engine id never sees one) — guard anyway so
    // a future call site cannot silently inject token 0.
    if (chunk.length !== CHUNK_BYTES) return;
    this.heard.push(chunk.readUInt16LE(0));
    this.emit('interim', {
      kind: 'interim', text: this.hypothesis(), confidence: 0.5, language: this.corpus.lang,
    });
    const n = this.script.finalEveryN ?? 0;
    if (n > 0 && this.heard.length - this.finalizedUpTo >= n) this.emitFinal(this.heard.length);
  }

  async flush(): Promise<void> {
    const atStart = this.heard.length;
    this.flushStartedAt = atStart;
    const delay = this.script.flushDelayMs ?? 0;
    if (delay > 0) {
      await new Promise<void>((res) => { this.clock.setTimeout(() => res(), delay); });
    }
    const policy = this.script.seamPolicy ?? 'vendor-excludes-late-audio';
    this.emitFinal(policy === 'vendor-includes-late-audio' ? this.heard.length : atStart);
  }

  async close(): Promise<void> { this._state = 'closed'; }

  /** One unvoluntary socket drop — the only reason the replay buffer exists. */
  emitDrop(): void { this.emit('error', unexpectedCloseError('harness')); }

  /** Seqs this engine was handed that arrived after its flush was issued. */
  get seamSeqs(): number[] {
    return this.flushStartedAt < 0 ? [] : this.heard.slice(this.flushStartedAt);
  }

  private hypothesis(): string { return this.corpus.render(this.heard.slice(this.finalizedUpTo)); }

  private emitFinal(upTo: number): void {
    if (upTo <= this.finalizedUpTo) return;
    const text = this.corpus.render(this.heard.slice(this.finalizedUpTo, upTo));
    this.finalizedUpTo = upTo;
    this.finalsEmitted.push(text);
    this.emit('final', { kind: 'final', text, confidence: 0.9, language: this.corpus.lang, duration_ms: 0 });
  }
}

export function frame(seq: number): Buffer {
  const b = Buffer.alloc(CHUNK_BYTES);
  b.writeUInt16LE(seq, 0);
  return b;
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface ServerFinal {
  segment_idx: number;
  is_segment: boolean;
  text: string;
}

/** Everything the phone sees on the wire for one utterance, in order. */
export type WireFrame =
  | { kind: 'interim'; segment_idx: number; text: string }
  | { kind: 'final'; segment_idx: number; text: string };

/**
 * THE MERGED FINAL TEXT — the phone's assembly, mirrored line for line from
 * `apps/mobile/lib/src/stt/segment_buffer.dart` (`put` + `joined`).
 *
 * 🔴 THIS MODEL WAS WRONG ON ITS FIRST DRAFT AND THE ERROR WAS THE EXPENSIVE
 * KIND (2026-08-07, RT-3, dev-pc-a). It consumed only `final` frames, so
 * an empty terminal final read as 「the user gets nothing」. The phone does not
 * do that: `put` has an explicit branch — 「finalized=true with empty text and
 * non-empty prior → KEEP prior + lock」 — written precisely so the
 * orchestrator's empty fallback cannot wipe accumulated online text. A model
 * that skips the interims therefore OVERSTATES every loss, and it would have
 * been believed, because it agreed with the code I had just read.
 * ⇒ check your ruler first: the assertion must land on what the PHONE ends up holding, and
 * that is a function of the interim stream as well as the final.
 *
 * The joiner is deliberately omitted (`joined` inserts a CJK-aware one): this
 * returns the raw concatenation so a duplicated span shows up as a duplicated
 * span rather than as a punctuation question.
 */
export class PhoneSegmentBuffer {
  private readonly texts = new Map<number, string>();
  private readonly finalized = new Set<number>();

  put(idx: number, text: string, isFinal: boolean): void {
    if (this.finalized.has(idx)) return;
    const prior = this.texts.get(idx) ?? '';
    if (isFinal) {
      if (text === '' && prior !== '') { this.finalized.add(idx); return; }
      this.texts.set(idx, text); this.finalized.add(idx); return;
    }
    if (prior === '') { if (text !== '') this.texts.set(idx, text); return; }
    if (text === '' || text === prior) return;
    if (prior.startsWith(text)) return;
    this.texts.set(idx, text);
  }

  get joined(): string {
    return [...this.texts.keys()].sort((a, b) => a - b)
      .map((k) => this.texts.get(k) ?? '').filter((t) => t.length > 0).join('');
  }
}

export function mergedFinalText(frames: readonly WireFrame[]): string {
  const buf = new PhoneSegmentBuffer();
  for (const f of frames) buf.put(f.segment_idx, f.text, f.kind === 'final');
  return buf.joined;
}

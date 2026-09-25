// Shared rig for the long-recording silence-arm tests (card RC-E): a Soniox-shaped
// fake leg that turns the chunks it is HANDED into words, with word times.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-D / RC-E blocks)
//   apps/server-core/test/stt-overdue-cut.test.ts (the word model this is lifted from)
//
// The model, and why each part is there:
//   · speech is WORDS with stream times; a leg transcribes a word only if it was
//     handed the chunk holding the word's START and the chunk holding its END — a
//     word missing its onset is DELETED, as Soniox deletes an onset-less syllable
//     (root-cause §3.1, measured). So a lost onset shows up as a missing word;
//   · the energy gate is modelled too: a chunk is 「voice」 only if a word covers at
//     least `GATE_MIN_OVERLAP_MS` of it — an onset in the last 120 ms of a chunk is
//     called silence, which is the E3 shape (「琥珀」 → 「霍」);
//   · interims carry the adapter-internal facts the relay reads (`hypothesis_last_word_ms`,
//     `audio_proc_ms`, vendor 200 ms behind what it was fed), and the final carries
//     `first_word_ms` / `last_word_ms` in the leg's own clock, so the pause account and
//     the word-gap arm run on the same arithmetic as in production;
//   · `finalsOnlyAtFlush` is declared, as the real adapter does (card RC-D);
//   · a leg opens after 50 ms and flushes in `FLUSH_MS`, both on the fake clock.
// Each chunk carries its seq in the first four payload bytes.

import { EventEmitter } from 'node:events';
import type { SttEngine, EngineState } from '../../src/stt/engines/base';

export const CHUNK_MS = 200;
export const CHUNK_BYTES = CHUNK_MS * 32;
export const FLUSH_MS = 400;
export const OPEN_MS = 50;
export const VENDOR_LAG_MS = 200;
export const GATE_MIN_OVERLAP_MS = 150;

export interface Word { i: number; s: number; e: number }

/** Words of `wordMs`, `gapMs` apart, from `fromMs` while they fit before `toMs`. The defaults sit on the
 *  200 ms chunk grid, so the gate never withholds a word's own chunk (a gap chunk is a breath). */
export function words(fromMs: number, toMs: number, firstIndex = 0, wordMs = 400, gapMs = 200): Word[] {
  const out: Word[] = [];
  for (let t = fromMs, i = firstIndex; t + wordMs <= toMs; t += wordMs + gapMs, i++) out.push({ i, s: t, e: t + wordMs });
  return out;
}

export const tok = (w: Word): string => `w${w.i} `;
export const chunkOf = (t: number): number => Math.floor(t / CHUNK_MS);

/** The gate: voice iff some word covers ≥ {@link GATE_MIN_OVERLAP_MS} of the chunk. */
export function gateSaysVoice(ws: readonly Word[], seq: number): boolean {
  const a = seq * CHUNK_MS; const b = a + CHUNK_MS;
  return ws.some((w) => Math.min(b, w.e) - Math.max(a, w.s) >= GATE_MIN_OVERLAP_MS);
}

export interface TimerHost { setTimeout: (fn: () => void, ms: number) => unknown }

export class WordLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  readonly finalsOnlyAtFlush = true as const;
  private _state: EngineState = 'closed';
  readonly seqs: number[] = [];
  constructor(private readonly ws: readonly Word[], private readonly clock: TimerHost) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { await new Promise<void>((r) => { this.clock.setTimeout(r, OPEN_MS); }); this._state = 'open'; }
  /** Where stream time [t] sits in this leg's clock, or null if its chunk was not handed over. */
  private legPos(t: number): number | null {
    const k = this.seqs.indexOf(chunkOf(t));
    return k < 0 ? null : k * CHUNK_MS + (t % CHUNK_MS);
  }
  /** Words this leg heard whole, in its own clock. */
  heardWords(): { w: Word; ls: number; le: number }[] {
    const out: { w: Word; ls: number; le: number }[] = [];
    for (const w of this.ws) {
      const ls = this.legPos(w.s); const le = this.legPos(w.e - 1);
      if (ls !== null && le !== null) out.push({ w, ls, le: le + 1 });
    }
    return out.sort((a, b) => a.ls - b.ls);
  }
  push(chunk: Buffer): void {
    this.seqs.push(chunk.readUInt32LE(0));
    const fed = this.seqs.length * CHUNK_MS;
    const ws = this.heardWords().filter((x) => x.le <= fed);
    if (ws.length === 0) return;
    this.emit('interim', {
      kind: 'interim', confidence: 1, language: 'zh', text: ws.map((x) => tok(x.w)).join(''), finalized_text: '',
      hypothesis_last_word_ms: ws[ws.length - 1]!.le, audio_proc_ms: Math.max(0, fed - VENDOR_LAG_MS),
    });
  }
  /** How many times this leg was asked to flush — one leg, one flush (a second is the hang-up race). */
  flushes = 0;
  async flush(): Promise<void> {
    this.flushes += 1;
    await new Promise<void>((r) => { this.clock.setTimeout(r, FLUSH_MS); });
    const ws = this.heardWords();
    this.emit('final', {
      kind: 'final', text: ws.map((x) => tok(x.w)).join(''), confidence: 1, language: 'zh', duration_ms: 0,
      ...(ws.length > 0 ? { first_word_ms: ws[0]!.ls, last_word_ms: ws[ws.length - 1]!.le } : {}),
    });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

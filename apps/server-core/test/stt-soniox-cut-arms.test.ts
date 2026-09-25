// card RC-4 — a Soniox-shaped session in a room whose floor keeps the VAD gate
// open must still end rows: on a sentence the VENDOR has finalised between
// flushes, and on a 3 s silence its own word timestamps measure.
// ⚠️ 更正（RC-D，2026-09-24）：the first half is withdrawn. Soniox declares
// `finalsOnlyAtFlush`, and for such an engine the sentence arm is closed — its
// finalised prefix trails the audio by 4–5 s, so the cut landed inside the next
// word (book 06 §2 RC-D block; docs/strategy/2026-09-24-cr12e-rerun-root-cause.md
// §2, §7 RC-D). The sentence cases below now assert NO cut, and one more pins the
// other entrance of the same defect: the hang-up bank's own 「。」 at `due`.
// REVERSE CONTROL (card RC-D): restoring `this.offlineAccum + this.legFacts.finalizedText`
// for every engine in `orchestrator-core.ts` `pushChunk` reds the two 🔴 RC-D cases.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-4 block)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §2 (the mechanism: both
//     arms collapse to 「did the gate close」 for Soniox), §5 RC-4
//
// Drives the REAL orchestrator on the chunk path (where every row is cut). The
// engine is a fake with Soniox's two load-bearing shapes: `final` only on our
// flush, and interims that carry the adapter-internal facts the real adapter
// sets (`finalized_text`, `hypothesis_last_word_ms`, `audio_proc_ms`). The gate
// is open for every chunk (`shouldFeedEngine` default), i.e. the CR-12-E rooms.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState, InterimResult } from '../src/stt/engines/base';

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
const drain = async (): Promise<void> => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

const CHUNK_MS = 200;
const CHUNK = Buffer.alloc(CHUNK_MS * 32);

/** What the vendor says after it has been handed `legFedMs` of audio. */
type Script = (legFedMs: number) => Omit<InterimResult, 'kind' | 'confidence' | 'language'> | null;

class SonioxShapedEngine extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  readonly finalsOnlyAtFlush = true as const; // card RC-D — what the real adapter declares
  private _state: EngineState = 'closed';
  private fedMs = 0;
  private lastText = '';
  constructor(private readonly script: Script, private readonly flushText: string) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void {
    this.fedMs += chunk.length / 32;
    const said = this.script(this.fedMs);
    if (said === null) return;
    this.lastText = said.text;
    this.emit('interim', { kind: 'interim', confidence: 1, language: 'zh', ...said });
  }
  async flush(): Promise<void> {
    this.emit('final', { kind: 'final', text: this.flushText || this.lastText, confidence: 1, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

interface FinalEvent { text: string; is_segment: boolean; segment_idx: number; pause_before_ms?: number }

async function run(script: Script, flushText: string, untilMs: number): Promise<FinalEvent[]> {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const orch = new SttEngineOrchestrator(session, () => new SonioxShapedEngine(script, flushText), {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 1_000,
  });
  const finals: FinalEvent[] = [];
  orch.on('final', (f: FinalEvent) => finals.push(f));
  orch.on('error', () => { /* a listener is mandatory on EventEmitter; none is expected */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  for (let seq = 0; seq * CHUNK_MS < untilMs; seq++) {
    orch.pushChunk({ seq, ts_ms: clock.now, payload: CHUNK });
    await clock.advance(CHUNK_MS);
  }
  const rows = finals.filter((f) => f.is_segment);
  await orch.close();
  return rows;
}

describe('RC-D — Soniox (finalsOnlyAtFlush): the sentence arm is closed at the live edge', () => {
  it('🔴 RC-D: continuous speech, the finalised prefix ends on 「。」 past 30 s ⇒ NO cut', async () => {
    // Speaking all along; the vendor has finalised 「…第一件事说完了。」 by 20 s and
    // keeps a provisional tail. RC-4 cut here — at the live edge, i.e. inside the
    // words that followed the 「。」 by the finalisation lag. RC-D does not.
    // ⚠️ 更正（RC-D）：this case asserted one row with RC-4's text; it now asserts none.
    const rows = await run((fed) => ({
      text: fed < 20_000 ? '今天我们先说第一件事' : '今天我们先说第一件事说完了。然后',
      finalized_text: fed < 20_000 ? '今天我们先' : '今天我们先说第一件事说完了。',
      hypothesis_last_word_ms: fed - 300, audio_proc_ms: fed - 200,
    }), '今天我们先说第一件事说完了。然后', 32_000);
    expect(rows).toHaveLength(0);
  });

  it('🔴 RC-D: after a hang-up the bank ends on 「。」 and the new leg has finalised nothing ⇒ NO cut at `due`', async () => {
    // Words until 5 s, a 3.6 s pause (the gate closes; the 3 s idle hang-up banks
    // 「第一句说完了。」, terminator kept), then speech again on a redialled leg whose
    // prefix is still empty when the 30 s deadline passes. The bank alone must not
    // fire the sentence arm there — it would cut at the live edge, mid-word.
    const clock = new FakeClock();
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
    session.start();
    let legs = 0;
    const orch = new SttEngineOrchestrator(session, () => {
      const first = legs++ === 0;
      return new SonioxShapedEngine((fed) => (first
        ? { text: '第一句说完了', finalized_text: '', hypothesis_last_word_ms: fed - 300, audio_proc_ms: fed - 200 }
        : { text: '接着说下去', finalized_text: '', hypothesis_last_word_ms: fed - 300, audio_proc_ms: fed - 200 }),
      first ? '第一句说完了。' : '接着说下去');
    }, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 30_000, softSegmentGraceMs: 600_000, engineFlushTimeoutMs: 1_000, idleHangupMs: 3_000,
      shouldFeedEngine: (c) => !(c.seq >= 25 && c.seq < 43), // 5.0 s – 8.6 s withheld
    });
    const finals: FinalEvent[] = [];
    orch.on('final', (f: FinalEvent) => finals.push(f));
    orch.on('error', () => { /* mandatory listener */ });
    await orch.start({ language: 'zh', mode: 'realtime' });
    for (let seq = 0; seq * CHUNK_MS < 33_000; seq++) {
      orch.pushChunk({ seq, ts_ms: clock.now, payload: CHUNK });
      await clock.advance(CHUNK_MS);
    }
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);
    // POSITIVE CONTROL: the hang-up happened and redialled (a second leg), so the bank existed.
    expect(legs).toBeGreaterThanOrEqual(2);
    await orch.close();
  });

  it('the provisional tail is never read either: a draft 「。」 alone does not end the row', async () => {
    const rows = await run((fed) => ({
      text: '今天我们先说第一件事说完了。', finalized_text: '今天我们先说',
      hypothesis_last_word_ms: fed - 300, audio_proc_ms: fed - 200,
    }), '', 32_000);
    expect(rows).toHaveLength(0);
  });
});

describe('RC-4 — the third arm: the engine\'s own word gap', () => {
  it('🔴 gate never closes, no terminator: 3.5 s without a word ends the row, and the engine\'s own stop survives', async () => {
    // Words until 26.5 s, then 3.5 s of room noise the gate lets through.
    const rows = await run((fed) => ({
      text: '没有句号的一段话', finalized_text: '',
      hypothesis_last_word_ms: Math.min(fed - 300, 26_500), audio_proc_ms: fed - 200,
    }), '没有句号的一段话。', 31_000);
    expect(rows).toHaveLength(1);
    // 'word_gap' is a speaker's pause: seamText keeps what the engine produced.
    expect(rows[0]!.text).toBe('没有句号的一段话。');
  });

  it('a gap the VENDOR has not confirmed does not cut (fed audio outran the vendor)', async () => {
    // Our fed count says 4 s since the last word, the vendor has only processed
    // 1 s past it — the next word may be in the other 3 s (a recovery burst).
    const rows = await run((fed) => ({
      text: '话还在说', finalized_text: '',
      hypothesis_last_word_ms: Math.min(fed - 300, 26_500), audio_proc_ms: Math.min(fed - 200, 27_500),
    }), '', 31_000);
    expect(rows).toHaveLength(0);
  });

  it('an engine that reports no word timestamps is unchanged: no third arm, no cut', async () => {
    const rows = await run(() => ({ text: '没有时间戳' }), '', 34_000);
    expect(rows).toHaveLength(0);
  });

  it('a gap under 3 s does not cut', async () => {
    const rows = await run((fed) => ({
      text: '停了一下', finalized_text: '',
      hypothesis_last_word_ms: Math.min(fed - 300, 27_600), audio_proc_ms: fed - 200,
    }), '', 30_400);
    expect(rows).toHaveLength(0);
  });
});

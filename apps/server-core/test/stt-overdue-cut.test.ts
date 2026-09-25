// card RC-4 follow-up — THE OVERDUE ARM: a row open 90 s ends at the next proven
// ≥600 ms gap between words, and by 120 s at a proven word end — never inside a word.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (the overdue arm block)
//   apps/server-core/src/stt/overdue-cut.ts (why the cut lands in the PAST)
//
// Drives the REAL orchestrator. The fake engine models what makes this arm hard:
//   · speech is WORDS with times (400 ms each, 300 ms apart unless a script says
//     otherwise), and a leg transcribes a word only if it was handed BOTH the chunk
//     holding the word's start and the chunk holding its end — a word cut in two
//     is lost, as Soniox drops an onset-less syllable (root-cause §3.1). So a cut
//     inside a word shows up as a MISSING word, which the claims below would see;
//   · words become FINAL 4.5 s after the audio that carries them (measured 4.1–5.3 s),
//     so the proven cut point is seconds in the past, and the flush takes 800 ms: the
//     replay the cut needs is older than the 5 s replay window by the time it runs.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { STT_REPLAY_SHORT_EVENT } from '../src/stt/orchestrator-replay';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { LegFacts } from '../src/stt/leg-facts';
import { OverdueCut } from '../src/stt/overdue-cut';

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
const FINAL_LAG_MS = 4_500;
const FLUSH_MS = 800;
const WORD_MS = 400;

interface Word { i: number; s: number; e: number }

/** Words back to back with a 300 ms gap, except where [gaps] says (index → gap after it). */
function speech(untilMs: number, gaps: ReadonlyMap<number, number> = new Map()): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (let i = 0; t + WORD_MS <= untilMs; i++) {
    out.push({ i, s: t, e: t + WORD_MS });
    t += WORD_MS + (gaps.get(i) ?? 300);
  }
  return out;
}
const tok = (w: Word): string => `w${w.i} `;
const chunkOf = (t: number): number => Math.floor(t / CHUNK_MS);
const endChunkOf = (w: Word): number => chunkOf(w.e - 1);

class WordLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  private readonly heard: number[] = []; // seqs, in the order handed over = this leg's clock
  private cutoff: number | null = null;
  private finalSent = 0;
  constructor(private readonly words: readonly Word[]) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  limitFinalTo(legMs: number | null): void { this.cutoff = legMs; }
  /** Where stream time [t] sits in this leg's clock, or null if its chunk was not handed over. */
  private legPos(t: number): number | null {
    const k = this.heard.indexOf(chunkOf(t));
    return k < 0 ? null : k * CHUNK_MS + (t % CHUNK_MS);
  }
  private whole(): { w: Word; ls: number; le: number }[] {
    const out: { w: Word; ls: number; le: number }[] = [];
    for (const w of this.words) {
      const ls = this.legPos(w.s); const le = this.legPos(w.e - 1);
      if (ls !== null && le !== null && this.heard.includes(endChunkOf(w))) out.push({ w, ls, le: le + 1 });
    }
    return out.sort((a, b) => a.ls - b.ls);
  }
  push(chunk: Buffer): void {
    this.heard.push(chunk.readUInt32LE(0));
    const fed = this.heard.length * CHUNK_MS;
    const ws = this.whole().filter((x) => x.le <= fed);
    const fin = ws.filter((x) => x.le <= fed - FINAL_LAG_MS);
    const fresh = fin.slice(this.finalSent);
    this.finalSent = fin.length;
    if (ws.length === 0) return;
    this.emit('interim', {
      kind: 'interim', confidence: 1, language: 'zh', text: ws.map((x) => tok(x.w)).join(''),
      finalized_text: fin.map((x) => tok(x.w)).join(''),
      hypothesis_last_word_ms: ws[ws.length - 1]!.le, audio_proc_ms: fed,
      ...(fresh.length > 0 ? { finalized_word_spans: fresh.map((x) => ({ start_ms: x.ls, end_ms: x.le })) } : {}),
    });
  }
  async flush(): Promise<void> {
    await new Promise<void>((r) => { this.emit('flush-wait', r); });
    const kept = this.whole().filter((x) => this.cutoff === null || x.ls < this.cutoff);
    this.emit('final', { kind: 'final', text: kept.map((x) => tok(x.w)).join(''), confidence: 1, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

interface Row { text: string; is_segment: boolean; atMs: number }
interface Run { rows: Row[]; all: string; cuts: Record<string, unknown>[]; shorts: Record<string, unknown>[] }

afterEach(() => { vi.restoreAllMocks(); });

/** [graceMs] — card RC-J: the leg rotates every `30 s + graceMs` (cadence phase 2); out of reach by default. */
async function run(words: readonly Word[], untilMs: number, graceMs = 600_000): Promise<Run> {
  const cuts: Record<string, unknown>[] = [];
  const shorts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
  vi.spyOn(log, 'warn').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_REPLAY_SHORT_EVENT) shorts.push(fields ?? {}); });
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new WordLeg(words);
    leg.on('flush-wait', (r: () => void) => { clock.setTimeout(r, FLUSH_MS); });
    return leg;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    // By default the leg is never rotated (grace out of reach): this file is about the ROW.
    // card RC-J passes a grace that rotates it just before the arm, on purpose.
    softSegmentMs: 30_000, softSegmentGraceMs: graceMs, engineFlushTimeoutMs: 3_000,
  });
  const rows: Row[] = [];
  orch.on('final', (f: { text: string; is_segment: boolean }) => rows.push({ text: f.text, is_segment: f.is_segment, atMs: clock.now }));
  orch.on('error', () => { /* listener mandatory */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  for (let seq = 0; seq * CHUNK_MS < untilMs; seq++) {
    const payload = Buffer.alloc(CHUNK_MS * 32);
    payload.writeUInt32LE(seq, 0);
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  const stopped = orch.stop();
  await clock.advance(5_000);
  await stopped;
  return { rows, all: rows.map((r) => r.text).join(''), cuts, shorts };
}

const said = (words: readonly Word[], untilMs: number): string => words.filter((w) => w.e <= untilMs).map(tok).join('');

describe('RC-4 follow-up — the overdue arm', () => {
  it('🔴 300 ms gaps: nothing before 90 s (not even a 700 ms gap at 60 s); the first ≥600 ms gap after 90 s ends the row', async () => {
    const early = speech(60_000).length - 1;            // a 700 ms gap near 60 s — too early
    const words0 = speech(100_000);
    const late = words0.length - 1;                       // a 700 ms gap near 100 s — the one
    const words = speech(110_000, new Map([[early, 700], [late, 700]]));
    const r = await run(words, 110_000);
    const segs = r.rows.filter((x) => x.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.atMs).toBeGreaterThanOrEqual(90_000);
    // The row ends on the word before the late gap, and on no other.
    expect(segs[0]!.text).toBe(words.slice(0, late + 1).map(tok).join(''));
    // THE CLAIM — every word said exactly once, none cut in two.
    expect(r.all).toBe(said(words, 110_000));
    // card RC-J (the hold) — and the next leg was replayed from X itself: nothing the cut owed
    // it had left the ring. This rig loses no WORD when a gap chunk is pruned (the chunk is
    // silence to it), so the relay's own WARN is the witness, not the text.
    expect(r.shorts).toEqual([]);
  });

  it('🔴 no gap ≥600 ms at all: the row is cut by 120 s, on a word end, losing and repeating nothing', async () => {
    const words = speech(126_000);
    const r = await run(words, 126_000);
    const segs = r.rows.filter((x) => x.is_segment);
    expect(segs).toHaveLength(1);
    // Decided on the first chunk at 120 s; the row leaves after the flush round trip.
    expect(segs[0]!.atMs).toBeLessThanOrEqual(120_000 + FLUSH_MS + CHUNK_MS);
    expect(segs[0]!.atMs).toBeGreaterThanOrEqual(120_000);
    // It ends on a whole word…
    expect(segs[0]!.text).toMatch(/^(w\d+ )+$/);
    // …and nothing is lost or duplicated across the cut.
    expect(r.all).toBe(said(words, 126_000));
    expect(r.shorts).toEqual([]); // card RC-J (the hold)
  });
});

describe('card RC-J — the overdue cut keeps 2 s clear of a fresh leg seam', () => {
  // The leg rotates at 45.5 s and 91 s (cadence 30 s + grace 15.5 s). The row armed at 90 s in
  // the OLD leg, so every gap of the new one counts from its first byte (`OverdueCut.decide`).
  // A 700 ms gap follows 0.6 s after the rotation; another follows at 94 s.
  //
  // MEASURED before the rule (lane-a, 2026-09-24; the `stt.cut` fields this card added): the
  // cut took the first gap — x_leg_ms 1450, leg_seam_ms 800, left word 'previous' (it starts in
  // the re-heard head), right 'current'. A sweep of rotation 89.4–91 s × gap 90.4–92 s put X at
  // 750–3050 ms, under 2 s in 11 of 20, the left word in the re-heard head in 5 of 20.
  //
  // ⚠️ What this rig can and cannot show: its leg transcribes every whole word it is handed,
  // context or none, so the device's damage (two seams within a second, each side garbled) does
  // not appear here — `said` passes before the rule too. The claim is therefore on WHERE the cut
  // lands (the `stt.cut` line), plus 「each word exactly once」 as the card's regression guard.
  // REVERSE CONTROL: the RC-J `continue` in `OverdueCut.decide` removed ⇒ the 🔴 case reds on
  // x_leg_ms (1450); see the card's report for the log.
  const w0 = speech(130_000);
  const early = w0.findIndex((w) => w.e >= 91_600);
  const late = w0.findIndex((w) => w.e >= 94_000);
  const words = speech(130_000, new Map([[early, 700], [late, 700]]));

  it('🔴 the new leg’s first gap sits inside 2 s of its start ⇒ skipped; the cut takes the next gap, and every word comes out once', async () => {
    const r = await run(words, 130_000, 15_500);
    const cut = r.cuts.find((c) => c.reason === 'overdue');
    expect(cut).toBeDefined();
    expect(cut!.x_leg_ms as number).toBeGreaterThanOrEqual(2_000);
    expect(cut!.x_left_word_leg).toBe('current');
    expect(cut!.x_right_word_leg).toBe('current');
    const segs = r.rows.filter((x) => x.is_segment);
    expect(segs).toHaveLength(1);
    // The row ends on the word before the 94 s gap — the second one, not the first.
    expect(segs[0]!.text.endsWith(tok(words[late]!))).toBe(true);
    expect(r.all).toBe(said(words, 130_000));
    expect(r.shorts).toEqual([]); // card RC-J (the hold)
  });
});

describe('card RC-J — the rule on `OverdueCut.decide` itself (the 120 s word-end fallback included)', () => {
  const leg = {};
  const facts = (seamMs: number, words: [number, number][]): LegFacts => {
    const f = new LegFacts();
    f.noteSeam(seamMs);
    for (let s = 1; s <= 30; s++) f.noteLegChunk(s, s * CHUNK_MS); // 6 s of chunks, so every point has a boundary
    f.noteInterim({ kind: 'interim', text: '', confidence: 1, language: 'zh', finalized_word_spans: words.map(([a, b]) => ({ start_ms: a, end_ms: b })) });
    return f;
  };
  it('a gap whose left word starts in the re-heard head is skipped even past 2 s; one wholly in the leg’s own audio is taken', () => {
    // ⚠️ 更正（RC-J2，2026-09-24）：this case used to end at 4600–4700 and expect the (3900 | 4600) gap, X = 4250 ms —
    // 4.25 s from the leg start but 1.85 s from the 2.4 s seam, which RC-J2 now skips. One more word puts a gap
    // (4700 | 5400) 2.65 s past the seam, and that is the one taken.
    const c = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 95_000, legFedMs: 0, legId: leg,
      facts: facts(2_400, [[2_000, 2_500], [3_200, 3_500], [3_600, 3_700], [3_800, 3_900], [4_600, 4_700], [5_400, 5_500]]) });
    // (2000–2500 | 3200) starts before the seam; (3500 | 3600) and (3700 | 3800) are too short; (3900 | 4600) is < 2 s past the seam.
    expect(c?.kind).toBe('gap');
    expect(c?.legMs).toBe(5_050);
  });
  it('the 120 s fallback does not cut on a word end inside 2 s of the leg start, and does once one lies past it', () => {
    const early = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 121_000, legFedMs: 0, legId: leg, facts: facts(0, [[900, 1_300], [1_500, 1_900]]) });
    expect(early).toBeNull();
    const late = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 121_000, legFedMs: 0, legId: leg, facts: facts(0, [[900, 1_300], [1_500, 1_900], [2_000, 2_300]]) });
    expect(late?.kind).toBe('word_end');
    expect(late?.legMs).toBe(2_300);
  });
});

describe('card RC-J2 — the 2 s clearance is measured from the seam, not from the leg clock’s 0', () => {
  // rerun-3 root cause §5.1-2 【实测】: a leg born into a backlog re-heard the old leg's 18.6 s flush
  // (`leg_seam_ms 18,600`), and the overdue cut landed at `x_leg_ms 19,800` — 19.8 s from the leg's 0,
  // 1.2 s past its seam — and the seam repeated a word. 125 chunks = 25 s of leg clock.
  const leg = {};
  const facts = (seamMs: number, words: [number, number][]): LegFacts => {
    const f = new LegFacts();
    f.noteSeam(seamMs);
    for (let s = 1; s <= 125; s++) f.noteLegChunk(s, s * CHUNK_MS);
    f.noteInterim({ kind: 'interim', text: '', confidence: 1, language: 'zh', finalized_word_spans: words.map(([a, b]) => ({ start_ms: a, end_ms: b })) });
    return f;
  };
  it('🔴 seam 18.6 s, the first ≥600 ms gap at 19.8 s ⇒ no cut; the next one past 20.6 s ⇒ cut there', () => {
    const early = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 95_000, legFedMs: 0, legId: leg,
      facts: facts(18_600, [[18_700, 19_450], [20_150, 20_500]]) });
    expect(early, 'X = 19.8 s is 1.2 s past the seam').toBeNull();
    const later = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 95_000, legFedMs: 0, legId: leg,
      facts: facts(18_600, [[18_700, 19_450], [20_150, 20_500], [21_200, 21_600]]) });
    expect(later?.kind).toBe('gap');
    expect(later?.legMs).toBe(20_850);
  });
  it('the 120 s word-end fallback is measured from the seam too', () => {
    const early = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 121_000, legFedMs: 0, legId: leg, facts: facts(18_600, [[18_700, 19_450]]) });
    expect(early).toBeNull();
    const late = new OverdueCut().decide({ segmentIdx: 0, rowAgeMs: 121_000, legFedMs: 0, legId: leg, facts: facts(18_600, [[18_700, 19_450], [20_150, 20_700]]) });
    expect(late?.kind).toBe('word_end');
    expect(late?.legMs).toBe(20_700);
  });
});

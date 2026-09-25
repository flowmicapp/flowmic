// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-4 block: the confirmed text and the
//     word-gap arm; RC-5a block: the seam floor) and §3 (RC-5b block: the merge gate;
//     RC-5c block: the merge bound read off the vendor's processed position)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (RC-5a
//     correction: an empty leg is judged by voice, not bytes)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §2, §3.1, §3.2, §5
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Cards RC-4 / RC-5a / RC-5b needed facts about THE LEG NOW OPEN, each born empty when a leg is
// born and dying with it. They live together here so the orchestrator resets
// them in ONE call at the one site every leg is born (`spawnEngine`), instead of
// growing more fields that each have to be remembered there (`orchestrator-core.ts`
// sits near the 800-line cap, and a per-leg field forgotten at one of the four
// birth paths is exactly how RT-2's hang-up hole happened).

import type { FinalResult, InterimResult } from './engines/base';
import type { LiveLegWords } from './segment-pause';
import { mergeOverlap, mergeOverlapWithin } from './text-merge';

/** How one replay into this leg is described by `replayBufferTail`. */
export interface LegReplay {
  /** `gateUnfed` — a rollover / redial / cold-open replay of `seq > mark` only.
   *  false = a LADDER reconnect re-feeding the whole window of heard audio. */
  readonly gated: boolean;
  /** `unheardVoice` BEFORE the replay: gate-accepted audio is waiting above the mark. */
  readonly voiceOwed: boolean;
  /** Bytes this replay actually handed to the leg. */
  readonly fedBytes: number;
}

export class LegFacts {
  private finalized = '';
  private lastWordEndMs: number | null = null;
  private vendorProcMs: number | null = null;
  private unvoicedReplayBytes = 0;
  private replayedHeard = false;
  private finalSeen = false;
  /** card RC-4 overdue — this leg's vendor-final content words, and every chunk it was
   *  handed with where that chunk ENDS in the leg's fed-audio clock (`legFedBytes`). */
  private words: { start_ms: number; end_ms: number }[] = [];
  private chunks: { seq: number; endMs: number }[] = [];
  /** card RC-5c — this leg's end-of-stream answer: the vendor's processed floor
   *  (`FinalResult.audio_proc_floor_ms`), or null when none came. */
  private finishedFloorMs: number | null = null;
  /** card RC-5c — the audio this leg re-heard that the previous leg's final had
   *  covered, in THIS leg's clock (ms from its first byte). null = not measured
   *  (no vendor position, or a ladder replay) ⇒ {@link foldFinal} keeps RC-5b's rule. */
  private overlapMs: number | null = null;
  /** card RC-5c — during a replay: per seq, how many ms at the head of that chunk
   *  the previous leg's final covered. */
  private reheard: ReadonlyMap<number, number> | null = null;
  /** card RC-5c — written when a leg closes, consumed by the next replay. It
   *  describes the leg that DIED, so {@link reset} (a leg being born) leaves it. */
  private closed: ReadonlyMap<number, number> | null = null;
  /** card RC-J — how much of this leg's head is audio the leg before it had also been handed
   *  (the gated replay's overlap, `orchestrator-replay.ts` `replayIntoLeg`); for a ladder replay,
   *  which re-feeds a window of heard audio, the whole replay. 0 = the leg's audio is all its own. */
  private seamMs = 0;

  /** A leg is being born — every fact below belongs to the one that died. */
  reset(): void {
    this.seamMs = 0; // card RC-J
    this.finalized = ''; this.lastWordEndMs = null; this.vendorProcMs = null;
    this.unvoicedReplayBytes = 0; this.replayedHeard = false; this.finalSeen = false;
    this.words = []; this.chunks = [];
    this.finishedFloorMs = null; this.overlapMs = null; this.reheard = null; // RC-5c (`closed` survives on purpose)
  }

  /** card RC-4 — record what this leg's latest interim says. A field the engine
   *  left absent CLEARS the fact rather than keeping an older answer: every
   *  Soniox frame restates all three, so absence is news, not silence. */
  noteInterim(e: InterimResult): void {
    this.finalized = typeof e.finalized_text === 'string' ? e.finalized_text : '';
    this.lastWordEndMs = typeof e.hypothesis_last_word_ms === 'number' ? e.hypothesis_last_word_ms : null;
    this.vendorProcMs = typeof e.audio_proc_ms === 'number' ? e.audio_proc_ms : null;
    if (e.finalized_word_spans) for (const w of e.finalized_word_spans) this.words.push({ start_ms: w.start_ms, end_ms: w.end_ms });
  }

  /** card RC-J — see {@link seamMs}. */
  noteSeam(ms: number): void { this.seamMs = Math.max(this.seamMs, ms); }
  get seam(): number { return this.seamMs; }

  /** card RC-4 overdue — the leg's vendor-final content words, in arrival (= time) order. */
  get finalWords(): readonly { start_ms: number; end_ms: number }[] { return this.words; }

  /** card RC-4 overdue — one chunk handed to this leg (live or replay); [endMs] is
   *  `legFedBytes / 32` right after it, i.e. where it ends in the vendor's clock. */
  noteLegChunk(seq: number, endMs: number): void {
    const startMs = this.chunks.length > 0 ? this.chunks[this.chunks.length - 1]!.endMs : 0;
    this.chunks.push({ seq, endMs });
    // card RC-5c — a replayed chunk the previous leg's final covered (wholly or its head).
    const covered = this.reheard?.get(seq);
    if (covered !== undefined && this.overlapMs !== null) this.overlapMs = Math.max(this.overlapMs, startMs + covered);
  }

  /**
   * card RC-5c — this leg is closing (its flush answered, or did not). Map its
   * end-of-stream floor onto the chunks it was handed: for each chunk, how many ms
   * at its head lie before the floor — audio this leg's final can cover. [cutoffMs]
   * is the overdue arm's cut (the final only keeps tokens that started before it).
   * No floor ⇒ nothing is known and the next replay measures nothing.
   */
  closeLeg(cutoffMs: number | null): void {
    const floor = this.finishedFloorMs;
    if (floor === null) { this.closed = null; return; }
    const covered = cutoffMs === null ? floor : Math.min(floor, cutoffMs);
    const m = new Map<number, number>();
    let startMs = 0;
    for (const c of this.chunks) {
      if (covered > startMs) m.set(c.seq, Math.min(c.endMs, covered) - startMs);
      startMs = c.endMs;
    }
    this.closed = m;
  }

  /** card RC-5c — a replay into this leg is about to be fed. A GATED replay after a
   *  leg that reported its floor is measured (starting from 0); a LADDER replay
   *  re-feeds heard audio with no floor to read, so it un-measures the leg. Either
   *  way the closed leg's map is spent. */
  beginReplay(gated: boolean): void {
    if (!gated) this.overlapMs = null;
    else if (this.closed !== null) { this.reheard = this.closed; if (this.overlapMs === null) this.overlapMs = 0; }
    this.closed = null;
  }

  /** card RC-5c — the replay is fed; later chunks are live audio nobody heard. */
  endReplay(): void { this.reheard = null; }

  /** card RC-4 overdue — the replay boundary that hands the next leg the chunk
   *  containing [legMs] and everything after it: the seq just below that chunk.
   *  null when no chunk of this leg reaches past [legMs]. */
  replayBoundaryFor(legMs: number): number | null {
    const c = this.chunks.find((x) => x.endMs > legMs);
    return c === undefined ? null : c.seq - 1;
  }

  /**
   * card RC-4 — the leg's vendor-finalised prefix, which the sentence arm reads
   * AFTER `offlineAccum`. Never the draft: a finalised token 「一旦标记为 final 就永不
   * 改变」 (the adapter's §3a), a provisional one may be revised away.
   * '' for every engine that does not declare one (all but Soniox) ⇒ the
   * sentence arm reads exactly what it read before this card.
   */
  get finalizedText(): string { return this.finalized; }

  /** card RC-4 — the live input to `SegmentPauseAccount.liveWordGap`, or null. */
  liveWords(legFedMs: number): LiveLegWords | null {
    if (this.lastWordEndMs === null || this.vendorProcMs === null) return null;
    return { legFedMs, lastWordEndMs: this.lastWordEndMs, vendorProcMs: this.vendorProcMs };
  }

  /**
   * card RC-5a — one replay into this leg. A GATED replay carries gate-accepted
   * audio only when voice was owed above the mark (`unheardVoice`, HANGUP-1's own
   * invariant: set by every path that leaves accepted audio unheard, cleared only
   * by a hand-over). Otherwise it holds only chunks the gate withheld — the
   * closed-run tail a row cut now replays, and withheld chunks from the flush
   * round trip — and those bytes are not voice. A ladder replay re-feeds heard
   * audio and counts as voice (it held the words the dead leg had been given).
   */
  noteReplay(r: LegReplay): void {
    if (r.gated && !r.voiceOwed) this.unvoicedReplayBytes += r.fedBytes;
  }

  /**
   * card RC-5b — this leg is about to be replayed audio an EARLIER leg was handed,
   * so its text may restate the bank. Called BEFORE the feed, because an engine can
   * emit a final while the replay is still being pushed (the harness' mid-session
   * finals do; FunASR's 2pass-offline can) and that final must already see it.
   * The orchestrator decides it from the same facts CR-12-D's `overlapBytes` counts
   * with: a gated replay covers seqs at or below the previous leg's high-water mark
   * (`legHeardUpToSeq > lastEngineFedSeq`); a LADDER replay always does — its
   * `overlapBytes` is FORCED to 0 (`heardUpToSeq: -1`, the pause account refuses that
   * clock), yet it re-feeds heard audio by definition. Read `overlapBytes` alone and
   * every reconnect seam would print the replayed window twice.
   */
  noteHeardReplay(): void { this.replayedHeard = true; }

  /** card RC-5a — bytes of this leg that carried gate-accepted audio. Only `> 0`
   *  is asked of it (the empty-leg rule of HANGUP-2/3). */
  voicedBytes(legFedBytes: number): number { return Math.max(0, legFedBytes - this.unvoicedReplayBytes); }

  /**
   * card RC-5b — fold one engine final into the bank. The FIRST final of a leg is
   * the only one that meets a seam (the bank ends with what earlier legs said);
   * when this leg was replayed nothing already heard, the two cannot overlap and a
   * shared suffix/prefix is the speaker repeating themselves (「没有投票。投票会在」,
   * root-cause §3.2) — joined, never trimmed. Later finals of the same leg keep
   * `mergeOverlap` exactly as before (a cumulative engine restates its own finals).
   * RC-4: a final carries everything the leg had finalised, so the prefix is spent.
   *
   * ⚠️ KNOWN LIMIT (book 06 §3 RC-5b block): a leg ROTATION's overlap equals its
   * flush round trip (chunks pushed into the old leg after its end-of-stream are
   * rewound and replayed), so a Soniox rotation with any round trip still merges
   * here. Whether the old final covered those chunks is a vendor fact this card
   * does not read.
   * ⚠️ 更正（RC-5c，2026-09-24）：the paragraph above was the whole rule until RC-5c.
   * When the previous leg reported its processed floor and this leg's final carries
   * token times, the seam is merged only within the leading tokens that STARTED
   * inside the measured overlap (the same 「started before ⇒ in that final」 rule as
   * the overdue arm's `finalTextBefore`); overlap 0 is a plain join. Without either
   * fact the RC-5b rule above is unchanged (book 06 §3 RC-5c block).
   */
  foldFinal(bank: string, text: string, e?: Pick<FinalResult, 'audio_proc_floor_ms' | 'token_spans'>): string {
    this.finalized = '';
    this.finishedFloorMs = typeof e?.audio_proc_floor_ms === 'number' ? e.audio_proc_floor_ms : null; // RC-5c: before any return
    if (text === '') return bank; // an empty final carries no words, so it does not use up the seam
    const seam = !this.finalSeen;
    this.finalSeen = true;
    if (!seam) return mergeOverlap(bank, text);
    if (!this.replayedHeard) return bank + text;
    if (this.overlapMs === null || !e?.token_spans) return mergeOverlap(bank, text); // RC-5c fact absent: RC-5b as before
    return mergeOverlapWithin(bank, text, charsStartedBefore(e.token_spans, this.overlapMs));
  }

  /**
   * card RC-L (rerun-3 root cause §1.2 / §4.1) — the highest seq this leg has ANSWERED: every chunk it
   * was handed above it is audio it heard and has not yet spoken for. null ⇒ nothing to owe: the engine
   * reports no processed position ([ackedMs] absent — every engine but Soniox, whose behaviour is then
   * exactly what it was), or every chunk ends at or before the answered point.
   *
   * 「Answered」 is the SMALLER of the vendor's processed position and the end of the last word in this
   * leg's latest hypothesis. Processed alone is not enough: a word straddling that position has been
   * half heard and not emitted, and replaying from its middle hands the next leg a word with no onset,
   * which Soniox deletes (root cause §3.1). The last-word end is where the banked draft stops, so the
   * replay starts where the text does.
   */
  answeredThroughSeq(ackedMs: number | undefined): number | null {
    if (typeof ackedMs !== 'number' || !Number.isFinite(ackedMs)) return null;
    return this.replayBoundaryFor(this.lastWordEndMs === null ? ackedMs : Math.min(ackedMs, this.lastWordEndMs));
  }

  /** card RC-T — the newest seq this leg has been handed, or null for a leg handed nothing yet. */
  get lastSeq(): number | null { return this.chunks.length === 0 ? null : this.chunks[this.chunks.length - 1]!.seq; }
}

/** card RC-5c — characters of the leading tokens that started before [overlapMs];
 *  stops at the first token that did not, or that has no start time. */
function charsStartedBefore(spans: NonNullable<FinalResult['token_spans']>, overlapMs: number): number {
  let n = 0;
  for (const t of spans) {
    if (t.start_ms === null || t.start_ms >= overlapMs) break;
    n += t.text.length;
  }
  return n;
}

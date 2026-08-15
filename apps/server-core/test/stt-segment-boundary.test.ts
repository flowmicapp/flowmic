// card SEG-1 — WHERE a long recording is allowed to be cut.
//
// The defect this pins, in the owner's words and in the product's own output
// (2026-08-15, one 102-second dictation over the cloud relay):
//
//   row 2 「…所以呢，本质上安倍。」  │  row 3 「经济学是通过出卖金融主权…」
//
// 「安倍経済学」 split down the middle by a 30-second stopwatch. The two halves
// then decode without each other's context, which is the 「中间会丢失几个字」
// half of the report.
//
// The tests below are written against `segmentCutVerdict` — a pure function —
// because the interesting content of this card is a POLICY, and a policy tested
// through a fake clock, a fake engine and a chunk pump is a policy tested by
// three things that can each be wrong. The wiring gets its own rows in
// `stt-segment-settlement.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  endsAtSentenceBoundary, seamText, segmentCutDecision, MIN_PAUSE_MS,
} from '../src/stt/segment-boundary';

/** The SEG-1 rows below were written against a `'cut' | 'wait'` verdict. SEG-3
 *  made the decision carry its REASON, so they read it through this adapter
 *  rather than being rewritten — what they assert did not change. */
const segmentCutVerdict = (i: Parameters<typeof segmentCutDecision>[0]): 'cut' | 'wait' =>
  segmentCutDecision(i).cut ? 'cut' : 'wait';

/** 🔴 SEG-3 changed what "the gate is closed" means: an INSTANT reading became a
 *  measured silence run, because a breath closes the gate and does not end a
 *  sentence. These SEG-1 rows meant "a real pause", so they say so in ms now. */
const PAUSE = MIN_PAUSE_MS;
const mid = { due: true, gateClosedMs: 0 };

describe('SEG-1 §1 — nothing is cut before the cadence deadline', () => {
  it('a pause at second 3 does not mint a 3-second row', () => {
    expect(segmentCutVerdict({ due: false, confirmed: '你好。', gateClosedMs: PAUSE }))
      .toBe('wait');
  });

  it('not even a finished sentence — the cadence is what asks for a boundary', () => {
    expect(segmentCutVerdict({ due: false, confirmed: '这是一句完整的话。', gateClosedMs: 0 }))
      .toBe('wait');
  });
});

describe('SEG-1 §2 — past the deadline, cut at a boundary we can defend', () => {
  it('a real pause (VAD gate closed) cuts', () => {
    expect(segmentCutVerdict({ ...mid, confirmed: '说到一半', gateClosedMs: PAUSE })).toBe('cut');
  });

  it('a sentence the ENGINE confirmed cuts, even mid-speech', () => {
    // 🔴 The row that matters for the reported defect. The measurement behind it:
    // that recording was 102,280 ms voiced out of 102,400 ms, i.e. the energy gate
    // never closed — so if this were pause-only, the fix would not fire on the
    // recording that motivated it.
    expect(segmentCutVerdict({ ...mid, confirmed: '所以呢，本质上安倍经济学是这样。' })).toBe('cut');
  });

  it('mid-sentence keeps recording — this is the whole point of the card', () => {
    expect(segmentCutVerdict({ ...mid, confirmed: '所以呢，本质上安倍' })).toBe('wait');
  });

  it('a trailing comma is NOT a boundary — the sentence is still running', () => {
    expect(segmentCutVerdict({ ...mid, confirmed: '所以呢，' })).toBe('wait');
  });
});

describe('SEG-4 §3 — time is NOT a boundary (the ceiling arm is gone)', () => {
  it('🔴 a speaker who never pauses, on an engine with no punctuation, is never cut by this policy', () => {
    // Both boundary signals dark ⇒ the answer is WAIT, forever. Under SEG-1
    // this was where a `ceilingReached` arm delivered a row — i.e. time could
    // end a sentence, which is owner's 2026-08-15 defect at its root. The
    // bounded resource (the vendor session) is bounded by the LEG rotation in
    // SoftSegmentCadence's phase 2 now, which delivers nothing; the input type
    // no longer even has a field through which time could force a delivery.
    expect(segmentCutVerdict({ due: true, confirmed: 'one two three four', gateClosedMs: 0 }))
      .toBe('wait');
  });
});

describe('SEG-1 §4 — what counts as a sentence terminator', () => {
  it('accepts the ideographic and full-width terminators', () => {
    for (const s of ['结束了。', '真的吗？', '太好了！', '嗯…', '这样吧?', '快跑!']) {
      expect(endsAtSentenceBoundary(s)).toBe(true);
    }
  });

  it('ignores trailing whitespace the engines pad with', () => {
    expect(endsAtSentenceBoundary('结束了。  ')).toBe(true);
  });

  it('REFUSES the ASCII period — "U.S." and "3.5" are mid-sentence', () => {
    // Accepting it would move the cut INTO a sentence, which is the defect this
    // card exists to remove. English leans on the pause signal and the ceiling;
    // that is the stated trade, not an oversight.
    expect(endsAtSentenceBoundary('we met in the U.S.')).toBe(false);
    expect(endsAtSentenceBoundary('it costs 3.5')).toBe(false);
  });

  it('empty confirmed text is never a boundary', () => {
    expect(endsAtSentenceBoundary('')).toBe(false);
    expect(endsAtSentenceBoundary('   ')).toBe(false);
    // …and the verdict agrees, so a segment that has heard nothing yet does not
    // close the moment the deadline passes.
    expect(segmentCutVerdict({ ...mid, confirmed: '' })).toBe('wait');
  });
});

// ── card SEG-3 (2026-08-15) ────────────────────────────────────────────────
// owner, holding up one of his own dictations after SEG-1 shipped:
// 「这句被切成了 2 段，中间用句号连起来，很明显不对」.
//
//   segment 1 「…所以呢要不断的去搜查记录与看看要怎么样实现。」  ← nobody spoke this
//   segment 2 「这个方案，所以说不一定要怎么搞。」
//
// The clause is 「看看要怎么样实现这个方案」. The full stop is a property of the
// SPAN, not of the speech — `engines/sherpa-local.ts:196` states the mechanism as
// a measured fact: SenseVoice punctuates as a function of the span, so that mark
// would have been a 「，」 had the audio kept flowing. SEG-1 could not fix this:
// the ceiling must exist, so forced cuts must exist.
describe('SEG-3 §1 — a breath is not a sentence', () => {
  it('an INSTANT gate reading no longer cuts — that was owner\'s seam', () => {
    // Exactly the shape of the reported defect: mid-clause, gate momentarily
    // closed for the breath before 「这个方案」.
    expect(segmentCutVerdict({ ...mid, confirmed: '看看要怎么样实现', gateClosedMs: 120 }))
      .toBe('wait');
  });

  it('a silence long enough to be a stop still cuts', () => {
    expect(segmentCutVerdict({ ...mid, confirmed: '看看要怎么样实现', gateClosedMs: PAUSE }))
      .toBe('cut');
  });
});

describe('SEG-3 §2 — the reason travels, because the repair depends on it', () => {
  it('a sentence the speaker finished is reported as such', () => {
    expect(segmentCutDecision({ ...mid, confirmed: '说完了。', gateClosedMs: PAUSE }))
      .toEqual({ cut: true, reason: 'sentence' });
  });

  it('🔴 a finished sentence FOLLOWED BY a pause is still "sentence", not "pause"', () => {
    // The ordering row. Both signals are true here, and reading it as 'pause'
    // would strip a full stop the speaker really did produce.
    expect(segmentCutDecision({ ...mid, confirmed: '说完了。', gateClosedMs: 5_000 }).cut).toBe(true);
    expect(segmentCutDecision({ ...mid, confirmed: '说完了。', gateClosedMs: 5_000 }))
      .toEqual({ cut: true, reason: 'sentence' });
  });

  it('a mid-sentence, mid-speech chunk reports no cut at all', () => {
    expect(segmentCutDecision({ due: true, confirmed: '还没说完', gateClosedMs: 0 }))
      .toEqual({ cut: false });
  });
});

describe('SEG-3 §3 — the seam repair', () => {
  it('🔴 removes the full stop the SPAN produced — the reported defect (a leg seam)', () => {
    expect(seamText('所以呢要不断的去搜查记录与看看要怎么样实现。', 'leg'))
      .toBe('所以呢要不断的去搜查记录与看看要怎么样实现');
    // …so the two halves join into the clause that was actually spoken.
    expect(seamText('看看要怎么样实现。', 'leg') + '这个方案，所以说不一定要怎么搞。')
      .toBe('看看要怎么样实现这个方案，所以说不一定要怎么搞。');
  });

  it('KEEPS it when the speaker is the one who ended the sentence', () => {
    expect(seamText('这句说完了。', 'sentence')).toBe('这句说完了。');
  });

  it('repairs a pause seam too — a breath-length gap ends no sentence either', () => {
    expect(seamText('我在想。', 'pause')).toBe('我在想');
  });

  it('takes exactly ONE mark, never the run — 「吗？！」 is the speaker\'s emphasis', () => {
    expect(seamText('真的吗？！', 'leg')).toBe('真的吗？');
  });

  it('leaves text that has no terminator alone, and never invents one', () => {
    expect(seamText('还没说完', 'leg')).toBe('还没说完');
    expect(seamText('', 'leg')).toBe('');
  });

  it('a trailing comma survives — it was never claiming a sentence ended', () => {
    expect(seamText('所以呢，', 'leg')).toBe('所以呢，');
  });
});

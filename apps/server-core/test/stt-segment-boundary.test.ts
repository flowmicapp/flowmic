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
import { endsAtSentenceBoundary, segmentCutVerdict } from '../src/stt/segment-boundary';

const mid = { due: true, ceilingReached: false, gateOpen: true };

describe('SEG-1 §1 — nothing is cut before the cadence deadline', () => {
  it('a pause at second 3 does not mint a 3-second row', () => {
    expect(segmentCutVerdict({ due: false, ceilingReached: false, confirmed: '你好。', gateOpen: false }))
      .toBe('wait');
  });

  it('not even a finished sentence — the cadence is what asks for a boundary', () => {
    expect(segmentCutVerdict({ due: false, ceilingReached: false, confirmed: '这是一句完整的话。', gateOpen: true }))
      .toBe('wait');
  });
});

describe('SEG-1 §2 — past the deadline, cut at a boundary we can defend', () => {
  it('a real pause (VAD gate closed) cuts', () => {
    expect(segmentCutVerdict({ ...mid, confirmed: '说到一半', gateOpen: false })).toBe('cut');
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

describe('SEG-1 §3 — the ceiling is unconditional', () => {
  it('cuts mid-sentence once the grace has expired', () => {
    expect(segmentCutVerdict({ due: true, ceilingReached: true, confirmed: '还没说完', gateOpen: true }))
      .toBe('cut');
  });

  it('a speaker who never pauses on an engine with no punctuation still segments', () => {
    // Both boundary signals dark. Without the ceiling this is a row that grows
    // for the length of the recording.
    const noPunct = { due: true, ceilingReached: false, confirmed: 'one two three four', gateOpen: true };
    expect(segmentCutVerdict(noPunct)).toBe('wait');
    expect(segmentCutVerdict({ ...noPunct, ceilingReached: true })).toBe('cut');
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

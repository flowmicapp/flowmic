// NR-245 (GUARD-2) — Smooth may resolve an explicit self-correction; the
// repair's own content must survive, and a marker used as an ordinary word
// licenses nothing.
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { repairReadings } from '../src/stt/stt-polish-guard-repair';

const smooth = { strength: 'smooth' as const };
const strict = { strength: 'strict' as const };

const resolved: [string, string][] = [
  ["let's meet at 2, no wait, 3", "let's meet at 3"],
  ['我们三点，不对，四点开会', '我们四点开会'],
  ['会议改到2点，不对，是3点。', '会议改到3点。'],
  ['把文件发给李明，不对，发给张伟。', '把文件发给张伟。'],
  ['这周三，我是说下周三，我们去北京出差。', '下周三我们去北京出差。'],
  ['Send it to Mark, sorry, I mean Martin, in finance.', 'Send it to Martin in finance.'],
  ['The budget is 50, I mean 15,000 dollars.', 'The budget is 15,000 dollars.'],
  ['Deploy to production, actually no, deploy to staging first.', 'Deploy to staging first.'],
  ['We need 4, no, 5 more engineers on the team.', 'We need 5 more engineers on the team.'],
  ['Delete the staging database, sorry, the production database.', 'Delete the production database.'],
];

describe('smooth resolves an explicit self-correction', () => {
  for (const [raw, pol] of resolved) {
    it(`accepts: ${raw} -> ${pol}`, () => {
      expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: true, selfCorrection: true });
    });
    it(`strict still keeps both: ${raw} -> ${pol}`, () => {
      expect(checkMeaningPreserved(raw, pol, strict)).toMatchObject({ ok: false });
    });
  }
});

describe('the repair itself must survive', () => {
  const droppedRepair: [string, string][] = [
    ["let's meet at 2, no wait, 3", "let's meet at 2"],
    ['我们三点，不对，四点开会', '我们三点开会'],
    ['把文件发给李明，不对，发给张伟。', '把文件发给李明。'],
    ['Send it to Mark, sorry, I mean Martin, in finance.', 'Send it to Mark in finance.'],
    ["let's meet at 2, no wait, 3", "let's meet at 4"],
    ["I'll go, no wait, I won't go", "I'll go"],
  ];
  for (const [raw, pol] of droppedRepair) {
    it(`refuses: ${raw} -> ${pol}`, () => expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: false }));
  }
  it('more than the reparandum dropped is still refused', () => {
    expect(checkMeaningPreserved('Send the invoice to Mark, sorry, I mean Martin, in finance.', 'Send it to Martin.', smooth)).toMatchObject({ ok: false });
  });
});

describe('a marker used as an ordinary word is not a repair', () => {
  const ordinary = [
    'The fee is 50, I mean it.',
    '定在三点，我是说过的。',
    '这个方案不对，应该改成B方案。',
    'Actually, I think we should ship on Friday.',
    'No, we cannot ship this week.',
    'I broke the build, sorry, it is fixed now.',
    '他今天，不对劲，早点回去吧。',
  ];
  for (const raw of ordinary) it(`no reading: ${raw}`, () => expect(repairReadings(raw)).toEqual([]));

  // What accepting a non-corrective marker would let through.
  const harmful: [string, string][] = [
    ['The fee is 50, I mean it.', 'The fee is it.'],
    ['定在三点，我是说过的。', '定在过的。'],
    ['这个方案不对，应该改成B方案。', '应该改成B方案。'],
  ];
  for (const [raw, pol] of harmful) {
    it(`refuses: ${raw} -> ${pol}`, () => expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: false }));
  }
});

// NR-245 review: the reparandum is only the MINIMAL stretch the repair
// replaces — a retrace (starts with the repair's first word) or a
// substitution (starts with a token of the repair's kind, and everything
// after it is repeated in the repair). Markers inside quotes, and sorry /
// actually right after a sentence stop, are not repairs.
describe('review round: a self-correction licenses only the minimal reparandum', () => {
  const refused: [string, string][] = [
    ['Send the report to Alice, sorry, Bob.', 'Bob.'],
    ['Meet me at the north entrance of the library at 3, no wait, 4.', 'Meet me at 4.'],
    ['Our revenue grew 10%. Actually, profit grew 20%.', 'Our profit grew 20%.'],
    ['Add the quote "we shipped 2, no wait, 3 features" to the slide.', 'Add the quote "we shipped 3 features" to the slide.'],
    ['先给客户打电话确认合同，说错了，发邮件。', '发邮件。'],
    ['Tell Dave the server is down, sorry, slow.', 'Slow.'],
    // A bare "No" after a sentence stop is an answer as often as a repair:
    // "We need 4. No, 5 more engineers" cannot be told apart from these.
    ['We lost 4. No, 5 customers renewed.', 'We lost 5 customers renewed.'],
    ['The fix landed in build 4. No, 5 still crashes.', 'The fix landed in build 5 still crashes.'],
  ];
  for (const [raw, pol] of refused) {
    it(`refuses: ${raw} -> ${pol}`, () => expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: false }));
  }
  const accepted: [string, string][] = [
    ['Tell Dave the server is down, sorry, slow.', 'Tell Dave the server is slow.'],
    ['Send the report to Alice, sorry, Bob.', 'Send the report to Bob.'],
  ];
  for (const [raw, pol] of accepted) {
    it(`accepts: ${raw} -> ${pol}`, () => expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: true }));
  }
});

// Final review round: a repair that ADDS ("too", 也 / 还 / 都) keeps the
// reparandum in force, and single quotes quote like double quotes.
describe('final round: additive repairs and single quotes', () => {
  const refused: [string, string][] = [
    ['Send it to finance, no wait, send it to legal too.', 'Send it to legal too.'],
    ['Send it to finance, sorry, legal as well.', 'Send it to legal as well.'],
    ['发给李明，不对，发给张伟，两个人都要。', '发给张伟，两个人都要。'],
    ["Label it 'version 2, no wait, 3' on the slide.", "Label it 'version 3' on the slide."],
    ['Label it ‘version 2, no wait, 3’ on the slide.', 'Label it ‘version 3’ on the slide.'],
  ];
  for (const [raw, pol] of refused) {
    it(`refuses: ${raw} -> ${pol}`, () => expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: false }));
  }
  it("an apostrophe is not a quote: it's 2, no wait, 3 -> it's 3", () => {
    expect(checkMeaningPreserved("It's at 2, no wait, 3.", "It's at 3.", smooth)).toMatchObject({ ok: true });
  });
});

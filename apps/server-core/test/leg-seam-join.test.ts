// card SEAM-1 (NR-244 layer 1) — the joiner for two legs' text across a leg seam.
//
// SPEC-REF: src/stt/leg-seam-join.ts (the rule and its measurements).
// The left/right pairs are the ones measured through a local relay (EVAL-2, midpause4, polish off).

import { describe, expect, it } from 'vitest';
import { joinAtLegSeam } from '../src/stt/leg-seam-join';

describe('SEAM-1 — joinAtLegSeam', () => {
  it.each([
    // [left, right, joined]
    ['We should deploy the API to Kubernetes.', 'And pointed at the replica.', 'We should deploy the API to Kubernetes. And pointed at the replica.'],
    ['We grew from 3,400 users.', 'To 12,000 users in 6 weeks.', 'We grew from 3,400 users. To 12,000 users in 6 weeks.'],
    ['Ask Claude Code to refactor the parser', 'and use Cursor', 'Ask Claude Code to refactor the parser and use Cursor'],
    ['Is it ready?', 'Not yet.', 'Is it ready? Not yet.'],
    ['users,', 'then', 'users, then'],
    ['version 3', '4 is out', 'version 3 4 is out'],
  ])('Latin|Latin with no whitespace => one space: %j + %j', (l, r, out) => {
    expect(joinAtLegSeam(l, r)).toBe(out);
  });

  it.each([
    ['Tell Priya that the—', 'Anthropic invoice came in.', 'Tell Priya that the Anthropic invoice came in.'],
    ['Um, I think we should—', 'Uh, push the release.', 'Um, I think we should Uh, push the release.'],
    ['the —', 'Anthropic', 'the Anthropic'],
  ])('a trailing em dash before a continuing word is dropped: %j + %j', (l, r, out) => {
    expect(joinAtLegSeam(l, r)).toBe(out);
  });

  // Review of 2026-10-13: every other mark carries content and must survive the seam untouched.
  it.each([
    ['The answer is -', '5', 'The answer is -5'],
    ['pages 5-', '10', 'pages 5-10'],
    ['pages 5—', '10', 'pages 5—10'],
    ['COVID-', '19', 'COVID-19'],
    ['call 555-', '1234', 'call 555-1234'],
    ['run it with --', 'verbose', 'run it with --verbose'],
    ['a state-', 'of-the-art model', 'a state-of-the-art model'],
    ['we should–', 'ship', 'we should–ship'],
    ['we should-', 'ship', 'we should-ship'],
    ['we should…', 'ship', 'we should… ship'],
    ['we should...', 'ship', 'we should... ship'],
    ['pi is 3.', '14', 'pi is 3.14'],
  ])('a mark that is content is kept, and nothing splits a number: %j + %j', (l, r, out) => {
    expect(joinAtLegSeam(l, r)).toBe(out);
  });

  it('a trailing cut mark before punctuation is kept (nothing continues the phrase)', () => {
    expect(joinAtLegSeam('until it is—', '.')).toBe('until it is—.');
  });

  it.each([
    ['今天没有投票。', '投票会在周五', '今天没有投票。投票会在周五'],
    ['今天没有投票', '投票会在周五', '今天没有投票投票会在周五'],
    ['这个PR我已经', 'review过了', '这个PR我已经review过了'],
    ['我已经review', '过了', '我已经review过了'],
    ['It is done.', '然后上线', 'It is done.然后上线'],
    ['会议结束，', 'OK', '会议结束，OK'],
    ['東京に', 'いきます', '東京にいきます'],
    // Review of 2026-10-13: a CJK seam is byte-identical to plain concatenation; "——" / "……" are punctuation.
    ['我觉得——', '我们周五上线', '我觉得——我们周五上线'],
    ['你好——', '世界', '你好——世界'],
    ['他想了想……', '算了', '他想了想……算了'],
    ['你好—', 'World', '你好—World'],
    ['发布到 v2', '。', '发布到 v2。'],
  ])('a spaceless script on either side => nothing: %j + %j', (l, r, out) => {
    expect(joinAtLegSeam(l, r)).toBe(out);
  });

  it('Hangul is a spaced script', () => {
    expect(joinAtLegSeam('오늘 회의는', '취소됐어요')).toBe('오늘 회의는 취소됐어요');
  });

  it.each([
    ['already spaced ', 'right', 'already spaced right'],
    ['left', ' already spaced', 'left already spaced'],
    ['the (', 'draft', 'the (draft'],
    ['the draft', ', then', 'the draft, then'],
  ])('whitespace or bracket/punctuation at the seam => plain concatenation: %j + %j', (l, r, out) => {
    expect(joinAtLegSeam(l, r)).toBe(out);
  });

  it('empty halves', () => {
    expect(joinAtLegSeam('', 'And so on.')).toBe('And so on.');
    expect(joinAtLegSeam('Done.', '')).toBe('Done.');
    expect(joinAtLegSeam('', '')).toBe('');
    expect(joinAtLegSeam('—', 'And')).toBe('And');
  });
});

import { describe, expect, it } from 'vitest';
import { countMixedWords, rowWordCount } from './entry-metrics';

describe('countMixedWords', () => {
  it('counts CJK characters one by one', () => {
    expect(countMixedWords('你好世界')).toBe(4);
  });

  it('counts a Latin run as ONE word, not one per letter', () => {
    expect(countMixedWords('hello world')).toBe(2);
  });

  it('mixed CJK + Latin: each CJK char counts, each Latin run counts once', () => {
    // "今天 hello 天气" → 今 天 [hello] 天 气 = 5
    expect(countMixedWords('今天 hello 天气')).toBe(5);
  });

  it('empty / whitespace-only / null / undefined all count as 0', () => {
    expect(countMixedWords('')).toBe(0);
    expect(countMixedWords('   \n\t  ')).toBe(0);
    expect(countMixedWords(null)).toBe(0);
    expect(countMixedWords(undefined)).toBe(0);
  });

  it('numbers count; a punctuation-only run does not (CHANGED 2026-08-14: was 4)', () => {
    // 🔴 In-place correction (原地更正) 2026-08-14. Original assertion and its
    // reasoning, kept verbatim
    // because it recorded the behaviour of the day it was written:
    //   > "v0.2.36," is one run (1), 好 and 的 are one CJK char each (2), and the
    //   > trailing "!" — NOT absorbed into the preceding CJK char, because CJK chars
    //   > are consumed one at a time and only LATIN runs merge with each other — is
    //   > its own 1-char run (1). Total 4.
    // Every clause of that is still true EXCEPT the last: the lone "!" run is
    // still its own run, but a run with no letter and no digit now scores 0
    // rather than 1. "v0.2.36," keeps its 1 (it has letters and digits), so the
    // total moves 4 → 3. The new number is the right one: this row shows the
    // user "3 characters" (3 字) for three countable things — one token, two characters (字) — where it used
    // to count the exclamation mark as a fourth.
    expect(countMixedWords('v0.2.36, 好的!')).toBe(3);
  });

  it('a trailing punctuation mark adds nothing (CHANGED 2026-08-14: was 2)', () => {
    // 🔴 In-place correction (原地更正) 2026-08-14. This test used to be titled "documents the boundary
    // case: CJK punctuation splits an otherwise-adjacent Latin run" and asserted
    // 2, with this reasoning, kept verbatim:
    //   > "好的!" — 好/的 are CJK (2), "!" is latin-ish and adjacent to 的 with no CJK
    //   > between it and the previous char, so it is absorbed into a run starting at
    //   > "!" — this is the "not linguistically correct" corner case the header
    //   > comment calls out.
    // The splitting behaviour it documents is unchanged and still deliberate;
    // what changed is that the resulting punctuation-only run scores 0. So the
    // corner case the header called out is now half-closed: punctuation still
    // BREAKS a run, but it no longer INVENTS a word.
    expect(countMixedWords('好!')).toBe(1); // 好=1, "!"=0
  });

  it('🔴 a run with no letter and no digit counts 0 — it is not a word', () => {
    // The defect this closes: standalone CJK punctuation is not in the CJK class
    // (that class is ideographs and kana only), so it fell into the non-CJK-run
    // branch and scored 1 apiece. A row reading "！！！" reported "1 character".
    expect(countMixedWords('！！！')).toBe(0);
    expect(countMixedWords('，')).toBe(0);
    expect(countMixedWords('，。！？')).toBe(0);
    expect(countMixedWords('... ')).toBe(0);
    expect(countMixedWords('---')).toBe(0);
    // …and the same rule inside real text: four 字, two marks, four counted.
    expect(countMixedWords('你好。世界！')).toBe(4);
  });

  it('punctuation ABSORBED into a lettered run still scores that run once', () => {
    // The other half of the same rule, and the reason the guard tests the whole
    // RUN rather than each character: 「，world」 is a single run (the fullwidth
    // comma is not CJK and there is no space to break it), it contains letters,
    // so it scores 1. Total 3 — the same number as before this change, but now
    // for a reason that survives the comma being moved.
    expect(countMixedWords('你好，world')).toBe(3);
    // Move the comma off the word and the difference shows: it scores 0 alone,
    // where before 2026-08-14 this string counted 4.
    expect(countMixedWords('你好， world')).toBe(3);
  });

  it('🔴 non-ASCII Latin: accented letters count, they are not punctuation', () => {
    // Pinned because it is exactly what the ASCII-only mobile rule gets wrong
    // (apps/mobile/.../entry_metrics.dart counts only [0-9A-Za-z], so it reads
    // "Grüße" as two runs). `\p{L}` is what makes de/fr/es correct here.
    expect(countMixedWords('Grüße aus München')).toBe(3);
    expect(countMixedWords('¿Cómo estás?')).toBe(2);
  });

  it('🔴 Cyrillic counts as words, not as zero', () => {
    // Same reason, harder failure: under an ASCII-only letter class an entire
    // Russian utterance counts 0 — the row would say "0 characters" about text plainly
    // visible above it. ru shipped as a UI language 2026-08-14.
    expect(countMixedWords('привет мир')).toBe(2);
    expect(countMixedWords('Привет, мир!')).toBe(2);
  });

  it('a lone Japanese sentence counts one per glyph, same as Chinese', () => {
    expect(countMixedWords('こんにちは')).toBe(5);
  });

  it('🔴 Korean counts 어절 (space-delimited), NOT syllables — CHANGED 2026-08-14', () => {
    // Was 7 / 5. Modern Korean is written with spaces between words (띄어쓰기),
    // which is precisely what separates it from Chinese and Japanese; the unit
    // has a name — 어절 (eojeol), the spacing unit — and the translation
    // industry counts that. Counting Hangul syllables is the Korean equivalent
    // of counting English letters. Hangul syllables were therefore removed from
    // the `CJK` class. 🔴 This is a judgement call made under owner's
    // 2026-08-14 authorisation to research and correct counting conventions —
    // NOT a ruling owner issued, and it moves a number the user sees. Reversal
    // is one line; see §C of the file header.
    expect(countMixedWords('한국어 단어 세기')).toBe(3); // was 7
    expect(countMixedWords('안녕하세요')).toBe(1); // was 5
    // Korean mixed with Han keeps both rules: the Hangul run is one 어절, the
    // two ideographs are one 字 each.
    expect(countMixedWords('한자 漢字')).toBe(3);
  });

  it('the CJK class itself is unchanged — ideographs and kana still count per char', () => {
    // Boundary guard. Hangul left the class on 2026-08-14; nothing else did, and
    // this pins the ranges so a future edit cannot quietly take another block
    // with it. The compatibility-ideograph pair is written as backslash-u
    // escapes on purpose, and is deliberately not spelled out as literals in
    // this comment either: retyping U+F900 through anything that applies
    // Unicode NFC rewrites it to U+8C48, which moves the range while the line
    // still looks right. Measured hazard, 2026-08-14.
    expect(countMixedWords('㐀䶿')).toBe(2); // Extension A ends
    expect(countMixedWords('一鿿')).toBe(2); // Unified ideographs ends
    expect(countMixedWords('\uF900\uFADF')).toBe(2); // compatibility ideographs
    expect(countMixedWords('぀ヿ')).toBe(2); // kana ends
    expect(countMixedWords('ㇰㇿ')).toBe(2); // katakana phonetic ext
  });

  it('an emoji-only utterance counts 0 — knowingly accepted', () => {
    // A consequence of the letter-or-digit guard, written down rather than left
    // to surprise someone: an emoji is neither a character (字) nor a word (词), and 0 is the
    // honest answer for a length estimate whose unit is one of those two. The
    // row still renders its text; only the count says 0. Before 2026-08-14 this
    // scored 1. If a product decision ever wants emoji counted, this is the
    // test that has to change, and it should change deliberately.
    expect(countMixedWords('😀😀')).toBe(0);
    // …but an astral LETTER (Han Extension B, one surrogate pair) still counts:
    // the guard tests the run with the `u` flag, so it sees one \p{L}, not two
    // lone surrogates.
    expect(countMixedWords('\u{20BB7}')).toBe(1);
  });
});

describe('rowWordCount — the owner "each mode\'s final result" (各模式最终结果) criterion', () => {
  it('reads output_text, never source_text', () => {
    expect(
      rowWordCount({ output_text: 'hello world', entry_type: 'transcript' }),
    ).toBe(2);
  });

  it('an image row is always 0 — output_text there is a system descriptor, not speech', () => {
    expect(
      rowWordCount({ output_text: '图片 · PNG · 78 KB', entry_type: 'image' }),
    ).toBe(0);
  });

  it('an empty transcript row is 0 (renders nothing, never "0 字")', () => {
    expect(rowWordCount({ output_text: '', entry_type: 'transcript' })).toBe(0);
  });
});

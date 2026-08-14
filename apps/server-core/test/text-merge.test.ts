// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (interim = offlineAccum + onlineDraft)
//   apps/server-core/src/stt/text-merge.ts (F-2067/F-2069/F-2100)
//
// 🔴 WHY THIS FILE EXISTS AT ALL: `text-merge.ts` documents SIX branches and,
// until 2026-08-02 (L9), had ZERO tests anywhere in the repo
// (`grep -rn "mergeOnlineDraft\|mergeOverlap\|overlapLen" test/` → no hits).
// Every one of those branches is a silent behaviour — a wrong one shows up as
// duplicated or missing words on the user's screen and as nothing at all in a
// test run. The defect below was found by a LIVE drill against a real vendor,
// which is a very expensive way to learn something a unit test can hold.
//
// REVERSE CONTROL (run 2026-08-02, saw RED): deleting the revision branch from
// `mergeOnlineDraft` (the `commonPrefixLen` guard) turns the two 🔴 cases red —
//   AssertionError: expected 'The tribal chieftain called for th…' to be 'The tribal …'
// while every other case in this file stays green. That pairing is the point:
// the new branch must change ONLY the mid-string-revision shape.

import { describe, expect, it } from 'vitest';
import {
  commonPrefixLen,
  commonSuffixLen,
  foldConfirmedWithDraft,
  mergeCumulativeDraft,
  mergeOnlineDraft,
  mergeOverlap,
  overlapLen,
} from '../src/stt/text-merge';

describe('overlapLen / commonPrefixLen / commonSuffixLen', () => {
  it('overlapLen finds the longest suffix-of-left that is a prefix-of-right', () => {
    expect(overlapLen('今天天气', '天气很好')).toBe(2);
    expect(overlapLen('abc', 'xyz')).toBe(0);
    expect(overlapLen('', 'abc')).toBe(0);
  });
  it('commonPrefixLen / commonSuffixLen count characters, not words', () => {
    expect(commonPrefixLen('大家好，欢迎', '大家好 欢迎')).toBe(3);
    expect(commonSuffixLen('presented him with', 'handed him with')).toBe(11); // 'ed him with'
    expect(commonPrefixLen('abc', 'xyz')).toBe(0);
  });
});

describe('mergeOverlap (offline finals — accumulate the whole utterance)', () => {
  it('takes the cumulative statement when one extends the other', () => {
    expect(mergeOverlap('', '大家好')).toBe('大家好');
    expect(mergeOverlap('大家好', '')).toBe('大家好');
    expect(mergeOverlap('大家好', '大家好，欢迎')).toBe('大家好，欢迎');
    expect(mergeOverlap('大家好，欢迎', '大家好')).toBe('大家好，欢迎'); // retraction
  });
  it('trims the overlapping seam instead of doubling it', () => {
    expect(mergeOverlap('今天天气', '天气很好')).toBe('今天天气很好');
    expect(mergeOverlap('abc', 'xyz')).toBe('abcxyz'); // genuinely disjoint
  });

  // ── 🔴 THE OVERLAP FLOOR (OVERLAP_MIN_CHARS, W2/FB-6) ─────────────────────
  // Before this floor, a single coincidentally shared character was treated as
  // a real overlap and silently deleted — invisible in fluent Chinese. Real
  // rollover-replay overlaps restate many characters, never one, so raising
  // the floor to 2 cannot suppress a genuine overlap while it stops this loss.
  it('🔴 a 1-character suffix/prefix coincidence is NOT an overlap — nothing is deleted', () => {
    // Old behaviour (no floor) collapsed this to '他说了算了吧我们走' — one '算' gone.
    const merged = mergeOverlap('他说了算', '算了吧我们走');
    expect(merged).toContain('他说了算');
    expect(merged).toContain('算了吧');
  });
  it('🔴 a 1-character coincidence is NOT an overlap — second shape', () => {
    // Old behaviour (no floor) collapsed this to '这次先到这里面还有两个人' — one '里' gone.
    const merged = mergeOverlap('这次先到这里', '里面还有两个人');
    expect(merged).toContain('到这里');
    expect(merged).toContain('里面');
  });
  it('a genuine multi-character overlap is still trimmed at the seam', () => {
    expect(mergeOverlap('我们明天去北京', '北京很冷')).toBe('我们明天去北京很冷');
  });
});

describe('mergeOnlineDraft (live preview — the text the user watches)', () => {
  it('cumulative refinement REPLACES', () => {
    expect(mergeOnlineDraft('大家', '大家好')).toBe('大家好');
  });
  it('a retraction KEEPS the longer draft', () => {
    expect(mergeOnlineDraft('大家好', '大家')).toBe('大家好');
  });
  it('a sliding-window forward delta is trimmed at the seam', () => {
    expect(mergeOnlineDraft('今天天气', '天气很好')).toBe('今天天气很好');
  });
  it('a consolidated re-statement (long shared SUFFIX) REPLACES', () => {
    // FunASR emits one whole-span frame mid-span; appending it would double.
    expect(mergeOnlineDraft('欢迎使用语音输入系统', '大家好，欢迎使用语音输入系统')).toBe('大家好，欢迎使用语音输入系统');
  });
  it('a genuine brand-new tail delta APPENDS', () => {
    expect(mergeOnlineDraft('大家好', '欢迎使用')).toBe('大家好欢迎使用');
  });

  // ── 🔴 THE LIVE DEFECT (L9, 2026-08-02) ───────────────────────────────────
  // Verbatim from the drill against wss://stt-rt.soniox.com. Soniox restates the
  // WHOLE hypothesis every frame and may revise it mid-string; here it dropped a
  // comma 38 characters in. Old behaviour: APPEND ⇒ the sentence piled onto
  // itself and the drill printed it TRIPLED on screen.
  const SONIOX_A = 'The tribal chieftain called for the boy, and presented him with';
  const SONIOX_B = 'The tribal chieftain called for the boy and presented him with 50 pieces of gold';

  it('🔴 a MID-STRING REVISION of the same span REPLACES — it must never double', () => {
    const merged = mergeOnlineDraft(SONIOX_A, SONIOX_B);
    expect(merged).toBe(SONIOX_B);
    // Two assertions, deliberately not one: 「it equals the new hypothesis」 and
    // 「the opening does not appear twice」 are the same fact only while the code
    // is right. The second is what the user actually complains about.
    expect(merged.split('The tribal chieftain')).toHaveLength(2);
  });

  it('🔴 and it stays stable when the same revision arrives twice', () => {
    let d = mergeOnlineDraft('', SONIOX_A);
    d = mergeOnlineDraft(d, SONIOX_B);
    d = mergeOnlineDraft(d, `${SONIOX_B}.`);
    expect(d).toBe(`${SONIOX_B}.`);
    expect(d.split('chieftain')).toHaveLength(2);
  });

  // ── The guards on that branch, each falsified on its own ──────────────────
  it('guard: a SHORTER revision is ambiguous ⇒ old behaviour, never a silent truncation', () => {
    // Retracting vs. a delta that happens to restate the opening cannot be told
    // apart here, and dropping text on a guess is worse than the doubling.
    const shorter = 'The tribal chieftain called for a boy';
    expect(mergeOnlineDraft(SONIOX_A, shorter)).toBe(SONIOX_A + shorter);
  });

  it('guard: a one-character shared prefix is NOT a revision', () => {
    // 「好的」 vs 「好好学习天天向上」 share 50 % of the shorter string on one
    // character. Without the absolute floor this would throw 「的」 away.
    expect(mergeOnlineDraft('好的', '好好学习天天向上')).toBe('好的好好学习天天向上');
  });

  it('guard: a short shared prefix on long strings is NOT a revision either', () => {
    const a = '今天下午三点我们在会议室讨论方案';
    const b = '今天晚上八点他们在食堂吃饭聊天说地';   // shares only 「今天」
    expect(mergeOnlineDraft(a, b)).toBe(a + b);
  });

  it('degenerate inputs are unchanged', () => {
    expect(mergeOnlineDraft('', '')).toBe('');
    expect(mergeOnlineDraft('abc', '')).toBe('abc');
    expect(mergeOnlineDraft('', 'abc')).toBe('abc');
  });

  // Regression guard: this file's own L9 mid-string-revision tests above are
  // still exercising mergeOnlineDraft itself, unmodified. foldConfirmedWithDraft
  // (tested below) is a SEPARATE function added at the one call site that
  // produces the terminal transcript (orchestrator-core.ts flushFinal); it does
  // not reuse mergeOnlineDraft's revision/restatement branches, and the two
  // 🔴 SONIOX_A/SONIOX_B cases above must keep passing unchanged.
});

describe('🔴 mergeCumulativeDraft (INT-2 — an engine that DECLARED its interims are cumulative)', () => {
  // Device line, round 2, run C: one non-repeating 5 s sentence, played ONCE,
  // painted twice; the SERVER's own `utterance summary {"last_chars":34}` for a
  // ~13-character sentence is what pinned the doubling to this process.
  // The two strings below are that utterance's shape: SenseVoice punctuates as a
  // function of the whole span, so the sentence-final 「。」 becomes a clause 「，」
  // the moment more speech follows — a revision in the MIDDLE of the string.
  const RUN_C_A = '跟你说个事啊。';
  const RUN_C_B = '跟你说个事啊，明天下午。';

  it('🔴 the run-C revision REPLACES — this is the whole defect', () => {
    expect(mergeCumulativeDraft(RUN_C_A, RUN_C_B)).toBe(RUN_C_B);
  });

  it('🔴 …and the CONTRAST is why the declaration exists, not a tuned threshold', () => {
    // The same two strings through the guessing merge. This assertion is not
    // testing a bug — it PINS the reason the two functions are two functions:
    // `mergeOnlineDraft` has to decide from similarity alone, and on short CJK
    // clauses every one of its branches declines (shared prefix 6 < 8; overlap
    // 0; shared suffix 1 「。」 with 1×4 < 7) so it appends. Nothing is broken in
    // it; it is answering a question that cannot be answered from the strings.
    expect(mergeOnlineDraft(RUN_C_A, RUN_C_B)).toBe(RUN_C_A + RUN_C_B);
    // ⚠️ If someone ever "fixes" mergeOnlineDraft by loosening a threshold, this
    // line goes red and they must come here and read why that is the wrong lever
    // — the six undeclared engines are governed by those thresholds, and each is
    // pinned above by real speech it protects.
  });

  it('🔴 POSITIVE CONTROL: a sentence genuinely said twice is NOT collapsed', () => {
    // The doubled text is INSIDE one cumulative frame, because the recognizer
    // heard the sentence twice. Believing the frame preserves the repetition;
    // it was concatenating frames that invented one. Nothing in this function
    // compares the two strings for similarity, so there is no mechanism by
    // which repeated speech could be dropped (dropped characters = owner's one-vote veto).
    const saidTwice = '跟你说个事啊，跟你说个事啊。';
    expect(mergeCumulativeDraft(RUN_C_A, saidTwice)).toBe(saidTwice);
    expect(mergeCumulativeDraft(RUN_C_A, saidTwice).split('跟你说个事啊')).toHaveLength(3);
  });

  it('a plain extension replaces (the common case)', () => {
    expect(mergeCumulativeDraft('你好我是', '你好我是小明')).toBe('你好我是小明');
  });

  it('🔴 a RETRACTION keeps the draft — the words already read stay put', () => {
    // The one guard that survives the declaration. Round 2 verified 「the prefix is not rewritten」
    // green on the device under the old code, whose `draft.startsWith(next)`
    // branch produced exactly this; the fix must not change a property that was
    // measured in order to fix one that does not require changing it.
    expect(mergeCumulativeDraft('你好我是小明', '你好我是')).toBe('你好我是小明');
  });

  it('a DIVERGENT shorter frame is a real revision and is believed', () => {
    // Not a prefix of the draft ⇒ the engine changed its mind about the words,
    // not merely about how many of them it has. Believing the newest hypothesis
    // is the definition of 「cumulative」.
    expect(mergeCumulativeDraft('预算是三百万', '预算是五百')).toBe('预算是五百');
  });

  it('degenerate inputs are identities', () => {
    expect(mergeCumulativeDraft('', '')).toBe('');
    expect(mergeCumulativeDraft('abc', '')).toBe('abc');
    expect(mergeCumulativeDraft('', 'abc')).toBe('abc');
  });
});

describe('foldConfirmedWithDraft (terminal transcript — confirmed text folded with the live draft)', () => {
  it('confirmed empty → draft', () => {
    expect(foldConfirmedWithDraft('', '大家好')).toBe('大家好');
  });
  it('draft empty → confirmed', () => {
    expect(foldConfirmedWithDraft('大家好', '')).toBe('大家好');
  });
  it('draft.startsWith(confirmed) → draft (cumulative engine, lossless)', () => {
    expect(foldConfirmedWithDraft('今天天气', '今天天气不错')).toBe('今天天气不错');
  });
  it('confirmed.startsWith(draft) → confirmed (nothing new in the draft)', () => {
    expect(foldConfirmedWithDraft('大家好，欢迎', '大家好')).toBe('大家好，欢迎');
  });
  it('disjoint spans → concatenate', () => {
    expect(foldConfirmedWithDraft('大家好', '欢迎使用')).toBe('大家好欢迎使用');
  });

  it('the cumulative-engine branch does not duplicate the confirmed text', () => {
    // Soniox-shaped draft: it already contains everything confirmed, so
    // replacing must not ALSO concatenate ('今天天气' + '今天天气不错').
    expect(foldConfirmedWithDraft('今天天气', '今天天气不错')).toBe('今天天气不错');
  });

  // ── 🔴 THE REGRESSIONS THIS FUNCTION EXISTS TO FIX (W2/FB-6) ──────────────
  // Real, disjoint speech — an enumeration, a negation, two different numbers.
  // Measured on the previous implementation (mergeOnlineDraft reused here),
  // every one of these collapsed to ONLY the second string; see this file's
  // own docstring in text-merge.ts for the "measured on the previous
  // implementation" table these cases are taken from verbatim.
  //
  // 🔴 W2-14/A-13 CORRECTION (2026-08-06): these five used to assert with
  // `toContain`, which cannot fail on a DOUBLING implementation — something
  // that emits `confirmed + draft + draft` still contains every substring a
  // `toContain` check looks for, so it passed this file undetected. Only the
  // exact-equality test above ("does not duplicate the confirmed text") was
  // saving this from being a real gap. Every assertion below now pins the
  // full, exact expected string (`confirmed + draft`, the disjoint-span
  // concatenation rule this function documents) with `toBe`, so a doubling
  // regression fails HERE too, not only in one unrelated test above it.
  // Reverse control run 2026-08-06, saw RED: temporarily making
  // `foldConfirmedWithDraft` return `confirmed + draft + draft` turned all
  // five red (e.g. expected '…完成了' to be '…完成了第二部分已经完成了' — the
  // doubled tail is right there in the diff); reverted byte-for-byte, `git
  // diff` on text-merge.ts empty, all five green again.
  it('🔴 an enumeration: both parts must survive, not just the second', () => {
    const merged = foldConfirmedWithDraft('第一部分已经完成了', '第二部分已经完成了');
    expect(merged).toBe('第一部分已经完成了第二部分已经完成了');
  });
  it('🔴 a negation must survive — it must not read as its opposite', () => {
    const merged = foldConfirmedWithDraft('他说这个方案不可行', '这个方案可行');
    expect(merged).toBe('他说这个方案不可行这个方案可行');
  });
  it('🔴 two different numbers must both survive', () => {
    const merged = foldConfirmedWithDraft('预算是三百万人民币', '预算是五百万人民币');
    expect(merged).toBe('预算是三百万人民币预算是五百万人民币');
  });
  it('🔴 English negation must survive too — this is not CJK-specific', () => {
    const merged = foldConfirmedWithDraft('I said we should not ship it today', 'we should ship it today');
    expect(merged).toBe('I said we should not ship it todaywe should ship it today');
  });
  it('🔴 a correction between two nouns: both must survive', () => {
    const merged = foldConfirmedWithDraft('请把门关上', '请把窗关上');
    expect(merged).toBe('请把门关上请把窗关上');
  });
});

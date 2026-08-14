// SPEC-REF:
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4 owner's already-ruled criteria (owner 已裁的口径) ②⑧
//     ("word-count criterion = each mode's final result" (字数口径 = 各模式最终结果); "show per-entry transcription duration + word count" (逐条显示转录时长 + 字数))
//
// owner 2026-08-01 ruled "show per-entry transcription duration + word count"
// ——**this card (lane C-4) does word count only**.
// Duration has no data source: the lead controller already checked
// packages/protocol/src/protocol-schemas-inject.ts's 卡 P's six additive
// fields (created_at / source_text / entry_type / thumb_b64 / …), and
// duration is not among them; with no data source the client is not allowed
// to fabricate one (estimating / deriving from word count / subtracting
// arrival times are all forbidden) — the PC row's duration must wait for a
// protocol round (owner gate + relay sync deployment).
//
// 🔴 The per-row numbers and the future C2 aggregate statistics must share
// one source (aggregate = sum of the per-row values, one algorithm, two
// display granularities) —— so this file is the repo's sole implementation:
// when C2 lands it should import `countMixedWords` / `rowWordCount` and sum
// them row by row, never start a second algorithm (grep proof: at the time
// this card ships, this is the only `countMixedWords` in the whole repo).
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS NUMBER IS — section added 2026-08-14 on the owner ruling of that
//    day, verbatim: "it must be emphasized in the relevant explanation that
//    word-count or TOKEN calculations will differ due to the language / the
//    LLM provider's algorithm" (要在相关的说明要强调，字数或TOKEN的计算会因为语种/LLM提供方的算法出现差异).
//
//    Everything above this line still stands. This section says out loud what
//    the number means now that the product ships in NINE UI languages
//    (packages/protocol/src/locales.ts: en, zh-CN, zh-TW, fr, es, de, ja, ko,
//    ru — four scripts). A rule that was a defensible approximation for two
//    languages has to declare its own limits for nine.
//
// ── A. IT IS A LENGTH ESTIMATE, NOT A LINGUISTIC FACT, AND IT IS NOT
//       COMPARABLE ACROSS LANGUAGES ──────────────────────────────────────────
//    The same utterance counted in Chinese and in German yields two numbers
//    that measure DIFFERENT THINGS: a 字 (one ideograph) versus a
//    whitespace-delimited token. "12" on a Chinese row and "12" on a German
//    row are not the same quantity, and printing them in one column does not
//    make them one. Two binding consequences:
//      · nothing in the product may present two languages' counts as
//        COMPARABLE — no cross-language ranking, no "your English said 40%
//        less than your Chinese" (你的英文比中文少说了 40%), no breakdown along a LANGUAGE axis that invites two columns to
//        be read against each other;
//        ⚠️ Summing is a different act and stays allowed, said out loud here
//        so this rule cannot be read as condemning something already shipped:
//        the word-count (字数) tile in main-window/components/TimelineStats.vue is
//        Σ rowWordCount over whatever this PC holds, and it answers "how much
//        content has accumulated on this PC" (这台电脑上攒了多少内容) — a SIZE question, the same shape as the text-volume (文字体积) /
//        image-volume (图片体积) tiles beside it, and its existing per-device grouping is a
//        device axis, not a language one. The day that total grows a
//        per-language split is the day this rule bites;
//      · 🔴 nothing may derive BILLING or QUOTA from this number. A price
//        measured in "words" would charge two users differently for the same
//        speech because of the language they spoke it in. Quota lives on
//        MINUTES and TOKENS (packages/protocol src/billing/plans.ts) — that is
//        not an accident, and this function must not become a second answer to
//        a question that already has one.
//    The same caveat runs one layer up and harder for TOKENS: a token is
//    whatever a given vendor's tokenizer says it is. The same sentence is a
//    different number of tokens on two providers, and a different number again
//    per language on the SAME provider (non-Latin scripts generally cost more
//    tokens per character than English). A token figure means nothing without
//    the provider and model that produced it printed beside it.
//
// ── B. THE INDUSTRY HAS NO SINGLE ANSWER; DO NOT GO LOOKING FOR ONE ─────────
//    GMX-V 1.0 (LISA/OSCAR's word- and character-count metrics standard) is the
//    one standard that addressed this head-on, and its answer was to DECLINE:
//    it does not define a "word" for CJK, and falls back to character counts
//    under Unicode UAX #29 grapheme-cluster boundaries. Commercial CAT tools
//    landed in the same place in product form — they ship TWO counters side by
//    side (non-Asian words + Asian characters) rather than one reconciled
//    number; Microsoft Word's `wdStatisticFarEastCharacters` IS that second
//    counter.
//    ⇒ This file's rule is not "worse than the standard"; there is no standard
//    for it to be worse than. What follows is only that the number must be
//    labelled honestly (§A) — never that it should be tuned until it looks
//    universal.
//
// ── C. KOREAN: CHANGED 2026-08-14 (7 → 3), AND WHY ─────────────────────────
//    Hangul syllables (U+AC00–U+D7A3) used to sit in the `CJK` class below, so
//    every Korean syllable scored 1 — the same treatment as a Han ideograph.
//    That was wrong in a way the other members of that class are not: modern
//    Korean IS WRITTEN WITH SPACES BETWEEN WORDS (띄어쓰기). Counting syllables
//    there is the Korean equivalent of counting English LETTERS, not English
//    words. Korean has a name for the space-delimited unit — 어절 (eojeol) —
//    and the translation industry counts that.
//    MEASURED: 「한국어 단어 세기」 scored 7 before this change and scores 3
//    after; 「안녕하세요」 scored 5 and now scores 1.
//    🔴 THIS IS A JUDGEMENT CALL MADE UNDER OWNER'S 2026-08-14 AUTHORISATION
//    ("if it's not reasonable, you need to first consult online resources to
//    confirm the conventional word-counting practice for different
//    languages", 如果不合理，你需要先查阅网络资料，确认不同语种对于字数的计算惯例), NOT A
//    RULING OWNER ISSUED. It is written out at this length precisely so that
//    reversing it is one line — put `가-힣` back in the class — with the
//    reasoning already on the page.
//    ⚠️ It is a VISIBLE BEHAVIOUR CHANGE: a Korean row's number moves. It is
//    cheap TODAY only because the Korean UI locale shipped hours before it and
//    there is no Korean usage to invalidate. That reason expires.
//    Han ideographs, kana and CJK compatibility ideographs STAY per-character:
//    Chinese and Japanese genuinely have no inter-word spaces, so there is no
//    space-delimited unit to count in the first place.
//
// ── D. PUNCTUATION-ONLY RUNS NOW COUNT 0 (changed 2026-08-14) ──────────────
//    See the in-place correction (原地更正) block on `countMixedWords` below for the measured
//    before/after. Short version: a standalone "，" or "！！！" used to score
//    1 apiece, because CJK punctuation is not in the `CJK` class and so fell
//    into the non-CJK-run branch.
//
// ── E. THE MOBILE FILE IS THE SAME RULE — A CHANGE HERE IS A CHANGE THERE ───
//    apps/mobile/lib/src/timeline/entry_metrics.dart (`textWordCount`).
//    Both files used to claim to be 「THE ONE implementation for this repo」
//    while disagreeing on 13 of 23 sample inputs: the mobile rule counts only
//    ASCII letters and digits, so it returns 0 for all-Cyrillic text and drops
//    accented Latin letters. Mobile is converging ONTO this file's rule, the
//    Hangul decision included — the whitespace-delimited branch is what
//    generalises to Cyrillic and accented Latin, and 어절 counting is part of
//    that one shared rule, not a desktop-local tweak.
//    🔴 The two are now ONE rule expressed in two languages: editing either
//    without the other re-opens the disagreement. The per-end allowance in
//    docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.1-a
//    ("the same utterance may give a different word count on the phone
//    versus on the PC", 同一句话在手机和 PC 上可以给出不同的字数) is about the two ends owning
//    DIFFERENT ROWS — never about the two ends counting the same string
//    differently.
// ═══════════════════════════════════════════════════════════════════════════

/** CJK ideographic/syllabic scripts (CJK 表意/音节文字): CJK Unified Ideographs
 *  + Compatibility Ideographs + Hiragana/Katakana
 *  (including the Katakana Phonetic Extensions) + Korean syllables. Each counts as 1 "character" (字).
 *
 *  🔴 In-place correction (原地更正) (2026-08-14): the line above, "+ Korean
 *  syllables" (+ 韩文音节), no longer describes this constant——
 *  Hangul syllables (U+AC00–U+D7A3) were REMOVED from this class; Korean now
 *  goes through the whitespace-delimited branch (어절), alongside Latin and
 *  Cyrillic. Original text kept, not deleted: it was true when written (原文保留不删：它写下时是真的). Reasoning and the measured 7→3 are
 *  in §C of the file header.
 *
 *  ⚠️ EDITING HAZARD, measured 2026-08-14: two of the literal characters in
 *  this class are CJK COMPATIBILITY ideographs (U+F900 / U+FADF). Retyping
 *  them through anything that applies Unicode NFC silently rewrites them to
 *  their canonical equivalents (U+F900 → U+8C48), which moves the range
 *  without changing what the line looks like. Edit around this literal, never
 *  through it. */
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ]/;

/** A non-CJK run has to carry at least one letter or digit to score 1.
 *
 *  🔴 Unicode property escape, NOT `[A-Za-z0-9]`: the ASCII class is exactly
 *  the mistake the mobile implementation makes — it drops the `ü` in 「Grüße」
 *  and every letter of 「привет」, so an all-Cyrillic utterance counts 0.
 *  `\p{L}` covers all nine shipped UI languages' letters (and any tenth),
 *  `\p{N}` all digit forms. Target is ES2022 (tsconfig.base.json), so the `u`
 *  flag and property escapes are plain language features here. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Mixed Chinese-English word count (中英混排字数)——owner did not rule on the exact
 *  algorithm word-for-word; this card's criteria are written here (for review/tests to pin down):
 *
 *  · a run of consecutive CJK characters, each counts as 1;
 *  · everything else non-whitespace (Latin letters, digits, most
 *    punctuation……) is split on whitespace, and each non-empty segment
 *    counts as 1 "word" (词) — this is the conventional treatment
 *    Chinese-context "word count" (字数) gives to Western text (e.g. WeChat
 *    official-account backend word counts): one English word counts as 1,
 *    not counted letter by letter;
 *  · pure whitespace does not count.
 *
 *  This is not a word-segmentation algorithm, it is a cheap, deterministic,
 *  testable approximation — it only answers "roughly how long is this one",
 *  and makes no promise of linguistic correctness (for example, CJK
 *  punctuation gets folded into an adjacent Western-text segment and counted together).
 *
 *  🔴 In-place correction (原地更正) (2026-08-14) —— half of the second bullet
 *  above and half of the closing sentence's parenthetical have each been
 *  overturned; original text kept, not deleted.
 *
 *  ① A non-CJK run now scores 1 ONLY IF it carries at least one letter or
 *     digit ([LETTER_OR_DIGIT]). "everything else non-whitespace……each
 *     non-empty segment counts as 1" was true
 *     when written, and the closing sentence above half-admitted to what it cost: it says
 *     CJK punctuation gets absorbed INTO an adjacent Latin run — the benign
 *     half. The half it does not mention is that a punctuation run with nothing
 *     adjacent STOOD ALONE and scored 1, so a row reading "！！！" reported
 *     "1 character" and "你好。世界！" (Hello. World!) reported 6 for four characters (字).
 *     MEASURED before → after: "！！！" 1 → 0; "..." 1 → 0; "---" 1 → 0;
 *     "你好。世界！" (Hello. World!) 6 → 4; "好!" (Good!) 2 → 1; "v0.2.36, 好的!" (v0.2.36, okay!) 4 → 3;
 *     "你好， world" (hello, world) 4 → 3.
 *     MEASURED unchanged, and pinned by tests anyway because they are the cases
 *     the ASCII-only mobile rule gets wrong: "Grüße aus München" 3,
 *     "привет мир" 2, and "你好，world" (hello, world) 3 — in that last one the "，" sits
 *     INSIDE the "，world" run, which has letters, so the run still scores 1.
 *     The absorbing half of the closing sentence is still true and still deliberate.
 *     ⚠️ Knowingly accepted: an emoji-only or symbol-only utterance now counts
 *     0 rather than 1. "0" is the honest answer for a length estimate whose
 *     unit is character/word (字/词) — neither is present — and the row still renders its text.
 *
 *  ② Korean no longer counts per syllable: "한국어 단어 세기" 7 → 3. See §C of
 *     the file header for the reasoning, the authorisation it rests on, and
 *     the one-line reversal. */
export function countMixedWords(text: string | null | undefined): number {
  if (text === null || text === undefined || text === '') return 0;
  let count = 0;
  let i = 0;
  const len = text.length;
  // `.charAt(i)` (never bracket indexing `text[i]`): under `noUncheckedIndexedAccess`
  // the latter types as `string | undefined`, and `.charAt` on an in-bounds index
  // returns a plain `string` — no non-null assertion needed for a loop already
  // bounded by `i < len`.
  while (i < len) {
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (CJK.test(ch)) {
      count += 1;
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < len && !/\s/.test(text.charAt(j)) && !CJK.test(text.charAt(j))) j += 1;
    // The whole run is tested at once (not char by char): 「，world」 is one run
    // and scores 1 because it contains letters, while 「！！！」 scores 0 because
    // it contains none. Testing the slice rather than accumulating a flag also
    // keeps astral letters (a surrogate pair is two `charAt` steps but one
    // `\p{L}` match under the `u` flag) counting as the letters they are.
    if (LETTER_OR_DIGIT.test(text.slice(i, j))) count += 1;
    i = j;
  }
  return count;
}

/** The row's word count under owner's "each mode's final result" (各模式最终结果) criterion (§4-2 ②): `output_text` —
 *  the rendered `.txt` value (== the delivered/display face; for translate/organize it
 *  is the PROCESSED text) — never `source_text` (the collapsible original-text (原文) side panel, which
 *  is a different column and not "this entry's result").
 *
 *  Image rows return 0 unconditionally (a judgment call, not an owner ruling — flagged
 *  here for review): `output_text` on an image row is a system descriptor, not
 *  transcribed speech, and counting it as "word count" would answer a question nobody asked.
 *
 *  REQ-12-13: a `'control'` row (a remote key press) counts 0 for the same reason,
 *  and structurally cannot count anything else — its `output_text` is `''` because
 *  the face is composed at render time from `control_kind`. It is named here anyway
 *  rather than left to fall through: a test that only checks the empty string would
 *  keep passing on the day someone gives control rows a stored face, and the count
 *  would silently start including keypresses. Written POSITIVELY on `transcript` so
 *  a fourth kind cannot fail open into the statistics. */
export function rowWordCount(
  row: { output_text: string; entry_type: 'transcript' | 'image' | 'control' },
): number {
  if (row.entry_type !== 'transcript') return 0;
  return countMixedWords(row.output_text);
}

/** The row's speaking duration in ms, or null (0.2.43, owner "voice duration must be brought back" (语音时长要找回来)).
 *
 *  🔴 THE row-level duration function — the aggregate (lib/portable/inventory.ts)
 *  and the per-row chip both consume THIS, never `row.duration_ms` raw, so
 *  "aggregate = sum of the per-row values" (聚合＝逐行之和) holds for time exactly as it does for words (§4b-8). Absent
 *  and malformed both read null: "no duration" (没有时长) is a value, never a guess of 0
 *  (book 16 §6.1 — null must never be treated as 0 when added into the total, null 绝不当 0 加进合计). */
export function rowDurationMs(row: { duration_ms?: number | null }): number | null {
  const d = row.duration_ms;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 ? d : null;
}

/** `0.4s` / `42s` / `12:05` — the SAME display grammar the phone's
 *  formatEntryDuration uses (apps/mobile lib/src/timeline/entry_metrics.dart),
 *  kept character-for-character so one utterance reads identically on both ends.
 *  Hand-built, no locale (red line: UI does not follow OS locale, UI 不跟随 OS locale 红线). */
export function formatRowDuration(durationMs: number): string {
  const ms = durationMs < 0 ? 0 : durationMs;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

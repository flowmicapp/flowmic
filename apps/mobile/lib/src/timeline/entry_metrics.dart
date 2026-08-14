// SPEC-REF:
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4-2 (word-count
//     basis = each mode's final result: original text by its own words,
//     translate/organize by the post-transform word count), §4b-8 (show
//     per-row transcription duration + word count; the live window updates
//     dynamically while transcribing; per-row figures and the C2 aggregate
//     stats must share one source — aggregate = sum of the rows, one algorithm
//     at two display granularities)
//
// THE ONE word-count implementation for this repo. [textWordCount] is the
// core algorithm; every other call site — [entryWordCount] here, the live
// in-flight draft in chat_message_tile.dart's `LiveDraftTile`, and (per §4b-8)
// the future C2 aggregate statistics — MUST call THIS function rather than
// re-deriving a count. Do not add a second `.length` / `.split(' ').length`
// anywhere else in the app; grep `textWordCount` before writing a new one.
//
// ── word-count judgement call (owner did not specify one; this file is where
//    it is pinned) ──────────────────────────────────────────────────────────
// Mixed CJK/Latin text has no single obvious count. This file uses the
// convention most Chinese word processors default to for 「字数统计」 ("word count"):
//   · each CJK character (Han ideographs, Hiragana, Katakana, Hangul
//     syllables) counts as ONE unit on its own — a "字";
//   · a run of ASCII letters/digits counts as ONE unit for the whole run — a
//     "词" ("hello" = 1, not 5);
//   · whitespace and punctuation (CJK or ASCII) contribute nothing.
// So "你好 world 123" = 你(1) + 好(1) + world(1) + 123(1) = 4. Pinned by
// entry_metrics_test.dart — if this rule ever needs to change, that is a
// product decision (it changes what every row AND the future aggregate say),
// not a drive-by edit.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 CORRECTION IN PLACE (2026-08-14) — two of the three rules above are false
//    today, though they were true when written.
//    Not a single character of the original is deleted: this repo's convention
//    is to correct in place, not overwrite history.
//
//    The trigger: the product went from 4 UI languages to 9 (en, zh-CN, zh-TW,
//    fr, es, de, ja, ko, ru — packages/protocol/src/locales.ts). An
//    approximation that held up for two languages has to state its own
//    boundaries once it reaches nine.
//
// ── A. The SECOND rule overturned: 「ASCII letters/digits」 is a defect that
//    **returns 0** ──────────────────────────────────────────────────────────
//    `_isWordRune` only recognized `0-9A-Za-z`, so every Cyrillic character
//    fell through to the else branch ⇒ **a pure-Russian sentence's word count
//    was permanently 0**. And `i18n/mobile/ru.json` had already shipped with
//    「$n слов」: a Russian user would see `0 слов` on every row, the
//    live-draft counter would be permanently stuck at 0, and the stats page
//    would also read 0. CLAUDE.md and 16 册 §6.1's red line explicitly bans
//    this exact shape — **a figure that is permanently zero reads, to the
//    user, as 「I haven't said a single word this month」**.
//    Accented Latin letters break the same way: `Grüße` counted as 2,
//    `München` counted as 2, because `ü` splits one word into two pieces.
//    ⇒ The fix is to **converge on the desktop's rule**, not invent a third
//    one: non-CJK text splits on whitespace, and that rule naturally
//    generalizes to Cyrillic and accented Latin.
//
// ── B. The FIRST rule overturned: Korean syllables are **no longer** counted
//    1 per character ───────────────────────────────────────────────────────
//    Korean is written **with word spacing** — that is precisely the line that
//    separates it from Chinese/Japanese, and the translation industry counts
//    it the same way, by spaces, with the unit called **어절 (eojeol)**.
//    Counting Korean by syllable is the same mistake as counting English by
//    letter.
//    Measured: `한국어 단어 세기`: 7 → 3.
//
// ── C. Punctuation standing alone counts 0 — and on **this file** that is a
//    mechanism convergence, not a change in numbers ─────────────────────────
//    A non-CJK run needs to contain **at least one letter or digit** to count
//    as 1.
//    ⚠️ 🔴 **This rule changed not a single number on the mobile side — stated
//    plainly so the next person does not cite the wrong evidence for it**:
//    measured (this machine), `！！！` / `...` / `---` were **already 0 under
//    the OLD algorithm** — the old algorithm walked rune by rune, punctuation
//    fell through to the else branch, and there was never a concept of "a
//    punctuation RUN" — so it never had this defect.
//    The one WITH this defect is the **desktop's** copy (it splits by segment,
//    and a segment of pure punctuation counted 1; measured there:
//    `！！！` 1 → 0, `你好。世界！` 6 → 4).
//    This file adopts this rule so the two ends run **the SAME rule**, rather
//    than two rules that happen to agree — that is exactly what §F is about.
//    Measured on mobile, unchanged: `你好，world` 3 → 3,
//    `你好， world` 3 → 3, `！！！` 0 → 0.
//    ⇒ **This passage was moved over from the desktop's own ledger, and in the
//    move it very nearly carried the desktop's numbers along with it. A delta
//    measured somewhere else, written down here, becomes a false statement
//    about THIS file.**
//
// ── D. 🔴 owner's own words, 2026-08-14, on what this number IS ─────────────
//    「要在相关的说明要强调，字数或TOKEN的计算会因为语种/LLM提供方的算法出现
//    差异。」 ("wherever this is explained, it must be emphasized that word or
//    token counts will vary because of algorithm differences between
//    languages / LLM providers.")
//    ⇒ **It is a LENGTH ESTIMATE, not a linguistic fact; word counts between
//    two languages are NOT comparable.** The same sentence, in Chinese, counts
//    「字」 (one ideograph at a time); in German, counts 「a run cut on
//    whitespace」 — the 12 on a Chinese row and the 12 on a German row **are
//    not measuring the same kind of thing**, and putting them side by side in
//    one column does not make them the same kind of thing. Two hard
//    constraints:
//      · nowhere in the product may two languages' word counts be presented
//        **as if comparable** — no cross-language ranking, no 「your English
//        was 40% shorter than your Chinese」, no splitting statistics along
//        the **language** axis;
//        ⚠️ **Summing is a different matter and remains allowed** (stated
//        plainly so this is not read as an accusation against something
//        already shipped): the stats page's figure is a Σ over this device's
//        rows, answering 「how much content has piled up on this machine」 —
//        a **volume** question, the same shape as the text-size / image-size
//        figures next to it. The day that total grows a **per-language**
//        breakdown, this constraint kicks in;
//      · 🔴 this number must never be used to derive **billing or quota**.
//        Pricing by 「word」 would charge different amounts for the same
//        content depending on which language the user happened to speak.
//        Quota lives on **minutes** and **tokens** (`billing/plans.ts`), and
//        that is not an accident.
//    The same warning applies even more strongly to **tokens**: a token is
//    whatever a given vendor's tokenizer says it is — the same sentence is two
//    different numbers across two vendors, and a different number again per
//    language within the same vendor. A token count, printed without the
//    vendor and model that produced it right next to it, means nothing.
//
// ── E. The industry has no single answer — don't go looking for one ─────────
//    GMX-V 1.0 (LISA/OSCAR's word-count measurement standard) is the only
//    standard that has ever tackled this head-on, and its answer is to
//    **refuse to answer**: it does not define 「word」 for CJK at all, and
//    falls back to counting UAX #29 grapheme clusters as characters.
//    Commercial CAT tools land in the same place at the product level — they
//    show **two** separate counters side by side (a word count for non-Asian
//    languages + a character count for Asian languages), rather than one
//    reconciled number; Word's `wdStatisticFarEastCharacters` is exactly that
//    second counter.
//    ⇒ This file's rule is not 「worse than the standard」 — **there is no
//    standard for it to be worse than**. The only thing that follows from
//    this is §D's rule (label the number honestly), and certainly not 「keep
//    tuning it until it looks universal」.
//
// ── F. 🔴 The desktop's copy is **the SAME rule** — editing this one means
//    editing that one too ───────────────────────────────────────────────────
//    `apps/desktop/src/lib/entry-metrics.ts`'s `countMixedWords`. The two
//    files used to **each claim to be 「the repo's one and only
//    implementation」**, and across 23 samples they disagreed on 13. As of
//    today the two converge on the same rule (Korean's rule included).
//    Editing one of them without touching the other reopens that exact
//    divergence.
//    ⚠️ 16 册 §6.1-a's sentence 「同一句话在手机和 PC 上可以给出不同的字数」
//    ("the same sentence CAN give a different word count on phone vs. PC")
//    is about **the two ends each owning different ROWS**, and never meant
//    「the two ends can count the same string into different numbers」.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── duration ─────────────────────────────────────────────────────────────
// [formatEntryDuration] is deliberately a SEPARATE function from
// time_label.dart / recording_panel.dart's `formatElapsed`: those two answer
// "when" and "how long has the mic been open right now" respectively, at
// whole-second granularity (nobody reads sub-second precision off a live
// timer). A landed row's spoken duration is a one-time fact that can
// genuinely be under a second, and collapsing that into "00:00" would make a
// real recording look like the CLAUDE.md-forbidden "0 秒" (a value present but
// rendered as if absent) — so this file keeps a decimal-second branch under
// 1s that recording_panel.dart has no reason to carry.
//
// ── null handling (RED LINE: no data source ⇒ no render, never a fabricated
//    zero) ─────────────────────────────────────────────────────────────────
// `TimelineEntry.durationMs` is `null` on any row the STT engine did not
// stamp a real duration onto (chat_utterance_settle.dart symbol `_settleSpan`:
// `spanMs > 0 ? spanMs : null` — 「没有一段报过时长」 ("no span ever reported a
// duration") is ALREADY coerced to null
// at the write site, so by the time a value reaches this file it is a genuine
// positive fact or absent; there is no live "0ms" case to special-case here).
// 🔴 CORRECTION IN PLACE (N1-B2, 2026-08-08): this used to quote the write site as
// `f.durationMs > 0 ? f.durationMs : null`. That was true when it was written
// and is now false — the row's number is a SUM over the spans it covers, not a
// copy of the frame's field, because `24b75cc` made that field answer 「这一段有
// 多长」 ("how long THIS span was") (REG-D1). The original text is kept in this
// sentence, not deleted: anti-façade ④ names exactly this shape — a comment
// asserting another place's behavior has a truth value that drifts with
// someone else's code while the comment itself does not.
// Callers must gate on `durationMs == null`
// themselves and render nothing for it — this file only formats a duration it
// is actually given.
// `entryWordCount` returns `null` for a picture row (`entry.isImage`): there
// is no spoken/typed content on a picture row to count, and rendering "0字"
// there would claim a fact ("we counted, and it was zero") this app cannot
// back up.

import 'timeline_entry.dart';

/// True for a rune that counts as one CJK "字" on its own: Han ideographs
/// (BMP + the common Extension A block), Hiragana, Katakana, Hangul
/// syllables, and CJK compatibility ideographs. Punctuation blocks (CJK
/// symbols/punctuation, fullwidth forms) are deliberately EXCLUDED — a comma
/// is not a character spoken, and counting it would inflate the number past
/// what "字数统计" ("word count") conventionally means.
///
/// 🔴 CORRECTION IN PLACE (2026-08-14): the words 「Hangul syllables」 above no longer
/// describe this function — U+AC00–U+D7A3 was REMOVED. Korean is written with
/// spaces between words, so it goes through the whitespace branch and is
/// counted in 어절 (eojeol). The original text is kept, not deleted: it was
/// true when it was written. §B of the file
/// header carries the reasoning and the measured 7 → 3.
///
/// ⚠️ Ranges are INTEGER comparisons, not a RegExp character class, and that is
/// load-bearing rather than stylistic. Two of the boundary characters here are
/// CJK COMPATIBILITY ideographs; written as literals inside a character class
/// they are silently rewritten by anything that applies Unicode NFC
/// (U+F900 → U+8C48 — identical on screen, and it MOVES THE RANGE). The desktop
/// twin pays exactly that tax and says so in its own comment; integers cannot
/// be normalised. Keep it this way.
///
/// The ranges are the desktop twin's, measured out of its regex rather than
/// copied from its comment (the comment there says U+FADF; the literal is
/// U+FAFF — the code is the one that counts).
bool _isCjkChar(int rune) =>
    (rune >= 0x4E00 && rune <= 0x9FFF) || // CJK Unified Ideographs
    (rune >= 0x3400 && rune <= 0x4DBF) || // CJK Extension A
    (rune >= 0x3040 && rune <= 0x309F) || // Hiragana
    (rune >= 0x30A0 && rune <= 0x30FF) || // Katakana
    (rune >= 0x31F0 && rune <= 0x31FF) || // Katakana Phonetic Extensions
    (rune >= 0xF900 && rune <= 0xFAFF); // CJK Compatibility Ideographs

/// Whitespace, ECMAScript semantics — same class the desktop twin splits on.
/// Includes U+3000 IDEOGRAPHIC SPACE and U+00A0 NBSP (both verified on this
/// Dart SDK), which matters because CJK text that DOES use spaces uses U+3000.
final RegExp _whitespace = RegExp(r'\s');

/// A non-CJK run has to carry at least one letter or digit to score 1.
///
/// 🔴 `unicode: true` is REQUIRED and its absence is silent, not loud: without
/// the flag Dart reads `\p{L}` as the literal characters `p{L}` and the class
/// stops matching letters altogether. Measured on this SDK — with the flag
/// `ü`/`п`/astral `𐐀` all match and `!`/`，` do not; without it `ü` does not
/// match. That silence is the whole reason this is a named constant with this
/// comment rather than an inline literal at the call site.
///
/// `[A-Za-z0-9]` is exactly the defect this replaces: it drops the `ü` in
/// 「Grüße」 and every letter of 「привет」, so an all-Cyrillic utterance
/// counted 0.
final RegExp _letterOrDigit = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// THE core counting algorithm. See file header for the mixed CJK/Latin rule
/// and why it is pinned here rather than left to drift per call site.
///
/// 🔴 Character-for-character the same algorithm as the desktop twin's
/// `countMixedWords` (§F of the file header). Dart's `text[i]` and JS's
/// `charAt(i)` are both UTF-16 code units, so a surrogate pair takes two steps
/// in both — and in both, the run is tested as a SLICE, which is what keeps an
/// astral letter counting as the letter it is.
int textWordCount(String text) {
  if (text.isEmpty) return 0;
  int count = 0;
  int i = 0;
  final int len = text.length;
  while (i < len) {
    final String ch = text[i];
    if (_whitespace.hasMatch(ch)) {
      i += 1;
      continue;
    }
    if (_isCjkChar(ch.codeUnitAt(0))) {
      count += 1;
      i += 1;
      continue;
    }
    int j = i + 1;
    while (j < len &&
        !_whitespace.hasMatch(text[j]) &&
        !_isCjkChar(text.codeUnitAt(j))) {
      j += 1;
    }
    // The whole run is tested at once, not char by char: 「，world」 is one run
    // and scores 1 because it contains letters, while 「！！！」 scores 0
    // because it contains none.
    if (_letterOrDigit.hasMatch(text.substring(i, j))) count += 1;
    i = j;
  }
  return count;
}

/// The row's word count, reading the MODE'S FINAL RESULT
/// (owner 2026-08-01 §4-2, verbatim: 「原文按原文，翻译/整理按翻译/整理后的字数」
/// — "original text by its own words, translate/organize by the post-transform
/// word count").
///
/// [TimelineEntry.displayText] is already this repo's one existing resolver
/// for "what this row's final face reads" (outputText, falling back to
/// sourceText only when outputText is empty — see its doc in
/// timeline_entry.dart) and is the exact string `chat_message_tile.dart`
/// renders as the row's body. Reusing it here — rather than re-deriving
/// "which field is the final one" a second time — is what guarantees the
/// word count can never disagree with the text sitting right above it.
///
/// Returns `null` for a picture row: there is no transcript to count (see
/// file header).
/// REQ-12-13: `null` for a remote-key row too — it has no words at all (its face is
/// composed at render time from `controlKind`), and 「0 字」 ("0 characters") on
/// it would be a number
/// invented for a question that does not apply. Written positively so a fourth kind
/// cannot fail open into the count.
int? entryWordCount(TimelineEntry entry) {
  if (entry.entryType != TimelineEntry.kTranscript) return null;
  return textWordCount(entry.displayText);
}

/// Formats a KNOWN duration (caller has already checked non-null — see file
/// header). Numeric-only, no translated unit words — same "UI does not follow
/// OS locale" posture as time_label.dart / recording_panel.dart's formatElapsed,
/// and the bare ASCII "s" suffix mirrors the existing untranslated "seg $n"
/// precedent (recording_strings.dart) rather than inventing a new one.
///
/// · under 1s  → one decimal place ("0.4s") — see file header for why whole
///   seconds are not enough here;
/// · 1s–59s    → whole seconds ("12s");
/// · 60s+      → "m:ss" ("1:05"), unbounded on the minutes side (organize-mode
///   utterances can run long).
String formatEntryDuration(int durationMs) {
  final int ms = durationMs < 0 ? 0 : durationMs;
  if (ms < 1000) {
    return '${(ms / 1000).toStringAsFixed(1)}s';
  }
  final int totalSeconds = ms ~/ 1000;
  if (totalSeconds < 60) return '${totalSeconds}s';
  final int mm = totalSeconds ~/ 60;
  final int ss = totalSeconds % 60;
  return '$mm:${ss.toString().padLeft(2, '0')}';
}

// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.
// Delivery spacing is independent of the IME route: Hangul needs word spaces.
use std::borrow::Cow;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// Should this delivery gain one ASCII space? The last Unicode letter/number
/// chooses the script; punctuation, symbols, marks and joiners cannot hide it.
/// With no letter/number, retain the original final-character fallback.
pub(crate) fn should_append_delivery_space(text: &str) -> bool {
    let Some(last) = text.chars().next_back() else { return false; };
    if last.is_whitespace() || text.chars().count() >= super::INJECT_TEXT_MAX_CHARS {
        return false;
    }
    // L*/N* positively identifies letter-like scalars. In particular, Unicode
    // Alphabetic alone is insufficient: some Mn/Mc marks are Alphabetic too.
    match text.chars().rev().find(|c| matches!(
        c.general_category_group(), GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
    )) {
        Some(letter) => !is_no_space_script(letter),
        None => !is_unspaced_script_or_cjk_form(last),
    }
}

// Owner's round-2 BLOCK policy, checked against Unicode 17 Scripts.txt.
// Blocks intentionally include Common/Unknown scalars; this is not a claim
// that every scalar has that Unicode Script property. Hangul is not in this set.
fn is_no_space_script(c: char) -> bool {
    matches!(u32::from(c),
        0x2E80..=0x2FDF | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        | 0x20000..=0x323AF // Han; includes 2F800..2FA1F compatibility supplement
        | 0x3040..=0x309F | 0x1B001..=0x1B11F // Hiragana
        | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F
        | 0x1B000 | 0x1B120..=0x1B16F // Katakana
        | 0x3100..=0x312F | 0x31A0..=0x31BF // Bopomofo
        | 0xA000..=0xA4CF // Yi
        | 0x17000..=0x18AFF | 0x18D00..=0x18D8F // Tangut
        | 0x0E00..=0x0E7F | 0x0E80..=0x0EFF // Thai / Lao
        | 0x1780..=0x17FF | 0x19E0..=0x19FF // Khmer
        | 0x1000..=0x109F | 0xA9E0..=0xA9FF | 0xAA60..=0xAA7F // Myanmar
    )
}

pub(crate) fn delivery_text(text: &str) -> Cow<'_, str> {
    if should_append_delivery_space(text) {
        Cow::Owned(format!("{text} "))
    } else {
        Cow::Borrowed(text)
    }
}

// Unicode 17 blocks/scripts: https://www.unicode.org/Public/17.0.0/ucd/Scripts.txt
// Historical final-character fallback, used ONLY when no L*/N* scalar exists.
// Keep symbol-only input such as Thai Baht and fullwidth punctuation unchanged.
// Halfwidth Hangul (FFA0..FFDC), like every other Hangul form, is NOT excluded.
fn is_unspaced_script_or_cjk_form(c: char) -> bool {
    matches!(u32::from(c),
        0x0E00..=0x0EFF       // Thai / Lao
        | 0x0F00..=0x0FFF     // Tibetan (syllable separators, not word spaces)
        | 0x1000..=0x109F     // Myanmar
        | 0x1780..=0x17FF     // Khmer
        | 0x1950..=0x19FF     // Tai Le / New Tai Lue / Khmer symbols
        | 0x1A20..=0x1AAF     // Tai Tham
        | 0x2E80..=0x2EFF | 0x2F00..=0x2FDF // Han radicals
        | 0x3000..=0x30FF     // CJK symbols/punctuation, Hiragana, Katakana
        | 0x31C0..=0x31FF     // CJK strokes / Katakana phonetic extensions
        | 0x32D0..=0x3357     // Enclosed/compatibility Katakana
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF // Han
        | 0xA9E0..=0xA9FF | 0xAA60..=0xAA7F // Myanmar extensions
        | 0xAA80..=0xAADF     // Tai Viet
        | 0xF900..=0xFAFF     // Compatibility ideographs
        | 0xFE10..=0xFE1F | 0xFE30..=0xFE4F // Vertical/CJK punctuation forms
        | 0xFE50..=0xFE6F     // Small punctuation forms
        | 0xFF01..=0xFF9F | 0xFFE0..=0xFFEE // Fullwidth forms / halfwidth Kana
        | 0x116D0..=0x116E3   // Myanmar Extended-C
        | 0x16FE2..=0x16FE3 | 0x16FF0..=0x16FF6 // Han marks
        | 0x1AFF0..=0x1AFFF | 0x1B000..=0x1B16F // Kana extensions
        | 0x1E6C0..=0x1E6FF   // Tai Yo
        | 0x1F200             // Hiragana ligature
        | 0x20000..=0x2A6DF | 0x2A700..=0x2B81D // Han extensions B/C/D
        | 0x2B820..=0x2CEAD | 0x2CEB0..=0x2EBE0 // E/F
        | 0x2EBF0..=0x2EE5D | 0x2F800..=0x2FA1D // I / compatibility supplement
        | 0x30000..=0x3134A | 0x31350..=0x33479 // G/H/J
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_spacing_baseline_table() {
        for (text, append) in [
            ("Friday afternoon.", true), ("hello", true), ("42", true),
            ("Привет", true), ("γειά", true), ("안녕", true),
            ("\u{1100}", true), ("\u{3131}", true), ("\u{A960}", true),
            ("\u{D7B0}", true), ("\u{FFA1}", true),
            ("你好", false), ("\u{20000}", false), ("かな", false),
            ("カナ", false), ("ｶﾅ", false), ("\u{1B001}", false),
            ("hello！", true), ("中文。", false), ("Ａ", true),
            ("hello ", false), ("hello\n", false), ("x\t", false),
            ("x\u{a0}", false), ("", false), (" \t\n", false),
            ("😀", true), ("ภาษาไทย", false), ("ไทย่", false),
            ("ລາວ", false), ("ខ្មែរ", false), ("မြန်မာ", false),
            ("中文.", false), ("hello中", false),
        ] {
            assert_eq!(should_append_delivery_space(text), append, "{text:?}");
            let expected = if append { format!("{text} ") } else { text.to_owned() };
            assert_eq!(delivery_text(text), expected);
        }
    }

    #[test]
    fn delivery_spacing_letter_like_suffix_table() {
        for (text, append) in [
            ("Hello.", true),
            ("Hello\u{201D}", true),
            ("\u{4F60}\u{597D}\u{3002}", false),
            ("\u{4F60}\u{597D}\u{201D}", false),
            ("\u{4F60}\u{597D}\u{2026}\u{2026}", false),
            ("\u{4F60}\u{597D}?", false),
            ("\u{4F60}\u{597D}\u{E0100}", false),
            ("\u{C548}\u{B155}\u{D558}\u{C138}\u{C694}.", true),
            ("Hello \u{1F600}", true),
            ("\u{4F60}\u{597D}\u{1F600}", false),
            ("...", true),
            ("\u{0E3F}", false),
            ("\u{4F60}\u{597D}\u{2014}", false),
            ("\u{4F60}\u{597D}\u{FE0E}", false),
            ("\u{4F60}\u{597D}\u{FE0F}", false),
            ("\u{4F60}\u{597D}\u{E01EF}", false),
            ("\u{4F60}\u{597D}\u{301}\u{903}\u{20DD}", false), // Mn/Mc/Me
            ("\u{4F60}\u{597D}\u{200C}\u{200D}", false),
            ("\u{4F60}\u{597D} \u{1F600}", false),
            ("\u{4F60}\u{597D}])", false),
            ("\u{3105}.", false), ("\u{31A0}.", false), // Bopomofo
            ("\u{A000}.", false), // Yi
            ("\u{17000}.", false), ("\u{18D80}.", false), // Tangut
            ("\u{0E01}.", false), ("\u{0E81}.", false), // Thai / Lao
            ("\u{1780}.", false), ("\u{1000}.", false), // Khmer / Myanmar
            ("\u{3042}.", false), ("\u{30A2}.", false), ("\u{FF66}.", false),
            ("\u{1100}.", true), ("\u{3131}.", true), ("\u{FFA1}.", true),
            ("\u{4F60}\u{597D}42?", true), // Last number wins, not earlier Han.
            ("Hello\u{301}.", true),
            ("\u{1F600}", true), ("\u{FF01}", false),
        ] {
            let actual = should_append_delivery_space(text);
            assert_eq!(actual, append, "input={text:?}");
            assert_eq!(delivery_text(text), if append { format!("{text} ") } else { text.into() });
            println!("delivery_spacing input={text:?} expected={append} actual={actual}");
        }
    }

    #[test]
    fn delivery_spacing_preserves_cap_without_truncation() {
        let at_cap = "é".repeat(super::super::INJECT_TEXT_MAX_CHARS);
        assert_eq!(delivery_text(&at_cap), at_cap);
        let below = "😀".repeat(super::super::INJECT_TEXT_MAX_CHARS - 1);
        assert_eq!(delivery_text(&below).chars().count(), super::super::INJECT_TEXT_MAX_CHARS);
        let over = format!("{at_cap}x");
        assert_eq!(delivery_text(&over), over);
    }
}

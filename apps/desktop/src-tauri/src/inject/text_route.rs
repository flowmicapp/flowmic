// SPEC-REF:
//   docs/strategy/2026-08-21-ime-safe-inject-routing-design.md §2 (the content
//     route: CJK/fullwidth text → clipboard paste, pure-ASCII → typing)
//   docs/strategy/2026-08-21-wechat-ime-punctuation-corruption-findings.md
//     (why: a CN-state IME in some TSF apps doubles every fullwidth punctuation
//     mark typed as a VK_PACKET stream and swallows the character after it —
//     measured byte-for-byte on WeChat 4.x with stock Microsoft Wubi; DingTalk
//     reproduces, Feishu does not)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The IME-safe content route's ONE decision, kept pure so it is provable without
// a desktop: does this text have to avoid the typed-keystroke path?
//
// Deliberately a function of the TEXT alone — no target probe, no app list, no
// IME-state detection. All three alternatives were measured dead or ruled out
// (design §1/§4): cross-process IME-state probes answer a different question
// than they are asked (two APIs, two rounds of measurements, readings decoupled
// from ground truth), an app allowlist has no compatibility story (owner
// 2026-08-21), and post-hoc read-back corrupts first and verifies second. A
// pure text predicate behaves identically for every app that exists today and
// every app that does not yet.

/// Should `text` take the clipboard-paste path instead of typed VK_PACKET
/// keystrokes? True when any character is CJK or a fullwidth form — the
/// character classes a Chinese-mode IME takes an interest in.
///
/// The corruption itself keys on FULLWIDTH PUNCTUATION (，。？…), but the
/// trigger here is deliberately the wider CJK families: a hanzi text without
/// punctuation costs nothing extra to paste, and routing the whole family means
/// the decision does not depend on which punctuation marks a given IME happens
/// to mangle (only Microsoft Wubi is measured; Pinyin/Sogou are not).
pub fn needs_ime_immune_path(text: &str) -> bool {
    text.chars().any(is_cjk_or_fullwidth)
}

/// The routed character classes, block by block. Each range below is asserted
/// in the tests; extending the set means adding a test row, not just a range.
///
/// ⚠️ DELIBERATELY NOT INCLUDED: General Punctuation (U+2000–U+206F — the …
/// U+2026, — U+2014 and curly quotes a Chinese IME also produces). Real CJK
/// output containing them virtually always carries hanzi too (which routes),
/// while English prose with smart quotes would be pushed onto the paste path
/// for a corruption never observed on Latin text. If a measurement ever shows
/// a CN-state IME mangling those marks in pure-Latin text, add the block WITH
/// the measurement, not on suspicion.
fn is_cjk_or_fullwidth(c: char) -> bool {
    matches!(u32::from(c),
        0x1100..=0x11FF     // Hangul Jamo
        | 0x2E80..=0x2FDF   // CJK Radicals Supplement + Kangxi Radicals
        | 0x3000..=0x303F   // CJK Symbols and Punctuation (。、「」 and IDEOGRAPHIC SPACE)
        | 0x3040..=0x30FF   // Hiragana + Katakana
        | 0x3130..=0x318F   // Hangul Compatibility Jamo
        | 0x31C0..=0x31EF   // CJK Strokes
        | 0x31F0..=0x31FF   // Katakana Phonetic Extensions
        | 0x3200..=0x33FF   // Enclosed CJK Letters/Months + CJK Compatibility
        | 0x3400..=0x4DBF   // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF   // CJK Unified Ideographs
        | 0xAC00..=0xD7AF   // Hangul Syllables
        | 0xF900..=0xFAFF   // CJK Compatibility Ideographs
        | 0xFE10..=0xFE1F   // Vertical Forms (presentation punctuation)
        | 0xFE30..=0xFE4F   // CJK Compatibility Forms
        | 0xFF00..=0xFFEF   // Halfwidth and Fullwidth Forms (，？！ and fullwidth ASCII)
        | 0x20000..=0x3FFFF // CJK Unified Ideographs Extensions B..H (astral)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_ascii_keeps_the_typing_path() {
        assert!(!needs_ime_immune_path("hello world 123"));
        assert!(!needs_ime_immune_path("git commit -m \"fix: x\" && echo done!?"));
        assert!(!needs_ime_immune_path(""));
    }

    #[test]
    fn ascii_punctuation_is_not_fullwidth_punctuation() {
        // The halfwidth marks the corruption was never observed on stay typed.
        assert!(!needs_ime_immune_path("a, b. c? d! e; f:"));
    }

    #[test]
    fn hanzi_routes_even_without_punctuation() {
        assert!(needs_ime_immune_path("好的"));
    }

    #[test]
    fn the_measured_corruption_text_routes() {
        // The exact test text from the findings report — every mark that was
        // doubled on the real device is in one of the routed blocks.
        assert!(needs_ime_immune_path(
            "在里面也是等过山车，你钱留在外面也是一样。所以你说哪个对呢？"
        ));
    }

    #[test]
    fn a_single_fullwidth_mark_in_latin_text_routes() {
        // U+FF0C fullwidth comma / U+3002 ideographic full stop — the two marks
        // measured doubling — route even with no hanzi around them.
        assert!(needs_ime_immune_path("ok，done"));
        assert!(needs_ime_immune_path("done。"));
        assert!(needs_ime_immune_path("really？"));
    }

    #[test]
    fn kana_hangul_and_astral_cjk_route() {
        assert!(needs_ime_immune_path("テスト"));   // Katakana
        assert!(needs_ime_immune_path("ひらがな")); // Hiragana
        assert!(needs_ime_immune_path("한국어"));   // Hangul syllables
        assert!(needs_ime_immune_path("𠀀"));       // U+20000, Extension B
    }

    #[test]
    fn general_punctuation_alone_does_not_route() {
        // The documented exclusion: … — and curly quotes are shared with Latin
        // typography and unmeasured; they must not push English prose onto the
        // paste path. (Real CJK output carrying them also carries hanzi.)
        assert!(!needs_ime_immune_path("wait… “sure” — fine"));
    }

    #[test]
    fn emoji_do_not_route() {
        // Emoji are astral but not CJK; typing them is measured-safe (the
        // sendinput tests cover surrogate pairs) and they appear in Latin chats.
        assert!(!needs_ime_immune_path("nice 😀🎉"));
    }
}

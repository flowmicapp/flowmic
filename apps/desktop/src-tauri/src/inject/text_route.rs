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
// The inject route decision, kept pure so it is provable without a desktop.
//
// 🔴 2026-08-26 — THIS MODULE GREW. It used to answer exactly one question
// (「does this text have to avoid the typed path?」 — `needs_ime_immune_path`,
// unchanged below). It now owns the WHOLE route decision (`route_text`), and
// the default flipped: the clipboard is the road, typing is the exception. The
// long-form reason sits above `route_text`; the short one is that typing fails
// silently and pasting fails visibly.
//
// Deliberately a function of the TEXT alone — no target probe, no app list, no
// IME-state detection. All three alternatives were measured dead or ruled out
// (design §1/§4): cross-process IME-state probes answer a different question
// than they are asked (two APIs, two rounds of measurements, readings decoupled
// from ground truth), an app allowlist has no compatibility story (owner
// 2026-08-21), and post-hoc read-back corrupts first and verifies second. A
// pure text predicate behaves identically for every app that exists today and
// every app that does not yet.

/// Must `text` NEVER be typed as VK_PACKET keystrokes? True when any character
/// is CJK or a fullwidth form — the character classes a Chinese-mode IME takes
/// an interest in.
///
/// ⚠️ 2026-08-26: this is now a stronger statement than 「it pastes」, because
/// everything pastes by default. It is the one rule that overrides the console
/// exception, and it is the one backed by a byte-for-byte measurement.
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

// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE ROUTE DECISION (2026-08-26) — the default flipped.
//
// Until today the default was TYPING and the clipboard was the exception. It is
// now the other way round, and the reason is a failure-mode asymmetry, not a
// preference:
//
//   · TYPING fails SILENTLY. `SendInput` returning Ok(n) means 「Windows queued
//     n events」, never 「the target received n characters」. Two independent
//     measured corruptions ride that gap — a CN-state IME doubling fullwidth
//     punctuation in some TSF apps (2026-08-21, WeChat/DingTalk), and an
//     Electron target dropping synthesised keystrokes outright (2026-08-26,
//     owner on Cursor: 「注入的时候里面会少了很多的英文字符」). In BOTH cases we
//     report success. There is no receipt to be had: a post-hoc read-back can
//     only ever say YES (`inject/readback.rs`), so 「I could not tell」 and 「it
//     worked」 are the same value at this seam. R11 says a verdict whose
//     evidence never reached the layer making it is right only by accident.
//
//   · PASTING fails VISIBLY. It cannot half-arrive: either the target takes the
//     clipboard content or nothing appears and the user sees it and says the
//     sentence again. Its real cost is that it borrows the user's clipboard —
//     which is why `clipboard_snapshot.rs` saves and restores it, and why
//     `ClipboardSnapshot::unrecoverable()` exists to say when that promise
//     could not be kept.
//
// A defect the user cannot see beats a defect the user can see, every time. So
// the clipboard becomes the road and typing becomes the exception.
//
// ⚠️ WHAT THIS COSTS, said out loud rather than discovered later: every text
// injection now takes over the clipboard for the ~100ms of the paste (19 real
// injections measured 91–127ms, `2026-08-22-clipboard-restore-race-findings.md`)
// and restores it afterwards. That used to be the minority path. The user is
// told about it in the desktop settings rather than left to notice.
// ─────────────────────────────────────────────────────────────────────────────

/// Which physical path a piece of text takes into the focused window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRoute {
    /// Put it on the clipboard and press Ctrl+V. The default.
    Paste(PasteReason),
    /// Synthesise VK_PACKET keystrokes. The documented exception only.
    Type(TypeReason),
}

/// Why a paste was chosen. Rides the forensic line, so a log can answer
/// 「why did this one go by clipboard」 without anyone re-deriving the rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteReason {
    /// The text carries CJK/fullwidth characters that a CN-state IME mangles
    /// when typed. The one rule that overrides everything below it.
    ImeUnsafeText,
    /// This app returned a hard error from `SendInput` before, so typing here
    /// is not merely unverifiable — it is known broken.
    TypingHardRejected,
    /// No reason to do anything else. The default since 0.3.32.
    DefaultPath,
}

/// Why typing was chosen — there is exactly one such reason today, and it is
/// an enum rather than a bool so that adding a second one cannot be done
/// without naming it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeReason {
    /// The target is a console/terminal host. See [`is_console_target`].
    ConsoleTarget,
}

impl PasteReason {
    /// The phrase the forensic line carries. Kept here beside the rule that
    /// produces it so the two cannot drift (anti-façade ④: a comment asserting
    /// behaviour elsewhere needs an anchor — this IS the anchor).
    pub fn forensic_phrase(self) -> &'static str {
        match self {
            PasteReason::ImeUnsafeText => {
                "ime-safe content route: text carries CJK/fullwidth chars, and a CN-state IME in \
                 some TSF apps doubles typed fullwidth punctuation and swallows the next char — \
                 docs/strategy/2026-08-21-ime-safe-inject-routing-design.md"
            }
            PasteReason::TypingHardRejected => {
                "this app hard-rejected SendInput before (per-app learning), so typing here is \
                 known broken rather than merely unverifiable"
            }
            PasteReason::DefaultPath => {
                "default path since 0.3.32: a typed injection cannot be verified (SendInput Ok \
                 means Windows queued the events, not that the target received them) and its \
                 failures are silent — measured on Cursor 2026-08-26 and WeChat 2026-08-21"
            }
        }
    }
}

/// The route decision, whole and pure, so it is provable without a desktop.
///
/// Ordering is the contract, and each rule is here because the one above it
/// could not answer:
///
///   1. [`needs_ime_immune_path`] — a MEASURED corruption. Wins over
///      everything, including the console exception: CJK into a terminal still
///      pastes.
///   2. `typing_hard_rejected` — the OS itself refused our keystrokes in this
///      app. Beats the exception for the same reason: the exception is a
///      preference, this is a fact.
///   3. [`is_console_target`] — the ONE documented exception (owner-approved
///      2026-08-26: keep an exception with a stated reason rather than a
///      blanket rule).
///   4. Otherwise paste.
///
/// ⚠️ Rules 2 and 4 both end in a paste, so rule 2 changes nothing except
/// whether rule 3 gets to speak. That is its entire remaining job and it is
/// stated here rather than left as a branch that looks redundant.
pub fn route_text(text: &str, app_id: Option<&str>, typing_hard_rejected: bool) -> TextRoute {
    if needs_ime_immune_path(text) {
        return TextRoute::Paste(PasteReason::ImeUnsafeText);
    }
    if typing_hard_rejected {
        return TextRoute::Paste(PasteReason::TypingHardRejected);
    }
    if is_console_target(app_id) {
        return TextRoute::Type(TypeReason::ConsoleTarget);
    }
    TextRoute::Paste(PasteReason::DefaultPath)
}

/// The console/terminal exception: is `app_id` (an executable basename without
/// `.exe`, from `focus::tracker::current_app_name`) a console host?
///
/// ── WHY AN EXCEPTION AT ALL, AND WHY THIS ONE ────────────────────────────────
///
/// Ctrl+V is a CONTENDED key inside a console in a way it is not in an ordinary
/// edit control. What Ctrl+V does there is decided by whatever program is
/// running INSIDE the console — vim takes it for visual-block, less for
/// literal-next, emacs -nw for quoted-insert, and any raw-mode TUI may claim it
/// — and we cannot see that program. Typed characters are not contended: a
/// console input path delivers them whatever is running.
///
/// 🔴 [unverified] — say it plainly: NOBODY HAS MEASURED Ctrl+V failing in any
/// of these targets. The list is reasoning about a mechanism, not a reading.
/// The falsifier is cheap and named: if a console target is ever measured
/// DROPPING typed ASCII, delete it from this list (or delete the list). Do not
/// answer it by adding a probe — cross-process probes of the target input state
/// have been measured dead twice (design §1/§4).
///
/// ⚠️ THE RISK OF THIS LIST, since an app allowlist was explicitly ruled out
/// for the 2026-08-21 routing: a WRONG entry here means we type into an app
/// that should have pasted, i.e. exactly the silent corruption the default now
/// exists to avoid. Two things bound the blast radius, and neither is luck:
///   · rule 1 runs first, so this list can never touch CJK/fullwidth text;
///   · rule 2 runs first, so an app that hard-rejects typing escapes the list
///     after one attempt.
/// What is left is ASCII into an app we NAMED. That is a bounded, auditable
/// wrong-answer set, which is what the 2026-08-21 rejection of allowlists was
/// really about — that list would have had to enumerate every app that
/// corrupts, including ones not yet written.
///
/// Matching is case-insensitive because the basename keeps the executable own
/// casing (`WindowsTerminal`, `Hyper`, `MobaXterm`) — comparing it raw is the
/// kind of ruler error this repo has paid for repeatedly.
pub fn is_console_target(app_id: Option<&str>) -> bool {
    let Some(id) = app_id else { return false };
    CONSOLE_TARGETS
        .iter()
        .any(|known| id.eq_ignore_ascii_case(known))
}

/// Console hosts, by executable basename (no `.exe`). Extending this list means
/// adding a test row, and means accepting the risk stated on
/// [`is_console_target`] for that app.
const CONSOLE_TARGETS: &[&str] = &[
    // Windows own
    "cmd",
    "conhost",
    "openconsole",
    "powershell",
    "pwsh",
    "windowsterminal",
    "wt",
    // third-party terminal emulators
    "alacritty",
    "conemu",
    "conemu64",
    "hyper",
    "kitty",
    "mintty",
    "mobaxterm",
    "putty",
    "tabby",
    "terminus",
    "wezterm",
    "wezterm-gui",
    "xshell",
    // SSH/serial clients whose window IS a terminal
    "securecrt",
];

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

// ── the whole-decision function (2026-08-26): the default is now the paste ────
#[cfg(test)]
mod route_tests {
    use super::*;

    fn paste_reason(text: &str, app: Option<&str>, rejected: bool) -> PasteReason {
        match route_text(text, app, rejected) {
            TextRoute::Paste(r) => r,
            TextRoute::Type(t) => panic!("expected a paste, got Type({t:?})"),
        }
    }

    #[test]
    fn plain_english_into_an_ordinary_app_now_pastes() {
        // THE FLIP, asserted at the point that decides it. This exact input —
        // pure-ASCII English into a non-console app — is what the owner reported
        // losing characters in Cursor on 2026-08-26, and until today it typed.
        assert_eq!(
            route_text("Let me know if that works for you.", Some("Cursor"), false),
            TextRoute::Paste(PasteReason::DefaultPath),
        );
    }

    #[test]
    fn an_app_we_know_nothing_about_pastes() {
        assert_eq!(
            paste_reason("hello", None, false),
            PasteReason::DefaultPath,
            "no app identity is not a reason to take the unverifiable path",
        );
    }

    #[test]
    fn a_console_target_is_the_one_exception_and_it_types() {
        for term in ["cmd", "pwsh", "WindowsTerminal", "Alacritty", "MobaXterm"] {
            assert_eq!(
                route_text("git status", Some(term), false),
                TextRoute::Type(TypeReason::ConsoleTarget),
                "{term} is a console host",
            );
        }
    }

    #[test]
    fn the_console_list_is_matched_case_insensitively() {
        // The basename keeps the executable own casing, so a raw compare would
        // have silently excluded every capitalised entry — the ruler error this
        // repo keeps paying for. Reverse control: a near-miss must NOT match.
        assert!(is_console_target(Some("WINDOWSTERMINAL")));
        assert!(is_console_target(Some("windowsterminal")));
        assert!(!is_console_target(Some("windowsterminalx")));
        assert!(!is_console_target(Some("terminal")));
        assert!(!is_console_target(None));
    }

    #[test]
    fn cjk_into_a_console_still_pastes_the_measured_rule_wins() {
        // Rule 1 over rule 3. If this ever reverses, the 2026-08-21 WeChat-class
        // corruption comes back inside terminals and nothing would report it.
        assert_eq!(
            paste_reason("提交，然后推送。", Some("WindowsTerminal"), false),
            PasteReason::ImeUnsafeText,
        );
    }

    #[test]
    fn an_app_that_hard_rejected_typing_pastes_even_if_it_is_a_console() {
        // Rule 2 over rule 3: the exception is a preference, a hard rejection is
        // a fact. Without this, a console where SendInput physically fails would
        // be sent back to typing for ever.
        assert_eq!(
            paste_reason("ls -la", Some("cmd"), true),
            PasteReason::TypingHardRejected,
        );
    }

    #[test]
    fn every_paste_reason_carries_a_distinct_forensic_phrase() {
        // Three reasons that arrive at the same physical path — if their forensic
        // phrases collapsed, a log could no longer answer WHICH rule fired, and
        // 「why did this one paste」 is the only question this line exists for.
        let phrases = [
            PasteReason::ImeUnsafeText.forensic_phrase(),
            PasteReason::TypingHardRejected.forensic_phrase(),
            PasteReason::DefaultPath.forensic_phrase(),
        ];
        for (i, a) in phrases.iter().enumerate() {
            assert!(!a.is_empty());
            for b in phrases.iter().skip(i + 1) {
                assert_ne!(a, b, "two rules must not be indistinguishable in the log");
            }
        }
    }
}

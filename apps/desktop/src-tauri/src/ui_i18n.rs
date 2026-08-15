// U6 — the Rust-side UI speaks the app language (2026-08-04).
//
// SPEC-REF:
//   docs/decisions/2026-07-28-i18n-four-locales-and-theme.md (Option C: the UI
//     locale has exactly two sources — the user's explicit choice, or whatever
//     was already persisted; never reads OS locale)
//   CLAUDE.md red line: 「UI 不跟随 OS locale」("the UI must not follow OS
//     locale") — applies to Rust exactly as to Vue.
//
// Until this card, every user-facing string the Rust shell produced — the tray
// menu, the tray status/tooltip, the exit-confirmation dialog (the ONLY exit
// path), and the autostart error strings — was hardcoded Chinese, outside every
// i18n mechanism. An English user saw Chinese in all of them.
//
// The locale KEY SPACE is not this file's to invent. Its one source is the
// registry `UI_LOCALES` in packages/protocol/src/locales.ts, which the WebView
// side also derives from; the tags here are that registry's `code` column
// verbatim, and the default is its `DEFAULT_UI_LOCALE`. Deliberately NO
// OS-locale fallback anywhere.
//
// ── THE THREE LAYERS (docs/strategy/2026-08-14-locale-expansion-architecture.md §4.3)
// This file is the LOGIC and the KEY CONTRACT. It holds the lookup, the
// placeholder contract, `fill`, persistence, and the per-key doc comments that
// pin every message to its production call site. It holds NO strings.
//
//   which languages exist -> packages/protocol/src/locales.ts   (registry, one row per language)
//   the strings           -> i18n/desktop-rust/<code>.json      (data, one file per language)
//   the table             -> src/ui_i18n_table.g.rs             (generated; `include!`d below)
//
// Adding language N+1 to this surface is a registry row, a JSON file, and
// `node scripts/i18n/gen-desktop-rust.mjs`. No line below changes, and nothing
// in this crate states how many languages there are — the old
// `ALL: [UiLocale; 4]` wrote that count into a TYPE, which is why it could only
// ever be remembered, never derived.
//
// 🔴 Completeness is still the COMPILER's job, not a runtime fallback: the
// generated `table` matches exhaustively on both `Msg` and `UiLocale`, so a key
// with no translation cannot compile. That property is the red line in §7-1 of
// the architecture doc and it survives this refactor unchanged.
//
// How the value reaches Rust (the bridge, both directions grep-provable):
//   frontend → Rust: `reportUiLocale` (src/lib/bridge.ts) invokes the
//     `ui_locale_set` command (shell/locale_sync.rs) on boot-hydrate and on
//     every locale change; the command calls `set_current` + `persist`.
//   disk → Rust: `init_from_disk` (called from `run()` in lib.rs BEFORE the
//     WebView exists) reads the small file `persist` wrote last time, so the
//     tray/dialog are in the right language from the first frame of the next
//     launch even though localStorage is unreachable from Rust.
//
// This module is tauri-free (std only) so the pump (socket/pump.rs, compiled
// without the `app` feature) can localize the tray status it computes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

// `UiLocale` (with `ALL` and `tag`), `Msg::ALL` and the string table itself are
// GENERATED from the registry + the JSON data files — see the header. The
// include sits here, where the enum used to be, so a reader meets the type
// where they expect it.
include!("ui_i18n_table.g.rs");

impl UiLocale {
    /// Parse a persisted tag. Unknown / garbage → `None`; callers fall back to
    /// `DEFAULT_LOCALE` exactly like the frontend's `isUiLocale` guard does —
    /// never to the OS.
    pub fn from_tag(tag: &str) -> Option<UiLocale> {
        UiLocale::ALL.iter().copied().find(|l| l.tag() == tag)
    }
}

/// Every tag this build accepts, joined for a human-readable refusal — used by
/// `ui_locale_set` (shell/locale_sync.rs) when the frontend hands over a tag
/// Rust does not know.
///
/// 🔴 Derived, not typed out. The sentence it replaces read "the Rust side
/// supports zh-CN/en/ja/ko": a hand-written list inside an error message, i.e. a
/// truth with an expiry date, in the one place a reader turns to when the two
/// key spaces have ALREADY drifted. A stale list there does not just mislead —
/// it misdirects the diagnosis of the exact failure it is reporting.
pub fn supported_tags() -> String {
    UiLocale::ALL
        .iter()
        .map(|l| l.tag())
        .collect::<Vec<_>>()
        .join("/")
}

// `DEFAULT_LOCALE` is generated too — it is the registry's `DEFAULT_UI_LOCALE`,
// not a second opinion held by this file.

/// Process-wide current locale, as a small atomic so the 500 ms pump tick can
/// read it without a lock. Index into `UiLocale::ALL`.
///
/// Starts at `DEFAULT_LOCALE_INDEX`, which the generator emits alongside
/// `DEFAULT_LOCALE` itself.
///
/// 🔴 It used to start at a literal 0 and rely on the registry listing the
/// default first — a coincidence that was honestly labelled as one and pinned by
/// a test. On 2026-08-14 the registry was reordered to put the BASE language
/// (English, the fallback for a missing translation) first while the startup
/// default stayed zh-CN, and that test went red. It was right to: the two are
/// different questions and had merely shared an answer. Generating the index
/// deletes the coincidence instead of re-pinning a new one.
static CURRENT: AtomicU8 = AtomicU8::new(DEFAULT_LOCALE_INDEX);

fn locale_index(l: UiLocale) -> u8 {
    UiLocale::ALL.iter().position(|x| *x == l).unwrap_or(0) as u8
}

/// The locale the Rust UI surface speaks right now.
pub fn current() -> UiLocale {
    let i = CURRENT.load(Ordering::Relaxed) as usize;
    *UiLocale::ALL.get(i).unwrap_or(&DEFAULT_LOCALE)
}

/// Set the process-wide locale. Returns whether it CHANGED, so the caller can
/// skip persist / tray re-render on the idempotent boot mirror.
pub fn set_current(l: UiLocale) -> bool {
    CURRENT.swap(locale_index(l), Ordering::Relaxed) != locale_index(l)
}

// ── persistence (the half of the bridge Rust reads at startup) ───────────────

/// Where the choice lives for Rust: a one-line file beside the DB / secret /
/// instance.lock in FLOWMIC_HOME (`%APPDATA%\FlowMic\`). localStorage is a
/// WebView2 store Rust cannot read, so `ui_locale_set` mirrors the value here.
pub fn default_locale_path() -> PathBuf {
    crate::sidecar::io::default_home().join("ui-locale.txt")
}

/// Read a persisted tag from `path`. Missing file / unreadable / unknown tag
/// all → `None` (caller stays on `DEFAULT_LOCALE`). Whitespace-trimmed so a
/// hand-edited file with a trailing newline still parses.
pub fn load_persisted(path: &Path) -> Option<UiLocale> {
    let raw = std::fs::read_to_string(path).ok()?;
    UiLocale::from_tag(raw.trim())
}

/// Write the tag to `path` (parent dir created). Fail-loud to the caller —
/// a persist that silently failed would leave next launch in the wrong
/// language with nothing on the record.
pub fn persist_to(path: &Path, l: UiLocale) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, l.tag())
}

/// `persist_to` at the default path — what `ui_locale_set` calls.
pub fn persist(l: UiLocale) -> std::io::Result<()> {
    persist_to(&default_locale_path(), l)
}

/// Startup: adopt the persisted choice (or stay on the default). Called once
/// from `run()` (lib.rs) before any UI surface is built, so the tray menu and
/// a pre-WebView exit dialog are already in the right language.
pub fn init_from_disk() {
    if let Some(l) = load_persisted(&default_locale_path()) {
        set_current(l);
    }
}

// ── the key contract ─────────────────────────────────────────────────────────

/// Every Rust-side user-visible string, by key — the KEYS, not the strings.
///
/// This enum is authored and stays authored: each variant's doc comment names
/// the production call site that renders it, which is the anti-façade evidence
/// for the key existing at all, and no generator can write that. The strings
/// themselves live in i18n/desktop-rust/<code>.json.
///
/// Adding a key in NO language does not compile (the generated `table` matches
/// exhaustively on `Msg`); adding it in SOME languages is refused by the
/// generator before it emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msg {
    /// Tray menu「显示主窗口」("Show main window") — shell/tray.rs `setup_tray`.
    TrayShowMain,
    /// Tray menu「显示胶囊」("Show capsule") — shell/tray.rs `setup_tray`.
    TrayShowCapsule,
    /// Tray menu「退出」("Quit") — shell/tray.rs `setup_tray`.
    TrayQuit,
    /// Tray disabled status row + boot value — socket/pump.rs `tray_state`,
    /// shell/tray.rs `setup_tray`.
    TrayStatusDisconnected,
    /// Tray tooltip, disconnected — socket/pump.rs `tray_state`, shell/tray.rs.
    TrayTooltipDisconnected,
    /// Tray menu toggle, shown while ONLINE — shell/tray.rs `setup_tray`
    /// (P7 offline switch, owner 2026-08-15).
    TrayGoOffline,
    /// Tray menu toggle, shown while OFFLINE — shell/tray.rs `setup_tray`.
    TrayGoOnline,
    /// Tray disabled status row while manually offline — shell/offline.rs
    /// `apply` (the pump is dead in this state, so offline speaks for itself).
    TrayStatusOffline,
    /// Tray tooltip while manually offline — shell/offline.rs `apply`.
    TrayTooltipOffline,
    /// Tray status row, recording — socket/pump.rs `tray_state`.
    TrayStatusRecording,
    /// Tray tooltip, recording — socket/pump.rs `tray_state`.
    TrayTooltipRecording,
    /// Tray status row, connected (`{n}` = phone count) — socket/pump.rs.
    TrayStatusConnected,
    /// Tray tooltip, connected (`{n}` = phone count) — socket/pump.rs.
    TrayTooltipConnected,
    /// Exit-confirmation dialog title — shell/tray.rs `confirm_quit`.
    QuitConfirmTitle,
    /// Exit-confirmation dialog body — shell/tray.rs `confirm_quit`.
    QuitConfirmBody,
    /// shell/autostart.rs `autostart_set` (enable path), `{detail}` = OS error.
    AutostartWriteFailed,
    /// shell/autostart.rs `autostart_set` (disable path), `{detail}` = OS error.
    AutostartRemoveFailed,
    /// shell/autostart.rs `snapshot`, `{detail}` = plugin error.
    AutostartReadFailed,
    /// shell/autostart.rs `current_exe_string`, `{detail}` = OS error.
    AutostartExePathFailed,
    /// shell/autostart.rs `verify_enabled` — `{want}` / `{got}` are the two
    /// registry command strings.
    AutostartVerifyMismatch,
    /// shell/autostart.rs `verify_enabled` — read-back empty after write.
    AutostartVerifyEmpty,
    /// shell/autostart.rs `verify_enabled` / `verify_disabled`, `{detail}`.
    AutostartRecheckFailed,
    /// shell/autostart.rs `verify_enabled` — written but system reports off.
    AutostartEnabledButOff,
    /// shell/autostart.rs `verify_disabled` — removed but system reports on.
    AutostartStillEnabled,
    /// shell/autostart.rs `rewrite_quoted`, `{detail}` = registry error.
    AutostartRegOpenFailed,
    /// shell/autostart.rs `rewrite_quoted`, `{detail}` = registry error.
    AutostartRewriteFailed,
}

impl Msg {
    /// The placeholders each key's template MUST carry in every language —
    /// the completeness test walks this so a translation cannot drop `{n}`
    /// and silently render a literal count-less sentence.
    pub fn placeholders(self) -> &'static [&'static str] {
        match self {
            Msg::TrayStatusConnected | Msg::TrayTooltipConnected => &["{n}"],
            Msg::AutostartWriteFailed
            | Msg::AutostartRemoveFailed
            | Msg::AutostartReadFailed
            | Msg::AutostartExePathFailed
            | Msg::AutostartRecheckFailed
            | Msg::AutostartRegOpenFailed
            | Msg::AutostartRewriteFailed => &["{detail}"],
            Msg::AutostartVerifyMismatch => &["{want}", "{got}"],
            _ => &[],
        }
    }
}

/// The string for one key in one language.
///
/// The body is `table`, which is GENERATED (src/ui_i18n_table.g.rs) from
/// i18n/desktop-rust/<code>.json. The zh-CN column is still the pre-U6 literals
/// VERBATIM — the move into JSON was proven byte-identical, cell by cell, and
/// reworded nothing.
///
/// The indirection is the point: this signature, its doc, and every caller are
/// language-count-blind, so `table` can grow a column without anything here
/// noticing.
pub fn text(locale: UiLocale, msg: Msg) -> &'static str {
    table(locale, msg)
}

/// `text` in the CURRENT locale — what production call sites use.
pub fn tr(msg: Msg) -> &'static str {
    text(current(), msg)
}

/// Fill `{name}` placeholders. Deliberately dumb (`str::replace`, no escaping
/// grammar): the templates are ours, the args are display strings, and a
/// placeholder that survives filling is exactly what the completeness test's
/// placeholder walk exists to prevent.
pub fn fill(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in args {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// `tr` + `fill` in one call — the shape the autostart error sites use.
pub fn tr_with(msg: Msg, args: &[(&str, &str)]) -> String {
    fill(tr(msg), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── script rulers, derived from the registry ─────────────────────────────
    //
    // These used to be three sentences hand-written per language ("en has no
    // CJK", "ko has hangul", "some ja cell has kana"). Now the rule is keyed on
    // the locale's ISO 15924 `script`, so fr/es/de arrive under the Latn rule
    // and ru under the Cyrl rule with nothing edited here.

    /// The writing systems a cell can be caught drawing from. Latin is
    /// deliberately NOT one: it is legal in EVERY language's cells (`FlowMic`,
    /// `PCID`, `free`/`pro`/`max` are on the do-not-translate list, doc 17 §3),
    /// so its presence would prove nothing and its absence would be a false
    /// alarm.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Marker {
        Han,
        Kana,
        Hangul,
        Cyrillic,
    }

    fn marker_of(c: char) -> Option<Marker> {
        match c as u32 {
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF => Some(Marker::Han),
            0x3040..=0x309F | 0x30A0..=0x30FF => Some(Marker::Kana),
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => Some(Marker::Hangul),
            0x0400..=0x04FF | 0x0500..=0x052F => Some(Marker::Cyrillic),
            _ => None,
        }
    }

    /// Which markers a locale of this script may legitimately contain.
    ///
    /// 🔴 An unknown script PANICS instead of returning "anything goes". A
    /// permissive default would mean the tenth language silently ships with no
    /// ruler at all — the failure this whole test exists to catch, arriving
    /// green. The panic is the one line a new SCRIPT (not a new language) costs.
    fn allowed_markers(script: &str) -> &'static [Marker] {
        match script {
            // Han only. Kana/hangul/cyrillic in a Chinese cell means another
            // language's string landed in this column.
            "Hans" | "Hant" => &[Marker::Han],
            // Kanji is unavoidable in Japanese, so Han must be allowed here —
            // which is exactly why RULE 3 below has to exist as well: script
            // alone cannot catch a zh string pasted into the ja column.
            "Jpan" => &[Marker::Han, Marker::Kana],
            // Modern Korean UI copy carries no hanja. Forbidding Han is a
            // deliberate tightening, not an oversight: zh → ko is the
            // copy-paste that actually happens here, and allowing Han would
            // make it invisible. A future translation that genuinely wants
            // hanja will go red, and that red is the prompt to revisit this
            // line on purpose.
            "Kore" => &[Marker::Hangul],
            "Latn" => &[],
            "Cyrl" => &[Marker::Cyrillic],
            other => panic!(
                "no marker rule for script {other:?} — add one to allowed_markers \
                 deliberately; a new script must not inherit 'anything goes'"
            ),
        }
    }

    /// Every marker in `s` that `script` does not permit.
    fn markers_outside(script: &str, s: &str) -> Vec<Marker> {
        let allowed = allowed_markers(script);
        let mut found: Vec<Marker> = Vec::new();
        for c in s.chars() {
            if let Some(m) = marker_of(c) {
                if !allowed.contains(&m) && !found.contains(&m) {
                    found.push(m);
                }
            }
        }
        found
    }

    /// The marker that positively evidences a script. `None` for Latn, because
    /// Latin is allowed everywhere and therefore evidences nothing.
    fn characteristic_marker(script: &str) -> Option<Marker> {
        match script {
            "Hans" | "Hant" => Some(Marker::Han),
            "Jpan" => Some(Marker::Kana),
            "Kore" => Some(Marker::Hangul),
            "Cyrl" => Some(Marker::Cyrillic),
            "Latn" => None,
            other => panic!("no characteristic marker for script {other:?}"),
        }
    }

    /// 🔴 Hans and Hant are the same script to a codepoint check. Two locales in
    /// this pair are SUPPOSED to be identical on every string containing no
    /// vocabulary that needs converting (`PCID`, 「配对」("pairing"), … — doc 17 §4), so a
    /// per-cell inequality between them is not a bug detector, it is a false
    /// alarm generator. The only honest guard across that pair is RULE 4.
    fn same_han_variant_pair(a: &str, b: &str) -> bool {
        matches!((a, b), ("Hans", "Hant") | ("Hant", "Hans"))
    }

    /// Positive controls for the ruler itself, on synthetic inputs.
    ///
    /// Written because the rules above are the kind that pass by being wrong: a
    /// `marker_of` that matched nothing would make every per-cell assertion in
    /// the table test below vacuously green. These pin that it really fires —
    /// permanently, rather than resting on someone having broken it once by hand.
    #[test]
    fn the_script_ruler_really_measures() {
        // A Chinese sentence in a Latin column is caught…
        assert_eq!(markers_outside("Latn", "未连接"), vec![Marker::Han]);
        // …and a genuine English one is not.
        assert!(markers_outside("Latn", "Not connected — FlowMic {n}").is_empty());
        // Kanji is fine in Japanese; hangul is not.
        assert!(markers_outside("Jpan", "未接続").is_empty());
        assert_eq!(markers_outside("Jpan", "종료"), vec![Marker::Hangul]);
        // The zh → ko copy-paste, which is the one that actually happens.
        assert_eq!(markers_outside("Kore", "未连接"), vec![Marker::Han]);
        assert!(markers_outside("Kore", "연결 안 됨").is_empty());
        // Brand names, placeholders and punctuation are never markers anywhere.
        for script in ["Hans", "Hant", "Jpan", "Kore", "Latn", "Cyrl"] {
            assert!(markers_outside(script, "FlowMic PCID free {n} — (2)").is_empty());
        }
        assert!(markers_outside("Cyrl", "Нет связи").is_empty());
        assert_eq!(markers_outside("Cyrl", "未连接"), vec![Marker::Han]);
    }

    /// U6 completeness: every key present (non-empty) in every supported
    /// language, with its placeholders intact. This is the test the card asks
    /// for — it fails when a language misses a key (empty string) or when a
    /// translation drops a `{placeholder}`.
    #[test]
    fn every_key_is_present_in_every_supported_language_with_its_placeholders() {
        for msg in Msg::ALL.iter().copied() {
            for locale in UiLocale::ALL.iter().copied() {
                let s = text(locale, msg);
                assert!(
                    !s.trim().is_empty(),
                    "{msg:?} is empty in {locale:?} — a missing translation"
                );
                for ph in msg.placeholders() {
                    assert!(
                        s.contains(ph),
                        "{msg:?} in {locale:?} lost its placeholder {ph}: {s:?}"
                    );
                }
            }
        }
    }

    /// Anti-façade for the table itself: an untranslated column wearing a
    /// translation's slot. Four rules, all keyed on registry data, so a new
    /// language inherits them without this file being touched.
    ///
    /// 🔴 WHAT THIS CANNOT PROVE, stated plainly because the honest weaker claim
    /// is worth more than a confident wrong one: **no codepoint rule can tell
    /// zh-CN from zh-TW.** Rules 1 and 3 are blind across that pair by
    /// construction. Rule 4 catches only the wholesale copy (an entire zh-TW
    /// column byte-equal to zh-CN); a Traditional column that is really
    /// "Mainland Chinese written in Traditional characters" — the exact failure
    /// doc 17 §4 warns about — passes every assertion here. Its only real guard is
    /// the reviewed vocabulary mapping in doc 17 §4, which this test does not
    /// attempt.
    #[test]
    fn translations_are_real_not_copies() {
        // RULE 1 — per cell: no writing system the locale's script forbids.
        for locale in UiLocale::ALL.iter().copied() {
            for msg in Msg::ALL.iter().copied() {
                let s = text(locale, msg);
                let strays = markers_outside(locale.script(), s);
                assert!(
                    strays.is_empty(),
                    "{msg:?} in {locale:?} ({}) contains {strays:?}: {s:?}",
                    locale.script()
                );
            }
        }

        // RULE 2 — per column: the language really is written in its own script.
        // Skipped for Latn, whose characteristic marker is Latin and Latin
        // proves nothing (see `Marker`).
        for locale in UiLocale::ALL.iter().copied() {
            let Some(want) = characteristic_marker(locale.script()) else {
                continue;
            };
            assert!(
                Msg::ALL
                    .iter()
                    .any(|m| text(locale, *m).chars().any(|c| marker_of(c) == Some(want))),
                "no {locale:?} cell contains any {want:?} — the column is not written in {}",
                locale.script()
            );
        }

        // RULE 3 — per cell: a translation must differ from the authored source
        // it was made from, when the two are in different scripts.
        //
        // Restricted to script-crossing pairs on purpose. Same-script pairs are
        // legitimately equal on parts of the table: fr vs en coincide on a
        // do-not-translate string (doc 17 §3), Hans vs Hant on most short ones.
        // Asserting inequality there would write a false alarm into the
        // acceptance criteria — the 0.2.52 lesson, where a reverse control
        // pointed the wrong way and froze a defect into a spec.
        for locale in UiLocale::ALL.iter().copied() {
            if locale.is_authored() {
                continue;
            }
            for source in UiLocale::ALL.iter().copied().filter(|l| l.is_authored()) {
                if locale.script() == source.script()
                    || same_han_variant_pair(locale.script(), source.script())
                {
                    continue;
                }
                for msg in Msg::ALL.iter().copied() {
                    assert_ne!(
                        text(locale, msg),
                        text(source, msg),
                        "{msg:?} in {locale:?} is the {source:?} string verbatim"
                    );
                }
            }
        }

        // RULE 4 — per column pair: no language's whole column may be another's.
        // The one rule that spans the Hans/Hant pair, and the only thing between
        // us and a copied data file (architecture doc §5, 「不许整语照抄」—
        // "no copying an entire language column verbatim").
        for (i, a) in UiLocale::ALL.iter().copied().enumerate() {
            for b in UiLocale::ALL.iter().copied().skip(i + 1) {
                assert!(
                    Msg::ALL.iter().any(|m| text(a, *m) != text(b, *m)),
                    "the {a:?} and {b:?} columns are identical — one is an untranslated copy"
                );
            }
        }
    }

    /// The atomic in `CURRENT` starts at index 0, which is only the default
    /// because the registry lists the default first. Pinned rather than trusted:
    /// reordering `UI_LOCALES` would otherwise boot the tray in the wrong
    /// language, silently, while `DEFAULT_LOCALE` still read correctly.
    #[test]
    fn the_starting_index_really_is_the_default() {
        // Was `ALL[0] == DEFAULT_LOCALE`, pinning a coincidence. Since the
        // registry now leads with the BASE language rather than the startup
        // default, index 0 and the default are legitimately different rows; what
        // must hold is that the atomic CURRENT starts on the default, whatever
        // position that occupies.
        assert_eq!(
            UiLocale::ALL[DEFAULT_LOCALE_INDEX as usize],
            DEFAULT_LOCALE,
            "CURRENT starts at DEFAULT_LOCALE_INDEX, so that slot must hold DEFAULT_LOCALE"
        );
        assert_eq!(current(), DEFAULT_LOCALE, "a fresh process speaks the default locale");
    }

    /// The tags are the registry's `code` column and nothing else, so this test
    /// no longer lists them. It used to spell all four out under the comment
    /// "the frontend persists exactly these" — a hand-copied list, in a test
    /// whose whole job is to catch a hand-copied list going stale.
    #[test]
    fn tags_round_trip_and_reject_everything_else() {
        for l in UiLocale::ALL.iter().copied() {
            assert_eq!(UiLocale::from_tag(l.tag()), Some(l));
            // The hyphen is part of the contract: the WebView stores 'zh-CN',
            // and the underscore spelling is the near-miss that would otherwise
            // be read as "no choice stored" and boot the tray in the default.
            let underscored = l.tag().replace('-', "_");
            if underscored != l.tag() {
                assert_eq!(
                    UiLocale::from_tag(&underscored),
                    None,
                    "{underscored:?} must not parse — tags are hyphenated, verbatim"
                );
            }
        }
        // Unknown / garbage → None, so callers keep DEFAULT_LOCALE, never the OS.
        assert_eq!(UiLocale::from_tag("no-such-locale"), None);
        assert_eq!(UiLocale::from_tag(""), None);
        // 🔴 The ONE literal left on purpose. It is not a language list: it is
        // the product decision about what the first frame speaks until a human
        // chooses otherwise (doc 01 §8 #11). Adding a language must not move it,
        // so a red here means someone changed the DEFAULT — exactly the change
        // that should need a second pair of eyes.
        //
        // It went red on 2026-08-14 and the guard was right to: owner ruled
        // 「全新安装以英文启动」("a fresh install boots in English"), so the value
        // moved zh-CN → en. Updated with the
        // ruling cited rather than loosened — an assertion that stops naming a
        // specific tag would stop being able to catch the next silent change.
        assert_eq!(DEFAULT_LOCALE.tag(), "en");
    }

    #[test]
    fn persistence_round_trips_and_rejects_garbage() {
        let dir = std::env::temp_dir().join(format!("flowmic-i18n-test-{}", std::process::id()));
        let p = dir.join("ui-locale.txt");
        let _ = std::fs::remove_file(&p);
        assert_eq!(load_persisted(&p), None, "missing file → None (stay on default)");
        persist_to(&p, UiLocale::Ja).expect("persist");
        assert_eq!(load_persisted(&p), Some(UiLocale::Ja));
        std::fs::write(&p, "no-such-locale\n").unwrap();
        assert_eq!(load_persisted(&p), None, "garbage on disk must not invent a locale");
        std::fs::write(&p, "en\n").unwrap();
        assert_eq!(load_persisted(&p), Some(UiLocale::En), "trailing newline tolerated");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fill_replaces_named_placeholders() {
        assert_eq!(fill("a {n} b {n}", &[("n", "2")]), "a 2 b 2");
        assert_eq!(
            fill("want {want} got {got}", &[("want", "X"), ("got", "Y")]),
            "want X got Y"
        );
        // An arg the template does not mention changes nothing.
        assert_eq!(fill("plain", &[("n", "2")]), "plain");
    }
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (flow_key six keys: enter/backspace/
//     undo(Ctrl+Z)/clear(Ctrl+A+Del)/tab/space, same Stage-1 focus discipline)
//   packages/protocol/src/protocol-schemas-inject.ts ControlKeySchema (the six
//     whitelisted kinds — the SSOT for what a valid control:key carries)
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 (CONTROL_UNKNOWN_KIND for a bad kind)
//
// Pure kind→virtual-key mapping in `key_sequence_for` so the contract is
// exercised headless in `cargo test` without touching Win32. The real
// SendInput emit (`send_chords`) is Windows-only with a non-windows
// compatibility seam mirroring sendinput.rs. An out-of-whitelist kind returns
// None so the caller fails loudly with CONTROL_UNKNOWN_KIND — no silent
// catch-all keystroke.

/// A single keystroke: a virtual-key code plus modifiers held around it.
/// Modifiers press (in order) before the key and release (reverse) after, so
/// Ctrl+Z is one `KeyChord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub vk: u16,
    pub modifiers: Vec<u16>,
}

impl KeyChord {
    fn bare(vk: u16) -> Self {
        Self {
            vk,
            modifiers: Vec::new(),
        }
    }

    /// Hold the platform's PRIMARY modifier across `vk` — Control on Windows,
    /// Command on macOS. Renamed from `with_ctrl` on 2026-08-07: the old name was
    /// accurate on exactly one platform and 「undo holds Ctrl」 is simply false on a
    /// Mac, where the same product gesture is ⌘Z. The FUNCTION is unchanged.
    fn with_primary_mod(vk: u16) -> Self {
        Self {
            vk,
            modifiers: vec![MOD_PRIMARY],
        }
    }
}

// The six-key table is PRODUCT-level (「enter」/「undo」/「clear」…); the numbers below
// are what each of those means to the OS in front of us. Plain constants rather
// than a platform newtype so `key_sequence_for` stays pure and unit-testable on
// every target.
//
// ⚠️ THE NAMES USED TO BE `VK_*` AND THE VALUES USED TO BE WinUser.h ONLY. That was
// right while the desktop was Windows-only and became a lie the moment it was not:
// a table that answers 「which key」 has to answer it for the machine it is running
// on. Both spellings are kept side by side below precisely so the mapping between
// them is readable rather than remembered.

/// Win32 virtual-key codes (WinUser.h).
#[cfg(not(target_os = "macos"))]
mod keys {
    pub const KEY_BACKSPACE: u16 = 0x08; // VK_BACK
    pub const KEY_TAB: u16 = 0x09; // VK_TAB
    pub const KEY_RETURN: u16 = 0x0D; // VK_RETURN
    pub const MOD_PRIMARY: u16 = 0x11; // VK_CONTROL
    pub const KEY_SPACE: u16 = 0x20; // VK_SPACE
    pub const KEY_DELETE: u16 = 0x2E; // VK_DELETE (forward delete)
    pub const KEY_A: u16 = 0x41; // VK_A
    pub const KEY_Z: u16 = 0x5A; // VK_Z
}

/// Carbon HIToolbox `Events.h` virtual key codes, taken from
/// [`crate::inject::macos::event_post`] so the paste keystroke and the six control
/// keys cannot end up with two different ideas of what ⌫ is.
///
/// 🔴 TWO SUBSTITUTIONS ARE PRODUCT DECISIONS, NOT TRANSLITERATIONS:
///   · the primary modifier is COMMAND, not Control. ⌃Z on macOS is not undo;
///     ⌘Z is. A literal transliteration of `VK_CONTROL` would produce a chord that
///     does something else in every app.
///   · `KEY_DELETE` maps to kVK_ForwardDelete (⌦) rather than kVK_Delete (⌫),
///     because it is the second half of 「clear」 = select-all-then-delete and it
///     must stay the analog of the Win32 Delete key. `KEY_BACKSPACE` is the ⌫ one.
///     Both delete a selection, so 「clear」 works either way — but collapsing the
///     two constants would make 「backspace」 and 「clear」 indistinguishable in the
///     table, and the six kinds are supposed to be six.
#[cfg(target_os = "macos")]
mod keys {
    use crate::inject::macos::event_post;
    pub const KEY_BACKSPACE: u16 = event_post::KVK_DELETE; // ⌫
    pub const KEY_TAB: u16 = event_post::KVK_TAB;
    pub const KEY_RETURN: u16 = event_post::KVK_RETURN;
    pub const MOD_PRIMARY: u16 = event_post::KVK_COMMAND; // ⌘, not ⌃
    pub const KEY_SPACE: u16 = event_post::KVK_SPACE;
    pub const KEY_DELETE: u16 = event_post::KVK_FORWARD_DELETE; // ⌦
    pub const KEY_A: u16 = event_post::KVK_ANSI_A;
    pub const KEY_Z: u16 = event_post::KVK_ANSI_Z;
}

use keys::{
    KEY_A, KEY_BACKSPACE, KEY_DELETE, KEY_RETURN, KEY_SPACE, KEY_TAB, KEY_Z, MOD_PRIMARY,
};

/// Map a control:key kind to the ordered chord sequence that realises it.
/// Returns `None` for any kind outside the six-key whitelist so the caller can
/// fail loudly with CONTROL_UNKNOWN_KIND.
///
///   enter     → Return
///   backspace → Backspace (⌫)
///   undo      → PRIMARY+Z        (Ctrl+Z on Windows, ⌘Z on macOS)
///   clear     → PRIMARY+A then Delete (select-all, then delete the field)
///   tab       → Tab
///   space     → Space
pub fn key_sequence_for(kind: &str) -> Option<Vec<KeyChord>> {
    match kind {
        "enter" => Some(vec![KeyChord::bare(KEY_RETURN)]),
        "backspace" => Some(vec![KeyChord::bare(KEY_BACKSPACE)]),
        "undo" => Some(vec![KeyChord::with_primary_mod(KEY_Z)]),
        "clear" => Some(vec![
            KeyChord::with_primary_mod(KEY_A),
            KeyChord::bare(KEY_DELETE),
        ]),
        "tab" => Some(vec![KeyChord::bare(KEY_TAB)]),
        "space" => Some(vec![KeyChord::bare(KEY_SPACE)]),
        _ => None,
    }
}

/// v0.2.1 — the PUNCTUATION half of the control:key whitelist (owner 2026-07-28:
/// tapping 。 must land on the PC, completing the sentence already there, rather
/// than filling a compose box on the phone).
///
/// These cannot be chords. Full-width CJK punctuation has no virtual-key code —
/// there is no VK for 「、」 — so they are TYPED as text through the same
/// SendInput unicode path an utterance uses, which also gets them the focus
/// discipline, the injection gate and the read-back receipt for free.
///
/// The table mirrors `CONTROL_KEY_PUNCTUATION` in
/// packages/protocol/src/protocol-schemas-inject.ts. Keeping the glyph out of
/// the wire payload and on BOTH ends by name is deliberate: a kind that means
/// one character on the phone and another on the PC would be undetectable.
pub fn punctuation_for(kind: &str) -> Option<&'static str> {
    match kind {
        "punct_comma" => Some("，"),
        "punct_question" => Some("？"),
        "punct_exclamation" => Some("！"),
        "punct_enumeration" => Some("、"),
        "punct_colon" => Some("："),
        "punct_period" => Some("。"),
        _ => None,
    }
}

/// Errors returned by the Win32 chord-emit path. Mirrors sendinput.rs
/// `InjectError` so the failure surface stays consistent across inject.
#[derive(Debug, thiserror::Error)]
pub enum FlowKeyError {
    #[error("SendInput rejected the flow-key chord (returned 0)")]
    Rejected,
    #[error("Win32 error: {0}")]
    Win32(u32),
}

/// Emit `chords` to the OS as real keystrokes. Windows-only; non-windows
/// returns `Win32(0)` so cross-target `cargo check` still compiles.
#[cfg(target_os = "windows")]
pub fn send_chords(chords: &[KeyChord]) -> Result<(), FlowKeyError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    fn key_event(vk: u16, key_up: bool) -> INPUT {
        let flags = if key_up {
            KEYEVENTF_KEYUP
        } else {
            KEYBD_EVENT_FLAGS(0)
        };
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    if chords.is_empty() {
        return Ok(());
    }

    // For each chord: press modifiers (in order), press+release the primary
    // key, release modifiers (reverse). One SendInput call keeps the modifier
    // window atomic so e.g. Ctrl is guaranteed held across Z.
    let mut inputs: Vec<INPUT> = Vec::new();
    for chord in chords {
        for &m in &chord.modifiers {
            inputs.push(key_event(m, false));
        }
        inputs.push(key_event(chord.vk, false));
        inputs.push(key_event(chord.vk, true));
        for &m in chord.modifiers.iter().rev() {
            inputs.push(key_event(m, true));
        }
    }

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    if sent as usize != inputs.len() {
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        if err.0 == 0 {
            return Err(FlowKeyError::Rejected);
        }
        return Err(FlowKeyError::Win32(err.0));
    }
    Ok(())
}

/// macOS: the same chords through CGEvent (MAC-05).
///
/// Each chord is one `post_chord` — modifiers ride the key events as FLAGS rather
/// than as their own press/release pair, which is why `KeyChord::modifiers` (a list
/// of virtual keys) is translated through `event_post::flag_for_modifier` here.
/// The reason that form was chosen, including what it costs, is in
/// `inject/macos/event_post.rs`'s header.
///
/// ⚠️ `Ok(())` CLAIMS LESS HERE THAN ON WINDOWS. `SendInput` reports how many
/// events the OS accepted, so the Win32 arm can tell a rejection from a delivery;
/// `CGEventPost` returns void, so `Ok(())` means only 「the events were created and
/// posted」 — NEVER that anybody received them.
///
/// 🔴 CORRECTED IN PLACE (W3 adversarial review, 2026-08-07) —— this used to
/// continue with:
///   「Whether they were DELIVERED is decided by the two OS conditions read in
///    `preflight::synthetic_input_preflight` before any of this runs — which is
///    why control keys are refused up front rather than judged after the fact.」
/// **That sentence was false at the time it was written.** The two injection
/// paths did go through that gate, **but the chord path did not**:
/// `send_chords`'s only production call site (the `control:key` branch of
/// `socket/inject_ops.rs`) at the time went straight from `set_foreground_window`
/// → `send_chords`, **never once calling preflight**.
/// The consequence was not 「one less safety net」 but **false reporting**: when
/// macOS was not authorized, `post_chord` answered `true`, this function answered
/// `Ok(())`, and the log wrote 「chord … sent」 — while `control:key` **has no
/// receipt frame**, so that log line was its **only** piece of evidence.
/// ⇒ **The gate has since been wired onto the chord path in the same round**
/// (`inject_ops.rs`, and deliberately placed **before**
/// `set_foreground_window` — a refusal must not be allowed to steal the
/// foreground). The sentence above is now true, **but it was not at the time it
/// was written** — the original text is kept as-is because it is itself a sample
/// of 「a comment asserting other code's behaviour can go stale on its own」
/// (anti-façade ④).
/// ⚠️ **The anchors to grep**: `synthetic_input_preflight(` and
/// `ChordExit::OsWillNotDeliver` in `inject_ops.rs`. This sentence no longer has
/// to stand as its own evidence.
#[cfg(target_os = "macos")]
pub fn send_chords(chords: &[KeyChord]) -> Result<(), FlowKeyError> {
    use crate::inject::macos::event_post;
    use objc2_core_graphics::CGEventFlags;
    for chord in chords {
        let mut flags = CGEventFlags::empty();
        for &m in &chord.modifiers {
            flags |= event_post::flag_for_modifier(m);
        }
        if !event_post::post_chord(chord.vk, flags) {
            // The window server would not allocate the event objects. Named as a
            // rejection rather than as a Win32 code that does not exist here.
            return Err(FlowKeyError::Rejected);
        }
    }
    Ok(())
}

/// Every other host: no synthetic input at all.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn send_chords(_chords: &[KeyChord]) -> Result<(), FlowKeyError> {
    Err(FlowKeyError::Win32(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_six_whitelisted_kinds_map_to_the_spec_keys() {
        assert_eq!(key_sequence_for("enter"), Some(vec![KeyChord::bare(KEY_RETURN)]));
        assert_eq!(
            key_sequence_for("backspace"),
            Some(vec![KeyChord::bare(KEY_BACKSPACE)])
        );
        assert_eq!(
            key_sequence_for("undo"),
            Some(vec![KeyChord::with_primary_mod(KEY_Z)])
        );
        assert_eq!(
            key_sequence_for("clear"),
            Some(vec![
                KeyChord::with_primary_mod(KEY_A),
                KeyChord::bare(KEY_DELETE)
            ]),
        );
        assert_eq!(key_sequence_for("tab"), Some(vec![KeyChord::bare(KEY_TAB)]));
        assert_eq!(key_sequence_for("space"), Some(vec![KeyChord::bare(KEY_SPACE)]));
    }

    #[test]
    fn undo_holds_the_primary_modifier_across_z() {
        let seq = key_sequence_for("undo").expect("undo whitelisted");
        assert_eq!(
            seq[0].modifiers,
            vec![MOD_PRIMARY],
            "undo must hold the platform's primary modifier"
        );
        assert_eq!(seq[0].vk, KEY_Z);
    }

    /// 🔴 THE TEST ABOVE PROVES THE TABLE EQUALS ITSELF, and that is not enough on
    /// its own: every assertion in it is written in terms of the very constants
    /// the table is built from, so a whole platform's numbers could be wrong and it
    /// would stay green. The NUMBERS are therefore restated here as literals, per
    /// platform — the same discipline `clipboard_snapshot`'s
    /// `handle_typed_formats_never_reach_the_hglobal_api` applies to the Winuser.h
    /// format ids, and for the same reason: restating them IS the point.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_windows_key_numbers_are_the_winuser_h_ones() {
        assert_eq!(KEY_BACKSPACE, 0x08, "VK_BACK");
        assert_eq!(KEY_TAB, 0x09, "VK_TAB");
        assert_eq!(KEY_RETURN, 0x0D, "VK_RETURN");
        assert_eq!(MOD_PRIMARY, 0x11, "VK_CONTROL is the Windows primary modifier");
        assert_eq!(KEY_SPACE, 0x20, "VK_SPACE");
        assert_eq!(KEY_DELETE, 0x2E, "VK_DELETE");
        assert_eq!(KEY_A, 0x41, "VK_A");
        assert_eq!(KEY_Z, 0x5A, "VK_Z");
    }

    /// The macOS half of the same guard. `MOD_PRIMARY` is the one that would be
    /// silently wrong: ⌃Z is not undo on this platform, and a chord built from
    /// Win32's 0x11 would post a key that means nothing at all.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_key_numbers_are_the_carbon_ones_and_the_modifier_is_command() {
        assert_eq!(KEY_BACKSPACE, 0x33, "kVK_Delete — the ⌫ key");
        assert_eq!(KEY_TAB, 0x30, "kVK_Tab");
        assert_eq!(KEY_RETURN, 0x24, "kVK_Return");
        assert_eq!(MOD_PRIMARY, 0x37, "kVK_Command — NOT Control (0x3B)");
        assert_eq!(KEY_SPACE, 0x31, "kVK_Space");
        assert_eq!(KEY_DELETE, 0x75, "kVK_ForwardDelete — the ⌦ key");
        assert_eq!(KEY_A, 0x00, "kVK_ANSI_A");
        assert_eq!(KEY_Z, 0x06, "kVK_ANSI_Z");
        assert_ne!(
            KEY_BACKSPACE, KEY_DELETE,
            "⌫ and ⌦ are different keys; collapsing them makes 「backspace」 and the second \
             half of 「clear」 indistinguishable"
        );
    }

    #[test]
    fn unknown_kind_returns_none_for_a_typed_error() {
        // Case-sensitive and trim-sensitive: only the exact six map.
        for kind in ["", "Enter", "ENTER", "delete", "escape", "foo", "  enter "] {
            assert_eq!(
                key_sequence_for(kind),
                None,
                "kind {kind:?} is outside the six-key whitelist and must not map",
            );
        }
    }

    // ── v0.2.1 punctuation family ───────────────────────────────────────────

    #[test]
    fn every_punctuation_kind_maps_to_its_glyph() {
        // The table must match packages/protocol CONTROL_KEY_PUNCTUATION exactly.
        // A kind meaning one character here and another on the phone would be
        // invisible in every test that only checks 「something was typed」.
        for (kind, glyph) in [
            ("punct_comma", "，"),
            ("punct_question", "？"),
            ("punct_exclamation", "！"),
            ("punct_enumeration", "、"),
            ("punct_colon", "："),
            ("punct_period", "。"),
        ] {
            assert_eq!(punctuation_for(kind), Some(glyph), "kind={kind}");
        }
    }

    #[test]
    fn the_two_families_never_overlap() {
        // A kind must be a chord OR a glyph, never both — otherwise the router in
        // run_control_key silently prefers one and the other becomes dead code.
        for kind in ["enter", "backspace", "undo", "clear", "tab", "space"] {
            assert_eq!(punctuation_for(kind), None, "chord kind {kind} must not type text");
        }
        for kind in ["punct_comma", "punct_period", "punct_colon"] {
            assert!(key_sequence_for(kind).is_none(), "punctuation {kind} has no chord");
        }
    }

    #[test]
    fn an_unknown_punctuation_kind_is_refused_not_guessed() {
        // No catch-all: an unrecognised kind falls through to CONTROL_UNKNOWN_KIND
        // rather than typing something plausible.
        assert_eq!(punctuation_for("punct_semicolon"), None);
        assert_eq!(punctuation_for("punct_"), None);
        assert_eq!(punctuation_for(""), None);
    }
}

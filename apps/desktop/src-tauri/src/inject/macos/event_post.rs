// SPEC-REF:
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md §A MAC-05
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback — the paste
//     keystroke itself)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The synthetic keystroke half of the macOS injection path: create a CGEvent
// keyboard pair and post it to the HID event tap. This is the Cmd+V that makes a
// pasteboard write into a paste, and it is also what `flow_key::send_chords`
// emits for the six control keys.
//
// ── 🔴 WHAT `post_chord` RETURNING `true` CLAIMS, AND WHAT IT DOES NOT ───────
//
// `CGEventPost` RETURNS VOID. There is no success value, no error code, no
// GetLastError equivalent — nothing anywhere on this path can tell us that a
// keystroke was received, or even that it was delivered. `true` here means
// exactly one thing: the two events were CREATED and handed to the window server.
//
// That is strictly less than what Win32's `SendInput` tells us (「the OS accepted
// N events into the input queue」, and 0 means the app dropped them), and it is
// why the two OS-level pre-conditions in `secure_input.rs` are checked BEFORE any
// of this runs rather than inferred after it. When Accessibility is not granted
// or secure input is on, every line below still succeeds and nothing arrives.
// A `false` from here is therefore a very narrow failure (the OS would not even
// allocate the event objects), not a delivery verdict.
//
// ── Why the modifier rides the key events instead of being its own keystroke ──
//
// Cmd+V could be spelled as four events (Command down, V down, V up, Command up).
// It is spelled as two events carrying `MaskCommand` instead, because the
// four-event form leaves a REAL modifier held down in the window server between
// the first and last post — and if anything goes wrong in between (a panic, a
// process kill, an app that eats the key-up) the user's machine is left with a
// stuck Command key, which is a far worse failure than a paste that did not
// happen. The flags form has no such window. Some apps that hand-roll their own
// key handling read only the physical modifier state; those are the ones this V1
// may miss, and that is the trade being made here rather than discovered later.

use objc2_core_graphics::{
    CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
};

// Carbon HIToolbox `Events.h` virtual key codes. Spelled as literals on purpose —
// restating the numbers IS the point; importing them from somewhere that derives
// them the same way would only prove they equal themselves.
/// kVK_ANSI_A
pub const KVK_ANSI_A: u16 = 0x00;
/// kVK_ANSI_Z
pub const KVK_ANSI_Z: u16 = 0x06;
/// kVK_ANSI_V — the paste key.
pub const KVK_ANSI_V: u16 = 0x09;
/// kVK_Return
pub const KVK_RETURN: u16 = 0x24;
/// kVK_Tab
pub const KVK_TAB: u16 = 0x30;
/// kVK_Space
pub const KVK_SPACE: u16 = 0x31;
/// kVK_Delete — the key labelled ⌫. This is macOS's BACKSPACE, not its
/// forward-delete; the name in Events.h is the historical one and reversing the
/// two here would silently delete the character on the wrong side of the caret.
pub const KVK_DELETE: u16 = 0x33;
/// kVK_ForwardDelete — the key labelled ⌦, the analog of Win32 `VK_DELETE`.
pub const KVK_FORWARD_DELETE: u16 = 0x75;
/// kVK_Command — the PRIMARY modifier on this platform, where Win32 uses Control.
pub const KVK_COMMAND: u16 = 0x37;

/// Map a modifier VIRTUAL KEY to the event flag that stands for it.
///
/// `KeyChord::modifiers` carries virtual keys (that is what Win32's `SendInput`
/// path needs), and CGEvent wants a flag mask, so the translation happens here
/// rather than by giving `KeyChord` a second, platform-shaped field. An unknown
/// modifier contributes NOTHING and is NOT silently treated as Command — a chord
/// that asked for a modifier we cannot express must come out weaker, never
/// different (「clear」 arriving as an unexpected Cmd+something is the destructive
/// direction).
pub fn flag_for_modifier(virtual_key: u16) -> CGEventFlags {
    match virtual_key {
        KVK_COMMAND => CGEventFlags::MaskCommand,
        _ => CGEventFlags::empty(),
    }
}

/// Press and release `virtual_key` with `flags` held, at the HID event tap.
///
/// Returns whether the events could be created and posted — see the module header
/// for the exact (narrow) meaning of `true`.
pub fn post_chord(virtual_key: u16, flags: CGEventFlags) -> bool {
    // A NULL source is legal and is what CGEventCreateKeyboardEvent documents for
    // 「a private source with default state」. `HIDSystemState` is asked for first
    // because it makes our synthetic events carry the same source state the real
    // keyboard does, which is what apps that inspect the source expect.
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
    let src = source.as_deref();

    let (Some(down), Some(up)) = (
        CGEvent::new_keyboard_event(src, virtual_key, true),
        CGEvent::new_keyboard_event(src, virtual_key, false),
    ) else {
        return false;
    };
    if !flags.is_empty() {
        CGEvent::set_flags(Some(&down), flags);
        CGEvent::set_flags(Some(&up), flags);
    }
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&down));
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&up));
    true
}

/// The paste keystroke: ⌘V.
pub fn post_command_v() -> bool {
    post_chord(KVK_ANSI_V, CGEventFlags::MaskCommand)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The virtual key codes are the contract with the OS, so they are pinned as
    /// numbers. A transposition here is invisible in every other test — `enter`
    /// would still 「map to a key」 and the suite would still be green while the
    /// user's Return typed a Tab.
    #[test]
    fn the_virtual_key_codes_are_the_carbon_ones() {
        assert_eq!(KVK_ANSI_A, 0x00);
        assert_eq!(KVK_ANSI_Z, 0x06);
        assert_eq!(KVK_ANSI_V, 0x09);
        assert_eq!(KVK_RETURN, 0x24);
        assert_eq!(KVK_TAB, 0x30);
        assert_eq!(KVK_SPACE, 0x31);
        assert_eq!(KVK_DELETE, 0x33);
        assert_eq!(KVK_FORWARD_DELETE, 0x75);
        assert_eq!(KVK_COMMAND, 0x37);
        // ⌫ and ⌦ are different keys and must never collapse into one constant.
        assert_ne!(KVK_DELETE, KVK_FORWARD_DELETE);
    }

    /// An unrecognised modifier must weaken the chord, not change it.
    #[test]
    fn an_unknown_modifier_contributes_no_flag_rather_than_a_guessed_one() {
        assert_eq!(flag_for_modifier(KVK_COMMAND), CGEventFlags::MaskCommand);
        for unknown in [0u16, 0x11 /* Win32 VK_CONTROL, meaningless here */, 0xFFFF] {
            assert!(
                flag_for_modifier(unknown).is_empty(),
                "modifier {unknown:#06x} must not be silently promoted to Command"
            );
        }
    }

    // NOTE there is deliberately no test that POSTS an event. Posting reaches the
    // real window server and types into whatever is in front of the machine
    // running the suite — the same hazard that got the Stage-2/Stage-3 tests
    // marked `#[ignore]` on Windows (pipeline_tests.rs). The delivery half of this
    // module is verified on a real desktop, not here, and that is stated rather
    // than papered over with a test that proves nothing.
}

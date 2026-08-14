// SPEC-REF:
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md §A MAC-05
//   master-plan §4 / CLAUDE.md red line: no silent failures — both directions forbidden
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The two OS-level facts that decide whether a synthetic Cmd+V can be DELIVERED
// AT ALL on macOS. Both are read BEFORE anything is written to the pasteboard and
// before any activation, because both of them make the keystroke vanish WITHOUT
// any API returning an error:
//
//   ① AXIsProcessTrusted() == false
//      Since 10.14 a process that is not trusted for Accessibility may still
//      CREATE and POST CGEvents — `CGEventPost` returns void and nothing fails —
//      and the OS drops them on the floor. There is no error to check afterwards.
//   ② IsSecureEventInputEnabled() == true
//      A password field, Terminal's 「Secure Keyboard Entry」, screen lock and a
//      few password managers put the window server into secure input mode, where
//      synthetic key events are not delivered to anyone. Again: no error.
//
// 🔴 THIS IS THE 「false reporting」 SHAPE IN ITS PUREST FORM. Everything our code does
// succeeds — the pasteboard write returns YES, the activation returns YES, the
// events are created and posted — and not one character arrives. Anything that
// reported `injected` off those return values would be lying with a completely
// clean conscience, which is why the check is a PRE-condition (a named refusal
// before any side effect) and not a post-condition (there is nothing to check).
//
// ⚠️ WHAT THESE TWO FUNCTIONS DO NOT CLAIM. `accessibility_trusted() == true`
// means the OS says this binary is in the Accessibility list RIGHT NOW; it does
// not promise the next event lands. `secure_event_input_enabled() == false` is a
// reading taken before the paste, and a user can focus a password field in the
// millisecond after it — this narrows the window, it does not close it. The
// honest claim the pipeline makes on the strength of them is the same one it
// makes on Windows: 「delivered to the keyboard focus, and the focus is not
// provably non-input-capable」
// (docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md).
//
// ── TCC binds to the CODE SIGNATURE, and under adhoc signing that bites ──────
// The Accessibility grant is keyed on the binary's code-signing identity. An
// ad-hoc signed build (which is what 0.2.5x produces on the Mac mini until the
// Apple account lands — IT-21 keeps 「shipping the package」 and 「being trusted」 apart on purpose) gets a
// NEW identity on every rebuild, so the permission the user granted five minutes
// ago is revoked by the next `tauri build`. That is not a bug in this file and it
// is not something this file can fix; it is stated here so the next person does
// not spend an afternoon on 「the permission keeps disappearing」.
//
// ── Zero new crates ──────────────────────────────────────────────────────────
// Two `extern "C"` declarations against frameworks the process already links.
// Both are declared `-> u8` rather than `-> bool`: the C return type is Carbon's
// `Boolean`, i.e. `unsigned char`, and materialising a `bool` from a byte that is
// not exactly 0 or 1 is undefined behaviour in Rust. Comparing against 0 is not
// pedantry, it is the only sound spelling.

// `AXIsProcessTrusted` lives in HIServices, inside the ApplicationServices
// umbrella framework. (Plain `//`, not `///` — rustdoc does not document extern
// blocks and warns about the attempt.)
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

// `IsSecureEventInputEnabled` lives in HIToolbox, inside the Carbon umbrella
// framework. Still present and still public on Apple Silicon (verified: this file
// links and the test below calls it, on the Mac mini 2026-08-07).
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

/// Is this process trusted for Accessibility (i.e. allowed to post synthetic
/// events to other applications)?
///
/// Read-only and prompt-free: the *prompting* variant is
/// `AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt)`, deliberately NOT
/// used here. A permission dialog raised from inside the injection path would pop
/// a window over whatever the user is typing in — i.e. it would take the very
/// foreground this code exists to respect — and it would do so once per utterance
/// while the answer stays false.
pub fn accessibility_trusted() -> bool {
    // SAFETY: a nullary C function returning a byte. No pointers, no ownership.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Is the window server in secure input mode right now (a password field or
/// Terminal's Secure Keyboard Entry is active)?
pub fn secure_event_input_enabled() -> bool {
    // SAFETY: as above.
    unsafe { IsSecureEventInputEnabled() != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both readers must ANSWER — the point of the card is that they are consulted
    /// before every injection, and a reader that panics or fails to link is a
    /// reader nobody can consult.
    ///
    /// The VALUES are properties of the machine running the suite (a CI box and an
    /// SSH session are both untrusted; a developer's own desktop may be trusted),
    /// so asserting either one would be asserting the weather. What is asserted is
    /// that the call is real: it links, it returns, and it returns the same answer
    /// twice in a row.
    #[test]
    fn both_os_readers_link_and_answer() {
        let ax = accessibility_trusted();
        let secure = secure_event_input_enabled();
        assert_eq!(ax, accessibility_trusted(), "AXIsProcessTrusted is not stable");
        assert_eq!(
            secure,
            secure_event_input_enabled(),
            "IsSecureEventInputEnabled is not stable"
        );
    }
}

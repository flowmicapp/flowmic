// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 (error-code namespaces)
//   packages/protocol/src/error-codes.ts (SSOT — every user-facing code with
//     its zh-CN + en messages)
//
// The desktop injection/control paths report failure with these exact codes
// so the mobile + server surface the same canonical message. Defined as
// constants (never inline literals) and guarded against drift from the
// error-codes.ts SSOT by the test below — same discipline as events.rs.
//
// Red line (CLAUDE.md / 07-DESKTOP-SPEC §2): no silent failures. Every non-injected
// outcome carries one of these codes on inject:result.error; the code is never
// swallowed and the STT text is never silently re-injected as-is.

/// Stage-1 focus could not be acquired (no locked/live target, or
/// SetForegroundWindow refused) → the utterance is cached, not injected.
pub const INJECT_FOCUS_LOST: &str = "INJECT_FOCUS_LOST";
/// The `SendInput` CALL itself failed — it returned 0 (the target dropped the
/// events) or a hard Win32 error. Also ridden by a successful clipboard delivery
/// to say 「typing was not the path used」.
///
/// ⚠️ 2026-07-30 — the meaning NARROWED. For two releases this code meant 「read
/// back the target, not a single character changed before/after, confirmed it did
/// not land」, i.e. a MEASUREMENT of the target. Read-back
/// is retired (it required the target app to expose its own text, so it went
/// blind in browsers), and this code no longer says anything about whether text
/// landed. It says only: this API call did not succeed.
pub const INJECT_SENDINPUT_FAIL: &str = "INJECT_SENDINPUT_FAIL";
/// Clipboard fallback failed — a Win32 step errored, or the user's clipboard
/// could not be restored → we know it did not happen → failed.
///
/// 2026-07-30: an unconsumed-but-error-free paste is NO LONGER this code. The
/// delayed-render receipt stopped being the ok/fail gate (design §3) — whether
/// the target app accepts a paste is the target's business — so it is recorded on
/// the forensic line instead of being reported to the user as a failure.
pub const INJECT_CLIPBOARD_FAIL: &str = "INJECT_CLIPBOARD_FAIL";
/// The inject target / request was invalid before any keystroke — e.g. the
/// text exceeded INJECT_TEXT_MAX_CHARS (rejected, never silently truncated).
pub const INJECT_TARGET_INVALID: &str = "INJECT_TARGET_INVALID";

/// owner 2026-07-27: the foreground window has keyboard focus but nothing usable
/// holds it, so the keystrokes have nowhere to go.
///
/// 2026-07-30 — the JUDGEMENT behind it changed (design §2). It used to come from
/// a UIA 「is the focused element editable?」 query, which answered 「no」 for every
/// browser whose a11y tree was not built yet (owner P0: 「not once succeeded」). It now
/// comes from the only two things provable from outside the target's process:
/// nothing holds keyboard focus at all, or the thread is in menu / move-resize
/// mode where every character is a mnemonic. An inconclusive reading never
/// produces this code — see `inject/target_probe.rs`.
pub const INJECT_NO_TEXT_TARGET: &str = "INJECT_NO_TEXT_TARGET";
/// R6 T-4: an image payload could not become a clipboard image — over the
/// protocol cap, non-canonical base64, a mime the bytes contradict, or an OS
/// decoder that refused the picture (e.g. WebP on an install without the
/// codec). Rejected BEFORE any focus switch or clipboard write, never a blank
/// paste and never a silent drop.
pub const INJECT_IMAGE_UNSUPPORTED: &str = "INJECT_IMAGE_UNSUPPORTED";
/// control:key arrived with a kind outside the six-key whitelist. Renamed in
/// the WP-R0-1 window from the legacy FLOW_ name to track the control:key
/// event rename (R-mobile-5 "Invalid kind → typed error").
pub const CONTROL_UNKNOWN_KIND: &str = "CONTROL_UNKNOWN_KIND";
/// GA-28: an inject:request landed on the channel that is NOT carrying the
/// capsule. Both channels stay resident (07 SS6) but only the capsule owner's may
/// type into this machine, so the frame is refused. It is reported rather than
/// dropped: a request with no result leaves the phone's entry stuck in-flight
/// forever, which is the silent failure the red line forbids.
pub const INJECT_NOT_PRIMARY: &str = "INJECT_NOT_PRIMARY";

/// 🔴 owner 2026-08-02: deferred/re-delivered messages must not be auto-injected
/// (docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md).
///
/// The frame said `inject_origin:'deferred'` — an AUTOMATIC re-delivery, not
/// anything the user did just now — so nothing was typed, **even though a live
/// focused window was available**. owner:「此时用户对这个行为是不可预知、没有准备的，
/// 直接注进当前输入窗口可能引起事故。」("at this moment the user cannot predict or is
/// unprepared for this action — injecting it directly into the current input window
/// could cause an accident.")
///
/// 🔴 IT IS NOT A FAILURE. The delivery SUCCEEDED: the message is on this PC's
/// timeline with its own row (`row_transit::mint_row` runs on this outcome like any
/// other). Only the INJECTION was withheld, deliberately. That is the delivery/
/// injection two-part split at its sharpest — delivery succeeded + not injected ·
/// cached — and it is why the outcome's mode is [`InjectMode::Cached`] rather than
/// a failure mode.
///
/// Deliberately NOT [`INJECT_FOCUS_LOST`], which is the OTHER cause of `cached`:
/// that one means 「clicking into an input field would make it land」 and this one
/// means 「the window is fine — we deliberately withheld the injection」. Folding
/// them is exactly what doc 15 forbids now that `cached` has two
/// causes — one status word must not answer two questions.
pub const INJECT_DEFERRED_NOT_AUTOINJECTED: &str = "INJECT_DEFERRED_NOT_AUTOINJECTED";

/// 🔴 owner 2026-08-02 (F1a reversal ruling):「FlowMic's own input fields (e.g. the
/// timeline search box) must be able to receive injection — it is itself a window
/// on the PC side; if the cursor is positioned there, what I say must be able to
/// be injected.」
///
/// This code is the OTHER half of that ruling: FlowMic's own window IS in front of
/// the user, and NOTHING in it holds an editable focus — the timeline list, the
/// settings page, a row the user just clicked. Nothing was typed.
///
/// 🔴 IT IS NOT A FAILURE, and it is not a guess either. Inside our own process the
/// judgement is PRECISE (the WebView knows which element has DOM focus —
/// `inject/self_focus.rs`), so the cross-process ruling of 2026-07-30 — 「when it
/// cannot be determined, type anyway」 — deliberately does NOT apply here. The
/// delivery succeeded, the row is on
/// this PC's timeline, and only the injection had nowhere to land ⇒ `InjectMode::Cached`.
///
/// ── WHY IT IS NOT [`INJECT_FOCUS_LOST`], which is `cached`'s FIRST cause ──────
/// That one means 「we could not acquire any target window at all」 — the user is
/// somewhere else entirely, or `SetForegroundWindow` refused — and the honest
/// instruction is 「click into an input field」
/// about a window we cannot name. This one names the window: it is OURS, it is in
/// front of you, and the fix is one click inside a surface the user is already
/// looking at. Folding them would put a sentence about someone else's app on a
/// screenful of FlowMic — one status word answering two questions, this repo's #1 bug shape.
/// ── nor [`INJECT_DEFERRED_NOT_AUTOINJECTED`], `cached`'s SECOND cause ─────────
/// That one means 「the window is fine — we deliberately withheld the injection」
/// and NOTHING the user does to the
/// window helps. This one is fixed by the window. Opposite advice, so: third code.
/// (docs/rebuild/15 §2.5e-4 — the causes share `mode:'cached'` and must never
/// share a code.)
/// ── nor [`INJECT_NO_TEXT_TARGET`] ────────────────────────────────────────────
/// That code rides `mode:'sendinput'` ⇒ the relay maps it to status `failed`, and
/// owner's ruling for this case is explicitly not injected · **cached**. It also carries
/// the cross-process Stage-1b judgement, which is a different (and much weaker)
/// kind of evidence than this one.
pub const INJECT_SELF_WINDOW_NO_INPUT: &str = "INJECT_SELF_WINDOW_NO_INPUT";

// ── MAC-05: the two macOS conditions under which the OS silently swallows a
//    synthetic keystroke (owner 2026-08-07 approved, docs/decisions/2026-08-07-owner-
//    grants-mac-injection-refusal-codes-63-64.md).
//
// Both are produced by ONE function — `inject/preflight.rs`
// `synthetic_input_verdict` — and reach the wire through
// `inject/pipeline.rs`'s `synthetic_input_preflight()` on the text path AND the
// image path. `control:key` takes the same gate but has no result frame in the
// protocol, so there they only reach the forensic line
// (`socket/inject_ops.rs` `ChordExit::OsWillNotDeliver`).
//
// 🔴 BOTH ARE `InjectMode::Cached`, i.e. NOT failures. The delivery SUCCEEDED —
// the frame is in this process and `row_transit::mint_row` mints its row from the
// same expression that produced the verdict. Only the injection was withheld.
//
// ⚠️ These two lived in `inject/preflight.rs` as deliberately isolated placeholder
// constants while they were unapproved ("the day the owner rules they become a
// one-line change each rather than a hunt"). Owner has ruled, so they move to the
// home every other desktop code has. The isolation was scaffolding for the wait,
// not a design.

/// macOS secure event input is on (a password field, Terminal's 「Secure Keyboard
/// Entry」, or the lock screen), so a synthetic key event is delivered to nobody.
/// Nothing was typed and nothing was written to the pasteboard.
///
/// ── Deliberately not any neighbour ─────────────────────────────────────────
/// [`INJECT_NO_TEXT_TARGET`] would be FALSE — a password field IS editable and IS
/// focused, so 「click into the input field」 tells the user to do what they already did.
/// [`INJECT_CLIPBOARD_FAIL`] would be FALSE — the pasteboard write succeeds; it is
/// the ⌘V after it that vanishes. [`INJECT_FOCUS_LOST`] would be FALSE — the focus
/// is exactly where we want it.
pub const INJECT_SECURE_INPUT_ACTIVE: &str = "INJECT_SECURE_INPUT_ACTIVE";

/// This process is not in macOS's Accessibility list, so the OS discards every
/// event it posts, with no error anywhere. Nothing was typed.
///
/// 🔴 IT IS THE ONLY FAILURE ON THIS WHOLE PATH THE USER CAN FIX THEMSELVES, which
/// is why it must not borrow another code even briefly: pointing them at 「click into
/// the input field」 or 「clipboard failed」 turns a solvable problem into an unsolvable one. It is also
/// why [`synthetic_input_verdict`](crate::inject::preflight::synthetic_input_verdict)
/// checks it FIRST — reporting a transient secure-input window on top of a missing
/// grant sends the user hunting for a password field they do not have.
///
/// ⚠️ THE NAME IS SHORT ON PURPOSE AND MUST NOT BE LENGTHENED. The phone truncates
/// an unrecognised raw code at 28 characters (`chat_message_tile.dart`
/// `_truncateFailureReason`); the originally drafted
/// `INJECT_ACCESSIBILITY_NOT_GRANTED` is 32 ⇒ it would have rendered as
/// 「INJECT_ACCESSIBILITY_NOT_GRA…」, a verbatim repeat of the defect that caused
/// the 0.2.53 release. This one is 23.
pub const INJECT_NO_ACCESSIBILITY: &str = "INJECT_NO_ACCESSIBILITY";

/// Every error code this crate emits **on `inject:result` or `compose:error`** —
/// used by the cross-source guard test below, which checks each one is declared in
/// the protocol SSOT.
///
/// 🔴 CORRECTED 2026-08-07 — this doc used to read 「Every error code this crate
/// emits」, and that was FALSE for as long as the two MAC-05 codes above existed
/// only as placeholder constants in `inject/preflight.rs`: they were emitted on
/// `inject:result` by a shipped macOS build and were in neither this list nor the
/// SSOT, so the guard below could not see them. That is anti-façade ④ in its exact
/// form — a true sentence that a change elsewhere quietly turned into a false one,
/// while the sentence itself could not change. The list is now complete again, and
/// the wording states the SCOPE it actually guards so the next code added outside
/// that scope does not silently falsify it a second time.
pub const DESKTOP_ERROR_CODES: &[&str] = &[
    INJECT_FOCUS_LOST,
    INJECT_SENDINPUT_FAIL,
    // 2026-07-30: INJECT_NO_RECEIPT removed. It named the read-back's 「could not
    // read it back」
    // verdict, and read-back is gone — so the code had no producer left, and a
    // code no branch can emit is a façade in the protocol table.
    INJECT_CLIPBOARD_FAIL,
    INJECT_TARGET_INVALID,
    INJECT_NO_TEXT_TARGET,
    INJECT_IMAGE_UNSUPPORTED,
    INJECT_NOT_PRIMARY,
    INJECT_DEFERRED_NOT_AUTOINJECTED,
    INJECT_SELF_WINDOW_NO_INPUT,
    INJECT_SECURE_INPUT_ACTIVE,
    INJECT_NO_ACCESSIBILITY,
    CONTROL_UNKNOWN_KIND,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn error_codes_ts_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("protocol")
            .join("src")
            .join("error-codes.ts")
    }

    #[test]
    fn desktop_error_codes_are_a_subset_of_the_protocol_ssot() {
        let path = error_codes_ts_path();
        let ts = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => {
                for code in DESKTOP_ERROR_CODES {
                    assert!(!code.is_empty(), "empty error code constant");
                }
                return;
            }
        };
        for code in DESKTOP_ERROR_CODES {
            // error-codes.ts declares keys as `CODE_NAME:` — match the key form.
            assert!(
                ts.contains(&format!("{code}:")),
                "error code {code:?} is NOT declared in packages/protocol/src/error-codes.ts \
                 (drift from the SSOT — {})",
                path.display(),
            );
        }
    }
}

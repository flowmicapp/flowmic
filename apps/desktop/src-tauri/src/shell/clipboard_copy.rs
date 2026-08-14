// SPEC-REF:
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4b-7 (capsule
//     per-row copy button)
//   docs/strategy/2026-08-11-ios-mac-real-device-findings.md §3-1 (B3: on
//     macOS the copy action failed — forensic said the clipboard write is
//     not implemented on that platform)
//   CLAUDE.md red line: no silent failures / ambient surfacing never steals focus by activating
//
// V2-19 escalation (2026-08-02, coordinator-mandated): the capsule's copy
// button was first wired to the BROWSER `navigator.clipboard.writeText`, the
// same call `main-window/TimelinePage.vue` already uses. That call requires
// Chromium's `document.hasFocus()` to be true. The capsule's ENTIRE window
// carries `WS_EX_NOACTIVATE` (see `configure_capsule_window`, this module's
// sibling in `shell/mod.rs`) precisely so a click can never steal the user's
// real input focus (07 §4 / F-2344) — which means the capsule's WebView2
// document may never become "focused" in Chromium's sense EITHER, no matter
// what is clicked. If that is how WebView2 actually behaves, every browser-
// side clipboard write would reject with `NotAllowedError` unconditionally,
// making the button a façade (R8: 「a control that changes nothing is worse than no control at all」) —
// and a 20-minute owner real-machine session cannot fix that, it can only
// discover it three days late.
//
// This command therefore routes the write through the OS clipboard API
// DIRECTLY, which has no concept of "document focus" at all — focus is a
// browser/DOM notion, not a property either native clipboard API ever
// inspects (Win32's `OpenClipboard` takes a window handle only to attribute
// ownership/for `WM_DESTROYCLIPBOARD` bookkeeping; NSPasteboard has no window
// parameter at all). So this path is STRUCTURALLY IMMUNE to the WebView2-
// focus hazard, not merely likely to dodge it.
//
// ── B3 (2026-08-11): the entry is PLATFORM-NEUTRAL, the halves are per-OS ────
//
// This command used to hand `write_clipboard_formats` a literal WIN32 format
// id (`CF_UNICODETEXT`) unconditionally. On macOS that call is a NAMED
// refusal by design (a Win32 format id has no macOS meaning — see the macOS
// arm in `inject/clipboard_snapshot.rs`), and findings §3-1 is that refusal
// reaching the user: the capsule's copy button did nothing but log. The
// payload this command carries is TEXT and nothing else — the capsule row's
// copy button copies the row's rendered string (`capsule-copy.ts
// copyPayload`), and no image path exists on this command — so the neutral
// surface is one function, `copy_text_native(&str)`, and each platform
// supplies its own half:
//
//   · Windows — byte-for-byte the previous behavior: UTF-16LE + NUL under
//     CF_UNICODETEXT through `write_clipboard_formats`, one
//     Open→Empty→Set→Close cycle (retries transient ERROR_ACCESS_DENIED —
//     see `WinClipboardApi::open`).
//   · macOS — `inject::macos::pasteboard::write_text`: UTF-8 under
//     `NSPasteboardTypeString` via the same audited `write_items` the
//     injection paste path uses, as a one-shot forward write (no ⌘V, no
//     snapshot, no restore).
//   · every other host — a NAMED error plus a forensic line, never a silent
//     no-op (no silent failures): the button must show its honest ✗ state.
//
// 🔴 THE macOS HALF IS A PREPARED PATCH, NOT A DELIVERY. Every gate on the
// Windows lead box skips code behind non-Windows cfg — it is NOT COMPILED
// there, so nothing on that machine can prove it even parses. The device
// line must run `./scripts/mac-verify.sh` on the Mac and perform a real
// capsule copy → paste into TextEdit before any claim stronger than
// 「written」. Only the Windows half below is unit-proven.
//
// No snapshot is taken and nothing is restored, on ANY platform: a copy
// button REPLACING the previous clipboard content is exactly what "copy"
// means everywhere else, so there is nothing to save.
//
// *** Does NOT touch, does NOT modify, and is NOT called from:
//   · `inject::clipboard_paste::PASTE_LOCK` (the save→paste→restore
//     serialisation mutex) — this command never takes it, on purpose: it is
//     not part of an injection, so pretending to be one would only make an
//     unrelated caller wait on it for no reason. See the module-level safety
//     note in the round's handoff report for why NOT holding it is safe here
//     (`WinClipboardApi::open()` already retries `ERROR_ACCESS_DENIED` 10×15ms
//     — the exact contention class a concurrent writer produces — and Win32
//     serialises `OpenClipboard` globally, so the two call sites can only
//     ever interleave, never corrupt one another).
//   · `configure_capsule_window` / any window-flag code.
//   · Any file under `inject/` is imported from, never edited (the B3 round
//     added `pasteboard::write_text` in the inject layer as the macOS half;
//     THIS module still only imports).

use crate::inject::sendinput::InjectError;

#[cfg(windows)]
use crate::inject::clipboard_snapshot::write_clipboard_formats;

/// CF_UNICODETEXT (Winuser.h) — the exact format id
/// `inject::clipboard_snapshot`'s own test table already names
/// (`13, // CF_UNICODETEXT — the format the text path writes`). Restated
/// here rather than imported for the same reason that file restates its own
/// GDI-handle ids: the point is that this module's choice of format agrees
/// with Winuser.h, not merely with itself.
#[cfg(windows)]
const CF_UNICODETEXT: u32 = 13;

/// UTF-16LE + a trailing NUL — the exact byte layout CF_UNICODETEXT requires
/// (Win32 reads the HGLOBAL as a NUL-terminated wide string; a payload with
/// no terminator is read past its own end).
#[cfg(windows)]
fn utf16_nul_bytes(text: &str) -> Vec<u8> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let mut bytes = Vec::with_capacity(units.len() * 2);
    for u in units {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    bytes
}

/// Write `text` to the OS clipboard, platform-dispatched (see module header).
/// Any failure is returned, never swallowed, so the caller can show the
/// honest ✗ state (no silent failures).
///
/// The dispatch itself is proven by compilation, not by a test: exactly one
/// `copy_text_native` exists per platform (a missing or duplicated half is a
/// compile error), and the entry below has no other branch to take.
#[tauri::command]
pub fn capsule_copy_text(text: String) -> Result<(), String> {
    copy_text_native(&text).map_err(|e| e.to_string())
}

/// Windows half — byte-for-byte the pre-B3 behavior of `capsule_copy_text`.
#[cfg(windows)]
fn copy_text_native(text: &str) -> Result<(), InjectError> {
    write_clipboard_formats(vec![(CF_UNICODETEXT, utf16_nul_bytes(text))])
}

/// macOS half — 🔴 PREPARED ONLY, see the module header: not compiled by any
/// gate on the Windows lead box; requires a mac-verify run plus a real
/// capsule copy pasted into TextEdit on the Mac before any delivery claim.
#[cfg(target_os = "macos")]
fn copy_text_native(text: &str) -> Result<(), InjectError> {
    crate::inject::macos::pasteboard::write_text(text)
}

/// Every other host: FAIL, LOUDLY. A friendly `Ok(())` here would be the
/// doc 13 §7 F1 ② shape — the button animates, the clipboard never changes,
/// and nobody can ever explain why.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn copy_text_native(_text: &str) -> Result<(), InjectError> {
    crate::forensic::record(
        "shell",
        "capsule_copy_text: no clipboard write implementation on this platform — reporting the \
         failure by name instead of pretending the copy happened",
    );
    Err(InjectError::Unsupported(
        "capsule copy: this platform has no clipboard write implementation",
    ))
}

// Windows-only: every assertion below is about the CF_UNICODETEXT byte layout
// the Windows half constructs. The macOS half has no headless test that could
// mean anything off-Mac — its verification is the device line's mac-verify
// run plus a real paste (module header).
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn ascii_text_is_utf16le_plus_a_trailing_nul() {
        let bytes = utf16_nul_bytes("hi");
        // 'h'=0x68 'i'=0x69, each as a little-endian u16, then a u16 NUL.
        assert_eq!(bytes, vec![0x68, 0x00, 0x69, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn empty_text_is_just_the_terminator() {
        assert_eq!(utf16_nul_bytes(""), vec![0x00, 0x00]);
    }

    #[test]
    fn a_non_bmp_and_cjk_string_round_trips_through_utf16() {
        let text = "你好 😀";
        let bytes = utf16_nul_bytes(text);
        // Drop the trailing NUL unit, then decode the rest back with the
        // standard library's own UTF-16 decoder — proves the byte layout is
        // real UTF-16LE, not just "looks plausible".
        assert_eq!(bytes.len() % 2, 0);
        let mut units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(units.pop(), Some(0), "trailing NUL unit");
        let decoded = String::from_utf16(&units).expect("valid UTF-16");
        assert_eq!(decoded, text);
    }

    #[test]
    fn cf_unicodetext_matches_winuser_h() {
        // Same literal `inject::clipboard_snapshot`'s own test table asserts
        // is the text format — restated, not imported, on purpose (see the
        // module header): agreement with Winuser.h is the point, not
        // agreement with itself.
        assert_eq!(CF_UNICODETEXT, 13);
    }
}

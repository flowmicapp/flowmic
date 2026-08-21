// SPEC-REF:
//   docs/strategy/2026-08-21-ime-safe-inject-routing-design.md §2 (P0 hardening
//     item 1: exclude our transient clipboard content from history/cloud/monitors)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Marks the clipboard content FlowMic owns during a paste as TRANSIENT, using
// the three advisory formats Windows documents for exactly this:
//
//   · `ExcludeClipboardContentFromMonitorProcessing` — presence alone tells
//     clipboard monitors to ignore this update entirely;
//   · `CanIncludeInClipboardHistory` = DWORD 0 — keep it out of Win+V history;
//   · `CanUploadToCloudClipboard`  = DWORD 0 — never sync it across devices.
//
// WHY NOW: the IME-safe content route (pipeline.rs, 2026-08-21) makes the
// clipboard the MAIN path for every CJK injection — realtime dictation pastes a
// segment every few seconds. Without these marks each segment lands in the
// user's Win+V history and their cloud clipboard, and clipboard monitors read
// our delayed-render announcement — which is ALSO how a false 「confirmed」
// receipt happens: the history service fetching our delayed format is
// indistinguishable from the target consuming the paste. One mechanism, two
// wins.
//
// Included as a `#[path]` submodule of `clipboard_confirm::win` (the same shape
// as clipboard_withdraw.rs) so it compiles exactly where the delayed-render
// owner does, with no new platform cfg of its own.
//
// All three are set with REAL (non-delayed) handles, so they create no render
// obligation for the RV-39 withdrawal to hand back, and the same EmptyClipboard
// that ends our ownership erases them.

use std::sync::OnceLock;
use windows::core::w;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::DataExchange::{RegisterClipboardFormatW, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

/// The three advisory formats, registered once. `RegisterClipboardFormatW`
/// returns the same atom for the same string process-wide (0 = failure).
fn format_ids() -> &'static [(u32, &'static str); 3] {
    static IDS: OnceLock<[(u32, &'static str); 3]> = OnceLock::new();
    IDS.get_or_init(|| unsafe {
        [
            (
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                "ExcludeClipboardContentFromMonitorProcessing",
            ),
            (
                RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")),
                "CanIncludeInClipboardHistory",
            ),
            (
                RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")),
                "CanUploadToCloudClipboard",
            ),
        ]
    })
}

/// A moveable HGLOBAL holding one DWORD 0 — the 「no」 payload all three formats
/// read. Fresh per call: `SetClipboardData` takes ownership on success.
unsafe fn alloc_dword_zero() -> Option<*mut core::ffi::c_void> {
    let hglobal = GlobalAlloc(GMEM_MOVEABLE, 4).ok()?;
    let dst = GlobalLock(hglobal) as *mut u8;
    if dst.is_null() {
        return None;
    }
    std::ptr::write_bytes(dst, 0, 4);
    let _ = GlobalUnlock(hglobal);
    Some(hglobal.0)
}

/// Mark the clipboard content we currently own as transient. MUST be called
/// while this thread holds the clipboard open (between EmptyClipboard and
/// CloseClipboard in `paste_formats`) — SetClipboardData outside an open
/// clipboard fails by contract.
///
/// Best-effort BY DESIGN: a mark that fails to stick costs history pollution,
/// never delivery — so failures go to the forensic record and nothing is
/// propagated. Turning this into a paste-failing step would let a cosmetic
/// API quirk block a delivery that would have worked.
pub(super) fn mark_transient_content() {
    let mut failed: Vec<&'static str> = Vec::new();
    for &(fmt, name) in format_ids() {
        if fmt == 0 {
            failed.push(name);
            continue;
        }
        let stuck = unsafe {
            alloc_dword_zero()
                .map(|h| SetClipboardData(fmt, HANDLE(h)).is_ok())
                .unwrap_or(false)
        };
        if !stuck {
            failed.push(name);
        }
    }
    if !failed.is_empty() {
        crate::forensic::record(
            "inject",
            &format!(
                "clipboard transient marks not set: {failed:?} — delivery is unaffected, but \
                 this paste may appear in clipboard history / cloud clipboard"
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registration itself — provable without touching the clipboard.
    /// (Whether the marks actually keep a paste out of Win+V history is a claim
    /// about Windows, verified on the device line, not here.)
    #[test]
    fn all_three_formats_register_with_nonzero_atoms() {
        for &(fmt, name) in format_ids() {
            assert_ne!(fmt, 0, "{name} failed to register");
        }
        // Same string → same atom: a second lookup must agree with the cache.
        let again =
            unsafe { RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")) };
        assert_eq!(again, format_ids()[1].0);
    }
}

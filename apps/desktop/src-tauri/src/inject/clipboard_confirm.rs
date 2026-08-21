// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4 ② (image injection must equally
//     go through confirmation)
//   master-plan §4 / CLAUDE.md red line: no silent failures / status only records
//     the delivery truth
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Confirmed clipboard paste via DELAYED RENDERING — the fix for the paste→
// restore race. The old flow (write text → Ctrl+V → immediately restore the
// user's original clipboard) is a lie: SendInput's Ctrl+V is posted async into
// the target's message queue, so the target almost always reads the ALREADY-
// RESTORED clipboard (the user's previous content), not the injected text —
// reporting `injected` falsely AND leaking the user's prior clipboard into the
// target app.
//
// Instead we own the clipboard with NULL (delayed) handles and send Ctrl+V.
// When — and ONLY when — the target actually reads one of the formats, the OS
// sends WM_RENDERFORMAT to us; we then supply the data and mark the paste
// CONFIRMED. That WM_RENDERFORMAT was the delivery GATE until 2026-07-30, when
// owner's narrowing of 「injected」 (design §3) demoted it to EVIDENCE: its absence
// now means 「not observed inside CONFIRM_TIMEOUT」 and nothing more, and the
// verdict is `pipeline::map_clipboard_outcome`'s to make. Because the target only
// ever pulls our injected data (never the user's restored original), the
// clipboard leak is closed either way.
//
// R6 T-4 generalised the mechanism from "one CF_UNICODETEXT string" to "a table
// of clipboard formats", because an image is delivered as CF_DIB / CF_BITMAP /
// registered `PNG` rather than text. The confirmation contract is IDENTICAL for
// images — and, since that de-gating, equally non-binding on both.
//
// Teardown (RV-39, 2026-07-30): whoever announces a delayed format owes an answer
// for it. Handing the announcement BACK before the owner window dies is
// `teardown_owner`'s job — a bare `DestroyWindow` made the OS drop the offer and
// ask us about it with a `WM_RENDERALLFORMATS` that went to `DefWindowProcW`,
// i.e. 「announced it could provide the data, then silently failed to provide it」.
//
// Two image-specific Win32 facts drive the shape below:
//   - CF_BITMAP is a GDI HBITMAP handle, not an HGLOBAL, so it cannot be a row
//     in a bytes table. It is announced alongside CF_DIB and materialised with
//     CreateDIBitmap at render time.
//   - Which format a target asks for is target-specific and cannot be known in
//     advance, so the format the target DID ask for is recorded even on the
//     failure path — an unconfirmed image paste reports which format was
//     requested instead of a shrug.

// Gated 2026-08-07: on macOS both paste entry points are RE-EXPORTED from
// `inject/macos/pasteboard.rs` (NSPasteboard has no delayed-rendering machinery to
// put here), so no function in this file names `InjectError` on that target.
#[cfg(not(target_os = "macos"))]
use crate::inject::sendinput::InjectError;
use std::time::Duration;

/// Pause between owning the clipboard and synthesizing Ctrl+V. See the call site
/// in `win::paste_formats` for why (and where the number came from).
pub const CLIPBOARD_SETTLE: Duration = Duration::from_millis(80);

/// What one delayed-render paste attempt observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConfirmOutcome {
    /// The target really read one of our formats (WM_RENDERFORMAT served).
    /// `false` → the caller MUST NOT report `injected`.
    pub confirmed: bool,
    /// The clipboard format the target asked for, when it asked for anything.
    /// Present even when `confirmed` is false (it asked for a format we could
    /// not serve) — this is the diagnostic that makes an unconfirmed image
    /// paste explainable instead of mysterious.
    pub requested_format: Option<u32>,
    /// RV-39 / F-4 (2026-08-03 M5): the delayed-render ANNOUNCEMENT was DROPPED
    /// UNRENDERED — the pre-teardown withdrawal did not take, so the OS discarded
    /// the formats we had offered inside `DestroyWindow` (a `WM_RENDERALLFORMATS`
    /// arrived; see `teardown_owner`). That is OUR OWN teardown failing, not the
    /// target choosing not to read — the same category as an `Err` from a paste
    /// step. `map_image_outcome` therefore reports the paste FAILED when this is
    /// set AND the target consumed nothing (`!confirmed`), so the phone can learn
    /// the picture did not land instead of hearing 「success」 for one that is nowhere
    /// the target could reach. `confirmed` OUTRANKS it: a target that read a
    /// format has the picture, and a dropped SIBLING format is then moot.
    ///
    /// 🔴 STRUCTURALLY `false` ON macOS: NSPasteboard has no delayed-rendering
    /// announcement to withdraw (`inject/macos/pasteboard.rs`), so there is nothing
    /// that can be dropped and no path here can set it — the macOS analogue of the
    /// F-4 shape is a restore failure, already reported as INJECT_CLIPBOARD_FAIL.
    pub dropped_unrendered: bool,
}

/// Attempt a clipboard paste of `text` into the foreground target and report
/// whether the target actually CONSUMED it (WM_RENDERFORMAT observed within
/// `timeout`). `Ok(true)` = confirmed injected; `Ok(false)` = not confirmed
/// (caller must NOT report injected). `Err` = a hard Win32 failure.
#[cfg(target_os = "windows")]
pub fn paste_with_confirmation(text: &str, timeout: Duration) -> Result<bool, InjectError> {
    let mut bytes: Vec<u8> = Vec::with_capacity((text.len() + 1) * 2);
    for unit in text.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let formats = vec![(win::CF_UNICODETEXT_U32, bytes)];
    win::paste_formats(&formats, timeout).map(|o| o.confirmed)
}

/// Attempt a clipboard paste of an arbitrary format table (R6 T-4: the image
/// path). Same delayed-render confirmation contract as the text path.
#[cfg(target_os = "windows")]
pub fn paste_formats_with_confirmation(
    formats: &[(u32, Vec<u8>)],
    timeout: Duration,
) -> Result<ConfirmOutcome, InjectError> {
    win::paste_formats(formats, timeout)
}

// ── macOS: the real thing (MAC-05 / MAC-06) ─────────────────────────────────
//
// NSPasteboard has no delayed-rendering callback, so there is no `mod mac` beside
// `mod win` here — the whole mechanism is different and it lives in
// `inject/macos/pasteboard.rs`. These two lines are the seam, nothing more.
#[cfg(target_os = "macos")]
pub use crate::inject::macos::pasteboard::{
    paste_formats_with_confirmation, paste_with_confirmation,
};

// ── every other host: FAIL, LOUDLY ──────────────────────────────────────────
//
// 🔴 THESE TWO USED TO RETURN `Ok(false)` / `Ok(ConfirmOutcome::default())` under a
// comment reading 「Non-Windows hosts cannot inject and cannot confirm → never
// `injected`」. First half true, SECOND HALF FALSE, and the gap is a whole failure
// mode: `pipeline::map_clipboard_outcome` reads `Ok(..)` as the delivery (design §3,
// 2026-07-30 — the receipt stopped being the gate), so a friendly `Ok` here reports
// `ok:true`/`injected` with the clipboard untouched and not one character anywhere.
// It was unreachable only because focus tracking died first on those hosts
// (tracker.rs's no-op ⇒ Stage 1 always cached) — which is exactly why the flip and
// the real implementation above land in the SAME change (breakdown §0-2), and why a host
// that gets a focus source later finds an error here rather than a lie.
// doc 13 §7 F1 ②: a DI default must be the real thing or must throw.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn paste_with_confirmation(_text: &str, _timeout: Duration) -> Result<bool, InjectError> {
    Err(InjectError::Unsupported(
        "clipboard paste (text): this platform has no implementation. Returning Ok here would \
         be reported as `injected` by pipeline::map_clipboard_outcome",
    ))
}

/// Same flip, same reason — see the note above.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn paste_formats_with_confirmation(
    _formats: &[(u32, Vec<u8>)],
    _timeout: Duration,
) -> Result<ConfirmOutcome, InjectError> {
    Err(InjectError::Unsupported(
        "clipboard paste (format table): this platform has no implementation. Returning Ok here \
         would be reported as `injected` by pipeline::map_image_outcome",
    ))
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use crate::inject::image::{CF_BITMAP_U32, CF_DIB_U32};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{
        GetLastError, SetLastError, HANDLE, HWND, LPARAM, LRESULT, WIN32_ERROR, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateDIBitmap, GetDC, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, CBM_INIT, DIB_RGB_COLORS,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardOwner, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VK_CONTROL, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, PM_REMOVE, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_RENDERALLFORMATS, WM_RENDERFORMAT, WNDCLASSW,
    };

    /// The format table the WM_RENDERFORMAT handler serves, plus what it
    /// observed. Accessed only from the paste thread (the OS delivers the
    /// SendMessage'd WM_RENDERFORMAT onto that same thread during PeekMessage),
    /// so there is never cross-thread contention on this lock.
    struct Pending {
        formats: Vec<(u32, Vec<u8>)>,
        /// The format the target asked for — recorded even when we cannot
        /// serve it, so an unconfirmed paste says WHY.
        requested: Option<u32>,
        rendered: bool,
        /// A `WM_RENDERALLFORMATS` was received (RV-39). The OS sends it only
        /// while tearing down a clipboard owner that still has delayed formats
        /// outstanding, so seeing it means `teardown_owner` did NOT manage to hand
        /// the offer back and the OS is dropping it. That used to happen on every
        /// single paste, into `DefWindowProcW`, without a word.
        render_all_requested: bool,
    }
    static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
    static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();

    /// Disarm the render slot, tolerating a poisoned lock. `.unwrap()` here used
    /// to be a second way to die: a panic anywhere under this mutex poisons it,
    /// and every later paste would then panic on teardown instead of reporting
    /// an honest unconfirmed result.
    fn clear_pending() {
        let mut g = PENDING.lock().unwrap_or_else(|p| p.into_inner());
        *g = None;
    }

    pub const CF_UNICODETEXT_U32: u32 = CF_UNICODETEXT.0 as u32;

    /// The OS calls this. It is `extern "system"`, so an unwinding panic crossing
    /// back out of it ABORTS the process — no message, no forensic line, exactly
    /// the silent death WER recorded on 2026-07-28. `catch_unwind` keeps any
    /// future panic inside our own boundary; the paste then simply goes
    /// unconfirmed, which the caller already reports honestly.
    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wndproc_inner(hwnd, msg, wparam, lparam)
        }))
        .unwrap_or(LRESULT(0))
    }

    unsafe fn wndproc_inner(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_RENDERFORMAT {
            let want = wparam.0 as u32;
            // The target is reading one of our formats → supply the data and
            // mark consumption confirmed. During WM_RENDERFORMAT the clipboard
            // is already open by the requester, so we SetClipboardData WITHOUT
            // opening it ourselves (per the delayed-rendering contract).
            if let Ok(mut guard) = PENDING.lock() {
                if let Some(p) = guard.as_mut() {
                    p.requested = Some(want);
                    // Copy out first: serving the format needs `p` immutably
                    // while recording the outcome needs it mutably.
                    let exact: Option<Vec<u8>> = p
                        .formats
                        .iter()
                        .find(|(f, _)| *f == want)
                        .map(|(_, b)| b.clone());
                    let dib: Option<Vec<u8>> = if want == CF_BITMAP_U32 {
                        p.formats
                            .iter()
                            .find(|(f, _)| *f == CF_DIB_U32)
                            .map(|(_, b)| b.clone())
                    } else {
                        None
                    };
                    if let Some(bytes) = exact {
                        if let Some(handle) = alloc_bytes(&bytes) {
                            if SetClipboardData(want, HANDLE(handle)).is_ok() {
                                p.rendered = true;
                            }
                        }
                    } else if let Some(bytes) = dib {
                        // CF_BITMAP is a GDI handle format — build the bitmap
                        // from the DIB we are holding rather than handing over
                        // an HGLOBAL the target would misread.
                        if let Some(hbitmap) = hbitmap_from_dib(&bytes) {
                            if SetClipboardData(CF_BITMAP_U32, HANDLE(hbitmap)).is_ok() {
                                p.rendered = true;
                            }
                        }
                    }
                }
            }
            return LRESULT(0);
        }
        if msg == WM_RENDERALLFORMATS {
            // RV-39. Deliberately NOT rendered here, and the reason is the
            // ordering: `clipboard_paste` restores the user's clipboard
            // (EmptyClipboard + their own bytes) within a millisecond of the
            // `DestroyWindow` that produced this message, so anything served here
            // is erased before anyone could paste it — while costing us
            // `SetClipboardData` + `CreateDIBitmap` inside a destroy-time callback
            // on the very path that produced STATUS_HEAP_CORRUPTION. The offer is
            // handed back BEFORE the window is destroyed instead (`teardown_owner`),
            // so arriving here at all means that withdrawal failed. Record the fact
            // and fall through: the OS's own teardown stays byte-for-byte what it
            // was, only no longer silent.
            if let Ok(mut guard) = PENDING.lock() {
                mark_render_all(&mut guard);
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Record a `WM_RENDERALLFORMATS` against the armed announcement, returning
    /// whether there was one to record.
    ///
    /// Takes the slot rather than the mutex so the rule is provable in a unit test
    /// without touching process-global state, and so the wndproc holds the lock
    /// for exactly one field write and calls nothing under it (this runs
    /// re-entrantly from inside `DestroyWindow`).
    fn mark_render_all(slot: &mut Option<Pending>) -> bool {
        match slot.as_mut() {
            Some(pending) => {
                pending.render_all_requested = true;
                true
            }
            None => false,
        }
    }

    /// Allocate a moveable HGLOBAL holding `bytes` verbatim; returns the raw
    /// handle pointer for SetClipboardData (which takes ownership on success).
    unsafe fn alloc_bytes(bytes: &[u8]) -> Option<*mut core::ffi::c_void> {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).ok()?;
        let dst = GlobalLock(hglobal) as *mut u8;
        if dst.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = GlobalUnlock(hglobal);
        Some(hglobal.0)
    }

    /// Materialise a packed DIB (BITMAPINFOHEADER + pixels) as a GDI bitmap for
    /// the CF_BITMAP request path. Returns the raw handle for SetClipboardData.
    unsafe fn hbitmap_from_dib(dib: &[u8]) -> Option<*mut core::ffi::c_void> {
        const HEADER: usize = std::mem::size_of::<BITMAPINFOHEADER>();
        // `BITMAPINFO` is BITMAPINFOHEADER + RGBQUAD[1], i.e. STRICTLY LARGER
        // than the header we bounds-checked against. Casting a buffer that only
        // clears `HEADER` bytes to `*const BITMAPINFO` and handing it to GDI is
        // an out-of-bounds read: the palette member sits past the end. The
        // buffers we build ourselves are 32bpp (no palette) so nothing ever read
        // it in practice, but "in practice" is not a memory-safety argument, and
        // this file is on the human-audit path that just produced a
        // STATUS_HEAP_CORRUPTION crash. Require the larger size outright.
        const INFO: usize = std::mem::size_of::<BITMAPINFO>();
        if dib.len() <= HEADER.max(INFO) {
            return None;
        }
        let header = dib.as_ptr() as *const BITMAPINFOHEADER;
        let info = dib.as_ptr() as *const BITMAPINFO;
        let bits = dib.as_ptr().add(HEADER) as *const core::ffi::c_void;
        let hdc = GetDC(HWND(std::ptr::null_mut()));
        if hdc.is_invalid() {
            return None;
        }
        let bitmap = CreateDIBitmap(
            hdc,
            Some(header),
            CBM_INIT as u32,
            Some(bits),
            Some(info),
            DIB_RGB_COLORS,
        );
        ReleaseDC(HWND(std::ptr::null_mut()), hdc);
        if bitmap.is_invalid() {
            None
        } else {
            Some(bitmap.0)
        }
    }

    /// `SetClipboardData(format, NULL)` — the DELAYED-RENDERING announcement.
    ///
    /// 2026-07-29, reproduced deterministically on a CLEAN clipboard
    /// (tests/clipboard_gdi_repro.rs): this call was reported as failing with
    /// hr=0x80070006 every single time, and that verdict was FALSE.
    ///
    /// `SetClipboardData` returns the handle it stored. For delayed rendering
    /// the stored handle IS NULL — that is what "the data will be supplied
    /// later" means — so a successful delayed announcement returns NULL, which
    /// is byte-for-byte the value windows-rs treats as failure. It then builds
    /// an error from whatever `GetLastError` happened to be holding — 6,
    /// ERROR_INVALID_HANDLE, in the owner's record — and a perfectly good
    /// clipboard write came back as a Win32 error.
    ///
    /// Where that particular 6 came from is NOT established: the run that
    /// produced it left no 「clipboard snapshot skipped」 line, so the snapshot's
    /// GDI probe (the obvious suspect) had not failed that time. The number is
    /// residue of unproven origin, and saying more than that would be inventing
    /// a cause. It does not matter for the fix — clearing the code first makes
    /// the verdict independent of whatever was left lying around.
    ///
    /// Consequences, now visible in the record: EVERY image paste failed here
    /// before the picture was ever offered to the target, and the text path's
    /// clipboard-first attempt failed here too — text simply had SendInput to
    /// fall through to (「clipboard-first failed …, fell through to a verified
    /// SendInput」 on every such line in window-forensics.log), so nothing ever
    /// surfaced. The delayed-render receipt mechanism has never once run.
    ///
    /// The documented discriminator is the error code, not the return value:
    /// clear it, make the call, and a NULL return with `GetLastError() == 0` is
    /// success. The repo already uses exactly this shape for the other
    /// zero-is-ambiguous clipboard API (`clipboard_snapshot.rs`
    /// `enum_next`/EnumClipboardFormats).
    unsafe fn set_delayed(format: u32) -> Result<(), u32> {
        SetLastError(WIN32_ERROR(0));
        if SetClipboardData(format, HANDLE(std::ptr::null_mut())).is_ok() {
            return Ok(());
        }
        // Read AFTER the call: this is the only thing that can tell a stored
        // NULL (success) from a refused write (failure).
        match GetLastError().0 {
            0 => Ok(()),
            code => Err(code),
        }
    }

    /// `OpenClipboard`, retried briefly on ERROR_ACCESS_DENIED.
    ///
    /// The clipboard is a single global lock every app on the machine contends
    /// for — clipboard managers, Electron apps and the shell all grab it for a
    /// few milliseconds at a time, and the very repro run that found the bug
    /// above ALSO hit 「access denied」 (0x80070005) on an unrelated open. One attempt
    /// turns someone else's 5 ms into our failed delivery.
    unsafe fn open_clipboard_retrying(hwnd: HWND) -> Result<(), u32> {
        const ATTEMPTS: usize = 10;
        const GAP: Duration = Duration::from_millis(15);
        let mut last = 0u32;
        for attempt in 0..ATTEMPTS {
            match OpenClipboard(hwnd) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = e.code().0 as u32;
                    // Only contention is worth waiting out; anything else is a
                    // real refusal and retrying only delays the honest report.
                    if last != HR_ACCESS_DENIED {
                        return Err(last);
                    }
                    if attempt + 1 < ATTEMPTS {
                        std::thread::sleep(GAP);
                    }
                }
            }
        }
        Err(last)
    }

    /// HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED) — what OpenClipboard returns
    /// while another process holds the clipboard open.
    const HR_ACCESS_DENIED: u32 = 0x8007_0005;

    /// Name the SetClipboardData step by the format it was announcing — the
    /// two GDI-handle formats behave differently from the byte formats, so
    /// 「which format」 is the first thing the next reader needs to know.
    fn set_step(format: u32) -> &'static str {
        match format {
            f if f == CF_DIB_U32 => "SetClipboardData(CF_DIB)",
            f if f == CF_BITMAP_U32 => "SetClipboardData(CF_BITMAP)",
            f if f == CF_UNICODETEXT_U32 => "SetClipboardData(CF_UNICODETEXT)",
            _ => "SetClipboardData(other)",
        }
    }

    // The RV-39 withdrawal unit lives in its own file since the F-4 change put
    // this one over the 800-line cap — see clipboard_withdraw.rs. The `../../`
    // follows the same rule as the tests include at the bottom of this module.
    #[path = "../../clipboard_withdraw.rs"]
    mod withdraw;
    use withdraw::{withdraw_announcement, WithdrawOps, Withdrawal};

    // Transient-content marks (history/cloud/monitor opt-out) — why in its file.
    #[path = "../../clipboard_transient.rs"]
    mod transient;

    /// Tear down the render-owner window: hand the announcement back FIRST, then
    /// destroy, then say so if the OS still had to drop something.
    ///
    /// ── RV-39 (2026-07-30) ─────────────────────────────────────────────────
    /// `DestroyWindow` on a clipboard owner that still has un-rendered delayed
    /// formats makes the OS send `WM_RENDERALLFORMATS` synchronously, from inside
    /// the call — and this module answered it with `DefWindowProcW`. So every
    /// format we had announced as 「we can provide this」 was dropped without a
    /// word, on every paste, confirmed or not: a target that asks for CF_DIB
    /// leaves the CF_BITMAP we also announced outstanding.
    /// 「announced it could provide the data, then silently failed to provide it」 is
    /// the second direction of "no silent failures".
    ///
    /// The fix is WITHDRAWAL, not rendering — see the `WM_RENDERALLFORMATS` note
    /// in the wndproc for why rendering there would buy the user nothing.
    ///
    /// Both teardown sites go through this one function on purpose: RV-39 was a
    /// bare `DestroyWindow` doing this silently, and two call sites drifting apart
    /// is exactly how it would come back.
    ///
    /// Returns whether the OS DROPPED the announced formats unrendered (RV-39):
    /// `true` means the withdrawal did not take and a `WM_RENDERALLFORMATS` landed
    /// inside `DestroyWindow`. `paste_formats` carries that onto `ConfirmOutcome`
    /// (`dropped_unrendered`) so `map_image_outcome` can tell an incomplete paste
    /// from a clean one (F-4) instead of the fact vanishing into a forensic line.
    fn teardown_owner(hwnd: HWND, announce: &[u32], phase: &'static str) -> bool {
        let withdrawal = withdraw_announcement(&WithdrawOps {
            owned_by_us: &|| unsafe { GetClipboardOwner() }.is_ok_and(|owner| owner == hwnd),
            open: &|| unsafe { open_clipboard_retrying(hwnd) },
            empty: &|| unsafe { EmptyClipboard() }.map_err(|e| e.code().0 as u32),
            close: &|| unsafe { CloseClipboard() }.map_err(|e| e.code().0 as u32),
        });
        let _ = unsafe { DestroyWindow(hwnd) };
        // Read BEFORE disarming the slot: WM_RENDERALLFORMATS is delivered
        // synchronously inside DestroyWindow, so if it was ever coming it has
        // already landed by this line.
        let dropped_by_os = PENDING
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| p.render_all_requested))
            .unwrap_or(false);
        clear_pending();
        match withdrawal {
            // Nothing lost and nobody to tell: the offer we made is the offer we
            // took back. The paste's own DONE line already records the attempt.
            Withdrawal::Withdrawn => {}
            Withdrawal::NotOurs => crate::forensic::record(
                "inject",
                &format!(
                    "clipboard {announce:?}: nothing of ours to withdraw at {phase} — the \
                     clipboard is not ours (someone else owns it, or nobody does: we either \
                     never took it, or lost it since), so the restore that follows will \
                     overwrite whatever is there now"
                ),
            ),
            Withdrawal::Failed(step, code) => crate::forensic::record(
                "inject",
                &format!(
                    "clipboard {announce:?}: withdrawal FAILED at {phase} — {step} \
                     hr=0x{code:08X}, so the OS drops the formats we had offered, unrendered"
                ),
            ),
        }
        if dropped_by_os {
            crate::forensic::record(
                "inject",
                &format!(
                    "clipboard {announce:?}: DROPPED unrendered at {phase} — \
                     WM_RENDERALLFORMATS arrived, which means the withdrawal did not take"
                ),
            );
        }
        dropped_by_os
    }

    fn ensure_class() {
        CLASS_REGISTERED.get_or_init(|| unsafe {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                lpszClassName: w!("FlowMicClipboardRender"),
                ..Default::default()
            };
            // Non-zero atom on success; a second registration would fail
            // harmlessly, but OnceLock guarantees exactly one call.
            let _ = RegisterClassW(&wc);
        });
    }

    fn send_ctrl_v() -> Result<(), InjectError> {
        let make = |vk, flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [
            make(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
            make(VK_V, KEYBD_EVENT_FLAGS(0)),
            make(VK_V, KEYEVENTF_KEYUP),
            make(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            let err = unsafe { windows::Win32::Foundation::GetLastError() };
            return Err(if err.0 == 0 {
                InjectError::AppRejected
            } else {
                InjectError::Win32(err.0)
            });
        }
        Ok(())
    }

    /// The formats ANNOUNCED on the clipboard: every row of the table, plus
    /// CF_BITMAP whenever a CF_DIB is present. CF_BITMAP is announced without
    /// being a table row because it is served as a GDI handle (see wndproc);
    /// announcing it explicitly means a target that asks for CF_BITMAP is
    /// answered directly rather than relying on the system's synthesis of a
    /// still-unrendered delayed format.
    fn announced(formats: &[(u32, Vec<u8>)]) -> Vec<u32> {
        let mut out: Vec<u32> = formats.iter().map(|(f, _)| *f).collect();
        if out.contains(&CF_DIB_U32) && !out.contains(&CF_BITMAP_U32) {
            out.push(CF_BITMAP_U32);
        }
        out
    }

    pub fn paste_formats(
        formats: &[(u32, Vec<u8>)],
        timeout: Duration,
    ) -> Result<ConfirmOutcome, InjectError> {
        if formats.is_empty() {
            return Ok(ConfirmOutcome::default());
        }
        ensure_class();

        // Message-only window to receive WM_RENDERFORMAT.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("FlowMicClipboardRender"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
        }
        .map_err(|e| InjectError::Win32(e.code().0 as u32))?;

        // Arm the render state, then take clipboard ownership with DELAYED
        // (NULL-handle) entries — the target's read triggers our render.
        let announce = announced(formats);
        if let Ok(mut g) = PENDING.lock() {
            *g = Some(Pending {
                formats: formats.to_vec(),
                requested: None,
                rendered: false,
                render_all_requested: false,
            });
        }

        // Each step is taken and REPORTED separately. It used to be one `and_then`
        // chain whose failure produced a bare number — owner 2026-07-29 hit
        // `paste=Win32 error: 2147942406` (0x80070006, ERROR_INVALID_HANDLE) and
        // nothing anywhere could say WHICH of four calls said it, which is the
        // 「a failure must be able to say clearly which step it was」 half of the fail-loud red line. The step name
        // now rides both the forensic line and the returned error message.
        let own: Result<(), (&'static str, u32)> = unsafe {
            (|| {
                open_clipboard_retrying(hwnd).map_err(|c| ("OpenClipboard", c))?;
                EmptyClipboard().map_err(|e| ("EmptyClipboard", e.code().0 as u32))?;
                for format in &announce {
                    // NULL handle = delayed rendering; owner is `hwnd`. See
                    // set_delayed for why the RESULT of this call cannot be
                    // trusted and the error code must be read instead.
                    set_delayed(*format).map_err(|c| (set_step(*format), c))?;
                }
                // Best-effort, deliberately not a `?` step: a mark that fails
                // costs history pollution, never delivery (clipboard_transient.rs).
                transient::mark_transient_content();
                CloseClipboard().map_err(|e| ("CloseClipboard", e.code().0 as u32))?;
                Ok(())
            })()
        };
        if let Err((step, code)) = own {
            // The clipboard may still be open on this thread when a step after
            // OpenClipboard failed — leaving it open would wedge every other app
            // (and our own next attempt) far worse than the failure itself.
            if step != "OpenClipboard" {
                let _ = unsafe { CloseClipboard() };
            }
            // A step that failed AFTER EmptyClipboard leaves us OWNING the
            // clipboard with whatever formats we did manage to announce still
            // delayed — so this path needs the withdrawal every bit as much as the
            // normal one does (RV-39 warned specifically against fixing only one
            // of the two teardowns).
            //
            // The drop status is IGNORED here on purpose: this path already returns
            // `Err`, which `map_image_outcome` reports as failed regardless — the
            // `dropped_unrendered` bit only decides the outcome on the `Ok` path.
            let _ = teardown_owner(hwnd, &announce, "announcement-failed");
            crate::forensic::record(
                "inject",
                &format!(
                    "image paste: {step} failed hr=0x{code:08X} (announced formats {announce:?})"
                ),
            );
            return Err(InjectError::Win32Step(step, code));
        }

        // The announcement claims success on an ERROR CODE (see set_delayed).
        // Ask the clipboard itself whether the formats are actually there — a
        // positive check needs no open handle and turns 「GetLastError said 0」
        // into 「the clipboard agrees」. Recorded, never gated: a wrong
        // announcement already ends as an unconsumed paste reported honestly,
        // and turning this into a refusal would let one API quirk block a paste
        // that might still work.
        let missing: Vec<u32> = announce
            .iter()
            .copied()
            .filter(|f| unsafe { IsClipboardFormatAvailable(*f) }.is_err())
            .collect();
        if !missing.is_empty() {
            crate::forensic::record(
                "inject",
                &format!(
                    "image paste: announced {announce:?} but the clipboard does not offer \
                     {missing:?} — the paste will almost certainly go unconsumed"
                ),
            );
        }

        // Let the clipboard change settle before Ctrl+V.
        //
        // Carried over from the legacy line (inject/image_clipboard.rs — a tree not shipped here, grep
        // `CLIPBOARD_SETTLE_MS` there — that tree is not this repo, so no :NNN):
        //   `const CLIPBOARD_SETTLE_MS: u64 = 80;`
        //   「Brief pause after clipboard write before Ctrl+V (Windows apps need this)」
        // — a number that line paid for on real machines, and the one thing in its
        // whole injection layer that this one did not already have.
        //
        // It applies to delayed rendering too, and arguably more: the target
        // typically ENUMERATES formats before asking for one, and an enumeration
        // that races our CloseClipboard sees the pre-Empty state and asks for
        // nothing — which lands here as 「no WM_RENDERFORMAT」, i.e. an
        // unconfirmed paste, i.e. a delivery reported as not made. The failure is
        // intermittent and looks exactly like an app that "sometimes doesn't take
        // pastes", which is the hardest kind of thing to ever diagnose.
        //
        // 80 ms on a FALLBACK path (SendInput leads again since v0.2.1) is not a
        // latency the user can feel.
        std::thread::sleep(CLIPBOARD_SETTLE);
        // Fire the paste, then pump until the target consumes it or we time out.
        let paste = send_ctrl_v();

        let deadline = Instant::now() + timeout;
        loop {
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            let rendered = PENDING
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|p| p.rendered))
                .unwrap_or(false);
            if rendered || Instant::now() >= deadline || paste.is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(4));
        }

        let outcome = PENDING
            .lock()
            .ok()
            .and_then(|g| {
                g.as_ref().map(|p| ConfirmOutcome {
                    confirmed: p.rendered,
                    requested_format: p.requested,
                    // Set from the teardown below — whether the OS dropped the
                    // offer is only known once the owner window is destroyed and
                    // any WM_RENDERALLFORMATS has landed (F-4).
                    dropped_unrendered: false,
                })
            })
            .unwrap_or_default();

        // Tear down: hand back any still-delayed announcement, THEN destroy the
        // owner window; the caller restores the user's original clipboard next.
        //
        // This comment used to read 「destroying the owner window relinquishes any
        // still-delayed clipboard entry」, which was true only in the sense that
        // the OS threw the entry away on our behalf — the message it asked us with
        // (WM_RENDERALLFORMATS) went to DefWindowProcW. RV-39.
        let dropped_unrendered = teardown_owner(hwnd, &announce, "receipt-window-closed");

        // A SendInput failure is a hard error; otherwise report the truth — now
        // including whether our own teardown DROPPED the offer unrendered (F-4).
        // `map_image_outcome` combines that with `confirmed`: nothing consumed AND
        // the offer dropped is an incomplete paste, not a clean 「we did the act」.
        paste?;
        Ok(ConfirmOutcome { dropped_unrendered, ..outcome })
    }

    // Split out for the 800-line src cap (same shape as inject/pipeline_tests.rs).
    // The `../../` is not a typo: a `#[path]` inside an INLINE module block resolves
    // relative to <file-stem>/<inline-mod>/ — `inject/clipboard_confirm/win/` here —
    // so two levels up is `inject/`, where the file actually sits.
    #[cfg(test)]
    #[path = "../../clipboard_confirm_tests.rs"]
    mod tests;
}


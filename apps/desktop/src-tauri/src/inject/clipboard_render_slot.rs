// The delayed-render SLOT and the window procedure that services it, moved
// VERBATIM out of `clipboard_confirm.rs`'s `mod win` for the 800-line src cap —
// the same `#[path]` shape `clipboard_transient.rs` and `clipboard_confirm_tests.rs`
// already use, so this compiles exactly where the render owner does and needs no
// platform cfg of its own. Only visibilities changed: items the parent still
// calls are `pub(super)`.
//
// What lives here is everything that answers「the OS is asking us for the bytes」:
// the `wndproc`, the WM_RENDERFORMAT / WM_RENDERALLFORMATS handling, and the two
// allocators that materialise a format on demand. What stays in the parent is
// everything that decides「should we still be holding this at all」 — that split is
// the point, because 2026-08-22 turned on nobody being able to see that those
// were two different questions.

use super::*;


/// The OS calls this. It is `extern "system"`, so an unwinding panic crossing
/// back out of it ABORTS the process — no message, no forensic line, exactly
/// the silent death WER recorded on 2026-07-28. `catch_unwind` keeps any
/// future panic inside our own boundary; the paste then simply goes
/// unconfirmed, which the caller already reports honestly.
pub(super) unsafe extern "system" fn wndproc(
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
pub(super) fn mark_render_all(slot: &mut Option<Pending>) -> bool {
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
pub(super) unsafe fn alloc_bytes(bytes: &[u8]) -> Option<*mut core::ffi::c_void> {
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
pub(super) unsafe fn hbitmap_from_dib(dib: &[u8]) -> Option<*mut core::ffi::c_void> {
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

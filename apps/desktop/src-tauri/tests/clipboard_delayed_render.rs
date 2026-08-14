// The delayed-render clipboard announcement, against the REAL Win32 clipboard.
//
// 2026-07-29 — owner: 「传到了 PC 端，但显示：注入失败」, forensic:
//   detail="image clipboard paste failed; paste=Win32 error: 2147942406"
//   (0x80070006 = ERROR_INVALID_HANDLE), 5 ms after the focus verdict.
//
// Reproduced here on a CLEAN clipboard — the screenshot everyone (including the
// first three root-cause theories) blamed turned out to be irrelevant:
//
//   [step] OpenClipboard(hwnd) ok
//   [step] EmptyClipboard ok
//   [step] SetClipboardData(format=8, NULL) FAILED hr=0x80070006
//
// `SetClipboardData` returns the handle it stored, and for a DELAYED format the
// stored handle is NULL by definition. windows-rs maps a NULL return to Err and
// fills it from whatever GetLastError was holding — so a successful delayed
// announcement is indistinguishable from a failure by return value alone, and
// this path reported failure 100% of the time. Every image paste died here
// before the picture was offered to anyone; the text path died here too and
// silently fell through to SendInput, which is why only images ever looked
// broken.
//
// These tests are #[ignore]d: they take the machine's real clipboard and need an
// interactive window station.
//   cargo test --test clipboard_delayed_render -- --ignored --nocapture
#![cfg(target_os = "windows")]

use std::thread::sleep;
use std::time::Duration;

use windows::core::w;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    GetLastError, SetLastError, HANDLE, HWND, LPARAM, LRESULT, WIN32_ERROR, WPARAM,
};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HBITMAP};
use windows::Win32::System::DataExchange::{
    CloseClipboard, CountClipboardFormats, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, HWND_MESSAGE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WNDCLASSW,
};

const CF_BITMAP_U32: u32 = 2;
const CF_DIB_U32: u32 = 8;
const HR_ACCESS_DENIED: u32 = 0x8007_0005;

unsafe extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, m, w, l)
}

/// Mirror of the production helper (clipboard_confirm.rs::open_clipboard_retrying).
unsafe fn open_retrying(hwnd: HWND) -> Result<(), u32> {
    let mut last = 0u32;
    for attempt in 0..20 {
        match OpenClipboard(hwnd) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.code().0 as u32;
                if last != HR_ACCESS_DENIED {
                    return Err(last);
                }
                if attempt < 19 {
                    sleep(Duration::from_millis(15));
                }
            }
        }
    }
    Err(last)
}

/// THE FIX under test, byte-for-byte the production shape: a NULL return with
/// GetLastError()==0 is a successful delayed announcement.
unsafe fn set_delayed(format: u32) -> Result<(), u32> {
    SetLastError(WIN32_ERROR(0));
    if SetClipboardData(format, HANDLE(std::ptr::null_mut())).is_ok() {
        return Ok(());
    }
    match GetLastError().0 {
        0 => Ok(()),
        code => Err(code),
    }
}

/// The OLD shape, kept so the test can state what actually changed.
unsafe fn set_delayed_old(format: u32) -> Result<(), u32> {
    SetClipboardData(format, HANDLE(std::ptr::null_mut()))
        .map(|_| ())
        .map_err(|e| e.code().0 as u32)
}

unsafe fn message_window() -> HWND {
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        lpszClassName: w!("FlowMicDelayedRenderTest"),
        ..Default::default()
    };
    let _ = RegisterClassW(&wc);
    CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("FlowMicDelayedRenderTest"),
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
    .expect("CreateWindowExW(HWND_MESSAGE)")
}

unsafe fn clear_clipboard() {
    if open_retrying(HWND(std::ptr::null_mut())).is_ok() {
        let _ = EmptyClipboard();
        let _ = CloseClipboard();
    }
}

/// Put a real GDI bitmap on the clipboard — the state a screenshot leaves, and
/// the state 0.2.10 first made reachable by this path.
unsafe fn seed_gdi_bitmap() {
    let bits: [u8; 16] = [0xFF; 16]; // 2×2 32bpp
    let hbitmap: HBITMAP = CreateBitmap(2, 2, 1, 32, Some(bits.as_ptr() as *const _));
    assert!(!hbitmap.is_invalid(), "CreateBitmap");
    open_retrying(HWND(std::ptr::null_mut())).expect("seed: OpenClipboard");
    let _ = EmptyClipboard();
    let stored = SetClipboardData(CF_BITMAP_U32, HANDLE(hbitmap.0)).is_ok();
    let _ = CloseClipboard();
    if !stored {
        let _ = DeleteObject(hbitmap);
        panic!("seed: SetClipboardData(CF_BITMAP) refused");
    }
}

/// Own the clipboard with delayed entries, using `set` for the announcement.
///
/// Returns how many formats the clipboard reports WHILE THE OWNER IS STILL
/// ALIVE. That ordering is not incidental: destroying the owner of unrendered
/// delayed data makes those formats evaporate (the OS gives the dying window a
/// WM_RENDERALLFORMATS it cannot answer once it is gone), so counting after
/// DestroyWindow measures nothing. Production keeps the window alive across the
/// paste and the receipt pump for exactly this reason.
unsafe fn announce_with(
    set: unsafe fn(u32) -> Result<(), u32>,
    formats: &[u32],
) -> (Result<(), (&'static str, u32)>, i32) {
    let hwnd = message_window();
    let result = (|| {
        open_retrying(hwnd).map_err(|c| ("OpenClipboard", c))?;
        EmptyClipboard().map_err(|e| ("EmptyClipboard", e.code().0 as u32))?;
        for f in formats {
            set(*f).map_err(|c| ("SetClipboardData", c))?;
        }
        CloseClipboard().map_err(|e| ("CloseClipboard", e.code().0 as u32))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = CloseClipboard();
    }
    let announced = if open_retrying(HWND(std::ptr::null_mut())).is_ok() {
        let n = CountClipboardFormats();
        let _ = CloseClipboard();
        n
    } else {
        -1
    };
    let _ = DestroyWindow(hwnd);
    (result, announced)
}

#[test]
#[ignore = "takes the machine's real clipboard; needs an interactive window station"]
fn delayed_announcement_succeeds_and_the_old_shape_is_what_lied() {
    unsafe {
        // ── 1. clean clipboard: the fixed shape must succeed, and the formats
        //     must really be announced (an Ok() that put nothing on the
        //     clipboard would be the same lie in the other direction).
        clear_clipboard();
        let (fixed, announced) = announce_with(set_delayed, &[CF_DIB_U32, CF_BITMAP_U32]);
        println!("clean / fixed  → {fixed:?}  formats_on_clipboard={announced}");
        assert!(
            fixed.is_ok(),
            "the delayed announcement must succeed on a clean clipboard: {fixed:?}"
        );
        assert!(
            announced >= 2,
            "both delayed formats must be on the clipboard while the owner lives, saw {announced}"
        );

        // ── 2. the OLD shape reports failure for that same successful call.
        //     This is the whole bug: 「注入失败」 with nothing actually wrong.
        clear_clipboard();
        let (old, old_announced) = announce_with(set_delayed_old, &[CF_DIB_U32, CF_BITMAP_U32]);
        println!("clean / old    → {old:?}  formats_on_clipboard={old_announced}");
        assert!(
            old.is_err(),
            "the pre-fix shape is expected to mis-report success as failure — if this \
             ever passes, the windows-rs mapping changed and the fix can be simplified"
        );
        assert!(
            old_announced >= 1,
            "the call the old shape called a failure had in fact WRITTEN to the clipboard \
             (saw {old_announced}) — that is what made the failure a false report"
        );

        // ── 3. with a screenshot (GDI handle) already on the clipboard — the
        //     state owner was in, and the one 0.2.10 first made reachable.
        seed_gdi_bitmap();
        let (dirty, dirty_announced) = announce_with(set_delayed, &[CF_DIB_U32, CF_BITMAP_U32]);
        println!("screenshot / fixed → {dirty:?}  formats_on_clipboard={dirty_announced}");
        assert!(
            dirty.is_ok(),
            "a GDI format already on the clipboard must not break the announcement: {dirty:?}"
        );

        clear_clipboard();
    }
}

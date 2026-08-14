// *** DIAGNOSTIC SCAFFOLDING — NOT PRODUCTION ***
//
// 2026-07-29 forensic: image inject failed with
//   resolve ok=false mode=clipboard err=INJECT_CLIPBOARD_FAIL
//   detail="image clipboard paste failed; paste=Win32 error: 2147942406"
// 2147942406 = 0x80070006 = HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE), and only
// ~5ms elapsed — i.e. BEFORE clipboard_confirm's 80ms CLIPBOARD_SETTLE sleep.
//
// Every phase runs in its OWN process (`mode` argv) because one of them kills
// the process outright (STATUS_HEAP_CORRUPTION), and a phase that aborts must
// not take the rest of the diagnosis with it.
//
//   dump                 — enumerate the clipboard (read-only, no GetClipboardData)
//   save                 — production clipboard_snapshot::save_clipboard()
//   readfmt <id>         — production-shaped read of ONE format id
//   probe <scenario>     — seed a clipboard state, then run a verbatim,
//                          instrumented copy of paste_formats' own-block
//   realpaste <scenario> — seed, then call the REAL
//                          paste_formats_with_confirmation (fires Ctrl+V if the
//                          own-block succeeds — hence opt-in)
//   seed <what>          — leave a clipboard state behind and exit
//
// scenarios: empty | gdi | text     what: empty | gdi | text

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("windows-only diagnostic");
}

#[cfg(target_os = "windows")]
fn main() {
    win::run();
}

#[cfg(target_os = "windows")]
mod win {
    use flowmic_desktop_lib::inject::clipboard_confirm::paste_formats_with_confirmation;
    use flowmic_desktop_lib::inject::clipboard_snapshot::save_clipboard;
    use flowmic_desktop_lib::inject::image;

    use std::time::Duration;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{GetLastError, SetLastError, HANDLE, HGLOBAL, HWND, WIN32_ERROR};
    use windows::Win32::Graphics::Gdi::CreateBitmap;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, CountClipboardFormats, EmptyClipboard, EnumClipboardFormats,
        GetClipboardData, GetClipboardFormatNameW, GetClipboardOwner, OpenClipboard,
        SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, HWND_MESSAGE,
        WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };

    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;

    /// The same 2x2 PNG image.rs' own unit tests use.
    const PNG_2X2_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMASUkJeJw9PL4AAAAASUVORK5CYII=";

    fn gle() -> u32 {
        unsafe { GetLastError().0 }
    }

    fn fmt_name(f: u32) -> String {
        let builtin = match f {
            1 => "CF_TEXT",
            2 => "CF_BITMAP",
            3 => "CF_METAFILEPICT",
            6 => "CF_TIFF",
            7 => "CF_OEMTEXT",
            8 => "CF_DIB",
            9 => "CF_PALETTE",
            13 => "CF_UNICODETEXT",
            14 => "CF_ENHMETAFILE",
            15 => "CF_HDROP",
            16 => "CF_LOCALE",
            17 => "CF_DIBV5",
            _ => "",
        };
        if !builtin.is_empty() {
            return format!("{f}={builtin}");
        }
        let mut buf = [0u16; 128];
        let n = unsafe { GetClipboardFormatNameW(f, &mut buf) };
        if n > 0 {
            format!("{f}=\"{}\"", String::from_utf16_lossy(&buf[..n as usize]))
        } else {
            format!("{f}=<unnamed>")
        }
    }

    fn enum_formats() -> Vec<u32> {
        let mut list = Vec::new();
        unsafe {
            if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
                println!("   OpenClipboard(NULL) FAILED gle={}", gle());
                return list;
            }
            let mut f = 0u32;
            loop {
                SetLastError(WIN32_ERROR(0));
                f = EnumClipboardFormats(f);
                if f == 0 {
                    break;
                }
                list.push(f);
            }
            let _ = CloseClipboard();
        }
        list
    }

    fn dump() {
        unsafe {
            let owner = GetClipboardOwner();
            let count = CountClipboardFormats();
            println!(
                "clipboard owner_hwnd={:?} CountClipboardFormats={count}",
                owner.map(|h| h.0 as usize)
            );
        }
        for f in enum_formats() {
            println!("   format {}", fmt_name(f));
        }
    }

    // ── phase: production save_clipboard ───────────────────────────────────
    fn phase_save() {
        println!("calling production clipboard_snapshot::save_clipboard() ...");
        match save_clipboard() {
            Ok(s) => {
                println!("   -> Ok");
                for (f, b) in &s.formats {
                    println!("      kept    {} {} bytes", fmt_name(*f), b.len());
                }
                for f in &s.skipped {
                    println!("      SKIPPED {}", fmt_name(*f));
                }
            }
            Err(e) => println!("   -> Err({e})"),
        }
    }

    /// The production `WinClipboardApi::read` body, step by step, for ONE format.
    /// Deliberately identical: GetClipboardData -> GlobalSize -> GlobalLock ->
    /// from_raw_parts. Run in its own process; it can and does die.
    fn phase_readfmt(format: u32) {
        println!("reading format {} the way production reads it", fmt_name(format));
        unsafe {
            if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
                println!("   OpenClipboard FAILED gle={}", gle());
                return;
            }
            println!("   OpenClipboard OK");
            let handle = match GetClipboardData(format) {
                Ok(h) => {
                    println!("   GetClipboardData -> HANDLE {:?} (0x{:X})", h.0 as usize, h.0 as usize);
                    h
                }
                Err(e) => {
                    println!("   GetClipboardData -> ERR hr=0x{:08X} gle={}", e.code().0, gle());
                    let _ = CloseClipboard();
                    return;
                }
            };
            let global = HGLOBAL(handle.0);
            println!("   about to call GlobalSize(handle) ...");
            let size = GlobalSize(global);
            println!("   GlobalSize -> {size} (gle={})", gle());
            if size == 0 {
                println!("   size==0 -> production returns Err(gle) and SKIPS this format");
                let _ = CloseClipboard();
                return;
            }
            println!("   about to call GlobalLock(handle) ...");
            let p = GlobalLock(global) as *const u8;
            println!("   GlobalLock -> {p:?} (gle={})", gle());
            if p.is_null() {
                let _ = CloseClipboard();
                return;
            }
            println!("   about to copy {size} bytes out ...");
            let bytes = std::slice::from_raw_parts(p, size).to_vec();
            println!("   copied {} bytes", bytes.len());
            let _ = GlobalUnlock(global);
            let _ = CloseClipboard();
        }
    }

    // ── seeding ────────────────────────────────────────────────────────────
    fn clear_clipboard() {
        unsafe {
            if OpenClipboard(HWND(std::ptr::null_mut())).is_ok() {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }

    /// Put a REAL GDI HBITMAP on the clipboard — what a screenshot leaves behind.
    fn put_gdi_bitmap() -> bool {
        unsafe {
            let pixels: [u8; 16] = [
                0xFF, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x40, 0x40,
                0x40, 0xFF,
            ];
            let hbmp = CreateBitmap(2, 2, 1, 32, Some(pixels.as_ptr() as *const _));
            if hbmp.is_invalid() {
                println!("   CreateBitmap FAILED gle={}", gle());
                return false;
            }
            if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
                println!("   seed OpenClipboard FAILED gle={}", gle());
                return false;
            }
            let _ = EmptyClipboard();
            let ok = SetClipboardData(CF_BITMAP, HANDLE(hbmp.0)).is_ok();
            if !ok {
                println!("   seed SetClipboardData(CF_BITMAP) FAILED gle={}", gle());
            }
            let _ = CloseClipboard();
            ok
        }
    }

    fn put_text() -> bool {
        unsafe {
            let s: Vec<u16> = "hello from the diagnostic\0".encode_utf16().collect();
            let bytes = s.len() * 2;
            if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
                return false;
            }
            let _ = EmptyClipboard();
            let mut ok = false;
            if let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, bytes) {
                let p = GlobalLock(h) as *mut u8;
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(s.as_ptr() as *const u8, p, bytes);
                    let _ = GlobalUnlock(h);
                    ok = SetClipboardData(CF_UNICODETEXT, HANDLE(h.0)).is_ok();
                }
            }
            let _ = CloseClipboard();
            ok
        }
    }

    fn seed(what: &str) {
        match what {
            "gdi" => println!("seed gdi -> {}", put_gdi_bitmap()),
            "text" => println!("seed text -> {}", put_text()),
            _ => {
                clear_clipboard();
                println!("seed empty -> cleared");
            }
        }
    }

    // ── the instrumented own-block (verbatim shape of paste_formats) ────────
    unsafe extern "system" fn diag_wndproc(
        hwnd: HWND,
        msg: u32,
        wp: windows::Win32::Foundation::WPARAM,
        lp: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    fn ensure_diag_class() {
        use std::sync::OnceLock;
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| unsafe {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(diag_wndproc),
                lpszClassName: w!("FlowMicDiagClipboardRender"),
                ..Default::default()
            };
            let atom = RegisterClassW(&wc);
            println!("   RegisterClassW -> atom={atom} (0=failed, gle={})", gle());
        });
    }

    /// CreateWindowExW + OpenClipboard/EmptyClipboard/SetClipboardData(NULL)*/
    /// CloseClipboard — the exact block from clipboard_confirm::win::paste_formats,
    /// with every call reported. STOPS before the 80ms sleep and never fires
    /// SendInput.
    fn probe_own_block(announce: &[u32]) -> Option<(&'static str, u32)> {
        ensure_diag_class();
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("FlowMicDiagClipboardRender"),
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
        };
        let hwnd = match hwnd {
            Ok(h) => {
                println!("   CreateWindowExW(HWND_MESSAGE) -> OK hwnd=0x{:X}", h.0 as usize);
                h
            }
            Err(e) => {
                let hr = e.code().0 as u32;
                println!("   CreateWindowExW -> ERR hr=0x{hr:08X} gle={}", gle());
                return Some(("CreateWindowExW", hr));
            }
        };

        let mut failure: Option<(&'static str, u32)> = None;
        unsafe {
            match OpenClipboard(hwnd) {
                Ok(()) => println!("   OpenClipboard(hwnd) -> OK"),
                Err(e) => {
                    let hr = e.code().0 as u32;
                    println!("   OpenClipboard(hwnd) -> ERR hr=0x{hr:08X} gle={}", gle());
                    let _ = DestroyWindow(hwnd);
                    return Some(("OpenClipboard", hr));
                }
            }
            match EmptyClipboard() {
                Ok(()) => println!("   EmptyClipboard() -> OK"),
                Err(e) => {
                    let hr = e.code().0 as u32;
                    println!("   EmptyClipboard() -> ERR hr=0x{hr:08X} gle={}", gle());
                    failure = Some(("EmptyClipboard", hr));
                }
            }
            if failure.is_none() {
                for &format in announce {
                    SetLastError(WIN32_ERROR(0));
                    match SetClipboardData(format, HANDLE(std::ptr::null_mut())) {
                        Ok(h) => println!(
                            "   SetClipboardData({}, NULL) -> OK ret=0x{:X}",
                            fmt_name(format),
                            h.0 as usize
                        ),
                        Err(e) => {
                            let hr = e.code().0 as u32;
                            println!(
                                "   SetClipboardData({}, NULL) -> ERR hr=0x{hr:08X} gle={}",
                                fmt_name(format),
                                gle()
                            );
                            failure = Some(("SetClipboardData", hr));
                            break;
                        }
                    }
                }
            }
            match CloseClipboard() {
                Ok(()) => println!("   CloseClipboard() -> OK"),
                Err(e) => {
                    let hr = e.code().0 as u32;
                    println!("   CloseClipboard() -> ERR hr=0x{hr:08X} gle={}", gle());
                    if failure.is_none() {
                        failure = Some(("CloseClipboard", hr));
                    }
                }
            }
            let _ = DestroyWindow(hwnd);
        }
        failure
    }

    /// The SAME own-block, but reading the ONE Win32-documented success signal
    /// for `SetClipboardData(fmt, NULL)`: the return value is `hMem` (= NULL) on
    /// success, so only `SetLastError(0)` + `GetLastError()` can tell success
    /// from failure. Proves the minimal fix.
    fn probe_own_block_fixed(announce: &[u32]) -> Option<(&'static str, u32)> {
        ensure_diag_class();
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("FlowMicDiagClipboardRender"),
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
        .expect("CreateWindowExW");
        println!("   CreateWindowExW -> OK hwnd=0x{:X}", hwnd.0 as usize);
        let mut failure = None;
        unsafe {
            if OpenClipboard(hwnd).is_err() {
                let g = gle();
                let _ = DestroyWindow(hwnd);
                return Some(("OpenClipboard", g));
            }
            println!("   OpenClipboard(hwnd) -> OK");
            if EmptyClipboard().is_err() {
                failure = Some(("EmptyClipboard", gle()));
            }
            if failure.is_none() {
                for &format in announce {
                    SetLastError(WIN32_ERROR(0));
                    let _ = SetClipboardData(format, HANDLE(std::ptr::null_mut()));
                    let g = gle();
                    println!(
                        "   SetClipboardData({}, NULL) -> GetLastError()={g} {}",
                        fmt_name(format),
                        if g == 0 { "=> SUCCESS" } else { "=> FAILURE" }
                    );
                    if g != 0 {
                        failure = Some(("SetClipboardData", g));
                        break;
                    }
                }
            }
            if CloseClipboard().is_err() && failure.is_none() {
                failure = Some(("CloseClipboard", gle()));
            } else {
                println!("   CloseClipboard() -> OK");
            }
        }
        if failure.is_none() {
            let owned = enum_formats();
            println!(
                "   clipboard NOW advertises [{}]  <- delayed-render ownership really took",
                owned.iter().map(|f| fmt_name(*f)).collect::<Vec<_>>().join(", ")
            );
        }
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        failure
    }

    fn production_table() -> (Vec<(u32, Vec<u8>)>, Vec<u32>, Vec<u32>) {
        let formats = image::clipboard_formats(PNG_2X2_B64, "image/png")
            .expect("production image::clipboard_formats");
        let no_bitmap: Vec<u32> = formats.iter().map(|(f, _)| *f).collect();
        let mut full = no_bitmap.clone();
        if full.contains(&CF_DIB) && !full.contains(&CF_BITMAP) {
            full.push(CF_BITMAP);
        }
        (formats, full, no_bitmap)
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mode = args.first().map(|s| s.as_str()).unwrap_or("dump");
        let arg = args.get(1).map(|s| s.as_str()).unwrap_or("");
        println!("--- diag mode={mode} arg={arg} pid={} ---", std::process::id());

        match mode {
            "dump" => dump(),
            "save" => phase_save(),
            "readfmt" => phase_readfmt(arg.parse().unwrap_or(2)),
            "seed" => seed(arg),
            "realpaste-text" => {
                seed(arg);
                println!("   calling REAL paste_with_confirmation(\"diag\") ...");
                let t = std::time::Instant::now();
                let out = flowmic_desktop_lib::inject::clipboard_confirm::paste_with_confirmation(
                    "diag",
                    Duration::from_millis(300),
                );
                println!("   -> {out:?}   (elapsed {:?})", t.elapsed());
                clear_clipboard();
            }
            "probe" | "probe-nobitmap" | "realpaste" | "fixprobe" => {
                seed(arg);
                dump();
                let (formats, full, no_bitmap) = production_table();
                let announce: &[u32] = if mode == "probe-nobitmap" { &no_bitmap } else { &full };
                println!(
                    "   production table = [{}]",
                    formats
                        .iter()
                        .map(|(f, b)| format!("{} {}B", fmt_name(*f), b.len()))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                println!(
                    "   announce = [{}]",
                    announce.iter().map(|f| fmt_name(*f)).collect::<Vec<_>>().join(", ")
                );
                if mode == "realpaste" {
                    println!("   calling REAL paste_formats_with_confirmation ...");
                    let t = std::time::Instant::now();
                    let out = paste_formats_with_confirmation(&formats, Duration::from_millis(300));
                    println!("   -> {out:?}   (elapsed {:?})", t.elapsed());
                } else if mode == "fixprobe" {
                    match probe_own_block_fixed(announce) {
                        Some((step, g)) => println!("   >>> FAILED AT {step} gle={g}"),
                        None => println!("   >>> FIXED own-block completed with NO error"),
                    }
                } else {
                    match probe_own_block(announce) {
                        Some((step, hr)) => {
                            println!("   >>> FAILED AT {step} hr=0x{hr:08X} ({hr})")
                        }
                        None => println!("   >>> own-block completed with NO error"),
                    }
                }
                clear_clipboard();
            }
            other => println!("unknown mode {other}"),
        }
    }
}

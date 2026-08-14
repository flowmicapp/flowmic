// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §K「胶囊定位：caret 锚定 + 多屏 flip/clamp
//     （永不遮挡 caret）→ 记忆拖动位 → 顶部居中」
//     ("Capsule placement: caret-anchored + multi-monitor flip/clamp (never
//     occludes the caret) → remembered drag position → top-center")
//   docs/strategy/R6-BACKLOG-AND-PLAN.md §0 D1 (owner ruling: caret-anchored) / §2 T-1
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (capsule first-surface placement)
//
// Foreground caret geometry via Win32 `GetGUIThreadInfo`. Deliberately tauri-free
// (same shape as window_enum.rs) so `cargo test` covers it without the WebView2
// toolchain; the `app` shell wraps it in the `caret_rect` command.
//
// DIVISION OF LABOUR (T-1 ruling 5): this module ONLY reads the raw OS rects. All
// placement math (gap / below-vs-above flip / horizontal clamp) lives in the pure
// TypeScript `anchorToCaret` (apps/desktop/src/lib/capsule-position.ts) where it is
// unit-tested with no OS.
//
// PIXEL UNITS: everything here is PHYSICAL screen (virtual-desktop) px — the process
// is per-monitor DPI aware, so Win32 hands back device pixels. The single
// physical→logical conversion happens in `shell::caret_rect` (see the marked
// conversion point there), because `capsule_move` speaks LOGICAL px.

/// A caret reading plus the work area of the monitor the caret sits on.
/// All fields PHYSICAL px, virtual-desktop coordinates (a monitor left of the
/// primary yields negative x — the placement math must not assume 0-based).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaretSnapshot {
    /// Caret rect, converted to SCREEN coordinates (rcCaret is client-relative).
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// `rcWork` of the caret's monitor (taskbar excluded) — the flip/clamp bounds.
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: i32,
    pub work_height: i32,
}

/// Read the foreground thread's caret. `None` whenever there is no *usable* caret
/// — no foreground window, the thread refuses GetGUIThreadInfo, the focused control
/// owns no caret (`hwndCaret` null), or the rect is empty / all-zero. The caller
/// must then fall back (capsule → top-center); NEVER fabricate a position.
#[cfg(target_os = "windows")]
pub fn foreground_caret() -> Option<CaretSnapshot> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };

    // SAFETY: every call below is a plain read of OS window state with locally
    // owned, correctly sized out-params; no handle is retained past this fn.
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None; // lock screen / no foreground window
        }
        let tid = GetWindowThreadProcessId(fg, None);
        if tid == 0 {
            return None; // window died between the two calls
        }

        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui).is_err() {
            // 🔴 This used to read 「e.g. an elevated foreground process we may not
            // query」. Measured false 2026-08-02: a genuinely Medium-integrity
            // process reads a High-integrity target's GUITHREADINFO fine
            // (`docs/strategy/2026-08-02-f1b-universal-focus-probe-matrix.md` §2.2 ①).
            // We do not know why it failed, so we no longer name a reason — the
            // caret is simply unknown and the caller falls back. anti-façade ④.
            return None;
        }
        // No caret-owning window ⇒ the focus is not in a text field at all.
        if gui.hwndCaret.0.is_null() {
            return None;
        }

        let r = gui.rcCaret;
        // All-zero (never set) or a degenerate height ⇒ no usable caret. A
        // zero-WIDTH caret is legitimate (thin insertion bars), so only the height
        // is required to be positive.
        if r.left == 0 && r.top == 0 && r.right == 0 && r.bottom == 0 {
            return None;
        }
        let width = r.right - r.left;
        let height = r.bottom - r.top;
        if height <= 0 || width < 0 {
            return None;
        }

        // rcCaret is in the CLIENT coordinates of `hwndCaret` (the classic bug: using
        // it as if it were screen coords parks the capsule at the top-left of the
        // window). Convert BOTH corners before any math.
        let mut tl = POINT { x: r.left, y: r.top };
        let mut br = POINT { x: r.right, y: r.bottom };
        if !ClientToScreen(gui.hwndCaret, &mut tl).as_bool() {
            return None;
        }
        if !ClientToScreen(gui.hwndCaret, &mut br).as_bool() {
            return None;
        }

        // Multi-monitor (T-1 ruling 4): the flip/clamp bounds are the work area of
        // the monitor the CARET is on — chosen via MonitorFromPoint on the caret
        // centre, never the primary screen. DEFAULTTONEAREST keeps a caret that sits
        // in a monitor gap on the closest display.
        let centre = POINT {
            x: tl.x + (br.x - tl.x) / 2,
            y: tl.y + (br.y - tl.y) / 2,
        };
        let monitor = MonitorFromPoint(centre, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return None; // no bounds ⇒ we cannot clamp honestly ⇒ let the caller fall back
        }
        let work = mi.rcWork;
        let work_width = work.right - work.left;
        let work_height = work.bottom - work.top;
        if work_width <= 0 || work_height <= 0 {
            return None;
        }

        Some(CaretSnapshot {
            x: tl.x,
            y: tl.y,
            width: br.x - tl.x,
            height: br.y - tl.y,
            work_x: work.left,
            work_y: work.top,
            work_width,
            work_height,
        })
    }
}

/// Non-Windows: there is no GetGUIThreadInfo equivalent in scope for 0.1.0 (the
/// desktop app ships Windows-only), so the caret is honestly unknown → the capsule
/// falls back to top-center. Same dual-impl shape as `configure_capsule_window`.
#[cfg(not(target_os = "windows"))]
pub fn foreground_caret() -> Option<CaretSnapshot> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_carries_caret_and_work_area_in_screen_space() {
        // Structural test: the live read needs a real desktop + a focused text
        // field, so here we only pin the record shape the shell command converts.
        // Negative coordinates are legal — a monitor left of the primary.
        let s = CaretSnapshot {
            x: -1200,
            y: 480,
            width: 2,
            height: 19,
            work_x: -1920,
            work_y: 0,
            work_width: 1920,
            work_height: 1040,
        };
        assert_eq!(s.x + s.width, -1198);
        assert!(s.work_x < 0, "secondary monitor coordinates may be negative");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_has_no_caret() {
        assert!(foreground_caret().is_none());
    }
}

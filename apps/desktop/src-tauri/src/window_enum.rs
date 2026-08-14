// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (focus tracking) / §2 (injection target
//     resolution) — window
//     enumeration backs target selection and forensic snapshots.
//
// Top-level visible-window enumeration via EnumWindows. Each entry carries the
// HWND, the window title, and the process basename (same extraction the focus
// tracker uses for process_name). Windows-only; non-windows returns an empty
// list so cross-target builds pass.

/// One enumerated top-level window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub title: String,
    /// Executable basename with the platform extension stripped ("notepad").
    pub process_name: String,
}

/// Enumerate visible top-level windows that have a non-empty title. The FlowMic
/// own window is NOT filtered here (callers that need self-exclusion compare
/// against their own HWND) — this is a raw OS snapshot.
#[cfg(target_os = "windows")]
pub fn enumerate_windows() -> Vec<WindowInfo> {
    use std::cell::RefCell;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, IsWindowVisible};

    thread_local! {
        static ACCUM: RefCell<Vec<WindowInfo>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn cb(hwnd: HWND, _l: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1); // keep enumerating
        }
        let raw = hwnd.0 as usize as u64;
        let title = crate::focus::tracker::current_window_title(raw);
        if title.is_empty() {
            return BOOL(1);
        }
        let process_name = crate::focus::tracker::current_app_name(raw);
        ACCUM.with(|a| {
            a.borrow_mut().push(WindowInfo {
                hwnd: raw,
                title,
                process_name,
            })
        });
        BOOL(1)
    }

    ACCUM.with(|a| a.borrow_mut().clear());
    // SAFETY: `cb` is a valid extern "system" callback; EnumWindows drives it
    // synchronously on this thread, so the thread-local accumulator is sound.
    let _ = unsafe { EnumWindows(Some(cb), LPARAM(0)) };
    ACCUM.with(|a| a.borrow().clone())
}

#[cfg(not(target_os = "windows"))]
pub fn enumerate_windows() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_info_is_constructible_and_comparable() {
        // Structural test: the enumerate call itself needs a live desktop, so
        // here we only assert the record shape the socket/forensic layers rely on.
        let w = WindowInfo {
            hwnd: 0x10,
            title: "Untitled - Notepad".into(),
            process_name: "notepad".into(),
        };
        assert_eq!(w.process_name, "notepad");
        assert!(!w.process_name.ends_with(".exe"), "extension must be stripped");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_enumerate_is_empty() {
        assert!(enumerate_windows().is_empty());
    }
}

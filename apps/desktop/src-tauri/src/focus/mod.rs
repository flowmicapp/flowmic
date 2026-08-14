// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §3 (focus tracking and the SPEAKING lock).
//
// Focus layer: the pure state machine (state.rs — the SPEAKING-lock invariant)
// and the OS event-hook tracker (tracker.rs — SetWinEventHook + process-name
// extraction + Stage-1 SetForegroundWindow).

/// MAC-04: the macOS foreground source (NSWorkspace activation notification +
/// `NSRunningApplication.activate`). Selected by `tracker.rs`'s cfg arms, never
/// referenced directly by a caller — everything still goes through
/// `WinEventSource` / `set_foreground_window` / `current_foreground_target`.
#[cfg(target_os = "macos")]
pub mod macos;
pub mod state;
pub mod tracker;

pub use state::{FocusEvent, FocusState, FocusStateMachine, StateError};
pub use tracker::{
    current_app_name, current_foreground_hwnd, current_foreground_target, current_window_title,
    set_foreground_window, FocusTracker, WinEventSource, WindowsWinEventSource,
};

// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1215-window-drag-follow-cursor.md
//     (owner: the window must FOLLOW the cursor, on Windows AND macOS)
//   docs/strategy/2026-08-12-req1215-window-drag-follow-cursor.md §4
//     (candidate 2: native drag region [the OS follows the cursor] replaces the custom chain)
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (capsule surface is NON-ACTIVATING)
//   CLAUDE.md red line: ambient surfacing never steals focus by activating / no silent failures
//
// ── WHAT THIS REPLACES, AND WHAT WAS MEASURED ────────────────────────────────
//
// The capsule used to be dragged by hand-rolled math in the WebView: every
// `pointermove` computed a screen-space delta, divided it by
// `window.devicePixelRatio`, added it to the last commanded position and fired
// `capsule_move` (see `shell::capsule_move`, still the ANCHOR/RESTORE path).
// Reading that path end to end (2026-08-12, LAN lane, machine
// dev-pc-a) turns up three independent reasons the window trails the
// pointer, only one of which is arithmetic:
//
//   ① ONE FULL IPC ROUND TRIP PER FRAME. Each pointermove crossed
//      WebView2 → main thread → `set_position` → `SetWindowPos`, and Tauri
//      emits `tauri://move` back into the WebView for every resulting WM_MOVE.
//      The window is therefore always at least one round trip behind the
//      pointer, and the DISTANCE that costs is `latency × pointer speed` —
//      which is exactly the shape owner reported (「the faster the mouse, the bigger the gap」).
//      A wrong SCALE would instead lose a fixed FRACTION of the travel at any
//      speed; a wrong LATENCY loses more the faster you go. The reported
//      symptom names latency, not arithmetic.
//   ② NO BACK-PRESSURE AND NO COALESCING. The frontend fired the command
//      through a `void`-discarded promise, so frame N+1 never waited for
//      frame N and nothing dropped a stale position; a backlog was replayed in
//      full rather than skipped.
//   ③ A COORDINATE-SPACE ASSUMPTION THAT IS PER-PLATFORM. Dividing by the
//      device pixel ratio is right only if `PointerEvent.screenX/Y` are
//      PHYSICAL px. That was MEASURED true on Windows @150% (2026-07-25, the
//      off-screen-capsule incident recorded in `lib/capsule-position.ts`). It
//      is NOT known to hold for the WKWebView on macOS, where screen
//      coordinates are points while `devicePixelRatio` is 2 on a Retina panel
//      — the same line would then move the capsule at HALF the cursor's speed.
//      Unverified either way off-Windows; see the report for REQ-12-15.
//
// This module removes all three at once by not doing the job at all: the OS
// runs its own modal move loop, which tracks the cursor 1:1 by construction,
// costs zero IPC per frame, and never converts a coordinate.
//
// ── WHY THIS IS STILL NON-ACTIVATING ─────────────────────────────────────────
//
// `start_dragging` is tao's cross-platform native drag. On Windows it is
// `ReleaseCapture()` + `PostMessageW(WM_NCLBUTTONDOWN, HTCAPTION)`; on macOS it
// is `performWindowDragWithEvent:`. The capsule's HWND carries
// `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW` (`shell::configure_capsule_window`),
// which is the documented mechanism for「clicking this window does not make it
// the foreground window」— and the click that STARTS this drag is an ordinary
// click on that same window, one that provably does not steal focus today
// (it is how the copy / ⚙ / × buttons are already pressed while the user types
// somewhere else).
// 🔴 THAT REASONING IS NOT A MEASUREMENT. Nothing on a Windows gate can
// observe whether the OS move loop activates the capsule, and no gate anywhere
// can observe the macOS half. The device line must watch the injection target
// keep focus while the capsule is dragged, on BOTH systems, before this is
// called verified.
//
// ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
//
// · It does not persist anything. The persisted drag position is owned by the
//   frontend (`lib/capsule-position.ts`, localStorage), because a persisted
//   position WINS FOREVER over caret anchoring (owner's ruling D1) — so「did the
//   user actually move it」has to be decided where that rule lives.
// · It does not touch `configure_capsule_window` or any window flag.
// · `capsule_position` is a pure READ. It is the only honest way to learn where
//   a native drag ended: the frontend never saw the pointer during it.
//
// ⚠️ TESTS: this module lives under `shell`, which is `#[cfg(feature = "app")]`,
// and `verify:rust-tests` runs `cargo test --lib` WITHOUT that feature — so a
// `#[cfg(test)]` block here would never execute in the delivery gate. Rather
// than plant tests that only look like coverage, the testable half (「did the
// window actually move, i.e. may we persist」) is a pure function in the
// frontend, where the suite that runs it is `verify:desktop-tests`. What holds
// this file up is compilation plus the device-line run named above.
//
// 🔴 In-place correction (2026-08-13, LANE 6, machine = F:\vibecoding-project\flowmic-github,
// 【measured】) — THE PARAGRAPH ABOVE IS FALSE TODAY. Left in place because it was
// true when written; read THIS instead.
// `verify:rust-tests` is TWO legs, and the second one carries the feature:
//   "cargo test --lib && cargo test --lib --features app"   (root package.json)
// Measured by planting tests under `shell` and running the second leg: the nine
// `shell::capsule_watch::tests::*` cases execute and are counted. A `#[cfg(test)]`
// block here WOULD run in the delivery gate.
// ⇒ The conclusion it was used to justify — that the frontend is the right home
// for「may we persist」— is still fine on its own merits; what is not fine is the
// reason, because it told the next reader not to bother. That is anti-façade rule ④ in
// its purest form: a comment asserting the behaviour of something else
// (package.json), whose truth value moves when that other thing moves, and which
// has no anchor a grep could check.

use tauri::{AppHandle, Manager};

use super::CAPSULE;

/// Hand the capsule's drag to the operating system (REQ-12-15).
///
/// Called once per drag, on the frontend's drag-arm edge — never per frame.
/// After this returns the WebView stops seeing the pointer: the OS owns the
/// mouse until the button is released, and the window follows it with the same
/// fidelity as any other window on the desktop.
///
/// Fails LOUDLY (Err + forensic). A drag that silently does not start would be
/// indistinguishable from a drag that lags, which is the very bug this replaces.
#[tauri::command]
pub fn capsule_start_drag(app: AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window(CAPSULE) else {
        crate::forensic::record("capsule", "drag: start refused — capsule window not found");
        return Err("capsule window not found".into());
    };
    // REQ-13-16 instrument, read BEFORE the OS takes the mouse: the drag is the
    // gesture R8 §2-1 measured the foreground steal on, so「which window was on
    // screen when the drag started」is the reading that matters. Forensic only.
    #[cfg(windows)]
    super::capsule_watch::observe_window(&w, "drag");
    match w.start_dragging() {
        Ok(()) => {
            crate::forensic::record("capsule", "drag: handed to the OS move loop");
            Ok(())
        }
        Err(e) => {
            crate::forensic::record("capsule", &format!("drag: start_dragging FAILED — {e}"));
            Err(e.to_string())
        }
    }
}

/// The capsule's current position in LOGICAL px — the same space
/// `capsule_move`, `caret_rect` and the persisted drag position speak.
#[derive(serde::Serialize)]
pub struct CapsulePoint {
    pub x: f64,
    pub y: f64,
}

/// Read where the capsule actually IS, in logical px.
///
/// The OS moved the window during a native drag, so the frontend's own idea of
/// the position is stale by definition; this is how it catches up (and what it
/// persists). Converting HERE, by the capsule window's own `scale_factor`, is
/// the same single conversion point `caret_rect` uses — the frontend never has
/// to guess whether a number is physical or logical, which is precisely the
/// class of mistake that once parked the capsule off-screen.
///
/// `None` when the window is gone or the OS refuses the query — never a
/// fabricated origin: the caller then keeps its previous position and persists
/// nothing (no silent failures: the refusal is recorded).
#[tauri::command]
pub fn capsule_position(app: AppHandle) -> Option<CapsulePoint> {
    let w = app.get_webview_window(CAPSULE)?;
    // Same guard shape as `caret_rect`: a zero / non-finite factor would turn
    // every coordinate into NaN or infinity and lose the capsule entirely.
    let scale = w
        .scale_factor()
        .ok()
        .filter(|f| f.is_finite() && *f > 0.0)
        .unwrap_or(1.0);
    match w.outer_position() {
        Ok(p) => Some(CapsulePoint {
            x: f64::from(p.x) / scale,
            y: f64::from(p.y) / scale,
        }),
        Err(e) => {
            crate::forensic::record("capsule", &format!("drag: outer_position FAILED — {e}"));
            None
        }
    }
}

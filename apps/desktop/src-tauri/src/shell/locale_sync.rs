// U6 — the Rust half of the UI-locale bridge (2026-08-04).
//
// The chosen UI language lives in the WebView's localStorage
// (`flowmic.ui.locale`, apps/desktop/src/lib/strings/locale.ts), which Rust
// cannot read — while the tray menu, the exit-confirmation dialog and the
// autostart error strings are all rendered on the Rust side. This command is
// the smallest real bridge:
//
//   frontend → here : `reportUiLocale` (src/lib/bridge.ts) invokes it on boot
//                     (after hydrateLocale, from main-window/main.ts) and on
//                     every prefs change (the UI_PREFS_SYNC handler in the same
//                     file) — so an existing user's stored choice migrates in
//                     on first launch after this card, no re-selection needed.
//   here → process  : `ui_i18n::set_current` — the tray/dialog/autostart sites
//                     read it through `ui_i18n::tr`.
//   here → disk     : `ui_i18n::persist` writes `%APPDATA%\FlowMic\ui-locale.txt`
//                     so `ui_i18n::init_from_disk` (run(), before any UI
//                     surface) has the right language on the NEXT launch too.
//   here → tray     : clears the pump's change-only tray memo and emits
//                     UI_LOCALE_CHANGED, so the menu re-renders immediately and
//                     the status/tooltip repaint on the next ≤500 ms pump tick.
//
// NEVER reads the OS locale (red line) — the only writer of the Rust-side locale is
// this command, and its only caller is the frontend's explicit-choice pipeline.

use tauri::{AppHandle, Emitter};

use crate::ui_i18n::{self, UiLocale};

/// Mirror the frontend's persisted UI locale into the Rust shell. Fail-loud:
/// an unknown tag is refused (the frontend validates against the same list, so
/// an Err here means the two key spaces drifted — exactly what must not be
/// papered over with a silent default), and a persist failure is reported even
/// though the in-memory switch already happened.
#[tauri::command]
pub fn ui_locale_set(app: AppHandle, locale: String) -> Result<(), String> {
    let Some(l) = UiLocale::from_tag(&locale) else {
        crate::forensic::record(
            "i18n",
            &format!("ui_locale_set REFUSED unknown tag {locale:?} — frontend/Rust locale lists drifted"),
        );
        // 🔴 The supported list is ASKED FOR, not typed out. It used to read
        // "…supports zh-CN/en/ja/ko" — a hand-copied language list sitting in
        // the one message a reader consults when the two key spaces have
        // ALREADY drifted. Once stale it does not merely mislead: it misdirects
        // the diagnosis of the exact failure it is reporting.
        return Err(format!(
            "unknown locale tag {locale:?} — the Rust side supports {}",
            ui_i18n::supported_tags()
        ));
    };
    if !ui_i18n::set_current(l) {
        // Idempotent boot mirror (same value) — nothing to persist or repaint.
        return Ok(());
    }
    crate::forensic::record(
        "i18n",
        &format!("ui locale -> {} (Rust surface: tray/menu now, status+tooltip next pump tick)", l.tag()),
    );
    // Defeat the tray's change-only throttle: same state, new words.
    crate::socket::pump::tray_showing_reset();
    // Re-render the static menu items (listener in shell/tray.rs).
    let _ = app.emit(
        crate::socket::bridge::channel::UI_LOCALE_CHANGED,
        serde_json::json!({ "locale": l.tag() }),
    );
    // Persist for the next launch — the half of the bridge init_from_disk reads.
    if let Err(e) = ui_i18n::persist(l) {
        crate::forensic::record("i18n", &format!("ui locale persist FAILED: {e}"));
        return Err(format!(
            "locale applied for this session, but persisting it failed: {e}"
        ));
    }
    Ok(())
}

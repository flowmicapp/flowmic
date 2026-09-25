// SPEC-REF:
//   CLAUDE.md red line: 「ambient 浮现永不激活抢焦点」 (ambient surfacing never steals
//     focus by activating)
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (the capsule surface is NON-ACTIVATING)
//   docs/archive/strategy/2026-08-12-device-line-r8-session-close.md §2-1 (the investigation
//     this file closes; the instrument that closed it is `capsule_watch.rs`)
//
// THE CAPSULE'S NON-ACTIVATING EX-STYLE — split out of `shell/mod.rs` (which was at
// 799 of its 800-line cap) so this could grow the paragraph below.
//
// ── 🔴 ROOT CAUSE, FOUND 2026-08-24, AND IT IS NEITHER OF THE TWO WE GUESSED ──
//
// The bits went missing for months. R8 §2-1 suspected `set_size`; `capsule_watch`
// measured that away and proposed a second suspect — that WebView2/tao tears the
// native window down and rebuilds it, so the window on screen is not the window we
// configured. The instrument was built to tell those apart, and it kept a cheap
// bit-check as a secondary line 「so that the refutation has something that would go
// loud if it ever stopped being true」.
//
// It went loud. From this machine's forensic log, 8 times since 2026-08-21:
//
//   watch@resize BITS LOST — SAME hwnd=0x291E48 we configured, but now
//   exstyle=0x000C0138 NOACTIVATE=false TOOLWINDOW=false
//
// Same HWND ⇒ no recreation. So both suspects are wrong, and the third answer was
// in the dependency all along — read out of the crate this build actually links,
// tao 0.35.3, `platform_impl/windows/window_state.rs`:
//
//   · `WindowFlags::apply_diff` ends with
//       let (style, style_ex) = new.to_window_styles();
//       SetWindowLongW(window, GWL_EXSTYLE, style_ex.0 as i32);
//     — a WHOLESALE OVERWRITE computed from tao's own flags. Not an OR. Anything
//     we painted on top is gone the next time ANY window flag changes.
//   · `to_window_styles` emits `WS_EX_NOACTIVATE` only for `!FOCUSABLE`, and does
//     not model `WS_EX_TOOLWINDOW` for app windows at all.
//
// And the flag change that fires on this product's hottest path is our own:
// `capsule_click_through` → `set_ignore_cursor_events`, the 800 ms just_injected
// window. Which is why the log reads 03:13:42.855 paste DONE → 03:13:43.670 BITS
// LOST, and why 0x000C0138 has LAYERED|TRANSPARENT set (the click-through pair
// tao regenerated) with NOACTIVATE|TOOLWINDOW cleared (ours, which it does not know
// about). ⇒ EVERY UTTERANCE DISARMED THE CAPSULE'S ANTI-FOCUS-STEAL, for the rest
// of the session. owner hit the consequence on 2026-08-24: clicking a row's
// re-inject icon in the capsule strip activated the capsule, so the injection had
// no window to go to.
//
// ── THE FIX: LET tao OWN THE BIT INSTEAD OF REPAINTING IT ────────────────────
//
// `set_focusable(false)` clears `WindowFlags::FOCUSABLE`, so `to_window_styles`
// re-emits `WS_EX_NOACTIVATE` on every future `apply_diff` — for free, forever, and
// without us having to notice. It is applied FIRST because the call is itself a
// flag change and therefore rewrites the ex-style; the manual OR then runs after it
// and the read-back reports what the OS truly holds.
//
// ⚠️ NOT A FIX FOR `WS_EX_TOOLWINDOW`, and this is registered rather than papered
// over: tao has no flag for it, so it is still painted on and will still be lost at
// the next flag change. What that costs is a taskbar / alt-tab entry — cosmetic —
// not a stolen foreground, and `capsule_watch` will keep saying so out loud.
//
// ⚠️ AND STILL NOT 「re-OR the bits at every touchpoint」, which R8 §2-1 warned
// against and `capsule_watch` refused to do. That would patch the symptom at N call
// sites while the cause kept overwriting. The cause now has a name, so it gets one
// fix at one place.

use tauri::AppHandle;

#[cfg(target_os = "linux")]
static LINUX_AMBIENT_POLICY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();

// 🔴 EVERY import here belongs to the Windows function below, and gating them is
// not tidiness — it is the difference between this crate building on macOS and
// not. `capsule_watch` is a cfg-windows-gated `pub mod` in shell/mod.rs, so an
// unconditional `use super::capsule_watch` is an unresolved import on every
// other platform. This file arrived with one, so 0.3.31 could not be compiled
// for macOS at all: `cargo check` there stopped at E0432 before it reached a
// single line of product code.
//
// ⚠️ Nothing on Windows could have caught it. `cargo`, `clippy` and every gate
// in this repo run there, where the import resolves; and `verify:lint`'s
// `platform-cfg-count` tripwire counts non-Windows cfg SITES, so a MISSING
// windows gate leaves that number untouched — it passed at 81 sites while
// the crate was unbuildable. This is CLAUDE.md's standing rule collecting on
// itself: a change that touches platform gating gets ZERO proof from the
// Windows gate, and the only instrument that answers is a run on the Mac.
#[cfg(windows)]
use tauri::Manager;
#[cfg(windows)]
use super::{capsule_watch, CAPSULE};

/// Make the capsule non-activating and keep it off the taskbar / alt-tab
/// (07 §4 ruling 1). Called once at setup.
///
/// 🔴 FAILS LOUD (REQ-13-16). Both lookups used to be silent `if let`s, so the
/// case 「the anti-focus-steal ex-style was never applied at all」 produced exactly
/// the same log as the case where it was applied and later lost — and the whole
/// R8 §2-1 investigation had to start by ruling that out by reading code, since
/// no run could answer it. Nothing about the WRITE changed; only its silence.
///
/// The ex-style is READ BACK after the write and the log reports what the OS
/// actually holds, not what we asked for — same discipline as the autostart
/// registry write. The read-back is also the reference the `capsule_watch`
/// instrument compares live windows against.
#[cfg(windows)]
pub fn configure_capsule_window(app: &AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let Some(w) = app.get_webview_window(CAPSULE) else {
        crate::forensic::record(
            "capsule",
            "configure: REFUSED — no window labelled `capsule`; WS_EX_NOACTIVATE + \
             WS_EX_TOOLWINDOW were NEVER applied and the capsule can take foreground",
        );
        return;
    };
    // Hand NOACTIVATE to tao BEFORE touching the ex-style ourselves — see the
    // header. This is the line that makes the bit survive every later
    // `set_ignore_cursor_events`; the manual OR below only makes it true *now*.
    if let Err(e) = w.set_focusable(false) {
        crate::forensic::record(
            "capsule",
            &format!(
                "configure: set_focusable(false) FAILED ({e}) — tao will keep regenerating an \
                 ex-style WITHOUT WS_EX_NOACTIVATE, so the bits OR'd in below will be lost again \
                 at the next window-flag change and the capsule will take foreground on click"
            ),
        );
    }
    let h = match w.hwnd() {
        Ok(h) => h,
        Err(e) => {
            crate::forensic::record(
                "capsule",
                &format!(
                    "configure: REFUSED — the `capsule` window has no HWND yet ({e}); \
                     WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW were NEVER applied"
                ),
            );
            return;
        }
    };
    let hwnd = HWND(h.0);
    let (before, after) = unsafe {
        let before = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = before | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        (before, GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    };
    capsule_watch::note_configured(h.0 as isize, after);
    crate::forensic::record(
        "capsule",
        &format!(
            "configure: hwnd=0x{:X} before {} -> after {}",
            h.0 as usize,
            capsule_watch::decode(before),
            capsule_watch::decode(after)
        ),
    );
}

#[cfg(target_os = "linux")]
pub fn configure_capsule_window(app: &AppHandle) {
    use gtk::prelude::*;
    use tauri::Manager;
    let Some(window) = app.get_webview_window(super::CAPSULE) else {
        crate::forensic::record("capsule", "Linux configure refused: capsule window missing");
        return;
    };
    // This function runs during Tauri setup on GTK's main thread. These are
    // compositor hints, not proof that an arbitrary compositor honors them.
    // Live acceptance must observe both the external target and this window.
    if let Err(error) = window.set_focusable(false) {
        crate::forensic::record("capsule", &format!("Linux set_focusable failed: {error}"));
    }
    match window.gtk_window() {
        Ok(native) => {
            native.set_accept_focus(false);
            native.set_focus_on_map(false);
            // WSLg maps a normal toplevel as an activating host window even
            // with both focus hints false. A status bubble needs its own role.
            native.set_type_hint(gtk::gdk::WindowTypeHint::Notification);
            native.set_skip_taskbar_hint(true);
            native.set_skip_pager_hint(true);
            let backend = crate::focus::linux_session::current_backend();
            let display = native.display().name();
            let wslg = matches!(display.as_str(), ":0" | ":0.0")
                && std::path::Path::new("/mnt/wslg/versions.txt").is_file();
            let policy = if backend != crate::focus::linux_session::DisplayBackend::X11 {
                Err(format!("backend={backend:?} has no verified non-activating surface"))
            } else if wslg {
                Err("WSLg X11 first-map activates the host window despite GTK focus hints".into())
            } else {
                Ok(())
            };
            let _ = LINUX_AMBIENT_POLICY.set(policy);
            crate::forensic::record("capsule", &format!(
                "Linux configure backend={:?} accept_focus={} focus_on_map={} active={}",
                crate::focus::linux_session::current_backend(), native.accepts_focus(),
                native.gets_focus_on_map(), native.is_active(),
            ));
        }
        Err(error) => crate::forensic::record("capsule", &format!("Linux GTK window lookup failed: {error}")),
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub fn configure_capsule_window(_app: &AppHandle) {}

#[cfg(target_os = "linux")]
pub(super) fn click_through_linux(window: &tauri::WebviewWindow, ignore: bool) {
    use gtk::prelude::*;
    let capsule = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        match capsule.gtk_window() {
            // Tao 0.35.3 unwraps the GdkWindow in CursorIgnoreEvents. A capsule
            // suppressed before its first map has no such window yet. Hidden
            // but realized windows still need the restore of their input region.
            Ok(native) if native.window().is_some() => {
                if let Err(error) = capsule.set_ignore_cursor_events(ignore) {
                    crate::forensic::record("capsule", &format!("Linux click-through failed: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => crate::forensic::record("capsule", &format!("Linux click-through GTK lookup failed: {error}")),
        }
    }) {
        crate::forensic::record("capsule", &format!("Linux click-through dispatch failed: {error}"));
    }
}

#[cfg(target_os = "linux")]
pub(super) fn surface_linux(window: &tauri::WebviewWindow, user_gesture: bool) {
    use gtk::prelude::*;
    use tauri::Manager;
    use std::sync::atomic::{AtomicBool, Ordering};
    static REPORTED: AtomicBool = AtomicBool::new(false);
    let suppression = match LINUX_AMBIENT_POLICY.get() {
        Some(Ok(())) => None,
        Some(Err(reason)) => Some(reason.as_str()),
        None => Some("native capsule configuration unavailable"),
    };
    if let Some(reason) = suppression {
        if !REPORTED.swap(true, Ordering::Relaxed) {
            crate::forensic::record("capsule", &format!("Linux ambient capsule suppressed: {reason}; main window remains available"));
        }
        if user_gesture {
            let app = window.app_handle().clone();
            let dispatch = app.clone();
            if let Err(error) = dispatch.run_on_main_thread(move || {
                super::show_main_window(&app);
                let parent = app.get_webview_window(super::MAIN)
                    .and_then(|window| window.gtk_window().ok());
                let message = crate::ui_i18n::text(crate::ui_i18n::current(),
                    crate::ui_i18n::Msg::LinuxCapsuleUnavailable);
                let dialog = gtk::MessageDialog::new(parent.as_ref(), gtk::DialogFlags::DESTROY_WITH_PARENT,
                    gtk::MessageType::Info, gtk::ButtonsType::Close, message);
                dialog.connect_response(|dialog, _| dialog.close());
                dialog.show();
            }) {
                crate::forensic::record("capsule", &format!("Linux fallback dispatch failed: {error}"));
            }
        }
        return;
    }
    // Ambient UI is permitted only while an external X11 target is verified.
    // An explicit tray gesture may show even with no external target.
    if !user_gesture && crate::focus::current_foreground_target().is_none() {
        return;
    }
    // GTK keeps the configured accept-focus/focus-on-map hints while mapping.
    // The capsule remains nonfocusable even when summoned from the tray.
    if let Err(error) = window.show() {
        crate::forensic::record("capsule", &format!("Linux surface failed user_gesture={user_gesture}: {error}"));
    }
}

#[cfg(test)]
mod tests {
    /// The fix is ONE LINE inside a function no test can run: it needs a real
    /// AppHandle, a real capsule window and a real HWND. So this pins the line
    /// itself, the same way the Vue side pins a control that renders but calls
    /// nothing. It is a weak instrument and it is the only one there is — what it
    /// can catch is the tidy-up that deletes the call or reorders it, which would
    /// fail SILENTLY (the bits look right at setup and vanish at the first
    /// injection, hours later, with nothing in the log but `capsule_watch`).
    ///
    /// 🔴 THE NEEDLE IS ASSEMBLED AT RUNTIME, AND THAT IS THE WHOLE POINT.
    /// The first draft of these two tests searched for the plain name
    /// `set_focusable(false)` — a string this file ALSO contains in the header
    /// that explains the fix, in the failure message, and (had it been a literal)
    /// in the tests themselves. `contains` was therefore satisfied by a COMMENT,
    /// `find` returned the header's offset, and the ordering test could not fail:
    /// a reverse control that genuinely moved the call below the manual OR left
    /// both tests green. 先核你的尺子 ("check your ruler first") — the ruler was
    /// measuring the documentation. Splitting the name means the needle cannot
    /// match prose and cannot match itself.
    const SRC: &str = include_str!("capsule_style.rs");

    fn windows_configuration() -> &'static str {
        // The Linux window.set_focusable call ends with the same substring.
        // Restrict this Win32 regression check to its actual function body.
        SRC.split("pub fn configure_capsule_window(app: &AppHandle)").nth(1).expect("Windows configure body")
    }

    fn call_site() -> String {
        format!("w.set_{}(false)", "focusable")
    }

    #[test]
    fn tao_is_handed_the_non_activating_bit_rather_than_us_repainting_it() {
        assert_eq!(
            windows_configuration().matches(&call_site()).count(),
            1,
            "exactly one CALL (not a mention): without it, tao regenerates an ex-style with no \
             WS_EX_NOACTIVATE on every window-flag change and the capsule steals foreground on click",
        );
    }

    #[test]
    fn it_is_handed_over_before_we_touch_the_ex_style_ourselves() {
        // `set_focusable` is ITSELF a flag change, so it rewrites the ex-style.
        // After the manual OR it would wipe what the OR just wrote; before it, the
        // OR runs last and the read-back reports the truth.
        let hand_over = windows_configuration().find(&call_site()).expect("guarded by the test above");
        let manual_or = windows_configuration()
            .find("SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want)")
            .expect("control: the manual OR must still be here, or this ordering test is vacuous");
        assert!(
            hand_over < manual_or,
            "the hand-over must come FIRST — it rewrites the ex-style from tao's flags",
        );
    }
}

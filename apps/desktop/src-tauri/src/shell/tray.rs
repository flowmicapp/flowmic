// VERBATIM MOVE out of shell/mod.rs (800-line cap) — the tray section
// (07 §7: the only quit path; show main / show capsule / quit), unchanged
// body-for-body. `setup_tray` is re-exported from `shell::mod` (`pub use
// tray::setup_tray;`) so `lib.rs`'s `shell::setup_tray(app.handle())?` call
// site needed no edit. Nothing here touches the WS_EX_NOACTIVATE /
// WS_EX_TOOLWINDOW window-flag family (`configure_capsule_window` /
// `surface_capsule_native`) — that stayed in mod.rs untouched, per this
// card's own instruction.

use serde_json::Value;
use tauri::AppHandle;

use super::{show_main_window, tray_summon_capsule};

// ── tray (07 §7: the only quit path; show main / show capsule / quit) ────────

/// Status-dot colors (redesign §5.5: gray=disconnected / green=idle / red=recording).
const TRAY_DOT_DISCONNECTED: [u8; 4] = [148, 163, 184, 255];
const TRAY_DOT_IDLE: [u8; 4] = [34, 197, 94, 255];
const TRAY_DOT_RECORDING: [u8; 4] = [220, 38, 38, 255];

/// Brand palette for the tray mark — the INVERSE variant (BRAND.md: light
/// strokes + indigo phone), because the Windows tray sits on a dark bar where
/// the standard near-black strokes would vanish.
const TRAY_PHONE: [u8; 4] = [129, 140, 248, 255]; // #818CF8
const TRAY_STROKE: [u8; 4] = [250, 250, 250, 255]; // #FAFAFA

/// Build a 32×32 tray icon in-memory: the FLOWMIC MARK (micro tier — phone
/// silhouette + mic-stand arc, per BRAND.md §1.1 "never scale `full` down to
/// 16px") + the corner status dot.
///
/// GA-34 / owner 2026-07-26 ⑥: this used to be a plain teal disc — a placeholder
/// wearing the product's tray slot. The mark is rasterized by hand from the
/// micro-tier geometry (svg/flowmic-mark-micro.svg, 280-viewBox scaled to 32) so
/// no image-decoding crate enters the audited shell. The status dot STAYS: the
/// tray is the product's one always-visible status surface (redesign §5.4), and
/// the brand does not get to erase the state it exists to show.
fn make_tray_icon(dot: [u8; 4]) -> tauri::image::Image<'static> {
    const W: u32 = 32;
    const H: u32 = 32;
    let mut rgba = vec![0u8; (W * H * 4) as usize];
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            let fx = x as f32;
            let fy = y as f32;

            // Phone body (micro svg rect x92 y20 w96 h156 → ×32/280).
            if (10.5..=21.5).contains(&fx) && (2.3..=20.1).contains(&fy) {
                rgba[i..i + 4].copy_from_slice(&TRAY_PHONE);
            }
            // Mic-stand arc: the micro svg's two quadratics approximate the
            // lower half of a circle centred (16, 16), r≈9.6. Band = stroke.
            let ax = fx - 15.7;
            let ay = fy - 16.0;
            let dist = (ax * ax + ay * ay).sqrt();
            if fy >= 16.0 && (dist - 9.4).abs() <= 1.1 {
                rgba[i..i + 4].copy_from_slice(&TRAY_STROKE);
            }
            // Stand column + base plate.
            if (15.0..=16.9).contains(&fx) && (25.2..=29.7).contains(&fy) {
                rgba[i..i + 4].copy_from_slice(&TRAY_STROKE);
            }
            if (12.3..=19.7).contains(&fx) && (29.4..=31.0).contains(&fy) {
                rgba[i..i + 4].copy_from_slice(&TRAY_STROKE);
            }
            // Corner status dot (with a thin dark ring so it reads anywhere).
            let ddx = fx - 24.5;
            let ddy = fy - 24.5;
            let r2 = ddx * ddx + ddy * ddy;
            if r2 <= 7.0 * 7.0 {
                if r2 <= 5.2 * 5.2 {
                    rgba[i..i + 4].copy_from_slice(&dot);
                } else {
                    rgba[i..i + 4].copy_from_slice(&[15, 23, 42, 255]);
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, W, H)
}

/// owner 2026-07-27:「PC端的托盘退出…要二次确认」("Quitting from the PC-side tray...
/// needs a double confirmation").
///
/// The tray is the ONLY quit path (07 §7), and it sat one click away from
/// killing the sidecar out from under a phone mid-utterance — right next to
/// 「显示胶囊」("Show Capsule") in a small menu. It asks now.
///
/// Win32 MessageBoxW rather than a dialog plugin: the `windows` crate is already
/// a dependency, and this needs to work before/without a webview. It is modal by
/// design — quitting should wait for an answer — and MB_TOPMOST because the tray
/// menu closes on click and an unparented prompt can otherwise open behind
/// whatever the user is actually looking at.
///
/// U6: the strings come from the ui_i18n table in the CURRENT locale, read at
/// click time — so the dialog follows a locale switch immediately (it is built
/// per invocation, unlike the menu items). `w!` (compile-time wide literals)
/// had to go with the hardcoded Chinese; the runtime UTF-16 buffers live on the
/// stack for the duration of the modal call.
#[cfg(windows)]
fn confirm_quit() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    use crate::ui_i18n::{tr, Msg};
    let body: Vec<u16> = tr(Msg::QuitConfirmBody).encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = tr(Msg::QuitConfirmTitle).encode_utf16().chain(std::iter::once(0)).collect();
    let answer = unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    answer == IDYES
}

/// Non-Windows builds have no `MessageBoxW`, so quitting proceeds unconfirmed.
///
/// 🔴 This branch IS reached on macOS. The claim it used to carry — "there is no
/// tray there either, so this branch is never reached in practice" — was true only
/// while macOS was an unbuilt target, and it went false silently: `setup_tray` is
/// called unconditionally from `lib.rs` (`shell::setup_tray(app.handle())?`, no
/// `cfg`), the `tray-icon` feature in Cargo.toml is not platform-gated, and the
/// "quit" arm below calls `confirm_quit()` for every platform. So on macOS the
/// tray's Quit exits immediately, which can kill a sidecar that is mid-session
/// with a phone — exactly what the Windows dialog exists to prevent.
///
/// Registered as a product-visible degradation, not a bug to be quietly patched:
/// `docs/rebuild/07-DESKTOP-SPEC.md` §13 MAC-D2. Closing it needs a confirm UI
/// that does not depend on `MessageBoxW`, verified on a real Mac — a code task
/// with its own card, not a one-line default flip here. Returning `false` instead
/// would be worse than the current gap: the tray's Quit would silently do nothing.
#[cfg(not(windows))]
fn confirm_quit() -> bool {
    true
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};
    use tauri::Listener;

    use crate::ui_i18n::{tr, Msg};

    // U6: all four items read the ui_i18n table in the CURRENT locale (loaded
    // from disk in run() before this builds) — and are re-rendered in place by
    // the UI_LOCALE_CHANGED listener below when the user switches language.
    let show_main_i =
        MenuItem::with_id(app, "show_main", tr(Msg::TrayShowMain), true, None::<&str>)?;
    let show_capsule_i =
        MenuItem::with_id(app, "show_capsule", tr(Msg::TrayShowCapsule), true, None::<&str>)?;
    // P7 (0.3.1) — the offline toggle (owner: 「托盘菜单…增加开关」). A plain
    // MenuItem whose LABEL flips between the two verbs, not a CheckMenuItem:
    // label-swap is this file's proven live-update idiom (the locale listener
    // below), and the verb form (「下线…」/「上线…」) says what a click DOES,
    // which a checkmark on a noun would leave ambiguous.
    let offline_i =
        MenuItem::with_id(app, "offline_toggle", tr(Msg::TrayGoOffline), true, None::<&str>)?;
    // Disabled status row (redesign §5.4). Text is live-updated from the same
    // pump TRAY_STATE payload that drives tooltip + icon — never a second source.
    let status_i =
        MenuItem::with_id(app, "status", tr(Msg::TrayStatusDisconnected), false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", tr(Msg::TrayQuit), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_main_i, &show_capsule_i, &offline_i, &sep1, &status_i, &sep2, &quit_i],
    )?;

    // Three-state icons (disconnected/idle/recording). Prebuilt once; set_icon only on state change.
    let icon_disconnected = make_tray_icon(TRAY_DOT_DISCONNECTED);
    let icon_idle = make_tray_icon(TRAY_DOT_IDLE);
    let icon_recording = make_tray_icon(TRAY_DOT_RECORDING);

    let tray = TrayIconBuilder::new()
        .tooltip(tr(Msg::TrayTooltipDisconnected))
        .icon(icon_disconnected.clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_main" => show_main_window(app),
            // R6-C2: summon (surface + FSM re-sync to persistent), not a bare surface.
            "show_capsule" => tray_summon_capsule(app),
            // P7 — toggle from the CURRENT state; `apply` is the same single
            // write path the devices-page switch invokes, so the two
            // entrances cannot disagree about what a click means.
            "offline_toggle" => {
                use tauri::Manager;
                let enable = !app
                    .state::<super::offline::OfflineState>()
                    .is_offline();
                let _ = super::offline::apply(app, enable);
            }
            // Match guard keeps the confirm dialog as the only gate before exit;
            // false → fall through to `_` (same as the previous nested `if`).
            //
            // 🔴 DECLARE BEFORE EXITING, never after: `app.exit` may not return
            // here, and `RunEvent::Exit` reads the declaration to write the one
            // line that says HOW this process ended. An undeclared quit is
            // reported as `undeclared`, i.e. indistinguishable from a taskkill.
            "quit" if confirm_quit() => {
                crate::exit_reason::declare(crate::exit_reason::ExitPath::TrayQuit);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Double-click → the MAIN window (owner 2026-07-27). It used to summon
            // the capsule, which since the phone-presence gate is a no-op whenever
            // no phone is on the active instance — a double-click that did nothing
            // at all, on the product's one always-visible surface. The capsule
            // still has its own menu row (「显示胶囊」, "Show Capsule"), and that is the gesture that
            // should be gated; the default one now always shows something.
            if let TrayIconEvent::DoubleClick { .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // U6 — re-render the tray in place on a locale switch. The three action
    // items are static text and repaint HERE, immediately; the status row +
    // tooltip belong to the pump ("never a second source" above), which
    // repaints them on its next ≤500 ms tick because `ui_locale_set` cleared
    // the change-only memo. The one exception: when NO pump has ever forwarded
    // (`tray_showing_snapshot()` is None — e.g. sidecar bring-up failed and no
    // cloud session exists), the tray still shows its boot strings, which are
    // by construction the disconnected pair — so repaint those directly rather
    // than wait for a tick that may never come.
    {
        let show_main_c = show_main_i.clone();
        let show_capsule_c = show_capsule_i.clone();
        let quit_c = quit_i.clone();
        let status_c = status_i.clone();
        let tray_c = tray.clone();
        let offline_c = offline_i.clone();
        let app_c = app.clone();
        app.listen(crate::socket::bridge::channel::UI_LOCALE_CHANGED, move |_event| {
            use tauri::Manager;
            let _ = show_main_c.set_text(tr(Msg::TrayShowMain));
            let _ = show_capsule_c.set_text(tr(Msg::TrayShowCapsule));
            let _ = quit_c.set_text(tr(Msg::TrayQuit));
            // P7 — the toggle's label depends on the current state, so the
            // locale re-render reads it rather than assuming the boot value.
            let offline_now = app_c
                .state::<super::offline::OfflineState>()
                .is_offline();
            let _ = offline_c.set_text(tr(if offline_now {
                Msg::TrayGoOnline
            } else {
                Msg::TrayGoOffline
            }));
            if crate::socket::pump::tray_showing_snapshot().is_none() {
                let _ = status_c.set_text(tr(Msg::TrayStatusDisconnected));
                let _ = tray_c.set_tooltip(Some(tr(Msg::TrayTooltipDisconnected)));
            }
        });
    }

    // P7 — flip the toggle's label when the switch flips, whichever entrance
    // flipped it (tray click or the devices-page switch — one write path,
    // shell::offline::apply, is the only emitter).
    {
        let offline_c = offline_i.clone();
        app.listen(crate::socket::bridge::channel::OFFLINE_STATE, move |event| {
            if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                if let Some(off) = v.get("offline").and_then(Value::as_bool) {
                    let _ = offline_c.set_text(tr(if off {
                        Msg::TrayGoOnline
                    } else {
                        Msg::TrayGoOffline
                    }));
                }
            }
        });
    }

    // Pump forwards TRAY_STATE only when tooltip text changes (only-on-change).
    // Icon further gates on `state` so a mobiles-count tick does not re-set_icon.
    // listen's closure is Fn (not FnMut) → Mutex for the last-seen state id.
    let last_icon_state = std::sync::Mutex::new(String::from("disconnected"));
    app.listen(crate::socket::bridge::channel::TRAY_STATE, move |event| {
        if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
            if let Some(tip) = v.get("tooltip").and_then(Value::as_str) {
                let _ = tray.set_tooltip(Some(tip));
            }
            if let Some(status) = v.get("status").and_then(Value::as_str) {
                let _ = status_i.set_text(status);
            }
            if let Some(state) = v.get("state").and_then(Value::as_str) {
                let mut prev = match last_icon_state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if state != prev.as_str() {
                    let icon = match state {
                        "recording" => &icon_recording,
                        "connected-idle" => &icon_idle,
                        _ => &icon_disconnected,
                    };
                    let _ = tray.set_icon(Some(icon.clone()));
                    *prev = state.to_string();
                }
            }
        }
    });
    Ok(())
}

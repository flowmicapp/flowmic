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
/// Stream-teal shoulder ticks (brand 2.0, owner 2026-08-21: the flank waves
/// moved to the phone's shoulders; every icon surface keeps a teal wave now,
/// the tray included).
const TRAY_WAVE: [u8; 4] = [45, 212, 191, 255]; // #2DD4BF
/// Core-ink rounded plate behind the mark (brand 1.2.0, owner 2026-08-21: every
/// icon surface carries a dark ground so the mark stops floating). Same plate
/// family as icons/icon.ico — the tray must not stay the one plateless holdout.
const TRAY_PLATE: [u8; 4] = [11, 16, 32, 255]; // #0B1020

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
    /// 3x3 supersampling: Windows shows the tray icon at ~16-20px, so a
    /// hard-edged 32px raster arrives on screen twice-degraded (our jaggies,
    /// then the shell's downscale). Owner 2026-08-21 flagged exactly this
    /// surface as muddy; coverage-averaged edges survive the downscale.
    const SS: u32 = 3;

    /// Signed-distance rounded-rect membership (cx/cy center, hw/hh half
    /// extents, r corner radius).
    fn in_rrect(fx: f32, fy: f32, cx: f32, cy: f32, hw: f32, hh: f32, r: f32) -> bool {
        let px = (fx - cx).abs() - (hw - r);
        let py = (fy - cy).abs() - (hh - r);
        let qx = px.max(0.0);
        let qy = py.max(0.0);
        qx * qx + qy * qy <= r * r
    }

    /// Topmost-wins color of one subsample, painter's layers inverted:
    /// status badge > stand > phone > plate > transparent.
    ///
    /// The mark is centered at (15, ~15) — one grid step up-left — so the
    /// corner status badge at (25.8, 25.8) clears the cradle's right arm and
    /// the base plate entirely (verified geometrically: min distance from
    /// either stroke to the badge center exceeds the 5.5 ring radius). The
    /// first plate cut had the badge at r6.4 over a centered mark and it ate
    /// the whole lower-right quarter of the cradle.
    fn sample(fx: f32, fy: f32, dot: [u8; 4]) -> [u8; 4] {
        // Corner status badge (ink ring so it reads on any state color).
        let ddx = fx - 25.8;
        let ddy = fy - 25.8;
        let d2 = ddx * ddx + ddy * ddy;
        if d2 <= 4.3 * 4.3 {
            return dot;
        }
        if d2 <= 5.5 * 5.5 {
            return [15, 23, 42, 255];
        }
        // Brand 2.0 shoulder ticks: ~70-degree ring segments off the phone's
        // top corners, aimed up-and-out (same sweep as the NANO frames'
        // 190..260-degree arcs; geometry mirrored in logo-tools/tray-preview.mjs
        // - update together, and run that preview before editing this).
        let lx = fx - 9.2;
        let ly = fy - 4.4;
        let ld = (lx * lx + ly * ly).sqrt();
        let la = ly.atan2(lx);
        if (ld - 3.0).abs() <= 0.75 && la > -2.967 && la < -1.745 {
            return TRAY_WAVE;
        }
        let rx = fx - 20.8;
        let ry = fy - 4.4;
        let rd = (rx * rx + ry * ry).sqrt();
        let ra = ry.atan2(rx);
        if (rd - 3.0).abs() <= 0.75 && ra > -1.396 && ra < -0.175 {
            return TRAY_WAVE;
        }
        // Mic cradle: lower half-circle around (15, 15.4), r 8.8, stroke 3.
        let ax = fx - 15.0;
        let ay = fy - 15.4;
        let dist = (ax * ax + ay * ay).sqrt();
        if fy >= 15.4 && (dist - 8.8).abs() <= 1.5 {
            return TRAY_STROKE;
        }
        // Stand column + base plate.
        if in_rrect(fx, fy, 15.0, 25.9, 1.1, 1.5, 0.4) {
            return TRAY_STROKE;
        }
        if in_rrect(fx, fy, 15.0, 27.9, 5.2, 1.0, 0.9) {
            return TRAY_STROKE;
        }
        // Phone body, rounded like the mark's rx20/96 ratio.
        if in_rrect(fx, fy, 15.0, 10.8, 5.4, 8.2, 2.6) {
            return TRAY_PHONE;
        }
        // Rounded ink plate, 17.5% corner radius (same family as icon.ico).
        if in_rrect(fx, fy, 16.0, 16.0, 16.0, 16.0, 5.6) {
            return TRAY_PLATE;
        }
        [0, 0, 0, 0]
    }

    let mut rgba = vec![0u8; (W * H * 4) as usize];
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            // Average SS*SS subsamples, alpha-weighted so transparent corner
            // subsamples do not drag edge colors toward black.
            let (mut r_acc, mut g_acc, mut b_acc, mut a_acc) = (0f32, 0f32, 0f32, 0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let fx = x as f32 + (sx as f32 + 0.5) / SS as f32;
                    let fy = y as f32 + (sy as f32 + 0.5) / SS as f32;
                    let c = sample(fx, fy, dot);
                    let a = c[3] as f32 / 255.0;
                    r_acc += c[0] as f32 * a;
                    g_acc += c[1] as f32 * a;
                    b_acc += c[2] as f32 * a;
                    a_acc += a;
                }
            }
            let n = (SS * SS) as f32;
            if a_acc > 0.0 {
                rgba[i] = (r_acc / a_acc).round() as u8;
                rgba[i + 1] = (g_acc / a_acc).round() as u8;
                rgba[i + 2] = (b_acc / a_acc).round() as u8;
                rgba[i + 3] = (a_acc / n * 255.0).round() as u8;
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

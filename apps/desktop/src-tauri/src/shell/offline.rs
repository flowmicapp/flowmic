// P7 (0.3.1) — the manual 「下线」 (go-offline) switch.
//
// owner 2026-08-15: 「为PC端增加1个下线的手动激活的功能，这是为了主动断开与所有
// 手机端的连接，减少干扰，托盘菜单和设备主页面顶部右上角增加开关」("give the PC a
// manually-activated offline function — actively disconnect from every phone to
// cut interference; a switch in the tray menu and at the top right of the
// devices page").
//
// Design (docs/strategy/2026-08-15-031-fix-batch-design.md §9):
//   · Going offline = drop BOTH channel sessions and refuse every redial while
//     the flag is up. Phones keep their own sockets to the relay/sidecar and
//     see this PC exactly as they see a powered-off one (existing presence
//     semantics) — zero protocol change, zero server change, zero new error
//     code. Their outboxes hold messages as 待投递 and drain on the next room
//     join, which is the F-1 machinery working as designed.
//   · Going online = clear the flag, redial both channels; phones reconnect by
//     themselves.
//   · NOT persisted on purpose: a PC that stays silently offline across a
//     restart is a support black hole (the switch is visible in two places,
//     but nobody re-reads a switch to explain a phone that 「just won't
//     connect」). A restart is online, like power cycling any appliance.
//
// ⚠️ THE PUMP DIES WITH THE SOCKETS. TRAY_STATE and CONNECTION are emitted only
// by each session's pump thread, and `disconnect()` joins it — so after the
// teardown NOTHING will repaint the tray or the page, and both would freeze on
// their last (connected!) words. The offline path therefore speaks for itself:
// it emits its own TRAY_STATE, its own OFFLINE_STATE (the store marks both
// channel rows disconnected off it), and clears the pump's change-only tray
// memo so the first tick after coming back online repaints even if the new
// tooltip equals the pre-offline one.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::forensic;
use crate::socket::channel::Channel;
use crate::ui_i18n::{tr, Msg};

/// The one writer-guarded fact: 「is this PC manually offline right now」.
/// Session-scoped (never persisted — see the module header).
pub struct OfflineState(AtomicBool);

impl OfflineState {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn is_offline(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn set(&self, v: bool) {
        self.0.store(v, Ordering::SeqCst);
    }
}

impl Default for OfflineState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Clone, Copy)]
pub struct OfflineDto {
    pub offline: bool,
}

/// Read the current state — the devices-page switch seeds itself from this
/// (register-then-pull, the RV-24 rule the store already follows).
#[tauri::command]
pub fn offline_state(state: State<OfflineState>) -> OfflineDto {
    OfflineDto { offline: state.is_offline() }
}

/// Flip the switch. The single write path, used by BOTH entrances (this
/// command from the devices page, and the tray menu item via [apply]).
#[tauri::command]
pub fn offline_set(app: AppHandle, enable: bool) -> OfflineDto {
    apply(&app, enable)
}

/// The shared toggle body. Idempotent: re-applying the current state only
/// re-emits it (harmless), it never re-tears or re-dials.
pub fn apply(app: &AppHandle, enable: bool) -> OfflineDto {
    let state: State<OfflineState> = app.state();
    let was = state.is_offline();
    // Flag FIRST on the way down: `connect_on_main` reads it, so any dial
    // racing in from a supervisor/worker thread between here and the teardown
    // below is already refused.
    state.set(enable);
    forensic::record(
        "offline",
        &format!("manual offline switch: {was} -> {enable}"),
    );
    if enable && !was {
        // Drop both sessions. Dropping a DesktopSocket disconnects it and
        // joins its pump; the phones' own presence semantics take it from
        // there (they see this PC leave the room — same as a shutdown).
        super::channel_session::set_socket(app, Channel::Lan, None);
        super::channel_session::set_socket(app, Channel::Cloud, None);
        // The pumps are gone — repaint the tray ourselves (see module header),
        // and clear the change-only memo so the post-online repaint cannot be
        // swallowed by 「tooltip unchanged」.
        crate::socket::pump::tray_showing_reset();
        let _ = app.emit(
            crate::socket::bridge::channel::TRAY_STATE,
            json!({
                "state": "disconnected",
                "tooltip": tr(Msg::TrayTooltipOffline),
                "status": tr(Msg::TrayStatusOffline),
            }),
        );
    } else if !enable && was {
        crate::socket::pump::tray_showing_reset();
        // Redial both channels; their pumps take tray + connection state back
        // over from their first tick.
        super::sidecar_ctl::ensure_dialed(app, Channel::Lan);
        super::sidecar_ctl::ensure_dialed(app, Channel::Cloud);
    }
    let dto = OfflineDto { offline: state.is_offline() };
    let _ = app.emit(
        crate::socket::bridge::channel::OFFLINE_STATE,
        json!({ "offline": dto.offline }),
    );
    dto
}

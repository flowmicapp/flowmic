// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §1 (dual-window: bordered main + transparent
//     capsule), §4 (capsule surface is NON-ACTIVATING — SW_SHOWNOACTIVATE +
//     SetWindowPos(SWP_NOACTIVATE); only a user gesture set_focus; F-2344),
//     §7 (tray is the only quit path; close→hide to tray)
//   docs/rebuild/13-LESSONS-LEARNED.md §1 W1/W2 (occlusion arg already in
//     tauri.conf; never activate on ambient surface)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-2 (ruling 1: capsule created
//     focus:false + WS_EX_NOACTIVATE semantics; just_injected click-through)
//
// The Tauri window shell — built only under the `app` feature so the audited
// socket/inject/focus core stays tauri-free for `cargo test`. Holds the outbound
// settings/history commands (thin wrappers over DesktopSocket verbs), the capsule
// window lifecycle commands, the non-activating surface (the F-2344 anti-focus-
// steal path), and the tray (only quit path). The transparent-HUD occlusion arg
// is env-level in tauri.conf (`additionalBrowserArgs … CalculateNativeWinOcclusion`)
// and shared by both windows — nothing to configure here.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;

use crate::socket::DesktopSocket;

/// The sidecar (self-hosted server) control layer — bring-up, retry, LAN-IP poll,
/// and the managed SidecarState the pairing endpoint reads (WP-R2-4).
pub mod sidecar_ctl;
mod marshal_fallback;
/// V2-10 boot autostart — real-state, read-back-verified, fail-loud; see module header.
pub mod autostart;
// P7 (0.3.1) — the manual go-offline switch (tray + devices page).
pub mod offline;
/// U6 — the `ui_locale_set` command: the frontend mirrors its persisted UI
/// locale here so the Rust surface (tray / exit dialog / autostart errors)
/// speaks the app language; see module header for the full bridge shape.
pub mod locale_sync;
/// V2-19 capsule copy button — a native OS clipboard write, structurally
/// immune to WebView2's document-focus requirement (see module header). Does
/// NOT touch the injection path's snapshot/restore logic, only calls its
/// pure one-shot write primitives (`write_clipboard_formats` on Windows,
/// `pasteboard::write_text` on macOS — B3, platform-neutral entry).
pub mod clipboard_copy;
/// REQ-12-15 capsule drag — the drag itself is handed to the OS move loop
/// (`start_dragging`) instead of being reconstructed from pointer deltas one
/// IPC round trip per frame; see module header for what was measured and for
/// why this is still non-activating.
pub mod capsule_drag;
/// REQ-13-16 forensic instrument — watches for the capsule's HWND being
/// RECREATED without `configure_capsule_window` re-running. Windows-only from
/// the `mod` line down (a not-windows stub would be non-Windows code that no
/// gate here can prove); zero behaviour change, no thread. See the
/// module header for why this replaced the bit-change monitor R8 §2-1 designed.
#[cfg(windows)]
pub mod capsule_watch;

/// The cloud-relay channel (R6 T-2) — the managed CloudState (endpoint + Cloud
/// Key, DPAPI at rest), the device-page commands, and the fail-loud teardown when
/// the relay refuses the key. *** HUMAN-AUDIT SENSITIVE (pairing/auth) ***
pub mod cloud;

/// Managed state: the TWO resident socket sessions (07 §6 both channels resident) plus the
/// shared capsule-ownership latch that decides which of them is primary.
///
/// GA-28 replaced a single `Option<DesktopSocket>` here. That single slot was the
/// mechanical reason the desktop could only ever hold one channel: switching meant
/// dropping the live session and rebuilding, which is precisely the 「switching
/// channel tears down
/// the endpoint it already occupies」 F-2363 hazard 07 §6 warns about. Both slots now stay filled;
/// only the ROLE moves, and it moves without touching either connection.
pub struct Sessions {
    pub lan: Option<DesktopSocket>,
    pub cloud: Option<DesktopSocket>,
    /// Shared with both sessions' handlers (Arc) — see socket::admission.
    pub admission: std::sync::Arc<crate::socket::Admission>,
}

impl Sessions {
    pub fn new(preferred: crate::socket::Channel) -> Self {
        Self {
            lan: None,
            cloud: None,
            admission: std::sync::Arc::new(crate::socket::Admission::new(preferred)),
        }
    }

    pub fn slot(&self, channel: crate::socket::Channel) -> Option<&DesktopSocket> {
        match channel {
            crate::socket::Channel::Lan => self.lan.as_ref(),
            crate::socket::Channel::Cloud => self.cloud.as_ref(),
        }
    }

    /// The session that carries the outbound verbs (settings / history / pairing).
    ///
    /// Primary first — that is where the timeline and settings the user is looking
    /// at actually live. If the primary channel has no live socket the OTHER one is
    /// used, because a live connection is strictly better than reporting failure
    /// while a working channel sits right there; `None` only when BOTH are down,
    /// which is the honest 「not connected」 the frontend already renders.
    pub fn primary(&self) -> Option<&DesktopSocket> {
        crate::socket::admission::fallback_order(self.admission.primary())
            .into_iter()
            .find_map(|c| self.slot(c))
    }
}

pub type SocketState = std::sync::Mutex<Sessions>;

const CAPSULE: &str = "capsule";
const MAIN: &str = "main";

/// owner 2026-07-26 ⑤ — the desktop settings page configures the LOCAL
/// (self-hosted) server and nothing else; the cloud relay's STT routing and
/// model live in the web console. Before this, the settings verbs followed the
/// PRIMARY channel (GA-28), so with a phone on the relay a dictionary edit
/// would quietly land on the cloud server — the settings UI would then be lying
/// about which machine it configures. Pinned to the LAN slot: when the local
/// service is down the edit holds pending (「stored locally」), exactly like any other
/// wire failure — never silently rerouted to a different server.
fn with_lan_socket<R>(state: &State<'_, SocketState>, f: impl FnOnce(&DesktopSocket) -> R, fallback: R) -> R {
    match state.lock() {
        Ok(guard) => match guard.slot(crate::socket::Channel::Lan) {
            Some(sock) => f(sock),
            None => fallback,
        },
        Err(_) => fallback,
    }
}

pub(crate) fn with_socket<R>(state: &State<'_, SocketState>, f: impl FnOnce(&DesktopSocket) -> R, fallback: R) -> R {
    match state.lock() {
        Ok(guard) => match guard.primary() {
            Some(sock) => f(sock),
            None => fallback,
        },
        Err(_) => fallback,
    }
}

/// RV-27 — the session on ONE named channel, with NO fallback to the other.
///
/// `with_socket` falls back to the other slot (a live connection beats reporting
/// failure), which is right for the timeline/settings verbs: either server can carry
/// them. It is wrong for PAIRING. A pairing code only means anything on the server
/// that minted it, so borrowing the other channel's code is not a fallback — it is a
/// wrong answer the phone will act on and fail with `PAIR_INVALID_CODE`. No session
/// on that channel ⇒ no code, which the modal already renders as 「refresh」/loud failure.
pub(crate) fn with_channel_socket<R>(
    state: &State<'_, SocketState>,
    channel: crate::socket::Channel,
    f: impl FnOnce(&DesktopSocket) -> R,
    fallback: R,
) -> R {
    match state.lock() {
        Ok(guard) => match guard.slot(channel) {
            Some(sock) => f(sock),
            None => fallback,
        },
        Err(_) => fallback,
    }
}

/// RV-新B — 「which channel is current right now」, the ONE Rust-side answer.
///
/// It is `Admission::primary()`: the channel of whichever phone was admitted, else the
/// channel a handshake roster puts a phone on (RV-新C), else the process default. It
/// replaced `cloud::CloudState::active_channel()`, which read a persisted flag that
/// owner's 2026-07-30 ruling ② had left with no writer — so it answered `lan` forever and the
/// pairing modal opened on the wrong tab for a pure-cloud user.
///
/// Takes the lock and releases it before returning, because every caller goes on to
/// `with_channel_socket`, which locks the same non-reentrant mutex.
pub(crate) fn current_channel(state: &State<'_, SocketState>) -> crate::socket::Channel {
    match state.lock() {
        Ok(guard) => guard.admission.primary(),
        // A poisoned lock still holds a usable latch — read it rather than invent a
        // channel, which is the whole class of defect this function replaces.
        Err(p) => p.into_inner().admission.primary(),
    }
}

// ── outbound settings / history verbs (main window → server) ─────────────────

/// Change-immediately-persist-immediately settings write (07 §8). Returns whether the frame reached the wire;
/// `false` → the frontend holds it pending and re-flushes on reconnect.
///
/// `stamp` is the frontend's `updated_at` — WHEN THE USER MADE THE EDIT (04 §3.7-a,
/// card C3), minted in `apps/desktop/src/lib/settings-client.ts` and persisted with
/// the durable queue, so a replayed offline edit carries its own moment rather than
/// the reconnect's. Passed through untouched and omitted from the frame when
/// `None`: absent means UNKNOWN, which is exactly the pre-C3 behaviour.
///
/// ⚠️ The IPC argument is one word on purpose. `apps/desktop/src/lib/bridge.ts`
/// states that this boundary uses single-word argument names so that
/// camelCase↔snake_case never has to be reasoned about; `stamp` honours that,
/// while the WIRE field stays `updated_at`. The two names answer to two layers.
#[tauri::command]
pub fn settings_update(state: State<'_, SocketState>, key: String, value: Value, stamp: Option<String>) -> bool {
    // owner ⑤: settings target the LAN server only — see with_lan_socket.
    with_lan_socket(&state, |s| s.emit_settings_update(&key, value, stamp.as_deref()), false)
}

/// settings:list snapshot pull (WP-R3.5; 07 §8). Unlike history_list this AWAITS
/// the ack and RETURNS the `items` array (`[{key,value}]`) directly, so the
/// frontend can adopt the server-authoritative settings into its local display
/// cache on the connected rising edge. `None` when the socket is down / the ack
/// times out — the frontend then keeps its local cache (never a blank overwrite).
#[tauri::command]
pub fn settings_list(state: State<'_, SocketState>) -> Option<Value> {
    // owner ⑤: hydrate from the LAN server — the one this page configures.
    with_lan_socket(&state, |s| s.fetch_settings_list(std::time::Duration::from_secs(5)), None)
}

/// Deferred re-delivery — the ONE timeline verb that still needs Rust (0.2.27). The other three
/// (list / update / delete) are gone with the server's transcript store: the PC owns
/// its rows, so an edit or a delete is a local write and a refresh has nothing to
/// pull. Re-inject stayed because typing into a window is a native act — but it lost
/// its round trip: the row's owner hands over the TEXT and the local pipeline runs.
/// See that module's header for why it is one command and not a second pipeline.
pub mod reinject;

pub mod naming;
/// The device page's 「paired phones」 read — BOTH channels, tagged (v0.2.1).
pub mod paired;
pub mod timeline_images; // RV-93 opening the full-size picture + eviction drop; socket::row_image owns the rules.

pub mod connection;

/// UP-3b online update: the command surface over `crate::update` — check, download,
/// and the two install chains (portable in-place swap / msiexec). Everything
/// decidable lives in the tauri-free core; this only owns the `AppHandle`.
pub mod update_ctl;

/// The tray (07 §7: the only quit path; show main / show capsule / quit) —
/// moved out verbatim for the 800-line cap. `setup_tray` re-exported below so
/// `lib.rs`'s call site (`shell::setup_tray(...)`) needed no edit.
mod tray;
pub use tray::setup_tray;

/// The per-channel socket SESSION layer — the two `SocketState` slots and the
/// dial that fills them — moved out of `sidecar_ctl.rs` VERBATIM for the same
/// 800-line cap as `tray` above (`verify/lint/file-size.mjs`). That cap was the
/// WHOLE reason; it is not an architectural claim, and no behaviour moved with
/// the code. See that module's header for the seam. `drop_socket` is re-exported
/// by `sidecar_ctl`, so `shell::cloud`'s two call sites are unchanged — the same
/// technique `setup_tray` uses just above.
///
/// ⚠️ Declared HERE, next to the other cap-driven split, rather than beside
/// `sidecar_ctl` at the top of this file: `settings-sync-notice.ts` used to carry
/// a LINE-NUMBER anchor into this file, and inserting six lines above it silently
/// unpinned that anchor in `coordinate-anchors-baseline.mjs` (caught by
/// `verify:lint`, not by review). Adding a module declaration above that point
/// cost someone that rot; adding it below cost nothing.
///
/// 🔴 UPDATE (2026-08-17, card C3): the rot came due a SECOND time anyway — a doc
/// block added above `settings_update` moved it again — so that citation was
/// rewritten to the symbol-only form (`settings_update` / `with_lan_socket`, no
/// number), which the anchors lint cannot see at all. The placement rule above is
/// therefore no longer load-bearing for THAT anchor, and it is kept because the
/// lesson generalises: this file is cited from several places, and the durable
/// repair is to delete the number, not to be careful about where lines go in.
mod channel_session;

/// The phones PAIRED to this PC — the device page's 「paired phones」 table (R6 T-8).
/// Returns the ack's `mobiles` array narrowed to the five public fields
/// (`pairing_id`/`mobile_name`/`paired_at`/`last_seen_at`/`online`), or `None`
/// when the socket is down / the ack timed out / the server refused. The
/// frontend renders that `None` as a loud 「read failed」 — it never degrades to an
/// empty table, which would read as 「no phones paired」 (a lie).
/// GA-08 — end ONE paired phone's access from the device page's 「disconnect | revoke」.
/// `revoke=false` disconnect: the server disconnects the phone and holds a 60 s
/// reconnect-suppression window (the pairing stays valid, the phone comes back
/// by itself). `revoke=true` revoke: the mobile_pairings row is DELETED, so the
/// phone's token is dead and it must be paired again — the frontend asks for a
/// second confirmation before ever sending that.
/// Returns whether the server acked `{ok:true}`; `false` (socket down / timeout /
/// refusal) makes the page say so instead of silently re-rendering the old table.
#[tauri::command]
pub fn release_mobile(
    state: State<'_, SocketState>,
    id: String,
    revoke: bool,
    channel: Option<String>,
) -> bool {
    // v0.2.7 — send it to the channel that OWNS the row.
    //
    // owner 2026-07-29:「PC 端这条无法撤销，提示成功，但仍然还在」 ("this row on
    // the PC side cannot be revoked, it reports success but the row is still
    // there"). This used
    // `with_socket`, i.e. the PRIMARY channel — but the two channels are two
    // servers with two `mobile_pairings` tables, which is exactly why
    // `list_paired_mobiles` was changed in v0.2.1 to ask BOTH and tag every row
    // with its channel. The table has carried that tag ever since; the revoke
    // button never used it. With cloud primary, revoking a local-LAN row asked
    // the relay to delete a pairing it has never heard of.
    //
    // The server then answered `{ok:true, revoked:0}` — well-formed request, no
    // row removed — and the desktop read only `ok`. Two independent defects
    // producing one symptom; both are fixed, because either one alone would
    // still leave a way to claim a deletion that did not happen.
    //
    // `None` (an older frontend, or a row with no tag) falls back to the primary
    // socket — the exact pre-0.2.7 behaviour, never a silent no-op.
    let target = channel.as_deref().and_then(crate::socket::Channel::from_tag);
    let Some(channel) = target else {
        return with_socket(&state, |s| s.release_mobile(&id, revoke, RELEASE_TIMEOUT), false);
    };
    let guard = match state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    match guard.slot(channel) {
        Some(sock) => sock.release_mobile(&id, revoke, RELEASE_TIMEOUT),
        // That channel is not resident, so nobody can carry the request. FALSE,
        // never true — the page must say it failed rather than leave a row the
        // user believes is gone.
        None => false,
    }
}

const RELEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Mint a FRESH 4-digit code via pc:refresh-code (device page refresh button /
/// stale-code recovery). Returns the new code, or `None` if the socket is down /
/// the ack timed out (the frontend surfaces a loud "refresh failed" — never a fake code).
///
/// RV-27 — minted on the channel whose ENDPOINT the modal is showing, not
/// on `primary`. `primary` follows whichever phone owns the capsule (admission.rs)
/// while the endpoint follows the pairing channel selection, so the two diverge
/// the moment a phone is present on the channel the user is not pairing through:
/// the user was handed server A's address and server B's code.
///
/// N5 (owner's requirement ②) — that selection now arrives as `channel`, from the modal's own
/// local-LAN / cloud-relay switch, so 「which server should the phone dial」 is answered by the dialog the
/// user is looking at instead of by a global preference set on another page. Same
/// resolver as `connection::pairing_code` (`connection::resolve_pairing_channel`)
/// so the code and the QR still cannot come from two different servers; omitted /
/// unknown falls back to [`current_channel`] (RV-新B: it used to be the dead
/// `cloud.active_channel()` flag, i.e. always LAN).
///
/// `state` is Tauri-injected managed state.
#[tauri::command]
pub fn refresh_pairing_code(
    state: State<'_, SocketState>,
    channel: Option<String>,
) -> Option<String> {
    let target = connection::resolve_pairing_channel(channel.as_deref(), current_channel(&state));
    with_channel_socket(
        &state,
        target,
        |s| s.refresh_pairing_code(std::time::Duration::from_secs(5)),
        None,
    )
}

// ── capsule window lifecycle (07 §1 sizes / §4 morph + click-through) ────────

/// Resize the capsule to a morph-state size (07 §1 CARD heights 56|120|200|290,
/// each + the 10px `CAPSULE_CHROME` `.wrap`/`.caps` need — added in
/// `windowHeightFor`, so what arrives is the WINDOW height: 560×{66|130|210|300}).
/// RV-81 moved these; passing the CARD height cut the corners off (0.2.31).
#[tauri::command]
pub fn capsule_resize(app: AppHandle, width: f64, height: f64) {
    if let Some(w) = app.get_webview_window(CAPSULE) {
        // REQ-13-16 instrument — read BEFORE the resize. If `set_size` were ever
        // the thing that recreates the window (it is not, on 0.2.62), reading
        // after would attribute the new HWND to whatever touched it next.
        #[cfg(windows)]
        capsule_watch::observe_window(&w, "resize");
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
    }
}

/// Move the capsule to a position WE computed — first-surface caret anchor,
/// top-center default, and the clamped restore of a persisted drag position
/// (07 §4).
///
/// 🔴 SINCE REQ-12-15 THIS IS NOT THE DRAG PATH. Dragging goes through
/// `capsule_drag::capsule_start_drag` (the OS move loop); calling this once per
/// `pointermove` is what made the window trail the cursor. Callers left: the
/// two placement paths above, both one-shot. If you find yourself calling this
/// in a loop, read `shell/capsule_drag.rs`'s header first.
#[tauri::command]
pub fn capsule_move(app: AppHandle, x: f64, y: f64) {
    if let Some(w) = app.get_webview_window(CAPSULE) {
        #[cfg(windows)]
        capsule_watch::observe_window(&w, "move");
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// The caret anchor payload handed to the frontend — LOGICAL px (see the
/// conversion point in `caret_rect`). Field names are snake_case on the wire, the
/// same shape convention as `PairingInfo` / `SidecarStatus`.
#[derive(serde::Serialize)]
pub struct CaretRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
}

/// Foreground caret geometry for the capsule's FIRST-surface anchor (R6 T-1,
/// owner's ruling D1). `None` whenever there is no usable caret (no text field focused,
/// GetGUIThreadInfo refused, empty rect) — the frontend then falls back to
/// top-center. Never fabricates a position.
#[tauri::command]
pub fn caret_rect(app: AppHandle) -> Option<CaretRect> {
    let s = crate::caret::foreground_caret()?;

    // ── PIXEL-UNIT CONVERSION POINT (the ONLY physical→logical hop, T-1 ruling 7) ──
    // Win32 hands back PHYSICAL device px. `capsule_move` takes a
    // `tauri::LogicalPosition`, which Tauri multiplies by the CAPSULE window's
    // current scale factor before calling the OS — so dividing by that SAME factor
    // here makes the anchor round-trip exact, and keeps one single coordinate space
    // (logical) across capsule-position.ts, the persisted drag position and
    // `capsule.move`. Caveat (accepted): on a MIXED-DPI setup where the caret's
    // monitor scales differently from the monitor the capsule currently sits on,
    // this factor is the capsule's, so the anchor can be off by the scale ratio for
    // that one placement; the user's drag then persists and wins forever (D1).
    let scale = app
        .get_webview_window(CAPSULE)
        .and_then(|w| w.scale_factor().ok())
        .filter(|f| *f > 0.0)
        .unwrap_or(1.0);
    let to_logical = |v: i32| f64::from(v) / scale;

    Some(CaretRect {
        x: to_logical(s.x),
        y: to_logical(s.y),
        width: to_logical(s.width),
        height: to_logical(s.height),
        work_x: to_logical(s.work_x),
        work_y: to_logical(s.work_y),
        work_width: to_logical(s.work_width),
        work_height: to_logical(s.work_height),
    })
}

/// Toggle click-through — enabled for the 800 ms just_injected window (07 §4).
#[tauri::command]
pub fn capsule_click_through(app: AppHandle, ignore: bool) {
    if let Some(w) = app.get_webview_window(CAPSULE) {
        #[cfg(windows)]
        capsule_watch::observe_window(&w, "click_through");
        let _ = w.set_ignore_cursor_events(ignore);
    }
}

/// Ambient surface — NON-ACTIVATING (07 §4, F-2344). Never steals the inject
/// target's focus; only the tray user-gesture path passes user_gesture=true.
#[tauri::command]
pub fn capsule_surface(app: AppHandle) {
    surface_capsule(&app, false);
}

/// Dismiss the capsule to the tray (the × / settled path — 07 §4).
///
/// MUST mirror `surface_capsule_native`'s raw-Win32 path. Tauri's `w.hide()` looks
/// correct but is a NO-OP here: the surface path deliberately bypasses Tauri
/// (`ShowWindow(SW_SHOWNOACTIVATE)`, to avoid the F-2344 focus steal), so tao's own
/// `visible` bookkeeping still reads "hidden" and `hide()` short-circuits. Measured
/// on a real machine 2026-07-25: `fe.capsule#5 retreat to tray` logged, then 14
/// consecutive Win32 samples over 15 s all reported WS_VISIBLE — the capsule never
/// left the screen, and BOTH swallow sites (`if let Some` + `let _ =`) meant nothing
/// said so. Asymmetric show/hide paths are 「one window kept as two separate ledgers」.
#[tauri::command]
pub fn capsule_hide(app: AppHandle) {
    let Some(w) = app.get_webview_window(CAPSULE) else {
        // Never silent: a missing capsule window means dismiss/retreat cannot work.
        crate::forensic::record("capsule", "hide FAILED — capsule window not found");
        return;
    };
    #[cfg(windows)]
    hide_capsule_native(&w);
    #[cfg(not(windows))]
    let _ = w.hide();
}

/// Hide the capsule through the same raw-Win32 door the surface path uses, so the
/// two directions share one source of truth (see `capsule_hide`).
#[cfg(windows)]
fn hide_capsule_native(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
    let Ok(h) = w.hwnd() else {
        crate::forensic::record("capsule", "hide FAILED — no HWND for the capsule window");
        return;
    };
    let hwnd = HWND(h.0);
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
        // Report the truth rather than assume it: a hide that did not take is the
        // exact defect this function exists to close.
        if IsWindowVisible(hwnd).as_bool() {
            crate::forensic::record("capsule", "hide FAILED — still WS_VISIBLE after SW_HIDE");
        }
    }
}

/// Bring the main window forward (user gesture → focus is allowed).
#[tauri::command]
pub fn show_main(app: AppHandle) {
    show_main_window(&app);
}

/// Open the directory that contains `server.log`, `window-forensics.log`, and
/// the other desktop diagnostics. Refuse a missing directory before asking the
/// OS to open it: the frontend renders every `Err` as a visible manual-path
/// fallback, so a click can never disappear silently.
#[tauri::command]
pub fn open_log_directory(app: AppHandle) -> Result<bool, String> {
    let log_file = crate::forensic::sibling_path("window-forensics.log");
    let log_dir = log_file
        .parent()
        .ok_or_else(|| "无法解析日志目录".to_string())?;
    if !log_dir.is_dir() {
        return Err(format!("日志目录不存在或无法访问：{}", log_dir.display()));
    }
    let path = log_dir.to_string_lossy().into_owned();

    // Shell::open is deprecated since tauri-plugin-shell 2.1.0 in favour of
    // tauri-plugin-opener::OpenerExt::open_path. On desktop both call
    // open::that_detached (Windows → ShellExecuteExW), so opening a local
    // directory is user-visibly identical. Migrating needs a new crate +
    // plugin init + capabilities — out of this card's territory and "no new
    // deps" — so keep the existing path until that separate migration lands.
    #[allow(deprecated)]
    app.shell()
        .open(path, None)
        .map_err(|error| format!("打开日志目录失败（{}）：{error}", log_dir.display()))?;
    Ok(true)
}

// ── forensics frontend mirror (07 §10) ──────────────────────────────────────

/// Frontend forensic mirror: the Vue capsule/settings push `fe.<domain>#<seq> …`
/// lines here (07 §10). The line is pre-formatted by the frontend; this only
/// prepends a timestamp and appends to the same window-forensics.log. Write
/// failure is silently tolerated (the observation layer never bites back at the main flow).
#[tauri::command]
pub fn append_forensic(line: String) {
    crate::forensic::record_raw(&line);
}

/// Snapshot BOTH windows from the Tauri AND Win32 perspectives (07 §10:
/// is_visible / iconic / foreground / rect) into the forensic log. `tag` labels
/// the moment (e.g. "startup"). Purely observational — every query is
/// best-effort and any error degrades to a "?" field, never a panic.
pub fn forensic_window_snapshot(app: &AppHandle, tag: &str) {
    for label in [MAIN, CAPSULE] {
        let Some(w) = app.get_webview_window(label) else {
            crate::forensic::record("window", &format!("{tag} label={label} — window not found"));
            continue;
        };
        let tauri_view = format!(
            "tauri{{vis={} min={} foc={} pos={} size={}}}",
            w.is_visible().map(|b| b.to_string()).unwrap_or_else(|_| "?".into()),
            w.is_minimized().map(|b| b.to_string()).unwrap_or_else(|_| "?".into()),
            w.is_focused().map(|b| b.to_string()).unwrap_or_else(|_| "?".into()),
            w.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|_| "?".into()),
            w.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|_| "?".into()),
        );
        let win32_view = win32_window_view(&w);
        crate::forensic::record("window", &format!("{tag} label={label} {tauri_view} {win32_view}"));
    }
}

/// The Win32 second perspective on a window (07 §10) — often diverges from Tauri's
/// (the transparent capsule "blank capsule" class of bug). `None`-safe: unavailable
/// fields render "?".
#[cfg(windows)]
fn win32_window_view(w: &tauri::WebviewWindow) -> String {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, IsIconic, IsWindowVisible,
    };
    let Ok(h) = w.hwnd() else { return "win32{unavailable}".into() };
    let hwnd = HWND(h.0);
    unsafe {
        let vis = IsWindowVisible(hwnd).as_bool();
        let iconic = IsIconic(hwnd).as_bool();
        let fg = GetForegroundWindow() == hwnd;
        let mut rect = RECT::default();
        let rect_s = if GetWindowRect(hwnd, &mut rect).is_ok() {
            format!("{},{},{},{}", rect.left, rect.top, rect.right, rect.bottom)
        } else {
            "?".into()
        };
        format!("win32{{vis={vis} iconic={iconic} foreground={fg} rect={rect_s}}}")
    }
}

#[cfg(not(windows))]
fn win32_window_view(_w: &tauri::WebviewWindow) -> String {
    "win32{n/a}".into()
}

// ── window helpers ───────────────────────────────────────────────────────────

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Tray user-gesture summon (R6-C2): emit `flowmic://tray-summon` and let the Vue
/// visibility FSM decide + drive the surface.
///
/// owner 2026-07-26: this used to surface the NATIVE window here, unconditionally,
/// which popped the HUD for a PC with no phone on the active instance (the red
/// line: the capsule only exists while a phone is present or transcribing). The
/// native surface is now driven ONLY by the frontend via the `capsule_surface`
/// command on the visibility FSM's hidden→visible edge — and that FSM gates the
/// tray summon on phone presence (capsule-visibility onTraySummon). So a summon
/// with no phone is a no-op the frontend simply never acts on; a summon WITH a
/// phone restores a dismissed capsule as before. A global `emit` reaches the
/// capsule window's `listen` (same pattern as the BridgeSink).
pub fn tray_summon_capsule(app: &AppHandle) {
    let _ = app.emit(crate::socket::bridge::channel::TRAY_SUMMON, serde_json::json!({}));
}

/// Surface the capsule. `user_gesture` (tray) may focus; ambient never does.
pub fn surface_capsule(app: &AppHandle, user_gesture: bool) {
    let Some(w) = app.get_webview_window(CAPSULE) else { return };
    #[cfg(windows)]
    {
        capsule_watch::observe_window(&w, "surface");
        surface_capsule_native(&w);
        if user_gesture {
            let _ = w.set_focus();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = w.show();
        if user_gesture {
            let _ = w.set_focus();
        }
    }
}

/// Apply the WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW extended styles to the capsule so
/// clicking it never steals foreground and it stays off the taskbar / alt-tab
/// (07 §4 ruling 1). Called once at setup.
///
/// 🔴 FAILS LOUD (REQ-13-16). Both lookups used to be silent `if let`s, so the
/// case「the anti-focus-steal ex-style was never applied at all」 produced exactly
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

#[cfg(not(windows))]
pub fn configure_capsule_window(_app: &AppHandle) {}

/// Show the capsule WITHOUT activating it (SW_SHOWNOACTIVATE + a topmost
/// SetWindowPos with SWP_NOACTIVATE) — the F-2344 anti-focus-steal path. Tauri's
/// own `show()` maps to SW_SHOW and would activate on the hidden→visible edge.
#[cfg(windows)]
fn surface_capsule_native(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };
    if let Ok(h) = w.hwnd() {
        let hwnd = HWND(h.0);
        unsafe {
            // owner 2026-07-27: the frontend re-asserts every 2 s so a window the
            // OS declined to show can heal (it used to be edge-only and stayed
            // hidden forever). Re-issuing ShowWindow + SetWindowPos on an ALREADY
            // visible window makes it flash, which the owner saw as 「flickering」 after
            // each injection — so the no-op case really is a no-op.
            if windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() {
                return;
            }
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
        }
    }
}


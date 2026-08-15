// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connect layer; both channels resident —
//     the two resident sessions, and the F-2363 「switching channel tears down
//     the endpoint it already occupies」 hazard that
//     is the reason a dial never tears the other slot down)
//
// The per-channel socket SESSION layer, split out of `sidecar_ctl.rs`.
//
// WHAT IT OWNS: the two `SocketState` slots — building a session for one
// channel, marshalling that build onto the main thread, reading whether a slot
// is filled, writing one, and emptying one loudly.
//
// 🔴 WHY THIS FILE EXISTS — LINE COUNT, NOT ARCHITECTURE. `sidecar_ctl.rs` stood
// at 799 lines against the 800-line cap in `verify/lint/file-size.mjs`, so the
// next person who needed a line there would have had to do this refactor first,
// under time pressure, inside an unrelated change. It was done on its own
// instead, so that the eventual functional change is a clean diff. The move is
// VERBATIM: every comment travelled with the code it explains, unedited — this
// repo splits files to stay under the cap RATHER THAN deleting evidence, and
// several comments below record measured behaviour and past incidents that are
// worth more than the code around them (precedent: `tray.rs` next door, and
// `ptt_wire_keepalive.dart` on the mobile side). Nothing was renamed, no
// signature changed, nothing was reordered, and no behaviour moved with the
// code. ⚠️ Do NOT read this file's existence as a claim that a new layer was
// introduced. There is no new layer.
//
// WHY THIS CUT AND NOT SOME OTHER ONE: the seam is which managed state a
// function touches, which is checkable rather than a matter of taste. No
// function here touches `SidecarState`, and no function left in `sidecar_ctl.rs`
// touches `SocketState` — neither was true of the single file before the split.
//   `grep -c SocketState apps/.../shell/sidecar_ctl.rs` → 0. A clean check.
//   ⚠️ The mirror check is NOT clean, and saying so is the point: this header
//   names `SidecarState` twice while explaining the seam, so grepping THIS FILE
//   for it returns those two comment lines and can never return 0. The first
//   draft of this header asserted「→ 0」 anyway; the assertion matched itself,
//   so the check it invited would have disproved it. Verify against the code
//   (`grep -n SidecarState` here — both hits are in this header), not the file.
// `sidecar_ctl.rs` keeps the sidecar LIFECYCLE (the phase FSM, bring-up, the
// F-2343 LAN poll, the health supervisor, the device-page commands) and its own
// managed `SidecarState`; this file keeps the per-channel SESSIONS it dials.
// `build_sink`, `admission_of` and `reconcile_stored_pc_name` are here because
// they are private helpers of `connect_socket`, not because they touch a slot.
//
// `drop_socket` is re-exported by `sidecar_ctl`, so `shell::cloud`'s two call
// sites (`sidecar_ctl::drop_socket`) needed no edit — the same technique the
// `tray` split used for `shell::setup_tray`.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::forensic;
use crate::socket;
use crate::socket::channel::{self as chan, Channel};

use super::{cloud, SocketState};

/// The bridge sink used to reach every window (identical to lib.rs run()'s).
fn build_sink(app: &AppHandle) -> socket::BridgeSink {
    let handle = app.clone();
    Arc::new(move |channel: &str, payload: Value| {
        let _ = handle.emit(channel, payload);
    })
}

/// Drop the CLOUD session (cloud auth teardown). Public so shell::cloud can tear a
/// refused relay session down without reaching into SocketState itself. Scoped to
/// the cloud slot on purpose: a refused Cloud Key says nothing about the LAN
/// channel, and since GA-28 the LAN channel is right there, still working.
pub fn drop_socket(app: &AppHandle) {
    set_socket(app, Channel::Cloud, None);
}

/// Whether `channel` currently holds a live session.
pub(super) fn has_socket(app: &AppHandle, channel: Channel) -> bool {
    let s: State<SocketState> = app.state();
    let g = s.lock().unwrap_or_else(|p| p.into_inner());
    g.slot(channel).is_some()
}

/// Swap ONE channel's session (07 §6 both channels resident — the two slots are independent).
///
/// GA-28: this used to overwrite the single slot, which is why every cloud event
/// that emptied it also killed the LAN connection. Writing per-channel is what
/// makes 「the cloud Key expired」 a cloud-only event again.
pub(super) fn set_socket(app: &AppHandle, channel: Channel, sock: Option<socket::DesktopSocket>) {
    let s: State<SocketState> = app.state();
    let mut g = s.lock().unwrap_or_else(|p| p.into_inner());
    match channel {
        Channel::Lan => g.lan = sock,
        Channel::Cloud => g.cloud = sock,
    }
}

/// The shared capsule latch, cloned out for a fresh session — and the one place
/// that guarantees the latch's OWN watchdog is running.
///
/// 🔴 F8① — starting it HERE rather than inside a session is the whole fix. The
/// eviction clock used to tick inside `socket::pump`'s loop, i.e. on a thread that
/// `drop_socket` (cloud auth failure) joins; the teardown therefore removed the only
/// thing that could ever free the capsule, and a phone that owned this machine could
/// not be evicted without restarting the app. `ensure_watchdog` is idempotent and
/// the thread it starts belongs to the LATCH (a Weak upgrade, never a session), so
/// every dial re-asserts 「the watchdog is running」 and no teardown can take it away.
fn admission_of(app: &AppHandle) -> std::sync::Arc<socket::Admission> {
    let s: State<SocketState> = app.state();
    let g = s.lock().unwrap_or_else(|p| p.into_inner());
    let latch = g.admission.clone();
    socket::Admission::ensure_watchdog(&latch);
    latch
}


/// Marshal the socket connect onto the MAIN thread. `socket::connect` installs the
/// focus tracker via `SetWinEventHook(..., WINEVENT_OUTOFCONTEXT)`, whose callbacks
/// are delivered to the INSTALLING thread's message queue — that MUST be the main
/// thread, since Tauri's event loop is the only message pump (a std::thread worker
/// has none, so the hook would go deaf). The sidecar bring-up runs on a worker
/// thread (blocking process IO), but the connect is posted back here so focus
/// tracking + the focus:state mirror keep working (07 §3, F-2344). `connect` itself
/// is non-blocking (the socket.io client + pump run on their own threads), so this
/// does not stall the event loop.
pub(super) fn connect_on_main(app: &AppHandle, url: &str, channel: Channel, jwt: Option<String>) {
    // P7 (0.3.1) — the manual offline switch gates EVERY dial here, because
    // this is the one funnel all four redial paths share (sidecar_retry →
    // start, ensure_dialed, cloud_save_key redial, health supervisor after a
    // sidecar death). Gating any single caller instead would leave the others
    // able to bring the machine quietly back online.
    {
        let offline: State<super::offline::OfflineState> = app.state();
        if offline.is_offline() {
            forensic::record(
                "offline",
                &format!("dial refused while manually offline (channel={})", channel.tag()),
            );
            return;
        }
    }
    let app_cl = app.clone();
    let url_owned = url.to_string();
    let jwt_cl = jwt.clone();
    if app
        .run_on_main_thread(move || connect_socket(&app_cl, &url_owned, channel, jwt_cl))
        .is_err()
    {
        // RV-19: marshal failed (event loop shutting down / not up). The old
        // inline `connect_socket` fallback installed SetWinEventHook on THIS
        // worker/dying thread. OUTOFCONTEXT delivery needs the installer's
        // message pump — a dying thread has none — so the process-wide HOOK
        // OnceLock latched forever while focus forensic still said "installed"
        // and both channels went blind. Honesty beats a dead hook: skip connect
        // (and thus tracker install) and say so. Do NOT call connect_socket here.
        //
        // Recovery (grep evidence, no auto-retry on this arm):
        //   • socket.io reconnect ladder never starts — no DesktopSocket was built.
        //   • spawn_lan_poll only resolves pairing IP; it does not dial.
        //   • spawn_health_supervisor re-runs bring_up_and_connect only when
        //     /api/health dies — a healthy sidecar leaves this empty slot alone.
        //   • Who CAN re-call connect_on_main: sidecar_retry → start, switch_channel
        //     when the slot is empty, cloud_save_key redial, or supervisor after
        //     a real sidecar death. A transient marshal fail with a live sidecar
        //     therefore stays disconnected until one of those external triggers.
        let action = super::marshal_fallback::marshal_fail_action(channel);
        debug_assert!(!action.install_tracker);
        forensic::record("sidecar", &action.forensic_detail);
    }
}

// NOTE: this doc comment and connect_socket's below (it had none) used to be one
// block, fused together and misattached here in full — split apart in
// hygiene-009, each half returned to the function it actually documents. Do not
// re-merge them.
/// Read BOTH credential files, pick the one machine name, and write it back to
/// whichever of them disagreed. Idempotent — after the first run it is two reads
/// and no writes. Returns the name that MUST go into `SocketConfig.device_name`
/// for the connect that follows (C-1): leaving that field as the factory default
/// from `socket_config_from_env` made a brand-new cloud credentials file register
/// as `FlowMic-xxxx` even when LAN already held the user's rename.
///
/// Deliberately does NOT touch the token / client_instance_id / pc_id in either
/// file: those are per-channel identity and merging them would be a completely
/// different (and wrong) thing. Only `device_name` is machine-level.
fn reconcile_stored_pc_name() -> String {
    use crate::socket::Credentials;
    let lan_path = chan::credentials_path(Channel::Lan);
    let cloud_path = chan::credentials_path(Channel::Cloud);
    let lan = Credentials::load(&lan_path);
    let cloud = Credentials::load(&cloud_path);
    let fallback = crate::socket_config_from_env().device_name;
    // Nothing stored yet on either side ⇒ a fresh install; `Credentials::fresh`
    // will seed both from the same env/default value, so there is nothing to fix.
    if lan.is_none() && cloud.is_none() {
        return fallback;
    }
    let (name, conflicted) = crate::pc_name::reconcile_machine_name(
        lan.as_ref().map(|c| c.device_name.as_str()),
        cloud.as_ref().map(|c| c.device_name.as_str()),
        &fallback,
    );
    if conflicted {
        // Both sides carried a user-chosen name and they differed. LAN won (see
        // the precedence note); saying so is the difference between a rename that
        // 「it inexplicably changed back」 and one that has an explanation.
        forensic::record(
            "rename",
            &format!(
                "machine name conflict: lan={:?} cloud={:?} → {:?}",
                lan.as_ref().map(|c| &c.device_name),
                cloud.as_ref().map(|c| &c.device_name),
                name
            ),
        );
    }
    for (path, current) in [(lan_path, lan), (cloud_path, cloud)] {
        let Some(mut creds) = current else { continue };
        if creds.device_name == name {
            continue;
        }
        let was = creds.device_name.clone();
        creds.device_name = name.clone();
        let saved = creds.save(&path).is_ok();
        forensic::record(
            "rename",
            &format!("converged {was:?} → {name:?} in {path:?} ({})",
                if saved { "written" } else { "WRITE FAILED" }),
        );
    }
    name
}

/// Build a fresh socket session at `url` and swap it into the managed SocketState
/// (dropping any prior session disconnects it). Fail-loud: a connect error leaves
/// a None session so commands resolve to false, never a silent dead socket.
/// MUST run on the main thread — see `connect_on_main`.
///
/// R6 T-2 — this is the ONE place the channel's three connection facts are bound:
/// the credential SLOT (a LAN device_token is never presented to the relay, nor
/// the reverse), the Cloud Key on the handshake, and the auth-failure hook that
/// makes a refused key loud. LAN passes `None` for both, so its handshake and its
/// credential file are exactly what every shipped build already uses.
fn connect_socket(app: &AppHandle, url: &str, channel: Channel, jwt: Option<String>) {
    // v0.2.1 — converge the machine name BEFORE this channel registers.
    // See pc_name::reconcile_machine_name for the smoke-run evidence: the two
    // credential files had drifted to two different names, and each channel was
    // re-asserting its own. This heals the existing split; `pc_rename` writing
    // both channel slots (resident wire + dormant disk) is what stops it recurring.
    //
    // C-1: the reconciled name MUST also land in cfg.device_name. Without that,
    // a missing credentials file on this channel falls through to
    // `Credentials::fresh(&config.device_name)` with the factory default from
    // `socket_config_from_env`, undoing a rename that only the peer slot held.
    let reconciled_name = reconcile_stored_pc_name();
    let mut cfg = crate::socket_config_from_env();
    cfg.device_name = reconciled_name;
    cfg.url = url.to_string();
    cfg.credentials_path = chan::credentials_path(channel);
    // G-13: NO per-channel line here, and that absence is the fix. This used to
    // read `cfg.ledger_path = chan::typed_ledger_path(channel)`, mirroring the
    // credentials line above — but a `request_id` names one delivery to this
    // MACHINE (the phone's outbox retries it over whichever link is up), so the
    // per-channel table let the cloud leg re-type what the LAN leg had already
    // typed. Both channels now take `SocketConfig::deduper`'s default, which is
    // `dedup::machine_deduper()` — one table, not two that agree.
    cfg.jwt = jwt;
    cfg.auth_failure = match channel {
        Channel::Cloud => Some(cloud::auth_failure_hook(app)),
        Channel::Lan => None,
    };
    cfg.bridge = Some(build_sink(app));
    // GA-28: the session's own identity + the SHARED latch. Both sessions get the
    // same Arc, which is what lets one of them see that the other already holds
    // the capsule — the whole point of the two-channel arbitration.
    cfg.channel = channel;
    cfg.admission = Some(admission_of(app));
    let tag = channel.tag();
    match socket::connect(cfg) {
        Ok(sock) => {
            set_socket(app, channel, Some(sock));
            forensic::record("sidecar", &format!("socket connected → {url} (channel={tag})"));
        }
        Err(e) => {
            eprintln!("[flowmic] socket connect failed: {e}");
            set_socket(app, channel, None);
            forensic::record("sidecar", &format!("socket connect FAILED → {url} (channel={tag}): {e}"));
        }
    }
}

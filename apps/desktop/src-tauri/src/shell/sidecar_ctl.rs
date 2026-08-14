// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar lifecycle → connect at its
//     endpoint; LAN-IP poll for the pairing endpoint), §6 (connect layer; the
//     FLOWMIC_SERVER_URL dev override), §10 (forensics)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-4 lead-controller ruling #4 (connection
//     order: app starts → sidecar reaches Healthy/Adopted → connect using its
//     endpoint; FLOWMIC_SERVER_URL explicit override = dev mode, highest priority)
//     + #5 (pairing modal endpoint = sidecar endpoint + /api/network
//     LAN IP; F-2343 backoff + 3s continuous polling)
//
// The `app`-feature control layer that drives the tauri-free sidecar core
// (crate::sidecar) at startup and on the device-page Retry button, wires the
// resolved endpoint into socket::connect, keeps the spawned child for a clean
// kill on quit, and runs the F-2343 LAN-IP poll that upgrades the pairing endpoint
// from loopback to a phone-dialable `http://<lan-ip>:41879`.
//
// PRIORITY (lead-controller ruling #4): FLOWMIC_SERVER_URL (explicit dev override) > sidecar
// endpoint > the socket_config_from_env default. The override bypasses the sidecar
// entirely (a dev points the desktop at a hand-run server), but the LAN-IP poll
// still runs so pairing works in dev too.
//
// R6 T-2 (dual channels): the ACTIVE CHANNEL now decides the whole bring-up path.
//   • LAN   → everything above, unchanged.
//   • Cloud → the server is REMOTE, so the local sidecar is not needed: it is
//     neither spawned nor killed (an already-running one may serve something
//     else), the device page shows the local-server card as `suspended` rather
//     than a fake failure, and the socket dials the relay with the Cloud Key.
// Switching back to LAN brings the sidecar up on demand.

use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::forensic;
use crate::sidecar::io::{self, BringUpOptions};
use crate::sidecar::{self, Phase};
use crate::socket::channel::{self as chan, Channel, CloudReadiness};
use crate::socket::bridge;

use super::channel_session::{connect_on_main, has_socket, set_socket};
use super::cloud;

/// Re-exported so that `shell::cloud`'s two `sidecar_ctl::drop_socket` call sites
/// needed no edit when the session layer moved out to `channel_session` for the
/// 800-line cap — the same technique the `tray` split used for
/// `shell::setup_tray`. Not a convenience alias: delete it and `shell/cloud.rs`
/// stops compiling.
pub use super::channel_session::drop_socket;

/// Managed sidecar control state (one per desktop process).
pub struct SidecarState {
    /// The spawned child (our own healthy server). `None` when adopted/dev/failed.
    child: Mutex<Option<Child>>,
    /// The endpoint the desktop dials (loopback for our child, or the adopted URL).
    dialed_endpoint: Mutex<Option<String>>,
    /// The LAN pairing endpoint (`http://<lan-ip>:port`) once /api/network yields
    /// one (F-2343). Shared with the poll thread.
    lan_endpoint: Arc<Mutex<Option<String>>>,
    /// GA-21: every LAN IPv4 the server reported, in its default order. The
    /// device page offers these so a human can override the heuristic's pick
    /// when the phone is on a segment the heuristic ranks last.
    lan_candidates: Arc<Mutex<Vec<String>>>,
    /// D2LAN-B2b: the sidecar's LAN TLS public-key fingerprint, as `/api/network`
    /// published it. `None` until the LAN poll has read one — and permanently
    /// `None` against a server serving plain (no TLS home) or an older sidecar
    /// that does not know the key. The pairing QR then carries no `fp=` and is
    /// byte-identical to the pre-D2-LAN one, which is the intended failure
    /// direction: 「退回现状」("fall back to the current state"), never 「连不上」("cannot connect").
    lan_tls_fp: Arc<Mutex<Option<String>>>,
    /// The current lifecycle phase (device-page status source).
    phase: Mutex<Phase>,
    /// R6 T-2: the cloud channel is active, so the local sidecar was deliberately
    /// NOT brought up. The device page renders「本地服务未启动（当前使用云端中继）」
    /// ("local service not started (currently using cloud relay)")
    /// instead of a transient「启动中」("starting") that would never resolve.
    suspended: Mutex<bool>,
    /// A health supervisor thread is running — at most one, ever (owner
    /// 2026-07-27). Cleared when that thread returns.
    supervising: std::sync::atomic::AtomicBool,
    host: String,
    port: u16,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            dialed_endpoint: Mutex::new(None),
            lan_endpoint: Arc::new(Mutex::new(None)),
            lan_candidates: Arc::new(Mutex::new(Vec::new())),
            lan_tls_fp: Arc::new(Mutex::new(None)),
            phase: Mutex::new(Phase::Resolving),
            suspended: Mutex::new(false),
            supervising: std::sync::atomic::AtomicBool::new(false),
            host: sidecar::SIDECAR_HOST.to_string(),
            // The resolved port, not the constant — FLOWMIC_SIDECAR_PORT must
            // reach the device page and the LAN poll too, or a second instance
            // would advertise a pairing endpoint it is not listening on.
            port: sidecar::sidecar_port(),
        }
    }

    /// Claim the single supervisor slot. `false` = one is already running.
    fn claim_supervisor(&self) -> bool {
        !self.supervising.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    fn release_supervisor(&self) {
        self.supervising.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Kill the spawned child. No-op when adopted/dev.
    ///
    /// 🔴 `cause` is not decoration: this method has three callers meaning three
    /// different things, and it used to write ONE sentence for all of them —
    /// which is why an instance that went away could not be attributed from its
    /// own log. See `crate::exit_reason::SidecarKillCause`.
    pub fn kill_child(&self, cause: crate::exit_reason::SidecarKillCause) {
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.kill();
                let _ = c.wait();
                // The job slot goes with it: the child is reaped, so closing the
                // kill-on-close job is a no-op. The job's real work is the crash
                // path where this method never runs (sidecar/job.rs).
                crate::sidecar::job::clear();
                forensic::record("sidecar", &cause.forensic_line());
            }
        }
    }

    /// The pairing endpoint (lead-controller ruling #5): prefer the resolved LAN endpoint, else
    /// the dialed loopback/adopted one (which suppresses the QR — F-2346).
    pub fn pairing_endpoint(&self) -> Option<String> {
        if let Ok(g) = self.lan_endpoint.lock() {
            if let Some(ep) = g.as_ref() {
                return Some(ep.clone());
            }
        }
        self.dialed_endpoint.lock().ok().and_then(|g| g.clone())
    }

    // Scoped lock helpers — every MutexGuard lives and dies INSIDE the method, so a
    // caller holding a `State<SidecarState>` never leaves a guard temporary beside
    // the State local (which would extend the borrow past the local's drop, E0597).
    fn set_phase(&self, phase: Phase) {
        let mut g = self.phase.lock().unwrap_or_else(|p| p.into_inner());
        *g = phase;
    }
    fn set_child(&self, child: Option<Child>) {
        let mut g = self.child.lock().unwrap_or_else(|p| p.into_inner());
        *g = child;
    }
    fn set_dialed(&self, endpoint: Option<String>) {
        let mut g = self.dialed_endpoint.lock().unwrap_or_else(|p| p.into_inner());
        *g = endpoint;
    }
    fn set_suspended(&self, suspended: bool) {
        let mut g = self.suspended.lock().unwrap_or_else(|p| p.into_inner());
        *g = suspended;
    }
    fn suspended(&self) -> bool {
        self.suspended.lock().map(|g| *g).unwrap_or(false)
    }
    fn phase_snapshot(&self) -> Phase {
        self.phase.lock().map(|g| g.clone()).unwrap_or(Phase::Resolving)
    }
    fn dialed_snapshot(&self) -> Option<String> {
        self.dialed_endpoint.lock().ok().and_then(|g| g.clone())
    }
    fn lan_handle(&self) -> Arc<Mutex<Option<String>>> {
        Arc::clone(&self.lan_endpoint)
    }
    /// GA-21: the candidate list for the device page's endpoint picker. Empty
    /// until the LAN poll has had one successful read.
    pub fn lan_candidates(&self) -> Vec<String> {
        self.lan_candidates.lock().map(|g| g.clone()).unwrap_or_default()
    }
    fn lan_candidates_handle(&self) -> Arc<Mutex<Vec<String>>> {
        Arc::clone(&self.lan_candidates)
    }
    /// D2LAN-B2b: the fingerprint the pairing QR publishes as `fp=`. `None` until
    /// the LAN poll reads one; `None` forever when the sidecar serves plain.
    pub fn lan_tls_fingerprint(&self) -> Option<String> {
        self.lan_tls_fp.lock().ok().and_then(|g| g.clone())
    }
    fn lan_tls_fp_handle(&self) -> Arc<Mutex<Option<String>>> {
        Arc::clone(&self.lan_tls_fp)
    }
    fn lan_resolved(&self) -> bool {
        self.lan_endpoint.lock().map(|g| g.is_some()).unwrap_or(false)
    }
}

/// The device-page status DTO. `phase` is the machine tag; `detail` carries the
/// human failure reason (only when failed) for the error card.
#[derive(serde::Serialize, Clone)]
pub struct SidecarStatusDto {
    pub phase: String,
    pub endpoint: Option<String>,
    pub detail: Option<String>,
}

fn dto(phase: &Phase, dialed: Option<String>, suspended: bool) -> SidecarStatusDto {
    if suspended {
        // T-2 ④: honest state for "we never started it, on purpose". NOT a failure
        // (no Retry offered) and NOT a transient「启动中」("starting") that never resolves.
        return SidecarStatusDto { phase: "suspended".to_string(), endpoint: dialed, detail: None };
    }
    let (tag, detail): (&str, Option<String>) = match phase {
        Phase::Resolving => ("resolving", None),
        Phase::Spawning => ("spawning", None),
        Phase::AwaitingHandshake => ("awaiting_handshake", None),
        Phase::AwaitingHealth { .. } => ("awaiting_health", None),
        Phase::Healthy { .. } => ("healthy", None),
        Phase::Probing => ("probing", None),
        Phase::Clearing => ("clearing", None),
        Phase::AdoptedExternal { .. } => ("adopted_external", None),
        Phase::Failed { reason } => ("failed", Some(reason.to_string())),
    };
    SidecarStatusDto {
        phase: tag.to_string(),
        endpoint: phase.endpoint().map(str::to_string).or(dialed),
        detail,
    }
}

fn emit_state(app: &AppHandle, phase: &Phase, dialed: Option<String>) {
    let suspended = app.state::<SidecarState>().suspended();
    if let Ok(v) = serde_json::to_value(dto(phase, dialed, suspended)) {
        let _ = app.emit(bridge::channel::SIDECAR_STATE, v);
    }
}

/// The ordered resolve candidates (07 §5: MSI resource dir → exe-sibling → dev
/// tree → cwd). The MSI/exe dirs come from the Tauri path resolver (app feature);
/// the dev-tree + cwd fallbacks keep `pnpm tauri dev` working.
fn resolve_candidates(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    // 1. MSI: bundled under <resource_dir>/resources/server.js.
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("resources"));
        dirs.push(res);
    }
    // 2. exe-sibling (portable / loose build).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("resources"));
            dirs.push(parent.to_path_buf());
        }
    }
    // 3. dev tree (src-tauri/resources + server-core/dist).
    dirs.extend(io::dev_candidate_dirs());
    // 4. cwd.
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("resources"));
    }
    dirs
}

/// Start (or restart) the sidecar bring-up: emit `resolving`, then run the blocking
/// resolve→spawn→handshake→health worker on a background thread so the window is
/// never blocked. The worker emits the terminal status and connects the socket.
pub fn start(app: &AppHandle) {
    // GA-28 (07 §6 dual channels always resident): BOTH channels come up, and since owner 2026-07-30 ②
    // there is no user-settable「主通道」("primary channel") to seed into the latch — which channel carries
    // the runtime is DERIVED from whichever phone gets admitted (socket::admission),
    // and with no phone it is the process default the latch was built with.
    forensic::record("channel", "bring-up: LAN + cloud both resident");

    // With both channels resident the LAN sidecar is always wanted: it IS the
    // local channel, so it is never left 'suspended' for the cloud's sake again.
    {
        let state: State<SidecarState> = app.state();
        state.set_suspended(false);
        state.set_phase(Phase::Resolving);
    }
    emit_state(app, &Phase::Resolving, None);
    let app2 = app.clone();
    std::thread::spawn(move || bring_up_and_connect(&app2));
    // The cloud leg needs no local process, so it dials in PARALLEL rather than
    // waiting behind the sidecar handshake.
    start_cloud(app);
}

/// Bring the CLOUD channel up alongside the LAN one. A relay that cannot be dialed
/// stays loudly disconnected (T-2 ⑤) — it never degrades the LAN channel, and
/// since GA-28 it never REPLACES it either.
fn start_cloud(app: &AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || connect_cloud(&app2));
}

/// Dial the cloud relay, or fail LOUD (T-2 ⑤). There is deliberately NO fallback
/// to the LAN channel here: a cloud channel that cannot connect stays visibly
/// broken (`readiness` on the device page) instead of quietly becoming a local
/// connection the user did not ask for.
fn connect_cloud(app: &AppHandle) {
    let cfg = cloud::snapshot(app);
    match cfg.readiness(chan::now_secs()) {
        CloudReadiness::Ready => {
            let head = cfg.key_head().unwrap_or_default();
            forensic::record(
                "cloud",
                &format!("dialing relay {} with Cloud Key (head={head})", cfg.endpoint),
            );
            connect_on_main(app, &cfg.endpoint, Channel::Cloud, cfg.jwt.clone());
        }
        not_ready => {
            // Fail-loud, and scoped to the CLOUD slot only: emptying it must not
            // disturb the LAN session sitting in the other slot.
            set_socket(app, Channel::Cloud, None);
            forensic::record(
                "cloud",
                &format!("relay NOT dialable: {} — cloud slot stays empty (LAN untouched)", not_ready.tag()),
            );
            eprintln!("[flowmic] cloud channel not dialable: {}", not_ready.tag());
            cloud::emit_state(app);
        }
    }
}

/// Make sure `target` has a live session, dialing it if its slot is empty.
///
/// This used to be `switch_channel`, the device page's「设为主通道」("set as
/// primary channel") verb, and it did
/// two things: move the user's preference in the latch AND dial. owner 2026-07-30 ②
/// deleted the preference, and what is left is the half that was always the useful
/// one — 「这条通道还没拨上，去拨」("this channel hasn't been dialed yet, dial it")
/// — now named after it. NOTHING is torn down (the
/// 「切通道拆掉自己已占的端点」("switching channels tears down an endpoint it
/// already holds") F-2363 hazard 07 §6 warns about), and a phone that
/// owns the capsule keeps it: dialing a second resident channel takes nothing away
/// from the one being spoken through.
pub fn ensure_dialed(app: &AppHandle, target: Channel) {
    if has_socket(app, target) {
        return;
    }
    forensic::record("channel", &format!("{} has no session — dialing it", target.tag()));
    match target {
        Channel::Cloud => start_cloud(app),
        Channel::Lan => {
            let state: State<SidecarState> = app.state();
            state.set_suspended(false);
            match state.phase_snapshot() {
                // The sidecar is already up — re-dial its endpoint instead of
                // restarting the whole bring-up.
                Phase::Healthy { endpoint } | Phase::AdoptedExternal { endpoint } => {
                    emit_state(app, &state.phase_snapshot(), Some(endpoint.clone()));
                    connect_on_main(app, &endpoint, Channel::Lan, None);
                }
                // Never brought up (bring-up failed, or is still running).
                _ => start(app),
            }
        }
    }
}

/// The blocking bring-up worker (runs on a thread). Honours the FLOWMIC_SERVER_URL
/// dev override, else drives crate::sidecar::io::bring_up, stores the child +
/// endpoint, emits the terminal status, connects the socket, and kicks the LAN
/// poll. On failure it manages a None socket (fail-loud — commands resolve to
/// false, never a silent dead socket).
fn bring_up_and_connect(app: &AppHandle) {
    let state: State<SidecarState> = app.state();

    // PRIORITY 1 — explicit dev override bypasses the sidecar (lead-controller ruling #4).
    if let Ok(url) = std::env::var("FLOWMIC_SERVER_URL") {
        forensic::record("sidecar", &format!("FLOWMIC_SERVER_URL set → dev mode, bypassing sidecar ({url})"));
        state.set_dialed(Some(url.clone()));
        let phase = Phase::AdoptedExternal { endpoint: url.clone() };
        state.set_phase(phase.clone());
        emit_state(app, &phase, Some(url.clone()));
        connect_on_main(app, &url, Channel::Lan, None);
        spawn_lan_poll(app);
        return;
    }

    // PRIORITY 2 — the bundled sidecar.
    let candidates = resolve_candidates(app);
    let opts = BringUpOptions {
        candidate_dirs: candidates,
        host: state.host.clone(),
        port: state.port,
        ..Default::default()
    };
    forensic::record("sidecar", "bring-up: starting (resolve → spawn → handshake → health)");
    let mut up = io::bring_up(&opts);
    let phase = up.phase.clone();

    state.set_child(up.child.take());
    let endpoint = phase.endpoint().map(str::to_string);
    if let Some(e) = &endpoint {
        state.set_dialed(Some(e.clone()));
    }
    state.set_phase(phase.clone());
    emit_state(app, &phase, endpoint.clone());

    match &phase {
        Phase::Healthy { endpoint } | Phase::AdoptedExternal { endpoint } => {
            connect_on_main(app, endpoint, Channel::Lan, None);
            spawn_lan_poll(app);
            spawn_health_supervisor(app);
        }
        _ => {
            // Failed → empty the LAN slot (fail-loud). The cloud slot is a
            // different channel's business and is left exactly as it was.
            set_socket(app, Channel::Lan, None);
            forensic::record("sidecar", &format!("bring-up FAILED: {phase:?}"));
        }
    }
}

/// F-2343 LAN-IP poll: once the endpoint is up, poll /api/network every 3 s until a
/// non-loopback LAN IPv4 appears (DHCP may be late — a loopback-only result is
/// "还没好" ("not ready yet"), not terminal). Stops once resolved. A ~10 min ceiling then gives up
/// (the pairing modal keeps the loopback endpoint → QR suppressed, F-2346).
fn spawn_lan_poll(app: &AppHandle) {
    let state: State<SidecarState> = app.state();
    if state.lan_resolved() {
        return; // already resolved
    }
    let lan = state.lan_handle();
    let cands = state.lan_candidates_handle();
    let tls_fp = state.lan_tls_fp_handle();
    let host = state.host.clone();
    let port = state.port;
    std::thread::spawn(move || {
        let mut warned_malformed = false;
        for _ in 0..200 {
            // GA-21: record the WHOLE candidate list on every read, not only on
            // the resolving one — the picker needs the alternatives even when the
            // heuristic already produced a usable primary.
            let all = io::fetch_lan_candidates(&host, port);
            if !all.is_empty() {
                if let Ok(mut g) = cands.lock() {
                    *g = all;
                }
            }
            // D2LAN-B2b — read the fingerprint HERE, ABOVE the primary check,
            // because that check RETURNS. On a normal machine the loop exits on its
            // first iteration, so a read placed after it would run zero times on
            // exactly the machines this feature is for. One read suffices (the TLS
            // front exists before the server listens), hence the `is_none` guard.
            // Rationale for dropping-vs-carrying is at `io::is_carryable_fingerprint`.
            if tls_fp.lock().map(|g| g.is_none()).unwrap_or(false) {
                match io::fetch_lan_tls_fingerprint(&host, port) {
                    Some(raw) if io::is_carryable_fingerprint(&raw) => {
                        if let Ok(mut g) = tls_fp.lock() {
                            *g = Some(raw.clone());
                        }
                        forensic::record("sidecar", &format!("LAN TLS fingerprint read: {raw}"));
                    }
                    // 🔴 Out loud, once, with the LENGTH rather than the value:
                    // truncation is the likely corruption and 「多长」("how long") identifies it.
                    Some(raw) if !warned_malformed => {
                        warned_malformed = true;
                        forensic::record(
                            "sidecar",
                            &format!(
                                "REFUSED a malformed LAN TLS fingerprint from /api/network ({} chars) — the pairing QR carries no fp=",
                                raw.len()
                            ),
                        );
                    }
                    // A malformed value we have already reported, or none at all:
                    // both leave the slot empty, which is the same QR either way.
                    _ => {}
                }
            }
            if let Some(ip) = io::fetch_lan_primary(&host, port) {
                let ep = format!("http://{ip}:{port}");
                if let Ok(mut g) = lan.lock() {
                    *g = Some(ep.clone());
                }
                forensic::record("sidecar", &format!("LAN pairing endpoint resolved: {ep}"));
                return;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        forensic::record("sidecar", "LAN-IP poll gave up (no non-loopback IPv4 in ~10min)");
    });
}

/// Consecutive failed health probes before the local server is declared dead.
/// 3 × 5 s ≈ 15 s: long enough that a GC pause or a busy moment is not a death,
/// short enough that the user is not left staring at 「重新连接中」("reconnecting").
const SUPERVISOR_STRIKES: u32 = 3;
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(5);

/// Watch the local server for the rest of its life and bring it back if it dies
/// (owner 2026-07-27).
///
/// The lifecycle FSM only covers failures BEFORE Healthy — exit-during-handshake,
/// EADDRINUSE. Nothing watched afterwards, so a server that died once it was up
/// left the desktop reconnecting to a port with nothing behind it, forever, with
/// no way back except quitting the app. That is exactly what owner hit: an
/// adopted orphan sidecar exited mid-utterance and the PC just said
/// 「重新连接中」("reconnecting") until it was restarted by hand.
///
/// Re-runs the SAME bring-up used at startup and by Retry (probe → adopt → spawn),
/// so it inherits the adopt-first rule and the one-shot kill budget instead of
/// inventing a second recovery path. Then it returns: the fresh bring-up starts
/// the next supervisor, so there is never more than one alive.
fn spawn_health_supervisor(app: &AppHandle) {
    {
        let state: State<SidecarState> = app.state();
        if !state.claim_supervisor() {
            return; // one is already watching
        }
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let (host, port) = {
            let state: State<SidecarState> = app2.state();
            (state.host.clone(), state.port)
        };
        let mut strikes: u32 = 0;
        loop {
            std::thread::sleep(SUPERVISOR_INTERVAL);
            {
                let state: State<SidecarState> = app2.state();
                // A suspended or already-failed sidecar is somebody else's story.
                if state.suspended() || !matches!(
                    state.phase_snapshot(),
                    Phase::Healthy { .. } | Phase::AdoptedExternal { .. }
                ) {
                    state.release_supervisor();
                    return;
                }
            }
            let alive = io::http_get(&host, port, "/api/health", Duration::from_secs(2))
                .map(|r| r.status == 200)
                .unwrap_or(false);
            if alive {
                strikes = 0;
                continue;
            }
            strikes += 1;
            forensic::record(
                "sidecar",
                &format!("supervisor: /api/health unanswered ({strikes}/{SUPERVISOR_STRIKES})"),
            );
            if strikes < SUPERVISOR_STRIKES {
                continue;
            }
            forensic::record(
                "sidecar",
                "supervisor: local server is GONE — re-running bring-up (never silent)",
            );
            {
                let state: State<SidecarState> = app2.state();
                // Reap our own corpse first: a dead child left in the slot would
                // otherwise be 'killed' again by the next exit path.
                state.kill_child(crate::exit_reason::SidecarKillCause::HealthSupervisorRestart);
                state.set_phase(Phase::Resolving);
                state.release_supervisor(); // the new bring-up claims a fresh one
            }
            emit_state(&app2, &Phase::Resolving, None);
            bring_up_and_connect(&app2);
            return;
        }
    });
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Read the current sidecar status for the device page.
#[tauri::command]
pub fn sidecar_state(state: State<'_, SidecarState>) -> SidecarStatusDto {
    dto(&state.phase_snapshot(), state.dialed_snapshot(), state.suspended())
}

/// Retry the bring-up (error-card Retry button). Kills any prior child, re-emits
/// `resolving`, and restarts the worker thread. Returns the immediate (resolving)
/// status; the terminal status arrives async on the sidecar-state channel.
///
/// The R6 T-2 「cloud channel is active ⇒ ignore」 branch is GONE (owner 2026-07-30 ②).
/// It rested on the single-channel world where choosing cloud suspended the local
/// server; since GA-28 the LAN sidecar is always wanted (`start` clears `suspended`
/// unconditionally, and nothing sets it), and now that the channel select is deleted
/// the user has no way to flip that flag back — so the branch could only ever refuse
/// a retry the user cannot otherwise obtain.
#[tauri::command]
pub fn sidecar_retry(app: AppHandle) -> SidecarStatusDto {
    let state: State<SidecarState> = app.state();
    state.kill_child(crate::exit_reason::SidecarKillCause::DevicePageRetry);
    forensic::record("sidecar", "retry requested (device page)");
    start(&app);
    dto(&Phase::Resolving, None, false)
}

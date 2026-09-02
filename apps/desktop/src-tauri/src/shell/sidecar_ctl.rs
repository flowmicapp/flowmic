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
// R6 T-2 (dual channels): the ACTIVE CHANNEL used to decide the whole bring-up
// path — a Cloud-only world left the local sidecar neither spawned nor killed
// and showed the device page a `suspended` card instead of a fake failure.
//
// In-place correction (2026-09-02, sidecar supervisor leftovers): GA-28 made
// BOTH channels always resident, so nothing sets `suspended` any more — start()
// always brings the LAN sidecar up regardless of which channel a phone ends up
// admitted to. The dead `suspended` field, its dto() branch, and the device
// page's corresponding phase (SIDECAR_LABEL.suspended in channel.ts) were
// removed here; the original text above is kept because it accurately records
// why this shape existed and the T-2 ruling it came from, not because it is
// still true today.

use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::forensic;
use crate::sidecar::io::{self, BringUpOptions};
use crate::sidecar::state::FailReason;
use crate::sidecar::{self, Phase};
use crate::socket::channel::{self as chan, Channel, CloudReadiness};
use crate::socket::bridge;
use crate::socket::node_select;

use super::channel_session::{connect_on_main, has_socket, mark_slot_transient, set_socket};
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
    /// A health supervisor thread is running — at most one, ever (owner
    /// 2026-07-27). Cleared when that thread returns.
    supervising: std::sync::atomic::AtomicBool,
    /// D8 (2026-09-02 audit §3-D): a bring-up (resolve → spawn → handshake →
    /// health) is in flight — at most one, ever. Before this flag existed,
    /// nothing stopped two callers of `start()` (a device-page "retry" click
    /// racing a heartbeat-death `ensure_dialed` rebuild, say) from BOTH
    /// running `bring_up_and_connect` concurrently: each spawns its OWN
    /// `node server.js`, and whichever finishes last silently overwrites
    /// `child` here — orphaning the other spawned child, which
    /// `job::guard_child`'s single-slot job-object replace can then respond
    /// to by killing a perfectly HEALTHY process (`KILL_ON_JOB_CLOSE`) instead
    /// of the stale one. `supervising` above guards a different thing (the
    /// health-poll loop that runs AFTER a successful bring-up) and does
    /// nothing to stop this.
    bringing_up: std::sync::atomic::AtomicBool,
    /// 2026-09-02 (sidecar supervisor leftovers, item 1): how many consecutive
    /// AUTOMATIC restarts the health supervisor has run without the server
    /// ever staying up long enough to forgive the streak (`note_restart_attempt`
    /// / `reset_restart_attempts` / `forgive_restart_streak_if_older_than`,
    /// used only by `spawn_health_supervisor`). A manual Retry always resets
    /// this to 0 (`start()`) — the budget is for CRASH LOOPS the supervisor is
    /// fighting alone, not a ceiling on how many times a human may click Retry.
    restart_attempts: std::sync::atomic::AtomicU32,
    /// When the LAST automatic restart was noted, so a streak can be forgiven
    /// once the server has stayed healthy for SUPERVISOR_FORGIVE_AFTER since
    /// then — an occasional restart over the app's whole lifetime must not
    /// spend down the same budget a real crash loop would need.
    last_restart_at: Mutex<Option<Instant>>,
    /// D-B2L (2026-09-02 audit, sidecar supervisor leftovers item 3): the
    /// buffer `io::bring_up`'s `BringUp::stderr_tail` hands back once a child
    /// has completed its handshake — set on every bring-up, taken (and thus
    /// cleared) by the health supervisor when it finds the child dead, so a
    /// restart/give-up forensic line can say what the dead child's own last
    /// words were instead of just "it's gone".
    child_stderr_tail: Mutex<Option<io::SharedStderrTail>>,
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
            supervising: std::sync::atomic::AtomicBool::new(false),
            bringing_up: std::sync::atomic::AtomicBool::new(false),
            restart_attempts: std::sync::atomic::AtomicU32::new(0),
            last_restart_at: Mutex::new(None),
            child_stderr_tail: Mutex::new(None),
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

    /// D8 — claim the single bring-up slot. `false` = one is already running.
    fn claim_bring_up(&self) -> bool {
        !self.bringing_up.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    fn release_bring_up(&self) {
        self.bringing_up.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Record one more automatic restart in the current streak and return its
    /// 1-based number. Only `spawn_health_supervisor` calls this — a manual
    /// Retry goes through `start()`, which resets the streak instead.
    fn note_restart_attempt(&self) -> u32 {
        if let Ok(mut g) = self.last_restart_at.lock() {
            *g = Some(Instant::now());
        }
        self.restart_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    /// Start a fresh streak — called on every manual entry point (`start()`,
    /// which both a cold boot and the Retry button run through) so the
    /// crash-loop budget is never spent by a human's own choice to retry.
    fn reset_restart_attempts(&self) {
        self.restart_attempts.store(0, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = self.last_restart_at.lock() {
            *g = None;
        }
    }

    /// Forgive the streak once the server has stayed healthy for at least
    /// `threshold` since the last automatic restart. A no-op when there is
    /// nothing to forgive (streak already at 0, or too young). Takes the
    /// threshold as a parameter rather than reading SUPERVISOR_FORGIVE_AFTER
    /// directly so the decision itself is unit-testable without a real clock.
    fn forgive_restart_streak_if_older_than(&self, threshold: Duration) {
        let stable = self
            .last_restart_at
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|t| t.elapsed() >= threshold)
            .unwrap_or(false);
        if stable {
            self.reset_restart_attempts();
        }
    }

    fn set_child_stderr_tail(&self, tail: Option<io::SharedStderrTail>) {
        let mut g = self.child_stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
        *g = tail;
    }

    /// Take (not just read) the buffered stderr tail for whichever child's
    /// bring-up last set one — `None` before any child has completed its
    /// handshake, or for an AdoptedExternal process (io::bring_up never sets
    /// one for those — see BringUp::stderr_tail's doc comment). Taking it
    /// means a stale tail is never attributed to the NEXT child after a
    /// restart: the following bring-up sets a fresh value (or `None`) before
    /// anyone could read this one again.
    fn take_child_stderr_tail(&self) -> Option<String> {
        let buf = {
            let mut g = self.child_stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
            g.take()
        }?;
        Some(io::stderr_tail(&buf, 5))
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

fn dto(phase: &Phase, dialed: Option<String>) -> SidecarStatusDto {
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
    if let Ok(v) = serde_json::to_value(dto(phase, dialed)) {
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
    // local channel, and GA-28 removed the only thing that used to hold it back
    // (see the file header's in-place correction on the retired `suspended` state).
    {
        let state: State<SidecarState> = app.state();
        state.set_phase(Phase::Resolving);
        // 2026-09-02 (sidecar supervisor leftovers, item 1): `start()` is the
        // ONLY manual entry point (cold boot, the Retry button, and
        // ensure_dialed()'s "never brought up" fallback all run through it) —
        // resetting the automatic-restart streak here means a human's own
        // choice to retry never counts against the crash-loop budget that
        // SUPERVISOR_MAX_RESTARTS bounds.
        state.reset_restart_attempts();
    }
    emit_state(app, &Phase::Resolving, None);
    // D8: claim the single bring-up slot BEFORE spawning the worker thread, so
    // two overlapping calls to `start()` (a device-page retry racing a
    // heartbeat-death rebuild, say) cannot both end up running
    // `bring_up_and_connect` — see `SidecarState::bringing_up`'s doc comment
    // for what that used to cost (two `node server.js` children, one of them
    // orphaned and then killed by a job-object slot replace).
    let state: State<SidecarState> = app.state();
    if state.claim_bring_up() {
        let app2 = app.clone();
        std::thread::spawn(move || bring_up_and_connect(&app2));
    } else {
        forensic::record(
            "sidecar",
            "bring-up SKIPPED — one is already in flight (D8 reentrancy guard); \
             the in-flight run will emit its own terminal status",
        );
    }
    // The cloud leg needs no local process, so it dials in PARALLEL rather than
    // waiting behind the sidecar handshake.
    start_cloud(app);
}

// Cloud-relay node tracking + selection moved to sidecar_node_select.rs
// (2026-09-02, file-size cap) — a child module so it keeps private access to
// this file's imports (chan, Channel, node_select). `current_node` /
// `current_node_id` are re-exported below because shell/connection.rs and
// shell/node_latency.rs call them as `sidecar_ctl::current_node()` /
// `sidecar_ctl::current_node_id()`.
#[path = "sidecar_node_select.rs"]
mod sidecar_node_select;
pub use sidecar_node_select::{current_node, current_node_id};
use sidecar_node_select::{cloud_registration_due, remember_node, select_relay_node};

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
            // 2026-08-29 multi-node — WHICH DOOR of this endpoint to use. This
            // never rewrites `cfg.endpoint`: that field answers「which service
            // am I on」and is the one a self-hosted operator sets, while a node
            // answers「which door is nearest me」. Candidates come only from what
            // that endpoint itself publishes, so a self-hosted install cannot be
            // moved onto our infrastructure here (socket/node_select.rs).
            //
            // On every non-choosing path `dial` IS the endpoint, so this line
            // is unconditional and there is no「no node」branch to forget.
            let choice = select_relay_node(&cfg.endpoint, cloud_registration_due());
            forensic::record("cloud", &format!("relay node: {}", choice.reason.describe()));
            forensic::record(
                "cloud",
                &format!("dialing relay {} with Cloud Key (head={head})", choice.url),
            );
            remember_node(choice.node.clone(), choice.short.clone(), choice.url.clone());
            connect_on_main(app, &choice.url, Channel::Cloud, cfg.jwt.clone());
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

/// WP2 Card 7 / G5 reconstruction: empty the slot so [`ensure_dialed`] will
/// actually dial, then dial. The new session's `"open"` is the room-entering
/// author — same funnel as a cold start. Spawned because the pump calls this
/// and `set_socket(None)` Drops the session whose pump we are on.
///
/// Shared by both channels: the detector lives in the shared pump, and this
/// is the shared dial funnel. No LAN-only fork.
///
/// W8-2 cloud arm (2026-09-02, AUD-D P1-3) — `mark_slot_transient` runs BEFORE
/// `set_socket(None)` for exactly this reason: this funnel's whole purpose is
/// "empty it so we can redial it", never "shut this channel down". Before this
/// line, a redial that then FAILED (`ensure_dialed` → `connect_cloud` →
/// `connect_on_main` → `channel_session::connect_socket`'s `Err` arm) left the
/// outgoing session marked deliberate by default — on the cloud channel that is
/// suppress-forever, so the PC could never reconnect on that channel again
/// short of an app restart (the same shape W8-2 fixed for LAN, now reproduced
/// for cloud one level up: no redial attempt marks it want-to-come-back). LAN
/// is unaffected (its release never depended on this flag); see
/// `session_gen::closing_gate`'s `transient` parameter for the decision this
/// feeds.
pub(super) fn rebuild_after_heartbeat_death(app: &AppHandle, channel: Channel) {
    let app = app.clone();
    std::thread::spawn(move || {
        forensic::record(
            "socket",
            &format!(
                "heartbeat death: emptying {} slot then ensure_dialed — new `open` owns the \
                 room-entering emit (Edge 1; session was not closing)",
                channel.tag()
            ),
        );
        mark_slot_transient(&app, channel);
        set_socket(&app, channel, None);
        ensure_dialed(&app, channel);
    });
}

/// D8 — releases the `bringing_up` slot on drop. `bring_up_and_connect` has
/// more than one return path (the dev-override short-circuit, the ordinary
/// end after a failed OR healthy bring-up), and a guard released BY HAND at
/// each one is exactly the kind of invariant a later-added early return
/// silently breaks. `Drop` runs no matter which path is taken.
struct BringUpGuard {
    app: AppHandle,
}

impl Drop for BringUpGuard {
    fn drop(&mut self) {
        let state: State<SidecarState> = self.app.state();
        state.release_bring_up();
    }
}

/// The blocking bring-up worker (runs on a thread). Honours the FLOWMIC_SERVER_URL
/// dev override, else drives crate::sidecar::io::bring_up, stores the child +
/// endpoint, emits the terminal status, connects the socket, and kicks the LAN
/// poll. On failure it manages a None socket (fail-loud — commands resolve to
/// false, never a silent dead socket).
///
/// Callers: `start()`, which claims `SidecarState::bringing_up` before
/// spawning the thread that runs this. This function's ONLY job regarding
/// that flag is to hold `_bring_up_guard` for its entire body so the flag
/// clears exactly once, whichever way this function returns (D8).
fn bring_up_and_connect(app: &AppHandle) {
    let _bring_up_guard = BringUpGuard { app: app.clone() };
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
    // D-B2L item 3: carried alongside the child so a LATER death (during the
    // health supervisor's watch, after this function has already returned)
    // can still be explained — see SidecarState::child_stderr_tail's doc
    // comment for the 0.2.50-shaped gap this closes.
    state.set_child_stderr_tail(up.stderr_tail.take());
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

// spawn_lan_poll moved to sidecar_lan_poll.rs (2026-09-02, file-size cap) —
// a child module so it keeps private access to SidecarState's accessors.
#[path = "sidecar_lan_poll.rs"]
mod sidecar_lan_poll;
use sidecar_lan_poll::spawn_lan_poll;

// The supervisor watch loop + its backoff/max policy moved to
// sidecar_supervisor.rs (2026-09-02, file-size cap) — same technique.
#[path = "sidecar_supervisor.rs"]
mod sidecar_supervisor;
use sidecar_supervisor::spawn_health_supervisor;

// ── commands ─────────────────────────────────────────────────────────────────

/// Read the current sidecar status for the device page.
#[tauri::command]
pub fn sidecar_state(state: State<'_, SidecarState>) -> SidecarStatusDto {
    dto(&state.phase_snapshot(), state.dialed_snapshot())
}

/// Retry the bring-up (error-card Retry button). Kills any prior child, re-emits
/// `resolving`, and restarts the worker thread. Returns the immediate (resolving)
/// status; the terminal status arrives async on the sidecar-state channel.
///
/// The R6 T-2 「cloud channel is active ⇒ ignore」 branch is GONE (owner 2026-07-30 ②).
/// It rested on the single-channel world where choosing cloud suspended the local
/// server; since GA-28 the LAN sidecar is always wanted (the `suspended` flag it
/// used to check no longer exists at all — see the file header), and now that the
/// channel select is deleted the user has no way to flip that flag back — so the
/// branch could only ever refuse a retry the user cannot otherwise obtain.
#[tauri::command]
pub fn sidecar_retry(app: AppHandle) -> SidecarStatusDto {
    let state: State<SidecarState> = app.state();
    state.kill_child(crate::exit_reason::SidecarKillCause::DevicePageRetry);
    forensic::record("sidecar", "retry requested (device page)");
    start(&app);
    dto(&Phase::Resolving, None)
}

#[cfg(test)]
#[path = "bring_up_guard_tests.rs"]
mod bring_up_guard_tests;

#[cfg(test)]
mod child_stderr_tail_tests {
    use super::*;
    use std::sync::Arc;

    /// D-B2L (2026-09-02 audit, sidecar supervisor leftovers item 3): before
    /// this plumbing existed, the post-handshake stderr reader thread kept
    /// filling a buffer for the child's whole life, but nothing outside
    /// io::bring_up() ever held a handle to it again once that function
    /// returned — so a LATER death (the health supervisor's job to notice)
    /// had no tail to report, only "it's gone". This proves the buffer
    /// SidecarState now holds actually reaches the caller, formatted.
    #[test]
    fn take_child_stderr_tail_reads_the_buffered_lines() {
        let state = SidecarState::new();
        let buf: io::SharedStderrTail = Arc::new(Mutex::new(vec![
            "Error: listen EADDRINUSE".to_string(),
            "    at Server.setupListenHandle".to_string(),
        ]));
        state.set_child_stderr_tail(Some(buf));

        let tail = state.take_child_stderr_tail();
        assert_eq!(
            tail.as_deref(),
            Some("Error: listen EADDRINUSE | at Server.setupListenHandle"),
            "both lines must reach the caller, joined the same way the handshake-exit path formats them"
        );
    }

    /// Taking clears it — a stale tail from a PREVIOUS child must never be
    /// attributed to the next one after a restart.
    #[test]
    fn take_child_stderr_tail_clears_after_reading() {
        let state = SidecarState::new();
        state.set_child_stderr_tail(Some(Arc::new(Mutex::new(vec!["boom".to_string()]))));
        assert!(state.take_child_stderr_tail().is_some());
        assert_eq!(
            state.take_child_stderr_tail(),
            None,
            "a second read after the first must not replay the previous child's words"
        );
    }

    /// Before any bring-up has completed a handshake, there is nothing to
    /// read — this must say so honestly (None), not fabricate an empty tail.
    #[test]
    fn no_buffer_ever_set_reads_as_none() {
        let state = SidecarState::new();
        assert_eq!(state.take_child_stderr_tail(), None);
    }
}

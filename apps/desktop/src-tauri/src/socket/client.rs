// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer: pc:register/pc:reconnect,
//     heartbeat, sys:ping/pong; reconnect ladder; auth:expired drain) + §2
//     (inject pipeline) + §3.5 F-3113 (focus:state mirror is GATED on a mobile
//     being present — the window title never goes on the wire in an empty room)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1/§3.2/§3.5
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth + injection paths) ***
//
// The desktop's socket.io client to server-core. On every (re)connection the
// `open` handler emits pc:reconnect{token} when a stored credential exists,
// else pc:register and persists the returned token — so reconnect is automatic
// and a restart re-pairs without user action. A dead token (reconnect ack error
// OR an auth:expired event) is CLEARED and re-registered rather than reconnect-
// looping forever. ⚠️ That register must NOT nest inside the reconnect-ack
// callback (A2 2026-08-11: never settles on rust_socketio 0.6; see emit_reconnect).
// inject:request runs the real three-stage pipeline and emits
// the TRUTHFUL inject:result (A-58 echo); control:key runs the six-key map
// (unknown kind → CONTROL_UNKNOWN_KIND, never injected); sys:ping is answered
// with sys:pong; a background pump emits heartbeat and — only while ≥1 mobile
// is present — the change-only focus:state mirror.
//
// EVERY event NAME comes from the events.rs constants — never an inline literal
// at a call site — so the protocol-whitelist lint's Rust scan stays clean.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rust_socketio::client::Client;
use rust_socketio::{ClientBuilder, Payload, TransportType};
use serde_json::Value;

use crate::error_codes;
use crate::events;
use crate::focus::{self, FocusStateMachine, FocusTracker, WinEventSource, WindowsWinEventSource};
use crate::forensic;
use crate::socket::admission::Admission;
use crate::socket::bridge::{self, BridgeSink};
use crate::socket::channel::Channel;
use crate::socket::credentials::Credentials;
use crate::socket::dedup::{session_deduper, SharedDeduper};
use crate::socket::fanout::{self, on_forward, on_forward_speaking, on_forward_tagged, PrimaryGate};
use crate::socket::local_inject::InjectHandles;
use crate::socket::pairing::{self, AuthFailureHook, Pairing, SharedCode, SharedCreds};
use crate::socket::pump;
use crate::socket::reconcile::Reconciler;
use crate::socket::speak_liveness::SpeakLiveness;
use crate::socket::inject_ops::{run_control_key, run_inject};
use crate::socket::{control_row, presence, row_transit, wire};

pub(in crate::socket) type SharedFsm = Arc<Mutex<FocusStateMachine>>;
pub(in crate::socket) type SharedDeadline = Arc<Mutex<Option<Instant>>>;
type SharedReconciler = Arc<Reconciler>;

/// FSM cooldown after an injection (07 §3: shields the just-injected window from
/// the app's own refocus-after-paste foreground events).
const FSM_COOLDOWN_MS: u64 = 300;
/// Hard cap on a SPEAKING lock measured from `audio:start` (ruling 2), in seconds.
/// If no injection ever resolves (delivery:'none', empty final, dropped link) the
/// watchdog force-releases the lock so it cannot wedge the inject target. The
/// production default is 32 s; `FLOWMIC_LOCK_TIMEOUT_SECS` overrides it for the
/// pull-cable smoke ONLY (so the watchdog fires within a scriptable window) — the
/// default and the release semantics are unchanged, this is a test seam mirroring
/// the existing FLOWMIC_SMOKE_ALLOWLIST / FLOWMIC_GOLDEN_HOLD_SECS envs.
const LOCK_HARD_TIMEOUT_SECS: u64 = 32;

pub(in crate::socket) fn lock_timeout() -> Duration {
    let secs = std::env::var("FLOWMIC_LOCK_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(LOCK_HARD_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Connection configuration.
pub struct SocketConfig {
    /// e.g. `http://127.0.0.1:41879`.
    pub url: String,
    /// PC display name shown to the paired mobile (pc:register.device_name).
    pub device_name: String,
    /// Where the pairing credential is persisted / loaded. R6 T-2: this is the
    /// per-CHANNEL slot (`socket::channel::credentials_path`) — a LAN device_token
    /// and a cloud one are different files and never meet.
    pub credentials_path: PathBuf,
    /// **G-13 (window B4-16)** — an OVERRIDE for the INJ-3/INJ-1 dedup table this
    /// session decides on. `None` (production, both channels) = this machine's
    /// one table, `dedup::machine_deduper()`; the per-channel ledger path this
    /// field replaced was the G-13 defect itself. Only the golden example sets
    /// it, to keep a smoke run off the developer's real ledger. See
    /// `dedup::session_deduper` and dedup.rs's SCOPE block.
    pub deduper: Option<SharedDeduper>,
    /// R6 T-2: the Cloud Key (account JWT) carried on the socket.io handshake as
    /// `auth:{jwt}` (04 §2). `None` for the LAN channel, which then sends NO auth
    /// object at all — byte-identical to the pre-T-2 handshake.
    pub jwt: Option<String>,
    /// R6 T-2: notified when the server refuses this desktop's identity (a
    /// `pc:register` ack error / `auth:expired`). Installed only for the cloud
    /// channel; `None` keeps the LAN clear-token-and-re-register behaviour.
    pub auth_failure: Option<AuthFailureHook>,
    /// Smoke-safety allowlist: when `Some`, the desktop performs a LIVE
    /// SendInput / control:key ONLY if the foreground window's process_name is
    /// in this list (case-insensitive); otherwise it declines to a cached/no-op
    /// so a test never types into an arbitrary window. Production leaves this
    /// `None` (inject into whatever the user has focused, by design).
    pub inject_foreground_allowlist: Option<Vec<String>>,
    /// WP-R2-2 frontend bridge. When `Some`, capsule-facing events (stt:*,
    /// audio:*, inject:result) and timeline broadcasts (history:*) are forwarded
    /// to the Vue windows through this sink. `None` in tests / the golden-path
    /// example (the socket core runs headless, tauri-free).
    pub bridge: Option<BridgeSink>,
    /// GA-28: which of the two resident channels this session IS. Used only to ask
    /// the shared [`Admission`] whether this session is currently primary — the
    /// credential slot is still chosen by the caller via `credentials_path`, so
    /// this field can never redirect a token to the wrong server.
    pub channel: Channel,
    /// GA-28/GA-29: the process-wide capsule-ownership latch, shared by BOTH
    /// channel sessions. `None` ⇒ no gate at all (single-socket callers — the
    /// headless tests and the golden example — keep the pre-GA-28 behaviour).
    pub admission: Option<Arc<Admission>>,
}

/// A live desktop socket session. Holding it keeps the connection (and the
/// heartbeat/focus pump) alive; dropping it disconnects.
pub struct DesktopSocket {
    /// Visible within the socket module so outbound.rs can emit on it.
    pub(in crate::socket) client: Client,
    /// GA-10: visible within the module so the rename verb can write the new
    /// identity back into the credential (see `outbound::rename_pc`).
    pub(in crate::socket) creds: SharedCreds,
    /// The short pairing code from the most recent pc:register ack. Transient
    /// (a mobile pairs against it), so it lives here, not in the persisted
    /// Credentials. `None` after a token-based reconnect (no fresh code issued).
    /// `pub(in crate::socket)` so the refresh verb in outbound.rs can update it.
    pub(in crate::socket) short_code: SharedCode,
    /// Number of DISTINCT mobiles currently in the room. GA-26: this is the
    /// Reconciler's presence-SET size, mirrored into an atomic so the pump and
    /// the capsule read it lock-free — nothing but the Reconciler writes it.
    mobile_count: Arc<AtomicUsize>,
    /// v0.2.4 — the SAME socket-level flag the pump reads, kept here so the
    /// current state can be PULLED as well as pushed.
    ///
    /// owner 2026-07-29 (device-page screenshot, 设备页截图): the device page sat at 「连接中…」("Connecting…") and the
    /// footer at 「未连接」("Not connected") while both sockets were open and registered. The pump
    /// forwards a CONNECTION frame only when the state CHANGES, and the forensic
    /// log put numbers on it — LAN and cloud both reached `connected=true` at
    /// 02:07:05.9, and the Vue window did not finish registering its listener
    /// until 02:07:07.0. Nothing changed after that, so nothing was ever sent
    /// again, and the UI stayed frozen at its initial `false` for the whole
    /// session. Deterministic, not flaky: Rust wins that race every time on this
    /// machine, which is why it was 「一直是这样」("it's always been this way").
    ///
    /// A push-only state with no way to ask is unrecoverable by construction.
    /// This field is what makes `connection_snapshot` possible.
    connected: Arc<AtomicBool>,
    /// RV-34 — the auth surface, kept so 「服务器认了我吗」("did the server recognize me") can be PULLED as well as
    /// pushed. `is_registered()` below reads its handshake judgment, not the token.
    /// `pub(in crate::socket)` since 0.2.66 so `outbound.rs` can reach the PCID cell
    /// it owns (same visibility the `client` / `creds` / `short_code` fields already
    /// carry, and for the same reason: the device-page verbs live in that sibling).
    pub(in crate::socket) pairing: Arc<Pairing>,
    /// 0.2.27 — the inject-decision state this session's `inject:request` handler runs
    /// on, so a LOCAL re-inject travels the identical path. Read by `socket::local_inject`
    /// (see there: a second FSM would be a second meaning for `injected`).
    pub(in crate::socket) inject: InjectHandles,
    stop: Arc<AtomicBool>,
    pump: Option<JoinHandle<()>>,
}

impl DesktopSocket {
    /// Whether THIS channel's socket is open right now (the `open`/`close`
    /// handlers own this flag). Distinct from [`is_registered`], which asks
    /// whether a token exists — a stored token survives a dropped socket, so
    /// reporting registration as connection is exactly the conflation that let
    /// the UI look plausible while being wrong.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// RV-34 — 「服务器在当前连接上认了我吗」("did the server recognize me on
    /// the current connection"), i.e. a `pc:register`/`pc:reconnect`
    /// ack came back ACCEPTED and has not been invalidated since.
    ///
    /// It used to be `creds.is_registered()`, which answers 「本机存着一个 token
    /// 吗」("does this machine have a token stored") — true forever after the first pairing, socket up or down, server
    /// willing or not. Every caller here wants the first question; the token
    /// question has exactly one legitimate reader (register-vs-reconnect, in
    /// `pairing.rs`) and it reads `Credentials` directly.
    pub fn is_registered(&self) -> bool {
        self.pairing.handshake_acked()
    }

    /// Block up to `timeout` for registration to complete. Returns whether it did.
    pub fn wait_registered(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.is_registered() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.is_registered()
    }

    /// A snapshot of the current credential (token/pc_id/room_uuid).
    pub fn credentials(&self) -> Credentials {
        self.creds.lock().map(|c| c.clone()).unwrap_or_default()
    }

    /// The short pairing code from the last fresh registration, if any.
    pub fn short_code(&self) -> Option<String> {
        self.short_code.lock().ok().and_then(|s| s.as_ref().map(|c| c.code.clone()))
    }

    // refresh_pairing_code (pc:refresh-code emit-with-ack) lives in outbound.rs
    // with the other main-window outbound verbs, keeping this audited core lean.

    /// Number of DISTINCT mobiles currently believed present in the room — the
    /// size of the reconciler's mobile_id set (GA-26), which is also what gates
    /// focus:state and drives the capsule's phonePresent, so all three agree.
    pub fn connected_mobiles(&self) -> usize {
        self.mobile_count.load(Ordering::SeqCst)
    }

    // Outbound verbs (settings:update / pc:*) live in outbound.rs and the local re-inject in
    // local_inject.rs — this file is the socket LIFECYCLE. `socket::timeline_ops`' four
    // timeline verbs are GONE (0.2.27): no server transcripts, nothing to address.

    /// Stop the pump and disconnect.
    pub fn disconnect(&mut self) {
        // F-3 Fix#1 — FIRST, and before the library is told anything: from here on
        // this session may not hand the server another `pc:register`/`pc:reconnect`.
        // `rust_socketio` 0.6's polling thread is a CLONE of the client, so the call
        // below cannot stop it, and its reconnect arm re-installs every handler —
        // including the `open` handler, whose whole job is to register. Ordering is
        // the point: set the flag before `client.disconnect()`, or the reconnect the
        // disconnect itself provokes races the flag. Full account, including why
        // this is correct under both branches of the still-open F-3 room-ownership
        // question, is at `socket::pairing::Pairing::begin_closing`.
        self.pairing.begin_closing();
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.client.disconnect();
        if let Some(h) = self.pump.take() {
            let _ = h.join();
        }
    }
}

impl Drop for DesktopSocket {
    fn drop(&mut self) {
        self.disconnect();
    }
}

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Connect to server-core and wire all handlers. Returns a live session.
///
/// Err is boxed: `rust_socketio::Error` is ≥136 bytes; keeping it unboxed
/// trips `clippy::result_large_err`. Call sites only Display the error.
pub fn connect(config: SocketConfig) -> Result<DesktopSocket, Box<rust_socketio::Error>> {
    // Forensics is on from the first line (07 §10: "新版必须第一天就带" — "a new
    // version must carry it from day one"). Idempotent;
    // observation only — a failed init eprintln's once and never blocks the connect.
    forensic::init_default();
    // The connect line names the credential SLOT (file name only) and whether a
    // Cloud Key rides along — the T-2 audit trail for "which channel is this, and
    // is it using the right token file". The key itself is NEVER logged: `head` is
    // its first 6 chars, i.e. the base64 of the fixed `{"alg":"HS256"…}` header.
    let key_head: String = match config.jwt.as_deref() {
        Some(j) => format!("set(head={})", j.chars().take(6).collect::<String>()),
        None => "none".to_string(),
    };
    // G-13: the dedup table this session decides on — this machine's one table
    // unless a caller overrode it (only the golden example does).
    let deduper: SharedDeduper = session_deduper(config.deduper);
    // …and its IDENTITY on the record. This is the real-machine test evidence
    // (判据) for G-13:
    // a dual-channel launch prints this line twice, and the two `dedup_table=`
    // addresses MUST be equal. Two different addresses = two tables = the cloud
    // leg is about to re-type what the LAN leg already typed. A boolean
    // 「是共享的吗」("is it shared") could not say that; a pointer either matches or it does not.
    forensic::record(
        "startup",
        &format!(
            "socket connect url={} device={:?} creds_file={:?} jwt={key_head} dedup_table={:p}",
            config.url,
            config.device_name,
            config.credentials_path.file_name().unwrap_or_default(),
            Arc::as_ptr(&deduper),
        ),
    );
    let creds: SharedCreds = Arc::new(Mutex::new(
        Credentials::load(&config.credentials_path)
            .unwrap_or_else(|| Credentials::fresh(&config.device_name)),
    ));
    let path = Arc::new(config.credentials_path.clone());
    let short_code: SharedCode = Arc::new(Mutex::new(None));
    let mobile_count = Arc::new(AtomicUsize::new(0));
    // GA-28: the shared capsule latch + this session's identity. Every handler that
    // reaches a user-visible surface asks `gate.open()`; presence/auth/liveness
    // handlers deliberately do not (a presence session must still register, answer
    // sys:ping and report joins — that is the entire point of keeping it resident).
    let admission = config.admission.clone();
    let my_channel = config.channel;
    let gate = PrimaryGate { admission: admission.clone(), channel: my_channel };
    // Presence reconciler (07 §6): shares `mobile_count` with the pump/focus
    // gating, owns the JOINED_SUPPRESS window + ReconcileGate.
    let reconciler: SharedReconciler = Arc::new(Reconciler::new(mobile_count.clone()));
    let allowlist = Arc::new(config.inject_foreground_allowlist);
    // WP-R2-2 frontend bridge — cloned (Arc) into each forwarding handler; `None`
    // in headless test/example builds so the socket core is unchanged there.
    let bridge = config.bridge;
    // Socket-level connected flag: set by open, cleared by close/error, read by
    // the pump so it forwards a CONNECTION transition to the frontend.
    let connected = Arc::new(AtomicBool::new(false));

    // ── focus layer: the FSM is the single source of truth for the inject
    //    target (deliverable A). Seed it with the CURRENT foreground, then
    //    install the SetWinEventHook tracker; the pump thread drains its events
    //    into the FSM (SpeakingLocked drops them — the lock invariant). ──────
    let fsm: SharedFsm = Arc::new(Mutex::new(FocusStateMachine::new(FSM_COOLDOWN_MS)));
    let lock_deadline: SharedDeadline = Arc::new(Mutex::new(None));
    let liveness = SpeakLiveness::new(); // F3: 「音频还在流吗」("is the audio still flowing") for the STATE watchdog
    if let Some(seed) = WindowsWinEventSource.seed_current() {
        let n = now_millis().max(0) as u64;
        let _ = fsm.lock().unwrap().handle(seed, n);
    }
    // Installs the OS hook on THIS thread (in the app: the Tauri main thread,
    // whose event loop dispatches the OUTOFCONTEXT callback that fills the
    // channel). The tracker is moved into the pump, which drains + unhooks it.
    let tracker = FocusTracker::start(WindowsWinEventSource);

    // The auth surface (register/reconnect + the refusal report) in one owner.
    // RV-新C: it also carries THIS session's channel + the shared capsule latch, so a
    // handshake ack's `connectedMobiles` roster can say which channel has a phone on
    // it. Before this, that roster reached the presence Reconciler only, and a phone
    // already in the room at startup left `primary` on the construction default for
    // the whole session — see Admission::observe_roster.
    let pairing = Pairing::new(
        creds.clone(),
        path.clone(),
        short_code.clone(),
        config.auth_failure.clone(),
        my_channel,
        admission.clone(),
        // W8-2: the process-wide construction counter — what lets an EARLIER
        // closing session on this channel see that this one replaced it (and a
        // closing session with no replacement see that nobody did).
        crate::socket::session_gen::process_generations(),
    );

    let mut builder = ClientBuilder::new(config.url)
        .transport_type(TransportType::Websocket)
        .reconnect(true)
        .reconnect_on_disconnect(true)
        .reconnect_delay(1_000, 30_000);

    // ── R6 T-2: the Cloud Key rides the handshake as `auth:{jwt}` (04 §2). The LAN
    //    channel passes `None` and NO auth object is attached at all, so its
    //    handshake stays byte-identical to every shipped build. ──
    if let Some(jwt) = config.jwt {
        builder = builder.auth(serde_json::json!({ "jwt": jwt }));
    }

    // ── open: register or reconnect (fires on initial connect AND each reconnect) ──
    {
        let p_o = pairing.clone();
        let rec_o = reconciler.clone();
        let conn_o = connected.clone();
        builder = builder.on("open", move |_payload, socket| {
            conn_o.store(true, Ordering::SeqCst);
            // RV-34: a NEW connection carries none of the previous one's standing. The
            // ack that confirmed the last socket says nothing about this one, and the
            // handshake below is what has to earn the claim again — so the judgment
            // starts false here, which is also what arms the pump's watchdog.
            p_o.clear_handshake_ack("new socket — the handshake starts over");
            // 「本机存着 token 吗」("does this machine have a token stored") is the
            // ONE question that decides which frame to
            // send, and it is the only thing this variable is allowed to answer.
            let has_token = p_o.creds.lock().map(|c| c.is_registered()).unwrap_or(false);
            eprintln!("[flowmic] socket open (has_token={has_token})");
            forensic::record("socket", &format!("open (has_token={has_token})"));
            // connected rising edge → pc:reconnect (07 §6); a fresh session registers.
            if has_token {
                pairing::emit_reconnect(&socket, &p_o, &rec_o);
            } else {
                pairing::emit_register(&socket, &p_o, &rec_o);
            }
        });
    }

    // ── close / error: mark disconnected so the pump forwards the transition;
    //    the settings/timeline queues flush again on the next open. ──
    {
        let conn_c = connected.clone();
        let p_c = pairing.clone();
        builder = builder.on("close", move |_payload, _socket| {
            conn_c.store(false, Ordering::SeqCst);
            // RV-34: the connection the server confirmed is gone. The TOKEN survives
            // (that is the point of a token, and the reconnect ladder needs it), but
            // 「服务端认了我」("the server recognized me") does not survive the socket it was granted on — that
            // conflation is what put `connected=false registered=true` in the log.
            p_c.clear_handshake_ack("socket closed");
            eprintln!("[flowmic] socket close");
            forensic::record("socket", "close");
        });
    }

    // ── capsule fan-out (stt:*) + timeline fan-out (history:*) + settings peer
    //    broadcast — each forwarded verbatim to the Vue windows (07 §4/§9). ──
    // F3: these three are ALSO the SPEAKING-lock watchdog's liveness evidence (fanout::on_forward_speaking).
    builder = on_forward_speaking(builder, events::STT_INTERIM, bridge::channel::STT_INTERIM, bridge.clone(), gate.clone(), liveness.clone());
    builder = on_forward_speaking(builder, events::STT_FINAL, bridge::channel::STT_FINAL, bridge.clone(), gate.clone(), liveness.clone());
    builder = on_forward_speaking(builder, events::STT_LEVEL, bridge::channel::STT_LEVEL, bridge.clone(), gate.clone(), liveness.clone());
    // R6-R2: forward engine health to the capsule diagnostic (honest STT row).
    builder = on_forward(builder, events::STT_ENGINE_STATUS, bridge::channel::STT_ENGINE_STATUS, bridge.clone(), gate.clone());
    // RV-01: the timeline frames go through the TAGGED forward — a row whose server is
    // unknown cannot be addressed later.
    // owner 2026-07-30 ①: and they are NOT primary-gated. The timeline is「投递到这台
    // PC 的所有消息」("every message delivered to this PC"), so both channels' rows reach the window, each carrying its own
    // stamp; the capsule's incoming-record (转入记录) strip narrows to one room in the capsule
    // (capsule/recent acceptRecentChannel), which is the surface that needs it.
    //
    // ⚠️ NEITHER FORWARD CAN FIRE — the server stores no transcripts and answers every
    // `history:*` with `HISTORY_SYNC_RETIRED` (owner architecture ruling, docs/decisions/
    // 2026-07-31-no-cloud-sync-for-phone-pc.md); `history:list-result` went with its
    // pull. Kept wired for an un-redeployed relay, and because the frontend handlers
    // they feed are the repo's only「入站行 → 时间线行/胶囊行」("inbound row →
    // timeline row/capsule row") implementation. ⚠️ The
    // window's rows do NOT come from here: `history:updated`'s real producer is LOCAL —
    // `row_transit::mint_row`, below, which builds a row from each delivery frame.
    builder = on_forward_tagged(builder, events::HISTORY_UPDATED, bridge::channel::HISTORY_UPDATED, bridge.clone(), my_channel);
    builder = on_forward_tagged(builder, events::HISTORY_DELETED, bridge::channel::HISTORY_DELETED, bridge.clone(), my_channel);
    builder = on_forward(builder, events::SETTINGS_UPDATED, bridge::channel::SETTINGS_UPDATED, bridge.clone(), gate.clone());

    // ── auth:expired: dead session — clear token, drain, re-register ──
    {
        let p_e = pairing.clone();
        let rec_e = reconciler.clone();
        builder = builder.on(events::AUTH_EXPIRED, move |_payload, socket| {
            // RV-34: the server just said this session is dead. Cleared for BOTH
            // channels and BEFORE the cloud branch returns — the UI must not keep
            // claiming 「已挂号」("already registered") on a session its own server disowned. On cloud the
            // hook tears the socket down (cloud::auth_failure_hook → drop_socket), so
            // nothing is left for the pump's watchdog to knock on.
            p_e.clear_handshake_ack(events::AUTH_EXPIRED);
            // Cloud channel (hook installed): the session rested on the account
            // JWT, so re-registering with the SAME dead Cloud Key would just be
            // refused again. Report it and stop — the shell clears the key and the
            // device page says so out loud (T-2 ⑤: no silent fallback to LAN).
            if p_e.auth_failure.is_some() {
                p_e.report_refusal(events::AUTH_EXPIRED, events::AUTH_EXPIRED);
                return;
            }
            eprintln!("[flowmic] auth:expired — clearing token, re-registering");
            forensic::record("socket", "auth:expired — clearing token, re-registering");
            if let Ok(mut c) = p_e.creds.lock() {
                c.clear_token();
                let _ = c.save(&p_e.path);
            }
            rec_e.reset();
            pairing::emit_register(&socket, &p_e, &rec_e);
        });
    }

    // ── audio:start fan-out (S→PC, F-2375) → SPEAKING lock ──
    // The server additively re-emits the mobile's audio:start to the paired PC
    // (audio.handler). F-2344: capture the LIVE foreground here — the hook ring
    // can be stale (clicking a control inside an already-foreground window fires
    // no EVENT_SYSTEM_FOREGROUND). Arm the 32s hard-timeout watchdog.
    {
        let fsm_a = fsm.clone();
        let dl_a = lock_deadline.clone();
        let br_a = bridge.clone();
        let g_a = gate.clone();
        let lv_a = liveness.clone();
        builder = builder.on(events::AUDIO_START, move |payload, _socket| {
            lv_a.signal(); // F3: the utterance's first liveness signal (speak_liveness.rs)
            // GA-28: a presence channel's utterance must not take THIS machine's
            // focus lock — the phone driving it is not the capsule's owner.
            if !g_a.open() {
                return;
            }
            // Capsule surface trigger (07 §4, F-2375): the server only fans out
            // audio:start for delivery:'inject' utterances (delivery:'none' is
            // gated server-side — the capsule "不浮现" ("never surfaces") red line's first gate), so
            // any audio:start here is a real utterance the HUD should surface for.
            if let Payload::Text(vals) = &payload {
                if let Some(v) = wire::first_arg(vals) {
                    bridge::forward(&br_a, bridge::channel::AUDIO_START, v.clone());
                }
            }
            match focus::current_foreground_target() {
                Some((hwnd, title, app)) => {
                    fsm_a.lock().unwrap().force_lock(hwnd, app.clone(), title);
                    *dl_a.lock().unwrap() = Some(Instant::now() + lock_timeout());
                    eprintln!("[flowmic] audio:start → SPEAKING lock hwnd={hwnd} app={app:?}");
                    forensic::record("lock", &format!("audio:start → force_lock hwnd={hwnd} app={app:?}"));
                }
                None => {
                    eprintln!(
                        "[flowmic] audio:start → no live foreground to lock (a following inject caches)"
                    );
                    forensic::record("lock", "audio:start → no live foreground to lock");
                }
            }
        });
    }

    // ── audio:stop / audio:pause / audio:resume (S→PC) → CAPSULE-ONLY edges ──
    // Whole family moved VERBATIM to socket/fanout.rs (800-line cap) — see
    // `on_capsule_audio_edges` there for Ruling 2 (audio:stop never releases the
    // lock) and for card F1 / owner ruling ① (pause ≠ leave: capsule only, never
    // admission / presence / the room / the SPEAKING lock).
    builder = fanout::on_capsule_audio_edges(builder, bridge.clone(), gate.clone());

    // ── inject:request → dedup → FSM target → pipeline → truthful result ──
    {
        let allow = allowlist.clone();
        let fsm_i = fsm.clone();
        let dl_i = lock_deadline.clone();
        let dedup_i = deduper.clone();
        let br_i = bridge.clone();
        let g_i = gate.clone();
        builder = builder.on(events::INJECT_REQUEST, move |payload, socket| {
            // GA-28/GA-29: only the capsule owner's channel may type into this
            // machine. A non-primary inject is REFUSED, not silently swallowed —
            // the truthful `inject:result` below is what the phone acts on, and a
            // missing result would leave its entry stuck 「投递中」("delivering") forever.
            if !g_i.open() {
                if let Payload::Text(vals) = &payload {
                    if let Some((obj, req)) = wire::first_arg(vals)
                        .and_then(|o| wire::parse_inject_request(o).map(|r| (o, r)))
                    {
                        // `mode` is a required enum of three delivery PATHS and
                        // none of them describes「什么都没试」("nothing was even
                        // attempted"). The truth is carried
                        // by ok:false + the error code; the token only has to keep
                        // the server's mapping honest — `cached` would be read as
                        // 「已缓存，可补投」("cached, can be re-delivered") (a lie: nothing was kept), so anything
                        // NOT `cached` is the correct choice and it maps to
                        // status='failed' in relay.handler. ⚠️ Correction (card F2, 卡
                        // F2): the last sentence originally read
                        // 「the mobile displays none of it」, which grep disproves —
                        // the mobile once used it to judge
                        // 「未投递 vs 待投递」("not delivered vs. pending delivery"),
                        // violating an owner ruling. **A placeholder — downstream must
                        // not treat it as a criterion.**
                        // 🔴 IJ-01 — the `FocusObservation::default()` below is a
                        // RULING, not a gap: an ADMISSION refusal has not looked at a
                        // single window, so naming one would invent a place (same
                        // error the RV-83 branch refuses to make in inject_ops.rs).
                        let refused = wire::build_inject_result(
                            false,
                            "sendinput",
                            Some(error_codes::INJECT_NOT_PRIMARY),
                            None,
                            "",
                            &req,
                            wire::FocusObservation::default(),
                        );
                        forensic::record(
                            "admission",
                            &format!(
                                "inject:request REFUSED — channel not primary (request_id={:?})",
                                req.request_id
                            ),
                        );
                        // Ruling two (裁定二) — a REFUSAL is still a result, so it is still a row.
                        // The message reached this PC and was not typed into it, and
                        // 「时间线＝投递到这台 PC 的所有消息」("timeline = every
                        // message delivered to this PC") (owner 2026-07-30 ①).
                        row_transit::mint_row(&br_i, my_channel, obj, &req, Some(refused.clone()));
                        let _ = socket.emit(events::INJECT_RESULT, refused);
                    }
                }
                return;
            }
            // owner 2026-07-29:「其它几次都返回：电脑没有回应」("the other times
            // it all came back: the computer did not respond"). That message is the
            // phone's 20 s watchdog, i.e. THIS machine never answered — and until
            // now nothing recorded whether the frame even arrived, so 「没到桌面」
            // ("didn't reach the desktop")
            // and 「到了但被丢掉」("arrived but was dropped") were indistinguishable in the record. Every
            // arrival is now stamped BEFORE any decision, and each of the two
            // silent drops below says so.
            let Payload::Text(vals) = payload else {
                forensic::record(
                    "inject",
                    "inject:request arrived as a NON-TEXT payload — dropped with no result",
                );
                return;
            };
            let Some(obj) = wire::first_arg(&vals) else {
                forensic::record("inject", "inject:request arrived EMPTY — dropped with no result");
                return;
            };
            let src = obj.get("source").and_then(Value::as_str).unwrap_or("?");
            let rid = obj.get("request_id").and_then(Value::as_str).unwrap_or("-");
            let bytes = obj.get("image_b64").and_then(Value::as_str).map_or(0, str::len);
            forensic::record(
                "inject",
                &format!("inject:request ARRIVED source={src} request_id={rid} image_b64_chars={bytes}"),
            );
            let Some(req) = wire::parse_inject_request(obj) else {
                forensic::record(
                    "inject",
                    "inject:request UNPARSEABLE (no `text` field?) — dropped with no result",
                );
                return;
            };
            // Ruling one (裁定一) — THE ROW IS MINTED HERE, AFTER the pipeline
            // resolved, so it is
            // born carrying the true (真) verdict and the 「还没等到判决」
            // ("hasn't gotten a verdict yet") row is never created
            // (socket::row_transit, which also records the dedup case). Minting is
            // wired INTO the expression that produces the result so the two cannot
            // drift apart; None = an INJ-1 duplicate → no result frame AND no row.
            let Some(minted) = row_transit::mint_row(
                &br_i,
                my_channel,
                obj,
                &req,
                run_inject(&req, &allow, &fsm_i, &dl_i, &dedup_i),
            ) else {
                return;
            };
            // Truth to the frontend (the capsule renders just_injected; the timeline
            // stamps the row's delivery target — 07 §4/§9) and then to the server
            // (A-58). The BRIDGE copy carries three client-local stamps that the wire
            // frame must not; `row_transit::forward_verdict` states why each exists.
            row_transit::forward_verdict(&br_i, my_channel, &req, &minted);
            let _ = socket.emit(events::INJECT_RESULT, minted.result);
        });
    }

    // ── control:key → six-key map (unknown → CONTROL_UNKNOWN_KIND) ──
    {
        let allow = allowlist.clone();
        let fsm_c = fsm.clone();
        let g_c = gate.clone();
        let br_c = bridge.clone();
        builder = builder.on(events::CONTROL_KEY, move |payload, _socket| {
            // The frame has to be read BEFORE the admission gate now, because a
            // refusal mints a row too and a row needs the kind. Nothing else moved:
            // no key is pressed on a non-primary channel (the gate below is still
            // evaluated before `run_control_key`).
            let Payload::Text(vals) = payload else { return };
            let Some(obj) = wire::first_arg(&vals) else { return };
            let Some(kind) = wire::parse_control_kind(obj) else { return };
            // REQ-12-13 — WHICH PHONE pressed it (vol. 04 F-3115). `None` on an older
            // phone or across an older relay; the row then says it cannot name its
            // sender rather than guessing one.
            let label = wire::parse_device_label(obj);
            // Same rule as inject: only the capsule owner's channel may press keys
            // on this machine. control:key has NO result frame in the protocol, so
            // there is nothing to report ON THE WIRE — the refusal is recorded
            // locally instead of inventing a wire answer that does not exist.
            //
            // 🔴 REQ-12-13: it is also MINTED, for the same reason a refused
            // inject:request is (row_transit ruling two, 裁定二) — the press really did arrive at
            // this PC and really did nothing, and both halves have to be visible.
            // Only for a CHORD key: a `punct_*` press is out of this card's scope
            // (vol. 15 §2.0-e), and `is_chord_key` is what keeps the two apart here.
            if !g_c.open() {
                forensic::record("admission", "control:key ignored — channel not primary");
                if crate::inject::key_sequence_for(&kind).is_some() {
                    control_row::mint_control_row(
                        &br_c,
                        my_channel,
                        &kind,
                        control_row::ControlOutcome::NotPrimary,
                        label.as_deref(),
                    );
                }
                return;
            }
            if let Some(outcome) = run_control_key(&kind, &allow, &fsm_c) {
                control_row::mint_control_row(&br_c, my_channel, &kind, outcome, label.as_deref());
            }
        });
    }

    // ── sys:ping → sys:pong ──
    builder = builder.on(events::SYS_PING, move |payload, socket| {
        if let Payload::Text(vals) = payload {
            if let Some(nonce) = wire::first_arg(&vals)
                .and_then(|v| v.get("nonce"))
                .and_then(Value::as_str)
            {
                let _ = socket.emit(events::SYS_PONG, wire::build_sys_pong(nonce));
            }
        }
    });

    // ── mobile presence (pc:mobile-joined / pc:mobile-left) → the presence SET
    //    that gates focus:state (F-3113) + the GA-28/GA-29 capsule admission ──
    // Whole family moved VERBATIM to socket/presence.rs (800-line cap, the same
    // move that produced fanout.rs / pump.rs / inject_ops.rs) — see
    // `on_mobile_presence` there for GA-26 (presence is keyed by the frame's
    // `mobile_id`, a SET and not a counter) and for why a REFUSED second phone is
    // told to go away on the wire instead of being left recording into a capsule
    // it will never own.
    builder = presence::on_mobile_presence(builder, reconciler.clone(), admission.clone(), my_channel);

    let client = builder.connect().map_err(Box::new)?;

    // W8-2: only NOW does this session count as a successor — after the dial
    // succeeded. Marking at `Pairing::new` would let a FAILED dial silence every
    // earlier closing session forever on the strength of a session that was never
    // born (the exact state the counter exists to end).
    pairing.mark_constructed();

    // ── pump (socket::pump): drain focus events → FSM, 32s SPEAKING-lock watchdog,
    //    heartbeat, change-only mobile-gated focus:state mirror, CONNECTION forward.
    //    The tracker is moved into the pump (dropping it unhooks the WinEvent). ──
    let stop = Arc::new(AtomicBool::new(false));
    let pump = pump::spawn(
        client.clone(),
        creds.clone(),
        mobile_count.clone(),
        stop.clone(),
        fsm.clone(),
        lock_deadline.clone(),
        bridge.clone(),
        connected.clone(),
        tracker,
        my_channel,
        admission.clone(),
        // RV-26: the pump's register watchdog re-emits pc:register when this
        // socket's ack is lost while the connection stays up — the `open` handler
        // above is otherwise the ONLY sender, and it only runs on a connection edge.
        // RV-34: the pump ALSO reads this handle's handshake judgment for the
        // CONNECTION frame, the tray and the focus:state gate.
        pairing.clone(),
        // RV-08: the watchdog's re-emitted pc:register carries a roster in its ack
        // like every other register does, so it needs the same presence set.
        reconciler.clone(),
        // F3: the audio-liveness clock the handlers above feed, for the STATE watchdog.
        liveness,
    );

    Ok(DesktopSocket {
        client,
        creds,
        short_code,
        mobile_count,
        connected,
        pairing,
        // The SAME four handles the `inject:request` handler closed over above —
        // cloned Arcs, not copies of the state (see InjectHandles).
        inject: InjectHandles {
            allowlist: allowlist.clone(),
            fsm: fsm.clone(),
            lock_deadline: lock_deadline.clone(),
            deduper: deduper.clone(),
        },
        stop,
        pump: Some(pump),
    })
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod client_tests;

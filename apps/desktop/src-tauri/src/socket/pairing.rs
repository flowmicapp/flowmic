// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:register → token; pc:reconnect{token})
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer: if a token is stored,
//     reconnect; otherwise register; after a dead token is cleared, re-register — must never loop forever)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-2 ⑤ (cloud Key invalidation fail-loud)
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth) — reviewable in isolation ***
//
// The register / reconnect emit pair, split out of client.rs (which sits at the
// file-size cap) so the auth handshake is one small auditable unit.
//
// Behaviour is the WP-R2-2 original except for one added truth: a `pc:register`
// ack that carries an `error` used to be dropped on the floor — the desktop then
// simply never registered and the UI showed a bare "not connected" with no reason. It is
// now recorded AND reported to the optional [`AuthFailureHook`], which is how the
// cloud channel learns its Cloud Key was refused (04 §2 pins the handshake to
// NEVER reject, so an account-level failure can only surface on this ack).
//
// The auth failure surfaces are deliberately NOT conflated:
//   • `pc:reconnect` ack error `AUTH_TOKEN_EXPIRED` → the ACCOUNT credential this
//     socket presented at handshake has lapsed (#6 zombie-room gate, server
//     pc.handler). The hook fires (the shell clears the Cloud Key and drops the
//     socket); the PAIRING credential is deliberately left alone — a 7-day key
//     lapse must not force every phone to re-pair (same ruling shell/cloud.rs
//     already applies on live-socket auth:expired). ONLY EXPIRED routes this
//     way: the server answers AUTH_TOKEN_INVALID for BOTH a dead device token
//     and a garbage jwt (collision pinned by the server test
//     pc-reconnect-account-auth), so INVALID must keep the recovery meaning.
//   • any other `pc:reconnect` ack error → the DEVICE token is dead → clear it,
//     re-register (both channels, no hook — normal recovery, not a refusal);
//   • `pc:register` ack error   → the ACCOUNT identity was refused (saas
//     resolveActingUser) → the hook fires and the shell clears the Cloud Key.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rust_socketio::client::Client;
use rust_socketio::{Payload, RawClient};
use serde_json::Value;

use crate::events;
use crate::forensic;
use crate::socket::admission::Admission;
use crate::socket::channel::Channel;
use crate::socket::credentials::Credentials;
use crate::socket::reconcile::Reconciler;
use crate::socket::roster_apply::apply_connected_mobiles;
use crate::socket::session_gen::{closing_gate, ClosingGate, SessionGenerations};
use crate::socket::wire;

pub type SharedCreds = Arc<Mutex<Credentials>>;

/// GA-18 — the cached pairing code AND when it dies.
///
/// The 5-min TTL is the server's (short-code governor); the desktop must not
/// re-derive it, or the modal's countdown and the code the phone can actually
/// use drift apart. So every ack that MINTS a code carries `expires_in_ms`, and
/// it is converted to a local deadline the moment it lands — a duration parked
/// in a field would silently keep meaning "5 minutes from now" forever.
///
/// `expires_at: None` means the server sent no TTL (pre-GA-18 sidecar): the
/// modal then shows its static "valid for 5 minutes" line instead of a countdown it
/// cannot back up.
#[derive(Clone, Debug)]
pub struct ShortCodeState {
    pub code: String,
    pub expires_at: Option<Instant>,
}

impl ShortCodeState {
    pub fn new(code: String, expires_in_ms: Option<u64>) -> Self {
        Self {
            code,
            expires_at: expires_in_ms.map(|ms| Instant::now() + Duration::from_millis(ms)),
        }
    }

    /// Milliseconds left at `now`, saturating at 0 (an expired code reports 0,
    /// never a negative or a wrapped-around huge number).
    pub fn remaining_ms_at(&self, now: Instant) -> Option<u64> {
        self.expires_at
            .map(|deadline| deadline.saturating_duration_since(now).as_millis() as u64)
    }

    pub fn remaining_ms(&self) -> Option<u64> {
        self.remaining_ms_at(Instant::now())
    }
}

pub type SharedCode = Arc<Mutex<Option<ShortCodeState>>>;

/// 0.2.66 — the relay's PUBLIC ADDRESSING id for this PC, cached per SESSION.
///
/// Deliberately NOT a field on [`ShortCodeState`] although both ride the register
/// ack: two questions, two lifetimes. The code is a 5-minute secret a refresh
/// REPLACES; the PCID is row-stable (design §4). One cell would mean either a
/// refresh can erase the PCID, or a reconnect ack — which mints no code — has to
/// invent one to carry a PCID home.
pub type SharedPcid = Arc<Mutex<Option<String>>>;

/// Notified when the SERVER refuses this desktop's identity on a `pc:register`
/// ack, or when it emits `auth:expired`. The argument is the wire error code
/// (`AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` / a registry code) or
/// `"auth:expired"` for the event. Installed ONLY for the cloud channel; LAN
/// leaves it `None` and keeps the historical behaviour byte for byte.
pub type AuthFailureHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Codes that mean "the account identity behind this connection is not good"
/// (04 §3.1 / server `resolveActingUser`), as opposed to a transient or
/// payload-level registry failure.
pub fn is_account_auth_failure(code: &str) -> bool {
    matches!(code, "AUTH_TOKEN_EXPIRED" | "AUTH_TOKEN_INVALID")
}

/// Everything the register/reconnect emits share. Bundled so each socket handler
/// clones ONE Arc instead of four, and so the auth surface has a single owner.
pub struct Pairing {
    pub creds: SharedCreds,
    pub path: Arc<PathBuf>,
    pub short_code: SharedCode,
    /// 0.2.66 — see [`SharedPcid`]. Created in [`Pairing::new`] rather than passed
    /// in: nothing outside may seed it, so the only way a PCID exists is that an ack
    /// said so. WRITTEN only by [`Pairing::adopt_pcid`] (register / reconnect);
    /// READ by `DesktopSocket::pcid` in `outbound.rs`, which is the device page's pull.
    pub pcid: SharedPcid,
    pub auth_failure: Option<AuthFailureHook>,
    /// RV-新C — WHICH of the two resident channels this handshake belongs to.
    ///
    /// Read for exactly one purpose: labelling the ack's `connectedMobiles` roster
    /// with the channel it describes before it is handed to the capsule latch (see
    /// [`apply_connected_mobiles`]). It can NEVER redirect a credential — the token
    /// file is chosen by the caller through `path`, which this field does not touch.
    /// (`pub(super)` since the roster funnel moved to `roster_apply.rs` at the
    /// 800-line cap — same reader, new file; nothing else may write it.)
    pub(super) channel: Channel,
    /// RV-新C — the process-wide capsule latch, shared by BOTH sessions. `None` in
    /// headless / single-socket callers (tests, the golden example), which then behave
    /// byte-for-byte as before: no roster ever reaches a latch that does not exist.
    /// (`pub(super)` for `roster_apply.rs`, same note as [`Self::channel`].)
    pub(super) admission: Option<Arc<Admission>>,
    /// RV-34 — "did the server recognize me on **this** connection". See [`Pairing::handshake_acked`];
    /// private so the only ways to move it are the two verbs below, which are the
    /// only two events that can legitimately answer that question.
    handshake_acked: AtomicBool,
    /// F-3 Fix#1 — "this session is being torn down". One-way: false → true, never back.
    /// See [`Pairing::begin_closing`] for what it is defending against and why the
    /// flag has to live on the auth surface rather than on the socket handle.
    closing: AtomicBool,
    /// W8-2 — the shared per-channel construction counter and THIS session's
    /// number in it (0 until [`Pairing::mark_constructed`]). Together they answer
    /// the one question the closing latch could not: "has anyone taken over for me".
    generations: Arc<SessionGenerations>,
    generation: AtomicU64,
    /// W8-2 — when [`Pairing::begin_closing`] first ran, so a close that never
    /// completed can be recognised as STALE from a live handler.
    closing_since: Mutex<Option<Instant>>,
    /// W8-2 — how many handshakes the closing latch has swallowed on this session
    /// (forensic evidence + the attempt arm of the release decision).
    suppressed_handshakes: AtomicU32,
}

impl Pairing {
    pub fn new(
        creds: SharedCreds,
        path: Arc<PathBuf>,
        short_code: SharedCode,
        auth_failure: Option<AuthFailureHook>,
        channel: Channel,
        admission: Option<Arc<Admission>>,
        generations: Arc<SessionGenerations>,
    ) -> Arc<Self> {
        Arc::new(Self {
            creds,
            path,
            short_code,
            pcid: Arc::new(Mutex::new(None)),
            auth_failure,
            channel,
            admission,
            // A fresh session has NOT been confirmed by anyone yet — not even when a
            // token was just loaded off disk. That is the whole point (RV-34).
            handshake_acked: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            generations,
            generation: AtomicU64::new(0),
            closing_since: Mutex::new(None),
            suppressed_handshakes: AtomicU32::new(0),
        })
    }

    /// W8-2 — this session finished constructing. Stamps its generation and
    /// advances the shared counter — what tells every EARLIER closing session on
    /// this channel that its replacement is up. One production caller:
    /// `socket::connect`, AFTER `builder.connect()` succeeded. Deliberately not
    /// `Pairing::new`: a session whose dial FAILS must not count as a successor,
    /// or a failed redial would re-create the very W8-2 state this counter ends.
    pub(super) fn mark_constructed(&self) {
        self.generation
            .store(self.generations.constructed(self.channel), Ordering::SeqCst);
    }

    /// F-3 Fix#1 — this session is being torn down; it must never hand the server
    /// another handshake. One-way and idempotent.
    ///
    /// WHAT IT DEFENDS AGAINST (vendored `rust_socketio` 0.6.0, read, not assumed —
    /// `src/client/client.rs`, `poll_callback` / `reconnect` / `do_reconnect`):
    ///   · `poll_callback` spawns its polling thread from a CLONE of the `Client`,
    ///     so `Client::disconnect()` on our handle does not stop that thread;
    ///   · there is no shutdown flag anywhere in it — the loop ends only when the
    ///     iterator's `RwLock` is poisoned;
    ///   · on a transport break the same thread calls `reconnect() → do_reconnect()
    ///     → builder.clone().connect_raw()`, i.e. it RE-INSTALLS every handler this
    ///     module registered, including `open`.
    /// ⇒ A session we believe we closed can still fire `open` afterwards, and the
    /// `open` handler's whole job is to (re-)register with the server. Without this
    /// flag a dying session can take the room slot back from the live one.
    ///
    /// WHY IT LIVES ON `Pairing` RATHER THAN ON THE SOCKET HANDLE: `pc:register` /
    /// `pc:reconnect` leave this process through exactly two functions — the two at
    /// the bottom of this file — and `grep -rn 'PC_REGISTER\|PC_RECONNECT'` over
    /// `apps/desktop/src-tauri/src` finds no other emitter (the only other hits are
    /// the two `events.rs` definitions and the whitelist). Guarding the funnel
    /// covers all five call sites by construction, including `pump.rs`'s RV-26
    /// register watchdog; guarding the `open` handler would have covered one and
    /// left the enumeration to be re-done by hand next time a caller appears.
    ///
    /// 🔴 IT IS CORRECT UNDER BOTH BRANCHES OF THE OPEN F-3 QUESTION (which session
    /// owns the room after a zombie re-registers — see the W9 ledger §4.1-bis, where
    /// that half is [unverified]). If the server hands the room to the LAST registrant,
    /// this stops the theft; if it keeps the FIRST, the suppressed frame was a no-op.
    /// Either way a session on its way out has nothing true to say to the server.
    /// This is why it can land before the fork is decided.
    ///
    /// The ONLY production caller is `DesktopSocket::disconnect`, which is reached
    /// only from `impl Drop for DesktopSocket` (client.rs) — so a `Pairing` that has
    /// begun closing belongs to a session that is being dropped and will never
    /// legitimately register again. `socket::connect` builds a fresh `Pairing` per
    /// session, so this flag is never reused across connections.
    ///
    /// 🔴 W8-2 (2026-08-10, real machine) — the sentence above hides an assumption
    /// that failed: "will never legitimately register again" is only true while a
    /// SUCCESSOR session exists to register instead. The replacement rides
    /// `run_on_main_thread` + one un-retried dial, and on the real machine it never
    /// landed — the only session the process had answered every fresh `open` with
    /// the suppression line, and the PC vanished from the server until an app
    /// restart. The latch was CORRECT every time it fired; missing was a local
    /// watchdog for "closing, and nobody ever came" — [`Pairing::handshake_gate`].
    /// This flag stays one-way; the funnels consult the gate, not the raw flag.
    pub(super) fn begin_closing(&self) {
        if !self.closing.swap(true, Ordering::SeqCst) {
            // W8-2: stamp WHEN, so a close that never completes can be told apart
            // from one that is simply in progress (see `handshake_gate`).
            *self.closing_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
            forensic::record(
                "socket",
                "session CLOSING — pc:register / pc:reconnect are suppressed from here on (F-3 Fix#1)",
            );
        }
    }

    /// Whether [`begin_closing`](Self::begin_closing) has been called.
    pub(super) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    /// W8-2 — the closing latch's LOCAL WATCHDOG: what the handshake funnel should
    /// do with this emit, given everything the latch can observe locally.
    ///
    /// Evaluated per attempt, never latched — a successor constructed AFTER a
    /// release re-suppresses this session on its very next `open`, so the F-3
    /// Fix#1 protection re-arms itself the moment it has something to protect.
    ///
    /// 🔴 WHICH FIX SHAPE THIS IS, AND WHY THE OTHER WAS WRONG (card C2 asked for
    /// it in writing). Shape (a) — "make the successor-constructed event always
    /// happen" — is not guaranteeable: building a session REQUIRES the Tauri main
    /// thread (`SetWinEventHook`, see `channel_session::connect_on_main`), and the
    /// W8-2 trace is precisely a state where that thread never ran the marshalled
    /// connect (`IsHungAppWindow=True` on the same window). A fix that needs new
    /// construction can be starved by the very failure it fixes. The zombie's own
    /// socket callback thread is the only context GUARANTEED alive when a fresh
    /// `open` arrives — so the decision runs there, at the suppression site. What
    /// survives of (a): the successor-constructed EVENT is still the judge; the
    /// timer/attempt arm only covers the window in which no successor ever came.
    pub(super) fn handshake_gate(&self, now: Instant) -> ClosingGate {
        if !self.is_closing() {
            return ClosingGate::Open;
        }
        let closed_for = self
            .closing_since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| now.saturating_duration_since(t));
        let gate = closing_gate(
            self.channel,
            self.generation.load(Ordering::SeqCst),
            self.generations.latest(self.channel),
            self.suppressed_handshakes.load(Ordering::SeqCst),
            closed_for,
        );
        if gate == ClosingGate::Suppress {
            self.suppressed_handshakes.fetch_add(1, Ordering::SeqCst);
        }
        gate
    }

    /// W8-2 — the loud half of a [`ClosingGate::Release`]. One line per released
    /// emit on purpose: this state is abnormal for as long as it lasts, and these
    /// frames are the ONLY forensic the failure mode produces (the W8-2 trace was
    /// ten minutes of zero lines).
    pub(super) fn record_release(&self, verb: &str) {
        let closed_for_ms = self
            .closing_since
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        forensic::record(
            "socket",
            &format!(
                "{verb} RELEASED past the closing latch — closing for {closed_for_ms}ms with NO \
                 successor session constructed on {} ({} handshake(s) suppressed so far). \
                 Suppressing forever would erase this PC from the server (W8-2 local watchdog); \
                 a successor, once constructed, re-suppresses this session on its next open.",
                self.channel.tag(),
                self.suppressed_handshakes.load(Ordering::SeqCst),
            ),
        );
    }

    /// Test seam: pretend the close began `ago` earlier. The decision itself is
    /// the pure [`closing_gate`]; this only lets the funnel-level tests reach the
    /// stale-close arm without sleeping through the real grace window.
    #[cfg(test)]
    pub(super) fn backdate_closing(&self, ago: Duration) {
        *self.closing_since.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Instant::now() - ago);
    }

    /// RV-34 — "did the server recognize me on this connection".
    ///
    /// Distinct from [`Credentials::is_registered`], which answers "does this
    /// machine have a token stored". Conflating the two produced two defects at once:
    ///
    /// ① having a token ⇒ registered is always true, so the state "connected, but the
    ///    server doesn't recognize it" did not
    ///    exist as far as the desktop was concerned — and the RV-26 register
    ///    watchdog, which only acts on `connected && !registered`, could NEVER fire
    ///    for a `pc:reconnect` ack lost on a socket that stayed up. A latch closed
    ///    by a remote event with no local watchdog is the red line this repo already
    ///    has a rule for.
    /// ② The UI said "registered" on the strength of a file on disk. 0.2.19 forensic:
    ///    `CONNECTION → ui (channel=cloud connected=false registered=true …)`.
    ///
    /// This flag is per-CONNECTION by construction: only a `pc:register` /
    /// `pc:reconnect` ack that came back ACCEPTED sets it, and it is cleared the
    /// moment the connection it describes ends (socket open/close) or the server
    /// says the session is dead (`auth:expired`, dead-token reconnect ack).
    pub fn handshake_acked(&self) -> bool {
        self.handshake_acked.load(Ordering::SeqCst)
    }

    /// An accepted handshake ack landed. `ctx` is the event that answered.
    ///
    /// Recorded only on the false→true edge: this is a per-connection edge, and a
    /// line per edge is what makes "when did the server accept this connection" readable back out
    /// of the log instead of inferred from a symptom.
    pub(super) fn mark_handshake_acked(&self, ctx: &str) {
        if !self.handshake_acked.swap(true, Ordering::SeqCst) {
            eprintln!("[flowmic] handshake ack landed via {ctx} — the server confirms this connection");
            forensic::record(
                "socket",
                &format!("handshake ack LANDED via {ctx} — server confirms THIS connection"),
            );
        }
    }

    /// This connection is no longer confirmed (new socket / close / auth:expired /
    /// dead token). Idempotent, and recorded only on the true→false edge.
    pub(super) fn clear_handshake_ack(&self, why: &str) {
        if self.handshake_acked.swap(false, Ordering::SeqCst) {
            forensic::record(
                "socket",
                &format!("handshake ack CLEARED ({why}) — this connection is no longer confirmed"),
            );
        }
    }

    /// 0.2.66 — remember the PCID an ack just carried (see [`SharedPcid`]).
    ///
    /// Called from the register and reconnect acks — the two the server stamps a pcid
    /// onto (`apps/server-core/src/socket/handlers/pc.handler.ts`; its
    /// `pc:refresh-code` handler deliberately omits it, and this desktop reads none
    /// there either — see `outbound::refresh_pairing_code`).
    ///
    /// A well-formed value REPLACES the cache; an ack carrying none LEAVES IT ALONE.
    /// Per design §4 "row-level stability" a later ack cannot legitimately change this id, so
    /// "this frame didn't say" is not evidence the relay took it back — and staleness is bounded,
    /// since every session starts this cell at `None`. The case it protects: the
    /// RV-26 register watchdog re-emitting into a relay that answers without the key
    /// would otherwise report "this PC has no ID" about a PC the phone can still address.
    pub(super) fn adopt_pcid(&self, obj: &Value) {
        let Some(pcid) = wire::parse_pcid(obj) else { return };
        if let Ok(mut g) = self.pcid.lock() {
            *g = Some(pcid);
        }
    }

    /// Report a refusal upward (cloud) — always recorded, hook optional.
    pub(super) fn report_refusal(&self, ctx: &str, code: &str) {
        eprintln!("[flowmic] {ctx} REFUSED: {code}");
        forensic::record("socket", &format!("{ctx} refused: {code}"));
        if let Some(hook) = &self.auth_failure {
            hook(code);
        }
    }
}

// The W8-2 closing-gate DECISION (`ClosingGate`, the release constants, the pure
// `closing_gate` fn) lives in `session_gen.rs` beside the successor counter it
// judges — moved VERBATIM at the 800-line cap (register_watchdog precedent: the
// funnel owns the EMIT, the sibling module the DECISION).

// RV-08 / GA-26 — `apply_connected_mobiles` (the ONE reader of an ack's
// `connectedMobiles` roster) moved VERBATIM to `roster_apply.rs` at the
// 800-line cap, in the round where C2 (session_gen) and B4 (reconcile_holder)
// landed together. The funnel here keeps the ack ORDER; that sibling owns the
// roster application and carries the full RV-08/GA-26/RV-新C/B4 argument.

/// What a `pc:register` ack decided. Returned instead of acted on because the ONE
/// remaining step needs the live socket back (`reassert_pc_name`) — everything
/// else is decided in [`on_register_ack`], which is therefore testable without a
/// transport. Before RV-34 the whole ack body lived inside the closure and no unit
/// test could reach a single line of it.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RegisterAckVerdict {
    /// `{error}` — reported (+ the cloud hook); nothing persisted, nothing claimed.
    Refused,
    /// A token landed and was persisted; the caller re-asserts this PC's name.
    Accepted,
    /// Neither an error nor a usable token. Not a registration, so not claimed as
    /// one — the watchdog keeps chasing it.
    NoToken,
}

/// The decision half of the `pc:register` ack (see [`RegisterAckVerdict`]).
pub(super) fn on_register_ack(obj: &Value, p: &Pairing, rec: &Reconciler) -> RegisterAckVerdict {
    // Fail-loud: a refused registration is a real, reportable outcome — never a
    // silent "still not registered".
    if let Some(code) = obj.get("error").and_then(Value::as_str) {
        // The server explicitly did NOT accept us. Says so even if a previous ack on
        // this connection had (a watchdog re-emit that comes back refused).
        p.clear_handshake_ack("pc:register refused");
        p.report_refusal("pc:register", code);
        return RegisterAckVerdict::Refused;
    }
    if let Some(code) = obj.get("short_code").and_then(Value::as_str) {
        if let Ok(mut s) = p.short_code.lock() {
            // GA-18: the register ack mints the code, so its TTL starts now —
            // capture the deadline with the code.
            *s = Some(ShortCodeState::new(code.to_string(), wire::parse_expires_in_ms(obj)));
        }
    }
    // 0.2.66: BEFORE the token check below — the relay named this PC on this ack
    // whether or not a token rode along, and "what's it called" does not wait on "was it accepted".
    p.adopt_pcid(obj);
    let (t, pc_id, room) = wire::parse_register_ack(obj);
    let Some(tok) = t else {
        forensic::record(
            "socket",
            "pc:register ack carried NEITHER an error NOR a token — not treated as a registration",
        );
        return RegisterAckVerdict::NoToken;
    };
    if let Ok(mut c) = p.creds.lock() {
        c.accept_registration(tok, pc_id, room);
        let _ = c.save(&p.path);
    }
    eprintln!("[flowmic] pc:register ack — token acquired");
    forensic::record("socket", "pc:register ack — token acquired");
    // RV-34: THIS is the moment the server admitted us on this connection — the
    // token now on disk is evidence of that moment, not of the current one.
    p.mark_handshake_acked("pc:register");
    // RV-08: the register leg seeds the roster too (see apply_connected_mobiles).
    apply_connected_mobiles("pc:register", obj, p, rec);
    RegisterAckVerdict::Accepted
}

/// What a `pc:reconnect` ack decided. Same split as [`RegisterAckVerdict`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReconnectAckVerdict {
    /// `{error}` — the DEVICE token is dead. Token cleared + presence reset here;
    /// the caller emits a fresh `pc:register` on the socket it still holds.
    DeadToken,
    /// `{error: AUTH_TOKEN_EXPIRED}` — the ACCOUNT credential lapsed (#6
    /// zombie-room gate). Refusal reported (hook → shell clears the Cloud Key
    /// and drops the socket); the pairing credential survives untouched, and
    /// the caller emits nothing further on a refused identity.
    AccountRefused,
    /// Accepted; the caller re-asserts this PC's name.
    Accepted,
}

/// The decision half of the `pc:reconnect` ack (see [`ReconnectAckVerdict`]).
pub(super) fn on_reconnect_ack(obj: &Value, p: &Pairing, rec: &Reconciler) -> ReconnectAckVerdict {
    if let Some(err) = obj.get("error") {
        if err.as_str() == Some("AUTH_TOKEN_EXPIRED") {
            // #6 zombie-room gate: the handshake jwt this socket presented has
            // lapsed (server pc.handler refuses the reconnect so an expired
            // login can no longer sit in its room). This is an ACCOUNT refusal,
            // not a dead device token — clearing the token here would wipe the
            // cloud pairing and force every phone to re-pair over a 7-day key
            // lapse. Only EXPIRED is safely routable (module-note collision).
            eprintln!("[flowmic] pc:reconnect REFUSED: AUTH_TOKEN_EXPIRED — account credential lapsed, pairing kept");
            p.clear_handshake_ack("pc:reconnect refused — account credential lapsed");
            p.report_refusal("pc:reconnect", "AUTH_TOKEN_EXPIRED");
            return ReconnectAckVerdict::AccountRefused;
        }
        // Dead DEVICE token — clear + re-register (never loop a dead token). This is
        // recovery, not an account refusal: the hook stays out of it, and the
        // following register carries the verdict if the identity is the problem.
        eprintln!("[flowmic] pc:reconnect rejected — clearing token, re-registering");
        forensic::record("socket", "pc:reconnect rejected — clearing token, re-registering");
        if let Ok(mut c) = p.creds.lock() {
            c.clear_token();
            let _ = c.save(&p.path);
        }
        // RV-34: the server just said it does not know this token. Whatever this
        // connection was granted earlier, it is not granted now.
        p.clear_handshake_ack("pc:reconnect rejected — dead token");
        rec.reset();
        return ReconnectAckVerdict::DeadToken;
    }
    // RV-34: the reconnect leg gets the same "the server recognized me" stamp as register —
    // which is what finally puts this leg under the pump's register watchdog.
    p.mark_handshake_acked("pc:reconnect");
    // 0.2.66: a token reconnect mints NO code, so this is the ONLY ack a restarted
    // desktop gets — without it the PCID row would exist only for the session that
    // first registered.
    p.adopt_pcid(obj);
    // Success: reconcile the mobile presence count (07 §6). An empty snapshot within
    // 2 s of a fresh join is SUPPRESSED so a mobile that joined during the handshake
    // is not zeroed.
    apply_connected_mobiles("pc:reconnect", obj, p, rec);
    let (_t, pc_id, room) = wire::parse_register_ack(obj);
    if pc_id.is_some() || room.is_some() {
        if let Ok(mut c) = p.creds.lock() {
            if pc_id.is_some() {
                c.pc_id = pc_id;
            }
            if room.is_some() {
                c.room_uuid = room;
            }
            let _ = c.save(&p.path);
        }
    }
    ReconnectAckVerdict::Accepted
}

/// How long the register ack is waited for before rust_socketio drops the
/// callback. Named because RV-26's watchdog has to stay OUTSIDE it: a re-emit
/// sooner than this would race an ack that is still legitimately in flight.
pub const REGISTER_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// The one emit shape the register handshake needs.
///
/// RV-26 — the register frame now has TWO senders: a socket handler
/// (which is handed a [`RawClient`]) and the pump thread's register watchdog
/// (which holds the session's [`Client`]). Those two types are unrelated but
/// expose the same `emit_with_ack`, so the handshake is written ONCE against this
/// trait instead of copied per caller. A second hand-rolled register path is
/// exactly how v0.2.1 ended up with two PC names on two channels — the copy that
/// nobody updated is always the one that runs on the machine with the bug.
pub trait AckEmitter {
    /// `true` when the frame reached the transport. The ack (or its absence) still
    /// arrives on `callback`; this only answers "whether it went out".
    fn emit_ack(
        &self,
        event: &'static str,
        data: Value,
        timeout: Duration,
        callback: Box<dyn FnMut(Payload, RawClient) + Send + 'static>,
    ) -> bool;
}

impl AckEmitter for RawClient {
    fn emit_ack(
        &self,
        event: &'static str,
        data: Value,
        timeout: Duration,
        callback: Box<dyn FnMut(Payload, RawClient) + Send + 'static>,
    ) -> bool {
        self.emit_with_ack(event, data, timeout, callback).is_ok()
    }
}

impl AckEmitter for Client {
    fn emit_ack(
        &self,
        event: &'static str,
        data: Value,
        timeout: Duration,
        callback: Box<dyn FnMut(Payload, RawClient) + Send + 'static>,
    ) -> bool {
        self.emit_with_ack(event, data, timeout, callback).is_ok()
    }
}

/// Emit pc:register and, on ack, persist the token + capture the short_code +
/// (RV-08) seed the presence roster. An `error` ack is reported (see the module
/// note) and nothing is persisted.
///
/// RV-08: `reconciler` is why this signature grew. The register ack has carried
/// `connectedMobiles` since 0.2.18 and this function had no way to reach the
/// presence set, so the field was written and never read — see
/// [`apply_connected_mobiles`].
pub fn emit_register<E: AckEmitter + ?Sized>(
    socket: &E,
    pairing: &Arc<Pairing>,
    reconciler: &Arc<Reconciler>,
) {
    // F-3 Fix#1 — a session being torn down does not get to claim the room again.
    // See `Pairing::begin_closing` for the vendored-source reason this can happen at
    // all, and for why the guard is here (the funnel) rather than at the callers.
    // W8-2: the latch now has a local watchdog — a stale close with NO successor
    // session releases the handshake instead of erasing this PC from the server
    // forever (`Pairing::handshake_gate` carries the full argument).
    match pairing.handshake_gate(Instant::now()) {
        ClosingGate::Open => {}
        ClosingGate::Suppress => {
            forensic::record("socket", "pc:register SUPPRESSED — this session is closing (F-3 Fix#1)");
            return;
        }
        ClosingGate::Release => pairing.record_release("pc:register"),
    }
    let (device, cinst) = {
        let c = pairing.creds.lock().unwrap();
        (c.device_name.clone(), c.client_instance_id.clone())
    };
    let p = pairing.clone();
    let rec = reconciler.clone();
    let uid = crate::pc_name::machine_uid();
    let sent = socket.emit_ack(
        events::PC_REGISTER,
        wire::build_pc_register(&device, &cinst, uid.as_deref()),
        REGISTER_ACK_TIMEOUT,
        Box::new(move |ack, _s| {
            if let Payload::Text(vals) = ack {
                if let Some(obj) = wire::unwrap_ack(&vals) {
                    if on_register_ack(obj, &p, &rec) == RegisterAckVerdict::Accepted {
                        // The server keeps an EXISTING row's device_name on
                        // re-register, so a fresh token does not imply a fresh
                        // name. State it explicitly (see reassert_pc_name).
                        reassert_pc_name(&_s, &p);
                    }
                }
            }
        }),
    );
    if !sent {
        // The frame never left the transport, so no ack will EVER arrive — the
        // callback above is simply never called. Before RV-26 this was a `let _`
        // and the desktop just stayed unregistered in silence; the pump's register
        // watchdog is what retries it, and this line is how the log shows the
        // difference between "it went out but nobody answered" and "it never went out at all".
        forensic::record("socket", "pc:register was NOT sent (transport refused the frame)");
    }
}

/// v0.2.1 — re-assert THIS machine's name on the channel that just came up.
///
/// owner 2026-07-28 ruling: "The name on the PC side should be unique. Whether the
/// connection is established through the local LAN or the cloud relay, it should get the same name."
///
/// `pc_rename` writes every channel that is RESIDENT at the moment of the rename.
/// A channel that was down then would otherwise keep the old label forever:
/// `pc:reconnect` carries only a token, and the server's `registerPc` re-register
/// branch deliberately keeps the existing row (rotating the token, not the name),
/// so neither path ever revisits it. The result is the exact split owner hit —
/// renamed on one server, factory default on the other, and the phone shows
/// whichever one it happened to pair through.
///
/// The desktop's credential file is the authority on its own name (04 §3.7: the
/// name is the PC's to set, and the server refuses a mobile-originated write), so
/// stating it once per connection is idempotent housekeeping, not a user action.
/// It is fire-and-forget on purpose: this is convergence, not a command anyone is
/// waiting on, and the next connection retries it anyway. It is still RECORDED —
/// unattended does not mean invisible.
pub fn reassert_pc_name(socket: &RawClient, pairing: &Arc<Pairing>) {
    let name = {
        let c = pairing.creds.lock().unwrap();
        c.device_name.clone()
    };
    if name.trim().is_empty() {
        return;
    }
    let sent = socket.emit(events::SETTINGS_UPDATE, wire::build_pc_name_update(&name));
    forensic::record(
        "rename",
        &format!(
            "re-asserted pc name on connect: {:?} ({})",
            name,
            if sent.is_ok() { "sent" } else { "socket refused the frame" }
        ),
    );
}

/// Emit pc:reconnect. On a dead-token ack (`{error}`) clear the token and fall
/// back to a fresh register; on success reconcile the mobile count from the ack's
/// `connectedMobiles` through the JOINED_SUPPRESS/ReconcileGate reconciler (07 §6).
///
/// The name re-assert now happens AFTER the roster reconcile rather than before it
/// (it moved out of the ack body into [`on_reconnect_ack`]'s verdict). Neither
/// waits on the other — one is a `settings:update` on the wire, the other a local
/// set replace — so the order carries no meaning.
///
/// F-3 Fix#1 made this generic over [`AckEmitter`] exactly like `emit_register`
/// already was. That is not tidiness: the F-3 zombie HAS a token, so the path a
/// re-registering dying session actually takes is this one, and while the signature
/// named `RawClient` concretely there was no way to assert anything about it without
/// a live socket — the guard would have been pinned only on the branch the defect
/// does not use.
pub fn emit_reconnect<E: AckEmitter + ?Sized>(
    socket: &E,
    pairing: &Arc<Pairing>,
    reconciler: &Arc<Reconciler>,
) {
    // F-3 Fix#1 — see `Pairing::begin_closing`. Guarded here as well as in
    // `emit_register` because a token-bearing session reaches the wire through this
    // function and never touches that one. W8-2: same local watchdog as there —
    // this very suppression line, repeated three times and then ten minutes of
    // silence, IS the real-machine trace the release arm exists for.
    match pairing.handshake_gate(Instant::now()) {
        ClosingGate::Open => {}
        ClosingGate::Suppress => {
            forensic::record("socket", "pc:reconnect SUPPRESSED — this session is closing (F-3 Fix#1)");
            return;
        }
        ClosingGate::Release => pairing.record_release("pc:reconnect"),
    }
    let (token, cinst) = {
        let c = pairing.creds.lock().unwrap();
        (c.token.clone(), c.client_instance_id.clone())
    };
    let Some(token) = token else {
        emit_register(socket, pairing, reconciler);
        return;
    };
    let p = pairing.clone();
    let rec = reconciler.clone();
    let uid = crate::pc_name::machine_uid();
    let _ = socket.emit_ack(
        events::PC_RECONNECT,
        wire::build_pc_reconnect(&token, &cinst, uid.as_deref()),
        Duration::from_secs(5),
        Box::new(move |ack, s| {
            if let Payload::Text(vals) = ack {
                if let Some(obj) = wire::unwrap_ack(&vals) {
                    match on_reconnect_ack(obj, &p, &rec) {
                        // A2 device-line 2026-08-11 (dev-pc-a): calling
                        // `emit_register` *inside* this reconnect-ack callback
                        // never settles on rust_socketio 0.6 — the pump's
                        // register watchdog keeps logging UNACKED, and a clean
                        // app restart (open → register, no nesting) acquires a
                        // token immediately. The same reject→register sequence
                        // against the live relay with Node's socket.io-client
                        // acks in <1s, so the relay is not the missing half.
                        // Schedule the register AFTER this callback returns.
                        ReconnectAckVerdict::DeadToken => {
                            forensic::record(
                                "socket",
                                "pc:reconnect dead token — scheduling pc:register after ack callback returns",
                            );
                            let s2 = s.clone();
                            let p2 = p.clone();
                            let rec2 = rec.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(20));
                                emit_register(&s2, &p2, &rec2);
                            });
                        }
                        // The shell's auth-failure hook owns the teardown (clear
                        // the Cloud Key + drop the socket). Registering on a
                        // refused identity would only be refused again.
                        ReconnectAckVerdict::AccountRefused => {}
                        ReconnectAckVerdict::Accepted => reassert_pc_name(&s, &p),
                    }
                }
            }
        }),
    );
}

#[cfg(test)]
#[path = "pairing_tests.rs"]
mod pairing_tests;

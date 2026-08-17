// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (SPEAKING-lock watchdog), §6 (heartbeat),
//     §3.5 F-3113 (focus:state mirror GATED on a mobile being present)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-2 (CONNECTION bridge → frontend
//     reconnect re-flush + history refresh triggers, 07 §9)
//
// The background pump thread, split out of client.rs to keep the audited core
// under the file-size cap. It drains OS foreground events into the focus FSM,
// runs the 32s SPEAKING-lock watchdog, emits heartbeat, mirrors the change-only
// mobile-GATED focus:state (F-3113), pushes the SAME foreground sample to our own
// windows on flowmic://focus-changed (GA-25 — the capsule's live "injection target"; that
// sink is deliberately NOT mobile-gated, see bridge::channel::FOCUS_CHANGED), and
// forwards CONNECTION transitions to the Vue windows. It touches NO inject/auth
// logic — purely operational.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rust_socketio::client::Client;
use serde_json::{json, Value};

use crate::events;
use crate::focus::{self, FocusState, FocusStateMachine, FocusTracker};
use crate::forensic;
use crate::socket::admission::Admission;
use crate::socket::bridge::{self, BridgeSink};
use crate::socket::channel::Channel;
use crate::socket::client::now_millis;
use crate::socket::credentials::Credentials;
use crate::socket::pairing::{self, Pairing};
use crate::socket::reconcile::Reconciler;
// RV-26 + RV-34: the registration latch's local watchdog. Its own module since the
// RV-34 fix pushed this file past the source cap — the pump owns the TICK, the
// watchdog owns the DECISION (socket/register_watchdog.rs).
use crate::socket::register_watchdog::{RegisterAction, RegisterWatchdog, REGISTER_RETRY_CEIL, REGISTER_RETRY_MAX};
// F3: the SPEAKING lock's STATE-timed local watchdog and its audio-liveness clock.
// Same split rationale as register_watchdog above.
use crate::socket::speak_liveness::{lock_starved, SpeakLiveness};
use crate::socket::wire;

type SharedCreds = Arc<Mutex<Credentials>>;

/// What the ONE tray icon is currently displaying, process-wide.
///
/// 🔴 F3 — THIS MEMO'S SCOPE IS LOAD-BEARING, and 0.2.48 had it wrong. The forward
/// below is throttled "only on change", and until now the memo was a LOCAL of the
/// pump thread, i.e. it answered "what did my channel last send". But there is exactly
/// ONE tray: `shell/tray.rs` builds a single `TrayIconBuilder` (tray.rs:141) and
/// `TRAY_STATE` has exactly one listener (tray.rs:171), fed by BOTH channels' pumps
/// under a `primary` gate — and `primary` FLIPS at runtime
/// (`Admission::primary`/`is_primary`, admission.rs, driven by join/left/roster).
///
/// So: cloud is primary and its phone speaks → the cloud pump forwards "recording now"
/// and the icon goes red. The phone leaves, primary falls back to LAN, and the LAN
/// pump compares its current tooltip against ITS OWN last send — which, on a
/// channel where nothing changed the whole time, is equal — so it forwards
/// NOTHING. The icon stays red with nobody speaking, forever, and no FSM is stuck.
///
/// The question the throttle has to ask is "what is the tray currently showing", and that
/// question is process-wide because the tray is. This is deliberately NOT the
/// "a process-level singleton colliding with dual channels" anti-pattern CLAUDE.md warns about: that one is a
/// singleton answering a PER-CHANNEL question. This is a single value answering a
/// question about a single OS object.
static TRAY_SHOWING: Mutex<Option<String>> = Mutex::new(None);

/// Whether a tray forward has to go out this tick. Pure so the flip scenario above
/// is testable without two live sockets (`pump_tests.rs`).
fn tray_forward_needed(primary: bool, showing: Option<&str>, tooltip: &str) -> bool {
    primary && showing != Some(tooltip)
}

/// Ask-and-claim against the process-wide memo: `true` ⇒ this pump must forward
/// `tooltip` now, and the memo has been advanced to it.
///
/// It exists so the SHARED-ness above is a testable property rather than a comment.
/// A pure predicate alone cannot catch the regression that matters — putting the
/// memo back into a pump-thread local would leave `tray_forward_needed` passing and
/// the icon stale again — but two calls through THIS seam can (see
/// `the_tray_change_memo_is_shared_by_both_pumps_because_there_is_one_icon`).
fn tray_take_forward(primary: bool, tooltip: &str) -> bool {
    let mut showing = TRAY_SHOWING.lock().unwrap_or_else(|p| p.into_inner());
    if !tray_forward_needed(primary, showing.as_deref(), tooltip) {
        return false;
    }
    *showing = Some(tooltip.to_string());
    true
}

/// U6 — forget what the tray is showing so the NEXT pump tick (≤500 ms) re-forwards
/// the tooltip/status even though the underlying state did not change. The one
/// production caller is `shell::locale_sync::ui_locale_set`: after a locale switch
/// the same state renders as different text, and the change-only memo would
/// otherwise keep the old language on the tray until a real state transition.
pub fn tray_showing_reset() {
    *TRAY_SHOWING.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// U6 — whether ANY pump has ever forwarded a tray payload. `None` means the tray
/// still shows its boot-time (disconnected) strings and no pump session exists to
/// repaint them, so the locale-change listener in shell/tray.rs repaints the
/// disconnected strings itself instead of waiting for a tick that may never come.
pub fn tray_showing_snapshot() -> Option<String> {
    TRAY_SHOWING.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The SPEAKING-lock watchdog's ENTIRE action for one tick, and the tick's ONE
/// answer to "does this machine currently count as recording" — which is what the tray is then told.
///
/// It is a function, not four lines inlined in the loop, for one reason: the tests
/// have to drive THE CODE THAT SHIPS. The pre-existing
/// `expired_watchdog_force_releases_a_wedged_lock_and_disarms` re-implements the
/// pump's branch inside the test body, so it stays green against a pump that lost
/// the branch entirely — the exact "measuring a path the product doesn't actually take" shape CLAUDE.md fines.
/// With this seam, breaking the watchdog turns the TRAY assertions red.
///
/// `now` is injected so a 32 s cap is testable without waiting 32 s.
fn speaking_watchdog_tick(
    fsm: &Mutex<FocusStateMachine>,
    lock_deadline: &Mutex<Option<Instant>>,
    liveness: &SpeakLiveness,
    speaking_since: &mut Option<Instant>,
    now: Instant,
    cap: Duration,
    tag: &str,
) -> bool {
    if !fsm_is_recording(fsm) {
        *speaking_since = None;
        return false;
    }
    let entered = *speaking_since.get_or_insert(now);
    // Kept as EVIDENCE, not as the verdict: "is this lock the one from audio:start" is what
    // tells hole ① apart from hole ② in the log below.
    let was_armed = watchdog_expired(*lock_deadline.lock().unwrap_or_else(|p| p.into_inner()), now);
    if !lock_starved(Some(entered), liveness.last(), now, cap) {
        return true; // still a live utterance — the lock stands
    }
    fsm.lock().unwrap_or_else(|p| p.into_inner()).force_release();
    *lock_deadline.lock().unwrap_or_else(|p| p.into_inner()) = None; // it belonged to this lock
    *speaking_since = None;
    eprintln!("[flowmic] SPEAKING lock watchdog — forced release");
    // 🔴 LEAVE A TRACE. Without this line "why did the red dot go out by itself" is unanswerable after
    // the fact, and a watchdog that fires silently is indistinguishable from a bug
    // that fixed itself. The age of the lock AND the age of the last audio signal both
    // go in, because that pair is what tells "the link died" from "the engine simply isn't sending interim results";
    // `armed_deadline_also_expired=false` is the fingerprint of a lock that 0.2.48
    // would never have released at all.
    forensic::record(
        "lock",
        &format!(
            "SPEAKING lock watchdog — forced release (channel={tag}): held {}s, no audio signal \
             for {}s (cap {}s, armed_deadline_also_expired={was_armed}). The tray stops claiming \
             录音 from this tick; nothing was injected, nothing was dropped.",
            now.saturating_duration_since(entered).as_secs(),
            liveness
                .last()
                .map(|s| now.saturating_duration_since(s).as_secs() as i64)
                .unwrap_or(-1),
            cap.as_secs()
        ),
    );
    false
}

/// "does this machine currently count as recording" — the ONE sample per tick that the watchdog and the
/// tray both read, so they cannot disagree within a tick (same discipline as the
/// `acked` sample below). `Injecting` counts: the utterance is still in flight, and
/// the user has no way to tell "typing right now" from "still speaking" from a corner dot.
fn fsm_is_recording(fsm: &Mutex<FocusStateMachine>) -> bool {
    let m = match fsm.lock() {
        Ok(g) => g,
        // A poisoned FSM cannot be shown as recording — that is the exact lie F3 is
        // about. Report "not recording" and let the state surface elsewhere.
        Err(p) => p.into_inner(),
    };
    matches!(
        m.state(),
        FocusState::SpeakingLocked { .. } | FocusState::Injecting { .. }
    )
}

/// Dynamic tray surface (07 §7 / redesign §5.4). The seven-state contract is
/// `disconnected|connected-idle|recording|active-owner|observer-waiting|
/// owner-grace|vacant`; only the THREE the desktop can derive from signals it
/// actually receives are wired here (deliverable D). The other four need
/// owner/observer role + grace events the server does not yet emit to the PC —
/// they are reported as gaps, never faked.
///
/// Returns `(state_id, tooltip, status_line)` — tooltip for the OS hover,
/// status_line for the disabled tray-menu row. Both share this one truth.
///
/// RV-34: `registered` is "the server recognized me" (`Pairing::handshake_acked`), never
/// "this machine has a token" — the tray used to say "connected" on the strength of a credential
/// file while the server had no idea who this socket was.
///
/// U6: strings come from the ui_i18n table in `locale` — the caller samples
/// `ui_i18n::current()` at tick time, so a locale switch reaches the tray on the
/// next tick (the switch also clears TRAY_SHOWING via `tray_showing_reset`, which
/// is what defeats the change-only throttle). `locale` is a parameter rather than
/// a second read of the global inside, so the tests can pin a language without
/// racing other tests through process state.
fn tray_state(
    locale: crate::ui_i18n::UiLocale,
    connected: bool,
    registered: bool,
    mobiles: usize,
    recording: bool,
) -> (&'static str, String, String) {
    use crate::ui_i18n::{fill, text, Msg};
    if !connected || !registered {
        return (
            "disconnected",
            text(locale, Msg::TrayTooltipDisconnected).to_string(),
            text(locale, Msg::TrayStatusDisconnected).to_string(),
        );
    }
    if recording {
        return (
            "recording",
            text(locale, Msg::TrayTooltipRecording).to_string(),
            text(locale, Msg::TrayStatusRecording).to_string(),
        );
    }
    let n = mobiles.to_string();
    (
        "connected-idle",
        fill(text(locale, Msg::TrayTooltipConnected), &[("n", &n)]),
        fill(text(locale, Msg::TrayStatusConnected), &[("n", &n)]),
    )
}

/// The SPEAKING-lock watchdog expiry predicate (07 §3, ruling 2). An armed
/// deadline that `now` has reached → the lock has been held with no resolving
/// inject past the hard cap and must be force-released. Split out pure so the
/// watchdog decision is unit-testable without a live socket/desktop (the live
/// force_lock path needs an OS foreground the headless smoke can't provide).
fn watchdog_expired(deadline: Option<Instant>, now: Instant) -> bool {
    matches!(deadline, Some(d) if now >= d)
}

/// What ONE foreground sample must be delivered to (GA-25). Two sinks hang off
/// the single sample + single change judgment below — there is deliberately no
/// second foreground tracking path (two trackers = two truths).
#[derive(Debug, Default, PartialEq, Eq)]
struct FocusEmits {
    /// `flowmic://focus-changed` → our OWN windows (capsule live "injection target").
    to_frontend: bool,
    /// `focus:state` → the wire (the phone's header), mobile-GATED per F-3113.
    to_server: bool,
}

/// The two-sink emission decision for one pump tick (GA-25 / F-3113).
///
/// * `changed` — the shared change judgment (this tick's foreground sample
///   differs from the last one). Both sinks throttle on this ONE verdict.
/// * `have_target` — the OS gave a real foreground (a null HWND yields none).
///   The wire mirror stays silent without one; the frontend still gets the
///   (empty) sample so the capsule falls back to「—」instead of freezing on a
///   stale target.
/// * `server_ready` — the handshake is acked (RV-34: "the server recognized me", not
///   "this machine has a token") AND a mobile is present. This is the F-3113
///   PRIVACY gate (window titles must not travel with no phone to receive them)
///   and it applies to the WIRE ONLY. The frontend sink is intentionally
///   ungated: Tauri IPC never leaves the machine and the capsule is hidden when
///   no phone is present.
/// * `server_stale` — the room was empty since the last mirror, so the next
///   presence must re-emit even if the foreground never changed (preserves the
///   pre-GA-25 "empty room → forget the last title" behaviour).
fn focus_emits(changed: bool, have_target: bool, server_ready: bool, server_stale: bool) -> FocusEmits {
    FocusEmits {
        to_frontend: changed,
        to_server: server_ready && have_target && (changed || server_stale),
    }
}

/// Build the CONNECTION bridge payload the frontend derives its reconnect re-flush
/// + history refresh triggers from (07 §9). `room_uuid` lets the capsule
///   visibility FSM reset to `persistent` on a session change.
///   GA-28: with BOTH channels resident, two pumps push this frame. Without the
///   `channel` tag the frontend's single connection store would flip-flop between
///   the two sockets' states — the sidebar dot would blink, and the capsule's
///   "phone present" would follow whichever pump ticked last. The tag lets the frontend
///   keep one snapshot PER channel and derive the global one from the primary.
///
/// RV-34: `registered` is now passed IN — it is `Pairing::handshake_acked()`, the
/// tick's sample of "the server recognized me". It used to be read out of `Credentials` here,
/// which meant this frame answered "this machine has a token" under the name `registered`; the
/// 0.2.19 forensic caught it saying `connected=false registered=true`.
///
/// `has_token` is the OTHER question, additive and separately named, so a consumer
/// that legitimately wants "has this machine ever paired" (the sidebar dot's
/// "was registered before, link is down, retrying" yellow) has a field for it instead of borrowing
/// this one. Both travel; neither has to stand in for the other.
fn build_connection(
    creds: &SharedCreds,
    connected: bool,
    registered: bool,
    mobiles: usize,
    reason: &str,
    channel: Channel,
    primary: bool,
) -> Value {
    let (has_token, room) = creds
        .lock()
        .map(|c| (c.is_registered(), c.room_uuid.clone()))
        .unwrap_or((false, None));
    json!({
        "connected": connected,
        "registered": registered,
        "has_token": has_token,
        "room_uuid": room,
        "mobiles": mobiles,
        "reason": reason,
        "channel": channel.tag(),
        "primary": primary,
    })
}

/// Spawn the pump. `tracker` is owned by the thread: dropping it on stop calls
/// UnhookWinEvent.
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn(
    hb_client: Client,
    creds: SharedCreds,
    mobile_count: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    fsm: Arc<Mutex<FocusStateMachine>>,
    lock_deadline: Arc<Mutex<Option<Instant>>>,
    bridge: Option<BridgeSink>,
    connected: Arc<AtomicBool>,
    tracker: FocusTracker,
    // GA-28: this session's channel + the SHARED capsule latch. The pump is the one
    // thread that can see this socket's health on a tick, so it is the latch's
    // REPORTER (`Admission::observe_link`). 🔴 F8① — it is deliberately NOT the
    // latch's watchdog any more: this thread dies with the socket, and a watchdog
    // that only ticks while the thing it guards is alive is not a watchdog. The
    // decision runs on `Admission::ensure_watchdog`'s own thread; see admission.rs.
    // `None` ⇒ single-socket caller, nothing to arbitrate.
    channel: Channel,
    admission: Option<Arc<Admission>>,
    // RV-26: the auth surface, so the tick's register watchdog can RE-EMIT the one
    // frame that closes the registration latch. RV-34 adds one READ to that: this
    // handle owns "did the server recognize me" (`handshake_acked`), which is what the watchdog,
    // the CONNECTION frame, the tray and the focus:state gate all now ask.
    pairing: Arc<Pairing>,
    // RV-08: the presence set, so a watchdog-re-emitted pc:register seeds the roster
    // from its ack exactly like the `open` handler's does.
    reconciler: Arc<Reconciler>,
    // F3: "is audio still flowing", fed by this channel's audio:start + stt:interim/final/level
    // handlers. The STATE watchdog below runs on it; see speak_liveness.rs for why an
    // absolute deadline armed at audio:start could not do this job.
    liveness: SpeakLiveness,
) -> JoinHandle<()> {
    let tag = channel.tag();
    // F3: the SPEAKING-lock hard cap. Read from the SAME `client::lock_timeout()` the
    // arming site uses (32 s default, `FLOWMIC_LOCK_TIMEOUT_SECS` smoke seam) so the
    // two watchdogs below cannot end up enforcing two different caps — and read ONCE,
    // not per tick, because it parses an env var.
    let lock_cap = crate::socket::client::lock_timeout();
    std::thread::spawn(move || {
        // v0.2.4 — THE PUMP MUST NOT BE ABLE TO DIE QUIETLY.
        //
        // owner 2026-07-29 (device page screenshot): both channel cards sat at "connecting…" and
        // the footer said "not connected", while the forensic log two lines above said
        // `socket connected` + `registered=true` on BOTH channels — and the
        // paired-phone table, which goes through a DIRECT emit_with_ack, was
        // fully populated. Everything the frontend PULLS worked; everything it
        // is PUSHED was frozen at its initial value.
        //
        // This thread is the only writer of the CONNECTION frame, and it is full
        // of `.unwrap()` on shared mutexes (fsm / lock_deadline). One poisoned
        // lock and it unwinds — after which the socket keeps working, commands
        // keep answering, and the UI simply never hears another word. Nothing
        // logged it, because nothing was watching a thread that only ever ended
        // by returning.
        //
        // A Drop guard rather than catch_unwind on purpose: it reports BOTH the
        // panic and the ordinary `stop` exit, so "is the pump still alive" is always
        // answerable from the log instead of inferred from a symptom.
        struct PumpLife(&'static str);
        impl Drop for PumpLife {
            fn drop(&mut self) {
                forensic::record(
                    "pump",
                    &format!(
                        "pump thread EXITED (channel={}) — panicking={}. No further                          CONNECTION frames will reach the UI from this channel.",
                        self.0,
                        std::thread::panicking()
                    ),
                );
            }
        }
        let _life = PumpLife(tag);
        forensic::record("pump", &format!("pump thread started (channel={tag})"));

        // ONE foreground marker for BOTH sinks (GA-25): the change judgment the
        // wire mirror and the frontend channel share. `server_focus_stale` is not
        // a second tracker — it is delivery bookkeeping that makes the next mobile
        // presence re-mirror a foreground that never changed while the room was
        // empty (the pre-GA-25 `last_focus = None` reset did the same job).
        let mut last_focus: Option<(String, String)> = None;
        let mut server_focus_stale = true;
        let mut last_hb = Instant::now() - Duration::from_secs(60);
        // Last forwarded connection tuple (connected, handshake_acked, has_token,
        // mobiles, room, primary) — forward a CONNECTION bridge event only on change.
        // RV-34: `has_token` is IN the tuple, not just in the frame, so a token that
        // is cleared or minted is a change the UI hears about even when the handshake
        // judgment happens not to move.
        let mut last_conn: Option<(bool, bool, bool, usize, Option<String>, bool)> = None;
        // (The tray's 「only on change」 memo is the process-wide TRAY_SHOWING above —
        // it used to be a local here, which is the F3 staleness bug.)
        // RV-26: this connection's register-retry ledger (reset on a new socket).
        let mut register_wd = RegisterWatchdog::default();
        // F3: when this pump FIRST saw the FSM in SpeakingLocked/Injecting. Cleared the
        // moment it leaves, so it always measures the CURRENT lock and never an old one.
        let mut speaking_since: Option<Instant> = None;
        while !stop.load(Ordering::SeqCst) {
            // Drain OS foreground events into the FSM (SpeakingLocked drops them —
            // the lock does not follow mid-utterance switches).
            while let Some(ev) = tracker.try_next_event() {
                let n = now_millis().max(0) as u64;
                let _ = fsm.lock().unwrap().handle(ev, n);
            }
            // ── SPEAKING-lock watchdog (07 §3 ruling 2, rebuilt for F3) ──────────
            //
            // ONE release site with ONE verdict, because "is this lock stuck" is one
            // question. 0.2.48 answered it by timing an EVENT — a 32 s deadline armed
            // at `audio:start` (`client.rs`, and grep `lock_deadline`: that is the ONLY
            // `Some(...)` in the repo). owner 2026-08-02 saw the two holes that leaves,
            // both of which end with a red tray dot and nobody speaking:
            //
            //   ① IT WATCHED NOTHING IT WAS NOT HANDED. `FocusState::Injecting` is
            //      「recording」 to the tray too and is reachable straight from `Idle`
            //      with the deadline still `None` — a local reinject
            //      (`local_inject::reinject_locally` → `inject_ops::run_inject` →
            //      `InjectStarted`), or an `inject:request` that lands after the
            //      deadline already fired. `watchdog_expired(None, _)` is false FOREVER,
            //      so those locks had NO local watchdog at all — the red line
            //     "a latch closed by a remote event must have a local watchdog" violated in the one state the
            //      user actually stares at.
            //   ② IT KILLED REAL UTTERANCES. Being ABSOLUTE, it force-released the lock
            //      32 s after audio:start even while the user was still talking and
            //      audio was still arriving — so 07 §3's SPEAKING-lock invariant quietly
            //      stopped holding mid-sentence and a later window switch could move the
            //      inject target. A watchdog that fixes a red dot by mis-targeting an
            //      injection is not a fix.
            //
            // So the verdict now times the STATE and is refreshed by evidence that audio
            // is still flowing: it needs no arming site (closes ①) and slides with a real
            // utterance (closes ②). The cap is UNCHANGED — the same `lock_timeout()`
            // ruling 2 already fixed; only what it is measured FROM has changed. Full
            // reasoning, and why `audio:stop` is deliberately not a signal:
            // speak_liveness.rs. The whole branch is `speaking_watchdog_tick`, so the
            // tests drive the shipping code rather than a copy of it.
            let recording = speaking_watchdog_tick(
                &fsm,
                &lock_deadline,
                &liveness,
                &mut speaking_since,
                Instant::now(),
                lock_cap,
                tag,
            );

            // GA-28 capsule ownership — this pump REPORTS, it does not decide.
            //
            // 🔴 F8① (2026-08-04). This used to be `admission.tick(channel,
            // connected, now)`: the clock that expires the capsule ran INSIDE the
            // loop of the socket it was waiting for. A cloud auth failure tears that
            // socket down (shell/cloud.rs → sidecar_ctl::drop_socket →
            // set_socket(Cloud, None) → DesktopSocket::drop → disconnect(), which
            // sets `stop` and JOINS this thread) ⇒ the teardown's last act was to
            // delete the only caller that could ever free the capsule. The 30 s
            // OWNER_GRACE never elapsed, the phone that owned the machine could not
            // be evicted, and the same phone arriving over LAN was refused until the
            // whole app was restarted. Same shape as the pump-exit note above: a
            // thread that stops has to be survivable by the things that depend on it.
            //
            // The decision now lives with the latch and runs on the latch's own
            // thread (`Admission::ensure_watchdog`), which reads these reports as
            // PERISHABLE — so this pump disappearing IS the signal, and no future
            // teardown path has to remember to say anything.
            if let Some(a) = &admission {
                a.observe_link(channel, connected.load(Ordering::SeqCst), Instant::now());
            }

            // RV-34 — this tick's ONE sample of "did the server recognize me on this connection".
            //
            // Sampled once and shared by all four readers below (the CONNECTION
            // frame, the tray, the register watchdog, the heartbeat + focus:state
            // gate) so they cannot disagree within a tick. The token question is
            // sampled separately, where it is asked, under its own name.
            let acked = pairing.handshake_acked();

            // Forward a CONNECTION transition to the frontend (reconnect re-flush +
            // history refresh trigger, 07 §9) only when it changed.
            if bridge.is_some() {
                let conn = connected.load(Ordering::SeqCst);
                let mob = mobile_count.load(Ordering::SeqCst);
                let (has_token, room) = creds
                    .lock()
                    .map(|c| (c.is_registered(), c.room_uuid.clone()))
                    .unwrap_or((false, None));
                // GA-28: the ROLE is part of the state. A promotion changes no
                // socket fact, but it changes which channel the UI should be
                // showing — so it must trigger a forward like any other change.
                // `map_or(true, …)`, not `is_none_or` — that method needs Rust 1.82 and
                // the declared MSRV is 1.78 (see the same note in fanout.rs).
                let primary = admission.as_ref().is_none_or(|a| a.is_primary(channel));
                let cur = (conn, acked, has_token, mob, room, primary);
                if last_conn.as_ref() != Some(&cur) {
                    bridge::forward(
                        &bridge,
                        bridge::channel::CONNECTION,
                        build_connection(&creds, conn, acked, mob, "pump", channel, primary),
                    );
                    // Recorded because this frame is the ONLY thing that moves the
                    // UI's connection state, and it is fire-and-forget: nothing
                    // acks it, so without this line "the UI says not connected" cannot be told
                    // apart from "nobody ever sent this frame".
                    // RV-34: BOTH judgments are logged, each under its own name. The
                    // 0.2.19 line "connected=false registered=true" was unreadable
                    // precisely because one word was carrying two meanings.
                    forensic::record(
                        "pump",
                        &format!(
                            "CONNECTION → ui (channel={tag} connected={conn} registered={acked} has_token={has_token} mobiles={mob} primary={primary})"
                        ),
                    );
                    last_conn = Some(cur);
                }

                // Dynamic tray tooltip (07 §7, deliverable D). `recording` is the
                // watchdog's OWN sample from this tick (above) — deliberately not a
                // second read of the FSM, so a lock the watchdog just released cannot
                // still be reported as recording for another 500 ms.
                // U6: the locale is sampled per tick — after `ui_locale_set`
                // resets TRAY_SHOWING, this very line is what repaints the tray
                // in the new language within one 500 ms tick.
                let (tray_id, tooltip, status) =
                    tray_state(crate::ui_i18n::current(), conn, acked, mob, recording);
                // One tray, one truth: the presence channel's (usually empty) room
                // must not overwrite what the primary channel is showing — and the
                // "only on change" memo is process-wide, because the thing it
                // describes is one process-wide icon (see TRAY_SHOWING).
                if tray_take_forward(primary, &tooltip) {
                    bridge::forward(
                        &bridge,
                        bridge::channel::TRAY_STATE,
                        json!({
                            "state": tray_id,
                            "tooltip": tooltip,
                            "status": status,
                        }),
                    );
                }
            }

            // ── RV-26 + RV-34: register-ack watchdog ─────────────────────────
            // Fed `acked` ("the server recognized me"), which is the ONLY input that makes
            // "connected but not registered" a state that can exist. Fed the token instead —
            // as 0.2.17 shipped it — this ladder is dead code on any machine that
            // has ever paired, and a `pc:reconnect` ack lost on a live socket has
            // no local signal whatsoever.
            //
            // ONLY the register frame is re-sent. Heartbeat, the focus mirror and
            // the name re-assert all have their own triggers; bundling them into a
            // recovery emit would make one lost ack fire three unrelated writes.
            match register_wd.decide(connected.load(Ordering::SeqCst), acked, Instant::now()) {
                RegisterAction::Idle => {}
                RegisterAction::Resend { attempt, waited } => {
                    // Past the ladder's announcement the attempt number keeps
                    // counting, so it must not be printed as "6/5".
                    let rung = if attempt > REGISTER_RETRY_MAX {
                        format!("attempt {attempt} (past the cap of {REGISTER_RETRY_MAX} — knocking at the ceiling)")
                    } else {
                        format!("attempt {attempt}/{REGISTER_RETRY_MAX}")
                    };
                    forensic::record(
                        "pump",
                        &format!(
                            "register watchdog: connected but the handshake is UNACKED for {}ms — \
                             re-emitting pc:register (channel={tag} {rung})",
                            waited.as_millis()
                        ),
                    );
                    pairing::emit_register(&hb_client, &pairing, &reconciler);
                }
                RegisterAction::GiveUp { attempts } => {
                    // 🔴 THIS LINE USED TO END "…until the socket drops and the open
                    // handler gets another turn", which was an assertion about a
                    // recovery that could not happen: the transport stays up
                    // (engine.io ping/pong), the heartbeat below is gated on `acked`,
                    // so nothing this process does can provoke the drop it was
                    // waiting for. The ladder no longer stops — it announces here and
                    // then knocks once per ceiling interval — so the line says what
                    // is now true, and says what to expect next.
                    forensic::record(
                        "pump",
                        &format!(
                            "register watchdog: {attempts} re-emits on channel={tag} all went \
                             UNANSWERED — this channel is connected-but-unregistered (the server \
                             does not have it in a room; presence answers offline). Announcing \
                             once; pc:register keeps going out every {}s until the handshake is \
                             acked or the socket drops.",
                            REGISTER_RETRY_CEIL.as_secs()
                        ),
                    );
                }
                RegisterAction::Recovered { attempts, waited } => {
                    // The exit from the state above. Without it a channel that came
                    // back after the announcement leaves a log that ends on "all went
                    // UNANSWERED" — indistinguishable from one that never recovered.
                    forensic::record(
                        "pump",
                        &format!(
                            "register watchdog RECOVERED — handshake acked on channel={tag} after \
                             {attempts} unanswered re-emit(s) over {}ms connected-but-unregistered",
                            waited.as_millis()
                        ),
                    );
                }
            }

            // RV-34: gated on the handshake, not the token. The server's heartbeat
            // handler refuses a frame from a socket it has no `auth` for
            // (heartbeat.handler.ts → AUTH_TOKEN_INVALID), so a heartbeat sent before
            // the ack lands is not liveness — it is a rejected frame every 5 s.
            if acked && last_hb.elapsed() >= Duration::from_secs(5) {
                let _ = hb_client.emit(events::HEARTBEAT, wire::build_heartbeat(now_millis()));
                last_hb = Instant::now();
            }

            // ── foreground: ONE sample → ONE change judgment → TWO sinks (GA-25) ──
            // Sampled unconditionally (not only while the handshake is acked) because the
            // frontend sink must keep the capsule's "injection target" live regardless of
            // wire state; the wire mirror below keeps its own F-3113 gate.
            let cur_focus = focus::current_foreground_target().map(|(_h, title, app)| (title, app));
            let changed = last_focus != cur_focus;
            if changed {
                last_focus.clone_from(&cur_focus);
            }
            // RV-34: "the server recognized me" && a phone is present. The privacy half of this
            // gate (F-3113) only means anything against the handshake: a window title
            // must not be put on a wire whose server does not know who is talking.
            let server_ready = acked && mobile_count.load(Ordering::SeqCst) >= 1;
            if !server_ready {
                // Empty room / handshake not acked → the next presence must re-mirror
                // even if the foreground never moved.
                server_focus_stale = true;
            }
            let emits = focus_emits(changed, cur_focus.is_some(), server_ready, server_focus_stale);
            if emits.to_frontend {
                // Our OWN windows only — no privacy gate on purpose (see
                // bridge::channel::FOCUS_CHANGED). An absent foreground travels as
                // empty strings so the capsule shows "—" rather than a stale target.
                let (title, app) = cur_focus.clone().unwrap_or_default();
                bridge::forward(
                    &bridge,
                    bridge::channel::FOCUS_CHANGED,
                    json!({ "window_title": title, "process_name": app }),
                );
            }
            if emits.to_server {
                // F-3113: the window title is sensitive — it goes on the WIRE only
                // when a mobile is present to receive it, and only on change.
                let (title, app) = cur_focus.clone().unwrap_or_default();
                let _ = hb_client.emit(events::FOCUS_STATE, wire::build_focus_state(&title, &app));
                server_focus_stale = false;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    })
}

#[cfg(test)]
#[path = "pump_tests.rs"]
mod tests;

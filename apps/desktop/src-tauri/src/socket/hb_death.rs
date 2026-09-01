// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (heartbeat; pc:register / pc:reconnect)
//   WP2 Card 7 / G5: engine.io Close that never becomes FlowMic `"close"` or `"open"`
//   *** HUMAN-AUDIT ADJACENT (pairing/auth) — reviewable in isolation ***
//
// Edge 1 of the cloud-leg room-rejoin hole: rust_socketio 0.6 swallows engine.io
// Close, maps the next poll to `StoppedEngineIoSocket`, and does NOT reconnect.
// FlowMic's `"close"` never runs, so `connected` and `handshake_acked` stay true,
// the register watchdog sees `(true, true)` → Idle (that Idle is intentional —
// `register_watchdog` pins it), `ensure_dialed` no-ops because the slot still
// holds the handle, and the PC is absent from the server for as long as the
// process keeps the zombie.
//
// The cheapest local probe is already on the pump: `Client::emit(HEARTBEAT)`
// currently discarded its `Result`. `Err` (typically `IllegalActionBeforeOpen`
// on a dead engine) is a CANDIDATE; TWO consecutive failures are a VERDICT.
// A successful emit resets the count. The verdict performs the same two writes
// the `"close"` handler already performs, then asks the shell to empty the slot
// and `ensure_dialed` so a NEW session's `"open"` is the one room-entering
// author. Deliberate teardowns (`Pairing::is_closing`) keep today's Suppress.
//
// This module is the DECISION. The pump owns the tick; the shell owns Drop +
// redial. No second `pc:register` / `pc:reconnect` emitter lives here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::socket::pairing::Pairing;

/// Shell hook: empty this channel's slot then `ensure_dialed`. Production wraps
/// the work in a spawned thread — `set_socket(None)` Drops the session, and
/// `DesktopSocket::disconnect` joins the pump, so the hook MUST NOT run on the
/// pump thread. `None` (tests, golden path) skips reconstruction; the detector
/// still clears `connected` + the handshake so the UI is honest.
pub type DeadTransportHook = Arc<dyn Fn() + Send + Sync>;

/// Why [`Pairing::clear_handshake_ack`] is called on a verdict. Named so the
/// log line is the same string the `"close"` handler's cousin uses a reason
/// for, and so the tests can pin it without copying a prose sentence.
pub(super) const HEARTBEAT_DEATH_CLEAR_WHY: &str =
    "heartbeat emit failed — transport dead";

/// Consecutive heartbeat-emit failures on a session that is still wanted.
#[derive(Default)]
pub(super) struct HeartbeatDeath {
    consecutive_failures: u8,
    /// A verdict already fired on this pump. Further failures must not spawn
    /// a second rebuild — one author, one reconstruction.
    fired: bool,
}

/// What one heartbeat emit's `Result` means for the session.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HbDeathAction {
    /// Success, a closing session, or a verdict already consumed.
    Idle,
    /// First consecutive failure — log a candidate, do not tear down.
    Candidate,
    /// Second consecutive failure — treat as `"close"` and rebuild.
    Verdict,
}

impl HeartbeatDeath {
    /// One heartbeat emit. `emit_ok` is `client.emit(...).is_ok()`.
    /// `session_closing` is [`Pairing::is_closing`] — a deliberate teardown
    /// (refused Cloud Key, Drop) must not be reconstructed.
    pub(super) fn on_emit(&mut self, emit_ok: bool, session_closing: bool) -> HbDeathAction {
        if session_closing {
            self.consecutive_failures = 0;
            return HbDeathAction::Idle;
        }
        if emit_ok {
            self.consecutive_failures = 0;
            return HbDeathAction::Idle;
        }
        if self.fired {
            return HbDeathAction::Idle;
        }
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures == 1 {
            HbDeathAction::Candidate
        } else {
            self.fired = true;
            HbDeathAction::Verdict
        }
    }
}

/// The same two writes the `"close"` handler performs (`connected=false` +
/// handshake cleared), then the rebuild hook if the session is still wanted.
///
/// Called from the pump on [`HbDeathAction::Verdict`]. Tests drive THIS
/// function rather than re-implementing the writes, so ripping the detector
/// out of `on_emit` is what turns the funnel test red.
pub(super) fn apply_verdict(
    connected: &AtomicBool,
    pairing: &Pairing,
    rebuild: Option<&(dyn Fn() + Send + Sync)>,
) {
    connected.store(false, Ordering::SeqCst);
    pairing.clear_handshake_ack(HEARTBEAT_DEATH_CLEAR_WHY);
    if pairing.is_closing() {
        return;
    }
    if let Some(hook) = rebuild {
        hook();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use rust_socketio::{Payload, RawClient};

    use crate::events;
    use crate::socket::channel::Channel;
    use crate::socket::credentials::Credentials;
    use crate::socket::pairing::{emit_reconnect, AckEmitter, Pairing};
    use crate::socket::reconcile::Reconciler;
    use crate::socket::register_watchdog::{RegisterAction, RegisterWatchdog};
    use crate::socket::session_gen::SessionGenerations;

    /// Counts frames that reached the transport. Same shape as the F-3 funnel
    /// tests in `pairing_tests.rs` — duplicated here so that file stays under
    /// the source cap, and so this card's assertions live next to the detector.
    struct CountingEmitter {
        sent: Mutex<Vec<&'static str>>,
    }

    impl CountingEmitter {
        fn new() -> Self {
            Self {
                sent: Mutex::new(Vec::new()),
            }
        }
        fn events(&self) -> Vec<&'static str> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl AckEmitter for CountingEmitter {
        fn emit_ack(
            &self,
            event: &'static str,
            _data: serde_json::Value,
            _timeout: Duration,
            _callback: Box<dyn FnMut(Payload, RawClient) + Send + 'static>,
        ) -> bool {
            self.sent.lock().unwrap().push(event);
            true
        }
    }

    fn paired(channel: Channel) -> (Arc<Pairing>, Arc<Reconciler>) {
        let mut creds = Credentials::fresh("Test PC");
        creds.accept_registration("fm_tok", Some("pc-1".into()), Some("room-1".into()));
        let pairing = Pairing::new(
            Arc::new(Mutex::new(creds)),
            Arc::new(std::env::temp_dir().join(format!(
                "flowmic-hb-death-{}.bin",
                uuid::Uuid::new_v4()
            ))),
            Arc::new(Mutex::new(None)),
            None,
            channel,
            None,
            SessionGenerations::new(),
        );
        let rec = Arc::new(Reconciler::new(Arc::new(AtomicUsize::new(0))));
        (pairing, rec)
    }

    /// What `"open"` does after a redial: flag up, handshake starts over, then
    /// `emit_reconnect` if a token is on disk. The production author is the
    /// `open` handler in `client.rs`; this is that sequence against a fake
    /// transport so the test can count frames without a live relay.
    fn simulate_open(pairing: &Arc<Pairing>, connected: &AtomicBool, e: &CountingEmitter, rec: &Arc<Reconciler>) {
        connected.store(true, Ordering::SeqCst);
        pairing.clear_handshake_ack("new socket — the handshake starts over");
        emit_reconnect(e, pairing, rec);
    }

    #[test]
    fn one_failure_then_success_is_a_flap_not_a_verdict() {
        let mut d = HeartbeatDeath::default();
        assert_eq!(d.on_emit(false, false), HbDeathAction::Candidate);
        assert_eq!(d.on_emit(true, false), HbDeathAction::Idle);
        assert_eq!(
            d.on_emit(false, false),
            HbDeathAction::Candidate,
            "a success resets the count: the next failure is a candidate again"
        );
    }

    #[test]
    fn a_closing_session_never_verdicts() {
        let mut d = HeartbeatDeath::default();
        assert_eq!(d.on_emit(false, true), HbDeathAction::Idle);
        assert_eq!(d.on_emit(false, true), HbDeathAction::Idle);
        // Closing in between two failures also cancels the candidate.
        let mut d = HeartbeatDeath::default();
        assert_eq!(d.on_emit(false, false), HbDeathAction::Candidate);
        assert_eq!(d.on_emit(false, true), HbDeathAction::Idle);
        assert_eq!(d.on_emit(false, false), HbDeathAction::Candidate);
    }

    #[test]
    fn acked_session_double_heartbeat_failure_clears_and_rebuilds_then_open_emits_one_reconnect() {
        // (a) THE card. An acked session whose engine is dead looks identical to
        // a healthy one until the detector runs: watchdog Idle, zero emits.
        let (pairing, rec) = paired(Channel::Cloud);
        pairing.mark_handshake_acked("pc:reconnect");
        let connected = AtomicBool::new(true);
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        for i in 0..120 {
            assert_eq!(
                wd.decide(true, pairing.handshake_acked(), t0 + Duration::from_secs(i * 30)),
                RegisterAction::Idle,
                "while handshake_acked stays true the watchdog must not emit \
                 (that Idle is pinned in register_watchdog; this loop is the hour \
                 of ticks on a dead-engine session)"
            );
        }
        let emitter = CountingEmitter::new();
        assert!(
            emitter.events().is_empty(),
            "no pc:register/pc:reconnect while the ack latch is still true"
        );

        let mut d = HeartbeatDeath::default();
        let first = d.on_emit(false, pairing.is_closing());
        let second = d.on_emit(false, pairing.is_closing());
        // A ripped detector (`return Idle` at the top of `on_emit`) must fall
        // through to the emit assertion below so the red names the hole:
        // zero room-entering frames across the hour of ticks above.
        let rebuilds = AtomicUsize::new(0);
        let hook = || {
            rebuilds.fetch_add(1, Ordering::SeqCst);
        };
        if second == HbDeathAction::Verdict {
            apply_verdict(&connected, &pairing, Some(&hook));
            assert!(!connected.load(Ordering::SeqCst), "same write the close handler performs");
            assert!(
                !pairing.handshake_acked(),
                "clear_handshake_ack({HEARTBEAT_DEATH_CLEAR_WHY:?}) ran"
            );
            // After the clear, connected=false: the watchdog still refuses to emit
            // ("No socket → the `open` handler owns registration").
            assert_eq!(wd.decide(false, pairing.handshake_acked(), t0), RegisterAction::Idle);
        }
        if rebuilds.load(Ordering::SeqCst) == 1 {
            simulate_open(&pairing, &connected, &emitter, &rec);
        }
        assert_eq!(
            emitter.events(),
            [events::PC_RECONNECT],
            "token present → exactly one pc:reconnect from simulated open after \
             the detector rebuilt the slot; without the detector this is [] \
             across the hour of ticks above (today's defect). NOT a watchdog \
             pc:register while handshake_acked was still true"
        );
        assert_eq!(first, HbDeathAction::Candidate);
        assert_eq!(second, HbDeathAction::Verdict);
        assert_eq!(
            d.on_emit(false, pairing.is_closing()),
            HbDeathAction::Idle,
            "one verdict per pump — a second rebuild would be a second author"
        );
        assert_eq!(rebuilds.load(Ordering::SeqCst), 1, "slot rebuild requested");
        assert!(connected.load(Ordering::SeqCst));
        assert!(
            !pairing.handshake_acked(),
            "open clears the handshake; the ack has not landed yet"
        );
        // Rising edge: watchdog starts a fresh clock, does not fire this tick.
        assert_eq!(
            wd.decide(true, pairing.handshake_acked(), Instant::now()),
            RegisterAction::Idle,
            "open owns the ack window; watchdog must not race it with pc:register"
        );
    }

    #[test]
    fn apply_verdict_on_a_closing_session_does_not_rebuild() {
        let (pairing, _rec) = paired(Channel::Cloud);
        pairing.mark_handshake_acked("pc:reconnect");
        pairing.begin_closing();
        let connected = AtomicBool::new(true);
        let rebuilds = AtomicUsize::new(0);
        let hook = || {
            rebuilds.fetch_add(1, Ordering::SeqCst);
        };
        apply_verdict(&connected, &pairing, Some(&hook));
        assert!(!connected.load(Ordering::SeqCst));
        assert_eq!(
            rebuilds.load(Ordering::SeqCst),
            0,
            "deliberate teardown keeps today's Suppress — do not ensure_dialed"
        );
    }
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer: pc:register / pc:reconnect)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (the two handshake legs and their acks)
//   red line "a latch closed by a remote event must have a local watchdog"
//   *** HUMAN-AUDIT ADJACENT (pairing/auth) — reviewable in isolation ***
//
// The registration latch's local watchdog, split out of socket/pump.rs (which hit
// the 800-line source cap when RV-34 landed) so the one decision this card is
// about is a small unit that can be read, and audited, on its own. The pump keeps
// only the tick that calls it — same move, and the same reason, as pairing.rs
// coming out of client.rs.
//
// Pure apart from its own ledger: no socket, no clock of its own, so every property
// that matters is asserted below without a live connection.

use std::time::{Duration, Instant};

use crate::socket::pairing::REGISTER_ACK_TIMEOUT;

// ── RV-26: the register-ack watchdog ────────────────────────────────────────────
//
// Registration is closed by a REMOTE event — the `pc:register` ack. Lose that ack
// on a socket that STAYS UP (the 5 s window simply expires and rust_socketio drops
// the callback) and nobody ever asks again: the `open` handler is the only other
// sender, and it fires on a connection edge that may not come for hours. The
// desktop then sits `connected=true, registered=false` — the tray says "not connected", the
// phone cannot pair, and every log line looks healthy.
//
// red line "a latch closed by a remote event must have a local watchdog". This is that watchdog for the
// registration latch; the SPEAKING lock's is `pump::watchdog_expired`.
//
// RV-34 — this watchdog shipped in 0.2.17 STRUCTURALLY UNABLE TO FIRE for the
// reconnect leg, because the tick fed it `Credentials::is_registered()`: any
// desktop that had ever paired has a token, so `registered` was true forever and
// `connected && !registered` never happened. A lost `pc:reconnect` ack therefore
// still parked the machine in "connected, UI says registered, but the server actually doesn't recognize it" with no local
// signal at all. It now reads `Pairing::handshake_acked()` — a per-CONNECTION
// judgment that BOTH legs' acks set — so the same ladder covers both.
//
// The recovery frame stays `pc:register` for both legs on purpose: register is the
// one frame that MINTS a server-confirmed token, so it works whether or not the
// local token is still good, and `emit_reconnect` would fall back to it anyway
// (a reconnect whose ack is lost a second time would recover nothing).

/// First retry window. Deliberately LONGER than [`REGISTER_ACK_TIMEOUT`] so the
/// watchdog can only fire on an ack that has ALREADY been given up on — it must
/// never double a handshake whose reply is still legitimately in flight.
const REGISTER_RETRY_FIRST: Duration = REGISTER_ACK_TIMEOUT.saturating_add(Duration::from_secs(1));
/// Backoff ceiling: a server that is up but not answering gets a steady slow
/// knock, never a faster one and never an ever-growing one.
const REGISTER_RETRY_CEIL: Duration = Duration::from_secs(60);
/// Re-emits allowed per CONNECTION. A cap, not forever: if six registers across
/// ~2.5 minutes all went unanswered, the honest move is to SAY so and leave the
/// next attempt to the socket ladder's next real reconnect, not to hammer a server
/// that has clearly decided not to answer.
pub(super) const REGISTER_RETRY_MAX: u32 = 5;

/// The wait before the NEXT action, after `done` re-emits on this connection:
/// 6s, 12s, 24s, 48s, then 60s (the ceiling). Doubling is what keeps a dead server
/// from being knocked on 120 times a minute by a 500 ms tick.
fn register_retry_after(done: u32) -> Duration {
    let scaled = REGISTER_RETRY_FIRST * (1u32 << done.min(4));
    if scaled > REGISTER_RETRY_CEIL {
        REGISTER_RETRY_CEIL
    } else {
        scaled
    }
}

/// What the register watchdog wants done on ONE tick.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RegisterAction {
    /// Nothing: the handshake is acked, no socket, or the backoff has not elapsed.
    Idle,
    /// Re-emit `pc:register` — and ONLY that. `attempt` is 1-based and `waited` is
    /// how long this state has held since the last action; both go in the forensic
    /// line, because "retried" without "which attempt number, how long it waited" cannot be read back.
    Resend { attempt: u32, waited: Duration },
    /// The cap is reached. Reported ONCE and out loud — a watchdog that quietly
    /// stops watching is itself a silent failure (red line).
    GiveUp { attempts: u32 },
}

/// Per-connection retry ledger for the register watchdog.
#[derive(Default)]
pub(super) struct RegisterWatchdog {
    /// Re-emits made on THIS connection.
    attempts: u32,
    /// When the current window opened: the first tick that saw
    /// `connected && !handshake_acked`, or the last re-emit.
    since: Option<Instant>,
    /// `GiveUp` already reported for this connection.
    gave_up: bool,
    /// Previous tick's `connected`, so a NEW socket can be recognised.
    was_connected: bool,
}

impl RegisterWatchdog {
    fn reset(&mut self) {
        self.attempts = 0;
        self.since = None;
        self.gave_up = false;
    }

    /// One tick's decision. Pure apart from its own ledger — no socket, no clock of
    /// its own — so all three properties that matter (it fires, it does not storm,
    /// a new connection starts fresh) are unit-testable.
    ///
    /// RV-34: `handshake_acked` must be "the server recognized me", NOT "this machine has a token" — with
    /// the token as the input this function is a no-op for every paired machine.
    pub(super) fn decide(&mut self, connected: bool, handshake_acked: bool, now: Instant) -> RegisterAction {
        // A socket that went away and came back is a NEW connection: the `open`
        // handler registers again from scratch, so the previous connection's spent
        // budget must not suppress the retries this one is entitled to. A handshake
        // that LANDED clears the ledger for the same reason — a session that dies
        // later starts over with a full budget rather than none.
        let reconnected = connected && !self.was_connected;
        self.was_connected = connected;
        if !connected || handshake_acked || reconnected {
            self.reset();
        }
        if !connected || handshake_acked {
            return RegisterAction::Idle;
        }
        let Some(since) = self.since else {
            // First tick in this state: start the clock, do not fire. The `open`
            // handler's own emit is in flight and owns its full ack window.
            self.since = Some(now);
            return RegisterAction::Idle;
        };
        if self.gave_up {
            return RegisterAction::Idle;
        }
        let waited = now.saturating_duration_since(since);
        if waited < register_retry_after(self.attempts) {
            return RegisterAction::Idle;
        }
        if self.attempts >= REGISTER_RETRY_MAX {
            self.gave_up = true;
            return RegisterAction::GiveUp { attempts: self.attempts };
        }
        self.attempts += 1;
        self.since = Some(now);
        RegisterAction::Resend { attempt: self.attempts, waited }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::socket::credentials::Credentials;
    use crate::socket::pairing::Pairing;

    // ── RV-26: the register-ack watchdog ────────────────────────────────────

    #[test]
    fn a_register_ack_lost_on_a_live_socket_is_re_emitted() {
        // The defect: `connected=true, registered=false` had no local watchdog, so
        // a dropped ack parked the desktop there until the NEXT real disconnect.
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        // First tick only starts the clock — the open handler's own ack is still
        // inside its own timeout and must not be raced.
        assert_eq!(wd.decide(true, false, t0), RegisterAction::Idle);
        assert_eq!(
            wd.decide(true, false, t0 + REGISTER_ACK_TIMEOUT),
            RegisterAction::Idle,
            "must not re-emit while the first ack is still legitimately in flight"
        );
        // Past the first window the frame goes out again, numbered.
        match wd.decide(true, false, t0 + REGISTER_RETRY_FIRST) {
            RegisterAction::Resend { attempt, waited } => {
                assert_eq!(attempt, 1);
                assert!(waited >= REGISTER_RETRY_FIRST, "the line must carry the real wait");
            }
            other => panic!("expected the first re-emit, got {other:?}"),
        }
    }

    #[test]
    fn the_watchdog_backs_off_and_never_storms_the_server() {
        // A 500 ms tick could fire 120 registers a minute. The minimum interval and
        // the doubling are what keep one lost ack from becoming a flood.
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        assert_eq!(wd.decide(true, false, t0), RegisterAction::Idle);
        let t1 = t0 + REGISTER_RETRY_FIRST;
        assert!(matches!(wd.decide(true, false, t1), RegisterAction::Resend { attempt: 1, .. }));
        // The very next ticks are silent.
        assert_eq!(wd.decide(true, false, t1 + Duration::from_millis(500)), RegisterAction::Idle);
        assert_eq!(wd.decide(true, false, t1 + Duration::from_secs(1)), RegisterAction::Idle);
        // …and the second window is BACKED OFF, not another 6 s.
        assert_eq!(
            wd.decide(true, false, t1 + REGISTER_RETRY_FIRST),
            RegisterAction::Idle,
            "attempt 2 must wait longer than attempt 1 did"
        );
        assert!(matches!(
            wd.decide(true, false, t1 + register_retry_after(1)),
            RegisterAction::Resend { attempt: 2, .. }
        ));
        // The ladder doubles up to a ceiling and never goes below the first window.
        assert_eq!(register_retry_after(0), REGISTER_RETRY_FIRST);
        assert_eq!(register_retry_after(1), REGISTER_RETRY_FIRST * 2);
        assert_eq!(register_retry_after(9), REGISTER_RETRY_CEIL, "capped, not unbounded");
        for done in 0..12 {
            assert!(register_retry_after(done) >= REGISTER_RETRY_FIRST);
            assert!(register_retry_after(done) <= REGISTER_RETRY_CEIL);
        }
    }

    #[test]
    fn a_new_socket_resets_the_retry_ledger() {
        // Constraint: the old connection's spent budget must not press down on the
        // new one. A reconnect re-runs the `open` handler, so the new connection is
        // entitled to the full ladder again.
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        wd.decide(true, false, t0);
        assert!(matches!(
            wd.decide(true, false, t0 + REGISTER_RETRY_FIRST),
            RegisterAction::Resend { attempt: 1, .. }
        ));
        // Socket drops…
        assert_eq!(wd.decide(false, false, t0 + Duration::from_secs(20)), RegisterAction::Idle);
        // …and comes back: attempt numbering starts at 1 again, after a full window.
        let t1 = t0 + Duration::from_secs(30);
        assert_eq!(wd.decide(true, false, t1), RegisterAction::Idle, "new clock, not a stale one");
        match wd.decide(true, false, t1 + REGISTER_RETRY_FIRST) {
            RegisterAction::Resend { attempt, .. } => assert_eq!(attempt, 1, "ledger was reset"),
            other => panic!("the new connection must get its own retries, got {other:?}"),
        }
    }

    #[test]
    fn a_successful_registration_clears_the_ledger_and_silences_the_watchdog() {
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        wd.decide(true, false, t0);
        assert!(matches!(
            wd.decide(true, false, t0 + REGISTER_RETRY_FIRST),
            RegisterAction::Resend { attempt: 1, .. }
        ));
        // The token landed → nothing more to chase, on this or any later tick.
        assert_eq!(wd.decide(true, true, t0 + Duration::from_secs(60)), RegisterAction::Idle);
        assert_eq!(wd.decide(true, true, t0 + Duration::from_secs(600)), RegisterAction::Idle);
        // If that token later dies on the SAME socket, the budget is full again.
        let t1 = t0 + Duration::from_secs(600);
        assert_eq!(wd.decide(true, false, t1), RegisterAction::Idle);
        assert!(matches!(
            wd.decide(true, false, t1 + REGISTER_RETRY_FIRST),
            RegisterAction::Resend { attempt: 1, .. }
        ));
    }

    #[test]
    fn giving_up_is_said_out_loud_exactly_once_and_then_stays_quiet() {
        // A cap is allowed; a SILENT cap is not — "silent giving-up = a false report".
        let mut wd = RegisterWatchdog::default();
        let mut t = Instant::now();
        for expected in 1..=REGISTER_RETRY_MAX {
            assert_eq!(wd.decide(true, false, t), RegisterAction::Idle);
            t += register_retry_after(expected - 1);
            match wd.decide(true, false, t) {
                RegisterAction::Resend { attempt, .. } => assert_eq!(attempt, expected),
                other => panic!("expected re-emit #{expected}, got {other:?}"),
            }
        }
        t += register_retry_after(REGISTER_RETRY_MAX);
        assert_eq!(
            wd.decide(true, false, t),
            RegisterAction::GiveUp { attempts: REGISTER_RETRY_MAX },
            "the cap must announce itself"
        );
        // …once. Not every 500 ms tick forever.
        for _ in 0..5 {
            t += Duration::from_secs(60);
            assert_eq!(wd.decide(true, false, t), RegisterAction::Idle);
        }
    }

    // ── RV-34: the watchdog is fed the RIGHT judgment ───────────────────────

    /// The pump's own wiring, minus the socket: a channel that is UP, has a token on
    /// disk, and whose handshake ack never landed.
    fn unacked_but_paired() -> Arc<Pairing> {
        let mut creds = Credentials::fresh("Test PC");
        creds.accept_registration("fm_tok", Some("pc-1".into()), Some("room-1".into()));
        Pairing::new(
            Arc::new(Mutex::new(creds)),
            Arc::new(std::env::temp_dir().join("flowmic-pump-watchdog-test.bin")),
            Arc::new(Mutex::new(None)),
            None,
            crate::socket::Channel::Lan,
            // No capsule latch: this watchdog decides on the handshake judgment alone,
            // and the RV-新C roster path has nothing to say to it.
            None,
            // Own registry (W8-2): this fixture asks nothing about successors, and
            // the process-wide one would race parallel tests.
            crate::socket::session_gen::SessionGenerations::new(),
        )
    }

    #[test]
    fn a_lost_reconnect_ack_on_a_live_socket_is_finally_watched() {
        // THE bug this card exists for. 0.2.17 wired this watchdog to
        // `Credentials::is_registered()`, so on any machine that had ever paired the
        // input was true forever and `connected && !registered` could not happen —
        // the ladder was unreachable code, and a `pc:reconnect` ack lost on a socket
        // that stayed up produced no local signal at all.
        let pairing = unacked_but_paired();
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();

        // What the pump feeds it NOW: "did the server recognize me".
        assert!(!pairing.handshake_acked());
        assert_eq!(wd.decide(true, pairing.handshake_acked(), t0), RegisterAction::Idle);
        assert!(
            matches!(
                wd.decide(true, pairing.handshake_acked(), t0 + REGISTER_RETRY_FIRST),
                RegisterAction::Resend { attempt: 1, .. }
            ),
            "connected + a token + no ack MUST reach the ladder"
        );

        // What it used to be fed: "does this machine have a token". Same watchdog, same clock,
        // silent forever — kept as an executable statement of the defect.
        let has_token = pairing.creds.lock().unwrap().is_registered();
        assert!(has_token, "the precondition of the reconnect leg");
        let mut old = RegisterWatchdog::default();
        assert_eq!(old.decide(true, has_token, t0), RegisterAction::Idle);
        assert_eq!(
            old.decide(true, has_token, t0 + REGISTER_RETRY_FIRST * 100),
            RegisterAction::Idle,
            "RV-34: with the token as the input this watchdog can never fire"
        );

        // The ack lands → the ladder goes quiet again.
        pairing.mark_handshake_acked("pc:reconnect");
        assert_eq!(
            wd.decide(true, pairing.handshake_acked(), t0 + REGISTER_RETRY_FIRST * 3),
            RegisterAction::Idle,
            "a confirmed handshake is nothing to chase"
        );

        // A NEW socket clears the claim (client.rs `open`), so the next connection is
        // watched from scratch even though the token never moved.
        pairing.clear_handshake_ack("new socket");
        assert!(!pairing.handshake_acked());
        assert!(pairing.creds.lock().unwrap().is_registered(), "the token is untouched");
    }

    #[test]
    fn a_down_or_already_registered_channel_is_never_asked_to_re_register() {
        let mut wd = RegisterWatchdog::default();
        let t0 = Instant::now();
        // No socket → the `open` handler owns registration; re-emitting into a dead
        // transport would only produce noise.
        for i in 0..10 {
            assert_eq!(wd.decide(false, false, t0 + Duration::from_secs(i * 30)), RegisterAction::Idle);
        }
        // Registered → nothing to chase, however long it has been up.
        for i in 0..10 {
            assert_eq!(wd.decide(true, true, t0 + Duration::from_secs(i * 30)), RegisterAction::Idle);
        }
    }
}

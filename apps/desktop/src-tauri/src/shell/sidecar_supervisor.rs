// Health-supervisor watch loop + its backoff/max policy, split out of
// sidecar_ctl.rs (2026-09-02, file-size cap — same technique as
// sidecar_lan_poll.rs / sidecar_node_select.rs). A CHILD module of sidecar_ctl
// so `use super::*` below reaches SidecarState's private accessors, plus
// `bring_up_and_connect` and `emit_state`, exactly as this code always could —
// VERBATIM move, no visibility widened.

use super::*;

/// Consecutive failed health probes before the local server is declared dead.
/// 3 × 5 s ≈ 15 s: long enough that a GC pause or a busy moment is not a death,
/// short enough that the user is not left staring at 「重新连接中」("reconnecting").
const SUPERVISOR_STRIKES: u32 = 3;
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(5);

/// D-B2L (2026-09-02, sidecar supervisor leftovers, item 1): base backoff
/// before the FIRST automatic restart once death is confirmed (SUPERVISOR_STRIKES
/// has already spent SUPERVISOR_STRIKES * SUPERVISOR_INTERVAL detecting it).
/// Doubles on each consecutive restart (crash-loop back-off) — see
/// `supervisor_backoff` — capped at SUPERVISOR_BACKOFF_MAX.
const SUPERVISOR_BACKOFF_BASE: Duration = Duration::from_secs(5);
const SUPERVISOR_BACKOFF_MAX: Duration = Duration::from_secs(300);
/// After this many consecutive automatic restarts without the server staying
/// up long enough to forgive the streak, the supervisor stops retrying on its
/// own and hands the device page a TERMINAL Failed state (Retry button, same
/// as every other failure) instead of restarting forever — a crash loop that
/// keeps silently announcing 「重新连接中」 forever is just a slower silent
/// failure (owner 2026-07-27's "never silent", the reason this supervisor
/// exists at all). Before this constant existed there was no ceiling: the
/// loop below re-ran `bring_up_and_connect` every time, forever, on ANY
/// server that kept dying right after restart.
const SUPERVISOR_MAX_RESTARTS: u32 = 6;
/// A restart streak is forgiven once the server has stayed healthy this long
/// since the last automatic restart — an occasional flake over the app's
/// whole runtime must not spend down the SAME budget a real crash loop needs.
/// 2 minutes ≈ 24 clean health checks at SUPERVISOR_INTERVAL.
const SUPERVISOR_FORGIVE_AFTER: Duration = Duration::from_secs(120);

/// Bounded exponential backoff for the Nth (1-based) consecutive automatic
/// restart. Pure so it is unit-testable without a thread or a clock: doubles
/// SUPERVISOR_BACKOFF_BASE on each attempt after the first, capped at
/// SUPERVISOR_BACKOFF_MAX so a long crash loop still gets re-probed
/// occasionally rather than backing off to nothing useful.
fn supervisor_backoff(consecutive_restarts: u32) -> Duration {
    let exp = consecutive_restarts.saturating_sub(1).min(10); // 2^10 is already far past the cap
    let secs = SUPERVISOR_BACKOFF_BASE.as_secs().saturating_mul(1u64 << exp);
    Duration::from_secs(secs.min(SUPERVISOR_BACKOFF_MAX.as_secs()))
}

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
pub(super) fn spawn_health_supervisor(app: &AppHandle) {
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
                // An already-failed sidecar is somebody else's story (Retry owns it).
                if !matches!(
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
                // A stable stretch forgives an EARLIER crash-loop streak — see
                // SUPERVISOR_FORGIVE_AFTER's doc comment for why this must not
                // share a budget with an actual crash loop.
                app2.state::<SidecarState>().forgive_restart_streak_if_older_than(SUPERVISOR_FORGIVE_AFTER);
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

            let attempt = app2.state::<SidecarState>().note_restart_attempt();
            // D-B2L item 3: read ONCE here (take_child_stderr_tail clears it),
            // then reuse for whichever branch below fires — the dead child's
            // own last words belong on BOTH the "waiting before retry" line
            // and the terminal give-up line, not just one of them.
            let last_stderr = app2.state::<SidecarState>().take_child_stderr_tail();
            if attempt > SUPERVISOR_MAX_RESTARTS {
                // D-B2L item 1: never silent, AND never forever. The device page
                // gets the same terminal Failed card + Retry button any other
                // bring-up failure gets, instead of an endless "reconnecting".
                let reason = FailReason::SupervisorGaveUp { restarts: SUPERVISOR_MAX_RESTARTS, last_stderr };
                forensic::record(
                    "sidecar",
                    &format!(
                        "supervisor: giving up after {SUPERVISOR_MAX_RESTARTS} consecutive automatic restarts with no stable recovery — {reason}"
                    ),
                );
                let state: State<SidecarState> = app2.state();
                state.kill_child(crate::exit_reason::SidecarKillCause::HealthSupervisorRestart);
                let phase = Phase::Failed { reason };
                state.set_phase(phase.clone());
                state.release_supervisor();
                emit_state(&app2, &phase, None);
                return;
            }

            let backoff = supervisor_backoff(attempt);
            // D-B2L item 3: the 0.2.50 lesson was a tail computed, logged once,
            // then thrown away — say it here too, not only in the eventual
            // SupervisorGaveUp card nobody may ever see if the next attempt works.
            let said = match last_stderr.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(t) => format!(" — it last said: {t}"),
                None => String::new(),
            };
            forensic::record(
                "sidecar",
                &format!(
                    "supervisor: local server is GONE — waiting {backoff:?} before automatic restart {attempt}/{SUPERVISOR_MAX_RESTARTS} (never silent){said}"
                ),
            );
            std::thread::sleep(backoff);
            {
                let state: State<SidecarState> = app2.state();
                // D8: this restart used to call `bring_up_and_connect` directly,
                // bypassing the reentrancy guard that function's own doc comment
                // says every caller must hold first — a device-page Retry racing
                // THIS restart could then run two `bring_up_and_connect`s at
                // once, the exact "two node server.js children" shape the guard
                // exists to prevent (SidecarState::bringing_up's doc comment).
                if !state.claim_bring_up() {
                    forensic::record(
                        "sidecar",
                        "supervisor: restart SKIPPED — a bring-up is already in flight (D8 reentrancy guard); the in-flight run will emit its own terminal status",
                    );
                    state.release_supervisor();
                    return;
                }
                // Reap our own corpse first: a dead child left in the slot would
                // otherwise be 'killed' again by the next exit path.
                state.kill_child(crate::exit_reason::SidecarKillCause::HealthSupervisorRestart);
                state.set_phase(Phase::Resolving);
                state.release_supervisor(); // the new bring-up claims a fresh one
            }
            emit_state(&app2, &Phase::Resolving, None);
            // bring_up_and_connect's own BringUpGuard releases the bring-up
            // slot claimed just above, whichever way it returns (D8).
            bring_up_and_connect(&app2);
            return;
        }
    });
}

#[cfg(test)]
mod supervisor_backoff_tests {
    use super::*;

    /// D-B2L (2026-09-02, sidecar supervisor leftovers, item 1): before this
    /// function existed, every automatic restart re-ran bring-up after the
    /// SAME fixed SUPERVISOR_STRIKES * SUPERVISOR_INTERVAL wait, forever — a
    /// server that crashes on startup would be re-spawned roughly every 15s
    /// with no growing delay and no ceiling. This pins the growth + the cap.
    #[test]
    fn backoff_doubles_then_caps() {
        assert_eq!(supervisor_backoff(1), SUPERVISOR_BACKOFF_BASE);
        assert_eq!(supervisor_backoff(2), SUPERVISOR_BACKOFF_BASE * 2);
        assert_eq!(supervisor_backoff(3), SUPERVISOR_BACKOFF_BASE * 4);
        assert_eq!(supervisor_backoff(4), SUPERVISOR_BACKOFF_BASE * 8);
        assert_eq!(
            supervisor_backoff(20),
            SUPERVISOR_BACKOFF_MAX,
            "a long crash loop must not back off past the cap"
        );
    }

    /// Reverse-control shape for the bug this fixes: a flat backoff (the
    /// pre-item-1 behaviour) would make this test fail on its second
    /// assertion, since attempt 2 would equal attempt 1 instead of doubling.
    #[test]
    fn backoff_is_not_flat() {
        assert_ne!(
            supervisor_backoff(1),
            supervisor_backoff(2),
            "a fixed-interval restart loop (the pre-item-1 shape) has no backoff at all"
        );
    }

    #[test]
    fn restart_attempts_count_up_from_one() {
        let state = SidecarState::new();
        assert_eq!(state.note_restart_attempt(), 1);
        assert_eq!(state.note_restart_attempt(), 2);
        assert_eq!(state.note_restart_attempt(), 3);
    }

    /// D-B2L: a manual Retry (`start()`) must reset the streak, or a machine
    /// that has flaked several times and been fixed by hand would still be
    /// one restart away from the terminal SupervisorGaveUp card.
    #[test]
    fn reset_restart_attempts_starts_the_streak_over() {
        let state = SidecarState::new();
        state.note_restart_attempt();
        state.note_restart_attempt();
        state.reset_restart_attempts();
        assert_eq!(
            state.note_restart_attempt(),
            1,
            "a reset streak's next attempt must be numbered 1 again, not 3"
        );
    }

    /// D-B2L: a streak old enough to have proven the server is fine again must
    /// not keep counting against the SAME crash-loop budget forever.
    #[test]
    fn a_restart_streak_older_than_the_forgive_window_resets_itself() {
        let state = SidecarState::new();
        state.note_restart_attempt();
        state.note_restart_attempt();
        std::thread::sleep(Duration::from_millis(30));
        state.forgive_restart_streak_if_older_than(Duration::from_millis(10));
        assert_eq!(
            state.note_restart_attempt(),
            1,
            "forgiven ⇒ the next attempt must start the count over"
        );
    }

    /// Reverse-control shape for the forgiveness fix: without it (or with the
    /// threshold check inverted), an occasional restart months apart would
    /// eventually exhaust SUPERVISOR_MAX_RESTARTS on a perfectly healthy
    /// machine. This also proves forgiveness does not fire EARLY.
    #[test]
    fn a_restart_streak_not_yet_stable_is_left_alone() {
        let state = SidecarState::new();
        state.note_restart_attempt();
        state.note_restart_attempt();
        state.forgive_restart_streak_if_older_than(Duration::from_secs(60));
        assert_eq!(
            state.note_restart_attempt(),
            3,
            "not stable long enough yet ⇒ the streak must not be reset"
        );
    }
}

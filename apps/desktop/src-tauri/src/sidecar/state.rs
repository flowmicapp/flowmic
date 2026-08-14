// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar lifecycle + port pinned at 41879:
//     EADDRINUSE fail-loud → adopt a healthy external listener (socket.io polling
//     probe) → else netstat+taskkill the port and respawn ONCE — F-2363/2365)
//   docs/rebuild/13-LESSONS-LEARNED.md §2 N-series (port/adopt), §4 (deploy)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-4 lead-controller ruling #1 (the port
//     remediation chain's ordering is a human-audit red line)
//     + #3 (the lifecycle state machine is made pure-logic and testable, modeled on the focus FSM)
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth + inject adjacency: the taskkill path
//       must never mis-kill; adopt-first ordering is enforced HERE, not in IO) ***
//
// The pure sidecar lifecycle + port-remediation state machine. Like focus::state
// it does NO I/O and reads NO wall clock: the Tauri IO layer (sidecar::io) performs
// spawn / probe / kill / handshake and feeds the RESULTS back as `Event`s; this
// machine decides the single next `Action`. Modelling it as a Mealy machine keeps
// the ONE red-line invariant unit-testable in isolation from the OS:
//
//   ┌─ THE RED LINE (lead-controller ruling #1) ─────────────────────────────────────────────┐
//   │ On EADDRINUSE we ALWAYS probe the existing listener FIRST                 │
//   │ (Action::ProbePort). A kill (Action::LocateAndKill) is only ever reached  │
//   │ from `Probing` on a `ProbeForeign` verdict, AT MOST ONCE per bring-up     │
//   │ (`port_clear_used`), and only the :41879 listener. A healthy external     │
//   │ FlowMic is ADOPTED (never killed). After the single kill+respawn, a       │
//   │ still-occupied port is terminal Failed — the machine NEVER loop-kills.    │
//   └──────────────────────────────────────────────────────────────────────────┘
//
// Lifecycle (lead-controller ruling #3):
//   Resolving → Spawning → AwaitingHandshake → AwaitingHealth
//              → Healthy | AdoptedExternal | Failed(reason)
//   with the EADDRINUSE detour  Spawning → Probing → {AdoptedExternal | Clearing
//   → (respawn) Spawning}. `Failed` carries a Retry button (RetryRequested resets
//   both one-shot budgets and restarts at Resolving) — the lifecycle's "Retry (once)".

use serde::{Deserialize, Serialize};

/// Why the sidecar gave up. Carries enough detail for the forensic log and the
/// device-page error card (07 §5: fail-loud, never a silent dead sidecar).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailReason {
    /// No `server.js` in any of the resolve candidates (MSI/exe/dev/cwd).
    ResolveFailed,
    /// Spawn syscall itself failed (node missing, permission, EISDIR after norm…).
    SpawnFailed { detail: String },
    /// No `FLOWMIC_LISTENING` line within the handshake window.
    HandshakeTimeout,
    /// The health poll never saw `/api/health` 200 within its window.
    HealthFailed,
    /// The child process exited before reaching Healthy (1.5 s exit watchdog).
    ///
    /// `stderr` is the tail the child printed on its way out, `None` when nobody
    /// was still buffering it (the post-handshake path). It is part of the reason
    /// — not decoration: 「child exited (code 1)」 alone is a true sentence that
    /// cannot be acted on, and on 2026-08-03 a second machine showed exactly that
    /// while Node had already printed the answer onto a pipe we threw away.
    ChildExited { code: Option<i32>, stderr: Option<String> },
    /// After the single allowed clear, :41879 is STILL held by a non-FlowMic
    /// process — we refuse to loop-kill (lead-controller ruling #1).
    PortOccupiedForeign,
    /// netstat/taskkill of the port listener failed.
    ClearFailed { detail: String },
}

impl std::fmt::Display for FailReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FailReason::ResolveFailed => write!(f, "server.js not found (MSI/exe/dev/cwd)"),
            FailReason::SpawnFailed { detail } => write!(f, "spawn failed: {detail}"),
            FailReason::HandshakeTimeout => write!(f, "handshake timeout (no FLOWMIC_LISTENING)"),
            FailReason::HealthFailed => write!(f, "health check failed (/api/health not 200)"),
            FailReason::ChildExited { code, stderr } => {
                match code {
                    Some(c) => write!(f, "child exited (code {c})")?,
                    None => write!(f, "child exited (signal)")?,
                }
                match stderr.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "<none>") {
                    Some(tail) => write!(f, " — {tail}"),
                    // Say that the child was silent rather than saying nothing:
                    // an absent tail and an unread tail look identical on screen,
                    // and only one of them means「去看它的 stderr」("go look at its stderr").
                    None => write!(f, " — no stderr output"),
                }
            }
            FailReason::PortOccupiedForeign => {
                write!(f, "port 41879 still occupied by a foreign process after one clear")
            }
            FailReason::ClearFailed { detail } => write!(f, "port clear failed: {detail}"),
        }
    }
}

/// The lifecycle phase — also the device-page status model (07 §5). `endpoint` is
/// the `http://host:port` the desktop should `connect` to once terminal-healthy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Phase {
    Resolving,
    Spawning,
    AwaitingHandshake,
    AwaitingHealth { port: u16 },
    /// Our OWN child is up and healthy — connect here, kill it on quit.
    Healthy { endpoint: String },
    /// EADDRINUSE → probing the existing listener (socket.io polling + /api/health).
    Probing,
    /// Probe said "alive but NOT FlowMic" → about to netstat+taskkill the port.
    Clearing,
    /// A healthy external FlowMic already owns :41879 — ADOPT it (never kill).
    AdoptedExternal { endpoint: String },
    Failed { reason: FailReason },
}

impl Phase {
    /// The endpoint to `connect` to, if this phase is terminal-healthy.
    pub fn endpoint(&self) -> Option<&str> {
        match self {
            Phase::Healthy { endpoint } | Phase::AdoptedExternal { endpoint } => Some(endpoint),
            _ => None,
        }
    }
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Phase::Healthy { .. } | Phase::AdoptedExternal { .. } | Phase::Failed { .. }
        )
    }
}

/// What the IO layer must do next. The machine is the single authority on
/// ordering — the IO layer never decides to kill on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Resolve `server.js` across MSI/exe/dev/cwd candidates.
    Resolve,
    /// Spawn `node server.js --mode standalone --port 41879` (CREATE_NO_WINDOW).
    Spawn,
    /// Wait for the `FLOWMIC_LISTENING` stdout line (+ 1.5 s child-exit watchdog).
    AwaitHandshake,
    /// Poll `/api/health` on our child until 200 (or the window elapses).
    ProbeHealth { endpoint: String },
    /// EADDRINUSE remediation STEP 1 (always first): probe the existing listener —
    /// socket.io polling to prove it's alive + /api/health to prove it's FlowMic.
    ProbePort,
    /// EADDRINUSE remediation STEP 2 (only after ProbeForeign, only once): forensic-
    /// record the PID+process name, then netstat-locate + taskkill the :41879 owner.
    LocateAndKill,
    /// Terminal success — `connect` to this endpoint.
    Connect { endpoint: String },
    /// Terminal failure — surface the error card + Retry button.
    Fail { reason: FailReason },
    /// Nothing to do right now (waiting on an async result).
    Wait,
}

/// State-machine inputs, fed by the IO layer as its async operations complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// `server.js` was found (Resolving → Spawning).
    Resolved,
    /// No `server.js` candidate exists.
    ResolveFailed,
    /// The child process handle was created (Spawning → AwaitingHandshake).
    Spawned,
    /// Spawn observed EADDRINUSE (either the syscall or the child's own bind-fail
    /// stderr). Triggers the ADOPT-FIRST remediation detour.
    SpawnPortInUse,
    /// Spawn failed for a non-port reason.
    SpawnFailed { detail: String },
    /// The `FLOWMIC_LISTENING port=…` line was seen.
    Listening { port: u16 },
    /// No handshake line within the window.
    HandshakeTimeout,
    /// `/api/health` returned 200 for OUR child.
    HealthOk { endpoint: String },
    /// The health window elapsed without a 200.
    HealthFailed,
    /// The 1.5 s watchdog saw the child process exit before Healthy. `stderr` is
    /// the tail it printed (`None` when nobody was buffering any more).
    ChildExited { code: Option<i32>, stderr: Option<String> },
    /// Probe verdict: the existing :41879 listener IS a healthy FlowMic → adopt.
    ProbeAdoptable { endpoint: String },
    /// Probe verdict: :41879 is alive but NOT FlowMic (or the probe failed) → clear.
    ProbeForeign,
    /// taskkill succeeded — the port is free again (→ respawn once).
    PortCleared,
    /// netstat/taskkill failed.
    ClearFailed { detail: String },
    /// User pressed Retry on the error card (Failed → Resolving, budgets reset).
    RetryRequested,
}

/// The sidecar lifecycle machine. One instance per desktop process; the IO layer
/// drives it and executes the returned `Action`.
pub struct SidecarMachine {
    phase: Phase,
    /// The :41879 clear (taskkill) has been used this bring-up. Gates entry to
    /// `Clearing` — THE one-kill red-line guard (lead-controller ruling #1). Reset by RetryRequested.
    port_clear_used: bool,
    /// The endpoint we bind/dial (host:port). Fixed at construction; the probe/
    /// health events carry the concrete `http://host:port` string.
    base_endpoint: String,
}

impl SidecarMachine {
    /// `base_endpoint` is the loopback URL the child binds and we health-probe,
    /// e.g. `http://127.0.0.1:41879`.
    pub fn new(base_endpoint: impl Into<String>) -> Self {
        Self { phase: Phase::Resolving, port_clear_used: false, base_endpoint: base_endpoint.into() }
    }

    pub fn phase(&self) -> &Phase {
        &self.phase
    }

    /// Whether a kill has already been spent this bring-up (for forensics/tests).
    pub fn port_clear_used(&self) -> bool {
        self.port_clear_used
    }

    /// The first action of a bring-up (kick Resolving). Idempotent to call when
    /// already Resolving.
    pub fn start(&mut self) -> Action {
        self.phase = Phase::Resolving;
        self.port_clear_used = false;
        Action::Resolve
    }

    /// Drive one transition and return the next `Action` for the IO layer.
    pub fn on_event(&mut self, event: Event) -> Action {
        // User Retry is accepted from any Failed state, resetting both budgets.
        if let (Phase::Failed { .. }, Event::RetryRequested) = (&self.phase, &event) {
            return self.start();
        }

        match (&self.phase, event) {
            // ── Resolving ──────────────────────────────────────────────
            (Phase::Resolving, Event::Resolved) => {
                self.phase = Phase::Spawning;
                Action::Spawn
            }
            (Phase::Resolving, Event::ResolveFailed) => self.fail(FailReason::ResolveFailed),

            // ── Spawning ───────────────────────────────────────────────
            (Phase::Spawning, Event::Spawned) => {
                self.phase = Phase::AwaitingHandshake;
                Action::AwaitHandshake
            }
            // EADDRINUSE → ADOPT-FIRST detour (the red line: probe BEFORE any kill).
            (Phase::Spawning, Event::SpawnPortInUse) => {
                self.phase = Phase::Probing;
                Action::ProbePort
            }
            (Phase::Spawning, Event::SpawnFailed { detail }) => {
                self.fail(FailReason::SpawnFailed { detail })
            }

            // ── AwaitingHandshake ──────────────────────────────────────
            (Phase::AwaitingHandshake, Event::Listening { port }) => {
                self.phase = Phase::AwaitingHealth { port };
                Action::ProbeHealth { endpoint: self.base_endpoint.clone() }
            }
            (Phase::AwaitingHandshake, Event::HandshakeTimeout) => {
                self.fail(FailReason::HandshakeTimeout)
            }
            (Phase::AwaitingHandshake, Event::ChildExited { code, stderr }) => {
                self.fail(FailReason::ChildExited { code, stderr })
            }
            // A late EADDRINUSE surfaced only via the child's stderr after the
            // handle was created still routes through adopt-first.
            (Phase::AwaitingHandshake, Event::SpawnPortInUse) => {
                self.phase = Phase::Probing;
                Action::ProbePort
            }

            // ── AwaitingHealth ─────────────────────────────────────────
            (Phase::AwaitingHealth { .. }, Event::HealthOk { endpoint }) => {
                self.phase = Phase::Healthy { endpoint: endpoint.clone() };
                Action::Connect { endpoint }
            }
            (Phase::AwaitingHealth { .. }, Event::HealthFailed) => self.fail(FailReason::HealthFailed),
            (Phase::AwaitingHealth { .. }, Event::ChildExited { code, stderr }) => {
                self.fail(FailReason::ChildExited { code, stderr })
            }

            // ── Probing (EADDRINUSE remediation step 1) ────────────────
            (Phase::Probing, Event::ProbeAdoptable { endpoint }) => {
                // A healthy external FlowMic owns the port — ADOPT, never kill.
                self.phase = Phase::AdoptedExternal { endpoint: endpoint.clone() };
                Action::Connect { endpoint }
            }
            (Phase::Probing, Event::ProbeForeign) => {
                if self.port_clear_used {
                    // Already killed once this bring-up — do NOT loop-kill.
                    self.fail(FailReason::PortOccupiedForeign)
                } else {
                    self.phase = Phase::Clearing;
                    Action::LocateAndKill
                }
            }

            // ── Clearing (EADDRINUSE remediation step 2 — the single kill) ─
            (Phase::Clearing, Event::PortCleared) => {
                self.port_clear_used = true; // spend the one-kill budget
                self.phase = Phase::Spawning;
                Action::Spawn // respawn ONCE
            }
            (Phase::Clearing, Event::ClearFailed { detail }) => {
                self.port_clear_used = true; // a failed kill still spends the budget
                self.fail(FailReason::ClearFailed { detail })
            }

            // ── Failed / terminal-healthy: ignore stray async events ───
            (Phase::Failed { reason }, _) => Action::Fail { reason: reason.clone() },
            (Phase::Healthy { endpoint }, _) | (Phase::AdoptedExternal { endpoint }, _) => {
                Action::Connect { endpoint: endpoint.clone() }
            }

            // ── Defensive: any other (phase,event) pair is a no-op wait ─
            _ => Action::Wait,
        }
    }

    fn fail(&mut self, reason: FailReason) -> Action {
        self.phase = Phase::Failed { reason: reason.clone() };
        Action::Fail { reason }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EP: &str = "http://127.0.0.1:41879";

    fn healthy_endpoint() -> String {
        EP.to_string()
    }

    #[test]
    fn happy_path_resolves_spawns_handshakes_and_connects() {
        let mut m = SidecarMachine::new(EP);
        assert_eq!(m.start(), Action::Resolve);
        assert_eq!(m.on_event(Event::Resolved), Action::Spawn);
        assert_eq!(m.on_event(Event::Spawned), Action::AwaitHandshake);
        assert_eq!(
            m.on_event(Event::Listening { port: 41879 }),
            Action::ProbeHealth { endpoint: healthy_endpoint() }
        );
        assert_eq!(
            m.on_event(Event::HealthOk { endpoint: healthy_endpoint() }),
            Action::Connect { endpoint: healthy_endpoint() }
        );
        assert!(matches!(m.phase(), Phase::Healthy { .. }));
        assert_eq!(m.phase().endpoint(), Some(EP));
    }

    #[test]
    fn eaddrinuse_adopts_a_healthy_external_flowmic_without_killing() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        // Spawn hits EADDRINUSE → the FIRST action MUST be a probe, never a kill.
        assert_eq!(m.on_event(Event::SpawnPortInUse), Action::ProbePort);
        assert!(matches!(m.phase(), Phase::Probing));
        // The existing listener is a healthy FlowMic → adopt it.
        assert_eq!(
            m.on_event(Event::ProbeAdoptable { endpoint: healthy_endpoint() }),
            Action::Connect { endpoint: healthy_endpoint() }
        );
        assert!(matches!(m.phase(), Phase::AdoptedExternal { .. }));
        // The one-kill budget was never spent — no taskkill happened.
        assert!(!m.port_clear_used(), "adopt path must NOT spend the kill budget");
    }

    #[test]
    fn eaddrinuse_foreign_kills_once_then_respawns_healthy() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        assert_eq!(m.on_event(Event::SpawnPortInUse), Action::ProbePort);
        // Probe says the listener is alive but NOT FlowMic → kill (step 2).
        assert_eq!(m.on_event(Event::ProbeForeign), Action::LocateAndKill);
        assert!(matches!(m.phase(), Phase::Clearing));
        // Kill succeeds → respawn ONCE.
        assert_eq!(m.on_event(Event::PortCleared), Action::Spawn);
        assert!(m.port_clear_used(), "the one-kill budget is now spent");
        assert!(matches!(m.phase(), Phase::Spawning));
        // The respawn is healthy.
        m.on_event(Event::Spawned);
        m.on_event(Event::Listening { port: 41879 });
        assert!(matches!(
            m.on_event(Event::HealthOk { endpoint: healthy_endpoint() }),
            Action::Connect { .. }
        ));
    }

    #[test]
    fn respawn_hitting_port_in_use_again_never_kills_a_second_time() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::SpawnPortInUse);
        m.on_event(Event::ProbeForeign); // → Clearing
        m.on_event(Event::PortCleared); // → Spawning (budget spent)
        // The respawn ALSO hits EADDRINUSE (something re-grabbed the port).
        assert_eq!(m.on_event(Event::SpawnPortInUse), Action::ProbePort);
        // A re-probe is still allowed (read-only, could adopt a racer)…
        // …but a foreign verdict now is TERMINAL — NEVER a second kill.
        let action = m.on_event(Event::ProbeForeign);
        assert_eq!(action, Action::Fail { reason: FailReason::PortOccupiedForeign });
        assert!(matches!(m.phase(), Phase::Failed { .. }));
    }

    #[test]
    fn respawn_racer_that_is_healthy_flowmic_is_adopted_not_killed() {
        // After our single kill+respawn loses the port to ANOTHER healthy FlowMic,
        // adopt-first still applies on the re-probe (never a second kill).
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::SpawnPortInUse);
        m.on_event(Event::ProbeForeign);
        m.on_event(Event::PortCleared);
        m.on_event(Event::SpawnPortInUse); // respawn → port in use again
        assert_eq!(
            m.on_event(Event::ProbeAdoptable { endpoint: healthy_endpoint() }),
            Action::Connect { endpoint: healthy_endpoint() }
        );
        assert!(matches!(m.phase(), Phase::AdoptedExternal { .. }));
    }

    #[test]
    fn handshake_timeout_is_terminal_failed() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::Spawned);
        assert_eq!(
            m.on_event(Event::HandshakeTimeout),
            Action::Fail { reason: FailReason::HandshakeTimeout }
        );
    }

    #[test]
    fn child_exit_before_healthy_is_detected_and_failed() {
        // The 1.5 s exit watchdog: a child that dies during handshake → Failed.
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::Spawned);
        assert_eq!(
            m.on_event(Event::ChildExited { code: Some(1), stderr: Some("boom".into()) }),
            Action::Fail {
                reason: FailReason::ChildExited { code: Some(1), stderr: Some("boom".into()) }
            }
        );
        // …and also from AwaitingHealth.
        let mut m2 = SidecarMachine::new(EP);
        m2.start();
        m2.on_event(Event::Resolved);
        m2.on_event(Event::Spawned);
        m2.on_event(Event::Listening { port: 41879 });
        assert!(matches!(
            m2.on_event(Event::ChildExited { code: None, stderr: None }),
            Action::Fail { reason: FailReason::ChildExited { code: None, stderr: None } }
        ));
    }

    /// 2026-08-03 — a second machine's device page could only say「child exited
    /// (code 1)」, a true sentence nobody can act on, while the answer sat on a
    /// pipe we read and dropped. The reason string is what the card renders
    /// (`sidecar_ctl::dto` → `reason.to_string()`), so assert it HERE.
    #[test]
    fn child_exit_reason_carries_what_the_child_actually_said() {
        let with_tail = FailReason::ChildExited {
            code: Some(1),
            stderr: Some("SyntaxError: Cannot use import statement outside a module".into()),
        };
        let rendered = with_tail.to_string();
        assert!(rendered.contains("code 1"), "the code must survive: {rendered}");
        assert!(
            rendered.contains("Cannot use import statement"),
            "the child's own words must reach the card: {rendered}"
        );

        // Reverse control: without a tail the card must SAY the child was silent.
        // 「说不出话」("couldn't say anything") and 「话没被读到」("the words were
        // never read") look identical on screen otherwise, and
        // only one of them means「去翻它的 stderr」("go dig through its stderr").
        for silent in [
            FailReason::ChildExited { code: Some(1), stderr: None },
            FailReason::ChildExited { code: Some(1), stderr: Some("  ".into()) },
            // `<none>` is stderr_tail()'s own empty marker — it must not leak
            // through as if the child had printed the literal string.
            FailReason::ChildExited { code: Some(1), stderr: Some("<none>".into()) },
        ] {
            let r = silent.to_string();
            assert!(r.contains("no stderr output"), "silence must be named: {r}");
            assert!(!r.contains("<none>"), "the internal marker must not reach the card: {r}");
        }
    }

    #[test]
    fn resolve_failure_is_terminal_failed() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        assert_eq!(
            m.on_event(Event::ResolveFailed),
            Action::Fail { reason: FailReason::ResolveFailed }
        );
    }

    #[test]
    fn clear_failure_spends_the_budget_and_fails_loud() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::SpawnPortInUse);
        m.on_event(Event::ProbeForeign);
        let action = m.on_event(Event::ClearFailed { detail: "taskkill 128".into() });
        assert!(matches!(action, Action::Fail { reason: FailReason::ClearFailed { .. } }));
        assert!(m.port_clear_used(), "a failed kill still spends the one-kill budget");
    }

    #[test]
    fn user_retry_from_failed_restarts_and_resets_the_kill_budget() {
        let mut m = SidecarMachine::new(EP);
        m.start();
        m.on_event(Event::Resolved);
        m.on_event(Event::SpawnPortInUse);
        m.on_event(Event::ProbeForeign);
        m.on_event(Event::PortCleared); // budget spent
        m.on_event(Event::SpawnPortInUse);
        m.on_event(Event::ProbeForeign); // → Failed (no second kill)
        assert!(matches!(m.phase(), Phase::Failed { .. }));
        // User presses Retry → fresh bring-up, budget reset.
        assert_eq!(m.on_event(Event::RetryRequested), Action::Resolve);
        assert!(matches!(m.phase(), Phase::Resolving));
        assert!(!m.port_clear_used(), "Retry resets the one-kill budget for a NEW attempt");
    }

    #[test]
    fn never_emits_kill_before_a_probe() {
        // Exhaustive ordering guard for the human auditor: from EVERY pre-terminal
        // phase, feeding SpawnPortInUse never yields LocateAndKill directly — the
        // only route to a kill is Probing + ProbeForeign.
        for kickoff in 0..3 {
            let mut m = SidecarMachine::new(EP);
            m.start();
            m.on_event(Event::Resolved);
            if kickoff >= 1 {
                m.on_event(Event::Spawned);
            }
            let a = m.on_event(Event::SpawnPortInUse);
            assert_ne!(a, Action::LocateAndKill, "kill must never precede a probe");
        }
    }
}

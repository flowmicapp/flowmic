// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (focus tracking and the SPEAKING lock — while speaking,
//     mid-utterance window switches must NOT change the inject target)
//
// Pure focus state machine. No Win32 calls and no async I/O — every transition
// is driven by an externally supplied FocusEvent and a caller-provided
// monotonic `now_ms`. This is the single source of truth for "which window
// will we inject into?" so the SPEAKING-lock invariant is unit-testable in
// isolation from the OS event hook.
//
// The spec enum (Idle / SpeakingLocked / Injecting / Cooldown) does not carry a
// target in Idle/Cooldown, but background ForegroundChanged events still need
// to update the "current candidate" so a later SpeakStarted has somewhere to
// lock. That candidate lives in a private `last_foreground` sidecar so the
// public enum stays exactly as specified.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FocusState {
    Idle,
    SpeakingLocked {
        target_hwnd: u64,
        app_name: String,
        window_title: String,
    },
    Injecting {
        target_hwnd: u64,
        app_name: String,
        window_title: String,
    },
    Cooldown {
        until_ms: u64,
    },
}

/// State-machine inputs:
///   1. SetWinEventHook EVENT_SYSTEM_FOREGROUND → ForegroundChanged
///   2. audio:start                              → SpeakStarted
///   3. audio:stop + final                       → SpeakEnded
///   4. inject pipeline begin                    → InjectStarted
///   5. inject pipeline end                      → InjectFinished
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FocusEvent {
    ForegroundChanged {
        /// 🔴 AN OPAQUE OS TOKEN, AND IT IS NOT THE SAME KIND OF THING ON EVERY
        /// PLATFORM (MAC-04, 2026-08-07):
        ///   · Windows — an `HWND`. Foreground is a WINDOW there.
        ///   · macOS   — a **pid**. There is no permission-free way to name or
        ///     raise one window of another process, so activation is APP-level and
        ///     this carries the application. `focus/macos.rs` has the account.
        /// The FSM and the inject pipeline never dereference it — they hand it back
        /// to `focus::set_foreground_window`, which is the only code that knows
        /// what it is — so the two meanings coexist without a second field. The
        /// name stays `hwnd` because renaming it reaches `socket/` and the wire.
        hwnd: u64,
        app_name: String,
        /// The foreground WINDOW's title, or "" when there is none to be had.
        /// ⚠️ Always "" on macOS, structurally: the title of another process's
        /// window needs Accessibility or Screen-Recording permission, which MAC-04
        /// deliberately does not take. Win32 also answers "" when it cannot read
        /// one, so every consumer already handles it.
        window_title: String,
    },
    SpeakStarted,
    SpeakEnded,
    InjectStarted,
    InjectFinished {
        now_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StateError {
    #[error("illegal transition from {from} on event {event}")]
    IllegalTransition { from: String, event: String },
}

pub struct FocusStateMachine {
    state: FocusState,
    cooldown_ms: u64,
    /// Most recent foreground observed while Idle/Cooldown. SpeakStarted
    /// promotes this into SpeakingLocked. None until the first ForegroundChanged.
    last_foreground: Option<(u64, String, String)>,
}

impl FocusStateMachine {
    pub fn new(cooldown_ms: u64) -> Self {
        Self {
            state: FocusState::Idle,
            cooldown_ms,
            last_foreground: None,
        }
    }

    pub fn state(&self) -> &FocusState {
        &self.state
    }

    /// Promote Cooldown → Idle when the window elapsed. Idempotent elsewhere.
    pub fn tick(&mut self, now_ms: u64) {
        if let FocusState::Cooldown { until_ms } = self.state {
            if now_ms >= until_ms {
                self.state = FocusState::Idle;
            }
        }
    }

    /// Drive a transition. `now_ms` is a caller-supplied monotonic timestamp;
    /// the machine never reads the wall clock.
    pub fn handle(&mut self, event: FocusEvent, now_ms: u64) -> Result<&FocusState, StateError> {
        self.tick(now_ms);

        match (&self.state, event) {
            // ── Idle ──────────────────────────────────────────────────
            (
                FocusState::Idle,
                FocusEvent::ForegroundChanged {
                    hwnd,
                    app_name,
                    window_title,
                },
            ) => {
                self.last_foreground = Some((hwnd, app_name, window_title));
            }
            (FocusState::Idle, FocusEvent::SpeakStarted) => {
                if let Some((hwnd, ref app, ref title)) = self.last_foreground {
                    self.state = FocusState::SpeakingLocked {
                        target_hwnd: hwnd,
                        app_name: app.clone(),
                        window_title: title.clone(),
                    };
                } else {
                    return Err(StateError::IllegalTransition {
                        from: "Idle".into(),
                        event: "SpeakStarted (no foreground sidecar)".into(),
                    });
                }
            }
            (FocusState::Idle, FocusEvent::InjectStarted) => {
                if let Some((hwnd, ref app, ref title)) = self.last_foreground {
                    self.state = FocusState::Injecting {
                        target_hwnd: hwnd,
                        app_name: app.clone(),
                        window_title: title.clone(),
                    };
                } else {
                    return Err(StateError::IllegalTransition {
                        from: "Idle".into(),
                        event: "InjectStarted (no foreground sidecar)".into(),
                    });
                }
            }
            (FocusState::Idle, FocusEvent::SpeakEnded)
            | (FocusState::Idle, FocusEvent::InjectFinished { .. }) => {
                // Idempotent no-op on startup.
            }

            // ── SpeakingLocked: the lock invariant ────────────────────
            (FocusState::SpeakingLocked { .. }, FocusEvent::ForegroundChanged { .. }) => {
                // IGNORED. While speaking, mid-utterance window switches must
                // NOT change the inject target, and we do not even update the
                // sidecar — the user's intent is the window they spoke into.
            }
            (FocusState::SpeakingLocked { .. }, FocusEvent::SpeakEnded) => {
                self.state = FocusState::Idle;
            }
            (FocusState::SpeakingLocked { .. }, FocusEvent::SpeakStarted) => {
                // Idempotent: PTT-down while already locked.
            }
            (
                FocusState::SpeakingLocked {
                    target_hwnd,
                    app_name,
                    window_title,
                },
                FocusEvent::InjectStarted,
            ) => {
                // Speak → inject without an explicit SpeakEnded carries the
                // locked target with it.
                self.state = FocusState::Injecting {
                    target_hwnd: *target_hwnd,
                    app_name: app_name.clone(),
                    window_title: window_title.clone(),
                };
            }
            (FocusState::SpeakingLocked { .. }, FocusEvent::InjectFinished { .. }) => {
                return Err(StateError::IllegalTransition {
                    from: "SpeakingLocked".into(),
                    event: "InjectFinished".into(),
                });
            }

            // ── Injecting ─────────────────────────────────────────────
            (FocusState::Injecting { .. }, FocusEvent::InjectFinished { now_ms: t }) => {
                self.state = FocusState::Cooldown {
                    until_ms: t.saturating_add(self.cooldown_ms),
                };
            }
            (FocusState::Injecting { .. }, FocusEvent::ForegroundChanged { .. }) => {
                // Lock extends through Injecting: we are physically writing
                // into target_hwnd; a foreground change here would be racy.
            }
            (FocusState::Injecting { .. }, FocusEvent::SpeakStarted)
            | (FocusState::Injecting { .. }, FocusEvent::SpeakEnded)
            | (FocusState::Injecting { .. }, FocusEvent::InjectStarted) => {
                // Defensive no-op. Only InjectFinished may exit.
            }

            // ── Cooldown ──────────────────────────────────────────────
            (FocusState::Cooldown { .. }, FocusEvent::ForegroundChanged { .. }) => {
                // IGNORED: cooldown shields the just-injected window from
                // spurious foreground events (some apps refocus after paste).
            }
            (FocusState::Cooldown { .. }, FocusEvent::SpeakStarted) => {
                if let Some((hwnd, ref app, ref title)) = self.last_foreground {
                    self.state = FocusState::SpeakingLocked {
                        target_hwnd: hwnd,
                        app_name: app.clone(),
                        window_title: title.clone(),
                    };
                } else {
                    return Err(StateError::IllegalTransition {
                        from: "Cooldown".into(),
                        event: "SpeakStarted (no foreground sidecar)".into(),
                    });
                }
            }
            (FocusState::Cooldown { .. }, _) => {
                // Other events while cooling: ignore. Cooldown auto-exits via tick().
            }
        }

        Ok(&self.state)
    }

    /// Read-only access to the sidecar candidate.
    pub fn last_foreground(&self) -> Option<&(u64, String, String)> {
        self.last_foreground.as_ref()
    }

    /// Production lock entry (WP-R2-1b — the SPEAKING-lock wiring seam).
    ///
    /// `audio:start` fan-out captures the CURRENT LIVE foreground (F-2344: the
    /// hook's ring can be stale because clicking a control inside an already-
    /// foreground window fires no EVENT_SYSTEM_FOREGROUND) and locks it here,
    /// UNCONDITIONALLY — a new utterance re-locks the fresh live target even if a
    /// prior lock/inject is still lingering (its inject window has closed). This
    /// is deliberately not the event-driven `SpeakStarted` path (which only locks
    /// the ring sidecar and is a no-op while already SpeakingLocked); the live
    /// target is the caller's truth, so it is written straight in.
    pub fn force_lock(&mut self, target_hwnd: u64, app_name: String, window_title: String) {
        self.last_foreground = Some((target_hwnd, app_name.clone(), window_title.clone()));
        self.state = FocusState::SpeakingLocked {
            target_hwnd,
            app_name,
            window_title,
        };
    }

    /// Watchdog / abandon release (WP-R2-1b, ruling 2). The lock is normally
    /// released by the inject path (InjectStarted → InjectFinished → Cooldown)
    /// AFTER `inject_text` resolves — never on speak-end (the unlock-before-inject
    /// race). This is the BACKSTOP the 32s hard-timeout watchdog calls to force
    /// a lingering SpeakingLocked/Injecting back to Idle when no injection ever
    /// resolved (delivery:'none', empty final, dropped link). The sidecar is kept
    /// so ordinary foreground tracking resumes immediately.
    pub fn force_release(&mut self) {
        if matches!(
            self.state,
            FocusState::SpeakingLocked { .. } | FocusState::Injecting { .. }
        ) {
            self.state = FocusState::Idle;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fg(hwnd: u64) -> FocusEvent {
        FocusEvent::ForegroundChanged {
            hwnd,
            app_name: "notepad".into(),
            window_title: "Untitled - Notepad".into(),
        }
    }

    #[test]
    fn speak_locks_the_last_foreground_target() {
        let mut m = FocusStateMachine::new(200);
        m.handle(fg(0x10), 0).unwrap();
        m.handle(FocusEvent::SpeakStarted, 1).unwrap();
        match m.state() {
            FocusState::SpeakingLocked { target_hwnd, .. } => assert_eq!(*target_hwnd, 0x10),
            other => panic!("expected SpeakingLocked, got {other:?}"),
        }
    }

    #[test]
    fn speaking_lock_ignores_mid_utterance_foreground_change() {
        let mut m = FocusStateMachine::new(200);
        m.handle(fg(0x10), 0).unwrap();
        m.handle(FocusEvent::SpeakStarted, 1).unwrap();
        // A different window comes to the foreground WHILE speaking.
        m.handle(fg(0x99), 2).unwrap();
        match m.state() {
            FocusState::SpeakingLocked { target_hwnd, .. } => {
                assert_eq!(*target_hwnd, 0x10, "lock target must not move to 0x99");
            }
            other => panic!("expected lock held, got {other:?}"),
        }
    }

    #[test]
    fn speak_without_a_sidecar_is_an_illegal_transition() {
        let mut m = FocusStateMachine::new(200);
        let err = m.handle(FocusEvent::SpeakStarted, 0).unwrap_err();
        assert!(matches!(err, StateError::IllegalTransition { .. }));
    }

    #[test]
    fn inject_finished_enters_then_auto_exits_cooldown() {
        let mut m = FocusStateMachine::new(200);
        m.handle(fg(0x10), 0).unwrap();
        m.handle(FocusEvent::InjectStarted, 1).unwrap();
        m.handle(FocusEvent::InjectFinished { now_ms: 100 }, 100).unwrap();
        assert!(matches!(m.state(), FocusState::Cooldown { until_ms } if *until_ms == 300));
        m.tick(300);
        assert_eq!(m.state(), &FocusState::Idle);
    }

    #[test]
    fn force_lock_overrides_any_state_with_the_live_target() {
        let mut m = FocusStateMachine::new(200);
        // From Idle with a stale sidecar → live target wins.
        m.handle(fg(0x10), 0).unwrap();
        m.force_lock(0xAB, "chatgpt".into(), "ChatGPT - Chrome".into());
        match m.state() {
            FocusState::SpeakingLocked { target_hwnd, app_name, .. } => {
                assert_eq!(*target_hwnd, 0xAB, "live target beats the ring sidecar (F-2344)");
                assert_eq!(app_name, "chatgpt");
            }
            other => panic!("expected SpeakingLocked, got {other:?}"),
        }
        // A NEW utterance re-locks even while already SpeakingLocked (the prior
        // event-driven SpeakStarted would have been a no-op here).
        m.force_lock(0xCD, "notepad".into(), "Untitled - Notepad".into());
        assert!(matches!(m.state(), FocusState::SpeakingLocked { target_hwnd, .. } if *target_hwnd == 0xCD));
        // And the sidecar tracks the live target so a later InjectStarted has a seed.
        assert_eq!(m.last_foreground().unwrap().0, 0xCD);
    }

    #[test]
    fn force_release_backstops_a_lingering_lock_and_injecting() {
        let mut m = FocusStateMachine::new(200);
        m.force_lock(0x10, "notepad".into(), "n".into());
        m.force_release();
        assert_eq!(m.state(), &FocusState::Idle, "watchdog releases a stuck lock");
        // Also from Injecting (a hung pipeline never sent InjectFinished).
        m.force_lock(0x11, "notepad".into(), "n".into());
        m.handle(FocusEvent::InjectStarted, 1).unwrap();
        assert!(matches!(m.state(), FocusState::Injecting { .. }));
        m.force_release();
        assert_eq!(m.state(), &FocusState::Idle);
        // No-op from Idle/Cooldown (never disturbs a benign state).
        m.force_release();
        assert_eq!(m.state(), &FocusState::Idle);
    }

    #[test]
    fn lock_held_through_inject_finished_release_is_after_resolve() {
        // Ruling 2 lifecycle: SpeakStarted (lock) → InjectStarted (carry) →
        // InjectFinished (release to Cooldown), NEVER released on SpeakEnded.
        let mut m = FocusStateMachine::new(200);
        m.force_lock(0x77, "notepad".into(), "n".into());
        m.handle(FocusEvent::InjectStarted, 10).unwrap();
        match m.state() {
            FocusState::Injecting { target_hwnd, .. } => assert_eq!(*target_hwnd, 0x77, "lock carried into inject"),
            other => panic!("expected Injecting carrying the lock, got {other:?}"),
        }
        m.handle(FocusEvent::InjectFinished { now_ms: 20 }, 20).unwrap();
        assert!(matches!(m.state(), FocusState::Cooldown { .. }), "released only after inject resolved");
    }

    #[test]
    fn speak_ended_returns_to_idle_and_refreshes_candidate() {
        let mut m = FocusStateMachine::new(200);
        m.handle(fg(0x10), 0).unwrap();
        m.handle(FocusEvent::SpeakStarted, 1).unwrap();
        m.handle(FocusEvent::SpeakEnded, 2).unwrap();
        assert_eq!(m.state(), &FocusState::Idle);
        // A fresh foreground now updates the sidecar again.
        m.handle(fg(0x20), 3).unwrap();
        assert_eq!(m.last_foreground().unwrap().0, 0x20);
    }
}

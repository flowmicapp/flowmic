// Unit tests for the lock/watchdog contract, kept in a sibling file so client.rs
// (the audited auth/wiring core) stays under the 800-line source cap.
//
// GA-28 moved the subject under test — `should_disarm_watchdog` and its inject
// runners — into socket::inject_ops when client.rs crossed the cap a second time.
// The test file stayed put (its subject is the same one-utterance-per-lock
// contract) and now names its imports explicitly instead of inheriting them.

use super::*;
use crate::focus::{FocusEvent, FocusState};
use crate::socket::inject_ops::should_disarm_watchdog;

// Coordinator must-fix (interleave): utterance #2's audio:start (force_lock)
// that interrupts an in-flight inject must NOT have its 32s watchdog disarmed
// by utterance #1's InjectFinished — else a stale lock could wedge with no
// watchdog and mis-target a later manual/history inject into the wrong window.
#[test]
fn interleaved_relock_keeps_the_new_utterances_watchdog_armed() {
    let mut fsm = FocusStateMachine::new(FSM_COOLDOWN_MS);
    // #1: speak-lock, then its inject enters the pipeline (Injecting #1).
    fsm.force_lock(0x1001, "notepad".into(), "n1".into());
    let _ = fsm.handle(FocusEvent::InjectStarted, 0);
    assert!(matches!(fsm.state(), FocusState::Injecting { target_hwnd, .. } if *target_hwnd == 0x1001));

    // #2's audio:start arrives mid-pipeline → re-lock + a fresh armed deadline.
    fsm.force_lock(0x2002, "chatgpt".into(), "c2".into());
    let mut deadline: Option<Instant> = Some(Instant::now()); // #2's watchdog, armed
    assert!(matches!(fsm.state(), FocusState::SpeakingLocked { target_hwnd, .. } if *target_hwnd == 0x2002));

    // #1's inject resolves: InjectFinished from SpeakingLocked is illegal and
    // ignored (FSM keeps #2's lock). The disarm decision must be "keep armed".
    let _ = fsm.handle(FocusEvent::InjectFinished { now_ms: 10 }, 10);
    assert!(
        matches!(fsm.state(), FocusState::SpeakingLocked { target_hwnd, .. } if *target_hwnd == 0x2002),
        "the new utterance's lock survives #1's resolve"
    );
    if should_disarm_watchdog(fsm.state()) {
        deadline = None;
    }
    assert!(
        deadline.is_some(),
        "#2's watchdog must stay armed (bug: #1's InjectFinished disarmed it)"
    );

    // With the deadline still armed, the watchdog can still release #2's lock
    // if #2's inject never lands.
    fsm.force_release();
    assert_eq!(fsm.state(), &FocusState::Idle);
}

#[test]
fn watchdog_disarms_only_after_the_lock_actually_released() {
    // Lone inject: Injecting → InjectFinished → Cooldown → disarm.
    let mut fsm = FocusStateMachine::new(FSM_COOLDOWN_MS);
    fsm.force_lock(0x30, "notepad".into(), "n".into());
    let _ = fsm.handle(FocusEvent::InjectStarted, 0);
    let _ = fsm.handle(FocusEvent::InjectFinished { now_ms: 5 }, 5);
    assert!(matches!(fsm.state(), FocusState::Cooldown { .. }));
    assert!(should_disarm_watchdog(fsm.state()), "a released lock → disarm");
    // A SpeakingLocked state never disarms.
    let mut locked = FocusStateMachine::new(FSM_COOLDOWN_MS);
    locked.force_lock(0x40, "notepad".into(), "n".into());
    assert!(!should_disarm_watchdog(locked.state()), "an active lock keeps its watchdog");
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (the SPEAKING lock never gets wedged / ruling 2)
//   CLAUDE.md red line: "a latch closed by a remote event must have a local watchdog"
//   docs/strategy/2026-08-02-0248-status-truth-analysis.md §F3 (owner 2026-08-02:
//     the tray's red dot stays lit with nobody speaking)
//
// "is audio still flowing" —— the ONE liveness signal the SPEAKING lock's local watchdog
// runs on, and the only question this type is allowed to answer.
//
// WHY IT EXISTS. The desktop's SPEAKING lock is closed by REMOTE events: it opens
// on `audio:start` and normally closes when an `inject:request` resolves. 0.2.48
// backstopped that with an ABSOLUTE 32 s deadline armed at `audio:start`
// (`client.rs` — grep `lock_deadline`: exactly ONE arming site, and
// `socket/pump.rs`'s `watchdog_expired`). That deadline has two holes, both of
// which put a red dot in the tray with nobody speaking:
//
//   ① IT IS BLIND TO EVERY LOCK THAT DID NOT COME FROM `audio:start`.
//      `FocusState::Injecting` is also 「recording」 to the tray (pump.rs), and it
//      is reachable from `Idle` with the deadline still `None` — a local reinject
//      (`local_inject::reinject_locally` → `inject_ops::run_inject` →
//      `FocusEvent::InjectStarted`), or any `inject:request` that lands after the
//      deadline already fired and disarmed. `watchdog_expired(None, _)` is
//      `false` FOREVER, so those states have NO watchdog at all.
//   ② IT KILLS A REAL LONG UTTERANCE. Being absolute, it force-releases a lock at
//      32 s even while the user is still talking and audio is still arriving —
//      the SPEAKING-lock invariant (07 §3) silently stops holding mid-sentence.
//
// The fix for both is to stop timing an EVENT and start timing a STATE, refreshed
// by evidence that audio is still flowing. That is exactly the shape the capsule
// already ships in `apps/desktop/src/lib/speaking-watchdog.ts`
// (`LATCH_WATCHDOG_MS`, `signal()`): a latch closed remotely, backstopped locally,
// kept alive by `stt:interim` / `stt:final` / `stt:level`. One shape, two
// surfaces — the tray and the HUD now answer "is it still speaking" the same way instead of
// two different ways.
//
// ⚠️ `audio:stop` is deliberately NOT a signal here, for the reason written at the
// top of speaking-watchdog.ts: after the user stops talking we are WAITING for the
// final + the LLM + the inject, and the silence measured from the last real audio
// signal is precisely what has to trip the watchdog if that never arrives.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A shared "when was the last audio/transcription signal received" clock. Cloneable so the socket
/// handlers that observe the signals and the pump thread that reads them share one
/// value; per-channel like the FSM it guards (each `connect()` makes its own).
#[derive(Clone, Default)]
pub(in crate::socket) struct SpeakLiveness {
    last: Arc<Mutex<Option<Instant>>>,
}

impl SpeakLiveness {
    pub(in crate::socket) fn new() -> Self {
        Self::default()
    }

    /// A sustaining signal arrived (`audio:start` / `stt:interim` / `stt:final` /
    /// `stt:level`). Production entry point; `signal_at` is the time-injected twin
    /// the tests drive.
    pub(in crate::socket) fn signal(&self) {
        self.signal_at(Instant::now());
    }

    pub(in crate::socket) fn signal_at(&self, now: Instant) {
        if let Ok(mut g) = self.last.lock() {
            *g = Some(now);
        }
    }

    /// `None` = no audio signal has EVER been seen on this channel. A poisoned
    /// mutex reads as `None` too, which is the safe direction: it makes the lock
    /// look starved (→ released) rather than immortal.
    pub(in crate::socket) fn last(&self) -> Option<Instant> {
        self.last.lock().ok().and_then(|g| *g)
    }
}

/// The watchdog's pure decision core: has the lock been held with NO audio
/// evidence for longer than `cap`?
///
/// `entered` is when the FSM was first OBSERVED in SpeakingLocked/Injecting, which
/// is what makes this cover hole ① — a state nobody armed a deadline for still has
/// a clock. The window runs from the LATER of "entering this state" and "the last audio signal",
/// so a signal stream slides the deadline (hole ②: a 10-minute utterance is never
/// killed while `stt:interim`/`stt:level` keep landing) while total starvation
/// still trips it.
///
/// `entered: None` (the FSM is not in a locked state) is never starved — there is
/// nothing to release, and returning true there would make the pump force-release
/// on every idle tick.
pub(in crate::socket) fn lock_starved(
    entered: Option<Instant>,
    last_signal: Option<Instant>,
    now: Instant,
    cap: Duration,
) -> bool {
    let Some(entered) = entered else {
        return false;
    };
    // A signal from BEFORE this state was entered says nothing about this lock —
    // it is the previous utterance's. Only a signal that landed since counts.
    let since = match last_signal {
        Some(s) if s > entered => s,
        _ => entered,
    };
    now.saturating_duration_since(since) >= cap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unlocked_fsm_is_never_starved() {
        // The pump calls this every 500 ms; `entered: None` must be inert or it
        // would force-release on every idle tick.
        assert!(!lock_starved(None, None, Instant::now(), Duration::from_secs(32)));
    }

    #[test]
    fn a_lock_with_no_signal_at_all_starves_from_the_moment_it_was_entered() {
        // Hole ① in the shape it actually reaches production: a local reinject enters
        // `Injecting` with NO `audio:start` behind it, so there is no signal and
        // no armed deadline. The clock still runs, from the state entry.
        let t0 = Instant::now();
        let cap = Duration::from_secs(32);
        assert!(!lock_starved(Some(t0), None, t0 + Duration::from_secs(31), cap));
        assert!(lock_starved(Some(t0), None, t0 + Duration::from_secs(32), cap));
    }

    #[test]
    fn a_signal_from_the_previous_utterance_does_not_extend_this_lock() {
        // The clock must not be refreshable by history: a signal older than the
        // state entry is the LAST utterance's, and counting it would let a wedged
        // lock inherit someone else's liveness.
        let t0 = Instant::now();
        let stale = t0 - Duration::from_secs(10);
        let cap = Duration::from_secs(32);
        assert!(lock_starved(Some(t0), Some(stale), t0 + cap, cap));
    }

    #[test]
    fn a_signal_stream_slides_the_deadline_so_a_long_utterance_survives() {
        // Hole ②: the 0.2.48 ABSOLUTE deadline force-released a live utterance at
        // 32 s. Five minutes of speech, one signal every 500 ms (what
        // `stt:level`/`stt:interim` actually do), must never trip.
        let t0 = Instant::now();
        let cap = Duration::from_secs(32);
        let mut now = t0;
        let mut last = t0;
        for _ in 0..600 {
            last = now;
            now += Duration::from_millis(500);
            assert!(
                !lock_starved(Some(t0), Some(last), now, cap),
                "audio still flowing at {:?} — the lock must hold",
                now.saturating_duration_since(t0)
            );
        }
        // …and the moment the audio stops, the cap runs from the LAST signal, not
        // from the start of the utterance.
        assert!(!lock_starved(Some(t0), Some(last), last + Duration::from_secs(31), cap));
        assert!(lock_starved(Some(t0), Some(last), last + Duration::from_secs(32), cap));
    }

    #[test]
    fn signal_is_shared_across_clones() {
        // The handlers hold clones and the pump reads one — if `signal()` did not
        // travel between them the watchdog would see permanent starvation and kill
        // every utterance at the cap.
        let a = SpeakLiveness::new();
        let b = a.clone();
        assert_eq!(a.last(), None, "no signal has been seen yet");
        let t = Instant::now();
        b.signal_at(t);
        assert_eq!(a.last(), Some(t), "a clone's signal is visible to the reader");
    }
}

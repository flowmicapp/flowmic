// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (the SPEAKING lock never gets wedged / ruling 2)
//   CLAUDE.md red line: "a latch closed by a remote event must have a local watchdog"
//   socket/speak_liveness.rs (the sibling clock; this file is the OTHER half of the
//     same question and deliberately does not touch it)
//   socket/focus/state.rs (the "empty final" case the 32 s backstop is documented
//     to cover — this is that case being answered in one tick instead of 32 s)
//
// "did this utterance end with NOTHING to inject" —— the ONE question this type is
// allowed to answer.
//
// WHY IT EXISTS. The SPEAKING lock is opened by `audio:start` and closed, normally,
// by the inject path (`inject_ops.rs`: InjectStarted → InjectFinished). `audio:stop`
// deliberately does NOT close it (ruling 2 — releasing on speak-end is the
// unlock-before-inject race), and `stt:final` only feeds liveness. So for an
// utterance that produced NO TEXT — a 3 s hold with no speech, a mis-hit button —
// there is no `inject:request`, nothing ever leaves `SpeakingLocked`, and the ONLY
// exit is the 32 s starvation backstop in socket/pump.rs. The user experience is a
// tray that claims 录音 for ~34 s after a 3 s hold; focus/state.rs:266 already names
// "empty final" as the case that backstop covers, which is precisely the admission
// that the case has no answer of its own.
//
// WHAT THIS IS NOT. It is not a second release authority: it hands its verdict to
// the SAME `speaking_watchdog_tick` that owns the existing one, so there is still
// exactly ONE site that calls `force_release`. And it is not a shortcut around
// ruling 2 — the release it asks for is conditioned on a final that carried NO
// text, which is exactly the case in which no inject can ever follow.
//
// THE TWO FLAGS, and why both are required:
//
//   · `stop_seen` — `audio:stop` arrived, i.e. the hold is OVER. Without it a
//     mid-hold segment rollover (the server emits `is_segment=true` finals while
//     the user keeps talking, orchestrator-core.ts) whose text happened to be
//     empty would release a lock the user is still speaking into.
//   · `last_final_empty` — the utterance-closing final carried no text. Without
//     it every `audio:stop` would release, which IS ruling 2's race.
//
// ORDER DOES NOT MATTER. The two frames race in production (`audio:stop` is the
// phone's, `stt:final` is the engine's, and they travel independently), so the
// latch is a pair of sticky flags read together rather than a state machine that
// assumes one comes first. Either arrival order arms it; neither alone does.
//
// A NON-EMPTY FINAL CLEARS BOTH. That utterance is going to inject, so the latch
// must carry nothing into the window where `inject:request` lands — which is the
// whole of the unlock-before-inject race it is forbidden to reopen.

use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Flags {
    stop_seen: bool,
    last_final_empty: bool,
}

/// The shared per-utterance latch. Cloneable so the socket handlers that observe
/// the frames and the pump thread that acts on them share one value; per-channel
/// like the FSM and `SpeakLiveness` it sits beside (each `connect()` makes its own).
#[derive(Clone, Default)]
pub(in crate::socket) struct EmptyFinalLatch {
    flags: Arc<Mutex<Flags>>,
}

impl EmptyFinalLatch {
    pub(in crate::socket) fn new() -> Self {
        Self::default()
    }

    /// `audio:stop` arrived on this channel: the hold is over.
    pub(in crate::socket) fn note_audio_stop(&self) {
        self.with(|f| f.stop_seen = true);
    }

    /// An `stt:final` arrived. `is_segment` finals are mid-hold rollovers and say
    /// nothing about whether the UTTERANCE produced text, so they are ignored
    /// outright rather than trusted to be filtered by `stop_seen` alone — two
    /// independent guards, because the cost of getting this wrong is releasing a
    /// lock the user is still speaking into.
    pub(in crate::socket) fn note_final(&self, is_segment: bool, text_is_empty: bool) {
        if is_segment {
            return;
        }
        self.with(|f| {
            if text_is_empty {
                f.last_final_empty = true;
            } else {
                // This utterance HAS text ⇒ an inject:request is coming. Drop
                // everything, including `stop_seen`: the inject path owns the
                // release from here (inject_ops.rs InjectStarted → InjectFinished).
                *f = Flags::default();
            }
        });
    }

    /// The pump's read: "is this lock releasable BECAUSE the utterance was empty?"
    /// Consuming — a verdict is spent by the tick that acts on it, so a later frame
    /// cannot be released twice by the same evidence.
    pub(in crate::socket) fn take_if_armed(&self) -> bool {
        let mut armed = false;
        self.with(|f| {
            armed = f.stop_seen && f.last_final_empty;
            if armed {
                *f = Flags::default();
            }
        });
        armed
    }

    /// Drop any half-armed state. The pump calls this on every tick in which the
    /// FSM is NOT holding a lock: there is nothing to release then, so keeping a
    /// leftover flag could only ever let one utterance's evidence arm the next
    /// one's release.
    pub(in crate::socket) fn reset(&self) {
        self.with(|f| *f = Flags::default());
    }

    /// A poisoned mutex reads/writes through `into_inner` rather than unwinding:
    /// the pump thread must not be killable by this latch (pump.rs's PumpLife note
    /// — a pump that dies stops every CONNECTION frame reaching the UI).
    fn with(&self, f: impl FnOnce(&mut Flags)) {
        let mut g = self.flags.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g);
    }
}

/// 🔴 LEAVE A TRACE — the forensic line for a release this branch performs, written
/// here rather than at the call site (pump.rs is at its 800-line cap, and the
/// reasoning this sentence encodes belongs beside the latch anyway).
///
/// Same discipline as the starvation watchdog's line: without it, "why did the red
/// dot go out by itself" is unanswerable after the fact, and a release that fires
/// silently is indistinguishable from a bug that fixed itself. It says WHICH of the
/// two exits fired — this one is the fast, evidence-based exit, and reaching the
/// `cap` instead would mean the empty final never arrived at all, which is a
/// different fault with a different fix.
pub(in crate::socket) fn release_note(tag: &str, held: Duration, cap: Duration) -> String {
    format!(
        "empty final after audio:stop -> release (channel={tag}): held {}s. The utterance \
         carried no text, so no inject:request can follow and there is nothing left to hold \
         the window for; the tray stops claiming recording from this tick instead of at the \
         {}s cap.",
        held.as_secs(),
        cap.as_secs()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neither_flag_alone_arms_the_latch() {
        let l = EmptyFinalLatch::new();
        l.note_audio_stop();
        assert!(!l.take_if_armed(), "a stop with no final says nothing about text");

        let l = EmptyFinalLatch::new();
        l.note_final(false, true);
        assert!(!l.take_if_armed(), "an empty final mid-hold is not an ended hold");
    }

    #[test]
    fn either_arrival_order_arms_it() {
        // stop → final (the common order: the phone's frame beats the engine's)
        let l = EmptyFinalLatch::new();
        l.note_audio_stop();
        l.note_final(false, true);
        assert!(l.take_if_armed());

        // final → stop (the engine wins the race)
        let l = EmptyFinalLatch::new();
        l.note_final(false, true);
        l.note_audio_stop();
        assert!(l.take_if_armed());
    }

    #[test]
    fn a_non_empty_final_clears_both_flags_so_the_inject_path_keeps_the_lock() {
        // Ruling 2's race, in latch form: this utterance is going to inject, so
        // nothing this latch holds may survive into that window.
        let l = EmptyFinalLatch::new();
        l.note_audio_stop();
        l.note_final(false, false);
        assert!(!l.take_if_armed());
        // …and a LATER stop must not resurrect it either — the evidence is gone.
        l.note_audio_stop();
        assert!(!l.take_if_armed());
    }

    #[test]
    fn a_mid_hold_segment_rollover_is_ignored_even_when_it_is_empty() {
        // The user is still talking; a soft-segment final happened to carry no
        // text. Releasing here would move the inject target mid-sentence.
        let l = EmptyFinalLatch::new();
        l.note_final(true, true);
        l.note_audio_stop();
        assert!(!l.take_if_armed());
    }

    #[test]
    fn the_verdict_is_spent_by_the_tick_that_takes_it() {
        let l = EmptyFinalLatch::new();
        l.note_audio_stop();
        l.note_final(false, true);
        assert!(l.take_if_armed());
        assert!(!l.take_if_armed(), "one utterance may not release two locks");
    }

    #[test]
    fn reset_drops_a_half_armed_latch() {
        let l = EmptyFinalLatch::new();
        l.note_final(false, true);
        l.reset();
        l.note_audio_stop();
        assert!(!l.take_if_armed(), "the previous utterance's final may not arm this one");
    }

    #[test]
    fn the_release_note_names_this_exit_and_not_the_cap() {
        // The two exits from SpeakingLocked have different faults behind them, so
        // the log has to tell them apart: reaching the cap means the empty final
        // never arrived, which is a link problem, not an empty utterance.
        let n = release_note("lan", Duration::from_secs(3), Duration::from_secs(32));
        assert!(n.contains("empty final after audio:stop"), "{n}");
        assert!(n.contains("held 3s"), "{n}");
        assert!(n.contains("channel=lan"), "{n}");
    }

    #[test]
    fn flags_are_shared_across_clones() {
        // The handlers hold clones and the pump reads one — if the flags did not
        // travel between them the release would never fire in production while
        // every test here stayed green.
        let a = EmptyFinalLatch::new();
        let b = a.clone();
        b.note_audio_stop();
        b.note_final(false, true);
        assert!(a.take_if_armed(), "a clone's observation is visible to the reader");
    }
}

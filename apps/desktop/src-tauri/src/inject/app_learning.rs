// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Per-app learning)
//
// Per-app inject-outcome memory. Keyed by `app_name` (the process basename)
// since HWNDs are ephemeral but the app identity the user perceives is stable.
//
// 🔴 2026-08-26 — WHAT THIS STORE MEANS CHANGED, TWICE IN ONE DAY, and the old
// header is preserved here because it is what the spec still describes:
//
//     「SendInput failure → next time go straight to Clipboard; SendInput
//      success → write back and restore SendInput; cached is not learned」
//
// The second clause is gone: a typed 「success」 is not evidence the target
// received anything, and while typing was the default that clause is what made
// the owner's Cursor corruption permanent. The third stands. The first is now
// the ONLY thing this store records at all — see `record_outcome`, which is
// where both halves of the story are written down.
//
// ⚠️ 07-DESKTOP-SPEC.md §2 still carries the old rule. It is a behaviour
// contract, so the divergence is named here rather than left for a reader to
// discover: this file is the implementation, that file is the contract, and the
// contract is the one that has to be corrected — not this comment.

use crate::inject::pipeline::InjectMode;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Per-app inject-outcome memory: app_name → preferred next-inject mode.
pub struct AppLearningStore {
    inner: Mutex<HashMap<String, InjectMode>>,
}

impl AppLearningStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Process-wide singleton the inject pipeline consults instead of
    /// threading the store through every call signature.
    pub fn global() -> &'static Self {
        static STORE: OnceLock<AppLearningStore> = OnceLock::new();
        STORE.get_or_init(AppLearningStore::new)
    }

    /// Record an inject outcome for `app_id`.
    ///   SendInput + _     → next prefers Clipboard (see below).
    ///   Clipboard + _     → next prefers Clipboard (fallback worked; keep it).
    ///   Cached + _        → ignored; the target was never alive.
    ///
    /// ── 🔴 WHY `SendInput + true` NO LONGER MEANS 「keep typing here」 ──────
    ///
    /// It used to, and that one arm is why the defect below could never heal
    /// itself. Reported by the owner 2026-08-26: translate mode injects English
    /// into Cursor and characters go missing; inject one Chinese sentence and
    /// English is fine from then on.
    ///
    /// The mechanism, end to end: English is pure ASCII, so `text_route`
    /// sends it down the typed path. Cursor (Electron) drops some of the
    /// synthesised keystrokes. `SendInput` still reports SUCCESS — because the
    /// `true` it hands us means 「Windows accepted the events we posted」, NOT
    /// 「the target received them」. So this arm wrote back 「typing is fine for
    /// Cursor」 and the next English sentence took the same broken road, for
    /// ever. Injecting Chinese routed to the clipboard, which DID write
    /// `Clipboard` here, and that is the only reason it ever recovered.
    ///
    /// One value answering a different question than it is asked is this
    /// repo's #1 defect shape, and R11 states the rule it breaks: a verdict
    /// whose evidence never reached the layer making it is right only by
    /// accident. There is no evidence available here — a post-hoc read-back
    /// can only ever say YES (`inject/readback.rs`; Cursor's editor does not
    /// expose ValuePattern at all), so 「I could not tell」 and 「it worked」
    /// are indistinguishable at this seam.
    ///
    /// ⇒ The typed path no longer earns its own re-election. It is still used
    /// when an app has no history at all, so nothing is locked out; it just
    /// stops being able to vote for itself on evidence it does not have.
    /// 「I don't know」 must not share a verdict with 「it's fine」.
    ///
    /// ── 🔴 SECOND HALF, SAME DAY: THIS STORE NOW CARRIES EXACTLY ONE FACT ──
    ///
    /// The other half of the fix landed hours later: `text_route::route_text`
    /// made the CLIPBOARD the default for all text, with a console exception.
    /// That changes what this store is FOR, and leaving it as it was would have
    /// left a mechanism that looks alive and decides nothing.
    ///
    /// Before: 「which road should this app take next」 — a real question while
    /// typing was the default. After: the default already answers that. The one
    /// thing this store can still say that nothing else can is:
    ///
    /// ```text
    /// THIS APP RETURNED A HARD ERROR FROM SendInput.
    /// ```
    ///
    /// and its one remaining job is to override the console exception, because
    /// a terminal where typing physically fails must not be sent back to typing
    /// for ever (`route_text` rule 2 over rule 3).
    ///
    /// So every other arm records NOTHING, and each for its own reason:
    ///   · `SendInput` + success — the success is not evidence (above);
    ///   · `Clipboard` + anything — a paste outcome answers 「did the paste
    ///     work」, never 「does typing work here」. Recording it was how an app
    ///     got moved between roads by a question nobody asked;
    ///   · `Cached` — the target was never alive.
    ///
    /// ⚠️ Callers still hand over the full outcome; the POLICY of what is worth
    /// remembering lives here, in one place, and is pinned by the tests below.
    /// That is deliberate — a caller that pre-filters would be a second author
    /// of the same rule.
    pub fn record_outcome(&self, app_id: &str, mode: InjectMode, success: bool) {
        let hard_typing_rejection = matches!(mode, InjectMode::SendInput) && !success;
        if !hard_typing_rejection {
            return;
        }
        if let Ok(mut g) = self.inner.lock() {
            g.insert(app_id.to_string(), InjectMode::Clipboard);
        }
    }

    /// Preferred starting mode for the next inject to `app_id`, or `None` when
    /// there is no history (caller defaults to SendInput per Stage 2).
    pub fn preferred_mode_for(&self, app_id: &str) -> Option<InjectMode> {
        self.inner.lock().ok().and_then(|g| g.get(app_id).copied())
    }

    #[cfg(test)]
    pub fn clear_for_tests(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.clear();
        }
    }
}

impl Default for AppLearningStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_store_has_no_history() {
        let store = AppLearningStore::new();
        assert_eq!(store.preferred_mode_for("notepad"), None);
    }

    #[test]
    fn sendinput_failure_steers_next_inject_to_clipboard() {
        let store = AppLearningStore::new();
        store.record_outcome("game", InjectMode::SendInput, false);
        assert_eq!(store.preferred_mode_for("game"), Some(InjectMode::Clipboard));
        // Per-app, not global — other apps unaffected.
        assert_eq!(store.preferred_mode_for("notepad"), None);
    }

    /// 🔴 THIS TEST USED TO ASSERT THE DEFECT, AND IT WENT RED THE MOMENT THE
    /// DEFECT WAS FIXED — 2026-08-26, verbatim:
    ///
    /// ```text
    ///   assertion `left == right` failed: a later success must revert the app
    ///   to the fast path
    /// ```
    ///
    /// It was named `sendinput_success_recovers_primary_path` and it required
    /// that a 「successful」 typed injection re-elect the typed path. That is
    /// exactly the behaviour that made the owner's Cursor bug permanent (see
    /// `record_outcome`), because the success it trusted means 「Windows took
    /// our events」, not 「the target got the characters」.
    ///
    /// This repo wrote the law down after the last time (0.2.52): a control
    /// pointed the wrong way is worse than no control — it does not merely miss
    /// a defect, it makes the defect the acceptance criterion, and it goes red
    /// on the day the fix lands so the fix looks like the mistake. Second
    /// sighting. The rewrite below pins the new rule AND keeps the property the
    /// old one was really protecting: an app is never locked out of the typed
    /// path, because a store with no history still answers `None`.
    #[test]
    fn a_typed_injection_never_re_elects_the_typed_path() {
        let store = AppLearningStore::new();
        store.record_outcome("game", InjectMode::SendInput, false);
        assert_eq!(store.preferred_mode_for("game"), Some(InjectMode::Clipboard));
        store.record_outcome("game", InjectMode::SendInput, true);
        assert_eq!(
            store.preferred_mode_for("game"),
            Some(InjectMode::Clipboard),
            "a typed 'success' is not evidence the target received anything",
        );
        // The property the old test was really defending: nothing is locked
        // out. An app this store has never seen still gets the fast path.
        assert_eq!(store.preferred_mode_for("never-seen"), None);
    }

    /// 🔴 REWRITTEN 2026-08-26 (second half). Was `clipboard_success_keeps_clipboard`,
    /// which asserted that a paste outcome writes a preference. That was true and
    /// harmless while typing was the default; once the clipboard BECAME the
    /// default it would have meant every successful injection into any app wrote
    /// `Clipboard` here — and this store's only remaining job is to override the
    /// console exception, so that would have quietly disabled the exception after
    /// one sentence in every terminal.
    #[test]
    fn a_paste_outcome_records_nothing_in_either_direction() {
        let store = AppLearningStore::new();
        store.record_outcome("uwp", InjectMode::Clipboard, true);
        store.record_outcome("uwp", InjectMode::Clipboard, false);
        assert_eq!(
            store.preferred_mode_for("uwp"),
            None,
            "a paste answers 'did the paste work', never 'does typing work here'",
        );
    }

    #[test]
    fn the_console_exception_survives_a_successful_typed_injection() {
        // The composed property, asserted where it can actually go wrong. A
        // terminal types (route rule 3); if that write-back came back, the very
        // next sentence into the same terminal would paste instead — and the
        // exception would be dead without a single test going red.
        let store = AppLearningStore::new();
        store.record_outcome("pwsh", InjectMode::SendInput, true);
        assert_eq!(store.preferred_mode_for("pwsh"), None);
        // ...but a hard rejection still takes it off the typed path for good.
        store.record_outcome("pwsh", InjectMode::SendInput, false);
        assert_eq!(store.preferred_mode_for("pwsh"), Some(InjectMode::Clipboard));
    }

    #[test]
    fn cached_is_not_recorded() {
        let store = AppLearningStore::new();
        store.record_outcome("desktop", InjectMode::Cached, false);
        store.record_outcome("desktop", InjectMode::Cached, true);
        assert_eq!(store.preferred_mode_for("desktop"), None);
    }

    #[test]
    fn global_singleton_is_shared() {
        let a = AppLearningStore::global() as *const _;
        let b = AppLearningStore::global() as *const _;
        assert_eq!(a, b, "global() must return the same OnceLock-backed singleton");
    }
}

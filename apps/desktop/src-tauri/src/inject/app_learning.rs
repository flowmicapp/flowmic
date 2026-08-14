// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Per-app learning: SendInput failure → next
//     time go straight to Clipboard; SendInput success → write back and restore
//     SendInput; cached is not learned)
//
// Per-app inject-outcome memory. Records whether each foreground app rejected
// the SendInput primary path so the next inject to the same app can skip the
// failed mode automatically. Keyed by `app_name` (the process basename) since
// HWNDs are ephemeral but the app identity the user perceives is stable. A
// SendInput SUCCESS overwrites any prior failure so a transient game-mode
// rejection does not lock an app onto clipboard-paste-forever.

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
    ///   SendInput + false → next prefers Clipboard (skip the failed path).
    ///   SendInput + true  → next prefers SendInput (recovered; not stuck).
    ///   Clipboard + _     → next prefers Clipboard (fallback worked; keep it).
    ///   Cached + _        → ignored; the target was never alive.
    pub fn record_outcome(&self, app_id: &str, mode: InjectMode, success: bool) {
        let preferred_next = match (mode, success) {
            (InjectMode::Cached, _) => return,
            (InjectMode::SendInput, true) => InjectMode::SendInput,
            (InjectMode::SendInput, false) => InjectMode::Clipboard,
            (InjectMode::Clipboard, _) => InjectMode::Clipboard,
        };
        if let Ok(mut g) = self.inner.lock() {
            g.insert(app_id.to_string(), preferred_next);
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

    #[test]
    fn sendinput_success_recovers_primary_path() {
        let store = AppLearningStore::new();
        store.record_outcome("game", InjectMode::SendInput, false);
        assert_eq!(store.preferred_mode_for("game"), Some(InjectMode::Clipboard));
        store.record_outcome("game", InjectMode::SendInput, true);
        assert_eq!(
            store.preferred_mode_for("game"),
            Some(InjectMode::SendInput),
            "a later success must revert the app to the fast path",
        );
    }

    #[test]
    fn clipboard_success_keeps_clipboard() {
        let store = AppLearningStore::new();
        store.record_outcome("uwp", InjectMode::Clipboard, true);
        assert_eq!(store.preferred_mode_for("uwp"), Some(InjectMode::Clipboard));
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

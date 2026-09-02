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
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const APP_LEARNING_FILE: &str = "app-learning.json";

/// On-disk shape. The store's ONLY recorded fact is 「this app hard-rejected
/// SendInput, go straight to Clipboard」 (see `record_outcome`'s doc comment
/// for why nothing else is ever written) — so a set of app_ids is the whole
/// truth, not a map to `InjectMode`. `InjectMode` itself stays free of
/// `serde` derives: this file does not need a second serialisation of a type
/// whose only other encoding is the wire's `.wire()` token, and the two have
/// no reason to be forced to agree.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppLearningFile {
    clipboard_pinned: HashSet<String>,
}

impl AppLearningFile {
    /// Absent → empty (normal first run). Corrupt / unreadable → ALSO empty,
    /// but NAMED on the forensic log — same discipline as
    /// `socket::typed_ledger::TypedLedgerFile::load`: a file that silently
    /// stopped being read is indistinguishable from a machine with no
    /// history, and only one of those is worth a note.
    fn load(path: &Path) -> Self {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                crate::forensic::record(
                    "inject",
                    &format!("app-learning file {path:?} could not be read ({e}) — starting empty"),
                );
                return Self::default();
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(e) => {
                crate::forensic::record(
                    "inject",
                    &format!("app-learning file {path:?} is corrupt or an unrecognised shape ({e}) — starting empty"),
                );
                Self::default()
            }
        }
    }

    /// Write-to-temp-then-rename, matching `TypedLedgerFile::save` — this file
    /// is small (one HashSet<String>) but a half-written JSON document is
    /// still a half-written JSON document if the process dies mid `fs::write`.
    fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        let mut tmp_name = path.as_os_str().to_os_string();
        tmp_name.push(".tmp");
        let tmp = PathBuf::from(tmp_name);
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)
    }
}

/// Per-app inject-outcome memory: app_name → preferred next-inject mode.
///
/// P2 (2026-09-02 audit): this used to be pure in-memory `HashMap`, so the one
/// fact it exists to remember — 「this app hard-rejects SendInput」 — was
/// forgotten on every restart, and the owner's Cursor corruption (see the
/// header above) could recur once per process lifetime instead of once ever.
/// `path` is `None` in tests (and any other caller that wants a pure in-memory
/// store) — persistence is opt-in via `global()`/`load_from_disk`, never
/// forced on `new()`.
pub struct AppLearningStore {
    inner: Mutex<HashMap<String, InjectMode>>,
    path: Option<PathBuf>,
}

impl AppLearningStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            path: None,
        }
    }

    /// Default on-disk location: a sibling of `credentials.bin` under this
    /// user's local app-data home (same directory role as the typed ledger).
    pub fn default_path() -> PathBuf {
        crate::app_dirs::local_home().join(APP_LEARNING_FILE)
    }

    /// Load prior history from `path` (best-effort — see `AppLearningFile::load`)
    /// and remember `path` so future `record_outcome` calls persist there too.
    fn load_from_disk(path: PathBuf) -> Self {
        let file = AppLearningFile::load(&path);
        let inner = file
            .clipboard_pinned
            .into_iter()
            .map(|app_id| (app_id, InjectMode::Clipboard))
            .collect();
        Self {
            inner: Mutex::new(inner),
            path: Some(path),
        }
    }

    /// Best-effort save of the current table to `self.path`, if any. Failure
    /// is not fatal to the running process (the in-memory table still answers
    /// correctly for this session) but must not be silent — see `save`'s own
    /// discipline in `typed_ledger.rs` for why a swallowed write is worse than
    /// a swallowed read: it is the one that makes NEXT session's read lie.
    fn persist(&self, table: &HashMap<String, InjectMode>) {
        let Some(path) = &self.path else { return };
        let file = AppLearningFile {
            clipboard_pinned: table
                .iter()
                .filter(|(_, mode)| matches!(mode, InjectMode::Clipboard))
                .map(|(app_id, _)| app_id.clone())
                .collect(),
        };
        if let Err(e) = file.save(path) {
            crate::forensic::record(
                "inject",
                &format!("app-learning file {path:?} could not be saved ({e}) — this restart's history will not survive the next one"),
            );
        }
    }

    /// Process-wide singleton the inject pipeline consults instead of
    /// threading the store through every call signature. Persists to
    /// [`Self::default_path`] so a hard SendInput rejection is remembered
    /// across restarts, not just for the rest of this process's life.
    pub fn global() -> &'static Self {
        static STORE: OnceLock<AppLearningStore> = OnceLock::new();
        STORE.get_or_init(|| AppLearningStore::load_from_disk(Self::default_path()))
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
            // P2 fix: this used to be the entire body — the table this insert
            // just changed was never written past the running process. Clone
            // out from under the lock so a slow disk write never holds up the
            // inject pipeline's next `preferred_mode_for` read.
            let snapshot = g.clone();
            drop(g);
            self.persist(&snapshot);
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

    fn scratch_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("flowmic-app-learning-{label}-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn fresh_store_has_no_history() {
        let store = AppLearningStore::new();
        assert_eq!(store.preferred_mode_for("notepad"), None);
    }

    // ── P2 (2026-09-02): the table must survive a restart ──────────────────

    #[test]
    fn a_hard_rejection_survives_reloading_the_store_from_disk() {
        let path = scratch_path("roundtrip");
        {
            let store = AppLearningStore::load_from_disk(path.clone());
            store.record_outcome("game", InjectMode::SendInput, false);
        } // store (and its process-local table) dropped — simulates a restart

        let reloaded = AppLearningStore::load_from_disk(path.clone());
        assert_eq!(
            reloaded.preferred_mode_for("game"),
            Some(InjectMode::Clipboard),
            "a hard SendInput rejection recorded before 'restart' must still be known after it"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reverse_control_an_in_memory_only_store_forgets_on_reload() {
        // NEGATIVE CONTROL: this is the pre-fix shape (`new()`, no path) —
        // without the fix above, EVERY store looked like this, which is
        // exactly the defect the audit named ("the table is never
        // persisted"). Kept as a permanent contrast so a future change that
        // makes `new()` itself persist does not silently make this drill
        // meaningless.
        let store = AppLearningStore::new();
        store.record_outcome("game", InjectMode::SendInput, false);
        assert_eq!(store.preferred_mode_for("game"), Some(InjectMode::Clipboard));
        drop(store);
        let fresh = AppLearningStore::new();
        assert_eq!(
            fresh.preferred_mode_for("game"),
            None,
            "an in-memory-only store has nothing to reload from"
        );
    }

    #[test]
    fn a_missing_file_loads_as_empty_not_an_error() {
        let path = scratch_path("missing");
        let store = AppLearningStore::load_from_disk(path);
        assert_eq!(store.preferred_mode_for("anything"), None);
    }

    #[test]
    fn a_corrupt_file_loads_as_empty_and_does_not_panic() {
        let path = scratch_path("corrupt");
        std::fs::write(&path, b"{ not json").unwrap();
        let store = AppLearningStore::load_from_disk(path.clone());
        assert_eq!(store.preferred_mode_for("anything"), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_paste_outcome_is_not_written_to_disk() {
        // The deliberate no-op (see `record_outcome`'s header) must stay a
        // no-op at the persistence layer too — a Clipboard outcome writing a
        // file would resurrect exactly the bug the header describes as fixed
        // (a paste answering a question about typing) the moment the process
        // restarted and reloaded it.
        let path = scratch_path("clipboard-noop");
        {
            let store = AppLearningStore::load_from_disk(path.clone());
            store.record_outcome("uwp", InjectMode::Clipboard, true);
        }
        assert!(
            !path.exists(),
            "a Clipboard outcome must never create the on-disk file"
        );
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

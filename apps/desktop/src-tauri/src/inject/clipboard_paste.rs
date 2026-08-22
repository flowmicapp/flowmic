// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback)
//   master-plan §4 / CLAUDE.md red line: no silent failures / status only records
//     the delivery truth
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Clipboard fallback: save the user's clipboard, HOLD ours on it long enough for
// the target to read it, restore. This wrapper owns the save/restore; the hold
// itself is `clipboard_confirm::paste_with_confirmation`.
//
//   1. save()          — snapshot the user's current clipboard
//   2. paste_confirm() — own the clipboard (delayed), Ctrl+V, then HOLD until
//                        read-back sees the text land or `PASTE_HOLD` expires
//   3. restore()       — put the user's original clipboard back (ALWAYS)
//
// ── 2026-08-22, THE P0 THAT REWROTE STEP 2 ───────────────────────────────────
// Step 2 used to end at the first `WM_RENDERFORMAT`, on the reading that it
// meant "the target consumed it". It does not: measured on dev-pc-a, that
// message arrives 13ms after Ctrl+V whether or not the target's renderer is even
// able to run, so step 3 was putting the user's clipboard back ~20ms later and a
// busy target then pasted THE USER'S OWN OLD TEXT while we reported `injected`.
// The user hit it in Cursor. `clipboard_confirm.rs`'s hold loop carries the
// trace; `readback.rs` carries the instrument that replaced the receipt.
//
// The verdict layering is unchanged from 2026-07-30: an error-free paste at a
// focus Stage 1/1b established is a delivery, and `pipeline::map_clipboard_outcome`
// / `map_image_outcome` own that call. What changed is that we no longer sabotage
// the delivery we are reporting, and that `landing` now says whether it was seen
// to arrive. Restore runs even on failure; a restore failure wins UNLESS the
// landing was confirmed (see `paste_text`). The save / paste / restore seams here
// are `Box<dyn Fn>`, so the ordering and the restore-on-failure guarantees are
// provable headless (the Win32 inside `clipboard_confirm::win` is NOT behind
// those seams).

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use crate::inject::{
    clipboard_confirm::{paste_formats_with_confirmation, paste_with_confirmation, ConfirmOutcome},
    clipboard_snapshot::{restore_clipboard, save_clipboard, ClipboardSnapshot},
    sendinput::InjectError,
};

/// Serialises the whole save → paste → restore sequence, process-wide.
///
/// GA-28 keeps BOTH channels connected, and `socket/client.rs` registers the
/// inject:request handler on each — two deliveries really can land at once, with
/// different request_ids, so the dedup does not merge them. The paste they share
/// is not re-entrant: `clipboard_confirm`'s `PENDING` render slot is a single
/// process-level cell, and the clipboard itself is one global OS lock.
/// Interleaved, B's announcement overwrites A's render slot — A can then read
/// B's `rendered` flag and report 「injected」 for a picture nobody took, or the
/// wndproc can answer A's request with B's bytes (the wrong image pasted). Both
/// are red-line failures, not glitches.
///
/// It was unreachable until 2026-07-29 only because the announcement failed in
/// ~5 ms every time (see clipboard_confirm::set_delayed). Fixing that stretched
/// the window to 80 ms + up to 500 ms of receipt wait, which is exactly the
/// 「process-level singleton + one instance per channel」 shape the 0.2.x window already got bitten by
/// (focus/tracker.rs, §4-B of the round report) — so the lock lands with the fix
/// that makes it matter, not after the next real-machine surprise.
///
/// Held across save AND restore on purpose: B's snapshot must never capture the
/// delayed formats A has on the clipboard and then 「restore」 them as if they
/// were the user's own.
static PASTE_LOCK: Mutex<()> = Mutex::new(());

/// Take [`PASTE_LOCK`], tolerating poisoning. A panic inside a previous paste
/// must not make every later paste panic on lock — the sequence is
/// restore-always and holds no invariant across callers.
fn paste_guard() -> MutexGuard<'static, ()> {
    PASTE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// How long the injected payload STAYS on the clipboard after Ctrl+V, unless
/// read-back confirms the landing sooner.
///
/// 🔴 THIS REPLACED A 500ms 「CONFIRM_TIMEOUT」 THAT WAS NEVER THE BINDING
/// CONSTRAINT. The old loop exited on the render receipt, which arrives ~13ms
/// after the keystroke, so the payload was really only reachable for ~110ms
/// (measured: 91–127ms across 19 real injections) and raising the timeout would
/// have changed nothing at all. The number that matters is how long a target
/// that is BUSY may take to get to the keystroke.
///
/// 1500ms covers the measured reproduction (a Chromium renderer blocked 1.2s
/// confirmed at 1318ms) with margin. It is an upper bound, not a cost: the
/// common case exits as soon as read-back sees the text, which on an idle target
/// is ~150ms — SHORTER than the old behaviour held it.
///
/// `pub(crate)` for one reason (RV-44): the forensic line has to name the window
/// it measured over, and retyping the number there would be the same question
/// answered in two places.
pub(crate) const PASTE_HOLD: Duration = Duration::from_millis(1500);

/// Outcome of a clipboard fallback attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PasteOutcome {
    /// Somebody asked us to render a format (WM_RENDERFORMAT). NOT 「the target
    /// consumed the text」 — see `ConfirmOutcome::confirmed` for the measurement
    /// that separated those two, and `landing` for the field that answers the
    /// question this one kept being asked.
    pub confirmed: bool,
    /// Did the delivered text actually turn up in the focused element?
    /// Positive-only (`inject/readback.rs`): anything but `Confirmed` means the
    /// instrument could not see it, never that the paste failed.
    pub landing: crate::inject::readback::LandingEvidence,
    /// How long the payload was reachable on the clipboard.
    pub held_ms: u32,
}

type SaveFn = Box<dyn Fn() -> Result<ClipboardSnapshot, InjectError> + Send + Sync>;
type RestoreFn = Box<dyn Fn(ClipboardSnapshot) -> Result<(), InjectError> + Send + Sync>;
type PasteConfirmFn = Box<dyn Fn(&str) -> Result<ConfirmOutcome, InjectError> + Send + Sync>;
type PasteFormatsFn =
    Box<dyn Fn(&[(u32, Vec<u8>)]) -> Result<ConfirmOutcome, InjectError> + Send + Sync>;

/// Fallback clipboard-paste injection client.
pub struct ClipboardFallbackClient {
    save: SaveFn,
    restore: RestoreFn,
    paste_confirm: PasteConfirmFn,
    paste_formats: PasteFormatsFn,
}

impl ClipboardFallbackClient {
    pub fn new() -> Self {
        Self {
            save: Box::new(save_clipboard),
            restore: Box::new(restore_clipboard),
            paste_confirm: Box::new(|text| paste_with_confirmation(text, PASTE_HOLD)),
            paste_formats: Box::new(|f| paste_formats_with_confirmation(f, PASTE_HOLD)),
        }
    }

    /// Text-path fake. The image closure is left at the honest default —
    /// "nothing was confirmed" — so a text-only fake can never manufacture an
    /// image success it was never told about.
    pub fn with_fakes(
        save: impl Fn() -> Result<ClipboardSnapshot, InjectError> + Send + Sync + 'static,
        restore: impl Fn(ClipboardSnapshot) -> Result<(), InjectError> + Send + Sync + 'static,
        paste_confirm: impl Fn(&str) -> Result<ConfirmOutcome, InjectError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            save: Box::new(save),
            restore: Box::new(restore),
            paste_confirm: Box::new(paste_confirm),
            paste_formats: Box::new(|_| Ok(ConfirmOutcome::default())),
        }
    }

    /// Image-path fake (R6 T-4). Same save/restore seams; the format-table
    /// paste is what varies.
    pub fn with_image_fakes(
        save: impl Fn() -> Result<ClipboardSnapshot, InjectError> + Send + Sync + 'static,
        restore: impl Fn(ClipboardSnapshot) -> Result<(), InjectError> + Send + Sync + 'static,
        paste_formats: impl Fn(&[(u32, Vec<u8>)]) -> Result<ConfirmOutcome, InjectError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            save: Box::new(save),
            restore: Box::new(restore),
            paste_confirm: Box::new(|_| Ok(ConfirmOutcome::default())),
            paste_formats: Box::new(paste_formats),
        }
    }

    /// Save → hold-the-paste → restore-always. On a paste error the restore
    /// still runs and the paste error propagates only when restoration succeeds;
    /// a restore failure wins UNLESS the landing was confirmed.
    pub fn paste_text(&self, text: &str) -> Result<PasteOutcome, InjectError> {
        let _serialised = paste_guard();
        let prev = (self.save)()?;
        let confirm_result = (self.paste_confirm)(text);
        // ALWAYS restore, even on paste failure.
        let restore_result = (self.restore)(prev);
        match (confirm_result, restore_result) {
            // ── THE ARM THE TEXT PATH WAS MISSING (2026-08-22) ───────────────
            // `paste_image` has had this rule since 0.2.14; the text path never
            // got it, and the gap is a DUPLICATED INJECTION. A target that has
            // just been pasted into is often still holding the clipboard open, so
            // the restore takes ERROR_ACCESS_DENIED (owner hit exactly that:
            // `paste=Win32 error: 5`). The text path turned that into `Err`, the
            // routed paste turned `Err` into "fell back to SendInput", and the
            // sentence the user already had in their editor got TYPED IN AGAIN —
            // through the IME pipeline this route exists to avoid.
            //
            // Reporting "not delivered" for something we can SEE in the target is
            // the false-reporting red line pointing the other way, so a confirmed
            // landing outranks the restore error. The lost clipboard is real and
            // is said out loud rather than folded into the delivery verdict.
            //
            // ⚠️ THE CONDITION IS `landing`, NOT `confirmed`, AND THAT IS THE
            // WHOLE POINT: the render receipt is exactly the signal that was
            // measured not to mean this. An unconfirmable target with a failed
            // restore still reports the error and may still be re-typed — a
            // visible duplicate beats a silent miss, and this module has no way
            // to tell those two apart there.
            (Ok(outcome), Err(restore_error))
                if outcome.landing == crate::inject::readback::LandingEvidence::Confirmed =>
            {
                crate::forensic::record(
                    "inject",
                    &format!(
                        "text WAS pasted (read-back saw it land) but the user's previous \
                         clipboard could not be restored: {restore_error}"
                    ),
                );
                Ok(PasteOutcome {
                    confirmed: outcome.confirmed,
                    landing: outcome.landing,
                    held_ms: outcome.held_ms,
                })
            }
            (_, Err(restore_error)) => Err(restore_error),
            (Err(operation_error), Ok(())) => Err(operation_error),
            (Ok(outcome), Ok(())) => Ok(PasteOutcome {
                confirmed: outcome.confirmed,
                landing: outcome.landing,
                held_ms: outcome.held_ms,
            }),
        }
    }

    /// R6 T-4: the same save → confirmed-paste → restore-ALWAYS sequence over a
    /// clipboard FORMAT TABLE (an image is CF_DIB / CF_BITMAP / registered PNG,
    /// never text). Byte-for-byte the same guarantees as [`Self::paste_text`]:
    /// the user's clipboard is restored even when the paste fails, a restore
    /// failure wins, and an unconfirmed consumption is reported as unconfirmed
    /// rather than dressed up as delivery.
    pub fn paste_image(&self, formats: &[(u32, Vec<u8>)]) -> Result<ConfirmOutcome, InjectError> {
        let _serialised = paste_guard();
        let prev = (self.save)()?;
        let confirm_result = (self.paste_formats)(formats);
        // ALWAYS restore, even on paste failure.
        let restore_result = (self.restore)(prev);
        match (confirm_result, restore_result) {
            // A CONFIRMED consumption outranks a restore failure. The target
            // took the picture — we have its own WM_RENDERFORMAT receipt — so
            // reporting 「not injected」 because we could not put the user's old
            // clipboard back would be the false-reporting red line pointing the other way:
            // claiming a delivery did not happen when it demonstrably did.
            //
            // owner 2026-07-29 (0.2.14): `paste=Win32 error: 5` was exactly
            // this — the restore lost a race with the target app reading the
            // clipboard it had just been handed. The retry in
            // clipboard_snapshot now makes that rare; this makes it harmless.
            // The lost clipboard is REAL and is said out loud on the forensic
            // record rather than being folded into the delivery verdict.
            (Ok(outcome), Err(restore_error)) if outcome.confirmed => {
                crate::forensic::record(
                    "inject",
                    &format!(
                        "image WAS pasted (target consumed it) but the user's previous \
                         clipboard could not be restored: {restore_error}"
                    ),
                );
                Ok(outcome)
            }
            (_, Err(restore_error)) => Err(restore_error),
            (Err(operation_error), Ok(())) => Err(operation_error),
            (Ok(outcome), Ok(())) => Ok(outcome),
        }
    }
}

impl Default for ClipboardFallbackClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// Two deliveries at once — one per channel, which GA-28 makes routine —
    /// must never interleave their save/paste/restore sequences.
    ///
    /// Interleaved, the second paste's announcement overwrites the first's
    /// render slot (a single process-level cell in clipboard_confirm), so the
    /// first can read the second's 「rendered」 and report 「injected」 for a picture
    /// nobody took; the second's snapshot would also capture the first's
    /// delayed formats and 「restore」 them over the user's real clipboard.
    ///
    /// The fake paste sleeps, so an unserialised implementation fails this
    /// reliably rather than by luck: without the lock the two sequences overlap
    /// for the whole sleep.
    #[test]
    fn two_concurrent_deliveries_are_serialised_end_to_end() {
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let inside = inside.clone();
            let max_seen = max_seen.clone();
            handles.push(std::thread::spawn(move || {
                let enter = inside.clone();
                let peak = max_seen.clone();
                let leave = inside.clone();
                let client = ClipboardFallbackClient::with_fakes(
                    move || {
                        // save() is the START of the critical section.
                        let now = enter.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        Ok(ClipboardSnapshot::default())
                    },
                    move |_s| {
                        // restore() is the END of it.
                        leave.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    },
                    |_t| {
                        std::thread::sleep(Duration::from_millis(60));
                        Ok(ConfirmOutcome { confirmed: true, ..Default::default() })
                    },
                );
                client.paste_text("hello").expect("ok")
            }));
        }
        for h in handles {
            assert!(h.join().expect("thread").confirmed);
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            1,
            "two deliveries were inside save→paste→restore at the same time"
        );
        assert_eq!(inside.load(Ordering::SeqCst), 0, "every sequence closed");
    }

    /// A picture the target DEMONSTRABLY took (its own WM_RENDERFORMAT receipt)
    /// stays delivered even when the user's old clipboard cannot be put back.
    /// Reporting 「not injected」 there is the false-reporting red line inverted — denying a
    /// delivery that provably happened. The lost clipboard is a separate,
    /// smaller fact, and it goes on the forensic record instead of into the
    /// delivery verdict.
    #[test]
    fn a_confirmed_image_paste_survives_a_failed_restore() {
        let client = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Err(InjectError::Win32(5)), // ERROR_ACCESS_DENIED, the real one
            |_f| {
                Ok(ConfirmOutcome {
                    confirmed: true,
                    requested_format: Some(8),
                    dropped_unrendered: false,
                    ..Default::default()
                })
            },
        );
        let out = client.paste_image(&[(8, vec![1, 2, 3])]).expect("delivered");
        assert!(out.confirmed);
    }

    /// …but an UNCONFIRMED paste plus a failed restore is still a failure: there
    /// is no receipt, so there is nothing to outrank the restore error.
    #[test]
    fn an_unconfirmed_image_paste_with_a_failed_restore_is_a_failure() {
        let client = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Err(InjectError::Win32(5)),
            |_f| {
                Ok(ConfirmOutcome {
                    confirmed: false,
                    requested_format: None,
                    dropped_unrendered: false,
                    ..Default::default()
                })
            },
        );
        assert!(matches!(
            client.paste_image(&[(8, vec![0])]),
            Err(InjectError::Win32(5))
        ));
    }

    #[test]
    fn confirmed_paste_saves_pastes_restores_in_order() {
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (o1, o2, o3) = (order.clone(), order.clone(), order.clone());
        let client = ClipboardFallbackClient::with_fakes(
            move || {
                o1.lock().unwrap().push("save");
                Ok(ClipboardSnapshot::default())
            },
            move |_s| {
                o3.lock().unwrap().push("restore");
                Ok(())
            },
            move |_t| {
                o2.lock().unwrap().push("paste");
                Ok(ConfirmOutcome { confirmed: true, ..Default::default() })
            },
        );
        let out = client.paste_text("hello").expect("ok");
        assert!(out.confirmed);
        assert_eq!(*order.lock().unwrap(), vec!["save", "paste", "restore"]);
    }

    // The coordinator-mandated proof: an UNCONFIRMED consumption must NOT be
    // reported as injected — paste_text returns confirmed=false, and restore
    // still ran (no leaked injected text left behind).
    #[test]
    fn unconfirmed_paste_returns_not_confirmed_and_still_restores() {
        let restored = Arc::new(Mutex::new(false));
        let r = restored.clone();
        let client = ClipboardFallbackClient::with_fakes(
            || Ok(ClipboardSnapshot::default()),
            move |_s| {
                *r.lock().unwrap() = true;
                Ok(())
            },
            |_t| Ok(ConfirmOutcome::default()), // nobody ever fetched our format
        );
        let out = client.paste_text("x").expect("ok");
        assert!(!out.confirmed, "unconfirmed consumption must not be 'confirmed'");
        assert!(*restored.lock().unwrap(), "restore runs even when unconfirmed");
    }

    #[test]
    fn restore_runs_even_when_paste_errors_and_error_propagates() {
        let restored = Arc::new(Mutex::new(false));
        let r = restored.clone();
        let client = ClipboardFallbackClient::with_fakes(
            || Ok(ClipboardSnapshot::default()),
            move |_s| {
                *r.lock().unwrap() = true;
                Ok(())
            },
            |_t| Err(InjectError::AppRejected),
        );
        assert!(matches!(client.paste_text("x"), Err(InjectError::AppRejected)));
        assert!(*restored.lock().unwrap(), "restore runs even on paste error");
    }

    #[test]
    fn restore_failure_wins_over_paste_error() {
        let client = ClipboardFallbackClient::with_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Err(InjectError::Win32(5)),
            |_t| Err(InjectError::AppRejected),
        );
        assert!(matches!(client.paste_text("x"), Err(InjectError::Win32(5))));
    }

    // ── R6 T-4 image path: the SAME three guarantees, proved separately ──────

    #[test]
    fn image_paste_saves_pastes_restores_in_order_and_forwards_the_table() {
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let seen = Arc::new(Mutex::new(Vec::<u32>::new()));
        let (o1, o2, o3) = (order.clone(), order.clone(), order.clone());
        let s = seen.clone();
        let client = ClipboardFallbackClient::with_image_fakes(
            move || {
                o1.lock().unwrap().push("save");
                Ok(ClipboardSnapshot::default())
            },
            move |_s| {
                o3.lock().unwrap().push("restore");
                Ok(())
            },
            move |formats| {
                o2.lock().unwrap().push("paste");
                *s.lock().unwrap() = formats.iter().map(|(f, _)| *f).collect();
                Ok(ConfirmOutcome {
                    confirmed: true,
                    requested_format: Some(8),
                    dropped_unrendered: false,
                    ..Default::default()
                })
            },
        );
        let out = client.paste_image(&[(8, vec![1, 2, 3])]).expect("ok");
        assert!(out.confirmed);
        assert_eq!(out.requested_format, Some(8));
        assert_eq!(*order.lock().unwrap(), vec!["save", "paste", "restore"]);
        assert_eq!(*seen.lock().unwrap(), vec![8], "the table reaches the paste verbatim");
    }

    // The red-line proof for the image half: an UNCONFIRMED consumption must NOT
    // be reported as injected, and the user's clipboard is restored regardless.
    #[test]
    fn unconfirmed_image_paste_is_not_confirmed_and_still_restores() {
        let restored = Arc::new(Mutex::new(false));
        let r = restored.clone();
        let client = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            move |_s| {
                *r.lock().unwrap() = true;
                Ok(())
            },
            // The target asked for a format we could not serve.
            |_f| {
                Ok(ConfirmOutcome {
                    confirmed: false,
                    requested_format: Some(2),
                    dropped_unrendered: false,
                    ..Default::default()
                })
            },
        );
        let out = client.paste_image(&[(8, vec![0])]).expect("ok");
        assert!(!out.confirmed, "unconfirmed image consumption is never 'confirmed'");
        assert_eq!(out.requested_format, Some(2), "the asked-for format is retained");
        assert!(*restored.lock().unwrap(), "restore runs even when unconfirmed");
    }

    // F-4: the RV-39 withdrawal-drop fact must SURVIVE `paste_image` unchanged. The
    // verdict is decided one layer up in `map_image_outcome`; this is the carrier
    // that must not swallow the fact on the way there (the way the forensic-only
    // record used to). Restore succeeds, so nothing else can mask it.
    #[test]
    fn paste_image_forwards_the_dropped_unrendered_fact() {
        let client = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Ok(()),
            |_f| {
                Ok(ConfirmOutcome {
                    confirmed: false,
                    requested_format: None,
                    dropped_unrendered: true,
                    ..Default::default()
                })
            },
        );
        let out = client.paste_image(&[(8, vec![0])]).expect("ok");
        assert!(out.dropped_unrendered, "the drop fact must reach map_image_outcome");
        assert!(!out.confirmed, "and it did not manufacture a receipt");
    }

    #[test]
    fn image_restore_runs_on_paste_error_and_a_restore_failure_still_wins() {
        let restored = Arc::new(Mutex::new(false));
        let r = restored.clone();
        let client = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            move |_s| {
                *r.lock().unwrap() = true;
                Ok(())
            },
            |_f| Err(InjectError::AppRejected),
        );
        assert!(matches!(client.paste_image(&[(8, vec![0])]), Err(InjectError::AppRejected)));
        assert!(*restored.lock().unwrap(), "restore runs even on image paste error");

        let losing = ClipboardFallbackClient::with_image_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Err(InjectError::Win32(5)),
            |_f| Err(InjectError::AppRejected),
        );
        assert!(matches!(losing.paste_image(&[(8, vec![0])]), Err(InjectError::Win32(5))));
    }

    #[test]
    fn a_text_only_fake_never_manufactures_an_image_success() {
        let client = ClipboardFallbackClient::with_fakes(
            || Ok(ClipboardSnapshot::default()),
            |_s| Ok(()),
            |_t| Ok(ConfirmOutcome { confirmed: true, ..Default::default() }), // text receipt served…
        );
        let out = client.paste_image(&[(8, vec![0])]).expect("ok");
        assert!(!out.confirmed, "…but the un-configured image path stays unconfirmed");
    }
}

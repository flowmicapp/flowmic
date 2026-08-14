// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback)
//   master-plan §4 / CLAUDE.md red line: no silent failures / status only records
//     the delivery truth
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Clipboard fallback with CONFIRMED consumption. The paste itself is delegated
// to `clipboard_confirm::paste_with_confirmation` (delayed rendering — see that
// module for why a synchronous write→paste→restore is a race that both lies
// about delivery and leaks the user's prior clipboard). This wrapper owns the
// user-clipboard save/restore around it:
//
//   1. save()          — snapshot the user's current clipboard
//   2. paste_confirm() — own the clipboard (delayed), Ctrl+V, observe whether
//                        the target actually consumed it → Ok(confirmed)
//   3. restore()       — put the user's original clipboard back (ALWAYS)
//
// The `confirmed` flag flows up to the pipeline. It was the ok/fail GATE until
// 2026-07-30, when owner's narrowing of 「injected」 (design §3) demoted it to
// DIAGNOSTIC: an error-free paste at a focus Stage 1/1b had already established is
// a delivery, and whether the target then read the bytes is the target's business.
// The flag is still carried, still recorded, and no longer decides anything —
// `pipeline::map_clipboard_outcome` / `map_image_outcome` own that verdict.
// Restore runs even on failure; a restore failure wins so the caller reports
// INJECT_CLIPBOARD_FAIL. The save / paste / restore seams here are `Box<dyn Fn>`,
// so the ordering and the restore-on-failure guarantees are provable headless
// (the Win32 inside `clipboard_confirm::win` is NOT behind those seams).

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

/// Bounded window to observe WM_RENDERFORMAT before giving up on the paste.
/// Ctrl+V processing is a few ms; 500ms comfortably covers a busy target
/// without leaving the user's clipboard clobbered for long.
///
/// `pub(crate)` for one reason (RV-44): the forensic line that reports an
/// unconsumed receipt has to name the window it measured over, and a literal
/// `500ms` retyped there would be the same number answering the same question in
/// two places — the shape this repo keeps getting bitten by. The log reads the
/// value it actually waited.
pub(crate) const CONFIRM_TIMEOUT: Duration = Duration::from_millis(500);

/// Outcome of a clipboard fallback attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasteOutcome {
    /// Whether the target actually consumed (pasted) the injected text, i.e.
    /// whether a WM_RENDERFORMAT arrived within `CONFIRM_TIMEOUT`. Since
    /// 2026-07-30 this is EVIDENCE, not a verdict: `false` means 「not observed
    /// inside that window」, which is not 「the target refused」 and no longer
    /// forbids the caller from reporting `injected` (design §3).
    pub confirmed: bool,
}

type SaveFn = Box<dyn Fn() -> Result<ClipboardSnapshot, InjectError> + Send + Sync>;
type RestoreFn = Box<dyn Fn(ClipboardSnapshot) -> Result<(), InjectError> + Send + Sync>;
type PasteConfirmFn = Box<dyn Fn(&str) -> Result<bool, InjectError> + Send + Sync>;
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
            paste_confirm: Box::new(|text| paste_with_confirmation(text, CONFIRM_TIMEOUT)),
            paste_formats: Box::new(|f| paste_formats_with_confirmation(f, CONFIRM_TIMEOUT)),
        }
    }

    /// Text-path fake. The image closure is left at the honest default —
    /// "nothing was confirmed" — so a text-only fake can never manufacture an
    /// image success it was never told about.
    pub fn with_fakes(
        save: impl Fn() -> Result<ClipboardSnapshot, InjectError> + Send + Sync + 'static,
        restore: impl Fn(ClipboardSnapshot) -> Result<(), InjectError> + Send + Sync + 'static,
        paste_confirm: impl Fn(&str) -> Result<bool, InjectError> + Send + Sync + 'static,
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
            paste_confirm: Box::new(|_| Ok(false)),
            paste_formats: Box::new(paste_formats),
        }
    }

    /// Save → confirmed-paste → restore-always. `Ok(PasteOutcome{confirmed})`
    /// tells the caller whether delivery was CONFIRMED. On a paste error the
    /// restore still runs and the paste error propagates only when restoration
    /// succeeds; a restore failure always wins (→ INJECT_CLIPBOARD_FAIL).
    pub fn paste_text(&self, text: &str) -> Result<PasteOutcome, InjectError> {
        let _serialised = paste_guard();
        let prev = (self.save)()?;
        let confirm_result = (self.paste_confirm)(text);
        // ALWAYS restore, even on paste failure.
        let restore_result = (self.restore)(prev);
        match (confirm_result, restore_result) {
            (_, Err(restore_error)) => Err(restore_error),
            (Err(operation_error), Ok(())) => Err(operation_error),
            (Ok(confirmed), Ok(())) => Ok(PasteOutcome { confirmed }),
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
                        Ok(true)
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
                Ok(true)
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
            |_t| Ok(false), // target never consumed the paste
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
            |_t| Ok(true), // text is confirmed…
        );
        let out = client.paste_image(&[(8, vec![0])]).expect("ok");
        assert!(!out.confirmed, "…but the un-configured image path stays unconfirmed");
    }
}

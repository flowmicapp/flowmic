// SPEC-REF: Linux L-4. A server-accepted chord is an attempted paste, never a
// target-read receipt. Hold duration and target evidence answer separate facts.
// D-MKT-2 (2026-11-05): the chord is chosen from the target's own identity —
// terminal emulators paste on Ctrl+Shift+V (`inject/x11_paste_chord.rs`) — and
// for them the chord waits until the target has re-read the clipboard.
use super::Owner;
use crate::inject::linux::keys::{self, SubmitError};
use crate::inject::readback::LandingEvidence;
use crate::inject::x11_paste_chord::{
    classify_x11_paste_target, same_x_client, x11_paste_chord, TERMINAL_SETTLE_CAP_MS,
    TERMINAL_SETTLE_GRACE_MS,
};
use crate::inject::{ConfirmOutcome, InjectError};
use std::time::{Duration, Instant};

impl Owner {
    pub fn paste(
        &mut self,
        text: &str,
        hold: Duration,
        expected_target: u64,
    ) -> Result<ConfirmOutcome, InjectError> {
        if expected_target == 0
            || !self
                .connection
                .contains_focus(expected_target as _)
                .map_err(InjectError::Native)?
        {
            return Err(InjectError::TargetChanged(
                "Stage-1 target lost before clipboard replacement".into(),
            ));
        }
        // Read BEFORE the clipboard is replaced, from the very window the
        // keys are committed to (`keys::send` re-checks that it still holds
        // focus under the server grab). Until D-MKT-2 this was a hard-coded
        // Ctrl+V, which GNOME Terminal hands to bash as quoted-insert: nothing
        // landed, the user's next key was swallowed, and we said `injected`.
        let identity = crate::focus::linux::window_identity_with(&self.connection, expected_target);
        let target = classify_x11_paste_target(&identity);
        let chord = x11_paste_chord(target);
        crate::forensic::record(
            "inject",
            &format!(
                "X11 paste {} WM_CLASS={:?}/{:?} exe={:?}",
                target.forensic_phrase(),
                identity.wm_instance,
                identity.wm_class,
                identity.exe
            ),
        );
        self.begin_paste(text).map_err(InjectError::Native)?;
        if target.waits_for_clipboard_reread() {
            self.settle_until_target_rereads(expected_target);
        }
        let submitted = keys::send(
            &self.connection,
            &[chord],
            expected_target,
            Some((self.clipboard, self.window)),
        );
        let mut uncertain = match submitted {
            Err(SubmitError::Focus(detail)) => return Err(InjectError::TargetChanged(detail)),
            Err(SubmitError::Before(detail)) => return Err(InjectError::Native(detail)),
            Err(SubmitError::Uncertain(detail)) => Some(detail),
            Ok(()) => None,
        };
        let start = Instant::now();
        // A selection request may be a clipboard bridge, so it never shortens
        // this hold. Keep responding even after a partially submitted chord:
        // immediately restoring then can paste the user's old clipboard.
        while start.elapsed() < hold {
            if let Err(error) = self.pump() {
                crate::forensic::record("inject", &format!("X11 clipboard hold event: {error}"));
                uncertain.get_or_insert_with(|| format!("clipboard service failed after keys: {error}"));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let held_ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;
        crate::forensic::record("inject", &format!("X11 paste hold ended held={held_ms}ms; target read-back unavailable; submission_uncertain={}", uncertain.is_some()));
        if let Some(detail) = uncertain {
            return Err(InjectError::SubmissionUncertain(detail));
        }
        Ok(ConfirmOutcome {
            confirmed: false,
            landing: LandingEvidence::Unavailable,
            held_ms,
            requested_format: None,
            dropped_unrendered: false,
        })
    }

    /// D-MKT-2, second mechanism (`inject/x11_paste_chord.rs`, the block above
    /// `TERMINAL_SETTLE_CAP_MS`): GNOME Terminal ignores its paste key until it
    /// has re-read the clipboard after our ownership change. Serve requests
    /// until one comes from the target's own X client, then a short grace;
    /// capped. A request is NOT a landing receipt, and the cap is not a
    /// failure verdict — both outcomes only go on the forensic line.
    fn settle_until_target_rereads(&mut self, expected_target: u64) {
        let start = Instant::now();
        let cap = Duration::from_millis(TERMINAL_SETTLE_CAP_MS);
        let mut asked_after = None;
        while start.elapsed() < cap {
            if let Err(error) = self.pump() {
                crate::forensic::record("inject", &format!("X11 paste settle event: {error}"));
            }
            if self
                .asked_since_publish
                .iter()
                .any(|requestor| same_x_client(*requestor as _, expected_target))
            {
                asked_after = Some(start.elapsed().as_millis());
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if asked_after.is_some() {
            let grace = Instant::now();
            while grace.elapsed() < Duration::from_millis(TERMINAL_SETTLE_GRACE_MS) {
                let _ = self.pump();
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        crate::forensic::record(
            "inject",
            &match asked_after {
                Some(ms) => format!(
                    "X11 paste settle: the target's client re-read the clipboard after {ms}ms; \
                     chord after +{TERMINAL_SETTLE_GRACE_MS}ms grace"
                ),
                None => format!(
                    "X11 paste settle: cap {TERMINAL_SETTLE_CAP_MS}ms reached with no request from \
                     the target's X client; pressing anyway — this paste very likely did not land"
                ),
            },
        );
    }
}

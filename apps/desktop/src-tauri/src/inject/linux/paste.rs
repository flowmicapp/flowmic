// SPEC-REF: Linux L-4. A server-accepted chord is an attempted paste, never a
// target-read receipt. Hold duration and target evidence answer separate facts.
use super::Owner;
use crate::inject::linux::keys::{self, SubmitError};
use crate::inject::readback::LandingEvidence;
use crate::inject::{ConfirmOutcome, InjectError, KeyChord};
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
        self.begin_paste(text).map_err(InjectError::Native)?;
        let submitted = keys::send(
            &self.connection,
            &[KeyChord {
                vk: 0x0076,
                modifiers: vec![0xFFE3], // XK_v, XK_Control_L
            }],
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
}

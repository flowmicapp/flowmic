// SPEC-REF: Linux L-4 structural split before expanding the 791-line inject_ops.
// Chord exit/reporting moved verbatim; the caller still owns target resolution.

use crate::socket::control_row::ControlOutcome;

/// RV-25 — how a control:key CHORD ended. One variant per exit of the
/// chord branch below.
///
/// The chord branch had THREE exits that sent nothing and said nothing, while the
/// punctuation branch in the same function records every outcome. So "pressed a
/// chord but nothing happened" had no record on file in the forensic log: "control:key
/// never reached the desktop" and "it arrived, but some precondition wasn't met" read identically (i.e. as silence). Since control:key
/// has NO result frame in the protocol, the log is the ONLY place that outcome can
/// live — a missing line there is the whole story missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ChordExit {
    /// SendInput accepted the whole sequence.
    Sent,
    /// The target was raised, but the OS refused the sequence (carries the
    /// FlowKeyError text — `Rejected` and `Win32(n)` are different problems).
    SendFailed(String),
    /// Events may already have reached the target; do not claim known refusal.
    SubmissionUncertain(String),
    /// The OS would discard a synthetic keystroke right now (macOS: no
    /// Accessibility grant, or secure event input is on). Nothing was posted and
    /// the foreground was NOT taken. Carries the preflight's error code so the
    /// log names WHICH of the two conditions held.
    OsWillNotDeliver(String),
    /// A target existed but could not be brought to the foreground, so the keys
    /// would have landed in whatever window IS foreground. Not sent, on purpose.
    ForegroundRefused,
    /// Focus changed after activation but before committing synthetic events.
    TargetChanged,
    /// No target at all: no live foreground to resolve, or the smoke allowlist
    /// declined the one there was.
    NoTarget,
}

impl ChordExit {
    /// The forensic wording. Every variant names the PRECONDITION that did not
    /// hold, because "why it wasn't sent" is the only question this line exists to
    /// answer — restating "not sent" is not an answer. Mirrors the punctuation
    /// branch's one-line-per-outcome shape.
    pub(super) fn line(&self, kind: &str, hwnd: Option<u64>, keys: usize) -> String {
        let where_ = match hwnd {
            Some(h) => format!("hwnd={h}"),
            None => "hwnd=-".to_string(),
        };
        match self {
            ChordExit::Sent => format!("chord {kind} sent ({where_} chords={keys})"),
            ChordExit::SubmissionUncertain(detail) => format!(
                "chord {kind} submission UNCERTAIN — cannot determine whether keys reached the target ({where_} chords={keys}); no automatic retry: {detail}"
            ),
            // 🔴 W3 2026-08-07: was 「SendInput refused the sequence」. There is no
            // SendInput on macOS — naming a Win32 API as the refuser on a platform
            // that has none sends the reader hunting through Win32 docs for a
            // CGEvent problem. The `{err}` already distinguishes the real causes.
            ChordExit::SendFailed(err) => format!(
                "chord {kind} NOT sent — the OS refused the sequence ({where_} chords={keys}): {err}"
            ),
            ChordExit::OsWillNotDeliver(code) => format!(
                "chord {kind} NOT sent — the OS would discard synthetic keystrokes right now \
                 ({code}); foreground NOT taken ({where_} chords={keys})"
            ),
            ChordExit::TargetChanged => format!("chord {kind} NOT sent — verified target no longer contains keyboard focus ({where_} chords={keys})"),
            ChordExit::ForegroundRefused => format!(
                "chord {kind} NOT sent — foreground activation ({where_}) refused, so the keys would \
                 have landed in another window"
            ),
            ChordExit::NoTarget => format!(
                "chord {kind} NOT sent — no inject target resolved (no live foreground, or the \
                 smoke allowlist declined it)"
            ),
        }
    }
}

impl ChordExit {
    /// The ROW's view of this exit (REQ-12-13, doc 15 §2.0-e).
    ///
    /// 🔴 COARSER THAN THE FORENSIC LINE, ON PURPOSE. `SendFailed` carries the OS's
    /// own words because a diagnosis needs them; a row must not, because the user's
    /// action is identical for every non-`Sent` exit and spelling `Win32(5)` at them
    /// answers a question they did not ask. The detail stays in [`ChordExit::line`],
    /// which is written on the SAME press — nothing is lost, it is filed where it is
    /// read.
    pub(super) fn outcome(&self) -> ControlOutcome {
        match self {
            ChordExit::Sent => ControlOutcome::Sent,
            ChordExit::SendFailed(_) => ControlOutcome::SendFailed,
            ChordExit::SubmissionUncertain(_) => ControlOutcome::SubmissionUncertain,
            ChordExit::OsWillNotDeliver(_) => ControlOutcome::OsRefused,
            ChordExit::ForegroundRefused | ChordExit::TargetChanged => ControlOutcome::ForegroundRefused,
            ChordExit::NoTarget => ControlOutcome::NoTarget,
        }
    }
}

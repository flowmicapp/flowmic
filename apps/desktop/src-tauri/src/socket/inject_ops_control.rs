// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (control:key target resolution, same FSM lock as inject)
//   docs/rebuild/04-PROTOCOL-SPEC.md (control:key, MP-14 key receipt)
//   *** HUMAN-AUDIT SENSITIVE (injection path) — reviewable in isolation ***
//
// NR-287 (2026-10-20): the control:key runner, moved VERBATIM out of inject_ops.rs
// when that file reached the 800-line cap and the in-flight dedup claim needed
// room in `run_inject`. Nothing here changed in the move except visibility
// annotations (`pub(super)` -> `pub(in crate::socket)` on the items
// socket/control_key.rs reaches through the re-export in inject_ops.rs). Comments
// elsewhere that cite `socket/inject_ops.rs` `run_control_key` /
// `run_control_key_with` resolve to this file, a child module of inject_ops.

use std::sync::Mutex;

use crate::error_codes;
use crate::focus::{self, FocusStateMachine};
use crate::forensic;
use crate::inject;
use crate::socket::chord_exit::ChordExit;
use crate::socket::control_row::{ControlOutcome, KeyReceipt, REASON_UNSUPPORTED_HERE};

use super::{apply_allowlist, resolve_inject_target, TargetIntent};

/// What one `control:key` press produced: the local row (when it mints one) and
/// the wire receipt (always). Two fields rather than two calls, because they are
/// decided by the SAME predicates and a second pass over them would be a second
/// place for the answers to diverge — the shape `ChordExit`'s single expression
/// already exists to prevent for the row and the forensic line.
pub(in crate::socket) struct ControlKeyRun {
    pub(in crate::socket) row: Option<ControlOutcome>,
    pub(in crate::socket) receipt: KeyReceipt,
}

/// Run one control:key kind. Unknown kinds fail loud (CONTROL_UNKNOWN_KIND) and
/// are never injected. The target is resolved from the FSM exactly like inject
/// (a `clear`/`enter` mid-utterance must land in the SPEAKING-locked window, not
/// a window the user switched to — 07 §3).
///
/// RETURNS BOTH ANSWERS THIS PRESS PRODUCES, and they have different coverage:
///
///   · [`ControlKeyRun::row`] — the row-facing outcome for a CHORD key, or `None`
///     when this press mints no row at all. The two `None` cases are deliberately
///     different things and both are out of REQ-12-13's scope by ruling rather than
///     by accident: a `punct_*` key edits the newest EXISTING row's text (owner
///     2026-07-28) rather than being an act of its own, and the execution card puts
///     the six punctuation keys out of scope in so many words; an unknown kind did
///     nothing, and "minting a row that says nothing happened" would be a receipt
///     for a non-event.
///   · [`ControlKeyRun::receipt`] — MP-14, what goes back to the phone that pressed
///     it. 🔴 IT IS PRODUCED ON EVERY PATH, INCLUDING THE TWO THAT MINT NO ROW.
///     That asymmetry is the whole card: the unknown-kind arm below has always been
///     loud in the forensic log and silent to the person who pressed the key, and a
///     log on this machine is not an answer to someone holding a phone.
///
/// ⚠️ The caller mints AND emits; this function does neither. Minting needs the
/// bridge sink and the channel, emitting needs the socket — all socket-lifecycle
/// facts — the same split `run_inject` / `mint_row` already uses, and it keeps this
/// function testable without a window and without a connection.
pub(in crate::socket) fn run_control_key(
    kind: &str,
    allowlist: &Option<Vec<String>>,
    fsm: &Mutex<FocusStateMachine>,
) -> ControlKeyRun {
    run_control_key_with(kind, allowlist, fsm, focus::set_foreground_window, inject::send_chords)
}

/// The OS key poster `run_control_key` hands the chord path (`inject::send_chords`).
pub(super) type ChordSender = fn(&[inject::KeyChord], u64) -> Result<(), inject::FlowKeyError>;

/// [`run_control_key`] with its two OS acts injected — the foreground switch and
/// the key poster — so a test can prove a refusal performed NEITHER (the seam shape
/// of `pipeline::FocusSwitcher`). Production passes the real pair, above.
pub(super) fn run_control_key_with(
    kind: &str,
    allowlist: &Option<Vec<String>>,
    fsm: &Mutex<FocusStateMachine>,
    set_foreground: inject::FocusSwitcher,
    send_chords: ChordSender,
) -> ControlKeyRun {
    // Capability refusal precedes target lookup too: Wayland has no X11 target
    // to resolve, so resolving first would hide the reason behind "no target".
    if let Some(refused) = crate::inject::preflight::synthetic_input_preflight() {
        return ControlKeyRun {
            row: inject::key_sequence_for(kind).map(|_| ControlOutcome::OsRefused),
            // A future unnamed preflight refusal must not invent a target or
            // display diagnosis. Keep the generic failed receipt in that case.
            receipt: refused.error_code.map_or(
                KeyReceipt::from_outcome(ControlOutcome::OsRefused),
                KeyReceipt::NamedRefusal,
            ),
        };
    }
    // v0.2.1 — the punctuation half of the whitelist is TYPED, not chorded (there
    // is no virtual key for 「、」). Routing it through the ordinary text pipeline
    // rather than a bespoke path is the point: it inherits Stage-1 focus, Stage-1b
    // "whether there is an editable control", the process-wide injection gate and the read-back
    // receipt. A second hand-rolled keystroke path would have had none of those,
    // and would have drifted from them the first time one changed.
    if let Some(glyph) = inject::punctuation_for(kind) {
        let target = apply_allowlist(resolve_inject_target(fsm, TargetIntent::LiveForeground), allowlist, "control:key");
        let (locked, app_id) = match &target {
            Some((h, _t, app)) => (Some(*h), Some(app.as_str())),
            None => (None, None),
        };
        let outcome = inject::inject_text(glyph, locked, app_id, set_foreground);
        // 🔴 MP-14 CHANGED THE SECOND HALF OF THIS COMMENT, NOT THE FIRST. What
        // stood here was 「control:key has NO result frame in the protocol, so the
        // outcome cannot be answered on the wire. It is recorded instead — an
        // unreportable outcome still has to be a discoverable one.」 The recording
        // stays, every word of it, because the forensic line is still the only
        // place the mode and the error code can live. What is no longer true is
        // 「cannot be answered on the wire」.
        forensic::record(
            "control",
            &format!(
                "punctuation {kind} ok={} mode={} err={:?}",
                outcome.ok,
                outcome.mode.wire(),
                outcome.error_code
            ),
        );
        // Mapped through the SAME table the chord path uses, by first turning this
        // into the local vocabulary — rather than reaching for a wire `reason`
        // directly here, which would be a second implementation of the collapse
        // rule and the place the two paths would drift apart. `locked.is_none()`
        // is 「the allowlist declined it, or there was no live foreground」, which
        // is exactly `NoTarget`.
        let as_outcome = if locked.is_none() {
            ControlOutcome::NoTarget
        } else if outcome.ok {
            ControlOutcome::Sent
        } else if outcome.error_code == Some(error_codes::INJECT_SUBMISSION_UNCERTAIN) {
            ControlOutcome::SubmissionUncertain
        } else {
            ControlOutcome::SendFailed
        };
        // NR-267-F1: the pipeline's UIPI refusal (`uipi::refusal_for`) travels as
        // itself — the same code the text path answers — not as the generic
        // `failed` that `SendFailed` collapses to. The receipt has no `mode` field;
        // `mode=cached` is in the forensic line above.
        let receipt = match outcome.error_code {
            Some(code @ error_codes::INJECT_TARGET_ELEVATED) if locked.is_some() => KeyReceipt::NamedRefusal(code),
            _ => KeyReceipt::from_outcome(as_outcome),
        };
        // 🔴 `row: None` IS UNCHANGED — a punctuation press still mints no row
        // (REQ-12-13 scope). Only the wire answer is new.
        return ControlKeyRun { row: None, receipt };
    }
    match inject::key_sequence_for(kind) {
        Some(seq) => {
            let target = apply_allowlist(resolve_inject_target(fsm, TargetIntent::LiveForeground), allowlist, "control:key");
            // RV-25 — the three exits below used to leave no trace at all. The
            // predicates and the order are untouched; each exit now says which
            // precondition failed (ChordExit), so a chord that did nothing is
            // answerable from the log instead of indistinguishable from a frame
            // that never arrived.
            if let Some((h, _t, _app)) = target {
                // 🔴 W3 2026-08-07 — the SAME gate the text and image paths take,
                // and it was missing here. `flow_key.rs`'s macOS arm carried a
                // comment claiming delivery 「is decided by the two OS conditions
                // read in preflight::synthetic_input_preflight before any of this
                // runs」 — true of the two inject paths, FALSE of this one, which
                // is the only production caller of `send_chords` and went straight
                // from `set_foreground_window` to posting events.
                //
                // What that cost on macOS without Accessibility: `CGEventPost`
                // returns void, so `post_chord` answered `true`, `send_chords`
                // answered `Ok(())`, and this line wrote 「chord {kind} sent」 for
                // keystrokes the window server discarded. `control:key` has NO
                // result frame — the forensic line is the ONLY evidence surface it
                // has — so the one artefact that exists said an act happened that
                // did not. "no silent failures" forbids both directions, and this was
                // the second one.
                //
                // Checked BEFORE `set_foreground_window` on purpose: a refusal must
                // not steal the user's foreground on its way to doing nothing —
                // the same ordering the text path asserts in
                // `a_refused_synthetic_input_gate_ends_the_text_frame_before_stage_1`.
                //
                // ⚠️ REQ-12-13 turned three `return`s and two `record` call sites into
                // ONE expression that yields the exit. The PREDICATES AND THEIR ORDER
                // ARE UNTOUCHED — `synthetic_input_preflight` is still evaluated
                // before `set_foreground_window`, which is the whole point of the
                // paragraph above. What changed is that every arm now produces a value
                // instead of ending the function, so the row and the forensic line
                // cannot fall out of step: they are built from the same `exit`.
                //
                // 🔴 NR-267-F1 — the same miss again, on Windows: the text and image
                // paths judge UIPI before Stage 1 (`pipeline.rs` `uipi_preflight`), this
                // one did not, so an elevated window in front cost the user their
                // foreground, UIPI dropped the keys, and row + receipt said sent. Judged
                // here, BEFORE `set_foreground`, answering the text path's own code.
                // Pinned by `a_control_key_into_an_elevated_window_takes_no_foreground_and_sends_nothing`.
                let mut named: Option<&'static str> = None;
                let exit = if let Some(refused) = crate::inject::preflight::synthetic_input_preflight() {
                    ChordExit::OsWillNotDeliver(refused.error_code.unwrap_or("(none)").to_string())
                } else if let Some(refused) = crate::inject::uipi::uipi_preflight(h) {
                    named = refused.error_code;
                    ChordExit::OsWillNotDeliver(refused.error_code.unwrap_or("(none)").to_string())
                } else if set_foreground(h) {
                    match send_chords(&seq, h) {
                        Ok(()) => ChordExit::Sent,
                        Err(inject::FlowKeyError::TargetChanged(_)) => ChordExit::TargetChanged,
                    Err(inject::FlowKeyError::SubmissionUncertain(detail)) => ChordExit::SubmissionUncertain(detail),
                        Err(e) => ChordExit::SendFailed(e.to_string()),
                    }
                } else {
                    ChordExit::ForegroundRefused
                };
                forensic::record("control", &exit.line(kind, Some(h), seq.len()));
                let outcome = exit.outcome();
                let receipt = named.map_or(KeyReceipt::from_outcome(outcome), KeyReceipt::NamedRefusal);
                ControlKeyRun { row: Some(outcome), receipt }
            } else {
                forensic::record("control", &ChordExit::NoTarget.line(kind, None, seq.len()));
                let outcome = ChordExit::NoTarget.outcome();
                ControlKeyRun { row: Some(outcome), receipt: KeyReceipt::from_outcome(outcome) }
            }
        }
        None => {
            eprintln!(
                "[flowmic] control:key rejected: kind={kind:?} -> {}",
                error_codes::CONTROL_UNKNOWN_KIND,
            );
            forensic::record(
                "control",
                &format!("rejected kind={kind:?} -> {}", error_codes::CONTROL_UNKNOWN_KIND),
            );
            // No row: see the doc comment. An unknown kind did nothing, and a row
            // saying so would be a receipt for a non-event.
            //
            // 🔴 BUT IT DOES GET A WIRE RECEIPT, AND THIS ARM IS THE REASON MP-14
            // EXISTS. The two lines above are the entire trace this press used to
            // leave, both of them on THIS machine — while the phone that pressed
            // the key kept saying it was sent. `unsupported_here` rather than
            // `failed`: nothing was attempted and nothing could be, so 「try again」
            // is the wrong move and 「this destination does not have that key」 is
            // the true one.
            ControlKeyRun { row: None, receipt: KeyReceipt::Refused(REASON_UNSUPPORTED_HERE) }
        }
    }
}

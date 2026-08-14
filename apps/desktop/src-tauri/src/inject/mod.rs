// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §2 (injection pipeline).
//
// Injection layer. Three-stage pipeline (pipeline.rs) over the primary
// SendInput path (sendinput.rs), the clipboard fallback (clipboard_paste.rs +
// clipboard_snapshot.rs), streaming correction (correction.rs), the six-key
// control map (flow_key.rs), and per-app learning (app_learning.rs).
//
// R6 T-4 adds the IMAGE half: image.rs turns an `inject:request.image_b64` into
// a Windows clipboard format table (WIC decode → CF_DIB / CF_BITMAP /
// registered PNG) which pipeline::inject_image pastes through the SAME
// save → delayed-render-confirm → restore-always machinery as text.

pub mod app_learning;
pub mod clipboard_confirm;
/// What a PASTE means — `map_clipboard_outcome` / `map_image_outcome` /
/// `receipt_phrase`, split out of `pipeline.rs` at the 800-line cap. Same cut
/// `sendinput_outcome.rs` makes for the typing path: the act stays in the
/// pipeline, 「what gives us the right to say this」 lives beside the rule.
pub mod clipboard_outcome;
pub mod clipboard_paste;
pub mod clipboard_snapshot;
pub mod correction;
pub mod flow_key;
pub mod gate;
pub mod image;
/// MAC-05 / MAC-06: the macOS implementations behind the platform-neutral seams
/// (NSPasteboard save/write/restore, the CGEvent ⌘V, and the two OS reads that
/// decide whether a synthetic keystroke can be delivered at all). No new stage and
/// no new verdict — see its header for what is deliberately NOT in it.
#[cfg(target_os = "macos")]
pub mod macos;
/// IJ-05 — a SECOND focus instrument (MSAA / oleacc), used ONLY to REPORT and never
/// to refuse. It is what lets a third-party app reach the strong tier 「injected
/// (confirmed input-capable)」 at all; before it, only FlowMic's own window could. Its header states
/// the red line it is built around: 「when it cannot be determined, always let it
/// through」, because owner's main browser and
/// WeChat hand back nothing but the window shell (measured, IJ-03).
pub mod msaa_focus;
/// V2-01 step one: READ-ONLY focus diagnostics. Does not change injection behavior, only observes.
pub mod probe_diag;
pub mod pipeline;
/// Injection permission (doc 15 §2.5e) — 「whether this frame should be typed into
/// the focus window, and who it should be typed into」.
/// Split out of `pipeline.rs` at the 800-line cap; the cut is 「the verdict that
/// can be settled before typing」 vs 「the act of typing itself」, argued in that file's header.
pub mod preflight;
/// 🔴 owner 2026-08-02 (F1a): 「own input fields must be able to receive
/// injection」. A NEW source of truth answering
/// 「does FlowMic's own window currently have an editable focus」 — merged with nothing, because
/// the two neighbours that look similar answer different questions (see its header).
pub mod self_focus;
pub mod sendinput;
/// V2-01: the SendInput truth-mapping rule (split out for the 800-line cap).
pub mod sendinput_outcome;
pub mod target_probe;
// 2026-07-30: `verify_readback` (the v0.2.1 before/after UIA read that was meant
// to make a SendInput delivery provable) is DELETED, not just unwired. It asked
// the target app to expose its own text through UI Automation — the target's
// choice, never ours — so it was blind in exactly the app owner uses most and
// produced two P0s in two days. `injected` now claims something we can evidence
// without it; see target_probe.rs and sendinput_outcome.rs.

pub use app_learning::AppLearningStore;
pub use clipboard_confirm::ConfirmOutcome;
pub use clipboard_paste::{ClipboardFallbackClient, PasteOutcome};
pub use clipboard_snapshot::ClipboardSnapshot;
pub use correction::{diff_correction, CorrectionOps};
pub use flow_key::{key_sequence_for, punctuation_for, send_chords, FlowKeyError, KeyChord};
pub use image::{ImageError, ImageMime, INJECT_IMAGE_B64_MAX};
// 🔴 DELIBERATELY NOT RE-EXPORTED (adversarial review, 2026-08-08). This line used
// to read `pub use msaa_focus::{msaa_verdict, MsaaVerdict};` — and grep found ZERO
// consumers of `inject::msaa_verdict` / `inject::MsaaVerdict`, because the one
// production caller (`pipeline.rs`) spells the path in full. New public symbols with
// no production caller are this repo's self-declared #1 historical bug class, and
// `pub use` emits no dead-code warning, so nothing would ever have caught it.
// ⇒ Anyone who needs them can say `inject::msaa_focus::…`, which also keeps the
// 「this came from the MSAA instrument」 fact visible at the call site.
pub use target_probe::{
    focused_input_state, refusal_for, wire_evidence, FocusInputState, TargetProbe,
};
pub use self_focus::{
    NoInputEvidence, SelfFocusProbe, SelfFocusVerdict, SELF_FOCUS_TTL,
};
// ⚠️ The 800-line split moved WHERE these live, never WHAT the callers say: the two
// pre-pipeline gates now come from `preflight`, and `socket/inject_ops.rs` /
// `socket/wire.rs` still write `inject::InjectOrigin` / `inject::deferred_outcome`
// exactly as before. That is the point of re-exporting from one place.
pub use preflight::{deferred_outcome, self_window_no_input, InjectOrigin};
pub use pipeline::{
    inject_image, inject_text, FocusSwitcher, InjectMode, InjectOutcome, INJECT_TEXT_MAX_CHARS,
};
#[cfg(test)]
pub use pipeline::inject_image_with_probe;
pub use sendinput::{InjectError, SendInputClient};

/// IJ-05 — the MSAA instrument's unit tests. Declared here rather than inline only
/// because `msaa_focus.rs` hit the 800-line src cap; same file-boundary detail as
/// `focus_evidence_tests.rs` below, and the same rule applies — it is not a
/// statement about ownership.
#[cfg(test)]
#[path = "msaa_focus_tests.rs"]
mod msaa_focus_tests;

/// IJ-01 — the focus-evidence contract, asserted on the PIPELINE. Declared here
/// rather than from `pipeline.rs` only because that file is at the 800-line src
/// cap; its header states what it can and cannot measure headless.
#[cfg(test)]
#[path = "focus_evidence_tests.rs"]
mod focus_evidence_tests;

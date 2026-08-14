// SPEC-REF:
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md §A MAC-05 / MAC-06
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (injection pipeline)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The macOS implementations behind the platform-neutral injection seams. Nothing
// here is a new stage and nothing here decides a verdict: the pipeline's shape,
// its stages and its truth table are unchanged, and these modules only supply the
// platform's answers to questions `pipeline.rs` was already asking.
//
//   secure_input — 「can a synthetic keystroke be delivered AT ALL right now?」
//                  (read BEFORE any side effect; the answer is consumed by
//                  `preflight::synthetic_input_preflight`)
//   pasteboard   — save / write+⌘V / restore, i.e. the Stage-3 seams
//                  (`clipboard_snapshot` + `clipboard_confirm` re-export these)
//   event_post   — the CGEvent keystroke itself, shared by the paste and by
//                  `flow_key::send_chords`
//
// 🔴 WHAT IS DELIBERATELY NOT HERE (breakdown §C, so it does not get 「a casual completeness pass」):
//   · a CGEvent TYPING path (the Stage-2 analog of SendInput). V1 delivers text
//     through the clipboard main path; `sendinput.rs`'s non-Windows arm therefore
//     still returns an error, and it now says WHY in words instead of `Win32(0)`.
//   · a promised-data pasteboard provider (the NSPasteboard analog of delayed
//     rendering). See `pasteboard.rs`'s header: there is no receipt on this
//     platform and V1 does not invent one.
//   · caret anchoring, window-level activation, window titles — all three need
//     either a permission MAC-04 does not take or an API macOS does not offer.

pub mod event_post;
pub mod pasteboard;
pub mod secure_input;

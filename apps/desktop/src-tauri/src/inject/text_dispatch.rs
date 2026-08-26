// The text inject DISPATCH: given a decision from `text_route`, run it, and fall
// back honestly when it fails.
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Split out of `pipeline.rs` VERBATIM on 2026-08-26 because that file stood at
// exactly 800/800 and CLAUDE.md's rule is that the next card to touch a file at
// the cap splits it first. The seam is a real one, not a line-count trick:
// `pipeline.rs` owns the three STAGES (focus → probe → deliver) and this file
// owns only the last one's choice of road.
//
// The decision itself lives in `text_route.rs` and is proven there. What only
// this file can prove is the COMPOSITION — 「a function was written but nobody
// calls it」 is this repo's #1 historical bug class — and the fallbacks, which
// are where the honesty lives: every path that ends up somewhere other than
// where the route pointed says so in its note.

use crate::inject::app_learning::AppLearningStore;
use crate::inject::clipboard_outcome::{map_clipboard_outcome, map_routed_paste_outcome};
use crate::inject::clipboard_paste::ClipboardFallbackClient;
use crate::inject::pipeline::{InjectMode, InjectOutcome};
use crate::inject::sendinput::SendInputClient;
use crate::inject::text_route::{self, PasteReason, TextRoute, TypeReason};

/// Stage 2/3: run the route, and fall back to the other road if it fails.
///
/// History of this ordering, because it has now flipped THREE times and the
/// reasons matter more than the current state:
///
///   · V2-01 put the CLIPBOARD first, on the grounds that `WM_RENDERFORMAT` was
///     the only receipt available anywhere.
///   · v0.2.1 flipped to SendInput once read-back was supposed to give typing a
///     receipt too.
///   · 2026-07-30 retired the receipt argument on both sides — `injected` no
///     longer claims a landing, so neither path needs to prove one — and typing
///     stayed in front for two reasons that were the stronger ones anyway: the
///     clipboard path takes over the user's clipboard and presses Ctrl+V into
///     their app (a lot of side effect for the common case), and it is where
///     the 0.2.1 heap-corruption crash lived (0xc0000374, twice, same
///     StackHash).
///   · 2026-08-26 flips it back to the CLIPBOARD, and neither of those two
///     reasons was refuted — they were outweighed. The clipboard side effect is
///     now bounded and reported (`clipboard_snapshot.rs` restores, and
///     `ClipboardSnapshot::unrecoverable()` says when it could not), the
///     re-entrancy crash was fixed at its root, and on the other side of the
///     scale two independent SILENT corruptions were measured on the typed path
///     within five days of each other. Full argument above
///     `text_route::route_text`.
///
/// ⚠️ The 0.2.1 crash note is kept deliberately: it is the strongest single
/// argument against this change, and deleting it once the change landed would
/// be how the next person re-flips this without knowing what it costs.
pub(crate) fn type_or_paste(text: &str, app_id: Option<&str>) -> InjectOutcome {
    type_or_paste_with(
        text,
        app_id,
        AppLearningStore::global(),
        &run_sendinput,
        &run_clipboard,
        &run_paste,
    )
}

/// The three runner seams of [`type_or_paste_with`], named so the signature
/// reads as a contract (and for clippy's type-complexity rule).
type SendInputRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore) -> InjectOutcome;
type ClipboardRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore) -> InjectOutcome;
type PasteRun<'a> = &'a dyn Fn(&str, PasteReason) -> InjectOutcome;

/// [`type_or_paste`] with the three runners injected — the seam the routing
/// tests drive (a live clipboard/keyboard cannot appear in a unit test).
///
/// The two fallbacks are NOT symmetric, and the asymmetry is deliberate:
///
///   · a failed PASTE falls back to typing, accepting that the delivery may be
///     mangled, because a dropped utterance is worse than a damaged one. The
///     note names the trade so a forensic reader is not left to guess why
///     typing ran after the route said not to;
///   · a failed TYPE falls back to the clipboard, which also writes per-app
///     learning (`map_sendinput_outcome` recorded the hard rejection on the way
///     through), so the next sentence into that app skips the broken road.
pub(crate) fn type_or_paste_with(
    text: &str,
    app_id: Option<&str>,
    store: &AppLearningStore,
    sendinput_run: SendInputRun<'_>,
    clipboard_run: ClipboardRun<'_>,
    paste_run: PasteRun<'_>,
) -> InjectOutcome {
    // The one learned fact the store still carries. `Some(Clipboard)` means this
    // app returned a HARD error from SendInput before — see `record_outcome`,
    // which no longer records anything else.
    let typing_hard_rejected =
        app_id.and_then(|id| store.preferred_mode_for(id)) == Some(InjectMode::Clipboard);

    match text_route::route_text(text, app_id, typing_hard_rejected) {
        TextRoute::Paste(reason) => {
            let out = paste_run(text, reason);
            if out.ok {
                return out;
            }
            sendinput_run(text, app_id, store).with_note(format!(
                "clipboard route failed ({}), fell back to SendInput typing — a typed delivery \
                 cannot be verified and some targets silently mangle or drop it (the corruption \
                 the route exists to avoid), but a dropped utterance would be worse",
                out.error_code.unwrap_or("unknown")
            ))
        }
        TextRoute::Type(TypeReason::ConsoleTarget) => {
            let out = sendinput_run(text, app_id, store);
            if out.ok {
                return out;
            }
            // 2026-07-30: the 「don't paste on top of a possible landing」 guard
            // that used to sit here (`if out.mode == Cached { return out }`) is
            // GONE with the verdict that produced it. `run_sendinput` can no
            // longer answer `cached` at all — the only non-ok outcome left is a
            // call that errored, which by definition queued nothing, so a paste
            // cannot duplicate anything. Keeping the branch would have been an
            // unreachable guard implying a state that no longer exists.
            let fallback = clipboard_run(text, app_id, store);
            if fallback.ok {
                return fallback.with_note(format!(
                    "the SendInput call failed ({}), delivered by clipboard paste instead",
                    out.error_code.unwrap_or("unknown")
                ));
            }
            fallback.with_note(
                "the SendInput call failed, and the clipboard fallback failed too".to_string(),
            )
        }
    }
}

/// Stage 2: type it.
///
/// `type_text` returning `Ok(n)` means n events were accepted into the input
/// queue. That is the whole of what Windows will ever tell us, and as of
/// 2026-07-30 it is also the whole of what we claim — the other two thirds of
/// `injected` (a foreground window, a focus in an input state) were established
/// by Stage 1 and Stage 1b before this runs.
///
/// What used to be here: a before/after UIA read of the target
/// (`verify_readback`), whose verdict decided the outcome. It is deleted. It
/// demanded that the TARGET expose its own text through UIA — the target's
/// choice, not ours — so it went blind precisely in the app owner uses most
/// (Chromium) and produced two P0s in two days. See the note at the top of
/// `sendinput_outcome.rs`.
fn run_sendinput(text: &str, app_id: Option<&str>, store: &AppLearningStore) -> InjectOutcome {
    let sent = SendInputClient::new().type_text(text);
    crate::inject::sendinput_outcome::map_sendinput_outcome(sent, app_id, store)
}

/// Stage-3 clipboard paste, reached only after a typed attempt FAILED (the
/// console exception is the only route that types, so this is the only entry).
fn run_clipboard(text: &str, app_id: Option<&str>, store: &AppLearningStore) -> InjectOutcome {
    let result = ClipboardFallbackClient::new().paste_text(text);
    map_clipboard_outcome(result, app_id, store)
}

/// The routed paste — the default road. Same client as [`run_clipboard`],
/// different mapper: no per-app learning (a paste says nothing about whether
/// typing works), and the forensic line carries WHICH rule sent it here.
fn run_paste(text: &str, reason: PasteReason) -> InjectOutcome {
    map_routed_paste_outcome(ClipboardFallbackClient::new().paste_text(text), reason)
}

impl InjectOutcome {
    /// Prefix an existing message with `note` (used to thread the SendInput
    /// error onto a fallback outcome without losing the fallback's own note).
    pub(crate) fn with_note(mut self, note: String) -> Self {
        self.error_message = Some(match self.error_message {
            Some(existing) => format!("{note}; {existing}"),
            None => note,
        });
        self
    }
}

// Routing wiring tests — a child of THIS module because `type_or_paste_with` is
// deliberately not public beyond the crate (see that file's header).
#[cfg(test)]
#[path = "ime_route_tests.rs"]
mod ime_route_tests;

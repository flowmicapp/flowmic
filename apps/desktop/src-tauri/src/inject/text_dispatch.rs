// The text inject DISPATCH: given a decision from `text_route`, run it, and fall
// back honestly when it fails.
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Split out of `pipeline.rs` VERBATIM on 2026-08-26 because that file stood at
// exactly 800/800 and CLAUDE.md's rule is that the next card to touch a file at
// the cap splits it first (that rule is CLAUDE.md D-14; the two blocks it was
// distilled from are docs/archive/CLAUDE-HISTORY.md §343-346 and §570-581). The seam is a real one, not a line-count trick:
// `pipeline.rs` owns the three STAGES (focus → probe → deliver) and this file
// owns only the last one's choice of road.
//
// The decision itself lives in `text_route.rs` and is proven there. What only
// this file can prove is the COMPOSITION — 「a function was written but nobody
// calls it」 is this repo's #1 historical bug class — and the fallbacks, which
// are where the honesty lives: every path that ends up somewhere other than
// where the route pointed says so in its note.

#[cfg(any(not(target_os = "linux"), test))]
use crate::inject::app_learning::AppLearningStore;
#[cfg(not(target_os = "linux"))]
use crate::inject::clipboard_outcome::map_clipboard_outcome;
use crate::inject::clipboard_outcome::map_routed_paste_outcome;
use crate::inject::clipboard_paste::ClipboardFallbackClient;
#[cfg(any(not(target_os = "linux"), test))]
use crate::inject::pipeline::InjectMode;
use crate::inject::pipeline::InjectOutcome;
#[cfg(not(target_os = "linux"))]
use crate::inject::sendinput::SendInputClient;
use crate::inject::text_route::PasteReason;
#[cfg(any(not(target_os = "linux"), test))]
use crate::inject::text_route::{self, TextRoute, TypeReason};

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
#[cfg(not(target_os = "linux"))]
pub(crate) fn type_or_paste(text: &str, app_id: Option<&str>, _expected_target: u64) -> InjectOutcome {
    type_or_paste_routed(
        text,
        app_id,
        // D-MKT-5: the console line-break rule is measured and specified for
        // Windows consoles only (07 §2 「控制台目标的换行」); macOS keeps its
        // behaviour, so this arm passes false there.
        cfg!(windows),
        AppLearningStore::global(),
        &run_sendinput,
        &run_clipboard,
        &run_paste,
    )
}

/// Linux has one text mechanism. The Stage-1 target is carried explicitly to
/// the XTEST commit point; an absent or changed focus is never guessed anew.
#[cfg(target_os = "linux")]
pub(crate) fn type_or_paste(text: &str, _app_id: Option<&str>, expected_target: u64) -> InjectOutcome {
    map_routed_paste_outcome(
        ClipboardFallbackClient::for_linux_target(expected_target).paste_text(text),
        PasteReason::DefaultPath,
    )
}

/// The three runner seams of [`type_or_paste_with`], named so the signature
/// reads as a contract (and for clippy's type-complexity rule).
#[cfg(any(not(target_os = "linux"), test))]
type SendInputRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore) -> InjectOutcome;
#[cfg(any(not(target_os = "linux"), test))]
type ClipboardRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore) -> InjectOutcome;
#[cfg(test)]
type PasteRun<'a> = &'a dyn Fn(&str, PasteReason) -> InjectOutcome;
/// The routed paste runner: its verdict, plus `act_completed` — whether the
/// paste ACT itself returned without error (Ctrl+V went out). D-MKT-8 needs that
/// fact and the verdict cannot carry it: a hard paste error and a paste nobody
/// fetched are both INJECT_CLIPBOARD_FAIL.
#[cfg(any(not(target_os = "linux"), test))]
type RoutedPasteRun<'a> = &'a dyn Fn(&str, PasteReason) -> (InjectOutcome, bool);

/// [`type_or_paste_routed`] for a paste runner that returns only a verdict —
/// the seam the routing tests drive. Such a runner carries no `act_completed`
/// fact, so it gets `false`: the fallback rule that held before D-MKT-8.
///
/// It also passes `console_line_breaks_submit = false` (no D-MKT-5 flattening),
/// which is what the Linux production arm does: its only caller outside this
/// module is `linux_contract_tests.rs`. Tests that need the flattening flag call
/// [`type_or_paste_routed`] directly (`ime_route_tests.rs` `drive_with`).
#[cfg(test)]
pub(crate) fn type_or_paste_with(
    text: &str,
    app_id: Option<&str>,
    store: &AppLearningStore,
    sendinput_run: SendInputRun<'_>,
    clipboard_run: ClipboardRun<'_>,
    paste_run: PasteRun<'_>,
) -> InjectOutcome {
    type_or_paste_routed(text, app_id, false, store, sendinput_run, clipboard_run, &|t, r| {
        (paste_run(t, r), false)
    })
}

/// [`type_or_paste`] with the three runners injected (a live clipboard/keyboard
/// cannot appear in a unit test).
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
///
/// 🔴 D-MKT-8 (2026-11-05): 「a failed PASTE」 above means a paste whose ACT
/// failed. A paste whose act completed and still is not a delivery (on Windows:
/// nobody fetched our text, `clipboard_outcome::text_never_left_us`) is NEVER
/// typed after. Its Ctrl+V is already in the target, which may still act on it
/// with whatever the clipboard then holds; typing on top is a second action we
/// cannot verify, on the road the route chose not to take, and its success
/// would turn an honest `failed` back into a claim with no evidence behind it.
///
/// `console_line_breaks_submit` (D-MKT-5): when true and the target is a
/// console, the text's line breaks are flattened to spaces BEFORE the route is
/// chosen, so every road below — typed, pasted, and both fallbacks — carries
/// the flattened text, and the outcome's forensic note says so. One place, not
/// one per runner: a runner that forgot would put the Enter back. The D-MKT-8
/// rule then applies inside `route_and_run`, to whichever text it was handed.
#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn type_or_paste_routed(
    text: &str,
    app_id: Option<&str>,
    console_line_breaks_submit: bool,
    store: &AppLearningStore,
    sendinput_run: SendInputRun<'_>,
    clipboard_run: ClipboardRun<'_>,
    paste_run: RoutedPasteRun<'_>,
) -> InjectOutcome {
    if console_line_breaks_submit {
        if let Some(flat) = text_route::flatten_line_breaks_for_console(text, app_id) {
            return route_and_run(&flat.text, app_id, store, sendinput_run, clipboard_run, paste_run)
                .with_note(flat.forensic_note(app_id));
        }
    }
    return route_and_run(text, app_id, store, sendinput_run, clipboard_run, paste_run);

    // The route and its fallbacks, unchanged by D-MKT-5 (nested so the
    // flattening above sits in front of all of it, under the same cfg). The
    // paste arm carries D-MKT-8's rule (no typing after a completed paste act).
    fn route_and_run(
        text: &str,
        app_id: Option<&str>,
        store: &AppLearningStore,
        sendinput_run: SendInputRun<'_>,
        clipboard_run: ClipboardRun<'_>,
        paste_run: RoutedPasteRun<'_>,
    ) -> InjectOutcome {
        // The one learned fact the store still carries. `Some(Clipboard)` means this
        // app returned a HARD error from SendInput before — see `record_outcome`,
        // which no longer records anything else.
        let typing_hard_rejected =
            app_id.and_then(|id| store.preferred_mode_for(id)) == Some(InjectMode::Clipboard);

        match text_route::route_text(text, app_id, typing_hard_rejected) {
            TextRoute::Paste(reason) => {
                let (out, act_completed) = paste_run(text, reason);
                if out.ok
                    || act_completed
                    || out.error_code == Some(crate::error_codes::INJECT_SUBMISSION_UNCERTAIN)
                {
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
                if out.ok || out.error_code == Some(crate::error_codes::INJECT_SUBMISSION_UNCERTAIN) {
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
                if fallback.error_code == Some(crate::error_codes::INJECT_SUBMISSION_UNCERTAIN) {
                    return fallback.with_note("the SendInput call failed; clipboard fallback submission is uncertain".into());
                }
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
#[cfg(not(target_os = "linux"))]
fn run_sendinput(text: &str, app_id: Option<&str>, store: &AppLearningStore) -> InjectOutcome {
    // NR-253: a typed line break is Shift+Enter unless this target is measured
    // to need plain Enter — this function also runs as the fallback after a
    // failed paste, i.e. into chat boxes where a plain Enter sends. The choice is
    // made inside `type_text_for_app`, where its tests can see it.
    let sent = SendInputClient::new().type_text_for_app(text, app_id);
    crate::inject::sendinput_outcome::map_sendinput_outcome(sent, app_id, store)
}

/// Stage-3 clipboard paste, reached only after a typed attempt FAILED (the
/// console exception is the only route that types, so this is the only entry).
#[cfg(not(target_os = "linux"))]
fn run_clipboard(text: &str, app_id: Option<&str>, store: &AppLearningStore) -> InjectOutcome {
    let result = ClipboardFallbackClient::new().paste_text(text);
    map_clipboard_outcome(result, app_id, store)
}

/// The routed paste — the default road. Same client as [`run_clipboard`],
/// different mapper: no per-app learning (a paste says nothing about whether
/// typing works), and the forensic line carries WHICH rule sent it here.
///
/// The second value is `act_completed` ([`RoutedPasteRun`]): read off the
/// paste's own `Result`, so the verdict stays decided in one place (the mapper).
#[cfg(not(target_os = "linux"))]
fn run_paste(text: &str, reason: PasteReason) -> (InjectOutcome, bool) {
    let result = ClipboardFallbackClient::new().paste_text(text);
    let act_completed = result.is_ok();
    (map_routed_paste_outcome(result, reason), act_completed)
}

impl InjectOutcome {
    /// Prefix an existing message with `note` (used to thread the SendInput
    /// error onto a fallback outcome without losing the fallback's own note).
    #[cfg(any(not(target_os = "linux"), test))]
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

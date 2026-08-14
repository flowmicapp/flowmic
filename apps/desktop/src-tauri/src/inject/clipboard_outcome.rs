// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (three-stage injection pipeline, Stage 3)
//   docs/strategy/2026-07-30-inject-state-narrowing-design.md §3
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// WHAT A PASTE MEANS — the clipboard half of the truth mapping.
//
// Split out of `pipeline.rs` at the 800-line src cap. 🔴 NOTHING CHANGED IN THE
// MOVE: every line below is the verbatim text that was in pipeline.rs, and the
// only edits are the three `pub(crate)` visibilities the file boundary requires.
// Any diff beyond 「the move」 would be a bug in this split rather than a change anyone
// asked for.
//
// THE CUT IS THE ONE `sendinput_outcome.rs` ALREADY MAKES, one path over: that
// file holds 「SendInput accepted N events — does that count as one injected」 and pipeline.rs holds
// the act itself (`run_sendinput`). This file is the same boundary for the paste —
// `run_clipboard` / `inject_image_with_probe` perform the act over there, and
// 「what gives us the right to call it injected / failed」 is decided here. Both mappers are PURE over
// their `Result`, which is what lets the rule be asserted without a live
// clipboard (pipeline_tests.rs drives all three functions directly).
//
// ⚠️ Callers are unchanged: pipeline.rs `use`s both mappers, so `run_clipboard`
// and `inject_image_with_probe` read exactly as they did, and pipeline_tests.rs's
// `use super::*` still resolves `map_clipboard_outcome` / `map_image_outcome` /
// `receipt_phrase` without touching a single test.

use crate::error_codes;
use crate::inject::app_learning::AppLearningStore;
use crate::inject::clipboard_confirm::ConfirmOutcome;
use crate::inject::clipboard_paste::{PasteOutcome, CONFIRM_TIMEOUT};
use crate::inject::pipeline::{InjectMode, InjectOutcome};
use crate::inject::sendinput::InjectError;

/// How a delayed-render receipt is written on a forensic line.
///
/// RV-44 (2026-07-30): the line used to read `render-receipt consumed=false`, and
/// the next person to read it takes that for 「the target did not read our data」.
/// It has only ever meant 「no WM_RENDERFORMAT arrived inside the window we
/// watched」, which is a MEASUREMENT — and a measurement without its window is an
/// unfalsifiable claim. The window is therefore part of the sentence, and the
/// number is read from `CONFIRM_TIMEOUT` instead of being retyped here: the same
/// question answered in two places is exactly how the log ends up asserting a
/// window we no longer wait.
#[cfg(not(target_os = "macos"))]
pub(crate) fn receipt_phrase(confirmed: bool) -> String {
    if confirmed {
        "render-receipt consumed=true".to_string()
    } else {
        format!(
            "render-receipt consumed=false (no WM_RENDERFORMAT within {}ms — NOT observed, \
             which is not the same as 「the target refused it」)",
            CONFIRM_TIMEOUT.as_millis()
        )
    }
}

/// The same line on a platform that has no receipt to report (MAC-05).
///
/// 🔴 THIS ARM EXISTS BECAUSE THE WINDOWS SENTENCE WOULD BE A CATEGORY ERROR HERE,
/// not merely false. 「no WM_RENDERFORMAT within 500ms」 tells the next reader that
/// we watched for something and did not see it, and they would go looking for a
/// target that refused to read. NSPasteboard has no delayed-rendering callback at
/// all (inject/macos/pasteboard.rs), so `confirmed` is false STRUCTURALLY: it says
/// 「this platform cannot answer that question」 and nothing whatsoever about the
/// target. The 500ms is still named, because it is real — it is how long the
/// user's pasteboard was held before being restored — but it is named as what it
/// is, a fixed delay, not a window we observed over.
#[cfg(target_os = "macos")]
pub(crate) fn receipt_phrase(confirmed: bool) -> String {
    // The word 「consumed」 is deliberately absent from both arms: it is the word
    // that turns a structural n/a into an apparent measurement of the target, and
    // it is what the Windows sentence means. Two platforms, two sentences, and the
    // reader can tell which one they are holding.
    if confirmed {
        // Unreachable through the production path — `inject/macos/pasteboard.rs`
        // returns `confirmed:false` by construction and has a test pinning it.
        // It is a LOUD LINE rather than a `debug_assert`, for two reasons: the
        // pure mapping functions (`map_clipboard_outcome` / `map_image_outcome`)
        // are legitimately driven with `true` by unit tests, so asserting here
        // would fail the suite for something that is not a defect; and a panic
        // inside the injection path is a worse answer than a log line anywhere.
        return "render-receipt claims consumed=true on macOS — IMPOSSIBLE: this platform has \
                no receipt mechanism, so the flag was invented somewhere upstream"
            .to_string();
    }
    format!(
        "render-receipt n/a on macOS (NSPasteboard has no WM_RENDERFORMAT equivalent, so there \
         is nothing to observe; the pasteboard was held {}ms as a FIXED delay, which says \
         nothing whatsoever about the target)",
        CONFIRM_TIMEOUT.as_millis()
    )
}

/// Map an image `paste_image` result to the truthful InjectOutcome.
///
/// ── 2026-07-30: the receipt stopped being a gate (design §3) ────────────────
///
/// owner:「for images ... there's no need to force it, we just need to have
/// actually performed the action」. So what an image
/// `injected` claims is 「delivered to the PC and the paste action was executed,
/// the file has been saved to the data directory」 — three
/// things we do know — and NOT 「the target app accepted the picture」, which is the target app's
/// business and not observable as a promise we can keep.
///
/// `WM_RENDERFORMAT` (the target fetching the bytes) is therefore no longer the
/// ok/fail gate, but it is still RECORDED: it is free evidence, and throwing away
/// evidence because it stopped being a verdict is the wrong lesson. It goes to
/// forensic, not to the user, because the user cannot act on it — 0.2.x spent
/// three releases telling owner 「not injected」 for pictures that were sitting in the
/// target's composer.
///
/// A real ERROR is still a failure: `Err(..)` means one of our own Win32 steps
/// failed (or the user's clipboard could not be restored), which is a thing we
/// did wrong and knowably did not do.
///
/// ── 2026-08-03 F-4: a DROPPED offer is that same failure, one layer up ────────
///
/// The receipt is not a gate, but the WITHDRAWAL that ends the paste is our step
/// too. When it did not take, the OS discards the announced formats unrendered
/// (`ConfirmOutcome::dropped_unrendered`) — and if the target ALSO read nothing,
/// the picture reached no one and the paste act did not complete. That is failed,
/// not a performed delivery. It is distinct from `!confirmed` alone, which owner
/// blessed as a delivery, because here it is OUR teardown that broke, not the
/// target that declined. See the `dropped_unrendered && !confirmed` branch.
pub(crate) fn map_image_outcome(result: Result<ConfirmOutcome, InjectError>) -> InjectOutcome {
    match result {
        Ok(ConfirmOutcome {
            confirmed,
            requested_format,
            dropped_unrendered,
        }) => {
            // ── F-4 (2026-08-03 M5): an incomplete paste is NOT a delivery ──────
            //
            // owner de-gated the RECEIPT for pictures (「for images ... there's no
            // need to force it, we just need to have actually performed the
            // action」), so `!confirmed` ALONE stays `injected`. But when
            // our OWN RV-39 teardown did not take and the OS DROPPED the announced
            // formats unrendered (`dropped_unrendered`) AND the target consumed
            // nothing (`!confirmed`), the paste act did not complete — the offer the
            // target would have read was destroyed before anyone read it. That is our
            // mechanism failing, the same category as the `Err` arm below, so it is
            // FAILED (INJECT_CLIPBOARD_FAIL → the relay maps ok=false to failed).
            // This is the exact M5 signature — image → Notepad, `consumed=false` +
            // `DROPPED unrendered`, both ends said 「success」 — made honest so the phone
            // can learn the picture did not land.
            //
            // 🔴 `confirmed` OUTRANKS the drop: a target that read a format HAS the
            // picture, so a dropped SIBLING format is moot. And this keys on the
            // WITHDRAWAL dropping the offer, never on the receipt alone — owner's
            // ruling for a clean unconfirmed paste is untouched.
            //
            // ⚠️ The picture is STILL kept: `socket::row_transit::mint_row` writes it
            // to the timeline-images store (RV-93) on every image frame regardless of
            // this verdict, so 「failed」 here means 「did not land in the target」, not
            // 「lost」 — the copy the user can open lives on this PC's timeline. The
            // false-reporting red line is what this closes: 「success」 for a paste that did not land.
            if dropped_unrendered && !confirmed {
                crate::forensic::record(
                    "inject",
                    &format!(
                        "image paste FAILED — announced formats were DROPPED unrendered (RV-39 \
                         withdrawal did not take) and the target consumed nothing; reporting \
                         failed so the phone does not hear 「success」 for a picture that did not \
                         land (F-4). requested_format={}",
                        requested_format
                            .map(|f| f.to_string())
                            .unwrap_or_else(|| "(none asked)".into()),
                    ),
                );
                return InjectOutcome {
                    ok: false,
                    mode: InjectMode::Clipboard,
                    error_code: Some(error_codes::INJECT_CLIPBOARD_FAIL),
                    error_message: Some(format!(
                        "image paste offer dropped unrendered (RV-39 withdrawal did not take) with \
                         no target consumption; requested_format={requested_format:?}"
                    )),
                    focus_evidence: None,
                };
            }
            // Both remaining branches are `injected`; only the evidence differs, and
            // it is recorded so a later 「the picture didn't go in」 report has something to read.
            crate::forensic::record(
                "inject",
                &format!(
                    "image paste DONE — {} requested_format={} \
                     (not a gate since 2026-07-30: 「injected」 claims the paste was performed, \
                     not that the target accepted it)",
                    receipt_phrase(confirmed),
                    requested_format
                        .map(|f| f.to_string())
                        .unwrap_or_else(|| "(none asked)".into()),
                ),
            );
            InjectOutcome {
                ok: true,
                mode: InjectMode::Clipboard,
                error_code: None,
                error_message: None,
                focus_evidence: None, // stamped by the caller, which holds the reading
            }
        }
        Err(paste_err) => InjectOutcome {
            ok: false,
            mode: InjectMode::Clipboard,
            error_code: Some(error_codes::INJECT_CLIPBOARD_FAIL),
            error_message: Some(format!("image clipboard paste failed; paste={paste_err}")),
            focus_evidence: None,
        },
    }
}

/// Map a clipboard `paste_text` result to the truthful InjectOutcome. Pulled out
/// of `run_clipboard` so the rule is unit-provable without a live clipboard.
///
/// ── 2026-07-30: the same de-gating as the image path, for the same reason ────
///
/// The TEXT fallback shares the very same delayed-render receipt machinery as the
/// picture path, so it gets the very same rule (design §3 ⚠️): the receipt is
/// recorded, not enforced. Under the narrowed definition of `injected` the paste
/// has done everything it claims — Stage 1 owned the foreground, Stage 1b found
/// the focus in an input state, and Ctrl+V went to that focus.
///
/// Truth:
///   Ok(..)   → the paste was performed at a verified focus → `injected`. The
///              receipt (`confirmed`) rides the forensic line.
///   Err(..)  → one of OUR Win32 steps failed, or the user's clipboard could not
///              be restored → `failed` (INJECT_CLIPBOARD_FAIL).
pub(crate) fn map_clipboard_outcome(
    result: Result<PasteOutcome, InjectError>,
    app_id: Option<&str>,
    store: &AppLearningStore,
    skipped_sendinput: bool,
) -> InjectOutcome {
    // Per-app learning now follows the same narrowing: only a hard error counts as
    // this app rejecting the paste path. An unconsumed-but-error-free paste used to
    // be recorded as a failure, which then bounced the app back onto SendInput —
    // a preference flip driven by a receipt we have just agreed not to trust.
    if let Some(id) = app_id {
        store.record_outcome(id, InjectMode::Clipboard, result.is_ok());
    }
    match result {
        Ok(PasteOutcome { confirmed }) => {
            // WHY the delivery ended up on the paste path is a diagnostic, and this
            // line is where diagnostics live. It used to ride the RECEIPT instead
            // (see below), where it was both invisible to every reader and shaped
            // like a failure.
            crate::forensic::record(
                "inject",
                &format!(
                    "text paste DONE — {} sendinput={} (receipt not a gate since 2026-07-30)",
                    receipt_phrase(confirmed),
                    if skipped_sendinput {
                        "skipped(prior-hard-failure)"
                    } else {
                        "failed"
                    },
                ),
            );
            InjectOutcome {
                ok: true,
                mode: InjectMode::Clipboard,
                // RV-48: this branch used to ship `INJECT_SENDINPUT_FAIL` on an
                // `ok:true` receipt, defended by 「this is how the UI learns the
                // delivery went by paste rather than by typing」. Grepped across all
                // three ends 2026-07-30 — that reader does not exist:
                //   · desktop: the wire field is `error`, and `capsule/controller.ts`
                //     reads it ONLY inside `if (!ok)` (`const code = str(r.error)`);
                //     `error_code|errorCode` has ZERO hits in all of apps/desktop/src;
                //   · phone: `timeline_store.applyInjectResult` maps status from `ok`
                //     and `mode`; every `INJECT_SENDINPUT_FAIL` test it has sends
                //     `ok:false`;
                //   · server: the relay maps ok/mode → status and never reads the code
                //     on a success.
                // So it was a failure code riding a success — the repo's #1 shape (one
                // value answering two questions) kept alive by a defence that named a
                // consumer nobody had checked for.
                //
                // 「Which physical path did this take」 is `mode`'s question and `mode:
                // clipboard` answers it. 「Why we ended up there」 is diagnostic and now
                // rides the forensic line above (`sendinput=skipped(prior-hard-failure)`
                // / `sendinput=failed`), which is where a fact no user can act on
                // belongs. Nothing is lost; one lie is.
                error_code: None,
                error_message: None,
                focus_evidence: None, // stamped by `inject_text_with_probe`
            }
        }
        Err(paste_err) => InjectOutcome {
            ok: false,
            mode: InjectMode::Clipboard,
            error_code: Some(error_codes::INJECT_CLIPBOARD_FAIL),
            error_message: Some(format!("both paths failed; paste={paste_err}")),
            focus_evidence: None,
        },
    }
}

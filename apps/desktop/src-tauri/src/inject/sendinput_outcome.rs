// V2-01 (requirement ⑦) — the SendInput truth-mapping rule, on its own so it is
// unit-provable without a live desktop.
//
// Split out of `pipeline.rs` because that file hit the repo's 800-line cap.
// Splitting rather than shrinking comments is deliberate: the comments carry why
// each branch reads the way it does, and trading them for line count is the worse
// deal (doc 13 §8 F-class findings live in exactly such comments).
//
// It mirrors `map_clipboard_outcome`'s existing shape — same reason, same seam.
//
// ── 2026-07-30: the third input was RETIRED, and this got simpler ────────────
//
// For two releases this function took a `ReadbackVerdict` as well, because
// `Ok(n)` from `SendInput` means 「n 个事件排进了队列」 ("n events were queued") and the rule
// 「未确认，即未注入」 ("unconfirmed means not injected") demanded a confirmation the API does not give. Read-back was
// the attempt to supply it — look at the target through UIA before and after and
// see whether our text appeared. It is gone (whole module deleted), and the honest
// reason is that it asked for evidence the platform does not hand out: a target
// only exposes its text if IT chooses to, so the mechanism failed exactly where
// owner needed it (Chromium, whose a11y provider answers nothing) and produced
// two P0s in two days — 0.2.19 (every browser dictation refused) and 0.2.21
// (text that HAD landed reported 「未注入」 ("not injected")).
//
// What replaced it is a narrower claim, not a looser one. `injected` now means
// 「已送到键盘焦点，且当时焦点处于可输入状态」 ("delivered to the keyboard focus, and
// the focus was in an input-capable state at the time") (owner's 2026-07-30 ruling), and all three
// pieces of evidence are ours BEFORE the keystroke: Stage 1 got the foreground
// window, Stage 1b found the focus in an input state, and `SendInput` accepted N
// events. Nothing here has to guess, and nothing here claims a landing.
//
// So this file now has exactly two branches, and `INJECT_SENDINPUT_FAIL` narrowed
// with it: it used to mean 「读回来了，一个字没变，确知没落地」 ("read it back, not a
// single character had changed, definitively did not land") — a MEASUREMENT — and
// now means only 「这个调用本身失败了」 ("the call itself failed"). It is no longer a statement about the
// target.

use crate::error_codes;
use crate::inject::app_learning::AppLearningStore;
use crate::inject::pipeline::{InjectMode, InjectOutcome};
use crate::inject::sendinput::InjectError;

/// Map a `type_text` result to the truthful outcome.
///
/// Truth:
///   Ok(n)   → the keys were accepted into the input queue of a focus we had
///             already established was in an input state → `injected`.
///   Err(e)  → the call itself failed → `failed` + `INJECT_SENDINPUT_FAIL`.
///
/// There is deliberately no `cached` branch here. `cached` means 「没有投递，留着
/// 可以补投」 ("not delivered, kept so it can be re-delivered later") and by the time this runs a delivery has been attempted at a real
/// focused window — the cached cases all live upstream in Stage 1 (no target /
/// could not take the foreground) where nothing has been sent yet. Letting this
/// function return `cached` is what made 「已发送但确认不了」 ("sent but could not
/// be confirmed") and 「根本没发出去」 ("never sent at all") the
/// same word for two releases, and the two ask the user to do opposite things.
pub(crate) fn map_sendinput_outcome(
    result: Result<usize, InjectError>,
    app_id: Option<&str>,
    store: &AppLearningStore,
) -> InjectOutcome {
    // Per-app learning: only a HARD call failure steers an app to the clipboard
    // next time. Previously this was fed by the read-back verdict, which meant an
    // app we merely could not READ got moved off the path that was working for it
    // — a self-inflicted downgrade on top of a false negative.
    if let Some(id) = app_id {
        store.record_outcome(id, InjectMode::SendInput, result.is_ok());
    }
    match result {
        Ok(_queued) => InjectOutcome {
            ok: true,
            mode: InjectMode::SendInput,
            error_code: None,
            error_message: None,
            // IJ-01: this function answers 「SendInput 接受了吗」 ("did SendInput
            // accept it") and only that. The
            // Stage-1b reading is stamped on by `inject_text_with_probe`, which is
            // the one place that holds it — a second producer here would be a
            // second answer to 「焦点是什么样的」 ("what does the focus look like").
            focus_evidence: None,
        },
        Err(send_err) => InjectOutcome {
            ok: false,
            // Non-`cached` → the relay maps ok=false to status=failed, which is
            // right: the call failed, so we know it did not happen.
            mode: InjectMode::SendInput,
            error_code: Some(error_codes::INJECT_SENDINPUT_FAIL),
            error_message: Some(format!("sendinput call failed: {send_err}")),
            focus_evidence: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_accepted_send_into_a_verified_focus_is_a_delivery() {
        // The new definition of `injected`, asserted at the point that decides it.
        // The three pieces of evidence are NOT re-checked here — Stage 1 and Stage
        // 1b own two of them and this function owns the third — which is precisely
        // why the pipeline must never call this without having passed both.
        let store = AppLearningStore::new();
        let out = map_sendinput_outcome(Ok(12), None, &store);
        assert!(out.ok);
        assert_eq!(out.mode, InjectMode::SendInput);
        assert_eq!(out.error_code, None, "a clean success invents no error");
        assert_eq!(out.error_message, None);
    }

    #[test]
    fn a_hard_sendinput_error_is_a_failure_and_says_which_kind() {
        let store = AppLearningStore::new();
        let out = map_sendinput_outcome(Err(InjectError::AppRejected), None, &store);
        assert!(!out.ok);
        assert_eq!(out.mode, InjectMode::SendInput);
        assert_eq!(out.error_code, Some(error_codes::INJECT_SENDINPUT_FAIL));
        // The message must name the CALL, because that is all this code claims
        // now. 「读回来一个字没变」 ("read it back, not a single character had
        // changed") was the old meaning and it is gone.
        assert!(
            out.error_message.as_deref().unwrap().contains("call failed"),
            "the narrowed code must not be dressed up as a measurement of the target"
        );
    }

    // ── the reverse assertions: neither state may drift into the other ────────

    #[test]
    fn a_failed_call_is_never_reported_as_cached() {
        // `cached` promises 「可以补投」 ("it can be redelivered later") and the phone offers a resend on it. A call
        // that errored has nothing to re-deliver later that it does not have now,
        // and 0.2.21 shipped the opposite: every unreadable send became `cached`,
        // so the phone invited a resend for text that was already in the box.
        let store = AppLearningStore::new();
        for err in [
            InjectError::AppRejected,
            InjectError::Win32(5),
            InjectError::Win32Step("SetClipboardData", 0x8007_0006),
        ] {
            let label = format!("{err:?}");
            let out = map_sendinput_outcome(Err(err), None, &store);
            assert_ne!(out.mode, InjectMode::Cached, "{label} is not a non-delivery");
            assert!(!out.ok);
        }
    }

    #[test]
    fn a_successful_call_is_never_reported_as_failed_or_cached() {
        let store = AppLearningStore::new();
        let out = map_sendinput_outcome(Ok(1), None, &store);
        assert!(out.ok, "the narrowed claim is met, so it must be said");
        assert_ne!(out.mode, InjectMode::Cached);
        assert_ne!(out.mode, InjectMode::Clipboard);
        assert_eq!(out.error_code, None);
    }

    // ── per-app learning is fed by the call result, and only by that ──────────

    #[test]
    fn an_app_that_accepts_sendinput_stays_on_sendinput() {
        let store = AppLearningStore::new();
        map_sendinput_outcome(Ok(1), Some("cursor"), &store);
        assert_eq!(
            store.preferred_mode_for("cursor"),
            Some(InjectMode::SendInput)
        );
    }

    #[test]
    fn only_an_app_that_hard_rejects_sendinput_is_steered_to_the_clipboard() {
        // The narrowing shows up here too: an app we merely could not verify used
        // to be pushed onto the clipboard path — which takes over the user's
        // clipboard, presses Ctrl+V into their app, and is where the 0.2.1 heap
        // corruption lived. Only a real rejection earns that now.
        let store = AppLearningStore::new();
        map_sendinput_outcome(Err(InjectError::AppRejected), Some("game"), &store);
        assert_eq!(
            store.preferred_mode_for("game"),
            Some(InjectMode::Clipboard)
        );
    }
}

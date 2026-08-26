// Inject-routing tests for inject/text_dispatch.rs — the WIRING half.
// A CHILD MODULE of `text_dispatch` (declared via `#[path]` at the bottom of
// that file), because the subject under test is crate-private and the fakes
// must reach it. The filename is kept from the 2026-08-21 IME-route round even
// though the subject is now the whole route: renaming it would churn the
// `#[path]` and, more to the point, the file-size lint's test-file patterns
// (`_test.rs`, not `_tests.rs`) mean this content cannot move back into
// `pipeline_tests.rs` without dragging that file over the 800-line SRC cap.

use super::*;
use crate::error_codes;
use crate::inject::clipboard_outcome::map_routed_paste_outcome;
use crate::inject::clipboard_paste::PasteOutcome;
use crate::inject::sendinput::InjectError;

// ── the ROUTE, asserted through the composition (2026-08-21 / 2026-08-26) ─────
//
// The decision itself is `text_route`'s and is proven there. What only THIS file
// can prove is that the decision is CONNECTED — 「a function was written but
// nobody calls it」 is this repo's #1 historical bug class — and that each
// fallback goes where it says it goes.
mod route_wiring {
    use super::*;
    use std::cell::RefCell;

    fn ok_out(mode: InjectMode) -> InjectOutcome {
        InjectOutcome {
            ok: true,
            mode,
            error_code: None,
            error_message: None,
            focus_evidence: None,
        }
    }

    fn failed_paste() -> InjectOutcome {
        InjectOutcome {
            ok: false,
            mode: InjectMode::Clipboard,
            error_code: Some(error_codes::INJECT_CLIPBOARD_FAIL),
            error_message: Some("fake paste failure".into()),
            focus_evidence: None,
        }
    }

    fn failed_typing() -> InjectOutcome {
        InjectOutcome {
            ok: false,
            mode: InjectMode::SendInput,
            error_code: Some(error_codes::INJECT_SENDINPUT_FAIL),
            error_message: Some("fake sendinput failure".into()),
            focus_evidence: None,
        }
    }

    struct Driven {
        out: InjectOutcome,
        calls: Vec<&'static str>,
        paste_reason: Option<PasteReason>,
    }

    /// Drive `type_or_paste_with` with recording fakes.
    fn drive(
        text: &str,
        app_id: Option<&str>,
        store: &AppLearningStore,
        paste: InjectOutcome,
        typed: InjectOutcome,
    ) -> Driven {
        let calls: RefCell<Vec<&'static str>> = RefCell::new(Vec::new());
        let seen: RefCell<Option<PasteReason>> = RefCell::new(None);
        let out = type_or_paste_with(
            text,
            app_id,
            store,
            &|_t, _id, _s| {
                calls.borrow_mut().push("sendinput");
                typed.clone()
            },
            &|_t, _id, _s| {
                calls.borrow_mut().push("clipboard-fallback");
                ok_out(InjectMode::Clipboard)
            },
            &|_t, reason| {
                calls.borrow_mut().push("paste");
                *seen.borrow_mut() = Some(reason);
                paste.clone()
            },
        );
        Driven {
            out,
            calls: calls.into_inner(),
            paste_reason: seen.into_inner(),
        }
    }

    #[test]
    fn plain_english_into_an_ordinary_app_pastes_and_never_types() {
        // THE FLIP, asserted through the wiring rather than at the predicate.
        // This is the owner's 2026-08-26 report reduced to one assertion:
        // English into Cursor must not reach the typed runner.
        let store = AppLearningStore::new();
        let d = drive(
            "Let me know if that works for you.",
            Some("Cursor"),
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(d.calls, vec!["paste"], "no typing on the default path");
        assert!(d.out.ok);
        assert_eq!(d.out.mode, InjectMode::Clipboard);
        assert_eq!(d.paste_reason, Some(PasteReason::DefaultPath));
        // The default route says nothing about the app, so nothing is learned.
        assert_eq!(store.preferred_mode_for("Cursor"), None);
    }

    #[test]
    fn cjk_pastes_for_the_measured_reason_not_the_default_one() {
        // Same physical path, different rule — and the difference has to survive
        // all the way to the runner, because it is what the forensic line says.
        let store = AppLearningStore::new();
        let d = drive(
            "在里面也是等过山车，测试。",
            Some("weixin"),
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(d.calls, vec!["paste"]);
        assert_eq!(d.paste_reason, Some(PasteReason::ImeUnsafeText));
        assert_eq!(store.preferred_mode_for("weixin"), None);
    }

    #[test]
    fn a_console_target_types_and_that_is_the_only_thing_that_does() {
        let store = AppLearningStore::new();
        let d = drive(
            "git status",
            Some("WindowsTerminal"),
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(d.calls, vec!["sendinput"], "the documented exception");
        assert!(d.out.ok);
        assert_eq!(d.out.mode, InjectMode::SendInput);
    }

    #[test]
    fn a_failed_paste_falls_back_to_typing_with_a_named_note() {
        let store = AppLearningStore::new();
        let d = drive(
            "测试文本。",
            Some("weixin"),
            &store,
            failed_paste(),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(
            d.calls,
            vec!["paste", "sendinput"],
            "a dropped utterance would be worse than a possibly-mangled one"
        );
        assert!(d.out.ok);
        assert_eq!(d.out.mode, InjectMode::SendInput);
        let note = d.out.error_message.expect("the trade-off must be on the record");
        assert!(
            note.contains("clipboard route failed"),
            "the note names WHY typing ran after all: {note}"
        );
    }

    #[test]
    fn a_console_whose_typing_fails_falls_back_to_the_clipboard() {
        let store = AppLearningStore::new();
        let d = drive(
            "ls -la",
            Some("cmd"),
            &store,
            ok_out(InjectMode::Clipboard),
            failed_typing(),
        );
        assert_eq!(d.calls, vec!["sendinput", "clipboard-fallback"]);
        assert!(d.out.ok);
        assert_eq!(d.out.mode, InjectMode::Clipboard);
        assert!(d
            .out
            .error_message
            .expect("the fallback names the failure it followed")
            .contains("the SendInput call failed"));
    }

    #[test]
    fn a_learned_hard_rejection_takes_a_console_off_the_typed_path() {
        // The store's ONE remaining job, asserted through the composition —
        // `route_text` proves the rule, this proves the store is actually read.
        // Reverse control: the same call with a fresh store types instead.
        let store = AppLearningStore::new();
        store.record_outcome("cmd", InjectMode::SendInput, false);
        let d = drive(
            "ls -la",
            Some("cmd"),
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(d.calls, vec!["paste"]);
        assert_eq!(d.paste_reason, Some(PasteReason::TypingHardRejected));

        let fresh = AppLearningStore::new();
        let control = drive(
            "ls -la",
            Some("cmd"),
            &fresh,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(control.calls, vec!["sendinput"], "without the learned fact it types");
    }

    // ── the mapper: the no-learning half is structural, the truth half is here ──

    #[test]
    fn routed_mapper_reports_an_error_free_paste_as_injected_clipboard() {
        // No `AppLearningStore` parameter EXISTS on this mapper — the no-learning
        // guarantee is the signature, not a branch (clipboard_outcome.rs).
        let out = map_routed_paste_outcome(
            Ok(PasteOutcome {
                confirmed: false,
                ..Default::default()
            }),
            PasteReason::DefaultPath,
        );
        assert!(out.ok, "receipt is evidence, not a gate (design §3, 2026-07-30)");
        assert_eq!(out.mode, InjectMode::Clipboard);
        assert_eq!(out.error_code, None);
    }

    #[test]
    fn routed_mapper_reports_a_hard_paste_error_as_clipboard_fail() {
        let out = map_routed_paste_outcome(Err(InjectError::Win32(5)), PasteReason::ImeUnsafeText);
        assert!(!out.ok);
        assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
        let msg = out.error_message.expect("a hard error names itself");
        assert!(msg.contains("clipboard route failed"));
        assert!(
            msg.contains("ime-safe content route"),
            "the failure must still say WHICH rule chose this road: {msg}"
        );
    }
}

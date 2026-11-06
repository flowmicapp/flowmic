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
        /// The text each runner was handed, in call order (D-MKT-5).
        texts: Vec<String>,
    }

    /// Drive `type_or_paste_routed` with recording fakes, with the Windows
    /// console line-break rule on (what production passes on Windows).
    fn drive(
        text: &str,
        app_id: Option<&str>,
        store: &AppLearningStore,
        paste: InjectOutcome,
        typed: InjectOutcome,
    ) -> Driven {
        drive_with(text, app_id, true, store, paste, typed)
    }

    fn drive_with(
        text: &str,
        app_id: Option<&str>,
        console_line_breaks_submit: bool,
        store: &AppLearningStore,
        paste: InjectOutcome,
        typed: InjectOutcome,
    ) -> Driven {
        let calls: RefCell<Vec<&'static str>> = RefCell::new(Vec::new());
        let seen: RefCell<Option<PasteReason>> = RefCell::new(None);
        let texts: RefCell<Vec<String>> = RefCell::new(Vec::new());
        // `type_or_paste_routed`, not `type_or_paste_with`: only the routed seam
        // takes the D-MKT-5 flag. The paste fake below reports
        // `act_completed = false`, the rule `type_or_paste_with` applies too.
        let out = type_or_paste_routed(
            text,
            app_id,
            console_line_breaks_submit,
            store,
            &|t, _id, _s| {
                calls.borrow_mut().push("sendinput");
                texts.borrow_mut().push(t.to_string());
                typed.clone()
            },
            &|t, _id, _s| {
                calls.borrow_mut().push("clipboard-fallback");
                texts.borrow_mut().push(t.to_string());
                ok_out(InjectMode::Clipboard)
            },
            &|t, reason| {
                calls.borrow_mut().push("paste");
                texts.borrow_mut().push(t.to_string());
                *seen.borrow_mut() = Some(reason);
                (paste.clone(), false)
            },
        );
        Driven {
            out,
            calls: calls.into_inner(),
            paste_reason: seen.into_inner(),
            texts: texts.into_inner(),
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

    // ── D-MKT-5: no line break reaches a console as an Enter ─────────────────
    //
    // Measured 2026-11-05: this exact text, typed into cmd, ran its first
    // paragraph as a command while both ends said ✓. Every road into a console
    // must now carry it on one line, and say so in the forensic note.

    const REPRO: &str = "V01 block one. First paragraph: the export job runs every night at two \
                         and writes a CSV to the shared folder.\nSecond paragraph: please add a \
                         check that stops the job when the folder is missing, and report it in \
                         the log.";

    fn assert_flattened_note(out: &InjectOutcome) {
        let note = out.error_message.as_deref().expect("the flattening must be on the record");
        assert!(note.contains("console line breaks flattened: 1 line-break run(s)"), "{note}");
    }

    #[test]
    fn a_multi_paragraph_text_reaches_a_typed_console_on_one_line() {
        let store = AppLearningStore::new();
        let d = drive(REPRO, Some("cmd"), &store, ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!(d.calls, vec!["sendinput"], "still the typed console route");
        assert_eq!(d.texts, vec![REPRO.replace('\n', " ")], "no line break reaches the keyboard");
        assert!(d.out.ok);
        assert_flattened_note(&d.out);
    }

    #[test]
    fn every_road_into_a_console_carries_the_flattened_text() {
        // Paste route (CJK into a terminal), learned hard rejection, and the
        // clipboard fallback after a failed typed attempt: none may carry a break.
        let store = AppLearningStore::new();
        let cjk = drive("提交代码。\n然后推送。", Some("WindowsTerminal"), &store,
            ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!((cjk.calls.clone(), cjk.paste_reason), (vec!["paste"], Some(PasteReason::ImeUnsafeText)));
        assert_eq!(cjk.texts, vec!["提交代码。 然后推送。".to_string()]);
        assert_flattened_note(&cjk.out);

        let fallback = drive(REPRO, Some("pwsh"), &store, ok_out(InjectMode::Clipboard), failed_typing());
        assert_eq!(fallback.calls, vec!["sendinput", "clipboard-fallback"]);
        assert!(fallback.texts.iter().all(|t| !t.contains(['\r', '\n'])), "{:?}", fallback.texts);
        assert_flattened_note(&fallback.out);

        let learned = AppLearningStore::new();
        learned.record_outcome("cmd", InjectMode::SendInput, false);
        let rejected = drive("dir\r\ncls", Some("cmd"), &learned,
            ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!(rejected.paste_reason, Some(PasteReason::TypingHardRejected));
        assert_eq!(rejected.texts, vec!["dir cls".to_string()]);
    }

    #[test]
    fn the_console_rule_touches_nothing_else() {
        let store = AppLearningStore::new();
        // Single-line text into cmd: identical text, no note (10/10 exact before).
        let single = drive("git status", Some("cmd"), &store, ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!(single.texts, vec!["git status".to_string()]);
        assert_eq!(single.out.error_message, None);
        // Not a console: the paste keeps its line breaks.
        let editor = drive(REPRO, Some("Code"), &store, ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!(editor.texts, vec![REPRO.to_string()]);
        // The non-Windows arm (`type_or_paste` passes false off Windows): unchanged.
        let off = drive_with(REPRO, Some("kitty"), false, &store, ok_out(InjectMode::Clipboard), ok_out(InjectMode::SendInput));
        assert_eq!(off.texts, vec![REPRO.to_string()]);
    }

    // ── the mapper: the no-learning half is structural, the truth half is here ──

    #[test]
    fn routed_mapper_reports_an_error_free_paste_as_injected_clipboard() {
        // No `AppLearningStore` parameter EXISTS on this mapper — the no-learning
        // guarantee is the signature, not a branch (clipboard_outcome.rs).
        // `confirmed: true` since D-MKT-8 (2026-11-05): on Windows a paste nobody
        // fetched is no longer error-free (paste_verdict_tests.rs pins that).
        let out = map_routed_paste_outcome(
            Ok(PasteOutcome {
                confirmed: true,
                ..Default::default()
            }),
            PasteReason::DefaultPath,
        );
        assert!(out.ok, "a served receipt is not landing evidence, and not a refusal");
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

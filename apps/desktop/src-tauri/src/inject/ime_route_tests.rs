// IME-safe content-routing tests for inject/pipeline.rs — the WIRING half.
// A CHILD MODULE OF `pipeline` (declared beside `mod tests` via `#[path]`), not
// of `mod.rs`: the subject under test, `type_or_paste_with`, is deliberately
// private to the pipeline, and only a child module can drive it. Split from
// pipeline_tests.rs because that file's name does not match the file-size
// lint's test-file patterns (`_test.rs`, not `_tests.rs`), so it is held to the
// 800-line SRC cap and these tests pushed it over.

use super::*;
// ── IME-safe content routing (2026-08-21) — the WIRING, asserted headless ─────
//
// The decision itself is text_route.rs's and is proven there. What only THIS
// file can prove is the composition (「a function was written but nobody calls
// it」 is this repo's #1 historical bug class): CJK text reaches the routed
// paste runner and NEVER the typing runner; ASCII text keeps today's path
// byte-for-byte; a routed paste that fails still falls back to typing instead
// of dropping the utterance. Root cause and design:
// docs/strategy/2026-08-21-ime-safe-inject-routing-design.md.
mod ime_safe_content_routing {
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

    /// Drive `type_or_paste_with` with recording fakes; returns (outcome, calls).
    fn drive(
        text: &str,
        store: &AppLearningStore,
        routed: InjectOutcome,
        typed: InjectOutcome,
    ) -> (InjectOutcome, Vec<&'static str>) {
        let calls: RefCell<Vec<&'static str>> = RefCell::new(Vec::new());
        let out = type_or_paste_with(
            text,
            Some("weixin"),
            store,
            &|_t, _id, _s| {
                calls.borrow_mut().push("sendinput");
                typed.clone()
            },
            &|_t, _id, _s, _skipped| {
                calls.borrow_mut().push("clipboard");
                ok_out(InjectMode::Clipboard)
            },
            &|_t| {
                calls.borrow_mut().push("routed-paste");
                routed.clone()
            },
        );
        (out, calls.into_inner())
    }

    #[test]
    fn cjk_text_takes_the_routed_paste_and_never_types() {
        let store = AppLearningStore::new();
        let (out, calls) = drive(
            "在里面也是等过山车，测试。",
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(calls, vec!["routed-paste"], "no typing, no learned-path paste");
        assert!(out.ok);
        assert_eq!(out.mode, InjectMode::Clipboard, "mode reports the truth: paste");
        // The route says nothing about the APP: the store must stay empty, or
        // this app's pure-ASCII injections would flip onto the paste path too.
        assert_eq!(store.preferred_mode_for("weixin"), None);
    }

    #[test]
    fn ascii_text_keeps_the_typing_path_untouched() {
        let store = AppLearningStore::new();
        let (out, calls) = drive(
            "hello, world!",
            &store,
            ok_out(InjectMode::Clipboard),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(calls, vec!["sendinput"], "ASCII must not pay the clipboard cost");
        assert!(out.ok);
        assert_eq!(out.mode, InjectMode::SendInput);
    }

    #[test]
    fn a_failed_routed_paste_falls_back_to_typing_with_a_named_note() {
        let store = AppLearningStore::new();
        let (out, calls) = drive(
            "测试文本。",
            &store,
            failed_paste(),
            ok_out(InjectMode::SendInput),
        );
        assert_eq!(
            calls,
            vec!["routed-paste", "sendinput"],
            "a dropped utterance would be worse than a possibly-mangled one"
        );
        assert!(out.ok);
        assert_eq!(out.mode, InjectMode::SendInput);
        let note = out.error_message.expect("the trade-off must be on the record");
        assert!(
            note.contains("ime-safe clipboard route failed"),
            "the note names WHY typing ran after all: {note}"
        );
    }

    #[test]
    fn ascii_still_honours_a_learned_clipboard_preference() {
        // The pre-existing per-app learning path must survive the seam refactor
        // verbatim: an app that hard-rejected SendInput pastes first even for
        // ASCII, with the skipped flag saying why.
        let store = AppLearningStore::new();
        store.record_outcome("weixin", InjectMode::SendInput, false);
        let skipped_seen: RefCell<Option<bool>> = RefCell::new(None);
        let out = type_or_paste_with(
            "plain ascii",
            Some("weixin"),
            &store,
            &|_t, _id, _s| panic!("typing must not run for a clipboard-learned app"),
            &|_t, _id, _s, skipped| {
                *skipped_seen.borrow_mut() = Some(skipped);
                ok_out(InjectMode::Clipboard)
            },
            &|_t| panic!("ASCII must not take the content route"),
        );
        assert!(out.ok);
        assert_eq!(*skipped_seen.borrow(), Some(true));
    }

    // ── the mapper: the no-learning half is structural, the truth half is here ──

    #[test]
    fn routed_mapper_reports_an_error_free_paste_as_injected_clipboard() {
        // No `AppLearningStore` parameter EXISTS on this mapper — the no-learning
        // guarantee is the signature, not a branch (clipboard_outcome.rs).
        let out = map_ime_routed_clipboard_outcome(Ok(PasteOutcome { confirmed: false }));
        assert!(out.ok, "receipt is evidence, not a gate (design §3, 2026-07-30)");
        assert_eq!(out.mode, InjectMode::Clipboard);
        assert_eq!(out.error_code, None);
    }

    #[test]
    fn routed_mapper_reports_a_hard_paste_error_as_clipboard_fail() {
        let out = map_ime_routed_clipboard_outcome(Err(InjectError::Win32(5)));
        assert!(!out.ok);
        assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
        assert!(out
            .error_message
            .expect("a hard error names itself")
            .contains("ime-safe clipboard route failed"));
    }
}


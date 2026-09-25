// SPEC-REF: Linux L-4 delivery truth and platform boundary regression tests.
use super::*;

#[test]
fn linux_contract_uncertainty_survives_restore_and_blocks_both_fallbacks() {
    let client = ClipboardFallbackClient::with_fakes(
        || Ok(ClipboardSnapshot::default()),
        |_| Err(InjectError::Native("restore deliberately failed".into())),
        |_| Err(InjectError::SubmissionUncertain("XSync result unavailable".into())),
    );
    let result = client.paste_text("never duplicate");
    assert!(matches!(&result, Err(InjectError::SubmissionUncertain(_))));
    let mapped = clipboard_outcome::map_routed_paste_outcome(result, text_route::PasteReason::DefaultPath);
    assert!(!mapped.ok);
    assert_eq!(mapped.error_code, Some(crate::error_codes::INJECT_SUBMISSION_UNCERTAIN));
    assert_eq!(mapped.mode, InjectMode::Clipboard);
    let store = AppLearningStore::new();
    let out = text_dispatch::type_or_paste_with("plain", None, &store,
        &|_,_,_| panic!("uncertain paste must never type again"),
        &|_,_,_| panic!("unused clipboard fallback"), &|_,_| mapped.clone());
    assert_eq!(out.error_code, mapped.error_code);
    let out = text_dispatch::type_or_paste_with("plain", Some("windowsterminal"), &store,
        &|_,_,_| mapped.clone(), &|_,_,_| panic!("uncertain type must never paste again"),
        &|_,_| panic!("console must type first"));
    assert_eq!(out.error_code, mapped.error_code);
    let out = text_dispatch::type_or_paste_with("plain", Some("windowsterminal"), &store,
        &|_,_,_| InjectOutcome { error_code: Some(crate::error_codes::INJECT_SENDINPUT_FAIL), ..mapped.clone() },
        &|_,_,_| mapped.clone(), &|_,_| panic!("console types first"));
    assert_eq!(out.error_code, mapped.error_code);
    assert!(!out.error_message.unwrap().contains("failed too"));
}

#[test]
fn linux_contract_images_are_unsupported_before_focus_or_clipboard() {
    let out = inject_image("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=", "image/png", None,
        |_| panic!("unsupported image must not activate a window"));
    assert_eq!(out.error_code, Some(crate::error_codes::INJECT_IMAGE_UNSUPPORTED));
    assert_ne!(out.error_code, Some(crate::error_codes::INJECT_SELF_WINDOW_NO_INPUT),
        "the picture path must not start answering with the text ruling's code");
    assert!(!out.ok);
}

#[test]
fn linux_contract_keysyms_and_receipt_are_platform_facts() {
    for (kind, symbol) in [("backspace",0xFF08),("tab",0xFF09),("enter",0xFF0D),("space",0x20),("undo",0x7A)] {
        assert_eq!(key_sequence_for(kind).unwrap()[0].vk, symbol, "{kind}");
    }
    let clear = key_sequence_for("clear").unwrap();
    assert_eq!(clear[0].vk, 0x61);
    assert_eq!(clear[0].modifiers, vec![0xFFE3]);
    assert_eq!(clear[1].vk, 0xFFFF);
    assert_eq!(key_sequence_for("undo").unwrap()[0].modifiers, vec![0xFFE3]);
    let phrase = clipboard_outcome::evidence_phrase(false, readback::LandingEvidence::Unavailable, 2345);
    assert!(phrase.contains("n/a on Linux"));
    assert!(phrase.contains("held=2345ms"));
    assert!(!phrase.contains("nobody fetched"));
    assert!(clipboard_outcome::receipt_phrase(true).contains("impossible"));
}

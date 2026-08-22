// The IMAGE-outcome test cluster, moved VERBATIM out of pipeline_tests.rs for
// the 800-line src cap after the F-4 additions put that file at 830. Child
// module of pipeline_tests (`use super::*`), so every fake and helper stays
// reachable unrenamed; nothing here changed but the location.
use super::*;

// 2026-07-30 (owner:「对于图片……没必要强求，只需要我们的确做了这个动作」 ("for
// pictures ... there is no need to force success, we only need to have genuinely
// performed this action"), design §3):
// the WM_RENDERFORMAT receipt is no longer the ok/fail gate. What an image
// `injected` claims is 「已送达电脑并执行了粘贴动作，文件已存进数据目录」 ("delivered
// to the PC and the paste action was performed, the file has already been saved
// into the data directory"), all three
// of which we know. Whether the target app accepts an image paste is the target's
// business, and 0.2.x spent three releases reporting 「未注入」 ("not injected") for pictures that
// were sitting in the target's composer.
#[test]
fn an_unconfirmed_image_paste_is_a_performed_delivery_not_a_failure() {
    for requested_format in [Some(2u32), None] {
        let out = map_image_outcome(Ok(ConfirmOutcome {
            confirmed: false,
            requested_format,
            // A CLEAN teardown — the offer was NOT dropped. owner's ruling: an
            // unconfirmed-but-cleanly-withdrawn paste is still a performed delivery.
            dropped_unrendered: false,
            ..Default::default()
        }));
        assert!(out.ok, "the paste WAS performed; that is what we claim");
        assert_eq!(out.mode, InjectMode::Clipboard);
        assert_eq!(
            out.error_code, None,
            "an outcome we call a delivery must not also carry a failure code"
        );
    }
}

#[test]
fn confirmed_image_paste_is_injected_with_no_invented_error() {
    let out = map_image_outcome(Ok(ConfirmOutcome {
        confirmed: true,
        requested_format: Some(8),
        dropped_unrendered: false,
            ..Default::default()
    }));
    assert!(out.ok, "a confirmed consumption is a real delivery");
    assert_eq!(out.mode, InjectMode::Clipboard);
    assert_eq!(out.error_code, None, "an image paste has no SendInput stage to report");
}

#[test]
fn image_clipboard_error_is_failed() {
    // The reverse assertion for the de-gating above. De-gating the RECEIPT must not
    // de-gate our own Win32 errors: `Err` means a step of ours failed (or the
    // user's clipboard could not be put back), which knowably did not happen.
    let out = map_image_outcome(Err(InjectError::AppRejected));
    assert!(!out.ok);
    assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
    assert_ne!(out.mode, InjectMode::Cached, "an error is failed, not re-deliverable");
}

// ── F-4 (2026-08-03 M5): image → a target that cannot take it, and our own RV-39
// teardown then DROPS the announced formats unrendered. Both ends used to say
// 「成功」. The withdrawal-drop is OUR mechanism failing, so when the target ALSO
// consumed nothing the paste did not complete and it is FAILED — the phone must be
// able to learn the picture did not land. (The picture itself is still kept on this
// PC's timeline by RV-93; this only makes the delivery VERDICT honest.)
#[test]
fn an_image_dropped_unrendered_with_no_consumption_is_failed_not_a_delivery() {
    let out = map_image_outcome(Ok(ConfirmOutcome {
        confirmed: false,
        requested_format: None,
        dropped_unrendered: true,
            ..Default::default()
    }));
    assert!(!out.ok, "the offer was dropped and nothing consumed it — not a delivery");
    assert_eq!(out.error_code, Some(error_codes::INJECT_CLIPBOARD_FAIL));
    assert_ne!(
        out.mode,
        InjectMode::Cached,
        "non-cached → the relay maps ok=false to status=failed, which is the truth here"
    );
}

// POSITIVE CONTROL for the branch above: a target that DID read a format has the
// picture, so a dropped SIBLING format is moot. `confirmed` outranks the drop, and
// without this control the failure branch could be keying on the drop ALONE.
#[test]
fn a_confirmed_image_survives_a_dropped_sibling_format() {
    let out = map_image_outcome(Ok(ConfirmOutcome {
        confirmed: true,
        requested_format: Some(49507), // PNG — the target read it
        dropped_unrendered: true,      // a sibling format (e.g. CF_BITMAP) was dropped
        ..Default::default()
    }));
    assert!(out.ok, "the target read a format; the picture landed");
    assert_eq!(out.error_code, None, "a real delivery carries no failure code");
}

// POSITIVE CONTROL #2 (owner's ruling stays intact): the new failure keys on the
// WITHDRAWAL dropping the offer, NEVER on the receipt alone. An unconfirmed paste
// with a CLEAN teardown is still a performed delivery — this pins that the two
// signals are combined with AND, not either-or.
#[test]
fn an_unconfirmed_image_with_a_clean_teardown_is_still_a_delivery() {
    let out = map_image_outcome(Ok(ConfirmOutcome {
        confirmed: false,
        requested_format: Some(2),
        dropped_unrendered: false, // the withdrawal took — nothing was dropped
        ..Default::default()
    }));
    assert!(out.ok, "owner de-gated the receipt; a clean unconfirmed paste is a delivery");
    assert_eq!(out.error_code, None);
}

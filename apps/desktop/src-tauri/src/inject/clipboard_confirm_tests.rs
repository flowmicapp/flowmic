// Tests for the `win` module of inject/clipboard_confirm.rs, split out under
// `#[path]` for the 800-line src cap (the same shape inject/pipeline_tests.rs and
// socket/client_tests.rs use). Nothing here changed in the move.
//
// They stay a CHILD of `win` rather than moving to the file's top level because
// everything they prove — `withdraw_announcement`, `mark_render_all`, `Pending`,
// `announced` — is private to that module, and widening six items' visibility so
// the tests can sit one level higher would be paying in production API for a test
// layout choice.

use super::*;

#[test]
fn cf_bitmap_is_announced_alongside_a_dib_but_never_duplicated() {
    let table = vec![(CF_DIB_U32, vec![0u8; 44])];
    assert_eq!(announced(&table), vec![CF_DIB_U32, CF_BITMAP_U32]);
    // A text table announces exactly itself — no image formats invented.
    let text = vec![(CF_UNICODETEXT_U32, vec![0u8; 2])];
    assert_eq!(announced(&text), vec![CF_UNICODETEXT_U32]);
    // Already present → not added twice.
    let both = vec![(CF_DIB_U32, vec![]), (CF_BITMAP_U32, vec![])];
    assert_eq!(announced(&both), vec![CF_DIB_U32, CF_BITMAP_U32]);
}

#[test]
fn an_empty_format_table_is_never_confirmed() {
    let out = paste_formats(&[], Duration::from_millis(1), None).expect("no-op");
    assert!(!out.confirmed, "nothing armed can never be consumed");
    assert_eq!(out.requested_format, None);
}

// ── RV-39: withdrawing the announcement before the owner window dies ─────────

/// Drive `withdraw_announcement` with fakes, returning the verdict and the calls
/// it actually made — the ORDER is half of what is being proved.
fn run_withdrawal(
    owned: bool,
    open: Result<(), u32>,
    empty: Result<(), u32>,
    close: Result<(), u32>,
) -> (Withdrawal, Vec<&'static str>) {
    let log = std::cell::RefCell::new(Vec::<&'static str>::new());
    let verdict = withdraw_announcement(&WithdrawOps {
        owned_by_us: &|| {
            log.borrow_mut().push("owner?");
            owned
        },
        open: &|| {
            log.borrow_mut().push("open");
            open
        },
        empty: &|| {
            log.borrow_mut().push("empty");
            empty
        },
        close: &|| {
            log.borrow_mut().push("close");
            close
        },
    });
    (verdict, log.into_inner())
}

/// The one branch that MUST hold whatever else changes: if the clipboard belongs
/// to another window, we touch nothing. Getting this wrong does not mis-report
/// anything — it destroys the user's own clipboard content.
#[test]
fn a_clipboard_owned_by_someone_else_is_never_emptied() {
    let (verdict, calls) = run_withdrawal(false, Ok(()), Ok(()), Ok(()));
    assert_eq!(verdict, Withdrawal::NotOurs);
    assert_eq!(calls, vec!["owner?"], "not ours ⇒ not one clipboard call");
}

#[test]
fn our_own_announcement_is_opened_emptied_and_closed_in_that_order() {
    let (verdict, calls) = run_withdrawal(true, Ok(()), Ok(()), Ok(()));
    assert_eq!(verdict, Withdrawal::Withdrawn);
    assert_eq!(calls, vec!["owner?", "open", "empty", "close"]);
}

#[test]
fn a_withdrawal_that_cannot_open_the_clipboard_says_which_step_failed() {
    // 5 = ERROR_ACCESS_DENIED, what another app holding the clipboard gives us.
    // Non-fatal by design: the OS still drops the formats inside DestroyWindow,
    // and `teardown_owner` records that that is what happened.
    let (verdict, calls) = run_withdrawal(true, Err(5), Ok(()), Ok(()));
    assert_eq!(verdict, Withdrawal::Failed("OpenClipboard", 5));
    assert_eq!(calls, vec!["owner?", "open"], "a failed open empties nothing");
}

#[test]
fn a_failed_empty_still_closes_the_clipboard() {
    // A clipboard left open wedges every app on the machine — including our own
    // next paste and the restore that runs a millisecond later.
    let (verdict, calls) = run_withdrawal(true, Ok(()), Err(6), Ok(()));
    assert_eq!(verdict, Withdrawal::Failed("EmptyClipboard", 6));
    assert!(calls.contains(&"close"), "close runs even when empty failed: {calls:?}");
}

#[test]
fn a_failed_close_is_reported_rather_than_swallowed() {
    let (verdict, _) = run_withdrawal(true, Ok(()), Ok(()), Err(7));
    assert_eq!(verdict, Withdrawal::Failed("CloseClipboard", 7));
}

/// The watchdog for the fix itself: if `WM_RENDERALLFORMATS` ever arrives it means
/// the withdrawal did not take, and that fact has to survive to the forensic line
/// instead of vanishing into `DefWindowProcW` — which is exactly what RV-39 was.
#[test]
fn a_render_all_request_is_recorded_not_swallowed() {
    let mut slot = Some(Pending {
        formats: vec![(CF_DIB_U32, vec![0u8; 4])],
        requested: None,
        rendered: false,
        render_all_requested: false,
    });
    assert!(mark_render_all(&mut slot), "an armed announcement records it");
    assert!(slot.as_ref().expect("armed").render_all_requested);
    // Disarmed slot: nothing to record, and no panic on the way past.
    let mut none: Option<Pending> = None;
    assert!(!mark_render_all(&mut none));
}

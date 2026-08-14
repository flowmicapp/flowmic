// The RV-39 withdrawal unit, moved VERBATIM out of `clipboard_confirm.rs`'s
// `mod win` for the 800-line src cap (the F-4 change pushed it to 833; same
// split shape as that file's own tests include). Pure logic over injected
// ops — which is exactly why `clipboard_confirm_tests.rs` can drive it with
// fakes. Only visibilities changed: items are `pub(crate)` so the including
// `mod win` (and its child test module) can keep using them unrenamed.

/// What the pre-teardown withdrawal of a delayed announcement did. There is
/// no 「nothing happened」 variant on purpose: every outcome is a fact the log
/// can state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Withdrawal {
    /// Another window owns the clipboard, so there is nothing of ours to hand
    /// back — and emptying THEIRS would destroy content that was never ours.
    NotOurs,
    /// We owned it and gave the offer back explicitly.
    Withdrawn,
    /// We owned it and could not give it back (which step, which code). The OS
    /// then drops the announcement inside `DestroyWindow`, which is the
    /// pre-RV-39 behaviour — now with a name and a line.
    Failed(&'static str, u32),
}

/// The ownership question plus the three Win32 calls the withdrawal needs,
/// behind a seam.
///
/// The rest of this module talks to Win32 directly and that is not changing
/// for one function's sake. This step gets a seam because it is the one step
/// whose wrong branch is 「EmptyClipboard on a clipboard that belongs to
/// somebody else」 — the user's own content destroyed by us — so the ordering
/// and the never-touch-theirs rule get to be unit facts instead of
/// real-machine hopes.
pub(crate) struct WithdrawOps<'a> {
    pub(crate) owned_by_us: &'a dyn Fn() -> bool,
    pub(crate) open: &'a dyn Fn() -> Result<(), u32>,
    pub(crate) empty: &'a dyn Fn() -> Result<(), u32>,
    pub(crate) close: &'a dyn Fn() -> Result<(), u32>,
}

pub(crate) fn withdraw_announcement(ops: &WithdrawOps) -> Withdrawal {
    if !(ops.owned_by_us)() {
        return Withdrawal::NotOurs;
    }
    if let Err(code) = (ops.open)() {
        return Withdrawal::Failed("OpenClipboard", code);
    }
    // EmptyClipboard frees the delayed (NULL-handle) entries, so past this
    // point the promise is over because we SAID so rather than because a
    // window died. Close unconditionally: a clipboard left open wedges every
    // app on the machine, which is worse than whatever made Empty fail.
    let emptied = (ops.empty)();
    let closed = (ops.close)();
    match (emptied, closed) {
        (Err(code), _) => Withdrawal::Failed("EmptyClipboard", code),
        (Ok(()), Err(code)) => Withdrawal::Failed("CloseClipboard", code),
        (Ok(()), Ok(())) => Withdrawal::Withdrawn,
    }
}

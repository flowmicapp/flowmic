// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (injection pipeline)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Split out of `pipeline.rs` for the repo's 800-line cap, the same way
// `sendinput_outcome.rs` was. The comment below is the entire value of this
// file — it is the reasoning behind a crash fix, and trimming it to save lines
// would be trading the finding for the fix (doc 13 §8).

/// The process-wide INJECTION GATE — one injection at a time, always.
///
/// v0.2.1, and it is the crash fix. WER recorded FlowMic.exe 0.2.0.0 dying twice
/// on 2026-07-28 with `0xc0000374` (STATUS_HEAP_CORRUPTION) in ntdll, same
/// StackHash both times, immediately after a re-inject from the phone's history
/// menu. Two overlapping injections is the condition that makes that reachable:
///
///   · `clipboard_confirm::win::PENDING` is a single process-wide slot holding
///     the format table the WM_RENDERFORMAT handler serves. A second paste
///     overwrites it while the first is still armed, so one run's window can be
///     asked to render another run's data — and the HGLOBAL ownership handoff to
///     `SetClipboardData` stops being one-to-one. That is a heap bug, and
///     heap bugs surface exactly where this one did;
///   · `clipboard_paste` saves the user's clipboard, replaces it, and restores
///     it. Interleave two of those and the "restore" of one run puts back what
///     the other run had just installed;
///   · (a third reason existed and is gone: read-back compared a before/after pair
///     around ONE keystroke burst, so a concurrent injection between the samples
///     made the verdict a coin flip. That module was deleted 2026-07-30 — the two
///     clipboard reasons above are on their own sufficient and unchanged.)
///
/// Sources of overlap exist and none is exotic: GA-28 keeps BOTH channel sockets
/// resident, each with its own callback thread, and a re-inject starts whenever the user
/// taps it — including while an utterance is still resolving. As of 0.2.27 that tap no
/// longer arrives as a wire `history:inject`; it runs the pipeline DIRECTLY from a
/// Tauri command thread (`DesktopSocket::reinject_locally`), which removes a round
/// trip and therefore makes the overlap window *easier* to hit, not harder.
/// Serialising here (rather than at each call site) means no future caller can
/// reintroduce the race by not knowing about it — and the local re-inject is precisely such
/// a caller: it inherits the gate without having to know it exists.
///
/// Held across the whole pipeline including the confirmation waits. That is the
/// point: an injection is a physical act on one focused window, and doing two at
/// once was never meaningful — the previous code just never said so.
pub fn inject_gate() -> &'static std::sync::Mutex<()> {
    static GATE: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| std::sync::Mutex::new(()))
}

/// Take the gate, tolerating poison. A previous panic must not turn the gate
/// into a permanent injection outage — 「a crash is not a message」 applies to self-inflicted
/// lockouts too.
pub fn lock_inject_gate() -> std::sync::MutexGuard<'static, ()> {
    inject_gate().lock().unwrap_or_else(|p| p.into_inner())
}


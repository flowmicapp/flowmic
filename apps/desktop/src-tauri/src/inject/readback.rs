// SPEC-REF:
//   docs/strategy/2026-08-21-ime-safe-inject-routing-design.md §3 (the safety net
//     and evidence layer — promoted here from "evidence" to "the thing that lets
//     us stop holding the user's clipboard")
//   master-plan §4 / CLAUDE.md red line R11: a status word must be able to answer
//     "on what grounds do you say that"
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// READ-BACK: does the focused element now END WITH the text we just delivered?
//
// ── WHY THIS EXISTS (measured, 2026-08-22, dev-pc-a) ──────────────────
// The clipboard paste used to treat `WM_RENDERFORMAT` — "somebody asked for our
// format" — as "the target consumed our text", break its wait the instant that
// arrived, and put the user's own clipboard back ~20 ms later. Measured against a
// real Chromium target whose renderer was deliberately blocked for 1.2 s:
//
//   t+417ms  WM_RENDERFORMAT #1        (arrives at the SAME 13ms even though the
//                                       renderer is blocked ⇒ it is NOT the paste)
//   t+435ms  user clipboard restored
//   t+2006ms TARGET PASTED: the user's OLD clipboard text
//
// So the receipt cannot answer the question it was being asked. Read-back can:
// the same run, holding the payload and polling this probe, confirmed at
// t+1318ms and the target pasted the injected text.
//
// ── THE ONE RULE THIS MODULE MUST NEVER BREAK ───────────────────────────────
// 🔴 IT MAY ONLY EVER SAY YES. `Unavailable` / `NotObserved` mean "this
// instrument could not see it", NEVER "it did not land". Measured on real
// targets the same day: Notepad answers with the full buffer, a Chromium
// <textarea> answers with its real value, Cursor's chat box answers, and Devin's
// contenteditable answers with a one-space placeholder that will never match
// anything. A probe that is blind on one target out of four cannot be allowed to
// call that target a failure — that is the shape
// `docs/decisions/2026-07-30-a11y-tree-cannot-back-an-injection-refusal.md`
// already ruled on, and the shape `msaa_focus.rs` (IJ-05) is built around.
//
// ── WHY A BASELINE ──────────────────────────────────────────────────────────
// "The box ends with our text" is NOT evidence on its own: a re-injection, or a
// user who typed the same words, satisfies it without anything having landed. So
// the value is read ONCE BEFORE the keystroke and the verdict requires the value
// to have CHANGED as well. A probe that can confirm without anything happening is
// the render receipt all over again, one layer up.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
// P2 (2026-09-02): no longer Windows-only — `BoundedReuseWorker::call_bounded`
// is portable (its tests, below, use it directly with a fake `work()`).
//
// ⚠️ CORRECTED IN PLACE (2026-09-02, B2-Z): "no longer Windows-only" was true
// of the CODE but not of the BUILD — the Mac-side run (commit 7d9a775c)
// reported `cargo clippy --lib --features app -- -D warnings` flagging
// `BoundedReuseWorker::{spawn, call_bounded}` dead code on macOS. The struct
// was never `#[cfg]`-gated, but its only PRODUCTION caller (`uia_reader`,
// below) is Windows-only, so a plain (non-test) macOS
// build never reaches it. See the struct definition below for the fix
// (`#[cfg(any(test, target_os = "windows"))]`), which keeps it out of that
// build while keeping it in every platform's test build — the property this
// comment already promised.
//
// NOT CONFIRMED ON THE MAC (2026-09-02, B2-AA) — reasoned from source only, no
// mac compiler available here, same limit the previous note already flagged.
// Every consumer of `Duration` below (the `POLL_INTERVAL` const, the
// `BoundedReuseWorker` impl, `uia_reader`, and the `#[cfg(test)]` module) sits
// behind a Windows-only or test-or-Windows gate, so a plain non-test macOS
// build reaches none of them. The import is given the widest of those two
// gates so it stops being the one unconditionally-compiled leftover on a
// platform that needs none of it — that mismatch is the `unused import`
// clippy hit the mac run reported at commit 7d9a775c. This still OWES an
// actual `cargo clippy --lib --features app -- -D warnings` run on the Mac.
#[cfg(any(test, target_os = "windows"))]
use std::time::Duration;

/// How long one cross-process read may take before we abandon it. UIA has no
/// timeout parameter anywhere, exactly like the oleacc walk in `msaa_focus.rs`,
/// so the bound is "a thread we are willing to abandon" and nothing else.
///
/// 150 ms, not `msaa_focus::MSAA_BUDGET_MS` (120): this walk is THREE
/// cross-process calls (GetFocusedElement → GetCurrentPattern → CurrentValue)
/// where that one is a focus walk. Deliberately NOT the same constant — two
/// different measurements should not share one number just because they are
/// close, or the next person tuning one silently tunes the other.
pub const READBACK_BUDGET_MS: u64 = 150;

/// Gap between polls while the paste is being held. 40 ms is well under the
/// smallest hold we use and well above the cost of one read on the measured
/// targets, so a landing is seen within ~40 ms of happening.
#[cfg(target_os = "windows")]
const POLL_INTERVAL: Duration = Duration::from_millis(40);

/// What the read-back instrument saw. Only [`LandingEvidence::Confirmed`] is
/// load-bearing; both other arms mean "no answer", never "no landing".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LandingEvidence {
    /// The focused element's text CHANGED and now ends with what we delivered.
    Confirmed,
    /// A value could be read, and it does not (yet) end with our text. Says
    /// nothing about delivery: the target may not have processed the paste yet,
    /// or its accessible value may be a placeholder that never reflects content.
    NotObserved,
    /// No value could be read at all — no UIA, no ValuePattern, or the read was
    /// abandoned on its budget.
    ///
    /// 🔴 THE `Default`, ON PURPOSE: anything that forgets to fill this field in
    /// gets "we do not know", never "it landed". The one arm that must be earned
    /// is `Confirmed`.
    #[default]
    Unavailable,
}

impl LandingEvidence {
    /// The word that goes on the forensic line. Kept here so the log and the
    /// verdict cannot drift into describing the same reading differently.
    pub fn phrase(self) -> &'static str {
        match self {
            LandingEvidence::Confirmed => "read-back=confirmed(focused element now ends with it)",
            LandingEvidence::NotObserved => "read-back=not-observed(element readable, no match)",
            LandingEvidence::Unavailable => "read-back=unavailable(no readable value on this target)",
        }
    }
}

/// The whole judgement, as a pure function of three readings — so the rule is a
/// unit fact rather than a real-machine hope.
///
/// `expected` is the text we delivered. `baseline` is the value read BEFORE the
/// keystroke, `current` the value read after.
pub fn evaluate(baseline: Option<&str>, current: Option<&str>, expected: &str) -> LandingEvidence {
    let Some(current) = current else {
        return LandingEvidence::Unavailable;
    };
    // An empty delivery has nothing to confirm; treating "ends with empty" as a
    // match would make every read a confirmation.
    if expected.trim().is_empty() {
        return LandingEvidence::NotObserved;
    }
    let now = normalise(current);
    let was = baseline.map(normalise);
    // The value must have CHANGED. See the header: without this, a box that
    // already contained the text confirms a paste that never happened.
    if was.as_deref() == Some(now.as_str()) {
        return LandingEvidence::NotObserved;
    }
    if now.ends_with(&normalise(expected)) {
        LandingEvidence::Confirmed
    } else {
        LandingEvidence::NotObserved
    }
}

/// Line endings only. Deliberately NOT a whitespace-squashing normaliser: the
/// looser the comparison, the more often this says yes for the wrong reason, and
/// a false `Confirmed` is the one failure this module must not have (it would
/// hand the clipboard back early, which is the very defect it exists to fix).
/// Editors that rewrite CRLF are common enough to be worth the one rule.
fn normalise(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

/// A running read-back watch. Created BEFORE the keystroke (so it can take its
/// baseline), polled by the paste's hold loop, and dropped when the paste ends.
pub struct LandingWatch {
    confirmed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    last: Arc<Mutex<LandingEvidence>>,
}

impl LandingWatch {
    /// Has the landing been confirmed? Cheap enough to call from a tight loop.
    pub fn confirmed(&self) -> bool {
        self.confirmed.load(Ordering::Relaxed)
    }

    /// The most recent reading, for the forensic line.
    pub fn evidence(&self) -> LandingEvidence {
        *self.last.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A watch that never answers — the seam every non-Windows host and every
    /// headless test gets. `Unavailable` is the honest default here BECAUSE the
    /// caller may not treat it as failure (doc 13 §7 F1 ②: a DI default must be
    /// the real thing or must be unable to be mistaken for it).
    pub fn inert() -> Self {
        Self {
            confirmed: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(true)),
            last: Arc::new(Mutex::new(LandingEvidence::Unavailable)),
        }
    }
}

impl Drop for LandingWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

// ── P2 (2026-09-02 audit): reuse the reader thread across polls ────────────
//
// Before this, EVERY poll tick (every `POLL_INTERVAL` = 40ms, for as long as
// the paste hold lasts — up to ~35 ticks over `PASTE_HOLD`'s 1.5s) spawned a
// brand-new OS thread that ran a fresh `CoInitializeEx` before doing its one
// UIA read. The per-read spawn itself is NOT the defect — it is what makes an
// individual read abandonable (see the module header: a cross-process UIA
// call has no timeout parameter, so the only way to bound one is a thread we
// are willing to leak) — but paying a full thread-create + COM-apartment-init
// cost on the OVERWHELMING majority of ticks, where the previous read
// answered fine, bought nothing.
//
// `BoundedReuseWorker` keeps ONE worker thread alive across ticks and only
// discards it (dropping the channel, abandoning whatever the worker is
// blocked on) when a call actually TIMES OUT — the one case where the worker
// might be stuck forever and must not be handed a second request that would
// queue up behind it, or that would receive a stale answer from the timed-out
// call at some arbitrary later moment. Generic so the reuse bookkeeping is
// unit-tested with a fake worker; only the Windows call site below supplies
// the real UIA closure — `#[cfg(any(test, target_os = "windows"))]` (not a
// bare `#[cfg]`, see the header note above) is what keeps it reachable for
// that test build on every platform while still dropping out of a plain
// non-Windows build, where it would otherwise be unreachable dead code.
#[cfg(any(test, target_os = "windows"))]
struct BoundedReuseWorker<T: Send + 'static> {
    req_tx: std::sync::mpsc::Sender<()>,
    resp_rx: std::sync::mpsc::Receiver<T>,
}

#[cfg(any(test, target_os = "windows"))]
impl<T: Send + 'static> BoundedReuseWorker<T> {
    /// `on_start` runs ONCE, before the first `work()` call, on the worker
    /// thread — this is where a real caller puts one-time-per-thread setup
    /// (`CoInitializeEx`) that used to run on every ephemeral thread.
    fn spawn(
        on_start: impl FnOnce() + Send + 'static,
        mut work: impl FnMut() -> T + Send + 'static,
    ) -> Self {
        let (req_tx, req_rx) = std::sync::mpsc::channel::<()>();
        let (resp_tx, resp_rx) = std::sync::mpsc::channel::<T>();
        std::thread::spawn(move || {
            on_start();
            while req_rx.recv().is_ok() {
                let v = work();
                if resp_tx.send(v).is_err() {
                    // The caller already replaced us (our previous answer
                    // timed out) — nobody is listening any more.
                    return;
                }
            }
        });
        Self { req_tx, resp_rx }
    }

    /// One bounded call. `Err(())` means "no answer arrived in time" — the
    /// caller MUST treat this worker as unusable from here on (drop it and
    /// spawn a fresh one for the next call), because the underlying `work()`
    /// may still be blocked and would otherwise serve a stale answer to a
    /// LATER, unrelated call.
    fn call_bounded(&self, budget: Duration) -> Result<T, ()> {
        if self.req_tx.send(()).is_err() {
            return Err(()); // worker already exited
        }
        self.resp_rx.recv_timeout(budget).map_err(|_| ())
    }
}

/// Start watching for `expected` to appear at the end of the focused element.
///
/// The polling runs on a thread we are willing to ABANDON, for the same reason
/// `msaa_focus::read_focus_bounded` does: a cross-process accessibility call can
/// block for as long as the target app feels like, and the caller is holding the
/// user's clipboard while it waits.
#[cfg(target_os = "windows")]
pub fn watch(expected: &str) -> LandingWatch {
    let confirmed = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(LandingEvidence::Unavailable));
    let (c, s, l) = (confirmed.clone(), stop.clone(), last.clone());
    let expected = expected.to_string();
    std::thread::spawn(move || {
        let mut reader = uia_reader::spawn_uia_reader();
        // The baseline MUST be taken before the keystroke lands; `watch` is
        // called before `send_ctrl_v` for exactly that reason.
        let baseline = uia_reader::read_bounded(&mut reader);
        while !s.load(Ordering::Relaxed) {
            let current = uia_reader::read_bounded(&mut reader);
            let verdict = evaluate(baseline.as_deref(), current.as_deref(), &expected);
            if let Ok(mut g) = l.lock() {
                *g = verdict;
            }
            if verdict == LandingEvidence::Confirmed {
                c.store(true, Ordering::Relaxed);
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
    LandingWatch { confirmed, stop, last }
}

/// Hosts with no UIA never answer, so every paste holds its full window and
/// every verdict falls back to what the act itself proves. That is a slower
/// product, never a wrong one.
#[cfg(not(target_os = "windows"))]
pub fn watch(_expected: &str) -> LandingWatch {
    LandingWatch::inert()
}

// Grouped under ONE platform attribute rather than two (`verify:lint`'s
// `platform-cfg-count` census counts attribute occurrences, not items — see
// `focus/tracker.rs`'s note on the same tripwire, and `shell/capsule_watch.rs`'s
// header for why this repo bothers pinning that count at all).
#[cfg(target_os = "windows")]
mod uia_reader {
    use super::*;

    pub(super) fn spawn_uia_reader() -> BoundedReuseWorker<Option<String>> {
        BoundedReuseWorker::spawn(ensure_com_initialized, read_focus_value)
    }

    /// One bounded read, replacing `reader` (abandoning whatever it may still
    /// be blocked on) the moment a call times out — see
    /// `BoundedReuseWorker::call_bounded`.
    pub(super) fn read_bounded(reader: &mut BoundedReuseWorker<Option<String>>) -> Option<String> {
        match reader.call_bounded(Duration::from_millis(READBACK_BUDGET_MS)) {
            Ok(v) => v,
            Err(()) => {
                *reader = spawn_uia_reader();
                None
            }
        }
    }
}

/// COM is initialised PER THREAD and never uninitialised — the same trade
/// `msaa_focus.rs` and `inject/image.rs` already make. `S_FALSE` (already
/// initialised) and `RPC_E_CHANGED_MODE` (this thread is an MTA) are both fine,
/// so the HRESULT is deliberately ignored. Called ONCE per worker thread's
/// lifetime (see `BoundedReuseWorker::spawn`'s `on_start`), not once per read.
#[cfg(target_os = "windows")]
fn ensure_com_initialized() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

/// The actual UIA read. Windows only. Runs on the reuse worker's thread (COM
/// already initialised by `ensure_com_initialized`), wrapped in `catch_unwind`
/// by nothing here any more — `BoundedReuseWorker`'s worker loop does not
/// catch panics, so a panicking read now brings down the worker thread
/// exactly once and `call_bounded`'s next call observes it as a timeout
/// (`resp_rx` disconnects), which already triggers a fresh worker — the same
/// externally-visible behaviour the old per-read `catch_unwind` produced.
#[cfg(target_os = "windows")]
fn read_focus_value() -> Option<String> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, UIA_ValuePatternId,
    };

    // SAFETY: every call below is a read. The COM pointers are owned by
    // windows-rs wrappers that Release on drop; nothing outlives this function.
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let focused = automation.GetFocusedElement().ok()?;
        // GetCurrentPatternAs returns an error rather than a null interface when
        // the element does not support the pattern, which is most of the reason
        // this whole module has to be allowed to say "Unavailable".
        let pattern: IUIAutomationValuePattern =
            focused.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
        let value = pattern.CurrentValue().ok()?;
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── P2 (2026-09-02): the reuse worker must reuse on success, replace on
    //    timeout, and never hand a caller a stale answer from an abandoned
    //    call — tested with a fake `work()`, no Win32/UIA involved. ─────────

    #[test]
    fn consecutive_fast_calls_reuse_the_same_worker_thread() {
        use std::sync::atomic::AtomicU32;
        static STARTS: AtomicU32 = AtomicU32::new(0);
        STARTS.store(0, Ordering::SeqCst);
        let worker = BoundedReuseWorker::spawn(
            || {
                STARTS.fetch_add(1, Ordering::SeqCst);
            },
            || 7u32,
        );
        for _ in 0..5 {
            assert_eq!(worker.call_bounded(Duration::from_millis(200)), Ok(7));
        }
        assert_eq!(
            STARTS.load(Ordering::SeqCst),
            1,
            "on_start (the CoInitializeEx stand-in) must run ONCE per worker thread, not once per call"
        );
    }

    #[test]
    fn a_call_that_never_returns_times_out_instead_of_blocking_forever() {
        let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        // `work` blocks forever on a channel nobody ever sends to — exactly
        // the shape of a UIA call into a target that never replies.
        let worker = BoundedReuseWorker::spawn(
            || {},
            move || {
                let _: Result<(), _> = gate_rx.recv();
                0u32
            },
        );
        let result = worker.call_bounded(Duration::from_millis(50));
        assert_eq!(result, Err(()), "a stuck work() must time out, not hang the caller");
        drop(gate_tx); // let the abandoned thread unblock and exit cleanly
    }

    #[test]
    fn reverse_control_a_slow_but_within_budget_call_still_succeeds() {
        // NEGATIVE CONTROL for the timeout test: a call that is slow but
        // finishes inside the budget must still answer `Ok`. Without this, a
        // version of `call_bounded` that always returned `Err` would still
        // pass the test above.
        let worker = BoundedReuseWorker::spawn(
            || {},
            || {
                std::thread::sleep(Duration::from_millis(5));
                42u32
            },
        );
        assert_eq!(worker.call_bounded(Duration::from_millis(500)), Ok(42));
    }

    #[test]
    fn read_bounded_falls_back_to_none_and_keeps_working_after_a_timeout() {
        // Exercises the actual call-site policy (`read_bounded`'s `Err` arm):
        // a timed-out reader is replaced, and the NEXT read still gets an
        // honest answer rather than repeating the stale timeout forever.
        let attempt = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let a = attempt.clone();
        // First call hangs (simulating one stuck target read); second+ calls
        // answer immediately. Modelled as a worker-generation counter since
        // `BoundedReuseWorker` is generic over `work`, not swappable in place —
        // `read_bounded`'s OWN replacement-on-timeout is what is under test,
        // via a small helper mirroring its exact policy.
        fn read_bounded_generic<T: Send + 'static + PartialEq>(
            reader: &mut BoundedReuseWorker<T>,
            budget: Duration,
            respawn: impl FnOnce() -> BoundedReuseWorker<T>,
        ) -> Option<T> {
            match reader.call_bounded(budget) {
                Ok(v) => Some(v),
                Err(()) => {
                    *reader = respawn();
                    None
                }
            }
        }
        let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        let mut reader = BoundedReuseWorker::spawn(
            || {},
            move || {
                a.fetch_add(1, Ordering::SeqCst);
                let _: Result<(), _> = gate_rx.recv(); // hangs forever
                0u32
            },
        );
        let first = read_bounded_generic(&mut reader, Duration::from_millis(30), || {
            BoundedReuseWorker::spawn(|| {}, || 99u32)
        });
        assert_eq!(first, None, "a timed-out first read must fall back to None");
        let second = read_bounded_generic(&mut reader, Duration::from_millis(200), || {
            BoundedReuseWorker::spawn(|| {}, || 99u32)
        });
        assert_eq!(second, Some(99), "the replacement worker must answer normally");
        drop(gate_tx);
    }

    #[test]
    fn a_changed_value_ending_with_the_text_confirms() {
        assert_eq!(
            evaluate(Some("hello "), Some("hello 你好世界"), "你好世界"),
            LandingEvidence::Confirmed
        );
    }

    #[test]
    fn an_unchanged_value_never_confirms_even_when_it_matches() {
        // The defect this guard exists for: the box ALREADY ended with our text,
        // so "ends with" is satisfied by a paste that never happened.
        assert_eq!(
            evaluate(Some("你好世界"), Some("你好世界"), "你好世界"),
            LandingEvidence::NotObserved
        );
    }

    #[test]
    fn a_changed_value_that_does_not_match_is_not_observed_not_failed() {
        // Devin's contenteditable answers with a one-space placeholder. That must
        // read as "this instrument is blind here", never as "the paste failed".
        assert_eq!(
            evaluate(Some(" "), Some("  "), "你好世界"),
            LandingEvidence::NotObserved
        );
    }

    #[test]
    fn no_readable_value_is_unavailable() {
        assert_eq!(
            evaluate(Some("x"), None, "你好世界"),
            LandingEvidence::Unavailable
        );
        assert_eq!(evaluate(None, None, "你好世界"), LandingEvidence::Unavailable);
    }

    #[test]
    fn an_unreadable_baseline_does_not_block_a_later_confirmation() {
        // The target became readable only after it took focus properly. The value
        // still changed (None → Some) and still ends with our text.
        assert_eq!(
            evaluate(None, Some("prefix 你好世界"), "你好世界"),
            LandingEvidence::Confirmed
        );
    }

    #[test]
    fn empty_deliveries_cannot_confirm_anything() {
        // "ends_with(\"\")" is true for every string on earth.
        assert_eq!(evaluate(Some("a"), Some("b"), ""), LandingEvidence::NotObserved);
        assert_eq!(
            evaluate(Some("a"), Some("b"), "   \n "),
            LandingEvidence::NotObserved
        );
    }

    #[test]
    fn crlf_rewriting_editors_still_confirm() {
        assert_eq!(
            evaluate(Some(""), Some("line1\r\nline2"), "line1\nline2"),
            LandingEvidence::Confirmed
        );
    }

    #[test]
    fn trailing_whitespace_added_by_the_target_still_confirms() {
        assert_eq!(
            evaluate(Some("x"), Some("x你好世界\n"), "你好世界"),
            LandingEvidence::Confirmed
        );
    }

    #[test]
    fn a_prefix_match_is_not_a_match() {
        // The text landing at the START of the box means something else is at the
        // end — most likely we are reading a different element than we injected
        // into. Not evidence.
        assert_eq!(
            evaluate(Some(""), Some("你好世界 trailing"), "你好世界"),
            LandingEvidence::NotObserved
        );
    }

    #[test]
    fn the_inert_watch_never_confirms_and_says_so() {
        let w = LandingWatch::inert();
        assert!(!w.confirmed());
        assert_eq!(w.evidence(), LandingEvidence::Unavailable);
    }

    #[test]
    fn every_arm_has_a_distinct_forensic_phrase() {
        let all = [
            LandingEvidence::Confirmed,
            LandingEvidence::NotObserved,
            LandingEvidence::Unavailable,
        ];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(a.phrase(), b.phrase(), "{a:?} and {b:?} read the same");
            }
        }
    }

    // The evidence sentence has to carry all three facts, because it is the only line
    // anybody will read when the next 「it pasted the wrong text」 report arrives. The
    // held= number is the one that makes the failure falsifiable at all: the defect
    // was 「the payload was reachable for 110ms」, and no reader could have known that
    // from the old line.
    #[test]
    fn the_evidence_sentence_carries_the_receipt_the_landing_and_the_hold() {
        use crate::inject::clipboard_outcome::evidence_phrase;
        use crate::inject::readback::LandingEvidence;
        let s = evidence_phrase(true, LandingEvidence::Confirmed, 214);
        assert!(s.contains("held=214ms"), "{s}");
        assert!(s.contains("read-back"), "{s}");
        // The two facts must stay distinguishable: a served receipt with NO landing
        // evidence is exactly the state the P0 lived in, and it must not read the
        // same as a confirmed landing.
        let unconfirmed = evidence_phrase(true, LandingEvidence::Unavailable, 1500);
        assert_ne!(s, unconfirmed);
        assert!(unconfirmed.contains("unavailable"), "{unconfirmed}");
    }

}

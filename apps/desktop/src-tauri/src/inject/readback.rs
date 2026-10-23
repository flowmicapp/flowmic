// SPEC-REF:
//   docs/archive/strategy/2026-08-21-ime-safe-inject-routing-design.md §3 (the safety net
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
//
// NR-254 (2026-10-14) found that rule had three gaps, each a way to say yes with
// nothing new in the box: the baseline was read on a thread that raced Ctrl+V; a
// missing baseline counted as 「changed」; and two polls could read two different
// focused elements. Now: `watch` waits for its baseline, no baseline never
// confirms, the same UIA element must answer both reads, and the change must add
// a copy of the text (`evaluate`, `evaluate_readings`, tests `nr254_*`).

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
    // NR-254: no baseline, no confirmation. 「Changed」 is unprovable without one,
    // and the box may well have ended with this text before the keystroke.
    let Some(baseline) = baseline else {
        return LandingEvidence::NotObserved;
    };
    let now = normalise(current);
    let was = normalise(baseline);
    // The value must have CHANGED. See the header: without this, a box that
    // already contained the text confirms a paste that never happened.
    if was == now {
        return LandingEvidence::NotObserved;
    }
    let expected = normalise(expected);
    // NR-254: and the change must have ADDED a copy of the text. 「Changed and ends
    // with it」 is also true of a box that already ended with it (an earlier
    // identical paste) and changed somewhere else.
    if now.ends_with(&expected) && now.matches(&expected).count() > was.matches(&expected).count() {
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

/// One reading of the focused element: WHICH element it was (its UIA runtime id)
/// and the value it held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusReading {
    pub element: Vec<i32>,
    pub value: String,
}

/// [`evaluate`] over two whole readings, plus the one question `evaluate` cannot
/// ask: were they readings of the SAME element?
///
/// NR-254: every poll asks UIA for whatever is focused NOW. A baseline taken from
/// one element (Notepad's AI prompt box, a tab strip mid-switch) and a poll that
/// lands on another (an editor that already ends with the text) look like 「the
/// value changed and ends with it」 without anything having been pasted. An
/// element whose runtime id could not be read cannot vouch for itself.
pub fn evaluate_readings(
    baseline: Option<&FocusReading>,
    current: Option<&FocusReading>,
    expected: &str,
) -> LandingEvidence {
    let Some(current) = current else {
        return LandingEvidence::Unavailable;
    };
    match baseline {
        Some(b) if !b.element.is_empty() && b.element == current.element => {
            evaluate(Some(&b.value), Some(&current.value), expected)
        }
        _ => LandingEvidence::NotObserved,
    }
}

/// How long `watch` waits for the baseline before letting the keystroke go: one
/// bounded read plus thread start-up. Overlaps `CLIPBOARD_SETTLE`, which the
/// paste spends asleep before Ctrl+V anyway (`clipboard_confirm.rs`).
pub const BASELINE_WAIT_MS: u64 = READBACK_BUDGET_MS + 50;

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
    let mut reader = uia_reader::spawn_uia_reader();
    watch_with(
        expected,
        POLL_INTERVAL,
        std::time::Duration::from_millis(BASELINE_WAIT_MS),
        move || uia_reader::read_bounded(&mut reader),
    )
}

/// The watch itself, over any reader — `watch` hands it the UIA one; the tests
/// hand it scripted reading sequences.
pub fn watch_with(
    expected: &str,
    poll: std::time::Duration,
    baseline_wait: std::time::Duration,
    mut read: impl FnMut() -> Option<FocusReading> + Send + 'static,
) -> LandingWatch {
    let confirmed = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(LandingEvidence::Unavailable));
    let (c, s, l) = (confirmed.clone(), stop.clone(), last.clone());
    let expected = expected.to_string();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let baseline = read();
        let _ = ready_tx.send(());
        while !s.load(Ordering::Relaxed) {
            let current = read();
            let verdict = evaluate_readings(baseline.as_ref(), current.as_ref(), &expected);
            if let Ok(mut g) = l.lock() {
                *g = verdict;
            }
            if verdict == LandingEvidence::Confirmed {
                c.store(true, Ordering::Relaxed);
                return;
            }
            std::thread::sleep(poll);
        }
    });
    // NR-254: the baseline must PREDATE the keystroke. This used to return at
    // once and the caller sent Ctrl+V straight away, so the first read raced the
    // paste. A baseline that misses this wait arrives late and real; a late one
    // can only make the verdict stricter (it may already contain the paste).
    let _ = ready_rx.recv_timeout(baseline_wait);
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

    pub(super) fn spawn_uia_reader() -> BoundedReuseWorker<Option<FocusReading>> {
        BoundedReuseWorker::spawn(ensure_com_initialized, read_focus_value)
    }

    /// One bounded read, replacing `reader` (abandoning whatever it may still
    /// be blocked on) the moment a call times out — see
    /// `BoundedReuseWorker::call_bounded`.
    pub(super) fn read_bounded(
        reader: &mut BoundedReuseWorker<Option<FocusReading>>,
    ) -> Option<FocusReading> {
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
fn read_focus_value() -> Option<FocusReading> {
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Ole::{
        SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
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
        // WHICH element answered. An element whose id cannot be read gets an
        // empty one, and `evaluate_readings` never confirms against an empty id.
        let mut element = Vec::new();
        if let Ok(ids) = focused.GetRuntimeId() {
            if !ids.is_null() {
                if let (Ok(lo), Ok(hi)) = (SafeArrayGetLBound(ids, 1), SafeArrayGetUBound(ids, 1)) {
                    for i in lo..=hi {
                        let mut v = 0i32;
                        if SafeArrayGetElement(ids, &i, &mut v as *mut i32 as *mut _).is_err() {
                            element.clear();
                            break;
                        }
                        element.push(v);
                    }
                }
                let _ = SafeArrayDestroy(ids);
            }
        }
        Some(FocusReading {
            element,
            value: value.to_string(),
        })
    }
}

// Split out for the 800-line src cap (NR-254 pushed this file over it).
#[cfg(test)]
#[path = "readback_tests.rs"]
mod tests;

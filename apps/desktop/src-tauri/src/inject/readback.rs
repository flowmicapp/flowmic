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
// Windows-only: the two things that need a Duration here (the poll interval and
// the per-read budget) are both inside the UIA implementation.
#[cfg(target_os = "windows")]
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
        // The baseline MUST be taken before the keystroke lands; `watch` is
        // called before `send_ctrl_v` for exactly that reason.
        let baseline = read_focus_value_bounded();
        while !s.load(Ordering::Relaxed) {
            let current = read_focus_value_bounded();
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

/// One bounded read of the focused element's value.
#[cfg(target_os = "windows")]
fn read_focus_value_bounded() -> Option<String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    // May outlive this function; it only sends on a channel whose receiver may
    // already be gone, which `send` reports as an error we ignore.
    std::thread::spawn(move || {
        let v = std::panic::catch_unwind(read_focus_value).unwrap_or(None);
        let _ = tx.send(v);
    });
    rx.recv_timeout(Duration::from_millis(READBACK_BUDGET_MS))
        .unwrap_or(None)
}

/// The actual UIA read. Windows only.
///
/// ⚠️ COM is initialised PER THREAD and never uninitialised — the same trade
/// `msaa_focus.rs` and `inject/image.rs` already make. `S_FALSE` (already
/// initialised) and `RPC_E_CHANGED_MODE` (this thread is an MTA) are both fine,
/// so the HRESULT is deliberately ignored. This runs on a thread we spawned, so
/// it cannot leave an apartment behind on a pooled Tauri thread.
#[cfg(target_os = "windows")]
fn read_focus_value() -> Option<String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, UIA_ValuePatternId,
    };

    // SAFETY: every call below is a read. The COM pointers are owned by
    // windows-rs wrappers that Release on drop; nothing outlives this function.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
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

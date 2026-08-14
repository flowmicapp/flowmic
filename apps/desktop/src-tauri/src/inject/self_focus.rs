// SPEC-REF:
//   docs/strategy/2026-08-02-0248-status-truth-analysis.md §F1a
//     + 「owner's 2026-08-02 clarification」item 1
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5e-4
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//     (the CROSS-PROCESS ruling — deliberately untouched by this module)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// ── WHAT THIS MODULE ANSWERS, AND THE ONLY THING IT ANSWERS ──────────────────
//
//   「FlowMic 自己的窗口里，此刻有没有一个可输入的焦点？」 ("Inside FlowMic's own
//   window, is there right now a focus that can receive input?")
//
// owner 2026-08-02:「它本身就是 PC 端的一个窗口，光标定位到这里我说的话肯定能注入，
// 这是非常正常的要求。」 ("It IS itself a window on the PC side; if the cursor is
// positioned here, what I say should definitely be able to be injected — that is a
// perfectly normal expectation.") That reversed the previous product stance (「不往自家窗口注入」
// ("never inject into our own window")),
// and it is answerable EXACTLY here in a way it is not answerable anywhere else in
// this codebase: our own window is our own PROCESS, and the WebView knows which
// element holds DOM focus. 0.2.19/0.2.21's whole tragedy was asking the platform
// for evidence about SOMEONE ELSE's process; none of that applies inside our own.
//
// 🔴 IT IS A NEW SOURCE OF TRUTH AND IT IS MERGED WITH NOTHING (CLAUDE.md's #1 red line
// 「一个值只回答一个问题」 ("one value only answers one question")). In particular it is NOT:
//
//   · NOT `focus::tracker`'s foreground stream. That answers 「哪个 EXTERNAL 程序是
//     前台」 ("which EXTERNAL program is in the foreground") and it must keep answering `None` for our own windows — `last_foreground`
//     is the SPEAKING lock's candidate, and letting a glance at FlowMic overwrite it
//     would erase the app the user was really working in (tracker.rs:251-259 says so
//     in its own words). Two questions, two answers, no shortcut.
//   · NOT `target_probe::focused_input_state`. That is the CROSS-PROCESS Stage-1b
//     gate, whose job is 「别搞坏东西」 ("don't break anything") and whose default is deliberately 「type
//     anyway」 because it cannot prove anything. This one is precise, so its default
//     is the opposite (see the failure direction below). Feeding one into the other
//     would give a precise answer the imprecise one's posture, or vice versa.
//   · NOT `caret.rs::foreground_caret`. That answers 「把胶囊画在哪」 ("where to draw the capsule").
//
// ── FRESHNESS, AND WHAT HAPPENS WHEN THE ANSWER IS STALE ─────────────────────
//
// The report is PUSHED by the WebView on every focus change (focusin/focusout,
// window activate/deactivate) plus a heartbeat while an input is focused, so it
// tracks the user clicking away. Two guards make a stale report harmless:
//
//   ① THE LIVE CROSS-CHECK. Every read re-asks the OS 「is our own window the
//      foreground RIGHT NOW, and is it the same window the report names?」 A report
//      can only ever be believed about the window that is actually in front of the
//      user. This is what makes 「the user clicked away」 self-correcting without any event at
//      all: the moment another app is foreground the answer is [`NotOurWindow`].
//   ② THE TTL. A report older than [`SELF_FOCUS_TTL`] is not believed. This covers
//      the one case ① cannot: the WebView's JS stopped running while its window
//      stayed in front (a wedged renderer), so focus moved and nobody told us.
//
// 🔴 FAILURE DIRECTION — 「could not get an answer」 degrades to not-injected · cached, NEVER to injected.
// Stated as a decision with a reason, not as a convenience:
//   · degrade to CACHED (this) — the outcome is byte-for-byte what 0.2.48 already
//     does for this case, so an absent/stale/broken reporter REGRESSES NOTHING; the
//     user sees the same not-injected · cached state they see today, now with a named reason.
//     And the headline feature (the phone speaks → the program you're actually using) is untouched, because
//     it aims at OTHER processes and never reaches this code at all.
//   · degrade to INJECT — a wedged or un-wired WebView would fire the user's
//     sentence at whatever FlowMic surface happens to be up (the timeline, the
//     settings page), where the characters either vanish or hit accelerators, and
//     we would report `injected` for them. That is the second, forbidden direction
//     of 没有静默失败 ("no silent failures") (claiming a thing happened that did not) — and this repo has
//     already paid for a gate whose optimistic default typed into nothing.
// Note this is the OPPOSITE default from `target_probe`, and deliberately so: there,
// an inconclusive reading costs the whole product; here, it costs nothing.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one pushed report is believed without a refresh.
///
/// Paired with the reporter's heartbeat (apps/desktop/src/lib/self-focus.ts
/// `SELF_FOCUS_HEARTBEAT_MS`, 3s) so a genuinely-focused input survives an
/// arbitrarily long utterance while a wedged renderer expires in bounded time.
/// The ratio matters more than either number: three missed heartbeats.
pub const SELF_FOCUS_TTL: Duration = Duration::from_secs(10);

/// What the WebView said about itself. Both fields are CLAIMS; neither is trusted
/// without the live cross-check in [`decide`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelfFocusReport {
    /// The OS handle of the FlowMic window making the claim. 🔴 Resolved in Rust
    /// from the `tauri::WebviewWindow` that invoked the command — never a number
    /// the page chose — so a page cannot name a window it does not own.
    pub hwnd: u64,
    /// An element that accepts typed text holds DOM focus in that window.
    pub editable: bool,
}

/// A report plus WHEN it was made. The stamp is this process's monotonic clock;
/// no cross-device or wall-clock comparison exists on this path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StampedReport {
    pub report: SelfFocusReport,
    pub at: Instant,
}

/// Why 「自家窗口前台，但不能打字」 ("our own window is foreground, but it can't
/// accept typing"). Kept apart from the verdict itself because the
/// four causes are the same answer to the USER and four different answers to
/// root-causing — the forensic line names which one, the UI does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoInputEvidence {
    /// The WebView said so, freshly. This is the precise, believed case.
    Reported,
    /// A report exists but is older than [`SELF_FOCUS_TTL`] — a wedged or
    /// unresponsive renderer. We do not know, so we do not type.
    Stale,
    /// No report at all: a build whose reporter is not wired, or a window that has
    /// never been focused since launch.
    Absent,
    /// The report names a DIFFERENT window of ours than the one in front (e.g. the
    /// capsule reported while the main window is foreground). A claim about window
    /// A proves nothing about window B.
    OtherWindow,
}

impl NoInputEvidence {
    /// The forensic token. Every variant is distinguishable in the log — two causes
    /// that print the same word are one cause as far as root-causing is concerned.
    pub fn tag(self) -> &'static str {
        match self {
            NoInputEvidence::Reported => "reported(no editable focus)",
            NoInputEvidence::Stale => "stale(report older than TTL — renderer not answering)",
            NoInputEvidence::Absent => "absent(no reporter has ever pushed)",
            NoInputEvidence::OtherWindow => "other-window(report names a different FlowMic window)",
        }
    }
}

/// The answer. Three values, not a bool: 「不是我们的窗口」 ("this is not our
/// window") and 「是我们的窗口但没有
/// 输入焦点」 ("this is our window but there is no input focus") lead to DIFFERENT outcomes (fall through to the normal pipeline vs.
/// a named `cached`), and folding them into one `Option` is how the third cause of
/// `cached` would lose its face again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfFocusVerdict {
    /// Our own window is the foreground AND an editable element holds focus in it.
    /// The `u64` is the LIVE `GetForegroundWindow` value, not the reported one —
    /// they are equal by construction here, and the OS reading is the fact while
    /// the report is only the claim.
    Editable(u64),
    /// Our own window IS the foreground, and typing into it would land nowhere.
    OwnWindowNoInput(NoInputEvidence),
    /// The foreground is not ours. This module has nothing to say; the ordinary
    /// cross-process pipeline owns the frame.
    NotOurWindow,
}

/// The whole decision, as a pure function — no Win32, no globals, no clock.
///
/// `foreground_is_ours` / `foreground_hwnd` come from ONE live OS read (see
/// [`live_foreground`]); passing them in is what lets every branch below be
/// asserted without a desktop.
pub fn decide(
    report: Option<StampedReport>,
    now: Instant,
    foreground_is_ours: bool,
    foreground_hwnd: u64,
) -> SelfFocusVerdict {
    // 🔴 THE CROSS-CHECK COMES FIRST AND IT IS NOT NEGOTIABLE. Every other branch
    // below is a statement about a window the user is looking at; if the user is
    // looking at something else, none of them may be reached — a report that said
    // `editable` ten milliseconds before the user alt-tabbed would otherwise send
    // their sentence into a window that is no longer in front of them.
    if !foreground_is_ours || foreground_hwnd == 0 {
        return SelfFocusVerdict::NotOurWindow;
    }
    let Some(stamped) = report else {
        return SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Absent);
    };
    // `saturating_duration_since` rather than `duration_since`: a stamp from the
    // future is a clock oddity, not a reason to panic inside the injection path.
    if now.saturating_duration_since(stamped.at) > SELF_FOCUS_TTL {
        return SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Stale);
    }
    if stamped.report.hwnd != foreground_hwnd {
        return SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::OtherWindow);
    }
    if !stamped.report.editable {
        return SelfFocusVerdict::OwnWindowNoInput(NoInputEvidence::Reported);
    }
    SelfFocusVerdict::Editable(foreground_hwnd)
}

/// The one pushed report, process-wide. `None` until a WebView pushes one.
static REPORT: Mutex<Option<StampedReport>> = Mutex::new(None);

/// Record what a FlowMic window says about its own DOM focus.
///
/// LAST WRITER WINS, on purpose. Two windows can both push, and the one that
/// matters is the one in front — which [`decide`]'s `OtherWindow` branch settles
/// with the live foreground rather than with a per-window table. (In practice the
/// capsule is `WS_EX_NOACTIVATE` and can never BE the foreground, so it can never
/// win a race it could not have won anyway.)
pub fn record_report(hwnd: u64, editable: bool) {
    let stamped = StampedReport {
        report: SelfFocusReport { hwnd, editable },
        at: Instant::now(),
    };
    let mut slot = match REPORT.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *slot = Some(stamped);
}

/// Forget everything (tests, and the shutdown path if one is ever added).
pub fn clear_report() {
    let mut slot = match REPORT.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *slot = None;
}

fn stored_report() -> Option<StampedReport> {
    match REPORT.lock() {
        Ok(g) => *g,
        Err(p) => *p.into_inner(),
    }
}

/// One live OS read: `(foreground_hwnd, belongs_to_this_process)`.
///
/// ⚠️ THE `pid` COMPARISON IS DELIBERATELY A SECOND COPY of the one in
/// `focus::tracker::is_own_window`, and that is not an oversight to be tidied up.
/// The tracker's copy answers 「may this foreground become an EXTERNAL inject
/// target / the SPEAKING lock's candidate?」 and must keep answering `false` for us
/// forever. This one answers 「is the window in front of the user ours?」 and needs
/// `true` in exactly that case. Merging them would give one value two questions —
/// the shape this repo tracks as its #1 historical bug.
#[cfg(target_os = "windows")]
fn live_foreground() -> (u64, bool) {
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: plain reads of OS window state with a locally owned out-param; no
    // handle is retained past this function.
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return (0, false); // lock screen / no foreground window
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(fg, Some(&mut pid as *mut u32));
        let ours = pid != 0 && pid == GetCurrentProcessId();
        (fg.0 as usize as u64, ours)
    }
}

#[cfg(not(target_os = "windows"))]
fn live_foreground() -> (u64, bool) {
    (0, false)
}

/// Production reader: the stored report + one live OS read + [`decide`].
pub fn current_verdict() -> SelfFocusVerdict {
    let (hwnd, ours) = live_foreground();
    decide(stored_report(), Instant::now(), ours, hwnd)
}

/// The pipeline's seam (same shape as [`crate::inject::target_probe::TargetProbe`]).
/// Production passes [`current_verdict`]; tests pass a fake, so no test's result
/// depends on which window happened to be in front of the machine running it.
pub type SelfFocusProbe = fn() -> SelfFocusVerdict;

/// The seam's 「this question does not apply」 value — the reader every caller that
/// has no WebView (the golden-path example, the smokes, `cargo test`) uses.
pub fn never_ours() -> SelfFocusVerdict {
    SelfFocusVerdict::NotOurWindow
}

/// The Tauri command the WebView pushes through.
///
/// 🔴 `window` IS THE AUTHORITY ON WHICH WINDOW THIS IS. The page sends only the
/// boolean; the handle is resolved here from the invoking `WebviewWindow`. A page
/// that could name a handle could name someone else's, and this module's whole
/// contract is 「our own process」.
///
/// Placed in `inject/` beside the judgement it feeds (the same reason
/// `probe_diag::focus_diagnostic` lives here rather than in `shell/`), and gated
/// on the `app` feature because `inject/` is compiled unconditionally — an
/// ungated `#[tauri::command]` broke the ENTIRE injection layer's `cargo test`
/// once already (see probe_diag.rs's v0.2.1 note).
/// 🔴 SPLIT BY PLATFORM, NOT BY FEATURE (2026-08-06, measured on a real Mac).
/// `feature = "app"` answers 「is the Tauri app being built」; it does NOT answer
/// 「does this OS have window handles」. This function needs BOTH, and used to ask
/// only the first — so it was the single compile error in the whole desktop crate
/// on macOS (`no method named hwnd`), while the four `hwnd()` sites in
/// `shell/mod.rs` compiled away correctly behind `cfg(windows)`.
/// The module already split `live_foreground` this way; this arm was the omission.
#[cfg(all(feature = "app", target_os = "windows"))]
#[tauri::command]
pub fn self_focus_report(window: tauri::WebviewWindow, editable: bool) {
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as usize as u64,
        Err(_) => {
            // No handle ⇒ nothing can be cross-checked ⇒ the report is unusable.
            // Recording it as `editable:false` under handle 0 would be a claim; the
            // honest move is to drop it and SAY so (red line: no silent failures).
            crate::forensic::record(
                "self-focus",
                "report DROPPED — the invoking window has no HWND, so nothing could be \
                 cross-checked against the live foreground",
            );
            return;
        }
    };
    record_report(hwnd, editable);
}

/// The same command on a platform with no window handles.
///
/// This is NOT a new behaviour: it is the `Err(_)` arm above — 「no handle ⇒
/// nothing can be cross-checked ⇒ drop the report and SAY so」 — made structural
/// instead of incidental. The command stays REGISTERED under the same name and
/// signature on every platform on purpose: an unregistered command would fail the
/// WebView's invoke with 「command not found」, which is a different (and less
/// truthful) failure than 「this platform cannot answer that question」.
///
/// ⚠️ OPEN, NOT CLOSED BY THIS ARM: `live_foreground()` already returns
/// `(0, false)` off Windows, so `current_verdict()` degrades to
/// `NotOurWindow` — which reads as 「the focused window is not ours」 when the
/// truth is 「this build cannot tell」. That predates this split and is dormant
/// while the desktop ships Windows-only; naming a third state is a product
/// decision, not a compile fix, so it is registered rather than invented here.
#[cfg(all(feature = "app", not(target_os = "windows")))]
#[tauri::command]
pub fn self_focus_report(_window: tauri::WebviewWindow, _editable: bool) {
    crate::forensic::record(
        "self-focus",
        "report DROPPED — this platform exposes no window handle, so nothing can be \
         cross-checked against the live foreground (structural on non-Windows, not a \
         runtime failure)",
    );
}

#[cfg(test)]
#[path = "self_focus_tests.rs"]
mod self_focus_tests;

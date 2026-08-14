// V2-01 step one —— READ-ONLY focus diagnostics. Zero changes to injection behaviour.
//
// Requirement ⑦: when injecting into Claude Code, the window gets activated but the
// characters never land, yet the UI reports 「✓ already injected」. owner's 2026-07-28
// addition: 「它只是激活了那个窗体, 并没有把光标定位到那个输入框
// 里面……提示注入成功, 其实是没有注入的, 窗口里没有任何地方可以注入。」 ("It only
// activated that window, it never positioned the cursor inside that input box ...
// it says the injection succeeded, but really nothing was injected — there is
// nowhere in the window that can receive input at all.")
//
// ── Why measure before fixing ─────────────────────────────────────────────────
//
// This defect has at least three mutually distinct root causes, each with a completely
// different fix, and on screen they all look identical:
//
//   ① 「UIA misjudged it」 — the probe judged the terminal Editable and let it through, the
//      keys got queued and nobody consumed them.
//      Fix: after injecting, read the console buffer back to confirm the text really appeared.
//   ② 「activation race」 — activating a window is asynchronous, and the keys were sent
//      before the target had actually become the foreground.
//      Fix: wait until the foreground switch truly completes before sending — unrelated to UIA.
//   ③ 「focus is on the window, not on an input box」 — the foreground was right, but the
//      keyboard focus landed on the terminal window itself.
//      Fix: yet another matter entirely.
//
// Guess wrong and you fix the wrong place, and what you'd be changing is the injection
// path that is subject to line-by-line human audit. So this module only collects data —
// it changes not a single byte of injection behaviour: no SendInput, no clipboard, no
// window activation.
//
// ── What it collects ──────────────────────────────────────────────────────────
//
// verdict          — the raw verdict from the existing Stage 1b criterion (the answer to ①)
// foreground_*     — who the foreground window is (the answer to ②: is it the one you think it is)
// focus_hwnd       — the handle of the window holding keyboard focus; caret_hwnd — the caret's owner (the answer to ③)
// If all three are equal ⇒ focus really is on the foreground window itself; focus_hwnd == 0 ⇒ no window holds keyboard focus at all.
//
// 2026-07-30: the underlying criterion switched from UIA to `GetGUIThreadInfo` + `ImmGetContext`
// (target_probe.rs). This module switched its source along with it, **but it changes not one
// line of injection behaviour** —— it now directly
// reuses `focus_evidence()`, so what the diagnostic sees and what injection actually uses are
// **the very same reading**, rather than
// 「the diagnostic asking a second time on its own」 (that is exactly where the two readings
// clashed during the 0.2.19 troubleshooting).

use super::target_probe::{focus_evidence, refusal_for, state_name};

/// One focus snapshot. Every field is an **observed value** — a missing one is always
/// null/0 rather than a plausible guess.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FocusDiagnostic {
    /// `Input` | `NotInput` | `Unknown` —— what Stage 1b's criterion decided.
    /// **The value set changed on 2026-07-30** (the old values `Editable`/`NotEditable`/`Unknown` came from the
    /// now-retired UIA criterion); the frontend `bridge.ts` union type has to widen along with it, see the N1 delivery report.
    pub verdict: &'static str,
    /// Whether, under the current policy, this injection would be refused (and with which error code if so). **Purely a projection — nothing was actually injected.**
    pub would_refuse: Option<&'static str>,
    pub foreground_hwnd: u64,
    pub foreground_title: String,
    pub foreground_process: String,
    /// The window holding keyboard focus. 0 = no window holds focus, or that thread could not be queried (**NOT** "elevation" —
    /// that reasoning was measured false on 2026-08-02, see the correction in `gui_focus()`).
    pub focus_hwnd: u64,
    /// The window that owns the caret. 0 = no caret —— a terminal-style TUI's caret is
    /// drawn as pixels by itself, it does not exist at the OS level, so 0 here **does not
    /// mean** it cannot receive input.
    pub caret_hwnd: u64,
    /// Whether GetGUIThreadInfo succeeded. When false the two hwnds above are meaningless (not the semantics of "0").
    pub gui_info_ok: bool,
    /// Focus window == foreground window —— the direct indicator for 「the window was
    /// merely activated, and focus never landed inside an input box」.
    pub focus_is_foreground: bool,
}

impl FocusDiagnostic {
    /// A one-line summary the owner can copy-paste straight back.
    pub fn one_line(&self) -> String {
        format!(
            "verdict={} refuse={} fg=0x{:x} [{}] {:?} focus=0x{:x} caret=0x{:x} gui_ok={} focus_is_fg={}",
            self.verdict,
            self.would_refuse.unwrap_or("-"),
            self.foreground_hwnd,
            self.foreground_process,
            self.foreground_title,
            self.focus_hwnd,
            self.caret_hwnd,
            self.gui_info_ok,
            self.focus_is_foreground,
        )
    }
}

#[cfg(windows)]
fn gui_focus() -> (u64, u64, bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };
    // SAFETY: purely reads OS window state, the out-params are locally owned and
    // correctly sized, no handle is retained.
    unsafe {
        let fg: HWND = GetForegroundWindow();
        if fg.0.is_null() {
            return (0, 0, false);
        }
        let tid = GetWindowThreadProcessId(fg, None);
        if tid == 0 {
            return (0, 0, false);
        }
        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui).is_err() {
            // false lets the reader know the two zeros below mean 「could not be
            // queried」, not 「genuinely absent」 —— the two meanings are entirely
            // different.
            // 🔴 This used to say 「an elevated process will refuse the query」. Measured
            // false on 2026-08-02: a process genuinely de-elevated to Medium integrity
            // reads a High-integrity target just fine (f1b matrix §2.2 ①).
            // It no longer claims a reason, because we do not actually know one. Anti-façade rule ④.
            return (0, 0, false);
        }
        (gui.hwndFocus.0 as u64, gui.hwndCaret.0 as u64, true)
    }
}

#[cfg(not(windows))]
fn gui_focus() -> (u64, u64, bool) {
    (0, 0, false)
}

/// Collect one snapshot. **Read-only**: does not activate a window, does not send
/// keystrokes, does not touch the clipboard.
///
/// Uses `focus_evidence()` rather than `focused_input_state()`: the latter writes a
/// forensic line, and this is a 「read-only diagnostic」 — letting it quietly land in
/// the log would turn an 「observation」 into a 「traced action」.
pub fn snapshot() -> FocusDiagnostic {
    let evidence = focus_evidence();
    let state = evidence.state();
    let fg_hwnd = crate::focus::tracker::current_foreground_hwnd();
    let (focus_hwnd, caret_hwnd, gui_info_ok) = gui_focus();
    FocusDiagnostic {
        verdict: state_name(state),
        would_refuse: refusal_for(state),
        foreground_hwnd: fg_hwnd,
        foreground_title: crate::focus::tracker::current_window_title(fg_hwnd),
        foreground_process: crate::focus::tracker::current_app_name(fg_hwnd),
        focus_hwnd,
        caret_hwnd,
        gui_info_ok,
        focus_is_foreground: gui_info_ok && focus_hwnd != 0 && focus_hwnd == fg_hwnd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_is_copy_pasteable_and_names_every_field() {
        let d = FocusDiagnostic {
            verdict: "Input",
            would_refuse: None,
            foreground_hwnd: 0x1234,
            foreground_title: "Claude Code".into(),
            foreground_process: "WindowsTerminal.exe".into(),
            focus_hwnd: 0x1234,
            caret_hwnd: 0,
            gui_info_ok: true,
            focus_is_foreground: true,
        };
        let s = d.one_line();
        assert!(s.contains("verdict=Input"));
        assert!(s.contains("fg=0x1234"));
        assert!(s.contains("caret=0x0"));
        assert!(s.contains("focus_is_fg=true"));
    }

    #[test]
    fn a_refused_verdict_reports_its_code_without_injecting_anything() {
        // Projection, not execution: refusal_for is a pure policy function, this proves the diagnostic merely 「asks how it would rule」.
        assert_eq!(
            refusal_for(super::super::target_probe::FocusInputState::NotInput),
            Some(crate::error_codes::INJECT_NO_TEXT_TARGET)
        );
    }
}

/// The V2-01 diagnostic command. **Read-only** —— it does not inject, does not activate
/// a window, does not send any keystroke.
///
/// Placed here rather than in `shell/mod.rs`: that file is already exactly 800 lines,
/// right against the line cap.
///
/// Usage (owner settled it 2026-07-28: 「you run the program, I'll do the clicking」):
///   ① Press the button in FlowMic → the frontend starts a countdown
///   ② During the countdown, **switch to the target program and click into its input box** (Claude Code / Terminal / vim …)
///   ③ When the countdown ends this command samples, and the result comes back into the FlowMic window
///
/// ⚠️ The countdown runs on the **frontend** rather than a sleep here: the sampling has
/// to happen after the owner has already switched away, or what gets measured is always
/// FlowMic itself —— a diagnostic that looks like it runs but is actually completely
/// uninformative. The frontend also has to show the remaining seconds during the
/// countdown, otherwise the user does not know when to switch windows.
///
/// v0.2.1 fix: this `#[tauri::command]` originally had no `app`-feature gate, while
/// `inject/` is compiled unconditionally —— so `cargo test` (without features) had been
/// failing to compile outright since V2-01. The consequence was not 「a few fewer tests
/// ran」, it was that **not a single Rust unit test for the entire injection layer was
/// running**, and that is exactly one of the three areas CLAUDE.md lists as requiring
/// line-by-line human audit. The gate follows the same pattern as `pub mod shell` in
/// lib.rs.
#[cfg(feature = "app")]
#[tauri::command]
pub fn focus_diagnostic() -> FocusDiagnostic {
    let snap = snapshot();
    // Also goes to forensic —— even a diagnostic nobody copied out should leave a trace in the log.
    crate::forensic::record("probe", &snap.one_line());
    snap
}

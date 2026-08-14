// SPEC-REF:
//   docs/strategy/2026-07-30-inject-state-narrowing-design.md §2
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (inject pipeline stages)
//   CLAUDE.md red line: no silent failures — both directions are forbidden
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// THE GATE'S JOB CHANGED (owner 2026-07-30).
//
// It used to be a PREDICTION: 「will this injection succeed?」 — asked of UI
// Automation, and the answer decided whether a key was ever sent. That geometry
// collapsed twice in two days: first every browser dictation was refused
// (a lazily-built Chromium a11y tree hands back the window frame, which the code
// read as 「no text target」), then the fix let text through and the read-back
// called the landed text 「未注入」 ("not injected"). Both P0s stood on the same wrong footing —
// asking the platform for evidence it does not hand out.
//
// The new definition of `injected` (see the decision log) is 「已送到键盘焦点，
// 且当时焦点处于可输入状态」 ("delivered to the keyboard focus, and the focus was
// in an input-capable state at the time"), and its three pieces of evidence are all in hand
// BEFORE the keystroke. So this gate no longer decides truth. Its only remaining
// job is 「别搞坏东西」 ("don't break anything"): a synthetic character landing outside an input site is not
// merely lost, it fires the app's single-key accelerators (a browser's `/` and
// `?`, space-to-page-down, an editor's command palette). That is the one harm
// worth a check, and it is a much smaller claim than the old one.
//
// ── DEFAULT = TYPE, and this is not laziness ─────────────────────────────────
//
// Of the two possible errors, 「本来能行却拒绝」 ("refusing something that would
// actually have worked") takes the whole feature down —
// owner lost several days to exactly that — while 「没有焦点还打」 ("typing anyway
// when there is no focus") is occasional and
// recoverable, and the user pressing "speak" was trying to type SOMEWHERE anyway. So
// an inconclusive reading must never refuse. Every branch below that cannot prove
// harm returns `Unknown`, and `refusal_for(Unknown)` is `None`.
//
// ── WHAT WAS MEASURED, 2026-07-30 (card N1), and what it cost the design ─────
//
// The design named `ImmGetContext` as the criterion, on the sound reasoning that
// an IME does this every day. It was measured on this machine before being
// trusted, and the measurement is the important part of this file:
//
//   in-process  WinForms Form  -> ImmGetContext = 0x21f7183f (non-null)
//   in-process  WinForms Edit  -> ImmGetContext = 0x21f7183f (the SAME handle)
//   Notepad     RichEditD2DPT  -> ImmGetContext = 0            (focused, real edit!)
//   Cursor      Chrome_WidgetWin_1 -> 0        WPS  Qt5QWindowIcon -> 0
//   Explorer    DirectUIHWND   -> 0
//   360ChromeX, <input autofocus> FOCUSED  -> focus=Chrome_WidgetWin_1 caret≠0 himc=0
//   360ChromeX, NOTHING focused (blank page) -> focus=Chrome_WidgetWin_1 caret≠0 himc=0
//
// Two conclusions, both load-bearing:
//   ① An IMM32 input context is a PROCESS-PRIVATE handle. The injector is never
//      the target's process, so `ImmGetContext` on a target window returns null
//      no matter how obviously typeable the target is. Reading that null as
//      「不能输入」 ("cannot receive input") would refuse 100% of injections — the 0.2.19 P0 again, worse.
//      Hence null ⇒ `Unknown` ⇒ type. Non-null stays a POSITIVE signal only.
//   ② The decisive pair — a browser with an input focused vs. the same browser
//      with nothing focused — is INDISTINGUISHABLE from outside the process:
//      same focus window, same class, both carets non-zero, both himc null. This
//      is the identical finding owner made for Cursor on 2026-07-28 (byte-
//      identical UIA readings in vs. out of the input box), now confirmed for
//      IMM and for the browser. **The blank-page case cannot be caught by any
//      out-of-process criterion**, and the honest thing is to say so rather than
//      ship a check that pretends to. An IME can do it because it runs INSIDE the
//      target (that is RV-45, 「自己成为输入法」 ("become the input method itself")), not because it asks better.
//
// The `ImmGetContext` call is kept anyway, deliberately, and NOT as a façade: it
// is a positive-only signal, it costs one syscall on a path that is already
// switching windows, and every injection records the raw handle on the forensic
// line. So 「它永远是 null」 ("it is always null") keeps being re-measured in the field instead of resting
// on my one afternoon of probing — if some target ever answers, the log says so.
//
// ── what CAN be proved from outside, and is therefore the whole refusal set ───
//
//   · `GetGUIThreadInfo` succeeded and `hwndFocus == 0` — no window in the active
//     thread holds keyboard focus, so WM_KEY* has nowhere to go. Provable.
//   · the thread is in MENU mode / a popup menu / an interactive move-resize —
//     keystrokes there are mnemonics and drag-cancels, i.e. exactly the
//     destructive case this gate exists for. Provable, and cross-process readable.
//
// Everything else types. When `GetGUIThreadInfo` cannot answer at all we land on
// `Unknown` and type anyway; a keystroke that is then swallowed is reported as a
// failure by the SendInput call itself, never as a false claim (design §2).
//
// 🔴 CORRECTION 2026-08-02 (F1b spike) — anti-façade rule ④, 「a stale truth」.
// This paragraph used to read 「An elevated target makes GetGUIThreadInfo fail」.
// **It does not.** 【measured】A process whose mandatory label was genuinely dropped to
// Medium (`SetTokenInformation(TokenIntegrityLevel)` — NOT `runas /trustlevel`,
// which leaves integrity at High) queried a High-integrity target and got
// `guiOk=True err=0`; across four scenarios its readings were identical to the
// High prober's, down to the `rcCaret` numbers.
// Anchor: `docs/strategy/2026-08-02-f1b-universal-focus-probe-matrix.md` §2.2 ①.
// ⇒ **`gui_ok == false` is NOT reached because the target is elevated.** Do not
//   reach for elevation when explaining that branch.
// ⚠️ Only the READ half was falsified. **Whether `SendInput` into an elevated
//   window is blocked by UIPI was not tested** (same report §7-4) — this
//   correction must not be read as 「UIPI does not block it」.

use crate::error_codes;

/// What the OS could be made to say about the current keyboard focus.
///
/// Three values because there are three genuinely different situations, and
/// collapsing any two of them is how both of this week's P0s were built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusInputState {
    /// Positively identified as an input site (an IMM context we could actually
    /// read). Type.
    Input,
    /// PROVABLY not an input site: nothing holds keyboard focus, or the thread is
    /// in menu / move-size mode. Refuse — this is the destructive case.
    NotInput,
    /// No conclusion. Our instrument, not a verdict about the target. Type.
    Unknown,
}

/// The probe seam: production passes [`focused_input_state`], tests pass a fake.
///
/// Kept as a `fn` pointer with the real implementation supplied at every
/// production call site (`pipeline::inject_text` / `inject_image`). Deliberately
/// NOT a defaulted trait object with a friendly no-op — doc 13 §7 F1 ②: a DI
/// default must be the real thing or must throw, because the day it silently
/// answers 「nothing focused, all good」 is the day injection quietly stops.
pub type TargetProbe = fn() -> FocusInputState;

/// `GUITHREADINFO.flags` bits that mean 「keystrokes here do something other than
/// type」. Mirrored as plain `u32` so [`classify_focus`] stays pure and testable
/// on the Linux CI toolchain, which has no `windows` crate.
///
/// GUI_INMOVESIZE(0x2): the user is dragging/sizing a window — ESC cancels it and
/// characters go nowhere. GUI_INMENUMODE(0x4) / GUI_SYSTEMMENUMODE(0x8) /
/// GUI_POPUPMENUMODE(0x10): a menu is up, so every character is a MNEMONIC. That
/// is the concrete 「breaking things」 this gate is for.
pub const GUI_FLAGS_NOT_TYPING: u32 = 0x2 | 0x4 | 0x8 | 0x10;

/// The whole judgement, pure — the part that would silently rot if someone later
/// 「simplified」 the fall-through, and the only part a unit test can reach (the
/// three Win32 reads around it need a real focused desktop).
///
/// * `gui_ok` — did `GetGUIThreadInfo` answer at all? (🔴 **not** 「the target is
///   elevated」 — that reason was measured false, see the module note's 2026-08-02
///   correction; false here means only 「we could not ask」)
/// * `gui_flags` — its raw flags word
/// * `focus_hwnd` — the focus window it reported; 0 = none
/// * `ime_context` — `Some(true)`/`Some(false)` = `ImmGetContext` ran and did /
///   did not return a handle; `None` = we never got to ask.
///
/// Note the asymmetry, which is the design's 「不确定时不许拒绝」 ("must not refuse
/// when uncertain") written out:
/// `Some(false)` does NOT reach `NotInput`. It cannot, because an IMM handle is
/// process-private and null is what a perfectly typeable foreign window returns
/// (see the module note's measurements).
pub fn classify_focus(
    gui_ok: bool,
    gui_flags: u32,
    focus_hwnd: u64,
    ime_context: Option<bool>,
) -> FocusInputState {
    // Our instrument failed. Says nothing about the target.
    if !gui_ok {
        return FocusInputState::Unknown;
    }
    // Menu / move-size: proved harmful, and the reason this gate still exists.
    if gui_flags & GUI_FLAGS_NOT_TYPING != 0 {
        return FocusInputState::NotInput;
    }
    // Nobody holds keyboard focus → WM_KEY* has no destination. Proved useless.
    if focus_hwnd == 0 {
        return FocusInputState::NotInput;
    }
    match ime_context {
        // The one positive we can ever get. Only reachable when the focused
        // window belongs to US (measured: cross-process always answers null).
        Some(true) => FocusInputState::Input,
        // Null, or never asked. Not evidence of anything → type.
        Some(false) | None => FocusInputState::Unknown,
    }
}

/// Should the TEXT injection be refused, and under which code?
///
/// Only [`FocusInputState::NotInput`] refuses, and only because typing there is
/// destructive rather than merely futile. `Unknown` never refuses — see the
/// module note on why that direction of error is the cheaper one.
pub fn refusal_for(state: FocusInputState) -> Option<&'static str> {
    match state {
        FocusInputState::NotInput => Some(error_codes::INJECT_NO_TEXT_TARGET),
        FocusInputState::Input | FocusInputState::Unknown => None,
    }
}

/// v0.2.9 — the same question asked for a PICTURE, which is a different act, and
/// the answer has been 「never refuse」 since owner 2026-07-29
/// (`docs/decisions/2026-07-29-image-target-policy-differs-from-text.md`).
///
/// A picture is delivered by Ctrl+V, and what accepts an image paste is far wider
/// than what accepts typed characters — chat composers, canvases, rich editors,
/// file panes. And unlike a stray character, a stray Ctrl+V is not an accelerator
/// storm. So the destructive-case argument that keeps the text gate alive does not
/// apply here, and refusing was costing owner every single send.
///
/// The state is still READ, so the forensic line can say what the focus looked
/// like when a paste went unconsumed instead of leaving the next reader to guess.
pub fn image_refusal_for(_state: FocusInputState) -> Option<&'static str> {
    None
}

/// The PROTOCOL token for `inject:result.focus_evidence` (IJ-01, owner's
/// 2026-08-07 ruling ④ — docs/decisions/2026-08-07-owner-inject-status-wording-
/// evidence-and-window-title.md).
///
/// 🔴 ABSENCE IS NOT ONE OF THESE THREE, and that is the whole discipline of this
/// field. `unknown` means 「我们问了，答不出来」 ("we asked, but got no answer"); a path that never reached Stage 1b
/// writes NO KEY AT ALL. Collapsing the two would re-tell the exact lie
/// `gui_ok == false` exists to avoid above ("could not be asked" vs "genuinely absent"), and the one the
/// MSAA spike restated for `d=0 CLIENT`
/// (docs/strategy/2026-08-07-ij03-msaa-focus-editability-spike.md §2.2-3).
///
/// ⚠️ DELIBERATELY NOT [`state_name`] REUSED. That one is a HUMAN token on a
/// forensic line and may be reworded by anyone reading a log; this one is a wire
/// value three ends parse. One function answering both questions is how a log
/// tidy-up would silently become a protocol change.
///
/// 🔴 CORRECTED BY IJ-05 (2026-08-08). This used to read 「TODAY `editable` CAN ONLY
/// COME FROM OUR OWN WINDOW … every third-party app reads `unknown` until the MSAA
/// probe is wired」. Both halves have to go:
///   · the second half was ALREADY false when it was written, and it is the exact
///     sentence the task book §1-bis-15 caught — a third-party window reads `not_editable`
///     whenever Stage 1b PROVES it (menu mode, or nothing holds keyboard focus).
///     `pipeline.rs` was corrected; this copy and one other survived, which is
///     §1-bis-14 (a red list is a sample) landing on the very sentence the rule was
///     derived from;
///   · the first half is now out of date too: `inject::msaa_focus` is wired, and a
///     third-party window can reach `Input`/`editable` through it.
///
/// ⚠️ What remains true and must not be dropped: `ImmGetContext` itself is still
/// process-private and still answers null cross-process, so THIS function never
/// returns `Input` for a foreign window. The upgrade happens one layer up, on the
/// REPORT binding in `pipeline.rs`, and never on the gate.
pub fn wire_evidence(state: FocusInputState) -> &'static str {
    match state {
        FocusInputState::Input => "editable",
        FocusInputState::NotInput => "not_editable",
        FocusInputState::Unknown => "unknown",
    }
}

/// A short human name for the state, used by the forensic line and the read-only
/// focus diagnostic. Not a wire value.
pub fn state_name(state: FocusInputState) -> &'static str {
    match state {
        FocusInputState::Input => "Input",
        FocusInputState::NotInput => "NotInput",
        FocusInputState::Unknown => "Unknown",
    }
}

/// Everything the three Win32 reads saw, as data — so the classification above
/// stays pure and the forensic line can print the RAW numbers rather than only
/// the conclusion (2026-07-30: the refusal that started this had a log line
/// carrying the conclusion and none of the evidence, which made two opposite
/// hypotheses indistinguishable for two days).
#[derive(Debug, Clone)]
pub struct FocusEvidence {
    pub gui_ok: bool,
    pub gui_flags: u32,
    pub focus_hwnd: u64,
    pub caret_hwnd: u64,
    /// `ImmGetContext` raw handle as a number. `Some(0)` = it answered null,
    /// `None` = never asked. Logged verbatim so 「cross-process is always null」
    /// keeps being verified in the field instead of trusted from one probe run.
    pub imm_context: Option<u64>,
    pub focus_class: String,
}

impl FocusEvidence {
    /// The state this evidence implies.
    pub fn state(&self) -> FocusInputState {
        classify_focus(
            self.gui_ok,
            self.gui_flags,
            self.focus_hwnd,
            self.imm_context.map(|h| h != 0),
        )
    }

    /// One copy-pasteable line. Names every field; no field is inferred.
    pub fn one_line(&self) -> String {
        format!(
            "state={} gui_ok={} flags=0x{:x} focus=0x{:x} class={} caret=0x{:x} himc={}",
            state_name(self.state()),
            self.gui_ok,
            self.gui_flags,
            self.focus_hwnd,
            if self.focus_class.is_empty() {
                "(none)"
            } else {
                &self.focus_class
            },
            self.caret_hwnd,
            match self.imm_context {
                Some(h) => format!("0x{h:x}"),
                None => "(not asked)".to_string(),
            },
        )
    }
}

/// Read the focus evidence off the OS. Read-only: no window is activated, no key
/// is sent, no clipboard is touched.
#[cfg(windows)]
pub fn focus_evidence() -> FocusEvidence {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::Ime::{ImmGetContext, ImmReleaseContext};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
        GUITHREADINFO,
    };

    // SAFETY: every call is a read of window-manager state plus one paired
    // ImmGetContext/ImmReleaseContext. The out-param is a locally owned struct
    // with cbSize set; no handle or pointer outlives this function.
    unsafe {
        let mut ev = FocusEvidence {
            gui_ok: false,
            gui_flags: 0,
            focus_hwnd: 0,
            caret_hwnd: 0,
            imm_context: None,
            focus_class: String::new(),
        };

        let fg: HWND = GetForegroundWindow();
        if fg.0.is_null() {
            // No foreground window at all. Stage 1 already refuses this case as
            // INJECT_FOCUS_LOST (cached, retryable); reporting `Unknown` here
            // keeps the two answers from racing to describe the same fact.
            return ev;
        }
        let tid = GetWindowThreadProcessId(fg, None);
        if tid == 0 {
            return ev;
        }
        let mut gui = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui).is_err() {
            // The query could not be answered. `gui_ok` stays false so the reader
            // knows the zeros below mean 「could not be asked」 and not 「genuinely
            // absent」 — two
            // completely different facts (probe_diag has carried this same warning
            // since V2-01).
            // 🔴 This used to say 「An elevated target refuses the query」. Measured
            // false 2026-08-02 — see the module note's correction. We no longer
            // claim to know WHY it failed, because we do not.
            return ev;
        }
        ev.gui_ok = true;
        ev.gui_flags = gui.flags.0;
        ev.focus_hwnd = gui.hwndFocus.0 as u64;
        ev.caret_hwnd = gui.hwndCaret.0 as u64;

        if !gui.hwndFocus.0.is_null() {
            let mut buf = [0u16; 128];
            let n = GetClassNameW(gui.hwndFocus, &mut buf);
            if n > 0 {
                ev.focus_class = String::from_utf16_lossy(&buf[..n as usize]);
            }
            let himc = ImmGetContext(gui.hwndFocus);
            ev.imm_context = Some(himc.0 as u64);
            if !himc.0.is_null() {
                // Paired release — ImmGetContext hands out a reference even when
                // the caller only wanted to know it exists.
                let _ = ImmReleaseContext(gui.hwndFocus, himc);
            }
        }
        ev
    }
}

/// Non-Windows builds (the Linux CI toolchain) have no window manager to ask, so
/// nothing is ever proved and by policy we type.
#[cfg(not(windows))]
pub fn focus_evidence() -> FocusEvidence {
    FocusEvidence {
        gui_ok: false,
        gui_flags: 0,
        focus_hwnd: 0,
        caret_hwnd: 0,
        imm_context: None,
        focus_class: String::new(),
    }
}

/// The production probe: read the evidence, record it, return the state.
///
/// The forensic line is written on EVERY injection, not only on refusals. That is
/// the correction for 2026-07-30: when only failures were logged there was no
/// baseline to compare a false refusal against, and the two candidate root causes
/// stayed indistinguishable for two days. One line per utterance is cheap; a
/// second UIA/IMM round-trip after the fact (what the old code did) is not.
pub fn focused_input_state() -> FocusInputState {
    let ev = focus_evidence();
    let state = ev.state();
    crate::forensic::record("inject", &format!("stage1b {}", ev.one_line()));
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provable_non_input_site_is_refused_with_the_named_code() {
        assert_eq!(
            refusal_for(FocusInputState::NotInput),
            Some(error_codes::INJECT_NO_TEXT_TARGET)
        );
    }

    #[test]
    fn a_positively_identified_input_site_types() {
        assert_eq!(refusal_for(FocusInputState::Input), None);
    }

    #[test]
    fn an_inconclusive_reading_must_not_break_injection() {
        // The 0.2.19 P0 in one assertion: refusing on 「我判不出来」 ("I can't tell") refuses every
        // browser dictation, because from outside the process a browser with an
        // input focused is indistinguishable from one with nothing focused.
        assert_eq!(refusal_for(FocusInputState::Unknown), None);
    }

    /// The measurement that reshaped the design, pinned as a table. An IMM handle
    /// is PROCESS-PRIVATE: Notepad's genuinely focused RichEditD2DPT answers null
    /// to a foreign `ImmGetContext`, exactly as an unfocused browser page does. If
    /// someone later reads `Some(false)` as 「不能输入」 ("cannot receive input"), injection stops working
    /// everywhere — so it is asserted here rather than left to the comment.
    #[test]
    fn a_null_ime_context_is_never_a_refusal() {
        for flags in [0u32, 0x1 /* GUI_CARETBLINKING is not a typing verdict */] {
            let state = classify_focus(true, flags, 0x1234, Some(false));
            assert_eq!(
                state,
                FocusInputState::Unknown,
                "cross-process ImmGetContext always answers null (measured: Notepad's own \
                 focused edit control included) — reading that as 「不能输入」 refuses 100% \
                 of injections"
            );
            assert_eq!(refusal_for(state), None);
        }
        // Never asked is likewise not evidence.
        assert_eq!(
            classify_focus(true, 0, 0x1234, None),
            FocusInputState::Unknown
        );
    }

    #[test]
    fn a_readable_ime_context_is_the_one_positive_signal() {
        assert_eq!(
            classify_focus(true, 0, 0x1234, Some(true)),
            FocusInputState::Input
        );
    }

    #[test]
    fn nothing_holding_keyboard_focus_is_a_provable_refusal() {
        // hwndFocus == 0 with gui_ok == true is a real reading: WM_KEY* has no
        // destination. This is one of only two things provable from outside.
        let state = classify_focus(true, 0, 0, Some(false));
        assert_eq!(state, FocusInputState::NotInput);
        assert_eq!(
            refusal_for(state),
            Some(error_codes::INJECT_NO_TEXT_TARGET)
        );
        // …but the SAME zero with gui_ok == false is 「could not be asked」, not 「genuinely absent」.
        // Whatever produced that silence lands here and must still be typed into.
        // 🔴 It is NOT 「an elevated target」 — measured false 2026-08-02, see the
        // module note. The rule this test pins never depended on the reason.
        assert_eq!(classify_focus(false, 0, 0, None), FocusInputState::Unknown);
        assert_eq!(refusal_for(classify_focus(false, 0, 0, None)), None);
    }

    /// The gate's remaining reason to exist: a menu is up, so every character is
    /// a mnemonic. Kept deliberately narrow — each bit added here widens what
    /// gets refused, and a false refusal is the expensive direction.
    #[test]
    fn menu_and_move_size_modes_refuse_because_typing_there_is_destructive() {
        for flags in [
            0x2,  // GUI_INMOVESIZE
            0x4,  // GUI_INMENUMODE
            0x8,  // GUI_SYSTEMMENUMODE
            0x10, // GUI_POPUPMENUMODE
            0x4 | 0x1,
        ] {
            assert_eq!(
                classify_focus(true, flags, 0x1234, Some(true)),
                FocusInputState::NotInput,
                "flags 0x{flags:x} means keystrokes are mnemonics, not text — and this \
                 outranks even a positive IMM context"
            );
        }
        // A blinking caret is NOT one of those bits: it is present in a focused
        // browser page AND in an unfocused one (measured 2026-07-30), so keying
        // anything to it manufactures verdicts out of noise.
        assert_eq!(
            classify_focus(true, 0x1, 0x1234, Some(true)),
            FocusInputState::Input
        );
    }

    /// IJ-01 — the three wire tokens, pinned as a table.
    ///
    /// Written as an exhaustive `match` over the enum rather than three asserts so
    /// a fourth state cannot be added without deciding what it is CALLED on the
    /// wire; and asserted against literals rather than against `state_name` so the
    /// two tokens stay two answers to two questions (a log rename must not move a
    /// protocol value).
    #[test]
    fn every_focus_state_has_exactly_one_wire_token_and_it_is_not_the_log_token() {
        assert_eq!(wire_evidence(FocusInputState::Input), "editable");
        assert_eq!(wire_evidence(FocusInputState::NotInput), "not_editable");
        assert_eq!(wire_evidence(FocusInputState::Unknown), "unknown");
        // Distinct: two states that print the same token are one state on the wire.
        let all = [
            FocusInputState::Input,
            FocusInputState::NotInput,
            FocusInputState::Unknown,
        ];
        for (i, a) in all.iter().enumerate() {
            for b in all.iter().skip(i + 1) {
                assert_ne!(wire_evidence(*a), wire_evidence(*b));
            }
            // …and the wire token is NOT the forensic token, which is what keeps
            // 「rewording the log」 from becoming 「changing the protocol」.
            assert_ne!(wire_evidence(*a), state_name(*a));
        }
    }

    #[test]
    fn the_image_policy_never_refuses_whatever_the_text_policy_says() {
        for state in [
            FocusInputState::Input,
            FocusInputState::NotInput,
            FocusInputState::Unknown,
        ] {
            assert_eq!(
                image_refusal_for(state),
                None,
                "a picture is pasted, not typed — owner 2026-07-29 ruling"
            );
        }
        // The two policies really are different, and only for NotInput.
        assert_eq!(
            refusal_for(FocusInputState::NotInput),
            Some(error_codes::INJECT_NO_TEXT_TARGET)
        );
    }

    #[test]
    fn the_forensic_line_prints_evidence_not_only_the_conclusion() {
        let ev = FocusEvidence {
            gui_ok: true,
            gui_flags: 0x1,
            focus_hwnd: 0x3701056,
            caret_hwnd: 0x3701056,
            imm_context: Some(0),
            focus_class: "Chrome_WidgetWin_1".to_string(),
        };
        let line = ev.one_line();
        // Every raw number must be readable off the line: 「state=NotInput」 alone
        // is what made the two root causes indistinguishable for two days.
        assert!(line.contains("state=Unknown"), "{line}");
        assert!(line.contains("focus=0x3701056"), "{line}");
        assert!(line.contains("class=Chrome_WidgetWin_1"), "{line}");
        assert!(line.contains("himc=0x0"), "{line}");
        assert!(line.contains("flags=0x1"), "{line}");

        // …and 「never asked」 must not be printable as 「asked, got null」.
        let unasked = FocusEvidence {
            imm_context: None,
            ..ev.clone()
        };
        assert!(unasked.one_line().contains("himc=(not asked)"));
    }

    #[test]
    fn an_empty_class_name_reads_as_none_rather_than_a_blank() {
        let ev = FocusEvidence {
            gui_ok: false,
            gui_flags: 0,
            focus_hwnd: 0,
            caret_hwnd: 0,
            imm_context: None,
            focus_class: String::new(),
        };
        assert!(ev.one_line().contains("class=(none)"));
        assert_eq!(ev.state(), FocusInputState::Unknown);
    }
}

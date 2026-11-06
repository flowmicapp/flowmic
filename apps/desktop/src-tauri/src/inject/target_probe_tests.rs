// Unit tests for `inject/target_probe.rs`, moved VERBATIM (de-indented one
// level) out of its inline `mod tests` so the probe stays under the 800-line
// source cap (D-MKT-6b). Wired from target_probe.rs by `#[path]`.

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
        foreground_class: "Chrome_WidgetWin_1".to_string(),
        fg_hwnd: 0,
        fg_thread: FgThreadRead::NotAsked,
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
        foreground_class: String::new(),
        fg_hwnd: 0,
        fg_thread: FgThreadRead::NotAsked,
    };
    assert!(ev.one_line().contains("class=(none)"));
    assert!(ev.one_line().contains("fg_class=(none)"));
    assert_eq!(ev.state(), FocusInputState::Unknown);
}

/// D-MKT-6, the field reading itself (Windows 10 19045, powershell.exe 5.1 in
/// conhost, 14/14 refused): `stage1b state=NotInput gui_ok=true flags=0x0
/// focus=0x0 … caret=0x50562`. For a console window that thread is the inner
/// program's, not the window's keyboard thread, so 「focus=0」 proves nothing
/// ⇒ it must type, as cmd always has.
#[test]
fn a_console_window_whose_inner_thread_reports_no_focus_is_not_refused() {
    let ev = FocusEvidence {
        gui_ok: true,
        gui_flags: 0,
        focus_hwnd: 0,
        caret_hwnd: 0x50562,
        imm_context: None,
        focus_class: String::new(),
        foreground_class: CONSOLE_WINDOW_CLASS.to_string(),
        fg_hwnd: 0,
        fg_thread: FgThreadRead::NotAsked,
    };
    assert_eq!(ev.state(), FocusInputState::Unknown);
    assert_eq!(refusal_for(ev.state()), None);
    let line = ev.one_line();
    assert!(line.contains("state=Unknown"), "{line}");
    assert!(line.contains("fg_class=ConsoleWindowClass"), "{line}");
    // Same answer from the pure rule, and class names are case-insensitive.
    for class in ["ConsoleWindowClass", "consolewindowclass"] {
        assert_eq!(
            classify_focus_in(class, true, 0, 0, None, None),
            FocusInputState::Unknown,
            "{class}"
        );
    }
    // cmd's usual reading (query failed) is unchanged: Unknown either way.
    assert_eq!(
        classify_focus_in(CONSOLE_WINDOW_CLASS, false, 0, 0, None, None),
        FocusInputState::Unknown
    );
}

/// The scope fence. A false refusal is the expensive direction, but widening
/// the allow rule beyond the one class whose thread reading is MEASURED to be
/// someone else's would turn a provable 「nothing has focus」 into typing into
/// accelerators. Every other class keeps the old refusal.
#[test]
fn the_console_exception_does_not_reach_any_other_window_class() {
    for class in [
        "",
        "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal: own thread, focus reads normally
        "PseudoConsoleWindow",           // ConPTY: never the foreground window
        "mintty",
        "PuTTY",
        "Chrome_WidgetWin_1",
        "Notepad",
        "ConsoleWindowClassX",
        "ConsoleWindow",
    ] {
        let state = classify_focus_in(class, true, 0, 0, Some(false), None);
        assert_eq!(state, FocusInputState::NotInput, "class {class:?}");
        assert_eq!(
            refusal_for(state),
            Some(error_codes::INJECT_NO_TEXT_TARGET),
            "class {class:?}"
        );
    }
    assert!(!is_console_window_class("CASCADIA_HOSTING_WINDOW_CLASS"));
    assert!(!is_console_window_class("PseudoConsoleWindow"));
}

/// The exception narrows the 「nothing has focus」 refusal only; the menu /
/// move-size refusal is a different reading and this card does not move it.
/// ⚠️ These inner-thread flags are never set in the field (measured, D-MKT-6b:
/// the console's menu lives on conhost's thread) — the case that actually
/// happens is pinned by
/// `a_console_window_with_its_system_menu_or_move_mode_open_is_refused`.
#[test]
fn a_console_window_in_menu_or_move_size_mode_is_still_refused() {
    for flags in [0x2u32, 0x4, 0x8, 0x10] {
        for focus in [0u64, 0x1234] {
            assert_eq!(
                classify_focus_in(CONSOLE_WINDOW_CLASS, true, flags, focus, None, None),
                FocusInputState::NotInput,
                "flags 0x{flags:x} focus 0x{focus:x}"
            );
        }
    }
    // And a console window with a reported focus takes the ordinary rule.
    assert_eq!(
        classify_focus_in(CONSOLE_WINDOW_CLASS, true, 0, 0x1234, Some(false), None),
        FocusInputState::Unknown
    );
}

/// The field reading that types into a menu (D-MKT-6b, round 4 on Windows 10
/// 19045, PowerShell 5.1 in conhost, 3/3 typed and reported success; evidence
/// `.local/device-evidence/2026-11-05-mkt-fixverify4/M-altspace-psMed.json` and
/// `M-movesize-psMed.json`, mechanism re-measured on the same host with cmd).
/// FlowMic's own probe line: `stage1b state=Unknown gui_ok=true flags=0x0
/// focus=0x0 class=(none) caret=0xa05f4 … fg_class=ConsoleWindowClass`; at the
/// same moment the conhost thread (= `GetGUIThreadInfo(0)`) read `flags=0xc
/// active=0xa05f4 menuOwner=0xa05f4` (system menu) or `flags=0x2
/// moveSize=0xa05f4` (Move). Keystrokes there are menu input ⇒ refuse.
#[test]
fn a_console_window_with_its_system_menu_or_move_mode_open_is_refused() {
    const FG: u64 = 0xa05f4; // 656884, the console window in the evidence
    for fg_flags in [0xcu32 /* system menu */, 0x2 /* Move mode */] {
        let ev = FocusEvidence {
            gui_ok: true,
            gui_flags: 0,
            focus_hwnd: 0,
            caret_hwnd: FG,
            imm_context: None,
            focus_class: String::new(),
            foreground_class: CONSOLE_WINDOW_CLASS.to_string(),
            fg_hwnd: FG,
            fg_thread: FgThreadRead::Answered {
                flags: fg_flags,
                active_hwnd: FG,
            },
        };
        assert_eq!(ev.state(), FocusInputState::NotInput, "0x{fg_flags:x}");
        assert_eq!(
            refusal_for(ev.state()),
            Some(error_codes::INJECT_NO_TEXT_TARGET)
        );
        assert_eq!(wire_evidence(ev.state()), "not_editable");
        let line = ev.one_line();
        assert!(line.contains("state=NotInput"), "{line}");
        // Which thread's flags decided it must be readable off the line.
        assert!(line.contains("flags=0x0 focus=0x0"), "{line}");
        assert!(
            line.contains(&format!("fg_thread=flags=0x{fg_flags:x} active=0xa05f4 used=true")),
            "{line}"
        );
        // cmd: its inner thread cannot be asked at all (err=87) — same refusal.
        let cmd = FocusEvidence {
            gui_ok: false,
            caret_hwnd: 0,
            ..ev.clone()
        };
        assert_eq!(cmd.state(), FocusInputState::NotInput, "cmd 0x{fg_flags:x}");
    }
}

/// The foreground-thread reading only counts when it is about THIS window, and
/// it can only refuse — it never upgrades a console to `Input` (the allow rule
/// is not widened). A no-menu console (`GetGUIThreadInfo(0)` measured
/// `flags=0x0 active=focus=fg`) must still type.
#[test]
fn a_console_fg_thread_reading_counts_only_when_it_describes_the_foreground_window() {
    const FG: u64 = 0xa05f4;
    let base = FocusEvidence {
        gui_ok: true,
        gui_flags: 0,
        focus_hwnd: 0,
        caret_hwnd: FG,
        imm_context: None,
        focus_class: String::new(),
        foreground_class: CONSOLE_WINDOW_CLASS.to_string(),
        fg_hwnd: FG,
        fg_thread: FgThreadRead::Answered {
            flags: 0,
            active_hwnd: FG,
        },
    };
    // No menu: types, and the allow side is unchanged (Unknown, never Input).
    assert_eq!(base.state(), FocusInputState::Unknown);
    assert!(base.one_line().contains("fg_thread=flags=0x0 active=0xa05f4 used=true"));
    // The foreground changed between the two reads: the reading is void.
    let other = FocusEvidence {
        fg_thread: FgThreadRead::Answered {
            flags: 0xc,
            active_hwnd: 0x1234,
        },
        ..base.clone()
    };
    assert_eq!(other.state(), FocusInputState::Unknown);
    assert!(other.one_line().contains("used=false"), "{}", other.one_line());
    // The call failed / was never made: no refusal from it.
    for read in [FgThreadRead::NoAnswer, FgThreadRead::NotAsked] {
        let ev = FocusEvidence {
            fg_thread: read,
            ..base.clone()
        };
        assert_eq!(ev.state(), FocusInputState::Unknown, "{read:?}");
    }
    assert!(FocusEvidence {
        fg_thread: FgThreadRead::NoAnswer,
        ..base.clone()
    }
    .one_line()
    .contains("fg_thread=(no answer)"));
    assert_eq!(
        console_fg_thread_flags(
            CONSOLE_WINDOW_CLASS,
            0,
            FgThreadRead::Answered {
                flags: 0xc,
                active_hwnd: 0
            }
        ),
        None,
        "no foreground window ⇒ nothing to match"
    );
}

/// Scope fence for D-MKT-6b: no other window class consults the foreground
/// thread, even if a reading were somehow present.
#[test]
fn the_fg_thread_reading_never_reaches_other_window_classes() {
    let menu = FgThreadRead::Answered {
        flags: 0xc,
        active_hwnd: 0x1234,
    };
    for class in ["CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow", "Notepad", ""] {
        assert_eq!(console_fg_thread_flags(class, 0x1234, menu), None, "{class:?}");
        assert_eq!(
            classify_focus_in(class, true, 0, 0x1234, Some(false), Some(0xc)),
            FocusInputState::Unknown,
            "{class:?}"
        );
    }
    assert_eq!(
        console_fg_thread_flags(CONSOLE_WINDOW_CLASS, 0x1234, menu),
        Some(0xc)
    );
}

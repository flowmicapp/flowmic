// Tests for `inject/x11_paste_chord.rs` (D-MKT-2). Pure, so they run on every
// platform; the Linux-only wiring is proven in `inject/linux/terminal_paste_tests.rs`.
use super::*;

fn id(instance: &str, class: &str, exe: &str) -> X11WindowIdentity {
    X11WindowIdentity {
        wm_instance: instance.into(),
        wm_class: class.into(),
        exe: exe.into(),
    }
}

fn ctrl_v() -> KeyChord {
    KeyChord { vk: XK_V, modifiers: vec![XK_CONTROL_L] }
}

fn ctrl_shift_v() -> KeyChord {
    KeyChord { vk: XK_V, modifiers: vec![XK_CONTROL_L, XK_SHIFT_L] }
}

#[test]
fn the_measured_gnome_terminal_gets_its_own_paste_chord() {
    // The exact identity of the D-MKT-2 target (forensic + xdotool reading).
    let gnome = id("gnome-terminal-server", "Gnome-terminal", "gnome-terminal-server");
    let target = classify_x11_paste_target(&gnome);
    assert_eq!(target, X11PasteTarget::TerminalCtrlShiftV);
    assert_eq!(
        x11_paste_chord(target),
        ctrl_shift_v(),
        "Ctrl+V into GNOME Terminal reaches bash as quoted-insert: nothing lands"
    );
}

#[test]
fn every_listed_terminal_is_found_by_any_one_field() {
    for name in CTRL_SHIFT_V_TERMINALS {
        let capitalised = {
            let mut c = name.chars();
            c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
        };
        for probe in [
            id(name, "", ""),
            id("", &capitalised, ""),
            id("", "", name),
            id("", "", &name.to_ascii_uppercase()),
        ] {
            assert_eq!(
                classify_x11_paste_target(&probe),
                X11PasteTarget::TerminalCtrlShiftV,
                "{name}: {probe:?}"
            );
        }
    }
}

#[test]
fn a_python_hosted_terminal_is_found_by_wm_class_not_by_its_executable() {
    // Terminator's process is the Python interpreter.
    let terminator = id("terminator", "Terminator", "python3.10");
    assert_eq!(classify_x11_paste_target(&terminator), X11PasteTarget::TerminalCtrlShiftV);
}

#[test]
fn an_upgraded_binary_still_matches_by_its_executable() {
    // readlink(/proc/<pid>/exe) after the package was replaced on disk.
    let upgraded = id("", "", "gnome-terminal-server (deleted)");
    assert_eq!(classify_x11_paste_target(&upgraded), X11PasteTarget::TerminalCtrlShiftV);
}

#[test]
fn ordinary_targets_keep_exactly_the_old_chord() {
    // The four V-15 targets that took 5/5 before this card, plus an
    // unreadable identity. Their chord must stay byte-identical to the one
    // `inject/linux/paste.rs` hard-coded until now (XK_v + Control_L).
    for app in [
        id("gedit", "Gedit", "gedit"),
        id("libreoffice", "libreoffice-writer", "soffice.bin"),
        id("Navigator", "firefox", "firefox"),
        // VS Code (snap, measured 2026-11-05: WM_CLASS code_code/code_code,
        // exe code). Its integrated terminal shares this identity and does
        // NOT paste on Ctrl+V — measured too — but the editor decides here
        // (see the note on CTRL_SHIFT_V_TERMINALS).
        id("code_code", "code_code", "code"),
        id("code", "Code", "code"),
        X11WindowIdentity::default(),
    ] {
        let target = classify_x11_paste_target(&app);
        assert_eq!(target, X11PasteTarget::Ordinary, "{app:?}");
        assert_eq!(x11_paste_chord(target), ctrl_v(), "{app:?}");
    }
    assert_eq!(ctrl_v(), KeyChord { vk: 0x0076, modifiers: vec![0xFFE3] });
}

#[test]
fn xterm_family_never_gets_ctrl_shift_v() {
    // In xterm Ctrl+Shift+V is the same ^V as Ctrl+V. A well-meant
    // extension of the terminal list would add xterm and fix nothing.
    for app in [
        id("xterm", "XTerm", "xterm"),
        id("uxterm", "UXTerm", "xterm"),
        id("urxvt", "URxvt", "urxvt"),
    ] {
        let target = classify_x11_paste_target(&app);
        assert_eq!(target, X11PasteTarget::TerminalWithoutClipboardKey, "{app:?}");
        assert_ne!(x11_paste_chord(target), ctrl_shift_v(), "{app:?}");
        assert_eq!(x11_paste_chord(target), ctrl_v(), "unchanged pending MAIN: {app:?}");
    }
}

#[test]
fn near_misses_are_not_terminals() {
    for app in [
        id("stellarium", "Stellarium", "stellarium"),
        id("terminal", "Terminal", "terminal"),
        id("konsolex", "", ""),
        id("", "", "gnome-terminal-server-helper"),
        id("xterm-256color", "", ""),
    ] {
        assert_eq!(classify_x11_paste_target(&app), X11PasteTarget::Ordinary, "{app:?}");
    }
}

#[test]
fn the_two_lists_are_disjoint_and_lowercase() {
    for name in CTRL_SHIFT_V_TERMINALS.iter().chain(NO_CLIPBOARD_KEY_TERMINALS) {
        assert_eq!(*name, name.to_ascii_lowercase(), "{name}");
    }
    for name in CTRL_SHIFT_V_TERMINALS {
        assert!(
            !NO_CLIPBOARD_KEY_TERMINALS.iter().any(|n| n.eq_ignore_ascii_case(name)),
            "{name} is on both lists"
        );
    }
}

#[test]
fn each_target_kind_logs_a_distinct_phrase() {
    let phrases = [
        X11PasteTarget::Ordinary.forensic_phrase(),
        X11PasteTarget::TerminalCtrlShiftV.forensic_phrase(),
        X11PasteTarget::TerminalWithoutClipboardKey.forensic_phrase(),
    ];
    for (i, a) in phrases.iter().enumerate() {
        assert!(a.starts_with("chord="), "{a}");
        for b in phrases.iter().skip(i + 1) {
            assert_ne!(a, b);
        }
    }
}

#[test]
fn only_the_terminal_arm_waits_for_the_clipboard_reread() {
    // Ordinary targets keep the V-15 timing byte for byte; the measured race
    // is the terminal's, and the xterm arm keeps its old behaviour entirely.
    assert!(X11PasteTarget::TerminalCtrlShiftV.waits_for_clipboard_reread());
    assert!(!X11PasteTarget::Ordinary.waits_for_clipboard_reread());
    assert!(!X11PasteTarget::TerminalWithoutClipboardKey.waits_for_clipboard_reread());
}

#[test]
fn a_request_is_matched_to_the_target_by_its_x_client() {
    // Ids logged on todigg68 during one paste into the GNOME Terminal fixture
    // (2026-11-05, debug run): fixture window 0x320000B; TARGETS requestors
    // 0x3200476 (same client as the fixture), 0x4003b8, 0x1a00002, 0x2400002,
    // 0x300079f; UTF8_STRING requestor 0x4003b9 (the clipboard manager's
    // fetch at the ownership timestamp, before any key).
    let terminal_window = 0x0320_000B_u64;
    assert!(same_x_client(0x0320_0476, terminal_window));
    assert!(same_x_client(terminal_window, terminal_window));
    for other in [0x0040_03B8_u64, 0x0040_03B9, 0x01A0_0002, 0x0240_0002, 0x0300_079F] {
        assert!(!same_x_client(other, terminal_window), "{other:#x}");
    }
    // A missing id never matches (an unknown requestor is not the target).
    assert!(!same_x_client(0, terminal_window));
    assert!(!same_x_client(terminal_window, 0));
}

// The settle cap: measured reaction 4–5 ms idle; the cap must leave room for a
// busy terminal (at least 50× that) yet stay far below the 2500 ms clipboard
// hold that follows. Checked at compile time.
const _: () = assert!(TERMINAL_SETTLE_CAP_MS >= 250);
const _: () = assert!(TERMINAL_SETTLE_CAP_MS + TERMINAL_SETTLE_GRACE_MS < 2500);

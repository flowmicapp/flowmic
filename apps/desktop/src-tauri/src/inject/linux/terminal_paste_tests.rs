// SPEC-REF: D-MKT-2 (docs/marketing/05b-defects-found.md). Real X server, real
// window properties, real XTEST, and for the second test a real GNOME Terminal
// running bash. Missing fixture evidence is a failure, never a skip.
//
// The pure decision is proven in `inject/x11_paste_chord.rs` on every platform.
// These two prove what only Linux can: that the identity is read from the X
// server the way the decision expects, and that `Owner::paste` really presses
// the chosen chord into the target — the second one goes red if `paste.rs` is
// reverted to the hard-coded Ctrl+V.
use super::selection::Owner;
use crate::inject::x11_paste_chord::{
    classify_x11_paste_target, x11_paste_chord, X11PasteTarget, XK_CONTROL_L, XK_SHIFT_L, XK_V,
};
use crate::inject::{self, ClipboardFallbackClient, KeyChord};
use std::time::{Duration, Instant};
use x11_dl::xlib;

fn set_string(owner: &Owner, window: xlib::Window, name: &str, value: &[u8]) {
    let atom = owner.connection.atom(name).unwrap();
    unsafe {
        (owner.connection.api.XChangeProperty)(
            owner.connection.display,
            window,
            atom,
            xlib::XA_STRING,
            8,
            xlib::PropModeReplace,
            value.as_ptr(),
            value.len() as i32,
        );
    }
    owner.connection.sync().unwrap();
}

#[test]
#[ignore = "requires an X server (DISPLAY); run on the Ubuntu box or under Xvfb"]
fn linux_window_identity_reads_both_wm_class_halves_and_the_exe_of_a_real_window() {
    let owner = Owner::open().expect("X display");
    let c = &owner.connection;
    let window = unsafe { (c.api.XCreateSimpleWindow)(c.display, c.root, 0, 0, 1, 1, 0, 0, 0) };
    // A window that claims to be the D-MKT-2 GNOME Terminal, owned by this
    // process (so its exe is the test binary, which is on no list).
    set_string(&owner, window, "WM_CLASS", b"gnome-terminal-server\0Gnome-terminal\0");
    let pid_atom = c.atom("_NET_WM_PID").unwrap();
    let pid: std::os::raw::c_ulong = std::process::id().into();
    unsafe {
        (c.api.XChangeProperty)(
            c.display,
            window,
            pid_atom,
            xlib::XA_CARDINAL,
            32,
            xlib::PropModeReplace,
            (&pid as *const std::os::raw::c_ulong).cast(),
            1,
        );
    }
    c.sync().unwrap();
    let identity = crate::focus::linux::window_identity_with(c, window);
    assert_eq!(identity.wm_instance, "gnome-terminal-server");
    assert_eq!(identity.wm_class, "Gnome-terminal");
    let me = std::env::current_exe().unwrap();
    assert_eq!(identity.exe, me.file_name().unwrap().to_string_lossy(), "exe via _NET_WM_PID");
    assert_eq!(classify_x11_paste_target(&identity), X11PasteTarget::TerminalCtrlShiftV);
    // Same window, re-labelled as an ordinary editor: the exe alone (the test
    // binary) must not make it a terminal.
    set_string(&owner, window, "WM_CLASS", b"gedit\0Gedit\0");
    let identity = crate::focus::linux::window_identity_with(c, window);
    assert_eq!((identity.wm_instance.as_str(), identity.wm_class.as_str()), ("gedit", "Gedit"));
    assert_eq!(classify_x11_paste_target(&identity), X11PasteTarget::Ordinary);
    unsafe {
        (c.api.XDestroyWindow)(c.display, window);
    }
    c.sync().unwrap();
    println!("PASS D-MKT-2 IDENTITY: WM_CLASS both halves + exe read from a real X window");
}

/// Fixture (scripts the operator runs; see the fix report): a GNOME Terminal
/// whose bash was started with an rc that binds Ctrl+G to write
/// `$READLINE_LINE` into `$FLOWMIC_TERMINAL_PROBE`. Env: FLOWMIC_TERMINAL_XID
/// (decimal XID of that terminal window) and FLOWMIC_TERMINAL_PROBE.
///
/// The probe key is also the swallowed-keystroke check: after a Ctrl+V bash
/// sits in quoted-insert and inserts the next key literally, so the binding
/// never runs and this test times out instead of reading the line.
#[test]
#[ignore = "requires a real GNOME Terminal fixture on an X11 desktop"]
fn linux_paste_into_a_real_gnome_terminal_lands_on_the_command_line_unexecuted() {
    let required = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"));
    let xid: u64 = required("FLOWMIC_TERMINAL_XID").parse().expect("decimal XID");
    let probe = std::path::PathBuf::from(required("FLOWMIC_TERMINAL_PROBE"));
    let executed = probe.with_extension("executed");
    let _ = std::fs::remove_file(&probe);
    let _ = std::fs::remove_file(&executed);
    let owner = Owner::open().expect("X display");
    let identity = crate::focus::linux::window_identity_with(&owner.connection, xid);
    assert_eq!(
        classify_x11_paste_target(&identity),
        X11PasteTarget::TerminalCtrlShiftV,
        "fixture must be a GNOME Terminal: {identity:?}"
    );
    assert_eq!(
        x11_paste_chord(X11PasteTarget::TerminalCtrlShiftV),
        KeyChord { vk: XK_V, modifiers: vec![XK_CONTROL_L, XK_SHIFT_L] }
    );
    assert!(crate::focus::set_foreground_window(xid), "activate the fixture terminal");
    assert!(owner.connection.contains_focus(xid as _).unwrap(), "fixture holds keyboard focus");
    // Two lines; the second would leave a file behind if bash executed it.
    let marker = format!("echo fm-dmkt2-line-1\ntouch {}", executed.display());
    let pasted = ClipboardFallbackClient::for_linux_target(xid).paste_text(&marker);
    assert!(pasted.is_ok(), "paste operation: {pasted:?}");
    // The other candidate cause of a swallowed next key: a modifier left down.
    // Read the X server's own key state, not our bookkeeping.
    let c = &owner.connection;
    let mut state = [0i8; 32];
    unsafe {
        (c.api.XQueryKeymap)(c.display, state.as_mut_ptr());
    }
    for (name, sym) in [("Control_L", XK_CONTROL_L), ("Shift_L", XK_SHIFT_L), ("v", XK_V)] {
        let code = unsafe { (c.api.XKeysymToKeycode)(c.display, sym as _) };
        assert_ne!(code, 0, "{name} has a keycode");
        let down = state[code as usize / 8] as u8 & (1 << (code % 8)) != 0;
        assert!(!down, "{name} is still held after the paste");
    }
    // Ctrl+G: the probe binding. Its arrival is the next-key check.
    inject::send_chords(&[KeyChord { vk: 0x0067, modifiers: vec![XK_CONTROL_L] }], xid)
        .expect("probe key");
    let start = Instant::now();
    let line = loop {
        if let Ok(line) = std::fs::read_to_string(&probe) {
            break line;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "probe never ran: the next key was swallowed (quoted-insert) or the paste never \
             reached bash"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    // Ctrl+U clears the line so the fixture is ready for the next run.
    inject::send_chords(&[KeyChord { vk: 0x0075, modifiers: vec![XK_CONTROL_L] }], xid)
        .expect("clear line");
    assert_eq!(line, marker, "the command line holds exactly the pasted text");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!executed.exists(), "a pasted line ran before the user pressed Enter");
    println!("PASS D-MKT-2 TERMINAL: real GNOME Terminal received the paste on its command line, unexecuted; next key not swallowed");
}

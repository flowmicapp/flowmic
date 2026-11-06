// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §14 (Linux V1, text/keys row)
//   docs/marketing/05b-defects-found.md D-MKT-2 (the measurement this exists for)
//   docs/rebuild/15-INJECTION-PERMISSION.md §2.5g-1 (what `injected` claims)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// Which key chord a Linux (X11) clipboard paste presses, decided from what the
// target window says it is.
//
// Pure, and compiled on every platform on purpose: the DECISION is provable by
// the Windows gates even though only the Linux paste calls it
// (`inject/linux/paste.rs`, `Owner::paste`). What no Windows gate can prove is
// the WIRING — that the identity really comes from the X server and that the
// chosen chord is the one really pressed. That is the job of the ignored
// native tests in `inject/linux/terminal_paste_tests.rs` and of an Ubuntu run.
//
// ── WHY THIS EXISTS (D-MKT-2, measured 2026-11-05, Ubuntu 22.04 Xorg) ────────
// Until this card every Linux text injection pressed Ctrl+V. GNOME Terminal
// does not paste on Ctrl+V: it passes ^V to the program inside, and bash's
// readline binds ^V to quoted-insert. The text never arrived, bash was left
// waiting to insert the user's NEXT key literally (a Ctrl+X showed up as
// `^X`), and the PC reported `injected` ("Input sent (unconfirmed)") while the
// phone said "Delivered". Isolated without FlowMic, with a marker on the
// clipboard: `xdotool key ctrl+v` → empty command line; `xdotool key
// ctrl+shift+v` → the marker on the command line.
//
// The status word was not where the lie was made. `injected` on Linux claims
// that the text was handed to the window holding the keyboard focus, landing
// unconfirmed (15 §2.5g-1, the weak tier). What was handed over was a chord
// this target does not treat as a paste, so the handover itself never
// happened. The fix therefore lives at the layer that produced the false
// precondition — the chord — and the words stay as defined.
//
// ── WHY PASTE, NOT TYPING, INTO A LINUX TERMINAL (unlike Windows) ────────────
// On Windows a console target TYPES ASCII (`text_route::is_console_target`),
// because there Ctrl+V is decided by the program inside the console. Here the
// terminal EMULATOR owns Ctrl+Shift+V and consumes it before the PTY, so the
// paste is not contended by vim/less/readline, and the text arrives in one
// piece, CJK included. Typing would need XTEST keymap remapping for every
// non-keymap character and would turn each newline into a Return — which a
// shell executes. A paste into a shell with bracketed-paste enabled (bash ≥ 5.1
// and zsh ≥ 5.1 by default) is held as one edit until the user's own Enter;
// that guard belongs to the shell, not to us, and a shell without it runs
// pasted lines exactly as it would for the user's own paste.

use crate::inject::flow_key::KeyChord;

/// X keysym `v` (lowercase). XTEST resolves keysyms to keycodes at submission
/// (`inject/linux/keys.rs`); with Shift held the same keycode reads as `V`.
pub const XK_V: u16 = 0x0076;
/// X keysym `Control_L`.
pub const XK_CONTROL_L: u16 = 0xFFE3;
/// X keysym `Shift_L`.
pub const XK_SHIFT_L: u16 = 0xFFE1;

/// What an X11 client window says it is, read at the paste commit point
/// (`focus::linux::window_identity_with`). All three are compared because each
/// one misses some terminal: Python-hosted emulators (Terminator, Guake) report
/// `/proc/<pid>/exe` as `python3.x`; a binary replaced by an upgrade reads back
/// as `<name> (deleted)`; WM_CLASS is a hint the client may leave unset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct X11WindowIdentity {
    /// WM_CLASS res_name (the first of its two strings).
    pub wm_instance: String,
    /// WM_CLASS res_class (the second string).
    pub wm_class: String,
    /// Basename of `/proc/<_NET_WM_PID>/exe`; empty when unreadable.
    pub exe: String,
}

/// What kind of paste target the window is, for choosing the chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum X11PasteTarget {
    /// Not on either list below. GTK, Qt, Gecko, Chromium/Electron and
    /// LibreOffice text fields paste on Ctrl+V. The default, and the only
    /// behaviour Linux had before this card.
    Ordinary,
    /// A terminal emulator whose own default CLIPBOARD-paste binding is
    /// Ctrl+Shift+V. The emulator consumes the chord before the PTY.
    TerminalCtrlShiftV,
    /// A terminal emulator with NO default keyboard binding for a CLIPBOARD
    /// paste: xterm pastes only PRIMARY, on Shift+Insert. Ctrl+V and
    /// Ctrl+Shift+V both reach the program inside as ^V. What is pressed for
    /// it today, and why that is still open, is on [`x11_paste_chord`].
    TerminalWithoutClipboardKey,
}

impl X11PasteTarget {
    /// Must the paste wait, after taking the clipboard and before pressing
    /// the chord, for the target to re-read the clipboard? See
    /// [`TERMINAL_SETTLE_CAP`]. Only the terminal arm, the one place it was
    /// measured: ordinary targets keep their timing byte for byte.
    pub fn waits_for_clipboard_reread(self) -> bool {
        self == X11PasteTarget::TerminalCtrlShiftV
    }

    /// The phrase the forensic line carries, kept beside the rule that
    /// produces it so the two cannot drift.
    pub fn forensic_phrase(self) -> &'static str {
        match self {
            X11PasteTarget::Ordinary => "chord=Ctrl+V (ordinary target)",
            X11PasteTarget::TerminalCtrlShiftV => {
                "chord=Ctrl+Shift+V (terminal emulator: its own clipboard-paste binding; Ctrl+V \
                 would reach the program inside as ^V — D-MKT-2)"
            }
            X11PasteTarget::TerminalWithoutClipboardKey => {
                "chord=Ctrl+V, KNOWN NOT TO PASTE here (terminal with no keyboard binding for a \
                 CLIPBOARD paste; the program inside receives ^V). Unchanged pending a named \
                 refusal or a PRIMARY-selection paste — D-MKT-2 fix report"
            }
        }
    }
}

/// Classify the target from its identity. Matching is exact and
/// case-insensitive against any one of the three fields: WM_CLASS keeps the
/// program's own casing (`Gnome-terminal`, `XTerm`, `Alacritty`), and a
/// substring match would let `stellarium` pass for `st`.
pub fn classify_x11_paste_target(id: &X11WindowIdentity) -> X11PasteTarget {
    let exe = id.exe.strip_suffix(" (deleted)").unwrap_or(&id.exe);
    let names = [id.wm_instance.as_str(), id.wm_class.as_str(), exe];
    let listed = |list: &[&str]| {
        names
            .iter()
            .filter(|name| !name.is_empty())
            .any(|name| list.iter().any(|known| name.eq_ignore_ascii_case(known)))
    };
    if listed(NO_CLIPBOARD_KEY_TERMINALS) {
        X11PasteTarget::TerminalWithoutClipboardKey
    } else if listed(CTRL_SHIFT_V_TERMINALS) {
        X11PasteTarget::TerminalCtrlShiftV
    } else {
        X11PasteTarget::Ordinary
    }
}

/// The chord to press for `target`, as X keysyms (modifiers press in order
/// before the key and release in reverse after it — `inject/linux/keys.rs`).
///
/// ⚠️ [`X11PasteTarget::TerminalWithoutClipboardKey`] keeps Ctrl+V, the exact
/// chord it got before this card, although Ctrl+V is known not to paste there.
/// Every alternative open to this card is worse or needs a decision it may not
/// take alone: Ctrl+Shift+V is the same ^V; Shift+Insert pastes the user's
/// PRIMARY selection, i.e. the WRONG text; pressing nothing while reporting
/// `injected` is a plainer lie; and an honest refusal needs a named error code,
/// which CLAUDE.md D-31/D-32 reserves for the first responsible person. The
/// forensic line says what is happening; the fix report carries the proposal.
pub fn x11_paste_chord(target: X11PasteTarget) -> KeyChord {
    match target {
        X11PasteTarget::TerminalCtrlShiftV => KeyChord {
            vk: XK_V,
            modifiers: vec![XK_CONTROL_L, XK_SHIFT_L],
        },
        X11PasteTarget::Ordinary | X11PasteTarget::TerminalWithoutClipboardKey => KeyChord {
            vk: XK_V,
            modifiers: vec![XK_CONTROL_L],
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND D-MKT-2 MECHANISM: the terminal ignores its paste key until it has
// re-read the clipboard (measured 2026-11-05, todigg68, GNOME Terminal 3.44).
//
// Taking the clipboard sends every interested client an owner-change notice.
// GNOME Terminal answers it by asking the new owner for TARGETS, and until that
// answer is in, its Ctrl+Shift+V does nothing at all: no paste, no ^V to the
// shell, so the next key is NOT swallowed and nothing looks wrong. Our chord
// used to follow the ownership change by ~1 ms; the terminal's TARGETS request
// arrived 4–5 ms after it. Chord at +1 ms: 0/4 landed, and the terminal never
// asked for the text. Chord after 150 ms of serving requests: 4/4 landed, the
// terminal's TARGETS at +4 ms, its text request right after the chord. Typing
// the same chord by hand or by xdotool always lands because a person is never
// that fast after a copy.
//
// So the terminal arm waits until the target's own X client has asked us
// something, then a short grace, capped. Ordinary targets do not wait: their
// timing is the measured 5/5 of V-15 and is left as it was.
// ─────────────────────────────────────────────────────────────────────────────

/// Upper bound on waiting for the target to re-read the clipboard. Past it the
/// chord is pressed anyway and the forensic line says the target never asked
/// — the paste then very likely did not land. 500 ms is ~100× the idle reading.
pub const TERMINAL_SETTLE_CAP_MS: u64 = 500;
/// After the target's request is served: our SelectionNotify is queued to it
/// before the key events, so this is margin, not the mechanism.
pub const TERMINAL_SETTLE_GRACE_MS: u64 = 20;
/// Low bits of an X resource id that belong to the client's own numbering, on
/// an X server with its default limit of 256 clients (resource-id-mask
/// 0x001FFFFF; the measured Xorg runs without `-maxclients`). x11-dl exposes no
/// way to read the real mask. 🔴 [assumption] With a larger client limit two
/// clients can share these high bits; the failure is then an early chord (the
/// race above, no worse than before this card), not a wrong one.
pub const X_CLIENT_ID_SHIFT: u32 = 21;

/// Do two X resource ids (windows) belong to the same client connection?
/// Used to recognise the target's own selection request among the others an
/// ownership change provokes (clipboard manager, other open apps).
pub fn same_x_client(a: u64, b: u64) -> bool {
    a != 0 && b != 0 && (a >> X_CLIENT_ID_SHIFT) == (b >> X_CLIENT_ID_SHIFT)
}

/// Terminal emulators whose default CLIPBOARD paste is Ctrl+Shift+V. A name may
/// be a WM_CLASS half or an executable basename; matched as described on
/// [`classify_x11_paste_target`]. Extending the list means adding a test row.
///
/// 🔴 MEASURED: GNOME Terminal only (2026-11-05, Ubuntu 22.04, WM_CLASS
/// `gnome-terminal-server` / `Gnome-terminal`). Every other row is that
/// program's documented default binding, not a reading — [unverified]. The
/// falsifier is cheap: a listed terminal that does not paste on Ctrl+Shift+V.
/// A wrong row costs Ctrl+Shift+V pressed into an app that would have pasted on
/// Ctrl+V — the failure this list fixes, for one app — so a row needs at least
/// the program's own documented binding behind it.
///
/// ⚠️ NOT DISTINGUISHABLE HERE, so deliberately absent: terminals that live
/// inside another program's window (VS Code / JetBrains integrated terminals,
/// Emacs vterm). Measured 2026-11-05 on VS Code (snap, WM_CLASS
/// `code_code`/`code_code`): its integrated terminal does NOT paste on Ctrl+V
/// and does on Ctrl+Shift+V — the D-MKT-2 failure, still open there — but the
/// window is also the editor's, where Ctrl+Shift+V is VS Code's documented
/// Markdown-preview binding (not measured here) and Ctrl+V pastes.
const CTRL_SHIFT_V_TERMINALS: &[&str] = &[
    // VTE-based applications (GNOME Terminal's widget family)
    "gnome-terminal",
    "gnome-terminal-server",
    "xfce4-terminal",
    "mate-terminal",
    "tilix",
    "terminator",
    "lxterminal",
    "sakura",
    "guake",
    "kgx",
    "org.gnome.console",
    // Qt
    "konsole",
    "qterminal",
    // standalone emulators
    "alacritty",
    "kitty",
    "wezterm",
    "wezterm-gui",
    "org.wezfurlong.wezterm",
    "ghostty",
    "com.mitchellh.ghostty",
    "terminology",
    // suckless st: TERMMOD+V in config.def.h; WM_CLASS is its TERM name
    "st",
    "st-256color",
];

/// Terminal emulators with no default keyboard binding for a CLIPBOARD paste.
/// xterm's only keyboard paste is Shift+Insert → PRIMARY (or CUT_BUFFER0).
/// rxvt-unicode gained Ctrl+Alt+V for CLIPBOARD in 9.20 — [unverified] on any
/// machine here, so it stays with xterm until measured.
const NO_CLIPBOARD_KEY_TERMINALS: &[&str] = &["xterm", "uxterm", "urxvt", "rxvt", "rxvt-unicode"];

#[cfg(test)]
#[path = "x11_paste_chord_tests.rs"]
mod tests;

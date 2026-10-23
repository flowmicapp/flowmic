// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (injection pipeline, Stage 2 — SendInput
//     KEYEVENTF_UNICODE, wVk=0/wScan=WCHAR, surrogate pairs as consecutive units)
//   docs/rebuild/01 / master-plan §4 (no silent failure — SendInput returning 0
//     is surfaced as AppRejected, never swallowed)
//
// Primary text-injection path. Wraps `SendInput` with `KEYEVENTF_UNICODE` so
// we send wide-char Unicode events rather than scancode-translated virtual
// keys — the only way to inject CJK / emoji into apps without IME support.
// Surrogate pairs (U+10000+) are sent as two consecutive UTF-16 code units in
// a single `SendInput` call so the receiving app reassembles them.
//
// ONE THING DOES NOT TRAVEL THAT WAY: a line break. It is a real keystroke,
// not a character — see the long note on `type_text` (defect NL-1) — and since
// NR-253 (2026-10-14) it is Shift+Enter unless the caller names plain Enter,
// because in a chat box a plain Enter SENDS the message.
//
// All Win32 calls are funneled through three `Box<dyn Fn>` seams so unit tests
// swap fakes in without touching the OS (the whole pipeline is headless-
// testable — the injection path is human-audit-sensitive and must be provable
// without a live desktop).


/// Errors returned by the SendInput-backed injection path.
#[derive(Debug, thiserror::Error)]
pub enum InjectError {
    /// The OS accepted the call but the receiving app silently dropped the
    /// events — `SendInput` returned 0. The caller falls back to clipboard
    /// paste per 07-DESKTOP-SPEC §2 Stage 3.
    #[error("SendInput rejected by app (returned 0)")]
    AppRejected,
    /// Hard Win32 error (window destroyed mid-call, hooked, etc.). The `u32`
    /// is the raw `GetLastError()` code.
    #[error("Win32 error: {0}")]
    Win32(u32),
    /// Same, but from a multi-step Win32 sequence that NAMES which call failed.
    ///
    /// owner 2026-07-29: an image paste came back as `paste=Win32 error:
    /// 2147942406` and no one — including the code's own author — could say
    /// which of four clipboard calls produced it. A number with no call site is
    /// a failure that cannot be acted on, which is the reporting half of the
    /// "no silent failures" red line. The code is kept in its HRESULT form (that is what
    /// windows-rs hands us) and printed as hex, because 0x80070006 is
    /// recognisable as ERROR_INVALID_HANDLE while 2147942406 is not.
    #[error("Win32 {0} failed: hr=0x{1:08X}")]
    Win32Step(&'static str, u32),
    /// This platform has no implementation of that step, and the string says
    /// WHICH step and WHY.
    ///
    /// 🔴 ADDED FOR THE MAC WINDOW (2026-08-07) AND IT IS A FIX, NOT DECORATION.
    /// The non-Windows arms of this module used to answer `Win32(0)` — a Win32
    /// error code of zero, on a platform with no Win32, printed as
    /// 「Win32 error: 0」. That is a number with no call site, which is the exact
    /// complaint `Win32Step` above was created to fix; it just never got applied
    /// to the platform stubs. Every message the pipeline threads into a forensic
    /// line from a non-Windows host went through it.
    ///
    /// It is also the shape the clipboard stubs get flipped INTO: a step that this
    /// build genuinely cannot perform must ERROR by name, never return a friendly
    /// `Ok` (doc 13 §7 F1 ②).
    #[error("not implemented on this platform: {0}")]
    Unsupported(&'static str),
    /// The native operation failed at a named step before submitting input.
    #[error("native operation failed: {0}")]
    Native(String),
    #[error("verified target changed before input: {0}")]
    TargetChanged(String),
    /// Input may already have reached the target. Never report a known failure
    /// or automatically retry; the wire code preserves uncertainty. Decision:
    /// docs/decisions/2026-09-22-linux-inject-verdict-codes-and-no-new-history-status.md
    /// (Chose / INJECT_SUBMISSION_UNCERTAIN; first responsible person, owner may overturn).
    #[error("input submission uncertain: {0}")]
    SubmissionUncertain(String),
}

/// Sender callback: take a slice of UTF-16 code units, push them to the OS,
/// return the number the OS accepted. 0 maps to `AppRejected`.
type Sender = Box<dyn Fn(&[u16]) -> Result<usize, InjectError> + Send + Sync>;

/// Which keystroke one line break becomes on the typed path (NR-253).
///
/// `ShiftEnter` is the default and `Enter` the exception, for the same reason
/// the clipboard is the default road (`text_route::route_text`): the two wrong
/// answers are not equally bad. A plain Enter in a chat or AI input box SENDS
/// the half-typed message — irreversible, and seen by other people.
///
/// ⚠️ Shift+Enter is NOT harmless everywhere, and the cost is stated, not
/// assumed (corrected 2026-10-14 after review; only the Notepad row is
/// measured, the rest are the apps' documented key bindings):
///   · Windows 11 Notepad: stores U+000B, a soft break — hence its plain-Enter
///     entry. Its AI prompt box runs in the same process, so it gets plain
///     Enter too, which submits that prompt.
///   · Jupyter, Colab, VS Code notebooks: RUNS the cell and leaves the next
///     cell in command mode, where the following letters act as commands
///     (insert/delete cell, change cell type).
///   · VS Code with the Python extension, in a .py editor: runs the line in a
///     Python terminal.
///   · Excel: commits the cell and moves up one cell; the rest of the text
///     then overwrites that cell.
/// The decision stands because the typed path reaches those apps only after a
/// paste has already failed (or for ASCII into a console), while the chat send
/// it prevents cannot be undone. Who gets plain Enter is decided in ONE place,
/// `text_route::line_break_key_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineBreakKey {
    /// VK_RETURN alone. Only for targets measured to need it.
    Enter,
    /// VK_SHIFT held across VK_RETURN: a new line, not a send, in the chat
    /// inputs measured (Chromium textarea and contenteditable with an
    /// Enter-to-send handler, 2026-10-14).
    ShiftEnter,
}

/// Line-break callback: press the given line-break keystroke once. Returns the
/// number of line breaks the OS accepted — 1 on success, 0 maps to
/// `AppRejected`.
///
/// Deliberately a second seam rather than a payload for `Sender`: a line break
/// does not travel as a Unicode code unit at all (see `type_text`), so it is a
/// different kind of event, not a different character.
type Enterer = Box<dyn Fn(LineBreakKey) -> Result<usize, InjectError> + Send + Sync>;

/// Primary text-injection client. `new()` wires the real Win32 path;
/// `with_fakes()` swaps both seams for unit tests.
///
/// P1 (2026-09-02 audit §3-D): this used to carry a THIRD seam, `backspacer`,
/// for `apply_correction` — deleted along with it (see `inject/mod.rs`'s
/// history and `git log -- inject/correction.rs`): `diff_correction` /
/// `CorrectionOps` / `apply_correction` had zero production callers (grepped
/// across `apps/desktop/src` and `src-tauri/src`; every hit was the dead
/// code's own definition or its own tests) — the character-level correction
/// feature it implemented was never wired into the inject pipeline.
pub struct SendInputClient {
    sender: Sender,
    enter: Enterer,
}

impl SendInputClient {
    pub fn new() -> Self {
        Self {
            sender: Box::new(real_send_unicode),
            enter: Box::new(real_send_line_break),
        }
    }

    pub fn with_fakes(
        sender: impl Fn(&[u16]) -> Result<usize, InjectError> + Send + Sync + 'static,
        enter: impl Fn(LineBreakKey) -> Result<usize, InjectError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            sender: Box::new(sender),
            enter: Box::new(enter),
        }
    }

    /// UTF-16 encode `text` and forward to the sender, TRANSLATING EVERY LINE
    /// BREAK INTO ONE `line_break` KEYSTROKE. Returns the number of keystroke
    /// units the OS accepted. Empty input returns Ok(0).
    ///
    /// ── NR-253 (2026-10-14): WHICH KEYSTROKE ───────────────────────────────
    /// NL-1 below made every break a plain Enter. That is right for Notepad and
    /// wrong for every input where Enter means "send": a multi-line utterance
    /// typed into a chat box goes out as several messages, the first one cut
    /// off mid-thought. The caller now names the keystroke ([`LineBreakKey`]);
    /// the one production caller asks `text_route::line_break_key_for`.
    ///
    /// ── WHY A LINE BREAK IS NOT A UNICODE UNIT (defect NL-1) ─────────────────
    /// `KEYEVENTF_UNICODE` hands the target whatever WCHAR sits in `wScan` as a
    /// character. Windows edit controls insert a line break when they are given
    /// **Enter** (VK_RETURN, whose WM_CHAR is CR); a bare LF (U+000A) is a
    /// character they do not act on, so it arrives and is discarded.
    ///
    /// Every layer that could have caught that was blind to it, which is why it
    /// survived to real hardware (2026-08-12,
    /// `scratch/r7-a26b-multiselect-2026-08-12.md`): a 3-item multiselect send —
    /// which owner ruled joins with a single '\n' (REQ-12-09 09-D) — left the
    /// phone as 34 chars, was recorded by the PC timeline as 34 chars, and
    /// landed in Notepad as 32 characters on ONE line, caret at column 33.
    /// `SendInput` accepted the two LF events and counted them, so both ends'
    /// accounting was correct and the loss was visible only in the user's
    /// document. Nobody could see it from either end — "no silent failures", on the
    /// 「把没做成的事说成做成了」 ("reporting a thing that was not done as done") side.
    ///
    /// So '\n', '\r\n' and a lone '\r' each become exactly ONE line-break
    /// keystroke, and the text around them is sent as before.
    ///
    /// VK_RETURN key events rather than a CR (U+000D) UNICODE unit: the
    /// keystroke is the same event the user's own Enter key produces, so a
    /// target that decides line breaks from the key event rather than from the
    /// resulting WM_CHAR still sees what it waits for. Choosing the CR unit
    /// would fix Notepad while leaving that class of target broken in a way this
    /// path cannot observe — the exact shape of the defect being fixed here.
    ///
    /// ⚠️ THE COUNT: one line break counts as one unit, so `"a\r\nb"` returns 3 and
    /// not the 4 UTF-16 units the string measures. The number says what was
    /// sent, not what the string was. The one caller is fine with that:
    /// `sendinput_outcome::map_sendinput_outcome` binds it as `Ok(_queued)`
    /// and never reads it.
    pub fn type_text(&self, text: &str, line_break: LineBreakKey) -> Result<usize, InjectError> {
        if text.is_empty() {
            return Ok(0);
        }
        let mut accepted = 0usize;
        let mut rest = text;
        while !rest.is_empty() {
            let Some(brk) = rest.find(['\r', '\n']) else {
                accepted += self.send_units(rest)?;
                break;
            };
            // No empty batch is ever sent: a leading break, or two breaks in a
            // row, must not hand the real sender an empty slice — it answers
            // `Ok(0)` to one, and `Ok(0)` is how the app says it refused.
            if brk > 0 {
                accepted += self.send_units(&rest[..brk])?;
            }
            accepted += self.press_line_break(line_break)?;
            // "\r\n" is ONE line break, not two. `\r` and `\n` are ASCII, so
            // both slice offsets are on char boundaries.
            let consumed = if rest[brk..].starts_with("\r\n") { 2 } else { 1 };
            rest = &rest[brk + consumed..];
        }
        Ok(accepted)
    }

    /// [`type_text`](Self::type_text) with the line-break keystroke chosen for
    /// `app_id` by `text_route::line_break_key_for` (NR-253). THE production
    /// entry (`text_dispatch.rs::run_sendinput`) and the real-window probe
    /// (`examples/line_break_probe.rs`) both call this, so the choice lives in
    /// one place that a fake-seam test can see.
    pub fn type_text_for_app(&self, text: &str, app_id: Option<&str>) -> Result<usize, InjectError> {
        self.type_text(text, crate::inject::text_route::line_break_key_for(app_id))
    }

    /// One run of non-newline text. Never called with an empty slice.
    fn send_units(&self, chunk: &str) -> Result<usize, InjectError> {
        debug_assert!(!chunk.is_empty(), "an empty batch would read as a refusal");
        let units: Vec<u16> = chunk.encode_utf16().collect();
        let written = (self.sender)(&units)?;
        if written == 0 {
            return Err(InjectError::AppRejected);
        }
        Ok(written)
    }

    /// One line break. A refused keystroke fails the whole call rather than
    /// being skipped — silently dropping it is the defect this function exists for.
    fn press_line_break(&self, key: LineBreakKey) -> Result<usize, InjectError> {
        let pressed = (self.enter)(key)?;
        if pressed == 0 {
            return Err(InjectError::AppRejected);
        }
        Ok(pressed)
    }

}

impl Default for SendInputClient {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------
// Real Win32 implementations. Compiled only on Windows; non-Windows returns
// errors so the crate still cargo-checks on Linux CI (the desktop binary is
// Windows-only but cross-target verification must not break — 07-SPEC §12.4).
// ---------------------------------------------------------------------

/// D3 (2026-09-02 audit §3-D) — ONE rule for what counts as a successful raw
/// `SendInput` call, shared by every call site that makes one.
///
/// `SendInput` returns the number of events it actually queued, which can be
/// LESS than what was asked for (Windows stops at the first event it refuses —
/// e.g. UIPI blocking a higher-integrity target partway through a batch). Before
/// this, `sendinput.rs`'s two wrappers treated `sent > 0` as success and quietly
/// reported a TRUNCATED count as though everything had landed; only
/// `flow_key.rs`'s chord sender compared `sent` against the batch length. Three
/// SendInput call sites disagreeing about what "sent" means is this repo's #1
/// bug shape (a value answers two questions) — this function is now the single
/// answer, called from `real_send_unicode`, `real_send_line_break` below (formerly `real_send_vk_pairs`) and
/// `clipboard_confirm.rs`'s `send_ctrl_v`.
///
/// ⚠️ CORRECTED IN PLACE (2026-09-02, B2-Z): the Mac-side run (commit
/// 7d9a775c) reported `cargo clippy --lib --features app -- -D warnings`
/// flagging this function dead code on macOS — true in a plain build there,
/// because every production caller named above (`real_send_unicode`,
/// `real_send_line_break`, `flow_key.rs::send_chords`, `clipboard_confirm.rs`'s
/// `send_ctrl_v`) is Windows-only. `#[cfg(any(test,
/// target_os = "windows"))]` keeps it reachable for the real Windows build
/// and for `sendinput_fully_sent_tests` below on every platform, without
/// `#[allow(dead_code)]` masking the day all four callers actually go away.
/// NOT YET CONFIRMED ON THE MAC by this commit — see
/// `verify/lint/platform-cfg-count.mjs`'s compound-cfg census note.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn sendinput_fully_sent(sent: u32, expected: usize) -> bool {
    sent as usize == expected
}

#[cfg(test)]
mod sendinput_fully_sent_tests {
    use super::sendinput_fully_sent;

    #[test]
    fn full_batch_is_success() {
        assert!(sendinput_fully_sent(4, 4));
    }

    /// The exact shape this card fixes: a NONZERO but PARTIAL send must not
    /// read as success. Before D3, `real_send_unicode`/`real_send_vk_pairs` only
    /// checked `sent == 0`, so `sendinput_fully_sent`-shaped logic would have
    /// said "sent" here — this is the case that made a target see the text
    /// twice (SendInput partially lands, the caller believes it failed... or,
    /// as this bug actually shipped, the caller believed a PARTIAL send was a
    /// COMPLETE one and never retried the missing tail at all).
    #[test]
    fn partial_batch_is_not_success() {
        assert!(!sendinput_fully_sent(2, 4));
        assert!(!sendinput_fully_sent(1, 4));
    }

    #[test]
    fn zero_sent_is_not_success() {
        assert!(!sendinput_fully_sent(0, 4));
    }

    #[test]
    fn empty_batch_edge_case() {
        // Callers already special-case `inputs.is_empty()` before reaching
        // SendInput, but the predicate itself should not lie about it either.
        assert!(sendinput_fully_sent(0, 0));
    }
}

#[cfg(target_os = "windows")]
fn real_send_unicode(units: &[u16]) -> Result<usize, InjectError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };

    if units.is_empty() {
        return Ok(0);
    }

    // Each code unit needs a key-down + key-up pair → 2 INPUTs per unit.
    let mut inputs: Vec<INPUT> = Vec::with_capacity(units.len() * 2);
    for &u in units {
        // KEYEVENTF_UNICODE: wVk MUST be 0, wScan carries the WCHAR. The OS
        // reassembles surrogate pairs from two consecutive UNICODE events.
        let down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: u,
                    dwFlags: KEYEVENTF_UNICODE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let up = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: u,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        inputs.push(down);
        inputs.push(up);
    }

    // SAFETY: SendInput reads `cbSize` bytes from each INPUT in the slice;
    // `inputs` is a properly-sized Vec<INPUT> and the size_of cast is exact.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    // D3 (2026-09-02 audit §3-D): a PARTIAL send is a failure, not a partial
    // success. This used to accept any `sent > 0` and report `sent / 2` units
    // typed even when the OS silently dropped the rest of the batch — the
    // caller then believed fewer characters landed than it asked for, never
    // that the call failed. `flow_key.rs`'s chord sender already treats
    // `sent != inputs.len()` as the failure condition (07-DESKTOP-SPEC's "one
    // meaning of injected" applies to internal call sites too, not just the
    // externally-visible verdict) — this wrapper and `clipboard_confirm.rs`'s
    // Ctrl+V sender now use the SAME rule.
    if !sendinput_fully_sent(sent, inputs.len()) {
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        if err.0 == 0 {
            return Err(InjectError::AppRejected);
        }
        return Err(InjectError::Win32(err.0));
    }
    Ok(units.len())
}

/// The key events ONE line break becomes, in order: `(virtual key, key_up)`.
///
/// Pure so the plan is provable without a desktop (this module's rule — see
/// the header). Both keys travel as VIRTUAL keys with `KEYEVENTF_UNICODE`
/// absent, which is what makes the OS treat them as real keypresses rather
/// than characters: the character form of a line break is what edit controls
/// silently drop (NL-1), and Shift has no character form at all.
///
/// Shift goes down before Return and comes up after it, in the SAME
/// `SendInput` batch, so no other keyboard input can be inserted between them
/// and see Shift held (`SendInput` inserts one batch serially — its documented
/// contract, and the reason this is one call and not four).
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn line_break_plan(key: LineBreakKey) -> &'static [(u16, bool)] {
    const VK_SHIFT: u16 = 0x10; // WinUser.h
    const VK_RETURN: u16 = 0x0D; // WinUser.h
    match key {
        LineBreakKey::Enter => &[(VK_RETURN, false), (VK_RETURN, true)],
        LineBreakKey::ShiftEnter => &[
            (VK_SHIFT, false),
            (VK_RETURN, false),
            (VK_RETURN, true),
            (VK_SHIFT, true),
        ],
    }
}

/// One line break (NL-1; which keystroke is NR-253's) — sends
/// [`line_break_plan`] as one `SendInput` batch and answers 1 on success.
#[cfg(target_os = "windows")]
fn real_send_line_break(key: LineBreakKey) -> Result<usize, InjectError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    let inputs: Vec<INPUT> = line_break_plan(key)
        .iter()
        .map(|&(vk, key_up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();

    // SAFETY: SendInput reads `cbSize` bytes from each INPUT in the slice;
    // `inputs` is a properly-sized Vec<INPUT> and the size_of cast is exact.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    // D3: same rule as `real_send_unicode` above — a partial send is a failure.
    // For Shift+Enter it matters twice over: a batch cut after the Shift-down
    // leaves Shift logically held for whatever the user types next (and our own
    // next Ctrl+V would arrive as Ctrl+Shift+V), so the keys the cut batch left
    // down are released before the failure is reported.
    if !sendinput_fully_sent(sent, inputs.len()) {
        // Read the error BEFORE the release call, which can overwrite it.
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        release_keys_left_down("line break", line_break_plan(key), sent);
        if err.0 == 0 {
            return Err(InjectError::AppRejected);
        }
        return Err(InjectError::Win32(err.0));
    }
    Ok(1)
}

/// Which keys a `plan` batch leaves logically DOWN when the OS inserted only
/// its first `sent` events, in press order. `SendInput` inserts a batch
/// serially and stops at the first event it refuses, so a partial batch is
/// always a prefix. Shift+Enter: 1 → [Shift], 2 → [Shift, Return],
/// 3 → [Shift]; 0 and 4 → [].
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn keys_left_down(plan: &[(u16, bool)], sent: usize) -> Vec<u16> {
    let mut down: Vec<u16> = Vec::new();
    for &(vk, key_up) in plan.iter().take(sent) {
        if key_up {
            down.retain(|&d| d != vk);
        } else if !down.contains(&vk) {
            down.push(vk);
        }
    }
    down
}

/// After a PARTIAL `plan` batch, send key-ups (reverse press order) for every
/// key it left down — a cut Ctrl+V or Shift+Enter must not leave the user's
/// keyboard with a modifier logically held. Best effort: the caller still
/// reports its own failure; this only writes what the release did to the
/// forensic log, because a release that also failed is something only that
/// log can tell anyone. Callers: `real_send_line_break` above and
/// `clipboard_confirm.rs`'s `send_ctrl_v`.
#[cfg(target_os = "windows")]
pub(crate) fn release_keys_left_down(what: &str, plan: &[(u16, bool)], sent: u32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let down = keys_left_down(plan, sent as usize);
    if down.is_empty() {
        return;
    }
    let ups: Vec<INPUT> = down
        .iter()
        .rev()
        .map(|&vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    // SAFETY: as above — a properly-sized slice of INPUT and its exact size.
    let released = unsafe { SendInput(&ups, std::mem::size_of::<INPUT>() as i32) };
    crate::forensic::record(
        "inject",
        &format!(
            "{what}: SendInput queued {sent}/{} events; released keys left down {down:#x?}: \
             {released}/{} key-up(s) queued",
            plan.len(),
            ups.len()
        ),
    );
}

/// 🔴 macOS DELIBERATELY HAS NO STAGE-2 TYPING PATH IN V1, and this error is how
/// the pipeline finds that out rather than by a comment nobody reads.
///
/// The macOS analog would be `CGEventKeyboardSetUnicodeString` — a real mechanism,
/// and explicitly deferred by the MAC-05 card (breakdown §C: 「CGEventPost 打字路（剪贴板
/// 主路已覆盖 V1）」 ("the CGEventPost typing path [the clipboard main path already
/// covers V1]")). So Stage 2 fails IMMEDIATELY and with no side effect, and
/// `inject_text` falls through to the clipboard main path, which is where macOS
/// text delivery lives. The first injection into a given app therefore reports
/// `mode: clipboard` with a forensic note saying typing was not attempted; after
/// that, `AppLearningStore` sends the app straight to the clipboard.
///
/// (Comment history: this used to also warn that `apply_correction` — streaming
/// realtime correction — inherited this same deferral. That function had zero
/// production callers and was deleted 2026-09-02 (P1, audit §3-D); the
/// deferral described below still applies to plain typed text.)
#[cfg(not(target_os = "windows"))]
fn real_send_unicode(_units: &[u16]) -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 SendInput typing. macOS V1 delivers text through the clipboard main path \
         (inject/macos/pasteboard.rs); the CGEvent typing path is deferred on purpose",
    ))
}


#[cfg(not(target_os = "windows"))]
fn real_send_line_break(_key: LineBreakKey) -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 line-break keystroke (line breaks in typed text). Same deferral as the typing \
         path above — and unlike the backspace, nothing is lost by it: the clipboard main path \
         carries the text's own line breaks, so macOS never needs one synthesised",
    ))
}

/// ⚠️ SCOPE STOP (WP-5, 2026-09-02): the Windows-side `apply_correction` /
/// `CorrectionOps` / `backspacer` seam this stub served was deleted this same
/// pass (zero production callers, grepped across `apps/desktop/src` and
/// `src-tauri/src`). This non-Windows counterpart is left in place, now
/// genuinely unreferenced on every platform, rather than deleted alongside it:
/// this repo's law is that `cfg(not(target_os = "windows"))` code must not be
/// touched from a Windows-only session — "Windows gates cannot compile it, so
/// nothing here can tell you whether removing it is safe" (the same reasoning
/// `platform-cfg-count`'s lint exists to enforce: a non-Windows branch-count
/// change requires `./scripts/mac-verify.sh` on the real machine before the
/// lint's EXPECTED constants can be updated). Deleting THIS function is exactly
/// that kind of change, so it stops here — flagged for the mac-verified pass
/// to remove alongside whatever else in `inject/macos/` it also turns out to
/// be the last reference to.
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn real_send_backspaces(_count: usize) -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 backspace chords (streaming correction). Same deferral as the typing path \
         above — there is no clipboard equivalent of a backspace, so correction degrades",
    ))
}

#[cfg(test)]
#[path = "sendinput_tests.rs"]
mod tests;

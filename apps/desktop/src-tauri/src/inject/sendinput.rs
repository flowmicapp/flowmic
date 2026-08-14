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
// ONE THING DOES NOT TRAVEL THAT WAY: a line break. It is a real Enter
// keystroke, not a character — see the long note on `type_text` (defect NL-1).
//
// All Win32 calls are funneled through three `Box<dyn Fn>` seams so unit tests
// swap fakes in without touching the OS (the whole pipeline is headless-
// testable — the injection path is human-audit-sensitive and must be provable
// without a live desktop).

use crate::inject::correction::CorrectionOps;

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
}

/// Sender callback: take a slice of UTF-16 code units, push them to the OS,
/// return the number the OS accepted. 0 maps to `AppRejected`.
type Sender = Box<dyn Fn(&[u16]) -> Result<usize, InjectError> + Send + Sync>;

/// Backspacer callback: send `n` BACKSPACE keystrokes (down+up). Returns the
/// number the OS accepted (0 maps to `AppRejected`).
type Backspacer = Box<dyn Fn(usize) -> Result<usize, InjectError> + Send + Sync>;

/// Enter callback: press RETURN once (down+up). Returns the number of
/// keystrokes the OS accepted — 1 on success, 0 maps to `AppRejected`.
///
/// Deliberately a THIRD seam rather than a payload for `Sender`: a line break
/// does not travel as a Unicode code unit at all (see `type_text`), so it is a
/// different kind of event, not a different character.
type Enterer = Box<dyn Fn() -> Result<usize, InjectError> + Send + Sync>;

/// Primary text-injection client. `new()` wires the real Win32 path;
/// `with_fakes()` swaps all three seams for unit tests.
pub struct SendInputClient {
    sender: Sender,
    backspacer: Backspacer,
    enter: Enterer,
}

impl SendInputClient {
    pub fn new() -> Self {
        Self {
            sender: Box::new(real_send_unicode),
            backspacer: Box::new(real_send_backspaces),
            enter: Box::new(real_send_enter),
        }
    }

    pub fn with_fakes(
        sender: impl Fn(&[u16]) -> Result<usize, InjectError> + Send + Sync + 'static,
        backspacer: impl Fn(usize) -> Result<usize, InjectError> + Send + Sync + 'static,
        enter: impl Fn() -> Result<usize, InjectError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            sender: Box::new(sender),
            backspacer: Box::new(backspacer),
            enter: Box::new(enter),
        }
    }

    /// UTF-16 encode `text` and forward to the sender, TRANSLATING EVERY LINE
    /// BREAK INTO A REAL ENTER KEYSTROKE. Returns the number of keystroke units
    /// the OS accepted. Empty input returns Ok(0).
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
    /// So '\n', '\r\n' and a lone '\r' each become exactly ONE Enter keystroke,
    /// and the text around them is sent as before.
    ///
    /// VK_RETURN key-down/key-up rather than a CR (U+000D) UNICODE unit: the
    /// keystroke is the same event the user's own Enter key produces, so a
    /// target that decides line breaks from the key event rather than from the
    /// resulting WM_CHAR still sees what it waits for. Choosing the CR unit
    /// would fix Notepad while leaving that class of target broken in a way this
    /// path cannot observe — the exact shape of the defect being fixed here.
    ///
    /// ⚠️ THE COUNT: one Enter counts as one unit, so `"a\r\nb"` returns 3 and
    /// not the 4 UTF-16 units the string measures. The number says what was
    /// sent, not what the string was. Both callers are fine with that and there
    /// are only two: `sendinput_outcome::map_sendinput_outcome` binds it as
    /// `Ok(_queued)` and never reads it, and `apply_correction` below drops it.
    pub fn type_text(&self, text: &str) -> Result<usize, InjectError> {
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
            accepted += self.press_enter()?;
            // "\r\n" is ONE line break, not two. `\r` and `\n` are ASCII, so
            // both slice offsets are on char boundaries.
            let consumed = if rest[brk..].starts_with("\r\n") { 2 } else { 1 };
            rest = &rest[brk + consumed..];
        }
        Ok(accepted)
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

    /// One line break. A refused Enter fails the whole call rather than being
    /// skipped — silently dropping it is the defect this function exists for.
    fn press_enter(&self) -> Result<usize, InjectError> {
        let pressed = (self.enter)()?;
        if pressed == 0 {
            return Err(InjectError::AppRejected);
        }
        Ok(pressed)
    }

    /// Apply a correction: backspace the differing suffix, then type the new
    /// suffix. Order matters — backspaces run first so the cursor is
    /// positioned when new text streams in.
    ///
    /// The append half goes through `type_text`, so a line break inside a
    /// correction gets the same Enter keystroke as one in a finished utterance.
    /// It is the second entry point to the NL-1 loss and is asserted separately
    /// in the tests for that reason.
    pub fn apply_correction(&self, ops: &CorrectionOps) -> Result<(), InjectError> {
        if ops.backspaces > 0 {
            let bs = (self.backspacer)(ops.backspaces)?;
            if bs == 0 {
                return Err(InjectError::AppRejected);
            }
        }
        if !ops.append.is_empty() {
            let _ = self.type_text(&ops.append)?;
        }
        Ok(())
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

    if sent == 0 {
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        if err.0 == 0 {
            return Err(InjectError::AppRejected);
        }
        return Err(InjectError::Win32(err.0));
    }
    Ok((sent as usize) / 2)
}

/// Send `count` down+up pairs of a VIRTUAL KEY.
///
/// This is the other half of the module and the opposite of `real_send_unicode`
/// above: `wVk` carries the key and `KEYEVENTF_UNICODE` is absent, which is what
/// makes the OS treat it as a real keypress instead of a character. Both callers
/// need exactly that — BACKSPACE cannot be expressed as a character at all, and
/// a line break (NL-1) must not be, because the character form of it is what
/// edit controls silently drop.
#[cfg(target_os = "windows")]
fn real_send_vk_pairs(
    vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
    count: usize,
) -> Result<usize, InjectError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    };

    if count == 0 {
        return Ok(0);
    }

    let mut inputs: Vec<INPUT> = Vec::with_capacity(count * 2);
    for _ in 0..count {
        let down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let up = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
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

    if sent == 0 {
        let err = unsafe { windows::Win32::Foundation::GetLastError() };
        if err.0 == 0 {
            return Err(InjectError::AppRejected);
        }
        return Err(InjectError::Win32(err.0));
    }
    Ok((sent as usize) / 2)
}

#[cfg(target_os = "windows")]
fn real_send_backspaces(count: usize) -> Result<usize, InjectError> {
    real_send_vk_pairs(windows::Win32::UI::Input::KeyboardAndMouse::VK_BACK, count)
}

/// One RETURN keystroke — the line-break half of NL-1.
#[cfg(target_os = "windows")]
fn real_send_enter() -> Result<usize, InjectError> {
    real_send_vk_pairs(windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN, 1)
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
/// ⚠️ NOTE WHAT THIS COSTS, so it is not discovered later: `apply_correction`
/// (streaming realtime correction — backspace the changed suffix, retype it) goes
/// through these two functions, so it does not work on macOS either. That is the
/// same deferral, not a separate gap, and it is the reason this arm names the
/// mechanism instead of shrugging.
#[cfg(not(target_os = "windows"))]
fn real_send_unicode(_units: &[u16]) -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 SendInput typing. macOS V1 delivers text through the clipboard main path \
         (inject/macos/pasteboard.rs); the CGEvent typing path is deferred on purpose",
    ))
}

#[cfg(not(target_os = "windows"))]
fn real_send_backspaces(_count: usize) -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 backspace chords (streaming correction). Same deferral as the typing path \
         above — there is no clipboard equivalent of a backspace, so correction degrades",
    ))
}

#[cfg(not(target_os = "windows"))]
fn real_send_enter() -> Result<usize, InjectError> {
    Err(InjectError::Unsupported(
        "Stage-2 RETURN keystroke (line breaks in typed text). Same deferral as the typing path \
         above — and unlike the backspace, nothing is lost by it: the clipboard main path carries \
         the text's own line breaks, so macOS never needs one synthesised",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// One thing the client asked the OS to do. All three seams write into a
    /// SINGLE log on purpose: the line-break work (NL-1) is as much about ORDER
    /// as about content — 「a」Enter「b」 and 「a」「b」Enter are both "one Enter and
    /// two batches", and only one of them is two lines in the right order.
    ///
    /// 🔴 WHAT THE TESTS BELOW DO NOT PROVE. Every seam here is a fake, so each
    /// assertion is about what we hand to Win32 and nothing else. That a
    /// VK_RETURN pair actually produces a line break in a real edit control is a
    /// claim about Windows, and no headless test can make it — it belongs to the
    /// device line. What is proven here is the half that was actually broken:
    /// that a '\n' no longer leaves as a character.
    #[derive(Debug, PartialEq, Eq)]
    enum Op {
        Units(Vec<u16>),
        Enter,
        Backspace(usize),
    }

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// A client that records every call, in order, and accepts all of them.
    fn recording_client() -> (SendInputClient, Arc<Mutex<Vec<Op>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (t, b, e) = (log.clone(), log.clone(), log.clone());
        let client = SendInputClient::with_fakes(
            move |units| {
                t.lock().unwrap().push(Op::Units(units.to_vec()));
                Ok(units.len())
            },
            move |n| {
                b.lock().unwrap().push(Op::Backspace(n));
                Ok(n)
            },
            move || {
                e.lock().unwrap().push(Op::Enter);
                Ok(1)
            },
        );
        (client, log)
    }

    #[test]
    fn empty_text_is_a_noop_returning_zero() {
        let (client, log) = recording_client();
        assert_eq!(client.type_text("").unwrap(), 0);
        assert!(log.lock().unwrap().is_empty(), "no OS call for empty input");
    }

    #[test]
    fn ascii_encodes_one_unit_per_char() {
        let (client, log) = recording_client();
        let n = client.type_text("hi").unwrap();
        assert_eq!(n, 2);
        assert_eq!(*log.lock().unwrap(), vec![Op::Units(utf16("hi"))]);
    }

    #[test]
    fn cjk_is_one_unit_per_bmp_char() {
        let (client, log) = recording_client();
        let n = client.type_text("你好").unwrap();
        assert_eq!(n, 2, "each CJK BMP char is one UTF-16 unit");
        assert_eq!(*log.lock().unwrap(), vec![Op::Units(vec![0x4F60, 0x597D])]);
    }

    #[test]
    fn emoji_is_a_surrogate_pair_of_two_units() {
        let (client, log) = recording_client();
        // U+1F600 → high+low surrogate, two consecutive units in one batch.
        let n = client.type_text("😀").unwrap();
        assert_eq!(n, 2, "an astral-plane emoji is two UTF-16 units");
        assert_eq!(*log.lock().unwrap(), vec![Op::Units(vec![0xD83D, 0xDE00])]);
    }

    #[test]
    fn sender_returning_zero_maps_to_app_rejected() {
        let client = SendInputClient::with_fakes(|_| Ok(0), |_| Ok(0), || Ok(0));
        assert!(matches!(client.type_text("x"), Err(InjectError::AppRejected)));
    }

    // ── NL-1: line breaks leave as keystrokes, never as characters ────────────

    #[test]
    fn a_newline_becomes_an_enter_keystroke_and_never_a_raw_lf_unit() {
        let (client, log) = recording_client();
        client.type_text("a\nb").unwrap();
        let log = log.lock().unwrap();
        assert_eq!(
            *log,
            vec![Op::Units(utf16("a")), Op::Enter, Op::Units(utf16("b"))]
        );
        // The defect itself: a 0x000A reaching the UNICODE path IS the loss —
        // Windows accepts the event, counts it, and the edit control drops it.
        for op in log.iter() {
            if let Op::Units(units) = op {
                assert!(
                    !units.contains(&0x000A),
                    "a bare LF unit is exactly what gets silently eaten: {units:?}"
                );
                assert!(
                    !units.contains(&0x000D),
                    "CR is not sent as a character either: {units:?}"
                );
            }
        }
    }

    #[test]
    fn crlf_is_one_enter_not_two() {
        let (client, log) = recording_client();
        client.type_text("a\r\nb").unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Units(utf16("a")), Op::Enter, Op::Units(utf16("b"))],
            "a CRLF pair is one line break; two Enters would open a blank line"
        );
    }

    #[test]
    fn a_lone_cr_is_also_one_enter() {
        let (client, log) = recording_client();
        client.type_text("a\rb").unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Units(utf16("a")), Op::Enter, Op::Units(utf16("b"))]
        );
    }

    #[test]
    fn the_returned_count_still_counts_every_newline() {
        // The shape from the real-device report: three items joined by two '\n'
        // — 32 text chars + 2 breaks = 34, which is what BOTH ends already
        // account for. This fix must not make that number move, or a correct
        // accounting would start looking like a partial send.
        let (client, _) = recording_client();
        let text = "aaaaaaaaaaa\nbbbbbbbbbb\nccccccccccc";
        assert_eq!(text.chars().count(), 34, "the report's 34-char utterance");
        assert_eq!(client.type_text(text).unwrap(), 34);
    }

    #[test]
    fn a_crlf_pair_counts_as_the_one_keystroke_it_becomes() {
        // 4 UTF-16 units in the string, 3 keystroke units on the wire. The count
        // reports what was SENT; nothing compares it to the text length
        // (`map_sendinput_outcome` ignores the value, `apply_correction` drops
        // it), so this is a truthful number rather than a regression.
        let (client, _) = recording_client();
        assert_eq!("a\r\nb".encode_utf16().count(), 4);
        assert_eq!(client.type_text("a\r\nb").unwrap(), 3);
    }

    #[test]
    fn text_and_breaks_keep_their_order_including_the_edges() {
        let (client, log) = recording_client();
        client.type_text("\n你好\n\n😀").unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![
                Op::Enter,
                Op::Units(vec![0x4F60, 0x597D]),
                Op::Enter,
                Op::Enter,
                Op::Units(vec![0xD83D, 0xDE00]),
            ],
            "leading, doubled and interior breaks all keep their place, and no \
             empty batch is emitted around them"
        );
    }

    #[test]
    fn a_trailing_newline_sends_its_enter_and_no_empty_batch() {
        // An empty batch would be handed to the real sender as an empty slice,
        // which answers Ok(0) — indistinguishable from the app refusing us.
        let (client, log) = recording_client();
        assert_eq!(client.type_text("hi\n").unwrap(), 3);
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Units(utf16("hi")), Op::Enter]
        );
    }

    #[test]
    fn a_newline_only_utterance_is_one_enter_and_nothing_else() {
        let (client, log) = recording_client();
        assert_eq!(client.type_text("\n").unwrap(), 1);
        assert_eq!(*log.lock().unwrap(), vec![Op::Enter]);
    }

    #[test]
    fn an_enter_the_app_refuses_is_a_rejection_not_a_silent_skip() {
        // "No silent failures": if the keystroke is refused we must say so, not carry on
        // and report a success whose line break never happened.
        let client = SendInputClient::with_fakes(|u| Ok(u.len()), Ok, || Ok(0));
        assert!(matches!(
            client.type_text("a\nb"),
            Err(InjectError::AppRejected)
        ));
    }

    #[test]
    fn apply_correction_backspaces_before_appending() {
        // "hello world" → "hello there": 5 backspaces then type "there".
        let ops = CorrectionOps {
            backspaces: 5,
            append: "there".to_string(),
        };
        let (client, log) = recording_client();
        client.apply_correction(&ops).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Backspace(5), Op::Units(utf16("there"))],
            "backspaces first, then one append batch"
        );
    }

    #[test]
    fn apply_correction_pure_append_sends_no_backspaces() {
        let ops = CorrectionOps {
            backspaces: 0,
            append: " world".to_string(),
        };
        let (client, log) = recording_client();
        client.apply_correction(&ops).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Units(utf16(" world"))],
            "no backspaces on pure append"
        );
    }

    #[test]
    fn a_correction_append_translates_its_line_breaks_too() {
        // The second entry point to the same loss. Asserted separately because
        // 「it delegates to type_text」 is a fact about today's code, and this
        // test is what keeps it one.
        let ops = CorrectionOps {
            backspaces: 2,
            append: "x\ny".to_string(),
        };
        let (client, log) = recording_client();
        client.apply_correction(&ops).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![
                Op::Backspace(2),
                Op::Units(utf16("x")),
                Op::Enter,
                Op::Units(utf16("y")),
            ]
        );
    }
}

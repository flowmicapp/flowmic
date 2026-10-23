// SPEC-REF:
//   docs/strategy/2026-10-16-msix-sendinput-spike.md §3.2 (the measurement)
//   docs/strategy/2026-10-16-uipi-silent-inject-design.md (this module's design)
//   docs/rebuild/15-INJECTION-PERMISSION.md (named failure surfaces of injection)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// ── WHAT THIS MODULE ANSWERS ────────────────────────────────────────────────
//
// 「Will Windows even deliver our synthetic input to the window we are about to
// type into?」 — asked BEFORE Stage 1, so a refusal can never cost the user a
// foreground switch, a clipboard write or a keystroke.
//
// 🔴 THE MEASURED FACT IT RESTS ON (2026-10-16, dev-pc-a, spike report
// §3.2 NC3/NC4): when FlowMic runs at Medium integrity and the target window's
// process runs at High (an elevated terminal, Task Manager, an editor started
// "as administrator"), User Interface Privilege Isolation drops BOTH the typing
// path (`SendInput` VK_PACKET) and the paste path (`Ctrl+V` via `SendInput`)
// WITHOUT any API reporting an error. FlowMic answered `ok=true`
// (mode=sendinput / mode=clipboard), the phone showed success, nothing arrived,
// and the clipboard had already been restored. 5 of 5 such trials failed that
// way; the same rig at High→High and Medium→Medium landed 20/20.
//
// ── WHY INTEGRITY RIDs, AND NOT `TokenElevation` ────────────────────────────
// UIPI is defined over mandatory integrity levels, not over 「is this process
// elevated」. A Medium-plus process, a Low (AppContainer-ish) sender, or a
// System-integrity window all sit on the same axis, and an elevation boolean
// collapses that axis into two points. Comparing the RIDs is the rule Windows
// itself applies: a sender may not drive a window whose integrity is HIGHER than
// its own; equals do not guard each other (which is exactly why owner's machine,
// where every process is High, never showed this).
//
// ── WHY `Unknown` NEVER REFUSES ─────────────────────────────────────────────
// This repo has paid twice for a refusal that fired on things it could not see
// (0.2.19 refused every browser dictation). When either integrity level cannot
// be read, the verdict is `Unknown` and the frame proceeds exactly as before;
// the forensic line says WHICH read failed so the field can tell us how often.
// Measured 2026-10-16 (design doc §2): a UAC-filtered Medium token
// (Administrators deny-only, privileges stripped) CAN read a same-user High
// process's integrity with PROCESS_QUERY_LIMITED_INFORMATION + TOKEN_QUERY; it
// CANNOT open a SYSTEM process (winlogon: OpenProcess → ERROR_ACCESS_DENIED).
//
// ── WHY NOT A MESSAGE PROBE ─────────────────────────────────────────────────
// Measured the same day: a Medium sender's `SendMessageTimeout` to a High window
// SUCCEEDS for WM_NULL and WM_GETTEXTLENGTH (UIPI lets them through) and fails
// with ERROR_ACCESS_DENIED only for messages ≥ WM_USER — and sending an
// arbitrary WM_USER message into a third-party window is an act with app-defined
// side effects. So there is no harmless message that answers this question.

use crate::inject::pipeline::InjectOutcome;

/// One process's mandatory integrity level, as read off its token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntegrityReading {
    /// The last sub-authority of the token's mandatory label SID
    /// (`SECURITY_MANDATORY_*_RID`: 0x1000 Low, 0x2000 Medium, 0x2100 Medium
    /// Plus, 0x3000 High, 0x4000 System).
    Rid(u32),
    /// We could not read it. The tag names the step that failed, so the
    /// forensic line distinguishes 「no process behind this window」 from
    /// 「access denied」 — two facts with different field frequencies.
    Unknown(&'static str),
}

/// Everything the judgement needs, as plain data — so it is pure and provable
/// on every platform, including the ones that can never produce it (same
/// reasoning as `preflight::SyntheticInputFacts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UipiFacts {
    /// FlowMic's own integrity.
    pub sender: IntegrityReading,
    /// FlowMic's own `TokenUIAccess`. A UIAccess process is exempt from UIPI.
    /// `None` ⇒ could not be read; treated as 「not UIAccess」, which can only
    /// move the verdict towards the integrity comparison, never past it.
    pub sender_ui_access: Option<bool>,
    /// The integrity of the process that owns the target window.
    pub target: IntegrityReading,
    /// That process's id, for the forensic line only (0 ⇒ none was found).
    pub target_pid: u32,
}

/// The judgement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UipiVerdict {
    /// Same or lower integrity: UIPI does not stand between us.
    Deliverable,
    /// We hold UIAccess: UIPI does not apply to us at all.
    UiAccess,
    /// 🔴 The target is at a HIGHER integrity than we are: Windows will drop
    /// every synthetic key we send it, silently.
    TargetAbove { sender: u32, target: u32 },
    /// One of the two levels could not be read. Proceed — see the module note.
    Unknown(&'static str),
}

impl UipiVerdict {
    /// The one verdict that means 「injection cannot land」.
    pub fn blocks_input(self) -> bool {
        matches!(self, UipiVerdict::TargetAbove { .. })
    }

    /// Stable token for the forensic line.
    pub fn tag(self) -> &'static str {
        match self {
            UipiVerdict::Deliverable => "deliverable",
            UipiVerdict::UiAccess => "ui_access",
            UipiVerdict::TargetAbove { .. } => "target_above",
            UipiVerdict::Unknown(_) => "unknown",
        }
    }
}

/// The whole judgement, pure.
pub fn uipi_verdict(facts: UipiFacts) -> UipiVerdict {
    if facts.sender_ui_access == Some(true) {
        return UipiVerdict::UiAccess;
    }
    match (facts.sender, facts.target) {
        (IntegrityReading::Rid(sender), IntegrityReading::Rid(target)) => {
            if target > sender {
                UipiVerdict::TargetAbove { sender, target }
            } else {
                UipiVerdict::Deliverable
            }
        }
        (IntegrityReading::Unknown(why), _) => UipiVerdict::Unknown(why),
        (_, IntegrityReading::Unknown(why)) => UipiVerdict::Unknown(why),
    }
}

#[cfg(any(windows, test))]
fn reading_text(r: IntegrityReading) -> String {
    match r {
        IntegrityReading::Rid(rid) => format!("0x{rid:x}"),
        IntegrityReading::Unknown(why) => format!("unknown({why})"),
    }
}

/// One forensic line per consultation, refusal or not — a log that only
/// records the interesting case has no baseline to compare it against (the
/// lesson recorded at `pipeline::inject_text`).
#[cfg(any(windows, test))]
fn record(hwnd: u64, facts: UipiFacts, verdict: UipiVerdict) {
    let consequence = if verdict.blocks_input() {
        " — Windows UIPI silently drops SendInput and Ctrl+V into a higher-integrity \
         window (measured 2026-10-16). REFUSED as INJECT_TARGET_ELEVATED before Stage 1: \
         no foreground switch, no clipboard write, no keystroke"
    } else {
        ""
    };
    crate::forensic::record(
        "inject",
        &format!(
            "uipi hwnd={hwnd} target_pid={} sender_il={} target_il={} ui_access={} verdict={}{consequence}",
            facts.target_pid,
            reading_text(facts.sender),
            reading_text(facts.target),
            match facts.sender_ui_access {
                Some(true) => "true",
                Some(false) => "false",
                None => "unknown",
            },
            verdict.tag(),
        ),
    );
}

/// 🔴 THE PIPELINE'S HOOK. Called before Stage 1 on the text and image paths,
/// with the window the frame is about to be typed into, and (NR-267-F1) before
/// the foreground switch on the control:key chord path (`socket/inject_ops.rs`
/// `run_control_key_with`; punctuation keys reach it through `inject_text`).
///
/// `Some(outcome)` ⇒ that IS the answer; `None` ⇒ proceed.
///
/// History: until `INJECT_TARGET_ELEVATED` was registered (2026-10-16, MAIN
/// ruled the new code; design doc §3 lists why no registered code could say
/// this truthfully) this hook only observed. It now refuses `TargetAbove` and
/// nothing else — `Unknown` and `Deliverable` still proceed exactly as before.
#[cfg(any(windows, test))]
pub fn uipi_preflight(hwnd: u64) -> Option<InjectOutcome> {
    let facts = read_facts(hwnd);
    let verdict = uipi_verdict(facts);
    record(hwnd, facts, verdict);
    refusal_for(verdict)
}

/// 🔴 THE REFUSAL, as a pure function of the verdict so every platform can test
/// it. `TargetAbove` is the ONLY verdict that refuses.
///
/// `mode: Cached` — the same reasoning as the macOS pair in
/// `preflight::synthetic_input_verdict`: the frame reached this PC and its row is
/// minted; only the typing did not happen, and nothing we called failed (the
/// whole point of UIPI is that nothing reports an error). It is NOT transient:
/// an elevated window does not lower itself, and a retry after the user moved on
/// would type the sentence into whatever is in front by then. That is enforced
/// on the phone: `kTransientInjectionVerdictCodes` leaves it out, so the outbox
/// settles it terminal (pinned by `apps/mobile/test/verdict_target_elevated_test.dart`).
/// ⚠️ Like every other `Cached` outcome it is NOT recorded in the permanent dedup
/// table (`socket/inject_ops.rs`, the `mode != Cached` guard before `record`;
/// rejected in design doc §5). NR-267-A: it IS remembered for 105 s in a separate
/// short-lived memory (`socket/dedup_elevated.rs`), so a phone that does not know
/// this code and re-sends the same id inside its live window gets this refusal
/// replayed instead of being typed into whatever window is in front by then.
pub fn refusal_for(verdict: UipiVerdict) -> Option<InjectOutcome> {
    let UipiVerdict::TargetAbove { sender, target } = verdict else {
        return None;
    };
    Some(InjectOutcome {
        ok: false,
        mode: crate::inject::InjectMode::Cached,
        error_code: Some(crate::error_codes::INJECT_TARGET_ELEVATED),
        error_message: Some(format!(
            "target window's process integrity 0x{target:x} is above FlowMic's 0x{sender:x}; \
             Windows UIPI drops SendInput and Ctrl+V into it without reporting an error, so \
             nothing was typed and the clipboard was not touched. The row is on the PC's \
             timeline and can be re-injected into a window that is not elevated."
        )),
        focus_evidence: None,
    })
}

#[cfg(all(windows, not(test)))]
fn read_facts(hwnd: u64) -> UipiFacts {
    win::read_facts(hwnd)
}

/// Off Windows there is no UIPI: nothing to read, nothing to log, proceed.
/// (macOS and Linux have their own gate in `preflight::synthetic_input_preflight`.)
#[cfg(all(not(windows), not(test)))]
pub fn uipi_preflight(_hwnd: u64) -> Option<InjectOutcome> {
    None
}

// ── The test seam ────────────────────────────────────────────────────────────
// Thread-local for the same reason as `preflight`'s: `cargo test` runs tests on
// parallel threads, and a test must never read the facts of the machine it runs
// on (memory note 「先核你的尺子」 ("check your ruler first")). The default is
// 「equal integrity」, so no existing test moves.

#[cfg(test)]
thread_local! {
    static TEST_FACTS: std::cell::Cell<UipiFacts> = const {
        std::cell::Cell::new(DEFAULT_TEST_FACTS)
    };
    static TEST_SEEN: std::cell::RefCell<Vec<u64>> = const {
        std::cell::RefCell::new(Vec::new())
    };
}

#[cfg(test)]
const DEFAULT_TEST_FACTS: UipiFacts = UipiFacts {
    sender: IntegrityReading::Rid(0x2000),
    sender_ui_access: Some(false),
    target: IntegrityReading::Rid(0x2000),
    target_pid: 0,
};

#[cfg(test)]
fn read_facts(hwnd: u64) -> UipiFacts {
    TEST_SEEN.with(|s| s.borrow_mut().push(hwnd));
    TEST_FACTS.with(|c| c.get())
}

/// The window handles this thread's pipeline consulted, in order. Lets a test
/// pin WHICH window was judged and that it was judged before Stage 1.
#[cfg(test)]
pub(crate) fn take_seen() -> Vec<u64> {
    TEST_SEEN.with(|s| std::mem::take(&mut *s.borrow_mut()))
}

#[cfg(windows)]
pub(crate) mod win {
    use super::{IntegrityReading, UipiFacts};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
        TokenUIAccess, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    /// Closes the handle on every exit path, including the early returns.
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn token_of(process: HANDLE) -> Result<Owned, &'static str> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .map_err(|_| "open_token_denied")?;
        Ok(Owned(token))
    }

    fn integrity_of_token(token: HANDLE) -> IntegrityReading {
        // TOKEN_MANDATORY_LABEL is a pointer followed by the SID it points at,
        // so the buffer is sized by asking first. u64-aligned storage keeps the
        // pointer read aligned.
        let mut needed: u32 = 0;
        let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed) };
        if needed == 0 || needed > 4096 {
            return IntegrityReading::Unknown("token_size");
        }
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buf.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
        };
        if ok.is_err() {
            return IntegrityReading::Unknown("token_query_failed");
        }
        let label = unsafe { &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
        let sid = label.Label.Sid;
        if sid.0.is_null() {
            return IntegrityReading::Unknown("no_label_sid");
        }
        let count = unsafe { *GetSidSubAuthorityCount(sid) };
        if count == 0 {
            return IntegrityReading::Unknown("no_label_rid");
        }
        IntegrityReading::Rid(unsafe { *GetSidSubAuthority(sid, u32::from(count) - 1) })
    }

    fn ui_access_of_token(token: HANDLE) -> Option<bool> {
        let mut value: u32 = 0;
        let mut len: u32 = 0;
        unsafe {
            GetTokenInformation(
                token,
                TokenUIAccess,
                Some((&mut value as *mut u32).cast()),
                std::mem::size_of::<u32>() as u32,
                &mut len,
            )
        }
        .ok()
        .map(|_| value != 0)
    }

    pub(crate) fn read_facts(hwnd: u64) -> UipiFacts {
        // Our own token. `GetCurrentProcess` is a pseudo-handle and must not be
        // closed, so it is not wrapped in `Owned`.
        let (sender, sender_ui_access) = match token_of(unsafe { GetCurrentProcess() }) {
            Ok(t) => (integrity_of_token(t.0), ui_access_of_token(t.0)),
            Err(why) => (IntegrityReading::Unknown(why), None),
        };

        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid as *mut u32)) };
        let target = if pid == 0 {
            IntegrityReading::Unknown("no_window_process")
        } else {
            match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
                Err(_) => IntegrityReading::Unknown("open_process_denied"),
                Ok(p) => {
                    let process = Owned(p);
                    match token_of(process.0) {
                        Ok(t) => integrity_of_token(t.0),
                        Err(why) => IntegrityReading::Unknown(why),
                    }
                }
            }
        };
        UipiFacts {
            sender,
            sender_ui_access,
            target,
            target_pid: pid,
        }
    }
}

#[cfg(test)]
pub(crate) fn with_test_facts(facts: UipiFacts) -> TestFactsGuard {
    TEST_FACTS.with(|c| c.set(facts));
    TestFactsGuard
}

#[cfg(test)]
pub(crate) struct TestFactsGuard;

#[cfg(test)]
impl Drop for TestFactsGuard {
    fn drop(&mut self) {
        TEST_FACTS.with(|c| c.set(DEFAULT_TEST_FACTS));
    }
}

#[cfg(test)]
#[path = "uipi_tests.rs"]
mod tests;

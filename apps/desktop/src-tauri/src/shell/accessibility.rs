// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §4 R11
//   docs/decisions/2026-08-07-owner-grants-error-code-62-compose-output-rejected.md
//     (the sibling case: a refusal is only useful where the user can act on it)
//
// macOS Accessibility permission — TOLD TO THE PERSON WHO CAN GRANT IT.
//
// ── 🔴 WHY THIS MODULE EXISTS AT ALL ────────────────────────────────────────
//
// The check already existed and already worked. `inject::preflight` calls the
// real `AXIsProcessTrusted()`, refuses with `INJECT_NO_ACCESSIBILITY`, and
// writes a good sentence.
//
// 🔴 AND THE MAC WAS NOT SILENT — the first draft of this header said it was,
// and that was measured false before a line of UI existed. `INJECT_NO_ACCESSIBILITY`
// is in `CACHED_CAUSE_CODES` and has a PC sentence in all nine languages, so the
// capsule drew 「还没给 FlowMic「辅助功能」权限 · 系统设置 ▸ 隐私与安全性 ▸ 辅助功能」
// on its 📥 face every single time. Writing 「the Mac says nothing」 here would
// have been a comment asserting the behaviour of code somewhere else, and wrong
// — 反 façade ④, in the module built to answer this very defect.
//
// [measured, owner's Mac, window-forensics.log, 2026-08-17] between 08:34:27 and
// 08:41 EIGHT utterances refused with `ax_trusted=false`, each one drawing that
// line; System Settings was opened at 08:42:00. So what the reader got was:
//   ① a sentence that appears only AFTER an utterance has already failed,
//   ② which flashes and retreats to the tray with the capsule, and
//   ③ which spells out a menu path with nothing to press.
// The gap this module closes is therefore not silence — it is that the answer
// was transient, after-the-fact, and not actionable. macOS keys an Accessibility
// grant to the application's code signature, so a fresh install or a change of
// signing identity is exactly when this state is most likely and most confusing.
//
// ⚠️ CLAUDE.md carries a standing note that `inject:result` codes are 「只有手机
// 看得到…别给桌面补文案」 ("only the phone sees these — do not add desktop copy
// for them"). ⚠️ That note is itself out of date for this code — the capsule DOES
// render it (above) — but its intent still applies and this module is still the
// exception to it, for a reason that is not a preference: **the action is on the
// Mac.** A standing, pressable notice is warranted here precisely because the
// switch that fixes it is in System Settings on the machine showing the notice.
//
// ── 🔴 THIS IS A PULL, AND IT ASKS THE OS EVERY TIME ────────────────────────
//
// Not a value cached at start-up, and not a value pushed once. The user grants
// the permission WHILE the app is running — that is the whole flow — and
// `AXIsProcessTrusted()` reflects the new grant on the next call. A cached
// answer would leave the notice on screen after the user fixed it, which is the
// 「提示生命周期必须匹配事实生命周期」 failure (owner 2026-08-01): a notice that
// outlives its fact teaches people to ignore notices.
//
// ── ⚠️ AND IT DOES NOT PROMPT ───────────────────────────────────────────────
//
// `secure_input::accessibility_trusted` is deliberately the prompt-free variant,
// for the reason stated at its declaration. This module keeps that: it REPORTS,
// and [`open_accessibility_settings`] is a separate action the user chooses.
// Raising a system dialog from a status read would put a window over whatever
// they are typing in.

/// What the front end needs to decide whether to say anything.
///
/// 🔴 `supported` and `trusted` are two facts, not one tri-state boolean. On
/// Windows and Linux there is no such permission, and「不适用」 is a different
/// sentence from 「还没授权」 — collapsing them would make a Windows build
/// capable of telling a user to open a System Settings pane that does not exist.
#[derive(serde::Serialize)]
pub struct AccessibilityStatus {
    /// Does this platform have the permission at all? macOS only.
    pub supported: bool,
    /// `AXIsProcessTrusted()` right now. Meaningless when `supported` is false,
    /// and reported as `true` there so that no caller which forgets to check
    /// `supported` can accidentally render a warning on Windows.
    pub trusted: bool,
    /// Is this copy running from macOS's App Translocation mount?
    ///
    /// 🔴 A THIRD FACT, AND IT IS NOT A DETAIL OF `trusted`. `trusted` answers
    /// 「现在授权了吗」 ("is it granted right now"). This answers 「这一份还有没有
    /// 可能被授权」 ("can this copy ever BE granted") — and when it is `true` the
    /// answer to the second question is NO, no matter what the user does in
    /// System Settings. Folding it into `trusted` would leave the UI repeating
    /// an instruction that cannot succeed, which is exactly the failure this
    /// module was built to end (see the header): the notice was not silent, it
    /// was unactionable.
    ///
    /// [measured, owner's Mac mini, 2026-08-24] The user granted Accessibility,
    /// confirmed the switch was on, and restarted FlowMic — three times — and
    /// injection kept refusing. The running executable was
    /// `/private/var/folders/hj/…/T/AppTranslocation/37629DE1-…/d/FlowMic-2.app/
    /// Contents/MacOS/flowmic-desktop`, `~/Downloads/FlowMic-2.app` still carried
    /// Safari's `com.apple.quarantine`, and `/Applications` held no copy at all.
    /// The app's own log answered `ax_trusted=false` six times across the minutes
    /// they spent granting it. The bundle is properly Developer ID signed
    /// (`TeamIdentifier=Y8NBFNKL3F`, `spctl` = 「Notarized Developer ID」), so the
    /// ad-hoc-rebuild caveat in `inject/macos/secure_input.rs` was NOT the cause
    /// and would have sent the next reader down the wrong path.
    pub translocated: bool,
}


/// Ask the OS, now.
#[tauri::command]
pub fn accessibility_status() -> AccessibilityStatus {
    #[cfg(target_os = "macos")]
    {
        // `unwrap_or(false)` is the safe degrade, stated rather than defaulted:
        // if we cannot read our own path we claim NOTHING about the location and
        // the UI keeps saying 「grant it」, which is what it says today. Claiming
        // 「move it」 on a guess would send a correctly-installed user to reinstall.
        let translocated = std::env::current_exe()
            .ok()
            .map(|p| crate::inject::preflight::is_translocated_path(&p.to_string_lossy()))
            .unwrap_or(false);
        AccessibilityStatus {
            supported: true,
            trusted: crate::inject::macos::secure_input::accessibility_trusted(),
            translocated,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        AccessibilityStatus { supported: false, trusted: true, translocated: false }
    }
}

/// Open System Settings at Privacy & Security ▸ Accessibility.
///
/// 🔴 The URL is the documented Apple scheme, and it is the ONLY part of this
/// module that can rot without a compiler noticing: Apple renamed the app from
/// System Preferences to System Settings in Ventura and the pane identifiers
/// survived, but a future rename would leave this opening nothing. The failure
/// direction is chosen accordingly — see the return value.
///
/// ⚠️ Returns whether the OPEN was accepted, which is NOT the same as「设置面板
/// 出现在用户眼前」. `open` exiting 0 means launch services took the URL. This
/// function does not claim more than it measured, and the front end's copy
/// therefore keeps naming the path in words as well as offering the button — so
/// a user whose pane never appeared still knows where to go.
#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const PANE: &str =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
        std::process::Command::new("open")
            .arg(PANE)
            .status()
            .map_err(|e| format!("could not start `open`: {e}"))
            .and_then(|s| {
                if s.success() {
                    crate::forensic::record("inject", "opened the Accessibility settings pane");
                    Ok(())
                } else {
                    Err(format!("`open` exited {}", s.code().unwrap_or(-1)))
                }
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Not silently Ok(()): a caller that reached this on Windows has a bug,
        // and an Ok would hide it behind a button that appears to work.
        Err("no Accessibility permission exists on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one thing worth pinning on every platform: a non-macOS build must
    /// never report a permission problem, because it has no permission to have a
    /// problem with. Without this, a `supported`-blind front end would show macOS
    /// copy on Windows.
    #[test]
    #[cfg(not(target_os = "macos"))]
    fn a_platform_without_the_permission_never_looks_untrusted() {
        let s = accessibility_status();
        assert!(!s.supported, "this platform has no Accessibility permission");
        assert!(s.trusted, "trusted must be true where the question does not apply");
        assert!(
            !s.translocated,
            "a platform with no Gatekeeper translocation must never claim it"
        );
        assert!(
            open_accessibility_settings().is_err(),
            "opening a pane that does not exist must fail loudly, not pretend"
        );
    }

    /// On macOS the value is whatever the machine says — asserting a particular
    /// answer would be asserting the state of the developer's System Settings.
    /// What IS assertable: it is a real reading, so two calls agree.
    #[test]
    #[cfg(target_os = "macos")]
    fn the_reading_is_stable_within_a_process() {
        let a = accessibility_status();
        assert!(a.supported);
        assert_eq!(a.trusted, accessibility_status().trusted);
        // Whether THIS build happens to be translocated is a property of how the
        // suite was launched, so it is not asserted. What is asserted is that the
        // reported fact is the one the detector derives from our own path, i.e.
        // that the command reports a reading and not a constant.
        let derived = std::env::current_exe()
            .ok()
            .map(|p| crate::inject::preflight::is_translocated_path(&p.to_string_lossy()))
            .unwrap_or(false);
        assert_eq!(a.translocated, derived);
    }
}

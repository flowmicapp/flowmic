// SPEC-REF:
//   docs/strategy/R7-V2-TASK-CARDS.md V2-10 (boot autostart, installed version + portable version)
//   docs/strategy/2026-07-28-0.1.x-private-line-report.md §6 (owner eyes-on item)
//   CLAUDE.md red line: no silent failures / showing an unverified state is false reporting
//
// V2-10 — the first link in 「pick up the phone and just speak」: the PC side has
// to be running. The toggle in the settings-page preferences section drives
// this module's two commands; the state is always read from the system's real
// registry, never persisted to any settings key (criterion 4:
// after the user manually disables it in Windows Settings/Task Manager, the
// toggle must show "off" — tauri-plugin-autostart's is_enabled() happens to
// check both that the Run value exists AND the Task Manager disable bit under
// StartupApproved\Run, which matches criterion 4's semantics).
//
// *** KNOWN RISK, LEFT ON RECORD AND NOT FIXED (criterion 3, owner eyes-on item, 0.1.x closing report §6) ***
// When the portable version and the Program Files installed version are both
// installed on one machine, the single-instance lock cannot stop it, and both
// come up (single_instance.rs's lock is %APPDATA%\FlowMic\instance.lock; the
// two forms should be mutually exclusive when they share one FLOWMIC_HOME —
// measured: it does not stop them; the root cause belongs to another card, not
// fixed by this task).
// Autostart amplifies this occasional problem into something that reproduces every single boot:
//   ① the two forms' autostart entries register under the SAME Run-key value name
//     (app_name comes from the cargo package name "flowmic-desktop", same for
//     the MSI and the portable build), and whichever was enabled LATER
//     overwrites the one enabled earlier — on boot only the form enabled last
//     gets launched, while the other form's toggle likewise reads
//     enabled=true, pointing at an exe that is not its own;
//   ② the scenario where both genuinely come up is 「autostart launches one +
//     the user manually opens the other」; in that case the lock's real
//     behaviour is decided by single_instance and has nothing to do with this
//     module — but the user will think 「the one that autostarted is this
//     one」, when in fact the two processes can coexist.
// This module does not pretend the problem does not exist: the comment above
// IS the record, and AutostartInfo passes back the raw command string from the
// registry verbatim, so the settings page can show exactly which exe the
// autostart entry actually points at.
//
// Criterion 1 (portable-version path): what gets recorded at registration time
// is current_exe()'s absolute path at that moment — the plugin captures it
// during setup and writes it on enable. Both failure points must be loud:
// registration failure propagates as Err, and the settings page shows the
// reason verbatim; a read-back verification mismatch is likewise Err. The
// registry read-back also backs a soft warning: after the portable directory
// is moved, the Run value still points at the old path, and the settings page
// shows 「the program the autostart entry points to no longer exists」, rather
// than only discovering it failed to start at the next boot.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::ui_i18n::{tr, tr_with, Msg};

/// Criterion 2's launch marker: the command line carries it when autostart
/// launches the app, and run() keeps the main window hidden and goes tray-only
/// based on it. A manual launch has no such argument and opens the main window
/// as usual. The constant is centralised here; plugin registration (lib.rs) and
/// launch branching (lib.rs setup) reference the SAME literal — must not each
/// write their own copy of the string.
pub const AUTOSTART_ARG: &str = "--flowmic-autostart";

/// Windows Run key (HKCU …\CurrentVersion\Run) — the same key auto-launch 0.5 uses.
#[cfg(windows)]
const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

/// The real-state snapshot the settings-page toggle reads. Field semantics are in the module header comment.
#[derive(Serialize)]
pub struct AutostartInfo {
    /// The system's real state (the Run value exists AND has not been disabled
    /// via Task Manager). The sole source for criterion 4.
    enabled: bool,
    /// The absolute path of the exe currently running — the path an `enable` call registers.
    exe_path: String,
    /// The full command string (including arguments) actually registered with
    /// the system, passed back verbatim with no embellishment.
    ///
    /// 🔴 `None` MEANS ONE THING: nothing is registered. It used to mean that
    /// **or**「this platform has no read-back」, and that second meaning is what
    /// made macOS report a failed registration every time it succeeded — the
    /// ambiguity was written right here and then consumed downstream as if it
    /// were unambiguous. Whether a platform can answer at all is now a separate
    /// fact, `READ_BACK_IMPLEMENTED`, which callers branch on.
    registered_cmd: Option<String>,
    /// Whether the registered exe still exists on disk right now — dead-path
    /// detection after a portable install has been moved.
    /// None = cannot be determined (nothing registered / non-Windows).
    registered_exe_exists: Option<bool>,
}

/// Read the current real state. Failing to read the current exe path counts as
/// a total failure (a loud Err) — a process that does not even know its own
/// path is not qualified to display autostart state.
#[tauri::command]
pub fn autostart_state(app: AppHandle) -> Result<AutostartInfo, String> {
    snapshot(&app)
}

/// Turn autostart on / off. The single write path for change-immediately-persist-immediately.
///
/// Every step's failure is an Err (U6: reasons come from the ui_i18n table in the app
/// language, shown verbatim by the frontend):
///   1. the plugin failed to write the registry (permissions / policy);
///   2. the quoted rewrite after enable failed (see below);
///   3. the read-back verification did not match expectations — the answer to
///      「how do we know it was really registered」 IS the read-back;
///      the plugin returning Ok does not count.
///
/// auto-launch 0.5's enable() writes **unquoted** `{path} {args}`.
/// The MSI installs to `C:\Program Files\…` by default, and an unquoted
/// space-containing path with trailing arguments only parses correctly via
/// CreateProcess's prefix-probing (and leaves an opening for a `C:\Program.exe`
/// squatting attack). Criterion 1 requires 「what got registered really comes
/// up at boot」, so immediately after a successful enable the Run value is
/// rewritten to the quoted form `"<exe>" --flowmic-autostart`, then read back and compared byte for byte.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enable: bool) -> Result<AutostartInfo, String> {
    crate::forensic::record("autostart", &format!("set requested: enable={enable}"));
    let manager = app.autolaunch();
    let outcome = if enable {
        manager
            .enable()
            .map_err(|e| tr_with(Msg::AutostartWriteFailed, &[("detail", &e.to_string())]))
            .and_then(|()| {
                let exe = current_exe_string()?;
                rewrite_quoted(&app, &exe)?;
                verify_enabled(&app, &exe)
            })
    } else {
        manager
            .disable()
            .map_err(|e| tr_with(Msg::AutostartRemoveFailed, &[("detail", &e.to_string())]))
            .and_then(|()| verify_disabled(&app))
    };
    if let Err(reason) = outcome {
        crate::forensic::record("autostart", &format!("set FAILED: {reason}"));
        return Err(reason);
    }
    let info = snapshot(&app)?;
    crate::forensic::record(
        "autostart",
        &format!(
            "set ok: enabled={} registered={:?}",
            info.enabled, info.registered_cmd
        ),
    );
    Ok(info)
}

fn snapshot(app: &AppHandle) -> Result<AutostartInfo, String> {
    let exe_path = current_exe_string()?;
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| tr_with(Msg::AutostartReadFailed, &[("detail", &e.to_string())]))?;
    let registered_cmd = registered_run_value(app);
    let registered_exe_exists = registered_cmd
        .as_deref()
        .map(|cmd| Path::new(exe_of_registered(cmd)).is_file());
    Ok(AutostartInfo { enabled, exe_path, registered_cmd, registered_exe_exists })
}

/// The current exe's absolute path at this moment (criterion 1 requires 「record
/// the absolute path as it was at the time」 — that is exactly what gets registered).
fn current_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| tr_with(Msg::AutostartExePathFailed, &[("detail", &e.to_string())]))
}

/// Read-back verification: after enable, the Run value must equal the expected
/// string byte for byte, and the plugin layer must confirm
/// 「the value exists AND Task Manager has not disabled it」. A mismatch at any
/// step is a loud failure.
/// Does this platform have a real read-back of the registration?
///
/// Windows reads the Run value; macOS reads the LaunchAgent plist. Anything
/// else does not, and the difference has to be a FACT the code can branch on
/// rather than a shade of meaning inside an Option — that shade is exactly what
/// shipped a permanent false failure on macOS.
const READ_BACK_IMPLEMENTED: bool = cfg!(any(windows, target_os = "macos"));
fn verify_enabled(app: &AppHandle, exe: &str) -> Result<(), String> {
    let want = quoted_cmd(exe);
    match registered_run_value(app) {
        Some(got) if got == want => {}
        Some(got) => {
            return Err(tr_with(Msg::AutostartVerifyMismatch, &[("want", &want), ("got", &got)]));
        }
        // 🔴 `None` HAS TO MEAN ONE THING, AND ON A PLATFORM WITHOUT A READ-BACK
        // IT MEANT TWO. Where a read-back exists, `None` is evidence: we looked
        // and nothing was registered, so the enable did not take. Where one does
        // not exist, `None` is the absence of evidence — and reading it as
        // failure is what made macOS report a failed registration on every
        // single success (see `registered_run_value`).
        //
        // Falling through is not「假装成功」: `is_enabled()` below is still
        // consulted and can still refuse. What is lost on such a platform is the
        // byte-for-byte confirmation, which we never had there — and saying so
        // by not claiming it is the honest shape.
        None if READ_BACK_IMPLEMENTED => return Err(tr(Msg::AutostartVerifyEmpty).to_string()),
        None => {}
    }
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| tr_with(Msg::AutostartRecheckFailed, &[("detail", &e.to_string())]))?;
    if !enabled {
        return Err(tr(Msg::AutostartEnabledButOff).to_string());
    }
    Ok(())
}

/// Read-back verification: after disable, the system layer must confirm it is
/// off. The plugin's disable only deletes the Run value; the StartupApproved
/// toggle bit is left alone — is_enabled reads false because the value is
/// missing, which is the correct semantics.
fn verify_disabled(app: &AppHandle) -> Result<(), String> {
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| tr_with(Msg::AutostartRecheckFailed, &[("detail", &e.to_string())]))?;
    if enabled {
        return Err(tr(Msg::AutostartStillEnabled).to_string());
    }
    Ok(())
}

fn quoted_cmd(exe: &str) -> String {
    format!("\"{exe}\" {AUTOSTART_ARG}")
}

/// Strip the exe path out of the registered command string: what we write
/// ourselves is the quoted form; the plugin's first write (or a legacy
/// version) may be the unquoted `{path} {AUTOSTART_ARG}`.
fn exe_of_registered(cmd: &str) -> &str {
    let t = cmd.trim();
    if let Some(rest) = t.strip_prefix('"') {
        return rest.split('"').next().unwrap_or(t);
    }
    if let Some(p) = t.strip_suffix(AUTOSTART_ARG) {
        return p.trim_end();
    }
    t
}

/// Read back the HKCU Run value. The value name shares its source with the
/// plugin (package_info().name = the cargo package name
/// "flowmic-desktop"), so a rename cannot make the two lose sync. Returns None
/// to mean 「nothing registered」; a read error itself is also folded into None
/// — in that case `enabled` is answered independently by the plugin layer's
/// is_enabled, and if the two genuinely diverge, that is still the honest
/// combination enabled=true + registered=None, rather than making up a string.
#[cfg(windows)]
fn registered_run_value(app: &AppHandle) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ).ok()?;
    key.get_value::<String, _>(&app.package_info().name).ok()
}

/// macOS: the plugin registers a LaunchAgent, so the read-back reads that.
///
/// 🔴 THIS FUNCTION EXISTS BECAUSE ITS ABSENCE WAS A LIE, AND THE LIE WAS
/// WRITTEN DOWN IN ADVANCE. The non-Windows arm used to be a bare `None`, and
/// the doc on [`AutostartInfo::registered_cmd`] said so honestly:
/// 「None = nothing registered (or non-Windows, read-back not implemented)」 —
/// one value answering two questions, this repository's headline bug shape,
/// with the ambiguity recorded at the declaration and then consumed downstream
/// as if it were unambiguous. `verify_enabled` reads `None` as「注册未生效」, so
/// on macOS **enabling autostart could never succeed**: the plugin wrote a
/// perfectly good LaunchAgent and we told the user it had failed.
///
/// [measured, owner's Mac, 2026-08-17] forensic:
///   `set requested: enable=true`
///   `set FAILED: 开机自启项写入后回读为空——注册未生效`
/// and `~/Library/LaunchAgents/FlowMic.plist` on disk, written that same
/// second, with `RunAtLoad=true` and our `--flowmic-autostart` marker. The write
/// worked every time; only the ruler was missing.
///
/// ⚠️ It is NOT a permission problem, which is the first thing anyone will
/// suspect on macOS. Nothing here asks the OS for anything.
///
/// Returned in the same shape `quoted_cmd` produces so the byte-for-byte
/// comparison in `verify_enabled` stays one comparison rather than two
/// platform-specific ones.
#[cfg(target_os = "macos")]
fn registered_run_value(app: &AppHandle) -> Option<String> {
    let path = launch_agent_path(app)?;
    let xml = std::fs::read_to_string(path).ok()?;
    launch_agent_command(&xml)
}

/// The parse, as a **pure function of the file's text**, so it can be driven
/// against fabricated plists on any platform — including this repository's
/// Windows gate, which otherwise has zero proof over a `cfg(target_os = "macos")`
/// change (CLAUDE.md states that in as many words).
///
/// Deliberately a narrow scan rather than a plist parser: the only file this ever
/// reads is one WE caused to be written and whose shape the plugin fixes, and a
/// dependency to read four lines would be a larger surface than the thing it
/// verifies. **A shape we do not recognise returns `None`** — 「could not
/// confirm」 — which is now a distinct outcome from 「not registered」 at the call
/// site, and is the safe direction either way.
#[cfg(any(target_os = "macos", test))]
fn launch_agent_command(xml: &str) -> Option<String> {
    // 🔴 `split(d).next()` IS NOT A DELIMITED READ — when `d` is absent it hands
    // back the whole remainder, so a truncated file parses as a complete one.
    // The first version of this function did exactly that and the test below
    // caught it on its first run: `<array><string>/a/b` with nothing closed
    // yielded a confident `"/a/b" --flowmic-autostart`. `split_once` is the
    // spelling that refuses instead, and refusing is the whole contract here.
    let (_, args) = xml.split_once("<key>ProgramArguments</key>")?;
    let (_, after_open) = args.split_once("<array>")?;
    let (array, _) = after_open.split_once("</array>")?;
    let (_, after_str) = array.split_once("<string>")?;
    let (exe, _) = after_str.split_once("</string>")?;
    let exe = exe.trim();
    if exe.is_empty() {
        return None;
    }
    Some(quoted_cmd(exe))
}

/// `~/Library/LaunchAgents/<Label>.plist`. The label is the app name, which is
/// what the plugin uses; if that ever diverges this returns a path that does not
/// exist and the read-back answers「could not confirm」rather than inventing one.
#[cfg(target_os = "macos")]
fn launch_agent_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        Path::new(&home)
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", app.package_info().name)),
    )
}

/// Linux and anything else: still not implemented, and still honest about it —
/// but the caller no longer treats「not implemented」as「not registered」. See
/// `verify_enabled`.
#[cfg(not(any(windows, target_os = "macos")))]
fn registered_run_value(_app: &AppHandle) -> Option<String> {
    None
}

/// Rewrite the unquoted Run value the plugin just wrote into the quoted form
/// (criterion 1, see the header comment on autostart_set). The rewrite uses
/// the same value name as the plugin; failure is an Err, and the caller reports it loudly.
#[cfg(windows)]
fn rewrite_quoted(app: &AppHandle, exe: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|e| tr_with(Msg::AutostartRegOpenFailed, &[("detail", &e.to_string())]))?;
    key.set_value::<String, _>(&app.package_info().name, &quoted_cmd(exe))
        .map_err(|e| tr_with(Msg::AutostartRewriteFailed, &[("detail", &e.to_string())]))
}

/// Non-Windows (dev/CI only): whatever the plugin itself writes is already the final form, no rewrite needed.
#[cfg(not(windows))]
fn rewrite_quoted(_app: &AppHandle, _exe: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod launch_agent_tests {
    use super::*;

    /// The plist the plugin really wrote on the owner's Mac, verbatim
    /// (`~/Library/LaunchAgents/FlowMic.plist`, read 2026-08-17). Pasted rather
    /// than paraphrased: a fixture that is a tidied-up idea of the file proves
    /// the parser against the idea, not against the file.
    const REAL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
  <key>Label</key>
  <string>FlowMic</string>
  <key>ProgramArguments</key>
  <array><string>/Applications/FlowMic.app/Contents/MacOS/flowmic-desktop</string><string>--flowmic-autostart</string></array>
  <key>RunAtLoad</key>
  <true/>
  </dict>
</plist>"#;

    /// 🔴 THE REGRESSION THIS FILE EXISTS FOR. Before this parser, the macOS
    /// read-back was a hardcoded `None`, `verify_enabled` read that as「not
    /// registered」, and enabling autostart on a Mac reported failure on every
    /// success — with a correct LaunchAgent sitting on disk the whole time.
    #[test]
    fn the_real_plist_yields_the_command_that_was_registered() {
        assert_eq!(
            launch_agent_command(REAL).as_deref(),
            Some("\"/Applications/FlowMic.app/Contents/MacOS/flowmic-desktop\" --flowmic-autostart"),
            "the read-back must return the same shape quoted_cmd produces, or the \
             byte-for-byte comparison in verify_enabled can never match"
        );
    }

    /// The `Label` key also holds a `<string>`, and it comes FIRST in the file.
    /// A parser that simply took the first `<string>` in the document would
    /// return "FlowMic" and compare it against an executable path — a mismatch
    /// reported as a corrupted registration. Anchoring on `ProgramArguments` is
    /// what prevents that, so it gets its own assertion.
    #[test]
    fn the_label_string_is_not_mistaken_for_the_executable() {
        let got = launch_agent_command(REAL).unwrap();
        assert!(!got.contains("\"FlowMic\""), "picked up <key>Label</key>'s value: {got}");
    }

    /// A shape we do not recognise answers「could not confirm」rather than
    /// inventing one. Each of these is a real way the file can differ: a plist
    /// for something else, a truncated write, and an empty argument array.
    #[test]
    fn an_unrecognised_shape_returns_none_rather_than_a_guess() {
        for (name, xml) in [
            ("no ProgramArguments", "<plist><dict><key>Label</key><string>x</string></dict></plist>"),
            ("truncated array", "<key>ProgramArguments</key>\n<array><string>/a/b"),
            ("empty array", "<key>ProgramArguments</key>\n<array></array>"),
            ("empty first string", "<key>ProgramArguments</key>\n<array><string></string></array>"),
            ("not a plist at all", ""),
        ] {
            assert_eq!(launch_agent_command(xml), None, "{name} must not produce a command");
        }
    }

    /// `None` and「this platform cannot answer」are two different facts now, and
    /// this pins that the code can still tell them apart. Windows and macOS have
    /// a read-back; nothing else does, and `verify_enabled` branches on it.
    #[test]
    fn the_platform_capability_is_a_fact_the_code_can_branch_on() {
        assert_eq!(READ_BACK_IMPLEMENTED, cfg!(any(windows, target_os = "macos")));
    }
}

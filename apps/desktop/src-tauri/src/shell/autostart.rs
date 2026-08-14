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
    /// The full command string (including arguments) actually registered in the
    /// registry, passed back verbatim with no embellishment;
    /// None = nothing registered (or non-Windows, read-back not implemented).
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
fn verify_enabled(app: &AppHandle, exe: &str) -> Result<(), String> {
    let want = quoted_cmd(exe);
    match registered_run_value(app) {
        Some(got) if got == want => {}
        Some(got) => {
            return Err(tr_with(Msg::AutostartVerifyMismatch, &[("want", &want), ("got", &got)]));
        }
        None => return Err(tr(Msg::AutostartVerifyEmpty).to_string()),
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

#[cfg(not(windows))]
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

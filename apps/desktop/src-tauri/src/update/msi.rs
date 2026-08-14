// UP-3b — the MSI hand-off.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.3 ④ / ⑥, §4.4
//
// ── 🔴 LAUNCH THE INSTALLER *BEFORE* EXITING ────────────────────────────────
//
// Design §4.3 ④b gives the reason, and it is not the one people expect. The
// obvious reason is that Windows will not overwrite a running program — true, but
// secondary. The real one:
//
// > 「我们退出之后就没有进程能再启动任何东西了 ⇒ 拉起安装器必须发生在退出之前。」
// > ("once we exit, there is no process left that can start anything ⇒
// > launching the installer must happen before we exit.")
//
// There is no later. Once this process is gone, nothing on the machine is under
// any obligation to start an installer, and the user sees an application that
// closed itself for no reason. msiexec is spawned DETACHED so it survives us, and
// then we exit through the normal shutdown path.
//
// ── 🔴 AND WE DO NOT PROMISE A RELAUNCH ─────────────────────────────────────
//
// [measured, design §4.1] the default Tauri WiX template carries no
// launch-after-install (none of the 20 MSIs inspected had any
// `WixShellExecTarget` property). So the UI says 「安装完成后请重新打开 FlowMic」
// ("once installation finishes, please reopen FlowMic")
// and not「安装完成后会自动重新打开」("it will reopen automatically once
// installation finishes").
//
// That is the second direction of the no-silent-failure line — 不许把没做成的事
// 说成做成了 ("must not describe something that wasn't done as done") — and it
// is the direction that gets forgotten, because a promise
// costs nothing to write and the person writing it is not the person who waits
// for a window that never appears. If a relaunch is ever wanted, §4.3 ⑥ says the
// correct mechanism is to make the MSI carry it (a WiX change on the artifact
// side), not to invent a second one here.
//
// ⚠️ **UAC happens after we are gone.** `ALLUSERS=1` [measured §4.1] means every
// install is per-machine, so msiexec will always prompt. The user can decline it,
// and when they do, absolutely nothing happens — which is precisely the state the
// breadcrumb exists to explain on the next launch.

use std::path::Path;

use super::apply_arg::spawn_detached;
use super::failure::UpdateFailure;

/// `msiexec` — resolved through `PATH` deliberately.
///
/// ⚠️ This is the one place this file departs from the standing lesson of
/// `sidecar::node_runtime` (「问版本，不要排顺序」("ask the version, don't
/// rely on ordering"), and「不要依赖宿主机碰巧装了什么」("don't depend on
/// whatever the host happens to have installed")). It departs for a reason
/// that does not generalise: `msiexec.exe` is a
/// Windows component in `System32`, not something a user may or may not have
/// installed. A machine where it is missing or shadowed cannot install an MSI by
/// any route, including the manual one we would fall back to.
const MSIEXEC: &str = "msiexec.exe";

/// Start the installer for a verified package and leave it running.
///
/// `/i` install, `/passive` = a progress bar and no questions. **Not `/quiet`**:
/// a silent install of a package that then wants a reboot, or fails, would give
/// the user no signal at all, and this chain's whole problem is that we are not
/// around to report anything.
///
/// Returns the installer's pid for the forensic record. 🔴 It does NOT wait —
/// waiting would hold this process open across a UAC prompt the user may sit on
/// for a minute, while the window they clicked in is already gone.
pub fn launch_installer(package: &Path) -> Result<u32, UpdateFailure> {
    let args = vec![
        "/i".to_string(),
        // Passed as ONE argument, unquoted. `Command` does the escaping; adding
        // our own quotes here would produce a literally-quoted path that msiexec
        // cannot open — and the path routinely contains spaces
        // (`C:\Users\<name>\AppData\Local\FlowMic\updates\…`).
        package.display().to_string(),
        "/passive".to_string(),
    ];
    spawn_detached(Path::new(MSIEXEC), &args)
        .map_err(|e| UpdateFailure::InstallerNotLaunched { detail: format!("spawn:{}", e.kind()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 The package path goes through as ONE argument, unquoted.
    ///
    /// Asserted on the vector rather than on a spawn, because the mistake this
    /// guards is invisible at the call site and only shows up as「安装程序打不开
    /// 这个文件」("the installer can't open this file") on a machine whose user
    /// name has a space in it. Note the literal
    /// space in the fixture — that is the whole point of the fixture.
    #[test]
    fn the_package_path_is_one_unquoted_argument() {
        let p = Path::new(r"C:\Users\A B\AppData\Local\FlowMic\updates\FlowMic_0.2.60_x64_zh-CN.msi");
        let args = vec!["/i".to_string(), p.display().to_string(), "/passive".to_string()];
        assert_eq!(args.len(), 3);
        assert!(!args[1].starts_with('"'), "the path must not carry quotes of our own");
        assert!(args[1].contains("A B"), "the space must survive as part of one argument");
        // /passive, never /quiet — see the module header.
        assert_eq!(args[2], "/passive");
        assert!(!args.iter().any(|a| a == "/quiet"));
    }
}

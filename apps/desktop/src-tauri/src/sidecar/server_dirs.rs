// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §5 (resolving server.js).
//
// Which directories to look in for `server.js`. Pure on purpose: the defect it
// fixes depends on which paths exist on one particular machine, so the decision
// has to be askable with paths handed in, not read from the running process.
//
// THE DEFECT (measured 1/1, 2026-11-07, Linux machine with both the .deb and the
// portable present): the portable's forensic log said
// `resolved server.js at /usr/lib/FlowMic/resources/server.js`, and it spawned
// that file with the portable's own Node. So a portable could run a server of a
// different version from its own client.
//
// The cause is in tauri-utils 2.9.3, `platform.rs`, `resource_dir_from`. On Linux,
// when `<exe>/../lib/<name>` does not exist and APPDIR is unset, it returns the
// absolute path `/usr/lib/<name>`. That path has nothing to do with the running
// executable: it belongs to whichever copy the package manager installed. On
// Windows the same function returns the executable's directory, and on macOS
// `<exe>/../Resources`, so on those two a resource dir can only ever be the
// running copy's own. That is why only Linux drops it here.

use std::path::{Path, PathBuf};

use crate::sidecar::node_runtime::linux_installed_resources;

/// The ordered directories to search for `server.js`. `is_linux` is a parameter so
/// that a test on any machine can ask the Linux question.
///
///   * Linux, exe under `usr/bin`: that install's own resources and nothing else.
///     A damaged install reports the missing file instead of borrowing a server
///     from cwd or a dev tree.
///   * Linux, anywhere else (portable, loose build): exe-sibling, dev tree, cwd.
///     `tauri_resource_dir` is ignored, see the file header.
///   * Windows and macOS: Tauri's resource dir, exe-sibling, dev tree, cwd.
pub fn server_search_dirs(
    is_linux: bool,
    exe_dir: Option<&Path>,
    tauri_resource_dir: Option<PathBuf>,
    dev_dirs: Vec<PathBuf>,
    cwd: Option<PathBuf>,
) -> Vec<PathBuf> {
    if is_linux {
        if let Some(resources) = exe_dir.and_then(linux_installed_resources) {
            return vec![resources];
        }
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    // 1. MSI / `.app`: bundled under <resource_dir>/resources/server.js.
    if !is_linux {
        if let Some(res) = tauri_resource_dir {
            dirs.push(res.join("resources"));
            dirs.push(res);
        }
    }
    // 2. exe-sibling (portable / loose build).
    if let Some(parent) = exe_dir {
        dirs.push(parent.join("resources"));
        dirs.push(parent.to_path_buf());
    }
    // 3. dev tree (src-tauri/resources + server-core/dist).
    dirs.extend(dev_dirs);
    // 4. cwd.
    if let Some(cwd) = cwd {
        dirs.push(cwd.join("resources"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    /// What Tauri hands a portable on a machine that also has the .deb. The test
    /// name is what the reverse control runs by.
    #[test]
    fn linux_portable_searches_only_its_own_tree_with_a_deb_installed() {
        let dirs = server_search_dirs(
            true,
            Some(Path::new("/home/me/FlowMic-portable")),
            Some(p("/usr/lib/FlowMic")),
            vec![p("/build/dev")],
            Some(p("/home/me")),
        );
        assert_eq!(
            dirs,
            vec![
                p("/home/me/FlowMic-portable/resources"),
                p("/home/me/FlowMic-portable"),
                p("/build/dev"),
                p("/home/me/resources"),
            ]
        );
        assert!(
            !dirs.iter().any(|d| d.starts_with("/usr/lib")),
            "a portable must not search another install's resources: {dirs:?}"
        );
    }

    /// The positive half: dropping `/usr/lib` must not cost the .deb its server.
    #[test]
    fn linux_installed_deb_uses_exactly_its_own_resources() {
        let dirs = server_search_dirs(
            true,
            Some(Path::new("/usr/bin")),
            Some(p("/usr/lib/FlowMic")),
            vec![p("/build/dev")],
            Some(p("/home/me")),
        );
        assert_eq!(dirs, vec![p("/usr/lib/FlowMic/resources")]);
    }

    /// Windows and macOS resolve as they did before this file existed.
    #[test]
    fn non_linux_order_is_resource_dir_then_exe_then_dev_then_cwd() {
        let dirs = server_search_dirs(
            false,
            Some(Path::new("C:/app")),
            Some(p("C:/res")),
            vec![p("C:/dev/a"), p("C:/dev/b")],
            Some(p("C:/cwd")),
        );
        assert_eq!(
            dirs,
            vec![
                p("C:/res/resources"),
                p("C:/res"),
                p("C:/app/resources"),
                p("C:/app"),
                p("C:/dev/a"),
                p("C:/dev/b"),
                p("C:/cwd/resources"),
            ]
        );
    }

    /// `/usr/bin` means "installed" only on Linux. Elsewhere that shortcut must not
    /// fire, whatever the path looks like.
    #[test]
    fn the_installed_shortcut_is_linux_only() {
        let dirs = server_search_dirs(false, Some(Path::new("/usr/bin")), None, vec![], None);
        assert_eq!(dirs, vec![p("/usr/bin/resources"), p("/usr/bin")]);
    }
}

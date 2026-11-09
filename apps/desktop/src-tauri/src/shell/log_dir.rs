// The folder that holds `server.log`, `window-forensics.log` and the other desktop
// diagnostics, for Settings > About. `open_log_directory` moved here from
// shell/mod.rs (FR-D2, 2026-11-06), which sits at its 800-line cap.
//
// `log_directory_path` is the answer the page shows. The page used to show a catalogue
// string spelling %LOCALAPPDATA%, which is false on Linux and macOS; the path below is
// the one `forensic` really writes to on this machine, whichever platform that is.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// The folder a log file lives in, as text for the page. `None` for a path with no
/// parent: the page then shows no address rather than a guess.
fn directory_text(log_file: &Path) -> Option<String> {
    log_file
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.to_string_lossy().into_owned())
}

fn log_file() -> PathBuf {
    crate::forensic::sibling_path("window-forensics.log")
}

#[tauri::command]
pub fn log_directory_path() -> Option<String> {
    directory_text(&log_file())
}

/// Open the directory that contains `server.log`, `window-forensics.log`, and
/// the other desktop diagnostics. Refuse a missing directory before asking the
/// OS to open it: the frontend renders every `Err` as a visible manual-path
/// fallback, so a click can never disappear silently. The `Err` text itself goes
/// to the forensic log (`openLogDirectory` in bridge-os.ts), so it is written for
/// whoever reads that log and is not translated.
#[tauri::command]
pub fn open_log_directory(app: AppHandle) -> Result<bool, String> {
    let log_file = log_file();
    let log_dir = log_file
        .parent()
        .ok_or_else(|| "cannot resolve the log directory".to_string())?;
    if !log_dir.is_dir() {
        return Err(format!("log directory missing or unreadable: {}", log_dir.display()));
    }
    let path = log_dir.to_string_lossy().into_owned();

    // Shell::open is deprecated since tauri-plugin-shell 2.1.0 in favour of
    // tauri-plugin-opener::OpenerExt::open_path. On desktop both call
    // open::that_detached (Windows → ShellExecuteExW), so opening a local
    // directory is user-visibly identical. Migrating needs a new crate +
    // plugin init + capabilities — out of this card's territory and "no new
    // deps" — so keep the existing path until that separate migration lands.
    #[allow(deprecated)]
    app.shell()
        .open(path, None)
        .map_err(|error| format!("opening the log directory failed ({}): {error}", log_dir.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_is_the_folder_the_log_file_is_in() {
        let dir = std::env::temp_dir().join("fm-fr-d2-logs");
        assert_eq!(
            directory_text(&dir.join("window-forensics.log")).as_deref(),
            Some(dir.to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn a_path_with_no_folder_has_no_answer() {
        assert_eq!(directory_text(Path::new("window-forensics.log")), None);
        assert_eq!(directory_text(Path::new("/")), None);
    }

    #[test]
    fn the_live_answer_names_the_folder_of_the_real_log() {
        let live = log_directory_path().expect("this process resolves a forensic path");
        assert!(log_file().starts_with(&live), "{live} does not hold the log file");
    }
}

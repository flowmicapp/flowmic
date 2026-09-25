//! Windows regression controls use child processes, so complete APPDATA branch
//! coverage never mutates the environment underneath unrelated parallel tests.

use super::*;
use std::process::Command;

#[test]
fn app_dirs_windows_environment_probe() {
    let Ok(mode) = std::env::var("FLOWMIC_L1_WINDOWS_PROBE") else { return; };
    let (roaming, local) = match mode.as_str() {
        "set" => (PathBuf::from(r"F:\fixture-roaming\FlowMic"), PathBuf::from(r"F:\fixture-local\FlowMic")),
        // Existing Windows semantics, deliberately preserved even for empty values.
        "empty" => (PathBuf::from("FlowMic"), PathBuf::from("FlowMic")),
        "missing" => (std::env::temp_dir().join("FlowMic"), std::env::temp_dir().join("FlowMic")),
        _ => panic!("unexpected probe case"),
    };
    validate_environment().unwrap();
    assert_eq!(roaming_home(), roaming);
    assert_eq!(config_home(), roaming);
    assert_eq!(instance_home(), roaming);
    assert_eq!(local_home(), local);
    assert_eq!(state_home().unwrap(), local);
}

#[test]
fn app_dirs_windows_keeps_all_appdata_branches_and_ignores_xdg() {
    for mode in ["set", "empty", "missing"] {
        let mut child = Command::new(std::env::current_exe().unwrap());
        child.args(["--exact", "app_dirs::windows_tests::app_dirs_windows_environment_probe", "--nocapture"])
            .env("FLOWMIC_L1_WINDOWS_PROBE", mode)
            .env("XDG_CONFIG_HOME", r"F:\wrong-config")
            .env("XDG_DATA_HOME", r"F:\wrong-data")
            .env("XDG_STATE_HOME", r"F:\wrong-state")
            .env("XDG_RUNTIME_DIR", r"F:\wrong-runtime");
        match mode {
            "set" => { child.env("APPDATA", r"F:\fixture-roaming").env("LOCALAPPDATA", r"F:\fixture-local"); }
            "empty" => { child.env("APPDATA", "").env("LOCALAPPDATA", ""); }
            _ => { child.env_remove("APPDATA").env_remove("LOCALAPPDATA"); }
        }
        let output = child.output().unwrap();
        assert!(output.status.success(), "{mode}: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

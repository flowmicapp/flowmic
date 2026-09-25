use super::*;
use std::process::Command;

fn fixture<'a>(values: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
    move |key| values.iter().find(|(name, _)| *name == key).map(|(_, value)| OsString::from(value))
}

#[test]
fn app_dirs_xdg_roles_ignore_windows_values_and_keep_distinct_homes() {
    let env = fixture(&[("HOME", "/users/a"), ("APPDATA", "/wrong/roaming"),
        ("LOCALAPPDATA", "/wrong/local"), ("XDG_CONFIG_HOME", "/config"),
        ("XDG_DATA_HOME", "/data"), ("XDG_STATE_HOME", "/state"),
        ("XDG_RUNTIME_DIR", "/runtime")]);
    for (role, want) in [(Role::Config, "/config/FlowMic"), (Role::Data, "/data/FlowMic"),
        (Role::State, "/state/FlowMic"), (Role::Runtime, "/runtime/FlowMic")] {
        assert_eq!(resolve(role, &env).unwrap(), Path::new(want));
    }
}

#[test]
fn app_dirs_empty_relative_and_missing_xdg_fall_back_to_home() {
    for value in [None, Some(""), Some("relative/path")] {
        let env = |key: &str| match key {
            "HOME" => Some(OsString::from("/users/a")),
            "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_RUNTIME_DIR" => value.map(OsString::from),
            _ => None,
        };
        for (role, want) in [(Role::Config, ".config"), (Role::Data, ".local/share"),
            (Role::State, ".local/state"), (Role::Runtime, ".local/state")] {
            assert_eq!(resolve(role, &env).unwrap(), Path::new("/users/a").join(want).join("FlowMic"));
        }
    }
}

#[test]
fn app_dirs_invalid_home_is_a_named_error_not_a_temporary_directory() {
    for value in [None, Some(""), Some("relative/home")] {
        let env = |key: &str| if key == "HOME" { value.map(OsString::from) } else { None };
        for role in [Role::Config, Role::Data, Role::State, Role::Runtime] {
            let error = resolve(role, &env).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(error.to_string().contains("HOME"));
        }
    }
    // HOME is unnecessary when each role has its own valid absolute answer.
    let env = fixture(&[("XDG_CONFIG_HOME", "/c"), ("XDG_DATA_HOME", "/d"), ("XDG_STATE_HOME", "/s")]);
    let homes = Homes::read(&env).unwrap();
    assert_eq!(homes.runtime, Path::new("/s/FlowMic"));
}

fn child(root: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "app_dirs::linux::tests::app_dirs_production_probe", "--nocapture"])
        .env("FLOWMIC_L1_PROBE", mode).env("FLOWMIC_L1_ROOT", root)
        .env("HOME", root.join("home")).env("APPDATA", root.join("wrong-roaming"))
        .env("LOCALAPPDATA", root.join("wrong-local"))
        .env("XDG_CONFIG_HOME", root.join("config")).env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_STATE_HOME", root.join("state")).env("XDG_RUNTIME_DIR", root.join("runtime"))
        .env_remove("FLOWMIC_FORENSIC_PATH");
    command
}

#[test]
fn app_dirs_production_probe() {
    let Ok(mode) = std::env::var("FLOWMIC_L1_PROBE") else { return; };
    #[cfg(feature = "app")]
    if mode == "startup-reject" {
        crate::run();
        panic!("invalid application storage must exit nonzero before starting the UI");
    }
    if mode == "reject" {
        assert!(crate::app_dirs::validate_environment().is_err());
        crate::forensic::init_default();
        assert!(!crate::forensic::is_ready(), "observer failure must stay non-panicking");
        return;
    }
    crate::app_dirs::validate_environment().unwrap();
    let root = PathBuf::from(std::env::var_os("FLOWMIC_L1_ROOT").unwrap());
    let data = root.join("data/FlowMic");
    assert_eq!(crate::sidecar::io::default_db_path(), data.join("flowmic.sqlite"));
    assert_eq!(crate::socket::Credentials::default_path(), data.join("credentials.bin"));
    let locale = crate::ui_i18n::default_locale_path();
    assert_eq!(locale, root.join("config/FlowMic/ui-locale.txt"));
    crate::ui_i18n::persist_to(&locale, crate::ui_i18n::DEFAULT_LOCALE).unwrap();
    assert!(crate::ui_i18n::load_persisted(&locale).is_some());
    assert_eq!(crate::forensic::sibling_path("server.log"), root.join("state/FlowMic/server.log"));
    crate::forensic::init_default();
    assert!(crate::forensic::is_ready());
    let lock_path = crate::single_instance::default_lock_path(None);
    assert_eq!(lock_path, root.join("runtime/FlowMic/instance.lock"));
    let lock = crate::single_instance::acquire(&lock_path);
    if mode == "occupied" { assert!(lock.is_none(), "a real second process must be excluded"); }
    else { assert_eq!(lock.unwrap().path(), Some(lock_path.as_path())); }
}

#[test]
fn app_dirs_real_callers_and_process_lock_use_the_resolved_roles() {
    let root = std::env::temp_dir().join(format!("flowmic-l1-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let lock_path = root.join("runtime/FlowMic/instance.lock");
    let holder = crate::single_instance::acquire(&lock_path).unwrap();
    assert_eq!(holder.path(), Some(lock_path.as_path()), "positive control: parent owns a real lock");
    let occupied = child(&root, "occupied").output().unwrap();
    assert!(occupied.status.success(), "{} {}", String::from_utf8_lossy(&occupied.stdout), String::from_utf8_lossy(&occupied.stderr));
    drop(holder);
    let free = child(&root, "free").output().unwrap();
    assert!(free.status.success(), "{} {}", String::from_utf8_lossy(&free.stdout), String::from_utf8_lossy(&free.stderr));
    let rejected = child(&root, "reject").env_remove("HOME").env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME").env_remove("XDG_STATE_HOME").env_remove("XDG_RUNTIME_DIR").output().unwrap();
    assert!(rejected.status.success(), "{}", String::from_utf8_lossy(&rejected.stdout));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("forensic init failed"));
    #[cfg(feature = "app")]
    {
        let startup = child(&root, "startup-reject").env_remove("HOME").env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME").env_remove("XDG_STATE_HOME").env_remove("XDG_RUNTIME_DIR").output().unwrap();
        assert_eq!(startup.status.code(), Some(1), "real run() must reject startup, not return success: {}", String::from_utf8_lossy(&startup.stderr));
        assert!(String::from_utf8_lossy(&startup.stderr).contains("REFUSING to launch"));
    }
    assert!(!root.join("wrong-roaming").exists());
    assert!(!root.join("wrong-local").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn app_dirs_startup_validates_before_file_consumers() {
    let source = include_str!("../../lib.rs");
    let run = source.split("pub fn run() {").nth(1).unwrap();
    let guard = run.find("if let Err(e) = app_dirs::validate_environment() {").unwrap();
    assert!(guard < run.find("forensic::init_default();").unwrap());
    assert!(guard < run.find("ui_i18n::init_from_disk();").unwrap());
    assert!(guard < run.find("let Some(instance_lock)").unwrap());
    let block = &run[guard..run[guard..].find("\n    }").unwrap() + guard];
    assert!(block.contains("eprintln!") && block.contains("std::process::exit(1);"));
}

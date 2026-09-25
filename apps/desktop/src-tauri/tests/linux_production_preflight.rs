// Integration tests link the non-test library: the production not(test) arm
// must compile and execute. These assert admission, not a real compositor.
#![cfg(target_os = "linux")]

#[test]
fn production_preflight_refuses_before_any_target_or_input() {
    use flowmic_desktop_lib::{error_codes, inject};
    if let Ok(case) = std::env::var("FLOWMIC_PREFLIGHT_CASE") {
        let outcome = inject::inject_text("must-not-send", Some(1), None,
            |_| panic!("production admission reached input target"));
        assert!(!outcome.ok);
        assert_eq!(outcome.mode, inject::InjectMode::Cached);
        assert_eq!(outcome.error_code, Some(if case == "unknown" {
            error_codes::INJECT_DISPLAY_UNAVAILABLE
        } else { error_codes::INJECT_WAYLAND_UNSUPPORTED }));
        assert_eq!(outcome.focus_evidence, None);
        return;
    }
    for case in ["wayland", "xwayland", "unknown"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "production_preflight_refuses_before_any_target_or_input", "--nocapture"])
            .env("FLOWMIC_PREFLIGHT_CASE", case)
            .env("XDG_SESSION_TYPE", if case == "unknown" { "" } else { "wayland" })
            .env("GDK_BACKEND", if case == "xwayland" { "x11" } else { "" })
            .env("DISPLAY", if case == "xwayland" { ":9999" } else { "" })
            .env_remove("WAYLAND_DISPLAY")
            .output().unwrap();
        assert!(output.status.success(), "{case}: {} {}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

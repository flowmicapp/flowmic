// Integration evidence from the real Tauri probe plus an independent GTK process.
#![cfg(target_os = "linux")]

#[test]
#[ignore = "requires the rebuilt real capsule probe and an active external GTK fixture"]
fn linux_capsule_preserves_real_external_focus() {
    let required = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"));
    let log = required("FLOWMIC_FOCUS_GTK_LOG");
    let read_samples = || {
        std::fs::read_to_string(&log)
            .expect("independent GTK observations")
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("GTK JSON"))
            .collect::<Vec<_>>()
    };
    let before = read_samples();
    let first = before.last().expect("GTK observation before capsule");
    assert_eq!(first["active"], true, "external window must already be active");
    let backend = required("FLOWMIC_CAPSULE_BACKEND");
    assert!(backend == "X11" || backend == "Wayland");
    let process = std::process::Command::new(required("FLOWMIC_CAPSULE_PROBE"))
        .output()
        .expect("launch real Tauri capsule process");
    println!("{}", String::from_utf8_lossy(&process.stdout));
    eprintln!("{}", String::from_utf8_lossy(&process.stderr));
    assert!(process.status.success(), "real capsule process failed");
    let stdout = String::from_utf8(process.stdout).expect("probe UTF-8");
    if backend == "Wayland" {
        let refusal = stdout.lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|value| value.get("wayland_preflight").is_some()).expect("production Wayland preflight proof");
        assert_eq!(refusal["wayland_preflight"], "refused");
        assert_eq!(refusal["mode"], "Cached");
        assert_eq!(refusal["error_code"], "INJECT_WAYLAND_UNSUPPORTED");
        assert_eq!(refusal["focus_evidence"], serde_json::Value::Null);
    }
    let samples: Vec<serde_json::Value> = stdout.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| value.get("phase").is_some()).collect();
    assert_eq!(samples.len(), 6, "all real capsule lifecycle phases");
    for sample in &samples {
        assert_eq!(sample["backend"], backend);
        assert_eq!(sample["accept_focus"], false, "native capsule accept-focus changed: {sample}");
        assert_eq!(sample["focus_on_map"], false, "native focus-on-map changed: {sample}");
        assert_eq!(sample["capsule_active"], false, "capsule stole focus: {sample}");
        if backend == "X11" {
            let xid: u64 = required("FLOWMIC_FOCUS_XID").parse().expect("decimal external XID");
            assert_eq!(sample["foreground"][0], xid, "real external X keyboard focus changed: {sample}");
        }
    }
    let expect_visible = required("FLOWMIC_CAPSULE_EXPECT_VISIBLE");
    assert!(expect_visible == "0" || expect_visible == "1");
    if expect_visible == "1" {
        assert!(samples.iter().any(|s| s["phase"] == "second-show" && s["visible"] == true));
    } else {
        assert!(samples.iter().all(|s| s["visible"] == false), "unsupported ambient capsule must be suppressed");
        let forensic = std::fs::read_to_string(required("FLOWMIC_FORENSIC_PATH")).expect("production refusal trace");
        assert_eq!(forensic.matches("Linux ambient capsule suppressed").count(), 1, "reason must be reported once");
    }
    let after = read_samples();
    assert!(after.len() > before.len(), "GTK must keep reporting during the capsule run");
    for sample in &after[before.len()..] {
        assert_eq!(sample["pid"], first["pid"]);
        assert_eq!(sample["active"], true, "external GTK focus was lost: {sample}");
        assert_eq!(sample["text"], first["text"], "capsule modified the target widget");
    }
    println!("observed {} independent GTK samples while the real capsule ran", after.len() - before.len());
}

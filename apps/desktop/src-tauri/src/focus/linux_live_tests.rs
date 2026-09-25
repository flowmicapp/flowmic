// Real external GTK fixture required; missing evidence is a failure, never a skip.
use super::*;

#[test]
#[ignore = "requires an active independent GTK X11 window and fixture environment"]
fn linux_focus_tracks_real_external_window() {
    let required = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"));
    let xid: u64 = required("FLOWMIC_FOCUS_XID").parse().expect("decimal XID");
    let title = required("FLOWMIC_FOCUS_TITLE");
    let evidence = std::fs::read_to_string(required("FLOWMIC_FOCUS_GTK_LOG"))
        .expect("external GTK observations");
    let sample: serde_json::Value = serde_json::from_str(evidence.lines().last().expect("GTK sample"))
        .expect("GTK JSON observation");
    assert_eq!(sample["backend"], "GdkX11Display");
    assert_eq!(sample["active"], true, "independent GTK window must be active");
    assert_eq!(sample["title"], title);
    let pid = sample["pid"].as_u64().expect("external PID") as u32;
    assert_ne!(pid, std::process::id());
    assert_eq!(current_backend(), DisplayBackend::X11);
    let connection = Connection::open().expect("live X display");
    assert_eq!(pid_with(&connection, xid), Some(pid));
    assert!(connection.contains_focus(xid).expect("actual X keyboard focus"));
    assert_eq!(current_foreground_hwnd(), xid);
    let actual = current_foreground_target().expect("production external target");
    assert_eq!(actual.0, xid);
    assert_eq!(actual.1, title);
    assert!(!actual.2.is_empty(), "production application identity");
    let source = WindowsWinEventSource;
    assert!(matches!(source.seed_current(), Some(FocusEvent::ForegroundChanged { hwnd, .. }) if hwnd == xid));
    let (first_tx, first_rx) = mpsc::sync_channel(8);
    let (second_tx, second_rx) = mpsc::sync_channel(8);
    let _first = source.install(first_tx);
    let _second = source.install(second_tx);
    for receiver in [first_rx, second_rx] {
        let event = receiver.recv_timeout(Duration::from_secs(2)).expect("production subscriber");
        assert!(matches!(event, FocusEvent::ForegroundChanged { hwnd, .. } if hwnd == xid));
    }
    println!("live GTK PID={pid} XID={xid} title={title}; both production subscribers observed target");
}

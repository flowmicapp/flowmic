// Real production source, not a fake FocusEvent or platform predicate.
#[cfg(target_os = "linux")]
fn main() {
    use flowmic_desktop_lib::focus::{self, WinEventSource};
    use std::time::{Duration, Instant};
    let args: Vec<String> = std::env::args().collect();
    if let Some(raw) = args
        .get(1)
        .filter(|raw| raw.as_str() == "activate")
        .and_then(|_| args.get(2))
    {
        let window = raw.parse().expect("decimal X window ID");
        let ok = focus::set_foreground_window(window);
        println!(
            "{}",
            serde_json::json!({"activate": window, "ok": ok, "foreground": focus::current_foreground_target()})
        );
        std::process::exit(if ok { 0 } else { 2 });
    }
    let seconds = args
        .get(1)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(10);
    let source = focus::WindowsWinEventSource;
    println!(
        "{}",
        serde_json::json!({"backend": format!("{:?}", focus::linux_session::current_backend()), "seed": format!("{:?}", source.seed_current())})
    );
    let first = focus::FocusTracker::start(source);
    let second = focus::FocusTracker::start(focus::WindowsWinEventSource);
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        for (subscriber, tracker) in [(1, &first), (2, &second)] {
            while let Some(event) = tracker.try_next_event() {
                println!(
                    "{}",
                    serde_json::json!({"subscriber": subscriber, "event": format!("{event:?}")})
                );
            }
        }
        println!(
            "{}",
            serde_json::json!({"foreground": focus::current_foreground_target(), "hwnd": focus::current_foreground_hwnd()})
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("linux_focus_probe requires Linux");
    std::process::exit(2);
}

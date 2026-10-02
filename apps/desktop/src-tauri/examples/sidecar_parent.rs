//! NR-136 integration-test parent. Uses the product IO with a temporary home.
#[cfg(unix)]
fn main() {
    use flowmic_desktop_lib::sidecar::io::{self, BringUpOptions, HandshakeOutcome};
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).expect("mode").clone();
    let node = args.get(2).expect("node").clone();
    let script = PathBuf::from(args.get(3).expect("script"));
    let port: u16 = args.get(4).expect("port").parse().unwrap();
    let home = PathBuf::from(args.get(5).expect("temporary home"));
    let db = home.join("flowmic.sqlite");
    // The bring-up worker must be allowed to END without signaling the child.
    let mut child = std::thread::spawn(move || {
        match mode.as_str() {
            "guarded" => match io::spawn_and_await_handshake(&node, &script, port, &db, &home, Duration::from_secs(12)) {
                HandshakeOutcome::Listening { child, .. } => child,
                _ => panic!("sidecar failed handshake"),
            },
            "reclaim" => {
                let up = io::bring_up(&BringUpOptions {
                    node_exe: node, candidate_dirs: vec![script.parent().unwrap().into()],
                    port, home, db_path: db, ..Default::default()
                });
                up.child.expect("reclaim must start a new owned child")
            }
            "pipe-only" | "kernel-only" | "unguarded" => {
                std::fs::create_dir_all(&home).unwrap();
                let mut cmd = Command::new(node);
                cmd.arg(script).args(["--mode", "standalone", "--port", &port.to_string()])
                    .env("FLOWMIC_HOME", home).env("FLOWMIC_DB_PATH", db)
                    .env_remove("FLOWMIC_PARENT_PIPE")
                    .env("FLOWMIC_DESKTOP_PID", std::process::id().to_string())
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                if mode == "pipe-only" { cmd.stdin(Stdio::piped()).env("FLOWMIC_PARENT_PIPE", "1"); }
                if mode == "kernel-only" {
                    flowmic_desktop_lib::sidecar::parent_death::configure(&mut cmd);
                    cmd.env_remove("FLOWMIC_PARENT_PIPE")
                    .env("FLOWMIC_DESKTOP_PID", std::process::id().to_string());
                    flowmic_desktop_lib::sidecar::parent_death::spawn(cmd).unwrap()
                } else { cmd.spawn().unwrap() }
            }
            _ => panic!("unknown mode"),
        }
    }).join().unwrap();
    println!("NR136 pid={} port={port}", child.id());
    std::io::stdout().flush().unwrap();
    loop {
        if child.try_wait().unwrap().is_some() { std::process::exit(2); }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(unix))]
fn main() { eprintln!("NR-136 SIGKILL integration requires Unix"); std::process::exit(1); }

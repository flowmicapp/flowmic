// EXPERIMENT (A) for card F-3 — WHICH SESSION OWNS THE ROOM after a second
// registration arrives on the SAME device token?
//
// WHY THIS EXISTS. `docs/strategy/2026-08-07-w9-legacy-fixes-and-oss-ledger.md`
// section 4.1-bis records that F-3 has to be kept as two halves. The MECHANISM half
// is settled from vendored source: `rust_socketio` 0.6's `disconnect()` cannot kill
// the cloned poll thread, the crate has no shutdown flag, and its reconnect arm
// re-installs every handler — so a session we believe we closed can register again.
// The ROOM-OWNERSHIP half is 【未验】: the previous investigation inferred it from
// 500 ms beat PHASE, and the logs carry no session identity at all, so the inference
// could not distinguish the two possible worlds. It withdrew its own recommendation
// when challenged, and the standing ruling is 【未验】, NOT 【已否决】.
//
// 🔴 SO THE WHOLE POINT IS TO ASSERT ON OBJECT IDENTITY, NEVER ON TIMING. Two
// `DesktopSocket` VALUES live in this process. Each owns its own `mobile_count`
// atomic, and after both are registered the ONLY thing that can move one of them is
// a `pc:mobile-joined` frame delivered to THAT session's socket
// (socket::presence::on_mobile_presence). So "which counter moved" is a statement
// about which object the server routed to. No correlation stands in for it.
//
// ⚠️ ORDER IS PART OF THE INSTRUMENT, not a convenience. A `pc:reconnect` ack also
// carries a `connectedMobiles` roster, and that roster ALSO writes `mobile_count`
// (pairing::apply_connected_mobiles). If the phone joined before session B
// handshook, B's counter would move because of its own ack rather than because
// frames route to it, and the reading would answer a different question. So B is
// fully registered BEFORE the orchestrator is told to bring the phone in, and this
// program prints `BOTH_READY` as the barrier that says so.
//
// It is driven by apps/desktop/scripts/f3-room-ownership-experiment.mjs, which owns
// the real server-core and the simulated mobile. Kept, not thrown away: the same
// program is the acceptance criterion for F-3's server-side half (Fix#2, card F-3-b
// in W4S's district) — after that lands, the branch this prints is what has to
// change, and nothing else about the harness does.
//
// No Tauri runtime is needed: `socket::connect` takes `bridge: None`, which is the
// property that makes this experiment cheap (golden_inject.rs relies on the same).
//
// Env:
//   FLOWMIC_SERVER_URL      server-core base URL (required in practice)
//   FLOWMIC_CRED_PATH       credential file BOTH sessions share (default: temp)
//   F3_OBSERVE_SECS         how long to keep reading the two counters (default 20)

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use flowmic_desktop_lib::socket::{self, DesktopSocket, InjectDeduper, SocketConfig};

fn env_secs(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// One session. `label` only names it in the output; nothing branches on it.
fn open_session(url: &str, cred_path: &PathBuf, ledger: &PathBuf, label: &str) -> DesktopSocket {
    match socket::connect(SocketConfig {
        url: url.to_string(),
        device_name: "FlowMic F3 Experiment PC".to_string(),
        credentials_path: cred_path.clone(),
        // An EXPLICIT throwaway ledger, same reason golden_inject gives: `None`
        // would build this machine's real dedup table under %LOCALAPPDATA%.
        deduper: Some(Arc::new(std::sync::Mutex::new(InjectDeduper::load_spec_default(
            ledger.clone(),
        )))),
        inject_foreground_allowlist: Some(Vec::new()), // never type into anything
        jwt: None,
        auth_failure: None,
        bridge: None,
        channel: socket::Channel::Lan,
        // No capsule latch: `Admission` is a CROSS-CHANNEL arbiter and both sessions
        // here are the same channel. Installing one would make it, not the server,
        // decide who is primary — i.e. the instrument would answer the question.
        admission: None,
    }) {
        Ok(s) => s,
        Err(e) => {
            println!("F3_CONNECT_FAILED session={label} err={e}");
            std::process::exit(2);
        }
    }
}

fn main() {
    let url = std::env::var("FLOWMIC_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:41879".to_string());
    let cred_path = std::env::var_os("FLOWMIC_CRED_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("flowmic-f3-{}.json", std::process::id()))
        });
    let ledger_a = cred_path.with_file_name(format!("flowmic-f3-{}-a.json", std::process::id()));
    let ledger_b = cred_path.with_file_name(format!("flowmic-f3-{}-b.json", std::process::id()));
    // Session A must REGISTER (fresh), so start from no credential at all.
    let _ = std::fs::remove_file(&cred_path);
    let _ = std::fs::remove_file(&ledger_a);
    let _ = std::fs::remove_file(&ledger_b);

    // ── session A: the incumbent. Registers fresh and writes the device token. ──
    let mut a = open_session(&url, &cred_path, &ledger_a, "A");
    if !a.wait_registered(Duration::from_secs(10)) {
        println!("F3_REGISTER_TIMEOUT session=A");
        std::process::exit(3);
    }
    let creds = a.credentials();
    println!("A_PC_ID={}", creds.pc_id.as_deref().unwrap_or("(none)"));
    println!("A_ROOM={}", creds.room_uuid.as_deref().unwrap_or("(none)"));
    println!("A_SHORT_CODE={}", a.short_code().as_deref().unwrap_or("(none)"));
    println!("A_READY");

    // ── session B: the challenger. Loads the SAME credential file, so it sends
    //    `pc:reconnect{token}` — the identical frame the F-3 zombie sends, because
    //    the zombie is a session that had already paired. ──
    let mut b = open_session(&url, &cred_path, &ledger_b, "B");
    if !b.wait_registered(Duration::from_secs(10)) {
        println!("F3_REGISTER_TIMEOUT session=B");
        std::process::exit(3);
    }
    println!("B_PC_ID={}", b.credentials().pc_id.as_deref().unwrap_or("(none)"));
    println!("B_READY");

    // The barrier: both handshakes are done, so from here a counter can only move
    // because a presence FRAME reached that session. See the ORDER note in the
    // header — without this, B's own ack roster would answer a different question.
    println!("BOTH_READY");

    // ── observe. Each line is a paired reading of the two OBJECTS, timestamped
    //    only so a human can read the log; nothing decides on the timestamp. ──
    let started = Instant::now();
    let observe = Duration::from_secs(env_secs("F3_OBSERVE_SECS", 20));
    let mut last = (usize::MAX, usize::MAX);
    while started.elapsed() < observe {
        let reading = (a.connected_mobiles(), b.connected_mobiles());
        if reading != last {
            println!(
                "MOBILES a={} b={} a_connected={} b_connected={} t_ms={}",
                reading.0,
                reading.1,
                a.is_connected(),
                b.is_connected(),
                started.elapsed().as_millis()
            );
            last = reading;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!(
        "FINAL a={} b={} a_connected={} b_connected={}",
        a.connected_mobiles(),
        b.connected_mobiles(),
        a.is_connected(),
        b.is_connected()
    );

    a.disconnect();
    b.disconnect();
    let _ = std::fs::remove_file(&cred_path);
    let _ = std::fs::remove_file(&ledger_a);
    let _ = std::fs::remove_file(&ledger_b);
    println!("F3_DONE");
}

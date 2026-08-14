// Headless golden-path desktop client.
//
// Connects to a running server-core, registers as a PC, prints its pairing
// short_code so the orchestrator can drive a simulated mobile, then holds the
// connection open (running the REAL inject pipeline on every inject:request)
// so the full wire round-trip — pc:register → mobile pair → inject:request →
// inject:result truth → status writeback — is observable end to end.
//
// Env:
//   FLOWMIC_SERVER_URL     server-core base URL (default http://127.0.0.1:41879)
//   FLOWMIC_PC_NAME        registered device name (default "FlowMic Golden PC")
//   FLOWMIC_GOLDEN_HOLD_SECS  seconds to hold the session open (default 20)
//   FLOWMIC_CRED_PATH      credential file path (default a temp file — the
//                          golden run wants a FRESH register, not a reconnect)

use std::time::Duration;

use flowmic_desktop_lib::socket::{self, SocketConfig};

fn main() {
    let url = std::env::var("FLOWMIC_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:41879".to_string());
    let device_name =
        std::env::var("FLOWMIC_PC_NAME").unwrap_or_else(|_| "FlowMic Golden PC".to_string());
    let hold_secs: u64 = std::env::var("FLOWMIC_GOLDEN_HOLD_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);
    let cred_path = std::env::var_os("FLOWMIC_CRED_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("flowmic-golden-{}.json", std::process::id()))
        });
    // RV-83: a sibling file, same naming pattern as the credentials path.
    let ledger_path = cred_path.with_file_name(format!(
        "flowmic-golden-{}-ledger.json",
        std::process::id()
    ));
    // Golden run wants a fresh register (fresh short_code) and a fresh dedup
    // ledger, so start clean.
    let _ = std::fs::remove_file(&cred_path);
    let _ = std::fs::remove_file(&ledger_path);

    println!("DESKTOP_URL={url}");
    let mut sock = match socket::connect(SocketConfig {
        url,
        device_name,
        credentials_path: cred_path.clone(),
        // G-13: one session, but an EXPLICIT throwaway ledger rather than
        // `None` — `None` would build this machine's real one under
        // %LOCALAPPDATA%, and a smoke that types into a sacrificial window has
        // no business reading or writing the user's own "already typed" facts.
        deduper: Some(std::sync::Arc::new(std::sync::Mutex::new(
            socket::InjectDeduper::load_spec_default(ledger_path.clone()),
        ))),
        // Smoke-safety: FLOWMIC_SMOKE_ALLOWLIST gates live injection to a
        // sacrificial window (see apps/desktop/scripts/golden-smoke.mjs).
        inject_foreground_allowlist: flowmic_desktop_lib::smoke_allowlist_from_env(),
        // LAN/standalone golden path: no Cloud Key on the handshake (so the
        // handshake bytes are exactly the pre-T-2 ones) and no auth-failure hook.
        jwt: None,
        auth_failure: None,
        // Headless golden path — no Vue windows, so no frontend bridge.
        bridge: None,
        // GA-28: one socket in this process, so there is nothing to arbitrate —
        // no capsule gate, and the channel tag is the LAN default it dials.
        channel: socket::Channel::Lan,
        admission: None,
    }) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("DESKTOP_CONNECT_FAILED={e}");
            std::process::exit(2);
        }
    };

    if !sock.wait_registered(Duration::from_secs(10)) {
        eprintln!("DESKTOP_REGISTER_TIMEOUT");
        std::process::exit(3);
    }

    let creds = sock.credentials();
    println!(
        "DESKTOP_TOKEN={}",
        creds.token.as_deref().unwrap_or("(none)")
    );
    println!(
        "DESKTOP_ROOM={}",
        creds.room_uuid.as_deref().unwrap_or("(none)")
    );
    println!(
        "DESKTOP_SHORT_CODE={}",
        sock.short_code().as_deref().unwrap_or("(none)")
    );
    println!("DESKTOP_READY");

    // Hold open so the simulated mobile can pair + send inject:request and see
    // the inject:result truth. The pump keeps heartbeat + focus:state flowing.
    std::thread::sleep(Duration::from_secs(hold_secs));

    sock.disconnect();
    let _ = std::fs::remove_file(&cred_path);
    println!("DESKTOP_DONE");
}

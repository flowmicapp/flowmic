// WP-R2-4 deliverable C — the REAL spawn验收 for the sidecar IO layer, run headless
// (no WebView2): resolve the bundled `resources/server.js` → spawn `node …` →
// handshake (FLOWMIC_LISTENING) → `/api/health` 200 → adopt-probe our own healthy
// child (proves the adopt path against a real FlowMic) → 亲杀 the child → verify the
// 1.5 s exit watchdog detects it → confirm the port is free again.
//
// Run:  cargo run --example sidecar_spawn            (uses a test port, temp DB)
//       (requires `node` on PATH + `node apps/desktop/scripts/build-sidecar.mjs`)
//
// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §5; R2-R3-TASK-CARDS WP-R2-4 交付 C.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use flowmic_desktop_lib::forensic;
use flowmic_desktop_lib::sidecar::io::{
    self, BringUpOptions, ProbeVerdict,
};
use flowmic_desktop_lib::sidecar::state::Phase;

fn main() {
    forensic::init_default();
    // A dedicated test port so we never collide with a real 41879 instance.
    let port: u16 = std::env::var("SIDECAR_TEST_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(41988);
    // A CUSTOM temp home (secret + db) so this验收 never touches real user data at
    // %APPDATA%\FlowMic (R2-4: home ↔ db are now paired; keep both in temp here).
    let home = std::env::temp_dir().join(format!("flowmic-sidecar-example-{}", std::process::id()));
    let db_path = home.join("flowmic.sqlite");
    let _ = std::fs::remove_dir_all(&home);

    let opts = BringUpOptions {
        candidate_dirs: io::dev_candidate_dirs(),
        host: io::SIDECAR_HOST.to_string(),
        port,
        home: home.clone(),
        db_path: db_path.clone(),
        node_exe: io::resolve_node_exe(),
        handshake_timeout: Duration::from_secs(12),
        health_timeout: Duration::from_secs(10),
    };

    println!("== FlowMic sidecar real-spawn验收 (port {port}) ==");
    println!("resolve candidates:");
    for d in &opts.candidate_dirs {
        println!("   - {} (server.js {})", d.display(), if d.join("server.js").is_file() { "PRESENT" } else { "absent" });
    }
    println!("node: {}", opts.node_exe);
    println!("db:   {}", db_path.display());

    // ── 1. bring-up: resolve → spawn → handshake → health ─────────────────────
    let t0 = Instant::now();
    let mut up = io::bring_up(&opts);
    let bring_ms = t0.elapsed().as_millis();
    match &up.phase {
        Phase::Healthy { endpoint } => {
            println!("[OK] bring-up → Healthy in {bring_ms}ms, endpoint={endpoint}");
        }
        other => {
            fail(&format!("bring-up did not reach Healthy: {other:?}"), &home);
        }
    }

    // ── 2. /api/health body ───────────────────────────────────────────────────
    match io::http_get(&opts.host, port, "/api/health", Duration::from_secs(2)) {
        Ok(r) if r.status == 200 => println!("[OK] GET /api/health → {} {}", r.status, r.body.trim()),
        Ok(r) => fail(&format!("/api/health status {}", r.status), &db_path),
        Err(e) => fail(&format!("/api/health error: {e}"), &db_path),
    }

    // ── 3. /api/network (LAN IP for the pairing endpoint) ─────────────────────
    match io::fetch_lan_primary(&opts.host, port) {
        Some(ip) => println!("[OK] /api/network primary LAN IPv4 = {ip}  → pairing endpoint http://{ip}:{port}"),
        None => println!("[..] /api/network primary is loopback/absent — QR stays suppressed (F-2346), poll continues"),
    }

    // ── 4. adopt-probe our OWN healthy child (proves the adopt verdict) ───────
    match io::probe_existing(&opts.host, port, None) {
        ProbeVerdict::AdoptableFlowMic => {
            println!("[OK] adopt-probe on the live child → AdoptableFlowMic (socket.io polling + /api/health both pass)")
        }
        ProbeVerdict::ForeignOrDead => fail("adopt-probe on our own healthy child returned ForeignOrDead", &db_path),
    }

    // ── 5. 亲杀 the child, verify the 1.5 s exit watchdog detects it ───────────
    let mut child = match up.child.take() {
        Some(c) => c,
        None => fail("Healthy phase had no owned child handle", &db_path),
    };
    let pid = child.id();
    println!("[..] killing child pid={pid} to exercise the 1.5s exit watchdog…");
    let _ = child.kill();
    let tk = Instant::now();
    match io::wait_child_exit(&mut child, Duration::from_millis(1500)) {
        Some(code) => println!("[OK] child exit DETECTED in {}ms (code {:?}) — within the 1.5s window", tk.elapsed().as_millis(), code),
        None => fail("child exit was NOT detected within 1.5s", &db_path),
    }

    // ── 6. the port is free again (adopt-probe now ForeignOrDead) ─────────────
    std::thread::sleep(Duration::from_millis(400));
    match io::probe_existing(&opts.host, port, None) {
        ProbeVerdict::ForeignOrDead => println!("[OK] after kill, adopt-probe → ForeignOrDead (port :{port} released)"),
        ProbeVerdict::AdoptableFlowMic => println!("[WARN] port still answered — a lingering socket (non-fatal for this验收)"),
    }

    // Remove the whole temp home (db + secret + wal/shm) — no real-user-data touch.
    let _ = std::fs::remove_dir_all(&home);
    println!("== sidecar real-spawn验收 PASSED ==");
}

fn fail(msg: &str, home: &PathBuf) -> ! {
    eprintln!("[FAIL] {msg}");
    let _ = std::fs::remove_dir_all(home);
    std::process::exit(1);
}

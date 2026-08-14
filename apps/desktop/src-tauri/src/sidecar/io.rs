// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (resolve chain: MSI resources → exe-sibling
//     → dev tree → cwd;
//     spawn `node server.js --mode standalone --port 41879` CREATE_NO_WINDOW +
//     strip `\\?\` prefix EISDIR fix; Node probe: PATH→Program Files→LOCALAPPDATA;
//     DB `%APPDATA%/flowmic.sqlite`; handshake FLOWMIC_LISTENING + /api/health 10s;
//     1.5s child-exit polling; adopt-first socket.io polling probe → netstat+taskkill)
//   docs/rebuild/13-LESSONS-LEARNED.md §4 (path/CRLF/kill hygiene)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-4 lead-controller ruling #1/#2/#3
//   *** HUMAN-AUDIT SENSITIVE (the taskkill path — forensic PID+name BEFORE kill,
//       only the :41879 listener, only after an adopt probe said "foreign") ***
//
// The Tauri IO layer for the sidecar FSM (sidecar::state). It performs the real
// spawn / probe / kill / handshake and feeds the RESULTS back to `SidecarMachine`,
// which is the single authority on ordering. This module is tauri-free (std only)
// so `cargo run --example sidecar_spawn` and `cargo test` exercise it WITHOUT the
// WebView2 toolchain; the resolve candidates (MSI resource dir under the `app`
// feature) are passed IN by lib.rs so the tauri path resolver stays out of here.
//
// HTTP is a hand-rolled loopback GET over std::net::TcpStream — the probe target
// is ALWAYS `http://127.0.0.1:41879` (a local child / a local FlowMic), never TLS,
// so pulling in reqwest/hyper/tokio would be pure weight against anti-façade slimming (反-façade 瘦身).

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::forensic;
use crate::sidecar::job;
use crate::sidecar::network;
pub use crate::sidecar::node_runtime::resolve_node_exe;
use crate::sidecar::node_runtime::annotate_node_version;
use crate::sidecar::state::{Action, Event, FailReason, Phase, SidecarMachine};

/// Which TCP port the local server is on, and the named override that moves it.
/// Split into its own module for the 800-line cap (`portclear.rs` / `node_runtime.rs`
/// precedent); re-exported here because every existing caller asks `io` for it.
pub use crate::sidecar::port::{
    parse_sidecar_port, sidecar_port, sidecar_port_checked, SidecarPortError,
    SIDECAR_PORT_DEFAULT, SIDECAR_PORT_ENV,
};

pub const SIDECAR_HOST: &str = "127.0.0.1";
/// Handshake window: FLOWMIC_LISTENING must appear within this (07 §5).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(12);
/// `/api/health` must return 200 within this (07 §5: 10 s).
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Child-exit watchdog poll cadence (07 §5: 1.5 s detection).
const EXIT_POLL: Duration = Duration::from_millis(250);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);

// ── path resolution ──────────────────────────────────────────────────────────

/// Strip a Windows verbatim `\\?\` prefix — a resource path handed through the
/// Tauri resolver can be verbatim, and Node's spawn chokes on it (the EISDIR-class
/// fix, 07 §5). No-op on other shapes / platforms.
pub fn normalize_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// Resolve `server.js` across the ordered candidate DIRECTORIES (07 §5:
/// MSI resource dir → exe-sibling → dev tree → cwd). Returns the first that
/// exists, path-normalized. The caller (lib.rs) supplies the app-specific
/// candidates so this stays tauri-free.
pub fn resolve_server_js(candidate_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in candidate_dirs {
        let cand = dir.join("server.js");
        if cand.is_file() {
            let norm = normalize_path(&cand);
            forensic::record("sidecar", &format!("resolved server.js at {}", norm.display()));
            return Some(norm);
        }
    }
    forensic::record(
        "sidecar",
        &format!("resolve FAILED — no server.js in {} candidate dir(s)", candidate_dirs.len()),
    );
    None
}

/// The default dev-tree candidate list relative to the crate (for the example /
/// tests): `apps/desktop/src-tauri/resources` plus the repo `apps/server-core/dist`.
pub fn dev_candidate_dirs() -> Vec<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // apps/desktop/src-tauri
    vec![
        manifest.join("resources"),
        manifest.join("..").join("..").join("server-core").join("dist"),
    ]
}


/// The standalone HOME dir — the parent of BOTH the DB and the standalone secret.
/// 07 §5 says the DB is `%APPDATA%/flowmic.sqlite`; **R2-4 correction**: the DB is nested
/// one level into `%APPDATA%\FlowMic\` so it shares a directory AND lifecycle with
/// the secret (`<home>/standalone.secret`, server identity.ts). This is the whole
/// fix for the escape defect the lead controller caught at MSI install smoke — without a paired
/// `FLOWMIC_HOME`, the server mints a cwd-based secret that cannot decrypt the DB's
/// existing `enc:v1:` seed → AES-GCM fail-loud, 335 ms exit. Falls back to the
/// system temp dir if APPDATA is unset (non-Windows / stripped env).
///
/// 🔴 In-place correction (MAC-01, 2026-08-07) — the sentence above 「Falls back
/// to the system temp dir if APPDATA is unset (non-Windows / stripped env)」
/// **was true at the time, and is wrong as macOS product behaviour**:
/// `$TMPDIR` (`/var/folders/...`) gets cleaned by macOS based on age ⇒ the DB,
/// the standalone secret, instance.lock, and ui-locale would all evaporate on
/// their own. **The original text is kept**, because
/// it accurately records why this fallback was originally written (tests /
/// non-Windows dev), and that use case has always been correct — what changed
/// is that someone put a real product on top of it.
/// The platform decision is now answered exclusively by
/// `crate::app_dirs::roaming_home()` (the three call sites previously each
/// answered the same question separately). Windows behaviour is unchanged, byte for byte.
pub fn default_home() -> PathBuf {
    crate::app_dirs::roaming_home()
}

/// The standalone DB path (07 §5: `%APPDATA%/flowmic.sqlite`; **R2-4 correction**: nested
/// under `%APPDATA%\FlowMic\` to pair with the secret — see `default_home`).
pub fn default_db_path() -> PathBuf {
    default_home().join("flowmic.sqlite")
}

// ── loopback HTTP (std only) ─────────────────────────────────────────────────

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// A minimal HTTP/1.1 GET over a loopback TcpStream. Connection: close, short
/// timeouts. Returns the status code + body; any transport error is `Err`.
pub fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> std::io::Result<HttpResponse> {
    let addr = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no addr"))?;
    let mut stream = TcpStream::connect_timeout(&addr, HTTP_CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    let mut raw = Vec::new();
    // Bounded read (health/probe bodies are tiny); Connection: close ends the read.
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break, // read timeout / reset — parse what we have
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok(HttpResponse { status, body })
}

// ── adopt probe ──────────────────────────────────────────────────────────────
// The policy (adopt vs reclaim, incl. the build-identity check) lives in
// sidecar::adopt; re-exported here so existing callers keep their `io::` paths.
pub use crate::sidecar::adopt::{is_same_script, parse_health_script, probe_existing, ProbeVerdict};

/// Poll `/api/health` until 200 within `timeout` (07 §5: health grace window).
pub fn await_health(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(r) = http_get(host, port, "/api/health", Duration::from_millis(1000)) {
            if r.status == 200 && r.body.contains("\"ok\":true") {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Fetch `/api/network` and return its `primary` LAN IPv4 (07 §5 / F-2343). The
/// server hands back a private-first, loopback/APIPA-excluded list; we read
/// `"primary":"…"`. `None` when unreachable or only loopback is available.
pub fn fetch_lan_candidates(host: &str, port: u16) -> Vec<String> {
    // GA-21: EVERY address the host has, in the server's default order — not just
    // its `primary`. The heuristic's first pick is a guess about which NIC the
    // phone shares, and on the owner's network it guesses wrong (the tablet can
    // reach 100.64.7.x, which is not RFC1918, so it never ranks first). The
    // device page lets a human override that guess; hiding the alternatives
    // would make a wrong guess unrecoverable.
    let Ok(r) = http_get(host, port, "/api/network", Duration::from_millis(1500)) else {
        return Vec::new();
    };
    if r.status != 200 {
        return Vec::new();
    }
    parse_lan_ipv4_array(&r.body)
}

/// Pull the `"lan_ipv4":[…]` array out of the /api/network body. A tiny reader
/// rather than a serde dependency at this call site, matching fetch_lan_primary's
/// existing style; unroutable entries are dropped so the picker cannot offer an
/// address that could never work.
pub fn parse_lan_ipv4_array(body: &str) -> Vec<String> {
    let key = "\"lan_ipv4\":[";
    let Some(start) = body.find(key) else { return Vec::new() };
    let rest = &body[start + key.len()..];
    let Some(end) = rest.find(']') else { return Vec::new() };
    rest[..end]
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|ip| !ip.is_empty() && !network::is_unroutable_for_lan(ip))
        .collect()
}

/// D2LAN-B2b — the sidecar's LAN TLS public-key fingerprint, from the SAME
/// `/api/network` read the LAN addresses come from.
///
/// 🔴 THIS FUNCTION IS THE TRANSPORT THE FEATURE WAS MISSING. Cards B1 (mint the
/// certificate, publish its fingerprint) and B2 (put `fp=` on the QR) both landed
/// complete and the feature was still worth nothing, because the value had no way
/// to cross this process. The design said 「桌面(Rust) 零改动」("desktop (Rust)
/// zero changes") — true of TLS
/// itself (this file speaks plain to loopback and still does), false of the
/// feature working.
///
/// `None` = the server published none: it is serving plain (no LAN TLS home, every
/// saas deployment, a mint that failed), or it is an older sidecar that does not
/// know the key. Both degrade to today's QR, never to a QR that cannot connect.
pub fn fetch_lan_tls_fingerprint(host: &str, port: u16) -> Option<String> {
    let r = http_get(host, port, "/api/network", Duration::from_millis(1500)).ok()?;
    if r.status != 200 {
        return None;
    }
    parse_lan_tls_fingerprint(&r.body)
}

/// Pull `"lan_tls_fp":"…"` out of an /api/network body. Same hand-rolled style as
/// the two readers above (no serde at this call site). `None` for an absent key
/// and for `"lan_tls_fp":null`, which are the same fact: no fingerprint on offer.
///
/// The literal key is produced by `apps/server-core/src/http/router.ts`, symbol
/// `publishableLanTlsFingerprint`. Shape is NOT judged here — see
/// `is_carryable_fingerprint`, which the caller applies so it can tell 「没有」
/// ("none") from 「有但是坏的」("present but broken") and say the second one out loud.
pub fn parse_lan_tls_fingerprint(body: &str) -> Option<String> {
    let key = "\"lan_tls_fp\":";
    let start = body.find(key)? + key.len();
    let rest = body[start..].trim_start();
    // `null` is the server's own 「没有」("none") and must not become the string "null".
    let quoted = rest.strip_prefix('"')?;
    let end = quoted.find('"')?;
    let value = &quoted[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// D2LAN-B2b — can this string be carried to the QR without changing its meaning?
///
/// ⚠️ Deliberately NOT a length check, and the omission is the point. The exact
/// length is the producer's business (`apps/server-core/src/lan-tls/fingerprint.ts`,
/// symbols `FP_CHARS` / `isWellFormedFingerprint`, which the route already applies)
/// and hard-coding 24 here would be a second copy of a number that moves the day
/// FP_BYTES moves — the two would then disagree, and the one that wins would be
/// whichever ran last. What this layer legitimately owns is 「这个串能不能原样穿过
/// 二维码」("can this string pass through the QR code unchanged"): the payload is a flat string the phone splits on ',' and '&', so
/// either character silently turns one value into two, and whitespace cannot
/// survive the round trip intact. `qrAltHosts` and `isQrSafeValue`
/// (apps/desktop/src/lib/pairing.ts) refuse the same characters for the same
/// reason. The bound is a sanity ceiling against a garbled body, not a spec.
pub fn is_carryable_fingerprint(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn fetch_lan_primary(host: &str, port: u16) -> Option<String> {
    let r = http_get(host, port, "/api/network", Duration::from_millis(1500)).ok()?;
    if r.status != 200 {
        return None;
    }
    // Tiny extraction (no serde dependency at this call site): find "primary":"…".
    let key = "\"primary\":\"";
    let start = r.body.find(key)? + key.len();
    let rest = &r.body[start..];
    let end = rest.find('"')?;
    let ip = &rest[..end];
    if network::is_unroutable_for_lan(ip) {
        None
    } else {
        Some(ip.to_string())
    }
}

// ── spawn + handshake ────────────────────────────────────────────────────────

/// The outcome of spawning + waiting for the handshake.
pub enum HandshakeOutcome {
    /// FLOWMIC_LISTENING seen — the live child is handed back for the health poll.
    Listening { child: Child, port: u16 },
    /// The child died with EADDRINUSE on its stderr → adopt-first remediation.
    PortInUse,
    /// The child exited before the handshake for a non-port reason. `stderr` is
    /// the tail the child actually printed — it travels WITH the outcome rather
    /// than only into the forensic file, because the layer that renders the error
    /// card is the layer that has to answer 「凭什么说它失败了」("what grounds is
    /// there to say it failed") (R11). Before
    /// 2026-08-03 this tail was computed, logged and dropped, so the device page
    /// could only ever say 「child exited (code 1)」 — true, and useless: the one
    /// machine that hit it needed the sentence Node had already printed.
    Exited { code: Option<i32>, stderr: String },
    /// Handshake window elapsed with the child still alive (it was killed).
    Timeout,
    /// The spawn syscall itself failed (node missing, etc.).
    SpawnError { detail: String },
}

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Spawn `node server.js --mode standalone --port <port>` (CREATE_NO_WINDOW), then
/// watch its stdout for `FLOWMIC_LISTENING port=…`, its stderr for `EADDRINUSE`,
/// and its exit — whichever comes first within the handshake window.
///
/// `home` is passed as `FLOWMIC_HOME` so the server's standalone SECRET lives at
/// `<home>/standalone.secret` — the SAME dir as the DB (07 §5 / R2-4 correction). Without
/// it the server mints a cwd-based secret that cannot decrypt the DB's `enc:v1:`
/// seed (the escape defect). The dir is created fail-loud BEFORE spawn.
pub fn spawn_and_await_handshake(
    node_exe: &str,
    server_js: &Path,
    port: u16,
    db_path: &Path,
    home: &Path,
    handshake_timeout: Duration,
) -> HandshakeOutcome {
    // Fail-loud: the secret + DB home MUST exist before the server boots, or it
    // will mint/resolve the secret against a different (cwd) path.
    if let Err(e) = std::fs::create_dir_all(home) {
        let detail = format!("create_dir_all({}) failed: {e}", home.display());
        forensic::record("sidecar", &format!("spawn ABORTED — {detail}"));
        return HandshakeOutcome::SpawnError { detail };
    }

    let server_js = normalize_path(server_js);
    let mut cmd = Command::new(node_exe);
    cmd.arg(&server_js)
        .arg("--mode")
        .arg("standalone")
        .arg("--port")
        .arg(port.to_string())
        .env("FLOWMIC_MODE", "standalone")
        .env("FLOWMIC_PORT", port.to_string())
        // The paired home: the standalone secret (`<home>/standalone.secret`) and
        // the DB share this dir + lifecycle. This env is the escape-defect fix.
        .env("FLOWMIC_HOME", home)
        .env("FLOWMIC_DB_PATH", db_path)
        // owner 2026-07-27 P0. The server's log used to exist ONLY on a pipe, so
        // it vanished the moment nobody was reading — and an adopted orphan's
        // pipe is worse than unread, it is dangling (that EPIPE was killing the
        // process outright). A file next to window-forensics.log outlives every
        // pipe and every parent, which is what made this bug diagnosable at all.
        .env("FLOWMIC_LOG_PATH", forensic::sibling_path("server.log"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    forensic::record(
        "sidecar",
        &format!(
            "spawn: {node_exe} {} --mode standalone --port {port} FLOWMIC_HOME={}",
            server_js.display(),
            home.display()
        ),
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return HandshakeOutcome::SpawnError { detail: e.to_string() },
    };

    // owner 2026-07-29「退出PC端时要强制杀掉这个进程」("When exiting on the PC
    // side, this process must be force-killed"): the Job Object backstop.
    // RunEvent::Exit → kill_child covers only a GRACEFUL quit; this binds the
    // child to a kill-on-close job so the OS terminates it even on a
    // force-kill / crash of the desktop — the orphan an adopt-first probe later
    // finds is then never ours in the first place.
    job::guard_child(child.id());

    // Reader thread for stdout: signal the FLOWMIC_LISTENING port over a channel.
    let (tx, rx) = mpsc::channel::<HandshakeSignal>();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(out);
            // owner 2026-07-27 — this loop used to `break` the moment it saw
            // FLOWMIC_LISTENING, which left NOBODY draining the child's stdout
            // for the rest of its life. Two consequences, both real:
            //   1. the OS pipe buffer fills (4–64 KB on Windows) and the server
            //      then BLOCKS on its next console.log — which stalls the whole
            //      Node event loop, so socket.io stops answering and BOTH ends
            //      report a dropped link out of nowhere;
            //   2. every server-side log line was invisible, which is exactly
            //      why the empty-transcript P0 took a manual server to diagnose.
            // Keep reading for the child's whole life and forward what it says
            // into the forensic log, so the server's own voice is on the record.
            let mut announced = false;
            for line in reader.lines().map_while(Result::ok) {
                if !announced {
                    if let Some(port) = parse_listening(&line) {
                        let _ = tx.send(HandshakeSignal::Listening { port });
                        announced = true;
                        continue;
                    }
                }
                let t = line.trim();
                if !t.is_empty() {
                    let capped: String = if t.chars().count() > 300 {
                        format!("{}…", t.chars().take(300).collect::<String>())
                    } else {
                        t.to_string()
                    };
                    forensic::record("server", &capped);
                }
            }
        });
    }
    // Reader thread for stderr: watch for EADDRINUSE (the child's bind-fail path)
    // AND buffer every line (tail-capped) so an early EXIT can be diagnosed from
    // the forensic log — this escape defect was only found by MANUAL repro because
    // the fatal `ERROR fatal: server failed to start {…}` line went unobserved.
    let stderr_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut stderr_handle: Option<std::thread::JoinHandle<()>> = None;
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        let buf = Arc::clone(&stderr_buf);
        stderr_handle = Some(std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                if line.contains("EADDRINUSE") {
                    let _ = tx.send(HandshakeSignal::PortInUse);
                }
                if let Ok(mut g) = buf.lock() {
                    g.push(line);
                    // Keep only the last ~20 lines (tail) — never grow unbounded.
                    let len = g.len();
                    if len > 20 {
                        g.drain(0..len - 20);
                    }
                }
            }
        }));
    }

    let deadline = Instant::now() + handshake_timeout;
    loop {
        // Signal from a reader thread?
        match rx.recv_timeout(EXIT_POLL) {
            Ok(HandshakeSignal::Listening { port }) => {
                forensic::record("sidecar", &format!("handshake: FLOWMIC_LISTENING port={port}"));
                return HandshakeOutcome::Listening { child, port };
            }
            Ok(HandshakeSignal::PortInUse) => {
                forensic::record("sidecar", "handshake: child stderr EADDRINUSE → PortInUse");
                let _ = child.kill();
                let _ = child.wait();
                return HandshakeOutcome::PortInUse;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) | Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Child exited before a handshake signal?
        if let Ok(Some(status)) = child.try_wait() {
            // Drain a final EADDRINUSE that may have arrived just before exit.
            if let Ok(HandshakeSignal::PortInUse) = rx.recv_timeout(Duration::from_millis(50)) {
                forensic::record("sidecar", "handshake: exit + EADDRINUSE → PortInUse");
                return HandshakeOutcome::PortInUse;
            }
            // The child is dead → its stderr pipe is at EOF; join the reader so the
            // buffer holds every line, then record the tail (≤5, truncated) — the
            // observation layer must never be blind to WHY a child exited early.
            if let Some(h) = stderr_handle.take() {
                let _ = h.join();
            }
            let code = status.code();
            let tail = annotate_node_version(node_exe, stderr_tail(&stderr_buf, 5));
            forensic::record(
                "sidecar",
                &format!("handshake: child exited early (code {code:?}) stderr-tail: {tail}"),
            );
            return HandshakeOutcome::Exited { code, stderr: tail };
        }
        if Instant::now() >= deadline {
            forensic::record("sidecar", "handshake: TIMEOUT — killing child");
            let _ = child.kill();
            let _ = child.wait();
            return HandshakeOutcome::Timeout;
        }
    }
}

/// Join the last `max_lines` buffered stderr lines into one forensic-safe string:
/// each line trimmed + char-truncated to 200 (overflow guard), joined with " | ". `<none>`
/// when empty. Char-boundary-safe truncation (no mid-UTF-8 panic).
fn stderr_tail(buf: &Arc<Mutex<Vec<String>>>, max_lines: usize) -> String {
    let g = buf.lock().unwrap_or_else(|p| p.into_inner());
    if g.is_empty() {
        return "<none>".to_string();
    }
    let start = g.len().saturating_sub(max_lines);
    g[start..]
        .iter()
        .map(|l| {
            let t = l.trim();
            if t.chars().count() > 200 {
                format!("{}…", t.chars().take(200).collect::<String>())
            } else {
                t.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

enum HandshakeSignal {
    Listening { port: u16 },
    PortInUse,
}

/// Parse a `FLOWMIC_LISTENING port=41879 mode=standalone version=…` line → port.
pub fn parse_listening(line: &str) -> Option<u16> {
    let line = line.trim();
    if !line.starts_with("FLOWMIC_LISTENING") {
        return None;
    }
    for tok in line.split_whitespace() {
        if let Some(v) = tok.strip_prefix("port=") {
            return v.parse::<u16>().ok();
        }
    }
    None
}

/// The 1.5 s child-exit watchdog (07 §5): poll `try_wait` until the child dies or
/// `timeout` elapses. `Some(code)` = it exited (with this code) within the window;
/// `None` = still alive. Used both by the example's "亲杀 child" ("directly kill
/// the child") verification and
/// the app's Healthy-phase liveness watch.
pub fn wait_child_exit(child: &mut Child, timeout: Duration) -> Option<Option<i32>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code()),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(EXIT_POLL);
    }
}

// ── the bring-up driver (runs the FSM against real IO) ────────────────────────

/// Options for a full bring-up.
pub struct BringUpOptions {
    pub candidate_dirs: Vec<PathBuf>,
    pub host: String,
    pub port: u16,
    /// The standalone HOME (`FLOWMIC_HOME`): parent of BOTH the secret and the DB
    /// (07 §5 / R2-4 correction — the escape-defect pairing).
    pub home: PathBuf,
    pub db_path: PathBuf,
    pub node_exe: String,
    pub handshake_timeout: Duration,
    pub health_timeout: Duration,
}

impl Default for BringUpOptions {
    fn default() -> Self {
        Self {
            candidate_dirs: dev_candidate_dirs(),
            host: SIDECAR_HOST.to_string(),
            // Not the constant: the override has to reach the headless example
            // and the bring-up alike, or a developer's second instance would
            // still spawn its server on the first instance's port.
            port: sidecar_port(),
            home: default_home(),
            db_path: default_db_path(),
            node_exe: resolve_node_exe(),
            handshake_timeout: HANDSHAKE_TIMEOUT,
            health_timeout: HEALTH_TIMEOUT,
        }
    }
}

/// The result of a bring-up: the terminal phase + (for a spawned-and-healthy child)
/// the live `Child` so the caller can watch its liveness and kill it on quit. For
/// `AdoptedExternal` there is no child (we do not own the external process).
pub struct BringUp {
    pub phase: Phase,
    pub child: Option<Child>,
}

impl BringUp {
    pub fn endpoint(&self) -> Option<String> {
        self.phase.endpoint().map(str::to_string)
    }
}

/// Drive `SidecarMachine` end to end against real IO, executing each `Action` and
/// feeding back the resulting `Event`. Returns when the machine reaches a terminal
/// phase (Healthy / AdoptedExternal / Failed). This is the ONE place spawn/probe/
/// kill IO is sequenced — always in the order the FSM dictates.
pub fn bring_up(opts: &BringUpOptions) -> BringUp {
    let base_endpoint = format!("http://{}:{}", opts.host, opts.port);
    let mut m = SidecarMachine::new(base_endpoint);
    let mut child: Option<Child> = None;
    let mut server_js: Option<PathBuf> = None;

    let mut action = m.start();
    loop {
        let event = match &action {
            Action::Resolve => match resolve_server_js(&opts.candidate_dirs) {
                Some(path) => {
                    server_js = Some(path);
                    Event::Resolved
                }
                None => Event::ResolveFailed,
            },
            Action::Spawn => {
                let sj = match &server_js {
                    Some(p) => p.clone(),
                    None => {
                        // Should not happen (Resolve precedes Spawn) — fail loud.
                        return BringUp { phase: Phase::Failed { reason: FailReason::ResolveFailed }, child };
                    }
                };
                match spawn_and_await_handshake(
                    &opts.node_exe,
                    &sj,
                    opts.port,
                    &opts.db_path,
                    &opts.home,
                    opts.handshake_timeout,
                ) {
                    HandshakeOutcome::Listening { child: c, port } => {
                        child = Some(c);
                        // The FSM will next ask for a health probe; carry the port.
                        // (We fold Spawned+Listening into a single Listening feed.)
                        let _ = m.on_event(Event::Spawned);
                        Event::Listening { port }
                    }
                    HandshakeOutcome::PortInUse => Event::SpawnPortInUse,
                    HandshakeOutcome::Exited { code, stderr } => {
                        // A quick exit with no EADDRINUSE — spawned then died.
                        let _ = m.on_event(Event::Spawned);
                        Event::ChildExited { code, stderr: Some(stderr) }
                    }
                    HandshakeOutcome::Timeout => {
                        let _ = m.on_event(Event::Spawned);
                        Event::HandshakeTimeout
                    }
                    HandshakeOutcome::SpawnError { detail } => Event::SpawnFailed { detail },
                }
            }
            Action::AwaitHandshake => {
                // Folded into the Spawn step above (spawn_and_await_handshake blocks
                // through the handshake). If we land here, just wait.
                Event::HandshakeTimeout
            }
            Action::ProbeHealth { endpoint } => {
                if await_health(&opts.host, opts.port, opts.health_timeout) {
                    Event::HealthOk { endpoint: endpoint.clone() }
                } else if let Some(c) = child.as_mut() {
                    // Distinguish "child died" from "slow/unhealthy". No stderr tail
                    // here: this child got as far as printing FLOWMIC_LISTENING, so
                    // the reader thread has already been handed back and nobody is
                    // buffering its lines any more. Saying `None` is the honest
                    // shape — inventing an empty string would read as「它什么都没说」("it said nothing at all").
                    match c.try_wait() {
                        Ok(Some(status)) => Event::ChildExited { code: status.code(), stderr: None },
                        _ => Event::HealthFailed,
                    }
                } else {
                    Event::HealthFailed
                }
            }
            Action::ProbePort => match probe_existing(&opts.host, opts.port, server_js.as_deref()) {
                ProbeVerdict::AdoptableFlowMic => {
                    Event::ProbeAdoptable { endpoint: format!("http://{}:{}", opts.host, opts.port) }
                }
                ProbeVerdict::ForeignOrDead => Event::ProbeForeign,
            },
            Action::LocateAndKill => match super::portclear::clear_port(opts.port) {
                Ok(()) => Event::PortCleared,
                Err(detail) => Event::ClearFailed { detail },
            },
            Action::Connect { .. } | Action::Fail { .. } => break,
            Action::Wait => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        action = m.on_event(event);
        if m.phase().is_terminal() {
            // Execute the terminal action's implicit meaning, then stop.
            break;
        }
    }

    let phase = m.phase().clone();
    // On failure, make sure we are not leaking a spawned child.
    if matches!(phase, Phase::Failed { .. }) {
        if let Some(mut c) = child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    // AdoptedExternal: we do NOT own the external process — drop any (none) child.
    if matches!(phase, Phase::AdoptedExternal { .. }) {
        child = None;
    }
    BringUp { phase, child }
}


#[cfg(test)]
#[path = "io_tests.rs"]
mod io_tests;

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
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::forensic;
use crate::sidecar::job;
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

// The functions below (health polling + the /api/network readers) moved to
// sidecar/lan_probe.rs (2026-09-02, file-size cap) — re-exported here so every
// existing `io::` caller (shell/sidecar_ctl.rs et al.) is unaffected.
pub use crate::sidecar::lan_probe::{
    await_health, fetch_lan_candidates, fetch_lan_primary, fetch_lan_tls_fingerprint,
    is_carryable_fingerprint, parse_lan_ipv4_array, parse_lan_tls_fingerprint,
};


// ── spawn + handshake ────────────────────────────────────────────────────────

/// The stderr tail buffer a spawned child's reader thread keeps appending to,
/// shared out so a caller who receives the child LATER (after the handshake
/// reader thread's `JoinHandle` would otherwise be silently dropped) can still
/// read what the child printed. See `HandshakeOutcome::Listening`.
pub(crate) type SharedStderrTail = Arc<Mutex<Vec<String>>>;

/// The outcome of spawning + waiting for the handshake.
pub enum HandshakeOutcome {
    /// FLOWMIC_LISTENING seen — the live child is handed back for the health poll.
    ///
    /// D7 (2026-09-02 audit §3-D): `stderr_tail` and `stderr_reader` travel WITH
    /// the child now, not just the child. Before this, once `Listening` was
    /// returned, the buffer the handshake's stderr reader thread had been
    /// filling — and the `JoinHandle` for that thread — were both local to
    /// `spawn_and_await_handshake` and went out of scope here, so the reader
    /// thread became an orphan nobody could read from again (it keeps running
    /// until the pipe closes, but its output is unreachable). If the child then
    /// died during the HEALTH probe (`AwaitingHealth`/`ProbeHealth`, a real
    /// phase, not a hypothetical), the comment at that call site said `None`
    /// was honest because "nobody is buffering its lines any more" — which was
    /// true only because this type threw the buffer away, not because the
    /// child stopped printing anything. Handing both along lets that call site
    /// report the SAME kind of tail the handshake-exit path already gets.
    Listening { child: Child, port: u16, stderr_tail: SharedStderrTail, stderr_reader: Option<JoinHandle<()>> },
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
                // D7: hand the buffer AND the reader thread's handle along with
                // the child — see `HandshakeOutcome::Listening`'s doc comment.
                return HandshakeOutcome::Listening {
                    child,
                    port,
                    stderr_tail: stderr_buf,
                    stderr_reader: stderr_handle,
                };
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
            let code = status.code();
            let tail = stderr_tail_after_exit(node_exe, Some(&stderr_buf), &mut stderr_handle);
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
///
/// `pub(crate)` (2026-09-02, sidecar supervisor leftovers item 3) so
/// `shell::sidecar_ctl`'s health supervisor can read the SAME buffer this
/// module keeps filling for the whole life of a Healthy child, instead of
/// re-implementing "last N lines, trimmed and capped" a second time — see
/// `BringUp::stderr_tail`'s doc comment for why nothing downstream could read
/// it before this.
pub(crate) fn stderr_tail(buf: &SharedStderrTail, max_lines: usize) -> String {
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

/// Report the stderr tail for a child that has ALREADY exited — joining its
/// reader thread first so the buffer holds every line the pipe ever delivered
/// (once a process exits, its stderr pipe is at EOF, so the reader thread's
/// `for line in reader.lines()` loop is at most one iteration from ending on
/// its own; joining just waits for that instead of racing it).
///
/// D7 (2026-09-02 audit §3-D): ONE function, used by both the handshake-exit
/// path (`spawn_and_await_handshake`'s own loop) and the health-probe-exit
/// path (`bring_up`'s `Action::ProbeHealth`) — before this card the second
/// path had no buffer to read at all (see `HandshakeOutcome::Listening`'s doc
/// comment), so it hardcoded `None`. `buf` is `Option` because the
/// health-probe path's buffer arrived via an `Option<SharedStderrTail>` that
/// is only ever `None` if a future caller reaches `AwaitingHealth` without
/// ever having gone through `Listening` — not a path that exists today, but
/// this function stays honest about it rather than assuming.
fn stderr_tail_after_exit(
    node_exe: &str,
    buf: Option<&SharedStderrTail>,
    reader: &mut Option<JoinHandle<()>>,
) -> String {
    if let Some(h) = reader.take() {
        let _ = h.join();
    }
    match buf {
        Some(b) => annotate_node_version(node_exe, stderr_tail(b, 5)),
        None => "<none>".to_string(),
    }
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
    /// D-B2L (2026-09-02 audit, sidecar supervisor leftovers item 3): the
    /// SAME buffer `HandshakeOutcome::Listening` hands back, carried all the
    /// way out of `bring_up()` — `None` until a child has completed its
    /// handshake (a `Failed` bring-up before that point, or `AdoptedExternal`,
    /// never has one). Before this field existed, the buffer's OWN reader
    /// thread kept it alive for the child's whole life, but `bring_up()` threw
    /// away the only handle to it once it returned Healthy — the 0.2.50
    /// lesson (`stderr_tail` computed, logged once, then thrown away)
    /// reproduced one layer higher, surviving past bring-up with no reader.
    pub stderr_tail: Option<SharedStderrTail>,
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
    // D7 (2026-09-02 audit §3-D): carried alongside `child` from the moment the
    // handshake succeeds, so a death during the LATER health probe can still be
    // explained — see `HandshakeOutcome::Listening`'s doc comment for why this
    // used to be thrown away at exactly this point.
    let mut stderr_tail_buf: Option<SharedStderrTail> = None;
    let mut stderr_reader_handle: Option<JoinHandle<()>> = None;

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
                        return BringUp { phase: Phase::Failed { reason: FailReason::ResolveFailed }, child, stderr_tail: None };
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
                    HandshakeOutcome::Listening { child: c, port, stderr_tail: tail, stderr_reader: reader } => {
                        child = Some(c);
                        stderr_tail_buf = Some(tail);
                        stderr_reader_handle = reader;
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
                    // Distinguish "child died" from "slow/unhealthy".
                    //
                    // D7 (2026-09-02 audit §3-D): this used to say `stderr: None`
                    // with a comment claiming "the reader thread has already been
                    // handed back and nobody is buffering its lines any more" —
                    // that was true only because `HandshakeOutcome::Listening`
                    // threw the buffer away at the handshake/health boundary, not
                    // because the child actually stopped printing anything. The
                    // buffer (`stderr_tail_buf`) now travels alongside `child`
                    // from that same `Listening` outcome, so a death HERE gets
                    // the identical tail treatment the handshake-exit path
                    // (`HandshakeOutcome::Exited`) already gave.
                    match c.try_wait() {
                        Ok(Some(status)) => {
                            let tail = stderr_tail_after_exit(
                                &opts.node_exe,
                                stderr_tail_buf.as_ref(),
                                &mut stderr_reader_handle,
                            );
                            Event::ChildExited { code: status.code(), stderr: Some(tail) }
                        }
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
    BringUp { phase, child, stderr_tail: stderr_tail_buf }
}


#[cfg(test)]
#[path = "io_tests.rs"]
mod io_tests;

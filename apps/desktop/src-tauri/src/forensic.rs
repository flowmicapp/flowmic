// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §10 (observability — the forensics log is the real-
//     machine bug-cracking lifeline): %LOCALAPPDATA%\FlowMic\window-forensics.log,
//     append-only, 2 MiB cap → keep tail 512 KiB; startup snapshot, socket
//     lifecycle, SPEAKING-lock events, inject resolve truth, dual-perspective
//     window state, and a `fe.<domain>#<seq>` frontend mirror.
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-3 deliverable A.
//   CLAUDE.md red line: no silent failures — EXCEPT the observation layer itself (a forensic
//     write failure must never backfire onto the main flow; init failure eprintln's once).
//
// This module is tauri-free (std only) so the audited socket/inject/focus core
// (client.rs / pump.rs) can log through it under `cargo test` and the golden
// example WITHOUT the WebView2 toolchain. The Tauri window shell adds the dual-
// perspective window snapshot (Tauri + Win32) on top under the `app` feature.
//
// The observation contract: writing NEVER changes inject / lock / dedup behavior
// and NEVER panics into a caller — every fs error is swallowed. Only a failure
// to initialize the sink at all is surfaced (once) on stderr, because a missing
// forensics file is itself the kind of thing forensics exists to catch.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 2 MiB hard cap (07 §10). Past this the log is truncated keeping the tail.
const CAP_BYTES: u64 = 2 * 1024 * 1024;
/// 512 KiB tail retained on truncation (07 §10) — recent history is what bug-cracking needs.
const KEEP_TAIL: u64 = 512 * 1024;

/// The process-wide forensic sink. `None` means init failed (surfaced once);
/// unset means init was never called (record is a no-op — tests that never init).
static SINK: OnceLock<Option<ForensicSink>> = OnceLock::new();

/// An append-only, self-truncating line sink over a single file. Writes are
/// serialized by an internal lock; all fs errors are swallowed (observation
/// must never backfire onto the main flow — 07 §10).
struct ForensicSink {
    path: PathBuf,
    cap: u64,
    keep: u64,
    write_lock: Mutex<()>,
}

impl ForensicSink {
    fn new(path: PathBuf) -> Self {
        Self { path, cap: CAP_BYTES, keep: KEEP_TAIL, write_lock: Mutex::new(()) }
    }

    /// Test-only: a sink with custom caps so rotation is exercisable without
    /// writing 2 MiB.
    #[cfg(test)]
    fn with_caps(path: PathBuf, cap: u64, keep: u64) -> Self {
        Self { path, cap, keep, write_lock: Mutex::new(()) }
    }

    fn append(&self, line: &str) {
        // Poisoned lock is fine here — we only guard write ordering, not invariants.
        let _guard = self.write_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = f.write_all(line.as_bytes());
            let _ = f.write_all(b"\n");
            let _ = f.flush();
        }
        self.rotate_if_needed();
    }

    /// When the file exceeds `cap`, rewrite it keeping only the last `keep` bytes,
    /// trimmed forward to the next line boundary so no partial line survives.
    fn rotate_if_needed(&self) {
        let len = match std::fs::metadata(&self.path) {
            Ok(m) => m.len(),
            Err(_) => return,
        };
        if len <= self.cap {
            return;
        }
        let Ok(mut f) = File::open(&self.path) else { return };
        let start = len.saturating_sub(self.keep);
        if f.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            return;
        }
        // Drop the (likely partial) first line so the file starts on a boundary.
        if start > 0 {
            if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                buf.drain(..=pos);
            }
        }
        let tmp = self.path.with_extension("log.rot");
        if let Ok(mut out) = File::create(&tmp) {
            let header = format!("[forensic: rotated — kept tail {} bytes]\n", buf.len());
            let _ = out.write_all(header.as_bytes());
            let _ = out.write_all(&buf);
            let _ = out.flush();
            drop(out);
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

/// Resolve the log path: `FLOWMIC_FORENSIC_PATH` override (tests / the pull-cable
/// smoke), else `%LOCALAPPDATA%\FlowMic\window-forensics.log`, else a temp-dir
/// fallback so the sink always has somewhere to go.
///
/// 🔴 CORRECTED IN PLACE (MAC-01, 2026-08-07) —— the sentence above, 「else a temp-dir fallback so the
/// sink always has somewhere to go」, **is kept as originally written**: its reasoning still holds
/// today (forensic output must always have somewhere to land — landing in the temp
/// dir is better than not landing at all). **But on macOS it used to be the ONLY
/// branch ever reached**, and `$TMPDIR` is pruned by the OS on an age policy ⇒
/// **the one file that most needs to outlive a crash turned out to be exactly the
/// one that lives the shortest**. The platform-specific location is now answered
/// exclusively by `crate::app_dirs::local_home()`; the temp-dir fallback still
/// exists, it just is no longer macOS's default answer. Windows behaviour is
/// unchanged, byte for byte.
fn resolve_path() -> PathBuf {
    if let Some(p) = std::env::var_os("FLOWMIC_FORENSIC_PATH") {
        return PathBuf::from(p);
    }
    crate::app_dirs::local_home().join("window-forensics.log")
}

/// A path beside the forensic log, so every diagnostic file this product writes
/// lands in ONE directory the user can be pointed at. Honours the
/// `FLOWMIC_FORENSIC_PATH` override, since that is where a test redirects them.
pub fn sibling_path(file_name: &str) -> PathBuf {
    let base = resolve_path();
    match base.parent() {
        Some(dir) => dir.join(file_name),
        None => PathBuf::from(file_name),
    }
}

/// Initialize the process-wide forensic sink (idempotent — OnceLock). Creates the
/// parent directory. On failure, records `None` and eprintln's ONCE (a missing
/// forensics file is exactly what forensics exists to catch) — never panics.
pub fn init_default() {
    let _ = SINK.get_or_init(|| {
        let path = resolve_path();
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("[flowmic] forensic init failed (mkdir {}): {e}", dir.display());
                return None;
            }
        }
        // Prove writability once; a later per-write failure is silently tolerated.
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(_) => {
                let sink = ForensicSink::new(path);
                sink.append(&format!(
                    "{} [forensic] === session start (pid={}) ===",
                    fmt_utc(now_ms()),
                    std::process::id()
                ));
                Some(sink)
            }
            Err(e) => {
                eprintln!("[flowmic] forensic init failed (open {}): {e}", path.display());
                None
            }
        }
    });
}

/// Append a domain-tagged line: `<utc> [<domain>] <msg>`. No-op until init.
pub fn record(domain: &str, msg: &str) {
    record_raw(&format!("[{domain}] {msg}"));
}

/// Append a pre-formatted line with only a timestamp prepended — the frontend
/// mirror passes its own `fe.<domain>#<seq> <msg>` token here (07 §10). No-op
/// until init; every fs error swallowed.
pub fn record_raw(line: &str) {
    if let Some(Some(sink)) = SINK.get() {
        sink.append(&format!("{} {line}", fmt_utc(now_ms())));
    }
}

/// Whether the sink initialized successfully (for a one-line startup diag).
pub fn is_ready() -> bool {
    matches!(SINK.get(), Some(Some(_)))
}

// ── D5: process-wide panic forensics ─────────────────────────────────────────
//
// Until this card a panic on any of the ~8 worker threads (pumps, sidecar
// watchdog, summon listener, reqwest fetches…) unwound that thread and vanished:
// std's default hook prints to stderr, and a `windows_subsystem = "windows"`
// release build HAS no stderr — zero forensic trace, thread simply gone. (The
// frontend, by contrast, has full error boundaries.) The hook writes the thread
// name, panic location, message and a backtrace to THIS log, then calls the
// previous (default) hook so stock behavior — the stderr print where one
// exists, and the panic runtime's own unwind/abort policy, which no hook can
// alter — is preserved exactly.

/// Guard so a second call cannot chain the hook onto itself (double-logging).
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

/// Install the process-wide panic hook. ONE production call site: `run()` in
/// lib.rs, immediately after `forensic::init_default()` and before any thread
/// spawns. Idempotent.
pub fn install_panic_hook() {
    let mut first = false;
    let _ = PANIC_HOOK_INSTALLED.get_or_init(|| {
        first = true;
    });
    if !first {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(|l| l.to_string());
        // force_capture: RUST_BACKTRACE is not set in production and cracking the
        // case is the whole point. (Release builds without debug info yield sparse frames —
        // still better than nothing, stated rather than hidden.)
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        record(
            "panic",
            &format_panic_report(
                thread.name().unwrap_or("<unnamed>"),
                location.as_deref(),
                panic_payload_message(info.payload()),
                &backtrace,
            ),
        );
        // Default behavior preserved: stderr print via the previous hook; the
        // configured unwind/abort happens after all hooks regardless.
        previous(info);
    }));
}

/// Extract the human message from a panic payload. `panic!("…")` yields
/// `&'static str`, `panic!("{x}")` / `.expect()` yield `String`; anything else
/// (a custom `panic_any` payload) is named for what it is, never dropped.
pub(crate) fn panic_payload_message(payload: &dyn std::any::Any) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "<non-string panic payload>"
    }
}

/// One forensic entry for one panic. First line mirrors std's own shape
/// (`thread 'x' panicked at src/…:l:c: msg`) so log readers' instincts
/// transfer; the backtrace follows on indented continuation lines.
pub(crate) fn format_panic_report(
    thread: &str,
    location: Option<&str>,
    message: &str,
    backtrace: &str,
) -> String {
    let mut out = format!(
        "thread '{thread}' panicked at {}: {message}",
        location.unwrap_or("<unknown location>")
    );
    out.push_str("\n  backtrace:");
    for line in backtrace.lines() {
        out.push_str("\n  ");
        out.push_str(line);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format epoch-millis as an ISO-8601-ish UTC string `YYYY-MM-DDThh:mm:ss.mmmZ`
/// with no external crate (Hinnant's days-from-civil inverse). Readability is a
/// 07 §10 requirement — a bug-cracking log has to carry a real wall-clock time.
///
/// PUBLIC since the row-transit card, and its second caller is not a log line:
/// `socket::row_transit` stamps a minted timeline row's `created_at` with it when
/// the delivery frame carried none. That value is COMPARED (the store sorts and
/// evicts by lexicographic ISO-8601 order) and RENDERED, so it has to be the same
/// shape the phone's rows use — exported rather than re-derived precisely so a
/// second formatter cannot drift from this one.
pub fn fmt_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // days since 1970-01-01 → civil (y, m, d), UTC.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0,399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0,365]
    let mp = (5 * doy + 2) / 153; // [0,11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1,31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1,12]
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("flowmic-forensic-test-{}-{name}.log", std::process::id()))
    }

    #[test]
    fn fmt_utc_epoch_zero_is_unix_start() {
        assert_eq!(fmt_utc(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn fmt_utc_known_2026_instant() {
        // 2026-07-23T00:00:00Z = 20657 days since epoch = 1_784_764_800_000 ms.
        assert_eq!(fmt_utc(1_784_764_800_123), "2026-07-23T00:00:00.123Z");
    }

    /// D5 — the hook's formatting: thread name, location, message and every
    /// backtrace frame must all be present, because a report missing any one of
    /// them is the un-answerable「which thread died and why」the card exists to kill.
    #[test]
    fn panic_report_carries_thread_location_message_and_backtrace() {
        let r = format_panic_report(
            "pump-lan",
            Some("src/socket/pump.rs:100:17"),
            "index out of bounds: the len is 3",
            "0: alpha_frame\n1: beta_frame",
        );
        assert!(r.contains("thread 'pump-lan' panicked at src/socket/pump.rs:100:17"));
        assert!(r.contains("index out of bounds: the len is 3"));
        assert!(r.contains("backtrace:"));
        assert!(r.contains("0: alpha_frame") && r.contains("1: beta_frame"));
        // No location (a panic from FFI glue) is said, not faked.
        let r = format_panic_report("<unnamed>", None, "boom", "");
        assert!(r.contains("<unknown location>"));
        assert!(r.contains("thread '<unnamed>'"));
    }

    /// D5 — payload extraction for the two shapes std produces, plus the honest
    /// fallback for `panic_any` payloads.
    #[test]
    fn panic_payload_message_handles_str_string_and_other() {
        let s: Box<dyn std::any::Any> = Box::new("static str panic");
        assert_eq!(panic_payload_message(s.as_ref()), "static str panic");
        let s: Box<dyn std::any::Any> = Box::new(String::from("formatted panic"));
        assert_eq!(panic_payload_message(s.as_ref()), "formatted panic");
        let s: Box<dyn std::any::Any> = Box::new(42i32);
        assert_eq!(panic_payload_message(s.as_ref()), "<non-string panic payload>");
    }

    #[test]
    fn append_writes_lines() {
        let p = scratch("append");
        let _ = std::fs::remove_file(&p);
        let sink = ForensicSink::new(p.clone());
        sink.append("line one");
        sink.append("line two");
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("line one") && body.contains("line two"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn rotation_keeps_only_the_tail_on_a_boundary() {
        let p = scratch("rotate");
        let _ = std::fs::remove_file(&p);
        // cap 400 bytes, keep 200: write enough distinct lines to blow the cap.
        let sink = ForensicSink::with_caps(p.clone(), 400, 200);
        for i in 0..200 {
            sink.append(&format!("entry-{i:04}-padding-xxxxxxxxxxxxxxxxxxxx"));
        }
        let meta = std::fs::metadata(&p).unwrap();
        assert!(meta.len() <= 400 + 128, "file must be truncated near the cap, got {}", meta.len());
        let body = std::fs::read_to_string(&p).unwrap();
        // The most recent entry survives; an ancient one does not.
        assert!(body.contains("entry-0199"), "tail must retain the newest line");
        assert!(!body.contains("entry-0000"), "head must be dropped");
        // No partial first line: after the rotation header, every content line is whole.
        for line in body.lines().filter(|l| l.starts_with("entry-")) {
            assert!(line.len() >= "entry-0000-padding-xxxxxxxxxxxxxxxxxxxx".len());
        }
        let _ = std::fs::remove_file(&p);
    }
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (adopt-first: socket.io polling probe →
//     /api/health → netstat+taskkill)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-4 lead-controller ruling #1
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D5 (same version number, can't tell new from old)
//
// The adopt-first probe: given something already listening on :41879, decide
// whether to ADOPT it or reclaim the port. Split out of sidecar::io (owner
// 2026-07-27) when the build-identity check pushed that file past the 800-line
// cap — and it earns its own file anyway: this is a policy decision, whereas io
// is the mechanism (spawn / handshake / kill) around it.

use std::path::Path;
use std::time::Duration;

use crate::forensic;
use crate::sidecar::io::{http_get, normalize_path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeVerdict {
    /// Alive socket.io endpoint AND `/api/health` says it is OUR FlowMic → ADOPT.
    AdoptableFlowMic,
    /// Alive but not FlowMic, not ours, dead, or unreachable → clear the port.
    ForeignOrDead,
}

/// Pull `"script":"…"` out of an `/api/health` body. A Windows path arrives with
/// its backslashes JSON-doubled (`C:\\Users\\…`), so escapes are unwound here.
pub fn parse_health_script(body: &str) -> Option<String> {
    let key = "\"script\":\"";
    let start = body.find(key)? + key.len();
    let mut out = String::new();
    let mut chars = body[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => out.push(chars.next()?),
            _ => out.push(c),
        }
    }
    None
}

/// Is the health-reported script the SAME file we were about to run? Compared
/// case-insensitively with separators normalized: the two sides come from
/// different APIs (Tauri's resolver vs Node's `process.argv[1]`) and legitimately
/// disagree on case and slash direction for one and the same file.
pub fn is_same_script(reported: &str, expected: &Path) -> bool {
    fn norm(s: &str) -> String {
        s.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    }
    !reported.is_empty() && norm(reported) == norm(&normalize_path(expected).to_string_lossy())
}

/// Probe an existing `:port` listener the way lead-controller ruling #1 mandates BEFORE any kill:
///   1. a socket.io polling handshake proves it speaks Engine.IO;
///   2. `/api/health` 200 with `"ok":true` proves it is THIS product;
///   3. (owner 2026-07-27) its `script` must be the very file WE resolved.
///
/// Step 3 is the difference between「是 FlowMic」("is FlowMic") and「是我这一份
/// FlowMic」("is MY copy of FlowMic"). Without
/// it, a stale orphan sidecar from another build — the MSI copy's server.js still
/// running after its desktop died, say — was adopted by a freshly-built or
/// portable app, which then ran against a server whose fixes it does not contain
/// and whose bundle it did not ship. Nothing about that is visible to the owner,
/// which is exactly what makes it dangerous. A mismatch is `ForeignOrDead`, so the
/// FSM clears the port and brings up OUR sidecar instead.
///
/// `expected_script` is `None` only where the caller genuinely has no opinion (the
/// headless example); it then keeps the pre-existing product-level check.
pub fn probe_existing(host: &str, port: u16, expected_script: Option<&Path>) -> ProbeVerdict {
    let sio = http_get(host, port, "/socket.io/?EIO=4&transport=polling", Duration::from_millis(1500));
    // Engine.IO's open packet is `0{"sid":…}`. Match on the `"sid"` marker (robust
    // to HTTP chunked framing prefixing the body with a hex chunk size) rather than
    // only a leading '0'.
    let sio_alive = matches!(&sio, Ok(r) if r.status == 200 && (r.body.contains("\"sid\"") || r.body.trim_start().starts_with('0')));
    if !sio_alive {
        forensic::record("sidecar", "probe: no socket.io on :port → ForeignOrDead");
        return ProbeVerdict::ForeignOrDead;
    }
    let Ok(health) = http_get(host, port, "/api/health", Duration::from_millis(1500)) else {
        forensic::record("sidecar", "probe: /api/health unreachable → ForeignOrDead");
        return ProbeVerdict::ForeignOrDead;
    };
    if health.status != 200 || !health.body.contains("\"ok\":true") {
        forensic::record("sidecar", "probe: socket.io alive but /api/health not FlowMic → ForeignOrDead");
        return ProbeVerdict::ForeignOrDead;
    }
    // It IS a FlowMic. Is it OURS? (see the doc comment above.)
    if let Some(expected) = expected_script {
        let reported = parse_health_script(&health.body).unwrap_or_default();
        if !is_same_script(&reported, expected) {
            forensic::record(
                "sidecar",
                &format!(
                    "probe: a FlowMic is on :{port} but it runs a DIFFERENT server \
                     (reported={} expected={}) → ForeignOrDead, will reclaim the port",
                    if reported.is_empty() { "<no script field — pre-2026-07-27 build>" } else { &reported },
                    expected.display()
                ),
            );
            return ProbeVerdict::ForeignOrDead;
        }
    }
    forensic::record("sidecar", "probe: socket.io + /api/health ok (our server.js) → AdoptableFlowMic");
    ProbeVerdict::AdoptableFlowMic
}

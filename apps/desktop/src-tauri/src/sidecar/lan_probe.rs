// The /api/network readers + health poll, split out of sidecar/io.rs
// (2026-09-02, file-size cap) — VERBATIM move, re-exported back into `io`
// (see io.rs) so no caller's `io::fn_name()` path changes.

use crate::sidecar::network;
use std::time::{Duration, Instant};

use super::io::http_get;

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

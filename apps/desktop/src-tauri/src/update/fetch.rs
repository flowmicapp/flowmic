// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1.1 (the endpoint) / §3 (the failure-direction table)
//   apps/server-core/src/http/update-routes.ts — the endpoint being called
//
// Ask the manifest endpoint what the latest release is.
//
// ── THE SPLIT THIS FILE IS BUILT AROUND ─────────────────────────────────────
//
// `interpret()` is a pure function of (status, body). `fetch_manifest()` is the
// transport around it. Everything that can be got WRONG lives in the pure half —
// which of six outcomes a response is, and in particular the two that look alike
// and must never merge (「服务器说它没有清单」("the server says it has no
// manifest") vs 「我们根本没问到」("we never got an answer at all")). That half
// is unit-tested against fabricated responses in the lean build; the transport
// half has one job and no branches worth arguing about.
//
// ── 未知 ≠ 最新 ("unknown ≠ latest") ────────────────────────────────────────
//
// 🔴 Not one outcome in this file returns「已是最新」("already up to date").
// Every failure path returns
// an `UpdateFailure`, which by construction cannot render as that sentence
// (`failure.rs`). This is the client end of the same rule the endpoint states
// for itself in its header — it answers 503 rather than「200 + 空清单」
// ("200 + an empty manifest") because
// an empty manifest reads as「没有更新，你已经是最新的」("no update, you're
// already on the latest") when the truth is「我们不知道」("we don't know").

use std::io::Read;
use std::time::Duration;

use serde_json::Value;

use super::failure::UpdateFailure;
use super::manifest::{parse_manifest, UpdateManifest};

/// The endpoint path. Mirrors `UPDATE_MANIFEST_PATH` in `update-routes.ts`.
pub const MANIFEST_PATH: &str = "/api/updates/latest";

/// How long a check may take before it counts as 「问不到」("couldn't get an
/// answer").
///
/// Longer than `cloud.rs`'s 6 s account read because this is not a card
/// refreshing under someone's cursor, and short enough that a manual
/// 【立即检查】("check now") does not look hung. A failure here is cheap: the standing
///「上次成功检查于 …」("last successful check at …") line keeps its old value and nothing about the app changes.
const MANIFEST_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// The most manifest we will read.
///
/// 🔴 Bounded because the thing on the other end is not necessarily our
/// endpoint. Design §1.4 records the specific trap: nginx's `location /` is
/// `try_files $uri $uri/ /index.html`, so a MISSING static path answers **200
/// with a whole HTML page** — that is why the manifest lives behind `/api/`.
/// Reading an unbounded body from a host we cannot authenticate is how a
/// misconfigured proxy turns a version check into an out-of-memory kill. A real
/// manifest is a few KB; 512 KiB is four orders of magnitude of headroom.
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;

/// Where the manifest lives, given a base URL.
///
/// 🔴 **`base` is a PARAMETER and this crate contains no default for it.** The
/// production default (`https://flowmic.app`) is `DEFAULT_SAAS_ENDPOINT` in
/// `@flowmic/protocol`, and `shell/cloud.rs` states the standing rule in as many
/// words: 「the DEFAULT lives in @flowmic/protocol on the frontend, never as a
/// literal in Rust」. Measured 2026-08-08: the only two `flowmic.app` literals
/// in this crate are both inside `#[cfg(test)]` blocks, so the rule currently
/// holds and this file does not break it.
///
/// ⚠️ Note this is NOT the relay the user has configured. Design §1.1: 「最新
/// FlowMic 是哪版」("which version is the latest FlowMic") is a global fact, independent of which server you are paired
/// through, so UP-3b passes the official site rather than `CloudConfig.endpoint`.
/// Pointing this at a self-hosted relay is legitimate — it will answer 404, and
/// 404 has its own honest sentence.
pub fn manifest_url(base: &str) -> String {
    format!("{}{MANIFEST_PATH}", base.trim_end_matches('/'))
}

/// Classify one transport error WITHOUT letting its `Display` reach a DTO.
///
/// Copied in shape from `cloud.rs::transport_detail`, and the reason is stated
/// there: `reqwest::Error`'s `Display` carries the full URL. A fixed vocabulary
/// keeps the diagnostic useful and the log free of endpoints.
fn transport_detail(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".to_string()
    } else if e.is_connect() {
        "connect".to_string()
    } else if e.is_redirect() {
        "redirect".to_string()
    } else if e.is_decode() {
        "decode".to_string()
    } else {
        "transport".to_string()
    }
}

/// Turn one HTTP response into an outcome. **Pure** — this is the half worth
/// testing, and it is testable because it takes bytes rather than a socket.
///
/// The six outcomes, each a different sentence to the user:
///
/// | status | outcome |
/// |---|---|
/// | 200, parses     | `Ok(manifest)` |
/// | 200, does not   | `ManifestUnusable` — includes the HTML-fallback trap |
/// | 404             | `NoManifestOnServer` — 「这个部署不提供更新清单」
///                     ("this deployment does not offer an update manifest") |
/// | 503             | `ServiceUnavailable` — configured, and refusing to serve |
/// | anything else   | `UnexpectedStatus` |
/// | (no response)   | `Unreachable`, produced by the caller, not here |
///
/// 🔴 404 and 503 are the pair most likely to be collapsed by a well-meaning
/// simplification (「both mean no manifest」). They do not mean the same thing
/// and the endpoint went out of its way to distinguish them: 404 = this
/// deployment does not offer the route at all (the expected answer from a
/// self-hosted relay, and from our own VPS today); 503 = the route IS mounted
/// and the manifest behind it is missing or invalid — an operations fault
/// somebody should be told about. Design §1.1: 「两句话对应两种完全不同的处置」
/// ("the two sentences correspond to two completely different responses").
pub fn interpret(status: u16, body: &str) -> Result<UpdateManifest, UpdateFailure> {
    match status {
        200 => {
            let Ok(value) = serde_json::from_str::<Value>(body) else {
                // The nginx `try_files` trap lands exactly here: a 200 carrying
                // a whole HTML page. Naming it `not_json` rather than
                // pretending we got a manifest is the entire point of §1.4.
                return Err(UpdateFailure::ManifestUnusable { reason: "not_json".to_string() });
            };
            parse_manifest(&value).map_err(|reason| UpdateFailure::ManifestUnusable { reason })
        }
        404 => Err(UpdateFailure::NoManifestOnServer),
        503 => {
            // The endpoint answers `{"error":"UPDATE_MANIFEST_UNAVAILABLE","detail":"<code>"}`.
            // The detail is the operations-facing short code (`manifest_unreadable`,
            // `bad_sha256:…`); a 503 without one is still a 503.
            let detail = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("detail").and_then(Value::as_str).map(str::to_string));
            Err(UpdateFailure::ServiceUnavailable { detail })
        }
        other => Err(UpdateFailure::UnexpectedStatus { status: other }),
    }
}

/// The blocking half. Runs on a thread of its own — see `fetch_manifest`.
fn fetch_blocking(url: String) -> Result<UpdateManifest, UpdateFailure> {
    let client = match reqwest::blocking::Client::builder()
        .timeout(MANIFEST_HTTP_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(UpdateFailure::Unreachable { detail: transport_detail(&e) }),
    };
    let resp = client
        .get(&url)
        // 🔴 `no-cache` on the request as well as the endpoint's `no-store` on
        // the response. The endpoint controls its own headers; it does not
        // control an intermediate proxy that has its own ideas. A cached
        // manifest is「我刚发版为什么客户端还没提示」("I just shipped a release,
        // why hasn't the client noticed") — the exact problem the
        // endpoint's header says it set `no-store` to avoid.
        .header("cache-control", "no-cache")
        .send()
        .map_err(|e| UpdateFailure::Unreachable { detail: transport_detail(&e) })?;

    let status = resp.status().as_u16();
    // Bounded read (see MAX_MANIFEST_BYTES). One extra byte so truncation is
    // DETECTED rather than silently producing a body that fails to parse and
    // gets reported as `not_json` — two different faults deserve two sentences.
    let mut buf = Vec::new();
    if let Err(e) = resp.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut buf) {
        return Err(UpdateFailure::Unreachable { detail: format!("body_read:{}", e.kind()) });
    }
    if buf.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(UpdateFailure::ManifestUnusable { reason: "too_large".to_string() });
    }
    let body = String::from_utf8_lossy(&buf);
    interpret(status, &body)
}

/// Fetch and validate the manifest from `base`.
///
/// 🔴 The blocking client runs on a thread WE own, never the thread a Tauri
/// command was handed: `reqwest::blocking` PANICS when driven from inside an
/// async runtime context, which would turn a version check into a process-level
/// fault. Verbatim the pattern and the reason from `cloud.rs::cloud_account_fetch`.
/// The join is bounded by `MANIFEST_HTTP_TIMEOUT`.
///
/// Forensics record the VERDICT only — never the URL, never a header. Same rule
/// as `cloud.rs`.
pub fn fetch_manifest(base: &str) -> Result<UpdateManifest, UpdateFailure> {
    let url = manifest_url(base);
    let handle = std::thread::spawn(move || fetch_blocking(url));
    let out = match handle.join() {
        Ok(r) => r,
        Err(_) => Err(UpdateFailure::Unreachable { detail: "worker_panicked".to_string() }),
    };
    match &out {
        Ok(m) => crate::forensic::record(
            "update",
            &format!("manifest ok — {} platform(s)", m.platforms.len()),
        ),
        Err(f) => crate::forensic::record("update", &format!("manifest check → {f}")),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
        "manifest_version": 1,
        "generated_at": "2026-08-08T00:00:00.000Z",
        "platforms": {
            "windows-x64": {
                "version": "0.2.60",
                "notes_url": null,
                "artifacts": [{
                    "kind": "msi", "locale": "zh-CN", "filename": "a.msi",
                    "url": "http://d/a.msi",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "size": 10
                }]
            }
        }
    }"#;

    #[test]
    fn the_base_url_is_joined_without_doubling_or_dropping_a_slash() {
        assert_eq!(manifest_url("https://flowmic.app"), "https://flowmic.app/api/updates/latest");
        assert_eq!(manifest_url("https://flowmic.app/"), "https://flowmic.app/api/updates/latest");
        assert_eq!(manifest_url("https://flowmic.app///"), "https://flowmic.app/api/updates/latest");
        // A self-hosted relay on a port — legitimate; it will answer 404.
        assert_eq!(manifest_url("http://10.0.0.5:41879"), "http://10.0.0.5:41879/api/updates/latest");
    }

    #[test]
    fn a_good_two_hundred_yields_a_manifest() {
        let m = interpret(200, GOOD).expect("a valid body must parse");
        assert_eq!(m.platform_keys(), vec!["windows-x64".to_string()]);
    }

    /// 🔴 The six outcomes, each distinct. This is the assertion that stands
    /// against the simplification 「it did not work, say check-failed」.
    #[test]
    fn every_response_shape_gets_its_own_named_outcome() {
        // Gate ② failing OPEN would look like this: a 200 whose payload carries
        // an unusable hash. Bound out here so it outlives the case table.
        let blank_sha =
            GOOD.replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "");
        let cases: Vec<(&str, u16, &str, &str)> = vec![
            // 404 ≠ 503. Different causes, different actions, different copy.
            ("this deployment has no manifest route", 404, r#"{"error":"not_found"}"#, "no_manifest_on_server"),
            (
                "route mounted, file unreadable",
                503,
                r#"{"error":"UPDATE_MANIFEST_UNAVAILABLE","detail":"manifest_unreadable"}"#,
                "service_unavailable",
            ),
            ("503 with no detail", 503, "", "service_unavailable"),
            ("wrong method", 405, r#"{"error":"METHOD_NOT_ALLOWED"}"#, "unexpected_status"),
            ("relay blew up", 500, "oops", "unexpected_status"),
            // 🔴 §1.4's HTML-fallback trap: a 200 that is a whole web page.
            // A client checking only `res.ok` would have called this success.
            ("nginx served index.html", 200, "<!doctype html><html><body>…</body></html>", "manifest_unusable"),
            ("200 but empty", 200, "", "manifest_unusable"),
            // 🔴 The client refuses it on its own — it cannot know gate ② ran.
            ("200 with a blank sha256", 200, blank_sha.as_str(), "manifest_unusable"),
        ];
        for (name, status, body, expected_tag) in cases {
            let err = interpret(status, body).expect_err(name);
            assert_eq!(err.tag(), expected_tag, "{name}");
        }
    }

    /// The 503 detail is carried through, because it is the only thing that
    /// tells operations WHICH of the endpoint's five refusals fired.
    #[test]
    fn the_endpoints_own_short_code_survives_the_trip() {
        let err = interpret(503, r#"{"error":"UPDATE_MANIFEST_UNAVAILABLE","detail":"bad_sha256:windows-x64:a.msi"}"#)
            .unwrap_err();
        assert_eq!(
            err,
            UpdateFailure::ServiceUnavailable { detail: Some("bad_sha256:windows-x64:a.msi".to_string()) },
        );
        // A 503 whose body we cannot read is still a 503, not a parse failure.
        assert_eq!(
            interpret(503, "<html>gateway</html>").unwrap_err(),
            UpdateFailure::ServiceUnavailable { detail: None },
        );
    }

    /// 🔴 THE RED LINE, asserted over every shape at once: no response, however
    /// broken, may produce「已是最新」("already up to date"). The only value that renders as that
    /// sentence is `UpdateVerdict::UpToDate`, and `interpret` cannot return one
    /// — its `Ok` side is a manifest, and its `Err` side is a taxonomy that
    /// `failure.rs` separately tests for that wording.
    #[test]
    fn no_broken_response_can_be_read_as_up_to_date() {
        for (status, body) in [
            (404, r#"{"error":"not_found"}"#),
            (503, ""),
            (500, "oops"),
            (200, "<!doctype html>"),
            (200, "null"),
            (200, "{}"),
            (200, r#"{"manifest_version":1,"generated_at":"x","platforms":{}}"#),
        ] {
            let err = interpret(status, body)
                .expect_err(&format!("{status} {body:?} must not yield a manifest"));
            assert!(!err.to_string().contains("latest"));
            assert!(!err.is_blocking() || err.tag() == "hash_mismatch");
        }
    }

    /// An empty `platforms` map is refused rather than read as「no platform has
    /// an update」. It is the client-side twin of why the endpoint answers 503
    /// instead of 200-with-an-empty-manifest.
    #[test]
    fn an_empty_manifest_is_not_an_answer() {
        let err = interpret(200, r#"{"manifest_version":1,"generated_at":"x","platforms":{}}"#)
            .unwrap_err();
        assert_eq!(err, UpdateFailure::ManifestUnusable { reason: "empty_platforms".to_string() });
    }
}

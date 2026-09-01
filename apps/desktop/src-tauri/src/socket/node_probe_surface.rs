// The READ-ONLY latency surface over the published relay nodes.
//
// SPEC-REF:
//   docs/strategy/2026-09-01-lan-fable-work-package-2.md Card 1 (the two
//     measurement rules this file exists to obey)
//   apps/desktop/src-tauri/src/socket/node_select.rs (the selector's probe —
//     reused as a TIMEOUT and as the ping SHAPE, never as the aggregator)
//   apps/server-core/src/http/node-routes.ts (`GET /api/node/list`, `GET /api/node/ping`)
//
//! Why this is a new module and not a few lines in `node_select.rs`:
//! another change is in flight against that file (parallel pings, fewer
//! rounds, a different list source). This surface reuses the ping URL and
//! [`PING_TIMEOUT`] and otherwise stays out of the way. It never writes a
//! choice, never dials a socket, and never invents a URL the directory did
//! not publish.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! # TWO MEASUREMENT RULES (learned the hard way, both non-negotiable)
//!
//! 1. **The headline is one round trip on a HOT connection.** The first sample
//!    that answers pays TLS and a cold origin fetch; reporting that as
//!    "latency" is how a panel said **836 ms** for a path whose real RTT was
//!    **67 ms**. That first success is [`PathReading::connect_ms`]. The
//!    headline [`PathReading::rtt_ms`] is the minimum of the samples AFTER
//!    it. One success and nothing after it is an unanswered path, not a
//!    number — a single cold sample is not a hot round trip.
//!
//! 2. **Both paths are visible where both exist.** A node may carry a
//!    published URL and an optional `direct_url`. Measuring only one of
//!    them produced a confidently wrong ~20× answer on a mainland tablet
//!    (Cloudflare vs a direct/proxied address). Today's production directory
//!    publishes the two doors as *separate rows* (`srvjp` vs `srvasia02`);
//!    this shape still shows every published row, and will show two numbers
//!    on one row the day a node carries both URLs.
//!
//! 🔴 This is INFORMATION. There is no "use this node" control. The selector
//! next door is the only writer of which node this PC dials; the phone
//! follows the PC.

use serde::Serialize;
use serde_json::Value;

use super::node_select::PING_TIMEOUT;

/// How many times each path is asked. Local on purpose: the selector's round
/// count is being changed on another branch, and importing it would make this
/// panel's numbers drift under someone else's commit.
pub const SURFACE_ROUNDS: usize = 3;

/// One door of one node — Cloudflare (the published URL) or a direct/alternate
/// address, when the directory named one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Published,
    Alternate,
}

/// One measured door.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathReading {
    pub kind: PathKind,
    /// The first sample that answered — TLS + cold origin. Not the headline.
    pub connect_ms: Option<u64>,
    /// Hot round-trip: the minimum of the samples AFTER the first success.
    /// `None` = this door did not produce a hot sample (named, never a huge
    /// number).
    pub rtt_ms: Option<u64>,
}

/// One published node, as the panel paints it. The node **id is not on this
/// object** — it is our word for the machine, not the user's (owner 2026-08-22 /
/// 2026-08-30). Selection is a boolean the command stamps from the id it
/// already holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NodeLatencyDto {
    pub short: Option<String>,
    pub selected: bool,
    pub paths: Vec<PathReading>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelayLatencyDto {
    pub nodes: Vec<NodeLatencyDto>,
}

/// One door the directory named. Internal — the URL never crosses to the
/// WebView.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedPath {
    pub kind: PathKind,
    pub url: String,
}

/// One row of `GET /api/node/list`, including a door the selector does not
/// consider (non-selectable). A panel that hid those would hide information
/// the operator published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedNode {
    pub id: String,
    pub short: Option<String>,
    pub paths: Vec<ListedPath>,
}

/// Split a sequence of ping results into connect vs headline.
///
/// `None` entries are misses (timeout / refused) and are skipped, not scored.
/// The first `Some` is connect; the rest of the `Some`s are the hot set;
/// the headline is their **minimum** — the floor of the path, matching the
/// selector's sense of "distance" once setup is paid.
///
/// ⚠️ Do not take the median of the whole sequence: for `[836, 67, 70]` that
/// is 70, which still mixes the cold sample into the headline. The reverse
/// control for this function is to put the first sample back into the
/// headline and watch `[836, 67, 70]` report 836.
pub fn split_hot_cold(samples: &[Option<u128>]) -> PathReading {
    let good: Vec<u128> = samples.iter().copied().flatten().collect();
    if good.is_empty() {
        return PathReading {
            kind: PathKind::Published,
            connect_ms: None,
            rtt_ms: None,
        };
    }
    let connect = to_ms(good[0]);
    if good.len() == 1 {
        return PathReading {
            kind: PathKind::Published,
            connect_ms: Some(connect),
            rtt_ms: None,
        };
    }
    let hot = good[1..].iter().copied().min().map(to_ms);
    PathReading {
        kind: PathKind::Published,
        connect_ms: Some(connect),
        rtt_ms: hot,
    }
}

fn to_ms(ms: u128) -> u64 {
    u64::try_from(ms).unwrap_or(u64::MAX)
}

/// HTTPS only — the same rule the selector uses, so a `http://` door cannot
/// appear here as a number the selector would have refused.
fn https_url(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('/');
    if t.starts_with("https://") && t.len() > "https://".len() {
        Some(t.to_string())
    } else {
        None
    }
}

fn short_of(n: &Value) -> Option<String> {
    n.get("short")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 6)
        .map(str::to_string)
}

/// Parse the operator directory. Unknown keys are ignored (additive-field
/// rule). `direct_url`, when present and a distinct HTTPS address, becomes
/// the alternate path. There is no second field on the wire today; this
/// reads it so a later additive publish does not need a client change.
pub fn parse_directory(body: &Value) -> Vec<ListedNode> {
    let Some(arr) = body.get("nodes").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for n in arr {
        let Some(id) = n.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut paths = Vec::new();
        if let Some(url) = n.get("url").and_then(Value::as_str).and_then(https_url) {
            paths.push(ListedPath { kind: PathKind::Published, url });
        }
        if let Some(alt) = n.get("direct_url").and_then(Value::as_str).and_then(https_url) {
            let dup = paths.iter().any(|p| p.url.eq_ignore_ascii_case(&alt));
            if !dup {
                paths.push(ListedPath { kind: PathKind::Alternate, url: alt });
            }
        }
        if paths.is_empty() {
            continue;
        }
        out.push(ListedNode {
            id: id.to_string(),
            short: short_of(n),
            paths,
        });
    }
    out
}

/// Ask each door, split hot/cold, stamp the node this process is already
/// dialing. Pure: the ping is injected so the aggregation is testable
/// without a network.
pub fn check_nodes(
    listed: &[ListedNode],
    current: Option<&str>,
    ping: impl Fn(&str) -> Option<u128>,
    rounds: usize,
) -> RelayLatencyDto {
    let nodes = listed
        .iter()
        .map(|n| {
            let paths = n
                .paths
                .iter()
                .map(|p| {
                    let samples: Vec<Option<u128>> = (0..rounds).map(|_| ping(&p.url)).collect();
                    let mut reading = split_hot_cold(&samples);
                    reading.kind = p.kind;
                    reading
                })
                .collect();
            NodeLatencyDto {
                short: n.short.clone(),
                selected: current == Some(n.id.as_str()),
                paths,
            }
        })
        .collect();
    RelayLatencyDto { nodes }
}

/// Production HTTP: connection **reuse** on purpose. The selector's
/// `HttpProbe` sets `pool_max_idle_per_host(0)` so every selector round is
/// equally cold (fair comparison). This panel wants the opposite: the first
/// round pays setup, the rest are the headline.
pub struct SurfaceHttp {
    client: reqwest::blocking::Client,
}

impl SurfaceHttp {
    pub fn new() -> Option<Self> {
        reqwest::blocking::Client::builder()
            .timeout(PING_TIMEOUT)
            .pool_max_idle_per_host(4)
            .build()
            .ok()
            .map(|client| SurfaceHttp { client })
    }

    pub fn fetch_list(&self, base: &str) -> Vec<ListedNode> {
        let body: Value = match self
            .client
            .get(format!("{base}/api/node/list"))
            .send()
            .ok()
            .and_then(|r| r.json().ok())
        {
            Some(v) => v,
            None => return Vec::new(),
        };
        parse_directory(&body)
    }

    pub fn ping(&self, url: &str) -> Option<u128> {
        let t0 = std::time::Instant::now();
        let res = self.client.get(format!("{url}/api/node/ping")).send().ok()?;
        if !res.status().is_success() {
            return None;
        }
        // Body before the clock stops: headers can be an edge's response line.
        let _ = res.text().ok()?;
        Some(t0.elapsed().as_millis())
    }
}

/// None when there is nothing to ask — empty list, never an error.
pub fn endpoint_base(endpoint: &str) -> Option<&str> {
    let ep = endpoint.trim().trim_end_matches('/');
    if ep.is_empty() {
        None
    } else {
        Some(ep)
    }
}

/// Empty endpoint → empty list, never an error. The panel hides the rows.
pub fn check_live(http: &SurfaceHttp, endpoint: &str, current: Option<&str>) -> RelayLatencyDto {
    let Some(ep) = endpoint_base(endpoint) else {
        return RelayLatencyDto { nodes: Vec::new() };
    };
    let listed = http.fetch_list(ep);
    check_nodes(&listed, current, |url| http.ping(url), SURFACE_ROUNDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::HashMap;

    fn samples(ms: &[u128]) -> Vec<Option<u128>> {
        ms.iter().copied().map(Some).collect()
    }

    #[test]
    fn headline_is_the_hot_round_not_the_cold_first_sample() {
        // The 836 → 67 example from Card 1. First sample is handshake + cold
        // origin; the headline is the floor of the rest.
        let r = split_hot_cold(&samples(&[836, 67, 70]));
        assert_eq!(r.connect_ms, Some(836));
        assert_eq!(r.rtt_ms, Some(67));
    }

    #[test]
    fn a_lone_cold_sample_is_unanswered_not_a_headline() {
        let r = split_hot_cold(&samples(&[836]));
        assert_eq!(r.connect_ms, Some(836));
        assert_eq!(r.rtt_ms, None, "one sample paid setup; that is not a hot RTT");
    }

    #[test]
    fn misses_are_named_not_scored() {
        let r = split_hot_cold(&[None, None, None]);
        assert_eq!(r.connect_ms, None);
        assert_eq!(r.rtt_ms, None);
    }

    #[test]
    fn a_miss_before_the_first_success_does_not_become_connect() {
        let r = split_hot_cold(&[None, Some(90), Some(67), Some(68)]);
        assert_eq!(r.connect_ms, Some(90));
        assert_eq!(r.rtt_ms, Some(67));
    }

    #[test]
    fn parse_directory_keeps_both_doors_on_one_node() {
        let listed = parse_directory(&json!({
            "nodes": [{
                "id": "srvjp",
                "url": "https://srvjp.flowmic.app",
                "direct_url": "https://srvasia02.flowmic.app",
                "short": "asia",
            }]
        }));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].paths.len(), 2);
        assert_eq!(listed[0].paths[0].kind, PathKind::Published);
        assert_eq!(listed[0].paths[1].kind, PathKind::Alternate);
        assert_eq!(listed[0].short.as_deref(), Some("asia"));
    }

    #[test]
    fn parse_directory_drops_a_duplicate_direct_url() {
        let listed = parse_directory(&json!({
            "nodes": [{
                "id": "srvjp",
                "url": "https://srvjp.flowmic.app/",
                "direct_url": "https://srvjp.flowmic.app",
            }]
        }));
        assert_eq!(listed[0].paths.len(), 1);
    }

    #[test]
    fn parse_directory_drops_http() {
        let listed = parse_directory(&json!({
            "nodes": [{ "id": "x", "url": "http://insecure.example" }]
        }));
        assert!(listed.is_empty());
    }

    #[test]
    fn check_nodes_marks_the_current_node_and_shows_both_paths() {
        let listed = vec![ListedNode {
            id: "srvjp".into(),
            short: Some("asia".into()),
            paths: vec![
                ListedPath {
                    kind: PathKind::Published,
                    url: "https://srvjp.flowmic.app".into(),
                },
                ListedPath {
                    kind: PathKind::Alternate,
                    url: "https://srvasia02.flowmic.app".into(),
                },
            ],
        }];
        // Per URL: first sample cold, then two hot. Cloudflare is slow; direct is 67.
        let mut q: HashMap<String, RefCell<Vec<u128>>> = HashMap::new();
        q.insert(
            "https://srvjp.flowmic.app".into(),
            RefCell::new(vec![1353, 200, 210]),
        );
        q.insert(
            "https://srvasia02.flowmic.app".into(),
            RefCell::new(vec![90, 67, 68]),
        );
        let dto = check_nodes(&listed, Some("srvjp"), |url| {
            q.get(url).and_then(|c| {
                let mut v = c.borrow_mut();
                if v.is_empty() {
                    None
                } else {
                    Some(v.remove(0))
                }
            })
        }, 3);
        assert_eq!(dto.nodes.len(), 1);
        assert!(dto.nodes[0].selected);
        assert_eq!(dto.nodes[0].short.as_deref(), Some("asia"));
        assert_eq!(dto.nodes[0].paths.len(), 2);
        assert_eq!(dto.nodes[0].paths[0].kind, PathKind::Published);
        assert_eq!(dto.nodes[0].paths[0].connect_ms, Some(1353));
        assert_eq!(dto.nodes[0].paths[0].rtt_ms, Some(200));
        assert_eq!(dto.nodes[0].paths[1].kind, PathKind::Alternate);
        assert_eq!(dto.nodes[0].paths[1].connect_ms, Some(90));
        assert_eq!(dto.nodes[0].paths[1].rtt_ms, Some(67));
    }

    #[test]
    fn empty_endpoint_is_skipped_not_an_error() {
        assert!(endpoint_base("").is_none());
        assert!(endpoint_base("   ").is_none());
        assert_eq!(endpoint_base("https://flowmic.app/"), Some("https://flowmic.app"));
        let dto = check_nodes(&[], None, |_| unreachable!("must not ping"), 3);
        assert!(dto.nodes.is_empty());
    }

    #[test]
    fn the_id_never_appears_on_the_dto() {
        // The DTO is what the WebView sees. A serde dump must not be able to
        // leak `srvjp`.
        let listed = vec![ListedNode {
            id: "srvjp".into(),
            short: Some("asia".into()),
            paths: vec![ListedPath {
                kind: PathKind::Published,
                url: "https://srvjp.flowmic.app".into(),
            }],
        }];
        let dto = check_nodes(&listed, Some("srvjp"), |_| Some(10), 3);
        let dumped = serde_json::to_string(&dto).unwrap();
        assert!(!dumped.contains("srvjp"), "node id leaked: {dumped}");
        assert!(!dumped.contains("flowmic.app"), "url leaked: {dumped}");
        assert!(dumped.contains("asia"));
        assert!(dumped.contains("\"selected\":true"));
    }
}

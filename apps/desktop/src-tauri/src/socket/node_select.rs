// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §2-2 (why the
//     probe must be application-level and what the self-check is for), §9
//   docs/strategy/2026-08-28-soniox-geo-latency-findings.md §8/§9
//   apps/server-core/src/http/node-routes.ts (the three routes this speaks to)
//   apps/desktop/src-tauri/src/socket/cloud_endpoint.rs (the rule this obeys)
//
//! Which relay node this PC should dial.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! # `endpoint` AND `node` ARE TWO DIFFERENT QUESTIONS
//!
//! `CloudConfig.endpoint` answers **which service am I on** — and it exists so a
//! self-hosted operator can point this install at their own relay. A node
//! answers **which door of that service is nearest me**.
//!
//! Conflating them would be a real bug, not a tidiness issue: rewriting
//! `endpoint` to a node URL would make a latency choice look like a
//! reconfiguration to every other reader of that field — the console login, the
//! QR payload, the endpoint-migration logic next door, and the device page's
//! "which relay am I on" line. So this module NEVER writes `endpoint`. It
//! returns a URL to dial, and the config is untouched.
//!
//! 🔴 AND IT ONLY EVER DIALS A NODE THAT THE ENDPOINT ITSELF PUBLISHED.
//!
//! The first draft of this module compared the endpoint against the canonical
//! string and refused to act on anything else, so that a self-hosted relay could
//! never be silently swapped for one of ours. That instinct was right and the
//! mechanism was wrong: it needed the canonical value inside this crate, which
//! `socket/channel.rs` forbids (no endpoint literal lives here — the frontend
//! supplies it), and it would have had nothing to compare against on a cold boot
//! before the frontend had mounted.
//!
//! The rule that replaces it is stronger, not weaker: the candidate nodes come
//! from a published `/api/node/list` and NOWHERE ELSE. We ask the node this PC
//! is already on when that copy is usable, and the canonical endpoint otherwise
//! (`fetch_published`). Either way the authority is a list that service
//! published, not a URL we invented. A self-hosted relay publishes no list
//! (or its own), so this cannot move that install onto our infrastructure — not
//! because we recognised the name, but because nothing told us to. Authority
//! beats recognition: a name check has to be kept in step with reality, and this
//! one cannot drift.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! # WHY THE PROBE IS AN HTTP ROUND TRIP AND NOT A TCP CONNECT
//!
//! Because behind Cloudflare, connect and TLS measure the wrong thing and do it
//! convincingly. Measured 2026-08-28 from five VPS in five regions against one
//! CF-fronted host: TLS handshake spanned **7 / 8 / 10 / 9 / 10 ms** — a 3 ms
//! spread — while the SAME machines running a real session against the SAME host
//! spanned **44 → 279 ms**. The handshake stops at the local edge; the latency a
//! user pays lives behind it.
//!
//! A selector built on connect() would therefore report every node as equally
//! fast, pick one arbitrarily, and never look broken. `/api/node/ping` is
//! answered by the origin process, so the reading contains the backhaul by
//! construction.
//!
//! 🔴 THE SELF-CHECK IS NOT OPTIONAL. If the spread across nodes is below
//! [`NOISE_FLOOR_MS`], this code is measuring something that is not distance —
//! most likely an edge that started answering, or a cache. In that case it makes
//! NO CHOICE and says so, rather than picking the numerically smallest of a set
//! of readings it does not believe. A selector that always returns a winner
//! cannot tell you it is broken.

use std::time::Duration;

/// Below this spread, the readings cannot be distinguished from measurement
/// noise and no choice is made. Set from the measured CF-edge artefact: the
/// handshake spread was 3 ms across five continents, so anything in that
/// neighbourhood is evidence that we are timing an edge rather than an origin.
/// Real inter-region differences in the same measurement were 44→279 ms, two
/// orders of magnitude clear of this.
///
/// Valid at [`PROBE_ROUNDS`] = 2. This floor compares the spread of per-node
/// *minima*, not the number of samples that produced each minimum. Two rounds
/// still include one warm sample (the second). Warm-to-warm jitter in the
/// 2026-08-31 Singapore sample was 1–13 ms — inside this floor, two orders
/// below inter-region deltas. Raising it because we dropped a round would
/// answer a question this number does not ask.
pub const NOISE_FLOOR_MS: u128 = 20;

/// How many times each node is probed. Two, and the MINIMUM is kept rather
/// than the mean: a single sample carries whatever the scheduler and the TLS
/// session cache were doing, and the mean lets one outlier move the answer,
/// whereas the minimum converges on the floor of the path — which is what
/// "distance" means here.
///
/// ⚠️ THREE → TWO IS A REAL REDUCTION IN CONFIDENCE. A round is noise
/// rejection, not a retry. Measured 2026-08-31 from Singapore (WP2 card 2):
/// NY 764/255/242 and Tokyo 259/80/79 — round 1 is the cold origin fetch,
/// round 2 is already on the warm floor, round 3 moved the min by 13 ms and
/// 1 ms and never changed the ranking. Dropping the third round is that
/// 13 ms of floor-hunting. The sticky margin and noise floor stay at 25/20:
/// they were derived against inter-node spread and reconnect cost, not
/// against round count — see those constants.
pub const PROBE_ROUNDS: usize = 2;

/// A node as published by `GET /api/node/list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeEntry {
    pub id: String,
    pub url: String,
    pub selectable: bool,
    /// True for the ONE node that accepts first contact (registration, pairing).
    ///
    /// ⚠️ CARRIED, NOT ACTED ON, IN THIS MODULE. Being the writer says nothing
    /// about being near — the writer is simply the node whose database is
    /// authoritative, and letting that pull the selector toward it would trade
    /// the whole point of this feature for an irrelevant property. It is parsed
    /// here so that one reader of `/api/node/list` exists rather than two.
    pub writer: bool,
    /// owner 2026-08-30 — the 2-4 character label a screen puts beside a
    /// connection (`us`, `asia`).
    ///
    /// 🔴 CARRIED, NOT DECIDED HERE, and never mapped from [id] in this crate.
    /// The label belongs to the operator's node directory because there are two
    /// clients sharing no runtime: a map in each is one fact with two authors,
    /// and the day a third node is added they disagree until BOTH ship. `None`
    /// ⇒ the caller renders the id verbatim (never a guess, never nothing).
    pub short: Option<String>,
}

/// Why we are dialing what we are dialing. Carried rather than logged in place
/// so the caller writes ONE forensic line containing both the decision and its
/// reason — a decision whose reason lives in a different line is a decision
/// nobody can audit afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// The endpoint is empty — there is nothing to ask. Not an error path anybody
    /// reaches in practice; it exists so `choose` has no unreachable branch.
    NoEndpoint,
    /// One node, or none published. Nothing to choose between.
    SingleNode,
    /// Probed, and the spread was below the noise floor — see NOISE_FLOOR_MS.
    BelowNoiseFloor { spread_ms: u128 },
    /// Probed and chose. `margin_ms` is how much better than the runner-up.
    Chose {
        node: String,
        rtt_ms: u128,
        margin_ms: u128,
    },
    /// Probed and kept the node already in use, because the challenger was not
    /// better by enough to be worth a reconnect.
    Kept { node: String, rtt_ms: u128 },
    /// Probing failed for every node. The caller dials the endpoint as before.
    NoneReachable,
    /// This PC has no token yet, so this connection will REGISTER — and
    /// registration must land on the writer. Nothing was probed; distance is not
    /// the question.
    WriterRequired { node: String },
    /// Registration is due but no node claims `role: "writer"`. The endpoint is
    /// dialled unchanged, which is what every single-node deployment does.
    NoWriterPublished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// The operator's label for [Choice::node], when the directory gave one.
    /// `None` ⇒ render the node id.
    pub short: Option<String>,
    /// What to dial. ALWAYS a usable URL — on every non-choosing path this is
    /// the endpoint itself, so a caller can dial the result unconditionally and
    /// there is no "no node" branch for anybody to forget.
    pub url: String,
    /// The node id, when one was chosen. `None` means "the endpoint as given".
    pub node: Option<String>,
    pub reason: Reason,
}

/// Minimal seam so the decision is testable without a network. Production wires
/// this to `reqwest::blocking`.
///
/// `Sync` because candidate pings run on scoped threads (one per node). A
/// probe that cannot be shared cannot be the production probe.
pub trait Probe: Sync {
    /// `GET {base}/api/node/list` → the published nodes, or None if unreadable.
    fn list(&self, base: &str) -> Option<Vec<NodeEntry>>;
    /// `GET {url}/api/node/ping` → round-trip time, or None if it failed.
    fn ping(&self, url: &str) -> Option<Duration>;
}

/// A node must beat the one already in use by at least this much before the
/// caller reconnects. Without it, two nodes a few milliseconds apart would trade
/// places on every probe and every trade is a dropped socket — the classic
/// flapping selector, which is worse than picking the wrong node once.
///
/// Valid at [`PROBE_ROUNDS`] = 2. This is the cost of tearing down a live
/// socket, not a confidence interval on the probe. The challenger is
/// compared on the same min-of-rounds number as the incumbent. Warm-round
/// jitter in the 2026-08-31 sample (13 ms NY, 1 ms Tokyo) sits at or under
/// this margin, so a two-round min does not make the selector flappier than
/// three did. Tightening it because we probe less would confuse a
/// reconnect-cost constant with a sample-size constant.
pub const STICKY_MARGIN_MS: u128 = 25;

/// One scoped thread per candidate, capped. The operator's directory is
/// already a small set; this is a belt against a huge file, not a pool we
/// tune. Rounds *within* a node stay sequential: round 1 is cold, round 2
/// is warm, and the min of those two is the aggregation. Parallelising rounds
/// would mix cold and warm across nodes and change the ruler.
const PROBE_PARALLELISM: usize = 8;

/// Per-node aggregation: `PROBE_ROUNDS` pings, keep the minimum of those that
/// answered. A node that answers none of them is absent from the result.
fn time_one_node(n: &NodeEntry, probe: &impl Probe) -> Option<u128> {
    let mut best: Option<u128> = None;
    for _ in 0..PROBE_ROUNDS {
        if let Some(d) = probe.ping(&n.url) {
            let ms = d.as_millis();
            best = Some(best.map_or(ms, |b: u128| b.min(ms)));
        }
    }
    best
}

/// Probe candidates in parallel. Wall time is ~max(single node), not the sum.
/// Join order is spawn order (the published order), so equal-RTT ties keep
/// the same winner as the sequential loop this replaced.
fn time_nodes_parallel<'a>(
    nodes: &'a [NodeEntry],
    probe: &impl Probe,
) -> Vec<(&'a NodeEntry, u128)> {
    let mut timed = Vec::with_capacity(nodes.len());
    for chunk in nodes.chunks(PROBE_PARALLELISM) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|n| s.spawn(move || time_one_node(n, probe).map(|ms| (n, ms))))
                .collect();
            for handle in handles {
                if let Some(pair) = handle
                    .join()
                    .unwrap_or_else(|p| std::panic::resume_unwind(p))
                {
                    timed.push(pair);
                }
            }
        });
    }
    timed
}

fn urls_eq(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

/// A replica's directory copy is usable only when it is a real, self-describing
/// fleet. Anything else falls back to the canonical-endpoint fetch — today's
/// path, byte for byte.
///
/// 🔴 2026-08-30 INCIDENT SHAPE. The writer's `nodes.json` and Tokyo's
/// disagreed (`selectable` on `srvjp`). A client that trusted Tokyo's copy
/// skipped selection; the phone badge vanished. A stale replica copy is a
/// real failure mode, which is why this guard exists.
///
/// `GET /api/node/list` carries `{ok, node, nodes, writer?}` — no freshness
/// stamp (the file mtime is an in-process cache on the answering node, never
/// a response field; `version` lives on `/ping`, not on `/list`). Without a
/// stamp the guard is containment: the copy must be non-empty and must name
/// the node we asked. Fail / empty / unparseable / missing-self all degrade
/// to the canonical fetch. Never to "no nodes", never to a guessed URL.
///
/// ⚠️ Containment does not catch the exact 08-30 bytes (Tokyo still *named*
/// itself, it just marked itself unselectable). A stamp would; the route
/// does not have one. The fallback still catches a fetch that fails, a copy
/// that is empty, and a copy that does not know the node we are on.
fn replica_copy_usable(list: &[NodeEntry], current_id: &str) -> bool {
    !list.is_empty() && list.iter().any(|n| n.id == current_id)
}

/// Prefer the node this PC is already talking to. The Singapore measurement
/// (2026-08-31, fmsrvtest-sg) paid **728 ms** asking `flowmic.app` (NY) for a
/// list the local node would have answered in one regional hop.
///
/// Cold start (`current` / `current_url` absent) is today's fetch: the
/// canonical endpoint is the only authority we have. A current URL that
/// *is* the endpoint is the same fetch, not a second one.
fn fetch_published(
    endpoint: &str,
    current: Option<&str>,
    current_url: Option<&str>,
    probe: &impl Probe,
) -> Vec<NodeEntry> {
    let canonical = || probe.list(endpoint).unwrap_or_default();
    let (Some(id), Some(url)) = (current, current_url) else {
        return canonical();
    };
    let url = url.trim_end_matches('/');
    if url.is_empty() || urls_eq(url, endpoint) {
        return canonical();
    }
    match probe.list(url) {
        Some(list) if replica_copy_usable(&list, id) => list,
        // Unusable copy (error / empty / missing self) → today's fetch.
        _ => canonical(),
    }
}

/// Which published node IS this url — asked when we are NOT choosing one.
///
/// 🔴 「我们没有在选点」 and 「我们不知道自己在哪」 are two different facts, and until
/// 2026-08-31 every non-choosing path answered the second one by accident: the
/// desktop's cloud card names the node from this value, so on the overwhelmingly
/// common `SingleNode` path — one selectable node, which is production right now
/// — the card drew nothing at all and the user was told less than the server
/// had already said. Nothing is fetched here: the directory is in hand.
///
/// ⚠️ Matching is on the URL and only on the URL. Comparing ids would need us to
/// already know our id, which is the thing being asked.
fn identify(url: &str, published: &[NodeEntry]) -> (Option<String>, Option<String>) {
    let want = url.trim().trim_end_matches('/');
    published
        .iter()
        .find(|n| n.url.trim_end_matches('/').eq_ignore_ascii_case(want))
        .map_or((None, None), |n| (Some(n.id.clone()), n.short.clone()))
}

/// Choose a node to dial.
///
/// `current` is the node id in use right now, if any — passed in rather than
/// stored here so this function stays pure and the stickiness is visible at the
/// call site.
///
/// `current_url` is the URL that id was last dialed at. The directory is
/// fetched from there when the copy is usable; otherwise from `endpoint`.
/// The two are separate arguments because an id without a URL cannot be
/// asked, and a URL without an id cannot be checked for containment.
///
/// `must_register` is 「this PC has no token, so this connection will emit
/// `pc:register`」 — [`Credentials::is_registered`] inverted, and it OVERRIDES
/// distance entirely. See the block on it below.
pub fn choose(
    endpoint: &str,
    current: Option<&str>,
    current_url: Option<&str>,
    must_register: bool,
    probe: &impl Probe,
) -> Choice {
    let ep = endpoint.trim_end_matches('/');
    if ep.is_empty() {
        return Choice {
            url: endpoint.to_string(),
            node: None,
            short: None,
            reason: Reason::NoEndpoint,
        };
    }

    // ── 🔴 REGISTRATION GOES TO THE WRITER, WHATEVER THE DISTANCE ────────────
    //
    // `pc:register` is not one write, it is seven — insert, setToken,
    // setShortCode, setOnline, setMachineUid, adoptClientInstance, stampPcid —
    // and one of them consumes a plan slot (server `room/registry.ts`). On a
    // read replica every one of them lands in a snapshot the next replication
    // pull overwrites, so THE PAIRING CODE THIS PC IS ABOUT TO SHOW THE USER
    // would be gone within a minute, with no error at either end.
    //
    // A PC registers once per install and reconnects forever, so this branch is
    // rare and the round trip it may cost is paid once. Node selection always
    // belonged on the reconnect leg; this is that statement made executable.
    //
    // ⚠️ NOTHING IS PROBED HERE. Latency is not the question — correctness is —
    // and probing would make a first-run connection wait on measurements whose
    // answer it is going to ignore.
    // Fetched ONCE, and used by both the writer search and the candidate filter.
    // It is also what lets every non-choosing return below still say WHICH node
    // it is dialing — see `identify`.
    let published = fetch_published(ep, current, current_url, probe);

    if must_register {
        return match published
            .iter()
            .find(|n| n.writer && n.url.starts_with("https://"))
        {
            Some(w) => Choice {
                url: w.url.clone(),
                node: Some(w.id.clone()),
                short: w.short.clone(),
                reason: Reason::WriterRequired { node: w.id.clone() },
            },
            // No node claims to be the writer. That is every single-node
            // deployment, and every self-hosted one — dial what we were given.
            None => {
                let (node, short) = identify(endpoint, &published);
                Choice {
                    url: endpoint.to_string(),
                    node,
                    short,
                    reason: Reason::NoWriterPublished,
                }
            }
        };
    }

    // 🔴 THE ONLY SOURCE OF CANDIDATES. See the header: the endpoint is the
    // authority on which doors are its own, so a self-hosted install cannot be
    // moved onto our infrastructure by this function — there is no path here
    // that invents a URL.
    let nodes: Vec<NodeEntry> = published
        .iter()
        .filter(|n| n.selectable && n.url.starts_with("https://"))
        .cloned()
        .collect();
    if nodes.len() < 2 {
        // One node or none. Note this is NOT an error: it is what every
        // single-node deployment answers, which is every deployment until today.
        let (node, short) = identify(endpoint, &published);
        return Choice {
            url: endpoint.to_string(),
            node,
            short,
            reason: Reason::SingleNode,
        };
    }

    let mut timed = time_nodes_parallel(&nodes, probe);
    if timed.is_empty() {
        let (node, short) = identify(endpoint, &published);
        return Choice {
            url: endpoint.to_string(),
            node,
            short,
            reason: Reason::NoneReachable,
        };
    }
    if timed.len() == 1 {
        let (n, ms) = timed[0];
        return Choice {
            url: n.url.clone(),
            node: Some(n.id.clone()),
            short: n.short.clone(),
            reason: Reason::Chose {
                node: n.id.clone(),
                rtt_ms: ms,
                margin_ms: 0,
            },
        };
    }

    timed.sort_by_key(|(_, ms)| *ms);
    let (best, best_ms) = (timed[0].0, timed[0].1);
    let (_, worst_ms) = timed[timed.len() - 1];
    let spread = worst_ms - best_ms;

    // 🔴 The self-check. Below the floor these numbers are not distance, and
    // choosing on them would produce a confident, arbitrary answer that never
    // looks wrong. Say so instead.
    if spread < NOISE_FLOOR_MS {
        let (node, short) = identify(endpoint, &published);
        return Choice {
            url: endpoint.to_string(),
            node,
            short,
            reason: Reason::BelowNoiseFloor { spread_ms: spread },
        };
    }

    if let Some(cur) = current {
        if let Some((n, ms)) = timed.iter().find(|(n, _)| n.id == cur) {
            // Stickiness: a reconnect costs a live socket, so the challenger has
            // to be better by a real margin, not by a millisecond.
            if *ms <= best_ms + STICKY_MARGIN_MS {
                return Choice {
                    url: n.url.clone(),
                    node: Some(n.id.clone()),
                    short: n.short.clone(),
                    reason: Reason::Kept {
                        node: n.id.clone(),
                        rtt_ms: *ms,
                    },
                };
            }
        }
    }

    let margin = timed[1].1 - best_ms;
    Choice {
        url: best.url.clone(),
        node: Some(best.id.clone()),
        short: best.short.clone(),
        reason: Reason::Chose {
            node: best.id.clone(),
            rtt_ms: best_ms,
            margin_ms: margin,
        },
    }
}

impl Reason {
    /// One line for the forensic log. Always says what was decided AND why, in
    /// the same sentence, because those two facts are useless apart.
    pub fn describe(&self) -> String {
        match self {
            Reason::NoEndpoint =>
                "node selection skipped: no endpoint configured".into(),
            Reason::SingleNode =>
                "node selection skipped: fewer than two selectable nodes published".into(),
            Reason::BelowNoiseFloor { spread_ms } => format!(
                "node selection made NO choice: spread {spread_ms}ms is below the {NOISE_FLOOR_MS}ms noise floor — these readings are not distance"
            ),
            Reason::Chose { node, rtt_ms, margin_ms } =>
                format!("node {node} chosen: {rtt_ms}ms, {margin_ms}ms ahead of the runner-up"),
            Reason::Kept { node, rtt_ms } =>
                format!("node {node} kept at {rtt_ms}ms: no challenger better by {STICKY_MARGIN_MS}ms"),
            Reason::NoneReachable =>
                "node selection failed: no published node answered — dialing the endpoint as given".into(),
            Reason::WriterRequired { node } => format!(
                "node {node} chosen because this PC must REGISTER: registration writes seven rows including the pairing code, and a replica would lose all of them within a minute. Distance was not measured."
            ),
            Reason::NoWriterPublished =>
                "registration is due and no node claims role:writer — dialing the endpoint as given (which is what a single-node deployment publishes)".into(),
        }
    }
}

/// The production probe: real HTTP, short timeouts, no retries of its own.
///
/// ⚠️ TIMEOUTS ARE THE MEASUREMENT'S UNITS. A probe that waits ten seconds does
/// not measure a far node, it measures a broken one — and averaging a broken
/// node in with a working one is how a selector ends up choosing the dead box.
/// A node that cannot answer inside `PING_TIMEOUT` is simply not a candidate.
pub struct HttpProbe {
    client: reqwest::blocking::Client,
}

/// Generous enough for a real intercontinental round trip (measured NY↔Tokyo:
/// 154 ms RTT, and a session leg to Singapore at 279 ms), short enough that a
/// dead node cannot hold startup.
pub const PING_TIMEOUT: Duration = Duration::from_millis(2_500);

impl HttpProbe {
    pub fn new() -> Option<Self> {
        reqwest::blocking::Client::builder()
            .timeout(PING_TIMEOUT)
            // 🔴 No connection reuse between probes. A pooled connection would
            // measure a warm socket for later rounds and a cold one for the
            // first, which biases toward whichever node happened to be probed
            // first — the ruler changing between measurements.
            .pool_max_idle_per_host(0)
            .build()
            .ok()
            .map(|client| HttpProbe { client })
    }
}

impl Probe for HttpProbe {
    fn list(&self, base: &str) -> Option<Vec<NodeEntry>> {
        let body: serde_json::Value = self
            .client
            .get(format!("{base}/api/node/list"))
            .send()
            .ok()?
            .json()
            .ok()?;
        let arr = body.get("nodes")?.as_array()?;
        // No freshness stamp on this body (`ok`/`node`/`nodes`/`writer?`).
        // `version` is on `/ping`; the file mtime never leaves the answering
        // process. Containment in `fetch_published` is the client-side guard.
        let mut out = Vec::new();
        for n in arr {
            let (Some(id), Some(url)) = (n.get("id")?.as_str(), n.get("url")?.as_str()) else {
                continue;
            };
            out.push(NodeEntry {
                id: id.to_string(),
                url: url.trim_end_matches('/').to_string(),
                // Absent means selectable — see node-routes.ts NodeEntry.
                selectable: n
                    .get("selectable")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                writer: n.get("role").and_then(|v| v.as_str()) == Some("writer"),
                // Length-checked on the way in: this string goes on a card
                // beside a machine's name, and a client that trusted a server
                // field's length would be trusting a file it does not own.
                short: n
                    .get("short")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.chars().count() <= 6)
                    .map(str::to_string),
            });
        }
        Some(out)
    }

    fn ping(&self, url: &str) -> Option<Duration> {
        let t0 = std::time::Instant::now();
        let res = self
            .client
            .get(format!("{url}/api/node/ping"))
            .send()
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        // The BODY must be read before the clock is stopped. Stopping at headers
        // would time the edge's response line rather than the origin's answer —
        // the exact confusion this whole route exists to avoid.
        let _ = res.text().ok()?;
        Some(t0.elapsed())
    }
}

#[cfg(test)]
#[path = "node_select_tests.rs"]
mod tests;

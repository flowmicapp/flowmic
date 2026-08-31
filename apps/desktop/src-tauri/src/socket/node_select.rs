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
//! from `{endpoint}/api/node/list` and NOWHERE ELSE. The endpoint is the only
//! authority on which doors belong to it. A self-hosted relay publishes no list
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
pub const NOISE_FLOOR_MS: u128 = 20;

/// How many times each node is probed. Three, and the MINIMUM is kept rather
/// than the mean: a single sample carries whatever the scheduler and the TLS
/// session cache were doing, and the mean lets one outlier move the answer,
/// whereas the minimum converges on the floor of the path — which is what
/// "distance" means here.
pub const PROBE_ROUNDS: usize = 3;

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
    Chose { node: String, rtt_ms: u128, margin_ms: u128 },
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
pub trait Probe {
    /// `GET {base}/api/node/list` → the published nodes, or None if unreadable.
    fn list(&self, base: &str) -> Option<Vec<NodeEntry>>;
    /// `GET {url}/api/node/ping` → round-trip time, or None if it failed.
    fn ping(&self, url: &str) -> Option<Duration>;
}

/// A node must beat the one already in use by at least this much before the
/// caller reconnects. Without it, two nodes a few milliseconds apart would trade
/// places on every probe and every trade is a dropped socket — the classic
/// flapping selector, which is worse than picking the wrong node once.
pub const STICKY_MARGIN_MS: u128 = 25;

/// Choose a node to dial.
///
/// `current` is the node id in use right now, if any — passed in rather than
/// stored here so this function stays pure and the stickiness is visible at the
/// call site.
///
/// `must_register` is 「this PC has no token, so this connection will emit
/// `pc:register`」 — [`Credentials::is_registered`] inverted, and it OVERRIDES
/// distance entirely. See the block on it below.
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

pub fn choose(
    endpoint: &str,
    current: Option<&str>,
    must_register: bool,
    probe: &impl Probe,
) -> Choice {
    let ep = endpoint.trim_end_matches('/');
    if ep.is_empty() {
        return Choice { url: endpoint.to_string(), node: None,
            short: None, reason: Reason::NoEndpoint };
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
    let published = probe.list(ep).unwrap_or_default();

    if must_register {
        return match published.iter().find(|n| n.writer && n.url.starts_with("https://")) {
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
                Choice { url: endpoint.to_string(), node, short, reason: Reason::NoWriterPublished }
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
        return Choice { url: endpoint.to_string(), node, short, reason: Reason::SingleNode };
    }

    let mut timed: Vec<(&NodeEntry, u128)> = Vec::new();
    for n in &nodes {
        let mut best: Option<u128> = None;
        for _ in 0..PROBE_ROUNDS {
            if let Some(d) = probe.ping(&n.url) {
                let ms = d.as_millis();
                best = Some(best.map_or(ms, |b: u128| b.min(ms)));
            }
        }
        if let Some(ms) = best {
            timed.push((n, ms));
        }
    }
    if timed.is_empty() {
        let (node, short) = identify(endpoint, &published);
        return Choice { url: endpoint.to_string(), node, short, reason: Reason::NoneReachable };
    }
    if timed.len() == 1 {
        let (n, ms) = timed[0];
        return Choice {
            url: n.url.clone(),
            node: Some(n.id.clone()),
                short: n.short.clone(),
            reason: Reason::Chose { node: n.id.clone(), rtt_ms: ms, margin_ms: 0 },
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
                    reason: Reason::Kept { node: n.id.clone(), rtt_ms: *ms },
                };
            }
        }
    }

    let margin = timed[1].1 - best_ms;
    Choice {
        url: best.url.clone(),
        node: Some(best.id.clone()),
                short: best.short.clone(),
        reason: Reason::Chose { node: best.id.clone(), rtt_ms: best_ms, margin_ms: margin },
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
            // measure a warm socket for the second and third rounds and a cold
            // one for the first, which biases toward whichever node happened to
            // be probed first — the ruler changing between measurements.
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
        let mut out = Vec::new();
        for n in arr {
            let (Some(id), Some(url)) = (n.get("id")?.as_str(), n.get("url")?.as_str()) else {
                continue;
            };
            out.push(NodeEntry {
                id: id.to_string(),
                url: url.trim_end_matches('/').to_string(),
                // Absent means selectable — see node-routes.ts NodeEntry.
                selectable: n.get("selectable").and_then(|v| v.as_bool()).unwrap_or(true),
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
        let res = self.client.get(format!("{url}/api/node/ping")).send().ok()?;
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
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const CANON: &str = "https://flowmic.app";

    struct Fake {
        nodes: Option<Vec<NodeEntry>>,
        rtt: HashMap<String, u64>,
        pings: RefCell<Vec<String>>,
    }
    impl Fake {
        fn new(nodes: &[(&str, &str, u64)]) -> Self {
            Fake {
                nodes: Some(nodes.iter().map(|(id, url, _)| NodeEntry {
                        id: (*id).into(), url: (*url).into(), selectable: true, writer: false, short: None,
                    }).collect()),
                rtt: nodes.iter().map(|(_, url, ms)| ((*url).to_string(), *ms)).collect(),
                pings: RefCell::new(Vec::new()),
            }
        }
    }
    impl Probe for Fake {
        fn list(&self, _base: &str) -> Option<Vec<NodeEntry>> { self.nodes.clone() }
        fn ping(&self, url: &str) -> Option<Duration> {
            self.pings.borrow_mut().push(url.to_string());
            self.rtt.get(url).map(|ms| Duration::from_millis(*ms))
        }
    }

    fn two_far() -> Fake {
        Fake::new(&[("srvny", "https://srvny.flowmic.app", 180), ("srvjp", "https://srvjp.flowmic.app", 40)])
    }

    #[test]
    fn chooses_the_near_node_when_the_difference_is_real() {
        let c = choose(CANON, None, false, &two_far());
        assert_eq!(c.node.as_deref(), Some("srvjp"));
        assert_eq!(c.url, "https://srvjp.flowmic.app");
    }

    #[test]
    fn a_self_hosted_relay_is_never_moved_onto_our_infrastructure() {
        // 🔴 The worst failure this module could have: taking a self-hoster's
        // install off their own box. The guard is authority, not recognition —
        // an endpoint that publishes no node list yields no candidates, so there
        // is no code path here that could invent one of our URLs.
        struct SelfHosted;
        impl Probe for SelfHosted {
            fn list(&self, _: &str) -> Option<Vec<NodeEntry>> { None }
            fn ping(&self, _: &str) -> Option<Duration> {
                panic!("nothing may be probed when the endpoint published no nodes")
            }
        }
        let c = choose("https://relay.example.org", None, false, &SelfHosted);
        assert_eq!(c.url, "https://relay.example.org");
        assert_eq!(c.node, None);
        assert_eq!(c.reason, Reason::SingleNode);
    }

    #[test]
    fn candidates_come_only_from_the_endpoint_that_was_asked() {
        // The positive half of the test above: every URL dialed must be one the
        // endpoint itself named. If this ever fails, some path is synthesising
        // node URLs, which is precisely what must not exist.
        let f = two_far();
        let c = choose(CANON, None, false, &f);
        let published: Vec<String> = f.nodes.clone().unwrap().into_iter().map(|n| n.url).collect();
        assert!(published.contains(&c.url));
        for dialed in f.pings.borrow().iter() {
            assert!(published.contains(dialed), "probed a URL nobody published: {dialed}");
        }
    }

    #[test]
    fn below_the_noise_floor_it_makes_no_choice_rather_than_a_confident_one() {
        // The measured CF artefact: five regions, 3ms apart at the handshake,
        // 44→279ms in reality. A selector that picked the smallest of these
        // would be picking noise and would never look broken.
        let f = Fake::new(&[
            ("srvny", "https://srvny.flowmic.app", 9),
            ("srvjp", "https://srvjp.flowmic.app", 10),
        ]);
        let c = choose(CANON, None, false, &f);
        assert_eq!(c.node, None);
        assert_eq!(c.url, CANON);
        assert!(matches!(c.reason, Reason::BelowNoiseFloor { spread_ms: 1 }));
    }

    #[test]
    fn a_single_published_node_is_not_an_error() {
        let f = Fake::new(&[("srvny", "https://srvny.flowmic.app", 40)]);
        let c = choose(CANON, None, false, &f);
        assert_eq!(c.reason, Reason::SingleNode);
        assert_eq!(c.url, CANON);
    }

    #[test]
    fn an_undialable_fleet_falls_back_to_the_endpoint_rather_than_to_nothing() {
        struct Dead;
        impl Probe for Dead {
            fn list(&self, _: &str) -> Option<Vec<NodeEntry>> {
                Some(vec![
                    NodeEntry { id: "a".into(), url: "https://a.flowmic.app".into(), selectable: true, writer: false, short: None },
                    NodeEntry { id: "b".into(), url: "https://b.flowmic.app".into(), selectable: true, writer: false, short: None },
                ])
            }
            fn ping(&self, _: &str) -> Option<Duration> { None }
        }
        let c = choose(CANON, None, false, &Dead);
        assert_eq!(c.url, CANON);
        assert_eq!(c.reason, Reason::NoneReachable);
    }

    #[test]
    fn stickiness_keeps_the_current_node_when_the_challenger_is_marginal() {
        // Every switch costs a live socket. Two nodes a few ms apart would
        // otherwise trade places forever, and a flapping selector is worse than
        // a wrong one.
        let f = Fake::new(&[
            ("srvny", "https://srvny.flowmic.app", 40),
            ("srvjp", "https://srvjp.flowmic.app", 65),
        ]);
        let c = choose(CANON, Some("srvjp"), false, &f);
        assert_eq!(c.node.as_deref(), Some("srvjp"));
        assert!(matches!(c.reason, Reason::Kept { .. }));
    }

    #[test]
    fn stickiness_yields_when_the_difference_is_large() {
        // The negative control for the test above: without it, "sticky" and
        // "never moves" would be indistinguishable, and a PC that flew to Tokyo
        // would keep dialing New York forever.
        let c = choose(CANON, Some("srvny"), false, &two_far());
        assert_eq!(c.node.as_deref(), Some("srvjp"));
    }

    #[test]
    fn a_node_marked_not_selectable_is_published_but_never_chosen() {
        // How an operator drains a node without deleting the row and losing the
        // record of what its id meant.
        let mut f = two_far();
        f.nodes.as_mut().unwrap()[1].selectable = false;
        let c = choose(CANON, None, false, &f);
        assert_eq!(c.reason, Reason::SingleNode);
    }

    #[test]
    fn a_plaintext_node_url_is_dropped_rather_than_dialed() {
        let mut f = two_far();
        f.nodes.as_mut().unwrap()[1].url = "http://srvjp.flowmic.app".into();
        let c = choose(CANON, None, false, &f);
        assert_eq!(c.reason, Reason::SingleNode);
    }

    /// The near node is srvjp; the WRITER is the far one. Any test that passes
    /// with these swapped is not testing the override.
    fn two_far_with_writer() -> Fake {
        let mut f = two_far();
        f.nodes.as_mut().unwrap()[0].writer = true; // srvny, the 180ms one
        f
    }

    #[test]
    fn registration_goes_to_the_writer_even_when_it_is_the_far_node() {
        // 🔴 pc:register is seven writes including the pairing code the user is
        // about to be shown. On a replica all seven vanish at the next
        // replication pull, with no error at either end.
        let f = two_far_with_writer();
        let c = choose(CANON, None, true, &f);
        assert_eq!(c.node.as_deref(), Some("srvny"));
        assert_eq!(c.url, "https://srvny.flowmic.app");
        assert!(matches!(c.reason, Reason::WriterRequired { .. }));
    }

    #[test]
    /// The NEAR node — that word is the whole assertion, and it lives here rather
    /// than in the identifier because clippy (rightly) rejects screaming case in a
    /// function name.
    fn negative_control_the_same_fleet_picks_the_near_node_when_not_registering() {
        // Without this, "always returns srvny" would pass the test above. This is
        // the assertion that proves must_register is what moved the answer.
        let c = choose(CANON, None, false, &two_far_with_writer());
        assert_eq!(c.node.as_deref(), Some("srvjp"));
    }

    #[test]
    fn registration_probes_nothing() {
        // Latency is not the question and a first-run connection must not wait on
        // measurements whose answer it is going to ignore.
        let f = two_far_with_writer();
        let _ = choose(CANON, None, true, &f);
        assert!(f.pings.borrow().is_empty(), "registration must not measure distance");
    }

    #[test]
    fn registration_with_no_writer_published_dials_the_endpoint() {
        // Every single-node deployment, and every self-hosted one.
        let c = choose(CANON, None, true, &two_far());
        assert_eq!(c.url, CANON);
        assert_eq!(c.reason, Reason::NoWriterPublished);
    }

    #[test]
    fn a_plaintext_writer_is_refused_like_any_other_plaintext_node() {
        let mut f = two_far_with_writer();
        f.nodes.as_mut().unwrap()[0].url = "http://srvny.flowmic.app".into();
        let c = choose(CANON, None, true, &f);
        assert_eq!(c.reason, Reason::NoWriterPublished);
        assert_eq!(c.url, CANON);
    }

    #[test]
    fn every_reason_says_what_was_decided_and_why_in_one_sentence() {
        for r in [
            Reason::NoEndpoint,
            Reason::SingleNode,
            Reason::BelowNoiseFloor { spread_ms: 3 },
            Reason::Chose { node: "srvjp".into(), rtt_ms: 40, margin_ms: 140 },
            Reason::Kept { node: "srvny".into(), rtt_ms: 40 },
            Reason::NoneReachable,
            Reason::WriterRequired { node: "srvny".into() },
            Reason::NoWriterPublished,
        ] {
            let s = r.describe();
            assert!(s.len() > 20, "a reason nobody can read is a reason nobody will check: {s}");
        }
    }
}

// Tests for socket/node_select.rs, split at the 800-line file-size cap
// (`pump_tests.rs` / `admission_tests.rs` precedent). Included via
// `#[cfg(test)] #[path = "node_select_tests.rs"] mod tests;` so `super::*`
// here IS the node_select module.
use super::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const CANON: &str = "https://flowmic.app";
const NY: &str = "https://srvny.flowmic.app";
const JP: &str = "https://srvjp.flowmic.app";

struct Fake {
    nodes: Option<Vec<NodeEntry>>,
    /// Per-base list response. `None` (the Option) is a fetch error. A missing
    /// key falls through to [`Fake::nodes`].
    by_base: HashMap<String, Option<Vec<NodeEntry>>>,
    rtt: HashMap<String, u64>,
    /// Per-URL remaining samples, consumed in order. Empty/absent → [`Fake::rtt`].
    rtt_seq: Mutex<HashMap<String, Vec<u64>>>,
    pings: Mutex<Vec<String>>,
    lists: Mutex<Vec<String>>,
}

fn entry(id: &str, url: &str) -> NodeEntry {
    NodeEntry {
        id: id.into(),
        url: url.into(),
        selectable: true,
        writer: false,
        short: None,
    }
}

fn fleet() -> Vec<NodeEntry> {
    vec![entry("srvny", NY), entry("srvjp", JP)]
}

impl Fake {
    fn new(nodes: &[(&str, &str, u64)]) -> Self {
        Fake {
            nodes: Some(nodes.iter().map(|(id, url, _)| entry(id, url)).collect()),
            by_base: HashMap::new(),
            rtt: nodes
                .iter()
                .map(|(_, url, ms)| ((*url).to_string(), *ms))
                .collect(),
            rtt_seq: Mutex::new(HashMap::new()),
            pings: Mutex::new(Vec::new()),
            lists: Mutex::new(Vec::new()),
        }
    }

    fn asked(&self) -> Vec<String> {
        self.lists.lock().unwrap().clone()
    }

    fn pinged(&self) -> Vec<String> {
        self.pings.lock().unwrap().clone()
    }
}

impl Probe for Fake {
    fn list(&self, base: &str) -> Option<Vec<NodeEntry>> {
        self.lists.lock().unwrap().push(base.to_string());
        if let Some(v) = self.by_base.get(base) {
            return v.clone();
        }
        self.nodes.clone()
    }
    fn ping(&self, url: &str) -> Option<Duration> {
        self.pings.lock().unwrap().push(url.to_string());
        let mut seq = self.rtt_seq.lock().unwrap();
        if let Some(q) = seq.get_mut(url) {
            if !q.is_empty() {
                return Some(Duration::from_millis(q.remove(0)));
            }
        }
        self.rtt.get(url).copied().map(Duration::from_millis)
    }
}

fn two_far() -> Fake {
    Fake::new(&[("srvny", NY, 180), ("srvjp", JP, 40)])
}

/// Sequential oracle: the loop this module used before candidates were
/// probed in parallel. Aggregation is min-of-[`PROBE_ROUNDS`], same as
/// production; independence is the point — if production took the first
/// sample only, this fixture would disagree.
fn sequential_oracle(nodes: &[NodeEntry], probe: &impl Probe) -> Vec<(String, u128)> {
    let mut timed = Vec::new();
    for n in nodes {
        let mut best: Option<u128> = None;
        for _ in 0..PROBE_ROUNDS {
            if let Some(d) = probe.ping(&n.url) {
                let ms = d.as_millis();
                best = Some(best.map_or(ms, |b: u128| b.min(ms)));
            }
        }
        if let Some(ms) = best {
            timed.push((n.id.clone(), ms));
        }
    }
    timed
}

fn selectable(published: &[NodeEntry]) -> Vec<NodeEntry> {
    published
        .iter()
        .filter(|n| n.selectable && n.url.starts_with("https://"))
        .cloned()
        .collect()
}

#[test]
fn chooses_the_near_node_when_the_difference_is_real() {
    let c = choose(CANON, None, None, false, &two_far());
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert_eq!(c.url, JP);
}

#[test]
fn a_self_hosted_relay_is_never_moved_onto_our_infrastructure() {
    // 🔴 The worst failure this module could have: taking a self-hoster's
    // install off their own box. The guard is authority, not recognition —
    // an endpoint that publishes no node list yields no candidates, so there
    // is no code path here that could invent one of our URLs.
    //
    // Two shapes, same property. A relay that ANSWERS without a directory
    // (404 on the route — every self-hosted install; `HttpProbe::list` maps it
    // to `Some(empty)`) is a single node. A relay that does not answer at all
    // (`None`) is an unreadable directory (2026-09-16). Neither may yield a
    // URL the endpoint did not publish, and neither may probe anything.
    struct SelfHosted(Option<Vec<NodeEntry>>);
    impl Probe for SelfHosted {
        fn list(&self, _: &str) -> Option<Vec<NodeEntry>> {
            self.0.clone()
        }
        fn ping(&self, _: &str) -> Option<Duration> {
            panic!("nothing may be probed when the endpoint published no nodes")
        }
    }
    let c = choose("https://relay.example.org", None, None, false, &SelfHosted(Some(vec![])));
    assert_eq!(c.url, "https://relay.example.org");
    assert_eq!(c.node, None);
    assert_eq!(c.reason, Reason::SingleNode);
    let c = choose("https://relay.example.org", None, None, false, &SelfHosted(None));
    assert_eq!(c.url, "https://relay.example.org");
    assert_eq!(c.node, None);
    assert_eq!(c.reason, Reason::ListUnreadable);
}

#[test]
fn candidates_come_only_from_the_endpoint_that_was_asked() {
    // The positive half of the test above: every URL dialed must be one the
    // endpoint itself named. If this ever fails, some path is synthesising
    // node URLs, which is precisely what must not exist.
    let f = two_far();
    let c = choose(CANON, None, None, false, &f);
    let published: Vec<String> = f
        .nodes
        .clone()
        .unwrap()
        .into_iter()
        .map(|n| n.url)
        .collect();
    assert!(published.contains(&c.url));
    for dialed in f.pinged() {
        assert!(
            published.contains(&dialed),
            "probed a URL nobody published: {dialed}"
        );
    }
}

#[test]
fn below_the_noise_floor_it_makes_no_choice_rather_than_a_confident_one() {
    // The measured CF artefact: five regions, 3ms apart at the handshake,
    // 44→279ms in reality. A selector that picked the smallest of these
    // would be picking noise and would never look broken.
    let f = Fake::new(&[("srvny", NY, 9), ("srvjp", JP, 10)]);
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.node, None);
    assert_eq!(c.url, CANON);
    assert!(matches!(c.reason, Reason::BelowNoiseFloor { spread_ms: 1 }));
}

#[test]
fn a_single_published_node_is_not_an_error() {
    let f = Fake::new(&[("srvny", NY, 40)]);
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.reason, Reason::SingleNode);
    assert_eq!(c.url, CANON);
}

#[test]
fn an_undialable_fleet_falls_back_to_the_endpoint_rather_than_to_nothing() {
    struct Dead;
    impl Probe for Dead {
        fn list(&self, _: &str) -> Option<Vec<NodeEntry>> {
            Some(vec![
                entry("a", "https://a.flowmic.app"),
                entry("b", "https://b.flowmic.app"),
            ])
        }
        fn ping(&self, _: &str) -> Option<Duration> {
            None
        }
    }
    let c = choose(CANON, None, None, false, &Dead);
    assert_eq!(c.url, CANON);
    assert_eq!(c.reason, Reason::NoneReachable);
}

#[test]
fn stickiness_keeps_the_current_node_when_the_challenger_is_marginal() {
    // Every switch costs a live socket. Two nodes a few ms apart would
    // otherwise trade places forever, and a flapping selector is worse than
    // a wrong one.
    let f = Fake::new(&[("srvny", NY, 40), ("srvjp", JP, 65)]);
    let c = choose(CANON, Some("srvjp"), None, false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert!(matches!(c.reason, Reason::Kept { .. }));
}

#[test]
fn stickiness_yields_when_the_difference_is_large() {
    // The negative control for the test above: without it, "sticky" and
    // "never moves" would be indistinguishable, and a PC that flew to Tokyo
    // would keep dialing New York forever.
    let c = choose(CANON, Some("srvny"), None, false, &two_far());
    assert_eq!(c.node.as_deref(), Some("srvjp"));
}

#[test]
fn a_node_marked_not_selectable_is_published_but_never_chosen() {
    // How an operator drains a node without deleting the row and losing the
    // record of what its id meant.
    let mut f = two_far();
    f.nodes.as_mut().unwrap()[1].selectable = false;
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.reason, Reason::SingleNode);
}

#[test]
fn a_plaintext_node_url_is_dropped_rather_than_dialed() {
    let mut f = two_far();
    f.nodes.as_mut().unwrap()[1].url = "http://srvjp.flowmic.app".into();
    let c = choose(CANON, None, None, false, &f);
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
    let c = choose(CANON, None, None, true, &f);
    assert_eq!(c.node.as_deref(), Some("srvny"));
    assert_eq!(c.url, NY);
    assert!(matches!(c.reason, Reason::WriterRequired { .. }));
}

#[test]
/// The NEAR node — that word is the whole assertion, and it lives here rather
/// than in the identifier because clippy (rightly) rejects screaming case in a
/// function name.
fn negative_control_the_same_fleet_picks_the_near_node_when_not_registering() {
    // Without this, "always returns srvny" would pass the test above. This is
    // the assertion that proves must_register is what moved the answer.
    let c = choose(CANON, None, None, false, &two_far_with_writer());
    assert_eq!(c.node.as_deref(), Some("srvjp"));
}

#[test]
fn registration_probes_nothing() {
    // Latency is not the question and a first-run connection must not wait on
    // measurements whose answer it is going to ignore.
    let f = two_far_with_writer();
    let _ = choose(CANON, None, None, true, &f);
    assert!(
        f.pinged().is_empty(),
        "registration must not measure distance"
    );
}

#[test]
fn registration_with_no_writer_published_dials_the_endpoint() {
    // Every single-node deployment, and every self-hosted one.
    let c = choose(CANON, None, None, true, &two_far());
    assert_eq!(c.url, CANON);
    assert_eq!(c.reason, Reason::NoWriterPublished);
}

#[test]
fn a_plaintext_writer_is_refused_like_any_other_plaintext_node() {
    let mut f = two_far_with_writer();
    f.nodes.as_mut().unwrap()[0].url = "http://srvny.flowmic.app".into();
    let c = choose(CANON, None, None, true, &f);
    assert_eq!(c.reason, Reason::NoWriterPublished);
    assert_eq!(c.url, CANON);
}

#[test]
fn every_reason_says_what_was_decided_and_why_in_one_sentence() {
    for r in [
        Reason::NoEndpoint,
        Reason::SingleNode,
        Reason::BelowNoiseFloor { spread_ms: 3 },
        Reason::Chose {
            node: "srvjp".into(),
            rtt_ms: 40,
            margin_ms: 140,
        },
        Reason::Kept {
            node: "srvny".into(),
            rtt_ms: 40,
        },
        Reason::NoneReachable,
        Reason::WriterRequired {
            node: "srvny".into(),
        },
        Reason::NoWriterPublished,
        Reason::ListUnreadable,
    ] {
        let s = r.describe();
        assert!(
            s.len() > 20,
            "a reason nobody can read is a reason nobody will check: {s}"
        );
    }
}

#[test]
fn cold_start_asks_only_the_canonical_endpoint() {
    let f = two_far();
    let _ = choose(CANON, None, None, false, &f);
    assert_eq!(f.asked(), vec![CANON.to_string()]);
}

/// Canonical copy is a single node (would skip selection). Current-node copy
/// is the two-node fleet. Using the current copy is the whole assertion.
fn current_valid_canonical_poisoned() -> Fake {
    let mut f = two_far();
    f.by_base.insert(JP.to_string(), Some(fleet()));
    f.by_base
        .insert(CANON.to_string(), Some(vec![entry("srvny", NY)]));
    f
}

#[test]
fn current_node_list_is_used_when_the_copy_is_usable() {
    let f = current_valid_canonical_poisoned();
    let c = choose(CANON, Some("srvjp"), Some(JP), false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert_eq!(
        f.asked(),
        vec![JP.to_string()],
        "usable current copy must not ask the writer"
    );
}

fn unusable_current(reply: Option<Vec<NodeEntry>>) -> Fake {
    let mut f = two_far();
    f.by_base.insert(JP.to_string(), reply);
    f
}

#[test]
fn unusable_current_list_error_falls_back_to_canonical() {
    let f = unusable_current(None);
    let c = choose(CANON, Some("srvjp"), Some(JP), false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert_eq!(f.asked(), vec![JP.to_string(), CANON.to_string()]);
}

#[test]
fn unusable_current_list_empty_falls_back_to_canonical() {
    let f = unusable_current(Some(vec![]));
    let c = choose(CANON, Some("srvjp"), Some(JP), false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert_eq!(f.asked(), vec![JP.to_string(), CANON.to_string()]);
}

#[test]
fn unusable_current_list_missing_self_falls_back_to_canonical() {
    // Tokyo answering a list that does not name Tokyo — the containment
    // half of the 2026-08-30 guard (the route has no freshness stamp).
    let f = unusable_current(Some(vec![entry("srvny", NY)]));
    let c = choose(CANON, Some("srvjp"), Some(JP), false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"));
    assert_eq!(f.asked(), vec![JP.to_string(), CANON.to_string()]);
}

/// First sample would pick Tokyo (70 < 100); min-of-two picks New York
/// (40 < 70). That is the aggregation the parallel path must preserve.
fn varying_min_is_not_the_first_sample() -> Fake {
    let f = Fake::new(&[("srvny", NY, 999), ("srvjp", JP, 999)]);
    *f.rtt_seq.lock().unwrap() = HashMap::from([
        (NY.to_string(), vec![100, 40]),
        (JP.to_string(), vec![70, 70]),
    ]);
    f
}

#[test]
fn parallel_path_preserves_selection_versus_the_sequential_oracle() {
    let oracle_probe = varying_min_is_not_the_first_sample();
    let nodes = selectable(oracle_probe.nodes.as_ref().unwrap());
    let seq = sequential_oracle(&nodes, &oracle_probe);
    let seq_winner = seq
        .iter()
        .min_by_key(|(_, ms)| ms)
        .map(|(id, _)| id.as_str());
    assert_eq!(
        seq_winner,
        Some("srvny"),
        "oracle fixture is min-of-rounds, not first-sample"
    );

    let c = choose(
        CANON,
        None,
        None,
        false,
        &varying_min_is_not_the_first_sample(),
    );
    assert_eq!(c.node.as_deref(), seq_winner);
}

#[test]
fn probe_rounds_is_two_and_every_candidate_is_probed_that_many_times() {
    let f = two_far();
    let _ = choose(CANON, None, None, false, &f);
    let pings = f.pinged();
    assert_eq!(PROBE_ROUNDS, 2);
    assert_eq!(pings.len(), 2 * PROBE_ROUNDS);
    assert_eq!(pings.iter().filter(|u| *u == NY).count(), PROBE_ROUNDS);
    assert_eq!(pings.iter().filter(|u| *u == JP).count(), PROBE_ROUNDS);
}

// ── 2026-09-16 node-selection audit — an unreadable directory is its own fact ──
//
// Measured on dev-pc-a (`window-forensics.log`, 2026-09-15T21:06:39Z,
// autostart at boot): the list fetch died at exactly PING_TIMEOUT, the reason
// line said "fewer than two selectable nodes published" while the directory
// had three, and the PC spent the day on the far writer. Four assertions pin
// the repair: the miss is NAMED, it is ASKED AGAIN, an answer is NOT asked
// again, and a second ask that lands is used like any other read.
//
// Reverse controls actually run (2026-09-16, this lane, dev-pc-a):
// with `LIST_ASKS` forced to 1, TWO tests went red (`…answers_on_the_second_ask`
// on "the second ask's directory drives a real choice", and the budget test);
// with the `readable` branch disabled, THREE went red (both unreadable tests
// and the self-hosted test's `None` shape, all on `reason == SingleNode`).
// Restored, 28 green, `REVERSE-CONTROL` residue grep = 0.

#[test]
fn an_unreadable_directory_is_named_as_such_and_asked_twice() {
    let mut f = two_far();
    f.nodes = None;
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.reason, Reason::ListUnreadable);
    assert_eq!(c.url, CANON, "no directory ⇒ the endpoint as given, never nothing");
    assert_eq!(c.node, None);
    assert_eq!(
        f.asked(),
        vec![CANON.to_string(); LIST_ASKS],
        "a fetch that produced nothing is asked again, at the canonical endpoint only"
    );
    assert!(f.pinged().is_empty(), "nothing to probe when nothing was read");
}

#[test]
fn an_empty_directory_is_an_answer_and_is_not_asked_again() {
    let mut f = two_far();
    f.nodes = Some(vec![]);
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.reason, Reason::SingleNode, "an empty list is a published answer");
    assert_eq!(c.url, CANON);
    assert_eq!(f.asked(), vec![CANON.to_string()], "an answer is never retried");
}

#[test]
fn a_directory_that_answers_on_the_second_ask_is_used() {
    /// Fails the first ask, answers the second — the boot-time shape.
    struct Flaky {
        misses: Mutex<usize>,
        asked: Mutex<Vec<String>>,
        inner: Fake,
    }
    impl Probe for Flaky {
        fn list(&self, base: &str) -> Option<Vec<NodeEntry>> {
            self.asked.lock().unwrap().push(base.to_string());
            let mut m = self.misses.lock().unwrap();
            if *m > 0 {
                *m -= 1;
                return None;
            }
            self.inner.list(base)
        }
        fn ping(&self, url: &str) -> Option<Duration> {
            self.inner.ping(url)
        }
    }
    let f = Flaky { misses: Mutex::new(1), asked: Mutex::new(Vec::new()), inner: two_far() };
    let c = choose(CANON, None, None, false, &f);
    assert_eq!(c.node.as_deref(), Some("srvjp"), "the second ask's directory drives a real choice");
    assert!(matches!(c.reason, Reason::Chose { .. }), "{:?}", c.reason);
    assert_eq!(f.asked.lock().unwrap().clone(), vec![CANON.to_string(), CANON.to_string()]);
}

#[test]
fn registration_on_an_unreadable_directory_says_so_and_dials_the_endpoint() {
    let mut f = two_far();
    f.nodes = None;
    let c = choose(CANON, None, None, true, &f);
    assert_eq!(c.reason, Reason::ListUnreadable);
    assert_eq!(c.url, CANON);
    assert!(f.pinged().is_empty());
}

#[test]
fn the_list_budget_is_not_the_ping_budget() {
    // The whole 2026-09-15 defect in one inequality: the directory fetch must
    // outlive a ping, because it decides everything and runs once.
    assert!(LIST_TIMEOUT > PING_TIMEOUT);
    assert!(LIST_ASKS >= 2, "one ask is the shape that pinned a PC to New York for a day");
}

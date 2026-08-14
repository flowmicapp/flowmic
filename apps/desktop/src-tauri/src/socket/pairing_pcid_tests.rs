// 0.2.66 — what a `pc:register` / `pc:reconnect` ack does to the per-session PCID
// cache (`socket::pairing::SharedPcid`).
//
// The SHAPE of the value is `wire::parse_pcid`'s job and is pinned in wire_tests.rs.
// What is pinned here is the CACHE's behaviour, which is where the two lifetimes
// (5-minute code vs. row-stable id) could be conflated back together.
use super::*;

/// Read the cell the way `DesktopSocket::pcid` (socket/outbound.rs) does.
fn cached(p: &Arc<Pairing>) -> Option<String> {
    p.pcid.lock().unwrap().clone()
}

#[test]
fn a_register_ack_carrying_a_pcid_puts_it_where_the_device_page_reads_it() {
    let (p, rec, path) = fixture(None);
    assert_eq!(cached(&p), None, "a fresh session starts knowing nothing");
    let ack = json!({ "token": "fm_tok", "short_code": "4821", "pcid": "302914775" });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(cached(&p).as_deref(), Some("302914775"));
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_token_reconnect_ack_learns_the_pcid_too_although_it_mints_no_code() {
    // The restart path: no code is minted here, so if the PCID rode on
    // `ShortCodeState` this session would never learn it at all.
    let (p, rec, path) = fixture(Some("fm_tok"));
    let ack = json!({ "pc_id": "pc-9", "room_uuid": "room-9", "pcid": "100200300" });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(cached(&p).as_deref(), Some("100200300"));
    assert!(
        p.short_code.lock().unwrap().is_none(),
        "…and it still minted no code — the two are not one value"
    );
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_ack_that_says_nothing_about_the_pcid_leaves_the_known_one_alone() {
    // "this frame didn't say" is not "the server took it back" (design §4: the id is row-stable). The
    // negative control below is the half that matters: without it this assertion
    // would also pass against a cache that simply never clears anything, including
    // one that ignored the ack entirely.
    let (p, rec, path) = fixture(None);
    on_register_ack(&json!({ "token": "t", "pcid": "302914775" }), &p, &rec);
    on_register_ack(&json!({ "token": "t2", "short_code": "1111" }), &p, &rec);
    assert_eq!(cached(&p).as_deref(), Some("302914775"), "an omission is not a withdrawal");
    // …while an ack that DOES name one replaces it.
    on_register_ack(&json!({ "token": "t3", "pcid": "400500600" }), &p, &rec);
    assert_eq!(cached(&p).as_deref(), Some("400500600"));
    // …and a malformed one is refused rather than written (wire::parse_pcid).
    on_register_ack(&json!({ "token": "t4", "pcid": "40050060" }), &p, &rec);
    assert_eq!(cached(&p).as_deref(), Some("400500600"), "junk never overwrites a real id");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_refused_register_ack_teaches_this_session_nothing() {
    // Same rule the token already follows: a refusal is not an answer about who we
    // are. (An `{error}` ack cannot legitimately carry a pcid; this pins that a
    // future server that sent one anyway could not seed the UI through a refusal.)
    let (p, rec, path) = fixture(None);
    let ack = json!({ "error": "PAIR_RATE_LIMITED", "pcid": "302914775" });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Refused);
    assert_eq!(cached(&p), None);
    std::fs::remove_file(&path).ok();
}

#[test]
fn the_lan_channel_gets_a_pcid_cell_it_simply_never_fills() {
    // A standalone sidecar mints none, so nothing writes this cell on LAN. Asserted
    // rather than assumed because `shell::connection::pcid_for_channel`'s second
    // gate is only defensible while this first one is genuinely empty.
    let (p, rec, path) = fixture(None);
    on_register_ack(&json!({ "token": "t", "short_code": "4821" }), &p, &rec);
    assert_eq!(p.channel, Channel::Lan);
    assert_eq!(cached(&p), None);
    std::fs::remove_file(&path).ok();
}

// Admission (capsule-ownership latch) tests — split from admission.rs at the
// 800-line file-size cap (`dedup_tests.rs`/`pairing_tests.rs`/`wire_tests.rs`
// precedent). Included via `#[cfg(test)] #[path = "admission_tests.rs"] mod tests;`
// inside admission.rs, so `super::*` here IS the admission module — nothing
// about coverage or reachability changes, only which file the bytes live in.
// The subjects are unchanged: single-holder refusal, primary derivation,
// RV-新C roster evidence, the F8① link watchdog, and B4 roster reconciliation.
use super::*;

fn adm() -> Admission {
    Admission::new(Channel::Lan)
}

#[test]
fn first_phone_takes_the_capsule_and_a_second_one_is_refused() {
    let a = adm();
    assert_eq!(a.join(Channel::Lan, "m1"), Verdict::Granted);
    // The SAME phone re-joining (a reconnect) is not a second phone.
    assert_eq!(a.join(Channel::Lan, "m1"), Verdict::Granted);
    // A different phone — on the OTHER channel, which is the case no server
    // could have caught — is refused, and the refusal names the holder.
    assert_eq!(
        a.join(Channel::Cloud, "m2"),
        Verdict::Refused { holder: Owner { channel: Channel::Lan, mobile_id: "m1".into() } }
    );
    // …and the refusal did not disturb the holder.
    assert_eq!(a.owner().unwrap().mobile_id, "m1");
}

#[test]
fn a_refused_phone_leaving_does_not_free_the_holders_capsule() {
    let a = adm();
    a.join(Channel::Lan, "m1");
    a.join(Channel::Cloud, "m2"); // refused
    a.left(Channel::Cloud, "m2");
    assert_eq!(a.owner().unwrap().mobile_id, "m1", "a non-owner's exit must not evict the owner");
    a.left(Channel::Lan, "m1");
    assert_eq!(a.owner(), None);
    // Now the door is open for the next phone, on either channel.
    assert_eq!(a.join(Channel::Cloud, "m2"), Verdict::Granted);
}

#[test]
fn primary_is_derived_from_admission_and_falls_back_to_the_construction_default() {
    let a = adm();
    assert_eq!(a.primary(), Channel::Lan, "no owner ⇒ the construction default");
    a.join(Channel::Cloud, "m2");
    assert_eq!(a.primary(), Channel::Cloud, "a phone on cloud makes cloud primary");
    assert!(!a.is_primary(Channel::Lan));
    a.left(Channel::Cloud, "m2");
    assert_eq!(a.primary(), Channel::Lan, "back to the default when it frees up");
}

#[test]
fn nothing_a_user_can_set_moves_primary() {
    // owner 2026-07-30 ② — THE REVERSE ASSERTION for the deleted user setting.
    // A whole session of joins, refusals, departures and watchdog ticks leaves
    // the no-owner answer exactly where the process started it. Primary moves on
    // EVIDENCE only, of which there are exactly two kinds and neither is a
    // preference: a phone being ADMITTED (here), and RV-新C's handshake roster
    // (the four tests below). If a setter is ever reintroduced, this is the test
    // that has to be deleted to do it.
    let a = Admission::new(Channel::Cloud);
    assert_eq!(a.primary(), Channel::Cloud);
    a.join(Channel::Lan, "m1");
    assert_eq!(a.primary(), Channel::Lan, "admitted ⇒ that phone's channel");
    a.join(Channel::Cloud, "m2"); // refused; the holder keeps the capsule
    assert_eq!(a.primary(), Channel::Lan);
    a.left(Channel::Lan, "m1");
    assert_eq!(a.primary(), Channel::Cloud, "free again ⇒ the same default as at line 1");
}

// ── RV-新C: a handshake roster answers「哪条通道」("which channel"), never「哪一台手机」("which phone") ────────

fn roster(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_handshake_roster_moves_primary_without_making_anybody_an_owner() {
    // THE regression this card exists for: desktop restarts, the phone is already
    // in the CLOUD room and therefore sends no fresh pc:mobile-joined. Before
    // this, primary answered the construction default and every inject came back
    // INJECT_NOT_PRIMARY.
    let a = adm(); // fallback = LAN
    assert_eq!(a.primary(), Channel::Lan, "no evidence at all ⇒ the process default");
    assert_eq!(a.observe_roster(Channel::Cloud, &roster(&["m1"])), Some(Channel::Cloud));
    assert_eq!(a.primary(), Channel::Cloud, "the room with a phone in it carries the runtime");
    assert!(a.is_primary(Channel::Cloud));
    // …and the OTHER question is still unanswered, because a roster cannot answer
    // it: nobody announced themselves, so nobody is 「在用这台电脑」("using this PC").
    assert_eq!(a.owner(), None, "a roster must never fabricate an owner");
}

#[test]
fn a_roster_can_never_refuse_a_real_phone() {
    // THE REVERSE ASSERTION, and the answer to「roster 非空但那台手机其实不在用
    // 这台电脑」("the roster is non-empty but that phone isn't actually using this
    // PC"): because the roster writes no owner, `join` still takes the
    // `None` arm and GRANTS. Had the roster been allowed to seed an owner, a
    // stale/other id would have made the real phone the SECOND phone and it would
    // have been told 「另一台手机占用了这台电脑」("another phone is occupying this PC") — a brand-new user-visible
    // failure invented by the fix.
    let a = adm();
    a.observe_roster(Channel::Cloud, &roster(&["ghost"]));
    assert_eq!(a.join(Channel::Cloud, "real"), Verdict::Granted);
    assert_eq!(a.owner().unwrap().mobile_id, "real");
    // Same on the OTHER channel: evidence for cloud does not reserve the capsule.
    let b = adm();
    b.observe_roster(Channel::Cloud, &roster(&["ghost"]));
    assert_eq!(b.join(Channel::Lan, "real"), Verdict::Granted);
    assert_eq!(b.primary(), Channel::Lan, "an admitted phone outranks the evidence");
}

#[test]
fn an_admitted_phone_outranks_roster_evidence_in_both_orders() {
    let a = adm();
    a.join(Channel::Lan, "m1");
    // A cloud ack lands afterwards (both channels register on every connect).
    a.observe_roster(Channel::Cloud, &roster(&["m2"]));
    assert_eq!(a.primary(), Channel::Lan, "the owner still owns it");
    // …and the evidence is not lost: it takes over the moment the owner leaves.
    a.left(Channel::Lan, "m1");
    assert_eq!(a.primary(), Channel::Cloud);
}

#[test]
fn two_non_empty_rosters_leave_primary_on_the_process_default() {
    // The DECIDING RULE for a tie, asserted in BOTH observation orders so it
    // cannot degenerate into 「whichever ack landed first」.
    for (first, second) in [(Channel::Lan, Channel::Cloud), (Channel::Cloud, Channel::Lan)] {
        let a = Admission::new(Channel::Lan);
        assert!(a.observe_roster(first, &roster(&["a"])).is_some());
        assert_eq!(
            a.observe_roster(second, &roster(&["b"])),
            None,
            "two rooms with phones do not name one channel"
        );
        assert_eq!(a.primary(), Channel::Lan, "a tie answers the construction default");
    }
    // A cloud-defaulted process answers CLOUD on the same tie — the fallback is
    // the process's, not a hardcoded LAN.
    let c = Admission::new(Channel::Cloud);
    c.observe_roster(Channel::Lan, &roster(&["a"]));
    c.observe_roster(Channel::Cloud, &roster(&["b"]));
    assert_eq!(c.primary(), Channel::Cloud);
}

#[test]
fn an_empty_roster_retracts_the_inference_it_made() {
    let a = adm();
    a.observe_roster(Channel::Cloud, &roster(&["m1"]));
    assert_eq!(a.primary(), Channel::Cloud);
    // The relay says the room is empty now — the evidence is gone, so the answer
    // goes back to the default rather than staying on a channel with nobody on it.
    assert_eq!(a.observe_roster(Channel::Cloud, &[]), None);
    assert_eq!(a.primary(), Channel::Lan);
    // And a tie can be BROKEN by one side emptying, which is the other direction
    // of the rule above.
    a.observe_roster(Channel::Lan, &roster(&["m1"]));
    a.observe_roster(Channel::Cloud, &roster(&["m2"]));
    assert_eq!(a.primary(), Channel::Lan, "tie ⇒ default");
    assert_eq!(a.observe_roster(Channel::Lan, &[]), Some(Channel::Cloud));
    assert_eq!(a.primary(), Channel::Cloud);
}

// ── B4: a channel's confirmed roster disproving its own pinned holder ──────

#[test]
fn a_holder_disproved_by_its_own_channels_roster_is_released_and_the_door_opens() {
    // 🔴 THE DEFECT (iOS-2 §2-1, real iPad + Mac mini): the phone that held
    // the capsule via cloud had already left (its pc:mobile-left was lost),
    // the cloud roster reconciled to 0 — and the LAN join was still refused,
    // forever, because nothing connected the two facts.
    let a = adm();
    assert_eq!(a.join(Channel::Cloud, "698f5fe3"), Verdict::Granted);
    // The channel's OWN applied roster says the room is empty now.
    let evicted = a.reconcile_holder(Channel::Cloud, &[]);
    assert_eq!(evicted.unwrap().mobile_id, "698f5fe3", "the ghost holder is named on the way out");
    assert_eq!(a.owner(), None);
    // …and the user-visible half: the next phone on the OTHER channel is
    // admitted as primary, where before it was told 「另一台手机占用了这台电脑」("another phone is occupying this PC")
    // until the whole app was restarted.
    assert_eq!(a.join(Channel::Lan, "6a18ecd2"), Verdict::Granted);
    assert_eq!(a.primary(), Channel::Lan);
}

#[test]
fn a_roster_still_naming_the_holder_keeps_it() {
    // The flap side of the coin, as the desktop sees it: a phone that is back
    // by the time the server builds the ack's confirmed roster IS in that
    // roster — the server's grace did its job, and this side must not undo it.
    let a = adm();
    a.join(Channel::Cloud, "m1");
    assert_eq!(a.reconcile_holder(Channel::Cloud, &roster(&["m1"])), None);
    assert_eq!(a.owner().unwrap().mobile_id, "m1");
    // Same with company in the room (a refused second phone still listed).
    assert_eq!(a.reconcile_holder(Channel::Cloud, &roster(&["m2", "m1"])), None);
    assert_eq!(a.owner().unwrap().mobile_id, "m1");
}

#[test]
fn a_nonempty_roster_missing_the_holder_also_releases() {
    // 「holder absent」, not 「roster empty」: the ack roster is a whole-set
    // replace of confirmed-live phones (GA-26), so a roster naming only
    // OTHER phones disproves the holder exactly as hard as an empty one.
    let a = adm();
    a.join(Channel::Cloud, "m1");
    let evicted = a.reconcile_holder(Channel::Cloud, &roster(&["m2"]));
    assert_eq!(evicted.unwrap().mobile_id, "m1");
    assert_eq!(a.owner(), None);
}

#[test]
fn the_other_channels_roster_says_nothing_about_the_holder() {
    // 🔴 THE REVERSE ASSERTION for the single-holder rule: an empty LAN room
    // is no evidence about a CLOUD holder — releasing on it would let any
    // idle channel's handshake evict whoever is speaking.
    let a = adm();
    a.join(Channel::Cloud, "m1");
    assert_eq!(a.reconcile_holder(Channel::Lan, &[]), None);
    assert_eq!(a.owner().unwrap().mobile_id, "m1", "a cross-channel roster must not evict");
    // And with no owner at all it is a no-op, not a panic or a grant.
    let b = adm();
    assert_eq!(b.reconcile_holder(Channel::Cloud, &[]), None);
    assert_eq!(b.owner(), None);
}

#[test]
fn the_local_watchdog_frees_a_capsule_held_by_a_dead_channel() {
    let a = adm();
    let t0 = Instant::now();
    a.join(Channel::Cloud, "m2");

    // The OTHER channel being down says nothing about the owner.
    a.observe_link(Channel::Lan, false, t0);
    assert_eq!(a.tick(t0), None);
    assert!(a.owner().is_some());

    // First observation only starts the clock — a blip must not evict.
    a.observe_link(Channel::Cloud, false, t0);
    assert_eq!(a.tick(t0), None);
    assert_eq!(a.tick(t0 + OWNER_GRACE - Duration::from_millis(1)), None);
    assert!(a.owner().is_some(), "still inside the grace window");

    // Past the window the capsule is freed, and the caller is told who lost it.
    let evicted = a.tick(t0 + OWNER_GRACE);
    assert_eq!(evicted.unwrap().mobile_id, "m2");
    assert_eq!(a.owner(), None);
    assert_eq!(a.primary(), Channel::Lan);
}

#[test]
fn outbound_prefers_the_primary_slot_but_falls_back_to_a_live_one() {
    assert_eq!(fallback_order(Channel::Lan), [Channel::Lan, Channel::Cloud]);
    assert_eq!(fallback_order(Channel::Cloud), [Channel::Cloud, Channel::Lan]);
    // Both channels appear exactly once — a verb can never be sent twice, and
    // a live channel can never be skipped.
    for p in [Channel::Lan, Channel::Cloud] {
        let order = fallback_order(p);
        assert_ne!(order[0], order[1]);
        assert_eq!(order[0], p);
    }
}

#[test]
fn a_reconnect_inside_the_grace_window_cancels_the_watchdog() {
    let a = adm();
    let t0 = Instant::now();
    a.join(Channel::Cloud, "m2");
    a.observe_link(Channel::Cloud, false, t0);
    a.tick(t0);
    a.observe_link(Channel::Cloud, true, t0 + Duration::from_secs(5)); // came back
    a.tick(t0 + Duration::from_secs(5));
    // The clock restarted: the original deadline must no longer fire.
    assert_eq!(a.tick(t0 + OWNER_GRACE), None);
    assert!(a.owner().is_some());
}

// ── F8①: the watchdog must outlive the socket it guards ─────────────────────

#[test]
fn a_capsule_is_freed_even_though_the_channel_that_held_it_stopped_reporting() {
    // 🔴 THE DEFECT THIS CARD EXISTS FOR. The eviction clock used to be a line
    // inside the pump loop, so a cloud auth failure (shell/cloud.rs →
    // sidecar_ctl::drop_socket → set_socket(Cloud, None) → DesktopSocket::drop →
    // disconnect() → JOIN the pump thread) deleted the only caller that could
    // ever free the capsule. Nothing after that point is a socket event, a
    // frame, or an error — it is SILENCE, and silence used to mean 「一切照旧」("everything as usual").
    //
    // Written against the shipping API rather than a copy of it: the only thing
    // this test does after the teardown moment is let time pass.
    let a = adm();
    let t0 = Instant::now();
    a.join(Channel::Cloud, "m2");
    // The pump's LAST word before its thread was joined: 「我这条通道连着」("my channel is connected").
    a.observe_link(Channel::Cloud, true, t0);

    // …and then nothing, ever again. There is no reporter left to say otherwise.
    assert_eq!(
        a.tick(t0 + LINK_REPORT_TTL),
        None,
        "the report only just went stale — the grace has not even started"
    );
    assert_eq!(a.tick(t0 + LINK_REPORT_TTL + OWNER_GRACE - Duration::from_millis(1)), None);
    let evicted = a
        .tick(t0 + LINK_REPORT_TTL + OWNER_GRACE)
        .expect("a capsule held by a channel nobody can hear must be freed");
    assert_eq!(evicted.mobile_id, "m2");
    assert_eq!(a.owner(), None);

    // …and the user-visible half: the SAME phone showing up on the other channel
    // is admitted, where before it was told 「另一台手机占用了这台电脑」("another phone is occupying this PC") until the
    // whole app was restarted.
    assert_eq!(a.join(Channel::Lan, "m2"), Verdict::Granted);
    assert_eq!(a.primary(), Channel::Lan);
}

#[test]
fn an_ordinary_reconnect_blip_never_costs_a_present_owner_its_capsule() {
    // 🔴 THE REVERSE ASSERTION, i.e. the MIRROR defect this fix must not invent.
    // [`OWNER_GRACE`] exists because the socket ladder's rungs (1→30 s) return
    // well inside it; a watchdog that freed the capsule the moment a channel
    // wobbled — or the moment a session object was replaced — would hand the
    // machine to a second phone while the first one is mid-sentence.
    let a = adm();
    let t0 = Instant::now();
    a.join(Channel::Cloud, "m2");

    // 29 s of a flapping but ALIVE pump: it keeps reporting, and what it reports
    // is 「断了」("disconnected"). Not one of those ticks may evict.
    let mut t = t0;
    while t < t0 + OWNER_GRACE - Duration::from_secs(1) {
        a.observe_link(Channel::Cloud, false, t);
        assert_eq!(a.tick(t), None, "evicted inside the grace window at {t:?}");
        t += Duration::from_secs(1);
    }
    // The ladder came back one second before the deadline.
    a.observe_link(Channel::Cloud, true, t);
    assert_eq!(a.tick(t), None);
    assert_eq!(a.owner().unwrap().mobile_id, "m2", "a reconnect must cost nothing");

    // And the clock really restarted rather than merely being read late: the
    // ORIGINAL deadline passes with the owner still in place.
    a.observe_link(Channel::Cloud, false, t + Duration::from_secs(1));
    assert_eq!(a.tick(t0 + OWNER_GRACE), None);
    assert!(a.owner().is_some());
}

#[test]
fn a_channel_that_is_not_the_owners_can_die_without_touching_the_capsule() {
    // The other half of 「不许误伤」("no friendly fire allowed"): LAN going quiet while a cloud phone owns the
    // capsule must not start any clock at all.
    let a = adm();
    let t0 = Instant::now();
    a.join(Channel::Cloud, "m2");
    a.observe_link(Channel::Lan, true, t0);
    for k in 0..40u64 {
        let now = t0 + Duration::from_secs(k);
        // The owner's channel keeps reporting; LAN said one thing long ago and
        // has been silent since (its socket was torn down).
        a.observe_link(Channel::Cloud, true, now);
        assert_eq!(a.tick(now), None);
    }
    assert_eq!(a.owner().unwrap().mobile_id, "m2");
}

#[test]
fn the_latch_runs_its_own_watchdog_thread_with_no_socket_and_no_pump_in_existence() {
    // 🔴 THE WIRING ASSERTION. Everything above drives `tick` by hand, which is
    // exactly what the old pump did — so a green suite proved nothing about
    // 「谁在叫它」("who's calling it"). This one calls the production starter and then does NOTHING:
    // no socket, no pump, no session exists in this process.
    let a = Arc::new(Admission::new(Channel::Lan));
    a.join(Channel::Cloud, "m2");
    // The state a teardown leaves behind: one last report from a pump that is
    // gone, old enough that the grace has already run out.
    let long_ago = Instant::now()
        .checked_sub(OWNER_GRACE + LINK_REPORT_TTL + Duration::from_secs(1))
        .expect("monotonic clock younger than the grace window");
    a.observe_link(Channel::Cloud, true, long_ago);
    assert!(a.owner().is_some(), "precondition: the capsule is held");

    Admission::ensure_watchdog(&a);
    // Idempotent — the production caller runs on every dial.
    Admission::ensure_watchdog(&a);

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && a.owner().is_some() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        a.owner(),
        None,
        "the latch's OWN thread must free the capsule with nothing else running"
    );
}

// ── B5 (owner report, 2026-08-20) — the operator's eviction is immediate ──────
//
// Replayed from the owner's own machine. The PC had already thrown a phone out
// and then spent thirty seconds refusing OTHER phones on its behalf, because the
// latch only learned through `pc:mobile-left` coming back over the network.
// See `Admission::released_by_operator` for the verbatim forensic trace.

#[test]
fn operator_release_frees_the_capsule_without_waiting_for_the_server() {
    let a = adm();
    assert_eq!(a.join(Channel::Lan, "held"), Verdict::Granted);
    // The state the owner was stuck in: a second phone cannot get in.
    assert!(matches!(a.join(Channel::Cloud, "mine"), Verdict::Refused { .. }));

    // The user presses 断开 on the holder. NOTE what has NOT happened yet:
    // no `pc:mobile-left` — on the real machine that was still 30 s away.
    let freed = a.released_by_operator("held").expect("the holder must be handed back");
    assert_eq!(freed.mobile_id, "held");
    assert_eq!(freed.channel, Channel::Lan);
    assert_eq!(a.owner(), None);

    // …and the phone the user is actually holding gets in NOW, which is the
    // whole point. Before this fix, this line was `Refused`.
    assert_eq!(a.join(Channel::Cloud, "mine"), Verdict::Granted);
}

#[test]
fn the_delayed_mobile_left_must_not_steal_the_new_owners_capsule() {
    // 🔴 THE HAZARD THE FIX CREATES, and the reason this test exists at all.
    // Freeing the capsule early does not cancel the server's `pc:mobile-left`:
    // it still arrives ~30 s later, for the OLD phone, by which time somebody
    // else legitimately holds the capsule. If that late event were read as
    // 「the holder left」the user would be evicted mid-sentence by a message
    // about a phone that has been gone for half a minute — a worse defect than
    // the one being fixed, and invisible in any test that stops at the handover.
    let a = adm();
    a.join(Channel::Lan, "held");
    a.released_by_operator("held");
    assert_eq!(a.join(Channel::Cloud, "mine"), Verdict::Granted);

    // The stale event finally lands. `left` is keyed on (channel, id), so it
    // does not match the new holder and must be inert.
    a.left(Channel::Lan, "held");
    assert_eq!(
        a.owner().map(|o| o.mobile_id),
        Some("mine".to_string()),
        "a late pc:mobile-left for the evicted phone must not evict its successor"
    );
}

#[test]
fn releasing_a_phone_that_does_not_hold_the_capsule_moves_nothing() {
    // The other half of the asymmetry: 断开 on a row that is not the holder is a
    // no-op, not「free the capsule」. Without this, disconnecting the refused
    // second phone would hand the machine away from whoever is mid-utterance.
    let a = adm();
    a.join(Channel::Lan, "held");
    a.join(Channel::Cloud, "other"); // refused, still a row on the device page

    assert_eq!(a.released_by_operator("other"), None);
    assert_eq!(a.owner().map(|o| o.mobile_id), Some("held".to_string()));
    assert_eq!(a.released_by_operator("nobody-ever-paired"), None);
    assert_eq!(a.owner().map(|o| o.mobile_id), Some("held".to_string()));
}

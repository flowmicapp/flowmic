// F-3 Fix#1 / closing-gate tests, split out of pairing_tests.rs at its own
// 800-line cap (pairing_tests.rs already carries a note that it once took
// this exact move from pairing.rs, and refusal_tests.rs is the sibling that
// took refusal-vocabulary tests off it before this one landed). Declared as
// a submodule of pairing_tests so `use super::*` reaches its `fixture` /
// `build_in` / `ShortCodeState` helpers instead of duplicating them here.
use super::*;
use crate::socket::session_gen::{SessionGenerations, CLOSING_RELEASE_AFTER, CLOSING_RELEASE_AFTER_ATTEMPTS};

// ── F-3 Fix#1: a session being torn down does not hand the server a handshake ──
//
// THE SUBJECT IS THE FUNNEL, NOT THE CALLERS. `pc:register` / `pc:reconnect` leave
// this process through the two `emit_*` functions below and nowhere else (grep
// `PC_REGISTER\|PC_RECONNECT` over apps/desktop/src-tauri/src: two definitions in
// events.rs, one whitelist entry, and these two emits). So the guard is asserted
// where every caller — the `open` handler, `auth:expired`, the RV-26 register
// watchdog, and the dead-token fallback — must pass through it.
//
// WHAT THESE TESTS CANNOT SEE, said out loud: the SITUATION is a `rust_socketio`
// reconnect firing `open` on a session we already closed, and reproducing that
// needs a live transport that can be broken on cue. What is pinned here is that the
// flag really gates both emits and that the emits really fire when it is clear —
// the second half is the positive control, and without it a broken fake would look
// exactly like a working guard.

/// Counts frames that reached the transport, per event name. Only `emit_ack` is
/// implemented because that is the entire surface both verbs use.
struct CountingEmitter {
    sent: Mutex<Vec<&'static str>>,
}

impl CountingEmitter {
    fn new() -> Self {
        Self { sent: Mutex::new(Vec::new()) }
    }
    fn events(&self) -> Vec<&'static str> {
        self.sent.lock().unwrap().clone()
    }
}

impl AckEmitter for CountingEmitter {
    fn emit_ack(
        &self,
        event: &'static str,
        _data: serde_json::Value,
        _timeout: Duration,
        // Deliberately dropped: an ack that never arrives is exactly the shape of a
        // frame sent to a server that is not going to answer, and the callback's
        // contents are the subject of the ack tests above, not of this one.
        _callback: Box<dyn FnMut(Payload, RawClient) + Send + 'static>,
    ) -> bool {
        self.sent.lock().unwrap().push(event);
        true
    }
}

#[test]
fn a_closing_session_emits_neither_register_nor_reconnect() {
    // POSITIVE CONTROL FIRST — on an OPEN session both verbs really do reach the
    // transport. Two separate fixtures because the token is what decides which of
    // the two frames a session sends, and the F-3 zombie is the token-bearing one.
    let (fresh, rec_a, _pa) = fixture(None);
    let (paired, rec_b, _pb) = fixture(Some("fm_tok"));
    let open_a = CountingEmitter::new();
    let open_b = CountingEmitter::new();
    emit_register(&open_a, &fresh, &rec_a);
    emit_reconnect(&open_b, &paired, &rec_b);
    assert_eq!(open_a.events(), [events::PC_REGISTER], "an open session registers");
    assert_eq!(open_b.events(), [events::PC_RECONNECT], "an open session reconnects");

    // …and once the session has begun closing, the same two calls send nothing.
    fresh.begin_closing();
    paired.begin_closing();
    let closed_a = CountingEmitter::new();
    let closed_b = CountingEmitter::new();
    emit_register(&closed_a, &fresh, &rec_a);
    emit_reconnect(&closed_b, &paired, &rec_b);
    assert!(
        closed_a.events().is_empty(),
        "a closing session must not re-register (F-3: the library's reconnect arm \
         re-installs the open handler on a socket we believe we closed)"
    );
    assert!(
        closed_b.events().is_empty(),
        "…and must not re-claim the room with its token either — this is the branch \
         the F-3 zombie actually takes, because it HAS a token"
    );
}

// ── W8-2: the closing latch's local watchdog ────────────────────────────────
//
// The real-machine trace (2026-08-10, dev-pc-a): sidecar killed twice,
// watchdog brought up a fresh one, the SUCCESSOR session was never constructed
// (main-thread marshal never ran), and the only session the process had answered
// three `open`s with "SUPPRESSED — this session is closing" — then the PC was
// simply gone from the server (`pc_devices.last_seen_at` froze) until an app
// restart. These tests pin the repair WITHOUT deleting the F-3 Fix#1 assertion:
// a closing session with a constructed successor stays quiet FOREVER; a closing
// session that nobody ever replaced gets its voice back, and hands it back the
// moment a successor finally exists.

#[test]
fn the_f3_protection_holds_forever_once_a_successor_is_constructed() {
    // THE DO-NOT-DELETE HALF, now pinned past every release arm: successor
    // constructed + grace long gone + attempts burned ⇒ still suppressed. This is
    // the exact theft F-3 Fix#1 exists to stop, and no amount of staleness may
    // re-open it.
    let reg = SessionGenerations::new();
    let (zombie, rec_z, _a1, _p1) = build_in(Some("fm_tok"), Channel::Lan, None, reg.clone());
    zombie.mark_constructed();
    let (successor, _rec_s, _a2, _p2) = build_in(Some("fm_tok"), Channel::Lan, None, reg);
    successor.mark_constructed(); // the replacement is up
    zombie.begin_closing();
    zombie.backdate_closing(Duration::from_secs(3600)); // stale beyond any grace
    let wire = CountingEmitter::new();
    for _ in 0..5 {
        // …and burn well past CLOSING_RELEASE_AFTER_ATTEMPTS for good measure.
        emit_reconnect(&wire, &zombie, &rec_z);
        emit_register(&wire, &zombie, &rec_z);
    }
    assert!(
        wire.events().is_empty(),
        "a zombie with a live successor must never re-claim the room, however stale \
         its close is — releasing here would be the F-3 slot theft itself"
    );
}

#[test]
fn a_stale_close_with_no_successor_releases_the_handshake() {
    // THE W8-2 REPAIR (time arm). This session is the newest its channel ever
    // constructed; it began closing and nobody replaced it. Past the grace window
    // the funnel must let it speak again — a machine represented by a half-dead
    // session beats a machine that vanished from the server.
    let reg = SessionGenerations::new();
    let (p, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Lan, None, reg);
    p.mark_constructed();
    p.begin_closing();
    p.backdate_closing(CLOSING_RELEASE_AFTER + Duration::from_secs(1));
    let wire = CountingEmitter::new();
    emit_reconnect(&wire, &p, &rec);
    assert_eq!(
        wire.events(),
        [events::PC_RECONNECT],
        "closing + no successor + stale ⇒ the reconnect goes out (W8-2 release)"
    );
    // The register leg passes the same gate (the funnel covers both verbs).
    let wire2 = CountingEmitter::new();
    emit_register(&wire2, &p, &rec);
    assert_eq!(wire2.events(), [events::PC_REGISTER]);
}

#[test]
fn repeated_suppressed_handshakes_release_without_waiting_for_the_clock() {
    // THE W8-2 REPAIR (attempt arm) — shaped exactly like the real trace: three
    // fresh `open`s arrived and the zombie's reconnect thread then wedged, so a
    // time-only grace (first opens land inside any reasonable window) would have
    // released NOTHING. Two suppressed handshakes = two full reconnect cycles of
    // wall time in which no successor appeared; the third attempt goes through.
    let reg = SessionGenerations::new();
    let (p, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Lan, None, reg);
    p.mark_constructed();
    p.begin_closing(); // fresh close — the time arm must NOT be what fires
    let wire = CountingEmitter::new();
    emit_reconnect(&wire, &p, &rec);
    emit_reconnect(&wire, &p, &rec);
    assert!(
        wire.events().is_empty(),
        "the first {CLOSING_RELEASE_AFTER_ATTEMPTS} handshakes on a fresh close are \
         still suppressed (F-3 Fix#1 within the judgment window)"
    );
    emit_reconnect(&wire, &p, &rec);
    assert_eq!(
        wire.events(),
        [events::PC_RECONNECT],
        "the attempt arm releases on the very open the real trace still had"
    );
}

#[test]
fn a_successor_constructed_after_a_release_re_suppresses_the_zombie() {
    // The release is a per-attempt judgment, not an un-latch: the moment a real
    // successor exists, the F-3 protection re-arms and the zombie yields — so a
    // recovered swap never fights a released zombie for the room slot.
    let reg = SessionGenerations::new();
    let (zombie, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Lan, None, reg.clone());
    zombie.mark_constructed();
    zombie.begin_closing();
    zombie.backdate_closing(CLOSING_RELEASE_AFTER + Duration::from_secs(1));
    let wire = CountingEmitter::new();
    emit_reconnect(&wire, &zombie, &rec);
    assert_eq!(wire.events(), [events::PC_RECONNECT], "released while alone");

    let (successor, _rs, _a2, _p2) = build_in(Some("fm_tok"), Channel::Lan, None, reg);
    successor.mark_constructed(); // the replacement finally arrives
    let wire2 = CountingEmitter::new();
    emit_reconnect(&wire2, &zombie, &rec);
    assert!(
        wire2.events().is_empty(),
        "the successor's construction re-suppresses the zombie on its next open"
    );
}

#[test]
fn a_cloud_session_never_releases_its_closing_latch() {
    // The cloud slot's successorless closes are DELIBERATE (Cloud Key refused /
    // not configured) — a released cloud zombie would re-present a refused or
    // user-removed identity every backoff forever. Stale + attempts burned +
    // newest of its channel: still quiet.
    let reg = SessionGenerations::new();
    let (p, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Cloud, None, reg);
    p.mark_constructed();
    p.begin_closing();
    p.backdate_closing(Duration::from_secs(3600));
    let wire = CountingEmitter::new();
    for _ in 0..5 {
        emit_reconnect(&wire, &p, &rec);
    }
    assert!(wire.events().is_empty(), "cloud: a closing session stays closed");
}

#[test]
fn the_closing_gate_decision_table() {
    // The pure decision, arm by arm — the funnel tests above prove the wiring,
    // this proves the judgment (no clocks, no threads).
    let lan = Channel::Lan;
    let fresh = Some(Duration::from_secs(1));
    let stale = Some(CLOSING_RELEASE_AFTER);
    // Successor wins over EVERYTHING — checked first, releases never, either
    // channel, regardless of `transient` (last arg).
    assert_eq!(closing_gate(lan, 1, 2, 99, stale, false), ClosingGate::Suppress);
    assert_eq!(closing_gate(Channel::Cloud, 1, 2, 99, stale, true), ClosingGate::Suppress);
    // Cloud UNMARKED (every existing production call site): never releases —
    // the AUD-D P1-3 default that must stay safe.
    assert_eq!(closing_gate(Channel::Cloud, 1, 1, 99, stale, false), ClosingGate::Suppress);
    // Cloud MARKED transient (2026-09-02 fix): same staleness arms LAN has.
    assert_eq!(closing_gate(Channel::Cloud, 1, 1, 99, stale, true), ClosingGate::Release);
    assert_eq!(closing_gate(Channel::Cloud, 1, 1, 0, fresh, true), ClosingGate::Suppress);
    // LAN: `transient` is irrelevant — it never gated on the channel tag.
    assert_eq!(closing_gate(lan, 1, 1, 0, fresh, false), ClosingGate::Suppress);
    assert_eq!(closing_gate(lan, 1, 1, 0, fresh, true), ClosingGate::Suppress);
    // Time arm.
    assert_eq!(closing_gate(lan, 1, 1, 0, stale, false), ClosingGate::Release);
    // Attempt arm (clock says fresh).
    let atc = CLOSING_RELEASE_AFTER_ATTEMPTS;
    assert_eq!(closing_gate(lan, 1, 1, atc, fresh, false), ClosingGate::Release);
    // No closing timestamp at all (defensive): the attempt arm still works…
    assert_eq!(closing_gate(lan, 1, 1, atc, None, false), ClosingGate::Release);
    // …and without it, absence of a clock is not staleness.
    assert_eq!(closing_gate(lan, 1, 1, 0, None, false), ClosingGate::Suppress);
}

// ── W8-2 cloud arm (2026-09-02, AUD-D P1-3): before this fix `closing_gate`
// suppressed EVERY successorless cloud close, so a cloud session that lost a
// race against its own redial (heartbeat-death rebuild empties the slot, the
// replacement dial then fails) could never reconnect short of an app restart —
// W8-2's LAN shape, one level up. First test pins the bug (mirrors
// `a_cloud_session_never_releases_its_closing_latch`); second pins the fix
// (`Pairing::mark_transient_close`, called by `mark_slot_transient` before the
// rebuild funnel empties the slot).

#[test]
fn an_unmarked_cloud_close_still_suppresses_forever_when_not_marked_transient() {
    // A cloud session nobody ever told "this close is a redial attempt" — every
    // call site before this fix, and both DELIBERATE ones (Cloud Key refused/
    // removed, not dialable) after it — stays suppressed forever. The test
    // below is what would catch a regression in the opposite direction.
    let reg = SessionGenerations::new();
    let (p, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Cloud, None, reg);
    p.mark_constructed();
    p.begin_closing();
    p.backdate_closing(Duration::from_secs(3600));
    let wire = CountingEmitter::new();
    for _ in 0..5 {
        emit_reconnect(&wire, &p, &rec);
    }
    assert!(wire.events().is_empty(), "cloud, unmarked: staleness alone must not imply a redial");
}

#[test]
fn a_transient_cloud_close_releases_like_lan_once_stale() {
    // Same shape as `a_stale_close_with_no_successor_releases_the_handshake`
    // (LAN), Channel swapped to Cloud + `mark_transient_close` called first —
    // reproducing what `rebuild_after_heartbeat_death` now does before
    // `set_socket(channel, None)`: mark, THEN empty the slot.
    let reg = SessionGenerations::new();
    let (p, rec, _adm, _path) = build_in(Some("fm_tok"), Channel::Cloud, None, reg.clone());
    p.mark_constructed();
    p.mark_transient_close(); // ← the redial funnel's new line, called BEFORE:
    p.begin_closing(); //         …dropping the session (set_socket(None))
    p.backdate_closing(CLOSING_RELEASE_AFTER + Duration::from_secs(1));
    let wire = CountingEmitter::new();
    emit_reconnect(&wire, &p, &rec);
    assert_eq!(wire.events(), [events::PC_RECONNECT], "cloud, transient + stale ⇒ released like LAN");

    // Successor arm still wins even when transient — marking transient must
    // never weaken the F-3 Fix#1 protection itself.
    let (successor, _rs, _a2, _p2) = build_in(Some("fm_tok"), Channel::Cloud, None, reg);
    successor.mark_constructed();
    let wire2 = CountingEmitter::new();
    emit_reconnect(&wire2, &p, &rec);
    assert!(wire2.events().is_empty(), "transient must not override the successor arm");
}

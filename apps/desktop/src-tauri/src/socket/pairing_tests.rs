// Unit tests for the register / reconnect ack decisions, kept in a sibling file so
// pairing.rs (the human-audited auth surface) stays under the 800-line source cap —
// the same move client.rs made when it crossed it (client_tests.rs).
//
// The subject is unchanged: the two ack verdicts, the handshake judgment (RV-34), the
// roster's two readers (RV-08 presence + RV-新C current channel) and the refusal hook.
use super::*;
use crate::socket::admission::Verdict;
use crate::socket::session_gen::{
    SessionGenerations, CLOSING_RELEASE_AFTER, CLOSING_RELEASE_AFTER_ATTEMPTS,
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A throwaway credential file: the ack paths under test really do persist, and
/// pointing them at the shared default path would make two tests fight over it.
fn temp_cred_path() -> PathBuf {
    std::env::temp_dir().join(format!("flowmic-pairing-{}.bin", uuid::Uuid::new_v4()))
}

/// `token = Some(..)` = "this machine has paired before", the precondition of the reconnect
/// leg AND the value that used to masquerade as "the server recognized me".
///
/// No capsule latch (`admission: None`) — the single-socket shape every test below
/// except the RV-新C ones needs; see [`fixture_on`].
fn fixture(token: Option<&str>) -> (Arc<Pairing>, Arc<Reconciler>, PathBuf) {
    let (p, rec, _adm, path) = build(token, Channel::Lan, None);
    (p, rec, path)
}

/// RV-新C — a fixture whose `Pairing` is wired to a REAL capsule latch on
/// `channel`, so the ack roster's SECOND reader can be asserted end to end.
/// The latch's no-evidence fallback is always the OTHER channel, which is what
/// makes "primary moved" a real observation rather than a coincidence.
fn fixture_on(
    token: Option<&str>,
    channel: Channel,
) -> (Arc<Pairing>, Arc<Reconciler>, Arc<Admission>, PathBuf) {
    let fallback = match channel {
        Channel::Lan => Channel::Cloud,
        Channel::Cloud => Channel::Lan,
    };
    let adm = Arc::new(Admission::new(fallback));
    build(token, channel, Some(adm))
}

fn build(
    token: Option<&str>,
    channel: Channel,
    admission: Option<Arc<Admission>>,
) -> (Arc<Pairing>, Arc<Reconciler>, Arc<Admission>, PathBuf) {
    build_in(token, channel, admission, SessionGenerations::new())
}

/// W8-2 — same as [`build`] but sharing a caller-owned generation registry, so
/// the successor-vs-no-successor tests can put two sessions in ONE registry.
/// Every fixture gets its OWN registry (never `process_generations()`): tests run
/// in parallel, and racing them through the process-wide counter would make
/// "has anyone taken over for me" depend on which unrelated test ran last.
fn build_in(
    token: Option<&str>,
    channel: Channel,
    admission: Option<Arc<Admission>>,
    generations: Arc<SessionGenerations>,
) -> (Arc<Pairing>, Arc<Reconciler>, Arc<Admission>, PathBuf) {
    let mut creds = Credentials::fresh("Test PC");
    if let Some(t) = token {
        creds.accept_registration(t, Some("pc-old".into()), Some("room-old".into()));
    }
    let path = temp_cred_path();
    // Kept so the caller can assert against the very latch the Pairing holds; when
    // `admission` is None a throwaway one is returned and nothing writes it.
    let handle = admission.clone().unwrap_or_else(|| Arc::new(Admission::new(channel)));
    let pairing = Pairing::new(
        Arc::new(Mutex::new(creds)),
        Arc::new(path.clone()),
        Arc::new(Mutex::new(None)),
        None,
        channel,
        admission,
        generations,
    );
    let rec = Arc::new(Reconciler::new(Arc::new(AtomicUsize::new(0))));
    (pairing, rec, handle, path)
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ── RV-34: two judgments, one question each ─────────────────────────────

#[test]
fn a_token_on_disk_is_never_a_handshake_claim() {
    // THE reverse assertion. This is the exact state the 0.2.19 forensic caught
    // reporting `registered=true`: a credential file exists, and nothing on this
    // connection has been confirmed by anybody.
    let (p, _rec, path) = fixture(Some("fm_tok"));
    assert!(p.creds.lock().unwrap().is_registered(), "\"this machine has a token\" is true");
    assert!(!p.handshake_acked(), "\"the server recognized me\" must still be false");

    // …and a landed handshake does not survive the connection it was granted on.
    p.mark_handshake_acked("test");
    assert!(p.handshake_acked());
    p.clear_handshake_ack("socket closed");
    assert!(!p.handshake_acked(), "a new connection starts with no claim");
    assert!(
        p.creds.lock().unwrap().is_registered(),
        "…while the token survives, which is the whole point of a token"
    );
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_accepted_register_ack_is_what_flips_the_handshake_judgment() {
    let (p, rec, path) = fixture(None);
    let ack = json!({ "token": "fm_tok_new", "pc_id": "pc-9", "room_uuid": "room-9" });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert!(p.handshake_acked(), "the server answered and accepted");
    let c = p.creds.lock().unwrap();
    assert_eq!(c.token.as_deref(), Some("fm_tok_new"));
    assert_eq!(c.room_uuid.as_deref(), Some("room-9"));
    drop(c);
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_refused_register_ack_claims_nothing_and_persists_nothing() {
    let (p, rec, path) = fixture(None);
    let ack = json!({ "error": "PAIR_RATE_LIMITED" });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Refused);
    assert!(!p.handshake_acked(), "a refusal is not a registration");
    assert!(!p.creds.lock().unwrap().is_registered(), "no token was invented");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_register_ack_with_neither_error_nor_token_is_not_a_registration() {
    // An ack that answers nothing must not be read as a yes — the watchdog has
    // to keep chasing it (this is the "you must not report success if you can't answer" red line).
    let (p, rec, path) = fixture(None);
    let ack = json!({ "short_code": "1234", "expires_in_ms": 300_000 });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::NoToken);
    assert!(!p.handshake_acked());
    // The code it DID carry is still captured — a partial ack is not a lost one.
    assert_eq!(p.short_code.lock().unwrap().as_ref().map(|s| s.code.clone()), Some("1234".into()));
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_accepted_reconnect_ack_marks_the_handshake_too() {
    // RV-34's main win: the reconnect leg now produces the SAME signal, so the
    // pump's watchdog covers it. Before this, the reconnect ack closed a latch
    // that nothing local could observe.
    let (p, rec, path) = fixture(Some("fm_tok"));
    let ack = json!({ "pc_id": "pc-9", "room_uuid": "room-9", "connectedMobiles": [] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert!(p.handshake_acked());
    let c = p.creds.lock().unwrap();
    assert_eq!(c.pc_id.as_deref(), Some("pc-9"), "the ack's ids are adopted");
    assert_eq!(c.room_uuid.as_deref(), Some("room-9"));
    drop(c);
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_dead_token_reconnect_ack_drops_both_the_token_and_the_claim() {
    let (p, rec, path) = fixture(Some("fm_tok_dead"));
    rec.on_join("m1");
    p.mark_handshake_acked("an earlier ack on this same socket");
    let ack = json!({ "error": "AUTH_TOKEN_INVALID" });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::DeadToken);
    assert!(!p.creds.lock().unwrap().is_registered(), "the dead token is gone");
    assert!(!p.handshake_acked(), "…and so is any claim that the server knows us");
    assert_eq!(rec.count(), 0, "the room association is gone with it");
    std::fs::remove_file(&path).ok();
}

// ── RV-08: the register leg reads the roster the server has been sending ──

#[test]
fn the_register_ack_roster_reaches_the_reconciler_like_the_reconnect_one_does() {
    // The defect: server-core grew `connectedMobiles` on the REGISTER ack in
    // 0.2.18 and this side never read it, so a desktop that came back through
    // register (credential file gone / reinstall) sat at mobile_count=0 with a
    // phone in the room — server_ready never opened, the tray said 0 phones.
    let (p, rec, path) = fixture(None);
    let ack = json!({ "token": "t", "connectedMobiles": ["m2", "m1"] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.count(), 2, "the roster was applied, not dropped on the floor");
    assert_eq!(rec.ids(), ids(&["m1", "m2"]));
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_empty_register_roster_is_an_honest_zero_not_a_kept_old_value() {
    let (p, rec, path) = fixture(None);
    rec.reconcile(&ids(&["stale-1", "stale-2"])); // no join stamp → no suppress
    assert_eq!(rec.count(), 2);
    let ack = json!({ "token": "t", "connectedMobiles": [] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.count(), 0, "the server says the room is empty — say so");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_roster_the_server_never_sent_leaves_the_set_alone() {
    // ABSENT is not EMPTY: a server too old to send the field must not zero a
    // presence the join events already proved.
    let (p, rec, path) = fixture(None);
    rec.reconcile(&ids(&["m1"]));
    let ack = json!({ "token": "t" });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.ids(), ids(&["m1"]), "silence changed nothing");
    std::fs::remove_file(&path).ok();
}

#[test]
fn the_register_leg_inherits_the_joined_suppress_protection_too() {
    // Shared implementation, shared guard (GA-26 / 07 §6): a phone that joined
    // DURING the handshake is not zeroed by the ack's stale-empty snapshot —
    // and that now holds on both legs, because there is only one copy of it.
    let (p, rec, path) = fixture(None);
    rec.on_join("m1");
    let ack = json!({ "token": "t", "connectedMobiles": [] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.count(), 1, "the fresh join survives the empty register ack");
    std::fs::remove_file(&path).ok();
}

#[test]
fn the_reconnect_leg_roster_behaves_exactly_as_it_did_before_the_extraction() {
    // Regression fence for the GA-26 behaviour that was moved, not changed.
    let (p, rec, path) = fixture(Some("fm_tok"));
    rec.on_join("residue-1");
    rec.on_join("residue-2");
    let ack = json!({ "connectedMobiles": ["phone-A"] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(rec.ids(), ids(&["phone-A"]), "whole-set replace, never a merge");
    std::fs::remove_file(&path).ok();
}

// ── RV-新C: the same roster also tells the capsule latch WHICH channel ────

#[test]
fn a_register_ack_roster_makes_this_channel_current_after_a_restart() {
    // The user-visible regression: desktop restarts, the phone is already in the
    // CLOUD room, so no pc:mobile-joined will ever arrive. The latch's fallback
    // here is LAN, so a cloud primary can only come from this ack.
    let (p, rec, adm, path) = fixture_on(None, Channel::Cloud);
    assert_eq!(adm.primary(), Channel::Lan, "before the ack: the process default");
    let ack = json!({ "token": "t", "connectedMobiles": ["m1"] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(adm.primary(), Channel::Cloud, "inject and the capsule follow the phone");
    assert_eq!(adm.owner(), None, "…and the roster still named no OWNER");
    std::fs::remove_file(&path).ok();
}

#[test]
fn the_reconnect_leg_feeds_the_latch_too() {
    // Both legs, one implementation — the copy nobody updates is always the one
    // running on the machine with the bug (the reason apply_connected_mobiles is
    // a function at all).
    let (p, rec, adm, path) = fixture_on(Some("fm_tok"), Channel::Cloud);
    let ack = json!({ "connectedMobiles": ["m1"] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(adm.primary(), Channel::Cloud);
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_empty_ack_roster_does_not_claim_this_channel() {
    // THE REVERSE ASSERTION: "the server sent back a roster" must not be read as
    // "this channel has a phone". An empty room is evidence AGAINST, and it leaves primary
    // on the process default.
    let (p, rec, adm, path) = fixture_on(None, Channel::Cloud);
    let ack = json!({ "token": "t", "connectedMobiles": [] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(adm.primary(), Channel::Lan, "an empty room claims nothing");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_roster_the_server_never_sent_never_reaches_the_latch() {
    // ABSENT ≠ EMPTY, upheld once: `apply_connected_mobiles` returns before both
    // readers, so a pre-RV-08 server cannot retract channel evidence either.
    let (p, rec, adm, path) = fixture_on(None, Channel::Cloud);
    rec.on_join("m1");
    adm.observe_roster(Channel::Cloud, &["m1".to_string()]);
    assert_eq!(adm.primary(), Channel::Cloud);
    let ack = json!({ "token": "t" }); // no connectedMobiles at all
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(adm.primary(), Channel::Cloud, "silence changed nothing, here too");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_suppressed_empty_roster_is_not_believed_by_the_latch_either() {
    // One snapshot, one verdict: JOINED_SUPPRESS judged this ack's empty roster
    // stale for PRESENCE, so it must not be trusted to retract the channel
    // evidence in the same breath.
    let (p, rec, adm, path) = fixture_on(None, Channel::Cloud);
    adm.observe_roster(Channel::Cloud, &["m1".to_string()]);
    rec.on_join("m1"); // arms JOINED_SUPPRESS
    let ack = json!({ "token": "t", "connectedMobiles": [] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.count(), 1, "the fresh join survived (pre-existing behaviour)");
    assert_eq!(adm.primary(), Channel::Cloud, "…and so did the channel it implies");
    std::fs::remove_file(&path).ok();
}

// ── B4: the same roster also settles "is the holder pinned to this channel still there" ────────

#[test]
fn an_applied_empty_ack_roster_releases_a_capsule_pinned_to_this_channel() {
    // 🔴 THE WIRE ASSERTION for iOS-2 §2-1. The Admission unit tests drive
    // `reconcile_holder` by hand; cut the call in `apply_connected_mobiles` and
    // every one of them stays green while the ghost capsule is back. This test
    // fails on exactly that cut (reverse control: seen red with the release
    // neutered — `Refused` where `Granted` is expected below).
    let (p, rec, adm, path) = fixture_on(Some("fm_tok"), Channel::Cloud);
    // The pc:mobile-joined that pinned the holder arrived HOURS ago; its
    // pc:mobile-left was lost on a socket flap. Deliberately not `rec.on_join`:
    // stamping the reconciler NOW would arm JOINED_SUPPRESS and exercise the
    // Suppressed arm, which is the NEXT test's subject.
    adm.join(Channel::Cloud, "698f5fe3");
    assert_eq!(adm.owner().unwrap().mobile_id, "698f5fe3", "precondition: pinned");
    // The cloud socket comes back and the server's confirmed roster says: empty.
    let ack = json!({ "connectedMobiles": [] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(adm.owner(), None, "the ghost holder is reconciled away");
    // …and the door is open: the iPad on LAN is admitted as primary, where the
    // real device was told "another phone is occupying this PC" until an app restart.
    assert_eq!(adm.join(Channel::Lan, "6a18ecd2"), Verdict::Granted);
    assert_eq!(adm.primary(), Channel::Lan);
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_suppressed_empty_roster_never_evicts_the_holder() {
    // The flap-shaped protection, as the desktop sees it: a stale-empty snapshot
    // racing the holder's fresh join was judged unusable for PRESENCE
    // (JOINED_SUPPRESS), so it must not be believed about the CAPSULE in the
    // same breath — same one-snapshot-one-verdict rule as the channel evidence.
    let (p, rec, adm, path) = fixture_on(Some("fm_tok"), Channel::Cloud);
    rec.on_join("m1"); // arms JOINED_SUPPRESS
    adm.join(Channel::Cloud, "m1");
    let ack = json!({ "connectedMobiles": [] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(rec.count(), 1, "the fresh join survived (pre-existing behaviour)");
    assert_eq!(adm.owner().unwrap().mobile_id, "m1", "…and so did its capsule");
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_applied_roster_naming_the_holder_keeps_it_across_the_wire_too() {
    // The server's grace worked: the flapping phone was back in time to answer
    // the liveness probe, so the confirmed roster names it — this side must not
    // second-guess that verdict.
    let (p, rec, adm, path) = fixture_on(Some("fm_tok"), Channel::Cloud);
    adm.join(Channel::Cloud, "m1");
    let ack = json!({ "connectedMobiles": ["m1"] });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::Accepted);
    assert_eq!(adm.owner().unwrap().mobile_id, "m1");
    std::fs::remove_file(&path).ok();
}

#[test]
fn a_session_with_no_latch_behaves_exactly_as_it_did_before() {
    // The headless / single-socket shape (the golden example, every other test in
    // this file): `admission: None` ⇒ the roster has ONE reader again and nothing
    // in the ack path can panic on the absent latch.
    let (p, rec, path) = fixture(None);
    let ack = json!({ "token": "t", "connectedMobiles": ["m1", "m2"] });
    assert_eq!(on_register_ack(&ack, &p, &rec), RegisterAckVerdict::Accepted);
    assert_eq!(rec.count(), 2);
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_expired_account_reconnect_ack_keeps_the_pairing_and_fires_the_hook() {
    // #6 zombie-room gate: the server now refuses pc:reconnect with
    // AUTH_TOKEN_EXPIRED when the handshake jwt lapsed. That refusal is about
    // the ACCOUNT — wiping the device token here would force every paired
    // phone to re-pair over a 7-day key lapse, the exact cost shell/cloud.rs
    // deliberately avoids on live-socket auth:expired.
    let hits = Arc::new(AtomicUsize::new(0));
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (h, s) = (hits.clone(), seen.clone());
    let mut creds = Credentials::fresh("PC");
    creds.accept_registration("fm_tok_alive", Some("pc-1".into()), Some("room-1".into()));
    let path = temp_cred_path();
    let p = Pairing::new(
        Arc::new(Mutex::new(creds)),
        Arc::new(path.clone()),
        Arc::new(Mutex::new(None)),
        Some(Arc::new(move |code: &str| {
            h.fetch_add(1, Ordering::SeqCst);
            s.lock().unwrap().push(code.to_string());
        })),
        Channel::Cloud,
        None,
        SessionGenerations::new(),
    );
    let rec = Arc::new(Reconciler::new(Arc::new(AtomicUsize::new(0))));
    p.mark_handshake_acked("an earlier ack on this same socket");

    let ack = json!({ "error": "AUTH_TOKEN_EXPIRED" });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::AccountRefused);
    assert!(
        p.creds.lock().unwrap().is_registered(),
        "the PAIRING credential survives an account refusal"
    );
    assert!(!p.handshake_acked(), "…while this connection is no longer confirmed");
    assert_eq!(hits.load(Ordering::SeqCst), 1, "the shell hook heard the refusal");
    assert_eq!(seen.lock().unwrap().as_slice(), ["AUTH_TOKEN_EXPIRED"]);
    std::fs::remove_file(&path).ok();
}

#[test]
fn an_invalid_token_reconnect_ack_still_takes_the_recovery_path_not_the_hook() {
    // The collision guard: AUTH_TOKEN_INVALID also answers a plain dead DEVICE
    // token (pinned server-side in pc-reconnect-account-auth.test.ts), so it
    // must keep meaning recovery — token cleared, register follows, hook silent.
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let mut creds = Credentials::fresh("PC");
    creds.accept_registration("fm_tok_dead", None, None);
    let path = temp_cred_path();
    let p = Pairing::new(
        Arc::new(Mutex::new(creds)),
        Arc::new(path.clone()),
        Arc::new(Mutex::new(None)),
        Some(Arc::new(move |_code: &str| {
            h.fetch_add(1, Ordering::SeqCst);
        })),
        Channel::Cloud,
        None,
        SessionGenerations::new(),
    );
    let rec = Arc::new(Reconciler::new(Arc::new(AtomicUsize::new(0))));
    let ack = json!({ "error": "AUTH_TOKEN_INVALID" });
    assert_eq!(on_reconnect_ack(&ack, &p, &rec), ReconnectAckVerdict::DeadToken);
    assert!(!p.creds.lock().unwrap().is_registered(), "dead token cleared (recovery)");
    assert_eq!(hits.load(Ordering::SeqCst), 0, "no account refusal was invented");
    std::fs::remove_file(&path).ok();
}

#[test]
fn account_auth_failures_are_exactly_the_two_frozen_codes() {
    assert!(is_account_auth_failure("AUTH_TOKEN_EXPIRED"));
    assert!(is_account_auth_failure("AUTH_TOKEN_INVALID"));
    // Registry / payload failures are NOT an account refusal — a Cloud Key
    // must not be wiped because a payload was malformed.
    assert!(!is_account_auth_failure("PAIR_INVALID_PAYLOAD"));
    assert!(!is_account_auth_failure("PAIR_RATE_LIMITED"));
    assert!(!is_account_auth_failure(""));
}

#[test]
fn a_code_without_a_server_ttl_never_invents_a_deadline() {
    // GA-18: a pre-GA-18 sidecar sends no expires_in_ms. The desktop must NOT
    // fill in "5 minutes" itself — that constant belongs to the server's
    // governor, and a UI copy of it drifts the moment either side changes.
    let s = ShortCodeState::new("1234".into(), None);
    assert_eq!(s.code, "1234");
    assert!(s.expires_at.is_none());
    assert_eq!(s.remaining_ms(), None);
}

#[test]
fn a_ttl_becomes_a_deadline_and_saturates_at_zero_once_past() {
    let s = ShortCodeState::new("1234".into(), Some(300_000));
    let deadline = s.expires_at.expect("deadline captured");
    // Counted from the deadline, not re-derived from the duration.
    let left = s
        .remaining_ms_at(deadline - Duration::from_millis(1_000))
        .expect("some remaining");
    assert_eq!(left, 1_000);
    // Past the deadline: 0, never a negative or a wrapped u64.
    assert_eq!(s.remaining_ms_at(deadline), Some(0));
    assert_eq!(s.remaining_ms_at(deadline + Duration::from_secs(60)), Some(0));
}

#[test]
fn a_refusal_reaches_the_hook_when_one_is_installed() {
    let hits = Arc::new(AtomicUsize::new(0));
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (h, s) = (hits.clone(), seen.clone());
    let pairing = Pairing::new(
        Arc::new(Mutex::new(Credentials::fresh("PC"))),
        Arc::new(PathBuf::from("unused.bin")),
        Arc::new(Mutex::new(None)),
        Some(Arc::new(move |code: &str| {
            h.fetch_add(1, Ordering::SeqCst);
            s.lock().unwrap().push(code.to_string());
        })),
        Channel::Cloud, // the hook is only ever installed on the cloud channel
        None,
        SessionGenerations::new(),
    );
    pairing.report_refusal("pc:register", "AUTH_TOKEN_EXPIRED");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(seen.lock().unwrap().as_slice(), ["AUTH_TOKEN_EXPIRED"]);
}

#[test]
fn a_refusal_without_a_hook_is_recorded_and_never_panics() {
    // The LAN channel installs no hook — the refusal path must still be safe.
    let pairing = Pairing::new(
        Arc::new(Mutex::new(Credentials::fresh("PC"))),
        Arc::new(PathBuf::from("unused.bin")),
        Arc::new(Mutex::new(None)),
        None,
        Channel::Lan,
        None,
        SessionGenerations::new(),
    );
    pairing.report_refusal("pc:register", "PAIR_INVALID_PAYLOAD");
}

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
    // Successor wins over EVERYTHING — checked first, releases never.
    assert_eq!(closing_gate(lan, 1, 2, 99, stale), ClosingGate::Suppress);
    // Cloud never releases.
    assert_eq!(closing_gate(Channel::Cloud, 1, 1, 99, stale), ClosingGate::Suppress);
    // LAN, no successor, fresh, no attempts burned: still the plain Fix#1.
    assert_eq!(closing_gate(lan, 1, 1, 0, fresh), ClosingGate::Suppress);
    // Time arm.
    assert_eq!(closing_gate(lan, 1, 1, 0, stale), ClosingGate::Release);
    // Attempt arm (clock says fresh).
    assert_eq!(closing_gate(lan, 1, 1, CLOSING_RELEASE_AFTER_ATTEMPTS, fresh), ClosingGate::Release);
    // No closing timestamp at all (defensive): the attempt arm still works…
    assert_eq!(closing_gate(lan, 1, 1, CLOSING_RELEASE_AFTER_ATTEMPTS, None), ClosingGate::Release);
    // …and without it, absence of a clock is not staleness.
    assert_eq!(closing_gate(lan, 1, 1, 0, None), ClosingGate::Suppress);
}

#[test]
fn begin_closing_is_one_way_and_idempotent() {
    let (p, _rec, _path) = fixture(Some("fm_tok"));
    assert!(!p.is_closing(), "a fresh session is not closing");
    p.begin_closing();
    p.begin_closing(); // second call must not panic and must not un-set it
    assert!(p.is_closing(), "there is no path back: this session is over");
    // It is a DIFFERENT question from RV-34's handshake judgment, which is
    // per-connection and does move both ways. Conflating them would give one flag
    // two meanings — and `clear_handshake_ack` runs on every socket close, so a
    // shared flag would un-close a closing session on its way out.
    p.mark_handshake_acked("test");
    p.clear_handshake_ack("socket closed");
    assert!(p.is_closing(), "the teardown flag survives a handshake flap");
}

// 0.2.66 — the PCID cache, in its own file (this one is close to the source cap
// too). Declared HERE rather than from pairing.rs so it inherits `fixture` above
// instead of growing a second copy of it.
#[path = "pairing_pcid_tests.rs"]
mod pcid;

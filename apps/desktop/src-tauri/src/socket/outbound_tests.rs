// Tests for `note_account_refusal_on` — the free function `emit_settings_update`'s
// ASYNC ack callback closes over (WP-6, 2026-09-02), extracted from
// `DesktopSocket::note_account_refusal`'s body so it can run on whichever thread
// `rust_socketio` invokes an ack callback on, after the calling method has
// already returned (07 §8's "instant" forbids blocking that path — see
// `emit_settings_update`'s own doc).
//
// Same evidentiary pattern as `refusal_tests.rs`'s `hook_recording_pairing`: a
// real `Pairing` with a real hook, so what is asserted is the value
// `shell::cloud::auth_failure_hook` would actually read — not a log line, and
// not a predicate in isolation. Before this extraction, `settings:update` never
// read its ack at all: a replica's `NODE_IS_REPLICA` refusal (or, before WP-6's
// generic handoff, EVERY settings write on a replica) vanished with no forensic
// line and no UI change — the user's edit looked saved and was not.

use super::*;
use crate::socket::channel::Channel;
use crate::socket::credentials::Credentials;
use crate::socket::pairing::Pairing;
use crate::socket::refusal::RefusalAuthority;
use crate::socket::session_gen::SessionGenerations;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// A `Pairing` on the cloud channel whose hook records every (code, authority) —
/// VERBATIM the same fixture `refusal_tests.rs` uses, duplicated rather than
/// shared across files at the file-size split (this repo's own precedent for
/// `mintShortCode`/`resolveToken`-shaped duplication, `node/forward-sync.ts`
/// header, applies here too: a helper this small is cheaper to repeat than to
/// thread a new `pub(crate)` export through for one caller).
fn hook_recording_pairing() -> (Arc<Pairing>, Arc<Mutex<Vec<(String, RefusalAuthority)>>>) {
    let seen: Arc<Mutex<Vec<(String, RefusalAuthority)>>> = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let pairing = Pairing::new(
        Arc::new(Mutex::new(Credentials::fresh("PC"))),
        Arc::new(PathBuf::from("unused.bin")),
        Arc::new(Mutex::new(None)),
        Some(Arc::new(move |code: &str, a: RefusalAuthority| {
            s.lock().unwrap().push((code.to_string(), a));
        })),
        Channel::Cloud,
        None,
        SessionGenerations::new(),
    );
    (pairing, seen)
}

#[test]
fn an_account_verdict_reaches_the_cloud_card() {
    let (pairing, seen) = hook_recording_pairing();

    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, Some("AUTH_TOKEN_INVALID"));

    let recorded = seen.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, "AUTH_TOKEN_INVALID");
    assert_eq!(recorded[0].1, RefusalAuthority::DevicePageVerb);
}

#[test]
fn account_restricted_is_also_a_verdict() {
    let (pairing, seen) = hook_recording_pairing();
    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, Some("ACCOUNT_RESTRICTED"));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn a_node_routing_refusal_must_not_reach_the_cloud_card() {
    // 🔴 THE REVERSE OF THE PRECEDING TEST, and the reason `note_account_refusal`
    // exists as a two-way gate rather than "forward everything": `NODE_IS_REPLICA`
    // is a fact about which machine answered, not about the account. Painting it
    // on the cloud card would tell a user with a perfectly good subscription that
    // something is wrong with their account, on every settings edit made while
    // the generic handoff (WP-6) has nobody to forward to.
    let (pairing, seen) = hook_recording_pairing();

    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, Some("NODE_IS_REPLICA"));

    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn a_schema_or_sync_refusal_also_stays_off_the_cloud_card() {
    let (pairing, seen) = hook_recording_pairing();
    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, Some("SETTINGS_SCHEMA_INVALID"));
    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, Some("SETTINGS_SYNC_FAIL"));
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn no_code_at_all_is_a_no_op() {
    // The ack timed out, or carried no `error` field (an ordinary success) — in
    // either case there is nothing to report, and this must not panic on `None`.
    let (pairing, seen) = hook_recording_pairing();
    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, None);
    assert!(seen.lock().unwrap().is_empty());
}

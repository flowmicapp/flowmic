// Tests for the refusal vocabulary and for the ONE decision it feeds: may this
// refusal cost the user their Cloud Key. Moved out of `pairing_tests.rs` on
// 2026-09-01 when that file hit its 800-line cap; they sit beside `refusal.rs`
// because that is the module whose contract they pin.
//
// They drive the real `Pairing::report_refusal` / `report_verb_refusal` through a
// real hook, so what is asserted is the value `shell::cloud::auth_failure_hook`
// actually reads — not a log line, and not a predicate in isolation.

use super::*;
use crate::socket::channel::Channel;
use crate::socket::credentials::Credentials;
use crate::socket::pairing::Pairing;
use crate::socket::session_gen::SessionGenerations;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// A `Pairing` on the cloud channel whose hook records every (code, authority).
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
        Channel::Cloud, // the hook is only ever installed on the cloud channel
        None,
        SessionGenerations::new(),
    );
    (pairing, seen)
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
    // 🔴 …and the code minted on 2026-09-01 to retire this defect is not one of
    // them either. `PC_HANDSHAKE_PENDING` is what an up-to-date relay answers in
    // place of the AUTH_TOKEN_INVALID that used to arrive here; treating it as an
    // account failure would rebuild the bug on top of its own fix.
    assert!(!is_account_auth_failure("PC_HANDSHAKE_PENDING"));
}

#[test]
fn a_refusal_reaches_the_hook_when_one_is_installed() {
    let (pairing, seen) = hook_recording_pairing();
    pairing.report_refusal("pc:register", "AUTH_TOKEN_EXPIRED");
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [(
            "AUTH_TOKEN_EXPIRED".to_string(),
            RefusalAuthority::IdentityHandshake
        )]
    );
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

// ── 2026-09-01: the four measured sign-outs (see RefusalAuthority) ────────────
//
// 🔴 THE REVERSE CONTROL IS THE POINT OF THIS PAIR, so it is spelled out rather
// than left to be re-derived: make `report_verb_refusal` delegate to
// `report_refusal` (i.e. undo the fix) and the FIRST test below fails on
// `IdentityHandshake != DevicePageVerb` — which is exactly the wire on which the
// shell decides whether to delete the user's Cloud Key. Measured red before
// green; the assertion is on the authority the shell reads, not on a log line.

#[test]
fn a_device_page_verb_refusal_reaches_the_screen_without_credential_authority() {
    let (pairing, seen) = hook_recording_pairing();
    // The exact frame dev-pc-a saw four times: `pc:list-mobiles` answered
    // AUTH_TOKEN_INVALID while this connection's pc:reconnect ack was still in
    // flight (it landed 56–335 ms later, every time).
    pairing.report_verb_refusal("pc:list-mobiles", "AUTH_TOKEN_INVALID");
    let got = seen.lock().unwrap().clone();
    assert_eq!(
        got.len(),
        1,
        "the refusal must still REACH the hook — owner 2026-08-27 §R1 追加 asks that \
         every relay refusal reach the screen; this fix removes its authority, not its voice"
    );
    assert_eq!(
        got[0],
        (
            "AUTH_TOKEN_INVALID".to_string(),
            RefusalAuthority::DevicePageVerb
        ),
        "a verb may never present itself with the authority of the identity handshake"
    );
}

#[test]
fn the_identity_handshake_keeps_the_authority_a_verb_lost() {
    // The positive control for the test above. Without it, deleting the whole
    // account-refusal path would leave both tests green while a genuinely dead
    // Cloud Key sat on disk being re-dialled forever.
    let (pairing, seen) = hook_recording_pairing();
    pairing.report_refusal("pc:reconnect", "AUTH_TOKEN_EXPIRED");
    pairing.report_refusal("auth:expired", "auth:expired");
    let got = seen.lock().unwrap().clone();
    assert!(
        got.iter()
            .all(|(_, a)| *a == RefusalAuthority::IdentityHandshake),
        "the two legs that actually present the credential keep their verdict: {got:?}"
    );
}

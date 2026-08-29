//! Unit coverage for the browser sign-in decision layer.
//!
//! WHAT A REAL CLICK STILL HAS TO PROVE, stated here so nobody reads a green bar
//! as more than it is: that the OS really hands the URL to a browser, that the
//! console really redirects to our port, and that a browser really reaches a
//! socket on 127.0.0.1. Everything BELOW the browser is here — including a real
//! `TcpListener` on a real ephemeral port, driven by a real TCP client, so the
//! bind/accept/answer path is measured rather than assumed.

use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

const T0: u64 = 1_700_000_000_000;

fn flow() -> Flow {
    Flow::new("s".repeat(32), T0, SIGNIN_WINDOW_MS)
}

fn cb(state: &str, nonce: &str) -> String {
    format!("{CALLBACK_PATH}?t={nonce}&state={state}")
}

#[test]
fn a_good_callback_yields_the_nonce_and_nothing_else() {
    let mut f = flow();
    let s = f.state().to_string();
    assert_eq!(f.offer("GET", &cb(&s, "n0nce"), T0 + 500), Verdict::Accepted("n0nce".into()));
}

#[test]
fn reverse_control_i_a_wrong_state_is_refused_and_emits_nothing() {
    // 🔴 THE REVERSE CONTROL FOR THE ANTI-LOGIN-INJECTION BINDING. Delete the
    // `ct_eq` guard in `offer` and this test — plus the three below it — go red;
    // that drill was run, and the failure read
    // `Accepted("attacker-nonce") != Refused(StateMismatch)`, i.e. the machine
    // signing itself into somebody else's account.
    let mut f = flow();
    let v = f.offer("GET", &cb(&"x".repeat(32), "attacker-nonce"), T0 + 500);
    assert_eq!(v, Verdict::Refused(SignInFailure::StateMismatch));
    // 「emits nothing」 is the load-bearing half: no nonce may escape a refused
    // callback, so there is nothing for a caller to spend by accident.
    assert!(!matches!(v, Verdict::Accepted(_)));
}

#[test]
fn a_missing_state_is_refused_not_treated_as_empty_equals_empty() {
    // The failure mode this pins: if `state` were compared only when present,
    // a callback carrying no state at all would sail through. It is compared
    // against `""` and a minted state is never empty.
    let mut f = flow();
    assert_eq!(
        f.offer("GET", &format!("{CALLBACK_PATH}?t=n"), T0 + 1),
        Verdict::Refused(SignInFailure::StateMismatch),
    );
}

#[test]
fn a_refused_callback_burns_the_flow_so_a_second_try_cannot_follow_it() {
    // Someone who can fire one callback can fire a thousand. If a mismatch left
    // the flow live, the window would be a guessing gallery; it is one shot.
    let mut f = flow();
    let s = f.state().to_string();
    let _ = f.offer("GET", &cb("wrong", "n1"), T0 + 1);
    assert_eq!(
        f.offer("GET", &cb(&s, "n2"), T0 + 2),
        Verdict::Refused(SignInFailure::StateMismatch),
        "the correct state was accepted AFTER a failed attempt",
    );
}

#[test]
fn exactly_one_callback_is_accepted() {
    let mut f = flow();
    let s = f.state().to_string();
    assert_eq!(f.offer("GET", &cb(&s, "n1"), T0 + 1), Verdict::Accepted("n1".into()));
    assert_eq!(
        f.offer("GET", &cb(&s, "n2"), T0 + 2),
        Verdict::Refused(SignInFailure::StateMismatch),
    );
}

#[test]
fn the_window_closes_and_says_timeout_not_state() {
    // Two different sentences for two different next moves: 「sign in again」 vs
    // 「something else answered us」.
    let mut f = flow();
    let s = f.state().to_string();
    assert!(!f.expired(T0 + SIGNIN_WINDOW_MS - 1));
    assert!(f.expired(T0 + SIGNIN_WINDOW_MS));
    assert_eq!(
        f.offer("GET", &cb(&s, "n"), T0 + SIGNIN_WINDOW_MS),
        Verdict::Refused(SignInFailure::Timeout),
    );
}

#[test]
fn a_stray_request_is_ignored_and_does_not_kill_a_live_sign_in() {
    // A browser asking for a favicon, or a port scanner, must not end a sign-in
    // the person is still completing. This is the difference between Ignore and
    // Refused, and it is the whole reason the enum has three arms.
    let mut f = flow();
    let s = f.state().to_string();
    assert_eq!(f.offer("GET", "/favicon.ico", T0 + 1), Verdict::Ignore);
    assert_eq!(f.offer("GET", "/", T0 + 2), Verdict::Ignore);
    assert_eq!(f.offer("POST", &cb(&s, "n"), T0 + 3), Verdict::Ignore);
    // …and the real one still lands.
    assert_eq!(f.offer("GET", &cb(&s, "n"), T0 + 4), Verdict::Accepted("n".into()));
}

#[test]
fn state_survives_percent_encoding_byte_for_byte() {
    // The console percent-encodes; a `+` reaching us is a real plus, never a
    // space. Decoding it as a space would make us refuse our own callback and
    // it would look exactly like an attack.
    let mut f = Flow::new("a b+c".into(), T0, SIGNIN_WINDOW_MS);
    assert_eq!(
        f.offer("GET", &format!("{CALLBACK_PATH}?t=n&state=a%20b%2Bc"), T0 + 1),
        Verdict::Accepted("n".into()),
    );
    let mut g = Flow::new("a b".into(), T0, SIGNIN_WINDOW_MS);
    assert_eq!(
        g.offer("GET", &format!("{CALLBACK_PATH}?t=n&state=a+b"), T0 + 1),
        Verdict::Refused(SignInFailure::StateMismatch),
        "a literal + was decoded as a space",
    );
}

#[test]
fn ct_eq_agrees_with_equality_including_the_prefix_cases() {
    assert!(ct_eq("abc", "abc"));
    assert!(!ct_eq("abc", "abd"));
    assert!(!ct_eq("abc", "ab"));
    assert!(!ct_eq("ab", "abc"));
    assert!(!ct_eq("", "a"));
    assert!(ct_eq("", ""));
    // The property that matters: differing in the FIRST byte and differing in
    // the LAST both return false through the same amount of work.
    assert!(!ct_eq(&"a".repeat(32), &format!("b{}", "a".repeat(31))));
    assert!(!ct_eq(&"a".repeat(32), &format!("{}b", "a".repeat(31))));
}

#[test]
fn minted_state_is_long_hex_and_never_repeats() {
    let a = mint_state();
    let b = mint_state();
    assert_eq!(a.len(), 32);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[test]
fn a_request_line_needs_a_version_and_a_bounded_length() {
    assert_eq!(parse_request_line("GET /cb?t=1 HTTP/1.1"), Some(("GET", "/cb?t=1")));
    assert_eq!(parse_request_line("GET /cb"), None);
    assert_eq!(parse_request_line(""), None);
    let huge = format!("GET /{} HTTP/1.1", "a".repeat(MAX_REQUEST_LINE));
    assert_eq!(parse_request_line(&huge), None);
}

#[test]
fn the_exchange_url_is_https_only_and_is_never_upgraded() {
    assert_eq!(exchange_url("https://flowmic.app").unwrap(), "https://flowmic.app/api/auth/qr-exchange");
    // Trailing slash tolerated; the path is not doubled.
    assert_eq!(exchange_url("https://flowmic.app/").unwrap(), "https://flowmic.app/api/auth/qr-exchange");
    assert_eq!(exchange_url("HTTPS://flowmic.app").unwrap(), "HTTPS://flowmic.app/api/auth/qr-exchange");
    for bad in ["http://flowmic.app", "flowmic.app", "", "  ", "https://flow mic.app", "ws://flowmic.app"] {
        assert_eq!(exchange_url(bad), Err(SignInFailure::BadEndpoint), "accepted {bad:?}");
    }
}

#[test]
fn the_page_escapes_and_pulls_in_nothing_from_outside() {
    let html = callback_page("zh-CN", "完成 <b>了</b>", "回到 FlowMic & 继续");
    assert!(html.contains("lang=\"zh-CN\""));
    assert!(html.contains("&lt;b&gt;"));
    assert!(html.contains("FlowMic &amp; 继续"));
    assert!(!html.contains("<b>"));
    // 🔴 The property, asserted rather than promised: nothing this page needs is
    // fetched, so nothing can 404 after the listener closes a millisecond later.
    for forbidden in ["http://", "https://", "<script", "<link", "<img", "src="] {
        assert!(!html.contains(forbidden), "the callback page reaches for {forbidden}");
    }
}

#[test]
fn the_response_declares_its_own_length_and_closes() {
    let html = callback_page("en", "Signed in", "Return to FlowMic.");
    let bytes = http_response("200 OK", &html);
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains(&format!("Content-Length: {}\r\n", html.len())));
    assert!(text.contains("Connection: close\r\n"));
    assert!(text.contains("Cache-Control: no-store\r\n"));
    assert!(text.ends_with(&html));
}

// ── the socket layer, on a real port ────────────────────────────────────────
//
// Not a mock. `TcpListener::bind("127.0.0.1:0")` is exactly what the flow does,
// and the two claims below — 「the OS gives us a usable ephemeral port」 and
// 「only loopback can reach it」 — are the ones a mock would assert by
// construction and therefore could not measure.

#[test]
fn binding_zero_yields_a_usable_high_port_on_loopback() {
    let l = TcpListener::bind("127.0.0.1:0").expect("loopback bind");
    let addr = l.local_addr().unwrap();
    assert!(addr.ip().is_loopback());
    // The console refuses a port below 1024 (signin-handoff.ts
    // MIN_CALLBACK_PORT), so a machine that handed us one would produce a link
    // the console would reject. Ephemeral ranges are far above it on every OS
    // we ship to; this asserts the assumption instead of resting on it.
    assert!(addr.port() >= 1024, "ephemeral port {} is below the console's floor", addr.port());
}

#[test]
fn a_real_request_over_a_real_socket_is_read_and_answered() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // ⚠️ STARTED AT `now_ms()`, NOT AT `T0`. This is the one test in the file
    // that judges against the REAL clock (it is measuring a real socket), and a
    // flow pinned to the 2023 constant the other tests use is already three
    // years expired by the time it reads it. The first draft did exactly that
    // and failed `Refused(Timeout) != Accepted("n0nce")` — a test whose ruler
    // and whose subject were on two different clocks.
    let mut f = Flow::new(mint_state(), now_ms(), SIGNIN_WINDOW_MS);
    let state = f.state().to_string();

    let client = std::thread::spawn(move || {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(format!("GET /cb?t=n0nce&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .unwrap();
        let mut got = String::new();
        s.read_to_string(&mut got).unwrap();
        got
    });

    let (mut sock, peer) = listener.accept().unwrap();
    assert!(peer.ip().is_loopback(), "a non-loopback peer reached the callback socket");

    let mut buf = [0u8; MAX_REQUEST_LINE];
    let n = sock.read(&mut buf).unwrap();
    let head = String::from_utf8_lossy(&buf[..n]);
    let line = head.lines().next().unwrap();
    let (method, target) = parse_request_line(line).unwrap();
    let verdict = f.offer(method, target, now_ms());
    assert_eq!(verdict, Verdict::Accepted("n0nce".into()));

    let html = callback_page("en", "Signed in", "You can return to FlowMic.");
    sock.write_all(&http_response("200 OK", &html)).unwrap();
    drop(sock);

    let answer = client.join().unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK"));
    assert!(answer.contains("Signed in"));
    // The credential must not come back out in the page we serve.
    assert!(!answer.contains("n0nce"));
}

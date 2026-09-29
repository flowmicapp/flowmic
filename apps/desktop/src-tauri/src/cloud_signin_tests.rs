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

/// D9 (2026-09-02 audit §3-D): a multi-byte UTF-8 character in the first 8
/// bytes of the (trimmed) endpoint used to PANIC this function instead of
/// returning `BadEndpoint` — `e[..8]` is a byte-index slice, and Rust panics
/// when that index is not a char boundary. `endpoint` is whatever the scanned
/// QR code said, i.e. untrusted input reaching a `#[tauri::command]` on the
/// main thread.
///
/// **Reverse control**: swap the two `if` blocks back to the original order
/// (length/prefix check before `is_ascii()`) and this test crashes the test
/// process instead of failing an assertion — `e[..8]` panics before
/// `Err(BadEndpoint)` can even be constructed.
#[test]
fn a_multi_byte_character_in_the_prefix_is_refused_not_a_panic() {
    // "http://" is 7 ASCII bytes; 'é' (U+00E9) is 2 bytes in UTF-8, so it
    // straddles byte index 8 exactly where the old code sliced.
    assert_eq!(exchange_url("http://é.example"), Err(SignInFailure::BadEndpoint));
    assert_eq!(exchange_url("https://é.example"), Err(SignInFailure::BadEndpoint));
    // A multi-byte character earlier still must not panic even though it is
    // nowhere near byte 8 — `is_ascii()` must gate ALL of this function's
    // slicing, not just this one boundary.
    assert_eq!(exchange_url("é"), Err(SignInFailure::BadEndpoint));
}

// ── what the callback page may contain (NR-110, 2026-09-26) ─────────────────
//
// 🔴 THE RULE, AND WHY IT IS NARROWER THAN IT USED TO BE. This test used to ban
// `http://`, `https://` and `<script` outright. Its stated reason was always
// 「nothing this page needs is FETCHED, so nothing can 404 after the listener
// closes a millisecond later」 — and a link the person may choose to follow is
// not a fetch, and neither is an inline script. The owner asked for two actions
// on the success page (「close this page」, 「go to the console」), so the ban now
// says exactly what the reason needs:
//   · still forbidden anywhere: every way of loading something — `src=`,
//     `<link`, `<img`, `<iframe`, `<object`, `<embed`, an external
//     `<script src`, `fetch(`, `XMLHttpRequest`, `import(`, CSS `url(` and
//     `@import`, and any `http://` at all;
//   · allowed: exactly ONE `https://`, and only as the console anchor built from
//     the origin handed in at sign-in start (https only — otherwise no link);
//   · allowed: exactly ONE inline script, and only `CLOSE_SCRIPT` verbatim.
// Failure pages carry neither.

const ALWAYS_FORBIDDEN: [&str; 14] = [
    "src=", "<link", "<img", "<iframe", "<object", "<embed", "<script src", "fetch(",
    "XMLHttpRequest", "import(", "url(", "@import", "http://", "<form",
];

fn assert_nothing_fetched(html: &str, console_link: Option<&str>, has_script: bool) {
    for forbidden in ALWAYS_FORBIDDEN {
        assert!(!html.contains(forbidden), "the callback page reaches for {forbidden}");
    }
    let https = html.matches("https://").count();
    let anchors = html.matches("<a ").count();
    match console_link {
        Some(url) => {
            assert_eq!(https, 1, "exactly one https:// — the console link");
            assert_eq!(anchors, 1, "exactly one anchor");
            assert!(html.contains(&format!("<a href=\"{url}\"")), "the one anchor is the console link");
        }
        None => {
            assert_eq!(https, 0, "no https:// when no console link may be drawn");
            assert_eq!(anchors, 0, "no anchor when no console link may be drawn");
        }
    }
    let scripts = html.matches("<script").count();
    if has_script {
        assert_eq!(scripts, 1, "exactly one script");
        assert!(html.contains(&format!("<script>{CLOSE_SCRIPT}</script>")), "the one script is CLOSE_SCRIPT verbatim");
    } else {
        assert_eq!(scripts, 0, "a failure page carries no script");
    }
}

fn actions(origin: &str) -> PageActions<'_> {
    PageActions {
        close_label: "Close <this>",
        console_label: "Console & more",
        closed_fallback: "You can close this page now",
        console_origin: origin,
    }
}

#[test]
fn the_failure_page_escapes_and_pulls_in_nothing_from_outside() {
    let html = callback_page("zh-CN", "完成 <b>了</b>", "回到 FlowMic & 继续", None);
    assert!(html.contains("lang=\"zh-CN\""));
    assert!(html.contains("&lt;b&gt;"));
    assert!(html.contains("FlowMic &amp; 继续"));
    assert!(!html.contains("<b>"));
    assert_nothing_fetched(&html, None, false);
}

#[test]
fn the_success_page_has_one_console_link_and_one_close_script_and_nothing_else() {
    let a = actions("https://flowmic.app");
    let html = callback_page("en", "Signed in", "Return to FlowMic.", Some(&a));
    assert_nothing_fetched(&html, Some("https://flowmic.app/console"), true);
    // The labels are escaped like every other sentence on the page.
    assert!(html.contains("Close &lt;this&gt;"));
    assert!(html.contains("Console &amp; more"));
    // The fallback line starts hidden; only the script reveals it.
    assert!(html.contains("<p id=\"fm-closed\" hidden"));
    assert!(html.contains("<button id=\"fm-close\" type=\"button\""));
}

#[test]
fn a_console_origin_that_is_not_a_bare_https_origin_draws_no_link() {
    for bad in [
        "", "http://flowmic.app", "flowmic.app", "https://", "https://flowmic.app/console",
        "https://user@flowmic.app", "https://flowmic.app\" onclick=\"x", "https://flow mic.app",
        "https://é.example", "javascript:alert(1)", "https://flowmic.app?x=1",
    ] {
        let a = actions(bad);
        let html = callback_page("en", "Signed in", "Return to FlowMic.", Some(&a));
        // The close action does not depend on the link and stays.
        assert_nothing_fetched(&html, None, true);
        assert_eq!(console_home_url(bad), None, "{bad:?} must not become a link");
    }
    // …and the accepted shapes, so the refusal above is not a function that
    // refuses everything.
    assert_eq!(console_home_url("https://flowmic.app/").as_deref(), Some("https://flowmic.app/console"));
    assert_eq!(console_home_url("HTTPS://flowmic.app").as_deref(), Some("https://flowmic.app/console"));
    assert_eq!(console_home_url("https://127.0.0.1:8443").as_deref(), Some("https://127.0.0.1:8443/console"));
}

#[test]
fn the_close_script_only_closes_and_reveals() {
    for forbidden in ["fetch", "XMLHttpRequest", "http", "location", "src", "import", "eval", "cookie", "localStorage"] {
        assert!(!CLOSE_SCRIPT.contains(forbidden), "CLOSE_SCRIPT reaches for {forbidden}");
    }
    assert!(CLOSE_SCRIPT.contains("window.close()"));
    assert!(CLOSE_SCRIPT.contains("document.getElementById('fm-closed').hidden=false"));
}

#[test]
fn base64_matches_rfc4648_vectors() {
    for (input, want) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
        assert_eq!(base64_std(input.as_bytes()), want);
    }
}

#[test]
fn the_csp_allows_exactly_the_close_script_by_hash_and_nothing_broader() {
    use sha2::{Digest, Sha256};
    let hash = format!("'sha256-{}'", base64_std(&Sha256::digest(CLOSE_SCRIPT.as_bytes())));

    let a = actions("https://flowmic.app");
    let ok = String::from_utf8(http_response("200 OK", &callback_page("en", "t", "b", Some(&a)))).unwrap();
    let csp = ok.lines().find(|l| l.starts_with("Content-Security-Policy: ")).expect("CSP header");
    assert!(csp.contains("default-src 'none'"));
    assert!(csp.contains(&format!("script-src {hash}")));
    assert_eq!(csp.matches("script-src").count(), 1);
    assert!(!csp.contains("'unsafe-inline'; script") && !csp.split("script-src").nth(1).unwrap().contains("unsafe"));
    assert!(!csp.contains("nonce-"));

    let fail = String::from_utf8(http_response("404 Not Found", &callback_page("en", "t", "b", None))).unwrap();
    let csp = fail.lines().find(|l| l.starts_with("Content-Security-Policy: ")).expect("CSP header");
    assert!(csp.contains("default-src 'none'"));
    assert!(!csp.contains("script-src"), "a page without the script allows no script");
}

#[test]
fn the_response_declares_its_own_length_and_closes() {
    let html = callback_page("en", "Signed in", "Return to FlowMic.", None);
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

    let html = callback_page("en", "Signed in", "You can return to FlowMic.", None);
    sock.write_all(&http_response("200 OK", &html)).unwrap();
    drop(sock);

    let answer = client.join().unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK"));
    assert!(answer.contains("Signed in"));
    // The credential must not come back out in the page we serve.
    assert!(!answer.contains("n0nce"));
}

// ── NR-112: the wait, on a real socket ──────────────────────────────────────
//
// The window went from 180 s to 15 min because the console now asks a new
// account to confirm its email before it hands the sign-in over (NR-111). A
// longer offer is only safe if ending it early and ending it late both really
// end it. These three drive `await_callback` — the loop the product runs — on a
// real ephemeral port, with a real client, and check the one thing that
// matters: no nonce comes out after the person cancelled or the window closed.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn pages() -> CallbackPages {
    CallbackPages {
        ok: callback_page("en", "OK-PAGE", "ok", None),
        fail: callback_page("en", "FAIL-PAGE", "fail", None),
    }
}

/// Run the product loop on its own thread, as the shell does.
fn spawn_wait(window_ms: u64) -> (u16, String, Arc<AtomicBool>, std::thread::JoinHandle<WaitEnd>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut f = Flow::new(mint_state(), now_ms(), window_ms);
    let state = f.state().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let c = Arc::clone(&cancel);
    let h = std::thread::spawn(move || {
        await_callback(listener, &mut f, &c, &pages(), Duration::from_millis(10), Duration::from_secs(3))
    });
    (port, state, cancel, h)
}

/// Whatever the client got back, or `None` if nobody was listening.
fn send_callback(port: u16, state: &str, delay_before_request: Duration) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    std::thread::sleep(delay_before_request);
    let _ = s.write_all(format!("GET /cb?t=n0nce&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes());
    let mut got = String::new();
    let _ = s.read_to_string(&mut got);
    Some(got)
}

#[test]
fn nr112_the_window_is_fifteen_minutes() {
    // Mirrored by the web console (`DESKTOP_SIGNIN_WINDOW_MS` in
    // src/lib/desktop-handoff-ledger.ts), whose test reads the constant's
    // declaration line in cloud_signin.rs.
    assert_eq!(SIGNIN_WINDOW_MS, 15 * 60 * 1000);
}

#[test]
fn nr112_a_callback_whose_request_line_arrives_late_still_lands() {
    // A browser that connects and sends a beat later is still our callback. On
    // Windows the accepted socket inherits the listener's non-blocking mode;
    // read without switching it back and this one is dropped as 「said nothing」,
    // and the wait runs out instead.
    let (port, state, _cancel, h) = spawn_wait(2_000);
    let client = std::thread::spawn(move || send_callback(port, &state, Duration::from_millis(250)));
    assert_eq!(h.join().unwrap(), WaitEnd::Accepted("n0nce".into()));
    let got = client.join().unwrap().expect("nobody was listening");
    assert!(got.starts_with("HTTP/1.1 200 OK"), "got: {got:.60}");
}

#[test]
fn nr112_cancel_refuses_a_late_callback_and_closes_the_port() {
    // 🔴 THE RACE: the connection is accepted BEFORE the person presses Cancel,
    // and its request line arrives AFTER. The loop's top-of-iteration check has
    // already passed, so only the re-check after the read stands between this
    // callback and a PC that signs itself in after being told to stop.
    let (port, state, cancel, h) = spawn_wait(60_000);
    let st = state.clone();
    let client = std::thread::spawn(move || send_callback(port, &st, Duration::from_millis(400)));
    std::thread::sleep(Duration::from_millis(150)); // accepted, request not yet sent
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    let end = h.join().unwrap();
    assert_eq!(end, WaitEnd::Cancelled, "a callback after cancel came out as {end:?}");
    let got = client.join().unwrap().unwrap_or_default();
    assert!(!got.contains("OK-PAGE"), "the browser was told it signed in after cancel");
    // …and after the wait ends, nothing is listening at all.
    assert_eq!(send_callback(port, &state, Duration::ZERO), None, "the port stayed open after cancel");
}

#[test]
fn nr112_a_callback_after_the_window_is_refused_and_signs_nobody_in() {
    // The flow's clock starts inside `spawn_wait` (`Flow::new(.., now_ms(), ..)`),
    // so `started` must be taken BEFORE it, or the test's window starts later
    // than the flow's and a correct 300 ms timeout measures as 29x ms (seen red
    // on macOS, 2026-09-27). `now_ms()` is whole wall-clock milliseconds, so
    // the flow can close up to 1 ms before 300 ms of real time: hence 299.
    let started = Instant::now();
    let (port, state, _cancel, h) = spawn_wait(300);
    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        send_callback(port, &state, Duration::ZERO)
    });
    let end = h.join().unwrap();
    assert_eq!(end, WaitEnd::Failed(SignInFailure::Timeout), "a late callback came out as {end:?}");
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(299), "the window closed early: {waited:?}");
    let got = client.join().unwrap().unwrap_or_default();
    assert!(!got.contains("OK-PAGE"), "the browser was told it signed in after the window");
}

//! The Tauri half of browser sign-in: bind a one-shot loopback listener, wait
//! for the console's callback, spend the nonce, store the token.
//!
//! Every DECISION this flow makes lives in `crate::cloud_signin` (tauri-free,
//! unit-tested in the lean `cargo test --lib` pass). What is here is the parts
//! that need a real socket, a real HTTP client and a real `AppHandle`: the
//! accept loop, the exchange, and the phase a poll reads.
//!
//! ⚠️ WHAT ONLY A REAL CLICK CAN PROVE, said here rather than left implied:
//! that the OS hands our URL to a browser, that the console redirects to the
//! port we named, and that the browser reaches our socket. Everything on this
//! side of the browser is covered; that arc is not, and no test in this repo
//! can cover it.
//!
//! 🔴 NO ASYNC, ON PURPOSE. This crate has no caller-side tokio runtime
//! (Cargo.toml says so, and `reqwest::blocking` panics inside one), and every
//! other command here is a sync `fn` that moves long work onto a
//! `std::thread`. This follows that, rather than introducing a second
//! concurrency model for one feature.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::cloud_signin::{
    callback_page, exchange_url, http_response, mint_state, now_ms, parse_request_line, Flow,
    SignInFailure, Verdict, MAX_REQUEST_LINE, SIGNIN_WINDOW_MS,
};
use crate::forensic;

use super::cloud::{store_verified_key, CloudStatusDto};

/// How long the exchange may take. Longer than the account card's 6 s because a
/// failure here costs the whole sign-in and the person is watching a spinner
/// they cannot help; short enough that 「it is stuck」 is never the answer.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(12);

/// How long one connection has to send its request line. A browser sends it
/// immediately; anything that connects and says nothing is not our callback and
/// must not be able to hold the loop.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the accept loop wakes to re-check the deadline and the cancel flag.
/// A blocking `accept()` cannot be interrupted, which is the whole reason this
/// listener is non-blocking: without it, 「cancel」 would mean 「cancel, in up to
/// three minutes」.
const POLL_INTERVAL: Duration = Duration::from_millis(60);

/// The localized page the browser lands on. Handed in from the frontend rather
/// than looked up here, so this flow adds NO second locale pipeline: the desktop
/// catalogue (nine languages) stays the one place these sentences exist.
#[derive(serde::Deserialize, Clone)]
pub struct PageCopy {
    pub lang: String,
    pub ok_title: String,
    pub ok_body: String,
    pub fail_title: String,
    pub fail_body: String,
}

/// What the frontend needs to build the console URL. The URL itself is built
/// THERE — `socket/channel.rs` forbids an endpoint literal in this crate, and
/// the console origin is a `@flowmic/protocol` constant.
#[derive(serde::Serialize)]
pub struct BeginDto {
    pub port: u16,
    pub state: String,
    pub window_ms: u64,
}

/// Where a sign-in attempt is. One field answers one question — `phase` says
/// what is happening, and the payload that belongs to a phase is only present in
/// that phase.
#[derive(serde::Serialize, Clone)]
pub struct PollDto {
    /// `idle` | `waiting` | `exchanging` | `done` | `failed`
    pub phase: &'static str,
    /// Present only in `done`: exactly what `cloud_save_key` returns, so the
    /// Vue side feeds it into the same `applyCloud` it already has.
    pub cloud: Option<CloudStatusDto>,
    /// Present only in `failed`: a `SignInFailure::code()` token the frontend
    /// maps to a localized sentence through an exhaustive record.
    pub reason: Option<String>,
}

#[derive(Clone)]
enum Phase {
    Idle,
    Waiting,
    Exchanging,
    Done(CloudStatusDto),
    Failed(&'static str),
}

struct Inner {
    phase: Phase,
    /// Bumped by every `begin`. A worker whose generation is stale writes
    /// nothing — otherwise a first attempt timing out at 180 s would overwrite
    /// the phase of a second attempt the person started at 170 s, and the UI
    /// would show a failure for a sign-in that was still running.
    generation: u64,
    cancel: Arc<AtomicBool>,
}

pub struct SignInState {
    inner: Mutex<Inner>,
}

impl Default for SignInState {
    fn default() -> Self {
        Self::new()
    }
}

impl SignInState {
    pub fn new() -> Self {
        SignInState {
            inner: Mutex::new(Inner {
                phase: Phase::Idle,
                generation: 0,
                cancel: Arc::new(AtomicBool::new(false)),
            }),
        }
    }
}

/// Write a phase, but only if this worker still owns the flow.
fn settle(app: &AppHandle, generation: u64, phase: Phase) {
    let state: State<SignInState> = app.state();
    let mut inner = match state.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if inner.generation != generation {
        return;
    }
    inner.phase = phase;
}

/// Start a browser sign-in: bind loopback, mint a state, and hand the frontend
/// what it needs to open the console.
///
/// 🔴 THE BIND HAPPENS BEFORE THE BROWSER IS OPENED, and the order is the point.
/// If we opened the browser first and the bind then failed, the person would be
/// looking at a sign-in page whose callback had nowhere to land — a failure they
/// could only discover by waiting. Binding first means 「this machine will not
/// give us a local port」 is answered on the PC, in a sentence, before anything
/// else happens.
#[tauri::command]
pub fn cloud_browser_signin_begin(
    app: AppHandle,
    endpoint: String,
    page: PageCopy,
) -> Result<BeginDto, String> {
    // Checked FIRST, so a misconfigured endpoint is named now rather than after
    // the person has signed in and the exchange has nowhere to go.
    let url = exchange_url(&endpoint).map_err(|f| f.code().to_string())?;

    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            forensic::record("cloud", &format!("browser sign-in: loopback bind refused ({e})"));
            return Err(SignInFailure::Listen.code().to_string());
        }
    };
    if listener.set_nonblocking(true).is_err() {
        return Err(SignInFailure::Listen.code().to_string());
    }
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return Err(SignInFailure::Listen.code().to_string()),
    };

    let state_token = mint_state();
    let cancel = Arc::new(AtomicBool::new(false));
    let generation;
    {
        let st: State<SignInState> = app.state();
        let mut inner = match st.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Any attempt still running is told to stop. Two live listeners would
        // mean two ports and one `state` the console could be sent to either of.
        inner.cancel.store(true, Ordering::SeqCst);
        inner.generation += 1;
        generation = inner.generation;
        inner.cancel = Arc::clone(&cancel);
        inner.phase = Phase::Waiting;
    }

    // The port is loggable; the state is NOT. It is the binding secret, and a
    // log line carrying it is the same leak as a log line carrying a nonce.
    forensic::record("cloud", &format!("browser sign-in: listening on 127.0.0.1:{port}"));

    let flow = Flow::new(state_token.clone(), now_ms(), SIGNIN_WINDOW_MS);
    let handle = app.clone();
    std::thread::spawn(move || {
        run(handle, generation, listener, flow, cancel, page, url);
    });

    Ok(BeginDto { port, state: state_token, window_ms: SIGNIN_WINDOW_MS })
}

/// Where the current attempt is. Polled by the Vue side rather than pushed as an
/// event: a poll cannot be missed by a window that was not listening yet, and
/// this flow has exactly one reader.
#[tauri::command]
pub fn cloud_browser_signin_poll(state: State<'_, SignInState>) -> PollDto {
    let inner = match state.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    match &inner.phase {
        Phase::Idle => PollDto { phase: "idle", cloud: None, reason: None },
        Phase::Waiting => PollDto { phase: "waiting", cloud: None, reason: None },
        Phase::Exchanging => PollDto { phase: "exchanging", cloud: None, reason: None },
        Phase::Done(dto) => PollDto { phase: "done", cloud: Some(dto.clone()), reason: None },
        Phase::Failed(code) => {
            PollDto { phase: "failed", cloud: None, reason: Some((*code).to_string()) }
        }
    }
}

/// Give up on the current attempt (the person pressed cancel, or left the page).
///
/// Returns to `Idle` rather than to a failure: nothing went wrong, and a red
/// sentence for a deliberate cancellation is noise. The listener closes within
/// one `POLL_INTERVAL`.
#[tauri::command]
pub fn cloud_browser_signin_cancel(state: State<'_, SignInState>) {
    let mut inner = match state.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    inner.cancel.store(true, Ordering::SeqCst);
    inner.generation += 1;
    inner.phase = Phase::Idle;
}

/// The accept loop. Runs on its own thread and owns the listener, so the
/// listener is dropped — and the port released — the moment this returns, by any
/// route.
fn run(
    app: AppHandle,
    generation: u64,
    listener: TcpListener,
    mut flow: Flow,
    cancel: Arc<AtomicBool>,
    page: PageCopy,
    exchange: String,
) {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return; // `cancel` already wrote the phase; do not overwrite it.
        }
        if flow.expired(now_ms()) {
            forensic::record("cloud", "browser sign-in: window closed with no callback");
            return settle(&app, generation, Phase::Failed(SignInFailure::Timeout.code()));
        }
        let (mut sock, peer) = match listener.accept() {
            Ok(pair) => pair,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }
            Err(e) => {
                forensic::record("cloud", &format!("browser sign-in: accept failed ({e})"));
                return settle(&app, generation, Phase::Failed(SignInFailure::Listen.code()));
            }
        };
        // 🔴 RE-CHECKED PER CONNECTION even though the bind is loopback-only. The
        // bind is a claim made once at start-up; this is the fact about THIS
        // peer. It costs one comparison and it is the last line of the property
        // the whole design rests on.
        if !peer.ip().is_loopback() {
            forensic::record("cloud", "browser sign-in: dropped a non-loopback peer");
            continue;
        }
        let _ = sock.set_read_timeout(Some(READ_TIMEOUT));

        let mut buf = [0u8; MAX_REQUEST_LINE];
        let n = match sock.read(&mut buf) {
            Ok(n) if n > 0 => n,
            // Connected and said nothing, or said nothing readable. Not our
            // callback; do not let it end a sign-in still in progress.
            _ => continue,
        };
        let head = String::from_utf8_lossy(&buf[..n]);
        let line = head.lines().next().unwrap_or("");
        let verdict = match parse_request_line(line) {
            Some((method, target)) => flow.offer(method, target, now_ms()),
            None => Verdict::Ignore,
        };

        match verdict {
            Verdict::Ignore => {
                let html = callback_page(&page.lang, &page.fail_title, &page.fail_body);
                let _ = sock.write_all(&http_response("404 Not Found", &html));
                continue;
            }
            Verdict::Refused(f) => {
                forensic::record("cloud", &format!("browser sign-in: callback refused ({})", f.code()));
                let html = callback_page(&page.lang, &page.fail_title, &page.fail_body);
                let _ = sock.write_all(&http_response("400 Bad Request", &html));
                return settle(&app, generation, Phase::Failed(f.code()));
            }
            Verdict::Accepted(nonce) => {
                // 🔴 ANSWER THE BROWSER FIRST, THEN EXCHANGE. The person is
                // looking at a loading tab; making them watch it spin through a
                // 12-second server round trip — and see a browser error if that
                // trip is slow — would put OUR latency on THEIR screen, in a page
                // we do not control. The page is written, the socket is dropped,
                // and only then does the credential get spent.
                let html = callback_page(&page.lang, &page.ok_title, &page.ok_body);
                let _ = sock.write_all(&http_response("200 OK", &html));
                let _ = sock.flush();
                drop(sock);
                drop(listener); // one shot: the port goes back immediately
                settle(&app, generation, Phase::Exchanging);
                let phase = match exchange_nonce(&exchange, &nonce) {
                    Ok(token) => {
                        let dto = store_verified_key(&app, &token, endpoint_of(&exchange));
                        forensic::record("cloud", "browser sign-in: completed, Cloud Key stored");
                        Phase::Done(dto)
                    }
                    Err(f) => {
                        forensic::record(
                            "cloud",
                            &format!("browser sign-in: exchange failed ({})", f.code()),
                        );
                        Phase::Failed(f.code())
                    }
                };
                return settle(&app, generation, phase);
            }
        }
    }
}

/// The origin we exchanged against, which is the origin the stored key belongs
/// to. Derived from the URL we actually called rather than from the argument we
/// were handed, so the endpoint recorded next to a key can never be one we did
/// not talk to.
fn endpoint_of(exchange_url: &str) -> &str {
    exchange_url.strip_suffix("/api/auth/qr-exchange").unwrap_or(exchange_url)
}

/// Spend the nonce. Returns the session token, or a NAMED failure.
///
/// 🔴 THREE OUTCOMES, NOT TWO. 「we could not reach the server」 and 「the server
/// refused」 send a person to two different places — the network, or signing in
/// again — and collapsing them into one sentence is how somebody spends ten
/// minutes checking their wifi over an expired grant.
fn exchange_nonce(url: &str, nonce: &str) -> Result<String, SignInFailure> {
    let client = reqwest::blocking::Client::builder()
        .timeout(EXCHANGE_TIMEOUT)
        .build()
        .map_err(|_| SignInFailure::Unreachable)?;
    let resp = client
        .post(url)
        .json(&serde_json::json!({ "nonce": nonce }))
        .send()
        .map_err(|_| SignInFailure::Unreachable)?;
    if !resp.status().is_success() {
        // The server's own refusal name (GRANT_INVALID) is deliberately NOT
        // surfaced further: it answers 「unknown, expired or already used」 as one
        // outcome by design, and the sentence for all three on this side is the
        // same one — start again.
        return Err(SignInFailure::Refused);
    }
    let body: serde_json::Value = resp.json().map_err(|_| SignInFailure::Refused)?;
    match body.get("token").and_then(|v| v.as_str()) {
        Some(t) if !t.is_empty() => Ok(t.to_string()),
        _ => Err(SignInFailure::Refused),
    }
}

//! Browser sign-in with an automatic loopback callback — the PART THAT HAS NO
//! TAURI IN IT, so `cargo test --lib` (the lean pass, no WebView2 toolchain)
//! exercises every decision this flow makes.
//!
//! SPEC-REF:
//!   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md
//!     — and specifically ITS CORRECTION BLOCK. The body of that ruling says the
//!       PC does 「不做回环端口自动回传」 (no loopback auto-callback); the owner
//!       overturned that at UAT the same day: 「浏览器里 Gmail 都登录成功了，
//!       为什么还要我去复制 Key」. The Cloud Key paste stays as the fallback.
//!   the web console repo, src/lib/signin-handoff.ts — the console half.
//!   apps/server-core/src/http/auth-routes.ts — POST /api/auth/qr-exchange.
//!
//! THE SHAPE, so the pieces below have something to belong to:
//!   PC binds 127.0.0.1:0 (the OS picks a free port) and mints a `state`
//!     → opens the system browser at
//!       `https://<console>/signin?flow=desktop&port=<port>&state=<state>`
//!     → person signs in there (password or Google — the console does not care)
//!     → console mints a 60-second single-use grant and redirects the browser to
//!       `http://127.0.0.1:<port>/cb?t=<nonce>&state=<state>`
//!     → THIS listener accepts exactly one such request, checks `state`, answers
//!       with a small page, closes, and spends the nonce at
//!       `POST /api/auth/qr-exchange` for a real token.
//!
//! ── the four properties that make that safe, and where each one lives ────────
//!
//! 🔴 ① LOOPBACK ONLY, AND `127.0.0.1` RATHER THAN `0.0.0.0`. A listener on any
//! other interface would let anything on the network hand us a `state` and a
//! nonce. The bind address is not configurable and there is no code path that
//! widens it; `peer_is_loopback` re-checks each accepted connection rather than
//! trusting the bind, because a bind is a claim made once and a peer address is
//! the fact for this connection.
//!
//! 🔴 ② `state` IS THE ANTI-LOGIN-INJECTION BINDING. Without it, anyone who can
//! make this machine's browser fetch a URL could deliver a nonce for THEIR
//! account to our listener, and the PC would silently end up signed into an
//! account it never chose — a login CSRF, and the reason the whole parameter
//! exists. It is compared in constant time, consumed exactly once, and only
//! within the window. A mismatch ABORTS the flow with a named failure rather
//! than being ignored: a callback we did not ask for is an event worth telling
//! the person about.
//!
//! 🔴 ③ SINGLE USE IS ENFORCED ON BOTH SIDES, and neither is redundant. The
//! grant store on the server deletes before it validates (auth/qr-grant.ts), and
//! this flow refuses a second callback locally. The server's copy is the one
//! that matters against a replay from elsewhere; this one is what stops a
//! browser that retries a request (or a person pressing the fallback link twice)
//! from starting a second exchange whose refusal would look like a bug.
//!
//! 🔴 ④ THE WINDOW IS OURS AND IS NOT THE GRANT'S. 180 s here bounds 「how long
//! we wait for a person to finish signing in」. The 60 s in `qr-grant.ts` bounds
//! 「how long a minted grant stays redeemable」, and the console mints it AFTER
//! the sign-in completes, one redirect before it is spent. Widening either one
//! because the other exists would be conflating two different intervals — the
//! server-side comment says the same thing from its end.
//!
//! ⚠️ WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never holds the endpoint
//! literal. `socket/channel.rs` forbids an endpoint literal in this crate and
//! `@flowmic/protocol` is the SSOT, so the console origin and the API endpoint
//! both arrive from the frontend on the `begin` call.

use std::time::{SystemTime, UNIX_EPOCH};

/// The path the console redirects to. ONE literal, mirrored in
/// the web console repo's `src/lib/signin-handoff.ts` (`DESKTOP_CALLBACK_PATH`) and
/// pinned there by a test — two ends of a callback that spell the path
/// differently produce a 404 that neither side can see.
pub const CALLBACK_PATH: &str = "/cb";

/// How long we wait for the person to finish in the browser. See ④ above for
/// why this is not the grant's TTL.
pub const SIGNIN_WINDOW_MS: u64 = 180_000;

/// A request line longer than this is not one of ours. The whole legitimate
/// request is `GET /cb?t=<32 hex>&state=<32 hex> HTTP/1.1` — about 80 bytes.
/// The cap exists so a connection cannot make us read without bound.
pub const MAX_REQUEST_LINE: usize = 2048;

/// Why a browser sign-in did not finish. Every one of these becomes a SENTENCE
/// on the PC (the desktop string catalogue, nine languages) — never a bare
/// identifier, which is the defect 0.2.53 shipped and this repo keeps citing.
///
/// 🔴 THEY ARE SEPARATE BECAUSE THE PERSON'S NEXT MOVE IS SEPARATE, which is
/// this repo's whole test for whether a name deserves to exist:
///   · `Timeout`          → sign in again, nothing is wrong;
///   · `StateMismatch`    → something else answered our callback; start again,
///                          and this one is worth being told about;
///   · `Refused`          → the console's grant was already spent or too old;
///   · `Unreachable`      → the network, not the account — retrying may work;
///   · `Listen`           → this machine would not give us a local port at all,
///                          and the answer is the Cloud Key paste below it;
///   · `BadEndpoint`      → a misconfigured endpoint box, which the person can
///                          see and fix on the same screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInFailure {
    Timeout,
    StateMismatch,
    Refused,
    Unreachable,
    Listen,
    BadEndpoint,
}

impl SignInFailure {
    /// The stable token the frontend maps to a localized sentence.
    ///
    /// ⚠️ NOT AN ERROR CODE. Minting a protocol `ErrorCode` is owner-gated and
    /// nothing here crosses a socket — these never leave this process. The Vue
    /// side maps them through an EXHAUSTIVE record, so adding a variant here
    /// without a sentence fails `vue-tsc` rather than reaching a user as a bare
    /// word.
    pub fn code(self) -> &'static str {
        match self {
            SignInFailure::Timeout => "TIMEOUT",
            SignInFailure::StateMismatch => "STATE_MISMATCH",
            SignInFailure::Refused => "REFUSED",
            SignInFailure::Unreachable => "UNREACHABLE",
            SignInFailure::Listen => "LISTEN",
            SignInFailure::BadEndpoint => "BAD_ENDPOINT",
        }
    }
}

/// What to do with one accepted HTTP request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// A good callback. The flow is over; spend this nonce.
    Accepted(String),
    /// Not our path (a favicon probe, a stray scan). Answer 404 and KEEP
    /// LISTENING — treating it as a failure would let one stray request kill a
    /// sign-in the person is still completing.
    Ignore,
    /// Our path, and wrong. Answer, then STOP: see ② for why a mismatch is not
    /// something to sit quietly through.
    Refused(SignInFailure),
}

/// Now, in milliseconds. One definition so the flow and its caller cannot
/// disagree about what time it is.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A `state` with 122 bits of OS CSPRNG entropy, hex, no separators.
///
/// ⚠️ `uuid` v4 RATHER THAN A NEW `rand` DEPENDENCY, and that is a measured
/// choice not a lazy one: `uuid` is already a direct dependency of this crate
/// and draws from `getrandom`, i.e. the operating system's CSPRNG — the same
/// source `rand::rngs::OsRng` would use. Adding a crate to type a different
/// call would have changed `Cargo.lock` for no property gained, and this crate's
/// manifest says not to.
pub fn mint_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Byte comparison that does not stop early.
///
/// 🔴 The length is allowed to leak and that is fine — `state` is a
/// fixed-length value we chose. What must not leak is WHERE two equal-length
/// values first differ, because that turns a 122-bit secret into 32 four-bit
/// guesses. `|=` over the whole buffer, and the result read once.
///
/// ⚠️ Written out rather than pulled from a crate on purpose: the two-line
/// version is auditable here, and the alternative was a new dependency for one
/// loop (see `mint_state`'s note).
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Percent-decode one query value. Not a general URI decoder — it handles `%XX`
/// and nothing else.
///
/// 🔴 `+` IS LEFT ALONE, DELIBERATELY, and this is the half that is easy to get
/// wrong. The console builds the callback with `encodeURIComponent`, which
/// writes a space as `%20` and a literal plus as `%2B`; a `+` that survives to
/// here is therefore a real plus character. Decoding `+` to a space — the
/// `application/x-www-form-urlencoded` rule — would CHANGE a `state` containing
/// one, we would refuse our own callback, and it would look exactly like the
/// attack ② exists to stop. The console-side comment states the same rule from
/// the other end.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Lossy on purpose: a value that is not UTF-8 cannot equal a `state` we
    // minted (hex) and cannot be a nonce (hex), so it will be refused a moment
    // later. Failing here instead would answer a different question.
    String::from_utf8_lossy(&out).into_owned()
}

/// Split `GET /cb?a=b HTTP/1.1` into method and target. `None` for anything
/// that is not a well-formed request line.
pub fn parse_request_line(line: &str) -> Option<(&str, &str)> {
    if line.len() > MAX_REQUEST_LINE {
        return None;
    }
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    // The version field must be PRESENT (a two-token line is HTTP/0.9, which no
    // browser sends and which we have no reason to accept) but its value is not
    // ours to police.
    parts.next()?;
    if method.is_empty() || target.is_empty() {
        return None;
    }
    Some((method, target))
}

/// Pull one query parameter out of a request target.
fn query_param(target: &str, key: &str) -> Option<String> {
    let q = target.split_once('?')?.1;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

/// The path half of a request target, query stripped.
fn target_path(target: &str) -> &str {
    match target.split_once('?') {
        Some((p, _)) => p,
        None => target,
    }
}

/// One browser sign-in attempt: the state it is waiting for, when it started,
/// and whether it has already been answered.
///
/// Owning `used` HERE rather than in the listener loop is the point — it makes
/// 「exactly one callback」 a property of the flow that a test can drive, instead
/// of a `break` in a loop that only a real browser could reach.
#[derive(Debug)]
pub struct Flow {
    state: String,
    started_ms: u64,
    window_ms: u64,
    used: bool,
}

impl Flow {
    pub fn new(state: String, started_ms: u64, window_ms: u64) -> Self {
        Flow { state, started_ms, window_ms, used: false }
    }

    pub fn state(&self) -> &str {
        &self.state
    }

    /// Whether the window has closed. Checked by the accept loop so a flow
    /// nobody ever answers still ends, and still ends with a SENTENCE.
    pub fn expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.started_ms) >= self.window_ms
    }

    /// Judge one request.
    ///
    /// ORDER MATTERS AND IS ARGUED, because judging in a different order would
    /// answer different questions:
    ///   1. path — anything else is not addressed to us at all;
    ///   2. method — a POST to our callback is not a callback;
    ///   3. freshness — a callback that arrives after the window is not
    ///      distinguishable to us from a late replay, and both should stop here;
    ///   4. single use;
    ///   5. state, in constant time;
    ///   6. only THEN is the nonce read out.
    ///
    /// The nonce is extracted LAST so that a request which fails any check above
    /// never has its credential parsed, logged, or held.
    pub fn offer(&mut self, method: &str, target: &str, now_ms: u64) -> Verdict {
        if target_path(target) != CALLBACK_PATH {
            return Verdict::Ignore;
        }
        if !method.eq_ignore_ascii_case("GET") {
            return Verdict::Ignore;
        }
        if self.expired(now_ms) {
            return Verdict::Refused(SignInFailure::Timeout);
        }
        if self.used {
            // A second callback for a flow already answered. Reported as a state
            // problem rather than as a timeout: nothing about it is late.
            return Verdict::Refused(SignInFailure::StateMismatch);
        }
        let offered = query_param(target, "state").unwrap_or_default();
        if !ct_eq(&offered, &self.state) {
            self.used = true;
            return Verdict::Refused(SignInFailure::StateMismatch);
        }
        self.used = true;
        match query_param(target, "t") {
            Some(nonce) if !nonce.is_empty() => Verdict::Accepted(nonce),
            // Our state, no credential. Not a valid callback and not something a
            // correct console can produce, so it reads as the same problem.
            _ => Verdict::Refused(SignInFailure::StateMismatch),
        }
    }
}

/// Escape text for placement in an HTML text node.
///
/// The strings that flow through here are the desktop's own localized copy,
/// handed in from the frontend so this file holds no user-facing English and no
/// second locale pipeline. They are ours, not a stranger's — and they are
/// escaped anyway, because 「the input is trusted」 is a claim about the whole
/// future of a file, and this one costs four replacements.
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// The page the browser lands on.
///
/// 🔴 NOT ONE EXTERNAL ASSET — no stylesheet, no font, no image, no script. Two
/// reasons, and the second is the one that would bite: a request that fails
/// would leave a broken page as the last thing the person sees of a SUCCESSFUL
/// sign-in; and the listener is closed the instant this response is written, so
/// anything the page asked us for would be refused by a socket that no longer
/// exists. Inline style, one document, done.
///
/// `lang` is stamped so a screen reader announces the sentence in the language
/// it is written in.
pub fn callback_page(lang: &str, title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{title}</title></head>\
<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#0f1115;color:#e6e8ee;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif\">\
<main style=\"max-width:32rem;padding:2rem;text-align:center\">\
<h1 style=\"margin:0 0 .5rem;font-size:1.25rem\">{title}</h1>\
<p style=\"margin:0;color:#9aa3b2\">{body}</p></main></body></html>",
        lang = escape_html(lang),
        title = escape_html(title),
        body = escape_html(body),
    )
}

/// A complete HTTP/1.1 response. `Connection: close` because this socket serves
/// exactly one request and then the listener is gone — leaving it open would
/// make a browser wait for a keep-alive that nobody is left to honour.
pub fn http_response(status: &str, html: &str) -> Vec<u8> {
    let head = format!(
        "HTTP/1.1 {status}\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Length: {len}\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\r\n",
        status = status,
        len = html.len(),
    );
    let mut out = head.into_bytes();
    out.extend_from_slice(html.as_bytes());
    out
}

/// The exchange endpoint, built from the endpoint the frontend handed us.
///
/// 🔴 HTTPS ONLY, AND REFUSED RATHER THAN UPGRADED. This request carries a live
/// credential and comes back holding a session token, so a plain-http endpoint
/// is not a degraded version of this flow, it is a different one. Rewriting the
/// scheme would be us deciding on the user's behalf that a host we have never
/// spoken to supports TLS. `shell/external_open.rs` refuses rather than upgrades
/// for the same reason, and this is the same rule on the outbound side.
///
/// ⚠️ The LAN/standalone channel is not affected: it has no accounts and never
/// reaches this code.
pub fn exchange_url(endpoint: &str) -> Result<String, SignInFailure> {
    let e = endpoint.trim().trim_end_matches('/');
    // D9 (2026-09-02 audit §3-D): `is_ascii()` FIRST, always. `e[..8]` below is a
    // BYTE-index slice, and Rust panics if that index does not fall on a char
    // boundary — which a multi-byte UTF-8 character anywhere in the first 8
    // bytes guarantees (e.g. "http://é…", where 'é' is two bytes straddling
    // index 8). `endpoint` comes from the QR code the frontend scanned, i.e. an
    // untrusted string reaching a `#[tauri::command]` — this used to be a panic
    // on the main thread from attacker- or typo-controlled input, not a bug that
    // needed a hostile actor to trigger, just a non-ASCII byte in the wrong spot.
    // Once ascii-only is confirmed, every subsequent byte index is a char
    // boundary by construction, so the slice below is safe.
    if !e.is_ascii() || e.contains(char::is_whitespace) {
        return Err(SignInFailure::BadEndpoint);
    }
    if e.len() < 9 || !e[..8].eq_ignore_ascii_case("https://") {
        return Err(SignInFailure::BadEndpoint);
    }
    Ok(format!("{e}/api/auth/qr-exchange"))
}

#[cfg(test)]
#[path = "cloud_signin_tests.rs"]
mod tests;

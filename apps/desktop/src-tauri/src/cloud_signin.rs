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
//! 🔴 ④ THE WINDOW IS OURS AND IS NOT THE GRANT'S. 15 min here bounds 「how long
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

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::forensic;

/// The path the console redirects to. ONE literal, mirrored in
/// the web console repo's `src/lib/signin-handoff.ts` (`DESKTOP_CALLBACK_PATH`) and
/// pinned there by a test — two ends of a callback that spell the path
/// differently produce a 404 that neither side can see.
pub const CALLBACK_PATH: &str = "/cb";

/// How long we wait for the person to finish in the browser. See ④ above for
/// why this is not the grant's TTL.
///
/// NR-112 (2026-09-26): 15 minutes, up from 180 s. Since NR-111 the console asks
/// a new account to confirm its email BEFORE it hands the sign-in to this PC
/// (web console repo, `src/lib/desktop-handoff-ledger.ts`, which mirrors this
/// constant as `DESKTOP_SIGNIN_WINDOW_MS` and pins it with a test that reads
/// this line). Registering, opening a mailbox and clicking a link did not fit in
/// 180 s, so the common first sign-in ran out and had to be started twice. The
/// waiting row on the PC keeps a Cancel button for the whole window
/// (`CloudSignInGuide.vue` → `SignInWaiting.vue`), and cancel closes the
/// listener at once (`await_callback` below), so a longer window is a longer
/// offer, not a longer open port nobody can shut.
pub const SIGNIN_WINDOW_MS: u64 = 900_000;

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

/// NR-110 (owner 2026-09-26) — the two actions on the SUCCESS page: 「close this
/// page」 and 「go to the console」. Labels are the desktop catalogue's, handed in
/// like every other sentence on this page (`shell/cloud_signin.rs` `PageCopy`).
pub struct PageActions<'a> {
    pub close_label: &'a str,
    pub console_label: &'a str,
    /// Revealed only if the page is still open shortly after `window.close()`.
    pub closed_fallback: &'a str,
    /// The console ORIGIN the frontend sent at sign-in start. The link is built
    /// from it by [`console_home_url`] and is omitted if it is not a bare https
    /// origin — this crate holds no endpoint literal (`socket/channel.rs`).
    pub console_origin: &'a str,
}

/// The ONE inline script the page may carry, verbatim. It only calls
/// `window.close()` and, if the page is still there 400 ms later, reveals the
/// 「you can close this page now」 line. Browsers refuse `window.close()` for a
/// tab they did not open by script and whose history is more than one document
/// — which is exactly this tab (sign-in → maybe Google → here) — so the fallback
/// line is the ordinary outcome, not an error. A constant, not a template: the
/// CSP header carries its hash (`page_csp`), and nothing handed in can reach the
/// script body.
pub const CLOSE_SCRIPT: &str = "document.getElementById('fm-close').onclick=function(){window.close();\
setTimeout(function(){document.getElementById('fm-closed').hidden=false},400)};";

/// `{origin}/console` when `origin` is a bare https origin (`https://host[:port]`,
/// ASCII, no path, no userinfo, no whitespace or quotes), else `None`.
///
/// 🔴 HTTPS ONLY and REFUSED RATHER THAN REPAIRED — same rule as [`exchange_url`]
/// and `shell/external_open.rs`. A page that says 「go to the console」 must not
/// take the person anywhere this sign-in did not start against.
pub fn console_home_url(origin: &str) -> Option<String> {
    let o = origin.trim().trim_end_matches('/');
    if !o.is_ascii() || o.len() <= 8 || !o[..8].eq_ignore_ascii_case("https://") {
        return None;
    }
    let host = &o[8..];
    if host.is_empty()
        || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
    {
        return None;
    }
    Some(format!("https://{host}/console"))
}

/// The page the browser lands on.
///
/// 🔴 NOT ONE EXTERNAL ASSET — no stylesheet, no font, no image, no external
/// script. Two reasons, and the second is the one that would bite: a request
/// that fails would leave a broken page as the last thing the person sees of a
/// SUCCESSFUL sign-in; and the listener is closed the instant this response is
/// written, so anything the page asked us for would be refused by a socket that
/// no longer exists. Inline style, one document, done.
///
/// NR-110 narrowed 「nothing from outside」 to what it was for — nothing is
/// FETCHED. A link the person may choose to follow is not a fetch, and neither
/// is an inline script. With `actions` the page carries exactly one anchor (to
/// the console, and only when [`console_home_url`] accepts the origin) and
/// exactly one inline script ([`CLOSE_SCRIPT`]). Failure pages pass `None`.
///
/// `lang` is stamped so a screen reader announces the sentence in the language
/// it is written in.
pub fn callback_page(lang: &str, title: &str, body: &str, actions: Option<&PageActions>) -> String {
    let actions_html = match actions {
        None => String::new(),
        Some(a) => {
            let link = console_home_url(a.console_origin)
                .map(|url| {
                    format!(
                        "<a href=\"{url}\" style=\"color:#8fb4ff\">{label}</a>",
                        url = escape_html(&url),
                        label = escape_html(a.console_label),
                    )
                })
                .unwrap_or_default();
            format!(
                "<p style=\"margin:1.25rem 0 0;display:flex;gap:1rem;justify-content:center;align-items:center;flex-wrap:wrap\">\
<button id=\"fm-close\" type=\"button\" style=\"font:inherit;padding:.4rem 1rem;border-radius:.5rem;border:1px solid #3a4150;\
background:#1b1f27;color:#e6e8ee;cursor:pointer\">{close}</button>{link}</p>\
<p id=\"fm-closed\" hidden style=\"margin:.75rem 0 0;color:#9aa3b2\">{fallback}</p>\
<script>{script}</script>",
                close = escape_html(a.close_label),
                fallback = escape_html(a.closed_fallback),
                script = CLOSE_SCRIPT,
            )
        }
    };
    format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{title}</title></head>\
<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#0f1115;color:#e6e8ee;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif\">\
<main style=\"max-width:32rem;padding:2rem;text-align:center\">\
<h1 style=\"margin:0 0 .5rem;font-size:1.25rem\">{title}</h1>\
<p style=\"margin:0;color:#9aa3b2\">{body}</p>{actions_html}</main></body></html>",
        lang = escape_html(lang),
        title = escape_html(title),
        body = escape_html(body),
    )
}

/// The page's Content-Security-Policy.
///
/// `default-src 'none'` is the header-level form of 「nothing is fetched」: even a
/// later edit that slipped an asset in would be refused by the browser. Inline
/// `style` attributes are the page's only styling, hence `style-src
/// 'unsafe-inline'`. 🔴 SCRIPTS: exactly [`CLOSE_SCRIPT`], by its SHA-256, and
/// only when the page actually carries it — never `'unsafe-inline'` for
/// scripts, never a nonce.
pub fn page_csp(html: &str) -> String {
    let mut csp = String::from(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if html.contains(&format!("<script>{CLOSE_SCRIPT}</script>")) {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(CLOSE_SCRIPT.as_bytes());
        csp.push_str(&format!("; script-src 'sha256-{}'", base64_std(&digest)));
    }
    csp
}

/// Standard base64 with padding — the encoding CSP hashes use. A dozen lines
/// here instead of a new crate for one call site; pinned by RFC 4648 vectors.
pub fn base64_std(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A complete HTTP/1.1 response. `Connection: close` because this socket serves
/// exactly one request and then the listener is gone — leaving it open would
/// make a browser wait for a keep-alive that nobody is left to honour.
pub fn http_response(status: &str, html: &str) -> Vec<u8> {
    let head = format!(
        "HTTP/1.1 {status}\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Security-Policy: {csp}\r\n\
Content-Length: {len}\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\r\n",
        status = status,
        csp = page_csp(html),
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

// ── the wait itself ─────────────────────────────────────────────────────────
//
// NR-112 moved the accept loop here from `shell/cloud_signin.rs`, VERBATIM in
// its decisions, so that 「after cancel or after the window, a late callback is
// refused and signs nobody in」 is something `cargo test --lib` drives on a real
// socket instead of a claim about a loop only a real browser could reach. The
// Tauri half keeps what needs an `AppHandle`: the phase, the exchange and the
// key store.

/// The two pages the listener can answer with, built ONCE by the caller from
/// the desktop catalogue's sentences (`shell/cloud_signin.rs` `PageCopy`), so
/// this module holds no user-facing words and no second locale pipeline.
pub struct CallbackPages {
    pub ok: String,
    pub fail: String,
}

/// How one wait for the browser ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitEnd {
    /// Cancelled on the PC (the button, or leaving the screen). No nonce leaves
    /// this function, and the caller writes no phase: `cancel` already did.
    Cancelled,
    /// The window closed, a callback was refused, or the socket failed.
    Failed(SignInFailure),
    /// A good callback, already answered with the success page. Spend this.
    Accepted(String),
}

/// Wait for the console's callback on `listener`.
///
/// 🔴 THE LISTENER IS TAKEN BY VALUE, and that is the property: every return
/// drops it, so the port is closed the moment the wait ends by ANY route —
/// cancel, window, refusal or success. A callback that arrives after that finds
/// nothing listening (connection refused), which is the strongest 「refused」
/// there is: no byte of it is read.
///
/// 🔴 CANCEL IS RE-CHECKED AFTER A CONNECTION IS ACCEPTED, not only at the top
/// of the loop. The flag can flip between that check and `accept()` returning;
/// without the second check a callback that raced a cancel would be judged,
/// accepted and spent, and the PC would sign itself in after the person said
/// stop. The expiry half of the same race is `Flow::offer`'s own freshness step.
pub fn await_callback(
    listener: TcpListener,
    flow: &mut Flow,
    cancel: &AtomicBool,
    pages: &CallbackPages,
    poll: Duration,
    read_timeout: Duration,
) -> WaitEnd {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return WaitEnd::Cancelled;
        }
        if flow.expired(now_ms()) {
            forensic::record("cloud", "browser sign-in: window closed with no callback");
            return WaitEnd::Failed(SignInFailure::Timeout);
        }
        let (mut sock, peer) = match listener.accept() {
            Ok(pair) => pair,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(poll);
                continue;
            }
            Err(e) => {
                forensic::record("cloud", &format!("browser sign-in: accept failed ({e})"));
                return WaitEnd::Failed(SignInFailure::Listen);
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
        // ⚠️ BLOCKING AGAIN, explicitly. The listener is non-blocking so the loop
        // can wake for cancel, and on Windows a socket accepted from a
        // non-blocking listener inherits that mode (Linux `accept4` does not).
        // A non-blocking read returns `WouldBlock` at once when the request line
        // has not arrived yet, which the arm below would treat as 「said
        // nothing」 and drop a real callback. `read_timeout` only means anything
        // on a blocking socket.
        let _ = sock.set_nonblocking(false);
        let _ = sock.set_read_timeout(Some(read_timeout));

        let mut buf = [0u8; MAX_REQUEST_LINE];
        let n = match sock.read(&mut buf) {
            Ok(n) if n > 0 => n,
            // Connected and said nothing, or said nothing readable. Not our
            // callback; do not let it end a sign-in still in progress.
            _ => continue,
        };
        if cancel.load(Ordering::SeqCst) {
            forensic::record("cloud", "browser sign-in: callback arrived after cancel, refused");
            let _ = sock.write_all(&http_response("400 Bad Request", &pages.fail));
            return WaitEnd::Cancelled;
        }
        let head = String::from_utf8_lossy(&buf[..n]);
        let line = head.lines().next().unwrap_or("");
        let verdict = match parse_request_line(line) {
            Some((method, target)) => flow.offer(method, target, now_ms()),
            None => Verdict::Ignore,
        };

        match verdict {
            Verdict::Ignore => {
                let _ = sock.write_all(&http_response("404 Not Found", &pages.fail));
                continue;
            }
            Verdict::Refused(f) => {
                forensic::record("cloud", &format!("browser sign-in: callback refused ({})", f.code()));
                let _ = sock.write_all(&http_response("400 Bad Request", &pages.fail));
                return WaitEnd::Failed(f);
            }
            Verdict::Accepted(nonce) => {
                // 🔴 ANSWER THE BROWSER FIRST, THEN EXCHANGE (the caller does the
                // exchange). The person is looking at a loading tab; making them
                // watch it spin through a 12-second server round trip would put
                // OUR latency on THEIR screen, in a page we do not control.
                let _ = sock.write_all(&http_response("200 OK", &pages.ok));
                let _ = sock.flush();
                return WaitEnd::Accepted(nonce);
            }
        }
    }
}

#[cfg(test)]
#[path = "cloud_signin_tests.rs"]
mod tests;

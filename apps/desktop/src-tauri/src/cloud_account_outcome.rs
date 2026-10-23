//! What a refused account read (`GET /api/me`, `GET /api/cloud/summary`) MEANS —
//! the PART THAT HAS NO TAURI IN IT, so `cargo test --lib` (the lean pass) pins
//! every verdict. The HTTP call that feeds it lives in `shell/cloud.rs`
//! (`get_json`), which is behind the `app` feature.
//!
//! SPEC-REF:
//!   apps/server-core/src/http/console-routes.ts — `/api/cloud/summary` runs
//!     `refuseRestricted` then `refuseUnverified` AFTER the identity verdict, so
//!     every 403 it sends is from a caller whose credential verified.
//!   apps/server-core/src/auth/email-verification.ts — `export const
//!     EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'` (the literal matched below;
//!     `apps/desktop/src/lib/cloud-account-unverified.test.ts` reads both
//!     files and goes red if they stop agreeing).
//!   CLAUDE.md red line: no silent failure, in BOTH directions — and 15 册 §4 R11:
//!     every status word must answer 「how do you know」.
//!
//! 🔴 NR-109 (owner report 2026-09-26, 0.3.95 Linux; the same code runs on
//! Windows and macOS). A freshly registered account whose mailbox is not yet
//! verified: the relay socket accepts its key (device surfaces are exempt from the
//! verification gate), `/api/me` answers 200, and `/api/cloud/summary` answers
//! `403 {"error":"EMAIL_NOT_VERIFIED"}`. This decision used to fold EVERY 403 that
//! was not `ACCOUNT_RESTRICTED` into `unauthorized`, which the card renders as
//! 「登录已过期，请重新登录。」 — a claim about the credential that is false (it
//! was minted minutes earlier and the relay had just accepted it), and an action
//! that cannot help (signing in again mints another key for the same unverified
//! account and lands on the same 403). Measured against production the same day:
//! the real `fetch_account_blocking` path answered `unauthorized (http 403)`.
//!
//! ⇒ The rule now: **only a 401 may become `unauthorized`.** A 403 is, by the
//! server's own contract (console-routes.ts: 「403, not 401: the caller IS
//! authenticated」), a verified credential being refused something — so it is
//! either a refusal we have a name for, or `bad_response` (「it answered and we
//! could not use what it said」), which is honest about being our gap and never
//! tells the user their sign-in lapsed.

/// The account read outcome a 401/403 maps to, and the machine-readable detail
/// that goes with it. `None` = the status is neither, and the caller carries on.
///
/// The error code is copied into `detail` only when it looks like a code (upper
/// snake case, bounded length): the detail reaches the forensic log, and a body we
/// did not write must not be able to put arbitrary text there.
pub fn refusal_outcome(status: u16, body: Option<&serde_json::Value>) -> Option<(&'static str, Option<String>)> {
    if status != 401 && status != 403 {
        return None;
    }
    let error = body.and_then(|b| b.get("error")).and_then(serde_json::Value::as_str);
    let code = error.filter(|e| looks_like_code(e));
    if status == 401 {
        // Card E-D / P-1: a 401 says 「sign in again」 ONLY when its code says the
        // credential itself lapsed or did not verify. A bare 401, or
        // AUTH_ACCOUNT_REQUIRED (the request carried no credential — our own
        // fault), is 「try later」: the user's sign-in is not in question.
        let outcome = if is_sign_in_lapsed(error) { "unauthorized" } else { "bad_response" };
        return Some((outcome, Some(http_detail(401, code))));
    }
    match error {
        // Owner ruling 2026-08-27 §R1 追加: a restricted account. `detail` carries
        // the reason KEY verbatim (or none), never a sentence made up here.
        Some("ACCOUNT_RESTRICTED") => Some((
            "restricted",
            body.and_then(|b| b.get("reason"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        )),
        // NR-109: the mailbox is not verified yet. The credential is fine.
        Some("EMAIL_NOT_VERIFIED") => Some(("unverified", None)),
        // A 403 we have no name for. Still NOT an expired sign-in.
        _ => Some(("bad_response", Some(http_detail(403, code)))),
    }
}

/// NR-109 (MAIN decision ①, 2026-09-26) — the way forward from the `unverified`
/// card: ask the relay to send the verification email again.
///
/// The route is `POST /api/auth/email-verification/send`
/// (apps/server-core/src/http/email-verification-routes.ts,
/// `EMAIL_VERIFICATION_SEND_PATH`). It authenticates with `accountUserFromBearer`
/// — the SAME verdict `/api/me` uses, and `/api/me` answers 200 to this PC's Cloud
/// Key — and it is exempt from the verification gate by construction (it is the
/// gate's own way out). Each answer below is one `sendJson` in that route; the
/// codes are matched verbatim and `cloud-account-unverified.test.ts` reads both
/// files so a rename on either side goes red.
///
/// 🔴 `sent` is claimed ONLY on a 200. The route awaits the mail transport and
/// answers 502 `VERIFY_SEND_FAILED` when it refused, storing nothing — so a 200
/// is the one answer that means a mail left, and nothing else may be read as one.
pub const RESEND_PATH: &str = "/api/auth/email-verification/send";

/// The resend outcome and, for `cooldown`, how long the server says to wait.
pub fn resend_outcome(status: u16, body: Option<&serde_json::Value>) -> (&'static str, Option<u64>) {
    let error = body.and_then(|b| b.get("error")).and_then(serde_json::Value::as_str);
    match (status, error) {
        (200, _) => ("sent", None),
        (409, Some("VERIFY_ALREADY_VERIFIED")) => ("already_verified", None),
        (429, Some("VERIFY_COOLDOWN")) => (
            "cooldown",
            body.and_then(|b| b.get("retry_after_ms")).and_then(serde_json::Value::as_u64),
        ),
        (429, _) => ("rate_limited", None),
        (400, Some("VERIFY_NO_EMAIL")) => ("no_email", None),
        (502, Some("VERIFY_SEND_FAILED")) => ("send_failed", None),
        // Card E-D / P-1: same rule as the account read.
        (401, code) if is_sign_in_lapsed(code) => ("unauthorized", None),
        _ => ("bad_response", None),
    }
}

/// The forensic detail for a resend answer: status plus the code when it looks
/// like one (same rule as the account read).
pub fn resend_detail(status: u16, body: Option<&serde_json::Value>) -> String {
    let code = body
        .and_then(|b| b.get("error"))
        .and_then(serde_json::Value::as_str)
        .filter(|e| looks_like_code(e));
    http_detail(status, code)
}

/// P-1 (docs/strategy/2026-10-10-login-renewal-design.md §2): the only two
/// codes that may make the desktop say the sign-in expired. Both are what
/// `apps/server-core/src/http/account-auth.ts` answers for a credential that
/// was presented and failed (expired / did not verify).
fn is_sign_in_lapsed(error: Option<&str>) -> bool {
    matches!(error, Some("AUTH_TOKEN_EXPIRED" | "AUTH_TOKEN_INVALID"))
}

fn looks_like_code(s: &str) -> bool {
    !s.is_empty() && s.len() <= 48 && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn http_detail(status: u16, code: Option<&str>) -> String {
    match code {
        Some(c) => format!("http {status} {c}"),
        None => format!("http {status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::refusal_outcome;
    use serde_json::json;

    #[test]
    fn unverified_mailbox_is_not_an_expired_sign_in() {
        // The exact body production sent on 2026-09-26.
        let body = json!({ "error": "EMAIL_NOT_VERIFIED" });
        assert_eq!(refusal_outcome(403, Some(&body)), Some(("unverified", None)));
    }

    #[test]
    fn restricted_keeps_its_reason_key() {
        let body = json!({ "error": "ACCOUNT_RESTRICTED", "reason": "abuse" });
        assert_eq!(refusal_outcome(403, Some(&body)), Some(("restricted", Some("abuse".to_string()))));
        let bare = json!({ "error": "ACCOUNT_RESTRICTED" });
        assert_eq!(refusal_outcome(403, Some(&bare)), Some(("restricted", None)));
    }

    #[test]
    fn no_403_ever_becomes_unauthorized() {
        for body in [json!({ "error": "ADMIN_ONLY" }), json!({}), json!("text"), json!({ "error": 7 })] {
            let (outcome, _) = refusal_outcome(403, Some(&body)).expect("403 is a refusal");
            assert_ne!(outcome, "unauthorized", "403 body {body} must not read as an expired sign-in");
        }
        let (outcome, detail) = refusal_outcome(403, None).expect("403 without a body");
        assert_eq!(outcome, "bad_response");
        assert_eq!(detail.as_deref(), Some("http 403"));
    }

    #[test]
    fn a_401_is_the_only_unauthorized_and_names_its_code() {
        let body = json!({ "error": "AUTH_TOKEN_EXPIRED" });
        assert_eq!(refusal_outcome(401, Some(&body)), Some(("unauthorized", Some("http 401 AUTH_TOKEN_EXPIRED".to_string()))));
        let body = json!({ "error": "AUTH_TOKEN_INVALID" });
        assert_eq!(refusal_outcome(401, Some(&body)), Some(("unauthorized", Some("http 401 AUTH_TOKEN_INVALID".to_string()))));
    }

    /// Card E-D / P-1: only the two lapsed-credential codes may say 「login
    /// expired」. A bare 401 or AUTH_ACCOUNT_REQUIRED is 「try later」.
    #[test]
    fn a_401_without_a_lapsed_credential_code_is_not_an_expired_sign_in() {
        let required = json!({ "error": "AUTH_ACCOUNT_REQUIRED" });
        assert_eq!(
            refusal_outcome(401, Some(&required)),
            Some(("bad_response", Some("http 401 AUTH_ACCOUNT_REQUIRED".to_string())))
        );
        assert_eq!(refusal_outcome(401, None), Some(("bad_response", Some("http 401".to_string()))));
        for body in [json!({}), json!("text"), json!({ "error": "AUTH_TOKEN_UNVERIFIABLE" })] {
            let (outcome, _) = refusal_outcome(401, Some(&body)).expect("401 is a refusal");
            assert_eq!(outcome, "bad_response", "401 body {body} must not read as an expired sign-in");
        }
    }

    #[test]
    fn resend_401_follows_the_same_rule() {
        use super::resend_outcome;
        assert_eq!(resend_outcome(401, Some(&json!({ "error": "AUTH_TOKEN_EXPIRED" }))).0, "unauthorized");
        assert_eq!(resend_outcome(401, Some(&json!({ "error": "AUTH_TOKEN_INVALID" }))).0, "unauthorized");
        assert_eq!(resend_outcome(401, Some(&json!({ "error": "AUTH_ACCOUNT_REQUIRED" }))).0, "bad_response");
        assert_eq!(resend_outcome(401, None).0, "bad_response");
    }

    #[test]
    fn a_body_cannot_put_free_text_into_the_detail() {
        let body = json!({ "error": "you are <b>banned</b> see http://x" });
        assert_eq!(refusal_outcome(403, Some(&body)), Some(("bad_response", Some("http 403".to_string()))));
    }

    #[test]
    fn resend_claims_sent_only_on_200() {
        use super::resend_outcome;
        assert_eq!(resend_outcome(200, Some(&json!({ "ok": true }))), ("sent", None));
        // The transport refused: nothing left, and it must not read as sent.
        assert_eq!(resend_outcome(502, Some(&json!({ "error": "VERIFY_SEND_FAILED" }))), ("send_failed", None));
        for s in [500u16, 404, 403, 400] {
            assert_ne!(resend_outcome(s, Some(&json!({}))).0, "sent", "status {s}");
        }
    }

    #[test]
    fn resend_names_every_answer_the_route_gives() {
        use super::resend_outcome;
        assert_eq!(resend_outcome(409, Some(&json!({ "error": "VERIFY_ALREADY_VERIFIED" }))), ("already_verified", None));
        assert_eq!(
            resend_outcome(429, Some(&json!({ "error": "VERIFY_COOLDOWN", "retry_after_ms": 41_000 }))),
            ("cooldown", Some(41_000))
        );
        assert_eq!(resend_outcome(429, Some(&json!({ "error": "VERIFY_RATE_LIMITED" }))), ("rate_limited", None));
        assert_eq!(resend_outcome(400, Some(&json!({ "error": "VERIFY_NO_EMAIL" }))), ("no_email", None));
        assert_eq!(resend_outcome(401, Some(&json!({ "error": "AUTH_TOKEN_EXPIRED" }))), ("unauthorized", None));
        assert_eq!(resend_outcome(400, Some(&json!({ "error": "SOMETHING_ELSE" }))), ("bad_response", None));
        assert_eq!(super::resend_detail(502, Some(&json!({ "error": "VERIFY_SEND_FAILED" }))), "http 502 VERIFY_SEND_FAILED");
    }

    #[test]
    fn other_statuses_are_not_refusals() {
        for s in [200u16, 404, 500, 502] {
            assert_eq!(refusal_outcome(s, None), None);
        }
    }
}

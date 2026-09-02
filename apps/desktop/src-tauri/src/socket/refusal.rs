// The vocabulary a relay refusal is judged in: WHAT was refused, and by WHOM it
// was asked. Moved VERBATIM out of `pairing.rs` on 2026-09-01 when that file hit
// its 800-line cap (same precedent as `outbound::is_account_validity_refusal`,
// which left for the same reason: the funnel owns the EMIT, a sibling module owns
// the DECISION). Nothing here changed in the move.
//
// The three predicates/types that answer "may this refusal cost the user their
// Cloud Key" now sit together, because the defect that produced
// [`RefusalAuthority`] was precisely that two of these questions had been
// collapsed into one.

use std::sync::Arc;

/// WHO asked, and therefore what this refusal is allowed to cost.
///
/// 🔴 THIS DISTINCTION EXISTS BECAUSE ITS ABSENCE SIGNED USERS OUT OF THE CLOUD.
/// A refusal reaching [`AuthFailureHook`] used to carry only a code, so the shell
/// had exactly one disposition for `AUTH_TOKEN_INVALID`: drop the Cloud Key. But
/// that code arrives from two completely different places, and only one of them
/// is evidence about the user's account.
///
/// Measured on dev-pc-a, four occurrences 2026-08-30 → 2026-09-01: a cold
/// start dials the relay, the device page's `pc:list-mobiles` reaches the server
/// before this connection's `pc:register` / `pc:reconnect` ack lands, the server
/// truthfully says 「this socket has no pairing identity」 in the only word it
/// had — and the desktop deleted a perfectly good credential. The handshake ack
/// then landed 56–335 ms LATER, on the very session that had just been torn down.
/// The user saw 「reinstalling signs me out of the cloud」.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalAuthority {
    /// The identity handshake itself refused us (`pc:register` / `pc:reconnect`
    /// ack, or the server's `auth:expired`). These legs ARE the credential
    /// conversation, so a verdict here may drop the Cloud Key and tear the
    /// session down.
    IdentityHandshake,
    /// One device-page verb was refused (`pc:list-mobiles`, `pc:refresh-code`,
    /// `pc:release-mobile`, `settings:list`, `settings:update`).
    ///
    /// 🔴 REPORTED, NEVER ACTED ON. Owner ruling 2026-08-27 §R1 追加 asked that
    /// every relay refusal reach the SCREEN — it did not ask that a verb be given
    /// authority over the credential, and the two are separate questions
    /// (「signed in locally」 vs 「the service answered me just now」 is that same
    /// ruling's own wording). A verb never sees the handshake, so it cannot tell
    /// 「your key was rejected」 from 「your key has not been presented yet」; a
    /// layer that cannot tell two things apart must not decide between them.
    DevicePageVerb,
}

/// Notified when the SERVER refuses this desktop's identity on a `pc:register`
/// ack, when it emits `auth:expired`, or when a device-page verb comes back with
/// an account-shaped code. The first argument is the wire error code
/// (`AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` / a registry code) or
/// `"auth:expired"` for the event; the second says what that code is allowed to
/// cost (see [`RefusalAuthority`] — it is not decoration). Installed ONLY for the
/// cloud channel; LAN leaves it `None` and keeps the historical behaviour byte
/// for byte.
pub type AuthFailureHook = Arc<dyn Fn(&str, RefusalAuthority) + Send + Sync>;

/// Codes that mean "the account identity behind this connection is not good"
/// (04 §3.1 / server `resolveActingUser`), as opposed to a transient or
/// payload-level registry failure.
///
/// ⚠️ THIS ANSWERS ONLY HALF THE QUESTION, and reading it as the whole one is
/// what cost four sign-outs: it says what a code is ABOUT, never whether the
/// layer that received it was in a position to know. [`RefusalAuthority`] carries
/// the other half, and `shell::cloud::auth_failure_hook` requires both.
pub fn is_account_auth_failure(code: &str) -> bool {
    matches!(code, "AUTH_TOKEN_EXPIRED" | "AUTH_TOKEN_INVALID")
}
// The WIDER question —「is this a verdict about the ACCOUNT or about the one verb
// that asked」— is `outbound::is_account_validity_refusal`, deliberately a
// separate predicate and a separate home.

#[cfg(test)]
#[path = "refusal_tests.rs"]
mod refusal_tests;

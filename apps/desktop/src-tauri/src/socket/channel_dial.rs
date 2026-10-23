// Card E-D (docs/strategy/2026-10-10-login-renewal-design.md §2 P-1, §3 "卡 E-D";
// contract: docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §3.2 correction block).
//
// Kept beside `channel.rs` rather than inside it: that file sits at the 800-line
// cap, and these two verdicts are the whole of what this card adds to it.
//
// `CloudReadiness::KeyExpired` is THIS PC's clock reading the key's `exp` claim
// (+ `CLOCK_SKEW_SECS`). Until this card it blocked dialing, so a clock running
// fast kept a perfectly valid key offline and told the user their login had
// expired. The relay is the only authority on whether a key is good, so the
// local reading is now a display hint and nothing more.

use super::CloudReadiness;

impl CloudReadiness {
    /// Whether to DIAL the relay. `KeyExpired` dials like `Ready`.
    ///
    /// What happens to a key that really did expire: the relay refuses
    /// `pc:reconnect` / `pc:register` with `AUTH_TOKEN_EXPIRED` and records
    /// `auth_expired` as this PC's absence reason, so a phone says "that
    /// computer's sign-in expired" instead of plain offline (docs/rebuild/18
    /// §7.3, `apps/server-core/src/room/pc-absence.ts`). The refusal reaches
    /// `shell/cloud.rs` `auth_failure_hook`, which clears the key with the code
    /// as its latch ⇒ the next verdict is `Rejected` (not dialable) and the dial
    /// does not repeat.
    pub fn is_dialable(&self) -> bool {
        matches!(self, CloudReadiness::Ready | CloudReadiness::KeyExpired)
    }

    /// The verdict to SHOW, given whether the relay has accepted this key on
    /// the live cloud session (`DesktopSocket::is_registered`). A local
    /// `KeyExpired` that the relay has accepted is a clock disagreement, not an
    /// expired login; showing 「登录已过期」 for it is the false report this card
    /// removes. Every other verdict is shown as is — an explicit rejection is
    /// never overridden by a session that happens to be up.
    pub fn shown(self, relay_accepted: bool) -> Self {
        match self {
            CloudReadiness::KeyExpired if relay_accepted => CloudReadiness::Ready,
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CloudConfig, CloudReadiness};

    /// A JWT whose payload is `{"exp":<exp>}`; header and signature are opaque
    /// (`decode_claims` reads only the middle segment).
    fn jwt_expiring_at(exp: i64) -> String {
        let payload = format!(r#"{{"exp":{exp}}}"#);
        format!("eyJhbGciOiJIUzI1NiJ9.{}.sig", b64url(payload.as_bytes()))
    }

    fn b64url(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..=chunk.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    /// The reverse control for the card's headline: a PC whose clock runs one
    /// day fast holds a key that is still valid by the relay's clock. Before
    /// E-D that key was not dialed at all.
    #[test]
    fn a_key_the_local_clock_calls_expired_is_still_dialed() {
        let true_now = 1_000_000;
        let fast_now = true_now + 86_400; // this PC's clock, one day ahead
        let mut cfg = CloudConfig::default();
        cfg.set_key(jwt_expiring_at(true_now + 3_600), "https://relay.example");

        let verdict = cfg.readiness(fast_now);
        assert_eq!(verdict, CloudReadiness::KeyExpired, "the local reading is unchanged");
        assert!(verdict.is_dialable(), "a fast clock must not keep a valid key offline");
        assert!(cfg.readiness(true_now).is_dialable());
    }

    #[test]
    fn only_ready_and_key_expired_dial() {
        assert!(CloudReadiness::Ready.is_dialable());
        assert!(CloudReadiness::KeyExpired.is_dialable());
        // A relay refusal latch must never re-dial: that is what stops a truly
        // expired key from looping once the relay has said no.
        assert!(!CloudReadiness::Rejected("AUTH_TOKEN_EXPIRED".into()).is_dialable());
        assert!(!CloudReadiness::NoKey.is_dialable());
        assert!(!CloudReadiness::NoEndpoint.is_dialable());
    }

    #[test]
    fn an_accepted_key_is_not_shown_as_expired_and_nothing_else_is_masked() {
        assert_eq!(CloudReadiness::KeyExpired.shown(true), CloudReadiness::Ready);
        assert_eq!(CloudReadiness::KeyExpired.shown(false), CloudReadiness::KeyExpired);
        let refused = CloudReadiness::Rejected("AUTH_TOKEN_INVALID".into());
        assert_eq!(refused.clone().shown(true), refused, "a rejection is never masked");
        assert_eq!(CloudReadiness::NoKey.shown(true), CloudReadiness::NoKey);
    }
}

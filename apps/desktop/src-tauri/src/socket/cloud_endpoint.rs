// SPEC-REF:
//   docs/strategy/2026-08-17-lan-cc-agent-work-package-2.md §1 C7
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer — cloud relay channel)
//
// The one-time migration of a RETIRED relay address off this install.
//
// THE DEFECT, in one line: `CloudConfig.endpoint` is a stored value and only an
// EMPTY one falls back to the default, so an install configured while
// a now-retired address was canonical dials and displays that host forever — and the
// web console mints the endpoint from `window.location.origin`, so logging in
// over the legacy domain hands it straight back. Per the card's own measurement
// (restated, not re-measured here): both hosts are the same box — `/api/health`
// byte-identical, socket.io handshake completes on each — so rewriting the value
// changes no connectivity. It changes what the install CARRIES.
//
// 🔴 WHY THE LITERALS ARE NOT IN THIS FILE. `socket/channel.rs` states the
// standing rule for this crate — no endpoint literal is hardcoded anywhere in it;
// the default comes from `@flowmic/protocol` on the frontend. That rule is kept:
// the canonical value and the retired list arrive as ARGUMENTS on every
// `cloud_status` read (frontend: `lib/channel.ts` `cloudEndpointSsot`). The
// migration nevertheless has to RUN here, because the Cloud Key never crosses
// back to the frontend and so the frontend cannot re-save the config on its own.
//
// ⚠️ THIS IS ONE HALF OF THE FIX, AND THE OTHER HALF IS NOT IN THIS REPO. The tap
// is the web console (its LoginQrCard view, in the private web repo), which
// mints the endpoint from `window.location.origin`; the canonical fix for it is an
// nginx redirect of the legacy domain's HTML routes, which belongs to the device
// line. 🔴 A BLANKET REDIRECT WOULD BE A DISCONNECTION EVENT: every install still
// configured with the legacy host dials `/api/*` and `/socket.io/*` there, so
// those must keep serving on it. This module is what keeps healing the installs
// meanwhile — which is also why it carries no「already migrated」flag.
//
// 🔴 THE DIRECTION THAT MATTERS IS THE ONE WE MUST NOT TAKE. `endpoint` exists so
// a self-hosted relay can override the default. Rewriting one of THOSE would be a
// worse bug than the one being fixed, so the rule is value equality against a
// known list — never "anything that is not the canonical value". Under-matching
// (a subdomain, a different scheme) is the safe failure and is deliberate.

use crate::socket::channel::CloudConfig;

/// A migration that is due: what the config holds now, and what it will hold.
/// Carries its own forensic sentence so「migrated silently」cannot happen by
/// omission at the call site — the caller receives the words along with the fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointMigration {
    /// The stored value being replaced, verbatim (NOT normalised — the log has to
    /// show what was actually on disk, including the trailing slash that made it
    /// look different from the list entry it matched).
    pub from: String,
    /// The canonical value, exactly as the frontend supplied it.
    pub to: String,
}

impl EndpointMigration {
    /// The forensic line. Names both values and why the rewrite was allowed, so a
    /// reader of the log can tell this apart from a user changing the endpoint.
    pub fn forensic_line(&self) -> String {
        format!(
            "relay endpoint migrated off a retired address: {} → {} \
             (one-time, matched the retired list by value; a self-hosted endpoint is never touched)",
            self.from, self.to
        )
    }
}

/// Normalise for COMPARISON only. Never for storage.
///
/// Trim whitespace, strip trailing `/`, ASCII-lowercase. Applied to both sides,
/// so `https://relay.retired.example/` and `HTTPS://Relay.Retired.Example` both match the list
/// entry `https://relay.retired.example`.
///
/// Deliberately NOT a URL parse and deliberately not more than this:
///   · the SCHEME stays part of the identity — `http://host` is a different value
///     from `https://host`, and silently upgrading someone's scheme is a decision
///     this migration has no standing to make (add the form to the list if it is
///     ever wanted);
///   · no host/subdomain folding — `www.` is not the same address;
///   · `to_ascii_lowercase`, not `to_lowercase`: Unicode case folding can map two
///     visually different hosts onto one string, and a non-ASCII host should only
///     ever match byte-for-byte.
fn normalise(v: &str) -> String {
    v.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Decide whether `stored` must be migrated. **Pure** — nothing is written, and
/// nothing is logged; the caller owns both.
///
/// `None` (i.e. leave it alone) in every one of these cases:
///   · `canonical` is blank — never rewrite a real endpoint into nothing;
///   · `stored` is blank — that is「never configured」and already falls back to
///     the default at every read site. Behaviour there is unchanged;
///   · `stored` already IS the canonical value — nothing to do, and this is also
///     the second line of defence for idempotency (see below);
///   · `stored` is not in `legacy` — the self-hosted case, the direction this
///     function exists to protect.
///
/// IDEMPOTENCY is by construction rather than by a flag: the rewrite removes the
/// thing that triggers it, so the next call sees a non-legacy value and answers
/// `None`. There is deliberately NO persisted "already migrated" bit — the web
/// console keeps handing the retired address back until the deployment half of
/// this fix lands, and a once-ever flag would make the desktop stop healing.
/// "Once" therefore means once per occurrence of the retired value, which is the
/// only sense that is true.
pub fn plan_migration(stored: &str, canonical: &str, legacy: &[String]) -> Option<EndpointMigration> {
    let target = canonical.trim();
    if target.is_empty() {
        return None;
    }
    let have = normalise(stored);
    if have.is_empty() || have == normalise(target) {
        return None;
    }
    // A blank list entry would match nothing (`have` is non-empty here), but it is
    // filtered anyway so that a malformed list can never become a wildcard.
    let matched = legacy
        .iter()
        .map(|l| normalise(l))
        .any(|l| !l.is_empty() && l == have);
    matched.then(|| EndpointMigration { from: stored.trim().to_string(), to: target.to_string() })
}

/// Apply the decision to a config in memory. Returns what the caller must then
/// persist and announce — `None` means the config was not touched at all, which
/// is the case on every read after the first.
pub fn migrate(cfg: &mut CloudConfig, canonical: &str, legacy: &[String]) -> Option<EndpointMigration> {
    let plan = plan_migration(&cfg.endpoint, canonical, legacy)?;
    cfg.endpoint = plan.to.clone();
    Some(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 🔴 THE RETIRED ADDRESS HERE IS FICTIONAL, AND THAT IS THE POINT.
    // `relay.retired.example` is an RFC 2606 `.example` name — it can never be a
    // real host. The module under test is DOMAIN-AGNOSTIC: it compares a stored
    // value against a list handed in from the frontend, so a fixture that named
    // the product's actual retired domain would be testing the fixture, not the
    // mechanism. It also made the tests the last place in the tree still carrying
    // a domain the owner retired on 2026-08-17
    // (docs/decisions/2026-08-17-owner-retires-flowmic-online-public-service.md).
    // ⚠️ Do NOT "fix" this back to a production hostname: the real value belongs in
    // exactly one place, `LEGACY_SAAS_ENDPOINTS` in @flowmic/protocol, and this
    // crate's standing rule (socket/channel.rs) is that no endpoint literal is
    // hardcoded here at all.
    const CANONICAL: &str = "https://flowmic.app";
    fn legacy() -> Vec<String> {
        vec!["https://relay.retired.example".to_string()]
    }

    #[test]
    fn a_retired_address_is_migrated_and_the_line_names_both_values() {
        let mut cfg = CloudConfig { endpoint: "https://relay.retired.example".to_string(), ..Default::default() };
        let m = migrate(&mut cfg, CANONICAL, &legacy()).expect("the retired address must migrate");
        assert_eq!(cfg.endpoint, CANONICAL);
        assert_eq!(m.from, "https://relay.retired.example");
        assert_eq!(m.to, CANONICAL);
        // Never silently: the words exist and carry both values.
        let line = m.forensic_line();
        assert!(line.contains("https://relay.retired.example"), "line must name what was replaced: {line}");
        assert!(line.contains(CANONICAL), "line must name what it became: {line}");
    }

    #[test]
    fn the_second_run_is_a_no_op() {
        let mut cfg = CloudConfig { endpoint: "https://relay.retired.example".to_string(), ..Default::default() };
        assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_some());
        // Every subsequent cloud_status read goes through here; it must not write,
        // must not log, and must not move the value again.
        assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_none());
        assert_eq!(cfg.endpoint, CANONICAL);
    }

    // 🔴 THE CONTROL THAT GUARDS THE DANGEROUS DIRECTION. `endpoint` exists so a
    // self-hosted relay can override the default; a migration that rewrote one of
    // these would take a working install off its own server.
    //
    // REVERSE CONTROL, run in this window (2026-08-16) and OBSERVED RED: replacing the
    // list-membership test with `let matched = !legacy.is_empty()` — the list read
    // as a feature flag rather than as a set, which is what this defect would
    // actually look like — failed HERE first
    // («https://relay.example must be left alone»), and took
    // `a_different_scheme_or_subdomain_is_not_a_match` and
    // `an_empty_or_blank_list_entry_is_not_a_wildcard` with it: 7 passed, 3 failed.
    // The happy-path and idempotency tests stayed GREEN throughout — i.e. this
    // trio is the only thing in the file standing between a rename and a
    // self-hosted install losing its relay. Restored and re-verified: 10 passed.
    #[test]
    fn a_self_hosted_endpoint_is_never_rewritten() {
        for host in ["https://relay.example", "http://192.168.1.9:41879", "https://relay.retired.example.evil.test"] {
            let mut cfg = CloudConfig { endpoint: host.to_string(), ..Default::default() };
            assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_none(), "{host} must be left alone");
            assert_eq!(cfg.endpoint, host);
        }
    }

    #[test]
    fn an_empty_endpoint_behaves_exactly_as_before() {
        for stored in ["", "   "] {
            let mut cfg = CloudConfig { endpoint: stored.to_string(), ..Default::default() };
            assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_none());
            // Untouched, not "helpfully" filled in: an empty endpoint is
            // CloudReadiness::NoEndpoint and every read site already falls back to
            // the default for display. Writing it here would turn "never
            // configured" into "configured", which is a different fact.
            assert_eq!(cfg.endpoint, stored);
        }
    }

    #[test]
    fn a_trailing_slash_or_different_case_still_matches() {
        for stored in [
            "https://relay.retired.example/",
            "https://relay.retired.example///",
            "HTTPS://Relay.Retired.Example",
            "  https://relay.retired.example  ",
        ] {
            let mut cfg = CloudConfig { endpoint: stored.to_string(), ..Default::default() };
            let m = migrate(&mut cfg, CANONICAL, &legacy()).unwrap_or_else(|| panic!("{stored} must migrate"));
            assert_eq!(cfg.endpoint, CANONICAL);
            // The log shows what was on disk (trimmed), not the normalised form.
            assert_eq!(m.from, stored.trim());
        }
    }

    #[test]
    fn a_different_scheme_or_subdomain_is_not_a_match() {
        for stored in ["http://relay.retired.example", "https://www.relay.retired.example", "https://api.relay.retired.example"] {
            let mut cfg = CloudConfig { endpoint: stored.to_string(), ..Default::default() };
            assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_none(), "{stored} is not the listed value");
        }
    }

    #[test]
    fn the_canonical_value_is_left_alone_even_if_the_list_is_wrong() {
        // The protocol package asserts the list cannot contain the canonical value;
        // this is the second line of defence, and it is the one that would have
        // stopped an endless rewrite loop had the first been removed.
        let bad = vec![CANONICAL.to_string(), "https://flowmic.app/".to_string()];
        let mut cfg = CloudConfig { endpoint: CANONICAL.to_string(), ..Default::default() };
        assert!(migrate(&mut cfg, CANONICAL, &bad).is_none());
        assert_eq!(cfg.endpoint, CANONICAL);
    }

    #[test]
    fn a_blank_canonical_never_wipes_a_stored_endpoint() {
        let mut cfg = CloudConfig { endpoint: "https://relay.retired.example".to_string(), ..Default::default() };
        assert!(migrate(&mut cfg, "   ", &legacy()).is_none());
        assert_eq!(cfg.endpoint, "https://relay.retired.example");
    }

    #[test]
    fn an_empty_or_blank_list_entry_is_not_a_wildcard() {
        let mut cfg = CloudConfig { endpoint: "https://relay.example".to_string(), ..Default::default() };
        assert!(migrate(&mut cfg, CANONICAL, &["".to_string(), "  ".to_string()]).is_none());
        assert_eq!(cfg.endpoint, "https://relay.example");
    }

    #[test]
    fn nothing_else_in_the_config_is_disturbed() {
        let mut cfg = CloudConfig {
            endpoint: "https://relay.retired.example".to_string(),
            jwt: Some("eyJhbGciOiJIUzI1NiJ9.payload.sig".to_string()),
            auth_error: Some("AUTH_TOKEN_EXPIRED".to_string()),
        };
        assert!(migrate(&mut cfg, CANONICAL, &legacy()).is_some());
        // The address moved; the key and the loud rejection latch did not. A
        // migration that cleared either would sign the user out (or hide a
        // refusal) over a rename.
        assert_eq!(cfg.jwt.as_deref(), Some("eyJhbGciOiJIUzI1NiJ9.payload.sig"));
        assert_eq!(cfg.auth_error.as_deref(), Some("AUTH_TOKEN_EXPIRED"));
    }
}

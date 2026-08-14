// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (LAN IP selection: /api/network non-loopback IPv4;
//     after falling back, keep re-polling every 3s until a LAN IP appears — a
//     late DHCP lease no longer permanently sticks at 127.0.0.1),
//     §6 (cloud classification: 172.77.x is not in RFC1918 → treated as cloud, but for LAN pairing any
//     non-loopback IPv4 the server hands us is dialable)
//   docs/rebuild/13-LESSONS-LEARNED.md §2 N2 (LAN IP stuck at 127.0.0.1: loopback is not a terminal state)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-4 lead-controller ruling #5
//
// Pure decision core for turning the server's `/api/network` reply into a pairing
// endpoint. The server already excludes internal + APIPA addresses and sorts
// RFC1918 first (see server-core http/router.ts collectLanIpv4), so we trust its
// `primary`; this layer only enforces the "loopback is NOT a terminal LAN IP,
// keep polling" invariant (N2) and builds the `http://<ip>:<port>` endpoint.

/// A loopback / wildcard / link-local address a phone on the LAN cannot dial —
/// i.e. one that must NOT be latched as the pairing endpoint (keep polling).
pub fn is_unroutable_for_lan(ip: &str) -> bool {
    let h = ip.trim();
    if h.is_empty() {
        return true;
    }
    if h == "0.0.0.0" || h == "::" || h == "::1" || h == "localhost" {
        return true;
    }
    if h.starts_with("127.") {
        return true;
    }
    if h.starts_with("169.254.") {
        return true; // APIPA — no DHCP lease yet
    }
    false
}

/// Decide the pairing endpoint from a `/api/network` `primary` value. `Some(url)`
/// only when `primary` is a LAN-dialable IPv4 — otherwise `None` (the caller keeps
/// the loopback endpoint, which suppresses the QR, and re-polls every 3 s: N2's
/// "environment still converging → 还没好 ('not ready yet'), not a terminal failure").
pub fn pairing_endpoint_from_primary(primary: Option<&str>, port: u16) -> Option<String> {
    match primary {
        Some(ip) if !is_unroutable_for_lan(ip) => Some(format!("http://{ip}:{port}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_apipa_are_unroutable() {
        for ip in ["127.0.0.1", "0.0.0.0", "::1", "169.254.10.1", "", "localhost"] {
            assert!(is_unroutable_for_lan(ip), "{ip} must be unroutable for LAN");
        }
    }

    #[test]
    fn real_lan_ipv4_is_routable() {
        for ip in ["10.0.0.78", "10.8.66.78", "172.30.160.1", "100.64.7.78"] {
            assert!(!is_unroutable_for_lan(ip), "{ip} must be routable");
        }
    }

    #[test]
    fn primary_lan_ip_builds_an_http_endpoint() {
        assert_eq!(
            pairing_endpoint_from_primary(Some("10.0.0.78"), 41879),
            Some("http://10.0.0.78:41879".to_string())
        );
    }

    #[test]
    fn loopback_primary_yields_none_so_the_caller_keeps_polling() {
        assert_eq!(pairing_endpoint_from_primary(Some("127.0.0.1"), 41879), None);
        assert_eq!(pairing_endpoint_from_primary(None, 41879), None);
    }
}

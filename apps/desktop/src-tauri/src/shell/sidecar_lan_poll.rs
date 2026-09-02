// F-2343 LAN-IP poll, split out of sidecar_ctl.rs (2026-09-02, file-size cap).
// A CHILD module of sidecar_ctl (not a sibling registered in shell/mod.rs) so
// `use super::*` below reaches SidecarState's private accessors exactly as
// this function always could — VERBATIM move, no visibility widened.

use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

/// P2 (2026-09-02 audit): "spawn_lan_poll reads lan_resolved once → a DHCP IP
/// change goes stale". True before this: once the fast loop below found a
/// primary IP, it wrote it ONCE and returned — nothing ever looked again for
/// the rest of the process's life, so a DHCP lease renewal that moved this
/// machine to a new address left `pairing_endpoint()` answering an IP the QR
/// code would carry into a dead connection.
///
/// A generation counter, not a re-entrancy `Mutex`: `bring_up_and_connect` can
/// call `spawn_lan_poll` again on a fresh bring-up (reconnect, dev-mode
/// bypass), and that new call's poll is the one that should own the endpoint
/// slot from then on — an OLD watch thread still sleeping from a previous
/// bring-up must stop touching state it no longer speaks for. Each spawn
/// captures the generation it was born with; every write checks it is still
/// current first. Cheaper than a "cancel the old thread" mechanism (there is
/// no such primitive for a thread blocked in `sleep`/a blocking HTTP call) and
/// sufficient: a stale generation's write is simply skipped, never applied.
static POLL_GENERATION: AtomicU64 = AtomicU64::new(0);

/// F-2343 LAN-IP poll: once the endpoint is up, poll /api/network every 3 s until a
/// non-loopback LAN IPv4 appears (DHCP may be late — a loopback-only result is
/// "还没好" ("not ready yet"), not terminal). Stops once resolved. A ~10 min ceiling then gives up
/// (the pairing modal keeps the loopback endpoint → QR suppressed, F-2346).
///
/// P2 (2026-09-02): resolving no longer ends the story. Once found, the poll
/// switches to a slow WATCH cadence (`LAN_WATCH_INTERVAL`) that keeps
/// re-reading the primary IP for as long as this generation is current, and
/// updates the shared slot (with a named forensic line) whenever it differs
/// from what is already published — the fix for the DHCP-change gap above.
pub(super) fn spawn_lan_poll(app: &AppHandle) {
    let state: State<SidecarState> = app.state();
    let generation = POLL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if state.lan_resolved() {
        // Already known from an EARLIER generation's fast loop. Still worth a
        // watcher of our own so a DHCP change is caught even when this call
        // is the "already resolved, nothing to do" common case — the old
        // early `return` here is exactly the line this fix replaces.
        spawn_watch_only(app, generation);
        return;
    }
    let lan = state.lan_handle();
    let cands = state.lan_candidates_handle();
    let tls_fp = state.lan_tls_fp_handle();
    let host = state.host.clone();
    let port = state.port;
    std::thread::spawn(move || {
        let mut warned_malformed = false;
        for _ in 0..200 {
            // GA-21: record the WHOLE candidate list on every read, not only on
            // the resolving one — the picker needs the alternatives even when the
            // heuristic already produced a usable primary.
            let all = io::fetch_lan_candidates(&host, port);
            if !all.is_empty() {
                if let Ok(mut g) = cands.lock() {
                    *g = all;
                }
            }
            // D2LAN-B2b — read the fingerprint HERE, ABOVE the primary check,
            // because that check RETURNS. On a normal machine the loop exits on its
            // first iteration, so a read placed after it would run zero times on
            // exactly the machines this feature is for. One read suffices (the TLS
            // front exists before the server listens), hence the `is_none` guard.
            // Rationale for dropping-vs-carrying is at `io::is_carryable_fingerprint`.
            if tls_fp.lock().map(|g| g.is_none()).unwrap_or(false) {
                match io::fetch_lan_tls_fingerprint(&host, port) {
                    Some(raw) if io::is_carryable_fingerprint(&raw) => {
                        if let Ok(mut g) = tls_fp.lock() {
                            *g = Some(raw.clone());
                        }
                        forensic::record("sidecar", &format!("LAN TLS fingerprint read: {raw}"));
                    }
                    // 🔴 Out loud, once, with the LENGTH rather than the value:
                    // truncation is the likely corruption and 「多长」("how long") identifies it.
                    Some(raw) if !warned_malformed => {
                        warned_malformed = true;
                        forensic::record(
                            "sidecar",
                            &format!(
                                "REFUSED a malformed LAN TLS fingerprint from /api/network ({} chars) — the pairing QR carries no fp=",
                                raw.len()
                            ),
                        );
                    }
                    // A malformed value we have already reported, or none at all:
                    // both leave the slot empty, which is the same QR either way.
                    _ => {}
                }
            }
            if let Some(ip) = io::fetch_lan_primary(&host, port) {
                let ep = format!("http://{ip}:{port}");
                if let Ok(mut g) = lan.lock() {
                    *g = Some(ep.clone());
                }
                forensic::record("sidecar", &format!("LAN pairing endpoint resolved: {ep}"));
                // P2 fix: resolving used to be the exit condition. Keep this
                // same thread alive as the generation's long-lived watcher
                // instead of a bare `return` — a second, brand-new thread for
                // the same job would be pure waste.
                watch_for_lan_ip_changes(generation, &lan, &host, port);
                return;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        forensic::record("sidecar", "LAN-IP poll gave up (no non-loopback IPv4 in ~10min)");
    });
}

/// How often the long-lived watch (after resolution, or a call that found the
/// endpoint already resolved by an earlier generation) re-checks the primary
/// IP. Slow relative to the discovery loop's 3s: nothing here is time-critical
/// once an endpoint exists (a DHCP lease is measured in hours), and a live
/// pairing session should not see a flurry of extra requests to its own
/// sidecar's `/api/network` for a check that almost always finds no change.
const LAN_WATCH_INTERVAL: Duration = Duration::from_secs(60);

/// The watch-only entry point used when `spawn_lan_poll` finds the endpoint
/// already resolved (an earlier generation's discovery already ran) — there is
/// no discovery left to do, only continued watching, and ownership of that
/// watching now belongs to `generation`.
fn spawn_watch_only(app: &AppHandle, generation: u64) {
    let state: State<SidecarState> = app.state();
    let lan = state.lan_handle();
    let host = state.host.clone();
    let port = state.port;
    std::thread::spawn(move || watch_for_lan_ip_changes(generation, &lan, &host, port));
}

/// Re-reads the primary LAN IP every [`LAN_WATCH_INTERVAL`] and republishes it
/// ONLY when it differs from what is already there — a same-value write would
/// cost a lock for nothing, and a difference is the one case worth a forensic
/// line: a silent IP change is exactly what "the QR now carries a dead
/// address" looks like from a user's side. Exits the moment a NEWER generation
/// exists (see [`POLL_GENERATION`]'s doc comment for why a generation check
/// rather than a stop flag) — an old bring-up's watcher must never keep
/// touching a slot a newer bring-up now owns.
fn watch_for_lan_ip_changes(generation: u64, lan: &Arc<Mutex<Option<String>>>, host: &str, port: u16) {
    loop {
        std::thread::sleep(LAN_WATCH_INTERVAL);
        if POLL_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        // A transient miss (the sidecar briefly unreachable, an interface
        // flapping) must NOT clear a known-good endpoint — only a NEW, DIFFERENT
        // answer is worth acting on.
        let Some(ip) = io::fetch_lan_primary(host, port) else {
            continue;
        };
        let current = lan.lock().ok().and_then(|g| g.clone());
        if let Some(ep) = lan_endpoint_if_changed(current.as_deref(), &ip, port) {
            if let Ok(mut g) = lan.lock() {
                *g = Some(ep.clone());
            }
            forensic::record("sidecar", &format!("LAN pairing endpoint CHANGED (DHCP?): now {ep}"));
        }
    }
}

/// The pure decision `watch_for_lan_ip_changes` acts on: given what is
/// published now and what a fresh read just returned, is there a NEW endpoint
/// to publish? `None` covers both "unchanged" and "read produced nothing" —
/// pulled out of the thread/lock/forensic plumbing above so the one part worth
/// getting right (comparing, not blindly overwriting) is a unit-testable fact
/// rather than something only observable by watching a real sidecar for an
/// hour.
fn lan_endpoint_if_changed(current: Option<&str>, fetched_ip: &str, port: u16) -> Option<String> {
    let candidate = format!("http://{fetched_ip}:{port}");
    if current == Some(candidate.as_str()) {
        return None;
    }
    Some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── P2 (2026-09-02): DHCP change must be seen, not just first resolution ──

    #[test]
    fn an_unchanged_ip_reports_nothing_to_publish() {
        assert_eq!(lan_endpoint_if_changed(Some("http://192.168.1.5:8420"), "192.168.1.5", 8420), None);
    }

    #[test]
    fn reverse_control_a_genuinely_different_ip_is_reported() {
        // NEGATIVE CONTROL for the test above: without it, a version of
        // `lan_endpoint_if_changed` that always returned `None` (i.e. the
        // pre-fix "never look again" behaviour) would still pass it.
        assert_eq!(
            lan_endpoint_if_changed(Some("http://192.168.1.5:8420"), "192.168.1.9", 8420),
            Some("http://192.168.1.9:8420".to_string()),
            "a DHCP-issued new address must be recognised as a change"
        );
    }

    #[test]
    fn no_prior_endpoint_is_always_a_change() {
        assert_eq!(
            lan_endpoint_if_changed(None, "192.168.1.5", 8420),
            Some("http://192.168.1.5:8420".to_string())
        );
    }

    #[test]
    fn a_port_change_alone_counts_as_a_change() {
        assert_eq!(
            lan_endpoint_if_changed(Some("http://192.168.1.5:8420"), "192.168.1.5", 8421),
            Some("http://192.168.1.5:8421".to_string())
        );
    }
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (both channels resident)
//
// The device page's two read-only snapshots, split out of shell/mod.rs for the
// 800-line cap: the CONNECTION state pull (v0.2.4) and the pairing snapshot the
// 「添加手机」 ("add a phone") modal builds its code + QR from. Both answer
// 「这台机器现在处于什么连接状况」 ("what connection state this machine is
// currently in") for the same page, which is why they share a module.

use tauri::State;

use crate::shell::{cloud, sidecar_ctl};
use super::{current_channel, with_channel_socket, with_socket, SocketState};

/// v0.2.4 — ONE resident channel's connection state, as a PULL.
///
/// Same field set as the `flowmic://connection` push frame on purpose: the
/// frontend seeds its store from this and then keeps it current from the push,
/// so there is exactly one shape and no second decoder to drift.
#[derive(serde::Serialize)]
pub struct ConnectionSnapshot {
    connected: bool,
    registered: bool,
    room_uuid: Option<String>,
    mobiles: usize,
    reason: &'static str,
    channel: &'static str,
    primary: bool,
}

/// Every resident channel's CURRENT connection state.
///
/// owner 2026-07-29 (device page screenshot): both channel cards said 「connecting…」 and the
/// footer said 「not connected」, for the whole session, while the log two lines above
/// said both sockets were open and registered.
///
/// The pump forwards a CONNECTION frame only when the state CHANGES — correct,
/// and cheap — but that made the frame a ONE-SHOT that the UI had to be present
/// for. It was not: the instrumented log timed it at LAN+cloud reaching
/// `connected=true` at 02:07:05.9 and the Vue window registering its listener at
/// 02:07:07.0, 1.1 s late. Nothing changed afterwards, so nothing was ever sent
/// again, and the page stayed at its initial `false` until something happened to
/// move it. Rust wins that race every launch, which is why it was 「always been this way」.
///
/// The push stays; this is the missing half. A state that can only be PUSHED is
/// unrecoverable for any listener that was not already there — the fix is not a
/// bigger buffer or a retry, it is being able to ask.
#[tauri::command]
pub fn connection_snapshot(state: State<'_, SocketState>) -> Vec<ConnectionSnapshot> {
    let guard = match state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let mut out = Vec::new();
    for channel in [crate::socket::Channel::Lan, crate::socket::Channel::Cloud] {
        // A channel with no session is NOT reported as disconnected — it is not
        // resident at all, and inventing a row for it would put a 「not connected」 card
        // on screen for a channel the user never configured.
        let Some(sock) = guard.slot(channel) else { continue };
        let creds = sock.credentials();
        out.push(ConnectionSnapshot {
            connected: sock.is_connected(),
            // RV-34 — `sock.is_registered()` (= Pairing::handshake_acked), NOT
            // `creds.is_registered()`. The credential file answers 「does this
            // machine hold a
            // token」, which survives a restart and says nothing about THIS
            // connection; 「the server has acknowledged me on this connection」 is the question this field is
            // rendered as, and only the register/reconnect ack can answer it. The
            // pump's CONNECTION frame already reads the ack, so leaving the pull on
            // creds gave the SAME fact two answers — the page would show 「registered」
            // off the snapshot and flip back to 「not registered」 when the first push landed
            // (RV-07's shape: one state must not have a second decoder). Do not
            // "simplify" this back to `creds`, which is the more direct-looking read.
            registered: sock.is_registered(),
            room_uuid: creds.room_uuid.clone(),
            mobiles: sock.connected_mobiles(),
            reason: "snapshot",
            channel: channel.tag(),
            primary: guard.admission.is_primary(channel),
        });
    }
    out
}

// ── device page: pairing code + endpoint (WP-R23-1) ──────────────────────────

/// N5 (owner's requirement ②) — the channel the 「add a phone」 modal is pairing THROUGH.
///
/// `socket::channel::pairing_destination` answers 「that channel's address」; this
/// answers 「which channel」, and it comes from the MODAL rather than from anything
/// global. The `default` argument keeps exactly one job: it is what the modal opens on,
/// and what every other reader of the pairing snapshot (the device page's PC card, the
/// LAN address pill) still gets.
///
/// `None` — an older frontend that invokes with no argument — and an unparseable tag
/// both resolve to `default`, i.e. the exact pre-N5 behaviour.
///
/// RV-新B — `default` is now [`super::current_channel`] (admission-derived). It used to
/// be `cloud::CloudState::active_channel()`, reading a persisted flag that owner's
/// 2026-07-30 ruling ② had left with no writer: it answered `lan` forever, so a pure-cloud
/// user's 「add a phone」 opened on the local-LAN tab and showed a code minted by a sidecar
/// their phone cannot reach. The parameter is deliberately still an ARGUMENT — this
/// function must stay pure so both readings of the tie (explicit tag vs. default) are
/// unit-testable without a socket.
///
/// An unknown tag deliberately does NOT refuse the call, unlike `Channel::from_tag`
/// in `cloud::channel_switch`. The stakes are asymmetric: a bad SWITCH persists and
/// moves a live connection, while this argument only chooses which resident session
/// is READ — refusing it would turn a version skew into a permanent 「no pairing code」
/// with no recovery path. The read still cannot LIE about which channel it answered
/// for: the snapshot carries the resolved tag back (`PairingInfo.channel`) and the
/// frontend renders a QR only while that tag matches the tab on screen.
pub(crate) fn resolve_pairing_channel(
    requested: Option<&str>,
    default: crate::socket::Channel,
) -> crate::socket::Channel {
    requested
        .and_then(crate::socket::Channel::from_tag)
        .unwrap_or(default)
}

/// 0.2.66 — 「this computer's public number on the relay」, and ONLY on the relay.
///
/// A free function rather than an inline `if`, for one reason: it is the only piece
/// of the snapshot's LAN/cloud asymmetry that can be exercised without a Tauri
/// `State`, and the rule it encodes is owner's own sentence rather than an
/// implementation detail. An exhaustive `match` on purpose — a third channel would
/// have to state its answer here instead of inheriting whichever branch an `if` had.
pub(crate) fn pcid_for_channel(
    destination: crate::socket::Channel,
    reported: Option<String>,
) -> Option<String> {
    match destination {
        crate::socket::Channel::Cloud => reported,
        // Not 「probably won't have one」 — dropped. See `PairingInfo::pcid`.
        crate::socket::Channel::Lan => None,
    }
}

/// A snapshot for the device page's "add a phone" modal: the current 4-digit code,
/// the dial endpoint (so the frontend builds the QR — or suppresses it for a
/// loopback endpoint, F-2346), and live presence. `short_code` is `None` after a
/// token reconnect (no fresh code minted) — the frontend then offers a refresh.
#[derive(serde::Serialize)]
pub struct PairingInfo {
    short_code: Option<String>,
    endpoint: String,
    pc_name: String,
    connected: bool,
    mobiles: usize,
    /// GA-21: every LAN IPv4 this host has, server-ordered. The device page's
    /// endpoint picker renders these; empty before the first successful
    /// /api/network read (and on the cloud channel, where the phone must reach
    /// the relay rather than this machine).
    lan_candidates: Vec<String>,
    /// GA-18: milliseconds until `short_code` expires, from the deadline captured
    /// when the minting ack landed. `None` = no code, or a server that sent no
    /// TTL — the modal then shows its static 「valid within 5 minutes」 line instead of a
    /// countdown it cannot back up.
    expires_in_ms: Option<u64>,
    /// v0.2.4 — THIS MACHINE's cross-channel identity (pc_name::machine_uid).
    ///
    /// owner 2026-07-29:「PC 端要有一个唯一的实例名或 ID 来区分是否同一 PC」
    /// ("the PC side needs a unique instance name or ID to distinguish whether
    /// it's the same PC"). It is
    /// derived, not stored, so both channels compute the same value and there is
    /// nothing to reconcile — see pc_name.rs for why the seed folds in the
    /// Windows user. Surfaced on the diagnostics page so the value can be
    /// eyeballed against what the phone shows, rather than only inferred from
    /// whether two rows happened to merge.
    ///
    /// `None` when the machine id could not be read; the page then says so
    /// instead of printing a placeholder that would look like an answer.
    machine_uid: Option<String>,
    /// v0.2.4 — THIS MACHINE's LAN address, ALWAYS, whatever the primary channel is.
    ///
    /// owner 2026-07-29 (device page screenshot): the local-LAN card was showing
    /// `https://flowmic.app`. `endpoint` above deliberately FOLLOWS the SELECTED
    /// channel — it answers 「where should the phone dial right now to pair」, and on the cloud channel a
    /// local NIC is not a pairing destination at all, so the QR must carry the
    /// relay. The LAN card asks a DIFFERENT question: 「what is this channel's address」.
    /// One value was answering both, so whenever cloud was selected the LAN card
    /// printed the relay URL. (RV-27 corrected 「primary」 to 「selected」
    /// here: the endpoint never followed primary, and believing it did is what let
    /// the short_code — which DID follow primary — drift away from it.)
    ///
    /// Empty before the sidecar resolves its address (never a guess).
    lan_endpoint: String,
    /// D2LAN-B2b — the sidecar's LAN TLS public-key fingerprint, for the QR's
    /// `fp=` (design 2026-08-08-design-d2lan-light-encryption.md §4-1).
    ///
    /// LAN ONLY, and for a reason of its own rather than by copying
    /// `lan_candidates` above: the cloud relay is reached over real
    /// `https://flowmic.app` with a real CA chain, so a self-signed pin there
    /// answers a question that channel does not ask. `derivePairingModal` refuses
    /// it a second time on the frontend — two gates, because this snapshot is a
    /// public command result and the modal is the only thing that knows which tab
    /// is on screen.
    ///
    /// `None` = the sidecar published none (serving plain, or an older one). The
    /// QR is then byte-for-byte the pre-D2-LAN payload — the failure direction is
    /// 「fall back to the status quo」, never 「cannot connect」.
    lan_tls_fp: Option<String>,
    /// 0.2.66 — the relay's PUBLIC ADDRESSING id for this PC, `XXXXXXXXX`.
    ///
    /// 🔴 CLOUD ONLY, and unlike `lan_candidates` / `lan_tls_fp` above this gate runs
    /// in the OPPOSITE direction. owner 2026-08-14: 「云端中继需要支持 PCID……本地局域
    /// 网扫码或输入配对码，没有 PCID」 ("the cloud relay needs to support PCID ... a
    /// local LAN scan or entering a pairing code has no PCID"). A standalone sidecar mints none, so on LAN this
    /// is already `None` in practice — [`pcid_for_channel`] is the second gate, and
    /// it exists for the same reason the fingerprint has one: this snapshot is a
    /// public command result, and a value that arrives where the contract says it
    /// cannot exist must die at the boundary rather than be rendered and scanned.
    ///
    /// `None` also for a relay older than this round. The frontend then appends no
    /// `pcid=` and the cloud QR is byte-for-byte the pre-0.2.66 payload — the
    /// failure direction is 「fall back to the status quo」, never a made-up id.
    pcid: Option<String>,
    /// N5 — WHICH channel this whole snapshot describes (`lan` | `cloud`).
    ///
    /// The modal can now switch its pairing target, and the re-read is async, so
    /// between the click and the answer the frontend holds a snapshot belonging to
    /// the OTHER channel. Without this tag it would paint that snapshot's 4-digit
    /// code under the new tab and build a QR whose `channel=` says the new one —
    /// one frame of 「server A's code + channel B's payload」, which is the very pairing
    /// mismatch RV-27 existed to remove. The frontend renders a QR only while this
    /// tag equals the tab on screen.
    channel: &'static str,
}

/// Read the current pairing snapshot for the device page. Never mints a code —
/// use `refresh_pairing_code` for that. The endpoint is the sidecar's PAIRING
/// endpoint (WP-R2-4 supervisor ruling #5): the resolved LAN address `http://<lan-ip>:41879`
/// once /api/network yields one, else the dialed loopback/adopted URL (which the
/// QR builder suppresses — F-2346). Falls back to the env default before bring-up.
///
/// R6 T-2: on the CLOUD channel the phone must reach the RELAY, not this machine —
/// reporting the local sidecar address there would be an outright wrong pairing
/// instruction, so the endpoint follows the pairing channel.
///
/// N5 (owner's requirement ②) — `channel` is that pairing channel, sent by the modal's own
/// local-LAN / cloud-relay switch. Omitted (an older frontend) / unknown ⇒ the CURRENT
/// channel (RV-新B: admission-derived, not a stored preference — that flag is gone).
/// See `resolve_pairing_channel`.
#[tauri::command]
pub fn pairing_code(
    state: State<'_, SocketState>,
    sidecar: State<'_, sidecar_ctl::SidecarState>,
    cloud: State<'_, cloud::CloudState>,
    channel: Option<String>,
) -> PairingInfo {
    // This machine's OWN LAN address, resolved once and reported unconditionally.
    // The LAN card renders THIS; `endpoint` below stays the dial target the QR
    // needs. Two questions, two fields.
    let lan_endpoint = sidecar.pairing_endpoint().unwrap_or_default();
    // RV-新B: the modal's DEFAULT tab is the admission-derived current channel, read
    // before the `with_*` calls below because they lock the same mutex.
    let default_channel = current_channel(&state);
    // RV-27 — the destination CHANNEL and its ADDRESS from one call, so
    // the code below is read off the very server this endpoint points at. See
    // socket::channel::pairing_destination for the divergence this closes.
    let (destination, endpoint) = crate::socket::channel::pairing_destination(
        resolve_pairing_channel(channel.as_deref(), default_channel),
        cloud.snapshot().endpoint,
        sidecar.pairing_endpoint(),
        || crate::socket_config_from_env().url,
    );
    let on_cloud = matches!(destination, crate::socket::Channel::Cloud);
    // On the cloud channel a local NIC is not a pairing destination at all, so no
    // candidates are offered there — an empty list, not a misleading one.
    let lan_candidates = if on_cloud { Vec::new() } else { sidecar.lan_candidates() };
    // D2LAN-B2b: same condition, an independent reason (see the field's doc).
    let lan_tls_fp = if on_cloud { None } else { sidecar.lan_tls_fingerprint() };
    // RV-27: the code + its TTL come from the DESTINATION channel's session, with no
    // fallback to the other one — a code the phone's server never minted is worse
    // than no code, because the modal handles 「no code」 and the phone cannot handle
    // 「someone else's code」.
    //
    // N5 — `connected` / `mobiles` come from that SAME session, and that is a
    // behaviour change worth stating: they used to be read through `with_socket`
    // (primary, with a fallback to the other slot). `connected` is the ONLY input to
    // the modal's 「not connected, cannot generate a pairing code」 branch, so with a per-QR channel switch
    // the primary session's registration is simply a different question — a cloud
    // tab with no relay session would have shown 「no valid pairing code yet, click
    // to refresh」 off a
    // LAN registration, and 「cloud relay not connected」 (a string that has existed since R6
    // T-2) could never be reached at all. Reported per channel, it is now reachable
    // and it is true.
    //
    // 0.2.66 — the PCID rides the SAME read for the same reason the code does: it is
    // that session's answer about that server, and taking it from anywhere else would
    // let the modal show one relay's id beside another one's code.
    let (short_code, expires_in_ms, connected, mobiles, pcid) = with_channel_socket(
        &state,
        destination,
        |s| {
            (
                s.short_code(),
                s.short_code_expires_in_ms(),
                s.is_registered(),
                s.connected_mobiles(),
                s.pcid(),
            )
        },
        (None, None, false, 0, None),
    );
    PairingInfo {
        short_code,
        endpoint,
        // Deliberately NOT per-channel: this is the 「this computer」 card's name, which
        // the device page renders whatever the pairing tab points at. Scoping it to
        // the destination would blank the card to a placeholder the moment the modal
        // looked at a channel with no session. (Whether the two channels can hold
        // two different names is a separate defect, not this card's.)
        pc_name: with_socket(&state, |s| s.credentials().device_name, String::new()),
        connected,
        mobiles,
        lan_candidates,
        expires_in_ms,
        // The uid is a property of the MACHINE, not of the socket, so it is reported
        // even when there is no session at all — that is precisely the state in
        // which the owner needs to compare it against the phone.
        machine_uid: crate::pc_name::machine_uid(),
        lan_endpoint,
        lan_tls_fp,
        pcid: pcid_for_channel(destination, pcid),
        channel: destination.tag(),
    }
}

#[cfg(test)]
mod tests {
    use super::{pcid_for_channel, resolve_pairing_channel};
    use crate::socket::channel::pairing_destination;
    use crate::socket::Channel;

    const RELAY: &str = "https://flowmic.app";
    const LAN: &str = "http://10.0.0.78:41879";
    const DIALED: &str = "http://127.0.0.1:41879";

    #[test]
    fn an_explicit_pairing_channel_beats_the_default_in_both_directions() {
        // The REVERSE assertion is the point of this test: a resolver that ignored
        // the argument and returned the default would still pass a one-directional
        // 「cloud arrives as cloud」 check whenever cloud happened to be the default,
        // and the whole card is about the modal being able to pick the OTHER channel.
        assert_eq!(resolve_pairing_channel(Some("cloud"), Channel::Lan), Channel::Cloud);
        assert_eq!(resolve_pairing_channel(Some("lan"), Channel::Cloud), Channel::Lan);
        assert_eq!(resolve_pairing_channel(Some("cloud"), Channel::Cloud), Channel::Cloud);
        assert_eq!(resolve_pairing_channel(Some("lan"), Channel::Lan), Channel::Lan);
    }

    #[test]
    fn a_missing_or_unparseable_pairing_channel_keeps_the_pre_n5_behaviour() {
        // Regression protection: an older frontend invokes both commands with no
        // argument at all, and it must still be handed the CURRENT channel's code —
        // never a silent jump to a channel nobody is on.
        for active in [Channel::Lan, Channel::Cloud] {
            assert_eq!(resolve_pairing_channel(None, active), active);
            assert_eq!(resolve_pairing_channel(Some(""), active), active);
            assert_eq!(resolve_pairing_channel(Some("saas"), active), active);
            assert_eq!(
                resolve_pairing_channel(Some("LAN"), active),
                active,
                "the tags are the machine tags — case-sensitive, no fuzzy matching"
            );
        }
    }

    /// 0.2.66 — owner:「本地局域网……没有 PCID」 ("local LAN ... has no PCID").
    ///
    /// 🔴 THE REVERSE CONTROL IS THE LAN ARM, and it is written against a session
    /// that DID report one. Testing only 「cloud passes it through」 would stay green
    /// against `pcid: reported` with no gate at all — i.e. against the exact defect
    /// this gate exists to prevent — and testing only 「LAN is None」 would stay green
    /// against a gate that drops the id on both channels, which is the feature not
    /// existing. Both arms, or neither is evidence.
    #[test]
    fn a_lan_snapshot_never_carries_a_pcid_even_when_the_session_reports_one() {
        let reported = || Some("302914775".to_string());
        assert_eq!(pcid_for_channel(Channel::Cloud, reported()), reported());
        assert_eq!(pcid_for_channel(Channel::Lan, reported()), None);
        // An absent id stays absent on BOTH channels — 「absent」 is never upgraded to a
        // placeholder, on either side of the gate.
        assert_eq!(pcid_for_channel(Channel::Cloud, None), None);
        assert_eq!(pcid_for_channel(Channel::Lan, None), None);
    }

    #[test]
    fn the_resolved_channel_is_the_one_the_endpoint_is_computed_from() {
        // The two halves must COMPOSE: whatever the modal asked for is the channel
        // whose address comes back, so the snapshot can never carry one server's
        // 4-digit code beside the other server's URL. RV-27 established that for the
        // preference; this keeps it true for an explicit per-QR request.
        for (tag, expect_ep) in [("lan", LAN), ("cloud", RELAY)] {
            let resolved = resolve_pairing_channel(Some(tag), Channel::Lan);
            let (ch, ep) = pairing_destination(
                resolved,
                RELAY.to_string(),
                Some(LAN.to_string()),
                || DIALED.to_string(),
            );
            assert_eq!(ch, resolved, "the destination is never silently swapped");
            assert_eq!(ep, expect_ep);
        }
    }
}

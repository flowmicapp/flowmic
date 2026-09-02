// `ReconnectAckVerdict` / `on_reconnect_ack` moved VERBATIM out of `pairing.rs`
// at that file's 800-line cap (same precedent as `refusal.rs` and
// `roster_apply.rs`, both split out of the same file for the same reason).
// Nothing here changed in the move; the auth surface stays the file's own
// (pairing.rs is still `*** HUMAN-AUDIT SENSITIVE (pairing/auth) ***`, and
// this sibling inherits that scope).

use serde_json::Value;

use crate::forensic;
use crate::socket::pairing::Pairing;
use crate::socket::reconcile::Reconciler;
use crate::socket::roster_apply::apply_connected_mobiles;
use crate::socket::wire;

/// What a `pc:reconnect` ack decided. Same split as `RegisterAckVerdict`
/// (`pairing.rs`).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReconnectAckVerdict {
    /// `{error}` — the DEVICE token is dead. Token cleared + presence reset here;
    /// the caller emits a fresh `pc:register` on the socket it still holds.
    DeadToken,
    /// `{error: AUTH_TOKEN_EXPIRED}` — the ACCOUNT credential lapsed (#6
    /// zombie-room gate). Refusal reported (hook → shell clears the Cloud Key
    /// and drops the socket); the pairing credential survives untouched, and
    /// the caller emits nothing further on a refused identity.
    AccountRefused,
    /// `{error: AUTH_TOKEN_UNVERIFIABLE}` (A11/F2-a, WP-8) — a multi-node
    /// replica could not confirm this token either way. Token kept, caller
    /// emits nothing further (same as `AccountRefused`) — the existing
    /// register/reconnect watchdog re-tries later, on the SAME token.
    Unverifiable,
    /// Accepted; the caller re-asserts this PC's name.
    Accepted,
}

/// The decision half of the `pc:reconnect` ack (see `ReconnectAckVerdict`).
pub(super) fn on_reconnect_ack(obj: &Value, p: &Pairing, rec: &Reconciler) -> ReconnectAckVerdict {
    if let Some(err) = obj.get("error") {
        if err.as_str() == Some("AUTH_TOKEN_EXPIRED") {
            // #6 zombie-room gate: the handshake jwt this socket presented has
            // lapsed (server pc.handler refuses the reconnect so an expired
            // login can no longer sit in its room). This is an ACCOUNT refusal,
            // not a dead device token — clearing the token here would wipe the
            // cloud pairing and force every phone to re-pair over an account-key
            // lapse. Only EXPIRED is safely routable (module-note collision).
            eprintln!("[flowmic] pc:reconnect REFUSED: AUTH_TOKEN_EXPIRED — account credential lapsed, pairing kept");
            p.clear_handshake_ack("pc:reconnect refused — account credential lapsed");
            p.report_refusal("pc:reconnect", "AUTH_TOKEN_EXPIRED");
            return ReconnectAckVerdict::AccountRefused;
        }
        if err.as_str() == Some("AUTH_TOKEN_UNVERIFIABLE") {
            // A11/F2-a (WP-8) — could not tell whether this token is good.
            // Deliberately NOT `report_refusal`: its `IdentityHandshake`
            // authority would let `shell::cloud::auth_failure_hook` read this
            // as an identity verdict worth a sign-out — exactly the false
            // positive A11/F2-a exists to stop. No claim about account or
            // device; only about this node's ability to answer right now.
            eprintln!("[flowmic] pc:reconnect: AUTH_TOKEN_UNVERIFIABLE — token kept, will ask again");
            forensic::record("socket", "pc:reconnect unverifiable — token kept, connection unconfirmed");
            p.clear_handshake_ack("pc:reconnect unverifiable — this connection is not confirmed yet");
            return ReconnectAckVerdict::Unverifiable;
        }
        // Dead DEVICE token — clear + re-register (never loop a dead token). This is
        // recovery, not an account refusal: the hook stays out of it, and the
        // following register carries the verdict if the identity is the problem.
        eprintln!("[flowmic] pc:reconnect rejected — clearing token, re-registering");
        forensic::record("socket", "pc:reconnect rejected — clearing token, re-registering");
        if let Ok(mut c) = p.creds.lock() {
            c.clear_token();
            let _ = c.save(&p.path);
        }
        // RV-34: the server just said it does not know this token. Whatever this
        // connection was granted earlier, it is not granted now.
        p.clear_handshake_ack("pc:reconnect rejected — dead token");
        rec.reset();
        return ReconnectAckVerdict::DeadToken;
    }
    // RV-34: the reconnect leg gets the same "the server recognized me" stamp as register —
    // which is what finally puts this leg under the pump's register watchdog.
    p.mark_handshake_acked("pc:reconnect");
    // 0.2.66: a token reconnect mints NO code, so this is the ONLY ack a restarted
    // desktop gets — without it the PCID row would exist only for the session that
    // first registered.
    p.adopt_pcid(obj);
    // Success: reconcile the mobile presence count (07 §6). An empty snapshot within
    // 2 s of a fresh join is SUPPRESSED so a mobile that joined during the handshake
    // is not zeroed.
    apply_connected_mobiles("pc:reconnect", obj, p, rec);
    let (_t, pc_id, room) = wire::parse_register_ack(obj);
    if pc_id.is_some() || room.is_some() {
        if let Ok(mut c) = p.creds.lock() {
            if pc_id.is_some() {
                c.pc_id = pc_id;
            }
            if room.is_some() {
                c.room_uuid = room;
            }
            let _ = c.save(&p.path);
        }
    }
    ReconnectAckVerdict::Accepted
}

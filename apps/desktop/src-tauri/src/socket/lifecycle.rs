// SPEC-REF:
//   apps/desktop/src-tauri/src/socket/client.rs (the caller; RV-34 handshake
//     judgment, GA-28 primary/presence dual channel)
//
// The socket.io transport's own "open"/"close" events — split out of
// client.rs at its 800-line cap, the same move that already produced
// fanout.rs (see that file's header): `builder: ClientBuilder -> ClientBuilder`
// so a chain of `.on()` registrations stays one line each at the call site.

use rust_socketio::ClientBuilder;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::forensic;
use crate::socket::pairing::{self, Pairing};
use crate::socket::reconcile::Reconciler;

/// register or reconnect (fires on initial connect AND each reconnect)
pub(in crate::socket) fn wire_open(
    builder: ClientBuilder,
    pairing_state: Arc<Pairing>,
    reconciler: Arc<Reconciler>,
    connected: Arc<AtomicBool>,
) -> ClientBuilder {
    let p_o = pairing_state;
    let rec_o = reconciler;
    let conn_o = connected;
    builder.on("open", move |_payload, socket| {
        conn_o.store(true, Ordering::SeqCst);
        // RV-34: a NEW connection carries none of the previous one's standing. The
        // ack that confirmed the last socket says nothing about this one, and the
        // handshake below is what has to earn the claim again — so the judgment
        // starts false here, which is also what arms the pump's watchdog.
        p_o.clear_handshake_ack("new socket — the handshake starts over");
        // 「本机存着 token 吗」("does this machine have a token stored") is the
        // ONE question that decides which frame to
        // send, and it is the only thing this variable is allowed to answer.
        let has_token = p_o.creds.lock().map(|c| c.is_registered()).unwrap_or(false);
        eprintln!("[flowmic] socket open (has_token={has_token})");
        forensic::record("socket", &format!("open (has_token={has_token})"));
        // connected rising edge → pc:reconnect (07 §6); a fresh session registers.
        if has_token {
            pairing::emit_reconnect(&socket, &p_o, &rec_o);
        } else {
            pairing::emit_register(&socket, &p_o, &rec_o);
        }
    })
}

/// mark disconnected so the pump forwards the transition; the settings/timeline
/// queues flush again on the next open.
/// rust_socketio 0.6 also has Event::Error; it is NOT registered. An earlier
/// comment claimed "close / error" — only `"close"` is wired. `"open"` is the
/// sole room-entering emitter; Error is not a second handshake author. Engine
/// Close that never becomes `"close"` (Edge 1) is detected at the pump's
/// heartbeat emit (`socket::hb_death`).
pub(in crate::socket) fn wire_close(
    builder: ClientBuilder,
    pairing_state: Arc<Pairing>,
    connected: Arc<AtomicBool>,
) -> ClientBuilder {
    let conn_c = connected;
    let p_c = pairing_state;
    builder.on("close", move |_payload, _socket| {
        conn_c.store(false, Ordering::SeqCst);
        // RV-34: the connection the server confirmed is gone. The TOKEN survives
        // (that is the point of a token, and the reconnect ladder needs it), but
        // 「服务端认了我」("the server recognized me") does not survive the socket it was granted on — that
        // conflation is what put `connected=false registered=true` in the log.
        p_c.clear_handshake_ack("socket closed");
        eprintln!("[flowmic] socket close");
        forensic::record("socket", "close");
    })
}

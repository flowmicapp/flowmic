// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (a closed session stops dialing; sign-out
//     ends contact with the relay until the next sign-in)
//   docs/marketing/verification-reports/V-LAN-speech-path.md §7 ② (the measurement)
//   *** HUMAN-AUDIT SENSITIVE (auth: when the account credential leaves this PC) ***
//
// D-MKT-21 — dropping a `DesktopSocket` closes the transport but cannot end the
// library's polling thread, and that thread carries the handshake auth.
//
// Read from the registry copy of `rust_socketio` 0.6.0, `src/client/client.rs`:
//   · `poll_callback` runs on a CLONE of the `Client`, so `Client::disconnect` on
//     our handle does not touch it, and the crate has no shutdown call;
//   · a transport error or a server `Disconnect` packet sends that thread to
//     `reconnect()` → `do_reconnect()` → `builder.clone().connect_raw()`, and
//     `builder` still holds `.auth({"jwt": …})` from `socket::connect`.
// So every session we closed went on presenting its Cloud Key. The `open` handler's
// closing latch (F-3 Fix#1) held back `pc:register` / `pc:reconnect`, which is
// exactly why the relay saw an unidentified socket and closed it at
// `DEFAULT_UNAUTH_TTL_MS` (60 s, server-core `socket/connection-guard.ts`). The next
// rung of the ladder then dialed again: the 65 s pattern measured after a sign-out.
//
// THE STOP. `RawClient::poll` runs the `error` callback on the polling thread before
// it returns the error that would start `reconnect()`, and `open` runs on that same
// thread. A callback cannot return a verdict, so the only way out of the library's
// loop is to unwind the thread from inside one. `resume_unwind` does that without
// the panic hook: this is a planned end of a thread, not a fault, and it must not
// write a `panic` forensic line. The `on` mutex the callback sits under is poisoned
// by the unwind; `RawClient::callback` answers `Err` from then on and every caller
// of it on a dead session ignores that (`let _ =` in `RawClient::disconnect`).
//
// ⚠️ NEVER FROM THE `close` HANDLER. `RawClient::disconnect` runs `close` on the
// CALLER's thread, which is ours (the main thread at sign-out). Unwinding there
// would take the wrong thread down.
//
// ⚠️ WHAT THIS CANNOT REACH. A session parked inside the library's own `reconnect()`
// retry loop because the network is down has no callback to run; when the network
// returns it completes one connection, its CONNECT packet carries the old key once,
// and the `open` arm then ends it. A library fork with a real shutdown call is the
// only way to close that last case.
//
// THE SECOND WAY THE THREAD OUTLIVED ITS SESSION (2026-11-10, the 1-of-32 residue).
// `Client::disconnect` sets the Engine.IO socket's `connected` flag to false. If the
// polling thread is blocked in its read at that moment, the read fails and `error`
// runs: the stop above. If it is NOT in a read (it is handling a packet that just
// arrived, i.e. inside one of our handlers), its next `poll` sees `connected ==
// false` and answers `Ok(None)` without reading (rust_engineio 0.6 `socket.rs`
// `poll`). `Iter::next` turns that into `Err(StoppedEngineIoSocket)`, which runs no
// callback and is not one of the two errors that start `reconnect()`, so the `for`
// loop asks again, forever: a thread spinning a core, holding a `Client` clone and
// with it the websocket, which nobody closes from this side. Measured in
// tests/session_stop.rs `a_close_that_lands_while_a_packet_is_handled_still_ends_the_thread`.
// So the end of every handler that runs on the polling thread is a stop point too.
// POLLING_THREAD_CHECKPOINTS: `lifecycle::wire_open` (start and end),
// `lifecycle::wire_error`, `lifecycle::wire_any` (after every incoming event's own
// handler), and the two handshake ack callbacks in `pairing::emit_register` /
// `pairing::emit_reconnect`. Still uncovered: the device-page ack callbacks in
// `socket::outbound` (a sign-out has to land inside one of those), and the few
// instructions between a checkpoint and the next `poll`.

use std::sync::{Arc, Mutex};

use rust_socketio::client::Client;

use crate::forensic;
use crate::socket::channel::Channel;
use crate::socket::pairing::Pairing;
use crate::socket::session_gen::process_generations;

// `resume_unwind` under `panic = "abort"` would end the whole app at every sign-out.
// No profile in Cargo.toml sets it today; this keeps it that way.
#[cfg(panic = "abort")]
compile_error!("socket::session_stop ends the polling thread by unwinding; it needs panic = \"unwind\"");

/// A closed cloud session that may still come back on its own (see
/// [`remember_if_it_can_come_back`]), with the handle that can still reach it.
struct Lingering {
    pairing: Arc<Pairing>,
    client: Client,
}

static LINGERING_CLOUD: Mutex<Vec<Lingering>> = Mutex::new(Vec::new());

/// Called while a session closes. Almost every close is final and its polling thread
/// ends by itself. The exception is the heartbeat-death rebuild
/// (`Pairing::mark_transient_close`): when its redial fails, W8-2 lets this closed
/// session re-register once the network returns, and from then on it is the PC's only
/// live connection, in no slot, with nothing able to reach it. A sign-out has to be
/// able to. Holding a `Client` clone keeps that session's memory until it ends or the
/// next close prunes it.
pub(super) fn remember_if_it_can_come_back(pairing: &Arc<Pairing>, client: &Client) {
    if pairing.channel != Channel::Cloud {
        return;
    }
    let mut list = LINGERING_CLOUD.lock().unwrap_or_else(|p| p.into_inner());
    list.retain(|l| !l.pairing.reconnect_is_over());
    if !pairing.reconnect_is_over() {
        list.push(Lingering { pairing: pairing.clone(), client: client.clone() });
    }
}

/// The account credential was withdrawn (sign-out, or the relay refused it): every
/// cloud session built so far may never speak again, including one in no slot.
///
/// The generation bump is what makes that final for all of them at once
/// (`session_gen::closing_is_final`); a session built after this has a newer
/// generation and carries the new key. Closing the lingering ones runs off the
/// caller's thread because this is called on the main thread at sign-out, and a
/// stalled socket must not stall the window.
pub fn withdraw_cloud_sessions() {
    process_generations().supersede(Channel::Cloud);
    let lingering = std::mem::take(&mut *LINGERING_CLOUD.lock().unwrap_or_else(|p| p.into_inner()));
    if lingering.is_empty() {
        return;
    }
    forensic::record("socket", &format!("closing {} lingering cloud session(s)", lingering.len()));
    std::thread::spawn(move || {
        for l in lingering {
            // Its polling thread then fails the read, runs `error`, and ends. If it
            // sits in the library's retry loop instead, the `open` arm ends it.
            let _ = l.client.disconnect();
        }
    });
}

/// Ends the CURRENT thread when this session has nothing left to do. Call ONLY from a
/// callback that runs on the polling thread (`error`, `open`), see the file header.
pub(super) fn end_polling_thread_if_over(pairing: &Pairing, at: &str) {
    if pairing.reconnect_is_over() {
        forensic::record(
            "socket",
            &format!("closed session stopped dialing (channel={}, at {at})", pairing.channel.tag()),
        );
        std::panic::resume_unwind(Box::new("closed session: polling thread ended"));
    }
}

// The behaviour is pinned against the real library in tests/session_stop.rs.

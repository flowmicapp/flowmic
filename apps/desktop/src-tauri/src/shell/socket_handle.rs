// NR-48 — the lock discipline for the five device-page verbs that BLOCK on a
// sidecar ack (up to 5.5 s). Split out of shell/mod.rs for the 800-line
// file-size cap (same reason as `tray` / `settings_route` / `paired`), not for
// any architectural claim: the two helpers below are the whole reason the
// device page no longer holds `SocketState` while it waits.
//
// Before NR-48 the five verbs ran their `recv_timeout` INSIDE `with_*_socket`'s
// guard, so one 「refresh phones」 froze every other `SocketState`-touching
// command for 5.5 s × 2 (ledger §36). The fix is the same shape as P1-2's
// injection-path split (`socket/local_inject.rs`): clone the send handle out of
// the lock, drop the guard, then run the slow wait outside.

use super::{Sessions, SocketState};

/// NR-48 — the lock discipline the five device-page verbs (rename / kick /
/// refresh-code / refresh-list / settings-list) now share: clone `T` out from
/// behind the `SocketState` lock (microseconds), DROP the guard, and only then
/// run `f` — the slow sidecar-ack wait — OUTSIDE the lock.
///
/// Before this, the verbs ran their up-to-5.5 s `recv_timeout` INSIDE
/// `with_*_socket`'s guard, so a single 「refresh phones」 froze every other
/// `SocketState`-touching command for 5.5 s × 2 (see the ledger §36 / NR-48).
///
/// 🔴 The guard MUST NOT be held while `f` runs. Reverting this to
/// `Ok(guard) => f(clone(&guard))` re-introduces NR-48, and the reverse-control
/// test `the_lock_is_released_before_the_slow_verb_runs` goes red.
///
/// Generic over the clone (`T`) so that test can prove the discipline without a
/// live socket: it passes a trivial clone and a slow `f`.
fn clone_then_run<T, R>(
    state: &SocketState,
    clone: impl FnOnce(&Sessions) -> Option<T>,
    f: impl FnOnce(Option<T>) -> R,
) -> R {
    let handle = match state.lock() {
        Ok(guard) => clone(&guard),
        Err(_) => None,
    };
    f(handle)
}

/// NR-48 — clone the SEND-side handle of the socket on `channel` (or the PRIMARY
/// socket when `None`) out from behind the lock, drop the guard, then run `f` on
/// the handle OUTSIDE the lock. This is the fast-ACK-wait replacement for
/// `with_socket` / `with_channel_socket` on the five device-page verbs: the
/// closure here is expected to BLOCK on the sidecar (see [`clone_then_run`]).
pub(crate) fn with_socket_handle<R>(
    state: &SocketState,
    channel: Option<crate::socket::Channel>,
    f: impl FnOnce(Option<crate::socket::outbound::OutboundHandles>) -> R,
) -> R {
    clone_then_run(
        state,
        |g| {
            match channel {
                Some(c) => g.slot(c),
                None => g.primary(),
            }
            .map(|s| s.outbound_handles())
        },
        f,
    )
}

#[cfg(test)]
mod socket_handle_lock_tests {
    use super::{with_socket_handle, Sessions, SocketState};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// NR-48 reverse control — the `SocketState` lock must be released BEFORE the
    /// slow verb (the up-to-5.5 s sidecar ack wait) runs. `with_socket_handle` is
    /// the helper all five device-page verbs now call; it clones the send handle
    /// out of the lock and runs the closure OUTSIDE it. The `Sessions` here has no
    /// live socket (a live socket would need a real `Client`), so the clone yields
    /// `None` — irrelevant to the discipline: the slow closure still runs, and the
    /// question is only whether the guard is held while it does.
    ///
    /// Reverting `clone_then_run` (which `with_socket_handle` delegates to) to
    /// `Ok(guard) => f(clone(&guard))` runs the closure INSIDE the guard, so the
    /// spawned thread holds the lock for the whole 300 ms and this assertion goes
    /// red (the main thread's `lock()` blocks ≈250 ms).
    #[test]
    fn the_lock_is_released_before_the_slow_verb_runs() {
        let state = Arc::new(SocketState::new(Sessions::new(crate::socket::Channel::Lan)));
        let probe = Arc::clone(&state);
        let runner = std::thread::spawn(move || {
            with_socket_handle(&probe, None, |_handles| {
                // The slow verb — 300 ms standing in for `OutboundHandles`'
                // `recv_timeout`.
                std::thread::sleep(Duration::from_millis(300));
            });
        });

        // Head start so a lock-holding (pre-fix) helper would already be parked on
        // the mutex by now.
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let guard = state.lock().expect("the lock must be uncontended");
        let acquired_in = started.elapsed();
        drop(guard);
        runner.join().expect("the slow verb thread must finish");

        assert!(
            acquired_in < Duration::from_millis(100),
            "the SocketState lock was held during the slow verb: took {acquired_in:?} to acquire"
        );
    }
}

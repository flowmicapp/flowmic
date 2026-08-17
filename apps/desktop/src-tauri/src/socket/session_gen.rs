// W8-2 — per-channel monotonic count of CONSTRUCTED socket sessions.
//
// WHY THIS EXISTS (ledger row W8-2, docs/strategy/2026-08-08-030-unified-plan-
// and-ledger.md): the F-3 Fix#1 `closing` latch on `Pairing` suppresses a dying
// session's `pc:register`/`pc:reconnect` forever, on the strength of one
// assumption written in its own doc comment — "`socket::connect` builds a fresh
// `Pairing` per session", i.e. a successor session exists to speak for this
// machine. On a real machine (2026-08-10, dev-pc-a) that assumption
// failed: the sidecar was killed twice, the watchdog brought a new one up, and
// the successor session was NEVER constructed (the replacement rides
// `run_on_main_thread` + one un-retried dial) — so the only session the process
// had kept answering every fresh `open` with "SUPPRESSED — this session is
// closing" and the PC vanished from the server (`pc_devices.last_seen_at`
// froze) until the whole app was restarted. Fourth-class structural defect,
// third occurrence: a latch closed pending a remote/foreign event ("my
// replacement is up") with no local watchdog.
//
// This counter is the piece of evidence the latch was missing: "was a session
// for my channel constructed AFTER me?". With it, the suppression gate in
// `pairing.rs` can tell the two closing states apart:
//   • successor constructed  → suppress forever (the exact F-3 Fix#1
//     protection: a zombie must not steal the room slot from the live session);
//   • NO successor, and the close has gone stale → release the handshake,
//     loudly (`ClosingGate::Release`) — a machine with one half-dead session is
//     better represented by that session than by nothing at all.
//
// WHY A COUNTER AND NOT A HANDLE: the socket layer must not reach into the
// shell's `SocketState` slots (layering — the shell owns the slots), and the
// question is ordinal, not referential: "did anyone come after me", never
// "who". Two u64 cells answer it without a single lock.
//
// The counter is bumped by `Pairing::mark_constructed`, which `socket::connect`
// calls ONLY after `builder.connect()` succeeded — a session that failed to
// construct must not count as a successor, or the exact W8-2 state (suppressed
// forever with nothing to show for it) would be re-created by a failed dial.
//
// Tests build their own `SessionGenerations` (see `pairing_tests.rs`), so
// parallel tests never race each other through the process-wide instance.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::socket::channel::Channel;

/// Per-channel construction counter. Generation 0 means "no session ever
/// constructed" — real sessions are numbered from 1.
#[derive(Debug, Default)]
pub struct SessionGenerations {
    lan: AtomicU64,
    cloud: AtomicU64,
}

impl SessionGenerations {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn cell(&self, channel: Channel) -> &AtomicU64 {
        match channel {
            Channel::Lan => &self.lan,
            Channel::Cloud => &self.cloud,
        }
    }

    /// A session on `channel` finished constructing — returns ITS generation.
    pub(crate) fn constructed(&self, channel: Channel) -> u64 {
        self.cell(channel).fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The newest generation ever constructed on `channel` (0 = none).
    pub(crate) fn latest(&self, channel: Channel) -> u64 {
        self.cell(channel).load(Ordering::SeqCst)
    }
}

/// The one process-wide instance production sessions share. Sessions must
/// compare generations against the SAME registry or "did anyone come after me"
/// has no answer — this is why `socket::connect` takes no registry parameter:
/// there is exactly one production registry by construction.
pub(crate) fn process_generations() -> Arc<SessionGenerations> {
    static REGISTRY: OnceLock<Arc<SessionGenerations>> = OnceLock::new();
    REGISTRY.get_or_init(SessionGenerations::new).clone()
}

// ── The decision made on the counter (moved VERBATIM from pairing.rs at the
//    800-line cap; `Pairing::handshake_gate` is the only caller) ──────────────

/// W8-2 — what the handshake funnel does with an emit on a (possibly closing)
/// session. See `Pairing::handshake_gate` for who runs this and where.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ClosingGate {
    /// Not closing — emit as always.
    Open,
    /// Closing, and staying quiet is right (F-3 Fix#1): either a successor
    /// session was constructed (it speaks for this machine now), or the close is
    /// too fresh to call abandoned, or the channel's successorless close is a
    /// deliberate state (cloud).
    Suppress,
    /// Closing, but NO successor was ever constructed and the close has gone
    /// stale — emit, and say so loudly (`Pairing::record_release`).
    Release,
}

/// How long a LAN close may stand successorless before the latch is judged
/// abandoned. Generous against the normal swap (which constructs the successor
/// BEFORE `begin_closing`, so the generation arm suppresses it regardless of
/// time), and short enough that recovery lands within the reconnect ladder's
/// early rungs.
pub(super) const CLOSING_RELEASE_AFTER: Duration = Duration::from_secs(10);

/// The attempt arm of the same judgment: this many handshakes already swallowed
/// on a still-successorless close mean the swap had ≥2 full reconnect cycles of
/// wall time to construct a replacement and did not. In the W8-2 real-machine
/// trace exactly three `open`s arrived before the zombie's reconnect thread also
/// wedged — a time arm alone (first opens land inside any reasonable grace)
/// would have released nothing; the attempt arm fires on the third.
pub(super) const CLOSING_RELEASE_AFTER_ATTEMPTS: u32 = 2;

/// W8-2 — the pure decision (unit-testable without threads or clocks): may a
/// CLOSING session's handshake go out?
///
/// * `my_generation` / `latest_generation` — from the shared
///   [`SessionGenerations`]; `latest > mine` means a successor session was
///   CONSTRUCTED after this one. That is the F-3 Fix#1 case, and it suppresses
///   FOREVER, unconditionally — a zombie must never take the room slot back from
///   a live session, and this arm is deliberately checked first.
/// * cloud never releases: the cloud slot's successorless closes are DELIBERATE
///   states (Cloud Key refused / not configured — `channel_session::drop_socket`,
///   `sidecar_ctl::connect_cloud`), where a resurrected zombie would re-present a
///   refused or user-removed identity. The LAN channel has no such state: since
///   GA-28 it is always wanted (`sidecar_ctl::sidecar_retry`'s header), so a
///   successorless LAN close is only ever a swap that failed to complete.
/// * `prior_suppressed` / `closed_for` — the two staleness arms (see the two
///   constants above); either suffices.
///
/// 🔴 THE CLOUD ARM IS DERIVED, NOT STATED — READ THIS BEFORE CHANGING IT
/// (audited 2026-08-16; nothing below is implemented, this is the evidence for
/// the next person, not a plan that was carried out).
///
/// The bullet above argues that a successorless CLOUD close is always
/// deliberate. That is an ASSUMPTION of exactly the kind W8-2 already falsified
/// once for LAN: the code that tears the session down knows whether the close is
/// final, and this function does not ask it — it infers the answer from the
/// channel tag. Measured call graph (`shell/`, 2026-08-16):
///   · DELIBERATE, cloud: `channel_session::drop_socket` (`set_socket(Cloud,
///     None)`, reached from `shell/cloud.rs` on a refused/removed Cloud Key) and
///     `sidecar_ctl::connect_cloud`'s not-dialable arm. A zombie released here
///     would re-present an identity the user or the server has withdrawn — the
///     suppression is right, and it must survive any change.
///   · DELIBERATE, both channels: `shell/offline.rs`'s manual offline switch
///     empties BOTH slots. Today the LAN half of that is released by the
///     staleness arms, i.e. a stale successorless LAN close taken while the user
///     asked to be offline can re-register. [unverified — reasoned from the call
///     graph, never observed.]
///   · TRANSIENT: `sidecar_ctl`'s bring-up-failed arm and `channel_session`'s
///     dial-failed arm also empty a slot, and both want to come back. So
///     「the slot was emptied」 is NOT the fact 「this close is final」, and a gate
///     that inferred finality from `sock.is_none()` would re-create W8-2 on the
///     very path W8-2 came from.
/// ⇒ The minimal honest shape is to carry the INTENT: `begin_closing(intent)`
/// stamps it on the `Pairing`, this function takes `final_close: bool` in place
/// of `channel`, and the deliberate sites above say so. It is not done here
/// because the intent can only be stated at those sites, which are outside this
/// change's scope — and an in-fence half (flip the gate to release for any cloud
/// close nobody marked) would REGRESS the removed-Cloud-Key path: that zombie's
/// transport is still authenticated at the relay, so releasing it would put the
/// PC back online on a key the user just removed. Half of this change is worse
/// than none of it.
/// ⚠️ The successorless-cloud arm has no consequence test today; the successor
/// arm does (`pairing_tests::the_f3_protection_holds_forever_once_a_successor_
/// is_constructed`).
pub(super) fn closing_gate(
    channel: Channel,
    my_generation: u64,
    latest_generation: u64,
    prior_suppressed: u32,
    closed_for: Option<Duration>,
) -> ClosingGate {
    if latest_generation > my_generation {
        return ClosingGate::Suppress; // a successor exists — F-3 Fix#1, forever
    }
    if channel != Channel::Lan {
        return ClosingGate::Suppress; // cloud: successorless close is deliberate
    }
    let stale = prior_suppressed >= CLOSING_RELEASE_AFTER_ATTEMPTS
        || closed_for.is_some_and(|d| d >= CLOSING_RELEASE_AFTER);
    if stale {
        ClosingGate::Release
    } else {
        ClosingGate::Suppress
    }
}

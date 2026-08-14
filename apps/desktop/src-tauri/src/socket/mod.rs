// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer).
//
// Socket.io client to server-core: the connection + handler wiring (client.rs),
// the register/reconnect auth surface (pairing.rs), pure payload mapping
// (wire.rs), local pairing-credential persistence (credentials.rs), and the
// two-channel model + cloud-relay state (channel.rs), and — since GA-28 keeps
// BOTH channels resident — the capsule-ownership latch that decides which one is
// primary and refuses a second phone (admission.rs).

pub mod admission;
pub mod bridge;
pub mod channel;
pub mod client;
pub mod credentials;
pub mod dedup;
/// The server→frontend fan-out seam (GA-28 primary gate + RV-01 channel stamp),
/// split out of client.rs at the 800-line cap like inject_ops.rs / pump.rs.
pub mod fanout;
/// The inject/control decision core, split out of client.rs at the 800-line cap
/// (same move that produced pump.rs) — target resolution, allowlist, the two runners.
pub mod inject_ops;
/// 0.2.27 — Reinject without a wire: the one injection nothing on the socket asked for.
/// Split from client.rs by responsibility (that file is the socket LIFECYCLE); see its
/// header for why it must share the session's FSM and dedup table rather than own one.
pub mod local_inject;
pub mod outbound;
pub mod pairing;
/// The mobile-presence WIRE EDGES (pc:mobile-joined / pc:mobile-left), split out of
/// client.rs at the 800-line cap like fanout.rs / pump.rs / inject_ops.rs. Separate
/// from `reconcile` next to it because that one owns the presence SET and names no
/// socket at all (which is what keeps it unit-testable); this is the seam where a
/// frame becomes a call on it, plus the `Admission` verdict a set cannot make.
pub mod presence;
pub mod pump;
pub mod reconcile;
/// 0.2.28+ — "one delivery frame → one timeline row". The server stopped storing (and therefore
/// broadcasting) transcripts, so a delivery frame is now the ONLY way a new row
/// reaches the PC timeline (owner architecture ruling, transit-not-storage). Split from
/// client.rs for the same reason inject_ops / local_inject were: client.rs is the
/// socket LIFECYCLE, and this is a decision about what a row IS.
pub mod row_transit;
/// RV-93 — size B on the PC: the DELIVERED picture, kept on disk so an image row's
/// full-image view shows the real thing instead of an enlarged 256 px thumbnail. Separate
/// from row_transit because it is a STORAGE decision, not a decision about what a
/// row is; see its header for why the bytes cannot live on the row itself.
pub mod row_image;
/// REQ-12-13 (owner P0, 2026-08-12) — "one remote keypress → one PC timeline row". Separate from
/// row_transit because a keypress row is not a delivery: it carries no text to type,
/// no mode, no `source_text`, and its outcome comes from a `ChordExit` rather than
/// from an `inject:result`. Contract: docs/rebuild/15 §2.0-e.
pub mod control_row;
/// RV-26/RV-34: the registration latch's local watchdog ("connected but the server doesn't recognize it" →
/// re-emit pc:register with backoff and a loud cap), split out of pump.rs at the
/// 800-line cap so the auth-adjacent decision is auditable on its own.
pub mod register_watchdog;
pub mod roster_apply;
/// F3 (owner 2026-08-02 "the tray stays a red dot but I'm not speaking"): the SPEAKING lock's OTHER
/// local watchdog — the one that times the FSM STATE rather than the `audio:start`
/// EVENT, so a lock nobody armed a deadline for is still watched, and a genuinely
/// long utterance is not force-released mid-sentence. Its own module because the
/// decision is a red-line backstop that has to be readable without the pump around
/// it (same reason register_watchdog left pump.rs).
pub mod speak_liveness;
/// W8-2: per-channel count of CONSTRUCTED sessions — the local evidence the F-3
/// Fix#1 `closing` latch needs to tell "my successor is up, stay quiet forever"
/// from "no successor was ever built, and staying quiet erases this PC from the
/// server". See its header for the real-machine trace that forced it.
pub mod session_gen;
// `timeline_ops` (RV-01's four outbound history verbs + their ack contract) was
// DELETED in 0.2.27: the server stores no transcripts, so list / update / delete /
// inject have no object to act on. The PC owns its rows (0.2.26) — it edits and
// deletes them locally, and reinject runs the local pipeline
// (`DesktopSocket::reinject_locally`). RV-01's finding is not lost: the rule that a
// row's only address is `(channel, id)` still governs `inject:result` reconciliation
// and the page's own identity, and it is stated at `bridge::tag_channel`.
pub mod wire;

pub use admission::{Admission, Owner, Verdict};
pub use bridge::{BridgeSink, channel as bridge_channel};
pub use channel::{Channel, CloudConfig, CloudReadiness};
pub use client::{connect, DesktopSocket, SocketConfig};
pub use credentials::Credentials;
// `SharedDeduper` is deliberately NOT re-exported: nothing outside `socket`
// names it today (the golden example infers it), and an export with no importer
// is the same façade shape this repo greps for. `socket::dedup::SharedDeduper`
// is already reachable if an out-of-crate caller ever does need to spell it.
pub use dedup::{InjectDecision, InjectDeduper};
pub use pairing::AuthFailureHook;
pub use reconcile::{ReconcileOutcome, Reconciler};

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (dual channels resident: presence set + primary
//     promotion) + §3.5 F-3113 (the mobile count is what gates focus:state)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-26/GA-28/GA-29
//
// The mobile-presence WIRE EDGES: the two frames that say a phone entered or left
// this desktop's room, and the capsule-ownership verdict each one triggers.
// Split out of client.rs at the 800-line cap — the same move that produced
// fanout.rs / pump.rs / inject_ops.rs, and for the same reason: client.rs is the
// socket LIFECYCLE (open/close, register/reconnect, inject, auth), and this is a
// decision about WHO IS IN THE ROOM.
//
// Distinct from `reconcile.rs` next door, and the difference is the reason this is
// its own module rather than a second half of that one: `Reconciler` owns the
// presence SET (and the JOINED_SUPPRESS race against a reconnect ack's roster) and
// names no socket at all, which is what keeps it unit-testable; this module is the
// seam where a frame becomes a call on it, plus the `Admission` verdict that set
// membership cannot make ("who owns the capsule" is a cross-CHANNEL question).
//
// EVERY event NAME comes from the events.rs constants — never an inline literal at
// a call site — so the protocol-whitelist lint's Rust scan stays clean.

use std::sync::Arc;

use rust_socketio::{ClientBuilder, Payload};

use crate::events;
use crate::forensic;
use crate::socket::admission::{Admission, Verdict};
use crate::socket::channel::Channel;
use crate::socket::reconcile::Reconciler;
use crate::socket::wire;

/// Attach the `pc:mobile-joined` / `pc:mobile-left` handlers. Consumes + returns
/// the builder (the `.on` builder pattern), so the call site in client.rs stays
/// one line like the other split-out families.
///
/// `admission: None` (headless tests, the golden example, any single-socket
/// caller) ⇒ presence is still tracked and still gates focus:state; only the
/// capsule-ownership verdict is skipped — byte-for-byte the pre-GA-28 behaviour.
pub(in crate::socket) fn on_mobile_presence(
    builder: ClientBuilder,
    reconciler: Arc<Reconciler>,
    admission: Option<Arc<Admission>>,
    my_channel: Channel,
) -> ClientBuilder {
    let mut builder = builder;
    // ── mobile presence: maintain the count that gates focus:state (F-3113) and
    //    stamps the JOINED_SUPPRESS window so a reconnect ack can't zero a fresh
    //    join (07 §6). ──
    //    GA-26: presence is keyed by the frame's `mobile_id` (a SET, not a
    //    counter) — the same phone reconnecting can no longer read as a second
    //    phone, and a stray departure can no longer decrement a live one.
    {
        let rec = reconciler.clone();
        let adm_j = admission.clone();
        builder = builder.on(events::PC_MOBILE_JOINED, move |payload, socket| {
            let id = if let Payload::Text(vals) = payload {
                wire::first_arg(&vals).and_then(wire::parse_mobile_id)
            } else {
                None
            };
            match id {
                Some(id) => {
                    let n = rec.on_join(&id);
                    eprintln!("[flowmic] pc:mobile-joined {id} (mobiles={n})");
                    forensic::record("presence", &format!("pc:mobile-joined {id} (mobiles={n})"));
                    // GA-28/GA-29: the capsule admits ONE phone across BOTH
                    // channels. Granting also PROMOTES this channel to primary
                    // (07 §6 "a phone joining on either channel promotes it to primary") without
                    // rebuilding either socket — the role is a shared flag, so
                    // nothing tears down an endpoint it already holds (F-2363).
                    if let Some(a) = &adm_j {
                        match a.join(my_channel, &id) {
                            Verdict::Granted => {
                                forensic::record(
                                    "admission",
                                    &format!("{id} owns the capsule → primary={}", my_channel.tag()),
                                );
                            }
                            Verdict::Refused { holder } => {
                                // LOUD, on the wire: the phone is told to go away
                                // rather than left recording into a capsule that
                                // will never show it (red line "no silent failures").
                                forensic::record(
                                    "admission",
                                    &format!(
                                        "REFUSING {id} on {} — capsule held by {} on {}",
                                        my_channel.tag(),
                                        holder.mobile_id,
                                        holder.channel.tag()
                                    ),
                                );
                                let _ = socket.emit(
                                    events::PC_RELEASE_MOBILE,
                                    wire::build_pc_release_busy(&id),
                                );
                            }
                        }
                    }
                }
                // Unattributable frame: presence is identity-keyed now, so there
                // is nothing honest to add. Recorded loudly rather than guessed.
                None => {
                    eprintln!("[flowmic] pc:mobile-joined WITHOUT mobile_id — presence unchanged");
                    forensic::record("presence", "pc:mobile-joined without mobile_id — ignored");
                }
            }
        });
    }
    {
        let rec = reconciler.clone();
        let adm_l = admission.clone();
        builder = builder.on(events::PC_MOBILE_LEFT, move |payload, _socket| {
            let id = if let Payload::Text(vals) = payload {
                wire::first_arg(&vals).and_then(wire::parse_mobile_id)
            } else {
                None
            };
            match id {
                Some(id) => {
                    let n = rec.on_left(&id);
                    eprintln!("[flowmic] pc:mobile-left {id} (mobiles={n})");
                    forensic::record("presence", &format!("pc:mobile-left {id} (mobiles={n})"));
                    // Frees the capsule ONLY if this phone held it — a refused
                    // second phone giving up must not evict whoever is speaking.
                    if let Some(a) = &adm_l {
                        a.left(my_channel, &id);
                    }
                }
                None => {
                    eprintln!("[flowmic] pc:mobile-left WITHOUT mobile_id — presence unchanged");
                    forensic::record("presence", "pc:mobile-left without mobile_id — ignored");
                }
            }
        });
    }
    builder
}

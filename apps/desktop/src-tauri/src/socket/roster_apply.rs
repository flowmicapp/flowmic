// The ONE place an ack's `connectedMobiles` roster is read — moved VERBATIM
// from `pairing.rs` at the 800-line file-size cap when C2 (session_gen) and B4
// (reconcile_holder) landed in the same round (register_watchdog / session_gen
// precedent: the funnel module keeps the ack ORDER, this sibling owns the
// roster APPLICATION). Body character-for-character; any other difference in
// the moving diff is a bug.

use serde_json::Value;

use crate::forensic;
use crate::socket::pairing::Pairing;
use crate::socket::reconcile::{ReconcileOutcome, Reconciler};
use crate::socket::wire;

/// RV-08 / GA-26 — apply an ack's `connectedMobiles` roster to the presence set.
///
/// ONE implementation called from BOTH handshake legs. The server grew this field
/// on the `pc:register` ack in 0.2.18 (pc.handler.ts, RV-08) precisely because a
/// desktop whose credential file is gone — reinstall, new Windows profile, cleared
/// token — comes back through REGISTER into a room `registerPc` still recognises,
/// phones and all. Nobody on this side read it, so `mobile_count` stayed 0:
/// `server_ready` never opened (pump.rs), `focus:state` was never mirrored, and the
/// tray reported 0 phones with a phone sitting in the room.
///
/// A function rather than a second copy of these eleven lines, because v0.2.1
/// shipped two "what is this PC called" and only one of them ever got fixed — the copy
/// nobody updates is always the one running on the machine with the bug.
///
/// RV-新C — the SAME roster is now also shown to the capsule latch, where it answers
/// a DIFFERENT question ("which channel is carrying the runtime", not "which phones are present"). That is why the
/// two calls sit side by side here instead of one deriving the other, and why
/// `Admission::observe_roster` carries the whole argument for when a roster is and is
/// not allowed to speak. This function stays the ONE place an ack's roster is read.
pub(super) fn apply_connected_mobiles(ctx: &str, obj: &Value, p: &Pairing, rec: &Reconciler) {
    let Some(arr) = obj.get("connectedMobiles").and_then(Value::as_array) else {
        // ABSENT is not EMPTY. A server older than GA-26/RV-08 says nothing about
        // the roster, and zeroing the set on silence would throw away the join
        // events that DID arrive. Only a roster the server actually sent replaces it.
        // RV-新C: returning HERE is also what keeps that rule single-sourced for the
        // capsule latch — a silent server leaves its channel evidence untouched
        // because `observe_roster` below is simply never reached.
        return;
    };
    // GA-26: the ack carries mobile_idS and the reconciler is a SET — so this is a
    // WHOLE-ROSTER replace, which is what clears residue left behind by a lost
    // pc:mobile-left. The server only lists ids that answered sys:ping (GA-07), so
    // this roster is confirmed presence, not memory.
    let (ids, dropped) = wire::parse_connected_mobiles(arr);
    if dropped > 0 {
        forensic::record(
            "reconcile",
            &format!("{ctx} ack — {dropped} unusable connectedMobiles entr(y/ies) ignored"),
        );
    }
    match rec.reconcile(&ids) {
        ReconcileOutcome::Applied(n) => {
            forensic::record("reconcile", &format!("{ctx} ack — mobiles := {n} {ids:?}"));
            // RV-新C: the roster was TRUSTED for presence, so it may also speak about
            // which channel carries the runtime. A phone already in the room when this
            // process started announces nothing, and this ack is the only evidence of
            // it that will ever arrive (see Admission::observe_roster).
            if let Some(adm) = &p.admission {
                // B4 (iOS-2 §2-1): the SAME trusted roster also settles a third
                // question — "is the capsule holder pinned to this channel still there". A holder this
                // channel's own confirmed roster no longer lists is a ghost (its
                // pc:mobile-left was lost on a socket flap, and the link watchdog
                // cannot fire while the SOCKET is healthy over an empty room), so
                // it is released here rather than pinning the capsule to a phone
                // that already went home. Suppressed rosters never reach this
                // line — see Admission::reconcile_holder for the whole argument.
                if let Some(evicted) = adm.reconcile_holder(p.channel, &ids) {
                    forensic::record(
                        "admission",
                        &format!(
                            "capsule holder reconciled away — {} on {} is absent from its own channel's confirmed roster ({} phone(s))",
                            evicted.mobile_id,
                            evicted.channel.tag(),
                            ids.len()
                        ),
                    );
                }
                let inferred = adm.observe_roster(p.channel, &ids);
                forensic::record(
                    "admission",
                    &format!(
                        "{ctx} ack roster on {} — {} phone(s) ⇒ current channel {}",
                        p.channel.tag(),
                        ids.len(),
                        match inferred {
                            Some(c) => c.tag(),
                            None => "(no single channel — the process default stands)",
                        }
                    ),
                );
            }
        }
        ReconcileOutcome::Suppressed(n) => {
            eprintln!("[flowmic] reconcile: empty ack within JOINED_SUPPRESS — kept {n}");
            forensic::record(
                "reconcile",
                &format!("empty {ctx} ack within JOINED_SUPPRESS — kept {n}"),
            );
            // Deliberately NOT observed: this ack's empty roster was judged stale for
            // presence, so trusting it to RETRACT the channel evidence would be the
            // same snapshot being believed and disbelieved in the same breath.
        }
    }
}

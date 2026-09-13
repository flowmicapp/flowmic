// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (`control:key`, `control:key-result`,
//     F-3115 device_label, F-3116 the receipt)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-e (the ⌨ segment)
//
// The `control:key` subscription: one remote keypress in, one local act, one row,
// and — since card MP-14 — one answer on the wire.
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
// client.rs stood at 789 of the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX), and MP-14 needs ~10 more lines inside this handler. Same practice as
// every split before it (fanout.rs / pump.rs / inject_ops.rs / presence.rs):
// take a coherent family out WHOLE rather than shave the reasoning prose to fit,
// and hand it the builder the way `presence::on_mobile_presence` already does.
//
// 🔴 DIFF DISCIPLINE. The body below is client.rs's handler moved
// character-for-character, plus exactly the MP-14 additions, each of which is
// marked `MP-14` at its own site: the `request_id` read, the two
// `emit_key_receipt` calls, the `run.row` destructure, and `_socket` becoming
// `socket` (a closure parameter that was unused precisely because this event had
// nothing to answer with). **Any other difference in this diff is a bug.**
//
// ── WHAT THE TWO ANSWERS ARE, AND WHY THEY ARE NOT ONE ──────────────────────
// The ROW says what this machine remembers about the press (REQ-12-13, owner
// 2026-08-12). The RECEIPT says what the person who pressed it gets told. Their
// coverage is deliberately different: `punct_*` and an unknown kind mint no row
// at all, and the unknown-kind case is the one that made MP-14 necessary — it
// was loud in the forensic log on THIS machine and silent to the phone. Tying
// the receipt to the row would have reproduced exactly that silence.

use std::sync::{Arc, Mutex};

use rust_socketio::{ClientBuilder, Payload};

use crate::events;
use crate::focus::FocusStateMachine;
use crate::forensic;
use crate::socket::bridge::BridgeSink;
use crate::socket::channel::Channel;
use crate::socket::control_row::{self, ControlOutcome, KeyReceipt};
use crate::socket::fanout::PrimaryGate;
use crate::socket::inject_ops::run_control_key;
use crate::socket::wire;

/// Register the `control:key` handler on `builder`.
pub(in crate::socket) fn on_control_key(
    builder: ClientBuilder,
    allowlist: Arc<Option<Vec<String>>>,
    fsm: Arc<Mutex<FocusStateMachine>>,
    gate: PrimaryGate,
    bridge: Option<BridgeSink>,
    my_channel: Channel,
) -> ClientBuilder {
    // ── control:key → six-key map (unknown → CONTROL_UNKNOWN_KIND) ──
    let allow = allowlist;
    let fsm_c = fsm;
    let g_c = gate;
    let br_c = bridge;
    builder.on(events::CONTROL_KEY, move |payload, socket| {
        // The frame has to be read BEFORE the admission gate now, because a
        // refusal mints a row too and a row needs the kind. Nothing else moved:
        // no key is pressed on a non-primary channel (the gate below is still
        // evaluated before `run_control_key`).
        let Payload::Text(vals) = payload else { return };
        let Some(obj) = wire::first_arg(&vals) else { return };
        let Some(kind) = wire::parse_control_kind(obj) else { return };
        // REQ-12-13 — WHICH PHONE pressed it (vol. 04 F-3115). `None` on an older
        // phone or across an older relay; the row then says it cannot name its
        // sender rather than guessing one.
        let label = wire::parse_device_label(obj);
        // MP-14 — WHICH PRESS the receipt below answers (vol. 04 F-3116). `None`
        // on an older phone, or across an older relay that zod-strips the key: the
        // receipt still goes out, and the far side matches it by kind + recency.
        // 🔴 Read here and never defaulted — an invented id would settle the wrong
        // press, which is worse than the weaker match.
        let request_id = obj
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Same rule as inject: only the capsule owner's channel may press keys
        // on this machine.
        //
        // ⚠️ 「control:key has NO result frame in the protocol, so there is nothing
        // to report ON THE WIRE — the refusal is recorded locally instead of
        // inventing a wire answer that does not exist」 stood here until MP-14 and
        // is now false in its premise. The refusal IS reported, as `failed`: from
        // the far side, 「another phone holds this computer」 and 「this computer
        // tried and nothing happened」 lead to the same move, and the detail stays
        // in the forensic line written one statement below.
        //
        // 🔴 REQ-12-13: it is also MINTED, for the same reason a refused
        // inject:request is (row_transit ruling two, 裁定二) — the press really did arrive at
        // this PC and really did nothing, and both halves have to be visible.
        // Only for a CHORD key: a `punct_*` press is out of this card's scope
        // (vol. 15 §2.0-e), and `is_chord_key` is what keeps the two apart here.
        if !g_c.open() {
            forensic::record("admission", "control:key ignored — channel not primary");
            if crate::inject::key_sequence_for(&kind).is_some() {
                control_row::mint_control_row(
                    &br_c,
                    my_channel,
                    &kind,
                    ControlOutcome::NotPrimary,
                    label.as_deref(),
                );
            }
            // MP-14. 🔴 OUTSIDE the `is_chord_key` guard the row sits behind, on
            // purpose: a `punct_*` press turned away here mints no row AND used to
            // produce nothing at all, so the phone was told less about it than
            // about anything else on this path.
            control_row::emit_key_receipt(
                &socket,
                &kind,
                request_id.as_deref(),
                KeyReceipt::from_outcome(ControlOutcome::NotPrimary),
            );
            return;
        }
        let run = run_control_key(&kind, &allow, &fsm_c);
        if let Some(outcome) = run.row {
            control_row::mint_control_row(&br_c, my_channel, &kind, outcome, label.as_deref());
        }
        // MP-14. Unconditional, and that is the card: `run.row` is `None` for a
        // `punct_*` press and for a kind this machine does not have, and the
        // second of those is precisely the case that used to end in silence.
        control_row::emit_key_receipt(&socket, &kind, request_id.as_deref(), run.receipt);
    })
}

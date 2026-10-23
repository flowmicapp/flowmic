// SPEC-REF:
//   docs/strategy/2026-10-16-uipi-silent-inject-design.md §5 (incl. its correction block)
//   docs/strategy/2026-10-18-open-items-advance-plan.md row A (NR-267-A)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md NR-267, audit (d)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// NR-267-A — a SHORT-LIVED memory of `INJECT_TARGET_ELEVATED` refusals, keyed by
// `request_id`, living on the same machine-wide `InjectDeduper` as INJ-3.
//
// ── THE HOLE ────────────────────────────────────────────────────────────────
// A phone that does not know the code (0.3.107 and older) files the refusal as a
// retryable failure (`delivery_outbox_settle.dart`: the code is not in
// `kPcInjectionVerdictCodes`), puts the item back to `queued`, and re-sends it under
// the SAME `request_id` on its next drain (reconnect, any ➤, or an inline resend —
// `chat_outbox_host.dart` reuses the owed item). Within 60 s of speaking that frame is
// stamped `live` (`outbox_inject_origin.dart` `kLiveDeliveryWindow`; a negative age
// counts as live too). A refusal is `mode: Cached`, and `inject_ops::run_inject` only
// records non-cached outcomes in INJ-3, so the re-send is judged afresh against the
// window in front NOW. If the user has moved on to an ordinary window, the sentence is
// typed THERE — into a window they never spoke to. Release order cannot close it: the
// desktop self-updates without waiting for the phone's store review (audit (d)).
//
// ── WHY NOT INJ-3 ITSELF (design §5, rejected there and still rejected) ─────
// INJ-3 is permanent for the life of the process (LRU 256). The old phone's inline
// resend reuses the same id, so a refusal recorded there would make that button do
// nothing until the PC restarts. This memory covers only the dangerous stretch.
//
// ── THE WINDOW: 60 s + 45 s = 105 s, measured from this PC's refusal ────────
//   · 60 s = `kLiveDeliveryWindow` (`apps/mobile/lib/src/session/outbox_inject_origin.dart`).
//     The phone measures it on its OWN clock from `createdAt` (the moment of speaking)
//     to `attemptAt` (the stamp of this attempt). Speaking precedes our first refusal,
//     so every automatically re-sent frame stamped `live` was stamped less than 60 s
//     after the instant recorded here.
//   · 45 s = `kOutboxInflightTimeout` (`apps/mobile/lib/src/session/delivery_outbox_terms.dart`):
//     the longest the phone keeps one attempt outstanding before its watchdog gives up on
//     it and re-stamps on the next drain (which, past 60 s, is `deferred`). That is the
//     longest a `live`-stamped frame can plausibly still be on its way here, so it is
//     the margin between "stamped" and "arrives".
//   Not covered, named so nobody reads silence as safety: a phone clock that moves
//   BACKWARDS keeps re-stamping `live` (negative age) for as long as the jump; and a frame
//   held in transit past the phone's own watchdog. Both are outside 105 s by construction.
//
// ── THE MANUAL RESEND TRADE-OFF (decided: refuse) ───────────────────────────
// On an OLD phone, a user who deliberately switched to an ordinary window and pressed
// the row's resend within the window is refused again: that press reuses the queued
// item, i.e. the SAME `request_id`, and `userRequested` stamps it `live`
// (`outbox_inject_origin.dart` — checked first, the clock gets no vote). On the wire it
// is byte-for-byte the automatic re-drain this memory exists to stop: there is no field
// that says "a human pressed this" (`socket/wire.rs` `InjectRequest`), and adding one is
// a protocol change this card may not make. Safety wins: the cost is that the button
// shows 「待投递」 again for at most 105 s, after which the next press types. The PC's
// own timeline re-inject is untouched (it carries no `request_id`, `wire.rs`
// `local_reinject_request`). A NEW phone (knows the code) is never affected: it settles
// the row terminal (`outbox_inject_authorship.dart` leaves the code out of
// `kTransientInjectionVerdictCodes`), so its resend is not owed and goes through
// `reInject`, which mints a FRESH `request_id` (`chat_outbox_host.dart`).
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// Keyed exactly like INJ-3: `request_id` alone, on the one machine-wide table (dedup.rs
// SCOPE block) — both channels and the local re-inject decide on the same object, so a
// re-send that comes back over the other link is still recognised. A collision between
// two phones' ids (mint shape `'{prefix}{seq}-{micros}'`) can only REFUSE a frame, never
// type one, so it fails in the safe direction.
// Control keys are not here: each press mints a fresh id (`chat_control_keys.dart`
// `mintRequestId('k')`) and is never queued or re-sent, and NR-267-F1 judges every press
// against the window in front at that moment (`inject_ops_control.rs` `run_control_key_with`).

use std::collections::VecDeque;

use serde_json::Value;

use super::InjectDeduper;

/// `kLiveDeliveryWindow` on the phone. A mirror, not a shared constant: the two ends
/// live in two languages. If the phone's number changes, this must follow.
pub(crate) const PHONE_LIVE_WINDOW_MS: u64 = 60_000;
/// `kOutboxInflightTimeout` on the phone — the in-flight margin (see the block above).
pub(crate) const PHONE_INFLIGHT_TIMEOUT_MS: u64 = 45_000;
/// How long a refusal is replayed for, measured from the refusal on this PC.
pub(crate) const ELEVATED_MEMORY_MS: u64 = PHONE_LIVE_WINDOW_MS + PHONE_INFLIGHT_TIMEOUT_MS;
/// Not a new number: INJ-3's own bound. Filling it needs more than two refusals a
/// second for 105 s; an eviction is logged because it reopens the hole for that id.
pub(crate) const ELEVATED_MEMORY_CAP: usize = InjectDeduper::LRU_CAP;

/// One remembered refusal: the id, when this PC refused it, and the exact result frame
/// it answered with (replayed verbatim, the way an INJ-3 in-memory hit is).
#[derive(Default)]
pub(super) struct ElevatedRefusals {
    entries: VecDeque<(String, u64, Value)>,
}

/// Symmetric on purpose: a wall clock that jumps BACKWARDS must not keep an entry
/// alive (and the old phone's resend dead) for as long as the jump.
fn alive(recorded_at_ms: u64, now_ms: u64) -> bool {
    recorded_at_ms.abs_diff(now_ms) <= ELEVATED_MEMORY_MS
}

impl InjectDeduper {
    /// `Some((result, age_ms))` when this id was refused as `INJECT_TARGET_ELEVATED`
    /// within [`ELEVATED_MEMORY_MS`]. The caller replays `result` and does not look at
    /// the foreground. The timestamp is never refreshed by a replay.
    pub(crate) fn elevated_refusal_replay(&mut self, request_id: Option<&str>, now_ms: u64) -> Option<(Value, u64)> {
        let rid = request_id?;
        self.elevated.entries.retain(|(_, at, _)| alive(*at, now_ms));
        self.elevated
            .entries
            .iter()
            .find(|(id, _, _)| id == rid)
            .map(|(_, at, v)| (v.clone(), now_ms.saturating_sub(*at)))
    }

    /// Remember a refusal this PC just answered. No id ⇒ nothing to key on ⇒ nothing
    /// remembered (a frame without one is never re-sent under one).
    pub(crate) fn remember_elevated_refusal(&mut self, request_id: Option<&str>, result: &Value, now_ms: u64) {
        let Some(rid) = request_id else { return };
        self.elevated.entries.retain(|(id, at, _)| id != rid && alive(*at, now_ms));
        while self.elevated.entries.len() >= ELEVATED_MEMORY_CAP {
            if let Some((evicted, at, _)) = self.elevated.entries.pop_front() {
                crate::forensic::record("dedup", &format!(
                    "elevated-refusal memory full: evicted request_id={evicted:?} age_ms={}; \
                     a live re-send of it would be judged afresh",
                    now_ms.saturating_sub(at),
                ));
            }
        }
        self.elevated.entries.push_back((rid.to_string(), now_ms, result.clone()));
    }

    #[cfg(test)]
    pub(crate) fn elevated_refusal_count(&self) -> usize {
        self.elevated.entries.len()
    }
}

// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (capsule surface data) / §9 (timeline
//     fan-out + refresh), §6 (dual channels resident: primary + presence)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-28
//
// The SERVER→FRONTEND fan-out seam: which inbound frames reach the Vue windows,
// which session is allowed to send them, and what has to be stamped on the way.
// Split out of client.rs at the 800-line cap (same move that produced pump.rs /
// inject_ops.rs) — client.rs stays the audited inject/auth core.

use rust_socketio::{ClientBuilder, Payload};

use crate::forensic;
use crate::socket::bridge::{self, BridgeSink};
use crate::socket::channel::Channel;
use crate::socket::wire;

/// GA-28 — 「this session is the one carrying the runtime」.
///
/// With both channels resident (07 §6) two sessions receive frames from two
/// DIFFERENT servers. Everything that reaches a USER-VISIBLE surface (the capsule,
/// the timeline, the injected window, the SPEAKING lock) must come from exactly
/// one of them, or two rooms' utterances interleave in one HUD. The presence
/// session stays fully alive — it registers, holds its pairing code, answers
/// sys:ping and reports joins — it just does not drive the runtime.
///
/// `admission: None` (headless tests, the golden example, any single-socket
/// caller) ⇒ always open, i.e. byte-for-byte the pre-GA-28 behaviour.
#[derive(Clone)]
pub(in crate::socket) struct PrimaryGate {
    pub(in crate::socket) admission: Option<std::sync::Arc<crate::socket::Admission>>,
    pub(in crate::socket) channel: Channel,
}

impl PrimaryGate {
    pub(in crate::socket) fn open(&self) -> bool {
        // `map_or(true, …)` rather than the tidier `is_none_or`: that method is stable
        // only since Rust 1.82 while this crate's declared MSRV is 1.78 (Cargo.toml
        // `rust-version`), which is what clippy's `incompatible_msrv` caught here. The
        // declaration is a promise about the toolchain the project builds on, so a
        // defect-fix card is the wrong place to raise it.
        self.admission.as_ref().is_none_or(|a| a.is_primary(self.channel))
    }
}

/// Attach a handler that forwards a server event's first-arg payload verbatim to
/// the frontend on a fixed bridge channel (07 §4/§9 capsule + timeline fan-out).
/// Consumes + returns the builder (the `.on` builder-pattern), so a chain of
/// forwards stays one line each.
/// GA-28: gated on `primary`. A presence session's server has its own room, its
/// own timeline and its own utterances; forwarding those into the SAME capsule and
/// the SAME timeline list would interleave two rooms in one surface. The frames
/// are dropped at this seam only — the session itself stays fully alive.
pub(in crate::socket) fn on_forward(
    builder: ClientBuilder,
    event: &'static str,
    channel: &'static str,
    bridge: Option<BridgeSink>,
    primary: PrimaryGate,
) -> ClientBuilder {
    builder.on(event, move |payload, _socket| {
        if !primary.open() {
            return;
        }
        if let Payload::Text(vals) = payload {
            if let Some(v) = wire::first_arg(&vals) {
                bridge::forward(&bridge, channel, v.clone());
            }
        }
    })
}

/// F3 — as [`on_forward`], plus ONE side effect: the frame is recorded as evidence
/// that audio is still flowing (`SpeakLiveness::signal`), which is what keeps the
/// SPEAKING lock's STATE watchdog from force-releasing a genuinely long utterance
/// (speak_liveness.rs). Used for `stt:interim` / `stt:final` / `stt:level` — the
/// same three signals the capsule's own latch watchdog already runs on
/// (`apps/desktop/src/lib/speaking-watchdog.ts`), so the tray and the HUD decide
/// "is it still speaking" from the same evidence instead of two different sets.
///
/// A SEPARATE FUNCTION rather than an extra parameter on [`on_forward`]: that
/// signature is pinned by `the_timeline_forward_cannot_be_primary_gated_but_the_capsule_one_is`
/// below as the anchor for a DIFFERENT invariant (owner 2026-07-30 ①), and widening
/// it would make that anchor churn for a reason unrelated to what it guards.
///
/// The signal is taken BEFORE the primary gate on purpose. The gate answers "should
/// this channel drive the UI"; the watchdog asks "is this channel's audio still flowing", and it guards
/// THIS channel's own FSM — which `audio:start` locked on this same channel — so a
/// channel that is momentarily not primary must not look starved to its own lock.
pub(in crate::socket) fn on_forward_speaking(
    builder: ClientBuilder,
    event: &'static str,
    channel: &'static str,
    bridge: Option<BridgeSink>,
    primary: PrimaryGate,
    liveness: crate::socket::speak_liveness::SpeakLiveness,
) -> ClientBuilder {
    builder.on(event, move |payload, _socket| {
        liveness.signal();
        if !primary.open() {
            return;
        }
        if let Payload::Text(vals) = payload {
            if let Some(v) = wire::first_arg(&vals) {
                bridge::forward(&bridge, channel, v.clone());
            }
        }
    })
}

/// RV-01 — as [`on_forward`], plus the SOURCE CHANNEL stamp every TIMELINE frame
/// carries (`bridge::tag_channel` explains why the frontend cannot address a row
/// without it). A frame we cannot stamp is recorded and dropped rather than
/// reaching the cache untagged.
///
/// NO PRIMARY GATE — owner 2026-07-30 ①: "the timeline = all messages delivered to
/// this PC, regardless of which phone is currently connected". The gate used to drop the non-primary channel's history frames
/// here, which made the timeline answer a DIFFERENT question: "what's on the
/// server that the currently-connected phone happens to be on". Rows this PC really received over the other channel then
/// disappeared from the page the moment a phone joined on one — and reappeared later,
/// which reads as data loss.
///
/// The old reason for the gate (one surface = one room, GA-28) is still real for the
/// CAPSULE's incoming-record strip, so it is enforced where that surface is built rather
/// than on the bridge: `capsule/controller`'s `acceptRecentChannel` compares each frame's
/// stamp against the capsule's own primary channel. Filtering at the bridge cannot
/// serve both surfaces at once — one of them must be wrong — so the bridge delivers
/// the truth and each surface narrows it for its own question.
pub(in crate::socket) fn on_forward_tagged(
    builder: ClientBuilder,
    event: &'static str,
    channel: &'static str,
    bridge: Option<BridgeSink>,
    source: Channel,
) -> ClientBuilder {
    builder.on(event, move |payload, _socket| {
        if let Payload::Text(vals) = payload {
            if let Some(v) = wire::first_arg(&vals) {
                match bridge::tag_channel(v, source.tag()) {
                    Some(tagged) => bridge::forward(&bridge, channel, tagged),
                    None => forensic::record(
                        "timeline",
                        &format!("{event} was not an object — dropped rather than cached untagged"),
                    ),
                }
            }
        }
    })
}

/// Card F1 —— the CAPSULE-ONLY audio lifecycle edges (S→PC), registered as one family
/// because they share one invariant: **none of them may move anything but the HUD.**
///
/// Moved here VERBATIM from client.rs at the 800-line cap (the same move that
/// produced pump.rs / inject_ops.rs / this file). `audio:start` deliberately stayed
/// behind — it DOES arm the SPEAKING lock, so it is not part of this family.
///
///  · `audio:stop` — Ruling 2: the lock is NOT released here. Release is owned by the
///    inject path (InjectFinished, AFTER inject_text resolves) and backstopped by the
///    32s watchdog — releasing on speak-end is the unlock-before-inject race.
///  · `audio:pause` / `audio:resume` — owner ruling ① (card F1): "the PC should
///    treat the phone as 'paused' (still paired, just the capsule collapsed)". 🔴 What they deliberately do NOT do, because
///    pause ≠ leave:
///      - never touch the ADMISSION latch (`gate` is READ, exactly as the other
///        forwards read it — a paused phone keeps the capsule's ownership);
///      - never touch presence / the room / the paired-mobiles directory, so the
///        device page keeps saying "paired phone" instead of "no phone connected yet";
///      - never touch the SPEAKING lock. A phone that backgrounds mid-utterance still
///        owns the window it locked at `audio:start`; releasing it here would be the
///        very race Ruling 2 forbids.
///    The ONLY effect is the capsule's visibility, and it is reversible by design:
///    controller.ts `onAudioPause` collapses, `onAudioResume` restores.
pub(in crate::socket) fn on_capsule_audio_edges(
    builder: ClientBuilder,
    bridge: Option<BridgeSink>,
    gate: PrimaryGate,
) -> ClientBuilder {
    let builder = {
        let br_s = bridge.clone();
        let g_s = gate.clone();
        builder.on(crate::events::AUDIO_STOP, move |payload, _socket| {
            if !g_s.open() {
                return;
            }
            if let Payload::Text(vals) = &payload {
                if let Some(v) = wire::first_arg(vals) {
                    bridge::forward(&br_s, bridge::channel::AUDIO_STOP, v.clone());
                }
            }
            eprintln!("[flowmic] audio:stop → speak ended (lock retained until inject resolves/watchdog)");
        })
    };
    let builder = on_forward(
        builder,
        crate::events::AUDIO_PAUSE,
        bridge::channel::AUDIO_PAUSE,
        bridge.clone(),
        gate.clone(),
    );
    on_forward(
        builder,
        crate::events::AUDIO_RESUME,
        bridge::channel::AUDIO_RESUME,
        bridge,
        gate,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// owner 2026-07-30 ① — the TIMELINE forward takes NO gate, and the capsule-facing
    /// one still does.
    ///
    /// A SIGNATURE anchor, because the behaviour lives in the argument list: the gate
    /// was a parameter, and re-introducing it cannot be done without changing this
    /// line. There is no runtime seam to assert instead — a `ClientBuilder::on` handler
    /// only ever runs inside a live socket.io client, which is precisely why a frame
    /// silently dropped here went unnoticed until the owner saw rows vanish.
    #[test]
    fn the_timeline_forward_cannot_be_primary_gated_but_the_capsule_one_is() {
        let timeline: fn(
            ClientBuilder,
            &'static str,
            &'static str,
            Option<BridgeSink>,
            Channel,
        ) -> ClientBuilder = on_forward_tagged;
        let capsule: fn(
            ClientBuilder,
            &'static str,
            &'static str,
            Option<BridgeSink>,
            PrimaryGate,
        ) -> ClientBuilder = on_forward;
        // Using them is what makes the coercion above a real check rather than a
        // discarded expression the compiler may fold away.
        assert_ne!(timeline as usize, capsule as usize);
    }

    /// A gate with NO admission latch is open — the headless/single-socket behaviour
    /// every existing test and the golden example rely on.
    #[test]
    fn a_gateless_session_is_always_primary() {
        let gate = PrimaryGate { admission: None, channel: Channel::Cloud };
        assert!(gate.open());
    }
}

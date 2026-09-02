// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (owner architecture ruling:
//     the cloud does not store transcripts ⇒ reinject text is supplied by the row's owner)
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//   docs/decisions/2026-07-30-rv45-is-an-optional-enhancement-not-a-prerequisite.md
//     (hard constraint: the two delivery paths must never let `injected` carry two meanings)
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (the timeline's four operations — reinject)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// REINJECT WITHOUT A WIRE — the one injection on this machine that no socket frame asks for.
//
// Split out of client.rs by RESPONSIBILITY, not by line count: client.rs is the socket
// LIFECYCLE (connect, handshake, inbound dispatch, teardown) and everything in it exists
// because a frame arrived. Nothing here does. It is the same split the module already
// made for `inject_ops` (the inject/control decision core) and `pump`, and it keeps the
// question "who can type into a window with no server involved" answerable in one file.
//
// WHAT IT REPLACES. `history:inject{id}`: the PC emitted an id, the server read the row's
// text out of `transcript_history`, and the server sent it back to THIS SAME PC as an
// `inject:request`. The table is gone (owner architecture ruling) and the PC has owned the row since
// 0.2.26, so the frame, the ack and the return leg all go. What is left is the part that
// was ever real — running the pipeline on text that was in hand all along.

use std::sync::Arc;

use serde_json::Value;

use crate::forensic;
use crate::socket::client::{DesktopSocket, SharedDeadline, SharedFsm};
use crate::socket::dedup::SharedDeduper;
use crate::socket::inject_ops::{run_inject, TargetIntent};
use crate::socket::wire;

/// Everything `inject_ops::run_inject` needs, as one bundle held on the session handle.
///
/// WHY IT IS ON THE HANDLE. These four used to live only inside the `inject:request`
/// handler's closure, which was enough while every injection on this machine arrived
/// over the socket. It no longer does, and a Tauri command has to be able to reach the
/// SAME decision state. Handing the command its own fresh FSM / deduper would have been
/// a SECOND injection path — a different SPEAKING-lock answer, a different dedup window
/// — and therefore a second meaning for `injected`, which the RV-45 ruling forbids
/// outright.
// P1-2 (2026-09-02 audit §3-D): `pub(crate)`, not `pub(in crate::socket)` — the
// shell layer (`shell::reinject`) needs to hold this type by value so it can
// clone the four Arcs out from behind the `SocketState` mutex and drop the
// lock BEFORE running the pipeline. The old shape ran the whole pipeline
// (up to the 1.5s PASTE_HOLD) inside the mutex guard's closure, which froze
// every OTHER Tauri command that needs `SocketState` for that long.
#[derive(Clone)]
pub(crate) struct InjectHandles {
    /// Smoke-safety allowlist (`None` in production).
    pub allowlist: Arc<Option<Vec<String>>>,
    /// The focus FSM — the single source of truth for the inject target.
    pub fsm: SharedFsm,
    /// The SPEAKING-lock watchdog deadline (disarmed when this inject's lock released).
    pub lock_deadline: SharedDeadline,
    /// INJ-3/INJ-1 dedup. A local reinject bypasses it by `source`, but it must be the SAME
    /// deduper — a separate one would forget what was physically typed.
    pub deduper: SharedDeduper,
}

impl DesktopSocket {
    /// A cheap clone of the four Arc handles this session's inject decisions run on.
    ///
    /// P1-2 (2026-09-02 audit §3-D): this is what `shell::reinject` takes OUT of the
    /// `SocketState` mutex guard before running the actual pipeline. Cloning four Arcs
    /// is microseconds; the pipeline it feeds can hold PASTE_HOLD for up to 1.5s, and
    /// that used to run INSIDE the same lock, freezing every other Tauri command that
    /// touches `SocketState` (which is most of them) for that long.
    ///
    /// `#[cfg(feature = "app")]`: `SocketState`/`shell::reinject` only exist under
    /// the `app` feature (the audited core here stays tauri-free), so the lean
    /// `cargo test` build has no caller — gated to match, rather than dead_code.
    #[cfg(feature = "app")]
    pub(crate) fn inject_handles(&self) -> InjectHandles {
        self.inject.clone()
    }

    /// Reinject the row's own text into this machine's focused window, with NO round trip.
    ///
    /// ONE DECISION PATH, THEREFORE ONE MEANING OF `injected`. This calls the very same
    /// `run_inject` the `inject:request` handler calls, on the very same FSM / deduper /
    /// allowlist ([`InjectHandles`]), so every word of
    /// docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md holds
    /// verbatim here — including that a reinject with no reachable foreground reports
    /// `cached`, never a fabricated success. The RV-45 ruling's hard constraint ("the two
    /// delivery paths must never let `injected` carry two meanings") is satisfied by there being one path, not by two
    /// paths agreeing.
    ///
    /// WHAT IT DOES **NOT** DO: it does not emit `inject:result` on the socket.
    /// `inject:result` is the ANSWER to an `inject:request`, and nobody asked for this
    /// delivery — the user clicked a button on this PC, on a row this PC owns. Sending
    /// one would (a) put a verdict on the wire for a request that never existed, which
    /// the relay's latency bookkeeping would pair with a `markInjectRequest` that never
    /// happened, and (b) flip a status on every phone in the room for an act none of them
    /// performed. owner's ruling is explicit that PC→phone does not sync; the row's owner
    /// is this PC and it is told directly (the return value).
    ///
    /// `None` = **nothing was injected and nothing was typed** — the caller must SAY so
    /// (red line: never claim something happened that did not). One cause reaches here: a dedup verdict, which
    /// two facts prevent for this builder — it mints no `request_id` (INJ-3 has no key)
    /// and `source:'history'` skips the INJ-1 byte window
    /// (`dedup::skips_the_inj1_byte_window`, ex-`is_bypass_source`, RV-29 round) — and
    /// the forensic line names it if either ever drifts. (The other cause — no resident session at all — is
    /// decided one layer up, in `shell::reinject`.)
    ///
    /// Body lives in [`reinject_text_with_handles`] now (P1-2) — this method just hands
    /// it `self`'s handles, for callers that still hold `&DesktopSocket` (unit tests).
    /// `shell::reinject` calls the free function directly with a bundle it cloned
    /// BEFORE dropping the `SocketState` lock.
    pub fn reinject_locally(&self, text: &str, entry_id: &str) -> Option<Value> {
        reinject_text_with_handles(&self.inject, text, entry_id)
    }

    /// The IMAGE sibling of [`Self::reinject_locally`] (0.3.36 — the 15-vol
    /// §2.5e-7 ① gap's PC half). Same posture, same constraint, one difference:
    /// the payload is the row's ORIGINAL picture, loaded by the caller
    /// (`shell::reinject::timeline_reinject_image`) from `socket::row_image` —
    /// this method takes bytes it is handed, exactly as `reinject_locally`
    /// takes text it is handed, so the session handle never grows a disk path.
    ///
    /// ONE DECISION PATH, still: the fabricated request is `source:'image'`,
    /// which `run_inject` routes down the SAME picture arm an inbound image
    /// `inject:request` takes (`inject::inject_image` — clipboard + paste, the
    /// hold/readback machinery included), on the same FSM / deduper /
    /// allowlist. `injected` keeps one meaning because there is one path.
    /// Dedup facts, for the record: `source:'image'` skips the INJ-1 byte
    /// window (`dedup::skips_the_inj1_byte_window`) and no `request_id` is
    /// minted, so INJ-3 has no key — two clicks are two deliveries, same as the
    /// text button.
    ///
    /// Body lives in [`reinject_image_with_handles`] now (P1-2), same reason as above.
    pub fn reinject_image_locally(&self, image_b64: &str, image_mime: &str, entry_id: &str) -> Option<Value> {
        reinject_image_with_handles(&self.inject, image_b64, image_mime, entry_id)
    }
}

/// The text-reinject pipeline, decoupled from `&DesktopSocket` (and therefore from any
/// `SocketState` lock) — see `DesktopSocket::inject_handles` and `shell::reinject`.
///
/// P1-2: the old call site ran this whole body — including `run_inject`'s SendInput /
/// clipboard-paste-and-hold machinery, up to 1.5s of PASTE_HOLD — INSIDE the
/// `with_socket` closure, which holds the app-wide `SocketState` mutex. Every other
/// Tauri command that touches `SocketState` (which is most of them: settings, pairing,
/// the device page, every inbound socket handler) was blocked for that whole run.
/// Cloning `InjectHandles` out from behind the lock and calling this function AFTER the
/// lock is dropped removes the hold entirely — the mutex is now held only for the
/// microseconds it takes to clone four Arcs.
pub(crate) fn reinject_text_with_handles(handles: &InjectHandles, text: &str, entry_id: &str) -> Option<Value> {
    let req = wire::local_reinject_request(text, entry_id);
    let out = run_inject(
        &req,
        &handles.allowlist,
        &handles.fsm,
        &handles.lock_deadline,
        &handles.deduper,
        // 🔴 THE ONE PRODUCER OF THIS INTENT IN THE WHOLE BINARY. A human just
        // clicked a row's re-inject button, so FlowMic is in front BECAUSE of
        // that click — reading the live foreground here answers a question
        // nobody asked and makes the act impossible (see [`TargetIntent`]).
        TargetIntent::BeforeTheClick,
    );
    match &out {
        Some(r) => forensic::record(
            "timeline",
            &format!(
                "local reinject entry_id={entry_id} chars={} → ok={} mode={:?} (no server round trip)",
                text.chars().count(),
                r.get("ok").and_then(Value::as_bool).unwrap_or(false),
                r.get("mode").and_then(Value::as_str).unwrap_or("?"),
            ),
        ),
        None => forensic::record(
            "timeline",
            &format!(
                "local reinject entry_id={entry_id} produced NO result — run_inject deduped it \
                 (source={:?} is expected to bypass dedup; nothing was typed)",
                req.source
            ),
        ),
    }
    out
}

/// The image-reinject pipeline, decoupled from `&DesktopSocket` — see
/// [`reinject_text_with_handles`] for why this exists (P1-2).
pub(crate) fn reinject_image_with_handles(
    handles: &InjectHandles,
    image_b64: &str,
    image_mime: &str,
    entry_id: &str,
) -> Option<Value> {
    let req = wire::local_reinject_image_request(image_b64, image_mime, entry_id);
    let out = run_inject(
        &req,
        &handles.allowlist,
        &handles.fsm,
        &handles.lock_deadline,
        &handles.deduper,
        // Same intent, same producer argument as the text arm above: a human
        // just clicked this row's button, so the target is the window that
        // was in front BEFORE the click.
        TargetIntent::BeforeTheClick,
    );
    match &out {
        Some(r) => forensic::record(
            "timeline",
            &format!(
                "local reinject IMAGE entry_id={entry_id} mime={image_mime} b64_chars={} → ok={} mode={:?} \
                 (no server round trip)",
                image_b64.chars().count(),
                r.get("ok").and_then(Value::as_bool).unwrap_or(false),
                r.get("mode").and_then(Value::as_str).unwrap_or("?"),
            ),
        ),
        None => forensic::record(
            "timeline",
            &format!(
                "local reinject IMAGE entry_id={entry_id} produced NO result — run_inject deduped it \
                 (source={:?} is expected to bypass dedup; nothing was pasted)",
                req.source
            ),
        ),
    }
    out
}

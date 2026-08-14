// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (three-stage injection pipeline), §3 (focus FSM / SPEAKING
//     lock / ruling 2: the lock is held THROUGH the injection), §10 (RCA lines)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request / inject:result)
//   *** HUMAN-AUDIT SENSITIVE (injection path) — reviewable in isolation ***
//
// The inject/control DECISION core, split out of client.rs when GA-28 pushed that
// file past the 800-line cap (the same move that produced pump.rs). Nothing here
// changed in the split: this is target resolution, the smoke allowlist, the
// watchdog disarm predicate, and the two runners that turn one frame into one
// truthful outcome. client.rs is now purely the socket WIRING that calls them.
//
// Keeping it here has a second benefit the cap forced into view: the injection
// path — the thing the project promised to human-review line by line — is now one
// file with no socket lifecycle around it.

use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use crate::error_codes;
use crate::focus::{self, FocusEvent, FocusState, FocusStateMachine};
use crate::forensic;
use crate::inject;
use crate::socket::client::now_millis;
use crate::socket::control_row::ControlOutcome;
use crate::socket::dedup::{InjectDecision, InjectDeduper};
use crate::socket::wire::{self, InjectRequest};

/// Resolve the injection target — the SINGLE source of truth is the focus FSM
/// (deliverable A). While SpeakingLocked/Injecting the LOCK wins: a divergent
/// live foreground never steals the target (F-203 — a mid-utterance window
/// switch must not land text in the wrong window), and under ruling 2 the lock
/// is held THROUGH the injection. The F-2248 "live wins" reconciliation applies
/// only in the UNLOCKED case (Idle/Cooldown), where the live foreground simply
/// IS the target. Divergence during an active lock is logged for RCA parity
/// (07 §10 [FLOWMIC-RCA]: locked HWND vs live foreground). Returns
/// `(hwnd, window_title, process_name)`.
pub(super) fn resolve_inject_target(fsm: &Mutex<FocusStateMachine>) -> Option<(u64, String, String)> {
    let locked = {
        let m = fsm.lock().unwrap();
        match m.state() {
            FocusState::SpeakingLocked {
                target_hwnd,
                app_name,
                window_title,
            }
            | FocusState::Injecting {
                target_hwnd,
                app_name,
                window_title,
            } => Some((*target_hwnd, window_title.clone(), app_name.clone())),
            _ => None,
        }
    };
    match locked {
        Some((hwnd, title, app)) => {
            if let Some((live_h, _lt, live_app)) = focus::current_foreground_target() {
                if live_h != hwnd {
                    eprintln!(
                        "[FLOWMIC-RCA] inject target: locked hwnd={hwnd} app={app:?}; \
                         live hwnd={live_h} app={live_app:?} — lock holds (F-203/ruling-2)"
                    );
                    forensic::record(
                        "rca",
                        &format!(
                            "inject target: locked hwnd={hwnd} app={app:?}; live hwnd={live_h} app={live_app:?} — lock holds"
                        ),
                    );
                }
            }
            Some((hwnd, title, app))
        }
        // Unlocked (Idle/Cooldown) → the live foreground is the target.
        None => focus::current_foreground_target(),
    }
}

/// Smoke-safety allowlist gate: decline a LIVE inject/control into any window
/// whose process is not on the allowlist (a self-built sacrificial window).
/// `None` in production (inject into whatever the user focused, by design).
pub(super) fn apply_allowlist(
    target: Option<(u64, String, String)>,
    allowlist: &Option<Vec<String>>,
    ctx: &str,
) -> Option<(u64, String, String)> {
    match (&target, allowlist) {
        (Some((_h, _t, app)), Some(allow))
            if !allow.iter().any(|p| p.eq_ignore_ascii_case(app)) =>
        {
            eprintln!("[flowmic] {ctx} declined: foreground '{app}' not in allowlist (smoke guard)");
            None // no live target → the pipeline reports cached, never injected
        }
        _ => target,
    }
}

/// After an inject resolves, whether the SPEAKING-lock watchdog deadline may be
/// disarmed. TRUE only when THIS inject's lock actually released (the FSM left
/// SpeakingLocked). If a NEW utterance's `audio:start` re-locked us mid-pipeline
/// (state is still SpeakingLocked — the old inject's InjectFinished was an
/// illegal transition the FSM correctly ignores, keeping the new lock), its 32s
/// deadline MUST stay armed so its own watchdog can still fire — disarming it
/// here would let a stale lock wedge with no watchdog and mis-target a later
/// manual/history inject.
pub(super) fn should_disarm_watchdog(state: &FocusState) -> bool {
    !matches!(state, FocusState::SpeakingLocked { .. })
}

/// INJ-3/INJ-1 dedup → resolve target from the FSM → three-stage pipeline →
/// truthful inject:result (A-58 echo). Returns `None` when the frame is an INJ-1
/// byte-window duplicate that is discarded with no result frame (07 §2); a
/// request_id replay returns the byte-identical first result WITHOUT re-typing.
pub(super) fn run_inject(
    req: &InjectRequest,
    allowlist: &Option<Vec<String>>,
    fsm: &Mutex<FocusStateMachine>,
    lock_deadline: &Mutex<Option<Instant>>,
    deduper: &Mutex<InjectDeduper>,
) -> Option<Value> {
    let now = now_millis().max(0) as u64;

    // ── INJ-3 / INJ-1 dedup — decided BEFORE any physical typing ──────────
    let decision = deduper.lock().unwrap().classify(
        &req.source,
        req.request_id.as_deref(),
        &req.text,
        now,
    );
    match decision {
        InjectDecision::Replay(cached) => {
            // G-13 (window B4-16): since the dedup table is now MACHINE-scoped, this
            // hit may have been recorded while serving the OTHER channel — the
            // phone's outbox retried over whichever link was up. The cached
            // `Value` is still the right answer verbatim: `build_inject_result`
            // writes ok / mode / target / injected_at and echoes the frame's
            // request_id + entry_id, and NOT ONE of those fields names a
            // channel, a room or a socket. The reply simply goes back out on
            // whichever channel asked — `client.rs` emits on the socket the
            // frame arrived on, so the asker is the one answered. (Full
            // reasoning, including why the replayed `entry_id` cannot mismatch,
            // is in dedup.rs's SCOPE block — one copy, not three.)
            eprintln!(
                "[flowmic] inject dedup HIT request_id={:?} — replaying cached result (no re-type)",
                req.request_id
            );
            forensic::record(
                "inject",
                &format!("dedup HIT request_id={:?} — replay cached (no re-type)", req.request_id),
            );
            return Some(cached);
        }
        InjectDecision::AlreadyTypedOnDisk { mode_wire } => {
            // RV-83 (owner 2026-08-01): a PRIOR process life already typed this
            // request_id — the on-disk ledger says so — but THIS process never
            // ran the pipeline for it, so there is no byte-identical `Value` to
            // replay (unlike the in-memory `Replay` branch above). Build a
            // FRESH, honest `inject:result` instead:
            //   ok:true, mode:<what we genuinely recorded> — the two things we
            //   actually know.
            //   target/inject_target: omitted (`target: None` below) — this
            //   process never saw the window this was typed into, and owner's
            //   ruling is explicit that a restart must not re-claim a place or
            //   time it did not itself observe ("do not replay the pre-restart old result").
            //   request_id/entry_id: echoed from THIS retry frame (`req`, via
            //   `build_inject_result`'s existing A-58 echo), never from a
            //   stored value — the retry itself carries the only ids this
            //   reply is allowed to assert.
            //   focus_window/focus_evidence: 🔴 OMITTED, and this is the SAME
            //   ruling as the line above rather than an oversight (IJ-01 §A-1).
            //   This process never looked at a window for this delivery, so
            //   naming one would be re-claiming a place it never observed — the
            //   exact thing the paragraph above forbids for `inject_target`.
            let result = wire::build_inject_result(
                true,
                &mode_wire,
                None,
                None,
                "",
                req,
                wire::FocusObservation::default(),
            );
            eprintln!(
                "[flowmic] inject dedup HIT (on-disk ledger) request_id={:?} mode={mode_wire} — \
                 typed before this process started; not re-typing, replying without the \
                 original target/time (never observed by this process)",
                req.request_id
            );
            forensic::record(
                "inject",
                &format!(
                    "dedup HIT (disk ledger, RV-83) request_id={:?} mode={mode_wire} — typed by \
                     a prior process life; reply omits target/injected_at on purpose",
                    req.request_id
                ),
            );
            return Some(result);
        }
        InjectDecision::Suppress => {
            eprintln!(
                "[flowmic] inject INJ-1 byte-window duplicate — discarded (no re-type, no result)"
            );
            forensic::record("inject", "INJ-1 byte-window duplicate — discarded (no re-type)");
            return None;
        }
        InjectDecision::Proceed => {}
    }

    // ── 🔴 L8 · Deferred-delivery messages must not be auto-injected (owner 2026-08-02 ruling) ──────────────────
    //
    // owner: "For a message that failed to send earlier and is later (once back
    // online) delivered to the PC as a deferred delivery — the PC side must not
    // casually inject it. At that point the user has no way to predict this
    // behavior and is not prepared for it; injecting straight into the current
    // input window could cause an accident."
    //
    // THREE PROPERTIES OF THIS PLACEMENT, each of which is the reason it is not one
    // line earlier or one line later:
    //
    //   ① AFTER DEDUP, and this ordering is load-bearing. The phone's queue re-sends
    //      an unanswered delivery under the SAME `request_id`, stamped `deferred`
    //      the second time (by then it IS a re-delivery). If this gate ran first, an
    //      utterance that was genuinely TYPED on the first frame would be answered
    //      "not injected" on the retry and the phone's row would go BACKWARDS from
    //      injected to cached. INJ-3 replays the original verdict verbatim above, so
    //      that never reaches here.
    //   ② BEFORE the FSM lock transition and before the pipeline, so a delivery we
    //      have already decided not to type never takes the user's foreground on its
    //      way to doing nothing (`stage1_focus` calls SetForegroundWindow). "zero
    //      injections" is therefore provable as "the focus switcher was never called" rather
    //      than "it was called and we changed our mind" — see inject_ops_tests.rs.
    //      🔴 CORRECTION (IJ-01, 2026-08-07): this used to read "BEFORE
    //      `resolve_inject_target`" and that stopped being true in this very round.
    //      The branch now DOES call `resolve_inject_target` + `apply_allowlist`, in
    //      order to report WHICH WINDOW the delivery arrived at (owner 2026-08-07
    //      ruling ④ — a not-injected row still has to be able to say "which window it faced"). Both
    //      calls are READ-ONLY: they read the FSM and `focus::current_foreground_
    //      target()` and write a log line. What ② actually protects — no
    //      `SetForegroundWindow`, no `FocusEvent::InjectStarted` — is unchanged, and
    //      is what the test pins. Anti-façade ④: the sentence had to move because the
    //      behaviour it asserted moved.
    //   ③ BEFORE the text/image split, so it covers BOTH. An unexpected picture
    //      pasted into the user's document is the same accident as an unexpected
    //      sentence, and arguably a louder one.
    //
    // ⚠️ THE ROW IS STILL MINTED. This returns a truthful verdict, and `mint_row`
    // (client.rs, ruling 2) builds the timeline row from it exactly as it does for any
    // other outcome — "the timeline = all messages delivered to this PC". The message is not
    // dropped, it is delivered-and-not-typed, which is a state this product can now
    // express (a delivery/injection two-part contract).
    if let Some(deferred) = inject::deferred_outcome(req.origin) {
        // IJ-01 §A-2 — WHICH WINDOW this delivery arrived at, read HERE because the
        // branch returns before the pipeline would have resolved it. Read-only: the
        // FSM is not transitioned, the foreground is not taken, no key is sent. The
        // same two functions the normal path uses, so "which window" has one answer.
        //
        // ⚠️ `None` HERE IS A REAL AND CORRECT ANSWER, not a failure to look: a deferred delivery
        // usually drains while the user is NOT speaking ⇒ the FSM is Idle/Cooldown ⇒
        // the target falls through to `focus::current_foreground_target()`, which is
        // itself `None` when a FlowMic window is in front. The frame then carries no
        // `focus_window`, which is the truth.
        let observed = apply_allowlist(resolve_inject_target(fsm), allowlist, "inject(deferred)");
        // ⚠️ SELF-EXPOSING LINE. It prints whether the frame STATED its origin, not
        // only what the decision was — because the one failure this feature has is
        // silent: a relay older than 0.2.48 strips `inject_origin` in flight (zod),
        // the frame arrives unmarked, and the PC types a deferred delivery exactly as it used to.
        // Without `stated=` in the log that reads identically to "the phone said
        // live", and "was the relay deployed first" becomes unanswerable after the fact.
        forensic::record(
            "inject",
            &format!(
                // 🔴 「no target resolved」 was removed from this sentence in the same
                // commit that made it false (IJ-01). The window IS resolved now, for
                // reporting; what still holds — and what this line has to keep
                // saying — is that no focus was taken and no key was sent.
                "DEFERRED — not auto-injected (owner 2026-08-02): source={} request_id={:?} \
                 chars={} inject_origin={} → ok=false mode=cached err={}; window observed \
                 (read-only) = {:?}, no focus taken, no key sent. The row is minted and the \
                 user re-injects it from this PC's timeline.",
                req.source,
                req.request_id,
                req.text.chars().count(),
                inject::InjectOrigin::tag(req.origin_stated, req.origin),
                error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED,
                observed.as_ref().map(|(_, t, a)| format!("{a}:{t}")),
            ),
        );
        let injected_at = now_millis().to_string();
        return Some(wire::build_inject_result(
            deferred.ok,
            deferred.mode.wire(),
            deferred.error_code,
            // No target: nothing was reached, and a non-delivery makes no claim
            // about where it landed (04 §3.5, same rule the failure paths follow).
            None,
            &injected_at,
            req,
            wire::FocusObservation {
                // …but WHICH WINDOW it arrived at is a different question, and this
                // one we really did observe (IJ-01 §A-1 row 2).
                window: observed.as_ref().map(|(_, t, a)| (t.as_str(), a.as_str())),
                // 🔴 ABSENT, never `unknown`: Stage 1b is inside the pipeline and the
                // pipeline was never entered. "we never asked" ≠ "we asked and got no answer" (§A-4).
                evidence: None,
            },
        ));
        // ⚠️ NOT RECORDED IN THE DEDUPER, deliberately and consistently with the
        // rule at the bottom of this function: only a frame that actually touched
        // the keyboard is cached for replay. A refused deferred delivery that is later sent again
        // as a USER action (`inject_origin:'live'`) must get a fresh, real attempt
        // rather than a replay of this refusal.
    }

    // ── Resolve target from the FSM (lock wins) + smoke allowlist ─────────
    let target = apply_allowlist(resolve_inject_target(fsm), allowlist, "inject");
    let (locked, app_id) = match &target {
        Some((h, _title, app)) => (Some(*h), Some(app.as_str())),
        None => (None, None),
    };

    // ── Lock lifecycle: carry the lock into Injecting, release AFTER resolve
    //    (ruling 2 — never unlock before the keystroke lands) ──────────────
    {
        let n = now_millis().max(0) as u64;
        let _ = fsm.lock().unwrap().handle(FocusEvent::InjectStarted, n);
    }
    // R6 T-4: an image frame takes the PICTURE path — clipboard-only, but the
    // same save → delayed-render-confirm → restore-always contract, and the
    // same "unconfirmed consumption is never `injected`" rule. A frame that
    // CLAIMS `source:'image'` but is missing a field is routed here too (with
    // an empty payload, which the decoder rejects by name) rather than falling
    // through to the text path — there its empty `text` would short-circuit
    // `inject_text` to a fabricated ok=true, i.e. a silent false success.
    if req.is_malformed_image() {
        forensic::record("inject", "source='image' without image_b64+image_mime — rejecting");
    }
    let outcome = if req.source == "image" {
        let (b64, mime) = req.image().unwrap_or(("", ""));
        inject::inject_image(b64, mime, locked, focus::set_foreground_window)
    } else {
        inject::inject_text(&req.text, locked, app_id, focus::set_foreground_window)
    };
    // Release the lock AFTER the keystroke resolved (ruling 2), then disarm the
    // watchdog ONLY when this inject's own lock released. A new utterance whose
    // audio:start re-locked us mid-pipeline keeps its 32s deadline armed.
    let disarm = {
        let mut m = fsm.lock().unwrap();
        let n = now_millis().max(0) as u64;
        let _ = m.handle(FocusEvent::InjectFinished { now_ms: n }, n);
        should_disarm_watchdog(m.state())
    };
    if disarm {
        *lock_deadline.lock().unwrap() = None; // this inject's lock released → watchdog stands down
    }

    let injected_at = now_millis().to_string();
    let tgt = if outcome.ok {
        target.as_ref().map(|(_, t, a)| (t.as_str(), a.as_str()))
    } else {
        None
    };
    let result = wire::build_inject_result(
        outcome.ok,
        outcome.mode.wire(),
        outcome.error_code,
        tgt,
        &injected_at,
        req,
        // 🔴 IJ-01 — THE LINE THIS CARD EXISTS FOR. `tgt` above is gated on
        // `outcome.ok` because it answers "where the characters landed"; the two below answer
        // "which window this attempt faced, and what we read there" and are true on every outcome,
        // which is exactly the half that used to be computed and discarded.
        // ⚠️ NOT a widening of `tgt`: both keys are new, so `inject_target`'s
        // 「only on ok:true」 contract (04 §3.5 F-3112) is untouched.
        wire::FocusObservation {
            window: target.as_ref().map(|(_, t, a)| (t.as_str(), a.as_str())),
            // `None` when the pipeline returned before Stage 1b (an empty utterance,
            // the length cap, Stage 0, a Stage-1 focus loss) — the key is then
            // omitted rather than filled with `unknown`.
            evidence: outcome.focus_evidence.map(inject::wire_evidence),
        },
    );
    // Inject resolve-truth summary (07 §10) — the delivery outcome as the forensic trail sees it.
    //
    // v0.2.2 — two things this line used to DROP, both of them exactly the thing
    // you need when it says `ok=false`:
    //
    //   · the TARGET. It logged `tgt`, which is deliberately `None` on failure
    //     because the WIRE result omits it (04: a non-delivery makes no claim
    //     about where it landed). Correct on the wire, backwards in a log — the
    //     window we were trying to reach matters MOST when we did not reach it.
    //     Logs the real resolved target now, on both outcomes.
    //   · the error MESSAGE. `map_image_outcome` goes to the trouble of naming
    //     which clipboard format the target asked for — written precisely for
    //     this moment — and then only `error_code` was recorded, so every image
    //     failure read as an identical, undiagnosable `INJECT_CLIPBOARD_FAIL`.
    //     (Four of them did, across three days, before anyone noticed the
    //     diagnostic existed and was being thrown away.)
    //
    // Neither changes a byte on the wire; this is the forensic log's own job.
    forensic::record(
        "inject",
        &format!(
            "resolve ok={} mode={} err={:?} target={:?} source={} request_id={:?} chars={} detail={:?}",
            outcome.ok,
            outcome.mode.wire(),
            outcome.error_code,
            target.as_ref().map(|(_, t, a)| format!("{a}:{t}")),
            req.source,
            req.request_id,
            req.text.chars().count(),
            outcome.error_message.as_deref().unwrap_or("-"),
        ),
    );

    // Cache for a future replay / refresh the INJ-1 byte window ONLY when the
    // keyboard was actually touched (mode != cached). A cached (untouched)
    // utterance is NOT recorded, so its reconnect-flap replay gets a fresh
    // delivery attempt — "physically typed once" is about typed frames.
    if outcome.mode != inject::InjectMode::Cached {
        deduper.lock().unwrap().record(
            &req.source,
            req.request_id.as_deref(),
            &req.text,
            &result,
            now,
        );
    }
    Some(result)
}

/// RV-25 — how a control:key CHORD ended. One variant per exit of the
/// chord branch below.
///
/// The chord branch had THREE exits that sent nothing and said nothing, while the
/// punctuation branch in the same function records every outcome. So "pressed a
/// chord but nothing happened" had no record on file in the forensic log: "control:key
/// never reached the desktop" and "it arrived, but some precondition wasn't met" read identically (i.e. as silence). Since control:key
/// has NO result frame in the protocol, the log is the ONLY place that outcome can
/// live — a missing line there is the whole story missing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ChordExit {
    /// SendInput accepted the whole sequence.
    Sent,
    /// The target was raised, but the OS refused the sequence (carries the
    /// FlowKeyError text — `Rejected` and `Win32(n)` are different problems).
    SendFailed(String),
    /// The OS would discard a synthetic keystroke right now (macOS: no
    /// Accessibility grant, or secure event input is on). Nothing was posted and
    /// the foreground was NOT taken. Carries the preflight's error code so the
    /// log names WHICH of the two conditions held.
    OsWillNotDeliver(String),
    /// A target existed but could not be brought to the foreground, so the keys
    /// would have landed in whatever window IS foreground. Not sent, on purpose.
    ForegroundRefused,
    /// No target at all: no live foreground to resolve, or the smoke allowlist
    /// declined the one there was.
    NoTarget,
}

impl ChordExit {
    /// The forensic wording. Every variant names the PRECONDITION that did not
    /// hold, because "why it wasn't sent" is the only question this line exists to
    /// answer — restating "not sent" is not an answer. Mirrors the punctuation
    /// branch's one-line-per-outcome shape.
    pub(super) fn line(&self, kind: &str, hwnd: Option<u64>, keys: usize) -> String {
        let where_ = match hwnd {
            Some(h) => format!("hwnd={h}"),
            None => "hwnd=-".to_string(),
        };
        match self {
            ChordExit::Sent => format!("chord {kind} sent ({where_} chords={keys})"),
            // 🔴 W3 2026-08-07: was 「SendInput refused the sequence」. There is no
            // SendInput on macOS — naming a Win32 API as the refuser on a platform
            // that has none sends the reader hunting through Win32 docs for a
            // CGEvent problem. The `{err}` already distinguishes the real causes.
            ChordExit::SendFailed(err) => format!(
                "chord {kind} NOT sent — the OS refused the sequence ({where_} chords={keys}): {err}"
            ),
            ChordExit::OsWillNotDeliver(code) => format!(
                "chord {kind} NOT sent — the OS would discard synthetic keystrokes right now \
                 ({code}); foreground NOT taken ({where_} chords={keys})"
            ),
            ChordExit::ForegroundRefused => format!(
                "chord {kind} NOT sent — SetForegroundWindow({where_}) refused, so the keys would \
                 have landed in another window"
            ),
            ChordExit::NoTarget => format!(
                "chord {kind} NOT sent — no inject target resolved (no live foreground, or the \
                 smoke allowlist declined it)"
            ),
        }
    }
}

impl ChordExit {
    /// The ROW's view of this exit (REQ-12-13, doc 15 §2.0-e).
    ///
    /// 🔴 COARSER THAN THE FORENSIC LINE, ON PURPOSE. `SendFailed` carries the OS's
    /// own words because a diagnosis needs them; a row must not, because the user's
    /// action is identical for every non-`Sent` exit and spelling `Win32(5)` at them
    /// answers a question they did not ask. The detail stays in [`ChordExit::line`],
    /// which is written on the SAME press — nothing is lost, it is filed where it is
    /// read.
    pub(super) fn outcome(&self) -> ControlOutcome {
        match self {
            ChordExit::Sent => ControlOutcome::Sent,
            ChordExit::SendFailed(_) => ControlOutcome::SendFailed,
            ChordExit::OsWillNotDeliver(_) => ControlOutcome::OsRefused,
            ChordExit::ForegroundRefused => ControlOutcome::ForegroundRefused,
            ChordExit::NoTarget => ControlOutcome::NoTarget,
        }
    }
}

/// Run one control:key kind. Unknown kinds fail loud (CONTROL_UNKNOWN_KIND) and
/// are never injected. The target is resolved from the FSM exactly like inject
/// (a `clear`/`enter` mid-utterance must land in the SPEAKING-locked window, not
/// a window the user switched to — 07 §3).
///
/// RETURNS the row-facing outcome for a CHORD key, or `None` when this press mints
/// no row at all. The two `None` cases are deliberately different things and both
/// are out of REQ-12-13's scope by ruling rather than by accident:
///   · a `punct_*` key — it edits the newest EXISTING row's text (owner 2026-07-28)
///     rather than being an act of its own, and the execution card puts the six
///     punctuation keys out of scope in so many words;
///   · an unknown kind — nothing happened, and "minting a row that says nothing happened" would be a
///     receipt for a non-event. It is already answered loudly in the forensic log.
///
/// ⚠️ The caller mints; this function does not. Minting needs the bridge sink and the
/// channel, which are socket-lifecycle facts — the same split `run_inject` /
/// `mint_row` already uses, and it keeps this function testable without a window.
pub(super) fn run_control_key(
    kind: &str,
    allowlist: &Option<Vec<String>>,
    fsm: &Mutex<FocusStateMachine>,
) -> Option<ControlOutcome> {
    // v0.2.1 — the punctuation half of the whitelist is TYPED, not chorded (there
    // is no virtual key for 「、」). Routing it through the ordinary text pipeline
    // rather than a bespoke path is the point: it inherits Stage-1 focus, Stage-1b
    // "whether there is an editable control", the process-wide injection gate and the read-back
    // receipt. A second hand-rolled keystroke path would have had none of those,
    // and would have drifted from them the first time one changed.
    if let Some(glyph) = inject::punctuation_for(kind) {
        let target = apply_allowlist(resolve_inject_target(fsm), allowlist, "control:key");
        let (locked, app_id) = match &target {
            Some((h, _t, app)) => (Some(*h), Some(app.as_str())),
            None => (None, None),
        };
        let outcome = inject::inject_text(glyph, locked, app_id, focus::set_foreground_window);
        // control:key has NO result frame in the protocol, so the outcome cannot
        // be answered on the wire. It is recorded instead — an unreportable
        // outcome still has to be a discoverable one.
        forensic::record(
            "control",
            &format!(
                "punctuation {kind} ok={} mode={} err={:?}",
                outcome.ok,
                outcome.mode.wire(),
                outcome.error_code
            ),
        );
        return None;
    }
    match inject::key_sequence_for(kind) {
        Some(seq) => {
            let target = apply_allowlist(resolve_inject_target(fsm), allowlist, "control:key");
            // RV-25 — the three exits below used to leave no trace at all. The
            // predicates and the order are untouched; each exit now says which
            // precondition failed (ChordExit), so a chord that did nothing is
            // answerable from the log instead of indistinguishable from a frame
            // that never arrived.
            if let Some((h, _t, _app)) = target {
                // 🔴 W3 2026-08-07 — the SAME gate the text and image paths take,
                // and it was missing here. `flow_key.rs`'s macOS arm carried a
                // comment claiming delivery 「is decided by the two OS conditions
                // read in preflight::synthetic_input_preflight before any of this
                // runs」 — true of the two inject paths, FALSE of this one, which
                // is the only production caller of `send_chords` and went straight
                // from `set_foreground_window` to posting events.
                //
                // What that cost on macOS without Accessibility: `CGEventPost`
                // returns void, so `post_chord` answered `true`, `send_chords`
                // answered `Ok(())`, and this line wrote 「chord {kind} sent」 for
                // keystrokes the window server discarded. `control:key` has NO
                // result frame — the forensic line is the ONLY evidence surface it
                // has — so the one artefact that exists said an act happened that
                // did not. "no silent failures" forbids both directions, and this was
                // the second one.
                //
                // Checked BEFORE `set_foreground_window` on purpose: a refusal must
                // not steal the user's foreground on its way to doing nothing —
                // the same ordering the text path asserts in
                // `a_refused_synthetic_input_gate_ends_the_text_frame_before_stage_1`.
                //
                // ⚠️ REQ-12-13 turned three `return`s and two `record` call sites into
                // ONE expression that yields the exit. The PREDICATES AND THEIR ORDER
                // ARE UNTOUCHED — `synthetic_input_preflight` is still evaluated
                // before `set_foreground_window`, which is the whole point of the
                // paragraph above. What changed is that every arm now produces a value
                // instead of ending the function, so the row and the forensic line
                // cannot fall out of step: they are built from the same `exit`.
                let exit = if let Some(refused) = crate::inject::preflight::synthetic_input_preflight() {
                    ChordExit::OsWillNotDeliver(refused.error_code.unwrap_or("(none)").to_string())
                } else if focus::set_foreground_window(h) {
                    match inject::send_chords(&seq) {
                        Ok(()) => ChordExit::Sent,
                        Err(e) => ChordExit::SendFailed(e.to_string()),
                    }
                } else {
                    ChordExit::ForegroundRefused
                };
                forensic::record("control", &exit.line(kind, Some(h), seq.len()));
                Some(exit.outcome())
            } else {
                forensic::record("control", &ChordExit::NoTarget.line(kind, None, seq.len()));
                Some(ChordExit::NoTarget.outcome())
            }
        }
        None => {
            eprintln!(
                "[flowmic] control:key rejected: kind={kind:?} -> {}",
                error_codes::CONTROL_UNKNOWN_KIND,
            );
            forensic::record(
                "control",
                &format!("rejected kind={kind:?} -> {}", error_codes::CONTROL_UNKNOWN_KIND),
            );
            // No row: see the doc comment. An unknown kind did nothing, and a row
            // saying so would be a receipt for a non-event.
            None
        }
    }
}

#[cfg(test)]
#[path = "inject_ops_tests.rs"]
mod tests;

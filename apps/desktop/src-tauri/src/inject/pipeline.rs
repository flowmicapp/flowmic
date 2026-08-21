// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (three-stage injection pipeline)
//   docs/rebuild/05-DATA-MODEL.md §1 (status = delivery truth: injected/cached/
//     failed — inject:result carries the TRUE outcome, never optimistic)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D4 (inject provenance: entry_id/
//     request_id exact echo, not FIFO)
//   master-plan §4 / CLAUDE.md red line: no silent failures — LLM/STT text is never
//     silently re-injected; a lost focus is reported cached, both-paths-fail
//     is reported failed.
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
//   docs/strategy/2026-07-30-inject-state-narrowing-design.md §1/§3
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//
// Stage 1  — switch focus: `focus_switcher(target_hwnd)` BEFORE any keystroke.
//   No target, or the switch refused → INJECT_FOCUS_LOST, mode=Cached (ok=false).
// Stage 1b — is the keyboard focus in an input state? (target_probe.rs)
//   Provably not (nothing focused / a menu is up) → INJECT_NO_TEXT_TARGET, failed.
//   Inconclusive → PROCEED. That default is load-bearing; see target_probe.rs.
// Stage 2  — SendInput (skipped when per-app learning prefers Clipboard).
// Stage 3  — clipboard paste. Both paths erroring → mode=Clipboard, ok=false,
//   INJECT_CLIPBOARD_FAIL (the relay maps this to status=failed).
//
// ── what each word claims, as of owner's 2026-07-30 ruling (design §1) ─────────
//
//   injected — 「delivered to the keyboard focus, and the focus was in an
//              input-capable state at that moment」. Three pieces of evidence,
//              all held BEFORE the act: ① Stage 1 got the foreground window,
//              ② Stage 1b did not prove the focus unusable, ③ SendInput accepted
//              N events (or the paste completed without a Win32 error). It does
//              NOT claim the target app kept the text — that is the target's
//              business and nothing on this platform will tell us out of process.
//   failed   — a premise did not hold, or our own act errored. We KNOW it did not
//              happen.
//   cached   — 🔴 card L7 (owner 2026-08-02): this line originally read 「nothing
//              was **delivered** and it can be re-**delivered** later」 —
//              **both uses of "delivered" are borrowed terms**. This entire file
//              lives inside **part ② (PC → focus window = injection)**: a frame
//              that reaches Stage 1 has **already been delivered successfully**
//              (it is sitting in this PC's memory). The correct wording is
//              「**not injected — the content stays on the timeline and can be
//              re-injected later**」 — docs/rebuild/15 §2.0's two-part
//              terminology table, rule 1 「the same word must never be reused
//              across the two parts」.
//              This borrowed term once made it all the way to the user's screen:
//              the capsule was, as a result, saying 「not delivered」.
//              🔴 card L8 (owner 2026-08-02, same batch as the one above):
//              **from now on `cached` has two causes, and they have opposite
//              implications for what the user should do** — ① Stage 1 「could not
//              find a focus」 ⇒ clicking into an input field would make it land;
//              ② `inject_origin:'deferred'` 「this is an automatic re-delivery,
//              deliberately not injected」 ⇒ doing anything to the window is
//              useless, the user has to actively click "re-inject" on the
//              timeline. The two are separated by **different error codes**
//              (INJECT_FOCUS_LOST / INJECT_DEFERRED_NOT_AUTOINJECTED), and
//              doc 15 requires the UI to display them separately as well: one
//              status word must not answer two questions.
//              🔴 owner's 2026-08-02 F1a reversal ruling added **a third
//              cause**: ③ the focus is on FlowMic's **own window**, and the
//              window holds no editable element (`INJECT_SELF_WINDOW_NO_INPUT`,
//              `self_window_stage0`). It differs from ① in that 「we can name
//              that window, and it is right in front of the user」, and from
//              ② in that 「doing one thing to the window (clicking into an input
//              field) solves it」.
//              **The same batch also turned the OPPOSITE of ① into a feature**:
//              when the cursor really is inside our own input field ⇒ **inject
//              as usual**, and this path's `injected` and the cross-process
//              `injected` **carry the same meaning**
//              (delivered to the keyboard focus, and the focus is not provably
//              non-input-capable) — only the own-window half of that sentence
//              is **exact** rather than 「when it cannot be proven, let it
//              through」.
//              🔴 `injected` must NEVER be allowed to carry two meanings
//              (docs/decisions/2026-07-30-rv45-is-an-optional-enhancement-not-a-prerequisite.md).
//
// Retired here in the same pass: the UIA pre-check and the before/after read-back,
// both of which demanded evidence the platform does not hand out, and both of
// which produced an owner P0 in the two days before this (0.2.19 refused every
// browser dictation; 0.2.21 called landed text 「not injected」).
//
// Truth table for inject:result mapped by the relay handler
// (server-core relay.handler.ts):
//   ok=true                       → status injected  (mode sendinput|clipboard)
//   ok=false, mode=cached         → status cached
//   ok=false, mode=sendinput|clip → status failed

use crate::error_codes;
use crate::inject::app_learning::AppLearningStore;
use crate::inject::clipboard_paste::ClipboardFallbackClient;
use crate::inject::image;
use crate::inject::sendinput::SendInputClient;
// 🔴 THE TWO PRE-PIPELINE GATES LIVE IN `preflight.rs` (800-line cap split). They
// are imported rather than re-implemented — `self_window_stage0` is consulted from
// `inject_text_with_probe` below and `deferred_outcome` from `socket/inject_ops.rs`,
// which is the whole reason they are not private to either file.
use crate::inject::preflight::{self_window_stage0, synthetic_input_preflight};
use crate::inject::self_focus::{current_verdict, SelfFocusProbe};
use crate::inject::target_probe::{
    focused_input_state, image_refusal_for, refusal_for, TargetProbe,
};
use crate::inject::gate::lock_inject_gate;
// The paste OUTCOME-MAPPING rules live in `clipboard_outcome.rs` (800-line cap
// split), mirroring `sendinput_outcome.rs` for the typing path. Imported rather
// than re-implemented.
use crate::inject::clipboard_outcome::{
    map_clipboard_outcome, map_image_outcome, map_ime_routed_clipboard_outcome,
};
use crate::inject::text_route;
// ⚠️ TEST-ONLY RE-EXPORTS, and they are what makes 「not one test moved for this
// split」 literally true. `pipeline_tests.rs` reaches its subjects through
// `use super::*`, so five names the PRODUCTION build no longer needs still have to
// resolve in this module's namespace. Gated rather than left plain because clippy's
// `-D unused-imports` is right about the non-test build: they really are unused
// there, and silencing that with an `#[allow]` would hide the next real one.
#[cfg(test)]
use crate::inject::clipboard_confirm::ConfirmOutcome;
#[cfg(test)]
use crate::inject::clipboard_outcome::receipt_phrase;
#[cfg(test)]
use crate::inject::clipboard_paste::{PasteOutcome, CONFIRM_TIMEOUT};
#[cfg(test)]
use crate::inject::sendinput::InjectError;

/// Hard upper bound on a single injection's text length. Over-limit is REJECTED
/// (never silently truncated) — the protocol adds a zod `.max()` on its side;
/// this is the desktop's own guard. 100k chars is orders of magnitude beyond
/// any real utterance/compose output.
pub const INJECT_TEXT_MAX_CHARS: usize = 100_000;

/// Which physical path an inject attempt took / would take next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectMode {
    /// SendInput primary path.
    SendInput,
    /// Clipboard paste fallback ran into a live target.
    Clipboard,
    /// No live target — the utterance was cached, **not injected**.
    ///
    /// card L7: the original text read 「not delivered」. It **had already** been
    /// delivered successfully (the frame is right here on this PC); what did not
    /// happen is the **injection**. See the `cached` note at this file's header
    /// and docs/rebuild/15 §2.0.
    Cached,
}

impl InjectMode {
    /// The wire token used on inject:result.mode (protocol InjectResultSchema).
    pub fn wire(self) -> &'static str {
        match self {
            InjectMode::SendInput => "sendinput",
            InjectMode::Clipboard => "clipboard",
            InjectMode::Cached => "cached",
        }
    }
}

/// The truthful outcome of one injection attempt. `error_code` is a protocol
/// error-code constant (error_codes.rs) present on every non-`injected`
/// outcome — never absent, never a silent success.
///
/// And, since RV-48 (2026-07-30), ABSENT on every `injected` one: an outcome that
/// claims a delivery does not also carry a failure code. `error_message` never
/// reaches the wire at all (`socket/wire.rs` builds the frame from `ok`, `mode`
/// and `error_code` only) — it is forensic detail, which is why a note may still
/// ride an `ok:true` outcome while the CODE may not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectOutcome {
    pub ok: bool,
    pub mode: InjectMode,
    pub error_code: Option<&'static str>,
    pub error_message: Option<String>,
    /// IJ-01 — WHAT STAGE 1b READ on this attempt, carried out of the pipeline
    /// instead of being computed and thrown away.
    ///
    /// 🔴 `None` MEANS 「we didn't ask」, NOT 「we asked and could not answer」. The latter is
    /// `Some(FocusInputState::Unknown)`. Every outcome produced BEFORE the focus is
    /// read at all (an empty utterance, the length cap, the macOS preflight, a
    /// Stage-1 focus loss) leaves this `None` on purpose — the wire key is then
    /// omitted entirely, which is the only honest thing an unasked question can say.
    /// Same rule as `gui_ok` in target_probe.rs, and the same one IJ-03 §2.2-3
    /// restated for MSAA's `d=0 CLIENT`.
    ///
    /// 🔴 IT IS NOT 「Stage 1b's enum」 — it is 「do we have positive evidence for this focus」. Those are
    /// two different sentences, and defining the field by its INSTRUMENT rather than
    /// by its QUESTION is this repo's headline bug shape. Two instruments feed it:
    /// the cross-process Stage-1b probe, and — for our own window — the in-process
    /// DOM-focus verdict in `self_focus.rs`, which is the only thing in this repo
    /// that can prove `Input` at all. Evidence is not discarded for arriving through
    /// the other one.
    ///
    /// It is REPORTING ONLY: no branch anywhere reads it to decide anything.
    /// `refusal_for` remains the single judge (spec §A-5 — this card changes no
    /// verdict, it only stops discarding one that was already computed).
    pub focus_evidence: Option<crate::inject::target_probe::FocusInputState>,
}

impl InjectOutcome {
    fn ok(mode: InjectMode) -> Self {
        Self {
            ok: true,
            mode,
            error_code: None,
            error_message: None,
            focus_evidence: None,
        }
    }

    /// Stamp the Stage-1b reading onto an outcome produced downstream of it. Done at
    /// the ONE place that holds the reading rather than threaded through
    /// `run_sendinput`/`run_clipboard`, which answer 「how to get the text out」 and nothing else.
    fn with_evidence(
        mut self,
        state: Option<crate::inject::target_probe::FocusInputState>,
    ) -> Self {
        self.focus_evidence = state;
        self
    }
}

/// Focus-switch seam: force the OS foreground onto `hwnd`, returning whether
/// the switch succeeded. Production passes `focus::tracker::set_foreground_window`;
/// tests pass a fake.
pub type FocusSwitcher = fn(u64) -> bool;

/// Inject `text` into the OS. `locked_hwnd` is the SPEAKING-locked / live
/// foreground target; `app_id` is that window's process name (drives per-app
/// learning). `focus_switcher` is the Stage-1 seam.
///
/// Empty text short-circuits ok before the focus check — there is nothing to
/// inject, so there is no focus to lose.
///
/// 2026-07-30: this function used to have a body — a SECOND UIA probe after a
/// refusal, so the forensic line could carry the evidence and not only the
/// conclusion. The evidence now rides the probe itself
/// (`target_probe::focused_input_state` records one line per injection, refusal or
/// not), so there is nothing left to do here. Logging only failures was half the
/// reason the 0.2.19 root cause stayed ambiguous for two days: with no line for
/// the successes there was no baseline to compare a false refusal against.
pub fn inject_text(
    text: &str,
    locked_hwnd: Option<u64>,
    app_id: Option<&str>,
    focus_switcher: FocusSwitcher,
) -> InjectOutcome {
    inject_text_with_probe(
        text,
        locked_hwnd,
        app_id,
        focus_switcher,
        focused_input_state,
        current_verdict,
    )
}

/// [`inject_text`] with both probes injected — the seam the tests drive.
///
/// `self_probe` is a SECOND seam and not a flag on the first: the two answer
/// different questions (「does the cross-process focus look input-capable」 vs 「does our own window have an input focus」)
/// and have opposite defaults on an inconclusive reading. Tests pass
/// `self_focus::never_ours` so no assertion here depends on which window happened
/// to be in front of the machine running the suite.
pub fn inject_text_with_probe(
    text: &str,
    locked_hwnd: Option<u64>,
    app_id: Option<&str>,
    focus_switcher: FocusSwitcher,
    probe: TargetProbe,
    self_probe: SelfFocusProbe,
) -> InjectOutcome {
    if text.is_empty() {
        return InjectOutcome::ok(InjectMode::SendInput);
    }
    // Everything past here touches the clipboard, the keyboard, or the focused
    // window. One at a time (see `inject_gate`).
    let _gate = lock_inject_gate();

    // ── Guard: hard length cap — reject, never silently truncate ──────
    let char_len = text.chars().count();
    if char_len > INJECT_TEXT_MAX_CHARS {
        return InjectOutcome {
            ok: false,
            // Non-`cached` mode → the server maps this ok=false to status=failed.
            mode: InjectMode::SendInput,
            error_code: Some(error_codes::INJECT_TARGET_INVALID),
            error_message: Some(format!(
                "inject text {char_len} chars exceeds cap {INJECT_TEXT_MAX_CHARS}; rejected"
            )),
            // Refused on the FRAME, before any window was looked at.
            focus_evidence: None,
        };
    }

    // ── Stage 0a (MAC-05): will the OS deliver a synthetic keystroke at all? ──
    //
    // 🔴 `None` ON EVERY PLATFORM BUT macOS — see `preflight::synthetic_input_preflight`.
    // This is not a new stage in the Windows pipeline; it is a gate that has
    // nothing to say there and says so by construction.
    //
    // It runs FIRST among the gates because the two things it reads (Accessibility
    // permission, secure event input) make ⌘V vanish with NO api returning an
    // error — the pasteboard write succeeds, the activation succeeds, the events
    // post, and not one character arrives. A verdict built on those return values
    // would be the false-reporting direction of no-silent-failures with a completely clean conscience.
    // Refusing here means nothing has been typed, written or activated yet.
    if let Some(refused) = synthetic_input_preflight() {
        return refused;
    }

    // ── Stage 0: is the window in front of the user OURS? (owner 2026-08-02) ──
    let self_window = match self_window_stage0(locked_hwnd, self_probe) {
        // Our window, no editable focus — the answer, already truthful and named.
        Some(Err(cached)) => return cached,
        // Our window, an editable focus. Type into it.
        Some(Ok(_hwnd)) => true,
        // Not our window: this card changes nothing about the frame.
        None => false,
    };

    // ── Stage 1: focus ────────────────────────────────────────────────
    //
    // SKIPPED for our own window, and that is a statement rather than a shortcut:
    // Stage 0 established the foreground by READING it (`GetForegroundWindow` +
    // `GetCurrentProcessId`), so there is nothing to switch. Calling
    // `SetForegroundWindow` on the window that is already in front would be an act
    // with no effect whose only possible outcome is a spurious `FALSE` → a
    // fabricated INJECT_FOCUS_LOST for a delivery we just proved can land.
    if !self_window {
        if let Err(cached) = stage1_focus(locked_hwnd, focus_switcher) {
            return cached;
        }
    }

    // ── Stage 1b: is the keyboard focus in an input state? ────────────
    //
    // 🔴 ALSO SKIPPED for our own window, and this one is load-bearing. Stage 1b is
    // the CROSS-PROCESS gate: it reads `GetGUIThreadInfo` about a process whose
    // internals it cannot see, and its whole design is 「when it cannot be proven, let it through」. Stage 0
    // answered the SAME question about our own process PRECISELY — the WebView told
    // us which element has DOM focus. Letting the weaker instrument veto the
    // stronger one is 「when two answers conflict, the weaker one wins」; owner's ruling for our own window
    // is explicit that the judgement here is exact and the cross-process boundary
    // does not apply to it.
    //
    // Stage 1 proved we own the foreground WINDOW; this is the second of the three
    // things `injected` now claims (design §1). Its job is NOT to predict success
    // — see the long note in target_probe.rs for why that was impossible from
    // outside the target's process — but to refuse the cases where typing is
    // actively DESTRUCTIVE: nothing holds keyboard focus, or a menu is up and every
    // character is a mnemonic.
    //
    // Inconclusive readings type. That direction of error costs one stray
    // utterance; the other direction cost owner several days of a feature that
    // refused everything.
    let state = if self_window { None } else { Some(probe()) };
    if let Some(code) = state.and_then(refusal_for) {
        return InjectOutcome {
            ok: false,
            // Non-`cached` → the relay maps ok=false to status=failed, which is the
            // truth: we know it was **not injected** (card L7 — it WAS delivered,
            // that is how we come to be judging it). The utterance is NOT lost — it
            // is in the timeline and the phone names the reason, so the user knows
            // to click into a field.
            mode: InjectMode::SendInput,
            error_code: Some(code),
            error_message: Some(
                "keyboard focus is not in an input state (nothing focused, or a menu / \
                 move-resize is active) — synthetic characters there fire the app's \
                 single-key accelerators, so nothing was typed"
                    .to_string(),
            ),
            // The very reading this refusal was made from — reported, not re-derived.
            focus_evidence: state,
        };
    }

    // ── IJ-01: what this attempt is entitled to SAY about the focus ───
    //
    // A SEPARATE binding from `state`, deliberately. `state` is the CROSS-PROCESS
    // gate's reading and feeds `refusal_for` above; touching it would move a
    // verdict, and this card moves none (§A-5). This one is the REPORT, and the two
    // differ in exactly one place:
    //   · our own window — Stage 0 proved an editable DOM focus IN OUR OWN PROCESS
    //     (self_focus.rs). That is not 「Stage 1b says Input」, it is a STRONGER
    //     instrument answering the same question precisely, and evidence is not
    //     thrown away for arriving through the instrument this field was not named
    //     after. Its mirror image — our own window, no editable focus — returns at Stage 0 and
    //     reports `not_editable` from there (`preflight::self_window_no_input`), so
    //     the two halves of one probe are treated alike.
    //   · anything else — verbatim `state`, including `None` (never asked).
    // ⚠️ 🔴 CORRECTED 2026-08-07 (adversarial review). The previous two sentences
    // here read 「Third-party windows are therefore `unknown` today … Every other app
    // on the machine reads `unknown`」 — **that is too strong and it is false**, and
    // the same over-broad sentence had already been copied into a window handoff
    // before anyone checked it against this function.
    //
    // What is actually true, per `target_probe::classify_focus`:
    //   · `editable`   — OUR OWN WINDOW ONLY. Cross-process `ImmGetContext` always
    //                    answers null (measured, see target_probe.rs), so the only
    //                    positive proof available is Stage 0's in-process DOM focus.
    //   · `not_editable` — has TWO producers, not one: (a) our own window with no
    //                    editable DOM focus, reported at Stage 0 by
    //                    `preflight::self_window_no_input`; and (b) a THIRD-PARTY
    //                    window where Stage 1b proves it — a menu/move-size mode is
    //                    up, or nothing holds keyboard focus at all. So a third-party
    //                    app CAN read `not_editable`; it simply can never read
    //                    `editable`.
    //   · `unknown`    — the overwhelming majority of third-party readings.
    //   · absent       — never probed (deferred, admission refusal, disk replay).
    //
    // ⚠️ Do not re-shorten this to 「third parties are unknown」. That shorter
    // sentence is the one that was wrong, and it reads more quotable than it is.
    //
    // 🔴 UPDATED BY IJ-05 (2026-08-08) — the bill above is PART-PAID, and only the
    // part that was actually measured. The paragraph used to end 「with MSAA unwired,
    // the strong tier is reachable ONLY by speaking into FlowMic's own window」. MSAA
    // is now wired, so:
    //   · `editable` — our own window (Stage 0, in-process DOM focus) OR a
    //                  third-party window where MSAA positively identified an
    //                  enabled, writable TEXT element holding focus.
    //   · everything else in the list above is UNCHANGED.
    // MSAA is consulted ONLY here, on the REPORT, and `msaa_focus::upgrade` can make
    // exactly one transition — `Unknown → Input`. It cannot reach `NotInput`, so it
    // cannot reach `refusal_for`, so no verdict moves (§A-5). That is asserted
    // exhaustively over every (base, verdict) pair in `msaa_focus`'s tests, not
    // promised here.
    //
    // ⚠️ [unverified] HOW BIG the new strong tier is in the field. The IJ-03 spike
    // measured that chrome / Cursor / explorer / XshellCore CAN be told apart, and
    // that 360极速浏览器X (360 Speed Browser X) and WeChat cannot (they answer with the window shell, which
    // `judge` rejects by construction) — but the ordinary-user configuration
    // (Medium-integrity FlowMic reading a Medium-integrity target) has never been
    // measured on any machine, and IJ-03b could not measure it either. So the honest
    // statement is 「some third-party apps now reach the strong tier」, and NOT a
    // percentage. Do not let anyone write one here without a measurement.
    // 🔴 TWO COSTS THIS INTRODUCES, named because 「no verdict moved」 invites a reader
    // to conclude 「nothing changed」, and two things did (adversarial review
    // 2026-08-08):
    //
    // ① UP TO `MSAA_BUDGET_MS` OF NEW BLOCKING WORK now sits between Stage 1b and the
    //    keystroke, under the process-wide inject gate, on the MAJORITY path (the
    //    guard below is `Unknown`, and the note above calls that the overwhelming
    //    majority of third-party readings). That WIDENS the existing TOCTOU window
    //    between reading the focus and typing into it: `INJECT_FOCUS_LOST` and
    //    mis-targeted keystrokes are probabilistic, and this makes them marginally
    //    more likely. The budget is [unverified] on every machine so far.
    //
    // ② THE IMAGE PATH IS DELIBERATELY NOT WIRED, and the asymmetry is user-visible.
    //    `inject_image_with_probe` ends `.with_evidence(Some(state))` with no
    //    `upgrade`, so in the SAME window at the SAME instant a sentence can report
    //    `editable` while a pasted picture reports `unknown` — the timeline will show
    //    「✓ injected → Cursor (confirmed input-capable)」 for one and 「delivered
    //    (unconfirmed)」 for the
    //    other. Why it is still right: the image path's `probe()` runs AFTER
    //    `stage1_focus`, and the image policy NEVER refuses (owner 2026-07-29), so a
    //    stronger instrument there changes no behaviour and only buys a second COM
    //    round-trip. ⇒ A DECISION, not an oversight — but one that has to be stated,
    //    because a user comparing two adjacent rows can see it.
    let evidence = if self_window {
        Some(crate::inject::target_probe::FocusInputState::Input)
    } else {
        // Only asked when Stage 1b was inconclusive: `upgrade` is the identity for
        // every other input, so paying for a COM round-trip would buy nothing. This
        // keeps the cost off the refusal path and off our own window entirely.
        if state == Some(crate::inject::target_probe::FocusInputState::Unknown) {
            crate::inject::msaa_focus::upgrade(state, crate::inject::msaa_focus::msaa_verdict())
        } else {
            state
        }
    };
    type_or_paste(text, app_id).with_evidence(evidence)
}

/// Stage 2/3: type first, paste only if the call itself fails.
///
/// Moved out of [`inject_text_with_probe`] VERBATIM (IJ-01) so the Stage-1b reading
/// can be stamped on whichever of its four exits wins; every `return` below returned
/// from the caller before the move and returns the same value now.
///
/// History of this ordering, because it flipped twice and the reasons matter:
/// V2-01 put the CLIPBOARD first, on the grounds that WM_RENDERFORMAT was the
/// only receipt available anywhere; v0.2.1 flipped back to SendInput once
/// read-back was supposed to give typing a receipt too. 2026-07-30 retires the
/// receipt argument on both sides — `injected` no longer claims a landing, so
/// neither path needs to prove one — and SendInput stays in front for two
/// reasons that were always the stronger ones anyway:
///   · the clipboard path takes over the user's clipboard, presses Ctrl+V into
///     their app, and restores afterwards. That is a lot of side effect to spend
///     on the common case where typing works;
///   · it is where the 0.2.1 heap-corruption crash lived (0xc0000374, twice,
///     same StackHash). Keeping it off the default path is defence in depth on
///     top of the re-entrancy fix itself.
fn type_or_paste(text: &str, app_id: Option<&str>) -> InjectOutcome {
    type_or_paste_with(
        text,
        app_id,
        AppLearningStore::global(),
        &run_sendinput,
        &run_clipboard,
        &run_clipboard_ime_routed,
    )
}

/// The three runner seams of [`type_or_paste_with`], named so the signature
/// reads as a contract (and for clippy's type-complexity rule).
type SendInputRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore) -> InjectOutcome;
type ClipboardRun<'a> = &'a dyn Fn(&str, Option<&str>, &AppLearningStore, bool) -> InjectOutcome;
type RoutedPasteRun<'a> = &'a dyn Fn(&str) -> InjectOutcome;

/// [`type_or_paste`] with the three runners injected — the seam the routing
/// tests drive (a live clipboard/keyboard cannot appear in a unit test).
///
/// ── IME-SAFE CONTENT ROUTE (2026-08-21) ──────────────────────────────────────
/// Design: docs/strategy/2026-08-21-ime-safe-inject-routing-design.md.
/// Measured root cause: a CN-state IME in some TSF apps (WeChat 4.x and DingTalk
/// measured; stock Microsoft Wubi suffices) DOUBLES every fullwidth punctuation
/// mark typed as a VK_PACKET stream and SWALLOWS the character after it —
/// 「，你钱」→「，，钱」, byte-for-byte on the real device. SendInput reports every
/// event accepted, so the corruption is invisible to this process.
/// A clipboard paste never enters the per-key IME pipeline, so text that a
/// Chinese-mode IME could take an interest in (CJK / fullwidth — text_route.rs)
/// goes straight to the paste. No app list, no IME probe: both were measured
/// dead or ruled out (design §1/§4), and a pure text predicate behaves the same
/// for apps that do not exist yet.
///
/// The routed paste deliberately writes NO per-app learning (see
/// `map_ime_routed_clipboard_outcome` — it says nothing about the app), and a
/// routed paste that FAILS still falls back to typing: a possibly mangled
/// delivery on a sick target beats a dropped utterance; the note names the trade.
fn type_or_paste_with(
    text: &str,
    app_id: Option<&str>,
    store: &AppLearningStore,
    sendinput_run: SendInputRun<'_>,
    clipboard_run: ClipboardRun<'_>,
    routed_run: RoutedPasteRun<'_>,
) -> InjectOutcome {
    if text_route::needs_ime_immune_path(text) {
        let out = routed_run(text);
        if out.ok {
            return out;
        }
        return sendinput_run(text, app_id, store).with_note(format!(
            "ime-safe clipboard route failed ({}), fell back to SendInput typing — under a \
             CN-state IME some TSF targets may mangle fullwidth punctuation on this path \
             (the corruption the route exists to avoid)",
            out.error_code.unwrap_or("unknown")
        ));
    }
    let preferred = app_id.and_then(|id| store.preferred_mode_for(id));
    match preferred {
        // An app that has HARD-REJECTED SendInput before (returned 0 / a Win32
        // error) goes straight to the paste. Note this is now the only way to get
        // here: 0.2.21 also steered apps whose text we merely could not READ, which
        // pushed working targets onto the more invasive path for no reason.
        Some(InjectMode::Clipboard) => {
            let out = clipboard_run(text, app_id, store, true);
            if out.ok {
                return out;
            }
            // The clipboard could not deliver either. Typing is the last resort.
            sendinput_run(text, app_id, store).with_note(format!(
                "clipboard-first failed ({}), fell through to SendInput",
                out.error_code.unwrap_or("unknown")
            ))
        }
        // Default (no history) and an explicit SendInput preference.
        _ => {
            let out = sendinput_run(text, app_id, store);
            if out.ok {
                return out;
            }
            // 2026-07-30: the 「don't paste on top of a possible landing」 guard that
            // used to sit here (`if out.mode == Cached { return out }`) is GONE with
            // the verdict that produced it. `run_sendinput` can no longer answer
            // `cached` at all — the only non-ok outcome left is a call that errored,
            // which by definition queued nothing, so a paste cannot duplicate
            // anything. Keeping the branch would have been an unreachable guard
            // implying a state that no longer exists.
            let fallback = clipboard_run(text, app_id, store, false);
            if fallback.ok {
                return fallback.with_note(format!(
                    "the SendInput call failed ({}), delivered by clipboard paste instead",
                    out.error_code.unwrap_or("unknown")
                ));
            }
            fallback.with_note(
                "the SendInput call failed, and the clipboard fallback failed too".to_string(),
            )
        }
    }
}

/// Stage 2: type it.
///
/// `type_text` returning `Ok(n)` means n events were accepted into the input
/// queue. That is the whole of what Windows will ever tell us, and as of
/// 2026-07-30 it is also the whole of what we claim — the other two thirds of
/// `injected` (a foreground window, a focus in an input state) were established by
/// Stage 1 and Stage 1b before this runs.
///
/// What used to be here: a before/after UIA read of the target
/// (`verify_readback`), whose verdict decided the outcome. It is deleted. It
/// demanded that the TARGET expose its own text through UIA — the target's choice,
/// not ours — so it went blind precisely in the app owner uses most (Chromium) and
/// produced two P0s in two days. See the note at the top of `sendinput_outcome.rs`.
fn run_sendinput(text: &str, app_id: Option<&str>, store: &AppLearningStore) -> InjectOutcome {
    let sent = SendInputClient::new().type_text(text);
    super::sendinput_outcome::map_sendinput_outcome(sent, app_id, store)
}


/// Stage 1, shared by the text and image paths: take the SPEAKING-locked / live
/// target and force the OS foreground onto it. `Err(outcome)` is the truthful
/// CACHED result for "there was nothing to inject into" — never a silent no-op,
/// and never an `injected` claim for a window we could not reach.
fn stage1_focus(
    locked_hwnd: Option<u64>,
    focus_switcher: FocusSwitcher,
) -> Result<u64, InjectOutcome> {
    let hwnd = match locked_hwnd {
        Some(h) if h != 0 => h,
        _ => {
            return Err(InjectOutcome {
                ok: false,
                mode: InjectMode::Cached,
                error_code: Some(error_codes::INJECT_FOCUS_LOST),
                error_message: Some("Stage-1: no locked/live target HWND".to_string()),
                // The focus read is downstream of here — nothing was asked (§A-4).
                focus_evidence: None,
            });
        }
    };
    if !focus_switcher(hwnd) {
        return Err(InjectOutcome {
            ok: false,
            mode: InjectMode::Cached,
            error_code: Some(error_codes::INJECT_FOCUS_LOST),
            error_message: Some(format!(
                "Stage-1: SetForegroundWindow(hwnd={hwnd}) returned FALSE"
            )),
            focus_evidence: None,
        });
    }
    Ok(hwnd)
}

/// R6 T-4 ②: inject an IMAGE into the focused target.
///
/// The shape deliberately mirrors [`inject_text`] minus Stage 2: there is no
/// SendInput path for a picture, so the clipboard is not a *fallback* here — it
/// is the only path. Everything else is identical and non-negotiable:
///
///   - the payload is validated and decoded BEFORE Stage 1, so a bad frame
///     never steals the user's foreground or touches their clipboard;
///   - Stage 1 focus failure is CACHED (nothing was **injected**; card L7 — the
///     picture was delivered, it is in this process's memory), not failed;
///   - the paste goes through `ClipboardFallbackClient::paste_image`, which
///     saves and ALWAYS restores the user's clipboard;
///   - what an image `injected` CLAIMS (owner 2026-07-30 ruling, design §3):
///     「delivered to the PC, the paste action was executed, and the file has
///     been saved to the data directory」. Whether the target app
///     then accepts an image paste is the target's business — `WM_RENDERFORMAT`
///     is no longer the ok/fail gate, only forensic evidence. See
///     [`map_image_outcome`].
///
/// Per-app learning is deliberately NOT updated from this path: the store
/// records whether an app prefers SendInput or paste for TEXT, and an app that
/// cannot take a picture must not thereby be marked as rejecting typing.
pub fn inject_image(
    image_b64: &str,
    image_mime: &str,
    locked_hwnd: Option<u64>,
    focus_switcher: FocusSwitcher,
) -> InjectOutcome {
    inject_image_with_probe(
        image_b64,
        image_mime,
        locked_hwnd,
        focus_switcher,
        focused_input_state,
    )
}

/// [`inject_image`] with the target probe injected — the seam the tests drive.
pub fn inject_image_with_probe(
    image_b64: &str,
    image_mime: &str,
    locked_hwnd: Option<u64>,
    focus_switcher: FocusSwitcher,
    probe: TargetProbe,
) -> InjectOutcome {
    // Same gate as the text path — the picture path shares `PENDING`, the
    // clipboard save/restore, and the focused window.
    let _gate = lock_inject_gate();
    // ── Guard: decode + validate before any focus/clipboard side effect ──
    let formats = match image::clipboard_formats(image_b64, image_mime) {
        Ok(f) => f,
        Err(err) => {
            return InjectOutcome {
                ok: false,
                // Non-`cached` mode → the server maps this ok=false to failed.
                mode: InjectMode::Clipboard,
                error_code: Some(error_codes::INJECT_IMAGE_UNSUPPORTED),
                error_message: Some(err.reason()),
                // Refused on the PAYLOAD, before any window was looked at.
                focus_evidence: None,
            };
        }
    };

    // ── Stage 0a (MAC-05): same gate, same reason as the text path ────
    //
    // AFTER the payload validation above and BEFORE Stage 1, so a bad frame is
    // still named as a bad frame (that verdict is platform-independent and
    // cheaper), and so a refusal still costs the user no foreground switch.
    if let Some(refused) = synthetic_input_preflight() {
        return refused;
    }

    // ── Stage 1: focus ────────────────────────────────────────────────
    if let Err(cached) = stage1_focus(locked_hwnd, focus_switcher) {
        return cached;
    }

    // ── Stage 1b: what does the focus look like? ─────────────────────
    //
    // v0.2.9 — the PICTURE path used to refuse when the text gate refused, a check
    // borrowed verbatim from the text path above. owner 2026-07-29:「pictures still
    // cannot be injected into the focused input field ... the legacy project could
    // inject successfully」— and that gate is exactly what the legacy
    // line does not have.
    //
    // A picture is delivered by Ctrl+V, and what accepts an image paste is far
    // wider than what accepts typed characters — chat composers, rich editors,
    // canvases, image editors and file panes. And unlike a stray character, a stray
    // Ctrl+V is not an accelerator storm, so the 「don't break anything」 argument that keeps
    // the text gate alive does not apply here either
    // (`docs/decisions/2026-07-29-image-target-policy-differs-from-text.md`).
    //
    // The state is still READ — the forensic line is the point — but
    // `image_refusal_for` refuses nothing. The `if` is kept rather than dropped so
    // that policy stays a named, testable function instead of an absence.
    let state = probe();
    if let Some(code) = image_refusal_for(state) {
        return InjectOutcome {
            ok: false,
            mode: InjectMode::Clipboard,
            error_code: Some(code),
            error_message: Some("picture refused before touching the clipboard".to_string()),
            focus_evidence: Some(state),
        };
    }

    // ── Stage 3 (the only stage an image has): paste it ───────────────
    //
    // IJ-01: the picture path probes and never refuses (owner 2026-07-29), so this
    // reading has ALWAYS been computed and discarded. It now rides the outcome.
    map_image_outcome(ClipboardFallbackClient::new().paste_image(&formats))
        .with_evidence(Some(state))
}

/// Stage-3 clipboard fallback shared by both the learning-skip and the
/// SendInput-failure entries. `skipped_sendinput` only affects the note.
fn run_clipboard(
    text: &str,
    app_id: Option<&str>,
    store: &AppLearningStore,
    skipped_sendinput: bool,
) -> InjectOutcome {
    let result = ClipboardFallbackClient::new().paste_text(text);
    map_clipboard_outcome(result, app_id, store, skipped_sendinput)
}

/// The content route's paste: same client as `run_clipboard`, different mapper
/// (no per-app learning; forensic names the route — see that mapper).
fn run_clipboard_ime_routed(text: &str) -> InjectOutcome {
    map_ime_routed_clipboard_outcome(ClipboardFallbackClient::new().paste_text(text))
}

impl InjectOutcome {
    /// Prefix an existing message with `note` (used to thread the SendInput
    /// error onto a fallback outcome without losing the fallback's own note).
    fn with_note(mut self, note: String) -> Self {
        self.error_message = Some(match self.error_message {
            Some(existing) => format!("{note}; {existing}"),
            None => note,
        });
        self
    }
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;

// IME-safe routing wiring tests — a child of THIS module because
// `type_or_paste_with` is deliberately private (see that file's header).
#[cfg(test)]
#[path = "ime_route_tests.rs"]
mod ime_route_tests;

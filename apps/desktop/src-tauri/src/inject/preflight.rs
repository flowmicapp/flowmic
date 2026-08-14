// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5e
//     (「注入许可：一条投递『该不该被打进焦点窗口』」 ("injection permission: should
//     this delivery be typed into the focused window"))
//   docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md
//   docs/strategy/2026-08-02-0248-status-truth-analysis.md §F1a
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// ── WHY THIS CUT, AND NOT ANOTHER ONE ────────────────────────────────────────
//
// Split out of `pipeline.rs` when the 800-line src cap bit (the same move that
// produced `shell/tray.rs` and `pipeline_tests.rs`). 🔴 NOTHING CHANGED IN THE
// MOVE — every line below is the verbatim text that was in pipeline.rs, and any
// diff beyond「搬移」("the move") would be a bug in this split rather than a change anyone
// asked for.
//
// The knife goes between two different questions, not between「上半个文件」("the
// first half of the file") and 「下半个文件」("the second half of the file"):
//
//   · THIS FILE — 「这一帧该不该被打进焦点窗口，以及该打进谁」 ("whether this frame
//     should be typed into the focused window, and which one it should go to").
//     Verdicts that are
//     fully decidable BEFORE any physical act. Every one of them can END the frame
//     by returning a truthful `InjectOutcome` in place of running the pipeline,
//     and NONE of them touches the keyboard, the clipboard, or the foreground.
//     That last property is load-bearing rather than incidental: `deferred_outcome`
//     exists precisely so a delivery we have already decided not to type does not
//     steal `SetForegroundWindow` on its way to not typing, and
//     `self_window_stage0` reads the foreground rather than switching it.
//   · pipeline.rs — 「怎么打，打了之后凭什么那么说」 ("how to type it, and once
//     typed, what entitles us to say so"). Stage 1 focus, Stage 1b, the
//     SendInput/clipboard ladder, and the outcome mapping. Everything there has a
//     side effect on the user's machine.
//
// The two halves keep DIFFERENT red lines, which is the real reason they are two
// files:
//   · here — 「没有静默失败」("no silent failures") 的第二个方向 (its second
//     direction): a refusal must be NAMED (its own error
//     code) and must never be silent. Every function below returns a code;
//   · there — 「`injected` 只声称我们真知道的事」 ("`injected` only claims what we
//     genuinely know"), and 「绝不许让 `injected` 有两个
//     含义」 ("`injected` must never be allowed to carry two meanings")
//     (docs/decisions/2026-07-30-rv45-is-an-optional-enhancement-not-a-
//     prerequisite.md). A verdict here never produces `injected` at all.
//
// ⚠️ The callers are unchanged: everything is re-exported through `inject/mod.rs`,
// so `socket/inject_ops.rs` and `socket/wire.rs` still say `inject::InjectOrigin`
// / `inject::deferred_outcome` and did not move a byte for this split.

use crate::error_codes;
use crate::inject::pipeline::{InjectMode, InjectOutcome};
use crate::inject::self_focus::{NoInputEvidence, SelfFocusProbe, SelfFocusVerdict};

/// 🔴 WHY THIS DELIVERY IS ON THE WIRE — the phone's answer to 「用户此刻在等这句话
/// 上屏吗」 ("is the user right now waiting for this sentence to land on screen"),
/// read off `inject:request.inject_origin`.
///
/// owner's 2026-08-02 ruling (docs/decisions/2026-08-02-deferred-delivery-must-not-
/// autoinject.md):「之前没发送成功、后面（连上网）补投到 PC 的消息，PC 端不能随便注入
/// ——这时用户对这个行为是不可预知、没有准备的，直接注进当前输入窗口可能引起事故。
/// 注入是用户预期的行为。」 ("A message that failed to send earlier and is later
/// [once back online] re-delivered to the PC — the PC side must not inject it
/// carelessly. At that moment the user cannot anticipate this action and is not
/// prepared for it; typing it straight into the current input window could cause
/// an accident. Injection is supposed to be an action the user expects.")
///
/// ── WHAT IT IS NOT, because both mistakes are one grep away ──────────────────
///   · NOT `source` (stt/llm/manual/history/image). That says where the BYTES came
///     from, and it disagrees with this in both directions: a `source:'stt'` frame
///     is live when the sentence just left the user's mouth and deferred when the same
///     queued item finally drains three hours later, while a `source:'history'`
///     frame is a deferred delivery the user PRESSED and is expected.
///   · NOT derived from `created_at`. That says WHEN it was spoken; this says
///     whether to type it. A resend the user pressed one second ago carries last
///     week's `created_at`, and inferring from age would refuse the one delivery
///     they are standing there waiting for. One value only answers one question.
///
/// The judgement is made ONCE, on the phone, at the instant the frame leaves
/// (apps/mobile/lib/src/session/outbox_inject_origin.dart) — comparing the phone's
/// own clock against the phone's own `created_at`, so no cross-device clock
/// comparison exists anywhere on this path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InjectOrigin {
    /// The direct result of a user's action right now — the sentence that just finished (including a short
    /// retry), a ➤ / "frequently used" tap, a picture just picked, a resend/deferred-redelivery the user pressed.
    /// Injects exactly as it always has.
    ///
    /// 🔴 ALSO THE READING FOR AN ABSENT FIELD, and that default is a decision with
    /// a stated failure direction rather than a convenience. zod strips unknown keys
    /// and the relay forwards `parsed.data`, so a relay older than 0.2.48 DELETES
    /// `inject_origin` in flight; a phone older than 0.2.48 never wrote one.
    ///   · absent ⇒ Live (this) — such a leg keeps behaving exactly as it does
    ///     today. The ruling is not yet in force there; nothing REGRESSES.
    ///   · absent ⇒ Deferred — a stale relay would turn EVERY live utterance on the
    ///     cloud leg into 「未注入」 ("not injected"), i.e. 手机说话 PC 不上屏
    ///     ("the phone speaks, the PC screen never shows it"), for anyone who has not
    ///     redeployed. This repo already paid two days for a refusal that fired on
    ///     everything (0.2.19), and 「说了没上屏」 ("it was said but never landed on
    ///     screen") is the product, not a nuance.
    /// ⇒ The compensation is a DEPLOY ORDER (deploy the relay first, then ship the APK) plus a golden that
    /// goes red when the relay in front of it strips the field
    /// (verify/golden/g19-deferred-not-autoinjected.mjs) — not a safer-looking
    /// default that breaks the headline feature.
    #[default]
    Live,
    /// Automatic deferred re-delivery — a reconnect drain of an item that has been waiting, a
    /// PC_BUSY-release drain, anything NOT produced by a user action right now.
    /// 🔴 NEVER TYPED, even with a live focused window ([`deferred_outcome`]).
    Deferred,
}

impl InjectOrigin {
    /// Read the wire literal. Anything that is not the exact token `"deferred"` —
    /// absent, misspelt, a non-string — is [`InjectOrigin::Live`]; see that
    /// variant's doc for why that direction, and note the server boundary already
    /// refuses a third value (`z.enum(['live','deferred'])`), so a junk token can
    /// only reach here from a non-conforming sender.
    pub fn from_wire(raw: Option<&str>) -> Self {
        match raw {
            Some("deferred") => InjectOrigin::Deferred,
            _ => InjectOrigin::Live,
        }
    }

    /// The token for a forensic line. `-` is 「这一帧没说」 ("this frame did not say") and is NOT spelled
    /// `live`: the two are the same DECISION and different FACTS, and the whole
    /// reason a stale relay is diagnosable after the event is that the log kept
    /// them apart.
    pub fn tag(raw_present: bool, self_: InjectOrigin) -> &'static str {
        if !raw_present {
            return "-(absent: pre-0.2.48 sender, or a relay stripped it)";
        }
        match self_ {
            InjectOrigin::Live => "live",
            InjectOrigin::Deferred => "deferred",
        }
    }
}

/// 🔴 THE ONE PLACE 「补投不许自动注入」 ("a deferred delivery must not auto-inject") IS DECIDED ON THIS MACHINE.
///
/// `Some(outcome)` ⇒ do not run the pipeline at all; this IS the answer. `None` ⇒
/// proceed exactly as before. Written as a returned OUTCOME rather than a bool so
/// the refusal and its truthful verdict cannot drift apart — a caller cannot obey
/// the gate and then invent its own status.
///
/// ── WHAT `cached` CLAIMS HERE (and it is a different claim from Stage 1's) ────
/// Both say 「**没有注入进去**，内容留在时间线上，可以再注一次」 ("**it was not
/// injected**, the content stays on the timeline, and it can be injected again"),
/// which is the only
/// thing the wire word means. (卡 L7 (card L7): this sentence used to read 「nothing was
/// **delivered** and it can be **delivered** later」 — a segment-① word inside a
/// file that is entirely segment ②. The frame reaching this function has ALREADY
/// been delivered; it is sitting in this process. docs/rebuild/15 §2.0 律 1 (rule 1).)
/// They differ in CAUSE, and 15 册 (doc 15) requires the two
/// to stay distinguishable — 「找不到焦点」 ("no focus could be found") is fixed by clicking into a text box,
/// 「这是补投」 ("this is a deferred delivery") is not fixed by anything the user does to the window. That is what the
/// distinct error code carries (`INJECT_DEFERRED_NOT_AUTOINJECTED`), and it is why
/// this outcome must NOT reuse `INJECT_FOCUS_LOST`: the focus was fine.
///
/// ── WHY IT REFUSES BEFORE STAGE 1 RATHER THAN INSIDE IT ──────────────────────
/// Stage 1 takes the foreground window away from the user (`SetForegroundWindow`).
/// A delivery we have already decided not to type must not steal focus on its way
/// to not typing — that is a visible side effect for an act that never happens.
/// So the caller runs this before the FSM lock transition and before the pipeline,
/// and 「零注入」 ("zero injection") is provable as 「the focus switcher was never called」 rather than as
/// 「it was called and we changed our mind」.
/// 🔴 CORRECTION (IJ-01, 2026-08-07) — this paragraph used to end 「before it
/// resolves a target at all」, and that became false the day the caller started
/// REPORTING which window the delivery arrived at (`focus_window` on
/// `inject:result`, owner's 2026-08-07 ruling ④). `socket/inject_ops.rs` now calls
/// `apply_allowlist(resolve_inject_target(fsm), ..)` on this branch. Both of those
/// are READ-ONLY (they read the FSM and `focus::current_foreground_target()` and
/// write a log); no foreground is taken, no FSM transition is driven, and the
/// property this paragraph actually protects is unchanged. Anti-façade rule ④: a comment
/// asserting someone else's behaviour has to be re-read when that behaviour moves.
///
/// ⚠️ THE CALLER MUST RUN DEDUP FIRST, and that ordering is load-bearing rather
/// than incidental: a frame the phone already delivered LIVE gets re-sent by the
/// queue's retry under the SAME `request_id` and stamped `deferred` (it is a
/// re-delivery by then). If this gate ran first, an utterance that was genuinely
/// typed would be answered 「未注入」 ("not injected") and the phone's row would go backwards. INJ-3
/// replays the original verdict verbatim before this is ever reached
/// (socket/inject_ops.rs `run_inject`).
pub fn deferred_outcome(origin: InjectOrigin) -> Option<InjectOutcome> {
    if origin != InjectOrigin::Deferred {
        return None;
    }
    Some(InjectOutcome {
        ok: false,
        // 🔴 `Cached`, never a failure mode: the relay maps ok=false + cached to
        // status `cached` (「未注入 · 已缓存」 ("not injected · cached")), which is the truth — the message is
        // here, on this timeline, and can be injected later from the row.
        mode: InjectMode::Cached,
        error_code: Some(error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED),
        error_message: Some(
            "inject_origin=deferred — an AUTOMATIC re-delivery (queue drain), not a user \
             action right now. owner 2026-08-02: 补投的消息不许自动注入，即使有焦点窗口也不许. \
             Nothing was typed and no focus was taken; the row is on this PC's timeline and \
             the user re-injects it from there."
                .to_string(),
        ),
        // IJ-01 §A-4: Stage 1b never ran on this branch — the frame is refused
        // before the pipeline is entered — so the key is ABSENT on the wire.
        // `unknown` would say 「我们问了，答不出来」 ("we asked, but got no answer"), which would be a fabricated
        // measurement. The WINDOW is still reported (`focus_window`), because that
        // one really was observed; see the caller.
        focus_evidence: None,
    })
}

/// 🔴 THE ONE PLACE 「自家输入框必须能注入」 ("our own input box must be able to
/// receive injection") IS DECIDED (owner 2026-08-02, F1a
/// reversal ruling). Runs BEFORE Stage 1, and only when the ordinary pipeline resolved no
/// target at all.
///
/// ── WHY 「ONLY WHEN THERE IS NO TARGET」 IS A CONDITION AND NOT AN OPTIMISATION ─
/// A resolved `locked_hwnd` is the SPEAKING lock's window (07 §3 / F-203: a
/// mid-utterance switch must not re-target). If the user started speaking while
/// Notepad was in front and then clicked into FlowMic, the sentence still belongs to
/// Notepad — that ruling is untouched here. And when FlowMic IS the window the user
/// spoke into, there is provably no lock to fight: `audio:start` locks from
/// `focus::current_foreground_target()`, which returns `None` for our own windows
/// (`focus/tracker.rs` `extract_foreground_event`), so this branch and the locked
/// branch are mutually exclusive by construction rather than by precedence.
///
/// `Ok(hwnd)` ⇒ type into that window of ours. `Err(outcome)` ⇒ that IS the answer
/// (a named `cached`). `Ok`-less third case — 「前台不是我们」 ("the foreground is
/// not us") — returns `None` and
/// the caller proceeds exactly as before.
///
/// ⚠️ TEXT ONLY, deliberately. The picture path does not consult this and keeps its
/// 0.2.48 verdict verbatim: FlowMic's own surfaces are plain text fields with no
/// place to receive an image, so pasting one there would be an act with no landing
/// — and reporting `injected` for it is the forbidden direction of 没有静默失败 ("no silent failures").
/// owner's ruling is about 「我说的话」 ("the words I spoke"). Widening it to pictures would be inventing
/// scope, not honouring one.
pub(crate) fn self_window_stage0(
    locked_hwnd: Option<u64>,
    probe: SelfFocusProbe,
) -> Option<Result<u64, InjectOutcome>> {
    // The SPEAKING lock (or a live external foreground) owns this frame — see the
    // paragraph above. The probe is not even asked, so a stale report cannot so much
    // as be evaluated on a frame that already has a destination.
    if locked_hwnd.unwrap_or(0) != 0 {
        return None;
    }
    match probe() {
        SelfFocusVerdict::NotOurWindow => None,
        SelfFocusVerdict::Editable(hwnd) => {
            crate::forensic::record(
                "self-focus",
                &format!(
                    "own window hwnd={hwnd} is foreground WITH an editable focus — typing into \
                     FlowMic itself (owner 2026-08-02 F1a). In-process judgement, not the \
                     cross-process one."
                ),
            );
            Some(Ok(hwnd))
        }
        SelfFocusVerdict::OwnWindowNoInput(evidence) => {
            crate::forensic::record(
                "self-focus",
                &format!(
                    "own window is foreground with NO editable focus ({}) → ok=false mode=cached \
                     err={}; nothing typed, no focus taken. The row is on this PC's timeline.",
                    evidence.tag(),
                    error_codes::INJECT_SELF_WINDOW_NO_INPUT,
                ),
            );
            Some(Err(self_window_no_input(evidence)))
        }
    }
}

// ── MAC-05: 「this OS will not deliver a synthetic keystroke right now」 ────────
//
// Two facts, read from the OS, that make ⌘V vanish WITHOUT any API returning an
// error (see `inject/macos/secure_input.rs` for the measurements and the
// mechanisms). They belong in THIS file because they satisfy its whole entry
// condition: fully decidable BEFORE any physical act, and every one of them can
// end the frame with a truthful outcome without touching the keyboard, the
// pasteboard or the foreground.
//
// ✅ REGISTERED 2026-08-07 (owner-approved, docs/decisions/2026-08-07-owner-grants-mac-
// injection-refusal-codes-63-64.md): `INJECT_SECURE_INPUT_ACTIVE` = 63 and
// `INJECT_NO_ACCESSIBILITY` = 64 in `packages/protocol/src/error-codes.ts`.
// The constants now live with every other desktop code in `crate::error_codes`;
// the isolated placeholders that used to sit HERE were scaffolding for the wait,
// and the reasoning that justified them is kept at their new home rather than
// deleted (why no neighbour could be borrowed, why the two are not folded).
//
// 🔴 WHAT THE WAIT ACTUALLY COST, recorded because the lesson outlived it: while
// the codes were unregistered they were emitted on `inject:result` by a shipped
// macOS build, and the phone's `kPcInjectionVerdictCodes` is a CLOSED SET — an
// unrecognised code settles the outbox item back to `queued`, so the row would
// have said 「待投递」 ("pending delivery") forever for a message that was already on the PC's timeline.
// The comment that used to stand here reasoned only about the RENDERING ("the user
// sees an ugly token, never a wrong sentence, and the row is still correctly
// 未注入 · 已缓存" ("not injected · cached")) and stopped one consumer short of the one that decides whether
// the queue still owes the item. ⇒ Deferring a code out of the registry is not a
// neutral act: it walks around the compile-time exhaustiveness check
// (`inject-verdict-authorship.ts`'s `satisfies Record<ErrorCode, …>`) that exists
// precisely to make that failure impossible.
//
// ⚠️ STILL TRUE AND STILL WORTH STATING: `InjectResultSchema.error` is
// `NonEmpty.optional()` — a free string, NOT a zod enum — so the relay forwards
// either code verbatim and NO relay redeploy is required by this round.

/// The two OS readings, as data — so the judgement below stays pure and is
/// provable on every platform, including the ones that can never produce it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyntheticInputFacts {
    /// `AXIsProcessTrusted()` — may this process post events to other apps?
    pub accessibility_trusted: bool,
    /// `IsSecureEventInputEnabled()` — is the window server in secure input mode?
    pub secure_event_input: bool,
}

/// The whole judgement, pure. `None` ⇒ proceed; `Some(outcome)` ⇒ that IS the
/// answer, and nothing has been typed, pasted or activated.
///
/// ── WHY BOTH ARE `Cached` AND NOT A FAILURE MODE ────────────────────────────
/// The delivery SUCCEEDED — the frame is in this process, the row is on this PC's
/// timeline. Only the injection did not happen, and in both cases it is undone by
/// something the user does OUTSIDE our window (leave the password field / grant
/// the permission) followed by a re-injection from the row. That is exactly what
/// `cached` promises (docs/rebuild/15 §2.0), and it is the same reasoning
/// `self_window_no_input` uses two functions down.
///
/// ── ORDER: ACCESSIBILITY FIRST, AND IT MATTERS ──────────────────────────────
/// When the permission is missing NOTHING works, ever, for anyone — it is a
/// standing condition, not a passing one. Reporting a transient secure-input
/// window on top of it would send the user hunting for a password field they do
/// not have while the real answer sits in System Settings.
pub fn synthetic_input_verdict(facts: SyntheticInputFacts) -> Option<InjectOutcome> {
    if !facts.accessibility_trusted {
        return Some(InjectOutcome {
            ok: false,
            mode: InjectMode::Cached,
            error_code: Some(error_codes::INJECT_NO_ACCESSIBILITY),
            error_message: Some(
                "AXIsProcessTrusted() = false — this build is not in macOS's Accessibility \
                 list, so every synthetic key event it posts is discarded by the OS with no \
                 error. Nothing was typed and nothing was written to the pasteboard. Grant \
                 FlowMic under System Settings ▸ Privacy & Security ▸ Accessibility, then \
                 re-inject the row. ⚠️ Under ad-hoc signing the grant is keyed to a code \
                 signature that CHANGES on every rebuild, so it has to be re-granted after \
                 each build (inject/macos/secure_input.rs)."
                    .to_string(),
            ),
            // Stage 0a runs BEFORE Stage 1/1b — nothing was asked about the focus.
            focus_evidence: None,
        });
    }
    if facts.secure_event_input {
        return Some(InjectOutcome {
            ok: false,
            mode: InjectMode::Cached,
            error_code: Some(error_codes::INJECT_SECURE_INPUT_ACTIVE),
            error_message: Some(
                "IsSecureEventInputEnabled() = true — the window server is in secure input \
                 mode (a password field, Terminal's 「Secure Keyboard Entry」, or the lock \
                 screen), and in that mode synthetic key events are delivered to nobody. \
                 Nothing was typed and nothing was written to the pasteboard. Leave the \
                 secure field and re-inject the row."
                    .to_string(),
            ),
            focus_evidence: None,
        });
    }
    None
}

/// Read the two facts off the OS and judge. macOS only.
///
/// ⚠️ ON WINDOWS THIS IS ALWAYS `None`. That is a deliberate position, but the
/// sentence that used to justify it was an unmeasured assertion, so it is written
/// out honestly here rather than stated as platform fact.
///
/// 🔴 【unverified】 **We have never measured whether a UIPI-blocked `SendInput` is
/// silent.** The old wording ("Win32 has no OS mode that swallows `SendInput`
/// silently") asserted behaviour of the platform that nobody here has observed —
/// anti-façade rule ④: an assertion about behaviour elsewhere does not change when the
/// facts do, and a reader who believes it stops asking. This one is load-bearing:
/// it decides whether we can honestly tell the user 「系统拦住了」 ("the system
/// blocked it") instead of
/// reporting a success that never landed (R11).
///
/// 🔴 **The one adjacent measurement must NOT be read across.** IJ-04 measured that
/// `SendMessage` from a Medium-integrity sender into a High-integrity target fails
/// *visibly* (returns 0, `GetLastError()` = 5 / `ERROR_ACCESS_DENIED`). **That says
/// nothing about `SendInput`** — different API, different mechanism, and the fact
/// that they may differ is the entire reason this question is still open. Borrowing
/// that result would be inventing an answer nobody has, which is what the previous
/// wording did in the other direction.
///
/// **Why it is still unmeasured** (owner 2026-08-07 cancelled the spike, and the
/// reasoning is worth keeping): on owner's machine the situation cannot arise —
/// FlowMic and the target both run at High integrity, and **UIPI does not guard
/// between equals**; producing a block would require de-elevating on purpose, so
/// the spike would have measured *the ordinary user's* configuration, not owner's.
/// And the half that actually affects users has a cheaper answer: on the next
/// real-device round, speak one sentence into the elevated editor and see whether
/// the characters arrive.
///
/// **Closing action** (does not need owner's hardware): run the Medium-sender →
/// High-target probe on any ordinary, non-elevated machine.
/// Context: `docs/decisions/2026-08-03-f1b-injected-means-delivered-not-landed.md`
/// §6-5 — only the READ half was ever falsified.
#[cfg(all(target_os = "macos", not(test)))]
pub fn synthetic_input_preflight() -> Option<InjectOutcome> {
    use crate::inject::macos::secure_input;
    let facts = SyntheticInputFacts {
        accessibility_trusted: secure_input::accessibility_trusted(),
        secure_event_input: secure_input::secure_event_input_enabled(),
    };
    let verdict = synthetic_input_verdict(facts);
    if let Some(outcome) = &verdict {
        crate::forensic::record(
            "inject",
            &format!(
                "macOS synthetic-input preflight REFUSED: ax_trusted={} secure_input={} → \
                 ok=false mode=cached err={}; nothing typed, no pasteboard write, no activation",
                facts.accessibility_trusted,
                facts.secure_event_input,
                outcome.error_code.unwrap_or("(none)"),
            ),
        );
    }
    verdict
}

/// See the macOS arm above for why this is `None` everywhere else.
#[cfg(all(not(target_os = "macos"), not(test)))]
pub fn synthetic_input_preflight() -> Option<InjectOutcome> {
    None
}

// ── The test seam, and why this gate needed one at all ───────────────────────
//
// 🔴 THIS WAS FOUND BY RUNNING THE SUITE, NOT BY THINKING ABOUT IT. The first
// macOS build with the gate wired went from 1 failure to 16: an SSH session is not
// Accessibility-trusted, so the REAL reader refused every frame before Stage 1 and
// sixteen tests about Stage 1/1b/2/3 never reached the stage they were asserting.
// The product behaviour was correct; the tests were measuring the machine.
//
// That is this repo's second-named #1 shape (memory note 「先核你的尺子」 ("check
// your ruler first")): a test whose
// answer depends on the state of the box it runs on tells you about the box. And
// it fails in BOTH directions — on a Mac where the developer HAS granted
// Accessibility the same sixteen tests go green again, so the suite's verdict would
// have depended on a checkbox in System Settings.
//
// The seam is a THREAD-LOCAL rather than a global, and that is the load-bearing
// detail: `cargo test` runs tests in parallel threads and `inject_text` takes a
// process-wide gate (`lock_inject_gate`), so a global override set by one test
// would be read by another test's injection. A thread-local cannot be.
//
// The DEFAULT is 「deliverable」 (trusted, not secure), so every pre-existing test
// behaves exactly as it does on Windows and this card moves none of them. A test
// that wants the refusal opts in, on its own thread.

#[cfg(test)]
thread_local! {
    static TEST_FACTS: std::cell::Cell<SyntheticInputFacts> = const {
        std::cell::Cell::new(SyntheticInputFacts {
            accessibility_trusted: true,
            secure_event_input: false,
        })
    };
}

/// The gate as the tests see it: the same pure judgement, over facts the test
/// owns. Compiled on EVERY platform so the 「does the pipeline actually call it?」
/// proof runs in the full Windows suite too, not only on a Mac.
#[cfg(test)]
pub fn synthetic_input_preflight() -> Option<InjectOutcome> {
    synthetic_input_verdict(TEST_FACTS.with(|c| c.get()))
}

/// Set this THREAD's facts. Returns a guard that puts the default back on drop, so
/// a panicking assertion cannot leak a refusing gate into the next test that
/// happens to reuse the thread.
#[cfg(test)]
pub(crate) fn with_test_facts(facts: SyntheticInputFacts) -> TestFactsGuard {
    TEST_FACTS.with(|c| c.set(facts));
    TestFactsGuard
}

#[cfg(test)]
pub(crate) struct TestFactsGuard;

#[cfg(test)]
impl Drop for TestFactsGuard {
    fn drop(&mut self) {
        TEST_FACTS.with(|c| {
            c.set(SyntheticInputFacts {
                accessibility_trusted: true,
                secure_event_input: false,
            })
        });
    }
}

/// The truthful verdict for 「焦点在 FlowMic 自己的窗口，但没停在输入框里」 ("the
/// focus is in FlowMic's own window, but it is not resting inside an input box").
///
/// `Cached`, never a failure mode: the relay maps ok=false + cached to status
/// `cached` (未注入 · 已缓存, "not injected · cached"), which is exactly what happened — the message is here,
/// on this timeline, and one click into a field makes the re-injection land.
pub fn self_window_no_input(evidence: NoInputEvidence) -> InjectOutcome {
    InjectOutcome {
        ok: false,
        mode: InjectMode::Cached,
        error_code: Some(error_codes::INJECT_SELF_WINDOW_NO_INPUT),
        error_message: Some(format!(
            "the foreground window belongs to FlowMic and no editable element holds focus in it \
             ({}) — nothing was typed. owner 2026-08-02: 自家窗口的判定是精确的（同进程），\
             不适用跨进程的「判不了就打」默认值.",
            evidence.tag()
        )),
        // 🔴 IJ-01 — `not_editable`, and this one was argued twice before it was
        // written, so the reasoning stays.
        //
        // The first draft left it ABSENT, on the grounds that `focus_evidence` was
        // defined as 「Stage 1b 这一次读到了什么」 ("what Stage 1b read this time") and Stage 1b never runs on this
        // branch. That definition is wrong, and wrong in this repo's headline way:
        // it names the field after the INSTRUMENT instead of after the QUESTION.
        // The question is 「我们对这次焦点有没有正面证据」 ("do we have positive evidence
        // about this focus"), and here we have the best
        // evidence this codebase can produce — an IN-PROCESS DOM-focus reading that
        // positively establishes there is no editable element. `unknown` would be a
        // lie in the other direction, and absence would mean 「我们没问」 ("we never asked") when we did.
        //
        // The second argument against it was 「`INJECT_SELF_WINDOW_NO_INPUT` already
        // says this, so a second field is one question with two producers」. That
        // conflates two questions the same way `focus_window` vs `inject_target`
        // does: the CODE answers 「这一帧的判决是什么」 ("what is this frame's verdict") (and carries the user's next
        // action), the EVIDENCE answers 「焦点长什么样」 ("what does the focus look
        // like"). They coincide here and they
        // do not in general — `INJECT_FOCUS_LOST` also produces no injection and
        // carries no reading at all.
        //
        // ⇒ And the decisive one: the POSITIVE half of this very probe reaches the
        // wire as `editable` (pipeline.rs `evidence`). Reporting one direction of an
        // instrument and silently dropping the other is not neutrality, it is a
        // measurement with a hole in it.
        focus_evidence: Some(crate::inject::target_probe::FocusInputState::NotInput),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error_codes;

    fn facts(accessibility_trusted: bool, secure_event_input: bool) -> SyntheticInputFacts {
        SyntheticInputFacts {
            accessibility_trusted,
            secure_event_input,
        }
    }

    /// The happy reading is the ONLY one that proceeds. Written as a table so a
    /// future change that flips one of the two conditions has to flip a row here.
    #[test]
    fn only_a_deliverable_keystroke_proceeds() {
        assert_eq!(
            synthetic_input_verdict(facts(true, false)),
            None,
            "trusted + not-secure is the one state where ⌘V can actually be delivered"
        );
        for (ax, secure) in [(false, false), (false, true), (true, true)] {
            assert!(
                synthetic_input_verdict(facts(ax, secure)).is_some(),
                "ax_trusted={ax} secure_input={secure} must be REFUSED, not attempted"
            );
        }
    }

    /// 🔴 The false-reporting trap, as an assertion. Every refusal must be `ok:false` with a
    /// code — never a quiet `Ok` — because everything downstream of it succeeds
    /// while nothing arrives.
    #[test]
    fn every_refusal_is_named_and_never_a_silent_success() {
        for (ax, secure) in [(false, false), (false, true), (true, true)] {
            let out = synthetic_input_verdict(facts(ax, secure)).expect("refused");
            assert!(!out.ok, "a refusal must never claim a delivery");
            assert!(out.error_code.is_some(), "a refusal must carry a code");
            assert!(
                out.error_message.is_some(),
                "a refusal must say what happened, in words a log can carry"
            );
        }
    }

    /// The two causes ask the user to do OPPOSITE things — one is fixed in System
    /// Settings and stays fixed, the other by moving off a password field — so
    /// they must never share a code. Same rule doc 15 §2.5e-4 applies to `cached`'s
    /// other causes.
    #[test]
    fn the_two_causes_do_not_share_a_code_with_each_other_or_with_anything_else() {
        let no_ax = synthetic_input_verdict(facts(false, false)).unwrap();
        let secure = synthetic_input_verdict(facts(true, true)).unwrap();
        assert_eq!(no_ax.error_code, Some(error_codes::INJECT_NO_ACCESSIBILITY));
        assert_eq!(secure.error_code, Some(error_codes::INJECT_SECURE_INPUT_ACTIVE));
        assert_ne!(no_ax.error_code, secure.error_code);

        // …and neither may borrow a code that already answers another question.
        // 🔴 `INJECT_TARGET_INVALID` is the one that would have been 「close
        // enough」; it already means 「the text is over the length cap」.
        for taken in [
            error_codes::INJECT_TARGET_INVALID,
            error_codes::INJECT_NO_TEXT_TARGET,
            error_codes::INJECT_FOCUS_LOST,
            error_codes::INJECT_CLIPBOARD_FAIL,
            error_codes::INJECT_SENDINPUT_FAIL,
            error_codes::INJECT_SELF_WINDOW_NO_INPUT,
            error_codes::INJECT_DEFERRED_NOT_AUTOINJECTED,
        ] {
            assert_ne!(no_ax.error_code, Some(taken));
            assert_ne!(secure.error_code, Some(taken));
        }
    }

    /// Both are `cached`, and the relay's truth table is what makes that the right
    /// word: ok=false + cached → status `cached` (未注入 · 已缓存, "not injected · cached"), which is the
    /// truth — the frame WAS delivered and the row is re-injectable once the user
    /// has changed the thing only they can change. A non-cached mode would map to
    /// `failed` and invite a re-DELIVERY, which fixes nothing here.
    #[test]
    fn a_refused_keystroke_is_cached_because_the_delivery_itself_succeeded() {
        for (ax, secure) in [(false, false), (false, true), (true, true)] {
            let out = synthetic_input_verdict(facts(ax, secure)).unwrap();
            assert_eq!(out.mode, InjectMode::Cached);
        }
    }

    /// The reason the user can act on has to survive into the message, or the code
    /// is the only thing they get — and the code is a placeholder today.
    #[test]
    fn the_accessibility_refusal_says_where_to_go_and_warns_about_adhoc_signing() {
        let msg = synthetic_input_verdict(facts(false, false))
            .unwrap()
            .error_message
            .unwrap();
        assert!(msg.contains("Accessibility"), "{msg}");
        assert!(
            msg.contains("rebuild"),
            "the adhoc-signing revocation is the thing that wastes an afternoon: {msg}"
        );
    }

    /// The seam's DEFAULT must be inert, or this card silently rewrites the
    /// verdict of every other test in the suite (it did, once — 16 of them; see
    /// the note above the thread-local).
    #[test]
    fn the_test_seam_defaults_to_deliverable_so_no_other_test_is_moved() {
        assert_eq!(
            synthetic_input_preflight(),
            None,
            "the default facts must let every frame through"
        );
    }

    /// …and the guard must restore that default even when the test that set it
    /// panicked, because `cargo test` reuses threads.
    #[test]
    fn the_guard_restores_the_default_on_drop() {
        {
            let _g = with_test_facts(facts(false, false));
            assert!(synthetic_input_preflight().is_some(), "the override took");
        }
        assert_eq!(
            synthetic_input_preflight(),
            None,
            "a leaked override would refuse the next test that reuses this thread"
        );
    }
}

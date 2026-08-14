// SPEC-REF:
//   docs/strategy/2026-08-07-inject-status-truth-and-evidence-design.md §4-2 (A-3)
//   docs/strategy/2026-08-07-ij03-msaa-focus-editability-spike.md (the measurements)
//   docs/decisions/2026-08-07-owner-inject-status-wording-evidence-and-window-title.md
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// IJ-05 — a SECOND instrument for 「is the focus a place where you can write text」, asked of MSAA
// (oleacc) instead of the window manager.
//
// ── WHAT THIS FILE MAY AND MAY NOT DO ────────────────────────────────────────
//
// 🔴 IT MAY ONLY EVER SAY 「YES」. There is no path from this module to a refusal,
// and that is enforced by [`upgrade`] below rather than by anyone remembering it.
// The reason is 0.2.19, and it is not a slogan — it is the measured shape of this
// machine: the IJ-03 spike read 360极速浏览器X (360 Speed Browser X, owner's main browser) and 微信 (WeChat) and
// got NOTHING but the window shell from either.
// ⚠️ COUNTS, stated only as precisely as the source supports (adversarial review;
// §1-bis-16): 360ChromeX is 11 of 11 — the spike's two tables agree. WeChat is 15 shell
// readings against a sample the SAME report elsewhere counts as 17, so 「every single
// one」 is not supported for it and is removed rather than repeated. Nothing in the
// design turns on which number is right: MSAA is positive-only, so an app that
// answers anything we do not recognise is `unknown` either way.
// An implementation that treated 「MSAA could not tell me」 as 「there is nowhere to
// type」 would refuse every utterance owner speaks into his own browser. That P0
// has been shipped once already and it cost days.
//
// ⇒ The failure direction is fixed by construction: no COM, no answer, a shell
// reading, a timeout, a panic, a role we do not recognise — every one of them lands
// on [`MsaaVerdict::Inconclusive`], which [`upgrade`] passes through untouched, and
// the frame is then injected exactly as it is today. An enhancement is not a gate.
//
// ── WHY IT REPORTS BUT DOES NOT GATE ─────────────────────────────────────────
//
// `pipeline.rs` deliberately keeps TWO bindings: `state` (the cross-process GATE,
// feeding `refusal_for`) and `evidence` (the REPORT, feeding `focus_evidence` on
// the wire). This module feeds ONLY the second. `classify_focus` is not touched, so
// every verdict this codebase produces is byte-identical before and after this card
// — which is what 「A: change the wording, not the mechanism」 means, applied to the instrument as well as
// to the words.
//
// ── WHY POSITIVE-ONLY, i.e. WHY MSAA NEVER PRODUCES `not_editable` ───────────
//
// It would buy nothing and it could lie. Both halves matter:
//   · IT BUYS NOTHING TODAY. `not_editable` and `unknown` render the SAME weak word
//     (`status.ts`: `evidence === 'editable' ? confirmed : unconfirmed`). A new
//     producer of `not_editable` changes no pixel.
//   · IT COULD LIE. The IJ-03 spike validated the POSITIVE predicate with samples
//     (Cursor 21, chrome 7, XshellCore 5, explorer 1). It validated the NEGATIVE
//     predicate with ZERO — nobody ever checked that typing really fails where MSAA
//     reports a non-TEXT role. task book §1-bis-5: a direction with no samples is
//     "not measured", not "passed", and saying 「confirmed not input-capable」 off an unvalidated predicate is
//     R11 in the other direction (claiming certainty we do not have).
//
// ⚠️ AND THE THIRD-PARTY `not_editable` TIER IS NOT EMPTY ANYWAY, which is the fact
// that makes this trade free. Stage 1b already proves it cross-process — a menu is
// up, or nothing holds keyboard focus — and `pipeline.rs` reports it. (task book
// §1-bis-15 is exactly this: the sentence 「every third-party app is invariably unknown」 fooled three
// readers because it was shorter than the truth.)
//
// ── COST, AND WHY IT IS BOUNDED BY A THREAD RATHER THAN AN API ───────────────
//
// oleacc offers no timeout. `get_accFocus` is a cross-process call into the
// target's UI thread, so a hung foreground app would hang US — on the path between
// 「the user finishes speaking」 and 「the text lands on screen」, under the process-wide inject gate. There is no way to
// bound that except to do the read on a thread we can abandon, which is what
// [`read_focus_bounded`] does.
//
// 🔴 CORRECTED 2026-08-08 (adversarial review). This used to end 「An abandoned
// thread finishes on its own and its result is dropped」. **That is false in exactly
// the case the budget exists for** — anti-façade ④ committed inside the sentence
// defending the design. `AccessibleObjectFromWindow` is `SendMessage(WM_GETOBJECT)`
// underneath, and a thread blocked against a WEDGED UI thread does NOT come back:
// there is no default LRPC timeout without an `IMessageFilter`.
//
// ⇒ WHAT IS ACTUALLY TRUE, cost stated rather than wished away:
//   · injections are serialised by `lock_inject_gate()`, so a wedged target leaks
//     about ONE THREAD PER UTTERANCE for as long as it stays wedged. Uncapped and
//     uncounted — the forensic line is written AFTER `recv_timeout` returns, so a
//     leaked thread leaves no trace whatsoever;
//   · each leaked thread holds an abandoned STA and a marshalled proxy;
//   · even the HAPPY path abandons one STA per injection.
// ⇒ An accepted cost of the only bounding mechanism available, not a free lunch. It
// is bounded in the sense that matters (the user's text is never delayed past the
// budget) and unbounded in one that mostly does not (threads, against an app that is
// itself already hung). If this trade is revisited, the honest alternatives are an
// `IMessageFilter` or one long-lived probe thread — NOT a re-wording of this note.
//
// ⚠️ `catch_unwind` catches RUST PANICS ONLY. An access violation inside a
// third-party a11y provider is an SEH exception and takes the process down. The list
// in the header is what we CAN contain, not everything that can go wrong.

use crate::inject::target_probe::FocusInputState;

/// `ROLE_SYSTEM_TEXT`. The one role the IJ-03 spike validated with samples, and the
/// only one that reaches [`MsaaVerdict::Editable`].
///
/// ⚠️ The spike shipped a whole WRONG role table and survived only because this one
/// constant happened to be right (its §5-3). It is asserted against the raw number
/// in the tests below rather than trusted from a name.
pub const ROLE_SYSTEM_TEXT: i32 = 0x2A;
/// `STATE_SYSTEM_UNAVAILABLE` — the element is disabled.
pub const STATE_SYSTEM_UNAVAILABLE: i32 = 0x1;
/// `STATE_SYSTEM_READONLY`. 🔴 This bit is the whole reason MSAA was enough and IA2
/// was never run: it carries the `EDITABLE`/`READONLY` distinction that the IA2
/// spike was going to be needed for. It is also the bit that kills the 「insertion
/// caret」
/// candidate — a READ-ONLY text box has a blinking caret too (F1b matrix §2.1 cell ③).
pub const STATE_SYSTEM_READONLY: i32 = 0x40;

/// Everything the MSAA walk saw, as data — so [`judge`] stays pure and the forensic
/// line prints RAW NUMBERS beside the conclusion.
///
/// The 2026-07-30 lesson this shape exists for: a log line that carried only the
/// verdict left two opposite root causes indistinguishable for two days.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsaaReading {
    /// Did the walk complete at all? `false` ⇒ every other field is meaningless.
    pub answered: bool,
    /// How many times `accFocus` descended. 🔴 `0` means we never left the window
    /// object, i.e. we are holding the SHELL — see [`judge`].
    pub depth: u32,
    /// `IAccessible::get_accRole`, raw.
    pub role: i32,
    /// `IAccessible::get_accState`, raw bitfield.
    pub state: i32,
    /// 🔴 The second shell test. A window-shell reading answers `accName` with the
    /// WINDOW TITLE; a real focused element answers with its own label.
    ///
    /// ⚠️ [known gap, adversarial review 2026-08-08] computed as
    /// `!title.is_empty() && name == title`, so a foreign window with NO caption
    /// disables this test entirely. Latent rather than active: shell test 1
    /// (`depth == 0`) still catches the measured 360/WeChat shape. Recorded because
    /// 「the guard did not run」 and 「the guard ran and passed」 are indistinguishable
    /// in the forensic line.
    pub name_equals_window_title: bool,
    /// Wall time of the whole walk.
    pub elapsed_ms: u32,
    /// Why it did not answer, for the log. `""` when it did.
    pub note: &'static str,
}

impl Default for MsaaReading {
    /// 🔴 The default is a NON-ANSWER, deliberately. doc 13 §7 F1 ②: a DI default
    /// must be the real thing or must refuse to pretend. A default that looked like
    /// a successful 「editable」 reading is how this module would silently start
    /// upgrading every frame.
    fn default() -> Self {
        MsaaReading {
            answered: false,
            depth: 0,
            role: 0,
            state: 0,
            name_equals_window_title: false,
            elapsed_ms: 0,
            note: "not attempted",
        }
    }
}

impl MsaaReading {
    /// One copy-pasteable line, raw numbers included.
    pub fn one_line(&self) -> String {
        format!(
            "msaa answered={} d={} role=0x{:x} state=0x{:x} shellName={} ms={} {}",
            self.answered,
            self.depth,
            self.role,
            self.state,
            self.name_equals_window_title,
            self.elapsed_ms,
            if self.note.is_empty() { "" } else { self.note },
        )
    }
}

/// What MSAA is allowed to conclude. **Two values, not three** — see the file note
/// on why there is no negative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsaaVerdict {
    /// Positively identified an enabled, writable text element holding focus.
    Editable,
    /// Anything else at all. Says nothing about the target.
    Inconclusive,
}

/// The whole judgement, pure.
///
/// 🔴 THE TWO SHELL TESTS ARE THE POINT OF THIS FUNCTION, and they come straight
/// off a measurement: at Medium integrity reading a High-integrity Chromium, the
/// call **succeeds** and hands back a perfectly normal-looking object — `CLIENT` +
/// `FOCUSABLE` + a name — and that name is the WINDOW TITLE. It is also FASTER than
/// a real answer. A more quickly delivered wrong answer is the worst shape a probe
/// can have, and it is the same shape as
/// `docs/decisions/2026-07-30-uia-window-shell-is-not-a-verdict.md`.
/// ⇒ what we got is the window shell, and the window shell is not a verdict.
pub fn judge(r: &MsaaReading) -> MsaaVerdict {
    if !r.answered {
        return MsaaVerdict::Inconclusive;
    }
    // Shell test 1: `accFocus` never descended, so we are still holding the object
    // we asked ABOUT rather than one it pointed us TO.
    if r.depth == 0 {
        return MsaaVerdict::Inconclusive;
    }
    // Shell test 2: it descended but answered with the window's own title.
    if r.name_equals_window_title {
        return MsaaVerdict::Inconclusive;
    }
    if r.role != ROLE_SYSTEM_TEXT {
        return MsaaVerdict::Inconclusive;
    }
    if r.state & STATE_SYSTEM_READONLY != 0 || r.state & STATE_SYSTEM_UNAVAILABLE != 0 {
        return MsaaVerdict::Inconclusive;
    }
    MsaaVerdict::Editable
}

/// 🔴 THE RED LINE, AS A FUNCTION RATHER THAN AS A PROMISE.
///
/// Folds an MSAA verdict into the evidence the frame will REPORT. The only
/// transition it can ever make is `Unknown → Input`; every other input is returned
/// verbatim. So:
///   · it can never manufacture a refusal — `refusal_for` only refuses `NotInput`,
///     and no input of this function can produce `NotInput` that did not already
///     arrive as `NotInput`;
///   · it can never overwrite a CONCLUSIVE reading. A Stage-1b `NotInput` is a
///     cross-process PROOF (a menu is up / nothing holds focus); MSAA disagreeing
///     with it would be the weaker instrument vetoing the stronger, which is the
///     mistake `pipeline.rs` calls out by name for the self-window branch.
///   · it can never fill in a reading nobody took. `None` means 「we did not ask」 and
///     stays `None` — absence ≠ `unknown` (§A-4, pinned in `focus_evidence_tests.rs`).
pub fn upgrade(base: Option<FocusInputState>, msaa: MsaaVerdict) -> Option<FocusInputState> {
    match (base, msaa) {
        (Some(FocusInputState::Unknown), MsaaVerdict::Editable) => Some(FocusInputState::Input),
        (other, _) => other,
    }
}

// ── the Windows reader ───────────────────────────────────────────────────────

/// How long the injection path will wait for MSAA before giving up on it.
///
/// 🔴 A BUDGET, NOT A GUESS ABOUT SPEED. Typical readings are single-digit
/// milliseconds; this number exists for the pathological case — a foreground app
/// whose UI thread is wedged — because `get_accFocus` is a blocking cross-process
/// call and we are holding the inject gate while it runs.
///
/// ⚠️ [unverified] on this machine: the IJ-05 window had **no activated window** on its
/// desktop (`GetForegroundWindow()` = 0), so the real cost of a successful walk was
/// never timed here. The instrument's own C# equivalent measured 30–45 ms against a
/// NON-foreground Chromium, and the IJ-03 spike measured a median of 8 ms (High) /
/// 2.3 ms (Medium) against foreground windows. 120 ms sits above all of those and
/// far below the point where a user notices, but it should be re-measured against a
/// live desktop before anyone quotes it as a cost.
pub const MSAA_BUDGET_MS: u64 = 120;

/// Read the focus through MSAA, giving up after [`MSAA_BUDGET_MS`].
///
/// The work runs on a thread we are willing to ABANDON. That is the only way to
/// bound a blocking cross-process COM call: there is no timeout parameter anywhere
/// in oleacc, and the alternative — letting it run to completion — puts an
/// unbounded wait between 「the user finishes speaking」 and 「the text lands on screen」.
#[cfg(windows)]
pub fn read_focus_bounded() -> MsaaReading {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    // The thread may outlive this function. It only sends on a channel whose
    // receiver may be gone, which `send` reports as an error we ignore.
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(read_focus).unwrap_or(MsaaReading {
            note: "panicked",
            ..Default::default()
        });
        let _ = tx.send(r);
    });
    match rx.recv_timeout(std::time::Duration::from_millis(MSAA_BUDGET_MS)) {
        Ok(r) => r,
        Err(_) => MsaaReading {
            note: "budget exceeded — the foreground app did not answer in time",
            elapsed_ms: MSAA_BUDGET_MS as u32,
            ..Default::default()
        },
    }
}

/// Non-Windows builds have no oleacc. Never answers, so [`judge`] is always
/// `Inconclusive` and [`upgrade`] is always the identity.
#[cfg(not(windows))]
pub fn read_focus_bounded() -> MsaaReading {
    MsaaReading {
        note: "no MSAA on this platform",
        ..Default::default()
    }
}

/// The actual COM walk. Windows only.
///
/// ⚠️ COM is initialised PER THREAD and never uninitialised, the same trade
/// `inject/image.rs` already makes for WIC: `S_FALSE` (already initialised) and
/// `RPC_E_CHANGED_MODE` (this thread is an MTA) are both fine, so the HRESULT is
/// deliberately ignored. This runs on a thread we spawned, so it cannot leave an
/// apartment behind on a pooled Tauri thread.
#[cfg(windows)]
fn read_focus() -> MsaaReading {
    use windows::core::{Interface, VARIANT};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Accessibility::{AccessibleObjectFromWindow, IAccessible};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, OBJID_CLIENT};

    let started = std::time::Instant::now();
    let mut out = MsaaReading::default();

    // SAFETY: every call below is a read. The COM pointers are owned by windows-rs
    // wrappers that Release on drop; no handle or pointer outlives this function.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            out.note = "no foreground window";
            return out;
        }

        // The window's own title, for the second shell test.
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(fg, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);

        let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
        if AccessibleObjectFromWindow(fg, OBJID_CLIENT.0 as u32, &IAccessible::IID, &mut raw).is_err()
            || raw.is_null()
        {
            out.note = "AccessibleObjectFromWindow failed";
            out.elapsed_ms = started.elapsed().as_millis() as u32;
            return out;
        }
        let mut acc = IAccessible::from_raw(raw);

        // Walk `accFocus` down to the element that actually holds focus. Bounded so
        // a cyclic or adversarial tree cannot spin here.
        let mut child = VARIANT::from(0i32); // CHILDID_SELF
        let mut depth = 0u32;
        // Bounded so a cyclic or adversarial tree cannot spin here — this runs on
        // the utterance path.
        for _ in 0..12 {
            let Ok(f) = acc.accFocus() else { break };
            match variant_vt(&f) {
                VT_I4_RAW => {
                    // A SIMPLE child: the focus is an element with no IAccessible
                    // of its own, addressed by id against its parent.
                    let Ok(id) = i32::try_from(&f) else { break };
                    if id == 0 {
                        break; // CHILDID_SELF ⇒ this object IS the focus
                    }
                    child = VARIANT::from(id);
                    depth += 1;
                    break;
                }
                VT_DISPATCH_RAW => {
                    let Some(unk) = variant_dispatch(&f) else { break };
                    let Ok(next) = unk.cast::<IAccessible>() else { break };
                    acc = next;
                    child = VARIANT::from(0i32);
                    depth += 1;
                }
                // VT_EMPTY (nothing focused) and anything unexpected: stop where we
                // are. `depth` then reports how far we actually got, and depth 0 is
                // the shell test.
                _ => break,
            }
        }

        out.answered = true;
        out.depth = depth;
        // ⚠️ `i32::try_from(&VARIANT)` is `VariantToInt32`, which COERCES rather than
        // type-checks. That is stated rather than hidden: a provider answering a
        // non-numeric type fails and lands on `-1`, and a numeric-but-odd type would
        // be rounded into a role number that `judge` will not match (it requires an
        // exact 0x2A). Either way the failure direction is Inconclusive.
        out.role = acc.get_accRole(&child).ok().and_then(|v| i32::try_from(&v).ok()).unwrap_or(-1);
        out.state = acc.get_accState(&child).ok().and_then(|v| i32::try_from(&v).ok()).unwrap_or(-1);
        let name = acc
            .get_accName(&child)
            .map(|b| b.to_string())
            .unwrap_or_default();
        out.name_equals_window_title = !title.is_empty() && name == title;
        out.elapsed_ms = started.elapsed().as_millis() as u32;
        out.note = "";
    }
    out
}

/// `VT_I4` / `VT_DISPATCH` as the raw ABI numbers.
///
/// 🔴 Spelled as literals ON PURPOSE, and then pinned against the crate's own
/// constants in the tests below. `windows::core::VARIANT` is opaque — its tag is
/// only reachable through `as_raw()`, whose type lives in a `#[doc(hidden)]` module
/// we must not name. Comparing against a literal keeps this file off that private
/// API; asserting the literal against `Win32::System::Variant::VT_*` keeps the
/// literal honest. (The IJ-03 spike's lesson, applied before rather than after: a
/// table that turns numbers into meanings is itself an unchecked assertion.)
/// ⚠️ `pub(crate)` only so the pinning test can reach them after the 800-line split
/// moved it into a sibling file. Not part of any public surface.
#[cfg(windows)]
pub(crate) const VT_I4_RAW: u16 = 3;
#[cfg(windows)]
pub(crate) const VT_DISPATCH_RAW: u16 = 9;

#[cfg(windows)]
fn variant_vt(v: &windows::core::VARIANT) -> u16 {
    // SAFETY: the tag arm of a VARIANT we own is always live, whichever payload arm
    // is. Nothing is dereferenced.
    unsafe { v.as_raw().Anonymous.Anonymous.vt }
}

/// The `IDispatch` payload, as a counted `IUnknown`, or `None` if this VARIANT does
/// not hold one.
///
/// The `transmute` mirrors windows-core's own `TryFrom<&VARIANT> for IUnknown`
/// verbatim — that impl exists but accepts only `VT_UNKNOWN`, and `accFocus` answers
/// `VT_DISPATCH`. An `IDispatch*` is an `IUnknown*` (it derives from it), so the
/// clone-then-`cast` below is the ordinary QueryInterface path.
#[cfg(windows)]
fn variant_dispatch(v: &windows::core::VARIANT) -> Option<windows::core::IUnknown> {
    if variant_vt(v) != VT_DISPATCH_RAW {
        return None;
    }
    // SAFETY: the tag says the `pdispVal` arm is live, so the raw pointer is a live
    // `IDispatch*`. The transmute is of `&p` — a reference to the LOCAL COPY of that
    // pointer — into `&IUnknown`, sound because `IUnknown` is `#[repr(transparent)]`
    // over a non-null pointer and `p` is null-checked just above. `clone()` then takes
    // our OWN reference count, so the returned handle depends on neither `p` nor the
    // VARIANT staying alive.
    // 🔴 CORRECTED 2026-08-08 (adversarial review): this used to say the pointer was
    // 「BORROWED from the VARIANT」. It is not — it is copied to the stack first, and
    // soundness actually rests on the POINTEE outliving the call, not on the borrow
    // the old wording named. On a human-audit-sensitive file, an `unsafe`
    // justification describing different code than it guards is the worst kind to get
    // wrong: the next auditor reads the justification and stops.
    unsafe {
        let p = v.as_raw().Anonymous.Anonymous.Anonymous.pdispVal;
        if p.is_null() {
            return None;
        }
        let unk: &windows::core::IUnknown = core::mem::transmute(&p);
        Some(unk.clone())
    }
}

// ── the seam ─────────────────────────────────────────────────────────────────
//
// A thread-local override rather than a parameter, for the reason `preflight.rs`
// already wrote down for `TEST_FACTS`: `cargo test` runs tests in parallel threads
// and the inject gate is process-wide, so a GLOBAL override set by one test would
// be read by another test's injection. A thread-local cannot be.
//
// The DEFAULT is `Inconclusive`, which is the identity for `upgrade` — so every
// pre-existing test behaves exactly as it did before this card, and none of them
// had to be touched.

#[cfg(test)]
thread_local! {
    static TEST_VERDICT: std::cell::Cell<MsaaVerdict> =
        const { std::cell::Cell::new(MsaaVerdict::Inconclusive) };
}

/// The IJ-03b gate, as a value rather than as a paragraph. **DEFAULT ON** since
/// IJ-05 (2026-08-09).
///
/// 🔴 LIFTED 2026-08-09 (owner ruling; measured by the first responsible party). The
/// precondition three W9 documents and doc 15 §2.5g-6 adopted in writing — IJ-03b ①
/// must close the Medium→Medium hole BEFORE MSAA ships — is now MEASURED. On
/// dev-pc-b a Medium-integrity client read a Medium-integrity Chrome's REAL
/// editable element (`role=0x2A` TEXT, `name != window title`, not a shell),
/// reproduced C#×2 + Rust×1 with a Notepad positive control proving the negative is
/// real. Same-integrity does NOT degrade to a shell; the shell in the earlier
/// readings was a CROSS-integrity (Medium→High) artifact. So the thing this gate
/// waited for exists — the ordinary user's configuration was measured — and it ships
/// ON. [measured · dev-pc-b, 2026-08-09]
///
/// ⚠️ KNOWN RESIDUAL (does NOT block the flip; owner-accepted). A default Chrome with
/// renderer accessibility OFF exposes only a read-only DOCUMENT (`role=0x0F`) to
/// `accFocus`, never the input — 4 reads, no flip. So the strong tier populates only
/// where Chrome a11y is already on (or where something wakes it): a question about
/// the tier's VALUE, orthogonal to integrity, still open (IJ-NEXT residual). The flip
/// is safe regardless of that answer: [`MsaaVerdict`] is only `Editable` (an
/// [`upgrade`], never a refusal) or `Inconclusive` (the identity), so turning the
/// probe on can never newly refuse an injection — every non-editable read folds to
/// the same `focus_evidence` a 0.2.58 build carried.
///
/// ⚠️ TO TURN IT OFF: set `FLOWMIC_MSAA_FOCUS_PROBE=0` (or `false`) — the env var is
/// the operator opt-out; the DEFAULT (unset) is what ships, and it now ships enabled.
/// The precondition text is retired in the same three places it was raised: doc 15
/// §2.5g-6, the IJ ledger §3-0, the IJ handoff §0 — W2.5 already paid for lifting a
/// cross-window precondition in only the ledger that raised it.
pub fn probe_enabled(raw: Option<&str>) -> bool {
    // Default ON. Only an explicit off-switch disables the probe; anything not
    // recognisably "off" stays on, because the failure direction is inert
    // (Inconclusive → 0.2.58-identical behaviour) and we would rather probe than
    // silently skip on a typo'd env value.
    !matches!(raw, Some("0") | Some("false"))
}

/// Production: gate, read, judge, and leave the raw numbers in forensic.
#[cfg(not(test))]
pub fn msaa_verdict() -> MsaaVerdict {
    verdict_with(
        probe_enabled(std::env::var("FLOWMIC_MSAA_FOCUS_PROBE").ok().as_deref()),
        read_focus_bounded,
    )
}

/// The gate and the reader, separated so a test can drive the GATE for real
/// instead of asserting that a line of source exists. A source grep proves a call
/// is written; it cannot prove the call is reached — and 「the probe never ran」 vs 「the
/// probe ran and reached no conclusion」 must stay distinguishable in forensic, or this becomes another silent
/// no-op nobody can tell from a working probe.
pub(crate) fn verdict_with(enabled: bool, read: impl FnOnce() -> MsaaReading) -> MsaaVerdict {
    if !enabled {
        crate::forensic::record(
            "inject",
            // Since IJ-05 flipped the default ON (2026-08-09), the ONLY way to get
            // here is an operator's explicit FLOWMIC_MSAA_FOCUS_PROBE=0/false —
            // the old wording named an unmeasured precondition that is now measured,
            // and a stale reason in forensic is worse than none.
            "stage1b-msaa SKIPPED (probe disabled by operator env) => Inconclusive",
        );
        return MsaaVerdict::Inconclusive;
    }
    let r = read();
    let v = judge(&r);
    crate::forensic::record(
        "inject",
        &format!("stage1b-msaa {} => {:?}", r.one_line(), v),
    );
    v
}

/// Tests see the same fold, over a verdict the test owns.
#[cfg(test)]
pub fn msaa_verdict() -> MsaaVerdict {
    TEST_VERDICT.with(|c| c.get())
}

/// Set this THREAD's MSAA verdict. The guard restores the inert default on drop, so
/// a panicking assertion cannot leak an upgrading probe into the next test that
/// reuses the thread.
#[cfg(test)]
pub(crate) fn with_test_verdict(v: MsaaVerdict) -> TestVerdictGuard {
    TEST_VERDICT.with(|c| c.set(v));
    TestVerdictGuard
}

#[cfg(test)]
pub(crate) struct TestVerdictGuard;

#[cfg(test)]
impl Drop for TestVerdictGuard {
    fn drop(&mut self) {
        TEST_VERDICT.with(|c| c.set(MsaaVerdict::Inconclusive));
    }
}

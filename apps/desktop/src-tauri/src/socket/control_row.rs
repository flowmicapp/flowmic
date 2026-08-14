// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-e
//     (the fifth segment 「按键」/"keypress" — the ⌨ segment's contract, and every ruling this file rests on)
//   docs/decisions/2026-08-12-owner-p0-control-key-history-and-haptics.md (owner P0)
//   docs/strategy/2026-08-12-req1213-control-key-timeline-and-haptics.md (execution card)
//   docs/rebuild/04-PROTOCOL-SPEC.md F-3115 (`control:key.device_label`)
//
// ONE REMOTE KEY PRESS ⇔ ONE PC TIMELINE ROW — minted WITH its outcome.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
// The four remote keys (clear / backspace / undo / enter) act on THIS machine's
// focused window, and until this card the only trace they left anywhere was a
// forensic line. owner (2026-08-12): 「按了什么键，手机历史与 PC 时间线都毫无感知」
// ("whatever key was pressed, neither the phone history nor the PC timeline
// has any awareness of it")
// — zero awareness (感知为零) means the capability does not exist for the user.
//
// ── WHY IT IS A SEPARATE MODULE FROM row_transit ─────────────────────────────
// row_transit answers 「一次投递产生什么行」("what row does one delivery
// produce") and every line in it is about a frame
// that carries TEXT TO TYPE. A keypress row carries none: it has no `source_text`,
// no `mode` (the three modes (三模式) answer 「这段话是怎么产生的」, "how was
// this passage produced", and a keypress is not a passage, 段话), no
// re-injectability, and its status comes from a `ChordExit` rather than from an
// `inject:result`. Folding it in would have made every field on RowFacts answer
// 「…unless it is a control row」 — the shape this repo pays for repeatedly.
//
// ── RULING INHERITANCE (裁定继承): A ROW IS NEVER CREATED WITHOUT ITS OUTCOME (row_transit ruling one) ──
// [`mint_control_row`] takes the `ChordExit` — it CANNOT be called before the
// desktop knows what happened. Minting first and patching later would publish, for
// that instant, a row that claims an outcome nobody had decided.
//
// ── WHAT THIS ROW DOES **NOT** CLAIM ─────────────────────────────────────────
// It says what THIS MACHINE did with the keys. It says nothing about the phone,
// and the phone's own row says nothing about this machine (vol. 15 §2.0-e: 两端各自
// 铸自己的行，各自只说自己能证的那一半 — "each side mints its own row, each
// only stating the half it can prove"). There is no receipt frame on `control:key`,
// so the two rows are deliberately never reconciled — inventing a correlation
// here would imply a round trip that does not exist.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::forensic;
use crate::socket::bridge::{self, BridgeSink};
use crate::socket::channel::Channel;

/// Sequence for control-row ids. A `control:key` frame carries no `request_id` and
/// no `entry_id` — there is nothing on it to be stable against — so the address is
/// local and says so, exactly like [`super::row_transit::RowIdOrigin::Local`].
///
/// 🔴 That is not a gap to be closed by inventing an id: an id whose only purpose
/// is to look stable would claim this row can be named again from the other end,
/// and nothing over there can name it (no receipt, no re-injection, no re-delivery).
static CONTROL_ROW_SEQ: AtomicU64 = AtomicU64::new(0);

/// How one remote key press ended, as the ROW sees it.
///
/// 🔴 ONE VARIANT PER USER-DISTINGUISHABLE OUTCOME, and no more. The forensic
/// `ChordExit` already distinguishes `SendFailed("Rejected")` from
/// `SendFailed("Win32(5)")`; a ROW must not, because the user's action is the same
/// and a row that spells an OS error at them answers a question they did not ask.
/// The full text stays in the forensic line, which is where a diagnosis is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::socket) enum ControlOutcome {
    /// The key sequence was handed to the focused window.
    ///
    /// ⚠️ 「Handed to」 is the whole claim, and it is the SAME claim the text path
    /// makes (`docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md`).
    /// Nothing reads back what the target did with it — there is no receipt for a
    /// chord — so this row renders the WEAK success word (已送入, "handed in"), never 已注入 ("injected").
    Sent,
    /// No target at all: no live foreground to resolve, or the smoke allowlist
    /// declined the one there was.
    NoTarget,
    /// A target existed but could not be brought to the foreground, so the keys
    /// would have landed in another window. Not sent, on purpose.
    ForegroundRefused,
    /// The OS would discard a synthetic keystroke right now (macOS: no Accessibility
    /// grant, or secure event input is on). Nothing was posted.
    OsRefused,
    /// The OS accepted the target but refused the sequence itself.
    SendFailed,
    /// This channel is not the capsule owner — another phone holds this machine.
    /// The keys were never attempted.
    ///
    /// 🔴 A ROW IS STILL MINTED (row_transit ruling two, same reasoning): the press
    /// really did arrive at this PC and really did nothing, and both halves have to
    /// be visible. 「时间线＝投递到这台 PC 的所有消息」("timeline = every message
    /// delivered to this PC") (owner 2026-07-30 ①).
    NotPrimary,
}

impl ControlOutcome {
    /// The wire-ish token the frontend renders from. A CODE, not a sentence: the
    /// window picks the words in the user's UI language, and a sentence composed
    /// here would freeze whatever language this process happened to be built with
    /// (the desktop already paid for that once — `lib/status.ts`'s getter-vs-snapshot
    /// note). One token ⇔ one string key in `lib/strings/timeline.ts`.
    pub(in crate::socket) fn tag(self) -> &'static str {
        match self {
            ControlOutcome::Sent => "sent",
            ControlOutcome::NoTarget => "no_target",
            ControlOutcome::ForegroundRefused => "foreground_refused",
            ControlOutcome::OsRefused => "os_refused",
            ControlOutcome::SendFailed => "send_failed",
            ControlOutcome::NotPrimary => "not_primary",
        }
    }

    /// The row's `status`, in the SAME four-value vocabulary every other row uses
    /// (vol. 05 §1 / red line 「status 只记投递真相」("status records only the
    /// delivery truth") — here, the ② segment's truth).
    ///
    /// 🔴 `injected` KEEPS EXACTLY ITS EXISTING MEANING and does not gain a second
    /// one (the RV-45 hard constraint): 「delivered to the keyboard focus」. That is
    /// what a chord is. What differs from a text row is only the EVIDENCE — a chord
    /// has none, ever — so the renderer's weak/strong split does the rest, and this
    /// row never carries `focus_evidence`.
    fn status(self) -> &'static str {
        match self {
            ControlOutcome::Sent => "injected",
            // Everything else: we KNOW the keys did not reach the window. `cached`
            // would be a lie of a different kind — nothing was held for a later
            // re-attempt, because a keypress has nothing to hold.
            _ => "failed",
        }
    }
}

/// The row's display face is composed by the WINDOW, not here. This module ships
/// two structured facts (`control_kind`, `control_outcome`) and an EMPTY
/// `output_text`, and that emptiness is deliberate:
///
///   ① a localized sentence written here would be frozen in one language forever
///      (rows persist across a UI-language switch), and
///   ② `output_text` is the field the re-injection path reads. A control row must
///      never be re-injectable — 「清除」("Clear") typed into the user's document is the
///      literal defect this design exists to avoid — and the surest way to keep a
///      face out of the typer is for it never to exist as text on the row.
///      (The UI guards are in TimelinePage.vue / timeline-store.ts; this is the
///      structural half, and the two are load-bearing together.)
fn build_row(id: &str, kind: &str, outcome: ControlOutcome, device_label: Option<&str>, now: &str) -> Value {
    let mut item = json!({
        "id": id,
        // 🔴 STRUCTURAL FILLER, AND IT IS SAID OUT LOUD. `TimelineRow.mode` is a
        // three-value union (red line: three-mode lock, 三模式锁定) that answers
        // 「这段话是怎么产生的」("how was this passage produced") —
        // a question a keypress does not have. There is no fourth mode and there
        // must not be one, so the row carries the union's first value and the
        // window is REQUIRED not to render a mode badge on a control row
        // (TimelinePage.vue gates the badge on entry_type). Same posture as the
        // RV-83 disk ledger's extra atom: the schema forces a value, so the
        // deviation gets named instead of hidden. vol. 15 §2.0-e records it.
        "mode": "realtime",
        "status": outcome.status(),
        // Nobody has edited anything; a keypress row is not editable at all.
        "edited": false,
        // There is no original — not 「it was empty」, but 「a keypress has no words」.
        "source_text": Value::Null,
        // See the note above: the face is composed by the window from the two
        // structured fields below.
        "output_text": "",
        // This PC's clock, and here that is the RIGHT clock rather than a fallback:
        // the event this row records is 「这台机器执行了那次按键」("this machine
        // executed that keypress"), which happened
        // here, now. (Contrast row_transit, where `created_at` means 「什么时候说的」("when it was said")
        // and using the receive time is a named substitution.)
        "created_at": now,
        "updated_at": now,
        "entry_type": "control",
        "control_kind": kind,
        "control_outcome": outcome.tag(),
    });
    // OMITTED, never null/"": the frontend narrows `typeof … === 'string'`, and an
    // empty string would be a claim that the phone sent an empty label.
    if let Some(l) = device_label {
        item["device_label"] = json!(l);
    }
    item
}

/// The one greppable line a minted control row leaves behind (red line: no silent failure, 没有静默失败),
/// built as a PURE FUNCTION so a test can read it — `forensic::record` writes to a
/// sink that is a no-op under `cargo test`, so a line formatted inline is a line no
/// test can assert on (the lesson `row_transit::minted_line` was built from).
fn minted_line(id: &str, channel: Channel, kind: &str, outcome: ControlOutcome, device_label: Option<&str>) -> String {
    let gaps = if device_label.is_none() {
        // A relay older than vol. 04 F-3115 strips `device_label` in flight, and so does
        // a phone older than this round. The row then cannot say WHICH phone pressed
        // the key — which on a shared PC is exactly what makes a misrouted id (串号) invisible — so
        // it must self-report rather than look like a row nobody asked about.
        "[device_label→none(row cannot name its phone)]"
    } else {
        "[]"
    };
    format!(
        "control row minted id={id} channel={} kind={kind} outcome={} status={} gaps={gaps}",
        channel.tag(),
        outcome.tag(),
        outcome.status(),
    )
}

/// Mint the PC timeline row for one remote key press.
///
/// Called from the ONE place that knows the outcome, and only there. It returns
/// nothing: unlike a delivery there is no verdict to hand back to a caller and none
/// to put on the socket — `control:key` has no result frame (vol. 15 §6 G-24 records
/// what that costs and what adding one would take).
pub(in crate::socket) fn mint_control_row(
    sink: &Option<BridgeSink>,
    channel: Channel,
    kind: &str,
    outcome: ControlOutcome,
    device_label: Option<&str>,
) {
    let n = CONTROL_ROW_SEQ.fetch_add(1, Ordering::Relaxed);
    let now_ms = crate::socket::client::now_millis();
    let id = format!("ctl:{now_ms}-{n}");
    let now = forensic::fmt_utc(now_ms);
    let item = build_row(&id, kind, outcome, device_label, &now);
    forensic::record("timeline", &minted_line(&id, channel, kind, outcome, device_label));
    // ONE implementation of 「这一行是哪条通道带来的」("which channel brought
    // this row") — the same stamp row_transit
    // applies, so the frontend keeps exactly one narrowing for it. Written as a
    // record rather than an unwrap so a later refactor cannot turn it into a panic
    // — or into silence.
    let envelope = json!({ "item": item });
    match bridge::tag_channel(&envelope, channel.tag()) {
        Some(tagged) => bridge::forward(sink, bridge::channel::HISTORY_UPDATED, tagged),
        None => forensic::record(
            "timeline",
            &format!("control row {id} could NOT be channel-stamped — the window never received it"),
        ),
    }
}

#[cfg(test)]
#[path = "control_row_tests.rs"]
mod control_row_tests;

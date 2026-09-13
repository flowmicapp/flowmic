// Unit tests for socket::control_row — 「一次远程按键 → PC 时间线一行」("one
// remote keypress → one PC timeline row") (REQ-12-13).
// Sibling file for the 800-line source cap, same move as row_transit_tests.rs.
//
// What these assert is the ROW, not the keypress: whether the chord really reaches
// a window is a Win32/CGEvent question `cargo test` cannot ask (no window server, no
// foreground). What CAN be pinned here is every property the contract in
// docs/rebuild/15 §2.0-e depends on — and each one below is a property that, if it
// silently flipped, would put a wrong word in front of the user or type 「清除」("Clear") into
// their document.

use super::*;
use std::sync::{Arc, Mutex};

/// A sink that records every forwarded `(channel, payload)`.
fn capturing() -> (Option<BridgeSink>, Arc<Mutex<Vec<(String, Value)>>>) {
    let log: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    let sink: BridgeSink = Arc::new(move |ch: &str, p: Value| {
        l.lock().unwrap().push((ch.to_string(), p));
    });
    (Some(sink), log)
}

fn rows(log: &Arc<Mutex<Vec<(String, Value)>>>) -> Vec<Value> {
    log.lock()
        .unwrap()
        .iter()
        .filter(|(ch, _)| ch == bridge::channel::HISTORY_UPDATED)
        .map(|(_, p)| p["item"].clone())
        .collect()
}

const EVERY_OUTCOME: [ControlOutcome; 6] = [
    ControlOutcome::Sent,
    ControlOutcome::NoTarget,
    ControlOutcome::ForegroundRefused,
    ControlOutcome::OsRefused,
    ControlOutcome::SendFailed,
    ControlOutcome::NotPrimary,
];

// ── the row's identity ───────────────────────────────────────────────────────

#[test]
fn a_control_row_is_never_a_transcript_or_an_image() {
    // 🔴 THE LOAD-BEARING ONE. Every 「can this row be re-injected / edited / counted
    // / exported」 predicate on the desktop is written `entry_type !== 'image'` — i.e.
    // it FAILS OPEN. If this row ever reads `transcript`, the timeline grows a
    // re-inject (重新注入) button that types the word 「清除」("Clear") into whatever the user has focused.
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Lan, "clear", ControlOutcome::Sent, None);
    assert_eq!(rows(&log)[0]["entry_type"], "control");
}

#[test]
fn the_row_names_which_key_and_what_this_machine_did_with_it() {
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Lan, "backspace", ControlOutcome::NoTarget, None);
    let row = rows(&log)[0].clone();
    assert_eq!(row["control_kind"], "backspace");
    assert_eq!(row["control_outcome"], "no_target");
}

#[test]
fn the_row_carries_no_text_to_type_and_no_original() {
    // The structural half of 「the caption is never typed」 applied to keypresses:
    // the face is composed by the window from `control_kind`, so there is no text on
    // the row for any re-injection path to find. `source_text` is null because a
    // keypress HAS no original, not because one was lost.
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Cloud, "undo", ControlOutcome::Sent, None);
    let row = rows(&log)[0].clone();
    assert_eq!(row["output_text"], "");
    assert_eq!(row["source_text"], Value::Null);
    assert_eq!(row["edited"], false);
}

// ── the status word ──────────────────────────────────────────────────────────

#[test]
fn only_a_sent_chord_claims_the_keys_reached_the_focus() {
    // ② segment truth (vol. 15 §2.0): `injected` keeps its ONE meaning — 「delivered to
    // the keyboard focus」 — and every other exit is a state we KNOW did not reach it.
    // 🔴 `cached` must never appear here: nothing was held for a later attempt,
    // because a keypress has nothing to hold, and 「已缓存」("cached") would offer the user a
    // re-injection this row does not have.
    for outcome in EVERY_OUTCOME {
        let (sink, log) = capturing();
        mint_control_row(&sink, Channel::Lan, "enter", outcome, None);
        let want = if outcome == ControlOutcome::Sent { "injected" } else { "failed" };
        assert_eq!(rows(&log)[0]["status"], want, "outcome={:?}", outcome);
    }
}

#[test]
fn a_control_row_never_carries_focus_evidence() {
    // The renderer splits `injected` into 已注入 ("injected") / 已送入 ("handed
    // in") on `focus_evidence`, and a
    // chord is never read back — there is no receipt for a keypress. An ABSENT key
    // means 「我们没问」("we didn't ask") and takes the weak word, which is the honest one here.
    // Stating it as an assertion so a later 「顺手补齐」("casually filling it in
    // while at it") has to argue with a test.
    for outcome in EVERY_OUTCOME {
        let (sink, log) = capturing();
        mint_control_row(&sink, Channel::Lan, "clear", outcome, None);
        assert!(rows(&log)[0].get("focus_evidence").is_none());
        assert!(rows(&log)[0].get("inject_target").is_none());
    }
}

// ── who pressed it (vol. 04 F-3115) ────────────────────────────────────────────

#[test]
fn the_label_is_carried_when_the_frame_had_one_and_omitted_when_it_did_not() {
    // OMITTED, never `""`/null: the frontend narrows `typeof … === 'string'`, and an
    // empty string would be a claim that the phone sent an empty label.
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Lan, "clear", ControlOutcome::Sent, Some("Pixel 8"));
    assert_eq!(rows(&log)[0]["device_label"], "Pixel 8");

    let (sink2, log2) = capturing();
    mint_control_row(&sink2, Channel::Lan, "clear", ControlOutcome::Sent, None);
    assert!(rows(&log2)[0].get("device_label").is_none());
}

#[test]
fn a_row_that_cannot_name_its_phone_says_so_in_the_log() {
    // no silent failure (没有静默失败), storage face: on a shared PC 「哪台手机按的」("which phone pressed it") is the visibility half
    // of the no-crosstalk red line, so its absence must be discoverable rather than
    // look like a row nobody asked about. (A relay older than F-3115 strips the key.)
    let named = minted_line("ctl:1-0", Channel::Lan, "clear", ControlOutcome::Sent, Some("Pixel 8"));
    let anon = minted_line("ctl:1-0", Channel::Lan, "clear", ControlOutcome::Sent, None);
    assert!(named.contains("gaps=[]"), "{named}");
    assert!(anon.contains("device_label→none"), "{anon}");
}

#[test]
fn the_minted_line_names_the_channel_the_kind_and_the_outcome() {
    // The forensic line is the only place the FULL local outcome lives: card MP-14
    // put a receipt on the wire, but it carries three coarse reasons (the far side
    // cannot act on the difference between `os_refused` and `send_failed`), so
    // this line still has to answer 「哪条通道、哪个键、结果是什么」("which channel,
    // which key, what result") in one greppable string.
    let line = minted_line("ctl:9-3", Channel::Cloud, "undo", ControlOutcome::OsRefused, None);
    assert!(line.contains("channel=cloud"), "{line}");
    assert!(line.contains("kind=undo"), "{line}");
    assert!(line.contains("outcome=os_refused"), "{line}");
    assert!(line.contains("status=failed"), "{line}");
}

// ── addressing ───────────────────────────────────────────────────────────────

#[test]
fn every_row_is_stamped_with_the_channel_that_carried_the_press() {
    // RV-01: a row whose server is unknown is a row no verb may act on — the window's
    // normaliser DROPS an untagged row. Asserted on the envelope, not the item,
    // because that is where the bridge stamps it.
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Cloud, "enter", ControlOutcome::Sent, None);
    let (ch, payload) = log.lock().unwrap()[0].clone();
    assert_eq!(ch, bridge::channel::HISTORY_UPDATED);
    assert_eq!(payload["channel"], "cloud");
}

#[test]
fn two_presses_never_share_an_id() {
    // A control frame carries no `request_id` and no `entry_id`, so the address is
    // local by necessity. What it must still guarantee is that a second press is a
    // SECOND ROW — folding two presses onto one id would hide one of them, which is
    // the RV-72 defect in a new place.
    let (sink, log) = capturing();
    for _ in 0..8 {
        mint_control_row(&sink, Channel::Lan, "backspace", ControlOutcome::Sent, None);
    }
    let ids: std::collections::HashSet<String> = rows(&log)
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 8);
    assert!(ids.iter().all(|id| id.starts_with("ctl:")));
}

#[test]
fn the_row_is_timestamped_and_born_unmodified() {
    // `created_at` here is genuinely this machine's clock rather than a substitute
    // for a missing one (contrast row_transit, where it stands in for 「什么时候说的」("when it was said")):
    // the event recorded IS 「这台机器执行了那次按键」("this machine executed that keypress").
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Lan, "clear", ControlOutcome::Sent, None);
    let row = rows(&log)[0].clone();
    let created = row["created_at"].as_str().unwrap().to_string();
    assert!(!created.is_empty());
    assert_eq!(row["updated_at"], created.as_str());
}

#[test]
fn the_mode_filler_is_a_legal_mode_and_never_a_fourth_one() {
    // Red line: three-mode lock, never a fourth mode (三模式锁定，永无第四模式). A keypress has no mode, the field is a required
    // union, so it carries the union's first value and the WINDOW is required not to
    // render a mode badge on a control row. Pinned so nobody 「fixes」 the filler by
    // inventing `mode:'control'`, which the frontend whitelist would silently rewrite
    // to `realtime` anyway — a disagreement nobody could see.
    let (sink, log) = capturing();
    mint_control_row(&sink, Channel::Lan, "clear", ControlOutcome::Sent, None);
    assert_eq!(rows(&log)[0]["mode"], "realtime");
}

// ── MP-14: the wire receipt ──────────────────────────────────────────────────
//
// These pin the frame itself rather than the emit: a socket is not available to
// `cargo test`, and the thing that can be wrong here is the CONTENT. Every case
// below is a way to build a receipt that looks right and lies.

#[test]
fn the_receipt_says_ok_with_no_reason_when_the_keys_went_out() {
    let f = build_key_receipt("enter", Some("k-7"), KeyReceipt::Ok);
    assert_eq!(f["ok"], true);
    assert_eq!(f["kind"], "enter");
    assert_eq!(f["request_id"], "k-7");
    // 🔴 A `reason` on a success would be read by the far side as a refusal it
    // could not name — the schema makes the key optional precisely so success can
    // be silent about cause.
    assert!(f.get("reason").is_none(), "{f}");
}

#[test]
fn the_receipt_carries_the_reason_on_a_refusal() {
    let f = build_key_receipt("tab", Some("k-8"), KeyReceipt::Refused(REASON_UNSUPPORTED_HERE));
    assert_eq!(f["ok"], false);
    assert_eq!(f["reason"], "unsupported_here");
}

#[test]
fn an_absent_request_id_is_omitted_rather_than_sent_empty() {
    // `NonEmpty.optional()` at the relay's zod boundary: an empty string kills the
    // whole frame, and a boundary refusal is ANONYMOUS (the frame dies naming no
    // field). Omission is a real state — 「the press did not carry one」 — and the
    // far side then matches by kind + recency.
    for id in [None, Some("")] {
        let f = build_key_receipt("undo", id, KeyReceipt::Refused(REASON_NO_TARGET));
        assert!(f.get("request_id").is_none(), "{id:?} produced {f}");
    }
}

#[test]
fn five_of_the_six_local_outcomes_collapse_into_failed_and_only_no_target_stands_apart() {
    // 🔴 THE COLLAPSE IS THE DECISION, so it is asserted rather than left to the
    // comment that explains it. The far side's MOVE is what separates the three
    // wire reasons: `no_target` means 「click into a box」, everything else here
    // means 「this computer tried or declined and nothing happened」. If someone
    // later gives `os_refused` its own wire word, this goes red and they have to
    // say which new move it buys.
    assert_eq!(KeyReceipt::from_outcome(ControlOutcome::Sent), KeyReceipt::Ok);
    assert_eq!(
        KeyReceipt::from_outcome(ControlOutcome::NoTarget),
        KeyReceipt::Refused(REASON_NO_TARGET)
    );
    for o in [
        ControlOutcome::ForegroundRefused,
        ControlOutcome::OsRefused,
        ControlOutcome::SendFailed,
        ControlOutcome::NotPrimary,
    ] {
        assert_eq!(
            KeyReceipt::from_outcome(o),
            KeyReceipt::Refused(REASON_FAILED),
            "{o:?} must not grow a wire word of its own without a move to go with it"
        );
    }
}

#[test]
fn the_three_reasons_are_the_three_the_protocol_declares() {
    // A hand-spelled literal on this side is a SECOND source of truth for a string
    // the relay validates with zod. This case is the only thing standing between a
    // typo here and a receipt that dies anonymously at the boundary — the shape
    // `CONTROL_KEY_RESULT_REASONS` exists for in packages/protocol.
    assert_eq!(
        [REASON_UNSUPPORTED_HERE, REASON_NO_TARGET, REASON_FAILED],
        ["unsupported_here", "no_target", "failed"]
    );
}

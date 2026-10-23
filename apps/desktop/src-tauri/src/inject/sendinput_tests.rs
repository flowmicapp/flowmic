// Tests for inject/sendinput.rs, split out under `#[path]` for the 800-line src
// cap (the same shape inject/clipboard_confirm_tests.rs and inject/pipeline_tests.rs
// use). Moved VERBATIM on 2026-10-14 (NR-253 review fixes), only dedented one level.

use super::*;
use std::sync::{Arc, Mutex};

/// One thing the client asked the OS to do. All three seams write into a
/// SINGLE log on purpose: the line-break work (NL-1) is as much about ORDER
/// as about content — 「a」Enter「b」 and 「a」「b」Enter are both "one Enter and
/// two batches", and only one of them is two lines in the right order.
///
/// 🔴 WHAT THE TESTS BELOW DO NOT PROVE. Every seam here is a fake, so each
/// assertion is about what we hand to Win32 and nothing else. That a
/// VK_RETURN pair actually produces a line break in a real edit control is a
/// claim about Windows, and no headless test can make it — it belongs to the
/// device line. What is proven here is the half that was actually broken:
/// that a '\n' no longer leaves as a character.
#[derive(Debug, PartialEq, Eq)]
enum Op {
    Units(Vec<u16>),
    Break(LineBreakKey),
}

/// The key the NL-1 splitting tests below run with. It is the production
/// default (`text_route::line_break_key_for` for any unlisted app), and the
/// splitting does not depend on which key it is — that is pinned separately
/// by `the_requested_line_break_key_is_the_one_pressed`.
const K: LineBreakKey = LineBreakKey::ShiftEnter;
const BRK: Op = Op::Break(K);

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// A client that records every call, in order, and accepts all of them.
fn recording_client() -> (SendInputClient, Arc<Mutex<Vec<Op>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (t, e) = (log.clone(), log.clone());
    let client = SendInputClient::with_fakes(
        move |units| {
            t.lock().unwrap().push(Op::Units(units.to_vec()));
            Ok(units.len())
        },
        move |key| {
            e.lock().unwrap().push(Op::Break(key));
            Ok(1)
        },
    );
    (client, log)
}

#[test]
fn empty_text_is_a_noop_returning_zero() {
    let (client, log) = recording_client();
    assert_eq!(client.type_text("", K).unwrap(), 0);
    assert!(log.lock().unwrap().is_empty(), "no OS call for empty input");
}

#[test]
fn ascii_encodes_one_unit_per_char() {
    let (client, log) = recording_client();
    let n = client.type_text("hi", K).unwrap();
    assert_eq!(n, 2);
    assert_eq!(*log.lock().unwrap(), vec![Op::Units(utf16("hi"))]);
}

#[test]
fn cjk_is_one_unit_per_bmp_char() {
    let (client, log) = recording_client();
    let n = client.type_text("你好", K).unwrap();
    assert_eq!(n, 2, "each CJK BMP char is one UTF-16 unit");
    assert_eq!(*log.lock().unwrap(), vec![Op::Units(vec![0x4F60, 0x597D])]);
}

#[test]
fn emoji_is_a_surrogate_pair_of_two_units() {
    let (client, log) = recording_client();
    // U+1F600 → high+low surrogate, two consecutive units in one batch.
    let n = client.type_text("😀", K).unwrap();
    assert_eq!(n, 2, "an astral-plane emoji is two UTF-16 units");
    assert_eq!(*log.lock().unwrap(), vec![Op::Units(vec![0xD83D, 0xDE00])]);
}

#[test]
fn sender_returning_zero_maps_to_app_rejected() {
    let client = SendInputClient::with_fakes(|_| Ok(0), |_| Ok(0));
    assert!(matches!(client.type_text("x", K), Err(InjectError::AppRejected)));
}

// ── NL-1: line breaks leave as keystrokes, never as characters ────────────

#[test]
fn a_newline_becomes_an_enter_keystroke_and_never_a_raw_lf_unit() {
    let (client, log) = recording_client();
    client.type_text("a\nb", K).unwrap();
    let log = log.lock().unwrap();
    assert_eq!(
        *log,
        vec![Op::Units(utf16("a")), BRK, Op::Units(utf16("b"))]
    );
    // The defect itself: a 0x000A reaching the UNICODE path IS the loss —
    // Windows accepts the event, counts it, and the edit control drops it.
    for op in log.iter() {
        if let Op::Units(units) = op {
            assert!(
                !units.contains(&0x000A),
                "a bare LF unit is exactly what gets silently eaten: {units:?}"
            );
            assert!(
                !units.contains(&0x000D),
                "CR is not sent as a character either: {units:?}"
            );
        }
    }
}

#[test]
fn crlf_is_one_enter_not_two() {
    let (client, log) = recording_client();
    client.type_text("a\r\nb", K).unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        vec![Op::Units(utf16("a")), BRK, Op::Units(utf16("b"))],
        "a CRLF pair is one line break; two Enters would open a blank line"
    );
}

#[test]
fn a_lone_cr_is_also_one_enter() {
    let (client, log) = recording_client();
    client.type_text("a\rb", K).unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        vec![Op::Units(utf16("a")), BRK, Op::Units(utf16("b"))]
    );
}

#[test]
fn the_returned_count_still_counts_every_newline() {
    // The shape from the real-device report: three items joined by two '\n'
    // — 32 text chars + 2 breaks = 34, which is what BOTH ends already
    // account for. This fix must not make that number move, or a correct
    // accounting would start looking like a partial send.
    let (client, _) = recording_client();
    let text = "aaaaaaaaaaa\nbbbbbbbbbb\nccccccccccc";
    assert_eq!(text.chars().count(), 34, "the report's 34-char utterance");
    assert_eq!(client.type_text(text, K).unwrap(), 34);
}

#[test]
fn a_crlf_pair_counts_as_the_one_keystroke_it_becomes() {
    // 4 UTF-16 units in the string, 3 keystroke units on the wire. The count
    // reports what was SENT; nothing compares it to the text length
    // (`map_sendinput_outcome` ignores the value), so this is a truthful
    // number rather than a regression.
    let (client, _) = recording_client();
    assert_eq!("a\r\nb".encode_utf16().count(), 4);
    assert_eq!(client.type_text("a\r\nb", K).unwrap(), 3);
}

#[test]
fn text_and_breaks_keep_their_order_including_the_edges() {
    let (client, log) = recording_client();
    client.type_text("\n你好\n\n😀", K).unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        vec![
            BRK,
            Op::Units(vec![0x4F60, 0x597D]),
            BRK,
            BRK,
            Op::Units(vec![0xD83D, 0xDE00]),
        ],
        "leading, doubled and interior breaks all keep their place, and no \
         empty batch is emitted around them"
    );
}

#[test]
fn a_trailing_newline_sends_its_enter_and_no_empty_batch() {
    // An empty batch would be handed to the real sender as an empty slice,
    // which answers Ok(0) — indistinguishable from the app refusing us.
    let (client, log) = recording_client();
    assert_eq!(client.type_text("hi\n", K).unwrap(), 3);
    assert_eq!(
        *log.lock().unwrap(),
        vec![Op::Units(utf16("hi")), BRK]
    );
}

#[test]
fn a_newline_only_utterance_is_one_enter_and_nothing_else() {
    let (client, log) = recording_client();
    assert_eq!(client.type_text("\n", K).unwrap(), 1);
    assert_eq!(*log.lock().unwrap(), vec![BRK]);
}

#[test]
fn an_enter_the_app_refuses_is_a_rejection_not_a_silent_skip() {
    // "No silent failures": if the keystroke is refused we must say so, not carry on
    // and report a success whose line break never happened.
    let client = SendInputClient::with_fakes(|u| Ok(u.len()), |_| Ok(0));
    assert!(matches!(
        client.type_text("a\nb", K),
        Err(InjectError::AppRejected)
    ));
}

// ── NR-253: the line-break keystroke is the caller's, and never a send ────

#[test]
fn the_requested_line_break_key_is_the_one_pressed() {
    for key in [LineBreakKey::ShiftEnter, LineBreakKey::Enter] {
        let (client, log) = recording_client();
        client.type_text("a\nb\r\nc", key).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![
                Op::Units(utf16("a")),
                Op::Break(key),
                Op::Units(utf16("b")),
                Op::Break(key),
                Op::Units(utf16("c")),
            ],
            "every break in one text must be the key the caller asked for"
        );
    }
}

#[test]
fn shift_enter_plan_holds_shift_around_the_whole_return_press() {
    // Shift down first, Shift up last, Return down+up between — the order
    // a chat input sees as "new line" (measured 2026-10-14). Shift released
    // before Return-down would be a plain Enter, i.e. a send.
    assert_eq!(
        line_break_plan(LineBreakKey::ShiftEnter),
        &[(0x10, false), (0x0D, false), (0x0D, true), (0x10, true)]
    );
}

#[test]
fn plain_enter_plan_is_return_alone() {
    assert_eq!(line_break_plan(LineBreakKey::Enter), &[(0x0D, false), (0x0D, true)]);
}

#[test]
fn every_plan_releases_every_key_it_presses() {
    // A plan that leaves a key down leaves it logically held for whatever
    // the user types next.
    for key in [LineBreakKey::ShiftEnter, LineBreakKey::Enter] {
        let plan = line_break_plan(key);
        for &(vk, up) in plan {
            if !up {
                assert!(plan.contains(&(vk, true)), "{key:?}: vk {vk:#x} never released");
            }
        }
    }
}

// ── NR-253 review: the production choice, and a cut batch's leftovers ─────────

#[test]
fn type_text_for_app_picks_the_key_the_production_path_needs() {
    // The call `text_dispatch.rs::run_sendinput` makes. Forcing the choice in
    // `type_text_for_app` to plain Enter must turn the chat row red.
    for (app, key) in [
        (Some("msedge"), LineBreakKey::ShiftEnter),
        (Some("slack"), LineBreakKey::ShiftEnter),
        (None, LineBreakKey::ShiftEnter),
        (Some("Notepad"), LineBreakKey::Enter),
    ] {
        let (client, log) = recording_client();
        client.type_text_for_app("a\nb", app).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec![Op::Units(utf16("a")), Op::Break(key), Op::Units(utf16("b"))],
            "{app:?}"
        );
    }
}

#[test]
fn a_cut_shift_enter_batch_names_every_key_it_left_down() {
    let plan = line_break_plan(LineBreakKey::ShiftEnter);
    assert_eq!(keys_left_down(plan, 0), Vec::<u16>::new());
    assert_eq!(keys_left_down(plan, 1), vec![0x10]);
    assert_eq!(keys_left_down(plan, 2), vec![0x10, 0x0D]);
    assert_eq!(keys_left_down(plan, 3), vec![0x10]);
    assert_eq!(keys_left_down(plan, 4), Vec::<u16>::new());
}

#[test]
fn a_cut_ctrl_v_batch_names_every_key_it_left_down() {
    // The `send_ctrl_v` plan in clipboard_confirm.rs: Ctrl, V, V-up, Ctrl-up.
    let plan = [(0x11, false), (0x56, false), (0x56, true), (0x11, true)];
    assert_eq!(keys_left_down(&plan, 1), vec![0x11]);
    assert_eq!(keys_left_down(&plan, 2), vec![0x11, 0x56]);
    assert_eq!(keys_left_down(&plan, 3), vec![0x11]);
    assert_eq!(keys_left_down(&plan, 4), Vec::<u16>::new());
}

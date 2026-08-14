// Unit tests for socket::row_transit — "one delivery frame → one timeline row". Kept in a sibling
// file so row_transit.rs stays under the 800-line source cap; same move, and the same
// reason, as client.rs -> client_tests.rs and pump.rs -> pump_tests.rs. The subject
// under test did not change, only where the assertions live — nothing here is a copy
// of anything there.

use super::*;
use std::sync::{Arc, Mutex};

fn frame(extra: Value) -> Value {
    let mut v = json!({ "text": "你好世界", "source": "stt" });
    if let (Some(dst), Some(src)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in src {
            dst.insert(k.clone(), val.clone());
        }
    }
    v
}

fn req_of(frame: &Value) -> InjectRequest {
    crate::socket::wire::parse_inject_request(frame).expect("parses")
}

fn ok_result() -> Value {
    json!({ "ok": true, "mode": "sendinput", "entry_id": "en-1" })
}

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
        .map(|(_, p)| p.clone())
        .collect()
}

// ── ruling 1 — a row is born WITH its verdict ──────────────────────────────

/// The property the whole design rests on: at the instant the row reaches the
/// window it ALREADY carries the REAL verdict. There is no frame on this channel
/// that says "don't know yet", so the "not injected · cached"-before-the-answer state the
/// timeline would otherwise show is never created.
#[test]
fn a_row_reaches_the_window_with_the_real_verdict_already_on_it() {
    for (result, expected) in [
        (json!({ "ok": true, "mode": "sendinput" }), "injected"),
        (json!({ "ok": true, "mode": "clipboard" }), "injected"),
        (json!({ "ok": false, "mode": "cached", "error": "INJECT_FOCUS_LOST" }), "cached"),
        (json!({ "ok": false, "mode": "sendinput", "error": "INJECT_SENDINPUT_FAIL" }), "failed"),
        (json!({ "ok": false, "mode": "clipboard", "error": "INJECT_CLIPBOARD_FAIL" }), "failed"),
    ] {
        let (sink, log) = capturing();
        let f = frame(json!({ "entry_id": "en-1" }));
        mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(result.clone()));
        let sent = rows(&log);
        assert_eq!(sent.len(), 1, "exactly one row per result: {result}");
        assert_eq!(sent[0]["item"]["status"], json!(expected), "verdict {result}");
        // …and it is never the placeholder a two-step mint would have needed.
        assert_ne!(sent[0]["item"]["status"], Value::Null);
    }
}

// ── ruling 2 — one inject:result ⇔ one row ─────────────────────────────────

/// The DEDUP edge. `run_inject` returning None means no result frame went to
/// the phone; the original delivery already made this row, and a second one
/// would be a duplicate line the user has to reconcile by eye.
#[test]
fn a_deduped_frame_mints_no_row_at_all() {
    let (sink, log) = capturing();
    let f = frame(json!({ "entry_id": "en-1", "request_id": "rq-1" }));
    let back = mint_row(&sink, Channel::Lan, &f, &req_of(&f), None);
    assert!(back.is_none(), "the outcome is handed back untouched");
    assert!(rows(&log).is_empty(), "no result ⇒ no row");
    assert!(log.lock().unwrap().is_empty(), "nothing at all is forwarded");
}

/// The REFUSAL edge (socket/client.rs, non-primary channel). A result IS sent,
/// so a row IS minted: "the timeline = all messages delivered to this PC" (owner 2026-07-30 ①)
/// and this message did arrive here and was not typed.
#[test]
fn a_refused_frame_mints_a_row_that_says_it_was_not_injected() {
    let (sink, log) = capturing();
    let f = frame(json!({ "entry_id": "en-9" }));
    let refused = crate::socket::wire::build_inject_result(
        false,
        "sendinput",
        Some(crate::error_codes::INJECT_NOT_PRIMARY),
        None,
        "",
        &req_of(&f),
        // IJ-01 §A-1 row 3: an admission refusal observed no window at all.
        crate::socket::wire::FocusObservation::default(),
    );
    mint_row(&sink, Channel::Cloud, &f, &req_of(&f), Some(refused));
    let sent = rows(&log);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["item"]["status"], json!("failed"));
    assert_eq!(sent[0]["item"]["id"], json!("en-9"));
    // The row is stamped with the channel that carried the refusal — `(channel,
    // id)` is a row's only address.
    assert_eq!(sent[0]["channel"], json!("cloud"));
}

/// The result value is returned unchanged: the caller emits the SAME bytes on
/// the socket that the row was built from, so the phone's status and the PC's
/// row can never describe two different deliveries.
#[test]
fn the_verdict_is_handed_back_byte_for_byte() {
    let (sink, _log) = capturing();
    let f = frame(json!({ "entry_id": "en-1" }));
    let r = ok_result();
    let minted = mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(r.clone())).expect("minted");
    assert_eq!(minted.result, r);
}

// ── RV-72 — the verdict must find the row THIS delivery made ────────────

/// The address is handed back, not re-derived. `forward_verdict` stamps it onto
/// the BRIDGE copy so the window addresses `(channel, row_id)` with no second
/// implementation of the rule — and the socket copy stays untouched, because
/// none of the three stamps is on `InjectResultSchema`.
#[test]
fn the_bridge_copy_carries_the_row_address_and_the_socket_copy_does_not() {
    let (sink, log) = capturing();
    let f = frame(json!({ "text": "", "source": "image", "request_id": "rq-1", "entry_id": "en-1",
                          "image_b64": "QUJDRA==", "image_mime": "image/png" }));
    let req = req_of(&f);
    let minted = mint_row(&sink, Channel::Cloud, &f, &req, Some(ok_result())).expect("minted");
    forward_verdict(&sink, Channel::Cloud, &req, &minted);

    let sent = rows(&log);
    let forwarded: Vec<Value> = log
        .lock()
        .unwrap()
        .iter()
        .filter(|(ch, _)| ch == bridge::channel::INJECT_RESULT)
        .map(|(_, p)| p.clone())
        .collect();
    assert_eq!(forwarded.len(), 1);
    // POSITIVE control: the stamp names the row that was really minted…
    assert_eq!(forwarded[0]["row_id"], sent[0]["item"]["id"], "the verdict finds ITS row");
    assert_eq!(forwarded[0]["row_id"], json!("req:rq-1"));
    assert_eq!(forwarded[0]["channel"], json!("cloud"));
    assert_eq!(forwarded[0]["entry_kind"], json!("image"));
    // …and NEGATIVE control on the frame that goes back on the wire: not one of
    // the three client-local keys may reach it.
    for k in ["row_id", "channel", "entry_kind"] {
        assert!(minted.result.get(k).is_none(), "{k} must not be on the socket copy");
    }
}

/// owner 2026-07-31 ruling ② "one re-delivery = one new row on the PC". The phone keeps `entry_id`
/// across a re-delivery (A-58 correlation) and mints a NEW `request_id`; before
/// RV-72 the second delivery folded onto the first row and the words that were
/// really typed left no record at all.
#[test]
fn a_re_delivery_of_the_same_entry_makes_a_second_row() {
    let (sink, log) = capturing();
    let first = frame(json!({ "text": "原句", "entry_id": "en-1", "request_id": "u7-1" }));
    let again = frame(json!({ "text": "改过的句子", "entry_id": "en-1", "request_id": "u7-1-rp99" }));
    mint_row(&sink, Channel::Lan, &first, &req_of(&first), Some(ok_result()));
    mint_row(&sink, Channel::Lan, &again, &req_of(&again), Some(ok_result()));

    let sent = rows(&log);
    assert_eq!(sent.len(), 2, "two deliveries, two rows");
    assert_ne!(sent[0]["item"]["id"], sent[1]["item"]["id"], "…at two DIFFERENT addresses");
    assert_eq!(sent[1]["item"]["output_text"], json!("改过的句子"));
    // The reverse control: ONE delivery replayed by a reconnect flap (INJ-3 — the
    // same request_id) is still ONE row, or every network hiccup would duplicate
    // a line in the user's timeline.
    mint_row(&sink, Channel::Lan, &again, &req_of(&again), Some(ok_result()));
    let sent = rows(&log);
    assert_eq!(sent.len(), 3, "the frame was forwarded again…");
    assert_eq!(sent[2]["item"]["id"], sent[1]["item"]["id"], "…to the SAME row");
}

// ── the row's fields come off the frame ─────────────────────────────────

#[test]
fn every_row_field_comes_from_the_frame_that_carried_it() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "Hello world",
        "source": "llm",
        "entry_id": "en-42",
        "mode": "translate",
        "created_at": "2026-07-30T08:15:00.000Z",
        "source_text": "你好世界",
        "entry_type": "transcript",
        "device_label": "Pixel 8-ab12",
        "duration_ms": 9490,
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["id"], json!("en-42"));
    assert_eq!(item["mode"], json!("translate"), "the ROW's mode, not inject:result.mode");
    assert_eq!(item["created_at"], json!("2026-07-30T08:15:00.000Z"), "when it was SPOKEN");
    assert_eq!(item["updated_at"], json!("2026-07-30T08:15:00.000Z"), "nothing has changed it yet");
    assert_eq!(item["source_text"], json!("你好世界"));
    assert_eq!(item["output_text"], json!("Hello world"));
    assert_eq!(item["entry_type"], json!("transcript"));
    assert_eq!(item["device_label"], json!("Pixel 8-ab12"));
    assert_eq!(item["duration_ms"], json!(9490), "0.2.43 — how long it took to say, the phone's own number");
    assert_eq!(item["edited"], json!(false));
    assert_eq!(item["status"], json!("injected"));
}

/// 0.2.43 — a malformed duration reads as ABSENT (costs the badge, never the
/// delivery), and an absent one is OMITTED from the row rather than written as 0:
/// "no duration" must reach the frontend as absence, and the normaliser turns that
/// into null (doc 16 §6.1: null must never be treated as 0).
#[test]
fn a_bad_or_missing_duration_is_omitted_never_zero() {
    let (sink, log) = capturing();
    let f = frame(json!({ "entry_id": "en-d1", "duration_ms": -3 }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let f2 = frame(json!({ "entry_id": "en-d2", "duration_ms": "9490" }));
    mint_row(&sink, Channel::Lan, &f2, &req_of(&f2), Some(ok_result()));
    let f3 = frame(json!({ "entry_id": "en-d3" }));
    mint_row(&sink, Channel::Lan, &f3, &req_of(&f3), Some(ok_result()));
    for row in rows(&log) {
        assert!(row["item"].get("duration_ms").is_none(), "{}", row["item"]);
    }
}

/// A 0.2.28 phone sends none of the six. The row is still minted (the message
/// really did arrive) and every fallback is a STATED one.
#[test]
fn a_pre_row_transit_frame_still_mints_a_row_with_honest_fallbacks() {
    let (sink, log) = capturing();
    let f = frame(json!({ "entry_id": "en-1" }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["mode"], json!("realtime"), "the stated default");
    assert_eq!(item["source_text"], Value::Null, "absent ⇒ \"no original text\"");
    assert_eq!(item["entry_type"], json!("transcript"));
    assert!(item.get("thumb_b64").is_none(), "omitted, never an empty string");
    assert!(item.get("device_label").is_none());
    // created_at falls back to THIS PC's clock, which must still be a real
    // ISO-8601 instant or the timeline's sort/eviction comparisons break.
    let created = item["created_at"].as_str().unwrap();
    assert!(created.len() == 24 && created.ends_with('Z') && created.contains('T'), "{created}");
    assert_eq!(item["updated_at"], item["created_at"]);
}

/// red line "three modes locked, never a fourth mode" + the entry-type whitelist. An off-whitelist
/// value reads as ABSENT (→ the stated default), never as itself.
#[test]
fn an_off_whitelist_mode_or_entry_type_never_reaches_the_row() {
    let (sink, log) = capturing();
    let f = frame(json!({ "entry_id": "en-1", "mode": "summarise", "entry_type": "video" }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["mode"], json!("realtime"));
    assert_eq!(item["entry_type"], json!("transcript"));
}

/// This PC decoded the bytes, so it knows the row is a picture even when a
/// 0.2.28 phone did not say so — the same knowledge that already stamps
/// `entry_kind` onto the forwarded inject:result.
#[test]
fn an_image_frame_makes_an_image_row_even_without_the_new_field() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "", "source": "image", "entry_id": "img-1",
        "image_b64": "QUJDRA==", "image_mime": "image/png",
        "thumb_b64": "QUJDRA==",
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["entry_type"], json!("image"));
    assert_eq!(item["thumb_b64"], json!("QUJDRA=="));
    // The frame's `text` is empty BY DESIGN and is copied verbatim — this PC
    // does not invent a caption for a picture nobody described. (RV-68 gives the
    // SENDER a way to describe it; it does not give this PC one — owner ruled out
    // a PC-side descriptor explicitly: it would be a second, drifting copy of a
    // string the phone already owns.)
    assert_eq!(item["output_text"], json!(""));
}

// ── RV-93 — size B: the row says whether its full picture was kept ───────────

/// A real 2×2 PNG. The junk `"QUJDRA=="` every other image test uses is fine for
/// them (they never look at the bytes) but is REFUSED by the picture store, which
/// validates the magic bytes — so a wiring test needs a real one, or it would prove
/// only that a rejected payload sets no flag.
const REAL_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAFjDAGACHtA/wSKAdxAAAAAElFTkSuQmCC";

#[test]
fn an_image_row_keeps_the_delivered_picture_and_says_so() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "", "source": "image", "request_id": "img-rv93",
        "image_b64": REAL_PNG_B64, "image_mime": "image/png",
        "entry_type": "image", "thumb_b64": "QUJDRA==",
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    // ① the row TELLS the frontend it has one…
    assert_eq!(item["full_image"], json!(true));
    // ② …and the picture is really on disk under the row's own address, readable
    // back as what the frame carried. Without ② this test would pass on a flag
    // nobody wrote a file for — the "claiming it was done when it wasn't" half of the red line.
    let url = crate::socket::row_image::data_url("req:img-rv93").expect("kept");
    assert!(url.starts_with("data:image/png;base64,"), "{url}");
    assert!(url.ends_with(REAL_PNG_B64), "byte-identical to the delivered picture");
    // ③ the thumbnail is untouched — two sizes, both on the row.
    assert_eq!(item["thumb_b64"], json!("QUJDRA=="));
    crate::socket::row_image::drop_ids(&["req:img-rv93".to_string()]);
}

/// ⟲ reverse control: a payload the picture store refuses leaves the flag OFF and says so
/// in the minted line. A row that claimed a picture it does not have would offer a
/// double-click that opens nothing.
#[test]
fn a_picture_that_could_not_be_kept_is_not_claimed_on_the_row() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "", "source": "image", "request_id": "img-junk",
        // Valid base64, not a picture — refused by `validated_bytes`.
        "image_b64": "QUJDRA==", "image_mime": "image/png",
        "entry_type": "image", "thumb_b64": "QUJDRA==",
    }));
    let req = req_of(&f);
    mint_row(&sink, Channel::Lan, &f, &req, Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert!(item.get("full_image").is_none(), "omitted, never a false claim");
    // positive control: the row still exists and still shows its thumbnail — the fallback
    // is a smaller picture, not a broken row.
    assert_eq!(item["thumb_b64"], json!("QUJDRA=="));
    let line = minted_line("req:img-junk", RowIdOrigin::Request, Channel::Lan, &req, &RowFacts::read(&f), &item);
    assert!(line.contains("full_image→absent"), "{line}");
}

/// 🔴 F-4 / RV-39 — THE PICTURE IS KEPT EVEN WHEN THE INJECTION DID NOT SUCCEED.
///
/// This is the property that closed F-4's content loss, and until now nothing
/// pinned it: both RV-93 tests above drive `ok_result()`, so an "optimisation"
/// that only stored the picture for a successful inject would leave every one of
/// them green while resurrecting the original defect in full.
///
/// What F-4 was (M5, 2026-08-03): a picture sent to a foreground window that could
/// not receive it landed nowhere, AND the clipboard was withdrawn (RV-39
/// `withdraw_announcement` → EmptyClipboard) and then overwritten by the user's
/// restored clipboard — so the bytes existed in no target, on no clipboard and on
/// no disk, while both ends said success. The reason that is no longer true is
/// exactly this: `build_row` stores from `req.image()` — the FRAME's own bytes,
/// still in memory — and its call site takes no `result`/`ok`/`status` argument, so
/// the write cannot be skipped by a bad verdict. The clipboard being emptied is
/// therefore no longer a content question, only a delivery one.
///
/// Both halves are asserted separately, on purpose: the row's `full_image` FLAG and
/// the BYTES it claims. A test that only checked the flag would stay green if the
/// write were skipped and the flag hard-coded — and "claiming it was done when it wasn't" is the half of
/// the red line this whole file exists to hold.
///
/// ⚠️ This deliberately does NOT assert anything about `ok`/`status` being right for
/// an unconsumed paste. Whether an image whose target never fetched it is still
/// `injected` is owner's 2026-07-30 ruling (quoted in `inject/clipboard_outcome.rs`
/// `map_image_outcome`), not this test's business. The verdicts below are only the
/// two shapes that must NOT be allowed to suppress the write.
#[test]
fn a_picture_is_kept_even_when_the_inject_verdict_is_not_success() {
    // (verdict, the status it must really produce, this row's id)
    let cases: [(Value, &str, &str); 2] = [
        (
            json!({ "ok": false, "mode": "clipboard", "error": "INJECT_CLIPBOARD_FAIL", "entry_id": "en-1" }),
            "failed",
            "img-f4-failed",
        ),
        (
            json!({ "ok": false, "mode": "cached", "error": "INJECT_FOCUS_LOST", "entry_id": "en-1" }),
            "cached",
            "img-f4-cached",
        ),
    ];
    for (verdict, want_status, rid) in cases {
        let (sink, log) = capturing();
        let f = frame(json!({
            "text": "", "source": "image", "request_id": rid,
            "image_b64": REAL_PNG_B64, "image_mime": "image/png",
            "entry_type": "image", "thumb_b64": "QUJDRA==",
        }));
        mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(verdict));
        let item = rows(&log)[0]["item"].clone();
        // positive control first: the verdict really is a non-success one, so a green run
        // below cannot mean "the test quietly drove the ok path".
        assert_eq!(item["status"], json!(want_status), "{rid}");
        // ① the row claims the picture…
        assert_eq!(item["full_image"], json!(true), "{rid}: kept despite {want_status}");
        // ② …and the bytes are really on disk, byte-identical to what was sent.
        let addr = format!("req:{rid}");
        let url = crate::socket::row_image::data_url(&addr).expect("kept");
        assert!(url.ends_with(REAL_PNG_B64), "{rid}: byte-identical to the delivered picture");
        crate::socket::row_image::drop_ids(&[addr]);
    }
}

/// A TRANSCRIPT row never mentions the picture gap — the same discipline
/// `thumb_b64` and `entry_caption` follow: a gap that fires on every row is noise
/// nobody reads, and then the one that matters is invisible too.
#[test]
fn a_transcript_row_says_nothing_about_pictures() {
    let f = frame(json!({ "request_id": "t-1", "mode": "realtime", "created_at": "2026-08-01T00:00:00Z", "device_label": "Mate-1" }));
    let req = req_of(&f);
    let facts = RowFacts::read(&f);
    let item = build_row("req:t-1", &req, &facts, &ok_result(), "2026-08-01T00:00:00Z");
    let line = minted_line("req:t-1", RowIdOrigin::Request, Channel::Lan, &req, &facts, &item);
    assert!(!line.contains("full_image"), "{line}");
}

// ── RV-68 — an image row's WORDS ────────────────────────────────────────

/// THE BUG THIS CLOSES: the phone's row read "🖼 PNG · 214 KB" and the PC's row
/// had a thumbnail with not one character under it, because an image frame's
/// `text` is `''` by design and there was nowhere else for a caption to ride.
#[test]
fn an_image_row_shows_the_caption_the_sender_prepared() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "", "source": "image", "request_id": "img-9",
        "image_b64": "QUJDRA==", "image_mime": "image/png",
        "entry_type": "image", "thumb_b64": "QUJDRA==",
        "entry_caption": "🖼 PNG · 214 KB",
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["output_text"], json!("🖼 PNG · 214 KB"));
    assert_eq!(item["entry_type"], json!("image"), "…and it is still an image row");
    // 🔴 The caption must NOT have been copied anywhere it could be mistaken for
    // the words that were delivered. `text` was empty and the delivery really did
    // type nothing; `source_text` is the immutable original and a picture has none.
    assert_eq!(item["source_text"], Value::Null);
}

/// 🔴 A TRANSCRIPT row never takes a caption, even if one is on the frame. The
/// wire schema refuses that combination outright (superRefine), so this is the
/// belt to that braces: `text` is the transcript row's face and a second answer
/// must not be able to displace it on this side either.
#[test]
fn a_transcript_row_ignores_a_caption_and_keeps_its_own_text() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "真正说出来的话", "entry_id": "en-1",
        "entry_type": "transcript", "entry_caption": "🖼 PNG · 214 KB",
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    assert_eq!(rows(&log)[0]["item"]["output_text"], json!("真正说出来的话"));
}

/// 🔴 THE FALLBACK DOES NOT UNLOCK DISPLAY TEXT. `source:'image'` with no
/// `entry_type` still makes an image ROW (this PC decoded the bytes, so it knows),
/// but that is this PC's GUESS about someone else's row — and a guess must not put
/// words on it. Stated as a rule in protocol-schemas-inject.ts and enforced here,
/// so the two ends cannot disagree about which frames may carry a caption.
#[test]
fn a_guessed_image_row_does_not_take_the_caption() {
    let (sink, log) = capturing();
    let f = frame(json!({
        "text": "", "source": "image", "request_id": "img-8",
        "image_b64": "QUJDRA==", "image_mime": "image/png",
        "entry_caption": "🖼 PNG · 214 KB",
    }));
    mint_row(&sink, Channel::Lan, &f, &req_of(&f), Some(ok_result()));
    let item = rows(&log)[0]["item"].clone();
    assert_eq!(item["entry_type"], json!("image"), "the row kind IS still inferred");
    assert_eq!(item["output_text"], json!(""), "…but its words are not");
}

/// An empty caption is "didn't say", not "said empty" — the row falls back to `text` rather
/// than rendering a blank line that claims the sender described the picture.
#[test]
fn an_empty_caption_reads_as_absent() {
    let f = frame(json!({ "entry_type": "image", "entry_caption": "" }));
    assert_eq!(RowFacts::read(&f).entry_caption, None);
}

/// no silent failures: an image row with no words self-reports, exactly like one with no
/// preview. The primary controller once read this line off a real machine and could not tell whether
/// a missing value was never sent or was dropped here (RV-75) — a new field that
/// does not appear in `gaps=[…]` re-opens that hole.
#[test]
fn a_picture_row_with_no_caption_says_so_and_a_transcript_never_does() {
    let img = frame(json!({
        "text": "", "source": "image", "request_id": "i-1",
        "image_b64": "QUJDRA==", "image_mime": "image/png", "entry_type": "image",
    }));
    let facts = RowFacts::read(&img);
    let item = build_row("r", &req_of(&img), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&img), &facts, &item);
    assert!(line.contains("entry_caption→absent"), "{line}");

    // POSITIVE control ①: the same picture WITH words reports no such gap — and
    // the row really does carry them, so this control cannot pass while the
    // feature is broken.
    let mut with_caption = img.clone();
    with_caption["entry_caption"] = json!("🖼 PNG · 214 KB");
    let facts = RowFacts::read(&with_caption);
    let item = build_row("r", &req_of(&with_caption), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&with_caption), &facts, &item);
    assert!(!line.contains("entry_caption"), "{line}");
    assert_eq!(item["output_text"], json!("🖼 PNG · 214 KB"));

    // POSITIVE control ②: a transcript has no caption and that is not a gap, or
    // the line would carry this token on every row and mean nothing.
    let txt = frame(json!({ "request_id": "t-1" }));
    let facts = RowFacts::read(&txt);
    let item = build_row("r", &req_of(&txt), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&txt), &facts, &item);
    assert!(!line.contains("entry_caption"), "{line}");
}

// ── the row's id ────────────────────────────────────────────────────────

/// RV-72: "this delivery" addresses the row, even when the frame also names its
/// content. It is DERIVED (never random) so an INJ-3 replay of one delivery
/// upserts one row instead of adding a second.
#[test]
fn the_row_id_is_the_delivery_id_when_there_is_one() {
    let f = frame(json!({ "entry_id": "en-7", "request_id": "rq-7" }));
    let (a, origin) = row_id(&req_of(&f));
    let (b, _) = row_id(&req_of(&f));
    assert_eq!(origin, RowIdOrigin::Request);
    assert_eq!(a, "req:rq-7", "the DELIVERY id, not the entry id");
    assert_eq!(a, b, "the SAME delivery must not produce two rows");
    assert_ne!(a, "rq-7", "prefixed so it can never collide with a phone-minted id");
}

/// No `request_id` — a sender too old to stamp one. The row falls back to the
/// CONTENT id, and [`minted_line`] says so, because that row has the pre-RV-72
/// behaviour: a re-delivery of the same content would land on it.
#[test]
fn without_a_request_id_the_row_falls_back_to_the_entry_id() {
    let f = frame(json!({ "entry_id": "en-7" }));
    assert_eq!(row_id(&req_of(&f)), ("en-7".to_string(), RowIdOrigin::Entry));
    let item = build_row("en-7", &req_of(&f), &RowFacts::default(), &ok_result(), "t");
    let line = minted_line("en-7", RowIdOrigin::Entry, Channel::Lan, &req_of(&f), &RowFacts::default(), &item);
    assert!(line.contains("request_id→absent"), "{line}");
}

/// Neither id: there is nothing on the frame to be stable against, so each
/// frame gets its own address rather than a fabricated shared one.
#[test]
fn with_no_ids_at_all_each_frame_gets_its_own_local_address() {
    let f = frame(json!({}));
    let (a, origin) = row_id(&req_of(&f));
    let (b, _) = row_id(&req_of(&f));
    assert_eq!(origin, RowIdOrigin::Local);
    assert!(a.starts_with("local:"), "{a}");
    assert_ne!(a, b, "two anonymous frames are two rows, not one overwritten twice");
}

// ── the facts reader ────────────────────────────────────────────────────

#[test]
fn empty_strings_read_as_absent_rather_than_as_content() {
    let f = frame(json!({
        "created_at": "", "thumb_b64": "", "device_label": "",
        "mode": "", "entry_type": "",
    }));
    assert_eq!(RowFacts::read(&f), RowFacts::default());
    // `source_text` is the one field that keeps three states apart (RV-75): an
    // empty string is a frame that SAID there is no original, which is a
    // different statement from a frame that never mentions the field.
    let e = frame(json!({ "source_text": "" }));
    assert_eq!(RowFacts::read(&e).source_text, Stated::Null);
}

#[test]
fn non_string_fields_read_as_absent_rather_than_as_a_stringified_number() {
    let f = frame(json!({ "created_at": 1700000000, "device_label": ["a"], "mode": 3 }));
    assert_eq!(RowFacts::read(&f), RowFacts::default());
}

// ── RV-75 — the log line can answer "not sent, or sent but not rendered" ────────────────

/// The primary controller read this line off a real machine and could not tell which. All three
/// states are now three distinguishable tokens, and the row's own value agrees
/// with the token in every one of them.
#[test]
fn the_minted_line_separates_no_source_text_from_an_absent_source_text() {
    for (frame_extra, token, on_row) in [
        (json!({}), "source_text=absent", Value::Null),
        (json!({ "source_text": Value::Null }), "source_text=null", Value::Null),
        (json!({ "source_text": "你好世界" }), "source_text=4chars", json!("你好世界")),
    ] {
        let f = frame(frame_extra.clone());
        let req = req_of(&f);
        let facts = RowFacts::read(&f);
        let item = build_row("r", &req, &facts, &ok_result(), "t");
        let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req, &facts, &item);
        assert!(line.contains(token), "{frame_extra} → {line}");
        assert_eq!(item["source_text"], on_row, "{frame_extra}");
        // …and none of the three may be reported as a GAP: gaps are fallbacks,
        // and this field has nothing to fall back to (see minted_line's note).
        assert!(!line.contains("gaps=[source_text"), "{line}");
    }
}

/// An image row whose preview never arrived is a row the user cannot recognise —
/// the picture IS the content. A transcript never carries this gap, or the line
/// would report one on every row and mean nothing.
#[test]
fn a_picture_row_with_no_preview_says_so_and_a_transcript_never_does() {
    let img = frame(json!({
        "text": "", "source": "image", "request_id": "i-1",
        "image_b64": "QUJDRA==", "image_mime": "image/png",
    }));
    let facts = RowFacts::read(&img);
    let item = build_row("r", &req_of(&img), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&img), &facts, &item);
    assert_eq!(item["entry_type"], json!("image"));
    assert!(line.contains("thumb_b64→absent"), "{line}");

    // POSITIVE control ①: the same picture WITH a preview reports no such gap.
    let mut with_thumb = img.clone();
    with_thumb["thumb_b64"] = json!("QUJDRA==");
    let facts = RowFacts::read(&with_thumb);
    let item = build_row("r", &req_of(&with_thumb), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&with_thumb), &facts, &item);
    assert!(!line.contains("thumb_b64"), "{line}");

    // POSITIVE control ②: a transcript has no preview and that is not a gap.
    let txt = frame(json!({ "request_id": "t-1" }));
    let facts = RowFacts::read(&txt);
    let item = build_row("r", &req_of(&txt), &facts, &ok_result(), "t");
    let line = minted_line("r", RowIdOrigin::Request, Channel::Lan, &req_of(&txt), &facts, &item);
    assert!(!line.contains("thumb_b64"), "{line}");
}

/// The gaps that were already reported still are — this card ADDED two facts, it
/// did not trade one set of blind spots for another.
#[test]
fn the_line_still_names_every_value_that_did_not_come_off_the_frame() {
    let f = frame(json!({ "entry_id": "en-1" }));
    let req = req_of(&f);
    let facts = RowFacts::read(&f);
    let item = build_row("en-1", &req, &facts, &ok_result(), "2026-07-31T00:00:00.000Z");
    let line = minted_line("en-1", RowIdOrigin::Entry, Channel::Lan, &req, &facts, &item);
    for token in [
        "id=en-1",
        "id_from=entry_id",
        "channel=lan",
        "status=injected",
        "created_at→received_at",
        "mode→realtime(guess)",
        "device_label→none",
        "request_id→absent",
    ] {
        assert!(line.contains(token), "missing {token} in {line}");
    }
}

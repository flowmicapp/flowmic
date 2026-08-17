// Tests for socket/wire.rs, split out under `#[cfg(test)] #[path = "wire_tests.rs"]`
// for the 800-line src cap — the same shape as inject/pipeline_tests.rs,
// sidecar/io_tests.rs and socket/client_tests.rs.
//
// NOTHING ELSE MOVED. Every assertion and every comment below is byte-identical
// to what sat at the bottom of wire.rs before the RV-29 round pushed the file to
// 801 lines; the split is a file boundary, not a rewrite. `super::*` still
// resolves to socket::wire, so no import changed either.

use super::*;

#[test]
fn parse_inject_request_reads_core_and_echo_keys() {
    let v = json!({
        "text": "hello world",
        "source": "llm",
        "request_id": "rq-1",
        "entry_id": "en-9"
    });
    let req = parse_inject_request(&v).unwrap();
    assert_eq!(req.text, "hello world");
    assert_eq!(req.source, "llm");
    assert_eq!(req.request_id.as_deref(), Some("rq-1"));
    assert_eq!(req.entry_id.as_deref(), Some("en-9"));
}

#[test]
fn parse_inject_request_defaults_source_and_drops_empty_ids() {
    let v = json!({ "text": "hi", "request_id": "", "entry_id": "" });
    let req = parse_inject_request(&v).unwrap();
    assert_eq!(req.source, "stt", "source defaults to stt");
    assert_eq!(req.request_id, None, "empty id dropped (NonEmpty on the wire)");
    assert_eq!(req.entry_id, None);
}

#[test]
fn parse_inject_request_requires_text() {
    assert!(parse_inject_request(&json!({ "source": "stt" })).is_none());
}

// ── R6 T-4: the F-2350 image fields ─────────────────────────────────────

#[test]
fn an_image_frame_is_recognised_only_when_source_and_both_fields_agree() {
    // The real shape the mobile emits: empty text, source image, both fields.
    let v = json!({
        "text": "",
        "source": "image",
        "request_id": "img-1",
        "entry_id": "loc_dev_img-1",
        "image_b64": "QUJDRA==",
        "image_mime": "image/png"
    });
    let req = parse_inject_request(&v).expect("parses");
    assert_eq!(req.image(), Some(("QUJDRA==", "image/png")));
    assert!(!req.is_malformed_image());
    assert_eq!(req.entry_id.as_deref(), Some("loc_dev_img-1"));

    // A text frame never looks like an image, even with an empty text.
    let text_frame = parse_inject_request(&json!({ "text": "", "source": "stt" })).unwrap();
    assert_eq!(text_frame.image(), None);
    assert!(!text_frame.is_malformed_image());
}

#[test]
fn a_half_formed_image_frame_is_flagged_rather_than_read_as_empty_text() {
    // This is the exact hazard: `text:""` + `source:'image'` would otherwise
    // short-circuit the text pipeline to a fabricated ok=true.
    for payload in [
        json!({ "text": "", "source": "image" }),
        json!({ "text": "", "source": "image", "image_b64": "QUJDRA==" }),
        json!({ "text": "", "source": "image", "image_mime": "image/png" }),
        json!({ "text": "", "source": "image", "image_b64": "", "image_mime": "image/png" }),
    ] {
        let req = parse_inject_request(&payload).expect("parses");
        assert_eq!(req.image(), None, "not a usable image frame: {payload}");
        assert!(req.is_malformed_image(), "must be flagged loud: {payload}");
    }
}

#[test]
fn cached_result_echoes_ids_and_omits_target() {
    // The truth this environment produces: focus lost → cached.
    let req = InjectRequest {
        text: "hi".into(),
        source: "stt".into(),
        request_id: Some("rq-7".into()),
        entry_id: Some("en-7".into()),
        ..Default::default()
    };
    let out = build_inject_result(
        false,
        "cached",
        Some("INJECT_FOCUS_LOST"),
        None,
        "",
        &req,
        FocusObservation::default(),
    );
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["mode"], json!("cached"));
    assert_eq!(out["error"], json!("INJECT_FOCUS_LOST"));
    assert_eq!(out["request_id"], json!("rq-7"));
    assert_eq!(out["entry_id"], json!("en-7"));
    assert!(out.get("target_window").is_none(), "no target on cached");
    assert!(out.get("inject_target").is_none());
}

#[test]
fn success_result_carries_target_and_inject_target() {
    let req = InjectRequest {
        text: "hi".into(),
        source: "stt".into(),
        request_id: None,
        entry_id: Some("en-3".into()),
        ..Default::default()
    };
    let out = build_inject_result(
        true,
        "sendinput",
        None,
        Some(("Untitled - Notepad", "notepad")),
        "2026-07-23T00:00:00.000Z",
        &req,
        FocusObservation::default(),
    );
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["target_window"], json!("Untitled - Notepad"));
    assert_eq!(out["inject_target"]["process_name"], json!("notepad"));
    assert_eq!(out["inject_target"]["injected_at"], json!("2026-07-23T00:00:00.000Z"));
    assert_eq!(out["entry_id"], json!("en-3"));
    assert!(out.get("request_id").is_none(), "absent request_id not echoed");
    assert!(out.get("error").is_none());
}

// ── IJ-01 · `focus_window` / `focus_evidence` on the frame ──────────────────
//
// owner 2026-08-07 ruling ④. The shape is asserted HERE, at the one producer, rather
// than at four call sites: "which branches speak of a window" is then a question about the callers,
// and "what it looks like when it does speak" a question about this file.

fn probe_req() -> InjectRequest {
    InjectRequest {
        text: "hi".into(),
        source: "stt".into(),
        request_id: Some("rq-ij1".into()),
        ..Default::default()
    }
}

/// 🔴 THE LINE THE CARD EXISTS FOR: a delivery that was NOT injected can now say
/// which window it was aimed at, while `inject_target` stays exactly as narrow as
/// it was (ok:true only). Both halves are asserted in ONE test on purpose — the
/// defect this card fixes and the contract it must not break are the same frame.
#[test]
fn a_failed_delivery_names_the_window_it_was_aimed_at_without_claiming_it_landed() {
    let out = build_inject_result(
        false,
        "cached",
        Some("INJECT_FOCUS_LOST"),
        None, // where it LANDED — nowhere
        "",
        &probe_req(),
        FocusObservation {
            window: Some(("Untitled - Notepad", "notepad")),
            evidence: Some("not_editable"),
        },
    );
    assert_eq!(out["focus_window"]["window_title"], json!("Untitled - Notepad"));
    assert_eq!(out["focus_window"]["process_name"], json!("notepad"));
    assert_eq!(out["focus_evidence"], json!("not_editable"));
    // …and the OLD key must not have been widened along with it (04 §3.5 F-3112).
    assert!(out.get("inject_target").is_none(), "a non-delivery claims no place");
    assert!(out.get("target_window").is_none());
    // The A-58 echo is untouched by the field-add.
    assert_eq!(out["request_id"], json!("rq-ij1"));
}

/// 🔴 ABSENCE ≠ `unknown` (§A-4). `unknown` says "we asked, but couldn't get an answer"; a path that never
/// probed must write NO KEY, or every un-probed branch would ship a fabricated
/// measurement. Same rule `gui_ok=false` follows in target_probe.rs.
#[test]
fn an_unasked_question_writes_no_key_rather_than_the_word_unknown() {
    let out = build_inject_result(
        false,
        "sendinput",
        Some("INJECT_NOT_PRIMARY"),
        None,
        "",
        &probe_req(),
        FocusObservation::default(),
    );
    assert!(out.get("focus_evidence").is_none(), "absent, NOT 'unknown'");
    assert!(out.get("focus_window").is_none(), "no window was ever observed");
    // POSITIVE CONTROL — without it this test also passes against a builder that
    // never writes either key at all, which is a different bug wearing the same
    // green (and is exactly the state this card came to fix).
    let filled = build_inject_result(
        false,
        "sendinput",
        Some("INJECT_NO_TEXT_TARGET"),
        None,
        "",
        &probe_req(),
        FocusObservation {
            window: Some(("", "chrome")),
            evidence: Some("unknown"),
        },
    );
    assert_eq!(filled["focus_evidence"], json!("unknown"));
    assert_eq!(filled["focus_window"]["process_name"], json!("chrome"));
}

/// `window_title` may legitimately be `""` (a window with no title) — the schema
/// declares it `z.string()` for exactly that. `process_name` may not: it is
/// NonEmpty on the boundary AND it is the half owner's ruling (c) allows onto a
/// persisted row, so a nameless process gets NO key rather than an empty one.
#[test]
fn an_untitled_window_still_reports_but_a_nameless_process_does_not() {
    let titled_blank = build_inject_result(
        true,
        "sendinput",
        None,
        Some(("", "cursor")),
        "2026-08-07T00:00:00.000Z",
        &probe_req(),
        FocusObservation {
            window: Some(("", "cursor")),
            evidence: Some("editable"),
        },
    );
    assert_eq!(titled_blank["focus_window"]["window_title"], json!(""));
    assert_eq!(titled_blank["focus_window"]["process_name"], json!("cursor"));

    let nameless = build_inject_result(
        false,
        "cached",
        Some("INJECT_FOCUS_LOST"),
        None,
        "",
        &probe_req(),
        FocusObservation {
            window: Some(("Some Title", "")),
            evidence: None,
        },
    );
    assert!(
        nameless.get("focus_window").is_none(),
        "a window we could not name a process for is \"not identified\", not a half-filled object"
    );
}

/// The three tokens really are the three the protocol enum accepts, asserted
/// through the SAME mapping production uses rather than against retyped literals
/// (a hand-spelled fixture is a second source of truth for one string).
#[test]
fn every_evidence_token_survives_onto_the_frame_verbatim() {
    use crate::inject::{wire_evidence, FocusInputState};
    for state in [
        FocusInputState::Input,
        FocusInputState::NotInput,
        FocusInputState::Unknown,
    ] {
        let token = wire_evidence(state);
        let out = build_inject_result(
            false,
            "cached",
            Some("INJECT_FOCUS_LOST"),
            None,
            "",
            &probe_req(),
            FocusObservation {
                window: None,
                evidence: Some(token),
            },
        );
        assert_eq!(out["focus_evidence"], json!(token), "state={state:?}");
    }
}

#[test]
fn control_kind_is_extracted_verbatim() {
    assert_eq!(parse_control_kind(&json!({ "kind": "enter" })).as_deref(), Some("enter"));
    assert_eq!(parse_control_kind(&json!({ "kind": "bogus" })).as_deref(), Some("bogus"));
    assert_eq!(parse_control_kind(&json!({})), None);
}

#[test]
fn register_ack_parses_ids() {
    let ack = json!({ "token": "t", "pc_id": "p", "room_uuid": "r", "short_code": "1234" });
    let (t, p, r) = parse_register_ack(&ack);
    assert_eq!(t.as_deref(), Some("t"));
    assert_eq!(p.as_deref(), Some("p"));
    assert_eq!(r.as_deref(), Some("r"));
}

#[test]
fn release_mobile_emits_revoke_only_when_it_is_really_a_revocation() {
    // disconnect: byte-identical to every pre-GA-08 frame — the absence of the flag
    // IS the disconnect meaning (server reads `revoke === true`).
    let disconnect = build_pc_release_mobile("m-1", false);
    assert_eq!(disconnect, json!({ "mobile_id": "m-1" }));
    assert!(disconnect.get("revoke").is_none());
    // revoke: unmistakable on the wire and in a log.
    assert_eq!(
        build_pc_release_mobile("m-1", true),
        json!({ "mobile_id": "m-1", "revoke": true }),
    );
}

#[test]
fn release_mobile_ack_is_true_only_for_an_explicit_ok() {
    // disconnect (revoke=false): the phone may be offline, so `released: 0` is a
    // genuine success — the suppression window was still written.
    assert!(parse_release_mobile_ack(&json!({ "ok": true, "released": 1, "revoked": 0 }), false));
    assert!(parse_release_mobile_ack(&json!({ "ok": true, "released": 0 }), false));
    // Everything else means "it did not happen" — the page must not refresh
    // a table as if the action had succeeded.
    assert!(!parse_release_mobile_ack(&json!({ "ok": false }), false));
    assert!(!parse_release_mobile_ack(&json!({ "error": "AUTH_TOKEN_INVALID" }), false));
    assert!(!parse_release_mobile_ack(&json!({}), false));
    assert!(!parse_release_mobile_ack(&json!({ "ok": "yes" }), false));
}

/// v0.2.7 — revoke is a DELETION, so `ok` alone is not the answer.
///
/// owner 2026-07-29: "on the PC side this couldn't be revoked — it showed success, but it's still there". The two
/// channels are two servers with two `mobile_pairings` tables, and the
/// revoke was going to whichever channel was PRIMARY. Asked to delete a row
/// it has never heard of, the server answers `{ok:true, revoked:0}` — a
/// well-formed request that removed nothing — and the desktop read only
/// `ok`. Routing is fixed in shell::release_mobile; this is the second half,
/// because either defect alone still lets a deletion be claimed that did not
/// happen (red line: never claim something happened that did not).
#[test]
fn a_revoke_that_removed_no_row_is_a_failure_however_ok_the_ack_says() {
    // The exact frame the wrong server sends back.
    assert!(!parse_release_mobile_ack(&json!({ "ok": true, "released": 0, "revoked": 0 }), true));
    // A server too old to report the count cannot prove the deletion either.
    assert!(!parse_release_mobile_ack(&json!({ "ok": true }), true));
    // A real revocation says so.
    assert!(parse_release_mobile_ack(&json!({ "ok": true, "released": 1, "revoked": 1 }), true));
    assert!(parse_release_mobile_ack(&json!({ "ok": true, "released": 0, "revoked": 1 }), true));
    // …and `ok:false` is still false whatever the count claims.
    assert!(!parse_release_mobile_ack(&json!({ "ok": false, "revoked": 1 }), true));
}

#[test]
fn expires_in_ms_is_read_only_when_the_server_really_sent_a_number() {
    assert_eq!(parse_expires_in_ms(&json!({ "expires_in_ms": 300_000 })), Some(300_000));
    assert_eq!(parse_expires_in_ms(&json!({ "expires_in_ms": 0 })), Some(0));
    // A pre-GA-18 server sends nothing → None → the modal shows its static
    // TTL line rather than counting down from a fabricated deadline.
    assert_eq!(parse_expires_in_ms(&json!({ "short_code": "1234" })), None);
    assert_eq!(parse_expires_in_ms(&json!({ "expires_in_ms": "300000" })), None);
    assert_eq!(parse_expires_in_ms(&json!({ "expires_in_ms": -5 })), None);
}

#[test]
fn settings_update_wraps_key_and_value_verbatim() {
    let v = build_settings_update("llm.config", json!({ "model": "qwen", "api_key": "EMPTY" }), None);
    assert_eq!(v["key"], json!("llm.config"));
    assert_eq!(v["value"]["model"], json!("qwen"));
}

/// Card C3 — the desktop is the SECOND writer of `scenario.card`, so its frames
/// have to say when the user edited. Before this, the builder emitted no stamp at
/// all and the server's regress guard could therefore never fire against a
/// desktop write: a stale offline edit replayed on reconnect still overwrote a
/// card the phone had edited minutes ago, silently.
#[test]
fn settings_update_carries_the_edit_moment_when_the_frontend_knows_it() {
    let v = build_settings_update(
        "scenario.card",
        json!({ "terms": ["灰度发布"] }),
        Some("2026-08-17T12:00:00.000Z"),
    );
    assert_eq!(v["key"], json!("scenario.card"));
    assert_eq!(v["updated_at"], json!("2026-08-17T12:00:00.000Z"));
    // Verbatim: this layer neither re-formats nor re-stamps. The frame may be a
    // replay of an edit made a week ago, and re-stamping it here is precisely
    // what would let that replay win.
    assert_eq!(v["value"]["terms"][0], json!("灰度发布"));
}

/// 🔴 ABSENT, NOT NULL. Absent means UNKNOWN and the server writes
/// unconditionally — exactly the pre-C3 behaviour, which is what makes the phone
/// and desktop shippable in any order. An explicit `null` would fail
/// `Iso8601.optional()` at the zod boundary and take the WHOLE frame down, and a
/// boundary refusal is anonymous: the user would see a setting that simply never
/// syncs, with nothing anywhere saying why.
#[test]
fn settings_update_omits_the_key_entirely_when_the_moment_is_unknown() {
    let v = build_settings_update("stt.routings", json!([]), None);
    assert!(v.get("updated_at").is_none(), "absent must be ABSENT, never null: {v}");
    assert_eq!(v, json!({ "key": "stt.routings", "value": [] }));
}

/// 🔴 The rename is the ONE settings write that must stay un-stamped, and this
/// pins it from our side. The server's G2 arbitration deliberately stops at the
/// `device.pc_name` branch (settings.handler.ts): the name is not in the KV, so
/// there is no `updated_at` for a stamp to be honest about, and `pc_devices` has
/// no such column — a stamp here would be a time invented from nothing. The
/// server's own `test/pc-rename.test.ts` asserts the same payload from the other
/// end; this is the half that fails on the machine that would introduce the bug.
#[test]
fn pc_name_update_carries_no_stamp() {
    let v = build_pc_name_update("dev-pc-a");
    assert!(v.get("updated_at").is_none(), "the rename must not be stamped: {v}");
    assert_eq!(v["key"], json!(crate::events::KEY_DEVICE_PC_NAME));
    assert_eq!(v["value"]["pc_name"], json!("dev-pc-a"));
}

#[test]
fn settings_list_builds_empty_payload_and_parses_items_array() {
    assert_eq!(build_settings_list(), json!({}));
    // A well-formed ack yields the items array verbatim.
    let ack = json!({ "items": [{ "key": "stt.routings", "value": [] }, { "key": "scenario.card", "value": {} }] });
    let items = parse_settings_list_ack(&ack).expect("items present");
    assert!(items.is_array());
    assert_eq!(items.as_array().unwrap().len(), 2);
    assert_eq!(items[0]["key"], json!("stt.routings"));
    // An error ack (no items) → None so the desktop keeps its local cache.
    assert_eq!(parse_settings_list_ack(&json!({ "error": "AUTH_TOKEN_INVALID" })), None);
    // A malformed items (not an array) → None.
    assert_eq!(parse_settings_list_ack(&json!({ "items": "nope" })), None);
}

#[test]
fn list_mobiles_builds_empty_payload_and_narrows_to_the_public_six() {
    assert_eq!(build_pc_list_mobiles(), json!({}));
    // A hostile / over-sharing ack: the token must NOT survive the narrowing.
    let ack = json!({ "mobiles": [{
        "pairing_id": "p1", "mobile_name": "Pixel 9",
        "paired_at": "2026-07-25T10:00:00.000Z", "last_seen_at": null, "online": true,
        "device_uid": "mb-0a0b0c0d0e0f0102",
        "mobile_token": "S3CRET-token-value", "user_id": "default"
    }] });
    let rows = parse_list_mobiles_ack(&ack).expect("mobiles present");
    let arr = rows.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["pairing_id"], json!("p1"));
    assert_eq!(arr[0]["mobile_name"], json!("Pixel 9"));
    assert_eq!(arr[0]["online"], json!(true));
    assert_eq!(arr[0]["last_seen_at"], Value::Null);
    assert_eq!(arr[0]["device_uid"], json!("mb-0a0b0c0d0e0f0102"));
    assert!(arr[0].get("mobile_token").is_none(), "token must not survive the narrowing");
    assert!(arr[0].get("user_id").is_none());
    assert_eq!(arr[0].as_object().unwrap().len(), 6, "exactly the public six");
    assert!(!rows.to_string().contains("S3CRET"));
}

/// v0.2.4 — the field this projection nearly swallowed.
///
/// The server sent `device_uid`, the schema declared it, the Vue template
/// rendered it — and this WHITELIST silently dropped it, so "same phone"
/// would never once have appeared. Nothing failed; the chip just would not
/// exist. That is the repo's number-one bug class ("a capability defined but never called") arriving
/// through a projection instead of a call site, which is why it gets its own
/// test rather than one more assertion in the case above.
#[test]
fn list_mobiles_carries_the_handset_id_through_the_whitelist() {
    let with_uid = json!({ "mobiles": [{
        "pairing_id": "p1", "mobile_name": "X", "paired_at": "t",
        "device_uid": "mb-0a0b0c0d0e0f0102"
    }] });
    let rows = parse_list_mobiles_ack(&with_uid).unwrap();
    assert_eq!(rows[0]["device_uid"], json!("mb-0a0b0c0d0e0f0102"));

    // A pre-0.2.4 pairing, and an older SERVER that has no such field, both
    // land on NULL — never on "" or a missing key, because the UI's grouping
    // rule keys on "whether there's an answer" and must be able to tell.
    for row in [
        json!({ "pairing_id": "p1", "mobile_name": "X", "paired_at": "t", "device_uid": null }),
        json!({ "pairing_id": "p1", "mobile_name": "X", "paired_at": "t" }),
        json!({ "pairing_id": "p1", "mobile_name": "X", "paired_at": "t", "device_uid": 7 }),
    ] {
        let rows = parse_list_mobiles_ack(&json!({ "mobiles": [row] })).unwrap();
        assert_eq!(rows[0]["device_uid"], Value::Null);
    }
}

#[test]
fn list_mobiles_never_invents_presence_and_fails_loud_on_a_bad_ack() {
    // Missing/garbage `online` reads OFFLINE — never a fabricated green dot.
    let ack = json!({ "mobiles": [{ "pairing_id": "p1", "mobile_name": "X", "paired_at": "t" }] });
    let rows = parse_list_mobiles_ack(&ack).unwrap();
    assert_eq!(rows[0]["online"], json!(false));
    assert_eq!(rows[0]["last_seen_at"], Value::Null);
    // An error ack / malformed shape → None (the page says "unknown", it does
    // not render a confident empty table).
    assert_eq!(parse_list_mobiles_ack(&json!({ "error": "AUTH_TOKEN_INVALID" })), None);
    assert_eq!(parse_list_mobiles_ack(&json!({ "mobiles": "nope" })), None);
    // An empty room is a legitimate answer, distinct from None.
    assert_eq!(parse_list_mobiles_ack(&json!({ "mobiles": [] })), Some(json!([])));
}

/// 0.2.27 — the four `build_history_*` tests are gone with their builders (the
/// server stores no transcripts). What replaces them asserts the ONE property the
/// local reinject depends on and cannot see fail at runtime.
#[test]
fn a_local_reinject_carries_its_text_and_the_dedup_bypass_source() {
    let req = local_reinject_request("补投的正文", "h-42");
    assert_eq!(req.text, "补投的正文", "the OWNER supplies the text now");
    assert_eq!(req.entry_id.as_deref(), Some("h-42"), "A-58 correlation echo");
    // `source` is not cosmetic: `skips_the_inj1_byte_window` reads exactly this
    // string, and if it drifted to a value NOT on that list ("reinject", "local", …) a
    // deliberate re-send of the same row within 1500ms would be SUPPRESSED with no
    // result frame at all — the button would do nothing and say nothing.
    // (⚠️ CORRECTION: this line used to name "manual" as such a drift. It is not one —
    // "manual" is on the same list, so that drift would change the forensic label
    // and nothing else. Anti-façade ④: the example in a justifying comment is itself
    // a claim, and this one was false when written.)
    assert_eq!(req.source, "history");
    // RV-29 — the assertion this comment describes is about the SECOND click, so
    // it now actually performs one. Classifying a single frame against a fresh
    // deduper only ever proved first-sight Proceed, which no reachable defect
    // could have broken; the old bypass ordering passed it too.
    let mut d = crate::socket::dedup::InjectDeduper::default_spec();
    assert_eq!(
        d.classify(&req.source, req.request_id.as_deref(), &req.text, 0),
        crate::socket::InjectDecision::Proceed,
    );
    d.record(
        &req.source,
        req.request_id.as_deref(),
        &req.text,
        &json!({ "ok": true }),
        0,
    );
    assert_eq!(
        d.classify(&req.source, req.request_id.as_deref(), &req.text, 900),
        crate::socket::InjectDecision::Proceed,
        "a second reinject click inside the INJ-1 window must never be deduped away",
    );
    // No request_id: nobody asked for this delivery (see the builder's doc).
    assert_eq!(req.request_id, None);
    // Not an image frame — the picture path is refused at the UI (a picture's
    // stored text is its descriptor, so re-typing it would fabricate a delivery).
    assert!(req.image().is_none() && !req.is_malformed_image());
}

#[test]
fn unwrap_ack_descends_into_the_nested_ack_array() {
    // rust_socketio delivers ack data as [ [obj] ] — one level deeper than
    // an event's [obj]. unwrap_ack must return the object either way.
    let obj = json!({ "token": "t" });
    let nested = vec![json!([obj.clone()])];
    assert_eq!(unwrap_ack(&nested), Some(&obj));
    let flat = vec![obj.clone()];
    assert_eq!(unwrap_ack(&flat), Some(&obj));
    assert_eq!(unwrap_ack(&[]), None);
}

#[test]
fn mobile_id_is_read_from_the_presence_frames() {
    // GA-26: the id the desktop used to throw away.
    let joined = json!({ "mobile_id": "m-7", "mobile_name": "Pixel", "room_uuid": "r" });
    assert_eq!(parse_mobile_id(&joined).as_deref(), Some("m-7"));
    let left = json!({ "mobile_id": "m-7" });
    assert_eq!(parse_mobile_id(&left).as_deref(), Some("m-7"));
    // An unattributable frame yields None — the caller records, never guesses.
    assert_eq!(parse_mobile_id(&json!({})), None);
    assert_eq!(parse_mobile_id(&json!({ "mobile_id": "" })), None);
    assert_eq!(parse_mobile_id(&json!({ "mobile_id": 7 })), None);
}

#[test]
fn connected_mobiles_roster_reports_what_it_had_to_drop() {
    let (ids, dropped) = parse_connected_mobiles(&[json!("a"), json!("b")]);
    assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(dropped, 0);
    // A malformed entry must not silently shrink the roster unnoticed.
    let (ids, dropped) = parse_connected_mobiles(&[json!("a"), json!(3), json!("")]);
    assert_eq!(ids, vec!["a".to_string()]);
    assert_eq!(dropped, 2);
    assert_eq!(parse_connected_mobiles(&[]), (vec![], 0));
}

// ── 0.2.66 PCID (cloud pairing addressing) ───────────────────────────────────

#[test]
fn pcid_is_read_off_a_register_ack() {
    // The positive control for every negative below: without it, a parser that
    // refused EVERY pcid would satisfy the whole rejection table.
    let ack = json!({ "token": "t", "pc_id": "p", "short_code": "4821", "pcid": "302914775" });
    assert_eq!(parse_pcid(&ack).as_deref(), Some("302914775"));
    // Leading zeros are DIGITS, not a number — the value is a string on the wire
    // and re-reading it as an integer would eat them (and change the id).
    assert_eq!(parse_pcid(&json!({ "pcid": "000000001" })).as_deref(), Some("000000001"));
}

#[test]
fn a_pcid_that_is_not_exactly_nine_ascii_digits_is_dropped() {
    // Dropped, never repaired and never shown: this string is read out loud by a
    // human and appended to the cloud QR. "none" is recoverable (the row simply
    // does not render); "there is one, but it can't be addressed" looks like an answer.
    for bad in [
        json!({}),                              // a relay older than this round
        json!({ "pcid": null }),
        json!({ "pcid": "" }),
        json!({ "pcid": "30291477" }),          // eight
        json!({ "pcid": "3029147750" }),        // ten
        json!({ "pcid": "30291477a" }),
        json!({ "pcid": "302 914 775" }),       // the DISPLAY grouping, never the wire form
        json!({ "pcid": "３０２９１４７７５" }), // full-width digits
        json!({ "pcid": 302914775 }),           // a number, not a string
    ] {
        assert!(parse_pcid(&bad).is_none(), "should have been refused: {bad}");
    }
}

#[test]
fn reading_the_pcid_does_not_disturb_the_other_ack_fields() {
    // Additive means additive: the pre-0.2.66 reads answer identically on a frame
    // that now carries a pcid, and `parse_pcid` answers on one that does not.
    let ack = json!({
        "token": "tok", "pc_id": "pc-1", "room_uuid": "room-1",
        "short_code": "4821", "expires_in_ms": 300000, "pcid": "302914775"
    });
    let (t, pc, room) = parse_register_ack(&ack);
    assert_eq!(t.as_deref(), Some("tok"));
    assert_eq!(pc.as_deref(), Some("pc-1"));
    assert_eq!(room.as_deref(), Some("room-1"));
    assert_eq!(parse_expires_in_ms(&ack), Some(300_000));
    let old = json!({ "token": "tok", "pc_id": "pc-1", "room_uuid": "room-1" });
    assert_eq!(parse_register_ack(&old), (Some("tok".into()), Some("pc-1".into()), Some("room-1".into())));
    assert_eq!(parse_pcid(&old), None);
}

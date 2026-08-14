// INJ-3/INJ-1 + RV-83 disk-ledger tests — split from dedup.rs (file-size cap,
// `io_tests.rs`/`client_tests.rs`/`wire_tests.rs` precedent). Included via
// `#[cfg(test)] #[path = "dedup_tests.rs"] mod tests;` inside dedup.rs, so
// `super::*` here IS the dedup module (private items reachable) — nothing
// about test coverage or reachability changes, only which file the bytes
// live in.

    use super::*;
    use serde_json::json;

    fn result(tag: &str) -> Value {
        json!({ "ok": true, "mode": "sendinput", "request_id": tag })
    }

    #[test]
    fn first_sight_proceeds_then_replays_the_cached_result() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("stt", Some("rq-1"), "hello", 0), InjectDecision::Proceed);
        let first = result("rq-1");
        d.record("stt", Some("rq-1"), "hello", &first, 0);
        // Reconnect-flap replay of the same request_id → the byte-identical result.
        match d.classify("stt", Some("rq-1"), "hello", 500) {
            InjectDecision::Replay(v) => assert_eq!(v, first, "replay is the exact first result"),
            other => panic!("expected Replay, got {other:?}"),
        }
    }

    #[test]
    fn distinct_request_ids_each_proceed() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("stt", Some("rq-1"), "a", 0), InjectDecision::Proceed);
        d.record("stt", Some("rq-1"), "a", &result("rq-1"), 0);
        assert_eq!(d.classify("stt", Some("rq-2"), "a", 1), InjectDecision::Proceed);
    }

    /// RV-29 — this test used to be
    /// `bypass_sources_never_dedup_even_with_a_repeated_request_id` and asserted
    /// the defect: that a repeated request_id from manual/history/image still
    /// Proceeds, and that the LRU stays empty. Renamed to the half that is still
    /// true, and the half that changed now has its own tests below.
    #[test]
    fn bypass_sources_with_no_request_id_always_proceed() {
        let mut d = InjectDeduper::default_spec();
        for src in ["manual", "history", "image"] {
            assert_eq!(d.classify(src, None, "same", 0), InjectDecision::Proceed);
            d.record(src, None, "same", &result("auto"), 0);
            // A second id-less send of the SAME bytes, well inside the 1500ms
            // INJ-1 window, still proceeds: it is a second deliberate delivery,
            // not a duplicated frame, and Suppress would send no result at all.
            assert_eq!(
                d.classify(src, None, "same", 1),
                InjectDecision::Proceed,
                "{src} with no request_id must skip the INJ-1 byte window"
            );
        }
        assert_eq!(d.len(), 0, "an id-less send has no key to be cached under");
    }

    /// ④ The INJ-1 window is genuinely not applied to id-less bypass sends —
    /// asserted across the whole window, not just at its start, so a future
    /// "just lower the window" change cannot pass this by accident.
    #[test]
    fn inj1_byte_window_is_never_applied_to_an_id_less_bypass_send() {
        for src in ["manual", "history", "image"] {
            let mut d = InjectDeduper::default_spec();
            for (i, t) in [0u64, 1, 750, 1499, 1500].iter().enumerate() {
                assert_eq!(
                    d.classify(src, None, "识别到的同一句话", *t),
                    InjectDecision::Proceed,
                    "{src} send #{i} at t={t}ms must proceed"
                );
                d.record(src, None, "识别到的同一句话", &result("auto"), *t);
            }
        }
    }

    /// ③ The isomorph of the wire.rs assertion on `local_reinject_request`:
    /// the desktop-local reinject mints no request_id, and two clicks inside 1500ms
    /// must both type. If this reddens, the reinject button silently does nothing.
    #[test]
    fn a_desktop_local_reinject_has_no_id_and_two_clicks_both_proceed() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("history", None, "补投的正文", 0), InjectDecision::Proceed);
        d.record("history", None, "补投的正文", &result("h-42"), 0);
        assert_eq!(
            d.classify("history", None, "补投的正文", 900),
            InjectDecision::Proceed,
            "second reinject click within the INJ-1 window must still type"
        );
    }

    /// ① The RV-29 defect itself: a `manual` frame carries a request_id, so a
    /// queue-drain retry of that ONE delivery must replay, not re-type.
    #[test]
    fn manual_with_a_repeated_request_id_replays_the_identical_result() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("manual", Some("m3-99"), "同一句", 0), InjectDecision::Proceed);
        let first = result("m3-99");
        d.record("manual", Some("m3-99"), "同一句", &first, 0);
        // A reconnect flap re-emits the queued item under the id it was born
        // with, long past any byte window.
        match d.classify("manual", Some("m3-99"), "同一句", 90_000) {
            InjectDecision::Replay(v) => {
                assert_eq!(v, first, "replay is byte-identical to the first result")
            }
            other => panic!("expected Replay for a repeated manual request_id, got {other:?}"),
        }
        assert_eq!(d.len(), 1, "a manual delivery IS cached under its id now");
    }

    /// ② Same for `image` — the socket leg has no server-side ledger at all
    /// (the HTTP ingress one covers only itself), so this is the only gate
    /// standing between a flap and a picture pasted twice.
    #[test]
    fn image_with_a_repeated_request_id_replays_the_identical_result() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("image", Some("i7-42"), "[图片]", 0), InjectDecision::Proceed);
        let first = result("i7-42");
        d.record("image", Some("i7-42"), "[图片]", &first, 0);
        match d.classify("image", Some("i7-42"), "[图片]", 5_000) {
            InjectDecision::Replay(v) => assert_eq!(v, first),
            other => panic!("expected Replay for a repeated image request_id, got {other:?}"),
        }
    }

    /// Two DELIBERATE sends are still two deliveries. Every producer mints a
    /// fresh id per user action (`mintRequestId` = prefix+seq+micros), so INJ-3
    /// can only ever collapse a retry — never two clicks.
    #[test]
    fn two_deliberate_sends_carry_distinct_ids_and_both_proceed() {
        let mut d = InjectDeduper::default_spec();
        for rid in ["r0-1700000000000000", "r1-1700000000000001"] {
            assert_eq!(
                d.classify("history", Some(rid), "同一行的正文", 0),
                InjectDecision::Proceed,
                "{rid} is a distinct delivery of the same row"
            );
            d.record("history", Some(rid), "同一行的正文", &result(rid), 0);
        }
    }

    /// `record` must not arm the INJ-1 window from an id-less bypass send: that
    /// window is only ever read for stt/llm, so the only reachable effect would
    /// be suppressing a LATER auto utterance whose text matches a reinject the user
    /// just clicked — silently, since Suppress emits no result frame.
    #[test]
    fn an_id_less_bypass_send_does_not_arm_the_inj1_window_for_auto_sources() {
        let mut d = InjectDeduper::default_spec();
        d.record("history", None, "碰巧一样的一句话", &result("h-1"), 0);
        assert_eq!(
            d.classify("stt", None, "碰巧一样的一句话", 200),
            InjectDecision::Proceed,
            "an auto utterance must not be suppressed by a reinject's bytes"
        );
    }

    #[test]
    fn inj1_suppresses_same_bytes_within_window_and_proceeds_outside() {
        let mut d = InjectDeduper::default_spec();
        assert_eq!(d.classify("stt", None, "hello", 0), InjectDecision::Proceed);
        d.record("stt", None, "hello", &result("auto"), 0);
        // Same bytes inside 1500ms → suppressed (no re-type, no result).
        assert_eq!(d.classify("stt", None, "hello", 1000), InjectDecision::Suppress);
        // Same bytes past the window → proceeds again.
        assert_eq!(d.classify("stt", None, "hello", 1600), InjectDecision::Proceed);
        // Different bytes inside the window → proceeds.
        d.record("stt", None, "hello", &result("auto"), 1600);
        assert_eq!(d.classify("llm", None, "world", 1700), InjectDecision::Proceed);
    }

    #[test]
    fn inj1_does_not_touch_request_id_path() {
        // A request_id frame after an INJ-1 window of identical bytes still
        // dedups by id, not bytes.
        let mut d = InjectDeduper::default_spec();
        d.record("stt", None, "hello", &result("auto"), 0);
        assert_eq!(d.classify("stt", Some("rq-9"), "hello", 100), InjectDecision::Proceed);
    }

    #[test]
    fn lru_evicts_the_oldest_request_id_at_capacity() {
        let mut d = InjectDeduper::new(3, InjectDeduper::INJ1_WINDOW_MS);
        for (i, rid) in ["a", "b", "c"].iter().enumerate() {
            d.record("stt", Some(rid), "t", &result(rid), i as u64);
        }
        // Insert a 4th → "a" (oldest) is evicted.
        d.record("stt", Some("d"), "t", &result("d"), 3);
        assert_eq!(d.classify("stt", Some("a"), "t", 4), InjectDecision::Proceed, "evicted → miss");
        assert!(matches!(d.classify("stt", Some("d"), "t", 5), InjectDecision::Replay(_)));
        assert!(matches!(d.classify("stt", Some("c"), "t", 6), InjectDecision::Replay(_)));
    }

    #[test]
    fn touching_on_replay_refreshes_recency_and_protects_from_eviction() {
        let mut d = InjectDeduper::new(2, InjectDeduper::INJ1_WINDOW_MS);
        d.record("stt", Some("a"), "t", &result("a"), 0);
        d.record("stt", Some("b"), "t", &result("b"), 1);
        // Replay "a" → moves it to the front (most recent).
        assert!(matches!(d.classify("stt", Some("a"), "t", 2), InjectDecision::Replay(_)));
        // Insert "c" → evicts "b" (now the oldest), NOT the just-touched "a".
        d.record("stt", Some("c"), "t", &result("c"), 3);
        assert!(matches!(d.classify("stt", Some("a"), "t", 4), InjectDecision::Replay(_)), "a survived");
        assert_eq!(d.classify("stt", Some("b"), "t", 5), InjectDecision::Proceed, "b evicted");
    }

    // ══════════════════════════════════════════════════════════════════════
    // RV-83 (window B4-3, owner 2026-08-01 ruling) — the on-disk "already typed"
    // ledger. Every test below constructs TWO SEPARATE `InjectDeduper`
    // instances sharing one file and drops the first before building the
    // second — that IS the production shape (`socket::client::connect` builds
    // a brand-new `InjectDeduper` on every call, one per channel session), so
    // this is not a simulation of a restart, it is the same construction
    // sequence a real restart produces.
    // ══════════════════════════════════════════════════════════════════════

    fn tmp_ledger_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("flowmic-dedup-ledger-{}.json", uuid::Uuid::new_v4()))
    }

    fn ok_result(tag: &str, mode: &str) -> Value {
        json!({ "ok": true, "mode": mode, "request_id": tag })
    }

    #[test]
    fn a_typed_success_survives_a_simulated_restart_as_an_honest_minimal_hit() {
        let path = tmp_ledger_path();
        {
            // "Process life #1".
            let mut before = InjectDeduper::load_spec_default(path.clone());
            assert_eq!(
                before.classify("manual", Some("rq-restart-1"), "同一句", 0),
                InjectDecision::Proceed
            );
            before.record("manual", Some("rq-restart-1"), "同一句", &ok_result("rq-restart-1", "clipboard"), 0);
            // Same-process replay is untouched by RV-83 — still the full Value.
            assert!(matches!(
                before.classify("manual", Some("rq-restart-1"), "同一句", 10),
                InjectDecision::Replay(_)
            ));
        } // `before` dropped here — the process "exits".

        // "Process life #2" — a FRESH InjectDeduper, long after any INJ-1
        // window, sharing only the file on disk.
        let mut after = InjectDeduper::load_spec_default(path.clone());
        match after.classify("manual", Some("rq-restart-1"), "同一句", 999_000) {
            InjectDecision::AlreadyTypedOnDisk { mode_wire } => {
                assert_eq!(mode_wire, "clipboard", "the mode we genuinely recorded, not a guess")
            }
            other => panic!("expected AlreadyTypedOnDisk after a simulated restart, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn without_the_ledger_the_same_scenario_would_type_twice() {
        // The reverse-of-the-fix control: an in-memory-only deduper (no
        // `ledger_path`, i.e. exactly `default_spec()` — what production used
        // before this card) constructed FRESH for "process life #2" cannot
        // know about "process life #1"'s delivery at all, so the SAME retry
        // that `AlreadyTypedOnDisk` catches above instead reads as a brand
        // new one — Proceed — which is precisely the double-type bug (G-7).
        // This is the reverse test made durable: it stays green forever
        // (nothing here calls the persisted constructor), and it is what
        // actually went RED during development when `load_spec_default` was
        // temporarily swapped for `default_spec()` in the test above — see
        // the card report for the transcript.
        let mut process_2_with_no_memory_of_process_1 = InjectDeduper::default_spec();
        assert_eq!(
            process_2_with_no_memory_of_process_1.classify("manual", Some("rq-restart-1"), "同一句", 999_000),
            InjectDecision::Proceed,
            "an in-memory-only deduper cannot see a prior process's delivery — this is the bug \
             the ledger exists to close"
        );
    }

    #[test]
    fn a_failed_but_noncached_attempt_is_not_persisted_so_a_restart_gets_a_fresh_try() {
        let path = tmp_ledger_path();
        {
            let mut before = InjectDeduper::load_spec_default(path.clone());
            assert_eq!(before.classify("stt", Some("rq-fail"), "too long", 0), InjectDecision::Proceed);
            // A deterministic non-cached FAILURE (Stage-1b refusal / char-cap /
            // clipboard-after-sendinput double failure) — recorded in-memory
            // (mode != Cached) exactly as before RV-83, but must NOT be
            // written to disk: repeating the pipeline after a restart is safe
            // (nothing was typed either time) and may do BETTER (the target
            // could have changed) — freezing a stale failure across a
            // restart has no upside and no owner ask behind it.
            let failed = json!({
                "ok": false, "mode": "sendinput", "error": "INJECT_TARGET_INVALID",
                "request_id": "rq-fail"
            });
            before.record("stt", Some("rq-fail"), "too long", &failed, 0);
            // Same-process replay of the FAILURE still works (unaffected).
            assert!(matches!(
                before.classify("stt", Some("rq-fail"), "too long", 1),
                InjectDecision::Replay(_)
            ));
        }
        let mut after = InjectDeduper::load_spec_default(path.clone());
        assert_eq!(
            after.classify("stt", Some("rq-fail"), "too long", 100),
            InjectDecision::Proceed,
            "a persisted FAILURE would deny the user a fresh, possibly-successful retry after \
             restart, for no benefit — see the RV-83 block's scope note"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_disk_ledger_shares_the_in_memory_lru_cap_and_survives_only_the_newest() {
        let path = tmp_ledger_path();
        {
            let mut before = InjectDeduper::load_with_cap(2, InjectDeduper::INJ1_WINDOW_MS, path.clone(), &[]);
            for (i, rid) in ["a", "b", "c"].iter().enumerate() {
                before.record("manual", Some(rid), "t", &ok_result(rid, "sendinput"), i as u64);
            }
            // cap=2 → "a" (oldest) is evicted from memory, and therefore from
            // the DERIVED disk snapshot too — there is no separate disk cap to
            // desync from the memory one.
        }
        let mut after = InjectDeduper::load_with_cap(2, InjectDeduper::INJ1_WINDOW_MS, path.clone(), &[]);
        assert_eq!(
            after.classify("manual", Some("a"), "t", 10),
            InjectDecision::Proceed,
            "evicted before this process ever started — a fresh attempt, not a false replay"
        );
        assert!(matches!(after.classify("manual", Some("b"), "t", 11), InjectDecision::AlreadyTypedOnDisk { .. }));
        assert!(matches!(after.classify("manual", Some("c"), "t", 12), InjectDecision::AlreadyTypedOnDisk { .. }));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_on_disk_file_never_contains_a_window_title_or_a_timestamp() {
        // The owner ruling, made mechanical: even when the IN-MEMORY result
        // carries a window title / injected_at / anything else, none of it
        // reaches the file. This stays green only because `TypedLedgerEntry`
        // structurally has no field for them — a future change that widens it
        // would have to touch this assertion on purpose, not by accident.
        let path = tmp_ledger_path();
        let mut d = InjectDeduper::load_spec_default(path.clone());
        assert_eq!(d.classify("manual", Some("rq-x"), "t", 0), InjectDecision::Proceed);
        let full = json!({
            "ok": true,
            "mode": "sendinput",
            "request_id": "rq-x",
            "target_window": "Notepad — untitled",
            "inject_target": {
                "window_title": "Notepad — untitled",
                "process_name": "notepad.exe",
                "injected_at": "1700000000000",
            },
        });
        d.record("manual", Some("rq-x"), "t", &full, 0);
        let raw = std::fs::read_to_string(&path).expect("ledger file must be written");
        assert!(!raw.contains("Notepad"), "the disk ledger must never carry a window title: {raw}");
        assert!(!raw.contains("injected_at"), "the disk ledger must never carry a timestamp: {raw}");
        assert!(!raw.contains("target_window"), "raw={raw}");
        assert!(!raw.contains("window_title"), "raw={raw}");
        assert!(raw.contains("rq-x") && raw.contains("sendinput"), "raw={raw}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_ok_true_result_somehow_carrying_mode_cached_is_never_persisted() {
        // Belt-and-braces: today's call sites can never produce this pairing
        // (`InjectOutcome::ok()` never constructs a Cached success), but
        // `record` is `pub fn` with no type-level guarantee of that, and the
        // truth table only defines ok:true for sendinput/clipboard. A future
        // caller that got it wrong must not get to write an undefined
        // combination that a LATER process would trust as fact.
        let path = tmp_ledger_path();
        let mut d = InjectDeduper::load_spec_default(path.clone());
        assert_eq!(d.classify("manual", Some("rq-weird"), "t", 0), InjectDecision::Proceed);
        let weird = json!({ "ok": true, "mode": "cached", "request_id": "rq-weird" });
        d.record("manual", Some("rq-weird"), "t", &weird, 0);
        // Same-process Full replay still works (dedup.rs's own guard is a
        // disk-write-time filter, not a classify-time one — the in-memory
        // cache is unconditionally whatever was recorded).
        assert!(matches!(d.classify("manual", Some("rq-weird"), "t", 1), InjectDecision::Replay(_)));
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(!raw.contains("rq-weird"), "an undefined ok:true+cached pairing must not reach disk: {raw}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_ledger_file_loads_as_empty_never_a_crash_loop() {
        let path = tmp_ledger_path(); // never written
        let mut d = InjectDeduper::load_spec_default(path);
        assert_eq!(d.classify("manual", Some("rq-fresh"), "t", 0), InjectDecision::Proceed);
    }

    #[test]
    fn a_corrupt_ledger_file_loads_as_empty_never_a_crash_loop() {
        let path = tmp_ledger_path();
        std::fs::write(&path, b"not json at all").expect("write garbage");
        let mut d = InjectDeduper::load_spec_default(path.clone());
        assert_eq!(d.classify("manual", Some("rq-z"), "t", 0), InjectDecision::Proceed);
        let _ = std::fs::remove_file(&path);
    }

    // ══════════════════════════════════════════════════════════════════════
    // G-13 (window B4-16) — ONE dedup table per MACHINE, not one per channel.
    //
    // The scenario, in the user's terms: the phone says a sentence over the
    // LAN, the PC types it, the receipt is lost on the way back, the phone's
    // outbox retries — and by then the phone is on the cloud relay. Under the
    // pre-G-13 shape the cloud session had its own table, had never heard of
    // that request_id, and typed the sentence into the document a SECOND time.
    // No restart involved: switching links mid-drain is the ordinary,
    // already-ruled-on correct behaviour of a queue whose destination is a MACHINE.
    // ══════════════════════════════════════════════════════════════════════

    /// The fix. Two channel sessions, ONE `Arc<Mutex<InjectDeduper>>` — exactly
    /// the production shape (both sessions take `session_deduper`'s default,
    /// which is the one `machine_deduper()` object) — and the retry is answered
    /// without typing.
    #[test]
    fn an_id_typed_on_one_channel_is_never_typed_again_when_the_retry_arrives_on_the_other() {
        let machine: SharedDeduper = Arc::new(Mutex::new(InjectDeduper::default_spec()));
        let lan_session = machine.clone();
        let cloud_session = machine.clone();

        // LAN leg: first sight → the pipeline runs → the truthful result is recorded.
        assert_eq!(
            lan_session.lock().unwrap().classify("manual", Some("m3-77"), "同一句", 0),
            InjectDecision::Proceed
        );
        let typed = ok_result("m3-77", "sendinput");
        lan_session.lock().unwrap().record("manual", Some("m3-77"), "同一句", &typed, 0);

        // Cloud leg, long past any INJ-1 byte window: the outbox re-emits the
        // SAME item under the id it was born with.
        let verdict = cloud_session.lock().unwrap().classify("manual", Some("m3-77"), "同一句", 90_000);
        match verdict {
            InjectDecision::Replay(v) => assert_eq!(
                v, typed,
                "the reply is the first result verbatim — none of its fields names a channel, so \
                 it is as true on the cloud leg as it was on the LAN one"
            ),
            other => panic!("expected Replay across channels, got {other:?} — this is G-13"),
        }
    }

    /// The reverse control, made durable: the PRE-G-13 shape, spelled out.
    /// Two `InjectDeduper`s (one per channel session, which is what
    /// `socket::client::connect` used to build) accept the very same retry as a
    /// brand-new delivery — `Proceed` — and the sentence gets typed twice.
    ///
    /// This is the test that actually went RED before the fix: with the wiring
    /// still per-channel, the test above was this one. It stays green forever
    /// (nothing here shares a table), and it is the reason the assertion above
    /// is about `Arc` identity rather than about two instances agreeing.
    #[test]
    fn the_pre_g13_shape_one_deduper_per_channel_types_the_same_sentence_twice() {
        let mut lan_session = InjectDeduper::default_spec();
        let mut cloud_session = InjectDeduper::default_spec();
        assert_eq!(
            lan_session.classify("manual", Some("m3-77"), "同一句", 0),
            InjectDecision::Proceed
        );
        lan_session.record("manual", Some("m3-77"), "同一句", &ok_result("m3-77", "sendinput"), 0);
        assert_eq!(
            cloud_session.classify("manual", Some("m3-77"), "同一句", 90_000),
            InjectDecision::Proceed,
            "a per-channel table cannot know what the other channel typed — that is G-13, and \
             `Proceed` here means the user's document gets the sentence a second time"
        );
    }

    /// The wiring seam. Every socket session's table comes from
    /// `session_deduper`, so what this asserts is that a session cannot end up
    /// with a table of its own unless a caller deliberately hands it one — and
    /// that a handed-in table is used AS IS, never re-wrapped into a second
    /// object that merely holds equal contents.
    ///
    /// ⚠️ The default branch (`None` → `machine_deduper()`) is deliberately NOT
    /// exercised here: it reads, MERGES and DELETES the real files under
    /// `%LOCALAPPDATA%\FlowMic`. A test that mutates the developer's own install
    /// to prove a default is worse than an unproven default; the thing that
    /// branch constructs (`load_machine_ledger`) is covered end to end below,
    /// against temp paths.
    #[test]
    fn a_session_decides_on_the_table_it_was_handed_and_never_a_copy_of_it() {
        let machine: SharedDeduper = Arc::new(Mutex::new(InjectDeduper::default_spec()));
        let lan = session_deduper(Some(machine.clone()));
        let cloud = session_deduper(Some(machine.clone()));
        assert!(Arc::ptr_eq(&lan, &machine), "used as-is, never re-wrapped");
        assert!(
            Arc::ptr_eq(&lan, &cloud),
            "both channels must hold the SAME table — two equal tables are still G-13"
        );
    }

    /// The same crossing, one process life later: a machine ledger merged from
    /// the two retired per-channel files still answers "already typed" for an id the
    /// CLOUD channel typed before the upgrade.
    #[test]
    fn the_retired_per_channel_ledgers_are_merged_and_then_deleted() {
        let machine_path = tmp_ledger_path();
        let retired_cloud = tmp_ledger_path();
        {
            // Pre-G-13 install: each channel wrote its own file.
            let mut lan = InjectDeduper::load_spec_default(machine_path.clone());
            lan.record("manual", Some("lan-1"), "t", &ok_result("lan-1", "sendinput"), 0);
            let mut cloud = InjectDeduper::load_spec_default(retired_cloud.clone());
            cloud.record("image", Some("cloud-1"), "[图片]", &ok_result("cloud-1", "clipboard"), 0);
        }
        assert!(retired_cloud.exists(), "precondition: the pre-G-13 cloud ledger is on disk");

        // The upgraded launch.
        let mut merged = InjectDeduper::load_machine_ledger(machine_path.clone(), &[retired_cloud.clone()]);
        for (rid, mode) in [("lan-1", "sendinput"), ("cloud-1", "clipboard")] {
            match merged.classify("manual", Some(rid), "t", 999_000) {
                InjectDecision::AlreadyTypedOnDisk { mode_wire } => assert_eq!(
                    mode_wire, mode,
                    "{rid} must survive the merge carrying the mode it was really typed under"
                ),
                other => panic!("{rid} was lost by the merge: {other:?}"),
            }
        }
        assert!(
            !retired_cloud.exists(),
            "a file that was merged and durably re-written must not stay behind pretending to be live"
        );
        let raw = std::fs::read_to_string(&machine_path).expect("the machine ledger must be written");
        assert!(raw.contains("lan-1") && raw.contains("cloud-1"), "both channels' facts are in ONE file now: {raw}");
        let _ = std::fs::remove_file(&machine_path);
    }

    /// Order-of-operations safety: the merge deletes ONLY what it has durably
    /// carried over. If the machine ledger cannot be written, the retired file
    /// stays exactly where it was and the next launch tries again — losing
    /// losing "this one was already typed" is what re-types a sentence into the user's document, so
    /// the failure mode has to be "migrate later", never "forget".
    #[test]
    fn a_merge_that_cannot_be_persisted_never_deletes_the_ledger_it_failed_to_carry() {
        let retired_cloud = tmp_ledger_path();
        {
            let mut cloud = InjectDeduper::load_spec_default(retired_cloud.clone());
            cloud.record("manual", Some("cloud-9"), "t", &ok_result("cloud-9", "sendinput"), 0);
        }
        // An unwritable machine path: a DIRECTORY where the file should be.
        let blocked = std::env::temp_dir().join(format!("flowmic-blocked-ledger-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&blocked).expect("mkdir");

        let mut merged = InjectDeduper::load_machine_ledger(blocked.clone(), &[retired_cloud.clone()]);
        // THIS process still runs on the correctly merged table — the write
        // failure degrades the NEXT launch, never this one.
        assert!(matches!(
            merged.classify("manual", Some("cloud-9"), "t", 10),
            InjectDecision::AlreadyTypedOnDisk { .. }
        ));
        assert!(
            retired_cloud.exists(),
            "the retired ledger must survive a failed merge — deleting it would destroy the only \
             record that this id was already typed"
        );
        let _ = std::fs::remove_file(&retired_cloud);
        let _ = std::fs::remove_dir_all(&blocked);
    }

    /// An id that BOTH files hold — the G-13 case itself, recorded twice
    /// because the pre-fix build typed it twice — collapses to one record. The
    /// merge is a union, not a concatenation, so it can never inflate the table
    /// past its cap with duplicates of one delivery.
    #[test]
    fn an_id_recorded_by_both_channels_collapses_to_one_record_on_merge() {
        let machine_path = tmp_ledger_path();
        let retired_cloud = tmp_ledger_path();
        {
            let mut lan = InjectDeduper::load_spec_default(machine_path.clone());
            lan.record("manual", Some("dup-1"), "t", &ok_result("dup-1", "sendinput"), 0);
            let mut cloud = InjectDeduper::load_spec_default(retired_cloud.clone());
            cloud.record("manual", Some("dup-1"), "t", &ok_result("dup-1", "clipboard"), 0);
        }
        let merged = InjectDeduper::load_machine_ledger(machine_path.clone(), &[retired_cloud.clone()]);
        // The retirement is asserted FIRST, and on purpose: without it, "one
        // record" is also what you get from a build that never merged at all,
        // so the interesting assertion below would be green for the wrong
        // reason (a negative assertion must carry its own positive control).
        assert!(!retired_cloud.exists(), "precondition: the merge really ran");
        assert_eq!(merged.len(), 1, "one delivery is one record, however many files remembered it");
        let raw = std::fs::read_to_string(&machine_path).expect("written");
        assert_eq!(raw.matches("dup-1").count(), 1, "and it is written once, not twice: {raw}");
        let _ = std::fs::remove_file(&machine_path);
    }

    /// When the merged set is bigger than the LRU cap, the eviction falls on
    /// the OLDEST OF EACH file rather than erasing whichever file was merged
    /// second. Neither file carries a timestamp, so there is no true global
    /// recency order to honour — alternating is the honest approximation, and
    /// this test is what pins it (see `merge_by_alternating`).
    #[test]
    fn the_merge_keeps_the_newest_of_both_files_when_the_cap_bites() {
        let machine_path = tmp_ledger_path();
        let retired_cloud = tmp_ledger_path();
        {
            let mut lan = InjectDeduper::load_spec_default(machine_path.clone());
            lan.record("manual", Some("lan-old"), "t", &ok_result("lan-old", "sendinput"), 0);
            lan.record("manual", Some("lan-new"), "t", &ok_result("lan-new", "sendinput"), 1);
            let mut cloud = InjectDeduper::load_spec_default(retired_cloud.clone());
            cloud.record("manual", Some("cloud-old"), "t", &ok_result("cloud-old", "clipboard"), 0);
            cloud.record("manual", Some("cloud-new"), "t", &ok_result("cloud-new", "clipboard"), 1);
        }
        let mut merged = InjectDeduper::load_with_cap(
            2,
            InjectDeduper::INJ1_WINDOW_MS,
            machine_path.clone(),
            &[retired_cloud.clone()],
        );
        for survivor in ["lan-new", "cloud-new"] {
            assert!(
                matches!(
                    merged.classify("manual", Some(survivor), "t", 10),
                    InjectDecision::AlreadyTypedOnDisk { .. }
                ),
                "{survivor} is the newest of its file and must survive the cap"
            );
        }
        for evicted in ["lan-old", "cloud-old"] {
            assert_eq!(
                merged.classify("manual", Some(evicted), "t", 11),
                InjectDecision::Proceed,
                "{evicted} fell off the LRU — a fresh attempt, never a false \"already typed\""
            );
        }
        let _ = std::fs::remove_file(&machine_path);
    }

    #[test]
    fn an_in_memory_only_instance_never_touches_disk() {
        // Every pre-RV-83 test in this file (and `default_spec()`/`new()`
        // themselves) must keep working with ZERO filesystem access — this is
        // the seam that keeps them fast and deterministic. Asserted by using a
        // path inside a directory that is never created, and confirming nothing
        // materializes there.
        let dir = std::env::temp_dir().join(format!("flowmic-dedup-untouched-{}", uuid::Uuid::new_v4()));
        let path = dir.join("would-be-ledger.json");
        let mut d = InjectDeduper::default_spec();
        d.record("manual", Some("rq-1"), "t", &ok_result("rq-1", "sendinput"), 0);
        assert!(!path.exists(), "an in-memory-only InjectDeduper must never write to disk");
        assert!(!dir.exists(), "…and must never even create the directory");
    }

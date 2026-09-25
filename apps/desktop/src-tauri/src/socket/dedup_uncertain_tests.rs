// L-7: separate process writes the production ledger, then a fresh reader must
// distinguish uncertain submission from success and from permission to retry.
use super::*;
use serde_json::json;

#[test]
fn uncertainty_expiry_is_persisted_and_forensic_is_read_from_disk() {
    const TEST: &str = "socket::dedup::uncertain_tests::uncertainty_expiry_is_persisted_and_forensic_is_read_from_disk";
    if let Some(path) = std::env::var_os("FLOWMIC_EXPIRY_LEDGER_CHILD") {
        crate::forensic::init_default();
        let mut ledger = InjectDeduper::load_spec_default(path.into());
        let now = uncertainty::wall_now_ms();
        let old = now - uncertainty::MAX_AGE_MS - 1;
        ledger.record("manual", Some("expired-request"), "private text",
            &json!({"ok": false, "mode": "clipboard", "error": crate::error_codes::INJECT_SUBMISSION_UNCERTAIN}), old);
        assert_eq!(ledger.classify("manual", Some("expired-request"), "private text", now), InjectDecision::Proceed);
        assert!(ledger.uncertain.is_empty());
        assert!(ledger.derive_ledger_file().entries.is_empty());
        return;
    }
    let base = std::env::temp_dir().join(format!("flowmic-expiry-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let ledger = base.join("ledger.json");
    let log = base.join("forensic.log");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env("FLOWMIC_EXPIRY_LEDGER_CHILD", &ledger)
        .env("FLOWMIC_FORENSIC_PATH", &log).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    let logged = std::fs::read_to_string(&log).unwrap();
    assert!(logged.contains("uncertain-evicted request_id=\"expired-request\""), "{logged}");
    assert!(logged.contains("reason=age"), "{logged}");
    assert!(!std::fs::read_to_string(&ledger).unwrap().contains("expired-request"));
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn uncertain_capacity_evicts_oldest_without_blocking_new_requests() {
    let mut ledger = InjectDeduper::default_spec();
    for i in 0..=uncertainty::CAP {
        ledger.record("manual", Some(&format!("capacity-{i}")), "text",
            &json!({"ok": false, "mode": "clipboard", "error": crate::error_codes::INJECT_SUBMISSION_UNCERTAIN}), i as u64);
    }
    assert_eq!(ledger.uncertain.len(), uncertainty::CAP);
    assert!(!ledger.uncertain.contains_key("capacity-0"));
    assert_eq!(ledger.classify("manual", Some("fresh"), "text", 1_000), InjectDecision::Proceed);
}

#[test]
fn uncertain_submission_survives_process_restart_without_success_claim() {
    const TEST: &str = "socket::dedup::uncertain_tests::uncertain_submission_survives_process_restart_without_success_claim";
    if let Some(path) = std::env::var_os("FLOWMIC_UNCERTAIN_LEDGER_CHILD") {
        let mut writer = InjectDeduper::load_spec_default(path.into());
        writer.record("manual", Some("rq-uncertain"), "private text", &json!({
            "ok": false, "mode": "clipboard", "error": crate::error_codes::INJECT_SUBMISSION_UNCERTAIN,
            "target_window": "private title", "injected_at": "private time",
        }), uncertainty::wall_now_ms());
        // Old phones can retry under the original id after arbitrarily many
        // other deliveries. Success-cache churn must never release uncertainty.
        for index in 0..=InjectDeduper::LRU_CAP {
            writer.record("manual", Some(&format!("churn-{index}")), "other",
                &json!({"ok": true, "mode": "sendinput"}), index as u64 + 2);
        }
        assert!(matches!(writer.classify("manual", Some("rq-uncertain"), "private text", 900_000),
            InjectDecision::SubmissionUncertainRemembered { .. }));
        return;
    }
    let path = std::env::temp_dir().join(format!("flowmic-uncertain-{}.json", uuid::Uuid::new_v4()));
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args(["--exact", TEST, "--nocapture"]).env("FLOWMIC_UNCERTAIN_LEDGER_CHILD", &path);
    #[cfg(all(windows, test))]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x08000000);
    }
    assert!(child.status().unwrap().success(), "writer process must really run");
    let mut reader = InjectDeduper::load_spec_default(path.clone());
    assert_eq!(reader.classify("manual", Some("rq-uncertain"), "private text", 900_000),
        InjectDecision::SubmissionUncertainRemembered { mode_wire: "clipboard".into() });
    // A new deliberate request remains possible; the replay key names one act.
    assert_eq!(reader.classify("manual", Some("rq-new-action"), "private text", 900_001), InjectDecision::Proceed);
    // Re-saving a loaded uncertain entry must not silently convert it to typed.
    reader.record("manual", Some("rq-success"), "other", &json!({"ok": true, "mode": "sendinput"}), 900_002);
    let mut again = InjectDeduper::load_spec_default(path.clone());
    assert!(matches!(again.classify("manual", Some("rq-uncertain"), "private text", 1_000_000),
        InjectDecision::SubmissionUncertainRemembered { .. }));
    assert!(matches!(again.classify("manual", Some("rq-success"), "other", 1_000_001),
        InjectDecision::AlreadyTypedOnDisk { .. }));
    let request = crate::socket::wire::InjectRequest {
        text: "private text".into(), source: "manual".into(),
        request_id: Some("rq-uncertain".into()), entry_id: Some("current-entry".into()),
        ..Default::default()
    };
    let fsm = Mutex::new(crate::focus::FocusStateMachine::new(1_000));
    let reply = crate::socket::inject_ops::run_inject(&request, &Some(vec![]), &fsm,
        &Mutex::new(None), &Mutex::new(again), crate::socket::inject_ops::TargetIntent::LiveForeground).unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], crate::error_codes::INJECT_SUBMISSION_UNCERTAIN);
    assert_eq!(reply["request_id"], "rq-uncertain");
    assert_eq!(reply["entry_id"], "current-entry");
    for forbidden in ["inject_target", "target_window", "focus_window", "injected_at"] {
        assert!(reply.get(forbidden).is_none(), "restart invented {forbidden}: {reply}");
    }
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("submission_uncertain"));
    assert!(!raw.contains("private"), "ledger must not preserve text/target/time: {raw}");
    std::fs::remove_file(path).unwrap();
}

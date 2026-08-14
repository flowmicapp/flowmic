// D5 — end-to-end: a worker-thread panic lands in the forensic log.
//
// An INTEGRATION test on purpose: the forensic sink and the panic hook are both
// process-wide singletons (OnceLock / std::panic::set_hook), so this must own
// its process — which a tests/ binary does — rather than race the unit-test
// runner's shared state. Headless by nature; what it proves is the entire D5
// mechanism short of a real production crash: hook installed once → a NAMED
// worker thread panics → the log carries thread name, location, message and a
// backtrace, and the default unwind behavior survives (the JoinHandle really
// reports Err).

use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn a_worker_thread_panic_is_written_to_the_forensic_log() {
    // Redirect the sink BEFORE init (FLOWMIC_FORENSIC_PATH is the documented
    // test override in forensic::resolve_path). Set in this process only.
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("flowmic-panic-forensics-{stamp}.log"));
    std::env::set_var("FLOWMIC_FORENSIC_PATH", &path);

    flowmic_desktop_lib::forensic::init_default();
    assert!(flowmic_desktop_lib::forensic::is_ready(), "sink must be up for this test to mean anything");
    flowmic_desktop_lib::forensic::install_panic_hook();

    // The D5 scenario: a named worker thread dies mid-flight.
    let worker = std::thread::Builder::new()
        .name("doomed-worker".into())
        .spawn(|| panic!("d5 probe panic: worker went down"))
        .expect("spawn");

    // Default behavior preserved — the panic still unwinds into the join error
    // (the hook observed it, it did not swallow it).
    assert!(worker.join().is_err(), "the panic must still propagate to join()");

    let body = std::fs::read_to_string(&path).expect("forensic log must exist");
    assert!(body.contains("[panic]"), "panic entries carry the panic domain tag:\n{body}");
    assert!(body.contains("thread 'doomed-worker' panicked at"), "thread name + std-shaped header:\n{body}");
    assert!(body.contains("tests\\panic_forensics.rs") || body.contains("tests/panic_forensics.rs"),
        "the panic LOCATION (this file) must be in the report:\n{body}");
    assert!(body.contains("d5 probe panic: worker went down"), "the message must be in the report:\n{body}");
    assert!(body.contains("backtrace:"), "a backtrace section must be present:\n{body}");

    let _ = std::fs::remove_file(&path);
}

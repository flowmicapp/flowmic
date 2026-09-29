use super::*;

/// ⚠️ CORRECTED IN PLACE (2026-09-02, B2-Z): used to join `tag` alone onto
/// `temp_dir()`, so every call with the same tag named the same file. The
/// Mac-side run (commit 7d9a775c) reported
/// `second_acquire_is_refused_while_the_first_is_held` failing once
/// "under parallel test execution" and passing with `--test-threads=1`:
/// two feature-gated `cargo test --lib` invocations running concurrently
/// as separate OS processes both open `flowmic-si-test-second.lock` — a
/// real flock conflict between two unrelated runs, not a code bug.
/// `std::process::id()` + a per-process counter makes every path unique —
/// isolation, not a widened timing window.
fn temp_lock(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static CALLS: AtomicU32 = AtomicU32::new(0);
    let n = CALLS.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "flowmic-si-test-{tag}-{}-{n}.lock",
        std::process::id()
    ))
}

#[test]
fn first_acquire_succeeds() {
    let p = temp_lock("first");
    let _ = std::fs::remove_file(&p);
    let lock = acquire(&p);
    assert!(lock.is_some(), "the first instance must acquire the lock");
    assert_eq!(lock.as_ref().unwrap().path(), Some(p.as_path()));
}

/// 🔴 REGRESSION TEST for the `temp_lock` fix above, not for `acquire`
/// itself. Before the fix, two calls with the SAME tag returned the SAME
/// path — harmless within one test binary (each test used a distinct
/// tag), but a real collision the moment two OS processes running this
/// suite concurrently (two feature-gated `cargo test` invocations) both
/// called `temp_lock("second")`. This asserts the property directly
/// rather than only through the flaky-under-concurrency symptom, which a
/// single-process run cannot reproduce on demand.
#[test]
fn temp_lock_is_unique_even_for_the_same_tag() {
    let a = temp_lock("dup");
    let b = temp_lock("dup");
    assert_ne!(a, b, "two calls with the same tag must not name the same file");
}

// ── the identity is no longer a path ────────────────────────────────────

/// 🔴 THE CARD, ASSERTED AS A PROPERTY RATHER THAN AS A STRING. A test that
/// only said「the mutex name is X」would still have been green on the broken
/// design, because the broken design ALSO had a stable name — it just had a
/// stable name per `%APPDATA%`. The criterion has to be「the identity does
/// not contain any path the environment can move」, which means checking it.
#[test]
fn the_instance_identity_contains_no_environment_derived_path() {
    let scope = resolve_scope(None, 41879, 41879).expect("the ordinary launch always resolves");
    assert_eq!(scope.tag, None);
    assert_eq!(scope.mutex_name, SINGLE_INSTANCE_MUTEX);
    // The two env vars whose redirection produced the reported hazard, plus
    // the two nearest neighbours somebody would reach for next.
    for var in ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP", "HOME"] {
        if let Ok(val) = std::env::var(var) {
            if val.len() < 3 {
                continue; // a degenerate value would match everything
            }
            assert!(
                !scope.mutex_name.contains(&val),
                "the instance identity embeds %{var}% — redirecting it forks the identity, which is the whole defect"
            );
        }
    }
    // …and it must still be scoped to the logon session, not machine-wide:
    // `Global\` would make one user's FlowMic refuse another user's.
    assert!(scope.mutex_name.starts_with("Local\\"), "{}", scope.mutex_name);
    assert!(scope.summon_event_name.starts_with("Local\\"), "{}", scope.summon_event_name);
}

/// The escape hatch, and the coupling that makes it safe. Both halves are
/// asserted, because the dangerous configuration is the one that LOOKS
/// isolated: a second identity sharing the first one's port.
#[test]
fn a_second_instance_is_possible_only_when_it_is_asked_for_and_given_its_own_port() {
    // Asked for + own port → granted, with every channel name separated.
    let dev = resolve_scope(Some("dev"), 41880, 41879).expect("a tagged scope on its own port is legitimate");
    assert_eq!(dev.tag.as_deref(), Some("dev"));
    let plain = resolve_scope(None, 41879, 41879).unwrap();
    assert_ne!(dev.mutex_name, plain.mutex_name, "the two instances must not refuse each other");
    assert_ne!(
        dev.summon_event_name, plain.summon_event_name,
        "a tagged instance's second launch must not raise the ordinary instance's window"
    );
    assert_ne!(dev.mutex_name, dev.summon_event_name);
    // The lock-file name is separated too, for the platforms that still use one.
    assert_ne!(default_lock_path(Some("dev")), default_lock_path(None));

    // Asked for WITHOUT its own port → refused. This is the assertion that
    // encodes「the port is what makes it safe」.
    let err = resolve_scope(Some("dev"), 41879, 41879).unwrap_err();
    assert_eq!(err, ScopeError::TagWithoutOwnPort { tag: "dev".to_string(), port: 41879 });
    let msg = err.to_string();
    assert!(msg.contains(crate::sidecar::io::SIDECAR_PORT_ENV), "the refusal must name the way out: {msg}");
    assert!(msg.contains("taskkill"), "the refusal must say what it is preventing: {msg}");
}

/// A tag is a kernel object name fragment, not free text. `\` is the
/// namespace separator — a tag containing one would not name a different
/// object, it would name an object in a different NAMESPACE, which is a
/// silent way to lose the exclusion entirely.
#[test]
fn an_unusable_tag_is_refused_by_name_rather_than_sanitised() {
    assert_eq!(resolve_scope(Some(""), 41880, 41879), Err(ScopeError::EmptyTag));
    assert_eq!(resolve_scope(Some("   "), 41880, 41879), Err(ScopeError::EmptyTag));
    for bad in ["a\\b", "a/b", "Global\\x", "a b", "ünïcode", &"x".repeat(33)] {
        let got = resolve_scope(Some(bad), 41880, 41879);
        assert!(matches!(got, Err(ScopeError::IllegalTag(_))), "{bad:?} → {got:?}");
    }
    for ok in ["dev", "DEV-2", "lane_3", "a", &"x".repeat(32)] {
        assert!(resolve_scope(Some(ok), 41880, 41879).is_ok(), "{ok:?} should be usable");
    }
}

/// The Windows identity really excludes — same shape as the file-lock test
/// right above, on the mechanism that replaced it. A unique per-process name
/// so concurrent test runs cannot cross-claim.
#[cfg(windows)]
#[test]
fn the_named_mutex_refuses_a_second_claim_and_frees_on_drop() {
    let scope = InstanceScope {
        tag: Some("test".to_string()),
        mutex_name: format!("Local\\FlowMic.SingleInstanceTest.{}", std::process::id()),
        summon_event_name: format!("Local\\FlowMic.SummonTest.{}", std::process::id()),
    };
    let first = acquire_instance(&scope).expect("the first claim must succeed");
    assert!(first.describe().contains("named mutex"), "{}", first.describe());
    assert_eq!(first.path(), None, "a named object has no path to report");
    assert!(acquire_instance(&scope).is_none(), "a second claim must be refused");
    drop(first);
    // …and the identity is reusable once the holder is gone — the property a
    // pidfile cannot offer after a crash, carried over from the file lock.
    assert!(acquire_instance(&scope).is_some(), "the identity must free on release");
}

/// 🔴 MAC-07 —— **this test used to carry `#[cfg(windows)]`, and that gate was
/// itself the shape of the defect**:
/// it is not that 「this property is only required on Windows」, but that
/// 「the non-Windows implementation always acquires,
/// so this would go red the moment the gate was lifted」. ⇒ **the gate was
/// removed, meaning this property now holds on every platform**,
/// and the first time it ran on mac WAS the MAC-07 evidence itself.
/// (flock is bound to the open file description, and two independent `open`
/// calls are two different fds ⇒ a real
/// conflict happens even within the same process, so this test can catch real
/// mutual exclusion without forking a child process.)
///
/// ⚠️ ISOLATED IN ITS OWN PROCESS (2026-09-27). The B2-Z fix above made the
/// path unique, but the test still failed 3 of 20 full `cargo test --lib`
/// runs on the Mac (0.3.96 round). The remaining mechanism is inside ONE
/// process, and no path can isolate it: while another test thread is
/// spawning a child (the self re-exec tests in `dedup_uncertain_tests.rs`,
/// the macOS-only `the_name_half_prefers_the_users_own_name_over_the_network_hostname`
/// in `pc_name_tests.rs`, which runs `scutil`), that child briefly holds a
/// duplicate of every fd in this process, including this lock's. An flock
/// belongs to the open file description, so after `drop(first)` the lock stays held until the
/// child execs and its close-on-exec copy goes away. The final
/// "reusable after release" assertion then runs inside that window and
/// fails. Measured on the Mac (probe outside the repo, same open + try_lock
/// as `open_exclusive`): 0 of 20,000 re-acquires refused with no spawner
/// thread, 176 of 20,000 iterations with one thread running `/usr/bin/true`
/// in a loop.
/// This is not a product defect: a long-lived child spawned while the lock
/// was held (`/bin/sleep 2`) did not keep it, and lsof showed no lock fd in
/// that child, because Rust opens files close-on-exec. Only the
/// fork-to-exec window holds a copy. That is also why `--test-threads=1`
/// "fixed" it in the B2-Z report.
/// So the body runs in a child copy of this test binary that runs this one
/// test on one thread, where nothing else can be spawning.
#[test]
fn second_acquire_is_refused_while_the_first_is_held() {
    const TEST: &str = "single_instance::tests::second_acquire_is_refused_while_the_first_is_held";
    const CHILD_ENV: &str = "FLOWMIC_SINGLE_INSTANCE_ISOLATED_CHILD";
    // Printed by the child body. If the parent does not see it, the child
    // ran zero tests (a mistyped `--exact` name exits 0), which would be a
    // silent pass.
    const BODY_RAN: &str = "single-instance-isolated-body-ran";
    if std::env::var_os(CHILD_ENV).is_none() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args(["--exact", TEST, "--nocapture", "--test-threads=1"]).env(CHILD_ENV, "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = child.output().expect("the isolated child must start");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "the isolated run failed:\n{stdout}\n{stderr}");
        assert!(
            stdout.contains(BODY_RAN),
            "the isolated child exited 0 without running the body:\n{stdout}\n{stderr}"
        );
        return;
    }
    let p = temp_lock("second");
    let _ = std::fs::remove_file(&p);
    let first = acquire(&p).expect("first acquires");
    assert!(acquire(&p).is_none(), "a second instance must be refused");
    drop(first);
    // …and once the holder is gone the lock is free again — the property a
    // pidfile cannot offer after a crash.
    assert!(acquire(&p).is_some(), "the lock must be reusable after release");
    let _ = std::fs::remove_file(&p);
    println!("{BODY_RAN}");
}

/// U10 — the whole headless-testable half of the card: signal → listener →
/// callback. A unique per-process event name so parallel/concurrent test
/// runs cannot cross-signal; production uses the fixed SUMMON_EVENT_NAME on
/// both sides (lib.rs run(): refused branch signals, setup branch listens).
/// What this cannot prove headlessly: that `show_main_window` visibly
/// surfaces the window — that is real-machine-only and reported as such.
#[cfg(windows)]
#[test]
fn a_second_launch_signal_reaches_the_running_instances_listener() {
    use std::sync::mpsc;
    use std::time::Duration;

    let name = format!("Local\\FlowMic.SummonTest.{}", std::process::id());

    // Order matters and is the production order reversed first: with NO
    // listener yet, signaling must answer false (that is the honest branch
    // the refused instance records as「NO LISTENER FOUND」).
    assert!(
        !signal_summon_event(&name),
        "signaling with no listener must report failure, not fake a summon"
    );

    let (tx, rx) = mpsc::channel::<()>();
    assert!(
        spawn_summon_listener_named(&name, move || {
            let _ = tx.send(());
        }),
        "the running instance's listener must come up"
    );

    // The second launch's click.
    assert!(signal_summon_event(&name), "the second launch must find the event");
    rx.recv_timeout(Duration::from_secs(5))
        .expect("the summon callback must fire — this is U10's entire mechanism");

    // Auto-reset: a THIRD launch summons again (each click = one surface).
    assert!(signal_summon_event(&name));
    rx.recv_timeout(Duration::from_secs(5))
        .expect("every subsequent second-launch must summon again");
}

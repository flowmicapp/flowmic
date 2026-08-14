// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §10 (forensics — the real-machine case-cracking lifeline)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §4 R11
//   CLAUDE.md red line: no silent failures
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
//
// A long-running instance went away and the log could not say HOW.
//
// Every path that tears this process (or its sidecar child) down converged on
// ONE forensic sentence — `[sidecar] child terminated (exit / retry)` — written
// by `shell::sidecar_ctl::SidecarState::kill_child`, which is called from three
// callers that mean three completely different things:
//   • the app is exiting            (`RunEvent::Exit` in lib.rs `run()`)
//   • the user pressed Retry        (`shell::sidecar_ctl::sidecar_retry`)
//   • the supervisor is restarting  (`shell::sidecar_ctl::spawn_health_supervisor`)
// Three stories, one sentence. Reading the log answered「it exited」and stopped.
//
// That is the doc-15 R11 shape in miniature: the layer WRITING the sentence did
// not hold the fact its sentence depended on. The fix is to hand it that fact,
// not to reword the sentence — so the intent is DECLARED by whoever forms it,
// latched here, and read back where the line is written.
//
// ── WHAT THIS MODULE CAN AND CANNOT KNOW (stated, not guessed) ───────────────
//
//   • It knows what an in-process quit path declared before calling `app.exit`.
//     That is a fact we own and it is cheap.
//   • It CANNOT distinguish「the OS is ending the logon session」from「someone
//     ran taskkill /F」from「the event loop ended for a reason nobody
//     declared」. A hard kill runs no Rust at all, and Tauri's exit event
//     carries no originator. Windows *does* deliver WM_QUERYENDSESSION, but
//     nothing in this app subscribes to it today, so we hold no such fact.
//     ⇒ All of those land in ONE honestly-named bucket (`Undeclared`) whose
//     sentence says which possibilities it covers. Splitting them by invention
//     would produce a log line that reads like a measurement and is not one.
//   • It does NOT know「was the user speaking」. The nearest facts we hold at
//     exit are the two channel session slots, and they answer「is a socket
//     connected」, not「was an utterance in flight」. They are reported under
//     that name and no other.
//
// Tauri-free (std + `crate::forensic`) on purpose: the lean `cargo test --lib`
// build exercises the whole classification without the WebView2 toolchain.

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::forensic;

/// The forensic domain every line in this module is tagged with, so
/// `grep "\[exit\]"` over a user's log is the whole investigation.
pub const DOMAIN: &str = "exit";

// ── the classification ───────────────────────────────────────────────────────

/// HOW this process ended. One variant per REACHABLE path, plus one honestly
/// named bucket for「nobody claimed it」.
///
/// 🔴 EXHAUSTIVENESS IS ENFORCED BY THE COMPILER, NOT BY A TEST. `tag`,
/// `sentence` and `ordinal` are all wildcard-free matches over this enum, so a
/// new variant is THREE compile errors until its author has written what it is
/// called, what it says, and where it sits. That is the Rust equivalent of the
/// `satisfies Record<ErrorCode, …>` exhaustive check the protocol package uses
/// to stop a new error code from silently inheriting somebody else's meaning.
///
/// ⚠️ WHERE THAT STOPS, AND WHAT COVERS THE REST. Stable Rust cannot enumerate
/// an enum's variants without a derive macro, so the compiler cannot prove `ALL`
/// is complete — and 【MEASURED】 a variant with all three arms written but left
/// out of `ALL` compiles clean and leaves every assertion in this module green,
/// because they all iterate `ALL`. Three things cover that gap, in order of
/// strength:
///   1. the compile-time block below, which rejects a duplicated or transposed
///      ordinal at BUILD time;
///   2. `the_source_itself_shows_all_and_the_three_matches_agree_on_how_many_paths_exist`,
///      which reads this file as data and counts arms against `ALL` — the same
///      technique `update::apply_arg`'s test module uses against `lib.rs`,
///      because statement-level facts are invisible to the type system;
///   3. `take_declared`, which says so LOUDLY at runtime rather than reporting
///      the exit as `Undeclared`, in case both of the above are ever edited away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitPath {
    /// Tray menu →「Quit」, past the confirm dialog. The ONLY user-initiated
    /// quit this product has (07 §7: a window close hides to the tray).
    TrayQuit,
    /// UP-3b: we are quitting on purpose so the installer / mover can replace
    /// this binary. Not a user asking to stop using the app.
    UpdateInstallHandoff,
    /// A second launch found another FlowMic already holding the instance
    /// identity and stood down. Nothing was wrong; nothing was started.
    SingleInstanceYielded,
    /// This process was never the application: it was the detached mover copy
    /// (`--flowmic-apply-update`) and it has finished its swap.
    UpdateMoverFinished,
    /// A startup preflight refused the configuration it was given (a bad
    /// `FLOWMIC_SIDECAR_PORT`, an unusable `FLOWMIC_INSTANCE_TAG`). Nothing was
    /// started and nothing is wrong with the install — the launch was declined
    /// on purpose, and the line immediately above this one in the log says why.
    StartupConfigRefused,
    /// The event loop ended and NO in-app path claimed it. Covers external
    /// termination (taskkill / a crash of the host), an OS session end, and the
    /// bug case「a quit path forgot to declare」— which cannot be told apart
    /// from here, so they share one bucket that says so.
    Undeclared,
}

impl ExitPath {
    /// Every variant, in ordinal order. See the type's doc for what pins this.
    pub const ALL: [ExitPath; 6] = [
        ExitPath::TrayQuit,
        ExitPath::UpdateInstallHandoff,
        ExitPath::SingleInstanceYielded,
        ExitPath::UpdateMoverFinished,
        ExitPath::StartupConfigRefused,
        ExitPath::Undeclared,
    ];

    /// Position in `ALL`, and the wire form of the declaration latch.
    /// Wildcard-free on purpose — see the type doc.
    pub const fn ordinal(self) -> usize {
        match self {
            ExitPath::TrayQuit => 0,
            ExitPath::UpdateInstallHandoff => 1,
            ExitPath::SingleInstanceYielded => 2,
            ExitPath::UpdateMoverFinished => 3,
            ExitPath::StartupConfigRefused => 4,
            ExitPath::Undeclared => 5,
        }
    }

    /// The short machine tag that appears in the log line and in the sidecar
    /// kill line, so the two can be correlated by eye. Wildcard-free.
    pub const fn tag(self) -> &'static str {
        match self {
            ExitPath::TrayQuit => "tray-quit",
            ExitPath::UpdateInstallHandoff => "update-install-handoff",
            ExitPath::SingleInstanceYielded => "single-instance-yielded",
            ExitPath::UpdateMoverFinished => "update-mover-finished",
            ExitPath::StartupConfigRefused => "startup-config-refused",
            ExitPath::Undeclared => "undeclared",
        }
    }

    /// The human half — what a reader of the log needs in order to STOP
    /// investigating (or to know that they must keep going). Wildcard-free.
    pub const fn sentence(self) -> &'static str {
        match self {
            ExitPath::TrayQuit =>
                "the user chose Quit in the tray menu and confirmed it",
            ExitPath::UpdateInstallHandoff =>
                "quitting on purpose to hand this binary over to the update installer",
            ExitPath::SingleInstanceYielded =>
                "another FlowMic already held the instance identity, so this launch stood down without starting anything",
            ExitPath::UpdateMoverFinished =>
                "this process was the detached update mover, not the app, and its swap is done",
            ExitPath::StartupConfigRefused =>
                "a startup preflight declined the configuration it was given and started nothing — the preceding log line names the setting and the fix",
            ExitPath::Undeclared =>
                "the event loop ended with no in-app quit path declaring itself — external termination, an OS session end, or a quit path that failed to declare; this process cannot tell those apart",
        }
    }
}

// Compile-time consistency of `ALL`: entry i must be the variant whose ordinal
// is i. Catches a duplicated or transposed ordinal AT BUILD TIME, which is the
// half of「a new variant must not fall into an existing bucket」that stable Rust
// can actually mechanise.
const _: () = {
    let mut i = 0;
    while i < ExitPath::ALL.len() {
        assert!(ExitPath::ALL[i].ordinal() == i, "ExitPath::ALL is out of order");
        i += 1;
    }
};

/// Why the sidecar child was killed. Same discipline as `ExitPath`: one variant
/// per caller of `kill_child`, wildcard-free rendering, no shared sentence.
///
/// This is THE fix for the reported defect — the three callers used to emit one
/// indistinguishable line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarKillCause {
    /// The desktop is going down; the exit path is carried through so the child
    /// line and the process line tell the same story.
    AppExit(ExitPath),
    /// Device page → Retry. The app is staying up.
    DevicePageRetry,
    /// The health supervisor saw `/api/health` unanswered for its full strike
    /// budget and is reaping the corpse before re-running bring-up.
    HealthSupervisorRestart,
}

impl SidecarKillCause {
    /// Every variant with a representative payload — the distinctness test's
    /// input. `AppExit` is expanded over every `ExitPath` by the test itself.
    pub const REPRESENTATIVES: [SidecarKillCause; 3] = [
        SidecarKillCause::AppExit(ExitPath::Undeclared),
        SidecarKillCause::DevicePageRetry,
        SidecarKillCause::HealthSupervisorRestart,
    ];

    /// The line `kill_child` records. Wildcard-free.
    pub fn forensic_line(self) -> String {
        match self {
            SidecarKillCause::AppExit(path) => format!(
                "child terminated: the desktop is exiting (exit-path={}) — no orphan `node server.js` is left behind",
                path.tag()
            ),
            SidecarKillCause::DevicePageRetry =>
                "child terminated: device-page Retry is restarting the bring-up (the app stays up)".to_string(),
            SidecarKillCause::HealthSupervisorRestart =>
                "child terminated: the health supervisor declared the local server GONE and is re-running bring-up (the app stays up)".to_string(),
        }
    }
}

// ── the cheap context available where an exit line is written ────────────────

/// Facts that are already in hand at an exit site. Every field is optional
/// because「don't know」and「know it's false」are different answers, and R11 forbids
/// printing the second when only the first is held.
#[derive(Debug, Default, Clone, Copy)]
pub struct ExitContext {
    /// How long this process had been up. `None` when `mark_process_start` was
    /// never called (the mover path, and any test).
    pub uptime: Option<Duration>,
    /// Whether the LAN / cloud channel held a live socket. `None` at sites that
    /// have no `SocketState` at all — the two early-return paths in `run()`
    /// exit BEFORE managed state exists, and saying「no session」there would be
    /// inventing a measurement.
    pub lan_session: Option<bool>,
    pub cloud_session: Option<bool>,
    /// How many times a second launch summoned this instance's main window, and
    /// how long ago the last one was. Zero means「never this session」, which is
    /// a fact, not an absence.
    pub summons: u32,
    pub since_last_summon: Option<Duration>,
}

impl ExitContext {
    /// Everything this module can answer on its own (uptime + summons). The
    /// session slots live in Tauri-managed state, so the caller fills those in.
    pub fn from_process() -> Self {
        Self {
            uptime: uptime(),
            lan_session: None,
            cloud_session: None,
            summons: SUMMONS.load(Ordering::Relaxed),
            since_last_summon: since_last_summon(),
        }
    }

    pub fn with_sessions(mut self, lan: bool, cloud: bool) -> Self {
        self.lan_session = Some(lan);
        self.cloud_session = Some(cloud);
        self
    }
}

/// One line, one exit. Kept on a single line because the forensic sink is
/// line-oriented and a wrapped record is a record you cannot grep.
pub fn describe(path: ExitPath, ctx: &ExitContext) -> String {
    format!(
        "exit path={} — {} | uptime={} | lan_session={} | cloud_session={} | summons={} (last {})",
        path.tag(),
        path.sentence(),
        opt_duration(ctx.uptime),
        opt_bool(ctx.lan_session),
        opt_bool(ctx.cloud_session),
        ctx.summons,
        if ctx.summons == 0 { "never this session".to_string() } else { opt_duration(ctx.since_last_summon) },
    )
}

/// Write the exit line. The ONE place an exit is recorded, so every exit site
/// produces the same shape and a reader learns it once.
pub fn record_exit(path: ExitPath, ctx: &ExitContext) {
    forensic::record(DOMAIN, &describe(path, ctx));
}

fn opt_bool(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "yes",
        Some(false) => "no",
        // NOT "no". See `ExitContext`.
        None => "unknown-here",
    }
}

fn opt_duration(d: Option<Duration>) -> String {
    match d {
        Some(d) => fmt_duration(d),
        None => "unknown".to_string(),
    }
}

/// `1d02h03m04s` / `03m04s` / `4.2s` — compact, sortable by eye, and never
/// scientific notation. The unit suffixes are there because a bare number in a
/// forensic log is an invitation to guess its unit.
pub fn fmt_duration(d: Duration) -> String {
    let secs = d.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hours, rem) = (rem / 3_600, rem % 3_600);
    let (mins, s) = (rem / 60, rem % 60);
    if days > 0 {
        format!("{days}d{hours:02}h{mins:02}m{s:02}s")
    } else if hours > 0 {
        format!("{hours}h{mins:02}m{s:02}s")
    } else if mins > 0 {
        format!("{mins}m{s:02}s")
    } else {
        format!("{}.{}s", s, d.subsec_millis() / 100)
    }
}

// ── process-lifetime facts ───────────────────────────────────────────────────

/// Monotonic start of the APPLICATION (not of the mover copy — see `run()`).
static STARTED_AT: OnceLock<Instant> = OnceLock::new();
/// Millis-since-start of the last second-launch summon; 0 = none yet.
static LAST_SUMMON_MS: AtomicU64 = AtomicU64::new(0);
static SUMMONS: AtomicU32 = AtomicU32::new(0);

/// Stamp the process start. Idempotent; the FIRST call wins so a stray second
/// call cannot shorten a reported uptime.
pub fn mark_process_start() {
    let _ = STARTED_AT.get_or_init(Instant::now);
}

/// Uptime, or `None` when the start was never stamped. Deliberately NOT
/// `Duration::ZERO` on the unmarked path: zero is a measurement and this is not.
pub fn uptime() -> Option<Duration> {
    STARTED_AT.get().map(|t| t.elapsed())
}

/// Record that a second launch summoned this instance's window. Cheap: two
/// relaxed atomics, called from the summon listener thread.
pub fn note_summon() {
    SUMMONS.fetch_add(1, Ordering::Relaxed);
    if let Some(d) = uptime() {
        // `max(1)` so「summoned in the first millisecond」is not indistinguishable
        // from「never summoned」— 0 is this counter's sentinel.
        LAST_SUMMON_MS.store((d.as_millis() as u64).max(1), Ordering::Relaxed);
    }
}

/// How long ago the last summon was, or `None` when there was none (or when the
/// process start was never stamped, so no elapsed time can be computed).
pub fn since_last_summon() -> Option<Duration> {
    let at = LAST_SUMMON_MS.load(Ordering::Relaxed);
    if at == 0 {
        return None;
    }
    let up = uptime()?.as_millis() as u64;
    Some(Duration::from_millis(up.saturating_sub(at)))
}

// ── the declaration latch ────────────────────────────────────────────────────

/// `0` = nothing declared; otherwise `ordinal + 1`.
static DECLARED: AtomicU8 = AtomicU8::new(0);

/// Declare WHY this process is about to end. Call this immediately before the
/// call that ends it (`app.exit`, or the early `return` in `run()`), never
/// speculatively — an undeclared exit is a truthful `Undeclared`, whereas a
/// declaration that did not happen is a lie with a timestamp on it.
///
/// FIRST declaration wins. A conflicting second one is recorded rather than
/// applied: two paths racing to end the process is itself a finding.
pub fn declare(path: ExitPath) {
    let want = path.ordinal() as u8 + 1;
    if let Err(prev) = DECLARED.compare_exchange(0, want, Ordering::SeqCst, Ordering::SeqCst) {
        if prev != want {
            forensic::record(
                DOMAIN,
                &format!(
                    "SECOND exit declaration ignored: already declared '{}', now asked for '{}' — the first one is what will be reported",
                    ExitPath::ALL
                        .get(prev.saturating_sub(1) as usize)
                        .map(|p| p.tag())
                        .unwrap_or("<out of range>"),
                    path.tag()
                ),
            );
        }
    }
}

/// Consume the declaration. `None` = nobody declared, which the caller must
/// render as `ExitPath::Undeclared` — that mapping is the caller's so this
/// function never has to pretend it knows.
pub fn take_declared() -> Option<ExitPath> {
    let v = DECLARED.swap(0, Ordering::SeqCst);
    if v == 0 {
        return None;
    }
    match ExitPath::ALL.get((v - 1) as usize) {
        Some(p) => Some(*p),
        // The residual named in `ExitPath`'s doc: a variant that exists but was
        // never added to `ALL`. Loud, because the alternative is reporting it as
        // `Undeclared` — i.e. exactly the silent bucket-sharing this type exists
        // to prevent.
        None => {
            forensic::record(
                DOMAIN,
                &format!(
                    "an exit path with ordinal {} declared itself but is MISSING from ExitPath::ALL — reporting the exit as undeclared, which is wrong; add the variant to ALL",
                    v - 1
                ),
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 🔴 The acceptance criterion: distinct paths must map to distinct strings.
    /// If two paths shared a tag or a sentence, the log would answer「it exited」
    /// again — which is the entire defect this module was written for.
    #[test]
    fn every_exit_path_has_its_own_tag_and_its_own_sentence() {
        let tags: BTreeSet<&str> = ExitPath::ALL.iter().map(|p| p.tag()).collect();
        assert_eq!(tags.len(), ExitPath::ALL.len(), "two ExitPath variants share a tag: {tags:?}");
        let sentences: BTreeSet<&str> = ExitPath::ALL.iter().map(|p| p.sentence()).collect();
        assert_eq!(
            sentences.len(),
            ExitPath::ALL.len(),
            "two ExitPath variants share a sentence — a reader could not tell them apart"
        );
        for p in ExitPath::ALL {
            assert!(!p.tag().is_empty(), "{p:?} has an empty tag");
            // A tag that is not greppable as one token is not a tag.
            assert!(
                p.tag().chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{p:?} tag must be lowercase-and-dashes so `grep` finds it whole: {}",
                p.tag()
            );
            assert!(p.sentence().len() > 20, "{p:?} sentence must actually explain: {}", p.sentence());
        }
    }

    /// 🔴 THE EXHAUSTIVENESS GUARD'S LAST MILE — and it reads this file as DATA
    /// because nothing else can see it.
    ///
    /// MEASURED, which is why the test exists: a variant given all three arms
    /// (`tag` / `sentence` / `ordinal`) and the next free ordinal, but NOT added
    /// to `ALL`, compiles clean and every other test in this module stays green.
    /// The compiler enforces「you must write all three arms for it」; nothing enforced
    /// 「you also have to add it to ALL」, and `ALL` is what every consumer iterates — so the new variant
    /// would exist, be declarable, and be invisible to the tests that are
    /// supposed to prove no two paths share a bucket.
    ///
    /// Counting the arms in the source closes exactly that gap. Same technique
    /// `update::apply_arg`'s test module uses against `lib.rs`, applied to our
    /// own file: comments are stripped first, for the reason written down there
    /// (the prose explaining a rule is the text most likely to fool a guard
    /// that reads prose).
    #[test]
    fn the_source_itself_shows_all_and_the_three_matches_agree_on_how_many_paths_exist() {
        let me = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("exit_reason.rs");
        let raw = std::fs::read_to_string(&me)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", me.display()));
        // Only the production half: the test module below is full of the same
        // token and would swamp every count.
        let production = raw.split("#[cfg(test)]").next().unwrap().to_string();
        let text: String = production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//") && !l.trim_start().starts_with("///"))
            .collect::<Vec<_>>()
            .join("\n");

        // Count `ExitPath::` mentions inside one delimited region.
        let region = |from: &str, to: &str| -> usize {
            let start = text.find(from).unwrap_or_else(|| {
                panic!("`{from}` is gone from {} — this guard cannot see the table any more", me.display())
            }) + from.len();
            let rest = &text[start..];
            let end = rest.find(to).unwrap_or_else(|| panic!("no `{to}` after `{from}`"));
            rest[..end].matches("ExitPath::").count()
        };

        let in_all = region("pub const ALL: [ExitPath; ", "];");
        let in_ordinal = region("pub const fn ordinal(self) -> usize {", "\n    }");
        let in_tag = region("pub const fn tag(self) -> &'static str {", "\n    }");
        let in_sentence = region("pub const fn sentence(self) -> &'static str {", "\n    }");

        let n = ExitPath::ALL.len();
        assert_eq!(
            in_all, n,
            "ExitPath::ALL's literal does not list {n} variants — the array length and its contents disagree"
        );
        for (what, got) in [("ordinal", in_ordinal), ("tag", in_tag), ("sentence", in_sentence)] {
            assert_eq!(
                got, n,
                "`{what}` has {got} arms but ExitPath::ALL has {n} entries. If you just added a \
                 variant, add it to ALL too — until you do, every consumer that iterates ALL \
                 (including the distinctness assertions in this module) is blind to it, which is \
                 exactly「a new variant silently falls into an existing bucket」"
            );
        }
    }

    /// Exhaustiveness, second half: `ALL` lists every ordinal exactly once,
    /// contiguously from zero. A variant given an ordinal that is already taken
    /// fails the compile-time block above before this test ever runs; this pins
    /// the array's own shape.
    #[test]
    fn all_covers_every_ordinal_exactly_once_and_contiguously() {
        let mut seen = vec![false; ExitPath::ALL.len()];
        for p in ExitPath::ALL {
            let o = p.ordinal();
            assert!(o < seen.len(), "{p:?} has ordinal {o} but ALL only has {} slots — add it to ALL", seen.len());
            assert!(!seen[o], "{p:?} reuses ordinal {o}: a new variant fell into an existing bucket");
            seen[o] = true;
        }
        assert!(seen.iter().all(|s| *s), "ALL has a hole: some ordinal in 0..{} has no variant", seen.len());
    }

    /// The latch is process-global (it has to be: the declaring site and the
    /// reading site are different stack frames on different threads). `cargo
    /// test` runs test fns concurrently IN ONE PROCESS, so the two tests that
    /// drive it must not run at the same time — without this they would flake,
    /// and a flaky exhaustiveness guard is worse than none because the first
    /// red gets blamed on the harness.
    static LATCH_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The declaration latch is the mechanism by which「how」reaches the exit
    /// line. Round-trip every variant, and prove an unclaimed exit reads as
    /// `None` (which the caller renders `Undeclared`) rather than as a stale
    /// previous declaration.
    #[test]
    fn declare_then_take_round_trips_and_then_reads_empty() {
        let _serial = LATCH_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        for p in ExitPath::ALL {
            let _ = take_declared(); // clear whatever a sibling assertion left
            declare(p);
            assert_eq!(take_declared(), Some(p), "{p:?} did not survive the latch");
            assert_eq!(take_declared(), None, "the latch must be consumed, not sticky");
        }
    }

    /// First-declaration-wins: the tray quit that actually happened must not be
    /// overwritten by a later, weaker claim.
    #[test]
    fn the_first_declaration_wins() {
        let _serial = LATCH_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let _ = take_declared();
        declare(ExitPath::TrayQuit);
        declare(ExitPath::UpdateInstallHandoff);
        assert_eq!(take_declared(), Some(ExitPath::TrayQuit));
    }

    /// The sidecar kill line is the ORIGINAL defect: three callers, one
    /// sentence. Pin that they are now three sentences, and that the app-exit
    /// one carries the exit path so the two records can be joined.
    #[test]
    fn every_sidecar_kill_cause_has_its_own_line() {
        let lines: BTreeSet<String> =
            SidecarKillCause::REPRESENTATIVES.iter().map(|c| c.forensic_line()).collect();
        assert_eq!(
            lines.len(),
            SidecarKillCause::REPRESENTATIVES.len(),
            "two kill causes produce the same forensic line — that is the reported defect"
        );
        // …and AppExit must further distinguish itself per exit path, otherwise
        // 「app exiting」 collapses back into one bucket.
        let app_lines: BTreeSet<String> = ExitPath::ALL
            .iter()
            .map(|p| SidecarKillCause::AppExit(*p).forensic_line())
            .collect();
        assert_eq!(app_lines.len(), ExitPath::ALL.len());
        for p in ExitPath::ALL {
            assert!(
                SidecarKillCause::AppExit(p).forensic_line().contains(p.tag()),
                "the child line must name the exit path so it can be joined to the process line"
            );
        }
        // The old text must not survive anywhere: it is the string a reader
        // would grep for, and finding it would mean the collapse came back.
        for c in SidecarKillCause::REPRESENTATIVES {
            assert!(
                !c.forensic_line().contains("(exit / retry)"),
                "the indistinguishable legacy line is back: {}",
                c.forensic_line()
            );
        }
    }

    /// A log line that answers「HOW」must carry the answer AND its context, on
    /// one line, with unknowns named as unknown rather than defaulted to false.
    #[test]
    fn describe_answers_how_and_never_fakes_a_fact_it_lacks() {
        let bare = ExitContext::default();
        let line = describe(ExitPath::Undeclared, &bare);
        assert!(line.contains("exit path=undeclared"));
        assert!(line.contains("external termination"));
        assert!(line.contains("uptime=unknown"), "an unstamped start must read unknown, not 0s: {line}");
        assert!(line.contains("lan_session=unknown-here"), "a missing fact must not render as `no`: {line}");
        assert!(line.contains("summons=0 (last never this session)"));
        assert_eq!(line.lines().count(), 1, "the forensic sink is line-oriented");

        let rich = ExitContext {
            uptime: Some(Duration::from_secs(3 * 86_400 + 2 * 3600 + 4 * 60 + 5)),
            summons: 2,
            since_last_summon: Some(Duration::from_secs(90)),
            ..Default::default()
        }
        .with_sessions(true, false);
        let line = describe(ExitPath::TrayQuit, &rich);
        assert!(line.contains("exit path=tray-quit"));
        assert!(line.contains("uptime=3d02h04m05s"), "{line}");
        assert!(line.contains("lan_session=yes"));
        assert!(line.contains("cloud_session=no"));
        assert!(line.contains("summons=2 (last 1m30s)"), "{line}");
    }

    #[test]
    fn fmt_duration_carries_its_units_at_every_scale() {
        assert_eq!(fmt_duration(Duration::from_millis(4_250)), "4.2s");
        assert_eq!(fmt_duration(Duration::from_secs(90)), "1m30s");
        assert_eq!(fmt_duration(Duration::from_secs(3_661)), "1h01m01s");
        assert_eq!(fmt_duration(Duration::from_secs(90_061)), "1d01h01m01s");
    }
}

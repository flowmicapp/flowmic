// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §3.2, the NR-287 row
//     (duplicate delivery: same id, two frames at once) and the 📌 row under it
//     (why a `cached` outcome is judged again rather than replayed)
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (INJ-3 request_id LRU)
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// NR-287 — an IN-FLIGHT claim on a `request_id`, taken under the same lock as
// INJ-3's `classify`, so one delivery can never run the pipeline twice at once.
//
// ── THE HOLE ────────────────────────────────────────────────────────────────
// `inject_ops::run_inject` locked the machine-wide table for `classify`, released
// it, ran the pipeline, and locked it again for `record`. The table only learns
// "this id was typed" at `record`. A second frame with the same id that arrives
// while the first is still in the pipeline (the other channel's poll thread after
// the primary channel changed hands mid-pipeline, or the same channel after a
// reconnect) therefore classified as `Proceed` and typed the sentence again. The
// gap is as long as the pipeline: under a second on the clipboard path, longer
// for a long SendInput.
//
// ── THE CLAIM ───────────────────────────────────────────────────────────────
// [`classify_claiming`] runs `classify` and, when the verdict is `Proceed` for a
// frame that HAS a request_id, inserts that id into the table's in-flight set
// before the lock is released. The caller holds the returned [`InFlightClaim`]
// for as long as the pipeline runs and records the result BEFORE dropping it
// (`run_inject` keeps it alive to the end of the function, after `record`).
//
// A frame that finds its id in flight does not run anything. It waits on this
// table's condvar (which releases the lock while waiting), and when the first
// frame lets go it classifies AGAIN:
//   · the first frame was recorded (it typed, or answered ok:false with a mode
//     other than `cached`) ⇒ `Replay`: the same reply, no second keystroke;
//   · the first frame was `cached` (nothing typed, deliberately not recorded) ⇒
//     `Proceed` with a fresh claim, i.e. exactly what a sequential retry gets.
//     Doc 15's 📌 row says why a cached outcome is judged again; "never type
//     twice" still holds because the cached run typed nothing.
//
// A frame without a request_id is never claimed: INJ-1's byte window and the
// "deliberate send always proceeds" rule decide it, exactly as before.
//
// ── THE WAIT BUDGET ─────────────────────────────────────────────────────────
// [`CLAIM_WAIT_BUDGET`] = 15 s (NR-288; it was 20 s = the phone's per-send result
// watchdog, `apps/mobile/lib/src/session/compose_gate.dart` `kInjectResultTimeout`).
// A waiting frame blocks its client object's ONLY poll thread: rust_socketio 0.6
// runs event callbacks synchronously on it (crate `src/client/raw_client.rs`
// `callback`), and rust_engineio 0.6 answers the relay's Ping with a Pong inside
// the same poll (crate `src/client/client.rs` `poll`, the `PacketId::Ping` arm).
// So while it waits, that client answers no engine.io ping and handles no
// `sys:ping`, `control:key`, `audio:start`/`audio:stop` or
// `pc:mobile-joined`/`pc:mobile-left`. The relay pings every 10 s and drops a
// link that has not ponged within 20 s (`apps/server-core/src/socket/server.ts`
// `PING_INTERVAL_MS` / `PING_TIMEOUT_MS`), so a 20 s wait could cost the waiter
// its own link; 15 s leaves the pong 5 s. Nothing is lost against the phone: its
// watchdog is 20 s, so a waiter that wakes inside 15 s to a finished first frame
// still answers before it, and past either budget the waiter answers nothing.
// The cost, stated: a first run that finishes between 15 s and 20 s (only a very
// long SendInput) is no longer replayed by the waiter; the first frame's own
// reply and the queue's next drain (`Replay`) answer it. A wait only happens
// across TWO client objects (LAN and cloud, or a re-dialled channel while the
// old object's callback still runs): frames on one object are called one at a
// time by its single poll thread. Both bounds are pinned by
// `dedup_claim_tests.rs` against the two source files. Past the budget the waiting frame gets
// [`Claimed::StillRunning`] and `run_inject` answers `None`: no result frame and
// no row on this frame (the first frame mints its own row and sends its own
// result). The phone's queue still owes the item, and its next drain classifies
// as `Replay` once the first frame has recorded.
//
// ── RELEASE ON EVERY EXIT ───────────────────────────────────────────────────
// The claim is released by `Drop`, not by a call each `return` has to remember:
// success, failure, cached, the deferred gate, the elevated-refusal replay, and
// a panic that unwinds through `run_inject` all drop it. `Drop` never panics: it
// takes the lock through a poisoned mutex rather than unwrapping it, because a
// panic inside a drop that runs during unwinding aborts the process.
//
// ── A PANIC LEAVES AN UNCERTAIN RESULT (NR-288) ─────────────────────────────
// A pipeline that panicked may already have sent some keys, and nothing can say
// how many. Releasing the id alone would let the waiting frame (and every later
// frame with that id) find nothing recorded and run the pipeline again, which
// can type the sentence a second time. So when `Drop` runs during a panic and
// this run recorded nothing, it remembers the id in the submission-uncertain
// table (dedup_uncertain.rs: persisted, 24 h, 256 entries) before releasing it.
// The waiting frame then classifies `SubmissionUncertainRemembered` and
// `run_inject` answers `ok:false` + `INJECT_SUBMISSION_UNCERTAIN` without running
// anything; the phone treats that code as a PC-authored injection verdict
// (`apps/mobile/lib/src/session/outbox_inject_authorship.dart`
// `kPcInjectionVerdictCodes`), so its queue stops re-sending and an explicit
// resend mints a new id. A run that recorded before panicking keeps its record.
// If the panic came before any key, "may be partial" over-states it; that is the
// chosen direction (doc 15 §3.2, the NR-287 row's NR-288 addendum).
//
// ── A POISONED LOCK IS RECOVERED, NOT UNWRAPPED (NR-290) ────────────────────
// This table is one process-wide object (`dedup.rs` `machine_deduper`). If any
// thread panics while holding its lock, std marks the mutex poisoned, and every
// later `lock().unwrap()` panics too: from then on no frame on either channel
// reaches the pipeline and none is answered, until the desktop restarts. The
// phone only sees silence (its 20 s watchdog). So every production lock of this
// table goes through [`lock_table`], and the condvar wait in
// [`classify_claiming`] recovers the same way (`wait_timeout` reports the
// poison too). Recovery clears the poison flag and writes one forensic line per
// poisoning event.
//
// Why the table is still consistent after a panic mid-section. No section
// relies on two fields changing together for a correct answer:
//   · `order`/`results` (`dedup.rs` `insert_entry`, `touch`, `insert`): a panic
//     between their steps leaves either an id in `order` with no result (that id
//     answers `Proceed`, the same as never recorded; eviction pops it and removes
//     nothing) or a result with no `order` slot (never evicted; the table holds
//     one more than `cap`). Neither replays a wrong result.
//   · `in_flight.ids`: inserted only in the statement that returns the claim,
//     removed only in its `Drop`. A run that panicked after typing and before
//     `record` is the "not recorded" case above; its claim's `Drop` (unwinding
//     through `run_inject`) remembers the id as submission-uncertain, so it is
//     not typed again.
//   · `uncertain`, `elevated`, `last_auto`: each write is one container call or
//     one assignment.
//   · the on-disk ledger is re-derived from memory on every save
//     (`save_ledger_best_effort`), never patched, so it cannot keep a half step.
// None of these sections has a known panic today (std containers panic only on
// capacity overflow); this is the guard for the next bug, not a fix for one.

use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::{InjectDecision, InjectDeduper};

/// The longest a frame waits for another frame with the same id to finish.
/// Derivation in the file header (under the relay's 20 s ping timeout with a 5 s
/// margin for the pong, and under the phone's 20 s result watchdog).
pub(crate) const CLAIM_WAIT_BUDGET: Duration = Duration::from_secs(15);

/// The wire mode stored for a run that panicked (see `Drop`): `record`'s own
/// fallback for an uncertain result that carries no mode.
const PANIC_MODE_FALLBACK: &str = "clipboard";

/// The request_ids whose pipeline is running right now, plus the condvar a
/// waiting frame sleeps on. Lives inside [`InjectDeduper`], so it is guarded by
/// the same mutex as INJ-3's table; the condvar is per table (one condvar must
/// never be paired with two different mutexes).
#[derive(Default)]
pub(crate) struct InFlight {
    ids: HashSet<String>,
    done: Arc<Condvar>,
}

/// What [`classify_claiming`] decided.
pub(crate) enum Claimed<'a> {
    /// Act on `decision`. `claim` is `Some` exactly when the decision is
    /// `Proceed` for a frame with a request_id: hold it until the result is
    /// recorded. `waited` is `Some` only when this frame had to wait for
    /// another frame with the same id, and says for how long.
    Decided { decision: InjectDecision, claim: Option<InFlightClaim<'a>>, waited: Option<Duration> },
    /// Another frame with the same id was still running when the budget ran
    /// out. Nothing was run for this frame.
    StillRunning { waited: Duration },
}

/// Proof that this frame owns its request_id's pipeline run. Dropping it
/// releases the id and wakes every frame waiting for it.
pub(crate) struct InFlightClaim<'a> {
    table: &'a Mutex<InjectDeduper>,
    request_id: String,
}

impl Drop for InFlightClaim<'_> {
    fn drop(&mut self) {
        let mut table = lock_table(self.table); // never panics (see the header): this may run while unwinding
        if std::thread::panicking() && !table.results.contains_key(&self.request_id) {
            // NR-288, file header. The mode is not known here (the panic may have
            // come from either path); the wire has no "unknown" token, so this uses
            // the same fallback `record` uses for an uncertain result without a mode.
            // The criterion is the code, not the mode (packages/protocol/src/inject-verdict-authorship.ts, "Why the criterion is a **code**").
            table.remember_uncertain(self.request_id.clone(), PANIC_MODE_FALLBACK.into(), super::uncertainty::wall_now_ms());
            table.save_ledger_best_effort();
            crate::forensic::record("dedup", &format!(
                "IN-FLIGHT panic request_id={:?} — the run unwound before recording a result; remembered as                  submission-uncertain, so a waiting or later frame with this id answers INJECT_SUBMISSION_UNCERTAIN                  and runs nothing", self.request_id));
        }
        table.in_flight.ids.remove(&self.request_id);
        let done = Arc::clone(&table.in_flight.done);
        drop(table);
        done.notify_all();
    }
}

/// INJ-3/INJ-1 `classify`, plus the in-flight claim, under ONE lock. See the
/// file header for the waiting rule and the budget.
pub(crate) fn classify_claiming<'a>(
    table: &'a Mutex<InjectDeduper>,
    source: &str,
    request_id: Option<&str>,
    text: &str,
    now_ms: u64,
    budget: Duration,
) -> Claimed<'a> {
    let started = Instant::now();
    let mut guard = lock_table(table);
    let mut waited = None;
    loop {
        let decision = guard.classify(source, request_id, text, now_ms);
        let (InjectDecision::Proceed, Some(rid)) = (&decision, request_id) else {
            return Claimed::Decided { decision, claim: None, waited };
        };
        if guard.in_flight.ids.insert(rid.to_string()) {
            let claim = InFlightClaim { table, request_id: rid.to_string() };
            return Claimed::Decided { decision, claim: Some(claim), waited };
        }
        let left = budget.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Claimed::StillRunning { waited: started.elapsed() };
        }
        let done = Arc::clone(&guard.in_flight.done);
        // `wait_timeout` re-takes the lock and reports a poison set while it slept.
        guard = match done.wait_timeout(guard, left) {
            Ok((g, _)) => g,
            Err(poisoned) => recovered(table, "condvar wait", poisoned.into_inner().0),
        };
        waited = Some(started.elapsed());
    }
}

/// NR-290: the one way production code locks this table (`run_inject`, the claim
/// and its `Drop`). A poisoned mutex is recovered instead of unwrapped; the file
/// header says why the data is still consistent. Never panics.
pub(crate) fn lock_table(table: &Mutex<InjectDeduper>) -> MutexGuard<'_, InjectDeduper> {
    table.lock().unwrap_or_else(|poisoned| recovered(table, "lock", poisoned.into_inner()))
}

/// Clear the poison flag and say so once: the next lock is clean, so this line
/// appears once per panic that poisoned the table, not once per later frame.
fn recovered<T>(table: &Mutex<InjectDeduper>, site: &str, inner: T) -> T {
    table.clear_poison();
    crate::forensic::record("dedup", &format!(
        "table lock POISONED (seen at {site}) — a thread panicked while holding the dedup table;          recovered and poison cleared, so frames keep being judged and answered          (consistency argument: socket/dedup_claim.rs header, NR-290)"));
    inner
}

#[cfg(test)]
#[path = "dedup_claim_tests.rs"]
mod tests;

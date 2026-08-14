// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer): "on the connected rising
//     edge, send pc:reconnect → reconcile the registry against the ack's
//     connectedMobiles (2s JOINED_SUPPRESS prevents a fresh join from being wiped
//     out by an empty reconcile; ReconcileGate is a mutex)".
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-3 deliverable C.
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md + 01-SERVER-PROTOCOL.md
//     GA-26 ("online phones" count inflated — owner reproduced 2 phones with 1 phone).
//
// The mobile-presence registry. It holds a SET of mobile_ids, not a count:
//   • pc:mobile-joined  → on_join(id)      (insert + stamp the join instant)
//   • pc:mobile-left    → on_left(id)      (remove)
//   • pc:reconnect ack  → reconcile(&ids)  (WHOLE-SET replace)
//
// WHY a set (GA-26): this used to be an `AtomicUsize` with fetch_add/saturating_
// sub while every one of those three wire frames carries a `mobile_id` that was
// simply thrown away. A counter cannot tell "the same phone again" from "a second
// phone", so a duplicate joined (server re-announced a reconnecting phone) or a
// lost left (force-stop, or the desktop offline when it was sent) left permanent
// residue: 1 leftover + 1 newly joined = 2. Identity makes both harmless — a re-inserted id
// is a no-op and an unknown removal is a no-op, so the number can only ever be
// the number of DISTINCT phones the desktop has evidence for.
//
// The RACE this still guards (07 §6): a mobile that joins DURING the reconnect
// handshake can land after the server built the ack's `connectedMobiles`
// snapshot, so the ack carries an EMPTY list while a join event is already in
// flight. Blindly storing the ack would zero a real presence. So:
//   • JOINED_SUPPRESS: an EMPTY reconcile within 2 s of the last join is ignored
//     (the fresh join is the truth; a real departure will re-empty it later).
//   • ReconcileGate: a mutex serializes concurrent reconciles (two rapid
//     reconnects) so the read-decide-store is atomic.
// A non-empty reconcile always applies — and now applies as a SET REPLACE, which
// is what finally clears residue: the server's confirmed roster (GA-07 proves
// each entry with sys:ping before putting it in the ack) becomes the desktop's,
// ids the server no longer knows about are dropped by construction.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 07 §6: a fresh join shields the set from an empty reconcile for this long.
pub const JOINED_SUPPRESS_MS: u64 = 2000;

/// The outcome of a reconcile — surfaced so callers can log/forensic-record it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileOutcome {
    /// The ack roster was applied; carries the new count.
    Applied(usize),
    /// An empty ack within JOINED_SUPPRESS of a join — set kept as-is.
    Suppressed(usize),
}

/// Owns the presence SET. `count` is a DERIVED mirror of `ids.len()`, published
/// inside the same critical section as every mutation and written NOWHERE else —
/// it exists so lock-free readers (the pump's focus:state gate, the capsule's
/// phonePresent) share one truth without taking the mutex on every tick.
pub struct Reconciler {
    ids: Mutex<HashSet<String>>,
    count: Arc<AtomicUsize>,
    last_join: Mutex<Option<Instant>>,
    gate: Mutex<()>,
    suppress: Duration,
}

impl Reconciler {
    pub fn new(count: Arc<AtomicUsize>) -> Self {
        Self::with_suppress(count, Duration::from_millis(JOINED_SUPPRESS_MS))
    }

    pub fn with_suppress(count: Arc<AtomicUsize>, suppress: Duration) -> Self {
        count.store(0, Ordering::SeqCst);
        Self {
            ids: Mutex::new(HashSet::new()),
            count,
            last_join: Mutex::new(None),
            gate: Mutex::new(()),
            suppress,
        }
    }

    /// Publish `ids.len()` to the mirror. Called while the `ids` lock is held.
    fn publish(&self, ids: &HashSet<String>) -> usize {
        let n = ids.len();
        self.count.store(n, Ordering::SeqCst);
        n
    }

    /// Current believed mobile count = the size of the presence set.
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// The ids currently believed present (diagnostics / forensic / the optional
    /// pc:list-mobiles cross-check).
    pub fn ids(&self) -> Vec<String> {
        let ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        let mut v: Vec<String> = ids.iter().cloned().collect();
        v.sort();
        v
    }

    /// pc:mobile-joined{mobile_id} → insert and stamp the join instant (starts the
    /// JOINED_SUPPRESS window). Idempotent: the SAME id twice is still one phone.
    /// Returns the new count.
    pub fn on_join(&self, mobile_id: &str) -> usize {
        let n = {
            let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
            ids.insert(mobile_id.to_string());
            self.publish(&ids)
        };
        // Stamped even for a duplicate: a join frame DID just arrive, so the
        // suppress window it protects is just as real.
        *self.last_join.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        n
    }

    /// pc:mobile-left{mobile_id} → remove. An id we never had is a no-op (no
    /// underflow, and no phantom departure can pull a live phone out). Returns the
    /// new count.
    pub fn on_left(&self, mobile_id: &str) -> usize {
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        ids.remove(mobile_id);
        self.publish(&ids)
    }

    /// Reconcile against the reconnect ack's `connectedMobiles` — a WHOLE-SET
    /// replace, so stale local ids are cleared, not merged. Gated (ReconcileGate)
    /// and JOINED_SUPPRESS-protected: an empty roster inside the suppress window
    /// after a join is kept, not applied.
    pub fn reconcile(&self, ack_ids: &[String]) -> ReconcileOutcome {
        let _serialized = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        if ack_ids.is_empty() {
            let recent_join = self
                .last_join
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .map(|t| t.elapsed() < self.suppress)
                .unwrap_or(false);
            if recent_join {
                return ReconcileOutcome::Suppressed(self.count());
            }
        }
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        *ids = ack_ids.iter().cloned().collect();
        ReconcileOutcome::Applied(self.publish(&ids))
    }

    /// Dead token / auth:expired → the room association is gone; empty the set
    /// unconditionally (a fresh register will re-seed via join events).
    pub fn reset(&self) {
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        ids.clear();
        self.publish(&ids);
        drop(ids);
        *self.last_join.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Reconciler {
        Reconciler::new(Arc::new(AtomicUsize::new(0)))
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn nonempty_reconcile_always_applies() {
        let r = fresh();
        assert_eq!(r.reconcile(&ids(&["a", "b", "c"])), ReconcileOutcome::Applied(3));
        assert_eq!(r.count(), 3);
    }

    #[test]
    fn empty_reconcile_with_no_recent_join_applies() {
        let r = fresh();
        r.reconcile(&ids(&["a", "b"]));
        // No join stamped → a real "room is empty" reconcile is honored.
        assert_eq!(r.reconcile(&[]), ReconcileOutcome::Applied(0));
        assert_eq!(r.count(), 0);
    }

    #[test]
    fn joined_suppress_keeps_count_on_empty_reconcile_after_a_fresh_join() {
        let r = fresh();
        // A mobile joins during the reconnect handshake…
        assert_eq!(r.on_join("m1"), 1);
        // …and the ack's snapshot is stale-empty. It must NOT zero the join.
        assert_eq!(r.reconcile(&[]), ReconcileOutcome::Suppressed(1));
        assert_eq!(r.count(), 1, "the fresh join survives the empty reconcile");
        assert_eq!(r.ids(), ids(&["m1"]));
    }

    #[test]
    fn joined_suppress_window_expires() {
        // Zero-length suppress window → even a just-stamped join does not shield.
        let r = Reconciler::with_suppress(Arc::new(AtomicUsize::new(0)), Duration::ZERO);
        r.on_join("m1");
        assert_eq!(r.reconcile(&[]), ReconcileOutcome::Applied(0));
        assert_eq!(r.count(), 0);
    }

    #[test]
    fn nonempty_reconcile_applies_even_right_after_a_join() {
        let r = fresh();
        r.on_join("m1"); // count 1
        // The ack DID see mobiles — apply the authoritative roster.
        assert_eq!(r.reconcile(&ids(&["m1", "m2", "m3", "m4"])), ReconcileOutcome::Applied(4));
        assert_eq!(r.count(), 4);
    }

    #[test]
    fn reset_zeroes_and_clears_the_join_stamp() {
        let r = fresh();
        r.on_join("m1");
        r.reset();
        assert_eq!(r.count(), 0);
        assert!(r.ids().is_empty());
        // After reset an empty reconcile is honored (no lingering suppress).
        assert_eq!(r.reconcile(&[]), ReconcileOutcome::Applied(0));
    }

    #[test]
    fn on_left_saturates_at_zero() {
        let r = fresh();
        assert_eq!(r.on_left("ghost"), 0);
        r.on_join("m1");
        r.on_join("m2");
        assert_eq!(r.on_left("m1"), 1);
        assert_eq!(r.on_left("m2"), 0);
        assert_eq!(r.on_left("m2"), 0);
    }

    // ── GA-26 regressions: the three shapes that produced the owner's phantom ──

    #[test]
    fn ga26_the_same_phone_joining_twice_is_still_one_phone() {
        // The pre-fix counter went 1→2 here. This is the owner's "shows 2 phones".
        let r = fresh();
        assert_eq!(r.on_join("phone-A"), 1);
        assert_eq!(r.on_join("phone-A"), 1, "a reconnect of the same phone is not a second phone");
        assert_eq!(r.ids(), ids(&["phone-A"]));
        // …and ONE left clears it completely (the counter would have stuck at 1).
        assert_eq!(r.on_left("phone-A"), 0);
    }

    #[test]
    fn ga26_a_left_for_an_unknown_id_never_touches_a_live_phone() {
        let r = fresh();
        r.on_join("phone-A");
        // A late/duplicate departure for a phone we do not hold (e.g. a displaced
        // socket's disconnect) must not decrement the live one.
        assert_eq!(r.on_left("phone-B"), 1);
        assert_eq!(r.ids(), ids(&["phone-A"]));
    }

    #[test]
    fn ga26_reconnect_ack_replaces_the_whole_set_and_clears_residue() {
        let r = fresh();
        r.on_join("stale-1");
        r.on_join("stale-2");
        assert_eq!(r.count(), 2);
        // The server's confirmed roster names ONE phone — and a different one.
        assert_eq!(r.reconcile(&ids(&["phone-A"])), ReconcileOutcome::Applied(1));
        assert_eq!(r.ids(), ids(&["phone-A"]), "residue is replaced, never merged");
    }

    #[test]
    fn the_atomic_mirror_never_disagrees_with_the_set() {
        let r = fresh();
        let check = |r: &Reconciler| assert_eq!(r.count(), r.ids().len());
        r.on_join("a");
        check(&r);
        r.on_join("a");
        check(&r);
        r.on_join("b");
        check(&r);
        r.on_left("a");
        check(&r);
        r.reconcile(&ids(&["x", "y", "z"]));
        check(&r);
        r.reset();
        check(&r);
    }
}

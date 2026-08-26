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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
    /// 🔴 HOW MANY PRESENCE EVENTS HAVE HAPPENED — not how many phones are here.
    ///
    /// `count` answers 「how many phones are here」. Nothing answered 「did a
    /// phone just arrive」, and those are different questions: this set is keyed
    /// by `mobile_id`, so the SAME phone leaving the transcription page and
    /// coming back inserts an id that is already in the set ⇒ the count does not
    /// move ⇒ every consumer downstream of the count is told nothing at all.
    ///
    /// MEASURED 2026-08-26 on owner's machine, six times in one session:
    /// `pc:mobile-joined <same-uid> (mobiles=1)` with no `mobile-left` between,
    /// no CONNECTION frame forwarded, and the capsule — retreated earlier by
    /// `audio:pause` — never came back. Full trace:
    /// docs/strategy/2026-08-26-0333-device-findings-three-defects.md.
    ///
    /// ⚠️ It is a SEPARATE value on purpose. Encoding 「an event happened」 into
    /// the count (bumping it, toggling it) would be this repo's #1 defect shape
    /// — one value answering two questions — and the count is load-bearing for
    /// `phonePresent`, the focus:state gate and the capsule.
    epoch: AtomicU64,
    /// 🔴 HOW MANY JOINS HAVE HAPPENED — a strict subset of `epoch`.
    ///
    /// `epoch` moves on ANY presence event, departures included — that is what
    /// its consumers (the capsule re-surface, the paired-list refresh) want:
    /// 「something changed, go look」. The QR modal's success face asks a
    /// narrower question — 「did a phone ENTER the room」 — and feeding it
    /// `epoch` made a phone LEAVING (another handset backgrounding its app
    /// while the QR was on screen) read as a pairing success. One value was
    /// answering two questions; this is the second value.
    ///
    /// Monotonic, join-only: `on_join` moves both counters, `on_left` moves
    /// only `epoch`. Watch it for INCREASE; its value means nothing.
    join_epoch: AtomicU64,
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
            epoch: AtomicU64::new(0),
            join_epoch: AtomicU64::new(0),
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

    /// How many presence EVENTS have been observed. Monotonic; it never goes
    /// down, and it says nothing about how many phones are here — ask
    /// [`Self::count`] for that. A consumer watches it for CHANGE and must
    /// never read meaning into its value.
    pub fn presence_epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// How many JOIN events have been observed — departures do not move this.
    /// Monotonic. The QR modal's presence-event criterion reads this one, and
    /// must NOT read [`Self::presence_epoch`]: that one also counts departures,
    /// and 「a phone left」 must never close the QR with a success face.
    pub fn join_epoch(&self) -> u64 {
        self.join_epoch.load(Ordering::SeqCst)
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
        //
        // 🔴 …and for EXACTLY the same reason the epoch moves too. These two
        // lines now say the same thing to two different consumers; until
        // 2026-08-26 only the suppress window was ever told. The fact was
        // collected here and then dropped on the way to the UI — R11 in its
        // purest form: the layer making the judgement never received it.
        *self.last_join.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        self.epoch.fetch_add(1, Ordering::SeqCst);
        // 🔴 The join-only counter moves HERE and nowhere else. `on_left` moves
        // `epoch` alone — see the field docs for why they must stay two values.
        self.join_epoch.fetch_add(1, Ordering::SeqCst);
        n
    }

    /// pc:mobile-left{mobile_id} → remove. An id we never had is a no-op (no
    /// underflow, and no phantom departure can pull a live phone out). Returns the
    /// new count.
    pub fn on_left(&self, mobile_id: &str) -> usize {
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        // Only a REAL removal is an event. A departure for an id we never had is
        // already a no-op by the doc above, and bumping the epoch for it would
        // hand the UI a phantom to react to — the opposite of the defect this
        // value exists to fix.
        if ids.remove(mobile_id) {
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
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

    /// 🔴 THE DEFECT owner measured on 2026-08-26, reduced to one assertion.
    ///
    /// The same phone leaving the transcription page and coming back is a REAL
    /// event with NO count change, and until this value existed there was
    /// nothing for the desktop to notice. Six occurrences in one session,
    /// capsule never came back, QR modal never closed.
    #[test]
    fn a_repeat_join_by_the_same_phone_moves_the_epoch_and_not_the_count() {
        let r = fresh();
        assert_eq!(r.presence_epoch(), 0, "nothing has happened yet");

        assert_eq!(r.on_join("phone-a"), 1);
        let after_first = r.presence_epoch();
        assert!(after_first > 0, "a join is an event");

        // The exact shape from the forensic log: joined again, still one phone.
        assert_eq!(r.on_join("phone-a"), 1, "one phone is still one phone");
        assert!(
            r.presence_epoch() > after_first,
            "the count could not say a phone just arrived — this is the value that can",
        );
    }

    #[test]
    fn a_departure_that_removes_nothing_is_not_an_event() {
        // The reverse control for the arm above. `on_left` for an id we never
        // had is documented as a no-op, and a phantom the UI reacts to would be
        // worse than the silence this whole change is fixing.
        let r = fresh();
        r.on_join("phone-a");
        let before = r.presence_epoch();
        assert_eq!(r.on_left("never-seen"), 1);
        assert_eq!(r.presence_epoch(), before, "nothing left, so nothing happened");
        // …while a real departure IS one.
        assert_eq!(r.on_left("phone-a"), 0);
        assert!(r.presence_epoch() > before);
    }

    /// 🔴 THE FALSE POSITIVE this counter exists to prevent (2026-08-26 review):
    /// feeding the QR modal's 「a phone just entered」 criterion from `epoch`
    /// made a DEPARTURE — another paired handset backgrounding its app while
    /// the QR was on screen — close the modal with a success face. A leave is
    /// an event (`epoch` moves, the paired list must refresh its dots), but it
    /// is never a pairing.
    #[test]
    fn a_departure_moves_the_presence_epoch_and_never_the_join_epoch() {
        let r = fresh();
        r.on_join("phone-a");
        let epoch_before = r.presence_epoch();
        let joins_before = r.join_epoch();
        assert_eq!(r.on_left("phone-a"), 0);
        assert!(r.presence_epoch() > epoch_before, "a real departure IS a presence event");
        assert_eq!(
            r.join_epoch(),
            joins_before,
            "…but it is NOT a join — reading it as one is what closed the QR on a disconnect",
        );
        // …while the join that follows moves BOTH.
        r.on_join("phone-a");
        assert!(r.join_epoch() > joins_before, "a join moves the join counter");
    }

    /// The repeat-join case from the arm above, on the join-only counter: the
    /// same phone re-entering is a real JOIN with no count change, and this is
    /// the value the QR criterion watches for it (owner: a re-pair counts).
    #[test]
    fn a_repeat_join_by_the_same_phone_moves_the_join_epoch_too() {
        let r = fresh();
        r.on_join("phone-a");
        let joins = r.join_epoch();
        assert_eq!(r.on_join("phone-a"), 1, "one phone is still one phone");
        assert!(r.join_epoch() > joins);
    }

    #[test]
    fn the_epoch_never_goes_backwards() {
        // It is a counter, not a state: consumers compare it to what they last
        // saw. If it could repeat a value, a consumer would miss an event.
        let r = fresh();
        let mut seen = r.presence_epoch();
        for id in ["a", "b", "a", "b", "a"] {
            r.on_join(id);
            let now = r.presence_epoch();
            assert!(now > seen, "epoch must strictly increase on every join");
            seen = now;
        }
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

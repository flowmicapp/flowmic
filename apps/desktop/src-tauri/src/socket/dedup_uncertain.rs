// SPEC-REF: 07-DESKTOP-SPEC.md §2, lead's 2026-09-22 B-6 retention ruling.
use super::InjectDeduper;

#[derive(Clone)]
pub(super) struct UncertainRecord {
    pub mode: String,
    pub recorded_at_ms: u64,
}

// Read-code measurement 2026-09-22: mobile delivery_outbox_terms.dart sets a
// 45-second inflight watchdog; delivery_outbox_settle.dart returns timeouts to
// queued; outbox_item.dart persists request_id across retries/restarts. No
// finite total retry age or attempt bound exists. Therefore 24h is NOT a
// measured maximum: it is a conservative day-long policy (1920 watchdog
// periods), balancing reconnection replay suppression with legacy-user retry.
// After expiration, an old retry can duplicate prior partial input. Every
// expiry/capacity eviction is logged; no retention policy blocks fresh speech.
pub(super) const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
pub(super) const CAP: usize = 256;

pub(super) fn wall_now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_millis() as u64
}

impl InjectDeduper {
    pub(super) fn remember_uncertain(&mut self, id: String, mode: String, recorded_at_ms: u64) {
        // Replays never refresh the original timestamp.
        self.uncertain.entry(id).or_insert(UncertainRecord { mode, recorded_at_ms });
    }

    pub(super) fn prune_uncertain(&mut self, now_ms: u64) -> bool {
        let mut removed = false;
        loop {
            let oldest = self.uncertain.iter()
                .min_by_key(|(id, record)| (record.recorded_at_ms, *id))
                .map(|(id, record)| (id.clone(), record.recorded_at_ms));
            let Some((id, recorded_at_ms)) = oldest else { break };
            let age_ms = now_ms.saturating_sub(recorded_at_ms);
            let reason = if age_ms >= MAX_AGE_MS { "age" }
                else if self.uncertain.len() > CAP { "capacity" }
                else { break };
            self.uncertain.remove(&id);
            crate::forensic::record("dedup", &format!(
                "uncertain-evicted request_id={id:?} age_ms={age_ms} reason={reason}; legacy retry is eligible again; check target before repeating"
            ));
            removed = true;
        }
        removed
    }
}

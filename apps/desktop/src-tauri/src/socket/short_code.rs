// Moved VERBATIM out of `pairing.rs` at that file's 800-line cap (2026-09-02,
// AUD-D P1-3 work: adding the W8-2 cloud-arm `transient` intent to `Pairing`
// pushed it over). Re-exported from `pairing.rs` (`pub use short_code::{..}`) so
// every existing `crate::socket::pairing::ShortCodeState` / `SharedCode` import
// stays valid — this is a line-count split, not a new layer: nothing was
// renamed, no signature changed, no behaviour moved with the code.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// GA-18 — the cached pairing code AND when it dies.
///
/// The 5-min TTL is the server's (short-code governor); the desktop must not
/// re-derive it, or the modal's countdown and the code the phone can actually
/// use drift apart. So every ack that MINTS a code carries `expires_in_ms`, and
/// it is converted to a local deadline the moment it lands — a duration parked
/// in a field would silently keep meaning "5 minutes from now" forever.
///
/// `expires_at: None` means the server sent no TTL (pre-GA-18 sidecar): the
/// modal then shows its static "valid for 5 minutes" line instead of a countdown it
/// cannot back up.
#[derive(Clone, Debug)]
pub struct ShortCodeState {
    pub code: String,
    pub expires_at: Option<Instant>,
}

impl ShortCodeState {
    pub fn new(code: String, expires_in_ms: Option<u64>) -> Self {
        Self {
            code,
            expires_at: expires_in_ms.map(|ms| Instant::now() + Duration::from_millis(ms)),
        }
    }

    /// Milliseconds left at `now`, saturating at 0 (an expired code reports 0,
    /// never a negative or a wrapped-around huge number).
    pub fn remaining_ms_at(&self, now: Instant) -> Option<u64> {
        self.expires_at
            .map(|deadline| deadline.saturating_duration_since(now).as_millis() as u64)
    }

    pub fn remaining_ms(&self) -> Option<u64> {
        self.remaining_ms_at(Instant::now())
    }
}

pub type SharedCode = Arc<Mutex<Option<ShortCodeState>>>;

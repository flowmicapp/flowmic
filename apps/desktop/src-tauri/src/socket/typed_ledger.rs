// SPEC-REF: see socket/dedup.rs's module header for the full RV-83 dedup
// design — this file is only the ON-DISK SHAPE half, split out (2026-09-02,
// file-size cap) when dedup.rs crossed 800 lines. `pub(in crate::socket)`
// throughout because `InjectDeduper` in dedup.rs constructs and reads these
// types directly (`derive_ledger_file`, `merge_by_alternating`) — this is an
// implementation detail of the dedup module, not a type other modules should
// reach for.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// RV-83 on-disk shape — see the block above [`InjectDeduper`] for the full
/// reasoning. One record per request_id this machine has physically typed
/// (`ok:true`, mode ≠ cached): NOT `InjectOutcome`, NOT the wire `Value` — no
/// window title, no injected_at, no error detail, no text. Just enough to
/// answer 「这条打过了吗」("has this one already been typed") honestly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(in crate::socket) struct TypedLedgerEntry {
    pub(in crate::socket) request_id: String,
    /// Wire `mode` token — "sendinput" | "clipboard" only, mirroring
    /// `InjectMode::wire()`'s two non-cached values. Never "cached": a cached
    /// (untouched) utterance is never recorded here, on disk any more than in
    /// memory (`record`'s existing `mode != Cached` guard, unchanged by RV-83).
    pub(in crate::socket) mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(in crate::socket) struct TypedLedgerFile {
    /// Front = most recently typed. Bounded at [`InjectDeduper::LRU_CAP`] by
    /// construction — this is DERIVED from that same LRU on every save (see
    /// `save_ledger_best_effort`), never a second independently-sized table —
    /// so this file can never hold more than 256 short records no matter how
    /// long the process runs. The bound is the existing owner-approved 07 §2
    /// constant, not a new one invented for this file.
    pub(in crate::socket) entries: VecDeque<TypedLedgerEntry>,
}

impl TypedLedgerFile {
    /// Absent → empty, silently (that is this machine's normal first run, or
    /// the first run after G-13 shipped — not an anomaly worth a log line).
    ///
    /// Unreadable / corrupt / a shape this build no longer recognises → ALSO
    /// empty (never a crash loop: the worst case is this launch not getting
    /// the restart-survival benefit), but D6 (2026-09-02 audit §3-D): NAMED on
    /// the forensic log now. Before this, `.ok()` swallowed the distinction
    /// between "there was never a file" and "there WAS a file and something
    /// destroyed it" — the second case is the interesting one (a crash mid
    /// `save()`, a disk error, a build that changed `TypedLedgerEntry`'s
    /// shape) and it used to leave NOTHING behind to say so: dedup protection
    /// just quietly stopped covering anything typed before this restart, and
    /// nobody investigating a duplicate-paste report could have told that from
    /// this file's own silence.
    pub(in crate::socket) fn load(path: &Path) -> Self {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                crate::forensic::record(
                    "dedup",
                    &format!(
                        "typed ledger {path:?} could not be read ({e}) — starting empty; \
                         dedup protection for anything typed before this restart is gone"
                    ),
                );
                return Self::default();
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(e) => {
                crate::forensic::record(
                    "dedup",
                    &format!(
                        "typed ledger {path:?} is corrupt or an unrecognised shape ({e}) — \
                         starting empty; dedup protection for anything typed before this restart is gone"
                    ),
                );
                Self::default()
            }
        }
    }

    /// Plaintext JSON — deliberately NOT DPAPI, unlike `credentials.bin`. This
    /// file carries no secret: no token, no window title, no message text —
    /// only opaque request_id strings (`mintRequestId`'s
    /// `'{prefix}{seq}-{micros}'` shape, no PII) and a 2-value mode tag. DPAPI
    /// would wrap a value that has nothing in it worth wrapping.
    ///
    /// D6 (2026-09-02 audit §3-D): write-to-temp-then-rename, not a direct
    /// `fs::write`. This file is saved on every injection (`record`'s existing
    /// `mode != Cached` guard notwithstanding, that is still every uncached
    /// utterance this machine types), so it is written far more often than the
    /// process can be expected to run without ever being killed mid-write. A
    /// direct write left half a JSON document on disk in that case, and
    /// `load()` above cannot tell a half-written file from a corrupt one —
    /// both come back as "start empty" (now at least NAMED, see `load`, but
    /// still a loss this rename avoids causing in the first place).
    /// `std::fs::rename` replaces the destination atomically on both Windows
    /// (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`) and Unix (`rename(2)`),
    /// so any reader always sees either the complete old file or the complete
    /// new one, never a partial write.
    pub(in crate::socket) fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        let mut tmp_name = path.as_os_str().to_os_string();
        tmp_name.push(".tmp");
        let tmp = PathBuf::from(tmp_name);
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, path)
    }
}

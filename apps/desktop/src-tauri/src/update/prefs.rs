// UP-3b — the two persisted facts about updating.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §5.0 / §5.2 / §3 row 8
//
// ── 🔴 WHY `last_success_check` IS IN HERE AND NOT A UI DETAIL ──────────────
//
// Design §5.0 names this the card's most likely silent failure, in as many words:
//
// > 「本卡最容易漏的静默失败：只显示『已是最新』而不显示『上次成功检查于 …』。
// >  那样一个**永远查不通**的客户端和一个**刚查过**的客户端**长得一模一样**。
// >  ⇒『上次成功检查』这一行不是装饰，它是『已是最新』这句话的唯一凭据。」
// > ("This card's most easily missed silent failure: showing only 'already up
// > to date' without showing 'last successful check at …'. That way a client
// > that **can never successfully check** and a client that **just checked**
// > look **identical**. ⇒ The 'last successful check' line is not decoration —
// > it is the ONLY evidence behind the sentence 'already up to date'.")
//
// So it is stored beside the toggle, written by exactly one place (a check that
// actually parsed a manifest), and handed to the UI in the same payload as the
// verdict. Not because that is tidy, but because the two must be impossible to
// ship apart: a build that renders 「已是最新」("already up to date") while this field is `None` is a
// build asserting something it has no evidence for (R11).
//
// 🔴 Only a SUCCESSFUL check writes it. A failed one deliberately leaves the old
// value standing — that is what lets the UI say「检查失败」("check failed")
// and「上次成功检查于三天前」("last successful check was three days ago") at
// the same time, which is the true state and is far more useful than
// either sentence alone.
//
// ── AND WHY 「自动检查已关闭」("automatic checking is off") IS NOT
// 「已是最新」("already up to date") ─────────────────────────────────────────
//
// §3 row 8. Turning the toggle off does not make this machine current; it makes
// it uninformed. The UI branches on `auto_check` BEFORE it branches on any
// verdict, and `update-view.ts` has a test for exactly that.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "update-prefs.json";

/// The persisted update preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePrefs {
    /// May we check on our own? Default ON — an update the user never hears about
    /// is the same as no update chain at all, and the check carries no personal
    /// data (it is one unauthenticated GET of a static document).
    pub auto_check: bool,
    /// 🔴 ISO-8601 UTC of the last check that actually READ a manifest.
    /// `None` = 「从未成功」("never succeeded"), which the UI must be able to say out loud.
    #[serde(default)]
    pub last_success_check: Option<String>,
    /// The version the user asked not to be reminded about.
    ///
    /// ⚠️ Reserved and NOT wired to any UI in this card — design §5.1 specifies
    /// 「忽略这个版本」("ignore this version") for the phone, and the desktop
    /// sketch (§5.2) has no such
    /// control. It is serialised so that adding the button later does not need a
    /// format migration, and it is named here so nobody wires it up believing it
    /// already works. 🔴 It is deliberately NOT read anywhere: a field consulted
    /// by nothing is inert, whereas a field consulted by a half-built control is a
    /// façade.
    #[serde(default)]
    pub ignored_version: Option<String>,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self { auto_check: true, last_success_check: None, ignored_version: None }
    }
}

pub fn path() -> PathBuf {
    crate::app_dirs::local_home().join(FILE_NAME)
}

/// Load from `dir`, falling back to the defaults.
///
/// A missing or unreadable file yields `Default`, and that is the correct
/// degradation for BOTH fields: auto-check returns to on (the product default),
/// and `last_success_check` returns to `None` — 「从未成功」("never succeeded").
/// Note the direction:
/// losing the file makes us claim LESS knowledge, never more. A fallback that
/// invented a recent timestamp would manufacture the evidence for「已是最新」
/// ("already up to date") out
/// of a read error.
pub fn load_from(dir: &Path) -> UpdatePrefs {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_to(dir: &Path, prefs: &UpdatePrefs) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(FILE_NAME), json)
}

pub fn load() -> UpdatePrefs {
    load_from(&crate::app_dirs::local_home())
}

pub fn save(prefs: &UpdatePrefs) -> std::io::Result<()> {
    save_to(&crate::app_dirs::local_home(), prefs)
}

/// An ISO-8601 UTC timestamp for "now", seconds precision.
///
/// Hand-formatted from the epoch rather than pulling `chrono`/`time` in: this
/// crate has one existing timestamp formatter of the same shape
/// (`forensic.rs`), and the value's only consumers are a log line and a UI that
/// renders it through `Intl.DateTimeFormat` on the frontend.
pub fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_epoch(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Days-from-epoch → civil date (Howard Hinnant's algorithm), plus the clock.
///
/// Correct across leap years and centuries. Written out rather than approximated
/// with `secs / 86400 / 365` — a timestamp that drifts a day per leap year would
/// make 「上次成功检查」("last successful check") quietly wrong, and that line's entire job is being
/// believed.
fn civil_from_epoch(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

#[cfg(test)]
#[path = "prefs_tests.rs"]
mod tests;

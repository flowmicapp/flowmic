// UP-3b — `update-pending.json`.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.3 ④a / ⑦, §4.4, §5.0
//
// ── WHAT THIS IS FOR, IN ONE SENTENCE ───────────────────────────────────────
//
// 🔴 Design §4.3 ④a states it and it is worth repeating verbatim: 「面包屑是这条
// 链上唯一让失败不静默的东西。没有它，用户取消 UAC 之后看到的是『FlowMic 莫名其妙
// 自己关了，什么也没发生』—— 那是这条链能产生的最坏结果，而且**不设计就是默认
// 结果**。」("The breadcrumb is the one thing on this chain that keeps a failure
// from being silent. Without it, after the user cancels UAC what they see is
// 'FlowMic mysteriously closed itself, and nothing happened' — that is the
// worst outcome this chain can produce, and **without a design, it is the
// default outcome**.")
//
// Both halves of the update chain END with this process exiting. Whatever happens
// after that — a declined UAC prompt, an installer that rolled itself back, a
// swapper that could not rename — happens with nobody left to report it. This
// file is the only channel from "after we died" back to "the next time we run".
//
// ── WHY IT LIVES WHERE IT LIVES ─────────────────────────────────────────────
//
// `%LOCALAPPDATA%\FlowMic\` — beside the forensic log, NOT inside the install
// directory. For the MSI form that is a matter of permissions; for the portable
// form it is structural: **the install directory is the thing being renamed
// away**, so a breadcrumb inside it would vanish at exactly the moment it became
// the only evidence of what happened.
//
// ── AND WHY IT IS DELETED ON READ, WHATEVER IT SAYS ─────────────────────────
//
// A breadcrumb that survived its reading would re-announce a months-old update on
// every launch. It describes ONE attempt; once that attempt has been reported it
// is history, and history does not belong in a file whose whole meaning is 「an
// update is in flight right now」.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file name. One constant so the writer and the reader cannot drift.
const FILE_NAME: &str = "update-pending.json";

/// Which chain wrote this breadcrumb.
///
/// Carried because the two chains fail differently and the recovery sentence
/// differs with them: a stalled MSI means 「安装程序没装完」("the installer
/// never finished") (Windows Installer rolled back; the old version is intact),
/// a stalled portable swap means 「我们没能换掉那个目录」("we couldn't swap out
/// that directory") (and `detail` says whether we put it back).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    Msi,
    Portable,
}

impl PendingKind {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Msi => "msi",
            Self::Portable => "portable",
        }
    }
}

/// One in-flight update attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breadcrumb {
    /// The version that wrote this file — i.e. what we were running.
    pub from: String,
    /// The version the attempt was aiming at.
    pub to: String,
    pub kind: PendingKind,
    /// ISO-8601 UTC, for a support log. Never used as a deadline: a wall clock
    /// that jumped is not evidence that an install failed.
    pub started_at: String,
    /// 🔴 Written by the SWAPPER after the fact, when it has something to say —
    /// `rolled_back:…` above all. This is the field that turns 「it didn't work」
    /// into 「it didn't work AND your old copy is back where it was」, and those
    /// are two very different nights for a user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `%LOCALAPPDATA%\FlowMic\update-pending.json`.
pub fn path() -> PathBuf {
    crate::app_dirs::local_home().join(FILE_NAME)
}

/// Serialise a breadcrumb to `dir/update-pending.json`.
///
/// Takes the directory as an ARGUMENT so the whole read/write/evaluate cycle is
/// testable against a temp dir — the same split `form.rs` uses, and for the same
/// reason: a function that only ever consults the real `%LOCALAPPDATA%` can only
/// be asked about the machine it is running on.
pub fn write_in(dir: &Path, crumb: &Breadcrumb) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(crumb)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(FILE_NAME), json)
}

/// Read the breadcrumb from `dir`, if there is a readable one.
///
/// 🔴 A corrupt or unparsable file reads as `None`, and that is deliberate rather
/// than lazy: this file is a HINT about a past attempt, and the worst thing an
/// unreadable hint could do is block a launch or produce a sentence built from
/// garbage. The honest degradation of 「I cannot tell you what happened last
/// time」 is 「say nothing about last time」 — never 「invent something」.
pub fn read_in(dir: &Path) -> Option<Breadcrumb> {
    let raw = std::fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Remove it. Best effort — a breadcrumb we could not delete is not a reason to
/// fail anything, it only risks one repeated notice.
pub fn clear_in(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(FILE_NAME));
}

/// What the next launch should say about the last attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingOutcome {
    /// We are running the version the attempt aimed at. Event-type 「已更新到 x」
    /// ("already updated to x").
    Completed { to: String },
    /// We are NOT running it. State-type 「上次的更新没有完成」("the last
    /// update didn't finish") + retry.
    ///
    /// 🔴 This merges two shapes — 「we are still on `from`」 and 「we are on some
    /// third version entirely」 — and the merge is legitimate where most are not.
    /// The repo's rule bans collapsing causes whose ACTIONS differ; here the fact
    /// asserted to the user is 「你没有装上 <to>」("you did not get <to> installed"),
    /// which is equally true of both,
    /// and the remedy (retry / open the download page) is identical. `current` is
    /// carried anyway so the diagnostic can show the surprise instead of hiding
    /// it — the merge is in the sentence, not in the record.
    NotCompleted { from: String, to: String, current: String, detail: Option<String> },
}

impl PendingOutcome {
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Completed { .. } => "completed",
            Self::NotCompleted { .. } => "not_completed",
        }
    }
}

/// Judge one breadcrumb against the version actually running. **Pure.**
///
/// 🔴 The judgement is 「what version am I now」, never 「did the installer report
/// success」. We are not present when the installer runs, so its exit code is not
/// ours to read; and the user could have cancelled a UAC prompt, or Windows
/// Installer could have rolled back after saying it started. The running
/// `CARGO_PKG_VERSION` is the one fact this process can establish about itself,
/// which makes it the only honest basis for the sentence.
pub fn evaluate(crumb: &Breadcrumb, current: &str) -> PendingOutcome {
    if current == crumb.to {
        PendingOutcome::Completed { to: crumb.to.clone() }
    } else {
        PendingOutcome::NotCompleted {
            from: crumb.from.clone(),
            to: crumb.to.clone(),
            current: current.to_string(),
            detail: crumb.detail.clone(),
        }
    }
}

/// The running build's own version string.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
#[path = "breadcrumb_tests.rs"]
mod tests;

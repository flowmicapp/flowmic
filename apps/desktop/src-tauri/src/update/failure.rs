// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §3 (the
//     failure-direction table)
//   CLAUDE.md red line「没有静默失败」("no silent failure") / R11「状态一定要
//     对」("the status must be correct")
//
// The closed failure taxonomy for the desktop update core. One variant per row
// of the §3 table, each carrying what the UI needs to say a SPECIFIC sentence.
//
// ── WHY THIS SET IS CLOSED AND `UpdateArtifact::kind` IS NOT ─────────────────
//
// These two live in the same module and obey opposite rules, so the asymmetry is
// worth stating rather than leaving to be discovered:
//
//   • This enum is OURS. Every variant is produced by code in this crate, so a
//     new one cannot appear without somebody adding it, and `#[non_exhaustive]`
//     is deliberately NOT applied: the exhaustive `match` in UP-3b's string
//     mapping is the mechanism that stops a new failure from shipping with no
//     sentence attached. Exactly the job `inject-verdict-authorship.ts` does for
//     the error-code table. A wildcard arm there would undo this whole file.
//
//   • `kind` is THEIRS — it comes off the wire, from a manifest that may have
//     been written by a newer release chain than this build has ever heard of.
//     A closed set in that position is the 0.2.48 P0 (the phone's
//     `kPcInjectionVerdictCodes` was a closed set, so an unregistered code meant
//     「still owed」forever and the queue never converged). It was re-created a
//     second time this month. So: closed where we are the author, open where we
//     are the reader.
//
// ── THE RULE EVERY VARIANT HERE SERVES ──────────────────────────────────────
//
// 🔴 NONE of these may be rendered as 「已是最新」("already up to date").
// 未知 ≠ 最新 ("unknown ≠ latest"). The only state
// permitted to say that sentence is `UpdateVerdict::UpToDate`, which is not in
// this file and is not reachable from any value in it.

use std::fmt;

/// Everything that can go wrong between「用户点了检查更新」("the user clicked
/// check for updates") and「我们手上有一个验过的安装包」("we are holding a
/// verified installer").
///
/// 🔴 `#[non_exhaustive]` is NOT used — see the module header. Adding a variant
/// SHOULD break UP-3b's string table, because that break is the only thing that
/// guarantees the new failure gets a sentence instead of a fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateFailure {
    // ── checking ─────────────────────────────────────────────────────────────
    /// §3 row 3 — DNS / TCP / TLS / timeout. We never got an answer at all.
    ///
    /// UI: 「检查更新失败：连不上服务器」("check for updates failed: can't
    /// reach the server") + the standing 「上次成功检查于 …」("last successful
    /// check at …") line.
    /// Event-type, auto-hides.
    ///
    /// 🔴 Distinct from `ServiceUnavailable` on purpose, and the design's §3
    /// merges them into one row. Splitting is the safe direction: they differ in
    /// what the user can do (wait for their network vs. wait for us) and, more
    /// importantly, in what WE should read out of a support log. Merging two
    /// causes into one sentence is how 「检查失败」("check failed") becomes
    /// unactionable noise.
    Unreachable { detail: String },

    /// §3 row 2 — HTTP 404. The server answered, and its answer was 「这个部署
    /// 不提供更新清单」("this deployment does not offer an update manifest").
    /// Not an error on anybody's part: only the cloud VPS is
    /// expected to carry a manifest (design §1.1).
    ///
    /// UI: 「这个服务器暂不提供更新信息」("this server does not currently
    /// provide update information"). **Not** a scary failure, and **not**
    /// 「已是最新」("already up to date").
    NoManifestOnServer,

    /// §3 row 3 — HTTP 503 `UPDATE_MANIFEST_UNAVAILABLE`. The endpoint HAS a
    /// manifest configured and refused to serve it: missing file, unreadable,
    /// unparsable, or shape-invalid (including a bad sha256 — that is gate ②).
    ///
    /// `detail` carries the endpoint's own short code (`manifest_unreadable`,
    /// `bad_sha256:…`) so a support log names which of those it was.
    ///
    /// UI: 「服务器暂时无法提供更新信息，请稍后再试」("the server cannot
    /// provide update information right now, please try again later").
    ServiceUnavailable { detail: Option<String> },

    /// The manifest endpoint answered with something we did not expect —
    /// 405, 500, a redirect we did not follow, a 200 of HTML from a captive
    /// portal that never reached the parser.
    ///
    /// UI: 「检查更新失败（服务器返回 <status>）」("check for updates failed
    /// (server returned <status>)").
    UnexpectedStatus { status: u16 },

    /// 200, and the body is not a manifest we can read. Either not JSON at all
    /// (the nginx `try_files` HTML-fallback trap the design's §1.4 describes) or
    /// JSON that `parse_manifest` refused.
    ///
    /// `reason` is the parser's short code, or `not_json`.
    ///
    /// UI: 「更新信息无法解读」("the update information could not be
    /// interpreted"). 🔴 Never 「已是最新」("already up to date") — this is the exact case
    /// where a client that only checked `res.ok` would have said it.
    ManifestUnusable { reason: String },

    /// §3 row 4 — the manifest is fine and has no entry for this platform key.
    ///
    /// UI: 「这个版本暂无适用于本平台的更新」("this version currently has no
    /// update available for this platform") + download page. `available` lists what the
    /// manifest DID carry, so a support log shows whether the platform key
    /// drifted (`windows-x64` vs `win32-x64`) rather than the build being absent.
    NoBuildForThisPlatform { platform: String, available: Vec<String> },

    /// This build cannot read its own version — `CARGO_PKG_VERSION` is not
    /// `x.y.z`. A build defect, not a user situation, and it is named rather
    /// than folded into a comparison default because defaulting would make the
    /// app confidently wrong forever in one direction or the other.
    ///
    /// UI: 「无法确定本机版本，请从下载页手动检查」("unable to determine this
    /// machine's version, please check manually from the download page").
    OwnVersionUnreadable { raw: String },

    // ── downloading ──────────────────────────────────────────────────────────
    /// §3 row 5 — the download URL 404s / 410s. The manifest points at a build
    /// the distribution site has already rotated out (release keeps 3 versions).
    ///
    /// UI: 「更新包已不在分发站」("the update package is no longer on the
    /// distribution site") +【recheck】.
    ArtifactGone { status: u16 },

    /// The download did not complete: connection dropped, timeout, TLS failure.
    ///
    /// UI: 「下载中断，请重试」("download interrupted, please retry").
    DownloadFailed { detail: String },

    /// We could not write to the downloads directory — disk full, permissions,
    /// antivirus quarantining the file as it lands.
    ///
    /// UI: 「无法写入下载目录」("unable to write to the downloads directory").
    CannotWrite { detail: String },

    /// 🔴 §2.4 rule 2 — **being unable to compute the hash is a FAILURE.**
    ///
    /// The file vanished between write and read, or reading it failed halfway.
    /// This variant exists so that no call site anywhere has an excuse to write
    /// `catch {}` around the hashing step: that specific `catch` is the literal
    /// shape of 「验不过就当没校验」("treating a failed verification as if no
    /// verification happened"), and it does not read as a bug — it reads as
    /// tidy error handling. A named outcome removes the temptation by giving the
    /// honest answer somewhere to go.
    ///
    /// UI: 「无法校验安装包完整性」("unable to verify the installer's
    /// integrity") — blocking, does not auto-hide.
    CannotHash { detail: String },

    /// The downloaded byte count does not match the manifest's `size`.
    ///
    /// 🔴 Split from `HashMismatch` deliberately, and it is NOT redundant with
    /// it: a truncated download fails BOTH checks, but the two sentences send
    /// the user to opposite conclusions. A dropped connection is 「网络中断了，
    /// 重试一次」("the network dropped, try again") ; a full-length file whose
    /// hash is wrong is 「这个包和我们发布的不是同一个」("this package is not
    /// the one we published"). Reporting the second sentence for the first cause would be
    /// R11's failure — a status word whose evidence does not support it — and it
    /// is the COMMON case, since connections drop far more often than mirrors
    /// are tampered with.
    ///
    /// UI: 「下载不完整（应为 X 字节，实得 Y）」("download incomplete
    /// (expected X bytes, got Y)") +【retry】.
    SizeMismatch { expected: u64, actual: u64 },

    /// 🔴 §3 row 6 — the hash gate refused. **The file has been deleted.**
    ///
    /// UI: 「安装包校验失败」("installer verification failed") — blocking,
    /// explicit dismissal only, deliberately
    /// NOT auto-hiding (design §5.0 records this as a conscious deviation from
    /// the banner contract, because it is not「刚才那次尝试失败了」("that
    /// attempt just failed") but「我们拒绝安装一个被换过的包」("we refuse to
    /// install a package that has been swapped out")).
    ///
    /// ⚠️ The copy must not overclaim. A mismatch means these bytes are not the
    /// published ones; it does not establish an attack, and design §2.1 says in
    /// as many words that a compromised VPS could serve a bad package WITH a
    /// matching hash. This gate is not 「更新链已加固」("the update chain has
    /// been hardened").
    HashMismatch { expected: String, actual: String },

    // ── inspecting a portable archive (see `archive.rs`) ─────────────────────
    /// The downloaded archive cannot be opened as a zip at all.
    ///
    /// UI: 「更新包无法读取」("the update package could not be read") — blocking.
    ArchiveUnreadable { detail: String },

    /// 🔴 The archive does not unpack to the single top-level entry the caller
    /// expected. **This is a live case, not a hypothetical**: the one
    /// `portable-zip` kind covers `FlowMic-portable/` on Windows and
    /// `FlowMic.app/` on macOS [measured 2026-08-08].
    ///
    /// UI: 「更新包的内容与预期不符」("the update package's contents do not
    /// match what was expected") — blocking. Both halves are carried so the
    /// diagnostic says what was wanted AND what was there; either alone leaves
    /// somebody guessing.
    ArchiveLayoutUnexpected { expected: String, found: Vec<String> },

    /// The archive carries entry names that would write outside the extraction
    /// directory (absolute paths, `..` segments, drive letters).
    ///
    /// UI: 「更新包含有不安全的文件名」("the update package contains an
    /// unsafe file name") — blocking. Never quietly skipped: an
    /// archive attempting traversal is something the user must be TOLD about,
    /// which is the rule `portable::zip` already states for its own refusal list.
    ArchiveUnsafeEntry { names: Vec<String> },

    // ── UP-3b: unpacking and installing ──────────────────────────────────────
    /// 🔴 The portable copy is somewhere we cannot replace in place — the
    /// preflight probe (create a sibling directory, rename it, delete it) failed.
    ///
    /// UI: 「这个位置无法就地更新」("this location cannot be updated in
    /// place") + download page — blocking.
    ///
    /// 🔴 The variant exists so this can be said EARLY. `swap.rs::preflight` runs
    /// before the breadcrumb is written and before we exit; discovering an
    /// unwritable location afterwards means the user watches FlowMic close and
    /// never come back, with the explanation trapped in a process that no longer
    /// exists. Failing here costs a sentence, failing later costs an application.
    LocationNotUpdatable { detail: String },

    /// Unpacking the verified archive failed part-way — disk full, permissions,
    /// an antivirus scanner taking a file away mid-write, or a truncated entry.
    ///
    /// UI: 「解压更新包失败」("failed to extract the update package")
    /// +【retry】— NOT blocking: unlike the refusals, this
    /// is a transient condition and retrying is a meaningful action.
    ExtractFailed { detail: String },

    /// A zip member uses a compression method we cannot decode.
    ///
    /// 🔴 Named rather than folded into `ExtractFailed`, because it means
    /// something about US, not about the user's machine: the release chain
    /// changed how it packs. [measured 2026-08-08] today's bundle is STORE +
    /// DEFLATE, both of which `extract.rs` handles; bzip2 / LZMA / zstd members
    /// are legal zip and would land here. The user's action ('open the download
    /// page') is the same as for other refusals, but the SUPPORT LOG's action is
    /// completely different, and that is what a tag is for.
    ArchiveCompressionUnsupported { method: u16, entry: String },

    /// The unpacked tree is missing files a working FlowMic needs.
    ///
    /// UI: 「更新包不完整」("the update package is incomplete") — blocking. 🔴 Checked immediately before the swap,
    /// because the next thing that happens is the user's working copy being
    /// renamed away. `verify_root` asked whether the archive is SHAPED right;
    /// this asks whether what came out of it is a product.
    StagedTreeIncomplete { missing: Vec<String> },

    /// We could not stage or start the mover process.
    ///
    /// UI: 「无法启动更新程序」("unable to launch the updater") — blocking.
    /// Nothing has moved and the app is still
    /// running, so this is recoverable; it is blocking because the user just
    /// clicked 「关闭 FlowMic 并安装」("close FlowMic and install") and is
    /// owed an explanation for why nothing
    /// happened.
    MoverNotLaunched { detail: String },

    /// `msiexec` could not be started.
    ///
    /// UI: 「无法启动安装程序」("unable to launch the installer") — blocking, same reasoning as `MoverNotLaunched`.
    /// 🔴 Distinct from it because the two chains are debugged differently: this
    /// one points at the OS installer, that one at our own copied binary.
    InstallerNotLaunched { detail: String },
}

impl UpdateFailure {
    /// A stable machine-readable tag — for forensic lines and for UP-3b's
    /// string-table key. Deliberately not `Debug`: `Debug` output is a
    /// formatting detail that changes when a field is added, and a log grep
    /// should not break because somebody added a field.
    ///
    /// 🔴 The `match` is exhaustive with NO wildcard arm. That is the whole
    /// mechanism: a new variant stops this compiling until it is named here.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Unreachable { .. } => "unreachable",
            Self::NoManifestOnServer => "no_manifest_on_server",
            Self::ServiceUnavailable { .. } => "service_unavailable",
            Self::UnexpectedStatus { .. } => "unexpected_status",
            Self::ManifestUnusable { .. } => "manifest_unusable",
            Self::NoBuildForThisPlatform { .. } => "no_build_for_platform",
            Self::OwnVersionUnreadable { .. } => "own_version_unreadable",
            Self::ArtifactGone { .. } => "artifact_gone",
            Self::DownloadFailed { .. } => "download_failed",
            Self::CannotWrite { .. } => "cannot_write",
            Self::CannotHash { .. } => "cannot_hash",
            Self::SizeMismatch { .. } => "size_mismatch",
            Self::HashMismatch { .. } => "hash_mismatch",
            Self::ArchiveUnreadable { .. } => "archive_unreadable",
            Self::ArchiveLayoutUnexpected { .. } => "archive_layout_unexpected",
            Self::ArchiveUnsafeEntry { .. } => "archive_unsafe_entry",
            Self::LocationNotUpdatable { .. } => "location_not_updatable",
            Self::ExtractFailed { .. } => "extract_failed",
            Self::ArchiveCompressionUnsupported { .. } => "archive_compression_unsupported",
            Self::StagedTreeIncomplete { .. } => "staged_tree_incomplete",
            Self::MoverNotLaunched { .. } => "mover_not_launched",
            Self::InstallerNotLaunched { .. } => "installer_not_launched",
        }
    }

    /// Does this failure need the user to dismiss it by hand?
    ///
    /// Only the ones that mean 「我们拒绝把这个文件交出去」("we refuse to hand
    /// over this file"). Everything else is a
    /// transient event that has already finished happening (design §5.0).
    pub fn is_blocking(&self) -> bool {
        matches!(
            self,
            Self::HashMismatch { .. }
                | Self::CannotHash { .. }
                | Self::ArchiveUnreadable { .. }
                | Self::ArchiveLayoutUnexpected { .. }
                | Self::ArchiveUnsafeEntry { .. }
                // UP-3b. The first three are refusals of the package's CONTENT,
                // in the same family as the archive ones above. The last two are
                // a different reason with the same requirement: the user clicked
                // an install button and nothing happened, and「数秒后自动隐藏」
                // ("auto-hides after a few seconds")
                // would leave them staring at an app that simply did not do what
                // they asked.
                | Self::ArchiveCompressionUnsupported { .. }
                | Self::StagedTreeIncomplete { .. }
                | Self::LocationNotUpdatable { .. }
                | Self::MoverNotLaunched { .. }
                | Self::InstallerNotLaunched { .. }
        )
    }
}

impl fmt::Display for UpdateFailure {
    /// A DIAGNOSTIC line, not user copy — UP-3b renders the four-locale
    /// sentences from `tag()` and the variant's fields.
    ///
    /// 🔴 No URL, no filesystem path, no credential ever appears here. Same rule
    /// as `cloud.rs`'s forensic lines and the endpoint's own `reason`: these
    /// strings end up in logs that users paste into chat windows. The one place
    /// this is easy to get wrong is `detail`, which is why the transport
    /// classifier in `fetch.rs` maps `reqwest::Error` to a fixed vocabulary
    /// instead of passing its `Display` through — that `Display` carries the
    /// full URL.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable { detail } => write!(f, "unreachable ({detail})"),
            Self::NoManifestOnServer => write!(f, "no_manifest_on_server"),
            Self::ServiceUnavailable { detail } => match detail {
                Some(d) => write!(f, "service_unavailable ({d})"),
                None => write!(f, "service_unavailable"),
            },
            Self::UnexpectedStatus { status } => write!(f, "unexpected_status (http {status})"),
            Self::ManifestUnusable { reason } => write!(f, "manifest_unusable ({reason})"),
            Self::NoBuildForThisPlatform { platform, available } => {
                write!(f, "no_build_for_platform ({platform}; manifest has {})", available.join(","))
            }
            Self::OwnVersionUnreadable { raw } => write!(f, "own_version_unreadable ({raw})"),
            Self::ArtifactGone { status } => write!(f, "artifact_gone (http {status})"),
            Self::DownloadFailed { detail } => write!(f, "download_failed ({detail})"),
            Self::CannotWrite { detail } => write!(f, "cannot_write ({detail})"),
            Self::CannotHash { detail } => write!(f, "cannot_hash ({detail})"),
            Self::SizeMismatch { expected, actual } => {
                write!(f, "size_mismatch (expected {expected}, got {actual})")
            }
            // Hashes are safe to print in full: they are public facts about a
            // public file, and truncating them would defeat the one diagnostic
            // anybody actually wants when this fires.
            Self::HashMismatch { expected, actual } => {
                write!(f, "hash_mismatch (expected {expected}, got {actual})")
            }
            Self::ArchiveUnreadable { detail } => write!(f, "archive_unreadable ({detail})"),
            Self::ArchiveLayoutUnexpected { expected, found } => {
                write!(f, "archive_layout_unexpected (expected {expected}, found [{}])", found.join(","))
            }
            Self::ArchiveUnsafeEntry { names } => {
                write!(f, "archive_unsafe_entry ({} name(s))", names.len())
            }
            Self::LocationNotUpdatable { detail } => write!(f, "location_not_updatable ({detail})"),
            Self::ExtractFailed { detail } => write!(f, "extract_failed ({detail})"),
            Self::ArchiveCompressionUnsupported { method, entry } => {
                write!(f, "archive_compression_unsupported (method {method} on {entry})")
            }
            Self::StagedTreeIncomplete { missing } => {
                write!(f, "staged_tree_incomplete (missing {})", missing.join(","))
            }
            Self::MoverNotLaunched { detail } => write!(f, "mover_not_launched ({detail})"),
            Self::InstallerNotLaunched { detail } => write!(f, "installer_not_launched ({detail})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant, once. This list is maintained by hand and that is the
    /// point: it is a second, independent place a new variant has to be
    /// registered, so 「加了一个没人给文案的失败」("a failure got added that
    /// nobody wrote copy for") costs two omissions rather
    /// than one.
    fn all() -> Vec<UpdateFailure> {
        vec![
            UpdateFailure::Unreachable { detail: "timeout".into() },
            UpdateFailure::NoManifestOnServer,
            UpdateFailure::ServiceUnavailable { detail: Some("manifest_unreadable".into()) },
            UpdateFailure::ServiceUnavailable { detail: None },
            UpdateFailure::UnexpectedStatus { status: 500 },
            UpdateFailure::ManifestUnusable { reason: "not_json".into() },
            UpdateFailure::NoBuildForThisPlatform {
                platform: "windows-x64".into(),
                available: vec!["android".into()],
            },
            UpdateFailure::OwnVersionUnreadable { raw: "0.2".into() },
            UpdateFailure::ArtifactGone { status: 404 },
            UpdateFailure::DownloadFailed { detail: "connect".into() },
            UpdateFailure::CannotWrite { detail: "denied".into() },
            UpdateFailure::CannotHash { detail: "denied".into() },
            UpdateFailure::SizeMismatch { expected: 10, actual: 4 },
            UpdateFailure::HashMismatch { expected: "a".repeat(64), actual: "b".repeat(64) },
            UpdateFailure::ArchiveUnreadable { detail: "not_a_zip".into() },
            UpdateFailure::ArchiveLayoutUnexpected {
                expected: "FlowMic-portable".into(),
                found: vec!["FlowMic.app".into()],
            },
            UpdateFailure::ArchiveUnsafeEntry { names: vec!["../evil".into()] },
            // UP-3b.
            UpdateFailure::LocationNotUpdatable { detail: "rename:PermissionDenied".into() },
            UpdateFailure::ExtractFailed { detail: "write:StorageFull".into() },
            UpdateFailure::ArchiveCompressionUnsupported {
                method: 93,
                entry: "FlowMic-portable/node.exe".into(),
            },
            UpdateFailure::StagedTreeIncomplete { missing: vec!["node.exe".into()] },
            UpdateFailure::MoverNotLaunched { detail: "copy:PermissionDenied".into() },
            UpdateFailure::InstallerNotLaunched { detail: "spawn:NotFound".into() },
        ]
    }

    /// Tags are the string-table keys UP-3b will switch on, so two variants
    /// sharing one tag would silently merge two sentences into one.
    #[test]
    fn every_variant_has_its_own_tag_and_a_nonempty_diagnostic() {
        let mut seen: Vec<&str> = Vec::new();
        for f in all() {
            let tag = f.tag();
            assert!(!tag.is_empty());
            // ServiceUnavailable appears twice by design (with and without a
            // detail) — same variant, same tag, so compare on the variant.
            if !matches!(f, UpdateFailure::ServiceUnavailable { detail: None }) {
                assert!(!seen.contains(&tag), "tag `{tag}` is used by two variants");
                seen.push(tag);
            }
            assert!(!f.to_string().is_empty());
        }
    }

    /// 🔴 The red line, asserted mechanically. A failure that rendered as
    /// 「已是最新」("already up to date") would be the exact defect the endpoint returns 503 to avoid.
    /// This cannot catch a bad translation in UP-3b, but it does catch the
    /// diagnostic layer drifting toward reassurance.
    #[test]
    fn no_failure_ever_describes_itself_as_up_to_date() {
        for f in all() {
            let s = f.to_string().to_ascii_lowercase();
            for forbidden in ["up to date", "up-to-date", "latest", "已是最新", "最新版本"] {
                assert!(
                    !s.contains(forbidden),
                    "{:?} rendered as `{s}`, which contains `{forbidden}` — 未知 ≠ 最新",
                    f.tag(),
                );
            }
        }
    }

    /// 🔴 Diagnostics get pasted into chat windows. No URL, no path.
    #[test]
    fn no_diagnostic_line_carries_a_url_or_a_path() {
        for f in all() {
            let s = f.to_string();
            for forbidden in ["http://", "https://", "C:\\", "://"] {
                assert!(!s.contains(forbidden), "{s} leaked `{forbidden}`");
            }
        }
    }

    /// Only the refusals block — the ones that mean 「我们拒绝把这个文件交出去」
    /// ("we refuse to hand over this file").
    ///
    /// Pinned as an exact list rather than a property, because both directions
    /// are real mistakes: if `Unreachable` ever became blocking, every laptop
    /// that closes its lid would collect an un-dismissable error; and if
    /// `HashMismatch` ever stopped blocking, the one sentence that MUST be read
    /// would auto-hide after a few seconds (design §5.0 records that deviation
    /// from the banner contract as deliberate).
    #[test]
    fn exactly_the_refusals_demand_explicit_dismissal() {
        let mut blocking: Vec<&str> =
            all().iter().filter(|f| f.is_blocking()).map(UpdateFailure::tag).collect();
        blocking.sort_unstable();
        blocking.dedup();
        assert_eq!(
            blocking,
            vec![
                "archive_compression_unsupported",
                "archive_layout_unexpected",
                "archive_unreadable",
                "archive_unsafe_entry",
                "cannot_hash",
                "hash_mismatch",
                "installer_not_launched",
                "location_not_updatable",
                "mover_not_launched",
                "staged_tree_incomplete",
            ],
        );
        // …and every transient one must NOT block.
        for f in all() {
            if matches!(
                f,
                UpdateFailure::Unreachable { .. }
                    | UpdateFailure::NoManifestOnServer
                    | UpdateFailure::ServiceUnavailable { .. }
                    | UpdateFailure::SizeMismatch { .. }
                    | UpdateFailure::DownloadFailed { .. }
                    // UP-3b: a part-way extraction is a transient condition with a
                    // meaningful retry, so it must stay an event like the others.
                    | UpdateFailure::ExtractFailed { .. }
            ) {
                assert!(!f.is_blocking(), "{} must not demand dismissal", f.tag());
            }
        }
    }
}

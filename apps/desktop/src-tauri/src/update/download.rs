// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §2.4 (the two hard
//                                                      client-side rules)
//                                                      §4.3 ② (where the
//                                                      download goes, and why)
//                                                      §3 table rows 5/6
//
// Gate ③ of the hash chain — **the only one of the three that protects a user.**
// Gates ① (the generator) and ② (the endpoint) protect「我们不会发出一份没法验
// 的清单」("we will never issue a manifest that cannot be verified"). This one
// holds the actual bytes.
//
// ── THE TWO HARD RULES, AND HOW THE CODE MAKES THEM STRUCTURAL ──────────────
//
// §2.4 states them as rules. Rules get forgotten, so each is built into a shape:
//
//   1. 「哈希在『下载完成』与『交给安装器』之间算，不许在别处。」("The hash is
//      computed between 'download complete' and 'handed to the installer',
//      nowhere else.")
//      ⇒ The download writes to `<filename>.part`. Only `finalize()` — which
//        hashes first — can produce the final name, and only `VerifiedPackage`
//        (which nothing else constructs) carries a path onward. So a caller
//        CANNOT get hold of a final-named file that was not hashed: there is no
//        code path that produces one. That is stronger than remembering to call
//        a verify function, because forgetting is not available as an option.
//
//   2. 🔴 「算不出来也是失败。」("Being unable to compute it is also a failure.")
//      ⇒ `sha256_file` returns `io::Result`, and its one caller maps `Err` to
//        `UpdateFailure::CannotHash` — never to「fine, carry on」. The `.part`
//        file is deleted in that branch too. There is deliberately no
//        `unwrap_or_default()`, no `if let Ok(..)` that silently skips, and no
//        `catch {}`-shaped construct anywhere in this file. That specific
//        omission IS 「验不过就当没校验」("treating a failed verification as if
//        no verification happened"), and it does not read as a bug when you
//        review it — it reads as tidy error handling. Which is why it gets a
//        named variant instead of a comment telling people not to.
//
// ── WHY `.part` AND A RENAME ────────────────────────────────────────────────
//
// A half-written file under the final name is indistinguishable from a complete
// one on the next launch, and the tempting feature that follows ("resume the
// download we already have") would then be building on a file nobody verified.
// With the rename, **a file under the final name has passed the gate, always** —
// that is an invariant a later card can rely on rather than re-derive.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::failure::UpdateFailure;
use super::manifest::UpdateArtifact;

/// Suffix for an in-flight download. See the module header.
const PART_SUFFIX: &str = ".part";

/// A download may take a while — an MSI is ~37 MB and the download centre is on
/// the LAN, but a portable zip is larger and a user may be on anything.
/// Generous, because the failure it prevents (a slow connection reported as
/// 「下载中断」— "download interrupted") is worse than a long spinner the user
/// can cancel by closing the page.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Read buffer. Big enough that a 40 MB file is ~640 reads, small enough that
/// progress updates stay smooth.
const CHUNK: usize = 64 * 1024;

/// Where downloads land: `%LOCALAPPDATA%\FlowMic\updates\`.
///
/// Design §4.3 ② rules out every alternative for a stated reason, and they are
/// worth keeping next to the code:
///   • NOT `publish/` — that is the BUILD machine's artifact area (RV-73); it
///     does not exist on a user's machine at all.
///   • NOT the install directory — writing to `C:\Program Files\FlowMic\` needs
///     elevation, and the MSI is about to replace its contents anyway.
///   • NOT `%TEMP%` — cleaners delete from it mid-download.
///   • `%LOCALAPPDATA%\FlowMic\` is already ours (the forensic log lives there).
///
/// 🔴 And note which directory this is NOT, because they differ by one segment:
/// the RUN directory is `%LOCALAPPDATA%\Programs\FlowMic\`
/// (`scripts/install-local.mjs`), not this one. That separation is load-bearing
/// for any future in-place swap — the downloaded archive never sits inside the
/// directory that would be being replaced. `form_tests.rs` asserts it.
pub fn updates_dir() -> PathBuf {
    crate::app_dirs::local_home().join("updates")
}

/// SHA-256 of a file, lowercase hex.
///
/// Streams in `CHUNK`-sized reads rather than `fs::read`: these files are tens
/// of megabytes and loading one whole into memory to hash it would be a
/// self-inflicted memory spike on the smallest machine we support.
///
/// 🔴 Returns `io::Result`. **The error case is the point.** See rule 2 in the
/// module header — the caller must turn it into `CannotHash`, and no caller may
/// treat「we could not compute it」as「it was fine」.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    // Lowercase hex, matching the manifest's required shape exactly, so the
    // comparison is between two normalised values rather than a guess about
    // case (`manifest.rs::is_sha256_hex` refuses uppercase for the same reason).
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// A file that has passed the gate.
///
/// 🔴 **The ONLY way to obtain one is `finalize`, which hashes first.** There is
/// no public constructor and no public setter, so「I have a `VerifiedPackage`」
/// and「these bytes matched the manifest」are the same statement. That is why
/// this type exists rather than returning a bare `PathBuf`: a `PathBuf` proves
/// nothing about the bytes it points at, and every consumer would have to be
/// trusted to remember.
///
/// ⚠️ **IT MAKES NO CLAIM ABOUT THE FILE'S INTERNAL STRUCTURE.** It says these
/// bytes hash to what the manifest declared. It does NOT say an MSI is
/// installable, and it does NOT say a `portable-zip` contains any particular
/// layout. This is deliberate and structural: the type carries no field
/// describing an archive's contents, and this module defines no constant naming
/// one, so a consumer that needs to know what is inside has nowhere to read it
/// from except the file itself. UP-3b must open the archive and verify its shape
/// — refusing loudly if it is not what was expected — and it cannot express
/// 「I assumed the layout」by reading something from here, because there is
/// nothing here to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPackage {
    path: PathBuf,
    kind: String,
    sha256: String,
    size: u64,
}

impl VerifiedPackage {
    /// The file on disk. Verified at the moment `finalize` returned.
    ///
    /// ⚠️ A sample, like every filesystem reading: nothing stops the file being
    /// replaced afterwards. If a later step needs the guarantee to still hold at
    /// the instant it acts — and the msiexec hand-off in UP-3b arguably does —
    /// it must re-hash. What this type removes is the possibility of NEVER
    /// having hashed, not the passage of time.
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// The manifest's `kind`, verbatim. An OPEN set — see `manifest.rs`.
    pub fn kind(&self) -> &str {
        &self.kind
    }
    /// The verified digest, lowercase hex.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    /// Verified byte length.
    pub fn size(&self) -> u64 {
        self.size
    }
}

/// Check a completed `.part` file and, only if it passes, move it to its final
/// name.
///
/// This is the gate itself, split out from the transport so it can be driven
/// against files written by hand. Every ordering rule lives here:
///   • size first (cheap, and it names the COMMON failure correctly),
///   • then the hash,
///   • the rename happens only after both,
///   • and any failure DELETES the file.
///
/// 🔴 Deleting on failure is not tidiness. A rejected installer left on disk is
/// something a confused user can double-click — we refused to hand it to the
/// installer, and then left it where they can run it themselves.
pub fn finalize(part: &Path, final_path: &Path, artifact: &UpdateArtifact) -> Result<VerifiedPackage, UpdateFailure> {
    // Size. Named separately from the hash because a truncated download fails
    // both, and 「网络中断了，重试」("the network dropped, retry") is a different
    // sentence from 「这个包和我们发布的不是同一个」("this package is not the one
    // we published") — see `UpdateFailure::SizeMismatch`.
    let actual_size = match fs::metadata(part) {
        Ok(m) => m.len(),
        Err(e) => {
            // We cannot even look at it. That is the CannotHash family: we did
            // not verify, and we must not pretend otherwise.
            return Err(discard(part, UpdateFailure::CannotHash { detail: format!("stat:{}", e.kind()) }));
        }
    };
    if actual_size != artifact.size {
        return Err(discard(part, UpdateFailure::SizeMismatch { expected: artifact.size, actual: actual_size }));
    }

    // 🔴 Rule 2. There is no third branch here — no `unwrap_or`, no skip.
    let actual = match sha256_file(part) {
        Ok(h) => h,
        Err(e) => {
            return Err(discard(part, UpdateFailure::CannotHash { detail: format!("read:{}", e.kind()) }));
        }
    };
    if actual != artifact.sha256 {
        return Err(discard(
            part,
            UpdateFailure::HashMismatch { expected: artifact.sha256.clone(), actual },
        ));
    }

    // Passed. Only now does the final name come into existence.
    if let Err(e) = fs::rename(part, final_path) {
        return Err(discard(part, UpdateFailure::CannotWrite { detail: format!("rename:{}", e.kind()) }));
    }
    Ok(VerifiedPackage {
        path: final_path.to_path_buf(),
        kind: artifact.kind.clone(),
        sha256: artifact.sha256.clone(),
        size: artifact.size,
    })
}

/// Delete a rejected download and pass the failure through unchanged.
///
/// The delete is best-effort and its result is deliberately dropped: if removal
/// fails we still have to report the ORIGINAL failure, and replacing
/// 「安装包校验失败」("installer verification failed") with「删不掉临时文件」
/// ("couldn't delete the temp file") would answer a question nobody asked
/// while hiding the one that matters.
fn discard(part: &Path, failure: UpdateFailure) -> UpdateFailure {
    let _ = fs::remove_file(part);
    failure
}

/// Download one artifact into `dir` and verify it.
///
/// `progress(downloaded, total)` is called as bytes arrive — `total` is the
/// manifest's declared size, so a progress bar never depends on a
/// `Content-Length` header we would have to trust. It is here rather than in
/// UP-3b so that the download loop has exactly one implementation.
///
/// 🔴 Runs the blocking client on a thread we own — `reqwest::blocking` panics
/// inside an async runtime context (`cloud.rs`). Unlike the manifest fetch this
/// one cannot simply `join()` on the caller's thread if progress is to be
/// reported live, so the caller is expected to invoke this from a worker of its
/// own; the doc says so rather than hiding a second thread inside.
pub fn download_and_verify(
    artifact: &UpdateArtifact,
    dir: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<VerifiedPackage, UpdateFailure> {
    if let Err(e) = fs::create_dir_all(dir) {
        return Err(UpdateFailure::CannotWrite { detail: format!("mkdir:{}", e.kind()) });
    }
    // `artifact.filename` was validated at the manifest boundary to contain no
    // separator and no `..` (`manifest.rs`), which is what makes this join safe.
    // Stated here because a `join` with an attacker-influenced name is exactly
    // the shape that is usually wrong — it is safe HERE only because of a check
    // that happens somewhere else, and that dependency should be visible.
    let final_path = dir.join(&artifact.filename);
    let part = dir.join(format!("{}{PART_SUFFIX}", artifact.filename));

    let client = match reqwest::blocking::Client::builder().timeout(DOWNLOAD_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return Err(UpdateFailure::DownloadFailed { detail: transport_detail(&e) }),
    };
    let mut resp = match client.get(&artifact.url).send() {
        Ok(r) => r,
        Err(e) => return Err(UpdateFailure::DownloadFailed { detail: transport_detail(&e) }),
    };
    let status = resp.status().as_u16();
    if status == 404 || status == 410 {
        // §3 row 5: the manifest points at a build the distribution site has
        // already rotated out (release keeps 3 versions). Its own sentence,
        // because the action is 「重新检查」("recheck") rather than 「重试下载」
        // ("retry the download").
        return Err(UpdateFailure::ArtifactGone { status });
    }
    if !resp.status().is_success() {
        return Err(UpdateFailure::DownloadFailed { detail: format!("http {status}") });
    }

    // A stale `.part` from an interrupted run is truncated, not resumed: we do
    // not know what is in it, and the only honest thing to do with bytes of
    // unknown provenance is not keep them.
    let mut out = match File::create(&part) {
        Ok(f) => f,
        Err(e) => return Err(UpdateFailure::CannotWrite { detail: format!("create:{}", e.kind()) }),
    };
    let mut buf = vec![0u8; CHUNK];
    let mut written: u64 = 0;
    loop {
        let n = match resp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                return Err(discard(&part, UpdateFailure::DownloadFailed { detail: format!("read:{}", e.kind()) }));
            }
        };
        if let Err(e) = out.write_all(&buf[..n]) {
            return Err(discard(&part, UpdateFailure::CannotWrite { detail: format!("write:{}", e.kind()) }));
        }
        written += n as u64;
        progress(written, artifact.size);
    }
    // Flush before hashing: buffered bytes still in the handle would make the
    // digest a hash of a file that does not exist yet.
    if let Err(e) = out.flush() {
        return Err(discard(&part, UpdateFailure::CannotWrite { detail: format!("flush:{}", e.kind()) }));
    }
    drop(out);

    finalize(&part, &final_path, artifact)
}

/// Same vocabulary as `fetch.rs` / `cloud.rs` — never the error's `Display`,
/// which carries the URL.
fn transport_detail(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".to_string()
    } else if e.is_connect() {
        "connect".to_string()
    } else {
        "transport".to_string()
    }
}

/// How many files a sweep touched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SweepReport {
    pub removed: usize,
    /// Files we tried and failed to remove (locked, permissions). Reported
    /// rather than swallowed: housekeeping that silently never works is how a
    /// directory becomes a pile nobody is watching.
    pub failed: usize,
}

/// Delete everything in `dir` that is not the current target.
///
/// Design §4.3 ②: 「每次启动清理 updates\ 里不是当前目标的文件 —— 否则它会变成
/// 一个只涨不消的垃圾堆。」("On every launch, clean up the files in updates\ that
/// are not the current target — otherwise it becomes a pile that only grows and
/// never shrinks.") Each release is tens of megabytes, so a year of
/// updates is gigabytes of installers for versions nobody can use any more.
///
/// `keep` is the CURRENT target's filename; its `.part` sibling is kept too, so
/// calling this while a download is in flight cannot delete that download.
///
/// Never returns an error: this is housekeeping, and a failure to tidy must not
/// be able to fail an update. It reports counts so a forensic line can say what
/// happened, which is the difference between "best effort" and "silent".
pub fn sweep_stale(dir: &Path, keep: Option<&str>) -> SweepReport {
    let mut report = SweepReport::default();
    let Ok(entries) = fs::read_dir(dir) else {
        // No directory yet is the normal state before the first download.
        return report;
    };
    let keep_part = keep.map(|k| format!("{k}{PART_SUFFIX}"));
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if Some(name.as_str()) == keep || Some(&name) == keep_part.as_ref() {
            continue;
        }
        // Only files. A directory in here is not something we put there, and
        // recursively deleting unknown directories from a path assembled out of
        // an environment variable is not a risk this function needs to take.
        if !entry.path().is_file() {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => report.removed += 1,
            Err(_) => report.failed += 1,
        }
    }
    report
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;

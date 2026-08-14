// UP-3b — unpack a verified portable bundle.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.5 (what about the
//     portable edition)
//   docs/decisions/2026-08-05-owner-build-and-release-additions.md ② (a true
//     in-place upgrade)
//
// ── 🔴 WHY THIS FILE EXISTS AT ALL: A MEASURED CONTRADICTION ────────────────
//
// UP-3a's `archive.rs` verifies an archive's SHAPE and says extraction belongs
// here. What it could not know is that **nothing in this tree could extract one**.
//
// `portable::zip::ZipReader::read_entry` refuses any method other than STORE, by
// a deliberate and correct design: it reads FPR v1 archives, which *we* write, so
// STORE-only is a complete answer there. The portable bundle is a different
// animal — `scripts/pack-portable.mjs` writes it with bsdtar, and bsdtar
// compresses.
//
// [measured 2026-08-08, dev-pc-a — parsed the central directory of
// `publish/FlowMic-0.2.59-portable-windows-x64.zip` directly, 10 entries]:
//
//     method histogram  {0: 2, 8: 8}
//     method=0  FlowMic-portable/                 (0 B — a directory marker)
//     method=0  FlowMic-portable/resources/       (0 B — a directory marker)
//     method=8  FlowMic-portable/FlowMic.exe      15,825,408 → 5,215,779
//     method=8  FlowMic-portable/node.exe         86,969,160 → 33,164,432
//     method=8  FlowMic-portable/resources/server.js  1,461,200 → 323,735
//     …and 3 more, all method 8
//
// ⇒ **Every real file is DEFLATE.** `read_entry` answers `ZipError::Compressed`
// for all eight. A portable self-updater built on it would have failed on its
// first file, on the owner's own machine, every time.
//
// ── WHY THIS DOES NOT TOUCH `portable::zip` ─────────────────────────────────
//
// Teaching that reader DEFLATE would have been fewer lines. It would also have
// silently changed a SHIPPED behaviour outside this card: FPR v1 import today
// REFUSES a file the user re-zipped with Explorer (`ZipError::Compressed` is a
// named refusal the import UI renders), and after such an edit it would quietly
// accept it. That is a product decision belonging to doc 16, not a side effect of
// an update card.
//
// So this module reuses that reader for the two things it is authoritative about
// — enumerating the central directory and REFUSING unsafe entry names — and
// reads the bytes itself. `ZipEntry` exposes `method`, `size` and `local_offset`
// as public fields, which is exactly enough.
//
// ⚠️ **WINDOWS-SHAPED, AND SAID SO RATHER THAN DISCOVERED.** This writes plain
// files. It does not restore POSIX permission bits and it does not recreate
// symlinks, both of which live in the zip's external-attributes field. A macOS
// `.app` needs both (its `Contents/MacOS/*` must be executable, and frameworks
// are symlink farms) ⇒ **this function is not sufficient to swap a macOS bundle**
// and must not be quietly reused for one. `swap.rs` only ever calls it for the
// Windows portable form; macOS keeps `ManualReason` until somebody does that work
// on a Mac and watches it run.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use crate::portable::zip::{ZipError, ZipReader};

use super::failure::UpdateFailure;

/// zip local file header, fixed part.
const LOCAL_HEADER_LEN: usize = 30;
/// `PK\3\4`.
const LOCAL_HEADER_SIG: u32 = 0x0403_4b50;
/// Stored, no compression.
const METHOD_STORE: u16 = 0;
/// DEFLATE — what bsdtar writes, and the whole reason this file exists.
const METHOD_DEFLATE: u16 = 8;

/// Streaming buffer. The largest member is `node.exe` at ~87 MB uncompressed, so
/// the one thing this must NOT do is materialise an entry in memory.
const COPY_BUF: usize = 64 * 1024;

/// What an extraction actually put on disk.
///
/// Counted rather than assumed: 「it ran without error」 is not a measurement, and
/// a caller that wants to prove a tree was written needs numbers to compare.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExtractReport {
    /// Files written.
    pub files: usize,
    /// Total uncompressed bytes written.
    pub bytes: u64,
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn io_fail(stage: &str, e: &io::Error) -> UpdateFailure {
    UpdateFailure::ExtractFailed { detail: format!("{stage}:{}", e.kind()) }
}

/// Join an archive entry name onto `dest`, refusing anything that could escape.
///
/// 🔴 **A SECOND LAYER, ON PURPOSE.** `ZipReader::open` already applies
/// `entry_name_is_safe` and an unsafe name never becomes a readable entry — so
/// this check should be unreachable. It is here anyway because the cost of being
/// wrong is writing an attacker-named file anywhere on the disk, and because the
/// first layer lives in ANOTHER MODULE whose contract could be relaxed by
/// somebody who never reads this one. `portable::archive` states the same
/// two-layer rule for the same reason.
///
/// Rejects by CONSTRUCTION rather than by string inspection: only `Normal`
/// components survive, so `..`, a root, and a drive prefix are all excluded by
/// the same `match` and no new spelling of them can slip past.
fn safe_join(dest: &Path, name: &str) -> Option<PathBuf> {
    let mut out = dest.to_path_buf();
    let mut any = false;
    for c in Path::new(name).components() {
        match c {
            Component::Normal(part) => {
                out.push(part);
                any = true;
            }
            // CurDir is harmless but contributes nothing; everything else is an
            // escape attempt or an absolute anchor.
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if any {
        Some(out)
    } else {
        None
    }
}

/// Copy exactly `expected` decompressed bytes from `src` into `out`.
///
/// 🔴 Bounded by `expected` (the CENTRAL DIRECTORY's uncompressed size) rather
/// than by "read until EOF", and the difference is load-bearing for DEFLATE: a
/// decoder handed a file positioned at one entry will happily keep inflating into
/// whatever follows. `Take` makes the entry's declared length the authority.
///
/// Then it asserts the count. A short read here is a truncated or lying archive,
/// and writing a partial `FlowMic.exe` while reporting success is precisely the
/// failure this whole window exists to prevent.
fn copy_exact(src: &mut dyn Read, out: &mut File, expected: u64, name: &str) -> Result<u64, UpdateFailure> {
    let mut limited = src.take(expected);
    let mut buf = vec![0u8; COPY_BUF];
    let mut written: u64 = 0;
    loop {
        let n = match limited.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(io_fail("inflate", &e)),
        };
        out.write_all(&buf[..n]).map_err(|e| io_fail("write", &e))?;
        written += n as u64;
    }
    if written != expected {
        return Err(UpdateFailure::ExtractFailed {
            detail: format!("short_entry:{name}:{written}/{expected}"),
        });
    }
    Ok(written)
}

/// Unpack every safe entry of `archive` into `dest`, preserving the archive's own
/// directory structure.
///
/// `dest` is created if missing. The archive's top-level directory is **kept** —
/// unpacking `FlowMic-portable/FlowMic.exe` into `dest` produces
/// `dest/FlowMic-portable/FlowMic.exe`. That is deliberate: `swap.rs` renames
/// that inner directory into place, and stripping the root here would mean this
/// function had to know the root's name, which is exactly the assumption
/// `archive.rs` went out of its way to make inexpressible.
///
/// 🔴 Refuses an archive with any unsafe entry name OUTRIGHT, before writing a
/// single byte — not per-entry as it goes. A traversal attempt is a property of
/// the package, and half-unpacking a hostile archive and then stopping leaves the
/// caller holding a tree it cannot reason about.
pub fn extract_into(archive: &Path, dest: &Path) -> Result<ExtractReport, UpdateFailure> {
    let reader = ZipReader::open(archive).map_err(|e| match e {
        ZipError::NotAZip => UpdateFailure::ArchiveUnreadable { detail: "not_a_zip".to_string() },
        ZipError::Corrupt(what) => UpdateFailure::ArchiveUnreadable { detail: format!("corrupt:{what}") },
        _ => UpdateFailure::ArchiveUnreadable { detail: "io".to_string() },
    })?;
    if !reader.refused_names().is_empty() {
        return Err(UpdateFailure::ArchiveUnsafeEntry { names: reader.refused_names().to_vec() });
    }
    // Entries are cloned out so the reader's file handle can be dropped: we do our
    // own positioned reads below, and holding two handles to one path while also
    // writing megabytes is a needless second thing to reason about.
    let entries: Vec<_> = reader.entries().to_vec();
    drop(reader);

    fs::create_dir_all(dest).map_err(|e| io_fail("mkdir", &e))?;
    let mut src = File::open(archive).map_err(|e| io_fail("open", &e))?;
    let mut report = ExtractReport::default();

    for e in &entries {
        let Some(out_path) = safe_join(dest, &e.name) else {
            // Unreachable through `ZipReader` (see `safe_join`). Named anyway —
            // an unreachable branch that returns a wrong answer is worse than one
            // that returns a right one.
            return Err(UpdateFailure::ArchiveUnsafeEntry { names: vec![e.name.clone()] });
        };
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| io_fail("mkdir", &err))?;
        }

        // Position at this entry's payload. The local header repeats the name and
        // extra fields with LENGTHS THAT MAY DIFFER from the central directory's,
        // so both are read from the local header itself rather than reused.
        src.seek(SeekFrom::Start(e.local_offset)).map_err(|err| io_fail("seek", &err))?;
        let mut lh = [0u8; LOCAL_HEADER_LEN];
        src.read_exact(&mut lh).map_err(|err| io_fail("header", &err))?;
        if le32(&lh, 0) != LOCAL_HEADER_SIG {
            return Err(UpdateFailure::ArchiveUnreadable {
                detail: format!("local_header:{}", e.name),
            });
        }
        let skip = u64::from(le16(&lh, 26)) + u64::from(le16(&lh, 28));
        src.seek(SeekFrom::Current(skip as i64)).map_err(|err| io_fail("seek", &err))?;

        let mut out = File::create(&out_path).map_err(|err| io_fail("create", &err))?;
        let written = match e.method {
            METHOD_STORE => copy_exact(&mut src, &mut out, e.size, &e.name)?,
            METHOD_DEFLATE => {
                // Raw DEFLATE — a zip member carries no zlib wrapper, so this is
                // `DeflateDecoder`, never `ZlibDecoder`. The latter would fail on
                // the first two bytes of every entry.
                let mut dec = flate2::read::DeflateDecoder::new(&mut src);
                copy_exact(&mut dec, &mut out, e.size, &e.name)?
            }
            // 🔴 An OPEN set read honestly. bzip2 / LZMA / zstd members are legal
            // zip and we cannot decode them; naming the method beats a generic
            // 「解压失败」("extraction failed"), because the action differs (this
            // one is 「the release
            // chain changed how it packs」, i.e. our bug, not the user's disk).
            other => {
                return Err(UpdateFailure::ArchiveCompressionUnsupported {
                    method: other,
                    entry: e.name.clone(),
                })
            }
        };
        out.flush().map_err(|err| io_fail("flush", &err))?;
        report.files += 1;
        report.bytes += written;
    }
    Ok(report)
}

#[cfg(test)]
#[path = "extract_tests.rs"]
mod tests;

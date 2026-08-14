// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (container), §5 (import),
//     §8 (streaming write + estimated size)
//   apps/desktop/src-tauri/src/socket/row_image.rs (the picture store this
//     module reads from on export and writes to on import — ONE writer)
//
// The file half of export / import: turn a list of already-serialised JSONL lines
// plus a set of row pictures into a `.zip`, and read one back.
//
// ── WHAT THIS MODULE DOES **NOT** DO ────────────────────────────────────────
//
// It never invents, parses or edits a record. The FPR line shaping lives in ONE
// place — apps/desktop/src/lib/portable/fpr.ts — because the fields come off the
// timeline rows, which live in the WebView's localStorage. Splitting the shaping
// across the bridge would give the format two authors, and this repo's #1 bug
// shape is precisely 「one thing, two answers」. So the lines arrive finished and are
// written VERBATIM.
//
// ── WHY THE BYTES STAY ON THIS SIDE ─────────────────────────────────────────
//
// The pictures are files (row_image), often hundreds of MB in total. Handing
// them to JS as base64 so JS could hand them back would triple them through the
// IPC boundary for no decision made on the way. Rust holds them the whole time;
// the frontend only ever names them.

use std::path::{Path, PathBuf};

use crate::forensic;
use crate::portable::zip::{crc32, Crc32, ZipError, ZipReader, ZipWriter};
use crate::socket::row_image;

/// The single JSONL member. One spelling, read by both directions.
pub const RECORDS_NAME: &str = "records.jsonl";
/// The human-readable member (§3 —「README.txt is not decoration」).
pub const README_NAME: &str = "README.txt";
/// The attachment directory prefix (§3).
pub const ATT_PREFIX: &str = "att/";

/// One picture to carry: which row it belongs to, and the name it takes inside
/// the archive (`att/<sha256-16>.<ext>` — the content hash the frontend already
/// asked for through [`digest_of`], so the LINE and the MEMBER cannot disagree).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Attachment {
    pub row_id: String,
    pub name: String,
}

/// What an export really produced. Every number is counted, never predicted —
/// the size is the finished file's own length off the filesystem.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportResult {
    pub path: String,
    pub records: usize,
    pub attachments: usize,
    pub bytes: u64,
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(315_532_800) // 1980-01-01, the DOS epoch floor
}

/// Write the archive. `lines` is the finished `records.jsonl`, one element per
/// line, header first.
///
/// 🔴 §8-1 streaming write: the JSONL body is written LINE BY LINE. The size and CRC are
/// pre-computed by walking the same list (see zip.rs `ZipWriter::begin` for why
/// they have to be known first) — walking is not concatenating, and no single
/// buffer holding the whole document is ever allocated. Attachments are written
/// one file at a time, so peak memory is ONE picture, not the whole album.
pub fn write_export(
    dest: &Path,
    lines: &[String],
    readme: &str,
    attachments: &[Attachment],
    picture_dir: &Path,
) -> Result<ExportResult, ZipError> {
    let now = unix_now();
    let mut w = ZipWriter::create(dest)?;

    // ── records.jsonl ──
    let mut size = 0u64;
    let mut crc = Crc32::new();
    for l in lines {
        crc.update(l.as_bytes());
        crc.update(b"\n");
        size += l.len() as u64 + 1;
    }
    w.begin(RECORDS_NAME, size, crc.finish(), now)?;
    for l in lines {
        w.body(l.as_bytes())?;
        w.body(b"\n")?;
    }
    w.end()?;

    // ── README.txt ──
    let rb = readme.as_bytes();
    w.begin(README_NAME, rb.len() as u64, crc32(rb), now)?;
    w.body(rb)?;
    w.end()?;

    // ── att/ ──
    // Deduped by NAME: the name IS the content hash, so two rows carrying the
    // same picture share one member (§3 「naturally deduped and idempotent」). Sorted so an export
    // of the same library twice produces the same member order — a diffable
    // artefact is worth more than the insertion order nobody can observe.
    let mut wanted: Vec<&Attachment> = attachments.iter().collect();
    wanted.sort_by(|a, b| a.name.cmp(&b.name));
    wanted.dedup_by(|a, b| a.name == b.name);
    let mut written = 0usize;
    for a in wanted {
        let Some(src) = row_image::find_in(picture_dir, &a.row_id) else {
            // Not fatal and not silent: the row's `attachment` field was decided
            // by the frontend from the digest call, so a picture that vanished
            // between those two moments is a real (if rare) event the log must
            // carry. The IMPORT side already has a named outcome for a row whose
            // attachment is not in the file (§5.2 one of four outcomes).
            forensic::record(
                "portable",
                &format!("export: row {} picture is gone, member skipped", a.row_id),
            );
            continue;
        };
        let bytes = match std::fs::read(&src) {
            Ok(b) => b,
            Err(e) => {
                forensic::record(
                    "portable",
                    &format!("export: row {} picture unreadable — {e}", a.row_id),
                );
                continue;
            }
        };
        w.begin(&a.name, bytes.len() as u64, crc32(&bytes), now)?;
        w.body(&bytes)?;
        w.end()?;
        written += 1;
    }
    w.finish()?;

    let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    let records = lines.len().saturating_sub(1); // the header is not a record
    forensic::record(
        "portable",
        &format!(
            "export wrote {} ({records} records, {written} pictures, {bytes} bytes)",
            dest.display()
        ),
    );
    Ok(ExportResult {
        path: dest.display().to_string(),
        records,
        attachments: written,
        bytes,
    })
}

/// What one archive holds, as far as the file layer can tell.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchiveRead {
    /// `records.jsonl`, split on newlines with blank lines dropped. The lines are
    /// NOT parsed here — see the module header.
    pub lines: Vec<String>,
    /// Member names under `att/` that are present.
    pub attachments: Vec<String>,
    /// Names the path-traversal guard refused (§3). Surfaced so the user is TOLD
    /// an archive tried it, rather than seeing a quietly smaller import.
    pub refused_names: Vec<String>,
}

/// Read `records.jsonl` + the attachment inventory out of an archive.
pub fn read_archive(src: &Path) -> Result<ArchiveRead, ZipError> {
    let mut r = ZipReader::open(src)?;
    let attachments: Vec<String> = r
        .entries()
        .iter()
        .filter(|e| e.name.starts_with(ATT_PREFIX) && e.size > 0)
        .map(|e| e.name.clone())
        .collect();
    let refused_names = r.refused_names().to_vec();
    let raw = r.read_entry(RECORDS_NAME)?;
    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.trim().is_empty())
        .collect();
    Ok(ArchiveRead { lines, attachments, refused_names })
}

/// One picture to restore: the member to take it from, and the row it belongs to.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Restore {
    pub name: String,
    pub row_id: String,
}

/// How the restore went. Both halves are counted so a partial result can SAY it
/// is partial (§5.2 red line).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RestoreResult {
    pub landed: usize,
    pub failed: usize,
}

fn mime_for(name: &str) -> Option<&'static str> {
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

/// Put the archive's pictures back where this PC keeps them.
///
/// 🔴 THE SECOND TRAVERSAL LAYER, AND THE STRUCTURAL ONE. The destination path
/// is never derived from the archive: it is built by `row_image::store_in` from
/// the ROW ID through its own `safe_stem` whitelist (`[A-Za-z0-9_.-]`, leading
/// dot neutralised), exactly as a delivered picture is. So even a member name
/// that somehow reached here could not address a directory — it only chooses
/// which BYTES are written, never WHERE.
///
/// Reusing `store_in` also buys the content check for free: it runs
/// `inject::image::validated_bytes`, so a member called `.png` that holds
/// something else never lands. The base64 hop is the price of that reuse and is
/// deliberate — see the call site.
pub fn restore_attachments(src: &Path, items: &[Restore], picture_dir: &Path) -> RestoreResult {
    let mut out = RestoreResult::default();
    let mut r = match ZipReader::open(src) {
        Ok(r) => r,
        Err(e) => {
            forensic::record("portable", &format!("import: archive unreadable — {}", e.detail()));
            out.failed = items.len();
            return out;
        }
    };
    for it in items {
        let Some(mime) = mime_for(&it.name) else {
            forensic::record(
                "portable",
                &format!("import: {} is not a picture name, skipped", it.name),
            );
            out.failed += 1;
            continue;
        };
        let bytes = match r.read_entry(&it.name) {
            Ok(b) => b,
            Err(e) => {
                forensic::record(
                    "portable",
                    &format!("import: {} not restored — {} {}", it.name, e.tag(), e.detail()),
                );
                out.failed += 1;
                continue;
            }
        };
        // The re-encode is on purpose. `store_in` is the ONE writer of this
        // product's row pictures — it owns the filename rule, the magic-byte
        // check and the temp+rename atomicity — and its input is base64 because
        // its other caller (`row_transit::mint_row`) receives base64 off the
        // wire. Adding a bytes-taking twin would be a second writer of the same
        // files, i.e. the defect this comment exists to avoid; the cost is one
        // picture's worth of string, transient, per row.
        if row_image::store_in(picture_dir, &it.row_id, &row_image::encode_b64(&bytes), mime) {
            out.landed += 1;
        } else {
            out.failed += 1;
        }
    }
    forensic::record(
        "portable",
        &format!("import restored {} picture(s), {} failed", out.landed, out.failed),
    );
    out
}

// ── the inventory's picture half (§6-2 byte counts, and §3's attachment names) ────

/// Size on disk of one row's picture (`None` = this row has none).
pub fn picture_bytes(picture_dir: &Path, row_id: &str) -> Option<u64> {
    let p = row_image::find_in(picture_dir, row_id)?;
    std::fs::metadata(&p).ok().map(|m| m.len())
}

/// What an attachment is called inside the archive, and how big it is.
///
/// The name is the CONTENT hash (§3) so identical pictures collapse to one
/// member and a re-export of the same library is byte-identical. Computed here
/// because the bytes are here.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Digest {
    pub id: String,
    /// The first 16 hex characters of the SHA-256 of the file's bytes.
    pub sha16: String,
    /// `png` / `jpg` / `webp`, taken from the stored file — never guessed.
    pub ext: String,
    pub bytes: u64,
}

pub fn digest_of(picture_dir: &Path, row_id: &str) -> Option<Digest> {
    let p: PathBuf = row_image::find_in(picture_dir, row_id)?;
    let bytes = std::fs::read(&p).ok()?;
    let ext = p.extension().and_then(|e| e.to_str())?.to_string();
    // ONE sha256 in this crate (pc_name.rs). A second implementation of a hash
    // is a second answer to 「are these two sets of bytes the same」.
    let d = crate::pc_name::sha256(&bytes);
    let sha16: String = d.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(Digest { id: row_id.to_string(), sha16, ext, bytes: bytes.len() as u64 })
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod archive_tests;

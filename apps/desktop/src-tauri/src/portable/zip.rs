// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (container = a single .zip;
//     「no absolute paths inside the zip, no `..`」 — the side reading the zip must guard against path traversal)
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §8-1 (streaming write: must
//     not assemble the entire records.jsonl string in memory before writing it out)
//
// A minimal ZIP container — write and read — with NO compression.
//
// ── WHY HAND-ROLLED, AND WHY STORE-ONLY ─────────────────────────────────────
//
// This crate's standing trade (Cargo.toml, R6 T-4「the card admits no new
// crates」; pc_name.rs「pulling one in for four hex characters is the wrong
// trade」) is to spend a hundred lines rather than take a dependency tree for a
// self-contained job. A STORE-only archive is a REAL zip: Explorer, 7-Zip and
// Python's `zipfile` all open it. What it is not is SMALL — and the two things
// in this product's export are already at their floor: `records.jsonl` is
// bounded by the timeline's own 1.5 M-character localStorage budget
// (lib/timeline-retention.ts), and the attachments are JPEG/PNG/WebP, which
// deflate cannot shrink.
//
// 🔴 THE COST IS STATED RATHER THAN HIDDEN: this reader understands method 0
// and NOTHING ELSE. A file a user unzipped and re-zipped with Explorer comes
// back DEFLATEd, and [`ZipReader::read_entry`] then answers a NAMED refusal
// ([`ZipError::Compressed`]) — never a silent skip, never a half-import.
//
// ── PATH TRAVERSAL (§3) ─────────────────────────────────────────────────────
//
// [`entry_name_is_safe`] is applied to EVERY central-directory entry as the
// archive is opened, and an unsafe name never becomes a readable entry at all —
// so nothing downstream can select it, by mistake or otherwise. That is the
// first of two layers; the second is that the extractor never joins an archive
// name to a path (it derives the destination from the ROW ID via
// `socket::row_image::safe_stem`), so even a name that slipped through could not
// address a directory. See archive.rs.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// What went wrong reading an archive. Every variant exists to be SAID to the
/// user — 「format error」 is exactly the unnamed refusal §5.2 forbids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError {
    /// The file could not be opened / read at all (permissions, gone, locked).
    Io(String),
    /// No End-Of-Central-Directory record: this is not a zip file.
    NotAZip,
    /// The central directory is truncated or self-inconsistent.
    Corrupt(&'static str),
    /// The entry is DEFLATEd (or any method other than STORE). Named on purpose
    /// — see the header.
    Compressed(String),
    /// The entry name could address something outside the archive root.
    UnsafeName(String),
    /// An entry the caller asked for is not in this archive.
    NoSuchEntry(String),
}

impl ZipError {
    /// A machine-readable tag the frontend maps to a sentence. Deliberately not a
    /// user string: this layer is locale-free (the copy lives in
    /// apps/desktop/src/lib/strings/portable.ts).
    pub fn tag(&self) -> &'static str {
        match self {
            ZipError::Io(_) => "io",
            ZipError::NotAZip => "not_a_zip",
            ZipError::Corrupt(_) => "corrupt",
            ZipError::Compressed(_) => "compressed",
            ZipError::UnsafeName(_) => "unsafe_name",
            ZipError::NoSuchEntry(_) => "no_such_entry",
        }
    }

    /// The detail half — a path, an OS error, a name. Shown verbatim beside the
    /// sentence (the openLogDirectory precedent: swallowing the reason is what
    /// makes a diagnostic unusable at the moment it is needed).
    pub fn detail(&self) -> String {
        match self {
            ZipError::Io(s) | ZipError::Compressed(s) | ZipError::UnsafeName(s)
            | ZipError::NoSuchEntry(s) => s.clone(),
            ZipError::NotAZip => String::new(),
            ZipError::Corrupt(s) => (*s).to_string(),
        }
    }
}

impl From<std::io::Error> for ZipError {
    fn from(e: std::io::Error) -> Self {
        ZipError::Io(e.to_string())
    }
}

// ── CRC-32 (IEEE, the one zip uses) ──────────────────────────────────────────

/// Streaming CRC-32 so a multi-chunk entry never has to be concatenated first
/// (§8-1 — the whole reason `records.jsonl` is written line by line).
#[derive(Debug, Clone, Copy)]
pub struct Crc32(u32);

impl Default for Crc32 {
    fn default() -> Self {
        Self::new()
    }
}

impl Crc32 {
    pub fn new() -> Self {
        Crc32(0xFFFF_FFFF)
    }
    pub fn update(&mut self, bytes: &[u8]) {
        let mut c = self.0;
        for &b in bytes {
            c ^= u32::from(b);
            for _ in 0..8 {
                // The bit-at-a-time form: no 1 KiB table to carry, and the
                // volumes here (a few MB) make the table's speed irrelevant.
                c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            }
        }
        self.0 = c;
    }
    pub fn finish(self) -> u32 {
        self.0 ^ 0xFFFF_FFFF
    }
}

/// One-shot CRC-32 of a whole buffer.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = Crc32::new();
    c.update(bytes);
    c.finish()
}

// ── entry names ──────────────────────────────────────────────────────────────

/// 🔴 THE PATH-TRAVERSAL GUARD (§3). `false` ⇒ the entry never becomes readable.
///
/// Refused: empty names, absolute names (`/x`, `\x`, `C:\x`), any name holding a
/// backslash (Windows separator — a zip is specified to use `/` only, so a `\`
/// is either malice or a broken writer), and any name with a `..` SEGMENT.
///
/// ⚠️ It tests SEGMENTS, not substrings: `..` is refused, `a/../b` is refused,
/// and a legitimate name like `att/..hidden.png` or `my..file.txt` is NOT — a
/// substring test would refuse real names and teach the next reader to loosen
/// the check, which is how these guards die.
pub fn entry_name_is_safe(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.contains('\\') || name.contains('\0') {
        return false;
    }
    if name.starts_with('/') {
        return false;
    }
    // `C:` / `c:` — a drive-qualified name is absolute on Windows even without a
    // separator (`C:records.jsonl` resolves against the drive's CWD).
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return false;
    }
    !name.split('/').any(|seg| seg == "..")
}

// ── writing ──────────────────────────────────────────────────────────────────

struct Central {
    name: String,
    crc: u32,
    size: u64,
    offset: u64,
    dos_time: u16,
    dos_date: u16,
}

/// A sequential STORE-only zip writer.
///
/// 🔴 SIZE AND CRC ARE DECLARED BEFORE THE BODY, ON PURPOSE. A zip local header
/// carries both, and the alternative (a data descriptor written afterwards)
/// needs no seek but IS the format's least-supported corner. Both callers can
/// state them up front cheaply: the JSONL is a list of lines whose lengths sum,
/// and an attachment is a file whose size the OS already knows. So the body is
/// still written CHUNK BY CHUNK ([`body`]) and never concatenated (§8-1).
pub struct ZipWriter {
    out: BufWriter<File>,
    offset: u64,
    entries: Vec<Central>,
    open: Option<Central>,
    written: u64,
}

fn dos_datetime(unix_secs: i64) -> (u16, u16) {
    // days → civil (Howard Hinnant). UTC: a zip has no timezone field, and
    // inventing a local offset would make the same export read as two different
    // times on two machines.
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    // DOS epoch is 1980; anything earlier clamps rather than wrapping into a
    // date that reads as the future.
    let year = if y < 1980 { 1980 } else { y };
    let date = (((year - 1980) as u16) << 9) | ((m as u16) << 5) | (d as u16);
    let (hh, mm, ss) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let time = ((hh as u16) << 11) | ((mm as u16) << 5) | ((ss / 2) as u16);
    (time, date)
}

impl ZipWriter {
    pub fn create(path: &Path) -> Result<Self, ZipError> {
        Ok(ZipWriter {
            out: BufWriter::new(File::create(path)?),
            offset: 0,
            entries: Vec::new(),
            open: None,
            written: 0,
        })
    }

    /// Start an entry. `size` and `crc` describe the bytes [`body`] is about to
    /// receive; [`end`] verifies the caller kept its word.
    pub fn begin(&mut self, name: &str, size: u64, crc: u32, unix_secs: i64) -> Result<(), ZipError> {
        if !entry_name_is_safe(name) {
            return Err(ZipError::UnsafeName(name.to_string()));
        }
        let (dos_time, dos_date) = dos_datetime(unix_secs);
        let nb = name.as_bytes();
        let mut h = Vec::with_capacity(30 + nb.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // local file header
        h.extend_from_slice(&20u16.to_le_bytes()); // version needed
        h.extend_from_slice(&0u16.to_le_bytes()); // flags (names are ASCII)
        h.extend_from_slice(&0u16.to_le_bytes()); // method = STORE
        h.extend_from_slice(&dos_time.to_le_bytes());
        h.extend_from_slice(&dos_date.to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        h.extend_from_slice(&(size as u32).to_le_bytes());
        h.extend_from_slice(&(size as u32).to_le_bytes());
        h.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // extra len
        h.extend_from_slice(nb);
        self.out.write_all(&h)?;
        self.open = Some(Central {
            name: name.to_string(),
            crc,
            size,
            offset: self.offset,
            dos_time,
            dos_date,
        });
        self.offset += h.len() as u64;
        self.written = 0;
        Ok(())
    }

    /// One chunk of the open entry's body.
    pub fn body(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        self.out.write_all(chunk)?;
        self.offset += chunk.len() as u64;
        self.written += chunk.len() as u64;
        Ok(())
    }

    /// Close the open entry. Refuses a body that does not match the declared
    /// size — a mismatch would produce an archive that opens and then hands out
    /// wrong bytes, which is worse than a failed export (no silent failures).
    pub fn end(&mut self) -> Result<(), ZipError> {
        let e = self.open.take().ok_or(ZipError::Corrupt("end without begin"))?;
        if self.written != e.size {
            return Err(ZipError::Corrupt("declared size did not match the body"));
        }
        self.entries.push(e);
        Ok(())
    }

    /// Central directory + EOCD.
    pub fn finish(mut self) -> Result<(), ZipError> {
        if self.open.is_some() {
            return Err(ZipError::Corrupt("finish with an entry still open"));
        }
        let cd_start = self.offset;
        for e in &self.entries {
            let nb = e.name.as_bytes();
            let mut h = Vec::with_capacity(46 + nb.len());
            h.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // central header
            h.extend_from_slice(&20u16.to_le_bytes()); // version made by
            h.extend_from_slice(&20u16.to_le_bytes()); // version needed
            h.extend_from_slice(&0u16.to_le_bytes()); // flags
            h.extend_from_slice(&0u16.to_le_bytes()); // method = STORE
            h.extend_from_slice(&e.dos_time.to_le_bytes());
            h.extend_from_slice(&e.dos_date.to_le_bytes());
            h.extend_from_slice(&e.crc.to_le_bytes());
            h.extend_from_slice(&(e.size as u32).to_le_bytes());
            h.extend_from_slice(&(e.size as u32).to_le_bytes());
            h.extend_from_slice(&(nb.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            h.extend_from_slice(&0u16.to_le_bytes()); // comment
            h.extend_from_slice(&0u16.to_le_bytes()); // disk
            h.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            h.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            h.extend_from_slice(&(e.offset as u32).to_le_bytes());
            h.extend_from_slice(nb);
            self.out.write_all(&h)?;
            self.offset += h.len() as u64;
        }
        let cd_size = self.offset - cd_start;
        let n = self.entries.len() as u16;
        let mut eocd = Vec::with_capacity(22);
        eocd.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // this disk
        eocd.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
        eocd.extend_from_slice(&n.to_le_bytes());
        eocd.extend_from_slice(&n.to_le_bytes());
        eocd.extend_from_slice(&(cd_size as u32).to_le_bytes());
        eocd.extend_from_slice(&(cd_start as u32).to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // comment len
        self.out.write_all(&eocd)?;
        self.out.flush()?;
        Ok(())
    }
}

// ── reading ──────────────────────────────────────────────────────────────────

/// One readable entry.
#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub size: u64,
    pub local_offset: u64,
}

/// A STORE-only zip reader.
pub struct ZipReader {
    file: BufReader<File>,
    entries: Vec<ZipEntry>,
    /// Names the central directory held that [`entry_name_is_safe`] refused.
    /// Kept rather than dropped: an archive carrying a traversal attempt is a
    /// thing the user must be TOLD about, not a thing we quietly ignore.
    refused: Vec<String>,
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

impl ZipReader {
    pub fn open(path: &Path) -> Result<Self, ZipError> {
        let f = File::open(path)?;
        let len = f.metadata()?.len();
        let mut file = BufReader::new(f);
        // EOCD is at most 22 + 65535 bytes from the end (the trailing comment).
        let tail_len = len.min(22 + 65_535) as usize;
        if tail_len < 22 {
            return Err(ZipError::NotAZip);
        }
        file.seek(SeekFrom::Start(len - tail_len as u64))?;
        let mut tail = vec![0u8; tail_len];
        file.read_exact(&mut tail)?;
        let eocd = (0..=tail_len - 22)
            .rev()
            .find(|&i| le32(&tail, i) == 0x0605_4b50)
            .ok_or(ZipError::NotAZip)?;
        let count = le16(&tail, eocd + 10) as usize;
        let cd_size = le32(&tail, eocd + 12) as usize;
        let cd_offset = u64::from(le32(&tail, eocd + 16));
        if cd_offset + cd_size as u64 > len {
            return Err(ZipError::Corrupt("central directory runs past the file"));
        }
        file.seek(SeekFrom::Start(cd_offset))?;
        let mut cd = vec![0u8; cd_size];
        file.read_exact(&mut cd)?;

        let mut entries = Vec::with_capacity(count);
        let mut refused = Vec::new();
        let mut p = 0usize;
        for _ in 0..count {
            if p + 46 > cd.len() || le32(&cd, p) != 0x0201_4b50 {
                return Err(ZipError::Corrupt("central directory entry is malformed"));
            }
            let method = le16(&cd, p + 10);
            let size = u64::from(le32(&cd, p + 24));
            let n = le16(&cd, p + 28) as usize;
            let extra = le16(&cd, p + 30) as usize;
            let comment = le16(&cd, p + 32) as usize;
            let local_offset = u64::from(le32(&cd, p + 42));
            if p + 46 + n > cd.len() {
                return Err(ZipError::Corrupt("central directory entry name runs past the record"));
            }
            let name = String::from_utf8_lossy(&cd[p + 46..p + 46 + n]).into_owned();
            p += 46 + n + extra + comment;
            // 🔴 §3 — refused HERE, before the name can be looked up by anything.
            if !entry_name_is_safe(&name) {
                refused.push(name);
                continue;
            }
            // Directory markers carry no bytes and are not entries anyone reads.
            if name.ends_with('/') {
                continue;
            }
            entries.push(ZipEntry { name, method, size, local_offset });
        }
        Ok(ZipReader { file, entries, refused })
    }

    /// Every SAFE entry, in central-directory order.
    pub fn entries(&self) -> &[ZipEntry] {
        &self.entries
    }

    /// Names refused by [`entry_name_is_safe`] — reported, never silent.
    pub fn refused_names(&self) -> &[String] {
        &self.refused
    }

    /// One entry's bytes. `Compressed` for any method other than STORE.
    pub fn read_entry(&mut self, name: &str) -> Result<Vec<u8>, ZipError> {
        let e = self
            .entries
            .iter()
            .find(|e| e.name == name)
            .cloned()
            .ok_or_else(|| ZipError::NoSuchEntry(name.to_string()))?;
        if e.method != 0 {
            return Err(ZipError::Compressed(name.to_string()));
        }
        self.file.seek(SeekFrom::Start(e.local_offset))?;
        let mut lh = [0u8; 30];
        self.file.read_exact(&mut lh)?;
        if le32(&lh, 0) != 0x0403_4b50 {
            return Err(ZipError::Corrupt("local header signature missing"));
        }
        let skip = u64::from(le16(&lh, 26)) + u64::from(le16(&lh, 28));
        self.file.seek(SeekFrom::Current(skip as i64))?;
        let mut buf = vec![0u8; e.size as usize];
        self.file.read_exact(&mut buf)?;
        Ok(buf)
    }
}

#[cfg(test)]
#[path = "zip_tests.rs"]
mod zip_tests;

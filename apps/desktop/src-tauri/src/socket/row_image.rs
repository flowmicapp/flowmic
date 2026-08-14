// SPEC-REF:
//   docs/decisions/2026-08-01-image-two-sizes-both-ends.md (owner's dictated final
//     decision: "On the PC, its timeline should also show a small thumbnail similar
//       to the one on the phone; opening it should also show the actual usable
//       picture that was sent over" ⇒ each end gets two sizes)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//     ("passes through but is not stored" binds the **SERVER**; the PC has owned its own timeline since 0.2.26)
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (timeline persistence)
//
// Size B ON THE PC: the delivered picture, kept on disk so opening the full image has something
// to show.
//
// ── WHY A FILE AND NOT A FIELD ON THE ROW ────────────────────────────────────
//
// The timeline row is persisted in the WebView's localStorage, whose whole budget
// for EVERY row is 1.5 M characters (lib/timeline-retention.ts MAX_CHARS), while
// ONE `image_b64` may be 5.5 M. Putting the picture on the row would not be a
// tight fit, it would be structurally impossible — the first screenshot would
// evict the entire timeline. So the bytes live beside the forensic log, in the
// one directory this product already points users at, and the row carries a
// single boolean saying whether they are there.
//
// ── 🔴 THIS DOES NOT VIOLATE "passes through but is not stored" ────────────────────────────────────
// That ruling binds the SERVER / relay (doc 15 §1.1). This PC has owned its
// timeline rows since 0.2.26 and already stores every one of them locally;
// storing the picture a row IS, is the same act, not a new category. Written here
// because it is the first question the next reader will have.
//
// ── WHAT IS WRITTEN, AND WHEN ────────────────────────────────────────────────
// The decoded bytes, AFTER `validated_bytes` has agreed the payload is a real
// picture of the declared mime — so a junk frame can never leave a junk file
// behind, and the file's extension is never a guess. Written from `mint_row`,
// i.e. once per row, on the same frame that produced the row.
//
// ⚠️ DELETION IS THE FRONTEND'S CALL, and there is exactly one deleter
// ([`drop_ids`], reached from `TimelineStore.evict` through the
// `timeline_images_drop` command). The rule is the one the timeline already has:
// **a row that is trimmed takes its picture with it.** That is existing behaviour
// (owner ② bounded trimming + persisted cutoff), not a new silent delete — nothing here
// expires, caps or sweeps on its own, because a picture disappearing while its
// row is still on screen would be "no silent failures"'s storage face.

use std::path::{Path, PathBuf};

use crate::forensic;
use crate::inject::image::{validated_bytes, ImageError, ImageMime};

/// The directory, beside the forensic log: `%LOCALAPPDATA%\FlowMic\timeline-images`.
/// One directory the user can be pointed at, and one the pull-cable smoke can
/// redirect with `FLOWMIC_FORENSIC_PATH` like everything else this product writes.
///
/// 🔴 UNDER `cargo test` IT IS A TEMP DIRECTORY, AND THAT IS NOT A CONVENIENCE.
/// `mint_row` writes a picture for every image frame it mints, and the row-transit
/// suite mints plenty — without this, running the tests would deposit files in the
/// developer's REAL `%LOCALAPPDATA%\FlowMic`, and (worse) a test could pass because
/// of a file an earlier run left there. The env-var route was rejected on purpose:
/// `set_var` is racy across the parallel test threads in one binary, so a test that
/// redirected the path would make the redirection itself the flake.
///
/// The production expression is therefore covered by exactly one assertion — see
/// `row_image_tests::the_production_directory_sits_beside_the_forensic_log`.
pub fn dir() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join("flowmic-test-timeline-images")
    }
    #[cfg(not(test))]
    {
        forensic::sibling_path(DIR_NAME)
    }
}

/// The one spelling of the directory name.
pub const DIR_NAME: &str = "timeline-images";

fn ext_of(mime: ImageMime) -> &'static str {
    match mime {
        ImageMime::Png => "png",
        ImageMime::Jpeg => "jpg",
        ImageMime::Webp => "webp",
    }
}

/// A row id turned into a file name.
///
/// ⚠️ THE KEY IS THE ROW **ID**, NOT ITS FULL ADDRESS. The frontend addresses a row by
/// `(channel, id)` because the two servers mint ids independently (RV-01), so in
/// principle two rows could share this file. In practice they cannot: a minted row's
/// id is `req:<request_id>`, and a `request_id` carries the phone's own microsecond
/// clock (`manual_delivery.dart` `mintRequestId`). Stated rather than assumed, because
/// if it ever DID collide the symptom is one picture showing under another row's
/// caption — and the fix would be to key this by the address, not to guess.
///
/// 🔴 SANITISED BECAUSE IT REACHES A FILESYSTEM. Row ids are minted here
/// (`req:<request_id>` / a phone's `entry_id` / `local:<ms>-<n>`), and the middle
/// one is a string a REMOTE PEER chose: `..` or a separator in it must not be
/// able to address a path outside [`dir`]. Everything outside `[A-Za-z0-9_.-]`
/// becomes `_`, and a leading dot is neutralised too (no hidden files, no `..`).
fn safe_stem(row_id: &str) -> String {
    let mut s: String = row_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect();
    if s.starts_with('.') {
        s.insert(0, '_');
    }
    if s.is_empty() {
        s.push('_');
    }
    s
}

fn path_in(base: &Path, row_id: &str, mime: ImageMime) -> PathBuf {
    base.join(format!("{}.{}", safe_stem(row_id), ext_of(mime)))
}

/// The three extensions [`store_in`] can produce — what [`find_in`] probes.
/// A row does not carry its mime (the wire history shape has no such field), so
/// the reader asks the filesystem instead of a second remembered value.
const EXTS: [&str; 3] = ["png", "jpg", "webp"];

/// WHICH filesystem step refused. Not a distinction the USER needs — free space
/// and write permission are the instruction for all three — but the one the
/// person diagnosing it needs: "this machine can't even create the directory", "can't write these bytes" and
/// "wrote it but couldn't move it into place" are three different machines to look at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskStage {
    /// `create_dir_all` on the pictures directory.
    Mkdir,
    /// The bytes could not be written to the `.part` file.
    Write,
    /// The finished `.part` could not be moved onto its real name.
    Rename,
}

impl DiskStage {
    /// The verb the forensic line has carried since RV-93. ONE producer, so the
    /// log and this enum cannot drift into two vocabularies for one event.
    fn verb(self) -> &'static str {
        match self {
            DiskStage::Mkdir => "mkdir",
            DiskStage::Write => "write",
            DiskStage::Rename => "rename",
        }
    }
}

/// WHY a picture was not kept — the fact a bare `false` destroyed.
///
/// 🔴 TWO VARIANTS BECAUSE THERE ARE TWO ANSWERS, not because there are two code
/// paths. The split is the product decision this type carries, put in the SHAPE
/// of the type rather than in a comment, so the layer that has to speak to the
/// user cannot give one of them the other's sentence by accident:
///
///   · [`StoreFailure::Disk`] is exactly what `PC_IMAGE_STORE_FAILED` describes
///     (packages/protocol/src/error-codes.ts): "The picture has already been
///     delivered to the PC, but the PC failed to save it… please check the PC's
///     disk space and write permission". Free space and write permission really
///     are the causes, and they really are the user's to fix.
///   · [`StoreFailure::Payload`] must NOT be told that sentence. These bytes were
///     never a picture of the declared mime, so they would fail to store on an
///     empty disk with every permission granted — sending that user to clear space
///     is advice that cannot work. A true underlying fact under a false sentence is
///     the reuse shape this repo has paid for twice (0.2.18 `PC_BUSY`, and the
///     `SETTINGS_SCHEMA_INVALID` note in error-codes.ts). When the pipeline ran, that
///     case already HAS its own answer: `INJECT_IMAGE_UNSUPPORTED`, refused in
///     `inject/pipeline.rs` `inject_image_with_probe` before any focus switch.
///
/// ⚠️ 「ALREADY HAS ITS OWN ANSWER」 IS NOT 「ALWAYS」 — measured 2026-08-10, and it
/// corrects the sentence that used to sit on the validation arm below (*「It can
/// only fire for a payload the inject path itself rejected, so it doubles as a
/// cross-check on that path」*). `mint_row` also runs on outcomes the pipeline never
/// produced: a deferred-delivery refusal returns `INJECT_DEFERRED_NOT_AUTOINJECTED` from
/// `socket/inject_ops.rs` **before** `clipboard_formats` is ever called, and a
/// non-primary-channel refusal (`socket/client.rs`) never enters the pipeline at
/// all. On those frames a junk payload reaches this store with nothing behind it.
/// So the Payload arm is not only a cross-check; it can be the only place a bad
/// payload is ever noticed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreFailure {
    /// Refused before anything was written — see [`validated_bytes`].
    Payload(ImageError),
    /// This PC's filesystem refused at `stage`, on `path`, with `err`.
    Disk {
        stage: DiskStage,
        path: PathBuf,
        err: String,
    },
}

impl StoreFailure {
    /// The one-line detail the forensic log carries — the four strings that ARE
    /// the diagnosis.
    ///
    /// A PURE function for the same reason `row_transit::minted_line` is one:
    /// `forensic::record` writes to a sink that is a no-op under `cargo test`, so a
    /// reason formatted inline is a reason no test can read.
    pub fn reason(&self) -> String {
        match self {
            StoreFailure::Payload(e) => e.reason(),
            StoreFailure::Disk { stage, path, err } => {
                format!("{} {}: {err}", stage.verb(), path.display())
            }
        }
    }
}

/// What one store attempt DID.
///
/// 🔴 WHY IT IS WIDER THAN THE BOOLEAN ITS CALLERS TAKE (R11, IMG-1). The layer
/// that has to decide what to tell the user is `row_transit::build_row`, and the
/// only fact that ever reached it was `false` — so it could not have told "this
/// picture was never a picture to begin with" from "this PC's disk can't write it" even if it wanted to. The forensic lines
/// have always drawn that distinction, which means the information existed and was
/// destroyed at the return: the layer making this judgment did not have in hand the fact it needed to make it.
/// It is not destroyed now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreOutcome {
    /// On disk, at this path.
    Kept(PathBuf),
    NotKept(StoreFailure),
}

impl StoreOutcome {
    /// The old answer, unchanged — "are the bytes on disk".
    pub fn kept(&self) -> bool {
        matches!(self, StoreOutcome::Kept(_))
    }
}

/// The write itself. Split out so [`store_outcome_in`] has exactly ONE place that
/// records, instead of four that have to be kept saying the same thing.
///
/// Not fatal whatever happens here: the picture was already TYPED (this runs after
/// the inject), so the delivery is unaffected — only the row's full-image view is.
fn attempt_store(
    base: &Path,
    row_id: &str,
    b64: &str,
    mime_wire: &str,
) -> Result<PathBuf, StoreFailure> {
    let (mime, bytes) = validated_bytes(b64, mime_wire).map_err(StoreFailure::Payload)?;
    std::fs::create_dir_all(base).map_err(|e| StoreFailure::Disk {
        stage: DiskStage::Mkdir,
        path: base.to_path_buf(),
        err: e.to_string(),
    })?;
    let path = path_in(base, row_id, mime);
    // Write to a temp name and rename: a crash midway would otherwise leave a
    // TRUNCATED picture at the real path, and the row would claim a picture that
    // renders as a broken frame. Rename is atomic on Windows for same-directory
    // moves. (Same discipline as the phone's FileOutboxBlobStore.)
    let tmp = path.with_extension(format!("{}.part", ext_of(mime)));
    std::fs::write(&tmp, &bytes).map_err(|e| StoreFailure::Disk {
        stage: DiskStage::Write,
        path: tmp.clone(),
        err: e.to_string(),
    })?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // The half-written name goes with the failure: a `.part` left in the
        // pictures directory is a file no reader ever probes (see [`EXTS`]) and no
        // deleter ever removes (`drop_in` finds rows, not fragments).
        let _ = std::fs::remove_file(&tmp);
        return Err(StoreFailure::Disk {
            stage: DiskStage::Rename,
            path,
            err: e.to_string(),
        });
    }
    Ok(path)
}

/// Pure form of [`store_outcome`] — the base directory is a parameter so this is
/// provable under `cargo test` without touching `%LOCALAPPDATA%`.
///
/// The ONE place a store failure is recorded, and the one place the widened answer
/// is built.
pub fn store_outcome_in(base: &Path, row_id: &str, b64: &str, mime_wire: &str) -> StoreOutcome {
    match attempt_store(base, row_id, b64, mime_wire) {
        Ok(path) => StoreOutcome::Kept(path),
        Err(failure) => {
            // no silent failures: the same greppable line RV-93 has always written, word for
            // word — this card widened what the RETURN carries, not what the log says.
            forensic::record(
                "timeline",
                &format!("row {row_id} picture NOT kept — {}", failure.reason()),
            );
            StoreOutcome::NotKept(failure)
        }
    }
}

/// Pure form of [`store`] — the base directory is a parameter so this is provable
/// under `cargo test` without touching `%LOCALAPPDATA%`.
///
/// Returns whether the bytes are ON DISK. **The caller must put that answer on the
/// row rather than assuming success**: a row claiming a picture it does not have
/// would offer a full-image view that opens nothing, which is the "a control that
/// changes nothing" shape this repo keeps paying for.
///
/// ⚠️ THIS IS A NARROWING OF [`store_outcome_in`], and it is deliberate rather than
/// left over: two callers outside this module ask exactly the yes/no question
/// (`socket/row_transit.rs` `build_row`, `portable/archive.rs`
/// `restore_attachments`). Everything they discard is on the outcome.
pub fn store_in(base: &Path, row_id: &str, b64: &str, mime_wire: &str) -> bool {
    store_outcome_in(base, row_id, b64, mime_wire).kept()
}

/// Keep one delivered picture for `row_id`. See [`store_in`] for the contract.
pub fn store(row_id: &str, b64: &str, mime_wire: &str) -> bool {
    store_outcome(row_id, b64, mime_wire).kept()
}

/// Keep one delivered picture, and say WHAT HAPPENED rather than merely whether.
pub fn store_outcome(row_id: &str, b64: &str, mime_wire: &str) -> StoreOutcome {
    store_outcome_in(&dir(), row_id, b64, mime_wire)
}

/// Pure form of [`find`].
pub fn find_in(base: &Path, row_id: &str) -> Option<PathBuf> {
    let stem = safe_stem(row_id);
    for ext in EXTS {
        let p = base.join(format!("{stem}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Where this row's picture is, or None.
pub fn find(row_id: &str) -> Option<PathBuf> {
    find_in(&dir(), row_id)
}

/// Pure form of [`drop_ids`] — returns how many files were removed.
pub fn drop_in(base: &Path, row_ids: &[String]) -> usize {
    let mut n = 0;
    for id in row_ids {
        if let Some(p) = find_in(base, id) {
            if std::fs::remove_file(&p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// Remove the pictures of rows the timeline has trimmed. The ONLY deleter — see
/// the header for why nothing else may expire a picture.
pub fn drop_ids(row_ids: &[String]) -> usize {
    let n = drop_in(&dir(), row_ids);
    if n > 0 {
        forensic::record(
            "timeline",
            &format!("{n} trimmed row picture(s) removed with their rows"),
        );
    }
    n
}

// ── base64 back out, for the WebView ─────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Canonical base64. Zero new crates, same rule as `image::decode_b64` reads —
/// and `decode_b64(encode_b64(x)) == x` is asserted in the tests, which is what
/// makes the pair trustworthy rather than two independent guesses.
pub fn encode_b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let acc = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(acc >> 18) as usize & 63] as char);
        out.push(B64[(acc >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(acc >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[acc as usize & 63] as char } else { '=' });
    }
    out
}

/// Pure form of [`data_url`].
pub fn data_url_in(base: &Path, row_id: &str) -> Option<String> {
    let path = find_in(base, row_id)?;
    let bytes = std::fs::read(&path).ok()?;
    // The mime comes from the file's own extension, which [`store_in`] only ever
    // wrote after `validated_bytes` agreed the magic bytes matched it. One
    // producer, so the `data:` prefix cannot disagree with the payload.
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", encode_b64(&bytes)))
}

/// The row's picture as a `data:` URL the WebView can put straight in an `<img>`,
/// or None when this row has none.
///
/// A data URL rather than raw bytes because the consumer is an `<img src>`: the
/// alternative (bytes over IPC, then a Blob URL) adds a lifetime to manage in the
/// page for no gain, and the IPC cost is the same base64 either way.
pub fn data_url(row_id: &str) -> Option<String> {
    data_url_in(&dir(), row_id)
}

#[cfg(test)]
#[path = "row_image_tests.rs"]
mod row_image_tests;

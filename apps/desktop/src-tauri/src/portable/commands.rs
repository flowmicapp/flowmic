// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5 / §6 / §7 / §8
//
// The IPC surface of export / import. Deliberately THIN, like shell/timeline_images.rs:
// nothing here decides anything. The rules live in archive.rs (files), dialog.rs
// (where the user chose) and, for everything about the FORMAT, in
// apps/desktop/src/lib/portable/ on the other side of the bridge.
//
// ⚠️ EVERY COMMAND ANSWERS WITH A VERDICT, NOT AN EXCEPTION. A `Result::Err` out
// of a Tauri command reaches the frontend as a rejected promise, and this repo's
// own `invokeSafe` folds every rejection into `undefined` + a console.warn —
// which is exactly how a reason gets lost (see bridge.ts openLogDirectory's note
// on why it bypasses that helper). So failures travel as DATA: a tag the page
// turns into a sentence, plus the detail shown verbatim beside it.

use crate::portable::archive::{self, ArchiveRead, Attachment, ExportResult, Restore, RestoreResult};
use crate::portable::dialog;
use crate::portable::zip::ZipError;
use crate::socket::row_image;

/// One row's picture size — the inventory's (§6-2) image half.
#[derive(serde::Serialize)]
pub struct PictureSize {
    pub id: String,
    pub bytes: u64,
}

/// The bytes on disk for each row that has a picture. Rows with none are simply
/// absent from the answer (never a `0`, which would read as 「has a picture but
/// it's empty」).
///
/// 🔴 THIS IS WHAT MAKES 「the estimated size」 A REAL NUMBER (§8-2). It is `metadata().len()`
/// of files this machine wrote — not a guess from a thumbnail, not an average.
#[tauri::command]
pub fn portable_picture_sizes(ids: Vec<String>) -> Vec<PictureSize> {
    let dir = row_image::dir();
    ids.into_iter()
        .filter_map(|id| archive::picture_bytes(&dir, &id).map(|bytes| PictureSize { id, bytes }))
        .collect()
}

/// Content hash + extension + size for each row that has a picture — what the
/// frontend needs to write `attachment: "att/<sha16>.<ext>"` on the record line
/// BEFORE the archive is written, so the line and the member always agree.
#[tauri::command]
pub fn portable_picture_digests(ids: Vec<String>) -> Vec<archive::Digest> {
    let dir = row_image::dir();
    ids.iter().filter_map(|id| archive::digest_of(&dir, id)).collect()
}

/// P2 (2026-09-02 audit): the raw HWND of the app's main window, or `0` when it
/// cannot be found — `dialog::pick`'s `owner_hwnd` treats `0` as "no owner",
/// exactly the behaviour every caller got before this fix existed, so a lookup
/// failure degrades to the old behaviour rather than a new one.
///
/// 🔴 CORRECTED IN PLACE (2026-09-02, mac-side `cargo test --features app` run):
/// `tauri::WebviewWindow::hwnd()` only exists on Windows, so an ungated call
/// here failed the whole crate to build (`E0599`) on macOS/Linux — a break
/// Windows gates cannot see because they never compile the other half. The
/// non-Windows twin below exists solely to give every platform a build;
/// `dialog::pick`'s own non-Windows arm already ignores the value it receives.
#[cfg(windows)]
fn main_window_hwnd(app: &tauri::AppHandle) -> isize {
    use tauri::Manager;
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn main_window_hwnd(_app: &tauri::AppHandle) -> isize {
    0
}

/// The user picks the destination (§7-2). `None` = cancelled — a normal answer.
#[tauri::command]
pub fn portable_pick_save(
    app: tauri::AppHandle,
    title: String,
    filter: String,
    suggested: String,
) -> Option<String> {
    dialog::save_as(&title, &filter, &suggested, main_window_hwnd(&app))
}

/// The user picks the archive to import. `None` = cancelled.
#[tauri::command]
pub fn portable_pick_open(app: tauri::AppHandle, title: String, filter: String) -> Option<String> {
    dialog::open(&title, &filter, main_window_hwnd(&app))
}

/// A verdict shape shared by the two commands that can fail on the file layer.
#[derive(serde::Serialize)]
pub struct Outcome<T> {
    pub ok: bool,
    pub value: Option<T>,
    /// Machine tag (`io` / `not_a_zip` / `corrupt` / `compressed` / …). The page
    /// owns the sentence; this side stays locale-free.
    pub error: Option<String>,
    /// The detail, shown verbatim — a path, an OS message, a member name.
    pub detail: Option<String>,
}

impl<T> Outcome<T> {
    fn ok(v: T) -> Self {
        Outcome { ok: true, value: Some(v), error: None, detail: None }
    }
    fn err(e: &ZipError) -> Self {
        Outcome {
            ok: false,
            value: None,
            error: Some(e.tag().to_string()),
            detail: Some(e.detail()),
        }
    }
}

/// Write the archive the frontend has finished shaping.
#[tauri::command]
pub fn portable_export(
    path: String,
    lines: Vec<String>,
    readme: String,
    attachments: Vec<Attachment>,
) -> Outcome<ExportResult> {
    let dir = row_image::dir();
    match archive::write_export(std::path::Path::new(&path), &lines, &readme, &attachments, &dir) {
        Ok(r) => Outcome::ok(r),
        Err(e) => {
            crate::forensic::record(
                "portable",
                &format!("export FAILED — {} {}", e.tag(), e.detail()),
            );
            Outcome::err(&e)
        }
    }
}

/// Read `records.jsonl` + the attachment inventory back out of an archive.
#[tauri::command]
pub fn portable_read_archive(path: String) -> Outcome<ArchiveRead> {
    match archive::read_archive(std::path::Path::new(&path)) {
        Ok(r) => Outcome::ok(r),
        Err(e) => {
            crate::forensic::record(
                "portable",
                &format!("import read FAILED — {} {}", e.tag(), e.detail()),
            );
            Outcome::err(&e)
        }
    }
}

/// Put the imported rows' pictures where this PC keeps them. Runs AFTER the
/// frontend has decided which rows are actually new, so a re-import writes no
/// files it does not need (§5.1 idempotency covers the bytes as well as the rows).
#[tauri::command]
pub fn portable_restore_pictures(path: String, items: Vec<Restore>) -> RestoreResult {
    archive::restore_attachments(std::path::Path::new(&path), &items, &row_image::dir())
}

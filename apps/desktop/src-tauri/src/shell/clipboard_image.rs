// SPEC-REF:
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §2-③ step 4
//     (card IMG-COPY, owner P0: the capsule must copy the PICTURE, and the
//     command that does it must NOT reuse the injection clipboard path)
//   shell/clipboard_copy.rs — the sibling TEXT command whose posture (native
//     write, no document-focus dependency, no snapshot/restore) this copies
//   socket/row_image.rs — where the delivered picture lives on disk
//   inject/image.rs — the PURE helpers borrowed here (`pack_dib`,
//     `decode_pixels`, `registered_png_format`, `validated_bytes`)
//
// The capsule's per-row COPY-IMAGE command.
//
// ── WHY A NEW COMMAND, AND WHY IT MUST NOT BE THE INJECTION PATH ────────────
// The capsule's existing copy goes `capsule_copy_text` → Win32 with a STRING
// payload; a picture has no string. The injection layer does know how to put
// a picture on the clipboard — but that path is the paste-hold / readback /
// withdraw machinery (`clipboard_hold.rs`, `clipboard_confirm.rs`,
// `clipboard_withdraw.rs`, `PASTE_LOCK`) whose restore race shipped a P0 in
// 0.3.26 / 0.3.27. A copy button is not an injection: nothing is pasted,
// nothing is held, nothing is read back, nothing is restored. So this command
// owns exactly one thing — a forward write of the picture's clipboard formats —
// and imports only the PURE helpers from `inject::image` (bytes → DIB table).
// It never touches `clipboard_paste`, never takes `PASTE_LOCK`, never snapshots.
//
// ── WHY THE CAPSULE CANNOT USE THE BROWSER CLIPBOARD API ───────────────────
// Same reason as clipboard_copy.rs: the capsule window carries
// WS_EX_NOACTIVATE and the Async Clipboard API needs `document.hasFocus()`.
// The main window still uses the browser API for its own copy (TimelinePage);
// whether that one is ever refused there is an open question this card was
// told to report, not assume — nothing here changes it.
//
// ── WHAT GETS WRITTEN ──────────────────────────────────────────────────────
// The ORIGINAL delivered bytes, read from `row_image::find` (never a copy
// re-encoded from pixels): under the registered `PNG` format when the file is
// a PNG — byte for byte, alpha intact — plus a CF_DIB rendition decoded through
// WIC and flattened onto white (`pack_dib`), for consumers that only read DIB.
// When the row has no original on disk, the 256 px thumbnail the caller hands
// over (base64) is written the same way, and the result names which one was
// used — 「原图」 vs 「预览图」 is a fact the user is entitled to.
//
// 🔴 THE BYTE PROMISE IS PINNED BY A TEST: `image_formats_in` is pure over a
// base directory, and its PNG entry is asserted equal to the file's bytes.

use std::path::Path;

use crate::inject::image::{validated_bytes, ImageError, ImageMime};
// 🔴 Windows-only, and the compiler only says so on the OTHER platform. Every
// user of these four is Windows-gated — the `image_formats_in` clipboard table
// and the single gated test that reads it back. Imported unconditionally they
// are dead on macOS/Linux, and `-D warnings` turns that into `could not
// compile`. The Windows gate cannot see it: there they are used, so it is green
// either way. (Prose deliberately does not spell the attribute out —
// platform-cfg-count regexes raw source, so a mention would inflate the very
// count that is supposed to mean "how many branches do not compile here".)
#[cfg(target_os = "windows")]
use crate::inject::image::{decode_pixels, pack_dib, registered_png_format, CF_DIB_U32};
use crate::socket::row_image;

/// Which picture ended up on the clipboard — reported to the page so the row
/// can say so (a copy of the preview must not read as a copy of the original).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopiedImage {
    Original,
    Thumbnail,
}

impl CopiedImage {
    fn wire(self) -> &'static str {
        match self {
            CopiedImage::Original => "original",
            CopiedImage::Thumbnail => "thumbnail",
        }
    }
}

fn mime_of_path(path: &Path) -> Option<ImageMime> {
    // The extension was written by `row_image::store_in` only after
    // `validated_bytes` agreed the magic bytes matched it — one producer.
    match path.extension().and_then(|e| e.to_str()) {
        Some("png") => Some(ImageMime::Png),
        Some("jpg") => Some(ImageMime::Jpeg),
        Some("webp") => Some(ImageMime::Webp),
        _ => None,
    }
}

/// The picture to write: the original from disk when the row has one, else the
/// thumbnail bytes the caller supplied. Pure over `base` so the byte promise
/// can be tested against a temp directory.
pub fn picture_bytes_in(
    base: &Path,
    row_id: &str,
    thumb_b64: Option<&str>,
) -> Result<(ImageMime, Vec<u8>, CopiedImage), String> {
    if let Some(path) = row_image::find_in(base, row_id) {
        if let Some(mime) = mime_of_path(&path) {
            if let Ok(bytes) = std::fs::read(&path) {
                return Ok((mime, bytes, CopiedImage::Original));
            }
        }
    }
    match thumb_b64 {
        Some(b64) if !b64.is_empty() => {
            // The thumbnail is always a PNG (the phone encodes it so); the
            // magic-byte check still runs, so junk never reaches the clipboard.
            let (mime, bytes) = validated_bytes(b64, "image/png").map_err(|e: ImageError| e.reason())?;
            Ok((mime, bytes, CopiedImage::Thumbnail))
        }
        _ => Err("copy image: this row has neither an original on disk nor a preview".to_string()),
    }
}

/// One clipboard rendition: (format id, bytes) — the shape
/// `inject::clipboard_snapshot::write_clipboard_formats` takes.
pub type ClipboardFormats = Vec<(u32, Vec<u8>)>;

/// The clipboard format table for the picture, most-faithful first:
/// registered `PNG` = the ORIGINAL bytes (only when the file is a PNG), then
/// CF_DIB decoded and flattened. Windows only — the DIB needs WIC.
#[cfg(target_os = "windows")]
pub fn image_formats_in(
    base: &Path,
    row_id: &str,
    thumb_b64: Option<&str>,
) -> Result<(ClipboardFormats, CopiedImage), String> {
    let (mime, bytes, which) = picture_bytes_in(base, row_id, thumb_b64)?;
    let decoded = decode_pixels(&bytes, mime).map_err(|e| e.reason())?;
    let mut table: ClipboardFormats = Vec::with_capacity(2);
    if mime == ImageMime::Png {
        table.push((registered_png_format(), bytes));
    }
    table.push((CF_DIB_U32, pack_dib(&decoded)));
    Ok((table, which))
}

/// Copy the row's picture to the OS clipboard. Returns which picture was
/// written (`"original"` / `"thumbnail"`); any failure is returned by name,
/// never swallowed (no silent failures — the button must show its honest ✗).
///
/// Single-word parameters, like every other command on this boundary.
#[tauri::command]
pub fn capsule_copy_image(id: String, thumb: Option<String>) -> Result<String, String> {
    copy_image_native(&id, thumb.as_deref()).map(|w| w.wire().to_string())
}

#[cfg(target_os = "windows")]
fn copy_image_native(id: &str, thumb: Option<&str>) -> Result<CopiedImage, String> {
    use crate::inject::clipboard_snapshot::write_clipboard_formats;
    let (table, which) = image_formats_in(&row_image::dir(), id, thumb)?;
    // A forward write only: one Open→Empty→Set→Close cycle, no snapshot, no
    // restore, no PASTE_LOCK — see the module header for why that is safe here
    // (the same argument clipboard_copy.rs makes for text).
    write_clipboard_formats(table).map_err(|e| e.to_string())?;
    crate::forensic::record("shell", &format!("capsule_copy_image row={id} wrote={}", which.wire()));
    Ok(which)
}

/// Every other host: FAIL, LOUDLY. A friendly `Ok` would be the doc 13 §7 F1 ②
/// shape — the button animates, the clipboard never changes. (The macOS half
/// is not prepared in this card: the pasteboard image write would be a new
/// `inject::macos` surface and belongs to the device line.)
#[cfg(not(target_os = "windows"))]
fn copy_image_native(_id: &str, _thumb: Option<&str>) -> Result<CopiedImage, String> {
    crate::forensic::record(
        "shell",
        "capsule_copy_image: no clipboard image write implementation on this platform — reporting the \
         failure by name instead of pretending the copy happened",
    );
    Err("capsule copy image: this platform has no clipboard image write implementation".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The smallest valid PNG (1×1 RGBA) — a REAL picture, so the Windows decode
    /// below has something WIC accepts, and the byte assertion compares a file
    /// that is not just a signature.
    const TINY_PNG: [u8; 67] = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flowmic-cpimg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn b64(bytes: &[u8]) -> String {
        row_image::encode_b64(bytes)
    }

    #[test]
    fn the_original_on_disk_wins_and_comes_back_byte_for_byte() {
        let base = tmp("orig");
        assert!(row_image::store_in(&base, "row-1", &b64(&TINY_PNG), "image/png"));
        // A DIFFERENT thumbnail is offered too — it must be ignored.
        let mut thumb = TINY_PNG;
        thumb[45] ^= 0xff;
        let (mime, bytes, which) = picture_bytes_in(&base, "row-1", Some(&b64(&thumb))).unwrap();
        assert_eq!(mime, ImageMime::Png);
        assert_eq!(which, CopiedImage::Original);
        assert_eq!(bytes, TINY_PNG.to_vec(), "the ORIGINAL bytes, exactly");
        assert_ne!(bytes, thumb.to_vec());
    }

    #[test]
    fn no_original_falls_back_to_the_thumbnail_and_says_so() {
        let base = tmp("thumb");
        let (mime, bytes, which) = picture_bytes_in(&base, "row-none", Some(&b64(&TINY_PNG))).unwrap();
        assert_eq!(mime, ImageMime::Png);
        assert_eq!(which, CopiedImage::Thumbnail);
        assert_eq!(bytes, TINY_PNG.to_vec());
    }

    #[test]
    fn neither_original_nor_thumbnail_is_a_named_refusal_not_an_empty_write() {
        let base = tmp("neither");
        let err = picture_bytes_in(&base, "row-none", None).unwrap_err();
        assert!(err.contains("neither an original"), "{err}");
        let err2 = picture_bytes_in(&base, "row-none", Some("")).unwrap_err();
        assert!(err2.contains("neither an original"), "{err2}");
    }

    #[test]
    fn a_junk_thumbnail_is_refused_by_the_magic_byte_check() {
        let base = tmp("junk");
        let err = picture_bytes_in(&base, "row-none", Some(&b64(b"not a png at all"))).unwrap_err();
        assert!(!err.is_empty());
    }

    /// 🔴 THE BYTE PROMISE ON THE CLIPBOARD TABLE (Windows: the DIB needs WIC).
    /// The registered-PNG entry IS the file, byte for byte; the DIB entry is a
    /// packed BITMAPINFOHEADER of the decoded 1×1 pixel.
    #[cfg(target_os = "windows")]
    #[test]
    fn the_png_clipboard_entry_is_the_original_file_byte_for_byte() {
        let base = tmp("table");
        assert!(row_image::store_in(&base, "row-t", &b64(&TINY_PNG), "image/png"));
        let (table, which) = image_formats_in(&base, "row-t", None).unwrap();
        assert_eq!(which, CopiedImage::Original);
        let png = table
            .iter()
            .find(|(fmt, _)| *fmt == registered_png_format())
            .expect("a registered PNG entry");
        assert_eq!(png.1, TINY_PNG.to_vec());
        let dib = table.iter().find(|(fmt, _)| *fmt == CF_DIB_U32).expect("a CF_DIB entry");
        // BITMAPINFOHEADER (40) + one 32bpp pixel (4).
        assert_eq!(dib.1.len(), 44);
        assert_eq!(&dib.1[0..4], &40u32.to_le_bytes());
    }

    /// 🔴 THE OTHER PLATFORM'S ONLY PROMISE, PINNED (2026-08-26).
    ///
    /// `copy_image_native`'s non-Windows arm exists to REFUSE BY NAME, and the
    /// comment above it says so — but a comment asserting behaviour is not the
    /// behaviour (anti-façade ④: give it a greppable anchor or pin it with a
    /// test). Until now nothing here ran on that arm at all: the byte promise
    /// above is `cfg(target_os = "windows")` and the other four tests exercise
    /// `picture_bytes_in`, which is platform-neutral. So the mac acceptance run
    /// could compile this file and still say nothing about the one thing that
    /// file does on mac.
    ///
    /// What it pins is the FAILURE DIRECTION, which is the whole reason the arm
    /// is written out rather than left to a friendly default: an `Ok` here is
    /// doc 13 §7 F1 ② — the button animates, the clipboard never changes, and
    /// the user is told it worked. A named `Err` is a product that says what
    /// happened. This assertion cannot pass on a stub that returns success.
    ///
    /// Runs on macOS and Linux; on Windows there is no such arm to check.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn this_platform_refuses_by_name_instead_of_claiming_the_copy_happened() {
        // Both a row that WOULD be copyable elsewhere and a hopeless one must
        // take the same road here: the refusal is about the platform, not about
        // whether a picture could be found, so a caller can never read it as
        // 「that row was the problem」.
        for thumb in [Some(b64(&TINY_PNG)), None] {
            let err = copy_image_native("row-any", thumb.as_deref())
                .expect_err("a platform with no clipboard image write must not report success");
            assert!(
                err.contains("no clipboard image write implementation"),
                "the refusal must name the platform gap, got: {err}"
            );
        }
    }
}

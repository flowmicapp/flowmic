// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request.image_b64 /
//     image_mime — F-2350 additive field-add, NO new event)
//   packages/protocol/src/protocol-schemas-inject.ts (InjectImageBase64Schema:
//     max 5_500_000, canonical base64; InjectImageMimeSchema: png|jpeg|webp)
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4 ② (receive image → inject)
//   master-plan §4 / CLAUDE.md red line: no silent failures — a payload we cannot
//     decode is REJECTED with a named reason, never silently dropped and never
//     reported as injected.
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The image half of the inject path: base64 → bytes → decoded pixels → the
// Windows clipboard format table that `clipboard_confirm` renders on demand.
//
// Zero new crates. base64 is decoded here (35 lines, and it lets us enforce the
// EXACT canonical-base64 rule the zod schema states rather than a permissive
// decoder's superset); the picture decode uses WIC — the imaging component that
// already ships in Windows — through the `windows` crate the desktop already
// depends on. PNG / JPEG decode natively; WebP decodes wherever the OS carries
// the WebP codec and fails LOUD (not silently blank) where it does not.
//
// Everything above the Win32 line (base64, magic-byte sniffing, DIB packing) is
// pure and unit-proven; only `decode_pixels` touches COM.

use crate::inject::sendinput::InjectError;

/// Mirror of the protocol's `image_b64` ceiling (InjectImageBase64Schema).
/// Over-limit is REJECTED here too — the desktop never trusts the wire to have
/// enforced its own cap (same discipline as INJECT_TEXT_MAX_CHARS).
pub const INJECT_IMAGE_B64_MAX: usize = 5_500_000;

/// D5 (2026-09-02 audit §3-D) — a SEPARATE cap, on decoded pixel COUNT
/// (`width * height`), independent of the base64-length cap above. That cap
/// bounds the ENCODED size; it says nothing about the DECODED canvas, because
/// image compression means the two are not proportional — a near-solid-color
/// PNG can be a few KB of base64 and decode to hundreds of megapixels. The LAN
/// image path (`socket/row_image.rs`) has no upstream size limit at all beyond
/// `INJECT_IMAGE_B64_MAX`, so this is the only line standing between a crafted
/// (or just very compressible) PNG and an allocation the OS aborts the process
/// for rather than one Rust can hand back as an `Err`.
///
/// 64 megapixels is comfortably above anything this product is asked to
/// paste — an 8K screenshot is ~33MP, a 48MP phone-camera photo is 48MP — while
/// keeping the worst case at `64_000_000 * 4 = 256 MB` per buffer (two buffers
/// exist briefly: this one and `pack_dib`'s copy), which is large but an
/// allocation Rust's allocator can plausibly satisfy or fail gracefully on,
/// not the multi-gigabyte one this card was written to stop.
pub const INJECT_IMAGE_MAX_PIXELS: u64 = 64_000_000;

/// Whether `width × height` fits under [`INJECT_IMAGE_MAX_PIXELS`].
///
/// Split out as a pure function (not gated to Windows, unlike the WIC decoder
/// that calls it) so the cap decision is unit-testable directly — actually
/// decoding an image large enough to breach a 64-megapixel cap would mean the
/// test itself allocates hundreds of megabytes, which is the exact hazard
/// this cap exists to avoid triggering in production.
///
/// ⚠️ CORRECTED IN PLACE (2026-09-02, B2-Z): the Mac-side run (commit
/// 7d9a775c) reported `cargo clippy --lib --features app -- -D warnings`
/// failing on macOS with this function flagged dead code — true in a plain
/// build there, because its only PRODUCTION caller is `decode_pixels`'s
/// the Windows-only arm below; the non-Windows `decode_pixels`
/// arm never reaches it. `#[cfg(any(test, target_os = "windows"))]` keeps
/// this reachable in the real Windows build AND in every platform's test
/// build (see `image_tests.rs`, ungated), which is the one property this
/// comment's first paragraph exists to promise, without `#[allow(dead_code)]`
/// papering over a caller that stopped existing. NOT YET CONFIRMED ON THE MAC
/// by this commit — see `verify/lint/platform-cfg-count.mjs`'s compound-cfg
/// census note.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn dimensions_within_pixel_cap(width: u32, height: u32) -> bool {
    (width as u64).saturating_mul(height as u64) <= INJECT_IMAGE_MAX_PIXELS
}

/// CF_DIB — packed BITMAPINFOHEADER + pixels. The one format every Windows
/// image consumer understands, and the one the OS synthesises CF_BITMAP /
/// CF_DIBV5 from.
pub const CF_DIB_U32: u32 = 8;
/// CF_BITMAP — a GDI HBITMAP handle, NOT an HGLOBAL. Many targets (the Chinese
/// IM clients in particular) ask for this one; it is materialised from the DIB
/// at render time inside clipboard_confirm.
pub const CF_BITMAP_U32: u32 = 2;

/// The three mimes the protocol admits (InjectImageMimeSchema).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageMime {
    Png,
    Jpeg,
    Webp,
}

impl ImageMime {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "image/png" => Some(ImageMime::Png),
            "image/jpeg" => Some(ImageMime::Jpeg),
            "image/webp" => Some(ImageMime::Webp),
            _ => None,
        }
    }

    pub fn wire(self) -> &'static str {
        match self {
            ImageMime::Png => "image/png",
            ImageMime::Jpeg => "image/jpeg",
            ImageMime::Webp => "image/webp",
        }
    }
}

/// Why an image payload could not become a clipboard image. Every variant
/// carries enough detail for the forensic line — none of them is silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    /// base64 longer than the protocol ceiling.
    OverCap { b64_len: usize },
    /// Not canonical base64 (bad length, alphabet or padding).
    NotCanonicalBase64,
    /// `image_mime` outside the protocol enum.
    UnsupportedMime(String),
    /// The declared mime and the actual magic bytes disagree — the payload is
    /// not what it claims to be, so it is refused rather than guessed at.
    MimeMismatch {
        declared: &'static str,
        sniffed: &'static str,
    },
    /// Zero-length payload.
    Empty,
    /// The OS decoder refused the bytes (corrupt file, or a codec — WebP — that
    /// this Windows install does not carry).
    Decode(String),
    /// D5: the decoded canvas exceeds `INJECT_IMAGE_MAX_PIXELS`. Named
    /// separately from `OverCap` because the two caps measure different
    /// things (encoded bytes vs. decoded pixels) and a payload can fail
    /// either one independently of the other.
    DimensionsTooLarge { width: u32, height: u32 },
}

impl ImageError {
    /// One-line human reason for the forensic log / eprintln. The WIRE only
    /// ever carries the protocol error CODE (INJECT_IMAGE_UNSUPPORTED); this is
    /// the local detail that makes a failure diagnosable.
    pub fn reason(&self) -> String {
        match self {
            ImageError::OverCap { b64_len } => format!(
                "image_b64 {b64_len} chars exceeds cap {INJECT_IMAGE_B64_MAX}; rejected"
            ),
            ImageError::NotCanonicalBase64 => "image_b64 is not canonical base64".to_string(),
            ImageError::UnsupportedMime(m) => format!("image_mime {m:?} is not png/jpeg/webp"),
            ImageError::MimeMismatch { declared, sniffed } => {
                format!("image_mime says {declared} but the bytes are {sniffed}")
            }
            ImageError::Empty => "image payload is empty".to_string(),
            ImageError::Decode(d) => format!("image decode failed: {d}"),
            ImageError::DimensionsTooLarge { width, height } => format!(
                "decoded image is {width}x{height} ({} px) exceeds cap {INJECT_IMAGE_MAX_PIXELS} px; rejected",
                (*width as u64) * (*height as u64)
            ),
        }
    }
}

// ── base64 (canonical only — mirrors InjectImageBase64Schema's refine) ──────

fn b64_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode canonical base64. Rejects (never repairs) anything the protocol's
/// `image_b64` refine would reject: empty, length % 4 != 0, characters outside
/// `A-Za-z0-9+/`, and `=` anywhere but the final one or two positions. No
/// whitespace tolerance and no `data:` prefix tolerance — by design, because a
/// permissive decoder here would accept frames the server's zod boundary
/// rejects and the two ends would disagree about what is a valid payload.
pub fn decode_b64(s: &str) -> Result<Vec<u8>, ImageError> {
    if s.len() > INJECT_IMAGE_B64_MAX {
        return Err(ImageError::OverCap { b64_len: s.len() });
    }
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(ImageError::NotCanonicalBase64);
    }
    let pad = bytes.iter().rev().take_while(|&&c| c == b'=').count();
    if pad > 2 {
        return Err(ImageError::NotCanonicalBase64);
    }
    let body = &bytes[..bytes.len() - pad];
    if body.iter().any(|&c| b64_value(c).is_none()) {
        return Err(ImageError::NotCanonicalBase64);
    }
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    for quad in bytes.chunks(4) {
        let mut acc: u32 = 0;
        for &c in quad {
            acc = (acc << 6) | u32::from(if c == b'=' { 0 } else { b64_value(c).unwrap_or(0) });
        }
        out.push((acc >> 16) as u8);
        out.push((acc >> 8) as u8);
        out.push(acc as u8);
    }
    out.truncate(out.len() - pad);
    if out.is_empty() {
        return Err(ImageError::Empty);
    }
    Ok(out)
}

/// Identify a payload by its magic bytes. Used to refuse a frame whose declared
/// mime does not match its content (a JPEG announced as PNG would decode fine
/// but tells us the sender is confused, and a mislabelled payload is exactly
/// the kind of thing that should fail loudly once rather than mysteriously
/// later).
pub fn sniff_mime(bytes: &[u8]) -> Option<ImageMime> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some(ImageMime::Png);
    }
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some(ImageMime::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageMime::Webp);
    }
    None
}

/// Validated payload bytes for a declared mime: over-cap / non-canonical /
/// unknown-mime / mismatched-magic all reject here, BEFORE any OS decoder runs.
pub fn validated_bytes(b64: &str, mime_wire: &str) -> Result<(ImageMime, Vec<u8>), ImageError> {
    let mime = ImageMime::from_wire(mime_wire)
        .ok_or_else(|| ImageError::UnsupportedMime(mime_wire.to_string()))?;
    let bytes = decode_b64(b64)?;
    match sniff_mime(&bytes) {
        Some(actual) if actual == mime => Ok((mime, bytes)),
        Some(actual) => Err(ImageError::MimeMismatch {
            declared: mime.wire(),
            sniffed: actual.wire(),
        }),
        None => Err(ImageError::Decode(
            "payload matches no supported image signature".to_string(),
        )),
    }
}

// ── DIB packing (pure — provable without a decoder) ────────────────────────

/// Straight-alpha BGRA pixels, top-down, `width * height * 4` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bgra {
    pub width: u32,
    pub height: u32,
    /// Top-down rows, 4 bytes per pixel in B,G,R,A order.
    pub pixels: Vec<u8>,
}

/// Pack straight-alpha BGRA into a CF_DIB (BITMAPINFOHEADER + pixel array).
///
/// Two deliberate conversions, both documented because they change what the
/// user sees:
///   1. **bottom-up**: a positive `biHeight` is the universally-read layout;
///      top-down (negative height) 32bpp DIBs are mishandled by a meaningful
///      slice of consumers.
///   2. **alpha is composited onto WHITE and then set opaque**. CF_DIB's
///      32bpp BI_RGB has no agreed alpha meaning: some targets read the 4th
///      byte as alpha, most treat it as padding, and a transparent PNG pasted
///      into the latter comes out black. Flattening onto white is the one
///      outcome that is never a surprise. The ORIGINAL bytes are still offered
///      unflattened under the registered `PNG` format for targets that prefer
///      it, so an alpha-aware consumer keeps its transparency.
pub fn pack_dib(image: &Bgra) -> Vec<u8> {
    let w = image.width as usize;
    let h = image.height as usize;
    let stride = w * 4;
    let mut out = Vec::with_capacity(40 + stride * h);
    // BITMAPINFOHEADER
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(image.width as i32).to_le_bytes());
    out.extend_from_slice(&(image.height as i32).to_le_bytes()); // positive = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&((stride * h) as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes()); // 72 dpi
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for y in (0..h).rev() {
        let row = &image.pixels[y * stride..y * stride + stride];
        for px in row.as_chunks::<4>().0 {
            let a = u32::from(px[3]);
            let over = |c: u8| -> u8 {
                ((u32::from(c) * a + 255 * (255 - a) + 127) / 255).min(255) as u8
            };
            out.push(over(px[0]));
            out.push(over(px[1]));
            out.push(over(px[2]));
            out.push(0xFF);
        }
    }
    out
}

/// The clipboard format table for one image, most-faithful format first.
/// `PNG` (a registered format) carries the ORIGINAL bytes with their alpha
/// intact; CF_DIB is the flattened universal fallback. CF_BITMAP is not listed
/// because it is a GDI handle rather than bytes — clipboard_confirm announces
/// it alongside CF_DIB and materialises it at render time.
#[cfg(not(target_os = "macos"))]
pub fn clipboard_formats(
    b64: &str,
    mime_wire: &str,
) -> Result<Vec<(u32, Vec<u8>)>, ImageError> {
    let (mime, bytes) = validated_bytes(b64, mime_wire)?;
    let decoded = decode_pixels(&bytes, mime)?;
    let mut table: Vec<(u32, Vec<u8>)> = Vec::with_capacity(2);
    if mime == ImageMime::Png {
        table.push((registered_png_format(), bytes.clone()));
    }
    table.push((CF_DIB_U32, pack_dib(&decoded)));
    Ok(table)
}

/// MAC-06: the same table on macOS — ONE row, the ORIGINAL bytes, under the UTI
/// the platform already has for that mime.
///
/// ── WHY THERE IS NO DECODE AND NO DIB HERE ──────────────────────────────────
/// Both of the Windows rows exist to serve Win32 consumers: `CF_DIB` because a
/// packed BITMAPINFOHEADER is the only thing every Windows image consumer reads,
/// and the WIC decode because that DIB has to be built. macOS consumers read
/// `public.png` / `public.jpeg` directly, so re-encoding the picture into a second
/// representation would be work whose only product is a lossier copy (the DIB path
/// flattens alpha onto white — see `pack_dib`). Skipping it is a SIMPLIFICATION,
/// not a gap: everything above the Win32 line — the cap, canonical base64, the
/// magic-byte/mime cross-check — is platform-neutral and still runs first.
///
/// 🔴 ONE THING THE WINDOWS PATH CATCHES AND THIS ONE DOES NOT, said out loud
/// rather than left to be discovered: a payload with a VALID signature and a
/// CORRUPT BODY. On Windows the WIC decode refuses it (`a_corrupt_payload_fails_
/// loud_at_the_decoder`); here nothing decodes it, so it reaches the pasteboard
/// and the target renders nothing. The picture is still delivered and still on the
/// timeline — the failure is 「the target shows a broken image」, not 「we said
/// injected and there was nothing」 — but it IS a difference between the two
/// platforms and it is pinned by a test below instead of being implied.
/// Closing it needs an ImageIO decode (`CGImageSourceGetStatus`), which is a
/// framework outside this card's dependency budget.
///
/// ⚠️ NO TIFF COMPANION IN V1. The MAC-05/06 card lists one as OPTIONAL; producing
/// it means decoding and re-encoding through NSImage/NSBitmapImageRep, i.e. exactly
/// the work the paragraph above declines to do, for the benefit of consumers that
/// read only `NSPasteboardTypeTIFF`. If a real target turns out to need it, it is
/// one more row in this table — recorded here so its absence reads as a decision.
#[cfg(target_os = "macos")]
pub fn clipboard_formats(
    b64: &str,
    mime_wire: &str,
) -> Result<Vec<(u32, Vec<u8>)>, ImageError> {
    use crate::inject::macos::pasteboard;
    let (mime, bytes) = validated_bytes(b64, mime_wire)?;
    let type_id = match mime {
        ImageMime::Png => pasteboard::png_type_id(),
        ImageMime::Jpeg => pasteboard::jpeg_type_id(),
        ImageMime::Webp => pasteboard::webp_type_id(),
    };
    Ok(vec![(type_id, bytes)])
}

/// Map an image failure onto the injection error type so the pipeline can treat
/// it exactly like any other hard failure.
impl From<ImageError> for InjectError {
    fn from(_: ImageError) -> Self {
        InjectError::AppRejected
    }
}

// ── Win32: the registered PNG clipboard format + the WIC decode ─────────────

#[cfg(target_os = "windows")]
pub fn registered_png_format() -> u32 {
    use std::sync::OnceLock;
    use windows::core::w;
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    static PNG_FORMAT: OnceLock<u32> = OnceLock::new();
    *PNG_FORMAT.get_or_init(|| unsafe { RegisterClipboardFormatW(w!("PNG")) })
}

/// MAC-06: the `public.png` pasteboard type, interned into the same `u32` space
/// the platform-neutral clipboard layer speaks. Exactly the same mechanism as the
/// Windows arm above — `RegisterClipboardFormatW` interns a NAME into an id, and
/// `pasteboard::type_id` interns a UTI into one.
#[cfg(target_os = "macos")]
pub fn registered_png_format() -> u32 {
    crate::inject::macos::pasteboard::png_type_id()
}

/// No clipboard, no format ids. `0` is not a valid format on any platform, so a
/// caller that ignores the surrounding `Err` cannot accidentally address
/// something with it.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn registered_png_format() -> u32 {
    0
}

/// Decode an encoded picture to straight-alpha top-down BGRA using WIC.
///
/// WIC is initialised per-thread once. A WebP payload on a Windows install
/// without the WebP codec fails here with the OS HRESULT rather than producing
/// a blank image — the red line is that a failure is named, not that every
/// format is guaranteed.
#[cfg(target_os = "windows")]
pub fn decode_pixels(bytes: &[u8], _mime: ImageMime) -> Result<Bgra, ImageError> {
    use std::cell::Cell;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };

    thread_local! {
        static COM_READY: Cell<bool> = const { Cell::new(false) };
    }
    COM_READY.with(|ready| {
        if !ready.get() {
            // S_FALSE (already initialised) and RPC_E_CHANGED_MODE (this thread
            // is already an MTA) are both fine — WIC works either way.
            let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            ready.set(true);
        }
    });

    let hr = |what: &str, e: windows::core::Error| {
        ImageError::Decode(format!("{what}: hr=0x{:08X}", e.code().0))
    };

    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| hr("WIC factory", e))?;
        let stream = factory.CreateStream().map_err(|e| hr("WIC stream", e))?;
        stream
            .InitializeFromMemory(bytes)
            .map_err(|e| hr("WIC stream init", e))?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnLoad)
            .map_err(|e| hr("WIC decoder (unsupported or corrupt payload)", e))?;
        let frame = decoder.GetFrame(0).map_err(|e| hr("WIC frame", e))?;
        let converter = factory
            .CreateFormatConverter()
            .map_err(|e| hr("WIC converter", e))?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| hr("WIC convert to BGRA", e))?;
        let (mut w, mut h) = (0u32, 0u32);
        converter
            .GetSize(&mut w, &mut h)
            .map_err(|e| hr("WIC size", e))?;
        if w == 0 || h == 0 {
            return Err(ImageError::Decode(format!("degenerate size {w}x{h}")));
        }
        // D5 (2026-09-02 audit §3-D): the comment this replaced ("w*h*4 cannot
        // overflow usize because the encoded payload is capped at ~4MB of
        // base64") was FALSE — that caps the ENCODED size, not the DECODED
        // canvas. PNG's compression means a near-solid-color 30000×30000 image
        // fits in a few KB of base64 yet decodes to a 3.6 GB BGRA buffer here,
        // and `pack_dib` (below, in the caller) copies it a second time on top
        // of that. Both allocations abort the PROCESS (Rust's global allocator
        // calls `handle_alloc_error` on an allocation failure of this size,
        // which is not a `Result` any caller can catch) rather than returning
        // an error — this check exists so we never reach that call.
        if !dimensions_within_pixel_cap(w, h) {
            return Err(ImageError::DimensionsTooLarge { width: w, height: h });
        }
        // 32bpp: stride is exactly 4 bytes per pixel; the check above bounds
        // w*h*4 well under usize::MAX on every platform this ships for.
        let stride = w as usize * 4;
        let mut pixels = vec![0u8; stride * h as usize];
        converter
            .CopyPixels(std::ptr::null(), stride as u32, &mut pixels)
            .map_err(|e| hr("WIC copy pixels", e))?;
        Ok(Bgra {
            width: w,
            height: h,
            pixels,
        })
    }
}

/// Non-Windows hosts have no clipboard image path at all — say so rather than
/// returning an empty picture.
///
/// ⚠️ CORRECTED IN PLACE 2026-08-07 (MAC-06): the sentence above is still true of THIS
/// FUNCTION and is deliberately left standing, but it no longer implies 「non-
/// Windows hosts have no image injection」. macOS does — it just does not go
/// through a decoder: `clipboard_formats`'s macOS arm writes the ORIGINAL encoded
/// bytes to the pasteboard under `public.png` / `public.jpeg` /
/// `org.webmproject.webp` and never calls this function at all. So on macOS this
/// arm is UNREACHABLE from the injection path, and reaching it would mean somebody
/// wired a DIB path that does not belong there.
#[cfg(not(target_os = "windows"))]
pub fn decode_pixels(_bytes: &[u8], _mime: ImageMime) -> Result<Bgra, ImageError> {
    Err(ImageError::Decode(
        "image decoding is Windows-only (WIC)".to_string(),
    ))
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;

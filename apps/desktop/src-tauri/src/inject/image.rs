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
        for px in row.chunks_exact(4) {
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
        // 32bpp: stride is exactly 4 bytes per pixel, and w*h*4 cannot overflow
        // usize because the encoded payload is capped at ~4MB of base64.
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
mod tests {
    use super::*;

    /// A real 2×2 RGBA PNG: red, green, blue, 50%-alpha white. Byte-exact so the
    /// decode path is exercised for real rather than mocked.
    const PNG_2X2: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xB6, 0x0D, 0x24, 0x00, 0x00, 0x00,
        0x14, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0,
        0x1F, 0x0C, 0x19, 0x18, 0xFE, 0x83, 0x40, 0x03, 0x00, 0x49, 0x49, 0x09,
        0x78, 0x9C, 0x3D, 0x3C, 0xBE, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    const PNG_2X2_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMASUkJeJw9PL4AAAAASUVORK5CYII=";

    #[test]
    fn canonical_base64_round_trips_the_real_png() {
        let decoded = decode_b64(PNG_2X2_B64).expect("canonical base64");
        assert_eq!(decoded, PNG_2X2, "byte-exact decode");
    }

    #[test]
    fn base64_rejects_everything_the_zod_refine_rejects() {
        // empty
        assert_eq!(decode_b64(""), Err(ImageError::NotCanonicalBase64));
        // length not a multiple of 4
        assert_eq!(decode_b64("QUJD QQ"), Err(ImageError::NotCanonicalBase64));
        assert_eq!(decode_b64("QUJDR"), Err(ImageError::NotCanonicalBase64));
        // whitespace / newlines are NOT tolerated (the schema forbids them)
        assert_eq!(decode_b64("QUJD\nQQ=="), Err(ImageError::NotCanonicalBase64));
        // data: URL prefix is not tolerated
        assert!(decode_b64("data:image/png;base64,QUJD").is_err());
        // url-safe alphabet is not canonical base64
        assert_eq!(decode_b64("Pz8_Pw=="), Err(ImageError::NotCanonicalBase64));
        // three padding chars
        assert_eq!(decode_b64("QQ==QQ=="), Err(ImageError::NotCanonicalBase64));
        // over the protocol cap → its own distinct reason, never a generic error
        let huge = "A".repeat(INJECT_IMAGE_B64_MAX + 4);
        assert_eq!(
            decode_b64(&huge),
            Err(ImageError::OverCap {
                b64_len: INJECT_IMAGE_B64_MAX + 4
            })
        );
    }

    #[test]
    fn base64_decodes_both_padding_lengths() {
        assert_eq!(decode_b64("QUJD").unwrap(), b"ABC");
        assert_eq!(decode_b64("QUI=").unwrap(), b"AB");
        assert_eq!(decode_b64("QQ==").unwrap(), b"A");
    }

    #[test]
    fn magic_bytes_identify_the_three_admitted_mimes() {
        assert_eq!(sniff_mime(PNG_2X2), Some(ImageMime::Png));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageMime::Jpeg));
        let webp = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
        assert_eq!(sniff_mime(webp), Some(ImageMime::Webp));
        assert_eq!(sniff_mime(b"not an image at all"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn a_mislabelled_payload_is_refused_rather_than_guessed_at() {
        // Real PNG bytes announced as JPEG.
        let err = validated_bytes(PNG_2X2_B64, "image/jpeg").unwrap_err();
        assert_eq!(
            err,
            ImageError::MimeMismatch {
                declared: "image/jpeg",
                sniffed: "image/png"
            }
        );
        assert!(err.reason().contains("image/png"), "reason names both sides");
    }

    #[test]
    fn an_unsupported_mime_and_a_non_image_payload_each_fail_by_name() {
        assert_eq!(
            validated_bytes(PNG_2X2_B64, "image/gif"),
            Err(ImageError::UnsupportedMime("image/gif".to_string()))
        );
        // Valid base64, but the bytes are not a picture.
        assert!(matches!(
            validated_bytes("QUJDRA==", "image/png"),
            Err(ImageError::Decode(_))
        ));
    }

    #[test]
    fn validated_bytes_accepts_the_real_png() {
        let (mime, bytes) = validated_bytes(PNG_2X2_B64, "image/png").expect("valid");
        assert_eq!(mime, ImageMime::Png);
        assert_eq!(bytes, PNG_2X2);
    }

    #[test]
    fn dib_header_is_a_bottom_up_32bpp_bi_rgb_bitmap() {
        let img = Bgra {
            width: 2,
            height: 2,
            // top-down: row0 = [blue-opaque, green-opaque], row1 = [red-opaque, x]
            pixels: vec![
                0xFF, 0x00, 0x00, 0xFF, // B
                0x00, 0xFF, 0x00, 0xFF, // G
                0x00, 0x00, 0xFF, 0xFF, // R
                0x10, 0x20, 0x30, 0xFF,
            ],
        };
        let dib = pack_dib(&img);
        assert_eq!(dib.len(), 40 + 2 * 2 * 4);
        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 2);
        assert_eq!(
            i32::from_le_bytes(dib[8..12].try_into().unwrap()),
            2,
            "positive biHeight = bottom-up, the layout every consumer reads"
        );
        assert_eq!(u16::from_le_bytes(dib[12..14].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(dib[14..16].try_into().unwrap()), 32);
        assert_eq!(
            u32::from_le_bytes(dib[16..20].try_into().unwrap()),
            0,
            "BI_RGB"
        );
        assert_eq!(u32::from_le_bytes(dib[20..24].try_into().unwrap()), 16);
        // Rows are flipped: the DIB's first row is the image's LAST row.
        assert_eq!(&dib[40..48], &[0x00, 0x00, 0xFF, 0xFF, 0x10, 0x20, 0x30, 0xFF]);
        assert_eq!(&dib[48..56], &[0xFF, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF]);
    }

    #[test]
    fn transparency_is_flattened_onto_white_and_never_left_as_black() {
        let img = Bgra {
            width: 1,
            height: 1,
            // fully transparent black — the pixel that comes out BLACK in every
            // target that treats the 4th byte as padding.
            pixels: vec![0x00, 0x00, 0x00, 0x00],
        };
        let dib = pack_dib(&img);
        assert_eq!(
            &dib[40..44],
            &[0xFF, 0xFF, 0xFF, 0xFF],
            "transparent → white, opaque alpha"
        );
        // Half alpha lands halfway to white, not at either extreme.
        let half = Bgra {
            width: 1,
            height: 1,
            pixels: vec![0x00, 0x00, 0x00, 0x80],
        };
        let d2 = pack_dib(&half);
        assert!(
            (0x7E..=0x80).contains(&d2[40]),
            "50% alpha black over white ≈ 0x7F, got {:#04X}",
            d2[40]
        );
        assert_eq!(d2[43], 0xFF, "output alpha is always opaque");
    }

    // The real decode. WIC is in-process COM and needs no window/desktop, so
    // this runs headless — it is the proof that the picture path is not a stub.
    #[cfg(target_os = "windows")]
    #[test]
    fn wic_really_decodes_the_png_to_bgra() {
        let img = decode_pixels(PNG_2X2, ImageMime::Png).expect("WIC decodes PNG");
        assert_eq!((img.width, img.height), (2, 2));
        assert_eq!(img.pixels.len(), 2 * 2 * 4);
        // Pixel 0 is opaque red → BGRA = 00 00 FF FF.
        assert_eq!(&img.pixels[0..4], &[0x00, 0x00, 0xFF, 0xFF]);
        // Pixel 1 is opaque green.
        assert_eq!(&img.pixels[4..8], &[0x00, 0xFF, 0x00, 0xFF]);
        // Pixel 3 is 50%-alpha white — straight alpha, not premultiplied.
        assert_eq!(img.pixels[15], 0x80);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_format_table_offers_png_verbatim_and_a_flattened_dib() {
        let table = clipboard_formats(PNG_2X2_B64, "image/png").expect("formats");
        assert_eq!(table.len(), 2, "registered PNG + CF_DIB");
        assert_eq!(table[0].0, registered_png_format());
        assert_eq!(table[0].1, PNG_2X2, "PNG is offered byte-verbatim");
        assert_eq!(table[1].0, CF_DIB_U32);
        assert_eq!(table[1].1.len(), 40 + 2 * 2 * 4);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_corrupt_payload_fails_loud_at_the_decoder() {
        // Valid PNG signature, garbage body → the OS decoder must refuse and the
        // reason must name the HRESULT rather than yielding a blank image.
        let mut broken = PNG_2X2.to_vec();
        for b in broken.iter_mut().skip(40) {
            *b = 0x00;
        }
        let b64 = {
            const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut s = String::new();
            for c in broken.chunks(3) {
                let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                s.push(A[(n >> 18) as usize & 63] as char);
                s.push(A[(n >> 12) as usize & 63] as char);
                s.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
                s.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
            }
            s
        };
        match clipboard_formats(&b64, "image/png") {
            Err(ImageError::Decode(d)) => {
                assert!(!d.is_empty(), "the decode failure carries a reason");
            }
            other => panic!("a corrupt PNG must fail loud, got {other:?}"),
        }
    }

    // ── MAC-06: the same contract, the platform's own answer ─────────────────

    /// The macOS sibling of `the_format_table_offers_png_verbatim_and_a_flattened_dib`.
    /// One row, the ORIGINAL bytes, no DIB — and the id must be one the pasteboard
    /// registry can resolve back to `public.png`, because an id it cannot resolve
    /// is refused at paste time by name (pasteboard.rs).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_table_offers_the_original_bytes_under_the_platform_uti() {
        use crate::inject::macos::pasteboard;
        let table = clipboard_formats(PNG_2X2_B64, "image/png").expect("formats");
        assert_eq!(table.len(), 1, "one row: no DIB, no re-encode");
        assert_eq!(table[0].0, pasteboard::png_type_id());
        assert_eq!(table[0].1, PNG_2X2, "the PNG is offered byte-verbatim");
        assert_eq!(
            pasteboard::type_uti(table[0].0).as_deref(),
            Some("public.png"),
            "the id must resolve, or paste_formats_with_confirmation refuses it"
        );
    }

    /// Each mime gets its OWN UTI. A single 「image」 type here would put JPEG bytes
    /// on the pasteboard labelled PNG, which every consumer would then fail to
    /// render for reasons none of them could report.
    #[cfg(target_os = "macos")]
    #[test]
    fn each_mime_gets_its_own_pasteboard_type() {
        use crate::inject::macos::pasteboard;
        let ids = [
            pasteboard::png_type_id(),
            pasteboard::jpeg_type_id(),
            pasteboard::webp_type_id(),
        ];
        for (i, a) in ids.iter().enumerate() {
            for b in ids.iter().skip(i + 1) {
                assert_ne!(a, b, "two mimes must never share one pasteboard type");
            }
        }
        assert_eq!(pasteboard::type_uti(ids[1]).as_deref(), Some("public.jpeg"));
        assert_eq!(
            pasteboard::type_uti(ids[2]).as_deref(),
            Some("org.webmproject.webp")
        );
    }

    /// 🔴 THE GAP, PINNED. On Windows `a_corrupt_payload_fails_loud_at_the_decoder`
    /// proves a valid-signature/corrupt-body PNG is refused by WIC. macOS has no
    /// decoder in this path, so the SAME payload is accepted and lands on the
    /// pasteboard. That is a real behavioural difference between the two
    /// platforms, and it is asserted rather than commented so it stays visible:
    /// if somebody later adds an ImageIO check, THIS test goes red and names the
    /// gap it closed, instead of the difference quietly ceasing to exist.
    ///
    /// Note what is NOT at risk: the payload still passed the cap, the canonical-
    /// base64 rule and the magic-byte/mime cross-check, and the delivery is still
    /// truthfully reported. The user sees a broken picture in their target app,
    /// never a 「injected」 for a frame that was refused.
    #[cfg(target_os = "macos")]
    #[test]
    // `NOT` IS SHOUTED ON PURPOSE — do not snake_case it (DOC-HYG, 2026-08-09).
    // This test asserts a GAP: the payload is accepted on macOS where Windows
    // refuses it. A lowercase `not` buried mid-name is exactly the word a reader
    // skims past, and skimming past it here means reading the test as proof the
    // decoder catches this — the opposite of what it pins.
    // ⚠️ This one is invisible on a Windows host: it is `cfg(target_os = "macos")`,
    // so `cargo clippy --all-targets` here never compiles it and never warned. It
    // is annotated anyway, because the machine that WOULD warn is the Mac mini the
    // IOS cards run on, and a warning that only appears on the other platform is
    // the kind that gets "fixed" by whoever meets it first.
    #[allow(non_snake_case)]
    fn a_corrupt_body_with_a_valid_signature_is_NOT_caught_on_macos() {
        // A real PNG signature + IHDR, then garbage — byte-for-byte the shape the
        // Windows test builds, so the two are comparing the same thing.
        let mut broken = PNG_2X2.to_vec();
        for b in broken.iter_mut().skip(40) {
            *b = 0x00;
        }
        let b64 = {
            const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut s = String::new();
            for c in broken.chunks(3) {
                let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                s.push(A[(n >> 18) as usize & 63] as char);
                s.push(A[(n >> 12) as usize & 63] as char);
                s.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
                s.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
            }
            s
        };
        let table = clipboard_formats(&b64, "image/png")
            .expect("macOS accepts it — there is no decoder on this path");
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].1, broken, "the corrupt bytes go through verbatim");
    }
}

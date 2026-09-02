// Unit coverage for inject/image.rs — split out (2026-09-02, file-size cap:
// image.rs crossed 800 lines once D5's pixel-cap fix and its comments were
// added) per this repo's standing pattern for oversized modules (see
// cloud_signin_tests.rs, swap_tests.rs, breadcrumb_tests.rs). VERBATIM move —
// no test logic changed by the split itself.

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

/// D5 (2026-09-02 audit §3-D): `INJECT_IMAGE_MAX_PIXELS` is a SEPARATE cap from
/// `INJECT_IMAGE_B64_MAX` — an encoded payload well under the base64 cap can
/// still decode to an enormous canvas, because compression ratio and pixel
/// count are unrelated. This exercises the pure predicate directly rather than
/// decoding a real oversized image: actually breaching a 64-megapixel cap
/// would mean the TEST allocates hundreds of megabytes, which is the exact
/// hazard the cap exists to stop production from doing.
#[test]
fn dimensions_within_pixel_cap_accepts_real_sizes_and_refuses_huge_ones() {
    // Ordinary photo/screenshot sizes: comfortably under the cap.
    assert!(dimensions_within_pixel_cap(1920, 1080));
    assert!(dimensions_within_pixel_cap(8000, 6000)); // 48MP phone camera
    // Exactly at the cap is still accepted — the check is "exceeds", not
    // "reaches".
    assert!(dimensions_within_pixel_cap(8000, 8000)); // 64,000,000 px exactly
    // The shape this card fixes: a huge-dimension, highly-compressible image.
    // 30000×30000 = 900,000,000 px, which decoded to BGRA is 3.6 GB — the
    // allocation that used to abort the process outright.
    assert!(!dimensions_within_pixel_cap(30_000, 30_000));
    // One pixel over the cap must already refuse (off-by-one check).
    assert!(!dimensions_within_pixel_cap(8000, 8001));
    // A pathological aspect ratio (1 px tall, absurdly wide) must not
    // integer-overflow u32 arithmetic — the multiplication happens in u64.
    assert!(!dimensions_within_pixel_cap(u32::MAX, u32::MAX));
}

/// **Reverse control**: this is the exact bug D5 fixed, written as a
/// regression test on the OLD (false) assumption rather than on the new code.
/// The comment `decode_pixels` used to carry — "w*h*4 cannot overflow usize
/// because the encoded payload is capped at ~4MB of base64" — is disproven by
/// this one example: watch it go red by deleting the
/// `dimensions_within_pixel_cap` check in `decode_pixels` (the huge dimensions
/// below would then reach the `vec![0u8; stride * h]` allocation instead of
/// being refused here).
#[test]
fn a_tiny_encoded_payload_can_still_declare_a_multi_gigabyte_canvas() {
    // This is exactly what made the old comment false: nothing about "encoded
    // size" bounds "declared width times height" — a decoder never even has
    // to look at how long the base64 was before it learns the dimensions.
    let width = 30_000u32;
    let height = 30_000u32;
    let declared_bgra_bytes = (width as u64) * (height as u64) * 4;
    assert!(
        declared_bgra_bytes > 3_000_000_000,
        "sanity: this canvas really is multi-gigabyte ({declared_bgra_bytes} bytes)"
    );
    assert!(
        !dimensions_within_pixel_cap(width, height),
        "a canvas this size must be refused before any buffer for it is allocated"
    );
}

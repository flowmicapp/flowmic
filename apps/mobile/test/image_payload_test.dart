// R6 T-4 ① — the pure half of the image chain: bytes → (mime, canonical base64,
// label), and the refusals that must be LOUD.
//
// These rules decide whether a frame the server will accept ever leaves the
// phone, so they are pinned against the protocol's own text: canonical base64
// (InjectImageBase64Schema's refine), the three-value mime enum, and the
// 5_500_000 ceiling the phone's own budget must stay under.
//
// SPEC-REF: packages/protocol/src/protocol-schemas-inject.ts;
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4 ①;
//   CLAUDE.md red line 「没有静默失败」 (over-budget is refused, never truncated).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart';
import 'package:flutter_test/flutter_test.dart';

/// A real 2×2 RGBA PNG — the SAME bytes the desktop's WIC decode test uses, so
/// both ends are proven against one artefact rather than two lookalikes.
final Uint8List kPng2x2 = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

Uint8List _bytes(List<int> b) => Uint8List.fromList(b);

void main() {
  group('signature sniffing (never the file name)', () {
    test('the three admitted formats are recognised by magic bytes', () {
      expect(sniffImageMime(kPng2x2), ImageMime.png);
      expect(sniffImageMime(_bytes(<int>[0xFF, 0xD8, 0xFF, 0xE0])), ImageMime.jpeg);
      expect(
        sniffImageMime(_bytes(<int>[
          0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, //
          0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
        ])),
        ImageMime.webp,
      );
    });

    test('anything else is unknown — including a RIFF that is not WebP', () {
      expect(sniffImageMime(_bytes(<int>[])), isNull);
      expect(sniffImageMime(_bytes(<int>[0x47, 0x49, 0x46, 0x38])), isNull); // GIF
      expect(sniffImageMime(_bytes(<int>[0x42, 0x4D])), isNull); // BMP
      // RIFF/WAVE — the same container, a completely different payload.
      expect(
        sniffImageMime(_bytes(<int>[
          0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, //
          0x57, 0x41, 0x56, 0x45,
        ])),
        isNull,
      );
      // A truncated PNG signature is not a PNG.
      expect(sniffImageMime(kPng2x2.sublist(0, 6)), isNull);
    });
  });

  group('encoding + the send budget', () {
    test('a real PNG becomes canonical base64 the schema would accept', () {
      final ImageEncodeResult r = encodeImagePayload(kPng2x2);
      final ImagePayload p = r.payload!;
      expect(p.mime, ImageMime.png);
      expect(p.mime.wire, 'image/png');
      expect(p.byteLength, kPng2x2.length);
      // The exact rule InjectImageBase64Schema's refine states.
      expect(p.b64.length % 4, 0);
      expect(RegExp(r'^[A-Za-z0-9+/]+={0,2}$').hasMatch(p.b64), isTrue);
      expect(p.b64.contains('\n'), isFalse, reason: 'no line wrapping');
      expect(p.b64.startsWith('data:'), isFalse, reason: 'no data: prefix');
      // …and it round-trips to the original bytes.
      expect(base64Decode(p.b64), kPng2x2);
    });

    test('an empty file is refused as empty, not as an unknown format', () {
      final ImageEncodeResult r = encodeImagePayload(Uint8List(0));
      expect(r.payload, isNull);
      expect(r.rejection, ImageRejection.empty);
    });

    test('an unsupported format is refused BY NAME before any size question',
        () {
      // A big GIF: if the order were wrong this would read as "too large".
      final ImageEncodeResult r = encodeImagePayload(
        Uint8List.fromList(<int>[0x47, 0x49, 0x46, 0x38, ...List<int>.filled(9_000_000, 0)]),
      );
      expect(r.rejection, ImageRejection.unsupportedFormat);
      expect(r.byteLength, greaterThan(0), reason: 'the real size is carried');
    });

    test('an over-budget picture is REFUSED with its real size, never truncated',
        () {
      // A valid PNG signature followed by enough filler to blow the budget.
      final Uint8List huge = Uint8List.fromList(<int>[
        ...kPng2x2,
        ...List<int>.filled(kInjectImageB64Budget, 0x7F),
      ]);
      final ImageEncodeResult r = encodeImagePayload(huge);
      expect(r.payload, isNull, reason: 'nothing is sent');
      expect(r.rejection, ImageRejection.tooLarge);
      expect(r.b64Length, greaterThan(kInjectImageB64Budget));
      expect(r.byteLength, huge.length);
    });

    // ── Card B4-1: the budget is 5,200,000 and the slack has ONE real reason ────
    //
    // ⚠️ The assertion that used to stand here said 「headroom for the JSON
    // envelope」 and demanded `> 1_000_000` of slack. It was pinning a false
    // claim: [kInjectImageB64Max] is a FIELD cap (zod `.max()` on `image_b64`
    // alone), so an envelope cannot push that field over its own ceiling — and
    // the framing it named measures 21 bytes. Rewritten rather than deleted so
    // the next reader sees WHY a 1.5 M slack existed and why it does not now.
    test('the budget stays under the protocol field cap — because the PHONE '
        'must be the end that refuses', () {
      expect(kInjectImageB64Max, 5500000, reason: 'mirrors the zod .max()');
      expect(kInjectImageB64Budget, 5200000);
      // Strictly under: a zod-boundary rejection is anonymous and silent, and
      // the desktop's Rust mirror only logs. This budget refuses with a
      // sentence and the real byte count, so it has to trip first.
      expect(kInjectImageB64Budget, lessThan(kInjectImageB64Max));
      // Never ABOVE the field cap: that is a protocol change (zod + the desktop
      // Rust mirror + a relay deploy), not a bigger version of this one.
      expect(kInjectImageB64Budget, lessThanOrEqualTo(kInjectImageB64Max));
    });

    test('a REAL 8 MP camera original now fits — the refusal owner asked us to '
        'remove', () {
      // 3,206,853 B is not a round number: it is the byte count of an actual
      // photo pulled off a device (/sdcard/DCIM/Camera) during this card.
      const int realCameraOriginalBytes = 3206853;
      const int b64 = ((realCameraOriginalBytes + 2) ~/ 3) * 4;
      expect(b64, 4275804);
      expect(b64, lessThanOrEqualTo(kInjectImageB64Budget),
          reason: 'at the old 4,000,000 this was 106.9 % and was refused');
      expect(b64, lessThanOrEqualTo(kInjectImageB64Max));
    });

    test('BOUNDARY — a payload EXACTLY at the budget is accepted', () {
      // ceil(3_900_000 / 3) * 4 == 5_200_000 exactly.
      final Uint8List atCap = Uint8List(3900000);
      atCap.setRange(0, kPng2x2.length, kPng2x2);
      final ImageEncodeResult r = encodeImagePayload(atCap);
      expect(r.payload, isNotNull, reason: 'at the cap passes, exactly like zod');
      expect(r.payload!.b64.length, kInjectImageB64Budget);
    });

    test('BOUNDARY — one base64 quad OVER the budget is refused', () {
      final Uint8List overCap = Uint8List(3900003);
      overCap.setRange(0, kPng2x2.length, kPng2x2);
      final ImageEncodeResult r = encodeImagePayload(overCap);
      expect(r.payload, isNull);
      expect(r.rejection, ImageRejection.tooLarge);
      expect(r.b64Length, kInjectImageB64Budget + 4,
          reason: 'the boundary is exact, not approximate');
    });
  });

  group('the row face', () {
    test('the label is locale-neutral and states format + real size', () {
      expect(imageEntryLabel(ImageMime.png, 512), '🖼 PNG · 512 B');
      expect(imageEntryLabel(ImageMime.jpeg, 219136), '🖼 JPEG · 214 KB');
      expect(imageEntryLabel(ImageMime.webp, 1258291), '🖼 WEBP · 1.2 MB');
      // No CJK and no English words — nothing to go stale when the UI language flips.
      expect(RegExp(r'[一-鿿]').hasMatch(imageEntryLabel(ImageMime.png, 1)), isFalse);
    });

    test('byte sizes read the same everywhere they appear', () {
      expect(formatBytes(0), '0 B');
      expect(formatBytes(1023), '1023 B');
      expect(formatBytes(1024), '1 KB');
      expect(formatBytes(1048576), '1.0 MB');
    });

    test('the payload label is the same function the timeline row uses', () {
      final ImagePayload p = encodeImagePayload(kPng2x2).payload!;
      expect(p.label, imageEntryLabel(ImageMime.png, kPng2x2.length));
    });
  });
}

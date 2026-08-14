// RV-21 / card D6: thumbnail longest-edge 256 + corrupt decode cached as absent.
//
// SPEC-REF: apps/mobile/lib/src/session/image_thumbnail.dart;
//   packages/protocol HistoryItemSchema.thumb_b64 (longest edge 256 px).

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flowmic/src/session/image_thumbnail.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<Uint8List> _pngOfSize(int width, int height) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF336699),
  );
  final ui.Image image = await recorder.endRecording().toImage(width, height);
  final ByteData? png = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return png!.buffer.asUint8List();
}

Future<({int w, int h})> _decodeSize(Uint8List pngBytes) async {
  final ui.Codec codec = await ui.instantiateImageCodec(pngBytes);
  final ui.FrameInfo frame = await codec.getNextFrame();
  final int w = frame.image.width;
  final int h = frame.image.height;
  frame.image.dispose();
  codec.dispose();
  return (w: w, h: h);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('encodeThumbnail — longest edge ≤ 256, aspect kept', () {
    test('portrait 100×400 scales on height', () async {
      final Uint8List src = await _pngOfSize(100, 400);
      final String? b64 = await encodeThumbnail(src);
      expect(b64, isNotNull);
      final ({int w, int h}) out = await _decodeSize(base64Decode(b64!));
      expect(math.max(out.w, out.h), lessThanOrEqualTo(kThumbMaxEdge));
      expect(out.h, kThumbMaxEdge, reason: 'portrait long edge is height');
      expect(out.w / out.h, closeTo(100 / 400, 0.02));
    });

    test('landscape 400×100 scales on width', () async {
      final Uint8List src = await _pngOfSize(400, 100);
      final String? b64 = await encodeThumbnail(src);
      expect(b64, isNotNull);
      final ({int w, int h}) out = await _decodeSize(base64Decode(b64!));
      expect(math.max(out.w, out.h), lessThanOrEqualTo(kThumbMaxEdge));
      expect(out.w, kThumbMaxEdge, reason: 'landscape long edge is width');
      expect(out.w / out.h, closeTo(400 / 100, 0.02));
    });
  });

  group('decodedThumbnail — failures cached as absent', () {
    setUp(clearThumbnailCache);

    test('corrupt bytes: second call hits cache, does not re-decode', () {
      const String bad = 'not!!!base64';
      expect(decodedThumbnail(bad), isNull);
      expect(
        thumbnailCacheContains(bad),
        isTrue,
        reason: 'FormatException must cache absent or every frame re-decodes',
      );
      expect(decodedThumbnail(bad), isNull);
      expect(thumbnailCacheContains(bad), isTrue);
    });
  });
}

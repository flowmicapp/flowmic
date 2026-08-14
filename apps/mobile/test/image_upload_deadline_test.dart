// RV-10 / card B7: the image HTTP poster must not hang forever when the body
// write stalls (EMUI background TCP kill without RST). uploadImageInject wraps
// the whole poster call in a total deadline and returns unreachable — never a
// permanent _sending latch with a frozen progress bar and no banner.
//
// SPEC-REF: apps/mobile/lib/src/session/image_upload.dart

import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/session/image_upload.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('hanging poster returns unreachable within the injected deadline', () {
    fakeAsync((FakeAsync async) {
      ImageUploadResult? result;

      // Completer.future never completes — models flush() hung at OS retransmit.
      final Completer<({int status, String body})> stuck =
          Completer<({int status, String body})>();

      final Future<ImageUploadResult> pending = uploadImageInject(
        endpoint: 'http://127.0.0.1:9/',
        token: 't',
        item: const <String, Object?>{},
        request: const <String, Object?>{},
        // Short only in the test; production default stays kImageUploadDeadline.
        deadline: const Duration(seconds: 2),
        poster:
            (
              Uri url,
              String token,
              Uint8List body,
              ImageUploadProgress? onProgress,
            ) => stuck.future,
      );
      pending.then((ImageUploadResult r) => result = r);

      expect(result, isNull, reason: 'must not resolve before the deadline');
      async.elapse(const Duration(seconds: 1));
      expect(result, isNull, reason: 'still inside the 2 s budget');
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();

      expect(result, isNotNull);
      expect(result!.status, ImageUploadStatus.unreachable);
      expect(result!.detail, contains('deadline'));
    });
  });

  test('production default deadline is 40 s (budget table total)', () {
    expect(kImageUploadDeadline, const Duration(seconds: 40));
    // The close ceiling must stay STRICTLY above the server's own 15 s wait for
    // the PC verdict: equal would race the honest INJECT_RESULT_TIMEOUT answer
    // and report unreachable for a body the PC already has (→ auto-retry →
    // double paste, RV-04). See the budget table in image_upload.dart.
    expect(kImageUploadCloseTimeout, greaterThan(const Duration(seconds: 15)));
    expect(
      kImageUploadConnectTimeout +
          kImageUploadWriteTimeout +
          kImageUploadCloseTimeout,
      kImageUploadDeadline,
      reason: 'sub-timeouts must sum to ≤ total or a stage timeout is a lie',
    );
  });
}

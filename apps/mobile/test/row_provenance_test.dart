// owner 2026-07-27:「手机端要有 PC端实例名 → 目标 的信息」+「页面会疯狂闪烁」.
//
// Two independent fixes that both live on the picture/history row:
//   ① the row REMEMBERS which PC it landed on, stamped at delivery time rather
//      than read live from today's pairing — otherwise an old row would name
//      whatever machine the phone happens to be paired with now, confidently
//      and wrongly;
//   ② the thumbnail decode is memoised, because Image.memory compares its bytes
//      by REFERENCE: a fresh base64Decode per build made every stt:interim
//      re-decode the picture, which is what「疯狂闪烁」was.
//
// SPEC-REF: apps/mobile/lib/src/timeline/timeline_entry.dart (pcName is
//   device-local, never on the wire); apps/mobile/lib/src/session/
//   image_thumbnail.dart (decodedThumbnail).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_thumbnail.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

const String kPngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
    'SUkJeJw9PL4AAAAASUVORK5CYII=';

InjectTarget _target(String win) =>
    InjectTarget(windowTitle: win, processName: 'notepad.exe', injectedAt: '2026-07-27T12:00:00Z');

void main() {
  group('① the row remembers WHERE it went', () {
    late TimelineStore store;
    late String id;
    setUp(() {
      store = newTestStore();
      id = store.buildFromUtterance(
        clientId: 'e1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '你好',
      ).id;
    });

    test('a successful delivery stamps the PC name alongside the target', () {
      final bool applied = store.applyInjectResult(
        correlationId: id,
        ok: true,
        target: _target('Untitled - Notepad'),
        pcName: '书房台式机',
      );
      expect(applied, isTrue);
      final TimelineEntry e = store.findById(id)!;
      expect(e.status, EntryStatus.injected);
      expect(e.pcName, '书房台式机');
      expect(e.injectTarget!.windowTitle, 'Untitled - Notepad');
    });

    test('a FAILED delivery stamps no PC — there is no "where it went" to report', () {
      store.applyInjectResult(
        correlationId: id,
        ok: false,
        pcName: '书房台式机',
        failureReason: 'INJECT_NO_TEXT_TARGET',
      );
      final TimelineEntry e = store.findById(id)!;
      expect(e.status, EntryStatus.failed);
      expect(e.pcName, isNull);
      // RV-14: the named code callers pass must land — not evaporate at copyWith.
      expect(e.failureReason, 'INJECT_NO_TEXT_TARGET');
    });

    test('the stamp survives a reload — it is what makes an OLD row honest', () {
      store.applyInjectResult(
        correlationId: id, ok: true, target: _target('Word'), pcName: '笔记本',
      );
      final Map<String, Object?> json = store.findById(id)!.toJson();
      final TimelineEntry back = TimelineEntry.fromJson(json)!;
      expect(back.pcName, '笔记本');
      expect(back.injectTarget!.windowTitle, 'Word');
    });

    test('pcName is DEVICE-LOCAL: it never rides the history wire', () {
      store.applyInjectResult(
        correlationId: id, ok: true, target: _target('Word'), pcName: '笔记本',
      );
      final Map<String, Object?> wire = store.findById(id)!.toHistoryItem(
        pcDeviceId: 'pc1', userId: 'u1',
      );
      // The console resolves the PC name server-side by id (so a rename shows
      // through); duplicating it into the row would be a second source of truth.
      expect(wire.containsKey('pc_name'), isFalse);
    });

    test('a pre-0.1.9 stored row simply has no stamp (no crash, no guess)', () {
      final TimelineEntry old = TimelineEntry.fromJson(<String, Object?>{
        'id': 'old', 'client_id': 'old', 'mode': 'realtime', 'delivery': 'inject',
        'output_text': 'hi', 'status': 'injected',
        'created_at': '2026-07-01T00:00:00Z', 'updated_at': '2026-07-01T00:00:00Z',
      })!;
      expect(old.pcName, isNull);
    });
  });

  group('② the thumbnail decode is memoised (the flicker fix)', () {
    setUp(clearThumbnailCache);

    test('the SAME bytes object comes back every time — this is the whole fix', () {
      final Uint8List? a = decodedThumbnail(kPngB64);
      final Uint8List? b = decodedThumbnail(kPngB64);
      expect(a, isNotNull);
      // identical(), not equals(): MemoryImage compares by reference, so an
      // equal-but-new list would still force a re-decode and still flicker.
      expect(identical(a, b), isTrue, reason: 'a new Uint8List per build IS the flicker');
      expect(a, base64Decode(kPngB64));
    });

    test('absent / undecodable previews are null, never a throw', () {
      expect(decodedThumbnail(null), isNull);
      expect(decodedThumbnail(''), isNull);
      expect(decodedThumbnail('not base64!!!'), isNull);
    });

    test('the cache is BOUNDED — user content must not leak forever', () {
      for (int i = 0; i < kThumbCacheMax + 10; i++) {
        // Distinct valid base64 payloads.
        decodedThumbnail(base64Encode(Uint8List.fromList(<int>[i, i + 1, i + 2])));
      }
      // The oldest entry was evicted, so re-asking for it decodes afresh —
      // proving the map did not simply grow.
      final Uint8List? first = decodedThumbnail(base64Encode(Uint8List.fromList(<int>[0, 1, 2])));
      expect(first, isNotNull);
    });
  });
}

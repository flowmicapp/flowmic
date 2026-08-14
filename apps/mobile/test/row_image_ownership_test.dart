// SPEC-REF:
//   docs/decisions/2026-08-01-image-two-sizes-both-ends.md
//     (owner: 「双击之后，能够预览相对大的图」+ amendment「投递成功即删，改为存下来」)
//
// 🔴 Ownership: the picture bytes belong to "this row of the timeline"; the
// queue is only a consumer.
//
// Why this group is its own file, not left in outbox_test.dart: that file
// tests the **queue**, and what this group has to prove is precisely that
// "the picture is reachable **without going through the queue**". Owner has
// already ruled the queue over-designed and will open an audit window to
// subtract (15 册 G-12); if these assertions lived in the queue's test file,
// that subtraction would read them as "part of the queue". The criterion is
// the entry itself: `RowImageStore.pathFor(entry.clientId)`.
//
// (There is also an immediate reason for the split: outbox_test.dart is
// already sitting on the 1200-line test-file cap.)

import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart'
    show ImageMime, imageBlobExtension;
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/row_image_lookup.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

final Uint8List kPng = Uint8List.fromList(<int>[1, 2, 3, 4]);

/// One picture row, built the way production builds it: `clientId` = that
/// delivery's `request_id`
/// (image_send_controller: `buildDeliveryRow(clientId: requestId)`).
TimelineEntry imageRow(String requestId, {String entryType = TimelineEntry.kImage}) {
  final DateTime t = DateTime.utc(2026, 8, 1);
  return TimelineEntry(
    id: TimelineEntry.mintLocId('dev-1', requestId),
    clientId: requestId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: '🖼 PNG · 4 B',
    outputText: '🖼 PNG · 4 B',
    status: EntryStatus.injected,
    entryType: entryType,
    thumbB64: 'dGh1bWI=',
    createdAt: t,
    updatedAt: t,
  );
}

void main() {
  test('the row can fetch the large picture by its own id (the queue does not take part)', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    await images.put(requestId: 'i0-1', bytes: kPng, extension: 'png');

    // There is no DeliveryOutbox and no OutboxItem here — after the queue is
    // cut away this must still be the result.
    final Uint8List? big = await rowImageBytes(images, imageRow('i0-1'));
    expect(big, kPng);
  });

  // 🔴 The easiest place to get it wrong, and getting it wrong does not throw:
  // asking with entry.id. The row id is `loc_<device>_<clientId>`, the
  // filename is request_id ⇒ asking with id never finds it, and the answer
  // is "an empty value" rather than an exception (the isomorphic variant of
  // 13 册 §7 F1 ⑤).
  test('⟲ reverse control: looking up by the row id (loc_ prefix) never finds it', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    await images.put(requestId: 'i0-1', bytes: kPng, extension: 'png');
    final TimelineEntry row = imageRow('i0-1');
    expect(row.id, isNot('i0-1'), reason: 'positive probe: the two ids really differ');
    expect(await images.pathFor(row.id), isNull);
    // And looking up by clientId finds it — proving the null above is
    // "asked the wrong question", not "never stored".
    expect(await images.pathFor(row.clientId), isNotNull);
  });

  test('a transcript row has no large picture ⇒ answers null honestly, does not touch storage', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    await images.put(requestId: 'i0-1', bytes: kPng, extension: 'png');
    final TimelineEntry text = imageRow(
      'i0-1',
      entryType: TimelineEntry.kTranscript,
    );
    expect(await rowImageBytes(images, text), isNull);
  });

  test('a picture row whose bytes are gone (old row / deleted externally) ⇒ null, the caller falls back to the thumbnail', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    expect(await rowImageBytes(images, imageRow('gone-1')), isNull);
  });

  // 🔴 Anti-drift: the probe list must cover every output of
  // imageBlobExtension. Missing one does not throw — it means "the large
  // picture of that kind never opens", which is again an empty value with
  // no symbol to grep.
  test('kRowImageExtensions covers every mime imageBlobExtension produces', () {
    for (final ImageMime mime in ImageMime.values) {
      expect(
        kRowImageExtensions,
        contains(imageBlobExtension(mime)),
        reason: 'after $mime is written to disk the row will not be able to recover its large picture',
      );
    }
  });

  test('all three extensions can be recovered (one each of png/jpg/webp)', () async {
    final InMemoryOutboxBlobStore images = InMemoryOutboxBlobStore();
    for (final ImageMime mime in ImageMime.values) {
      final String id = 'i-${mime.name}';
      await images.put(
        requestId: id,
        bytes: kPng,
        extension: imageBlobExtension(mime),
      );
      expect(await rowImageBytes(images, imageRow(id)), kPng, reason: '$mime');
    }
  });
}

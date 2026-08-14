// Card E-CL — what travels inside the envelope, and what deliberately does not.
//
// The load-bearing assertion here is the SUBTRACTION: design §3.1 says
// "do not upload image bytes", and the thumbnail is image bytes. A test that only checked
// the round trip would pass just as happily with the picture attached.

import 'dart:convert';

import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

/// A picture row carrying a recognisable thumbnail.
TimelineEntry _imageEntry({String thumb = 'THUMBNAILBYTESAAA'}) =>
    TimelineEntry.fromJson(<String, Object?>{
      'id': 'loc_dev_img1',
      'client_id': 'img1',
      'origin': 'cloud',
      'entry_type': TimelineEntry.kImage,
      'output_text': '🖼 PNG · 78 KB',
      'thumb_b64': thumb,
      'status': 'noted',
      'created_at': '2026-08-08T01:02:03.000Z',
      'updated_at': '2026-08-08T01:02:03.000Z',
    })!;

TimelineEntry _textEntry({String text = 'a light record'}) =>
    TimelineEntry.fromJson(<String, Object?>{
      'id': 'loc_dev_e1',
      'client_id': 'e1',
      'origin': 'cloud',
      'output_text': text,
      'source_text': text,
      'mode': 'realtime',
      'delivery': 'none',
      'status': 'noted',
      'created_at': '2026-08-08T01:02:03.000Z',
      'updated_at': '2026-08-08T01:02:03.000Z',
    })!;

void main() {
  test('a text record round-trips through the payload', () {
    final TimelineEntry e = _textEntry();
    final TimelineEntry back = decodeBlindStorePayload(
      encodeBlindStorePayload(e),
    )!;

    expect(back.id, e.id);
    expect(back.clientId, e.clientId);
    expect(back.outputText, e.outputText);
    expect(back.sourceText, e.sourceText);
    expect(back.origin, 'cloud');
    expect(back.status, e.status);
    expect(back.createdAt, e.createdAt);
  });

  group('🔴 image BYTES do not go up (design §3.1)', () {
    test('the thumbnail is absent from the payload and from the decode', () {
      final TimelineEntry e = _imageEntry();
      final String payload = encodeBlindStorePayload(e);

      // The bytes are not in the string that gets sealed...
      expect(payload, isNot(contains('THUMBNAILBYTESAAA')));
      expect(payload, isNot(contains(kBlindStoreStrippedImageKey)));
      // ...and the reader does not invent them either.
      expect(decodeBlindStorePayload(payload)!.thumbB64, isNull);
    });

    test('the picture ROW still travels — only the pixels stay home', () {
      final TimelineEntry back = decodeBlindStorePayload(
        encodeBlindStorePayload(_imageEntry()),
      )!;
      // A second device must still learn "there was a picture here" and where it sits.
      expect(back.isImage, isTrue);
      expect(back.entryType, TimelineEntry.kImage);
      expect(back.outputText, '🖼 PNG · 78 KB');
    });

    test('re-thumbnailing does not look like an edit', () {
      // The stated pay-off of stripping: the fingerprint cannot move when only
      // the preview changes, so a re-thumbnailed row does not burn a fresh seq
      // on every device.
      final String a = blindStorePayloadHash(
        encodeBlindStorePayload(_imageEntry(thumb: 'AAAA')),
      );
      final String b = blindStorePayloadHash(
        encodeBlindStorePayload(_imageEntry(thumb: 'BBBBBBBBBBBB')),
      );
      expect(a, b);
    });
  });

  group('the fingerprint answers exactly one question', () {
    test('same content, same hash — twice', () {
      final String a = blindStorePayloadHash(
        encodeBlindStorePayload(_textEntry()),
      );
      final String b = blindStorePayloadHash(
        encodeBlindStorePayload(_textEntry()),
      );
      expect(a, b);
    });

    test('changed content, changed hash', () {
      final String a = blindStorePayloadHash(
        encodeBlindStorePayload(_textEntry(text: 'before')),
      );
      final String b = blindStorePayloadHash(
        encodeBlindStorePayload(_textEntry(text: 'after')),
      );
      expect(a, isNot(b));
    });

    test('a decoded remote entry re-encodes to the same hash', () {
      // This is what stops a pull→push loop: after merging, the local copy must
      // fingerprint identically to what the cloud holds, or stage 2 would push
      // it straight back up as an edit and every device would re-pull forever.
      final String payload = encodeBlindStorePayload(_textEntry());
      final TimelineEntry back = decodeBlindStorePayload(payload)!;
      expect(
        blindStorePayloadHash(encodeBlindStorePayload(back)),
        blindStorePayloadHash(payload),
      );
    });
  });

  group('unreadable payloads are refused, never half-read', () {
    test('a NEWER payload version is refused whole', () {
      final String fromTheFuture = jsonEncode(<String, Object?>{
        'v': kBlindStorePayloadVersion + 1,
        'entry': <String, Object?>{'id': 'x', 'client_id': 'x'},
      });
      // 🔴 Not 「read the keys we recognise」: that would silently drop whatever
      // the newer build cared about and then push the truncated row back up.
      expect(decodeBlindStorePayload(fromTheFuture), isNull);
    });

    test('garbage and shape errors answer null rather than throwing', () {
      expect(decodeBlindStorePayload('not json at all'), isNull);
      expect(decodeBlindStorePayload('[]'), isNull);
      expect(decodeBlindStorePayload('{"v":1}'), isNull);
      expect(decodeBlindStorePayload('{"v":1,"entry":{}}'), isNull);
    });
  });
}

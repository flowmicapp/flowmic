// Cards CV-1 / PR-1, phone side: parsing the coverage receipt off a terminal
// `stt:final`, and the capability bits off a pair / reconnect ack.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (b) and (c)
//           lib/src/stt/stt_stream.dart (CoverageReceipt)
//           lib/src/signaling/server_capabilities.dart
//
// 🔴 NEITHER OF THESE HAS A CONSUMER YET — card RC-1 is the reader. So what is
// under test is exactly and only what this card claims: the facts arrive, the
// absent cases stay absent, and no default is invented in the direction that
// would let a later consumer think it is safe to delete a recording.

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/stt/stt_stream.dart';

Map<String, Object?> terminal(Map<String, Object?> extra) => <String, Object?>{
      'text': 'hello',
      'confidence': 0.9,
      'language': 'en',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 4200,
      ...extra,
    };

void main() {
  group('CoverageReceipt — off the terminal final', () {
    test('a full receipt round-trips, echoes included', () {
      final SttFinal? f = SttFinal.tryFromJson(terminal(<String, Object?>{
        'coverage_receipt_version': 1,
        'fed_frames': 21,
        'seq_gaps': 0,
        'drops': 0,
        'engine_leg_rollovers': 1,
        'ended_normally': true,
        'recording_id': 'rec-7f3a',
        'attempt_id': 'att-2',
        'range_start_sample': 0,
        'range_end_sample': 320000,
      }));
      expect(f, isNotNull);
      final CoverageReceipt r = f!.coverage!;
      expect(r.version, 1);
      expect(r.fedFrames, 21);
      expect(r.seqGaps, 0);
      expect(r.drops, 0);
      expect(r.engineLegRollovers, 1);
      expect(r.endedNormally, isTrue);
      expect(r.recordingId, 'rec-7f3a');
      expect(r.attemptId, 'att-2');
      expect(r.rangeStartSample, 0);
      expect(r.rangeEndSample, 320000);
    });

    test('a final with no receipt parses, and coverage is null', () {
      // Every pre-card server, every stripping relay, and every soft-segment
      // final. The rest of the frame must be untouched by this card.
      final SttFinal? f = SttFinal.tryFromJson(terminal(const <String, Object?>{}));
      expect(f, isNotNull);
      expect(f!.coverage, isNull);
      expect(f.text, 'hello');
      expect(f.durationMs, 4200);
    });

    test('🔴 no version ⇒ no receipt, even when every counter is present', () {
      // The version is the one field with no safe default. Counters without a
      // version are a receipt of unknown provenance, and defaulting it to 1
      // would invent the very fact that decides what the rest is worth.
      final SttFinal? f = SttFinal.tryFromJson(terminal(<String, Object?>{
        'fed_frames': 21, 'seq_gaps': 0, 'drops': 0,
        'engine_leg_rollovers': 0, 'ended_normally': true,
      }));
      expect(f!.coverage, isNull);
      for (final Object? bad in <Object?>[0, -1, '1', 1.5, null]) {
        final SttFinal? g = SttFinal.tryFromJson(
          terminal(<String, Object?>{'coverage_receipt_version': bad, 'ended_normally': true}),
        );
        expect(g!.coverage, isNull, reason: 'version $bad must not produce a receipt');
      }
    });

    test('🔴 ended_normally defaults to FALSE, the direction that cannot mislead', () {
      // Absent / non-boolean must never read as "ended cleanly": that is the
      // half of the cleanup threshold whose true value licenses a deletion.
      for (final Object? bad in <Object?>[null, 'true', 1, <String>[]]) {
        final SttFinal? f = SttFinal.tryFromJson(
          terminal(<String, Object?>{'coverage_receipt_version': 1, 'ended_normally': bad}),
        );
        expect(f!.coverage!.endedNormally, isFalse, reason: 'ended_normally $bad');
      }
    });

    test('malformed counters fall back to 0 and malformed echoes to null', () {
      final SttFinal? f = SttFinal.tryFromJson(terminal(<String, Object?>{
        'coverage_receipt_version': 1,
        'fed_frames': '21', 'seq_gaps': -1, 'drops': null,
        'recording_id': '', 'range_start_sample': -5,
      }));
      final CoverageReceipt r = f!.coverage!;
      expect(<int>[r.fedFrames, r.seqGaps, r.drops, r.engineLegRollovers], <int>[0, 0, 0, 0]);
      // 🔴 0 gaps and 0 drops are the GOOD-looking values, so this fallback is
      // only safe because the threshold also needs ended_normally (false here)
      // and a persisted row. It is written down so a future consumer that drops
      // one of those two conditions sees why it may not.
      expect(r.endedNormally, isFalse);
      expect(r.recordingId, isNull);
      expect(r.rangeStartSample, isNull);
    });

    test('an unknown FUTURE version still parses — the consumer decides, not the parser', () {
      final SttFinal? f = SttFinal.tryFromJson(
        terminal(<String, Object?>{'coverage_receipt_version': 99, 'ended_normally': true}),
      );
      expect(f!.coverage!.version, 99);
    });
  });

  group('ServerCapabilities — off a pair / reconnect ack', () {
    test('parses the two advertised bits', () {
      final ServerCapabilities c = parseServerCapabilities(<String, Object?>{
        'pairing_id': 'p1',
        'capabilities': <String>[kCapabilityCoverageReceipt, kCapabilityDeliveryNoneSafe],
      });
      expect(c.known, isTrue);
      expect(c.coverageReceipt, isTrue);
      expect(c.deliveryNoneSafe, isTrue);
      // The bit no server advertises yet. Fail-closed is the default and the
      // whole reason card RC-1 can hold audio instead of gambling with it.
      expect(c.has(kCapabilityIdempotentOperation), isFalse);
    });

    test('🔴 "no key" and "empty list" are different facts', () {
      final ServerCapabilities missing = parseServerCapabilities(<String, Object?>{'pairing_id': 'p1'});
      expect(missing.known, isFalse);
      expect(missing.bits, isEmpty);

      final ServerCapabilities stated = parseServerCapabilities(<String, Object?>{'capabilities': <String>[]});
      expect(stated.known, isTrue);
      expect(stated.bits, isEmpty);
      // Both answer false to every bit — the safe direction — but only one of
      // them is the server making a statement, and a diagnostic that cannot tell
      // them apart cannot explain itself.
      expect(missing.coverageReceipt, isFalse);
      expect(stated.coverageReceipt, isFalse);
    });

    test('keeps a bit name this build has never heard of', () {
      final ServerCapabilities c = parseServerCapabilities(<String, Object?>{
        'capabilities': <String>['recovery.something_new'],
      });
      expect(c.has('recovery.something_new'), isTrue);
    });

    test('tolerates junk without throwing, and invents nothing', () {
      expect(parseServerCapabilities(null).known, isFalse);
      expect(parseServerCapabilities(<String, Object?>{'capabilities': 'nope'}).known, isFalse);
      final ServerCapabilities mixed = parseServerCapabilities(<String, Object?>{
        'capabilities': <Object?>[kCapabilityCoverageReceipt, '', 7, null, kCapabilityCoverageReceipt],
      });
      expect(mixed.bits, <String>{kCapabilityCoverageReceipt});
    });

    test('the set is unmodifiable — one writer, no callers editing it in place', () {
      final ServerCapabilities c = parseServerCapabilities(<String, Object?>{
        'capabilities': <String>[kCapabilityCoverageReceipt],
      });
      expect(() => c.bits.add('recovery.forged'), throwsUnsupportedError);
    });
  });
}

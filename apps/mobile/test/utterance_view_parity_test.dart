// Fixture-driven parity for the utterance view (phone half).
//
// The fixture is READ, not restated: ../../verify/fixtures/
// utterance-view-parity.json is the same bytes
// apps/desktop/src/capsule/utterance-view.test.ts loads. A test that copied the
// expectations into this file would stay green while the two ends disagreed,
// which is the whole failure this pair exists to catch.
//
// It drives the PRODUCTION assembly (SegmentBuffer) plus the production settle
// rule, and then asserts the view over it — so a green run says "the phone's
// real accumulator, seen through the real view, produces what the capsule
// produces", not "two hand-written reducers agree".

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/stt/segment_buffer.dart';
import 'package:flowmic/src/stt/utterance_view.dart';
import 'package:flutter_test/flutter_test.dart';

const String _fixturePath = '../../verify/fixtures/utterance-view-parity.json';

void main() {
  final Map<String, Object?> fixture =
      jsonDecode(File(_fixturePath).readAsStringSync()) as Map<String, Object?>;
  final List<Object?> scenarios = fixture['scenarios']! as List<Object?>;

  test('the fixture is actually loaded (a silently empty file must not pass)', () {
    expect(scenarios.length, greaterThanOrEqualTo(5));
  });

  for (final Object? raw in scenarios) {
    final Map<String, Object?> s = raw! as Map<String, Object?>;
    final String name = s['name']! as String;
    final String mode = s['mode']! as String;
    final List<Object?> steps = s['steps']! as List<Object?>;

    test(name, () {
      final SegmentBuffer buf = SegmentBuffer();
      for (int i = 0; i < steps.length; i++) {
        final Map<String, Object?> step = steps[i]! as Map<String, Object?>;
        final String frame = step['frame']! as String;
        final String where = '$name · step $i ($frame)';
        switch (frame) {
          case 'audio:start':
            buf.clear();
          case 'stt:interim':
            buf.put(idx: step['idx']! as int, text: step['text']! as String);
          case 'stt:final':
            final int idx = step['idx']! as int;
            final bool isSegment = step['is_segment'] == true;
            buf.put(
              idx: idx,
              text: step['text']! as String,
              finalized: true,
              durationMs: 1,
            );
            // The production settle rule, mirrored: `_settlesPerSegment`
            // (chat_utterance_settle.dart) is "this mode has no compose task",
            // i.e. realtime. A settled span becomes a ROW and leaves the draft
            // — `_settleSpan` calls `markSettled`. The TERMINAL final settles
            // too, but AFTER the assembly is read, which is why it does not
            // mark here (see the capsule's utterance-view.ts header).
            if (isSegment && mode == 'realtime') buf.markSettled(idx);
        }

        final UtteranceView v = UtteranceView.of(buf);
        expect(v.committed, step['committed'], reason: 'committed @ $where');
        expect(v.pending, step['pending'], reason: 'pending @ $where');
        expect(v.display, step['display'], reason: 'display @ $where');
        // The view may not invent or lose a character relative to the assembly
        // the rest of the phone already uses.
        expect(
          v.display,
          buf.unsettledJoined,
          reason: 'display == SegmentBuffer.unsettledJoined @ $where',
        );
        // The colour split may never claim characters the display does not
        // have, and the black run must be exactly the committed half.
        expect(v.committedChars, lessThanOrEqualTo(v.display.length));
        expect(
          v.display.substring(0, v.committedChars).trimRight(),
          step['committed'],
          reason: 'black run @ $where',
        );
      }
    });
  }

  group('the rules the fixture cannot show twice', () {
    test('an unfinalised gap keeps the later closed slot GREY, never black', () {
      final SegmentBuffer buf = SegmentBuffer();
      buf.put(idx: 0, text: 'still open');
      buf.put(idx: 1, text: 'closed later', finalized: true);
      final UtteranceView v = UtteranceView.of(buf);
      expect(v.committed, '');
      expect(v.pending, 'still open closed later');
      expect(v.committedChars, 0);
    });

    test('a replayed FINAL for a closed slot changes nothing', () {
      final SegmentBuffer buf = SegmentBuffer();
      buf.put(idx: 0, text: 'first.', finalized: true);
      expect(buf.put(idx: 0, text: 'something else', finalized: true), isFalse);
      expect(UtteranceView.of(buf).display, 'first.');
    });
  });
}

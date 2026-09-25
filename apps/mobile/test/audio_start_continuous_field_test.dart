// Card RC-1 (phone half) — `audio:start` says when it opens a LONG recording.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §5 RC-1 (the relay
//     gives a long recording the unbounded engine-reconnect ladder)
//   apps/mobile/lib/src/signaling/wire_payloads.dart `AudioStartPayload.continuous`
//
// The field is `continuous: true`, additive optional on `AudioStartSchema`.
// 🔴 ABSENT IS THE PUSH-TO-TALK ANSWER, and the relay reads it that way: a key
// sent as `false` on every press would be a second spelling of 「not long」, and
// an old relay that strips the key degrades to exactly today's behaviour. The
// recovery leg (`beginBackfill`) does not send it either: it re-feeds a range
// from a file, not a microphone, and it has no ladder to be generous with.
//
// Asserted on the FRAME the transport carried, not on the payload class — the
// class being right and the edge forgetting to pass it are two halves of one
// claim, and only the frame answers both.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

Map<String, Object?> _lastStart(ArticleRig r) {
  final List<EventEnvelope> starts =
      r.transport.emittedWhere(FlowMicEvents.audioStart);
  expect(starts, isNotEmpty, reason: 'positive control: a start went out');
  return starts.last.data! as Map<String, Object?>;
}

void main() {
  test('a long recording\'s audio:start carries continuous: true', () async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    await r.startRecording();

    expect(_lastStart(r)['continuous'], isTrue);

    await r.controller.pttUp();
    r.session.endContinuous();
  });

  test('an ordinary press sends no continuous key at all', () async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    await r.controller.pttDown();

    expect(_lastStart(r).containsKey('continuous'), isFalse);

    await r.controller.pttUp();
  });

  test('a recovery leg (beginBackfill) sends no continuous key at all', () {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);
    expect(
      r.session.beginBackfill(mode: FlowMode.realtime, sourceLang: 'zh'),
      BackfillStart.started,
    );

    expect(_lastStart(r).containsKey('continuous'), isFalse);

    r.session.abortBackfill();
  });
}

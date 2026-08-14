// SEG-2 — the §2-R5 replay trim, through the REAL seam:
// FakeSocketTransport → ReconnectCoordinator ladder → `mobile:reconnect` ack
// (`runMobileReconnect` → `onAccepted`, ptt_reconnect_ack.dart edit ④) →
// `PttSession._reconnectAckAudioSeq` → the provider closure →
// `AudioCapture.bufferedChunkPayloads(cutoffSeq:)` → re-emitted frames.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R5
//     (trim = "do not resend seq ≤ watermark"; missing/malformed ⇒ full replay), §5-4
//     (fail toward duplication, never loss)
//   packages/protocol/src/protocol-schemas-auth.ts
//     (MobileReconnectAckAudioFieldsSchema: int ≥ -1, optional; ABSENCE is the
//      no-session signal — never null, never a sentinel)
//
// The GA-04M ordering (replay only after the rejoin ack) and the
// never-resend-audio:start rule stay pinned by reconnect_test.dart:146/:184 —
// nothing here re-tests them, and nothing in the trim touched reconnect.dart.
//
// REVERSE CONTROL (recorded in the SEG-2 delivery report): flipping the
// predicate in audio_capture.dart from `c.seq > cutoffSeq` to `>=` turns the
// boundary test below red (seq 1 — the chunk AT the watermark — reappears in
// the replay); reverted after recording.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _token = 'tok-test-abcdefghijklmnopqrstuvwxyz012';

/// The rig: a real capture whose ring holds seqs 0,1,2, and a session whose
/// ladder is armed on the fake transport. No spill — this file is about the
/// trim, and disk I/O never completes inside a FakeAsync zone.
({
  FakeSocketTransport transport,
  FakeAudioRecorder recorder,
  AudioCapture capture,
  PttSession session,
}) _rig() {
  final FakeSocketTransport transport = FakeSocketTransport();
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  final AudioCapture capture = AudioCapture(recorder: recorder);
  final PttSession session =
      newTestSession(transport: transport, audio: capture);
  // The reconnected edge re-probes the channel; a FakeAsync zone must never
  // reach the real HttpClient (its I/O would just hang off the fake clock).
  session.healthReader =
      (Uri url, Duration timeout) async => HealthReading.offline;
  return (
    transport: transport,
    recorder: recorder,
    capture: capture,
    session: session,
  );
}

void main() {
  /// Fill the ring (seq 0..2), then drop and let the ladder reconnect with
  /// [ack] queued as the `mobile:reconnect` answer. Returns the seqs replayed.
  List<int> replayedSeqsAfterReconnect(
    FakeAsync async, {
    required Map<String, Object?> ack,
    void Function(FakeSocketTransport t)? betweenSpans,
  }) {
    final rig = _rig();
    rig.transport.pushStatus(SocketStatus.connected);
    unawaited(rig.capture.start());
    async.flushMicrotasks();
    rig.recorder.feed(makePcm(kChunkBytes)); // seq 0
    rig.recorder.feed(makePcm(kChunkBytes)); // seq 1
    rig.recorder.feed(makePcm(kChunkBytes)); // seq 2
    async.flushMicrotasks();
    expect(rig.capture.currentSeq, 3,
        reason: 'positive control: the ring really holds three chunks');

    rig.session.reconnect
        .configure(url: 'ws://x', token: _token, replaceToken: true);
    rig.session.reconnect.start();
    rig.transport.ackQueue.add(ack);
    rig.transport.connectSucceeds = true;
    rig.transport.pushStatus(SocketStatus.disconnected);
    async.elapse(const Duration(seconds: 1)); // rung 1 dials → connected
    async.flushMicrotasks();

    final List<int> seqs = <int>[
      for (final EventEnvelope e in rig.transport.emittedWhere('audio:chunk'))
        (e.data! as Map)['seq']! as int,
    ];
    betweenSpans?.call(rig.transport);
    // Teardown inside the zone so no fake timer leaks across tests.
    rig.session.debugStopIdlePresencePoll();
    unawaited(rig.session.dispose());
    async.flushMicrotasks();
    unawaited(rig.transport.close());
    async.flushMicrotasks();
    return seqs;
  }

  Map<String, Object?> ackWith(Object? watermark) => <String, Object?>{
        'pairing_id': 'pair-test-1',
        'pc_name': 'Test PC',
        'pc_online': true,
        'audio_last_contiguous_seq': ?watermark,
      };

  test('🔴 boundary: watermark 1 ⇒ seq 1 (observed) is NOT re-emitted, '
      'seq 2 (unproven) IS', () {
    fakeAsync((FakeAsync async) {
      final List<int> seqs =
          replayedSeqsAfterReconnect(async, ack: ackWith(1));
      expect(seqs, isNot(contains(1)),
          reason: 'the server STATED it observed seq 1 — resending it is the '
              'duplication this field exists to remove');
      expect(seqs, contains(2),
          reason: 'nothing proves the server holds seq 2 — trimming it would '
              'be loss, the direction §5-4 forbids');
      expect(seqs, <int>[2]);
    });
  });

  test('watermark absent ⇒ full replay (today\'s behaviour, byte-for-byte)',
      () {
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith(null)),
          <int>[0, 1, 2]);
    });
  });

  test('-1 (session live, zero observed) ⇒ full replay', () {
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith(-1)),
          <int>[0, 1, 2]);
    });
  });

  test('malformed watermark (non-int / below the schema floor) ⇒ full replay',
      () {
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith('7')),
          <int>[0, 1, 2],
          reason: 'a string is off-contract; §2-R5: malformed ⇒ full replay');
    });
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith(-5)),
          <int>[0, 1, 2],
          reason: 'below the schema floor (.min(-1)); same rule');
    });
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith(2.5)),
          <int>[0, 1, 2]);
    });
  });

  test('watermark covering the whole ring ⇒ nothing re-emitted (and the '
      'server-side dedup is not even needed)', () {
    fakeAsync((FakeAsync async) {
      expect(replayedSeqsAfterReconnect(async, ack: ackWith(2)), isEmpty);
    });
  });

  test('🔴 staleness: a second span whose ack carries NO watermark falls back '
      'to full replay — the previous span\'s value must not survive', () {
    fakeAsync((FakeAsync async) {
      final rig = _rig();
      rig.transport.pushStatus(SocketStatus.connected);
      unawaited(rig.capture.start());
      async.flushMicrotasks();
      rig.recorder.feed(makePcm(kChunkBytes)); // seq 0
      rig.recorder.feed(makePcm(kChunkBytes)); // seq 1
      rig.recorder.feed(makePcm(kChunkBytes)); // seq 2
      async.flushMicrotasks();
      rig.session.reconnect
          .configure(url: 'ws://x', token: _token, replaceToken: true);
      rig.session.reconnect.start();

      // Span 1: watermark 2 ⇒ everything trimmed.
      rig.transport.ackQueue.add(ackWith(2));
      rig.transport.connectSucceeds = true;
      rig.transport.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(rig.transport.emittedWhere('audio:chunk'), isEmpty,
          reason: 'positive control: span 1 really trimmed at watermark 2');
      // Survive the 5 s stability window so span 2 starts at rung 1 again.
      async.elapse(const Duration(seconds: 6));

      // Span 2: the ack says nothing about audio (e.g. the session aged out
      // of its grace server-side). Stale watermark 2 would trim everything —
      // silently losing whatever the server no longer holds.
      rig.transport.ackQueue.add(ackWith(null));
      rig.transport.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      final List<int> seqs = <int>[
        for (final EventEnvelope e
            in rig.transport.emittedWhere('audio:chunk'))
          (e.data! as Map)['seq']! as int,
      ];
      expect(seqs, <int>[0, 1, 2],
          reason: '`_onReconnected` resets the watermark per span; an absent '
              'field means 「no trimming basis」, never 「same as last time」');

      rig.session.debugStopIdlePresencePoll();
      unawaited(rig.session.dispose());
      async.flushMicrotasks();
      unawaited(rig.transport.close());
      async.flushMicrotasks();
    });
  });

  test('audio:start is never re-sent by a trimmed replay either '
      '(belt on reconnect_test.dart:184\'s pin)', () {
    fakeAsync((FakeAsync async) {
      final rig = _rig();
      rig.transport.pushStatus(SocketStatus.connected);
      unawaited(rig.capture.start());
      async.flushMicrotasks();
      rig.recorder.feed(makePcm(kChunkBytes));
      async.flushMicrotasks();
      rig.session.reconnect
          .configure(url: 'ws://x', token: _token, replaceToken: true);
      rig.session.reconnect.start();
      rig.transport.ackQueue.add(ackWith(-1));
      rig.transport.connectSucceeds = true;
      rig.transport.pushStatus(SocketStatus.disconnected);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(rig.transport.emittedWhere('audio:start'), isEmpty);
      expect(rig.transport.emittedWhere('audio:chunk'), hasLength(1));
      rig.session.debugStopIdlePresencePoll();
      unawaited(rig.session.dispose());
      async.flushMicrotasks();
      unawaited(rig.transport.close());
      async.flushMicrotasks();
    });
  });
}

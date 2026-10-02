// NR-146/R11: reverse control emits kept from the request before confirmation.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';
import 'support/memory_journal_fs.dart';

class _HeldStore extends RetainedAudioStore {
  _HeldStore({required super.dir, required this.fail});
  final bool fail;
  final gate = Completer<void>();
  final entered = Completer<void>();
  @override
  Future<bool> append({required int segmentIdx, required Uint8List bytes}) async {
    if (!entered.isCompleted) entered.complete();
    await gate.future;
    if (fail) throw StateError('tail save refused');
    return super.append(segmentIdx: segmentIdx, bytes: bytes);
  }
}

class _HeldJournalFs extends GatedMemoryJournalFs {
  bool fail = false;
  @override
  Future<void> rename(String from, String to) async {
    if (fail) throw StateError('tail manifest refused');
    await super.rename(from, to);
  }
}

void main() {
  for (final bool fail in <bool>[false, true]) {
    test('held tail write: ${fail ? 'failure never claims kept' : 'kept only after flush'}', () async {
      final tmp = await Directory.systemTemp.createTemp('nr146-tail-');
      final store = _HeldStore(dir: tmp, fail: fail);
      await store.open();
      final spill = RetainedAudioSpill(store: store);
      final recorder = FakeAudioRecorder();
      final capture = AudioCapture(recorder: recorder, spill: spill);
      final transport = FakeSocketTransport();
      final session = newTestSession(transport: transport, audio: capture,
        stateMachine: FlowmicStateMachine(sessionDropGrace: const Duration(milliseconds: 10)));
      final reasons = <String>[];
      session.autoStopped.listen(reasons.add);
      try {
        transport.pushStatus(SocketStatus.connected);
        await pumpEventQueue();
        expect(await session.pttDown(), isTrue);
        recorder.feed(makePcm(kChunkBytes));
        await pumpEventQueue();
        final stopped = capture.state.firstWhere((s) => s == RecorderState.stopped);
        transport.pushStatus(SocketStatus.disconnected);
        await stopped.timeout(const Duration(seconds: 3));
        await store.entered.future.timeout(const Duration(seconds: 3));
        await pumpEventQueue();
        expect(capture.currentState, RecorderState.stopped);
        expect(reasons, isEmpty, reason: 'no kept notice while the write is blocked');
        store.gate.complete();
        expect(await capture.tailRetentionConfirmed, !fail);
        await pumpEventQueue();
        expect(reasons, <String>[fail ? kLocalStopReasonLinkLoss : kLocalStopReasonLinkLossKept]);
        if (fail) {
          expect(store.lastNotice.value?.code, RetainedAudioNotice.codeWriteFailed);
        } else {
          expect((await spill.readSegment(0))!.length, kChunkBytes);
        }
      } finally {
        if (!store.gate.isCompleted) store.gate.complete();
        await session.dispose(); await transport.close(); await store.dispose(); await removeTempDir(tmp);
      }
    });
  }

  for (final bool fail in <bool>[false, true]) {
  test('journal confirmation waits for publish, fail=$fail', () async {
    final tmp = await Directory.systemTemp.createTemp('nr146-journal-tail-');
    final store = RetainedAudioStore(dir: tmp);
    await store.open();
    final fs = _HeldJournalFs();
    final spill = RetainedAudioSpill(store: store, retainFromFirstFrame: true, journalFs: fs);
    final recorder = FakeAudioRecorder();
    final capture = AudioCapture(recorder: recorder, spill: spill);
    try {
      await capture.start(); recorder.feed(makePcm(kChunkBytes)); await pumpEventQueue();
      fs.gate = Completer<void>();
      expect(capture.stopForLinkLoss(), isTrue);
      bool confirmed = false;
      unawaited(capture.tailRetentionConfirmed.then((_) => confirmed = true));
      await pumpEventQueue();
      expect(fs.blocked, isTrue);
      expect(confirmed, isFalse);
      fs.fail = fail;
      fs.gate!.complete();
      expect(await capture.tailRetentionConfirmed, !fail);
      if (fail) expect(store.lastNotice.value?.code, RetainedAudioNotice.codeCommitFailed);
    } finally {
      if (fs.gate != null && !fs.gate!.isCompleted) fs.gate!.complete();
      fs.fail = false;
      await capture.dispose(); await spill.dispose(); await store.dispose(); await removeTempDir(tmp);
    }
  });
  }
}

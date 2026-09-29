import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('offline local stop emits one incomplete timing immediately', () async {
    DiagLog.instance.clear();
    final tmp = await Directory.systemTemp.createTemp('flowmic-nr118-stop-');
    final retained = RetainedAudioStore(dir: tmp, clock: () => 0);
    await retained.open();
    final spill = RetainedAudioSpill(store: retained);
    final transport = FakeSocketTransport();
    final recorder = FakeAudioRecorder();
    final capture = AudioCapture(recorder: recorder, spill: spill);
    final session = newTestSession(
      transport: transport,
      audio: capture,
      stateMachine: FlowmicStateMachine(
        sessionDropGrace: const Duration(milliseconds: 40),
      ),
    );
    giveSessionAPairedIdentity(session);
    final store = newTestStore();
    final destination = DestinationController(fixedRecordOnly: true);
    final controller = ChatController(
      session: session,
      store: store,
      destination: destination,
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    addTearDown(() async {
      await controller.dispose();
      await session.dispose();
      await transport.close();
      store.dispose();
      destination.dispose();
      await spill.dispose();
      await retained.dispose();
      await removeTempDir(tmp);
    });

    transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    session.continuous.begin();
    expect(await controller.pttDown(), isTrue);
    recorder.feed(makePcm(kChunkBytes));
    await pumpEventQueue();
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(session.continuousCapturingOffline, isTrue);
    expect(capture.currentState, RecorderState.recording);
    expect(session.timings.active, isNotNull);
    expect(
      DiagLog.instance.snapshot().where((s) => s.contains('utt.timing')),
      isEmpty,
    );

    await controller.pttUp();

    expect(capture.currentState, RecorderState.stopped);
    expect(session.continuous.isActive, isFalse);
    expect(session.timings.active, isNull);
    expect(transport.emittedWhere('audio:stop'), isEmpty);
    final line = DiagLog.instance
        .snapshot()
        .where((s) => s.contains('utt.timing'))
        .single;
    expect(line, contains('release_ms=0'));
    expect(line, contains('stop_emit_ms=null'));
    expect(line, contains('final_rx_ms=null'));
    expect(line, endsWith('open=release'));
    session.timings.dispose();
    expect(
      DiagLog.instance.snapshot().where((s) => s.contains('utt.timing')),
      hasLength(1),
    );
  });
}

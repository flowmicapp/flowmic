import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/diag/utterance_timing.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/article_rig.dart';

void main() {
  testWidgets(
    'terminal repeat of a settled segment closes without a new inject',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      late ArticleRig rig;
      DiagLog.instance.clear();
      await tester.runAsync(() async {
        rig = ArticleRig();
        rig.session.timings.frameHook = UtteranceTiming.scheduleFrame;
        await pumpEventQueue();
        expect(await rig.controller.pttDown(), isTrue);
        await rig.say('Synthetic earlier segment', 0, isSegment: true);
        await rig.controller.pttUp();
        await rig.say('Synthetic earlier segment', 0, isSegment: false);
      });
      await mountLightRecordScreen(tester, rig);
      final String line = DiagLog.instance
          .snapshot()
          .where((s) => s.contains('utt.timing'))
          .single;
      expect(line, isNot(contains('open=')));
      expect(line, matches(RegExp(r' painted_ms=\d+')));
      expect(line, contains('inject_emit_ms=null'));
      expect(rig.store.entries, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    },
  );
  for (final FlowMode mode in <FlowMode>[
    FlowMode.realtime,
    FlowMode.translate,
  ]) {
    testWidgets(
      '${mode.name}: production stamps, exact request match, one line',
      (tester) async {
        late FakeSocketTransport transport;
        late PttSession session;
        late ChatController controller;
        final destination = DestinationController();
        final store = newTestStore();
        await tester.runAsync(() async {
          transport = FakeSocketTransport();
          session = newTestSession(
            transport: transport,
            audio: AudioCapture(recorder: FakeAudioRecorder()),
          );
          session.timings.frameHook = UtteranceTiming.scheduleFrame;
          giveSessionAPairedIdentity(session);
          controller = ChatController(
            session: session,
            store: store,
            destination: destination,
            outboxStore: newTestOutboxStore(),
            outboxBlobs: newTestOutboxBlobs(),
            syncGate: TimelineSyncGate(transport: transport),
            localPrefs: InMemoryLocalPrefs(),
          );
        });
        await tester.pumpWidget(const MaterialApp(home: SizedBox()));
        DiagLog.instance.clear();
        await tester.runAsync(() async {
          transport.pushStatus(SocketStatus.connected);
          await pumpEventQueue();
          controller.setMode(mode);
          expect(await controller.pttDown(), isTrue);
          await controller.pttUp();
          transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
            'text': 'SYNTHETIC_PRIVATE_118',
            'confidence': .95,
            'language': 'en',
            'segment_idx': 0,
            'is_segment': false,
            'duration_ms': 500,
            'utterance_id': '123abc0123456789',
            'polish': 'applied',
          });
          await pumpEventQueue();
          if (mode == FlowMode.translate) {
            transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
              'request_id': store.entries.single.clientId,
              'output_text': 'Synthetic translation',
            });
            await pumpEventQueue();
          }
          expect(
            transport.emittedWhere(FlowMicEvents.injectRequest),
            hasLength(1),
            reason: DiagLog.instance.snapshot().join('\n'),
          );
          transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
            'request_id': 'unrelated',
            'ok': true,
          });
          await pumpEventQueue();
        });
        await tester.pump();
        expect(
          DiagLog.instance.snapshot().where((s) => s.contains('utt.timing')),
          isEmpty,
        );
        await tester.runAsync(() async {
          transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
            'request_id': store.entries.single.clientId,
            'ok': true,
          });
          await pumpEventQueue();
        });
        await tester.pump();
        final String line = DiagLog.instance
            .snapshot()
            .where((s) => s.contains('utt.timing'))
            .single;
        for (final String mark in <String>[
          'press',
          'release',
          'stop_emit',
          'final_rx',
          'painted',
          'enqueue_start',
          'persisted',
          'enqueue_done',
          'inject_emit',
          'result_rx',
          if (mode == FlowMode.translate) ...<String>[
            'compose_start',
            'compose_done',
          ],
        ]) {
          expect(
            line,
            matches(RegExp(' ${mark}_ms=-?[0-9]+(?: |\$)')),
            reason: mark,
          );
        }
        expect(line, contains('tcorr=123abc'));
        expect(line, isNot(contains('SYNTHETIC_PRIVATE_118')));
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(() async {
          await controller.dispose();
          await session.dispose();
        });
        store.dispose();
        destination.dispose();
      },
    );
  }
}

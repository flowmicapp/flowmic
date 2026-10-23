// NR-174-D6 — a long recording, the user leaves the app for a few seconds,
// Android cuts the backgrounded app's network, the user comes back.
//
// 【measured 2026-10-10, TB335ZC / Android 16, FlowMic 0.3.107】 3-4 s after
// leaving, `dumpsys netpolicy` reads `blocked=APP_BACKGROUND` for the app's
// uid and both of its TCP sockets are gone; after the return they come back on
// new local ports. On the device every word said after the return was lost
// while the panel kept saying Recording (review doc 2026-10-10 §2 ①②⑦⑧).
//
// This drives the REAL chain on the phone — PttSession, the real state machine
// with its drop grace, AudioCapture with a retention layer (CR-3 keeps the
// microphone only when one exists), the ReconnectCoordinator ladder and the
// `mobile:reconnect` accept path — and replaces only the recorder and the
// socket. The layer that dropped the audio is the state machine's session
// gate in `_onCapturedChunk`, and it is not doubled here.
//
// The relay half — the pause latch survives a rebind, and an `audio:resume`
// on the new socket clears it — is pinned in server-core
// test/audio-grace.test.ts ("the pause state survives a rebind"); what this
// file adds is that the phone now SENDS that resume on the new socket.

import 'dart:async';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/continuous_away.dart';
import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/app_lifecycle_bridge.dart';
import 'package:flowmic/src/ui/app_lifecycle_edges.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const Duration _grace = Duration(milliseconds: 80);
const String _token = 'tok-test-abcdefghijklmnopqrstuvwxyz012';

Future<void> _until(bool Function() ok, String what) async {
  final DateTime deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!ok()) {
    if (DateTime.now().isAfter(deadline)) fail('never happened: $what');
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  late Directory tmp;
  late RetainedAudioStore store;
  late RetainedAudioSpill spill;
  late FakeSocketTransport transport;
  late FakeAudioRecorder recorder;
  late AudioCapture capture;
  late PttSession session;
  late List<String> stopReasons;

  Future<void> build() async {
    DiagLog.instance.clear();
    tmp = await Directory.systemTemp.createTemp('flowmic-d6-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    spill = RetainedAudioSpill(store: store);
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    capture = AudioCapture(recorder: recorder, spill: spill);
    session = newTestSession(
      transport: transport,
      audio: capture,
      stateMachine: FlowmicStateMachine(sessionDropGrace: _grace),
      heartbeatInterval: const Duration(milliseconds: 40),
    );
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
    stopReasons = <String>[];
    session.autoStopped.listen(stopReasons.add);
    transport.pushStatus(SocketStatus.connected);
  }

  Future<void> teardown() async {
    session.debugStopIdlePresencePoll();
    await session.dispose();
    await transport.close();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }

  /// Record, leave, lose the link past the drop grace, come back. Returns the
  /// index in `transport.emitted` of the `mobile:reconnect` frame.
  Future<int> recordLeaveAndReturn(Map<String, Object?> ack,
      {String? articleId}) async {
    session.continuous.begin(articleId: articleId);
    expect(await session.pttDown(), isTrue,
        reason: 'positive control: the production chain entered RECORDING');
    recorder.feed(makePcm(kChunkBytes)); // seq 0
    recorder.feed(makePcm(kChunkBytes)); // seq 1
    await Future<void>.delayed(Duration.zero);
    session.reconnect
        .configure(url: 'ws://x', token: _token, replaceToken: true);
    session.reconnect.start();

    await onAppBackground(session); // the `paused` edge
    expect(capture.currentState, RecorderState.paused);

    // Android blocks the backgrounded app's network: frames go nowhere.
    transport.failEmits = true;
    transport.pushStatus(SocketStatus.disconnected);
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(session.fsm.session, SessionState.disconnected,
        reason: 'positive control: the 3 s drop grace (80 ms here) expired');
    expect(capture.currentState, RecorderState.paused,
        reason: 'positive control: CR-3 kept the long recording open');

    // The `resumed` edge (app_lifecycle_edges.dart `onAppForeground`). Its
    // `kickNow` is fired first, but a dial takes network round trips, so the
    // resume frame reaches a socket that is still dead — modelled by
    // resuming before the link is allowed back.
    await session.resumeCapture();
    expect(capture.currentState, RecorderState.recording);
    transport.failEmits = false;
    transport.connectSucceeds = true;
    transport.ackQueue.add(ack);
    session.reconnect.kickNow(reason: 'foreground');
    await _until(() => transport.emittedWhere('mobile:reconnect').isNotEmpty,
        'the ladder re-dialled and sent mobile:reconnect');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    return transport.emitted
        .indexWhere((EventEnvelope e) => e.name == 'mobile:reconnect');
  }

  Map<String, Object?> ackWith(int? watermark) => <String, Object?>{
        'pairing_id': 'pair-test-1',
        'pc_name': 'Test PC',
        'pc_online': true,
        'audio_last_contiguous_seq': ?watermark,
      };

  test('🔴 relay still holds the recording: after the return the audio goes '
      'out again, behind a fresh audio:resume', () async {
    await build();
    final int at = await recordLeaveAndReturn(ackWith(1));
    recorder.feed(makePcm(kChunkBytes)); // seq 2
    recorder.feed(makePcm(kChunkBytes)); // seq 3
    recorder.feed(makePcm(kChunkBytes)); // seq 4
    await Future<void>.delayed(Duration.zero);

    final List<EventEnvelope> after = transport.emitted.sublist(at + 1);
    final List<String> names =
        after.map((EventEnvelope e) => e.name).toList();
    final List<int> seqs = <int>[
      for (final EventEnvelope e in after)
        if (e.name == 'audio:chunk')
          (e.data! as Map<Object?, Object?>)['seq']! as int,
    ];
    expect(seqs, containsAll(<int>[2, 3, 4]),
        reason: 'the words said after coming back must reach the relay; '
            'before NR-174-D6 none did and the panel still said Recording');
    expect(names, contains('audio:resume'),
        reason: 'the relay latched the pause before the link died and the '
            'first resume went into the dead socket');
    expect(names.indexOf('audio:resume'),
        lessThan(names.indexOf('audio:chunk')),
        reason: 'a chunk ahead of the resume is dropped by the latch');
    expect(session.fsm.session, SessionState.recording);
    expect(session.continuous.isActive, isTrue);
    expect(stopReasons, isEmpty);
    await teardown();
  });

  test('🔴 relay disposed the recording while the app was away: it ends '
      'honestly instead of streaming into nothing', () async {
    await build();
    final int at = await recordLeaveAndReturn(ackWith(null));
    recorder.feed(makePcm(kChunkBytes));
    await Future<void>.delayed(Duration.zero);
    await _until(() => stopReasons.isNotEmpty, 'the stop was announced');

    expect(capture.currentState, RecorderState.stopped,
        reason: 'a recorder running into a session that no longer exists is '
            'the zombie the device showed');
    expect(session.continuous.isActive, isFalse,
        reason: 'the panel is drawn from this flag; it must stop saying '
            'Recording');
    expect(stopReasons.single,
        anyOf(kLocalStopReasonLinkLossKept, kLocalStopReasonLinkLoss));
    // seq 0-1 may come back as the ladder's ring replay (no watermark = full
    // replay; the relay drops them, it has no session). What must not happen
    // is audio captured AFTER the return streaming into nothing.
    expect(<int>[
      for (final EventEnvelope e in transport.emitted.sublist(at + 1))
        if (e.name == 'audio:chunk')
          (e.data! as Map<Object?, Object?>)['seq']! as int,
    ].where((int seq) => seq >= 2), isEmpty);
    expect(
        DiagLog.instance.snapshot().any((String l) =>
            l.contains('audio.continuous.stopped_offline') &&
            l.contains('session_lost=true')),
        isTrue);
    await teardown();
  });

  test('🔴 NR-213 review F1 — the relay lost the session: the return notice '
      'stops saying 「recording again」', () async {
    // Android 16 cuts a backgrounded app's network after 3-4 s and the relay
    // keeps the session 30 s, so a longer absence ends the recording HERE, at
    // the reconnect — after `resumeCapture` already raised the return notice.
    // Reviewer probe before the fix: active=false, outcome=resumed,
    // stop=[local:link-loss-kept], notice 「Paused for 0.3s … recording again」,
    // and the notice (pushed first) hid the real link-loss stop banner.
    await build();
    await recordLeaveAndReturn(ackWith(null), articleId: 'a-f1');
    await _until(() => stopReasons.isNotEmpty, 'the stop was announced');
    expect(session.continuous.isActive, isFalse);
    expect(session.continuous.away.lastReturn.value?.outcome,
        ContinuousAwayOutcome.resumed,
        reason: 'positive control: a return was recorded (the gap stays)');
    expect(session.continuous.away.notice, isNull,
        reason: 'a recording that has ended must not be announced as '
            'recording again; the link-loss stop says what happened');
    await teardown();
  });

  testWidgets('🔴 the bridge runs a return only after the pause it undoes has '
      'finished', (WidgetTester tester) async {
    final Completer<void> slowPause = Completer<void>();
    final List<String> log = <String>[];
    await tester.pumpWidget(AppLifecycleBridge(
      onBackground: () async {
        log.add('pause:start');
        await slowPause.future;
        log.add('pause:end');
      },
      onForeground: () async => log.add('resume'),
      child: const SizedBox(),
    ));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(log, <String>['pause:start'],
        reason: 'a resume that overtakes the pause reads the recorder as '
            'still recording, skips the resume, and the pause lands last');
    slowPause.complete();
    await tester.pump();
    expect(log, <String>['pause:start', 'pause:end', 'resume']);
  });
}

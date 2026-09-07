// Defect D-1 (round-four device drill, 2026-09-06) — THE PAGE MAY NOT LEAVE A
// MICROPHONE BEHIND.
//
// EVIDENCE:
//   .local/session-2026-09-06-durability-drill-r4/06-DEFECTS.md D-1
//   B-3/verdict.md, B-3/02-notes-after-restore.png
// Measured: a 30-minute continuous recording, the network cut, and ~40 s later
// the page left by itself with 「多次重连未成功」. The user was then looking at a
// Notes screen that said 「暂无记录」 and offered an IDLE 「长时间录音」 row, while
// the microphone was still capturing to disk at 32,320 B/s. It ran 36 minutes
// and only stopped because the drill stopped it: no indicator, no Stop.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     card CR-3 (the microphone survives a link death), §5-8 (the continuous
//     face REPLACES the dock)
//   apps/mobile/lib/src/ui/chat_flow_exits.dart (the exit that was taken)
//   apps/mobile/lib/src/ui/chat_flow_continuous.dart (the face that vanished)
//
// ── 🔴 WHY THIS FILE MOUNTS THE SCREEN ──────────────────────────────────────
//
// Reverse-façade ⑥, and this defect is its textbook case: every layer under the
// screen was doing the right thing. `ptt_continuous_link_loss_test.dart` proves
// the recorder keeps running, `continuous_lifecycle_test.dart` proves the stop
// paths work — and the delivered product had no screen from which to reach any
// of it. The claim under test is 「the user can see and stop this recording」,
// so the test has to be able to see and stop it.
//
// The page is PUSHED onto a first route rather than being `home:`, because the
// defect's visible half is a `Navigator.popUntil(isFirst)` and on a
// single-route app that call does nothing at all — a rig that could not
// reproduce the navigation would have passed against the broken build.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show PairEntry;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_live_bar.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const Duration _grace = Duration(milliseconds: 60);
const Duration _lostAfter = Duration(milliseconds: 80);
const Key _listKey = Key('test.instance-list');

/// The page's own default locale (`ChatFlowPage` with no `appSettings`).
final AppStrings _s = AppStrings.of(AppLocale.zh);

class _Rig {
  _Rig(this.controller, this.transport, this.now);
  final ChatController controller;
  final FakeSocketTransport transport;

  /// A hand-wound wall clock. `RecordingTelemetry` reads it for the elapsed
  /// readout, and `DateTime.now()` does not move inside `testWidgets`' fake
  /// zone — so without this the countdown could never be shown to advance,
  /// which is half of what D-1 is about.
  DateTime now;
}

Future<_Rig> _pump(WidgetTester tester, {bool pair = false}) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  // 🔴 A REAL RETENTION LAYER, AND IT IS NOT SCENERY. `_keepOpenForContinuous`
  // refuses to keep the microphone open when there is nowhere to write (CR-3's
  // honesty gate), so a rig without a spill reproduces the OLD, correct
  // fallback instead of the state D-1 lives in — and every assertion below
  // would be measuring the wrong screen.
  //
  // ⚠️ `runAsync`, NOT a bare await: `testWidgets` runs in a fake-async zone
  // where a REAL future never completes, so `createTemp()` awaited directly
  // hangs the test with no output at all (CLAUDE.md, the same trap
  // `article_screen_test.dart` records as (a)).
  late final Directory tmp;
  late final RetainedAudioStore store;
  await tester.runAsync(() async {
    tmp = await Directory.systemTemp.createTemp('flowmic-d1-');
    store = RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
  });
  final RetainedAudioSpill spill = RetainedAudioSpill(store: store);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
    stateMachine: FlowmicStateMachine(sessionDropGrace: _grace),
  );
  late _Rig rig;
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(fixedRecordOnly: true),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
    clock: () => rig.now,
    sessionLostAfter: _lostAfter,
  );
  rig = _Rig(controller, transport, DateTime.utc(2026, 9, 6, 13));

  final LoginController login = newTestLogin(
    transport: transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-d1', email: 'x@example.com', plan: 'pro'),
    ),
  );
  await tester.runAsync(login.hydrate);
  final account = newTestCloudSummary(
    login: login,
    fetcher: fixedCloudSummary(testSummary(continuousMinutes: 30)),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    account.dispose();
    login.dispose();
    // ⚠️ BOUNDED AND SWALLOWED, WHICH IS NORMALLY THE WRONG THING TO DO IN A
    // TEARDOWN. The retention writes this rig produces were queued INSIDE the
    // fake-async zone, so awaiting them from `runAsync` deadlocks — measured:
    // the whole file hung for four minutes with no output, which also swallows
    // the real failure of the test that ran before it. Nothing in this file
    // asserts on a file (the byte-level claims live in
    // `continuous_cap_offline_test.dart`), so there is no I/O failure here for
    // a swallow to hide.
    await tester.runAsync(() async {
      try {
        await spill.dispose().timeout(const Duration(seconds: 2));
        await store.dispose().timeout(const Duration(seconds: 2));
      } catch (_) {}
        await removeTempDir(tmp);
    });
  });

  // ⚠️ ONLY THE PC-RELEASE TEST PAIRS. `SessionScope.key` is null on an
  // unpaired session, and `PcReleaseCooldown.note` records nothing without one
  // — so a rig that skipped this would exercise the 「not my screen」 arm and
  // pass against a build that ejects users mid-recording. The other tests do
  // not pair, because a pairing also arms the presence poll and this file's
  // helpers pump fixed frame counts rather than settling.
  if (pair) {
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-d1b-000000000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-d1b',
    });
    await tester.runAsync(() async {
      await session.pair(PairEntry.parse('1234'),
          endpoint: 'ws://192.0.2.5:41879');
    });
  }
  transport.pushStatus(SocketStatus.connected);
  await tester.runAsync(() async {
    account.refresh();
    await Future<void>.delayed(Duration.zero);
  });

  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          key: _listKey,
          body: Center(
            child: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ChatFlowPage(
                    controller: controller,
                    cloudSummary: account,
                    isSignedIn: () => login.isLoggedIn,
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return rig;
}

/// ⚠️ `pumpAndSettle` IS UNUSABLE ONCE A RECORDING IS LIVE, and that is a
/// property of the product rather than of the rig: `RecordingTelemetry` runs a
/// 200 ms ticker that repaints the page for as long as the recording lasts, so
/// "wait until nothing is scheduled" never returns. Every helper below therefore
/// pumps a fixed number of frames, and `pumpAndSettle` reappears only after the
/// recording is over.
Future<void> _pumpFrames(WidgetTester tester, [int n = 6]) async {
  for (int i = 0; i < n; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// The full production entry: row → briefing → start.
Future<void> _startRecording(WidgetTester tester) async {
  await tester.tap(find.byKey(ContinuousEntryKeys.row));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(ContinuousSheetKeys.start));
  await _pumpFrames(tester, 12);
  expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget,
      reason: 'positive control: an ORDINARY continuous recording draws its '
          'face, so a later absence means the link killed it');
}

/// Every test must end with the recording actually over: a 30-minute ceiling
/// still armed when the widget tree is disposed trips
/// `AutomatedTestWidgetsFlutterBinding`'s pending-timer invariant, and a test
/// that leaves the microphone running is a poor advertisement for a fix about
/// microphones that keep running.
Future<void> _stopRecording(WidgetTester tester) async {
  await tester.tap(find.byKey(ContinuousLiveKeys.stop));
  await _pumpFrames(tester);
  // Past the event-type notice's auto-hide window, so the banner reconciler's
  // own timer is not left standing either. Settling is safe again from here:
  // the recording is over, so the ticker is too.
  await tester.pump(const Duration(seconds: 6));
  await tester.pumpAndSettle();
}

/// Kill the link and let the whole give-up chain run: drop grace, then the
/// session-lost window, then the exit.
Future<void> _loseTheLinkForGood(WidgetTester tester, _Rig rig) async {
  rig.transport.pushStatus(SocketStatus.disconnected);
  await tester.pump(_grace * 2);
  await tester.pump(_lostAfter * 2);
  await _pumpFrames(tester);
  expect(rig.controller.sessionLost, isTrue,
      reason: 'positive control: the ladder really did give up — without this '
          'the assertions below would pass on a link that never died');
}

void main() {
  testWidgets('🔴 ① THE DEFECT: the ladder gives up and the page STAYS, with '
      'the recording face and a reachable Stop', (WidgetTester tester) async {
    final _Rig rig = await _pump(tester);
    await _startRecording(tester);

    await _loseTheLinkForGood(tester, rig);

    // The microphone is still open — that is CR-3 and it is correct.
    expect(rig.controller.session.continuousStillCapturing, isTrue);
    // …and so is the only screen that admits it exists.
    expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget,
        reason: 'the page navigated away from a live microphone; this is the '
            'assertion that reproduces D-1');
    expect(find.byKey(ContinuousLiveKeys.stop), findsOneWidget,
        reason: 'a recording nobody can stop is the whole impact of D-1');
    expect(find.byKey(ContinuousLiveKeys.clock), findsOneWidget);
    // §5-8, and the second half of the measured screen: no IDLE offer sitting
    // under a running recording (pressing it is defect D-3).
    expect(find.byKey(ContinuousEntryKeys.row), findsNothing);
    // The state line is not invented here — it is the CR-3 banner, already
    // written and already translated, and it says only what this phone can
    // prove: the recording continues and the audio is on this device.
    expect(find.text(_s.bannerContinuousOffline),
        findsOneWidget);

    await _stopRecording(tester);
  });

  testWidgets('🔴 ② the countdown keeps running after the link dies', (
    WidgetTester tester,
  ) async {
    // A frozen clock on a live recording is R11 in the countdown: the number
    // answers 「how much is left」 (ruling ⑮) and it would be answering it with
    // whatever it happened to say at the moment the socket dropped, while the
    // ceiling that ends the sitting keeps its own time.
    final _Rig rig = await _pump(tester);
    await _startRecording(tester);
    await _loseTheLinkForGood(tester, rig);
    final Duration atDrop = rig.controller.recordingElapsed;

    rig.now = rig.now.add(const Duration(minutes: 3));
    await tester.pump(const Duration(seconds: 1));

    expect(rig.controller.recordingElapsed, greaterThan(atDrop),
        reason: 'the readout the face counts down from must not freeze while '
            'the recording it describes is still running');

    await _stopRecording(tester);
  });

  testWidgets('🔴 ③ Stop still ends it, and THEN the deferred exit happens', (
    WidgetTester tester,
  ) async {
    // The exit is postponed, never cancelled: both sentences it carries are
    // true and the user should still get them — after the recording, not
    // instead of it.
    final _Rig rig = await _pump(tester);
    await _startRecording(tester);
    await _loseTheLinkForGood(tester, rig);

    await _stopRecording(tester);

    expect(rig.controller.session.continuousStillCapturing, isFalse,
        reason: 'the user asked for it to end, so it ends');
    expect(rig.controller.session.capTimer.isArmed, isFalse,
        reason: 'C8 — the ceiling lets go on this exit too');
    expect(find.byKey(ContinuousLiveKeys.bar), findsNothing);
    // And the postponed exit lands: back on the list, with its sentence.
    expect(find.byKey(_listKey), findsOneWidget,
        reason: 'deferred, not cancelled — a latch set on the way past would '
            'have turned "not yet" into "never"');
    expect(find.text(_s.sessionLostToast), findsOneWidget);
  });

  testWidgets('🔴 ④ D-1b: a PC-INITIATED disconnect also waits for the '
      'microphone, and lands the moment the recording ends', (
    WidgetTester tester,
  ) async {
    // The third exit was the one R4F left open: it rides `PcReleaseCooldown.tick`
    // rather than a controller notify, so deferring it needed a driver that
    // re-fires. `PttSession` now pokes `repoll()` when the recorder closes.
    final _Rig rig = await _pump(tester, pair: true);
    await _startRecording(tester);

    rig.transport.pushIncoming('mobile:released',
        <String, Object?>{'retry_after_ms': 60000, 'revoked': false});
    // The server closes the socket immediately after saying it (pc.handler.ts),
    // so the production sequence includes the drop.
    rig.transport.pushStatus(SocketStatus.disconnected);
    await _pumpFrames(tester, 8);

    expect(rig.controller.session.continuousStillCapturing, isTrue,
        reason: 'positive control: the microphone really is still open, so the '
            'assertions below are about a deferral and not about a no-op');
    expect(find.byKey(ContinuousLiveKeys.bar), findsOneWidget,
        reason: '🔴 the D-1b defect: the page left a live microphone behind '
            'because this exit was not guarded');
    expect(find.byKey(ContinuousLiveKeys.stop), findsOneWidget);
    expect(find.byKey(_listKey), findsNothing);

    // Stopped by hand, then read the exit BEFORE the snackbar's own 4 s
    // auto-dismiss — `_stopRecording` deliberately pumps past that to clear the
    // banner reconciler's timer, so the sentence cannot be asserted after it.
    await tester.tap(find.byKey(ContinuousLiveKeys.stop));
    await _pumpFrames(tester);

    // …the postponed exit lands, and with the PC-release sentence rather than
    // the generic 「reconnect failed」 one — which is the whole reason this exit
    // exists, and which the session-lost exit now yields to.
    expect(find.text(_s.pcReleasedNotice(60)), findsOneWidget,
        reason: 'deferred, not cancelled — without the repoll driver this is '
            'an exit that never happens, which is worse than the defect');
    expect(find.text(_s.sessionLostToast), findsNothing,
        reason: 'a person pressed 断开; saying 「多次重连未成功」 would be the '
            'wrong sentence, ten seconds late');

    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.byKey(_listKey), findsOneWidget);
    expect(find.byType(ChatFlowPage), findsNothing);
  });
}

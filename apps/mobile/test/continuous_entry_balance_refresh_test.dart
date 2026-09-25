// 🔴 CARD RC-H — THE BALANCE ON THE LONG-RECORDING ENTRY IS RE-READ AFTER A
// RECORDING AND WHEN THE START SHEET OPENS.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.2 / §6 H / §7 RC-H
//   test/continuous_entry_page_test.dart (the mount this one is cut from)
//
// ── WHAT THE DEVICE SHOWED (CR-12-E re-run, 2026-09-24) ─────────────────────
//
// The start sheet said 「剩余 20 分钟」 while the account had 12 left: the
// summary moves on sign-in, on entering the chat page and on `billing:budget`
// frames, and none of those happens between the end of one recording and the
// start of the next.
//
// The account here is a fake FETCHER whose answer the test moves between
// reads (20 left, then 12). Everything between it and the pixels is
// production: the controller, the page, the entry row, the sheet.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

// The page renders zh when no settings are wired (`ChatFlowPage._strings`).
final AppStrings _zh = AppStrings.of(AppLocale.zh);

const double _limit = 30;
const int _cap = 30;

class _Rig {
  final FakeSocketTransport transport = FakeSocketTransport();
  final FakeAudioRecorder recorder = FakeAudioRecorder();
  late final PttSession session;
  late final ChatController controller;
  late final LoginController login;
  late final CloudSummaryController account;

  /// What the account says it has used; the fetcher reads it at call time.
  double used = _limit - 20;
  int reads = 0;
}

Future<_Rig> _mount(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final _Rig r = _Rig();
  r.session = newTestSession(
    transport: r.transport,
    audio: AudioCapture(recorder: r.recorder),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  r.controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: r.session,
    store: newTestStore(),
    destination: DestinationController(fixedRecordOnly: true),
    syncGate: TimelineSyncGate(transport: r.transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  // Signed in, or the controller never fetches (continuous_entry_page_test.dart
  // explains the case that first passed without testing anything).
  r.login = newTestLogin(
    transport: r.transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-rch', email: 'x@example.com', plan: 'pro'),
    ),
  );
  await tester.runAsync(r.login.hydrate);
  r.account = newTestCloudSummary(
    login: r.login,
    fetcher: (Uri url, String bearer, Duration budget) async {
      r.reads += 1;
      return CloudSummaryRead(
        summary: testSummary(usedMin: r.used, limitMin: _limit, continuousMinutes: _cap),
      );
    },
  );
  addTearDown(() async {
    debugCancelAsrHealthTicker(r.controller);
    await r.controller.dispose();
    r.controller.destination.dispose();
    r.controller.store.dispose();
    r.account.dispose();
    r.login.dispose();
  });
  r.transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(
      home: ChatFlowPage(
        controller: r.controller,
        cloudSummary: r.account,
        isSignedIn: () => r.login.isLoggedIn,
      ),
    ),
  );
  await _land(tester); // the page's own initState read
  return r;
}

/// Let a fetch that is in the air resolve (a real future even with a fake
/// fetcher), then repaint.
Future<void> _land(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
  await tester.pump();
}

String _numbers(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(ContinuousEntryKeys.numbers)).data!;

void main() {
  testWidgets('🔴 RC-H: after a long recording ends, the entry reads the '
      'account again and shows the new balance', (WidgetTester tester) async {
    final _Rig r = await _mount(tester);
    expect(_numbers(tester), _zh.continuousEntryCapAndLeft(_cap, 20),
        reason: 'positive control: the first read is on the row');
    final int before = r.reads;

    // The recording, through the session the page is wired to. It is started
    // the way the entry starts it (`beginContinuous` then the press); the
    // sheet is the other case's subject.
    await tester.runAsync(() async {
      r.session.beginContinuous(cap: const Duration(minutes: _cap), onWarning: () {});
      await r.controller.pttDown();
      r.recorder.feed(makePcm(32000));
      await pumpEventQueue();
    });
    await tester.pump();
    expect(r.session.continuous.isActive, isTrue, reason: 'setup: recording');

    // The relay books the minutes; the next read says so.
    r.used = _limit - 12;
    await tester.runAsync(() async {
      await r.controller.pttUp();
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '最后一句。',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 1000,
      });
      await pumpEventQueue();
    });
    await tester.pump();
    await _land(tester);
    // `justDone` → idle is a (zero-length) timer on the fake clock.
    await tester.pump(const Duration(milliseconds: 100));
    expect(r.session.fsm.session, SessionState.idle, reason: 'setup: at rest');

    expect(r.reads, greaterThan(before), reason: 'the account was read again');
    expect(_numbers(tester), _zh.continuousEntryCapAndLeft(_cap, 12),
        reason: 'the row shows the balance after the recording, not before it');
  });

  testWidgets('🔴 RC-H: the start sheet reads the account as it opens and '
      'shows the fresh balance', (WidgetTester tester) async {
    final _Rig r = await _mount(tester);
    expect(_numbers(tester), _zh.continuousEntryCapAndLeft(_cap, 20),
        reason: 'positive control: the stale number is what the row holds');

    // Spent elsewhere since the last read (another device, a recording whose
    // booking landed after its own end read).
    r.used = _limit - 12;
    await tester.tap(find.byKey(ContinuousEntryKeys.row));
    await tester.pump();
    await _land(tester);
    await tester.pumpAndSettle();

    expect(find.byKey(ContinuousSheetKeys.sheet), findsOneWidget);
    final Text left = tester.widget<Text>(find.descendant(
      of: find.byKey(ContinuousSheetKeys.left),
      matching: find.byType(Text),
    ));
    expect(left.data, _zh.continuousSheetLeft(12),
        reason: 'the sheet is where the user decides; it must not show 20');

    await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
    await tester.pumpAndSettle();
  });
}

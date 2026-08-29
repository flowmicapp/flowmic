// Card CR-9 — the entry, on a REAL ChatFlowPage.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/chat_flow_continuous.dart
//   task unit §6 C6 (「the PC channel offers no entry, AND says why」 — asserted
//     on the RENDERED result), demo cells A-1 / A-3
//
// 🔴 WHY A THIRD FILE FOR THE SAME CARD, AND WHAT EACH ONE CANNOT DO.
//   · `continuous_offer_test.dart` — the decision, with no frame. Cannot see
//     whether anything draws it.
//   · `continuous_entry_row_test.dart` — the widget, in isolation. Cannot see
//     whether the dock builds one.
//   · `continuous_wired_test.dart` — greps. Sees the CALL, not the pixel: a
//     call inside a branch that never runs satisfies it.
//   · this file — the page. The only one that can fail when the dock's own
//     conditions (idle rows, destination, offer) do not line up in practice.
// Three cards shipped complete and unreachable one day earlier because the
// first three kinds were all green.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/continuous_entry_row.dart';
import 'package:flowmic/src/ui/continuous_start_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

Future<ChatController> _pump(
  WidgetTester tester, {
  required bool recordOnly,
  bool withAccount = true,
  bool connected = true,
  int? continuousMinutes = 30,
}) async {
  // Phone width: this row lives in the phone dock, and the tablet arrangement
  // is unreachable while it is visible (pinned in continuous_wired_test.dart).
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(fixedRecordOnly: recordOnly),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  // 🔴 SIGNED IN, ON PURPOSE, AND THE FIRST CUT WAS NOT. `CloudSummaryController`
  // refuses to fetch while logged out — correctly: there is nothing to ask about
  // and no bearer to ask with. So a signed-OUT harness leaves `summary` null
  // forever, every case renders the ceiling-unknown face, and the two cases
  // below that differ only in `continuousMinutes` would both have passed WITHOUT
  // TESTING ANYTHING. The tap case is what exposed it, by failing.
  final LoginController login = newTestLogin(
    transport: transport,
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-cr9', email: 'x@example.com', plan: 'pro'),
    ),
  );
  // ⚠️ `runAsync`, NOT a bare await. `testWidgets` runs in a fake-async zone
  // where real futures never complete, so `hydrate()` awaited directly hangs the
  // test forever — measured, on the case that had been passing a minute
  // earlier. Same reason `ptt_continuous_link_loss_test.dart` states for
  // avoiding fakeAsync entirely: real I/O does not resolve in that zone.
  await tester.runAsync(login.hydrate);
  final account = withAccount
      ? newTestCloudSummary(
          login: login,
          fetcher: fixedCloudSummary(
            testSummary(continuousMinutes: continuousMinutes),
          ),
        )
      : null;
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    account?.dispose();
    login.dispose();
  });

  // 🔴 The link is part of the offer: without this the dock renders the
  // DISABLED face and the tap does nothing — which is how the sheet case first
  // failed here, and is itself the gate working. The dock says 未连接 one row
  // up, so the entry adds no sentence of its own.
  if (connected) transport.pushStatus(SocketStatus.connected);
  if (account != null) {
    // Same zone problem: the fetch is a real future even with a fake fetcher.
    await tester.runAsync(() async {
      account.refresh();
      await Future<void>.delayed(Duration.zero);
    });
  }
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller, cloudSummary: account)),
  );
  await tester.pump();
  return controller;
}

void main() {
  testWidgets('🔴 A-1: the entry is ON THE PAGE in a record-only dock', (
    WidgetTester tester,
  ) async {
    await _pump(tester, recordOnly: true);
    expect(find.byKey(ContinuousEntryKeys.row), findsOneWidget,
        reason: 'every other test in this lane is green whether or not this is '
            'true — that is exactly how CR-2, CR-3 and CR-6 shipped unreachable');
  });

  testWidgets('🔴 A-3: a paired dock is unchanged — not one pixel added', (
    WidgetTester tester,
  ) async {
    // Ruling ⑧: 「不影响原有体验」 is a zero diff here, not a promise. Where the
    // user learns the feature exists is light-record's own ground.
    await _pump(tester, recordOnly: false);
    expect(find.byKey(ContinuousEntryKeys.row), findsNothing);
  });

  testWidgets('🔴 no account source ⇒ ABSENT, not present-and-broken', (
    WidgetTester tester,
  ) async {
    // A standalone instance, a self-hosted relay, or a page built without the
    // controller. 「Not offered」 and 「offered, and we could not read the
    // ceiling」 are different answers; only the second one draws.
    await _pump(tester, recordOnly: true, withAccount: false);
    expect(find.byKey(ContinuousEntryKeys.row), findsNothing);
  });

  testWidgets('an account that cannot state a ceiling DOES draw, disabled and '
      'explained', (WidgetTester tester) async {
    await _pump(tester, recordOnly: true, continuousMinutes: null);
    expect(find.byKey(ContinuousEntryKeys.row), findsOneWidget,
        reason: 'the other half of the case above — this one the user can act '
            'on, so it must not be hidden');
    expect(find.byKey(ContinuousEntryKeys.reason), findsOneWidget);
  });

  testWidgets('🔴 tapping it opens the briefing, on the page, for real', (
    WidgetTester tester,
  ) async {
    // The whole chain in one gesture: dock → offer → row → sheet. Nothing here
    // is stubbed except the socket, the recorder and the account fetcher.
    await _pump(tester, recordOnly: true);
    await tester.tap(find.byKey(ContinuousEntryKeys.row));
    await tester.pumpAndSettle();

    expect(find.byKey(ContinuousSheetKeys.sheet), findsOneWidget);
    expect(find.byKey(ContinuousSheetKeys.cap), findsOneWidget);
    expect(find.byKey(ContinuousSheetKeys.noCancel), findsOneWidget);

    // And out again, without starting anything.
    await tester.tap(find.byKey(ContinuousSheetKeys.cancel));
    await tester.pumpAndSettle();
    expect(find.byKey(ContinuousSheetKeys.sheet), findsNothing);
  });
}

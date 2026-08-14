// REQ-12-01 (owner 2026-08-12 需求①「手机与 PC 的退出登录二次确认样式要改进」,
// the mechanism keeps the second confirm). This file exists because the round CHANGED the look of that
// confirm, and the look is the one thing a passing suite could not have noticed:
// `grep -rn confirmDestructive apps/mobile/test` before this card returned **0**
// hits — the gate owner called a red line on 2026-07-27 was held up by nothing
// but the source of `confirm_dialog.dart`.
//
// What is pinned here, in the order that matters:
//
//   ① DISMISSING IS NOT CONSENT. Tapping the barrier (the Android back-out
//      gesture's twin, and the single likeliest accidental exit) leaves the
//      account signed in. This is `confirmDestructive`'s `?? false`, driven end
//      to end through the real CloudSignOutRow → ConnectionsController.
//      🔴 Reverse control for this one is `?? true` — see the note at the
//      bottom of the file for what it printed.
//   ② 取消 IS NOT CONSENT either — a different path to the same `false`, and the
//      one a user takes deliberately.
//   ③ THE CONFIRM STILL WORKS. Without this, ① and ② are also satisfied by a
//      sign-out that is simply broken, and a test suite that cannot tell
//      「gated」 from 「dead」 is not testing the gate.
//   ④ THE THREE LOAD-BEARING CLAUSES ARE ON SCREEN. The card's hard rule: a
//      prettier dialog that drops「记录不受影响」/「账号不会被删」is worse than the
//      one it replaced. Asserted as three separate finds, so dropping any ONE
//      of them fails by name.
//
// ⚠️ These are `Text.data` finds, which 0.2.53 taught us is NOT a proof that the
// user can READ the sentence (that round shipped a message clipped to three
// letters while its test was green). It is honest here for a reason worth
// writing down: the clauses now render in an AlertDialog body that this round
// made scrollable and unconstrained in height, not in a fixed-width Row of six
// cells. The 0.2.53 hazard is a LAYOUT one and it is answered by layout, not by
// this file — see ⑤, which measures instead of matching.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

/// The remembered cloud-instance row the sign-out control is mounted on
/// (GA-33 / A2 — the dashed entry card retires once this row exists).
MobileSession _saasRow() => const MobileSession(
      token: 'tok-cloud-000000000000000000000',
      endpoint: 'https://flowmic.app',
      channel: 'saas',
      pcName: 'FlowMic Cloud',
      pairingId: 'pair-cloud',
    );

class _Harness {
  _Harness(this.transport, this.login, this.widget);

  final FakeSocketTransport transport;
  final LoginController login;
  final Widget widget;
}

Future<_Harness> _signedInPage() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);

  final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
  final LoginController login = LoginController(
    transport: t,
    accountStore: InMemoryAccountStore(),
    saasEndpoint: 'https://saas.test:443',
  );
  t.ackQueue.add(<String, Object?>{
    'ok': true,
    'token': 'jwt-req1201',
    'user': <String, Object?>{'email': 'req1201@flowmic.test', 'id': 'u-req1201'},
    'mode': 'saas',
  });
  await login.login(email: 'req1201@flowmic.test', password: 'secret12ab');
  if (!login.isLoggedIn) {
    throw StateError('harness precondition failed: the fake login did not take');
  }

  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_saasRow());
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport()..connectSucceeds = false,
  );
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: (Uri url, Duration timeout) async => HealthReading.offline,
    presenceReader: (Uri url, String token, Duration timeout) async =>
        PcPresenceReading.unknown,
  );
  return _Harness(
    t,
    login,
    MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      ),
    ),
  );
}

Future<_Harness> _pumpSignedIn(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(400, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final _Harness h = await _signedInPage();
  await tester.pumpWidget(h.widget);
  await tester.pumpAndSettle();
  return h;
}

/// Open the second confirm from the real control. Labels are zh in tests that
/// do not override the language setting.
Future<void> _openConfirm(WidgetTester tester) async {
  expect(find.text('登出'), findsOneWidget,
      reason: 'positive probe: without the trigger the taps below prove nothing');
  await tester.tap(find.text('登出'));
  await tester.pumpAndSettle();
  expect(find.text('退出云端登录？'), findsOneWidget);
}

void main() {
  testWidgets('① dismissing the confirm by tapping outside does NOT sign out',
      (WidgetTester tester) async {
    final _Harness h = await _pumpSignedIn(tester);
    await _openConfirm(tester);

    // The barrier, i.e. the cheapest accidental exit there is. showDialog hands
    // back `null` for it, and `confirmDestructive` turns null into false.
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();

    expect(find.text('退出云端登录？'), findsNothing, reason: 'the dialog did close');
    expect(h.login.isLoggedIn, isTrue,
        reason: 'a dismissed confirm must never be read as consent');
    expect(h.login.jwt, isNotNull);
    // Still signed in ⇒ the control is still there to try again.
    expect(find.text('登出'), findsOneWidget);
  });

  testWidgets('② 取消 does NOT sign out', (WidgetTester tester) async {
    final _Harness h = await _pumpSignedIn(tester);
    await _openConfirm(tester);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    expect(h.login.isLoggedIn, isTrue);
    expect(find.text('登出'), findsOneWidget);
  });

  testWidgets('③ the confirm still WORKS — 确认退出 signs out',
      (WidgetTester tester) async {
    // Without this, ① and ② are equally satisfied by a sign-out that is simply
    // broken. This is the positive control for the two negatives above.
    final _Harness h = await _pumpSignedIn(tester);
    await _openConfirm(tester);

    await tester.tap(find.text('确认退出'));
    await tester.pumpAndSettle();

    expect(h.login.isLoggedIn, isFalse);
    expect(h.login.jwt, isNull);
    // CloudSignOutRow shrinks when signed out — the control goes with the state.
    expect(find.text('登出'), findsNothing);
  });

  testWidgets('④ all three load-bearing clauses are on the confirm',
      (WidgetTester tester) async {
    await _pumpSignedIn(tester);
    await _openConfirm(tester);

    // ①「本机登录被清 + 要重新登录」— what you lose.
    expect(find.textContaining('这台手机上的登录会被清除'), findsOneWidget);
    // The panel that says the next two are the OPPOSITE kind of statement.
    expect(find.text('不受影响'), findsOneWidget);
    // ②「记录不受影响」 ③「账号不会被删」— what you keep. Separate finds on
    // purpose: dropping either one has to fail by name, not shorten a match.
    expect(find.text('手机上已有的记录'), findsOneWidget);
    expect(find.text('你的账号本身（不会被删除）'), findsOneWidget);
  });

  testWidgets('⑤ the two actions are told apart WITHOUT colour '
      '(owner 2026-08-01「颜色+图标组合，不能只靠颜色」)',
      (WidgetTester tester) async {
    await _pumpSignedIn(tester);
    await _openConfirm(tester);

    // A measurement, not a match. Before this round both actions were bare
    // TextButtons: same size, same shape, no glyph — the ONLY difference was the
    // label colour, which is exactly what the C-8 criterion forbids as a sole
    // signal. Two non-colour signals are pinned:
    //
    //   (a) a glyph on the danger action and none on cancel;
    final Finder danger = find.ancestor(
      of: find.text('确认退出'),
      matching: find.byType(TextButton),
    );
    final Finder cancel = find.ancestor(
      of: find.text('取消'),
      matching: find.byType(TextButton),
    );
    expect(danger, findsOneWidget);
    expect(cancel, findsOneWidget);
    expect(
      find.descendant(of: danger, matching: find.byIcon(Icons.warning_amber_rounded)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: cancel, matching: find.byType(Icon)),
      findsNothing,
      reason: 'the glyph only separates the two if exactly one of them has it',
    );

    //   (b) both actions clear the 44px floor, and NEITHER is bigger than the
    //       other. A destructive button given a bigger hit box than cancel is
    //       the shape this card forbids ("cheaper to click through").
    final Size dangerBox = tester.getSize(danger);
    final Size cancelBox = tester.getSize(cancel);
    expect(dangerBox.height, greaterThanOrEqualTo(44));
    expect(cancelBox.height, greaterThanOrEqualTo(44));
    expect(dangerBox.height, cancelBox.height);
  });
}

// ── REVERSE CONTROL (2026-08-12, machine = dev-pc-a / this repo) ──────
// The guard is the last line of `confirmDestructive`. Broken on purpose —
// `return ok ?? true;` (a dismissed dialog counted as consent) — and the file
// re-run. Verbatim:
//
//   ══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞═════════════════════
//   The following TestFailure was thrown running a test:
//   Expected: true
//     Actual: <false>
//   a dismissed confirm must never be read as consent
//   …
//   00:00 +0 -1: ① dismissing the confirm by tapping outside does NOT sign out [E]
//   00:01 +4 -1: Some tests failed.
//
// 🔴 Read the OTHER four lines of that run, they are the point: ②③④⑤ all stayed
// GREEN with the gate broken. ⑤ measures the buttons, ④ reads the copy, ③ drives
// the happy path, ② takes the deliberate exit — not one of them can see a
// dismissal being counted as consent. Only ① can, which is why it exists and why
// deleting it as「redundant with ②」would silently retire the whole guard.
//
// Restored to `?? false` (5/5 green again); the marker string
// `REVERSE-CONTROL-REQ1201` greps to 0 across the repo.

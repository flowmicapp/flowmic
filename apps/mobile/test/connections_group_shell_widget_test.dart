// REQ-12-10b (mobile half) — a computer with more than one connection is drawn
// inside a SHELL that says so.
//
// Card: docs/strategy/2026-08-12-req1210b-same-machine-group-shell.md
// Desktop half of the same card: 0450b0a (`PairedList.vue`).
//
// WHAT OWNER SAW: `dev-pc-a` with a LAN row and a cloud-relay row, and
// the 「轻记录」 card immediately below — three cards of equal weight in one flat
// column, with only a thin 「同一台电脑的 2 个连接」 line trying to say that the
// first two belong together. The line was too weak to carry it.
//
// 🔴 WHY THESE ASSERTIONS ARE GEOMETRIC AND BEHAVIOURAL RATHER THAN COSMETIC.
// A shell is decoration, and decoration is the class of change that can be
// removed, inverted or defeated by a later layout edit with nothing failing. So
// the suite does not assert 「there is a border」 — the repo's own law for
// anything about what the user can SEE is that the assertion lands on the
// rendered result. It measures:
//   · the RENDERED gaps, and demands the inner one be smaller than the outer
//     one (card §2.2) — that ordering IS the grouping, a container whose inside
//     gap equals its outside gap groups nothing;
//   · that both pairings survive whole inside it, each still its own
//     `Dismissible` with its own tap;
//   · that TAPPING THE SHELL DOES NOTHING. A clickable shell is the merge the
//     ruling forbids (session/machine_group.dart), just wearing other markup, so
//     this is checked by tapping, not by reading the widget tree for gestures.
//
// ⚠️ Gaps are measured between the identity LANES (`ConnectionCardIdentity`
// lane keys), not between whole cards: the lane is stretched to the card's inner
// content box, so lane-to-lane distance is a stable stand-in for card-to-card
// distance and does not shift when a card's border width changes.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/ui/connection_card_identity.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _uid = 'pc-00112233445566aa';

Future<HealthReading> _offline(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;

MobileSession _row({
  required String token,
  String endpoint = 'http://192.168.1.5:41879',
  String? pcInstanceId,
  String? pcMachineUid,
}) => MobileSession(
  token: token,
  endpoint: endpoint,
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-$token',
  pcInstanceId: pcInstanceId,
  pcMachineUid: pcMachineUid,
);

Future<Widget> _rig(List<MobileSession> seed) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  for (final MobileSession s in seed) {
    await storage.addOrUpdatePairing(s);
  }
  final PttSession session = PttSession(
    transport: FakeSocketTransport()..connectSucceeds = true,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  return MaterialApp(
    home: ConnectionsPage(
      connections: ConnectionsController(
        session: session,
        login: login,
        healthReader: _offline,
        presenceReader: _presenceUnknown,
      ),
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
    ),
  );
}

/// The two pairings owner actually had: one machine, two channels.
List<MobileSession> get _sharedMachine => <MobileSession>[
  _row(
    token: 'tok-lan-000000000000000000000000',
    pcInstanceId: 'pc-inst-lan-0000000',
    pcMachineUid: _uid,
  ),
  _row(
    token: 'tok-cloud-00000000000000000000000',
    endpoint: 'https://flowmic.app',
    pcInstanceId: 'pc-inst-cloud-00000',
    pcMachineUid: _uid,
  ),
];

void main() {
  final Key shellKey = machineGroupShellKey(_uid);

  testWidgets('two connections to ONE computer are drawn inside one shell',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(_sharedMachine));
    await tester.pumpAndSettle();

    expect(find.byKey(shellKey), findsOneWidget);
    // The header is the shell's top bar now, not a line floating above peers.
    expect(
      find.descendant(
        of: find.byKey(shellKey),
        matching: find.text('Studio PC · 同一台电脑的 2 个连接'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('🔴 both pairings survive the shell — two rows, each its own '
      'dismissible and its own tap', (WidgetTester tester) async {
    // The half a "make it look nicer" change is most likely to quietly cost. Two real
    // pairings with two tokens: a shell that swallowed one, or fused them into a
    // single actionable unit, is the merge machine_group.dart forbids.
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(_sharedMachine));
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(shellKey),
        matching: find.byType(Dismissible),
      ),
      findsNWidgets(2),
      reason: 'each pairing must remain independently swipe-deletable',
    );
    // Both rows still name the same computer, i.e. neither was collapsed away.
    expect(
      find.descendant(
        of: find.byKey(shellKey),
        matching: find.text('Studio PC'),
      ),
      findsNWidgets(2),
    );
    // A ROW still owns its own gestures inside the shell. Long-press (rename) is
    // the probe rather than tap-to-connect: it exercises the row's own
    // `InkWell` without dialling, so the assertion measures the gesture and not
    // the fake transport.
    await tester.longPress(find.text('Studio PC').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('修改别名'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
  });

  testWidgets('🔴 the shell itself is NOT a tap target', (WidgetTester tester) async {
    // A clickable shell would be the forbidden merge in other markup: it would
    // have to pick ONE of the two pairings to act on, and nothing on this screen
    // could say which. So the group header — the one part of the shell that is
    // its own and not a row — must do nothing at all when tapped.
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(_sharedMachine));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Studio PC · 同一台电脑的 2 个连接'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('CHAT'), findsNothing, reason: 'the shell navigated somewhere');
    expect(find.text('修改别名'), findsNothing, reason: 'the shell adopted a row action');
    // The same, for the press-and-hold the rows answer to.
    await tester.longPress(find.text('Studio PC · 同一台电脑的 2 个连接'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('修改别名'), findsNothing);

    // 🔴 POSITIVE CONTROL. Without it every negative above would still pass on a
    // page that rendered nothing tappable at all — the suite would be measuring
    // its own deafness. The identical gesture on a ROW does open the dialog.
    await tester.longPress(find.text('Studio PC').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('修改别名'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
  });

  testWidgets('🔴 measured: the gap INSIDE the group is smaller than the gap '
      'between the group and the next card', (WidgetTester tester) async {
    // Card §2.2. This is the assertion that makes the shell a grouping rather
    // than a rectangle: if the two distances were equal, the rows would still
    // read as peers of the 「轻记录」 card below them, which is what owner saw.
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(_sharedMachine));
    await tester.pumpAndSettle();

    final Finder pcLanes =
        find.byKey(ConnectionCardIdentity.pcLaneKey(
      ConnectionCardIdentity.machineLaneIndex(_uid)!,
    ));
    expect(pcLanes, findsNWidgets(2));
    final Rect first = tester.getRect(pcLanes.at(0));
    final Rect second = tester.getRect(pcLanes.at(1));
    // The 「轻记录」 entry card is what sits below the group (no saas pairing is
    // seeded, so it renders) — the neighbour owner's screenshot showed.
    final Rect notes =
        tester.getRect(find.byKey(ConnectionCardIdentity.notesLaneKey));

    final double insideGap = second.top - first.bottom;
    final double outsideGap = notes.top - second.bottom;
    expect(insideGap, greaterThan(0), reason: 'rows did not render in order');
    // 🔴 NOT merely `greaterThan(insideGap)`. The shell's own border and padding
    // already add a couple of pixels, so a plain ordering assertion stays green
    // with the outer margin deleted entirely — it would pass on exactly the
    // layout this card exists to fix. The two distances have to be
    // DISTINGUISHABLE, so the margin of separation is asserted too. 8 logical
    // pixels is the smallest step this list uses anywhere else (its paddings run
    // 2/4/8/10/14), i.e. the smallest difference the design treats as a
    // difference — not a number tuned to make today's value pass.
    expect(
      outsideGap,
      greaterThan(insideGap + 8),
      reason: 'measured inside=$insideGap outside=$outsideGap — a container '
          'whose inner gap is not visibly smaller than its outer gap groups '
          'nothing, which is the flat list owner reported',
    );
  });

  testWidgets('a SINGLE connection gets NO shell (chrome with nothing in it '
      'is worse than none)', (WidgetTester tester) async {
    // Card §2.4, and the positive control for every assertion above: the same
    // probe that finds a shell on the grouped list must NOT find one here, or it
    // is not measuring the grouping at all.
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(<MobileSession>[
      _row(
        token: 'tok-lan-000000000000000000000000',
        pcInstanceId: 'pc-inst-lan-0000000',
        pcMachineUid: _uid,
      ),
    ]));
    await tester.pumpAndSettle();

    expect(find.byKey(shellKey), findsNothing);
    expect(find.textContaining('同一台电脑'), findsNothing);
    // Positive control: the row itself really rendered, so the two negatives
    // above are reading an unshelled row rather than an empty page.
    expect(find.text('Studio PC'), findsOneWidget);
  });

  testWidgets('rows with no machine uid are never shelled — cannot-ask is not same-machine',
      (WidgetTester tester) async {
    // Two pre-0.2.4 pairings both report null. `groupPairingsByMachine` rule ①
    // keeps them apart, so `isShared` is false for both and no shell may appear
    // under ANY key — asserted over the whole tree rather than one key, because
    // a fabricated group would be keyed on the empty uid.
    await tester.binding.setSurfaceSize(const Size(400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(<MobileSession>[
      _row(token: 'tok-a-0000000000000000000000000', pcInstanceId: 'pc-inst-a-000000000'),
      _row(token: 'tok-b-0000000000000000000000000', pcInstanceId: 'pc-inst-b-000000000'),
    ]));
    await tester.pumpAndSettle();

    expect(find.byKey(machineGroupShellKey(null)), findsNothing);
    expect(find.byKey(machineGroupShellKey('')), findsNothing);
    expect(find.byKey(shellKey), findsNothing);
    expect(find.text('Studio PC'), findsNWidgets(2));
  });
}

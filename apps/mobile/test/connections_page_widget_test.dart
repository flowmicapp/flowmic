// WP-R23-1 — instance list rendered over the real controllers (fake socket +
// recorder). Proves the anti-façade wiring end-to-end at the UI: 添加设备 opens the
// add-pairing sheet, and a server-rejected code renders the LOUD error inline
// (never a fake success). Also asserts the empty-state hint + cloud entry render.
// T-6c: long-press rename alias — list reflects alias immediately; blank clears.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/ui/connection_card_identity.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/di.dart';

Future<Widget> _rig(
  FakeSocketTransport t, {
  List<MobileSession> seed = const <MobileSession>[],
  // owner 2026-07-27 reachability probe. Faked by DEFAULT and never optional:
  // the production probe is a real HttpClient, and a widget test that reached
  // the network would hang on every pumpAndSettle in this file.
  Future<HealthReading> Function(Uri, Duration) probe = _probeUnreachable,
  // RV-98 — the second probe (GET /api/pc/presence). Faked by default and never
  // optional, for exactly the same reason as `probe` above. The default answers
  // "cannot-ask", which is what a pre-0.2.36 server does and what every test written
  // before this card expects.
  PcPresenceReader presence = _presenceUnknown,
  /// Whether the isolated `mobile:unpair` dial reaches its server. False is the
  /// interesting case: the entry still goes locally, and the page must SAY that
  /// the PC's own list still has it.
  bool retireReaches = false,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings =
      AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.zh);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  for (final MobileSession s in seed) {
    await storage.addOrUpdatePairing(s);
  }
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    // v0.2.4 — `retirePairing` dials a SECOND, isolated socket. Left as the
    // production `SocketCore` it would reach for the real network here, and the
    // await would still be outstanding when the assertions run.
    retireTransport: () => FakeSocketTransport()..connectSucceeds = retireReaches,
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: probe,
    presenceReader: presence,
  );
  return MaterialApp(
    home: ConnectionsPage(
      connections: connections,
      appSettings: appSettings,
      login: login,
      destination: DestinationController(),
      chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
      settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
      historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
    ),
  );
}

Future<HealthReading> _probeUnreachable(Uri url, Duration timeout) async =>
    HealthReading.offline;
Future<HealthReading> _probeReachable(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.lan);
/// v0.2.3 — a reachable server that reports itself as the CLOUD RELAY. The row
/// must then say 云端中继, whatever kind of destination the pairing is.
Future<HealthReading> _probeCloudRelay(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.cloudRelay);

// ── RV-98 (卡 B4-14) — the second probe: "is that PC in its room" ─────────
Future<PcPresenceReading> _presenceUnknown(Uri u, String t, Duration d) async =>
    PcPresenceReading.unknown;
Future<PcPresenceReading> _presenceOnline(Uri u, String t, Duration d) async =>
    const PcPresenceReading(presence: PcPresence.online);
Future<PcPresenceReading> _presenceOffline(Uri u, String t, Duration d) async =>
    const PcPresenceReading(presence: PcPresence.offline);

MobileSession _seeded({
  String token = 'tok-seeded-00000000000000000000',
  String? pcName = 'Studio PC',
  String? displayAlias,
  DateTime? lastConnectedAt,
  String endpoint = 'http://192.168.1.5:41879',
  String? pcInstanceId,
  String? pcMachineUid,
}) => MobileSession(
  token: token,
  endpoint: endpoint,
  channel: 'standalone',
  pcName: pcName,
  displayAlias: displayAlias,
  pairingId: 'pair-seed',
  pcInstanceId: pcInstanceId,
  pcMachineUid: pcMachineUid,
  lastConnectedAt: lastConnectedAt,
);

void main() {
  testWidgets('empty list shows the pairing hint + add + cloud entry', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.pumpWidget(await _rig(t));
    await tester.pumpAndSettle();

    expect(find.text('还没有配对的电脑'), findsOneWidget);
    expect(find.text('添加设备'), findsOneWidget);
    expect(find.text('轻记录'), findsOneWidget); // migrated-in cloud entry
    expect(find.text('启动不自动连接 · 点实例连接'), findsOneWidget);
  });

  testWidgets('GA-33: the cloud ENTRY card retires once the cloud instance is remembered',
      (WidgetTester tester) async {
    // owner 2026-07-26 measured: after signing in, the home list showed both
    // 「FlowMic Cloud」 (the remembered pseudo-PC session) and the dashed
    // 「云端实例」 entry card — one thing, two rows.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(token: 'tok-cloud-000000000000000000000', pcName: 'FlowMic Cloud')
          .copyWith(channel: 'saas'),
    ]));
    await tester.pumpAndSettle();

    // Exactly one 「云端实例」 on screen — the row, not the row PLUS the card.
    expect(find.text('轻记录'), findsOneWidget);
    // …and it no longer wears a PC's clothes: it says what it is.
    expect(find.text('轻记录 · 仅记录'), findsOneWidget);
    expect(find.text('FlowMic Cloud'), findsNothing);
  });

  testWidgets('owner 2026-07-27: a reachable instance AND the cloud entry both report 在线',
      (WidgetTester tester) async {
    // 「启动到连接实例清单界面应有轻量级的检查对应的实例是否在线…包括云端实例也一样」
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded()], probe: _probeReachable));
    await tester.pumpAndSettle();

    expect(find.text('在线'), findsNWidgets(2)); // the PC row + the cloud entry
    expect(find.text('点击连接'), findsNothing);  // no longer the resting label
    // 2026-08-01 owner: 颜色+图标组合，不能只靠颜色 — the LAN PC's ChannelBadge
    // wears Icons.wifi (size 11); the static 轻记录 card's own leading icon
    // (size 20, always present) is the only cloud_outlined on screen — no SECOND
    // one from a badge, because this PC is on the LAN channel, not the relay.
    expect(find.byIcon(Icons.wifi), findsOneWidget);
    expect(find.byIcon(Icons.cloud_outlined), findsOneWidget);
  });

  testWidgets('owner 2026-07-27: an unreachable instance says 离线, it does not stay blank',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded()]));
    await tester.pumpAndSettle();

    expect(find.text('离线'), findsNWidgets(2));
    expect(find.text('在线'), findsNothing);
  });

  testWidgets('v0.2.3: a PC reached over the RELAY says 云端中继, not 本地局域网',
      (WidgetTester tester) async {
    // owner 2026-07-29 saw 本地局域网 on a relay-paired PC. The row used to read
    // `MobileSession.channel`, which answers "is this a virtual cloud instance" — a different
    // question. It now renders the MEASURED `/api/health.mode`.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(
      t,
      seed: <MobileSession>[_seeded(endpoint: 'https://flowmic.app')],
      probe: _probeCloudRelay,
    ));
    await tester.pumpAndSettle();

    expect(find.text('云端中继'), findsOneWidget);
    expect(find.text('本地局域网'), findsNothing);
    // 2026-08-01 owner: 颜色+图标组合，不能只靠颜色 — the transport chip is now
    // ChannelBadge (tokens.dart), and its icon is the REAL tell, not just the text.
    // TWO cloud_outlined on screen: the static 轻记录 card's own leading icon
    // (always present, size 20) PLUS this PC row's ChannelBadge (size 11, cloud=true
    // because it was reached over the relay) — never Icons.wifi, which would mean
    // the badge is wired to the lan colours while the text still says 云端中继.
    expect(find.byIcon(Icons.cloud_outlined), findsNWidgets(2));
    expect(find.byIcon(Icons.wifi), findsNothing);
  });

  // ── RV-98 (卡 B4-14) — owner's scene, on the real widgets ────────────────
  //
  // owner 2026-08-01：「截图 2 中的云端中继这个实例显示的是『中继可达 · 电脑是否在线
  // 未知』，**实际上 PC 是在线的**，这样显示不对，**要能正确显示 PC 端是否在线**」。
  //
  // Three as a set, none optional: asked-and-online says online, asked-and-offline
  // says **a different sentence**, asked-and-cannot-ask still says unknown.
  testWidgets('🔴 RV-98 relay row: asked and the PC is online ⇒ says 「在线」', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(
      t,
      seed: <MobileSession>[_seeded(endpoint: 'https://flowmic.app')],
      probe: _probeCloudRelay,
      presence: _presenceOnline,
    ));
    await tester.pumpAndSettle();

    // That row says the word owner asked for, not the 「未知」 leftover from RV-92.
    expect(find.text('中继可达 · 电脑是否在线未知'), findsNothing);
    expect(find.text('在线'), findsNWidgets(2)); // this PC + the 轻记录 card
  });

  testWidgets('🔴 RV-98 asked and the PC is offline ⇒ says 「电脑已离线」, a different sentence from 「离线」',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(
      t,
      seed: <MobileSession>[_seeded(endpoint: 'https://flowmic.app')],
      probe: _probeCloudRelay,
      presence: _presenceOffline,
    ));
    await tester.pumpAndSettle();

    expect(find.text('电脑已离线'), findsOneWidget);
    // Positive control: the relay itself is reachable, so the 轻记录 card still
    // says 「在线」 — two questions, two sentences; this screen proves at once
    // that "PC is absent" and "server is up" did not contaminate each other.
    expect(find.text('在线'), findsOneWidget);
    // 🔴 The "cannot reach the server" sentence must never appear here: the user
    // would go fix a network that is not broken.
    expect(find.text('离线'), findsNothing);
  });

  testWidgets('🔴 RV-98 the 「不知道」 face was not deleted: an old server that cannot be asked still says unknown',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(
      t,
      seed: <MobileSession>[_seeded(endpoint: 'https://flowmic.app')],
      probe: _probeCloudRelay,
      // Default is _presenceUnknown (404 / 401 / network jitter all land here).
    ));
    await tester.pumpAndSettle();

    expect(find.text('中继可达 · 电脑是否在线未知'), findsOneWidget);
    expect(find.text('电脑已离线'), findsNothing, reason: 'unknown ≠ knowing it is absent');
  });

  // ── v0.2.4 · "is this the same computer" ────────────────────────────────
  testWidgets('two pairings that share a machine uid render under ONE 同一台电脑 header',
      (WidgetTester tester) async {
    // owner 2026-07-29:「应能明确知道是否都是同一台手机和同一台 PC」. The two rows
    // stay separate (two tokens, two revocable pairings); what is new is the
    // statement that they are one computer.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(
        token: 'tok-lan-000000000000000000000000',
        pcInstanceId: 'pc-inst-lan-0000000',
        pcMachineUid: 'pc-00112233445566aa',
      ),
      _seeded(
        token: 'tok-cloud-00000000000000000000000',
        endpoint: 'https://flowmic.app',
        pcInstanceId: 'pc-inst-cloud-00000',
        pcMachineUid: 'pc-00112233445566aa',
      ),
    ]));
    await tester.pumpAndSettle();

    expect(find.text('Studio PC · 同一台电脑的 2 个连接'), findsOneWidget);
    // …and BOTH rows are still there and still individually tappable.
    expect(find.text('Studio PC'), findsNWidgets(2));
  });

  // RV-54 — both offline, never measured this session: the dial host is the
  // addressable fact (LAN IP vs relay domain). Live chips must stay absent.
  testWidgets('RV-54: two offline same-machine rows stay distinguishable by '
      'dial host — not by a fake live chip', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(
        token: 'tok-lan-000000000000000000000000',
        endpoint: 'http://192.168.1.5:41879',
        pcInstanceId: 'pc-inst-lan-0000000',
        pcMachineUid: 'pc-00112233445566aa',
      ),
      _seeded(
        token: 'tok-relay-0000000000000000000000',
        endpoint: 'https://flowmic.app',
        pcInstanceId: 'pc-inst-relay-00000',
        pcMachineUid: 'pc-00112233445566aa',
      ),
    ]));
    await tester.pumpAndSettle();

    expect(find.text('Studio PC · 同一台电脑的 2 个连接'), findsOneWidget);
    expect(find.text('192.168.1.5:41879'), findsOneWidget);
    expect(find.text('flowmic.app'), findsOneWidget);
    // Neither live chip: both probes failed, so painting 云端中继/本地局域网
    // would be inventing "now" from nothing.
    expect(find.text('云端中继'), findsNothing);
    expect(find.text('本地局域网'), findsNothing);
    expect(find.text('上次经云端中继'), findsNothing);
    expect(find.text('上次本地局域网'), findsNothing);
  });

  testWidgets('RV-54: a remembered channel while offline says 上次, not the '
      'live chip face', (WidgetTester tester) async {
    // Probe succeeds once (channel cached), then fails — the row must keep
    // naming the past measurement as 「上次」, never wear the live fill.
    bool up = true;
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      await _rig(
        t,
        seed: <MobileSession>[
          _seeded(endpoint: 'https://flowmic.app'),
        ],
        probe: (Uri url, Duration timeout) async {
          if (!up) return HealthReading.offline;
          if (url.host.contains('flowmic.app')) {
            return const HealthReading(ok: true, channel: ServerChannel.cloudRelay);
          }
          return HealthReading.offline;
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('云端中继'), findsOneWidget);
    expect(find.text('上次经云端中继'), findsNothing);

    up = false;
    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();

    expect(find.text('离线'), findsWidgets);
    expect(find.text('上次经云端中继'), findsOneWidget);
    expect(
      find.text('云端中继'),
      findsNothing,
      reason: 'the live chip and the 「上次」 chip must not share one face',
    );
  });

  testWidgets('rows with NO machine uid are never grouped — cannot-ask is not same-machine',
      (WidgetTester tester) async {
    // The negative control. Two pre-0.2.4 pairings both report null, and
    // treating that as a match would fabricate 「同一台电脑」 out of two
    // absences — the exact shape of dishonesty the grouping rule forbids.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(token: 'tok-a-0000000000000000000000000', pcInstanceId: 'pc-inst-a-000000000'),
      _seeded(token: 'tok-b-0000000000000000000000000', pcInstanceId: 'pc-inst-b-000000000'),
    ]));
    await tester.pumpAndSettle();

    expect(find.textContaining('同一台电脑'), findsNothing);
    expect(find.text('Studio PC'), findsNWidgets(2));
  });

  testWidgets('a delete that could not reach the PC SAYS so (v0.2.4)',
      (WidgetTester tester) async {
    // v0.2.3 made the phone actually retire the pairing server-side, and the
    // controller has recorded whether that landed ever since — but nothing
    // rendered it, so a delete the server never heard about looked identical to
    // one it did. The local entry still goes (an unreachable PC has to be
    // cleanable); what changes is that the phone stops implying the PC agreed.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = false;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded()]));
    await tester.pumpAndSettle();

    await tester.drag(find.text('Studio PC'), const Offset(-500, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();

    expect(find.textContaining('它那边的记录还在'), findsOneWidget);
    // …and it really is gone from THIS phone: the message is an added truth,
    // not a refusal.
    expect(find.text('Studio PC'), findsNothing);
  });

  testWidgets('pull-to-refresh runs a fresh reachability probe', (WidgetTester tester) async {
    int probeCalls = 0;
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      await _rig(
        t,
        seed: <MobileSession>[_seeded()],
        probe: (Uri url, Duration timeout) async {
          probeCalls += 1;
          return const HealthReading(ok: true, channel: ServerChannel.lan);
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(probeCalls, 2); // remembered PC + cloud relay on cold load

    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();

    expect(probeCalls, 4); // the same two endpoints were measured again
  });

  testWidgets('V2-06b: the history icon sits LEFT of the ⚙ and pushes 全部历史',
      (WidgetTester tester) async {
    // owner ruling: the entry belongs on the HOME header (not the chat page's
    // test icon) — left of the gear.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.pumpWidget(await _rig(t));
    await tester.pumpAndSettle();

    final Finder entry = find.byKey(const ValueKey<String>('connections.history'));
    expect(entry, findsOneWidget);
    final double historyX = tester.getTopLeft(entry).dx;
    final double gearX = tester.getTopLeft(find.byIcon(Icons.settings_outlined)).dx;
    expect(historyX, lessThan(gearX), reason: 'history must sit left of the ⚙');

    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(find.text('HISTORY'), findsOneWidget);
  });

  testWidgets('GA-33: with no cloud session the entry card is still there', (WidgetTester tester) async {
    // The card is how you GET a cloud instance — retiring it unconditionally
    // would remove the entry point entirely.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded()]));
    await tester.pumpAndSettle();
    expect(find.text('轻记录'), findsOneWidget);
    expect(find.text('Studio PC'), findsOneWidget);
  });

  testWidgets('a rejected code renders the loud error inline (fail-loud)', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()
      ..connectSucceeds = true
      ..defaultAck = <String, Object?>{'error': 'PAIR_INVALID_CODE'};
    await tester.pumpWidget(await _rig(t));
    await tester.pumpAndSettle();

    await tester.tap(find.text('添加设备'));
    await tester.pumpAndSettle();

    // GA-30 (owner:「扫码优先于手输」): the sheet now opens on the SCAN tab, so the
    // manual form is one deliberate tap away. Asserted here rather than worked
    // around, because it IS the new contract.
    expect(find.text('扫码'), findsOneWidget);
    await tester.tap(find.text('手动输入'));
    await tester.pumpAndSettle();

    // Fill the address + a well-formed code so it reaches the wire (and is rejected).
    //
    // 0.2.66 — the code field is addressed BY KEY, not by index. The manual tab
    // now carries a third field (PCID) whenever the address is the cloud relay,
    // and this page pre-fills the relay when there is no prior pairing ⇒ index 1
    // was the PCID box for the first keystroke of this test.
    await tester.enterText(find.byType(TextField).at(0), '192.168.1.5:41879');
    await tester.enterText(find.byKey(const ValueKey<String>('pair.code')), '1234');
    await tester.tap(find.text('配对并连接'));
    await tester.pumpAndSettle();

    // The mapped, loud error is shown; the sheet stays open (no fake success).
    expect(find.text('配对码无效'), findsOneWidget);
    expect(find.text('CHAT'), findsNothing);
  });

  testWidgets('long-press rename shows the new alias on the list', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded()]));
    await tester.pump(); // load() completes synchronously on InMemoryTokenStorage
    await tester.pump();

    expect(find.text('Studio PC'), findsOneWidget);

    await tester.longPress(find.text('Studio PC'));
    await tester.pump(); // dialog route pushed
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('修改别名'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '办公桌');
    await tester.tap(find.text('保存'));
    // Finish the dialog route pop (300ms Material transition) + reload.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('办公桌'), findsOneWidget);
    expect(find.text('Studio PC'), findsNothing);
    expect(find.text('修改别名'), findsNothing);
  });

  testWidgets("GA-10: an alias keeps the PC's OWN name visible in small type",
      (WidgetTester tester) async {
    // owner 2026-07-26 iron rule ③: the phone-local rename never leaves the device, so
    // this list is the only place the two names can diverge — hiding the real one
    // would leave the user unable to tell which machine they are speaking into.
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(pcName: 'FlowMic-STUDIO-3f7a', displayAlias: '家里那台'),
    ]));
    await tester.pumpAndSettle();

    expect(find.text('家里那台'), findsOneWidget);
    expect(find.text('原名 FlowMic-STUDIO-3f7a'), findsOneWidget);
  });

  testWidgets('GA-10: no alias → no redundant second line', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[_seeded(pcName: 'Studio PC')]));
    await tester.pumpAndSettle();
    expect(find.text('Studio PC'), findsOneWidget);
    expect(find.textContaining('原名'), findsNothing);
  });

  testWidgets('last connection renders only when the persisted stamp exists',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(
        token: 'tok-current-0000000000000000000000',
        pcName: '有时间的 PC',
        // A future local-wall-clock value exercises the rollback clamp too.
        lastConnectedAt: DateTime.now().toUtc().add(const Duration(hours: 3)),
      ),
      _seeded(
        token: 'tok-legacy-00000000000000000000000',
        pcName: '遗留 PC',
      ),
    ]));
    await tester.pumpAndSettle();

    expect(find.text('最后连接 · 刚刚'), findsOneWidget);
    expect(find.textContaining('最后连接'), findsOneWidget);
    expect(find.text('遗留 PC'), findsOneWidget); // no guessed 「刚刚」 for this row
  });

  test('last-connected copy uses the explicit app locale and clamps future age', () {
    final DateTime now = DateTime(2026, 7, 28, 13);
    final AppStrings zh = AppStrings.of(AppLocale.zh);
    final AppStrings en = AppStrings.of(AppLocale.en);

    expect(
      zh.lastConnectedAt(DateTime(2026, 7, 28, 12, 57), now: now),
      '最后连接 · 3 分钟前',
    );
    expect(
      zh.lastConnectedAt(DateTime(2026, 7, 27, 20, 5), now: now),
      '最后连接 · 昨天 20:05',
    );
    expect(
      zh.lastConnectedAt(DateTime(2026, 7, 28, 16), now: now),
      '最后连接 · 刚刚',
    );
    expect(
      en.lastConnectedAt(DateTime(2026, 7, 28, 12, 57), now: now),
      'Last connected · 3 min ago',
    );
  });

  testWidgets('blank rename input clears alias back to device name', (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      await _rig(
        t,
        seed: <MobileSession>[_seeded(displayAlias: '办公桌')],
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('办公桌'), findsOneWidget);

    await tester.longPress(find.text('办公桌'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 「恢复默认」 pops '' → storage clears alias → list shows pcName again.
    await tester.tap(find.text('恢复默认'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Studio PC'), findsOneWidget);
    expect(find.text('办公桌'), findsNothing);
    expect(find.text('修改别名'), findsNothing);
  });

  // ── REQ-12-10 — identity lane (notes vs PC chrome) ─────────────────────────
  testWidgets('REQ-12-10: empty list cloud ENTRY wears notes identity lane',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t));
    await tester.pumpAndSettle();

    expect(find.byKey(ConnectionCardIdentity.notesLaneKey), findsOneWidget);
    expect(find.byKey(ConnectionCardIdentity.pcNeutralLaneKey), findsNothing);
  });

  testWidgets('REQ-12-10: notes session and PC rows use different lane keys',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(pcMachineUid: 'mach-office-aaa'),
      _seeded(
        token: 'tok-cloud-000000000000000000000',
        pcName: 'FlowMic Cloud',
      ).copyWith(channel: 'saas'),
    ]));
    await tester.pumpAndSettle();

    expect(find.byKey(ConnectionCardIdentity.notesLaneKey), findsOneWidget);
    final int lane =
        ConnectionCardIdentity.machineLaneIndex('mach-office-aaa')!;
    expect(find.byKey(ConnectionCardIdentity.pcLaneKey(lane)), findsOneWidget);
    // Entry retired (GA-33) — still exactly one notes lane (the session row).
    expect(find.text('轻记录'), findsOneWidget);
  });

  testWidgets('REQ-12-10: two PCs with different machine_uids get different lanes',
      (WidgetTester tester) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    const String uidA = 'machine-alpha-001';
    const String uidB = 'machine-beta-002';
    final int laneA = ConnectionCardIdentity.machineLaneIndex(uidA)!;
    final int laneB = ConnectionCardIdentity.machineLaneIndex(uidB)!;
    expect(laneA, isNot(laneB));

    await tester.pumpWidget(await _rig(t, seed: <MobileSession>[
      _seeded(
        token: 'tok-a-000000000000000000000000',
        pcName: 'Alpha PC',
        pcMachineUid: uidA,
        pcInstanceId: 'inst-a',
      ),
      _seeded(
        token: 'tok-b-000000000000000000000000',
        pcName: 'Beta PC',
        pcMachineUid: uidB,
        endpoint: 'http://192.168.1.6:41879',
        pcInstanceId: 'inst-b',
      ),
    ]));
    await tester.pumpAndSettle();

    expect(find.byKey(ConnectionCardIdentity.pcLaneKey(laneA)), findsOneWidget);
    expect(find.byKey(ConnectionCardIdentity.pcLaneKey(laneB)), findsOneWidget);
  });
}

// 🔴 RV-92 —— 「relay is reachable」 was treated as 「my PC is online」.
//
// owner 2026-08-01 measured on a real device, verbatim:「云端中继模式下，退出 PC 端，**仍然会显示连接状态且有
// PC 端的实例名和目标窗口名**，说话后显示：未投递」; follow-up ruling:「在**连接实例清单**，
// 对于是否在线的检测**要检测到 PC 端**，现在云端中继通道的实例会显示在线，但 PC 端已
// 关闭，这是不对的；**云端轻记录这个默认实例只需要能连接云端中继服务器就行**。」
//
// This file pins the **structure** of that owner scene, not some function's return value:
//   ① truth table of a pure projection ([instanceLivenessFaceOf]);
//   ② the **only** wire fact in the session that actively says 「the PC left」 is actually read;
//   ③ 🔴 **the three statements at the top go stale after the PC exits — while the socket stays connected the whole time** (this card's core);
//   ④ instance list: a **real PC row** the relay answered for no longer says 「online」, while **cloud light-notes** still says online;
//   ⑤/⑥ RV-89's two channel-measurement criteria (clear on endpoint change / keep on same-endpoint failure).
//
// ⚠️ Reverse control (actually seen red; original wording is in the handoff report):
//   · change the relayOnlyPcUnknown branch of [instanceLivenessFaceOf] back to `pcOnline` ⇒ ①④ go red;
//   · tear out the `addListener(_onPcPresenceChanged)` line in `chat_controller` ⇒ ③ goes red on
//     the 「target window name」 assertion (**while the connection-point assertion stays green** — exactly the combination owner hit);
//   · drop the clear at the start of `_refreshServerChannel` ⇒ ⑤ goes red (the fail-open window).

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

void main() {
  // ── ① pure projection: which word this row should say ─────────────────────
  group('instanceLivenessFaceOf — one value answers one question', () {
    test('🔴 owner\'s scene: the relay answered 「I am here」, the real-PC row must never say 「online」', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.relayOnlyPcUnknown,
      );
    });

    test('owner\'s exception: cloud light-notes is online as long as the relay is reachable', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.cloudNotes,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.pcOnline,
      );
    });

    test('LAN: the answering sidecar runs on that PC ⇒ this probe asked that PC', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.lan,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.pcOnline,
      );
    });

    test('mode not measured ⇒ fail-closed, treat as relay (must never paint as online)', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: null,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.relayOnlyPcUnknown,
      );
    });

    test('offline may pass through (if the server is unreachable the PC certainly is); online may not', () {
      for (final ServerChannel? ch in <ServerChannel?>[
        ServerChannel.lan,
        ServerChannel.cloudRelay,
        null,
      ]) {
        expect(
          instanceLivenessFaceOf(
            reach: InstanceReach.offline,
            answeringChannel: ch,
            target: InstanceTarget.pc,
            pcPresence: PcPresence.unknown,
          ),
          InstanceLivenessFace.unreachable,
        );
      }
    });

    // ── RV-98 (card B4-14): we have **actually asked that computer** now ────
    //
    // owner 2026-08-01 verbatim:「截图 2 中的云端中继这个实例显示的是『中继可达 · 电脑
    // 是否在线未知』，**实际上 PC 是在线的**，这样显示不对，**要能正确显示 PC 端是否
    // 在线**」. The relayOnlyPcUnknown assertion above still holds — it now pins
    // 「what to say **when we did not ask**」, not 「what to say forever」.
    test('🔴 RV-98 owner scene, the correct reading: asked and got online ⇒ the real-PC row is 「online」', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.online,
        ),
        InstanceLivenessFace.pcOnline,
      );
    });

    test('🔴 asked and got offline ⇒ pcOffline, **a different face from unreachable**', () {
      final InstanceLivenessFace face = instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: PcPresence.offline,
      );
      expect(face, InstanceLivenessFace.pcOffline);
      // Reverse control: not reaching the server is a different sentence. Collapsing
      // them into one 「offline」 would send the user to fix the network while the
      // computer is sitting there fine, or the other way around.
      expect(face, isNot(InstanceLivenessFace.unreachable));
    });

    test('🔴 measurement beats inference: asked offline on LAN ⇒ pcOffline (the orphan-sidecar scene)', () {
      // The old criterion said 「LAN ⇒ online」, because the answering sidecar runs
      // on that PC. But a live sidecar with a dead desktop process is a scene this
      // repo already has precedent for — then there is no PC in the room. Once we
      // have a measurement, inference is not allowed.
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.lan,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.offline,
        ),
        InstanceLivenessFace.pcOffline,
      );
    });

    test('🔴 owner\'s exception is untouched: cloud light-notes is never even asked; offline still paints online', () {
      // That virtual PC row never joins a room ⇒ asking for real would always
      // answer false. The caller structurally does not ask
      // (`connections_controller`); this pins a second door: even if someone
      // force-feeds the answer in, the face must not flip.
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.cloudNotes,
          pcPresence: PcPresence.offline,
        ),
        InstanceLivenessFace.pcOnline,
      );
    });

    test('🔴 the 「unknown」 face was not deleted: when we cannot ask, still say unknown, never degrade to offline', () {
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.pc,
          pcPresence: PcPresence.unknown,
        ),
        InstanceLivenessFace.relayOnlyPcUnknown,
      );
    });

    test('when the server is unreachable, whatever presence says does not change the answer (offline passes through)', () {
      for (final PcPresence p in PcPresence.values) {
        expect(
          instanceLivenessFaceOf(
            reach: InstanceReach.offline,
            answeringChannel: ServerChannel.cloudRelay,
            target: InstanceTarget.pc,
            pcPresence: p,
          ),
          InstanceLivenessFace.unreachable,
          reason: '$p',
        );
      }
    });

    test('the destination criterion reads the pairing\'s channel, not which channel this trip used', () {
      expect(
        instanceTargetOf(const MobileSession(
          token: 'tok-cloud-notes-0000000000000000',
          endpoint: 'https://flowmic.app',
          channel: 'saas',
        )),
        InstanceTarget.cloudNotes,
      );
      // A **real PC** reached via the relay: channel is still standalone
      // (written in stone at pairing time in ptt_session.dart), so it will
      // never fall into owner's exception by mistake.
      expect(
        instanceTargetOf(const MobileSession(
          token: 'tok-relay-pc-000000000000000000',
          endpoint: 'https://flowmic.app',
          channel: 'standalone',
        )),
        InstanceTarget.pc,
      );
    });
  });

  // ── ② session online state: every transition comes from a wire fact that is live today ──
  group('PcPresence — every transition has a wire fact', () {
    test('starts at unknown (no answer is allowed until someone has spoken)', () {
      final PttSession s = newTestSession(transport: FakeSocketTransport());
      addTearDown(s.dispose);
      expect(s.pcPresence.value, PcPresence.unknown);
    });

    test('🔴 inject:result{INJECT_PC_OFFLINE} ⇒ offline — the same frame owner saw as 「未投递」', () {
      final FakeSocketTransport t = FakeSocketTransport();
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);

      t.pushIncoming('focus:state', <String, Object?>{
        'window_title': '记事本',
        'process_name': 'notepad.exe',
      });
      expect(s.pcPresence.value, PcPresence.online, reason: 'only a PC produces focus:state');

      t.pushIncoming('inject:result', <String, Object?>{
        'ok': false,
        'mode': 'sendinput',
        'error': 'INJECT_PC_OFFLINE',
      });
      expect(s.pcPresence.value, PcPresence.offline);
    });

    test('the PC answering in its own voice (a success receipt) ⇒ online', () {
      final FakeSocketTransport t = FakeSocketTransport();
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);
      t.pushIncoming('inject:result',
          <String, Object?>{'ok': true, 'mode': 'sendinput'});
      expect(s.pcPresence.value, PcPresence.online);
    });

    test('not every refusal code is testimony: PC_BUSY presupposes the PC is online; oversized frame is a server-boundary refuse', () {
      final FakeSocketTransport t = FakeSocketTransport();
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);
      t.pushIncoming('focus:state', <String, Object?>{'process_name': 'x.exe'});
      for (final String code in <String>['PC_BUSY', 'INJECT_FRAME_TOO_LARGE']) {
        t.pushIncoming('inject:result',
            <String, Object?>{'ok': false, 'mode': 'sendinput', 'error': code});
        expect(s.pcPresence.value, PcPresence.online, reason: code);
      }
    });

    test('🔴 R3 local watchdog: a sentence the remote once said must not outlive the connection that said it', () {
      final FakeSocketTransport t = FakeSocketTransport();
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);
      t.pushIncoming('focus:state', <String, Object?>{'process_name': 'x.exe'});
      expect(s.pcPresence.value, PcPresence.online);

      t.pushStatus(SocketStatus.disconnected);
      // unknown, not offline — we merely no longer know, we do not know it is gone.
      expect(s.pcPresence.value, PcPresence.unknown);
    });

    test('ack\'s pc_online is a truth we already had (previously dropped on the floor); a missing field must never back-fill', () {
      final PcPresenceTracker t1 = PcPresenceTracker();
      t1.noteAck(<String, Object?>{'pc_online': true});
      expect(t1.value, PcPresence.online);
      t1.noteAck(<String, Object?>{'pc_online': false});
      expect(t1.value, PcPresence.offline);

      final PcPresenceTracker t2 = PcPresenceTracker();
      t2.noteAck(<String, Object?>{'pc_name': 'Studio PC'}); // old server
      expect(t2.value, PcPresence.unknown);
    });
  });

  // ── ③ 🔴 this card's core: after the PC exits, the three statements at the top go stale (socket stays connected) ──
  testWidgets(
      '🔴 owner\'s scene: relay stays up, PC exits ⇒ 「target window name」 disappears and 「电脑已离线」 appears',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final FakeSocketTransport t = FakeSocketTransport();
    final ChatController c = ChatController(
      session: newTestSession(
        transport: t,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      ),
      store: newTestStore(),
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: t),
      localPrefs: InMemoryLocalPrefs(),
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );
    addTearDown(() async {
      await c.dispose();
      c.destination.dispose();
      c.store.dispose();
    });
    c.session.connectedDeviceName.value = 'Studio PC';

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: c)));

    // Link up (the destination badge paints a neutral `→ —` while disconnected;
    // that is not the scene this test wants).
    t.pushStatus(SocketStatus.connected);
    await tester.pump();

    // PC is present: it reported its own foreground window.
    t.pushIncoming('focus:state', <String, Object?>{
      'window_title': '无标题 - 记事本',
      'process_name': 'notepad.exe',
    });
    await tester.pump();

    // ── positive control (a negative assertion must bring its own, or 「zero」 may just mean the probe is blind) ──
    expect(find.text('→ notepad.exe'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('chat.pcOffline')), findsNothing);

    // ── PC exits. The relay did not; the socket did not drop a single word ──
    t.pushIncoming('inject:result', <String, Object?>{
      'ok': false,
      'mode': 'sendinput',
      'error': 'INJECT_PC_OFFLINE',
    });
    await tester.pump();

    // Premise: this scene is defined as 「the link is fine」. If it dropped, this test would not be measuring this thing.
    expect(t.currentStatus, SocketStatus.connected,
        reason: 'in the scene owner hit, the socket was fine — relay present, PC not');

    // 1️⃣ target window name: must disappear (nobody used to clear it).
    expect(find.text('→ notepad.exe'), findsNothing);
    expect(c.destination.focusApp, isNull);
    // 2️⃣ someone must **say out loud** the computer is gone (silence = the other half of saying an undone thing was done).
    expect(find.byKey(const ValueKey<String>('chat.pcOffline')), findsOneWidget);
    expect(find.text('电脑已离线'), findsOneWidget);
    // 3️⃣ the instance name stays, and **that is not a defect**: we are still paired to that PC, and next to it we already write that it is gone.
    expect(find.text('Studio PC'), findsOneWidget);
  });

  // ── ④ instance list: the cut owner ruled ──────────────────────────────────
  testWidgets('🔴 instance list: a real-PC row the relay answered for does not say 「online」; cloud light-notes still does',
      (WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
    await appSettings.load();
    appSettings.setLocale(AppLocale.zh);

    final InMemoryTokenStorage storage = InMemoryTokenStorage();
    await storage.addOrUpdatePairing(const MobileSession(
      token: 'tok-relay-pc-000000000000000000',
      endpoint: 'https://flowmic.app',
      channel: 'standalone', // a **real PC** reached via the relay
      pcInstanceId: 'pc-inst-relay-00000',
      pcName: 'Studio PC',
    ));
    final FakeSocketTransport t = FakeSocketTransport();
    final PttSession session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      tokenStorage: storage,
      retireTransport: FakeSocketTransport.new,
    );
    final LoginController login = newTestLogin(transport: session.transport);
    final ConnectionsController connections = ConnectionsController(
      session: session,
      login: login,
      healthReader: (Uri url, Duration timeout) async =>
          const HealthReading(ok: true, channel: ServerChannel.cloudRelay),
      // RV-98 — the **premise** of this assertion is 「the computer was not asked」,
      // so this must explicitly write 「could not ask」 rather than let the
      // production probe dial: flutter_test replaces HttpClient with a fake,
      // which is exactly the layer RV-97's bug hid in (what the stand-in
      // replaced, the suite cannot see).
      presenceReader: (Uri url, String token, Duration timeout) async =>
          PcPresenceReading.unknown,
    );

    await tester.pumpWidget(MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
      ),
    ));
    await tester.pumpAndSettle();

    // Positive control: the probe did answer (otherwise the 「zero」 below is just a blind probe).
    expect(find.text('云端中继'), findsWidgets);
    // 🔴 owner:「这是不对的」— that PC was never even asked.
    expect(find.text('中继可达 · 电脑是否在线未知'), findsOneWidget);
    // And the cloud light-notes card **must** still say online (owner's exception).
    expect(find.text('在线'), findsOneWidget);
  });

  // ── ⑤⑥ RV-89: a channel measurement must carry 「which endpoint it was measured on」 ──
  group('serverChannel — a measurement must say who it is about (RV-89)', () {
    test('🔴 switch PC without leaving the room: the moment the endpoint changes, clear first (the fail-OPEN window)', () async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);

      final Completer<HealthReading> gate = Completer<HealthReading>();
      s.healthReader = (Uri url, Duration timeout) async {
        if (url.host == 'lan.example') {
          return const HealthReading(ok: true, channel: ServerChannel.lan);
        }
        return gate.future; // B's probe **has not come back** — that is the window
      };

      await s.resumePairing(const MobileSession(
        token: 'tok-lan-a-00000000000000000000',
        endpoint: 'http://lan.example:41879',
      ));
      await Future<void>.delayed(Duration.zero);
      expect(s.serverChannel.value, ServerChannel.lan, reason: 'positive control: A was indeed measured');

      // Switch to B (cloud relay). `connectTo` does not go through leaveRoom(),
      // so the notifier still holds A's answer.
      unawaited(s.resumePairing(const MobileSession(
        token: 'tok-relay-b-00000000000000000',
        endpoint: 'https://flowmic.app',
      )));
      await Future<void>.delayed(Duration.zero);

      // 🔴 that window must never still be lan — `imageOriginalAllowed` only
      // accepts lan, and null is treated as cloud (fail-closed). If this goes
      // red, an original image went onto the relay.
      expect(s.serverChannel.value, isNot(ServerChannel.lan));
      expect(s.serverChannel.value, isNull);
      gate.complete(const HealthReading(ok: true, channel: ServerChannel.cloudRelay));
    });

    test('same-endpoint probe failure ⇒ keep the last answer (converges with _probeOne\'s written policy)', () async {
      final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
      final PttSession s = newTestSession(transport: t);
      addTearDown(s.dispose);

      int calls = 0;
      s.healthReader = (Uri url, Duration timeout) async {
        calls++;
        if (calls == 1) {
          return const HealthReading(ok: true, channel: ServerChannel.lan);
        }
        // RV-89's real root-cause shape: `ws://` makes HttpClient throw Error, not Exception.
        throw ArgumentError('Unsupported scheme');
      };

      const MobileSession p = MobileSession(
        token: 'tok-lan-a-00000000000000000000',
        endpoint: 'http://lan.example:41879',
      );
      await s.resumePairing(p);
      await Future<void>.delayed(Duration.zero);
      expect(s.serverChannel.value, ServerChannel.lan);

      await s.resumePairing(p); // same endpoint, this probe blew up
      await Future<void>.delayed(Duration.zero);
      expect(s.serverChannel.value, ServerChannel.lan,
          reason: '「we did not get an answer this time」 is not 「it changed」 — one failure is no longer a lifetime verdict');
      expect(calls, greaterThan(1));
    });
  });
}

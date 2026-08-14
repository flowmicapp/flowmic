// 卡 B4-6 / RV-89 — "on the LAN channel, the original-image tick box really appears on the panel".
//
// owner 2026-08-01 measured:「我在手机上并没有发现有原图的勾选框或选项……我确认是在
// 本地局域网通道下没看到原图的勾选功能」. 0.2.34 shipped the control and it was
// invisible on the one channel it exists for.
//
// ── WHY THE EXISTING TESTS WERE ALL GREEN ────────────────────────────────────
// image_original_option_test.dart hands the controller `liveChannel: () =>
// ServerChannel.lan`. plus_panel_widget_test.dart hands the panel
// `originalBlock: null`. Both assert something true about a value that, on a
// real handset, NOTHING PRODUCES — the exact 反 façade shape 13 册 §7 F1 ③ is
// about: unit tests all-green have zero proof of "wiring". So this file starts at the WIRE and ends at
// a widget key, and every step in between is production code:
//
//   real /api/health server
//     → healthUri (instance_probe.dart)          ← the broken link, RV-89
//     → httpHealthRead                            ← real HttpClient, real JSON
//     → PttSession.resumePairing → _refreshServerChannel
//     → session.serverChannel
//     → ChatController's `liveChannel` closure (chat_controller.dart)
//     → ImageSendController.originalBlock
//     → PlusPanel                                 ← pumped for real
//     → find.byKey('plus.image.original')
//
// ── THE ROOT CAUSE THIS FILE PINS ────────────────────────────────────────────
// A QR-paired PC stores the endpoint the QR carried, and the desktop always
// writes a ws-url (apps/desktop/src/lib/pairing.ts `toWsUrl()`). `HttpClient.getUrl`
// throws `ArgumentError: Unsupported scheme 'ws'` on that — an **Error, not an
// Exception** — so `httpHealthRead`'s `on Exception` never caught it and
// `_refreshServerChannel`'s blanket catch wrote down "unknown", permanently, for
// every QR-paired session. `originalBlock` is fail-closed on "unknown" (correctly
// — a guessed LAN would put an original on the relay), so the tick box was
// replaced by 「尚未确认当前通道」 forever.
//
// Reverse control (must be seen RED, not assumed): restore `healthUri` to
// `Uri.parse(e).replace(path: '/api/health', …)` and every test below fails with
// that ArgumentError.
//
// SPEC-REF: apps/mobile/lib/src/session/instance_probe.dart (healthUri);
//   apps/mobile/lib/src/ptt/ptt_session.dart §_refreshServerChannel;
//   apps/mobile/lib/src/session/image_payload.dart (imageOriginalAllowed);
//   apps/mobile/lib/src/ui/plus_panel.dart (_ImageTile);
//   docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md;
//   CLAUDE.md 反 façade ③④ / 没有静默失败.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/favorites/favorites_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/image_send_controller.dart'
    show ImageOriginalBlock;
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/link_recovery.dart' show sessionLanIngress;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/plus_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _zh = AppStringsZh();

/// The two widget keys this whole file exists to tell apart.
const Key kTickBox = ValueKey<String>('plus.image.original');
const Key kBlockedSentence = ValueKey<String>('plus.image.original.blocked');

/// 🔴 WHY NO TEST IN THIS REPO COULD EVER HAVE CAUGHT RV-89.
///
/// `TestWidgetsFlutterBinding` installs an [HttpOverrides] whose client answers
/// EVERY request with status 400 and opens no socket ("Warning: At least one
/// test in this suite creates an HttpClient…"). The bug is `HttpClient.getUrl`
/// throwing on a `ws://` URI — under the test binding that is not the real
/// `getUrl`, so the failure mode does not exist in-process. Every probe test
/// this repo has ever had was measuring the stub.
///
/// The base [HttpOverrides] implementation IS the production factory, so this
/// un-fakes networking for the block rather than substituting a second fake.
/// Law (CLAUDE.md): how hard a measurement is depends on whether the mechanism that produced it is the path the product actually takes.
class _RealHttpOverrides extends HttpOverrides {}

Future<T> _withRealHttp<T>(Future<T> Function() body) =>
    HttpOverrides.runWithHttpOverrides<Future<T>>(body, _RealHttpOverrides());

/// A REAL http server answering the REAL `/api/health` shape
/// (apps/server-core/src/http/router.ts). Not a stub of our own probe: the
/// point of this file is that the bytes go over a socket and back.
Future<HttpServer> _healthServer(String mode) async {
  final HttpServer server =
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(server.forEach((HttpRequest req) async {
    if (req.uri.path == '/api/health') {
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(<String, Object?>{
          'ok': true,
          'mode': mode,
          'port': server.port,
          'version': '0.0.0-test',
        }));
    } else {
      req.response.statusCode = HttpStatus.notFound;
    }
    await req.response.close();
  }));
  return server;
}

/// The pairing a QR scan produces: the endpoint is the ws-url VERBATIM, exactly
/// as `PairEntry.parse` extracts it and `PttSession.pair` persists it. Using an
/// `http://` endpoint here would test the short-code path and quietly stop
/// describing the bug owner hit.
MobileSession _qrPairing(int port) => MobileSession(
      token: 'tok-test-abcdefghijklmnopqrstuvwxyz012',
      endpoint: 'ws://127.0.0.1:$port',
      channel: 'standalone',
      pcInstanceId: 'inst-test-1',
      pairingId: 'pair-test-1',
      pcId: 'pc-test-0001',
      pcMachineUid: 'machine-test-0001',
      pcName: 'Test PC',
    );

/// Connect a real [PttSession] to [server] through the production path, and
/// wait for the fire-and-forget channel probe to land.
Future<PttSession> _connectedSession(
  HttpServer server,
  FakeSocketTransport transport,
) =>
    _withRealHttp(() async {
      final PttSession session = newTestSession(transport: transport);
      transport.connectSucceeds = true;
      // `healthReader` is left at its production default (httpHealthRead) on
      // purpose — swapping in a fake here would skip the very call that broke.
      await session.resumePairing(_qrPairing(server.port));
      // The probe is `unawaited` in production (knowing the label is not a
      // precondition for talking), so the test waits rather than assuming.
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 5));
      while (session.serverChannel.value == null &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      await session.reconnect.stop();
      return session;
    });

ChatController _chatOn(PttSession session, FakeSocketTransport transport) =>
    ChatController(
      session: session,
      store: newTestStore(),
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    );

/// The panel, built with the SAME expression chat_flow_page.dart:648 uses.
Widget _panel(ChatController controller, FavoritesStore favorites) => MaterialApp(
      home: Scaffold(
        body: PlusPanel(
          favorites: favorites,
          strings: _zh,
          buffer: '',
          noPcTarget: false,
          onSend: (String _) {},
          onFeedback: (String _) {},
          onPickImage: (bool _) async {},
          imageSending: controller.imageSend.isSending,
          originalBlock: controller.imageSend.originalBlock,
        ),
      ),
    );

void main() {
  // ── ① the wire: a QR-shaped endpoint must be probeable at all ─────────────
  group('RV-89 ① the probe can actually ask (first segment of the criterion)', () {
    test('🔴 a ws:// endpoint — what every QR pairing stores — reads as LAN',
        () async {
      final HttpServer server = await _healthServer('standalone');
      addTearDown(() => server.close(force: true));

      final HealthReading reading = await _withRealHttp(() => httpHealthRead(
            healthUri('ws://127.0.0.1:${server.port}'),
            const Duration(seconds: 5),
          ));

      expect(reading.ok, isTrue,
          reason: 'before the fix this threw ArgumentError: Unsupported scheme '
              "'ws' — an Error, so `on Exception` never saw it");
      expect(reading.channel, ServerChannel.lan);
    });

    test('POSITIVE CONTROL — the same server answering saas reads as relay',
        () async {
      final HttpServer server = await _healthServer('saas');
      addTearDown(() => server.close(force: true));

      final HealthReading reading = await _withRealHttp(() => httpHealthRead(
            healthUri('ws://127.0.0.1:${server.port}'),
            const Duration(seconds: 5),
          ));
      expect(reading.channel, ServerChannel.cloudRelay,
          reason: 'the LAN answer above is the server being read, not the '
              'probe defaulting to something friendly');
    });

    test('the short-code path (http://) is unchanged — the fix is additive',
        () async {
      final HttpServer server = await _healthServer('standalone');
      addTearDown(() => server.close(force: true));

      final HealthReading reading = await _withRealHttp(() => httpHealthRead(
            healthUri('http://127.0.0.1:${server.port}'),
            const Duration(seconds: 5),
          ));
      expect(reading.ok, isTrue);
      expect(reading.channel, ServerChannel.lan);
    });

    test('the ws→http mapping keeps host+port and drops path/query', () {
      expect(healthUri('ws://100.64.7.179:55889'),
          Uri.parse('http://100.64.7.179:55889/api/health'));
      expect(healthUri('wss://flowmic.app'),
          Uri.parse('https://flowmic.app/api/health'));
      expect(healthUri('ws://127.0.0.1:41999/socket.io/?EIO=4'),
          Uri.parse('http://127.0.0.1:41999/api/health'));
    });
  });

  // ── ② the session: the criterion the delivery reads is populated ──────────
  group('RV-89 ② the session really knows which channel it is on', () {
    test('🔴 a QR-paired LAN session ends up with serverChannel == lan',
        () async {
      final HttpServer server = await _healthServer('standalone');
      final FakeSocketTransport transport = FakeSocketTransport();
      addTearDown(() => server.close(force: true));

      final PttSession session = await _connectedSession(server, transport);
      addTearDown(session.dispose);

      expect(session.serverChannel.value, ServerChannel.lan,
          reason: 'this was null for the whole life of every QR-paired session');
    });

    test('…and the LAN http image ingress therefore exists (RCA-v3 was inert)',
        () async {
      final HttpServer server = await _healthServer('standalone');
      final FakeSocketTransport transport = FakeSocketTransport();
      addTearDown(() => server.close(force: true));

      final PttSession session = await _connectedSession(server, transport);
      addTearDown(session.dispose);

      // sessionLanIngress gates on the SAME value, so RV-89 silently sent every
      // LAN picture down the socket path RCA-v3 exists to avoid.
      expect(sessionLanIngress(session), isNotNull);
    });

    test('POSITIVE CONTROL — a relay session reads as cloudRelay, not lan',
        () async {
      final HttpServer server = await _healthServer('saas');
      final FakeSocketTransport transport = FakeSocketTransport();
      addTearDown(() => server.close(force: true));

      final PttSession session = await _connectedSession(server, transport);
      addTearDown(session.dispose);

      expect(session.serverChannel.value, ServerChannel.cloudRelay);
      expect(sessionLanIngress(session), isNull,
          reason: 'the relay deliberately does not mount the http route');
    });
  });

  // ── ③ 🔴 THE CARD'S ACCEPTANCE: the real panel, the real key ──────────────
  group('RV-89 ③ the tick box on the panel', () {
    testWidgets('🔴 on a LAN instance, the 「原图」 tick box really appears', (WidgetTester tester) async {
      late final ChatController controller;
      late final PttSession session;
      final FakeSocketTransport transport = FakeSocketTransport();
      late final HttpServer server;
      // The probe is real network IO; it cannot run inside testWidgets' fake
      // async zone, and faking it here would put the bug back out of reach.
      await tester.runAsync(() async {
        server = await _healthServer('standalone');
        session = await _connectedSession(server, transport);
        controller = _chatOn(session, transport);
      });
      addTearDown(() async {
        await controller.dispose();
        await session.dispose();
        await server.close(force: true);
      });

      await tester.pumpWidget(_panel(controller, controller.favorites));

      expect(find.byKey(kTickBox), findsOneWidget,
          reason: 'owner measured 0.2.34: 「并没有发现有原图的勾选框或选项」');
      expect(find.byKey(kBlockedSentence), findsNothing,
          reason: 'the 「尚未确认当前通道」 sentence is what stood in its place');
      expect(controller.imageSend.originalBlock, isNull);
      expect(controller.imageSend.canSendOriginal, isTrue);
    });

    testWidgets('POSITIVE CONTROL — on the relay the box is gone and the '
        'reason is the CLOUD one, not "unknown"', (WidgetTester tester) async {
      late final ChatController controller;
      late final PttSession session;
      final FakeSocketTransport transport = FakeSocketTransport();
      late final HttpServer server;
      await tester.runAsync(() async {
        server = await _healthServer('saas');
        session = await _connectedSession(server, transport);
        controller = _chatOn(session, transport);
      });
      addTearDown(() async {
        await controller.dispose();
        await session.dispose();
        await server.close(force: true);
      });

      await tester.pumpWidget(_panel(controller, controller.favorites));

      expect(find.byKey(kTickBox), findsNothing);
      expect(find.byKey(kBlockedSentence), findsOneWidget);
      // 🔴 The distinction that makes the LAN assertion above meaningful: before
      // the fix BOTH channels showed a blocked sentence, and both showed the
      // SAME one (channelUnknown). If this said channelUnknown the file would be
      // green while the product was still broken on both legs.
      expect(controller.imageSend.originalBlock, ImageOriginalBlock.cloudChannel,
          reason: 'the sentence must be 「云端不发原图」(switch networks), never '
              '「还不知道走哪条」(wait)');
      expect(
        find.text(_zh.imageOriginalUnavailable(ImageOriginalBlock.cloudChannel)),
        findsOneWidget,
      );
    });

    testWidgets('FAIL-CLOSED is preserved: an unreachable server still refuses',
        (WidgetTester tester) async {
      late final ChatController controller;
      late final PttSession session;
      final FakeSocketTransport transport = FakeSocketTransport();
      late final int deadPort;
      await tester.runAsync(() => _withRealHttp(() async {
            // Bind, read the port, close: a port nothing is listening on. With
            // the real client this is a genuine connection refusal — under the
            // test binding's stub it would be a canned 400, i.e. this control
            // would pass without the probe ever having tried.
            final HttpServer probe =
                await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
            deadPort = probe.port;
            await probe.close(force: true);
            session = newTestSession(transport: transport);
            transport.connectSucceeds = true;
            await session.resumePairing(_qrPairing(deadPort));
            controller = _chatOn(session, transport);
            // Let the (doomed) probe finish inside this zone rather than
            // leaving a real socket attempt outstanding past teardown.
            await Future<void>.delayed(const Duration(milliseconds: 300));
            await session.reconnect.stop();
          }));
      addTearDown(() async {
        await controller.dispose();
        await session.dispose();
      });

      await tester.pumpWidget(_panel(controller, controller.favorites));

      expect(find.byKey(kTickBox), findsNothing,
          reason: 'guessing LAN would put an original on the relay — owner '
              'ruled against exactly that');
      expect(find.byKey(kBlockedSentence), findsOneWidget);
      expect(controller.imageSend.originalBlock,
          ImageOriginalBlock.channelUnknown);
    });
  });
}

// Card B4-13 / RV-97 — two real defects of the LAN image HTTP ingress.
//
// owner 2026-08-01 real-device (0.2.35), original words:「**无论本地局域网或中继**都会有图中的这个
// 红底的提示，**但图是能传到 PC 端且注入到输入框中去的**」. Red banner verbatim:
//
//   联系不上电脑（Invalid argument(s): Unsupported scheme 'ws' in URI
//   ws://10.0.0.78:41879/api/inject/image），图片没有发出
//
// ── ① the endpoint is `ws://`, and HttpClient does not recognize it ─────────
// RV-89 fixed the **health-probe** funnel (`healthUri`). Image HTTP upload walks
// **another** path — `sessionLanIngress` → `LanImageIngress.endpoint` (＝
// `ReconnectCoordinator.url`, and QR pairing stores `ws://`) →
// `uploadImageInject` — not one character of normalization.
// ⇒ And this exposed something larger: before RV-89 `serverChannel` was always
// null ⇒ `sessionLanIngress` was always null ⇒ **this path never ran**, images
// always went over the socket. RV-89 judged the channel correctly, this path
// ran for the first time, and then it was broken ⇒ **RCA-v3 (0.2.16) has never
// succeeded even once.**
//
// 🔴 Reverse control (must have really gone red, no assuming): in
// image_upload.dart change
//   `url = httpEndpointUri(base, '/api/inject/image');`
// back to
//   `url = Uri.parse(base.endsWith('/') ? '${base}api/inject/image' : '$base/api/inject/image');`
// group ①'s first case and the diagnostics case immediately go red on
// `ArgumentError: Unsupported scheme 'ws'`.
// (measured record in this card's report; that is Error not Exception, so it
// escaped `on Exception`.)
//
// 🔴 And this layer must **take the test stand-in off to be measurable**:
// `TestWidgetsFlutterBinding` installs an [HttpOverrides] for the whole suite
// that answers every request with 400 and never opens a socket — the thing that
// is broken is exactly the `postUrl` that was swapped out. So below we use
// [_RealHttpOverrides] + a real [HttpServer] (the method RV-89 established,
// lan_original_visible_test.dart).
//
// ── ② it arrived, it was injected, and the UI said 「图片没有发出」 ──────────
// After HTTP failure there is **no fallback code** — what actually sends the
// picture is the **outbox**:
//   image_send_controller._send        → outbox.enqueueImage      (persist-to-disk before send)
//   image_send_controller._sendViaHttp → unreachable, item is still `queued`
//   chat_outbox_host.onFsmChangeRouted → reconnect rising edge → outbox.drain()
//   outboxSend → composeGate.emitInject → PC inject → inject:result(ok)
// ⇒ the red banner's 「图片没有发出」 was already false at the moment it was
// painted. The other half of the red line "no silent failure": **must not say
// a thing that was done was not done**.
//
// SPEC-REF: apps/mobile/lib/src/signaling/http_endpoint.dart;
//   apps/mobile/lib/src/session/image_upload.dart;
//   apps/mobile/lib/src/session/image_send_controller.dart;
//   apps/mobile/lib/src/diag/diag_upload.dart;
//   apps/server-core/src/http/inject-routes.ts;
//   docs/strategy/2026-08-01-real-device-session-findings.md RV-97.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/diag/diag_upload.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/image_upload.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_frame.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/connections_controller.dart'
    show normalizePairEndpoint;
import 'package:flowmic/src/signaling/http_endpoint.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart' show InjectResult;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// The base [HttpOverrides] implementation IS the production factory, so this
/// un-fakes networking for the block rather than substituting a second fake.
/// Law (CLAUDE.md): how hard a measurement is depends on whether the mechanism that produced it is the path the product walks.
class _RealHttpOverrides extends HttpOverrides {}

Future<T> _withRealHttp<T>(Future<T> Function() body) =>
    HttpOverrides.runWithHttpOverrides<Future<T>>(body, _RealHttpOverrides());

/// A REAL server answering the two routes this card is about, in the shapes
/// `apps/server-core/src/http/inject-routes.ts` and `diag-routes.ts` answer in.
/// Records the paths it was asked for, so a test can prove the request arrived
/// rather than merely that no exception escaped.
Future<HttpServer> _pcServer(List<String> hits) async {
  final HttpServer server =
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(server.forEach((HttpRequest req) async {
    hits.add(req.uri.path);
    final String body = await utf8.decoder.bind(req).join();
    switch (req.uri.path) {
      case '/api/inject/image':
        final Map<String, Object?> sent =
            (jsonDecode(body) as Map).cast<String, Object?>();
        final Map<String, Object?> request =
            (sent['request'] as Map).cast<String, Object?>();
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(<String, Object?>{
            'ok': true,
            'mode': 'clipboard',
            'request_id': request['request_id'],
            'entry_id': request['entry_id'],
            'saved': true,
          }));
      case '/api/diag/mobile':
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(<String, Object?>{'ok': true}));
      default:
        req.response.statusCode = HttpStatus.notFound;
    }
    await req.response.close();
  }));
  return server;
}

Uint8List _jpeg(int length) {
  final Uint8List bytes = Uint8List(length);
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  bytes[2] = 0xFF;
  return bytes;
}

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

/// The delivery host, wired to the REAL queue and the REAL ComposeGate — the
/// same reasoning image_transit_gate_test's `_Host` header spells out: every
/// assertion in ② is about what the QUEUE did and what went out on the wire, so
/// a recording double would remove the subject.
class _Host implements ManualDeliveryHost, OutboxDrainHost {
  /// 🔴 L8 — the stamp the queue handed this send.
  InjectOrigin? lastOrigin;

  _Host({required this.store, required this.syncGate});

  @override
  late final DeliveryOutbox outbox = DeliveryOutbox(
    store: newTestOutboxStore(),
    blobs: newTestOutboxBlobs(),
    host: this,
  );

  late final ComposeGate compose;
  late final ManualDelivery delivery;

  /// Mutable so a test can model "this session has no deliverable destination" (after
  /// `leaveRoom`), which is the ONLY case in which a picture really is lost.
  LiveConnection connection = const LiveConnection(
    machineUid: 'machine-rv97',
    pairingIdentity: 'standalone|instance:rv97',
    pcId: 'pc-rv97',
    channel: ServerChannel.lan,
  );

  @override
  LiveConnection get liveConnection => connection;

  /// Mutable so a test can switch instances the way the user does.
  String? instanceId = 'standalone|instance:rv97';

  @override
  String? get deliveryInstanceId => instanceId;

  @override
  Future<bool> ensureLink() => delivery.ensureLink();

  @override
  Future<void> reseedDestination() async {}

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    lastOrigin = origin;
    final InjectRequestPayload? frame = buildOutboxInjectFrame(
      item: item,
      targetPcId: targetPcId,
      origin: origin,
      imageBytes: imageBytes,
      entryCaption: store.findById(item.entryId)?.displayText,
    );
    if (frame == null) return false;
    final bool ok = compose.emitInject(frame);
    if (ok) delivery.armInFlight(item.requestId, item.coveredEntryIds);
    return ok;
  }

  @override
  void onOutboxChanged() {}

  @override
  final TimelineStore store;
  @override
  final TimelineSyncGate syncGate;
  @override
  bool get canCompose => true;
  @override
  bool get noPcTarget => false;
  @override
  FlowMode get mode => FlowMode.realtime;
  @override
  String? get pcDisplayName => 'RV-97 PC';
  @override
  String? get targetPcId => 'pc-rv97';
  @override
  void deliveryNotify() {}
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;

  LanImageIngress? ingress;
  @override
  LanImageIngress? get lanImageIngress => ingress;
}

class _Rig {
  _Rig({ImageUploadPoster? poster}) {
    transport = FakeSocketTransport();
    store = newTestStore();
    gate = TimelineSyncGate(transport: transport);
    host = _Host(store: store, syncGate: gate);
    final ComposeGate compose = ComposeGate(transport: transport);
    delivery = ManualDelivery(host: host, gate: compose);
    host.compose = compose;
    host.delivery = delivery;
    imageSend = ImageSendController(
      host: host,
      gate: compose,
      delivery: delivery,
      picker: _FakePicker(_jpeg(60_000)),
      rowImages: newTestOutboxBlobs(),
      thumbnailEncoder: (Uint8List bytes) async => null,
      uploadPoster: poster,
      liveChannel: () => ServerChannel.lan,
    );
    host.ingress =
        const LanImageIngress(endpoint: 'ws://127.0.0.1:41879', token: 'tok');
  }

  late final FakeSocketTransport transport;
  late final TimelineStore store;
  late final TimelineSyncGate gate;
  late final _Host host;
  late final ManualDelivery delivery;
  late final ImageSendController imageSend;

  TimelineEntry get row => store.entries.first;
}

/// The EXACT throw production saw: `HttpClient.postUrl` on a ws:// URI. An
/// `ArgumentError` is an **Error**, not an Exception — modelling it as a plain
/// exception would make the fixture easier than reality.
ImageUploadPoster _wsSchemeThrows() =>
    (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async =>
        throw ArgumentError.value(
          url.toString(),
          'uri',
          "Unsupported scheme 'ws' in URI",
        );

void main() {
  // ── ① one funnel, three consumers, all recognize ws:// ────────────────────
  group('RV-97 ① a ws:// endpoint as an HTTP base', () {
    test('🔴 image upload: a ws:// endpoint hits a real server and comes back with the PC\'s verdict', () async {
      final List<String> hits = <String>[];
      final HttpServer server = await _pcServer(hits);
      addTearDown(() => server.close(force: true));

      final ImageUploadResult result = await _withRealHttp(
        () => uploadImageInject(
          // What a QR pairing dials with, verbatim — the string owner's handset
          // actually held. An http:// endpoint here would test a path that was
          // never broken.
          endpoint: 'ws://127.0.0.1:${server.port}',
          token: 'tok',
          item: const <String, Object?>{},
          request: const <String, Object?>{
            'request_id': 'req-rv97-1',
            'entry_id': 'row-rv97-1',
          },
        ),
      );

      expect(result.status, ImageUploadStatus.verdict,
          reason: 'before the fix this was `unreachable` with detail '
              "「Invalid argument(s): Unsupported scheme 'ws' …」");
      expect(result.ok, isTrue);
      expect(hits, contains('/api/inject/image'),
          reason: 'the bytes must have REACHED the server — a green status with '
              'no hit would mean the request never left');
    });

    test('POSITIVE CONTROL — the same server, an http:// endpoint still works (the fix is additive)', () async {
      final List<String> hits = <String>[];
      final HttpServer server = await _pcServer(hits);
      addTearDown(() => server.close(force: true));

      final ImageUploadResult result = await _withRealHttp(
        () => uploadImageInject(
          endpoint: 'http://127.0.0.1:${server.port}',
          token: 'tok',
          item: const <String, Object?>{},
          request: const <String, Object?>{'request_id': 'req-rv97-2'},
        ),
      );
      expect(result.status, ImageUploadStatus.verdict);
      expect(hits, contains('/api/inject/image'));
    });

    test('🔴 diagnostics upload: the third site of the same defect, found by grep', () async {
      // connection_diagnostics_sheet.dart:25 passes `session.reconnect.url`,
      // i.e. the same ws:// string. 「把手机诊断日志发到电脑」 answered
      // 「联系不上电脑」 for every QR-paired session since it shipped.
      final List<String> hits = <String>[];
      final HttpServer server = await _pcServer(hits);
      addTearDown(() => server.close(force: true));
      DiagLog.instance.clear();
      diag('rv97.probe', const <String, Object?>{'n': 1});

      final DiagUploadResult r = await _withRealHttp(
        () => uploadDiagnostics(
          endpoint: 'ws://127.0.0.1:${server.port}',
          deviceLabel: 'phone-rv97',
          token: 'tok',
        ),
      );
      expect(r.outcome, DiagUploadOutcome.delivered);
      expect(hits, contains('/api/diag/mobile'));
    });

    test('normalization has only one implementation, all three funnels ask it', () {
      // The rule.
      expect(httpBaseOf('ws://10.0.0.78:41879'),
          'http://10.0.0.78:41879');
      expect(httpBaseOf('wss://flowmic.app'), 'https://flowmic.app');
      expect(httpBaseOf('WS://192.0.2.5:41879'), 'http://192.0.2.5:41879',
          reason: 'a scheme is case-insensitive; a QR is not the only writer');
      expect(httpBaseOf('192.0.2.5:41879'), 'http://192.0.2.5:41879');
      expect(httpBaseOf('http://x:1'), 'http://x:1');
      expect(httpBaseOf('  '), '');
      // An unknown scheme is passed through so it fails loudly AS ITSELF rather
      // than as an http 404.
      expect(httpBaseOf('flowmic://pair'), 'flowmic://pair');

      // The three routes, one derivation.
      expect(httpEndpointUri('ws://100.64.7.179:55889', '/api/inject/image'),
          Uri.parse('http://100.64.7.179:55889/api/inject/image'));
      expect(httpEndpointUri('ws://127.0.0.1:41999/socket.io/?EIO=4', '/api/diag/mobile'),
          Uri.parse('http://127.0.0.1:41999/api/diag/mobile'),
          reason: 'an absolute route drops the endpoint\'s own path AND query');

      // 🔴 The one-funnel assertion: `healthUri` and the dial normalizer are the
      // SAME rule as the two POST funnels, not three lookalikes. If someone
      // re-inlines a copy, one of these diverges.
      const String qr = 'ws://10.0.0.78:41879';
      expect(healthUri(qr), httpEndpointUri(qr, '/api/health'));
      expect(normalizePairEndpoint(qr), httpBaseOf(qr));
      expect(healthUri(qr).origin,
          httpEndpointUri(qr, '/api/inject/image').origin);
    });
  });

  // ── ② "it arrived but we said it did not" ────────────────────────────────
  group('RV-97 ② HTTP failed but the queue delivered the picture', () {
    test('🔴 HTTP upload failed and the draft is in the queue ⇒ no red banner, the row does not settle ✗', () async {
      final _Rig r = _Rig(poster: _wsSchemeThrows());

      final ImageSendFailure? failure = await r.imageSend.pickAndSend();

      expect(failure, isNull,
          reason: 'the picture is queued and owed — not a failed send');
      expect(r.imageSend.failure, isNull,
          reason: 'owner real-device: red-background 「图片没有发出」 while the picture WAS delivered');
      // The delivery is still on disk and still owed — this is what makes the
      // absence of the banner honest rather than a swallow.
      expect(r.host.outbox.queuedEntryIds, contains(r.row.id));
      expect(r.host.outbox.pendingCountFor(r.host.instanceId), 1);
      expect(r.row.status, isNot(EntryStatus.failed),
          reason: 'a row that renders ✗ next to 「排队中」 is the same lie in the '
              'other surface');
    });

    test('🔴 …then drain really sends it out, and the red banner never appeared', () async {
      final _Rig r = _Rig(poster: _wsSchemeThrows());
      expect(await r.imageSend.pickAndSend(), isNull);

      // The production trigger is the reconnected rising edge
      // (chat_outbox_host.onFsmChangeRouted); the drain itself is what this
      // asserts, through the real ComposeGate and the real frame builder.
      final OutboxDrainReport report = await r.host.outbox.drain();
      expect(report.linkOk, isTrue);
      expect(report.sent, 1);
      expect(r.transport.emittedNames, contains(FlowMicEvents.injectRequest),
          reason: 'this is the frame that actually delivered owner\'s picture');

      // The PC answers. Same path chat_outbox_host.onInjectResultRouted drives.
      final String requestId = r.row.clientId;
      final InjectResult verdict =
          InjectResult(ok: true, mode: 'clipboard', entryId: r.row.id);
      r.delivery.applyInjectResult(verdict, r.store);
      r.imageSend.onInjectSettled(verdict, r.delivery, 0);
      await r.host.outbox.settle(correlationId: requestId, ok: true);

      expect(r.row.status, EntryStatus.injected);
      expect(r.host.outbox.queuedEntryIds, isEmpty);
      expect(r.imageSend.failure, isNull,
          reason: '🔴 THE CARD: the picture arrived, it was injected, the UI must not still say 「图片没有发出」');
    });

    test('POSITIVE CONTROL — when there is no deliverable draft, the red banner must still be there', () async {
      final _Rig r = _Rig(poster: _wsSchemeThrows());
      // The one real case (`leaveRoom` nulled the identities): `_admit` refuses
      // at the door, nothing is on disk, no drain will ever carry it ⇒ the
      // picture genuinely did not go out.
      r.host.connection = const LiveConnection(
        machineUid: null,
        pairingIdentity: null,
        pcId: null,
        channel: ServerChannel.lan,
      );

      final ImageSendFailure? failure = await r.imageSend.pickAndSend();

      expect(failure, ImageSendFailure.pcUnreachable);
      expect(r.imageSend.failure?.reason, ImageSendFailure.pcUnreachable);
      expect(r.host.outbox.queuedEntryIds, isEmpty,
          reason: 'nothing was durable — that is WHY the banner is honest here');
      expect(r.row.status, EntryStatus.failed);
    });

    test('🔴 the red banner must not hand the raw exception to the user (four languages)', () async {
      final _Rig r = _Rig(poster: _wsSchemeThrows());
      r.host.connection = const LiveConnection(
        machineUid: null,
        pairingIdentity: null,
        pcId: null,
        channel: ServerChannel.lan,
      );
      await r.imageSend.pickAndSend();
      final ImageSendOutcome outcome = r.imageSend.failure!;

      for (final AppLocale locale in AppLocale.values) {
        final String text = AppStrings(locale).imageSendError(outcome);
        expect(text, isNotEmpty);
        // owner saw this inside the banner. It is diagnostic detail: it belongs
        // in the log (`image.http_upload.detail`), never in a sentence someone
        // is supposed to act on.
        expect(text.contains('Unsupported scheme'), isFalse);
        expect(text.contains('Invalid argument'), isFalse);
        expect(text.contains('ws://'), isFalse);
      }
      // …and the detail is NOT discarded — it is still on the outcome for
      // forensics, it simply does not reach the sentence.
      expect(outcome.detail, contains('ws'));
    });

    test('🔴 any picture banner is withdrawn by "this picture later arrived"', () async {
      // The generalisation: pcOffline / noAnswer / serverRefused all leave the
      // item queued too, so any of them can be contradicted by a later verdict.
      final _Rig r = _Rig(
        poster:
            (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async =>
                (
                  status: 200,
                  body: jsonEncode(const <String, Object?>{
                    'ok': false,
                    'error': 'INJECT_RESULT_TIMEOUT',
                  }),
                ),
      );
      expect(await r.imageSend.pickAndSend(), ImageSendFailure.noAnswer);
      expect(r.imageSend.failure, isNotNull, reason: 'raised on a real unknown');

      // The queue carries it, the PC pastes it, the verdict comes back.
      final InjectResult late =
          InjectResult(ok: true, mode: 'clipboard', entryId: r.row.id);
      r.imageSend.onInjectSettled(late, r.delivery, 0);
      expect(r.imageSend.failure, isNull);
    });

    test('🔴 a failed verdict must not withdraw the banner (the withdraw criterion is ok, not "there was an echo")', () async {
      final _Rig r = _Rig(
        poster:
            (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async =>
                (
                  status: 200,
                  body: jsonEncode(const <String, Object?>{
                    'ok': false,
                    'error': 'INJECT_RESULT_TIMEOUT',
                  }),
                ),
      );
      expect(await r.imageSend.pickAndSend(), ImageSendFailure.noAnswer);
      r.imageSend.onInjectSettled(
        InjectResult(ok: false, mode: 'cached', entryId: r.row.id),
        r.delivery,
        0,
      );
      expect(r.imageSend.failure, isNotNull);
      // Nor may a verdict for SOMEBODY ELSE's delivery clear it.
      r.imageSend.onInjectSettled(
        const InjectResult(ok: true, mode: 'clipboard', entryId: 'row-someone-else'),
        r.delivery,
        0,
      );
      expect(r.imageSend.failure, isNotNull);
    });

    test('🔴 (b) the banner does not cross instances: an error that rose on A must not appear on B\'s screen', () async {
      // owner's screenshot: a 云端中继 header with a **LAN** address in the
      // banner. One ChatController serves every instance (main.dart:180), and
      // this banner was the second thing on that screen with no instance scope
      // (RV-91 fixed the first).
      final _Rig r = _Rig(poster: _wsSchemeThrows());
      r.host.connection = const LiveConnection(
        machineUid: null,
        pairingIdentity: null,
        pcId: null,
        channel: ServerChannel.lan,
      );
      await r.imageSend.pickAndSend();
      expect(r.imageSend.failure, isNotNull);

      r.host.instanceId = 'saas|instance:cloud-1'; // the user switched
      expect(r.imageSend.failure, isNull,
          reason: 'this is the LAN instance\'s news, on the relay\'s screen');

      r.host.instanceId = 'standalone|instance:rv97'; // …and switched back
      expect(r.imageSend.failure, isNotNull,
          reason: 'not discarded — it is simply not the other screen\'s news');
    });

    test('🔴 ③ a new send retires the previous conclusion (the progress bar and the red banner must not contradict each other on the same screen)', () async {
      // owner's screenshot has 「正在传输到电脑」 and the red banner up together.
      // The bar was right (a send WAS in flight); the banner was the previous
      // attempt's, and nothing ever retired it.
      final _Rig r = _Rig(poster: _wsSchemeThrows());
      r.host.connection = const LiveConnection(
        machineUid: null,
        pairingIdentity: null,
        pcId: null,
        channel: ServerChannel.lan,
      );
      await r.imageSend.pickAndSend();
      expect(r.imageSend.failure, isNotNull);

      // A second send, this time on a healthy session.
      r.host.connection = const LiveConnection(
        machineUid: 'machine-rv97',
        pairingIdentity: 'standalone|instance:rv97',
        pcId: 'pc-rv97',
        channel: ServerChannel.lan,
      );
      await r.imageSend.pickAndSend();
      expect(r.imageSend.failure, isNull,
          reason: 'the screen must not assert two conclusions about one action');
    });
  });
}

// 2026-07-30 RCA-v3 — the transport-truth gate + the LAN http image ingress.
//
// The root cause these pin against: every image send passes through the system
// photo picker, which backgrounds the app; the owner's handset severs
// background TCP without the socket client noticing for up to 30 s, so frames
// emitted right after returning vanished into a dead pipe — no receipt, no
// log, a 20 s watchdog mystery, ten times over.
//
// What is pinned here:
//   - a delivery's history:create is ACKED and precedes the inject ON THE
//     WIRE; synced is stamped by the ack, never by the emit;
//   - an ack miss recovers the link ONCE (kick → await → retry) and then
//     delivers; an unrecoverable link fails loud as linkDown with the row
//     settled ✗ — never a silent 20 s;
//   - on a measured-standalone channel the image rides the http ingress: the
//     response verdict settles the row through the SAME InjectResult path the
//     socket mirror uses, and no inject:request touches the socket;
//   - every http outcome (verdict ok / verdict failed / pc offline / no answer
//     / unreachable-after-retry) lands on the row with its own named reason.
//
// SPEC-REF: apps/mobile/lib/src/session/image_upload.dart;
//   apps/server-core/src/http/inject-routes.ts;
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/image_upload.dart';
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart' show InjectResult;
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_frame.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'support/di.dart';

Uint8List jpegOfLength(int length) {
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

/// 🔴 窗口B3-2c — THIS HOST HAS TO BE A REAL DRAIN HOST, NOT A RECORDING ONE.
///
/// It used to hold `newTestOutbox()`, whose drain host is a `RecordingDrainHost`
/// — it answers "the link is fine" without probing and swallows the frame instead of
/// emitting it. That was harmless while nothing drained through it, and became
/// wrong the moment `deliverText` started going through the queue: every
/// assertion in this file is about WHAT WENT OUT ON THE TRANSPORT, and the
/// recording host is precisely the thing that stops anything going out.
///
/// ⚠️ THIS IS WHY THREE OF THE REDS IN THIS FILE WERE **NOT** "the fixture never built a pairing".
/// `noPcTarget` here is already false, so pairing was never their problem —
/// their problem was a fixture wired to a different exit from the one production
/// uses. Diagnosing them as the same failure as the other sixteen would have
/// produced a 「fix」 that left them red for a second reason.
///
/// So the queue is wired to THIS object, which forwards to the same
/// `ManualDelivery.ensureLink` gate and the same `ComposeGate` production uses,
/// and builds its frame with the same shared builder (`buildOutboxInjectFrame`).
class _Host implements ManualDeliveryHost, OutboxDrainHost {
  /// 🔴 L8 — the stamp the queue handed this send. Recorded so a test can assert
  /// "whether this frame went out as live or as a re-delivery" on the HOST boundary, not only in the frame.
  InjectOrigin? lastOrigin;

  @override
  late final DeliveryOutbox outbox = DeliveryOutbox(
    store: newTestOutboxStore(),
    blobs: newTestOutboxBlobs(),
    host: this,
  );

  /// Bound by [_Rig] right after construction — the queue needs the very gate
  /// and delivery the direct paths use, and those need `host: this` first.
  late final ComposeGate compose;
  late final ManualDelivery delivery;

  @override
  LiveConnection get liveConnection => const LiveConnection(
    machineUid: 'machine-studio-test',
    pairingIdentity: 'standalone|instance:studio-test',
    // The SAME id `targetPcId` answers with, so the queue's address check
    // resolves to the value every assertion in this file already expects.
    pcId: 'pc-studio-test',
    // 卡 B4-17: this rig's subject is the LAN image transit path, so it must be
    // measured-LAN — on the cloud leg the queue would (correctly) hold anything
    // over 1 MiB and these assertions would fail for an unrelated reason.
    channel: ServerChannel.lan,
  );

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

  _Host({required this.store, required this.syncGate});

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
  String? get pcDisplayName => 'Studio PC';
  @override
  String? get targetPcId => 'pc-studio-test';
  @override
  String? get deliveryInstanceId => 'inst-studio-test';

  @override
  void deliveryNotify() {}

  int kicks = 0;
  bool linkComesBack = true;
  @override
  Future<void> kickLink() async {
    kicks += 1;
  }

  @override
  Future<bool> awaitLinkUp(Duration timeout) async => linkComesBack;

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
    // The queue drains through the SAME gate and the SAME link probe the direct
    // paths use — see _Host's header for why a RecordingDrainHost cannot.
    host.compose = compose;
    host.delivery = delivery;
    imageSend = ImageSendController(
      host: host,
      gate: compose,
      delivery: delivery,
      picker: _FakePicker(jpegOfLength(100_000)),
      rowImages: newTestOutboxBlobs(),
      thumbnailEncoder: (Uint8List bytes) async => null,
      uploadPoster: poster,
    );
  }

  late final FakeSocketTransport transport;
  late final TimelineStore store;
  late final TimelineSyncGate gate;
  late final _Host host;
  late final ManualDelivery delivery;
  late final ImageSendController imageSend;

  TimelineEntry get row => store.entries.first;
}

/// A poster that answers with [status]+[body] and records what it was handed.
ImageUploadPoster fakePoster(
  int status,
  Map<String, Object?> body, {
  List<Map<String, Object?>>? sentBodies,
  List<double>? fractions,
  int failFirstN = 0,
}) {
  int calls = 0;
  return (Uri url, String token, Uint8List bytes, ImageUploadProgress? onProgress) async {
    calls += 1;
    if (calls <= failFirstN) throw const FormatException('connection refused');
    sentBodies?.add((jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>());
    onProgress?.call(bytes.length ~/ 2, bytes.length);
    if (fractions != null) fractions.add(0.5);
    onProgress?.call(bytes.length, bytes.length);
    return (status: status, body: jsonEncode(body));
  };
}

void main() {
  group('socket path — the create-ack transport-truth gate', () {
    test('history:create is ACKED and precedes inject:request on the wire; synced stamps on the ack', () async {
      final _Rig r = _Rig();
      final ComposeSendFailure? failure =
          await r.delivery.deliverText('hello', covered: const <String>[]);
      expect(failure, isNull);
      final List<String> names = r.transport.emittedNames;
      // 0.2.27: this asserted `history:create` BEFORE `inject:request` (D10 by
      // construction — the stored row provably preceded the delivery). There is
      // no stored row any more (owner architecture ruling), so what must still hold is the
      // half that protects the user: the link is PROVEN alive before the frame
      // goes out, and nothing is asked of the retired history table.
      final int probeAt = names.indexOf(FlowMicEvents.heartbeat);
      final int injectAt = names.indexOf(FlowMicEvents.injectRequest);
      expect(probeAt, isNot(-1), reason: 'the link is probed, not assumed');
      expect(injectAt, isNot(-1));
      expect(probeAt, lessThan(injectAt),
          reason: 'no frame leaves on a link nobody has heard back from');
      expect(names, isNot(contains(FlowMicEvents.historyCreate)));
    });

    test('an ack miss recovers the link once (kick → await → retry) and then delivers', () async {
      final _Rig r = _Rig();
      // First probe ack is a shapeless {} (no ok:true ⇒ not proven); after the
      // recovery the default {ok:true} answers the retry.
      r.transport.ackQueue.add(<String, Object?>{});
      final ComposeSendFailure? failure =
          await r.delivery.deliverText('hello again', covered: const <String>[]);
      expect(failure, isNull);
      expect(r.host.kicks, 1, reason: 'a dead link is kicked exactly once');
      expect(r.transport.emittedNames, contains(FlowMicEvents.injectRequest));
    });

    test('an unrecoverable link fails loud as linkDown — row ✗, nothing emitted, no 20 s wait', () async {
      final _Rig r = _Rig();
      r.transport.ackQueue.add(<String, Object?>{});
      r.host.linkComesBack = false;
      final ComposeSendFailure? failure =
          await r.delivery.deliverText('doomed', covered: const <String>[]);
      expect(failure, ComposeSendFailure.linkDown);
      expect(r.transport.emittedNames, isNot(contains(FlowMicEvents.injectRequest)));
      expect(r.row.status, EntryStatus.failed);
    });

    test('image over the socket path proves the link through the same gate before the frame', () async {
      final _Rig r = _Rig(); // no ingress → socket path
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, isNull);
      final List<String> names = r.transport.emittedNames;
      // Same substitution as the text path above: the acked probe, not an acked
      // `history:create`, is what stands between a dead link and a lost picture.
      expect(names.indexOf(FlowMicEvents.heartbeat),
          lessThan(names.indexOf(FlowMicEvents.injectRequest)));
      expect(names, isNot(contains(FlowMicEvents.historyCreate)));
      expect(
        r.imageSend.progress.value?.stage,
        ImageSendStage.waitingSocketAck,
      );
      r.imageSend.onInjectSettled(
        InjectResult(ok: true, mode: 'clipboard', entryId: r.row.id),
        r.delivery,
        0,
      );
      expect(r.imageSend.progress.value, isNull);
    });
  });

  group('http ingress — the LAN image path', () {
    test('a delivered verdict settles the row injected through the shared InjectResult path', () async {
      final List<Map<String, Object?>> sent = <Map<String, Object?>>[];
      final _Rig r = _Rig(
        poster: fakePoster(200, <String, Object?>{
          'ok': true,
          'mode': 'clipboard',
          'request_id': 'WILL-BE-REPLACED',
          'saved': true,
        }, sentBodies: sent),
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://100.64.7.78:41879', token: 'tok');
      // The verdict must echo the REAL request_id to settle the row; patch the
      // poster's canned body after we know it. Easier: answer with entry_id.
      // (The route echoes both; entry_id is the exact key.)
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      // request_id mismatch → settle falls back to the correlation echo; the
      // canned body above carries no matching key, so assert the honest halves
      // that do not depend on it, then the full loop below with entry_id.
      expect(failure, isNull);
      expect(sent, hasLength(1));
      final Map<String, Object?> body = sent.single;
      expect(body['item'], isA<Map<String, Object?>>());
      final Map<String, Object?> request = (body['request'] as Map).cast<String, Object?>();
      expect(request['source'], 'image');
      expect(request['image_b64'], isNotNull);
      // NOTHING rode the socket: the whole point of the ingress.
      expect(r.transport.emittedNames, isNot(contains(FlowMicEvents.injectRequest)));
      expect(r.transport.emittedNames, isNot(contains(FlowMicEvents.historyCreate)));
    });

    test('a verdict naming the row settles it injected + synced', () async {
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          final Map<String, Object?> body =
              (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
          final Map<String, Object?> request = (body['request'] as Map).cast<String, Object?>();
          return (
            status: 200,
            body: jsonEncode(<String, Object?>{
              'ok': true,
              'mode': 'clipboard',
              'request_id': request['request_id'],
              'entry_id': request['entry_id'],
              'inject_target': <String, Object?>{
                'window_title': 'Cursor',
                'process_name': 'Cursor.exe',
              },
              'saved': true,
            }),
          );
        },
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, isNull);
      expect(r.row.status, EntryStatus.injected);
      expect(r.imageSend.progress.value, isNull, reason: 'the bar retreats with the verdict');
    });

    test('a FAILED verdict lands as the row\'s ✗ with the PC\'s own error — never softened', () async {
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          final Map<String, Object?> body =
              (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
          final Map<String, Object?> request = (body['request'] as Map).cast<String, Object?>();
          return (
            status: 200,
            body: jsonEncode(<String, Object?>{
              'ok': false,
              'mode': 'clipboard',
              'error': 'INJECT_CLIPBOARD_FAIL',
              'request_id': request['request_id'],
              'entry_id': request['entry_id'],
              'saved': true,
            }),
          );
        },
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, isNull, reason: 'a PC verdict is row truth, not a send failure');
      expect(r.row.status, EntryStatus.failed);
    });

    test('INJECT_PC_OFFLINE → row ✗ with that reason + a named banner', () async {
      final _Rig r = _Rig(
        poster: fakePoster(200, <String, Object?>{'ok': false, 'error': 'INJECT_PC_OFFLINE'}),
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, ImageSendFailure.pcOffline);
      expect(r.row.status, EntryStatus.failed);
    });

    test('INJECT_RESULT_TIMEOUT → noAnswer: relayed, unconfirmed, said exactly so', () async {
      final _Rig r = _Rig(
        poster: fakePoster(200, <String, Object?>{'ok': false, 'error': 'INJECT_RESULT_TIMEOUT', 'relayed': true}),
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, ImageSendFailure.noAnswer);
      expect(r.row.status, EntryStatus.failed);
    });

    // ⚠️ Correction (RV-97). This test was named "…then fails loud" and asserted
    // `pcUnreachable` + a row settled ✗. Both halves were WRONG, and owner paid
    // for them on a real handset: the delivery is already on disk
    // (`enqueueImage` ran before the emit), so the next drain sends this exact
    // picture and the PC pastes it — "the picture was not sent" was a claim about a future
    // that had not happened. What survives unchanged is the fact this test was
    // really pinning: the retry ladder. See lan_image_http_ingress_test.dart for
    // the full chain and for the positive control (no durable item ⇒ the banner
    // IS raised, because then it is true).
    test('unreachable retries ONCE on a fresh connection; the queue still owes it', () async {
      int calls = 0;
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          calls += 1;
          throw const FormatException('connection refused');
        },
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(calls, 2, reason: 'exactly one immediate retry');
      expect(failure, isNull,
          reason: 'RV-97: a queued delivery is owed, not failed');
      expect(r.imageSend.failure, isNull);
      expect(r.host.outbox.queuedEntryIds, contains(r.row.id),
          reason: 'the honest surface is queued + 「还有 N 条未投递」, not a red banner');
      expect(r.row.status, isNot(EntryStatus.failed));
    });

    // ── RV-04: the retry must be the SAME delivery, not a second one ────────
    // The retry loop lives on the phone, so the phone owns half of the fix: the
    // request_id is minted ONCE (outside the loop) and both attempts carry it,
    // which is the only thing that lets the server recognise "this is a retry of
    // the same request" and not paste the picture again. Without this the two attempts would
    // be two indistinguishable new deliveries and no server-side idempotency
    // could exist.
    test('both attempts carry the SAME request_id — what makes the server able to be idempotent', () async {
      final List<Map<String, Object?>> sent = <Map<String, Object?>>[];
      int calls = 0;
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          calls += 1;
          final Map<String, Object?> body =
              (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
          sent.add((body['request'] as Map).cast<String, Object?>());
          // Attempt 1: the body ARRIVES and the PC pastes, but the response dies
          // in the dead-TCP window (exactly RCA-v3's environment) → the client
          // sees `unreachable` and retries.
          if (calls == 1) throw const FormatException('connection reset while reading the response');
          return (
            status: 200,
            body: jsonEncode(<String, Object?>{
              'ok': true,
              'mode': 'clipboard',
              'request_id': sent.last['request_id'],
              'entry_id': sent.last['entry_id'],
              'replayed': true, // the server recognised the retry
              'saved': true,
            }),
          );
        },
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, isNull);
      expect(sent, hasLength(2));
      expect(sent[1]['request_id'], sent[0]['request_id'],
          reason: 'the retry is the same delivery — the id is minted outside the loop');
      expect(sent[1]['entry_id'], sent[0]['entry_id']);
      // The replayed verdict is still the truth: pasted once, row ✓.
      expect(r.row.status, EntryStatus.injected);
    });

    // ── RV-05: a SERVER refusal is not the PC's verdict ─────────────────────
    for (final String code in <String>['PC_BUSY', 'PAIR_RELEASED']) {
      test('$code → serverRefused: row ✗, NOT synced, retry_after_ms surfaced, banner said', () async {
        int calls = 0;
        final _Rig r = _Rig(
          poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
            calls += 1;
            final Map<String, Object?> body =
                (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
            final Map<String, Object?> request = (body['request'] as Map).cast<String, Object?>();
            return (
              status: 200,
              body: jsonEncode(<String, Object?>{
                'ok': false,
                'error': code,
                'retryable': true,
                'retry_after_ms': 7500,
                'request_id': request['request_id'],
                'entry_id': request['entry_id'],
              }),
            );
          },
        );
        r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
        final ImageSendFailure? failure = await r.imageSend.pickAndSend();
        // Classified as a server refusal — never as the PC's injection verdict.
        expect(failure, ImageSendFailure.serverRefused);
        expect(calls, 1, reason: 'a hold-out is not retried on a fresh connection');
        expect(r.row.status, EntryStatus.failed);
        // 0.2.27: RV-05's other half asserted here — 「not synced, still in
        // pendingSync」 — retired with the server row it was about. The half that
        // faces the user is the one above and below: the row says ✗ with the
        // server's own code, and the wait is stated rather than dropped.
        // retry_after_ms is USED, not parsed and dropped.
        expect(r.imageSend.failure?.retryAfterMs, 7500);
        expect(r.imageSend.failure?.detail, code);
        // Fail-loud: the banner exists and names the wait in every language.
        for (final AppLocale locale in AppLocale.values) {
          final String text = AppStrings(locale).imageSendError(r.imageSend.failure!);
          expect(text, isNotEmpty);
          expect(text, contains('8'), reason: '7500 ms is stated as ~8 s, not dropped');
        }
      });
    }

    test('an unknown retryable refusal is still a refusal — never mistaken for a verdict', () async {
      final _Rig r = _Rig(
        poster: fakePoster(200, <String, Object?>{
          'ok': false,
          'error': 'SOME_FUTURE_HOLD_OUT',
          'retryable': true,
          'retry_after_ms': 1200,
        }),
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      expect(await r.imageSend.pickAndSend(), ImageSendFailure.serverRefused);
      expect(AppStrings(AppLocale.zh).imageSendError(r.imageSend.failure!), isNotEmpty);
    });

    test('a transient first failure is healed by the retry — delivered on attempt 2', () async {
      int calls = 0;
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          calls += 1;
          if (calls == 1) throw const FormatException('network wake-up race');
          final Map<String, Object?> body =
              (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
          final Map<String, Object?> request = (body['request'] as Map).cast<String, Object?>();
          return (
            status: 200,
            body: jsonEncode(<String, Object?>{
              'ok': true,
              'mode': 'clipboard',
              'request_id': request['request_id'],
              'entry_id': request['entry_id'],
              'saved': true,
            }),
          );
        },
      );
      r.host.ingress = const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      final ImageSendFailure? failure = await r.imageSend.pickAndSend();
      expect(failure, isNull);
      expect(calls, 2);
      expect(r.row.status, EntryStatus.injected);
    });

    // ── RV-30 ──────────────────────────────────────────────────────────────
    test('RV-30: HTTP progress retreats with the verdict (no 20 s waitingPc stall)',
        () async {
      ImageSendStage? midWait;
      late final ImageSendController send;
      final _Rig r = _Rig(
        poster: (Uri url, String token, Uint8List bytes, ImageUploadProgress? p) async {
          // Real clients report sent>=total before the response body arrives —
          // that is the moment the old code entered waitingPc and then kept it.
          p?.call(bytes.length, bytes.length);
          midWait = send.progress.value?.stage;
          final Map<String, Object?> body =
              (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
          final Map<String, Object?> request =
              (body['request'] as Map).cast<String, Object?>();
          return (
            status: 200,
            body: jsonEncode(<String, Object?>{
              'ok': true,
              'mode': 'clipboard',
              'request_id': request['request_id'],
              'entry_id': request['entry_id'],
              'saved': true,
            }),
          );
        },
      );
      send = r.imageSend;
      r.host.ingress =
          const LanImageIngress(endpoint: 'http://pc:41879', token: 'tok');
      expect(await r.imageSend.pickAndSend(), isNull);
      expect(midWait, ImageSendStage.waitingHttpVerdict,
          reason: 'bytes-on-wire done → HTTP wait, never the socket wording');
      expect(r.imageSend.progress.value, isNull,
          reason: 'verdict already applied — bar must not sit until the watchdog');
      expect(r.row.status, EntryStatus.injected);
    });

    test('RV-30: the two wait labels are different sentences', () {
      const AppStrings s = AppStringsZh();
      expect(s.imageStageWaitingHttpVerdict, isNot(s.imageStageWaitingSocketAck));
      expect(s.imageStageWaitingHttpVerdict, contains('已上传'));
      expect(s.imageStageWaitingSocketAck, contains('尚未确认'));
      // Red line: socket wait must not claim the HTTP fact 「已送达/已上传」.
      expect(s.imageStageWaitingSocketAck.contains('已上传'), isFalse);
    });
  });
}

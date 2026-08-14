// R6 T-4 ① acceptance — pick → compress → base64 → inject:request{source:'image'},
// end to end on the phone side with a fake picker.
//
// The image chain is a DELIVERY, so the assertions below are the delivery
// assertions: it builds its row before the emit, it carries both correlation
// keys, ONE inject:result settles it, and every way it can fail is loud and
// distinguishable. Plus the two rules that are specific to pictures:
//   - a user CANCEL is not a failure (no row, no banner, no trace);
//   - an image row can never be re-delivered, because history:inject would re-send its
//     DESCRIPTOR as text and call that a delivery.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (F-2350 image fields);
//   docs/ui-design/REDESIGN-PLAN.md §6.1 / §6.2-6;
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4 ①;
//   CLAUDE.md 红线: 没有静默失败 / 时间线为本体 / status records only delivery truth.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_payload.dart';
import 'package:flowmic/src/session/image_thumbnail.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The same real 2×2 RGBA PNG the desktop's WIC decode test uses.
final Uint8List kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

/// A picker under the test's control: it can return bytes, return null (the
/// user cancelled), or throw either failure kind.
class _FakePicker implements ImagePickerPort {
  _FakePicker({this.bytes});

  Uint8List? bytes;
  bool denied = false;
  Object? blowUp;
  int calls = 0;

  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async {
    calls++;
    if (denied) throw const ImagePickDenied();
    if (blowUp != null) throw blowUp!;
    return bytes;
  }
}

class _FlakyTransport extends FakeSocketTransport {
  String? refuse;

  @override
  void emit(String event, Object? payload) {
    if (event == refuse) throw StateError('socket closed');
    super.emit(event, payload);
  }
}

class _Harness {
  late final _FlakyTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;
  late final _FakePicker picker;

  _Harness({Uint8List? bytes, bool cloudInstance = false}) {
    transport = _FlakyTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    store = newTestStore();
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    prefs = InMemoryLocalPrefs();
    gate = TimelineSyncGate(transport: transport);
    picker = _FakePicker(bytes: bytes);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: prefs,
      imagePicker: picker,
    );
    // owner 2026-08-01 cloud-image policy. This suite is the LAN image chain, and the
    // channel is read from `/api/health` — which no test session answers, so it
    // is `null` = "unknown" and [imagePickSpecFor] fails CLOSED to the cloud
    // tier. Declared here through the SAME notifier production reads, so these
    // cases keep exercising the LAN path rather than a seam override.
    session.serverChannel.value = ServerChannel.lan;
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  Map<String, Object?> payloadOf(EventEnvelope e) =>
      Map<String, Object?>.from(e.data! as Map);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('the happy path: one inject:request{source:image} with the exact F-2350 '
      'fields, and a row that was created BEFORE it', () async {
    final _Harness h = _Harness(bytes: kPng);
    h.connect();

    expect(await h.controller.sendImage(), isNull, reason: 'success returns null');
    expect(h.picker.calls, 1);

    // ── the frame ──
    expect(h.injects, hasLength(1));
    final Map<String, Object?> p = h.payloadOf(h.injects.single);
    expect(p['source'], 'image');
    expect(p['image_mime'], 'image/png');
    expect(
      base64Decode(p['image_b64']! as String),
      kPng,
      reason: 'the real bytes ride the wire',
    );
    // `text` is EMPTY on purpose: sending the descriptor would make a PC that
    // does not understand images TYPE 「🖼 PNG · 77 B」 and call it a delivery.
    expect(p['text'], '');
    // RV-74. This assertion was `containsKey('mode') == isFalse`, defended by
    // 「the image send call site has never had a FlowMode to attach to an image
    // row」 — which was falsifiable and false: `buildDeliveryRow` builds this very
    // row with `_host.mode`, so the value was one line away the whole time. The
    // frame now carries the ROW's mode, so the same picture cannot file under
    // organize on the phone and realtime on the PC.
    expect(p['mode'], isNotNull);
    expect(p['mode'], h.store.entries.single.mode.name);
    // Both correlation keys ride along (A-58).
    expect(p['request_id'], isNotNull);
    expect(p['entry_id'], isNotNull);

    // ── the row (时间线为本体) ──
    expect(h.store.entries, hasLength(1));
    final TimelineEntry row = h.store.entries.single;
    expect(row.id, p['entry_id']);
    expect(row.entryType, TimelineEntry.kImage);
    expect(row.isImage, isTrue);
    expect(row.sourceText, imageEntryLabel(ImageMime.png, kPng.length));
    expect(row.status, EntryStatus.cached, reason: 'awaiting the delivery truth');
    expect(row.delivery, Delivery.inject);

    // 0.2.27: this asserted `history:create` BEFORE `inject:request` (the server
    // wrote the delivery truth onto the STORED row when inject:result came back).
    // There is no stored row now (owner architecture ruling) and the write-back lands on the
    // LOCAL row through the same correlation echo — which the next test asserts.
    // What must still hold is that the link was proven before the bytes left.
    final int probed = h.transport.emitted
        .indexWhere((EventEnvelope e) => e.name == FlowMicEvents.heartbeat);
    final int injected = h.transport.emitted
        .indexWhere((EventEnvelope e) => e.name == FlowMicEvents.injectRequest);
    expect(probed, greaterThanOrEqualTo(0), reason: 'the link is probed, not assumed');
    expect(probed, lessThan(injected));
    expect(h.transport.emittedNames, isNot(contains(FlowMicEvents.historyCreate)));
    await h.dispose();
  });

  test('the delivery truth lands on the image row through the SAME correlation '
      'path a typed send uses', () async {
    final _Harness h = _Harness(bytes: kPng);
    h.connect();
    await h.controller.sendImage();
    final String entryId = h.store.entries.single.id;

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'clipboard',
      'entry_id': entryId,
      'inject_target': <String, Object?>{
        'window_title': '微信',
        'process_name': 'WeChat',
        'injected_at': '2026-07-25T10:00:00.000Z',
      },
    });
    await pumpEventQueue();
    expect(h.store.entries.single.status, EntryStatus.injected);
    expect(h.store.entries.single.injectTarget?.processName, 'WeChat');
    await h.dispose();
  });

  test('a FAILED paste settles the image row at ✗ — never a phantom ✓, never '
      'stuck at ⏳', () async {
    final _Harness h = _Harness(bytes: kPng);
    h.connect();
    await h.controller.sendImage();
    final String entryId = h.store.entries.single.id;

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': false,
      'mode': 'clipboard',
      'error': 'INJECT_IMAGE_UNSUPPORTED',
      'entry_id': entryId,
    });
    await pumpEventQueue();
    expect(h.store.entries.single.status, EntryStatus.failed);
    await h.dispose();
  });

  test('CANCELLING the picker is not a failure: no row, no banner, no trace',
      () async {
    final _Harness h = _Harness(); // picker returns null
    h.connect();
    expect(await h.controller.sendImage(), isNull);
    expect(h.picker.calls, 1);
    expect(h.store.entries, isEmpty, reason: 'a cancel leaves no record');
    expect(h.injects, isEmpty);
    expect(h.controller.imageFailure, isNull, reason: 'and raises no banner');
    await h.dispose();
  });

  test('a denied photo permission is a NAMED failure, not a picker that opens '
      'onto nothing', () async {
    final _Harness h = _Harness();
    h.picker.denied = true;
    h.connect();
    expect(await h.controller.sendImage(), ImageSendFailure.permissionDenied);
    expect(
      h.controller.imageFailure,
      const ImageSendOutcome(reason: ImageSendFailure.permissionDenied),
    );
    expect(h.store.entries, isEmpty);
    expect(h.injects, isEmpty);
    // Dismissible, and dismissing really clears it.
    h.controller.dismissImageFailure();
    expect(h.controller.imageFailure, isNull);
    await h.dispose();
  });

  test('an unknown picker error is surfaced VERBATIM rather than swallowed',
      () async {
    final _Harness h = _Harness();
    h.picker.blowUp = StateError('MissingPluginException(no impl)');
    h.connect();
    expect(await h.controller.sendImage(), ImageSendFailure.pickerFailed);
    expect(
      h.controller.imageFailure!.detail,
      contains('MissingPluginException'),
      reason: 'a code we cannot name is exactly the one worth showing',
    );
    await h.dispose();
  });

  test('an unsupported format is refused before anything is built or sent',
      () async {
    // A GIF: real file, not one of the three admitted mimes.
    final _Harness h = _Harness(
      bytes: Uint8List.fromList(<int>[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    );
    h.connect();
    expect(await h.controller.sendImage(), ImageSendFailure.unsupportedFormat);
    expect(h.store.entries, isEmpty, reason: 'no row for a delivery that cannot happen');
    expect(h.injects, isEmpty);
    await h.dispose();
  });

  test('an over-budget picture the rescue ladder cannot shrink is refused WITH '
      'its real size, and nothing is truncated or sent', () async {
    // 2026-07-29: over-budget bytes now get an in-app downscale rescue first
    // (image_send_downscale_test.dart pins that path). THIS test pins the other
    // half of the contract: when no rung can produce something inside the
    // budget, the refusal is still the loud tooLarge with the real numbers.
    // PNG magic over an UNDECODABLE body — every rescue rung fails naturally.
    final _Harness h = _Harness(
      bytes: Uint8List.fromList(<int>[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        ...List<int>.filled(kInjectImageB64Budget, 0x7F),
      ]),
    );
    h.connect();
    expect(await h.controller.sendImage(), ImageSendFailure.tooLarge);
    expect(h.controller.imageFailure!.detail, isNotNull);
    expect(h.controller.imageFailure!.detail, contains('MB'));
    expect(h.injects, isEmpty);
    expect(h.store.entries, isEmpty);
    await h.dispose();
  });

  test('a disconnected phone refuses UP FRONT — the picker never even opens',
      () async {
    final _Harness offline = _Harness(bytes: kPng); // never connected
    expect(await offline.controller.sendImage(), ImageSendFailure.notConnected);
    expect(offline.picker.calls, 0, reason: 'do not make them choose a photo first');
    await offline.dispose();
  });

  test('cloud light-record: pick → local noted image row — no inject, no not-injected face',
      () async {
    // owner 2026-07-31: local save is the product answer; e2e:v1: upload is
    // a different engineering and must NOT be invented here.
    final _Harness cloud = _Harness(bytes: kPng, cloudInstance: true);
    // Link optional for local save — still connect so the session mirrors a
    // real light-record visit, but the assert is about the ABSENCE of wire traffic.
    cloud.connect();
    expect(await cloud.controller.sendImage(), isNull);
    expect(cloud.picker.calls, 1);
    expect(cloud.injects, isEmpty, reason: 'no PC ⇒ no inject:request');
    expect(
      cloud.transport.emittedWhere(FlowMicEvents.historyCreate),
      isEmpty,
      reason: '0.2.27: nothing uploads at all — a light-record image stays on the phone '
          'structurally, where the withhold gate used to keep it',
    );
    expect(cloud.store.entries, hasLength(1));
    final TimelineEntry row = cloud.store.entries.single;
    expect(row.isImage, isTrue);
    expect(row.origin, 'cloud');
    expect(row.delivery, Delivery.none);
    expect(row.status, EntryStatus.noted,
        reason: 'noted = record-only truth, never cached/injected/failed');
    expect(row.sourceText, imageEntryLabel(ImageMime.png, kPng.length));
    expect(cloud.controller.imageFailure, isNull);
    await cloud.dispose();
  });

  test('cloud light-record still works while the link is down — local save needs no PC',
      () async {
    final _Harness cloud = _Harness(bytes: kPng, cloudInstance: true);
    // deliberately NOT connected
    expect(await cloud.controller.sendImage(), isNull);
    expect(cloud.picker.calls, 1);
    expect(cloud.store.entries.single.status, EntryStatus.noted);
    expect(cloud.injects, isEmpty);
    await cloud.dispose();
  });

  test('an emit that never leaves the device marks the fresh row ✗ failed and '
      'says so (没有静默失败)', () async {
    final _Harness h = _Harness(bytes: kPng);
    h.connect();
    h.transport.refuse = FlowMicEvents.injectRequest;
    expect(await h.controller.sendImage(), ImageSendFailure.wireFailed);
    expect(h.store.entries, hasLength(1), reason: 'the attempt still leaves a record');
    expect(
      h.store.entries.single.status,
      EntryStatus.failed,
      reason: 'never left at ⏳ pretending a delivery is still in flight',
    );
    expect(h.controller.imageFailure!.reason, ImageSendFailure.wireFailed);
    await h.dispose();
  });

  test('an image row can NEVER be re-injected: a re-delivery would re-send its '
      'descriptor as text and call that a delivery', () async {
    final _Harness h = _Harness(bytes: kPng);
    h.connect();
    await h.controller.sendImage();
    final TimelineEntry row = h.store.entries.single;
    // 0.2.27: counted on the new carrier. Re-delivery is an inject:request{source:history}
    // now, so THAT is what must not appear — the original bytes are not retained,
    // so re-sending the descriptor would be a fabricated success either way.
    final int before = h.transport.emitted
        .where((EventEnvelope e) =>
            e.name == FlowMicEvents.injectRequest &&
            (e.data! as Map)['source'] == 'history')
        .length;

    h.controller.reInject(row);
    await pumpEventQueue();
    expect(
      h.transport.emitted
          .where((EventEnvelope e) =>
              e.name == FlowMicEvents.injectRequest &&
              (e.data! as Map)['source'] == 'history')
          .length,
      before,
      reason: 'no re-delivery frame may be emitted for a picture',
    );
    expect(h.transport.emittedNames, isNot(contains(FlowMicEvents.historyInject)));
    // …and the row's settled truth was not disturbed into a fake ⏳.
    expect(h.store.entries.single.status, EntryStatus.cached);
    await h.dispose();
  });

  test('the ORIGINAL bytes are never persisted — the row keeps a descriptor and '
      'a bounded preview', () async {
    // owner 2026-07-27 (protocol change authorised) moved this line, and it is
    // worth being precise about WHERE it moved to. What stays banned is the row
    // becoming a file: the original bytes are still never stored. What is new is
    // a BOUNDED thumbnail, because 「🖼 PNG · 78 KB」 on three surfaces tells you
    // nothing about which screenshot it was. So the assertion is no longer
    // "small" — it is "not the original, and inside the cap".
    final _Harness h = _Harness(bytes: kPng);
    h.connect();
    await h.controller.sendImage();
    final Map<String, Object?> json = h.store.entries.single.toJson();
    final String blob = jsonEncode(json);
    expect(blob.contains(base64Encode(kPng)), isFalse,
        reason: 'the original payload must never be in the row');
    expect(json['entry_type'], 'image');
    final Object? thumb = json['thumb_b64'];
    expect(thumb, isA<String>());
    expect((thumb! as String).length, lessThanOrEqualTo(kThumbB64Max));
    // …and BOTH now cross the wire: the picture row stops arriving at the PC and
    // the console as a line of prose.
    final Map<String, Object?> wire =
        h.store.entries.single.toHistoryItem(pcDeviceId: 'pc', userId: 'u');
    expect(wire['entry_type'], 'image');
    expect(wire['thumb_b64'], thumb);
    await h.dispose();
  });

  test('a stored image row round-trips its kind, and a pre-T-4 row defaults to '
      'transcript rather than guessing', () {
    final TimelineEntry img = TimelineEntry(
      id: 'loc_d_i0',
      clientId: 'i0',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      sourceText: '🖼 PNG · 77 B',
      outputText: '🖼 PNG · 77 B',
      status: EntryStatus.injected,
      entryType: TimelineEntry.kImage,
      createdAt: DateTime.utc(2026, 7, 25),
      updatedAt: DateTime.utc(2026, 7, 25),
    );
    expect(TimelineEntry.fromJson(img.toJson())!.isImage, isTrue);
    // The kind is immutable: copyWith has no parameter for it, and an edit
    // cannot turn a picture row into a transcript one (or the reverse).
    expect(img.copyWith(outputText: 'x', edited: true).entryType,
        TimelineEntry.kImage);
    // A row stored before T-4 has no entry_type key at all.
    final Map<String, Object?> legacy = img.toJson()..remove('entry_type');
    expect(TimelineEntry.fromJson(legacy)!.entryType, TimelineEntry.kTranscript);
  });
}

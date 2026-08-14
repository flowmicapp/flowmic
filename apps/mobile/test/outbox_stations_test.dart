// window B3-2c — the two things the queue's own suite structurally could not ask.
//
//   ① 🔴 G-6 AT THE FRAME. outbox_test.dart can only see what the queue HANDED
//      the host. G-6 lived in the gap after that: the queue passed the bytes and
//      the host dropped them. So these assert on the FRAME — `image_b64` and
//      `image_mime` as they would appear in the JSON on the wire — and they can
//      do so without a whole ChatController because the builder was extracted
//      into outbox_frame.dart for exactly this reason.
//
//   ② 🔴 THE DIRECT-SEND SNAPSHOT. `_deliverDirect` now awaits a disk write
//      before the emit. Anything it read AFTER that await could be a different
//      utterance's — so the test holds the write open, changes the mode and
//      lands another sentence inside the window, and demands the queued item be
//      byte-identical. 「the whole item is built synchronously before any await」 is the rule; this is the
//      only thing that can prove it stayed true.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/outbox_frame.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

final DateTime kSpoken = DateTime.utc(2026, 7, 28, 9, 15);

OutboxItem _imageItem({String? mime = 'image/png'}) => OutboxItem(
  requestId: 'i-1',
  entryId: 'loc_i-1',
  coveredEntryIds: const <String>['loc_i-1'],
  kind: OutboxPayloadKind.image,
  source: 'image',
  // The protocol requires `text`; a picture carries none.
  text: '',
  mode: 'realtime',
  createdAt: kSpoken,
  enqueuedAt: kSpoken,
  destinationMachineUid: 'machine-A',
  destinationPairingIdentity: 'standalone|instance:A',
  enqueuedPcId: 'pc-A',
  entryType: 'image',
  imagePath: '/tmp/i-1.png',
  imageMime: mime,
);

/// One text delivery. [wireEntryId] is the whole subject of two tests below:
/// null ⇒ this send did NOT build the row it covers ⇒ the frame omits entry_id.
OutboxItem _textItem({required String? wireEntryId}) => OutboxItem(
  requestId: 't-1',
  entryId: 'loc_t-1',
  wireEntryId: wireEntryId,
  coveredEntryIds: const <String>['loc_t-1', 'loc_t-2'],
  kind: OutboxPayloadKind.text,
  source: 'manual',
  text: '一句话',
  mode: 'realtime',
  createdAt: kSpoken,
  enqueuedAt: kSpoken,
  destinationMachineUid: 'machine-A',
  destinationPairingIdentity: 'standalone|instance:A',
  enqueuedPcId: 'pc-A',
);

void main() {
  group('🔴 G-6 at the frame: source:image must carry image_b64 + image_mime', () {
    final Uint8List png = Uint8List.fromList(<int>[137, 80, 78, 71, 1, 2, 3]);

    test('bytes present ⇒ both fields are on the frame, and b64 is the canonical form', () {
      final InjectRequestPayload? frame = buildOutboxInjectFrame(
        item: _imageItem(),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
        imageBytes: png,
        entryCaption: '🖼 PNG · 7 B',
      );
      expect(frame, isNotNull);

      // THE WIRE, not the object: `toJson` is what actually crosses.
      final Map<String, Object?> json = frame!.toJson();
      expect(json['source'], 'image');
      expect(json['image_b64'], base64Encode(png));
      expect(json['image_mime'], 'image/png');
      // Canonical base64 — no `data:` prefix, no newlines (04 §3.5).
      expect(json['image_b64'].toString(), isNot(contains('\n')));
      expect(json['image_b64'].toString(), isNot(startsWith('data:')));
      // RV-68: the row's words ride along, passed through untouched.
      expect(json['entry_caption'], '🖼 PNG · 7 B');
      // gate 1/gate 3: the item's own frozen keys, never re-minted or re-clocked.
      expect(json['request_id'], 'i-1');
      expect(json['created_at'], kSpoken.toIso8601String());
    });

    // ── reverse control ──────────────────────────────────────────────────────
    // Each of these is the state the code was ACTUALLY in before this card. A
    // frame built here is not 「one field short」: InjectRequestPayload's constructor
    // asserts the pairing (debug death) and the server answers
    // INJECT_FRAME_INVALID — which isTerminalRefusalCode treats as TERMINAL, so
    // the item is settled `refused` and the picture is gone for good.
    test('🔴 no bytes ⇒ no frame is built at all (exactly the pre-fix state)', () {
      OutboxFrameRefusal? reason;
      final InjectRequestPayload? frame = buildOutboxInjectFrame(
        item: _imageItem(),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
        onRefused: (OutboxFrameRefusal r) => reason = r,
      );
      expect(frame, isNull, reason: 'an unbuildable frame must not be built');
      expect(reason, OutboxFrameRefusal.imageBytesMissing);
    });

    test('🔴 no mime ⇒ likewise no frame (the pairing is bidirectional)', () {
      OutboxFrameRefusal? reason;
      final InjectRequestPayload? frame = buildOutboxInjectFrame(
        item: _imageItem(mime: null),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
        imageBytes: png,
        onRefused: (OutboxFrameRefusal r) => reason = r,
      );
      expect(frame, isNull);
      expect(reason, OutboxFrameRefusal.imageMimeMissing);
    });

    // ── 🔴 wire_entry_id: whether entry_id is stamped is 「did THIS delivery build that row」 ──
    //
    // window B3-2a stamped `entry_id` unconditionally (`settle.first`), replacing a
    // pre-queue `typedEntry?.id` that was NULL for a buffered multi-row send.
    // typed_send_row_test.dart says the cost in its own words: 「one id would
    // make the PC write that row's truth over both」. These two pin both sides.
    test('🔴 multi-row buffered send (never built a row) ⇒ the frame has no entry_id key at all', () {
      final Map<String, Object?> json = buildOutboxInjectFrame(
        item: _textItem(wireEntryId: null),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
      )!.toJson();
      expect(
        json.containsKey('entry_id'),
        isFalse,
        reason: 'OMITTED, not empty — an empty string is a value, and entry_id '
            'means 「this frame is talking about this row」',
      );
      // The settle anchor still exists locally; it just does not go on the wire.
      expect(_textItem(wireEntryId: null).entryId, isNotEmpty);
    });

    test('D10 single-row send (it built that row itself) ⇒ the frame has entry_id, and it is that row', () {
      final Map<String, Object?> json = buildOutboxInjectFrame(
        item: _textItem(wireEntryId: 'loc_t-1'),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
      )!.toJson();
      expect(json['entry_id'], 'loc_t-1');
    });

    test('text item ⇒ neither field appears (supplying only one half is equally an illegal frame)', () {
      final InjectRequestPayload? frame = buildOutboxInjectFrame(
        item: OutboxItem(
          requestId: 't-1',
          entryId: 'loc_t-1',
          coveredEntryIds: const <String>['loc_t-1'],
          kind: OutboxPayloadKind.text,
          source: 'manual',
          text: '一句话',
          mode: 'realtime',
          createdAt: kSpoken,
          enqueuedAt: kSpoken,
          destinationMachineUid: 'machine-A',
          destinationPairingIdentity: 'standalone|instance:A',
          enqueuedPcId: 'pc-A',
        ),
        targetPcId: 'pc-A',
        origin: InjectOrigin.live,
        // Even if a caller offers a caption, a transcript frame must not carry
        // one — the schema's superRefine binds it to entry_type:'image'.
        entryCaption: 'not mine',
      );
      final Map<String, Object?> json = frame!.toJson();
      expect(json.containsKey('image_b64'), isFalse);
      expect(json.containsKey('image_mime'), isFalse);
      expect(json.containsKey('entry_caption'), isFalse);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  group('🔴 re-inject: persist to disk before sending', () {
    test('while the disk await is still open ⇒ not a single frame has gone out', () async {
      final _GatedOutboxStore store = _GatedOutboxStore();
      final _Rig rig = _Rig(store);
      rig.connect();
      rig.speak('要重发的那一句');
      await pumpEventQueue();
      rig.transport.emitted.clear();

      final Completer<void> gate = Completer<void>();
      store.gate = gate;
      final Future<void> resent =
          rig.controller.delivery.reInject(rig.timeline.entries.first);
      await pumpEventQueue();

      // 🔴 THE ORDERING. `unawaited`-ing the enqueue would weaken 「enqueue finished before
      // send」 to 「enqueue started before send」, and this is the assertion that can tell the
      // difference: with the disk held open, nothing may be on the wire yet.
      expect(
        rig.transport.emittedWhere(FlowMicEvents.injectRequest),
        isEmpty,
        reason: 're-inject must not emit before its delivery is on disk',
      );

      gate.complete();
      await resent;
      await pumpEventQueue();
      expect(
        rig.transport.emittedWhere(FlowMicEvents.injectRequest),
        isNotEmpty,
        reason: 'and once the disk is done, it does go out',
      );
      // The re-inject landed in the queue as its own delivery (source:'history').
      final List<OutboxItem> all = await store.inner.loadAll();
      expect(all.any((OutboxItem i) => i.source == 'history'), isTrue);
      await rig.dispose();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  group('🔴 direct-send persist: the whole item is built synchronously before any await', () {
    test('change mode and land a new utterance while the disk await is open ⇒ the already-queued item is byte-identical', () async {
      final _GatedOutboxStore store = _GatedOutboxStore();
      final _Rig rig = _Rig(store);
      rig.connect();

      // Hold the disk write open, then say something in realtime.
      final Completer<void> gate = Completer<void>();
      store.gate = gate;
      rig.speak('第一句');
      // Let _deliverDirect reach the blocked upsert.
      await pumpEventQueue();
      // A REAL check, awaited. (An earlier version of this line peeked at a
      // synchronously-returned list that was always empty — an assertion that
      // could not fail is the same façade this whole card is about.)
      expect(
        await store.inner.loadAll(),
        isEmpty,
        reason: 'the write must still be open, or the window below is fiction',
      );

      // ── INSIDE THE WINDOW: everything the old code might have re-read. ──
      rig.controller.setMode(FlowMode.organize);
      rig.speak('第二句完全不同的话');
      await pumpEventQueue();

      gate.complete();
      await pumpEventQueue();

      final OutboxItem first =
          (await store.inner.findByRequestId(rig.firstClientId!))!;
      // 🔴 The three fields the window could have corrupted.
      expect(first.text, '第一句', reason: 'a later utterance must not overwrite it');
      expect(
        first.mode,
        FlowMode.realtime.name,
        reason: 'the ROW\'s mode, not 「which one is selected now」 (RV-74)',
      );
      expect(
        first.createdAt,
        rig.firstCreatedAt,
        reason: 'gate 3 — the SPEAKING instant, not the moment the disk finished',
      );
      await rig.dispose();
    });
  });
}

/// A store whose write can be held open, so the enqueue `await` becomes a real
/// window a test can act inside. Without this the window is a single microtask
/// and nothing can be proven about it.
class _GatedOutboxStore implements OutboxStore {
  final InMemoryOutboxStore inner = InMemoryOutboxStore();
  Completer<void>? gate;

  @override
  Future<void> upsert(OutboxItem item) async {
    final Completer<void>? g = gate;
    if (g != null) await g.future;
    return inner.upsert(item);
  }

  @override
  Future<List<OutboxItem>> loadPending() => inner.loadPending();
  @override
  Future<List<OutboxItem>> loadAll() => inner.loadAll();
  @override
  Future<OutboxItem?> findByRequestId(String id) => inner.findByRequestId(id);
}

class _Rig {
  _Rig(OutboxStore store) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    timeline = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: store,
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: timeline,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final DestinationController destination;
  late final ChatController controller;

  String? firstClientId;
  DateTime? firstCreatedAt;

  void connect() => transport.pushStatus(SocketStatus.connected);

  void speak(String text) {
    controller.pttDown();
    controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    if (firstClientId == null && timeline.entries.isNotEmpty) {
      firstClientId = timeline.entries.first.clientId;
      firstCreatedAt = timeline.entries.first.createdAt;
    }
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    timeline.dispose();
    await session.dispose();
    await transport.close();
  }
}

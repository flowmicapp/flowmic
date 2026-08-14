// REQ-12-09 09-F/09-I/09-J acceptance — what the "+" panel's send actually puts
// on the wire, end to end against a real ChatController.
//
// SPEC-REF:
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     §2-1 (1 text + M pictures = 1+M items), §3 criterion 1 and criterion 5, §3 卡 09-I
//   docs/strategy/2026-08-12-req1209-plus-panel-design.md §7-1/§7-2/§7-3, §7-4
//
// 🔴 THE RULING IN ONE LINE: N ticked texts compose into **exactly one**
// `deliverText` (one message, one row), and each ticked picture is **its own**
// delivery and **its own** row — 「Images must be sendable in new line, not
// merging to text line」. So N texts + M pictures ⇒ 1 + M frames and 1 + M rows,
// and with M = 0 that is still exactly one.
//
// ⚠️ WHY THE ASSERTION IS ON FRAMES AND ROWS, NOT ON A CALL COUNTER. A spy on
// `deliverText` would prove the orchestration called it once and would say
// nothing about whether one message left the phone: the queue sits between them
// and a drain carries everything pending, so "called once" and "one item left the phone" are
// different facts. The transport's `inject:request` list is the one the PC would
// have seen.
//
// Plain `test()`, not `testWidgets`: the delivery chain is genuinely async and
// awaiting it inside a FakeAsync zone deadlocks (a scar this repo already
// wears — see typed_send_row_test.dart's header).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/row_image_lookup.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The same real 2×2 RGBA PNG the rest of the image suite uses.
final Uint8List kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List? bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

/// A light-record picture row exactly as `ImageSendController._saveLocal`
/// writes one: `clientId == request_id`, `origin: 'cloud'`, `entry_type: image`.
///
/// 🔴 `clientId` is the whole point — it is the name the bytes are filed under
/// (`OutboxBlobStore.pathFor`), so a fixture that invented a different one would
/// be testing a shape production never produces.
TimelineEntry _noteRow(
  String clientId, {
  required String text,
  required DateTime at,
  String entryType = TimelineEntry.kTranscript,
}) => TimelineEntry(
  id: TimelineEntry.mintLocId('mobile', clientId),
  clientId: clientId,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  createdAt: at,
  updatedAt: at,
  origin: 'cloud',
  entryType: entryType,
);

class _Harness {
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final TimelineSyncGate gate;
  late final ChatController controller;
  late final OutboxBlobStore blobs;
  late final TimelinePersistence persistence;

  _Harness({bool cloudInstance = false, Uint8List? picked}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Identity, not the handshake — a queued delivery is addressed to a MACHINE, so a fixture
    // with a live socket and no pairing has no destination and every text send
    // is (correctly) refused `noPcTarget`.
    giveSessionAPairedIdentity(session);
    persistence = InMemoryTimelinePersistence();
    store = newTestStore(persistence: persistence);
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    gate = TimelineSyncGate(transport: transport);
    blobs = newTestOutboxBlobs();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: blobs,
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: InMemoryLocalPrefs(),
      imagePicker: _FakePicker(picked),
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  List<Map<String, Object?>> get injectPayloads => <Map<String, Object?>>[
    for (final EventEnvelope e in injects)
      Map<String, Object?>.from(e.data! as Map),
  ];

  List<Map<String, Object?>> framesOfSource(String source) =>
      injectPayloads.where((Map<String, Object?> p) => p['source'] == source)
          .toList();

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  group('09-I — a light-note picture now keeps its bytes', () {
    test('🔴 saving one writes the ORIGINAL bytes beside the row, findable by '
        'the row\'s own id', () async {
      final _Harness h = _Harness(cloudInstance: true, picked: kPng);
      h.connect();

      expect(await h.controller.sendImage(), isNull);

      final TimelineEntry row = h.store.entries.single;
      expect(row.entryType, TimelineEntry.kImage);
      expect(row.origin, 'cloud', reason: 'this is a light record');
      // 🔴 The gap RV-93 named, closed: `pathFor(clientId)` is how every reader
      // finds a row's picture, and before this card it returned null forever
      // for this class of row.
      expect(await h.blobs.pathFor(row.clientId), isNotNull);
      expect(await rowImageBytes(h.blobs, row), kPng,
          reason: 'byte for byte what the picker handed over');
      await h.dispose();
    });

    test('Reverse control: a TRANSCRIPT light record still has no picture — the write '
        'is on the picture path, not on every save', () async {
      final _Harness h = _Harness(cloudInstance: true, picked: kPng);
      h.connect();
      // A row that is not a picture: nothing was written for it, and
      // `rowImageBytes` says so rather than inventing a path.
      final TimelineEntry text =
          _noteRow('m1', text: '一句轻记录', at: DateTime.utc(2026, 8, 1));
      expect(await rowImageBytes(h.blobs, text), isNull);
      expect(await h.blobs.pathFor(text.clientId), isNull);
      await h.dispose();
    });
  });

  group('09-F/09-J — criterion 1: N texts + M pictures ⇒ 1 + M', () {
    /// Seed [notes] onto disk, load them into the store, and file [withBytes]'
    /// pictures where 09-I would have put them.
    Future<_Harness> rig({
      required List<TimelineEntry> notes,
      Set<String> withBytes = const <String>{},
    }) async {
      final _Harness h = _Harness();
      for (final TimelineEntry n in notes) {
        await h.persistence.upsert(n);
        if (withBytes.contains(n.clientId)) {
          await h.blobs.put(
            requestId: n.clientId,
            bytes: kPng,
            extension: 'png',
          );
        }
      }
      await h.store.load();
      h.connect();
      return h;
    }

    test('🔴 3 texts + 2 pictures ⇒ ONE manual frame carrying the joined text, '
        'TWO image frames, and exactly 3 new rows', () async {
      final TimelineEntry t1 =
          _noteRow('m1', text: '第一句', at: DateTime.utc(2026, 8, 1));
      final TimelineEntry p1 = _noteRow('i1',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage);
      final TimelineEntry p2 = _noteRow('i2',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 3),
          entryType: TimelineEntry.kImage);
      final _Harness h = await rig(
        notes: <TimelineEntry>[t1, p1, p2],
        withBytes: <String>{'i1', 'i2'},
      );
      final int rowsBefore = h.store.entries.length;

      await h.controller.sendPlusSelection(
        // Already composed by the panel: tick order, one '\n', no decoration.
        text: '第一句\n常用一句\n第三句',
        images: <TimelineEntry>[p1, p2],
      );

      final List<Map<String, Object?>> manual = h.framesOfSource('manual');
      final List<Map<String, Object?>> images = h.framesOfSource('image');
      expect(manual, hasLength(1), reason: 'criterion 1: exactly ONE deliverText');
      expect(manual.single['text'], '第一句\n常用一句\n第三句');
      expect(images, hasLength(2), reason: 'criterion 1: one delivery per picture');
      // Each picture really carries bytes — a frame with an empty payload would
      // be the G-6 regression, and it is invisible without this line.
      for (final Map<String, Object?> f in images) {
        expect(base64Decode(f['image_b64']! as String), kPng);
        // Same addressing path as everything else: 绝不许串号 is enforced there,
        // and this is the visible edge of it.
        expect(f['target_pc_id'], 'pc-test-0001');
        expect(f['request_id'], isNotNull);
      }
      // 🔴 1 + M rows. Three new ones on top of the three notes that were
      // already on disk — the notes were quoted, not consumed.
      expect(h.store.entries.length - rowsBefore, 3);
      await h.dispose();
    });

    test('🔴 M = 0 still means exactly ONE frame and ONE new row', () async {
      final _Harness h = await rig(notes: const <TimelineEntry>[]);
      await h.controller.sendPlusSelection(
        text: '甲\n乙',
        images: const <TimelineEntry>[],
      );
      expect(h.framesOfSource('manual'), hasLength(1));
      expect(h.framesOfSource('image'), isEmpty);
      expect(h.store.entries, hasLength(1));
      expect(h.store.entries.single.sourceText, '甲\n乙');
      await h.dispose();
    });

    test('pictures only ⇒ no text message is invented, M frames and M rows',
        () async {
      final TimelineEntry p1 = _noteRow('i1',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage);
      final _Harness h =
          await rig(notes: <TimelineEntry>[p1], withBytes: <String>{'i1'});
      final int before = h.store.entries.length;

      await h.controller.sendPlusSelection(
        text: null,
        images: <TimelineEntry>[p1],
      );

      // An empty text message would be a delivery the user never asked for —
      // and `deliverText` would refuse it, burying a real refusal among
      // rehearsed ones.
      expect(h.framesOfSource('manual'), isEmpty);
      expect(h.framesOfSource('image'), hasLength(1));
      expect(h.store.entries.length - before, 1);
      await h.dispose();
    });

    test('🔴 §7-4: the quoted light records are not touched — same id, same '
        'text, same status, byte for byte', () async {
      final TimelineEntry note =
          _noteRow('m1', text: '第一句', at: DateTime.utc(2026, 8, 1));
      final TimelineEntry pic = _noteRow('i1',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage);
      final _Harness h = await rig(
        notes: <TimelineEntry>[note, pic],
        withBytes: <String>{'i1'},
      );

      await h.controller.sendPlusSelection(
        text: '第一句',
        images: <TimelineEntry>[pic],
      );

      for (final TimelineEntry original in <TimelineEntry>[note, pic]) {
        final TimelineEntry? after = h.store.findById(original.id);
        expect(after, isNotNull, reason: '${original.id} vanished');
        expect(after!.status, original.status);
        expect(after.sourceText, original.sourceText);
        expect(after.outputText, original.outputText);
        expect(after.updatedAt, original.updatedAt);
        expect(after.delivery, original.delivery);
        expect(after.origin, 'cloud');
      }
      // The new picture row is a DIFFERENT row with its own id — the note was
      // quoted, and "what actually happened to this row" about the note did not change.
      final List<TimelineEntry> fresh = h.store.entries
          .where((TimelineEntry e) => e.origin != 'cloud')
          .toList();
      expect(fresh, hasLength(2));
      expect(fresh.map((TimelineEntry e) => e.id), isNot(contains(pic.id)));
      // …and it has its OWN copy of the bytes, so opening the full image works on both.
      final TimelineEntry newPicture =
          fresh.firstWhere((TimelineEntry e) => e.isImage);
      expect(newPicture.clientId, isNot(pic.clientId));
      expect(await rowImageBytes(h.blobs, newPicture), kPng);
      expect(await rowImageBytes(h.blobs, pic), kPng,
          reason: 'the note kept its own picture too');
      await h.dispose();
    });

    test('🔴 09-G at the send edge: a picture whose bytes are gone fails LOUD '
        'and puts nothing on the wire', () async {
      // The panel does not offer a tick for this row, but the file can vanish
      // between the probe and the tap — so this is a race, not a
      // should-never-happen, and it must not be silent.
      final TimelineEntry legacy = _noteRow('i-legacy',
          text: '🖼 JPEG · 88 KB',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage);
      final _Harness h = await rig(notes: <TimelineEntry>[legacy]);
      final int before = h.store.entries.length;

      final ImageSendFailure? outcome =
          await h.controller.imageSend.sendStoredImage(legacy);

      expect(outcome, ImageSendFailure.emptyFile);
      expect(h.controller.imageSend.failure?.reason, ImageSendFailure.emptyFile,
          reason: 'the banner has to be able to say so');
      expect(h.framesOfSource('image'), isEmpty);
      expect(h.store.entries.length, before,
          reason: 'no half-delivery row left behind');
      await h.dispose();
    });

    test('🔴 sequential, not parallel: M pictures really produce M frames — '
        'the in-flight guard drops a concurrent second send', () async {
      // This is the assertion that would catch a `Future.wait` refactor. With
      // the guard, firing them together delivers ONE picture and returns
      // "success" for all of them, which is the "saying we did something we did not" half of
      // the red line and looks exactly like a working feature.
      final List<TimelineEntry> pics = <TimelineEntry>[
        for (int i = 0; i < 4; i++)
          _noteRow('i$i',
              text: '🖼 PNG · 77 B',
              at: DateTime.utc(2026, 8, 2).add(Duration(minutes: i)),
              entryType: TimelineEntry.kImage),
      ];
      final _Harness h = await rig(
        notes: pics,
        withBytes: <String>{'i0', 'i1', 'i2', 'i3'},
      );
      final int before = h.store.entries.length;

      await h.controller
          .sendPlusSelection(text: null, images: pics);

      expect(h.framesOfSource('image'), hasLength(4));
      expect(h.store.entries.length - before, 4);
      // Four distinct request ids — one delivery each, never one id reused.
      final Set<Object?> ids = h
          .framesOfSource('image')
          .map((Map<String, Object?> f) => f['request_id'])
          .toSet();
      expect(ids, hasLength(4));
      await h.dispose();
    });
  });
}

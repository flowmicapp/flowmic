// D9 ② (0.3.0) — a broken disk must degrade DURABILITY, never DELIVERY.
//
// THE DEFECT THIS PINS. Four send sites (chat_utterance.dart:251,
// manual_delivery.dart:378, manual_delivery_reinject.dart:185,
// image_send_controller.dart:537) call `await outbox.enqueueText/Image(...)`
// with no try/catch, and each one states the rule in its own comment
// (「That degrades DURABILITY, never delivery」 / 「A NULL IS NOT FATAL AND MUST
// NOT ABORT THE SEND」). The queue broke it: `_admit` did a bare
// `await _store.upsert(item)`, so a SQLite write failure THREW straight through
// enqueue and aborted the whole send — the user's sentence never left the
// phone because we could not also write it down. A persistence problem was
// turned into a delivery failure at all four sites at once.
//
// WHAT THE FIX PROMISES (and what these tests hold it to):
//   ① the send still goes out, and still settles, on a disk that cannot write;
//   ② it is LOUD — `outbox.persist_degraded` names the request, and the
//      `outbox.enqueued` line carries `persisted:false`, which is the one bit
//      separating 「queued」 from 「landed on disk」;
//   ③ a read failure degrades the same way (shadow-only, `store_read_degraded`)
//      instead of aborting the drain;
//   ④ it self-heals per item: once a write lands, the disk is authoritative
//      again.
//
// ⚠️ WHAT IS NOT PROMISED, on purpose: a shadow item does NOT survive a process
// death. That is what 「persistence degraded」 MEANS, and ② is what makes the
// loss attributable afterwards. 「待投递」 stays honest because the in-memory
// queue really does still redeem it within this session.
//
// REVERSE CONTROL (D9②): put `await _store.upsert(item)` back in
// `DeliveryOutbox._persistItem` — the first test goes red with the StateError
// escaping `enqueueText`, exactly as production did. Executed for real during
// the card (red output in the report), then restored; marker grep
// REVERSE-CONTROL-D9 = 0 in lib/.

import 'dart:typed_data';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;
import 'package:flutter_test/flutter_test.dart';

const LiveConnection _kOnLan = LiveConnection(
  machineUid: 'machine-uid-AAAA',
  pairingIdentity: 'standalone|instance:inst-A-lan',
  pcId: 'pc-A-lan',
  channel: ServerChannel.lan,
);

class _Host implements OutboxDrainHost {
  final List<String> sentRequestIds = <String>[];
  bool sendOk = true;

  @override
  LiveConnection get liveConnection => _kOnLan;

  @override
  Future<bool> ensureLink() async => true;

  @override
  Future<void> reseedDestination() async {}

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sentRequestIds.add(item.requestId);
    return sendOk;
  }

  @override
  void onOutboxChanged() {}
}

/// The disk-error shape: a real store underneath, with writes and/or reads
/// switchable to throwing. Deliberately NOT a store that returns silently —
/// silence is what the old code could survive; a throw is what killed the send.
class _FlakyStore implements OutboxStore {
  final InMemoryOutboxStore _real = InMemoryOutboxStore();

  bool failWrites = false;
  bool failReads = false;
  int refusedWrites = 0;

  @override
  Future<void> upsert(OutboxItem item) {
    if (failWrites) {
      refusedWrites++;
      throw StateError('disk write refused (test)');
    }
    return _real.upsert(item);
  }

  @override
  Future<List<OutboxItem>> loadPending() {
    if (failReads) throw StateError('disk read refused (test)');
    return _real.loadPending();
  }

  @override
  Future<List<OutboxItem>> loadAll() {
    if (failReads) throw StateError('disk read refused (test)');
    return _real.loadAll();
  }

  @override
  Future<OutboxItem?> findByRequestId(String requestId) {
    if (failReads) throw StateError('disk read refused (test)');
    return _real.findByRequestId(requestId);
  }
}

Future<OutboxItem?> _enqueue(DeliveryOutbox box, {String id = 'req-1'}) =>
    box.enqueueText(
      requestId: id,
      entryId: 'loc_$id',
      wireEntryId: 'loc_$id',
      source: 'manual',
      text: 'hello pc',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 8, 4, 9),
    );

void main() {
  late _FlakyStore store;
  late _Host host;
  late DeliveryOutbox box;

  setUp(() {
    DiagLog.instance.clear();
    store = _FlakyStore();
    host = _Host();
    box = DeliveryOutbox(
      store: store,
      blobs: InMemoryOutboxBlobStore(),
      host: host,
    );
  });

  test('🔴 D9② — the write fails, the SEND STILL HAPPENS (and settles)', () async {
    store.failWrites = true;

    // ① The enqueue must not throw — this is the line that aborted all four
    // send sites before the card.
    final OutboxItem? queued = await _enqueue(box);

    expect(store.refusedWrites, greaterThan(0),
        reason: 'positive control — the write really was attempted and refused');
    expect(queued, isNotNull,
        reason: 'a delivery we could not write down is still a delivery; '
            'returning null/throwing here is the persistence problem being '
            'promoted into a failed send');

    // ② The drain finds it (through the shadow, since the table is empty) and
    // hands it to the wire.
    final OutboxDrainReport report = await box.drain();
    expect(report.sent, 1);
    expect(host.sentRequestIds, <String>['req-1']);
    // The table really is empty — the item is being delivered out of RAM.
    expect(await store._real.loadAll(), isEmpty);

    // ③ The PC answers. The verdict must find the item, or the queue would
    // re-deliver the same sentence after the watchdog.
    await box.settle(correlationId: 'req-1', ok: true);
    expect(box.pendingCountFor(null), 0,
        reason: 'a settled delivery must stop being counted as 待投递 even '
            'when its row never reached disk');

    // ④ …and the whole thing is on the record.
    final String trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('outbox.persist_degraded'));
    expect(trail, contains('req-1'));
  });

  test('🔴 D9② — the enqueue line says whether it landed (persisted:false is '
      'the bit that separates queued from landed-on-disk)', () async {
    store.failWrites = true;
    await _enqueue(box);
    final String degraded = DiagLog.instance
        .snapshot()
        .firstWhere((String l) => l.contains('outbox.enqueued'));
    expect(degraded, contains('persisted'));
    expect(degraded, contains('false'));

    DiagLog.instance.clear();
    store.failWrites = false;
    await _enqueue(box, id: 'req-2');
    final String healthy = DiagLog.instance
        .snapshot()
        .firstWhere((String l) => l.contains('outbox.enqueued'));
    // Positive control: the flag really does distinguish the two cases. Without
    // this half, a line that always said `false` would pass the assertion above.
    expect(healthy, contains('persisted'));
    expect(healthy, isNot(contains('false')));
  });

  test('D9② — a disk that cannot be READ degrades to the shadow instead of '
      'aborting the drain', () async {
    store.failWrites = true;
    store.failReads = true;
    await _enqueue(box);

    final OutboxDrainReport report = await box.drain();

    expect(report.sent, 1, reason: 'the queue keeps delivering out of RAM');
    expect(DiagLog.instance.snapshot().join('\n'),
        contains('outbox.store_read_degraded'));
  });

  test('D9② — self-healing per item: once a write lands, the disk is '
      'authoritative again', () async {
    store.failWrites = true;
    await _enqueue(box);
    expect(await store._real.loadAll(), isEmpty); // positive control

    // The disk comes back. The next write for this request_id lands…
    store.failWrites = false;
    await box.drain();
    await box.settle(correlationId: 'req-1', ok: true);

    final List<OutboxItem> onDisk = await store._real.loadAll();
    expect(onDisk, hasLength(1));
    expect(onDisk.single.state, OutboxDeliveryState.delivered,
        reason: 'the shadow must not keep shadowing a row the disk now holds — '
            'a stale shadow would be a second answer to 「where is this item」');
  });

  test('D9② — a write failure does not lose the DESTINATION (串号 red line is '
      'not relaxed by degrading)', () async {
    store.failWrites = true;
    final OutboxItem? queued = await _enqueue(box);

    expect(queued!.destinationMachineUid, _kOnLan.machineUid);
    expect(queued.destinationPairingIdentity, _kOnLan.pairingIdentity);
    expect(queued.enqueuedPcId, _kOnLan.pcId);
    // …and the frame the drain hands over is for that machine, not for
    // 「whoever is connected now」.
    await box.drain();
    expect(host.sentRequestIds, <String>['req-1']);
  });
}

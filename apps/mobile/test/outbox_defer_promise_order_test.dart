// NR-279 review S4a — the 「will not type it in」 promise must never be on the
// row while the queue item does not know it.
//
// Contract: docs/rebuild/15-INJECTION-PERMISSION.md §2.5e-3, the S4 append.
//
// THE DEFECT, by code reading in the acceptance review: on the socket leg
// `onInjectResultRouted` wrote the ROW first (`applyInjectResult`) and settled
// the QUEUE ITEM after it, unawaited — and the settle is what records
// `deferPromisedAt`. A kill between the two left the promise on disk over an
// `inflight` item with no stamp; the boot revive re-queued it and a PC back
// inside the 60 s live window got it `live` and typed it. The HTTP image leg
// had the same order in its `pcOffline` arm.
//
// HOW THE KILL IS STAGED: the store HOLDS the one write that carries the stamp
// (`GatedOutboxStore`). While it is held, whatever the row shows is what a
// restart would find next to an item that never got the stamp. The rule is
// 「both, or the fact alone — never the row alone」, so while held the row must
// NOT show the verdict yet.
//
// POSITIVE CONTROL: a verdict that makes no promise (`PC_UNREACHABLE`) keeps
// the old row-first order — with its settle write held, its row IS already
// written. Without this, 「the row was not written」 could mean the routing
// never reached the row at all.
//
// S4b at the controller level: the user's Resend on the promised row clears
// the fact on the attempt it puts on the wire, and a second INJECT_PC_OFFLINE
// stamps it again through the same path.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/gated_outbox_store.dart';

const String _rid = 'u-promise';

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    store = newTestStore();
    outboxStore = GatedOutboxStore();
    controller = ChatController(
      outboxStore: outboxStore,
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final GatedOutboxStore outboxStore;
  late final ChatController controller;
  late TimelineEntry row;

  Future<void> seedOwedTextDelivery() async {
    // Paired for real: the queue refuses an enqueue with no redeemable
    // destination.
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-nr279-s4a-00000000000000000000',
      'pc_name': 'Study PC',
      'pc_instance_id': 'inst-study',
      // The queue addresses a MACHINE; without it a drain holds the item
      // (`addressUnknown`) and the S4b case would test that hold instead.
      'pc_machine_uid': 'machine-study',
      'pc_id': 'pc-study',
    });
    await session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://192.0.2.5:41879',
    );
    transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    row = store.buildFromUtterance(
      clientId: _rid,
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: 'hello pc',
    );
    final OutboxItem? item = await controller.outbox.enqueueText(
      requestId: _rid,
      entryId: row.id,
      wireEntryId: row.id,
      source: 'stt',
      text: 'hello pc',
      mode: 'realtime',
      createdAt: DateTime.now().toUtc(),
    );
    expect(item, isNotNull, reason: 'setup: the queue must have taken it');
  }

  void pushVerdict(String code) {
    transport.pushIncoming('inject:result', <String, Object?>{
      'ok': false,
      'mode': 'sendinput',
      'error': code,
      'request_id': _rid,
      'entry_id': row.id,
    });
  }

  TimelineEntry get rowNow => store.findById(row.id)!;
  Future<OutboxItem> get itemNow async =>
      (await outboxStore.findByRequestId(_rid))!;
}

void main() {
  test('S4a socket leg: while the stamp write is held, the row does NOT show '
      'the promise yet; after it lands, both do', () async {
    final _Harness h = _Harness();
    await h.seedOwedTextDelivery();
    h.outboxStore.holdWhere = (OutboxItem i) => i.deferPromisedAt != null;

    h.pushVerdict('INJECT_PC_OFFLINE');
    await h.outboxStore.firstHeld.timeout(const Duration(seconds: 5));
    await pumpEventQueue();

    // ── the 「killed here」 instant ──
    expect((await h.itemNow).deferPromisedAt, isNull,
        reason: 'fixture: the stamp write is the one being held');
    expect(h.rowNow.failureReason, isNot('INJECT_PC_OFFLINE'),
        reason: 'row-only is the A1 shape: the row would promise 「will not '
            'type it in」 over an item a restart drains live');

    h.outboxStore.release();
    await pumpEventQueue();
    expect((await h.itemNow).deferPromisedAt, isNotNull);
    expect(h.rowNow.failureReason, 'INJECT_PC_OFFLINE',
        reason: 'the verdict still reaches the row, right after the fact');
  });

  test('positive control: a verdict that promises nothing keeps row-first '
      '(its row is written while its settle is held)', () async {
    final _Harness h = _Harness();
    await h.seedOwedTextDelivery();
    h.outboxStore.holdWhere =
        (OutboxItem i) => i.lastRefusalNote == 'PC_UNREACHABLE';

    h.pushVerdict('PC_UNREACHABLE');
    await h.outboxStore.firstHeld.timeout(const Duration(seconds: 5));
    await pumpEventQueue();
    expect(h.rowNow.failureReason, 'PC_UNREACHABLE',
        reason: 'the routing reaches the row; only the promise is reordered');
    h.outboxStore.release();
    await pumpEventQueue();
    expect((await h.itemNow).deferPromisedAt, isNull);
  });

  test('S4b controller: Resend on the promised row clears the fact on the '
      'attempt it sends; a second INJECT_PC_OFFLINE stamps it again', () async {
    final _Harness h = _Harness();
    await h.seedOwedTextDelivery();
    h.pushVerdict('INJECT_PC_OFFLINE');
    await pumpEventQueue();
    expect((await h.itemNow).deferPromisedAt, isNotNull);
    expect(h.controller.outbox.owedEntryIds, contains(h.row.id));

    h.controller.resendEntry(h.rowNow);
    await pumpEventQueue();
    final OutboxItem sent = await h.itemNow;
    expect(sent.state, OutboxDeliveryState.inflight,
        reason: 'fixture: the press really put the item on the wire');
    expect(sent.deferPromisedAt, isNull,
        reason: 'the row no longer promises anything; the fact goes with it');

    h.pushVerdict('INJECT_PC_OFFLINE');
    await pumpEventQueue();
    expect((await h.itemNow).deferPromisedAt, isNotNull,
        reason: 'the note is back on the row ⇒ the fact is back on the item');
    expect(h.rowNow.failureReason, 'INJECT_PC_OFFLINE');
  });
}

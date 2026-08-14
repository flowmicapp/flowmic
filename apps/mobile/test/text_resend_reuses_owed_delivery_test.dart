// card F7 (residual) — the in-row "resend" on a TEXT row minted a SECOND delivery for a
// record the queue still owed.
//
// THE HARM, stated the way the user meets it: the queue is holding this exact
// sentence (its `request_id` frozen at enqueue — gate 1, which is what makes a
// retry idempotent), the row shows a resend button, the user presses it, and
// `reInject` mints a BRAND NEW delivery with a new `request_id` and
// `created_at: now`. Two deliveries now exist for one sentence. The desktop
// cannot collapse them — two ids ARE two sends, deliberately (RV-72 makes a deferred
// resend a new PC row) — so when the first one lands late the sentence is typed into
// the user's document TWICE.
//
// 📌 THE PICTURE PATH ALREADY REFUSED TO DO THIS and said why in words that are
// not about pictures (`chat_outbox_host.dart`, `outboxResendImage`): 「the SAME
// delivery tried again … Minting a second delivery for those would paste the
// picture twice the moment the first one landed late.」 This card mirrors that
// for text — 「mirror it」 being the whole instruction, not a new mechanism.
//
// ⚠️ THE GATE IS `owedEntryIds` (queued OR inflight), not `queuedEntryIds`. An
// `inflight` item is the dangerous half: a frame is out with its answer
// outstanding, which is exactly the moment a user reaches for resend.
//
// ⚠️ REVERSE CONTROL — run RED against the pre-card dispatch
// (`entry.isImage ? outboxResendImage(c, entry) : c.reInject(entry)`); output in
// the worker's report.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    store = newTestStore();
    outboxStore = newTestOutboxStore();
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
  late final OutboxStore outboxStore;
  late final ChatController controller;

  Future<TimelineEntry> seedOwedTextDelivery({
    required bool connected,
  }) async {
    // Pair for real: the queue REFUSES an enqueue with no redeemable
    // destination (`_hasRedeemableDestination`), so an unpaired harness would be
    // testing that guard instead of the resend dispatch.
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-f7-resend-0000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    await session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://192.0.2.5:41879',
    );
    transport.pushStatus(
      connected ? SocketStatus.connected : SocketStatus.disconnected,
    );
    await pumpEventQueue();
    final TimelineEntry row = store.buildFromUtterance(
      clientId: 'u-owed',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '这一句还欠着',
    );
    // The delivery this row is about, already on disk and still owed — exactly
    // the state a drain that has not succeeded yet leaves behind.
    final OutboxItem? item = await controller.outbox.enqueueText(
      requestId: 'u-owed',
      entryId: row.id,
      wireEntryId: row.id,
      source: 'manual',
      text: '这一句还欠着',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 8, 4, 9, 15),
    );
    expect(item, isNotNull, reason: 'setup: the queue must have taken it');
    return row;
  }
}

void main() {
  test('resend on a still-owed text row does NOT mint a second delivery',
      () async {
    final _Harness h = _Harness();
    // 🔴 LINK UP ON PURPOSE. With the link known down, `runReInject` returns at
    // its own `canCompose` gate BEFORE enqueuing, so the pre-card code minted
    // nothing and this test would have been green against the defect — a test
    // that agrees with the bug. Measured, not assumed: the reverse-control run
    // with `connected: false` failed only on `lastResentAt`, and the item count
    // stayed at 1. The duplicate is minted exactly when the user can see the
    // link is fine, which is also when they press the button.
    final TimelineEntry row = await h.seedOwedTextDelivery(connected: true);
    expect(h.controller.outbox.owedEntryIds, contains(row.id));

    h.controller.resendEntry(row);
    await pumpEventQueue();

    final List<OutboxItem> all = await h.outboxStore.loadAll();
    expect(
      all.length,
      1,
      reason: 'one sentence, one delivery — a second item is a second paste',
    );
    expect(
      all.single.requestId,
      'u-owed',
      reason: 'the frozen request_id (gate 1) is what makes a retry idempotent',
    );
    expect(
      all.single.createdAt,
      DateTime.utc(2026, 8, 4, 9, 15),
      reason: 'gate 3: a drain is a FIRST delivery however long it waited',
    );
    // The ACT is still recorded — the row goes back to waiting and gains its
    // "last resent" instant, identical to the picture path.
    expect(h.store.findById(row.id)!.lastResentAt, isNotNull);
  });

  test('resend on a row the queue does NOT owe still mints a fresh deferred resend', () async {
    // 🔴 THE NEGATIVE CONTROL. `runReInject` is the right action when the
    // previous delivery is OVER: fresh `request_id`, `created_at: now`, and — by
    // RV-72 — a NEW row on the PC. Without this assertion, 「we fixed it by
    // disabling the button」 would look exactly like the fix.
    final _Harness h = _Harness();
    final TimelineEntry row = await h.seedOwedTextDelivery(connected: true);
    // The PC answered: this delivery is finished and nothing is owed.
    await h.controller.outbox.settle(correlationId: 'u-owed', ok: true);
    expect(h.controller.outbox.owedEntryIds, isNot(contains(row.id)));

    h.controller.resendEntry(row);
    await pumpEventQueue();

    final List<OutboxItem> all = await h.outboxStore.loadAll();
    expect(
      all.length,
      2,
      reason: 'a deferred resend of a finished delivery IS a new delivery (RV-72)',
    );
    expect(
      all.where((OutboxItem i) => i.requestId != 'u-owed').single.entryId,
      row.id,
      reason: 'the new delivery is about this row',
    );
  });
}

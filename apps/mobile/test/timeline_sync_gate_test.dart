// 0.2.27 acceptance — what is LEFT of TimelineSyncGate, and the new probe.
//
// WHAT THIS FILE USED TO BE: the WP-R3-2 noted emit-side filter (R1-1 ruling —
// a 「仅记录」 row does not emit `history:create` unless the device-local toggle is
// on) plus two thin-emit frame-shape guards. All three subjects are retired with
// the history uplink (owner architecture ruling,
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md): `shouldSync`,
// `onEntryBuilt`, `pushEdit` and `emitInject` no longer exist, and §4.0 C is now
// structural (nothing about a row leaves the phone). The runtime proof that no
// uplink survives lives in timeline_edit_sync_test.dart, over the real controller.
//
// WHAT IT IS NOW: the acceptance for card A1 item 4 — the delivery paths' link
// probe changed CARRIER, from `history:list` (an event the server now refuses) to
// `heartbeat` (the event whose one job is liveness, 04 §3.2). The card's hard
// requirement is 「must actually prove the link is alive; must not be replaced by something that counts 『we emitted』 as success」, so the
// criterion is asserted in all four directions: an authenticated ok, an error ack,
// a shapeless ack, and silence.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.2;
//   apps/server-core/src/socket/handlers/heartbeat.handler.ts (the consumer that
//   makes an ok:true mean 「the server wrote a row for THIS socket and answered」).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

void main() {
  group('probeLink (card A1 ④ — the delivery link gate)', () {
    test('rides `heartbeat`, and never the retired `history:list`', () async {
      final FakeSocketTransport t = FakeSocketTransport();
      final TimelineSyncGate gate = TimelineSyncGate(transport: t);

      expect(await gate.probeLink(), isTrue);
      expect(t.emittedNames, <String>[FlowMicEvents.heartbeat]);
      // The old carrier is now answered `HISTORY_SYNC_RETIRED` by the server, so
      // probing on it would have been measuring a refusal — and the card forbids
      // probing liveness on a retired event outright.
      expect(t.emittedNames, isNot(contains(FlowMicEvents.historyList)));
      // HeartbeatSchema is `{ts:int}` — the frame has to parse at the server's zod
      // boundary or the ack we are reading would never exist.
      final Object? frame = t.emittedWhere(FlowMicEvents.heartbeat).single.data;
      expect(frame, isA<Map<String, Object?>>());
      expect((frame! as Map<String, Object?>)['ts'], isA<int>());
      await t.close();
    });

    test('ok:true is the criterion — an ERROR ack is not proof of a usable link',
        () async {
      // Deliberately narrower than the old 「any ack proves the round trip」.
      // AUTH_TOKEN_INVALID is the only error heartbeat.handler can produce, and it
      // means the pipe is up but this socket cannot deliver anything — for which
      // the caller's response (kick, let the ladder re-auth) is the correct one.
      final FakeSocketTransport t = FakeSocketTransport();
      final TimelineSyncGate gate = TimelineSyncGate(transport: t);
      t.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});

      expect(await gate.probeLink(), isFalse);
      await t.close();
    });

    test('a shapeless ack is NOT a pass — 「something came back」 is not 「the '
        'server handled it」', () async {
      final FakeSocketTransport t = FakeSocketTransport();
      final TimelineSyncGate gate = TimelineSyncGate(transport: t);
      t.ackQueue.add(<String, Object?>{});
      expect(await gate.probeLink(), isFalse);

      t.ackQueue.add(null);
      expect(await gate.probeLink(), isFalse);
      await t.close();
    });

    test('no answer at all is a false — the dead-but-undetected link this probe '
        'exists for', () async {
      final FakeSocketTransport t = FakeSocketTransport();
      final TimelineSyncGate gate = TimelineSyncGate(transport: t);
      // `failEmits` makes the acked emit THROW, which is the same code path the
      // real transport takes on its ack timeout (SocketCore completes the future
      // with a TimeoutException) — the RCA-v3 case where the OS severed the TCP
      // and socket.io keeps believing for up to 30 s. Deliberately not simulated
      // with a never-completing future: the fake ignores the timeout argument, so
      // that would hang the suite instead of testing it.
      t.failEmits = true;

      expect(await gate.probeLink(), isFalse);
      await t.close();
    });
  });

  group('wireItem (the http image ingress body)', () {
    test('still produces a parseable history item — the POST /api/inject/image '
        'body carries one, so this outlived the socket create', () {
      final FakeSocketTransport t = FakeSocketTransport();
      final TimelineSyncGate gate = TimelineSyncGate(transport: t);
      final TimelineStore store = newTestStore();
      final TimelineEntry row = store.buildFromUtterance(
        clientId: 'c-img',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '[图片] PNG 12 KB',
        entryType: TimelineEntry.kImage,
      );

      final Map<String, Object?> item = gate.wireItem(row);
      expect(item['id'], row.id);
      expect(item['output_text'], '[图片] PNG 12 KB');
      // red line: the immutable original never rides a wire field that could be
      // written back — HistoryItemSchema keeps it, the update event never did.
      expect(item.containsKey('source_text'), isTrue);
      // ⚠️ Known open item (reported, not silently patched): RoomIdentity has no
      // production setter, so these two are the constructor sentinels on every
      // real device. It has never shown because the server re-stamps identity
      // from the verified token.
      expect(item['user_id'], 'local');
      expect(item['pc_device_id'], 'standalone-pc');
      store.dispose();
    });
  });
}

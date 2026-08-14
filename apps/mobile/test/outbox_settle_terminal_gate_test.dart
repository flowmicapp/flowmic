// Card F11 ① — `outboxSettle` had no terminal-state gate.
//
// WHAT IS BEING PINNED, in one sentence: a delivery that is ALREADY ANSWERED
// must not be moved by a second answer. Every branch of `outboxSettle` writes a
// state unconditionally, so before this card a late or duplicate `inject:result`
// re-decided a settled item — `delivered` → `queued` on any retryable code (the
// queue then delivers a sentence that already landed, twice on the PC, and the
// row's 「已投递」 goes back to 「待投递」), and a named terminal → `queued`, undoing
// the 「must not retry forever」 stop.
//
// 🔴 THE PRODUCERS ARE REAL, not hypothetical:
//   · the desktop's INJ-3 dedup CACHES a verdict per `request_id` and REPLAYS it
//     for a repeat of that id (`socket/dedup.rs` — `classify()` looks it up for
//     every source now, `record()` caches for every source);
//   · the queue re-sends under the id it was born with, on purpose (gate 1), so a
//     repeat is the designed behaviour rather than an accident;
//   · the relay can answer a frame the PC also answers (`relay.handler.ts`
//     `answerReject`), so two verdicts for one frame is a shape the wire allows.
//
// ⚠️ REVERSE CONTROL — this suite was run RED against the pre-card code by
// deleting the `if (item.isTerminal)` block in
// `lib/src/session/delivery_outbox_settle.dart`; the output is pasted in the
// worker's report. Both cases fail there, in the direction the card describes.

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;
import 'package:flutter_test/flutter_test.dart';

const String _machine = 'machine-uid-AAAA';
const String _pcId = 'pc-A-lan';
const String _pairing = 'standalone|instance:inst-A-lan';

const LiveConnection _live = LiveConnection(
  machineUid: _machine,
  pairingIdentity: _pairing,
  pcId: _pcId,
  channel: ServerChannel.lan,
);

class _FakeHost implements OutboxDrainHost {
  int sends = 0;

  @override
  LiveConnection get liveConnection => _live;

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
    sends++;
    return true;
  }

  @override
  void onOutboxChanged() {}
}

void main() {
  late InMemoryOutboxStore store;
  late _FakeHost host;
  late DeliveryOutbox box;

  setUp(() {
    store = InMemoryOutboxStore();
    host = _FakeHost();
    box = DeliveryOutbox(
      store: store,
      blobs: InMemoryOutboxBlobStore(),
      host: host,
    );
  });

  Future<OutboxItem> enqueueAndSend() async {
    final OutboxItem? item = await box.enqueueText(
      requestId: 'm0-1',
      entryId: 'loc_m0-1',
      wireEntryId: 'loc_m0-1',
      source: 'manual',
      text: 'hello pc',
      mode: 'realtime',
      createdAt: DateTime.utc(2026, 8, 4, 9, 15),
    );
    expect(item, isNotNull);
    await box.drain();
    expect(host.sends, 1, reason: 'the fixture must have put it on the wire');
    return item!;
  }

  Future<OutboxItem> reload(String requestId) async {
    final OutboxItem? found = await store.findByRequestId(requestId);
    expect(found, isNotNull);
    return found!;
  }

  test('a delivered item is NOT dragged back to queued by a late verdict',
      () async {
    await enqueueAndSend();
    // The PC's own answer: it landed. Terminal, and the only state a remote
    // success may reach.
    await box.settle(correlationId: 'm0-1', ok: true);
    expect((await reload('m0-1')).state, OutboxDeliveryState.delivered);

    // A SECOND answer for the same delivery — the shape INJ-3's replay and the
    // relay's own refusal both produce. Retryable code on purpose: that is the
    // branch that used to write `queued`.
    await box.settle(
      correlationId: 'm0-1',
      ok: false,
      code: 'INJECT_NO_RESULT',
    );

    final OutboxItem after = await reload('m0-1');
    expect(
      after.state,
      OutboxDeliveryState.delivered,
      reason: 'a late verdict must not re-open a delivery the PC confirmed',
    );
    // The stronger half of the same fact: it must not be in the queue's own
    // 「still owed」 answer either, or the next drain re-delivers the sentence.
    expect(box.owedEntryIds, isNot(contains('loc_m0-1')));
    expect(box.queuedEntryIds, isNot(contains('loc_m0-1')));
  });

  test('a named terminal refusal is NOT re-opened by a later retryable code',
      () async {
    await enqueueAndSend();
    // red-line signal: the server refused a frame addressed to a PC this connection
    // is not bound to. Terminal by `isTerminalRefusalCode` clause ②, precisely so
    // it can never be retried into an eventual silent success.
    await box.settle(
      correlationId: 'm0-1',
      ok: false,
      code: 'INJECT_PC_MISMATCH',
    );
    final OutboxItem refused = await reload('m0-1');
    expect(refused.state, OutboxDeliveryState.refused);
    expect(refused.refusedCode, 'INJECT_PC_MISMATCH');

    await box.settle(correlationId: 'm0-1', ok: false, code: 'PC_BUSY');

    final OutboxItem after = await reload('m0-1');
    expect(
      after.state,
      OutboxDeliveryState.refused,
      reason: 'the 「must not retry forever」 stop must survive a second, softer answer',
    );
    expect(
      after.refusedCode,
      'INJECT_PC_MISMATCH',
      reason: 'the red-line code is the evidence; it must not be overwritten',
    );
    expect(box.owedEntryIds, isNot(contains('loc_m0-1')));
  });
}

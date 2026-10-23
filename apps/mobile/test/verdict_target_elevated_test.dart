// INJECT_TARGET_ELEVATED (Windows, 2026-10-16) — the queue semantics, as BEHAVIOUR.
//
// The PC refuses before touching focus, clipboard or keyboard when the window in
// front runs at a higher integrity level than FlowMic (`inject/uipi.rs`
// `refusal_for`, `mode: Cached`). MAIN ruled it TERMINAL for the outbox: an
// elevated window does not lower itself, and an automatic re-send after the user
// moved to another window would type the sentence into a window they never spoke
// to.
//
// 🔴 WHAT HAS TO BE PROVEN: (1) the frame counts as DELIVERED — the PC received it
// and minted its row, so 「pending delivery」 would be the 0.2.48 P0 shape; (2) it
// is never re-sent by a drain. The positive control is an unknown code through the
// SAME harness — that is the behaviour of a phone that does not know this code
// (0.3.107), and it must requeue AND re-send, or a green run here proves nothing.
//
// ⚠️ This is Dart on a Windows gate: it covers the mapping and the queue. The real
// trigger (a Medium FlowMic aimed at a High window) is the desktop rig's job
// (docs/strategy/2026-10-16-uipi-silent-inject-design.md §6.5).
//
// SPEC-REF:
//   docs/rebuild/15-INJECTION-PERMISSION.md (cause ⑥)
//   packages/protocol/src/inject-verdict-authorship.ts (INJECT_TARGET_ELEVATED)

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_inject_authorship.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

const String kTargetElevated = 'INJECT_TARGET_ELEVATED';

/// Stands in for "a code this build has never heard of" — the old-phone path.
const String kUnknownToThisBuild = 'INJECT_NOT_A_REGISTERED_CODE';

const LiveConnection _kOnLan = LiveConnection(
  machineUid: 'machine-uid-WIN',
  pairingIdentity: 'standalone|instance:inst-win',
  pcId: 'pc-win-lan',
  channel: ServerChannel.lan,
);

class _Host implements OutboxDrainHost {
  final List<OutboxItem> sent = <OutboxItem>[];

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
    sent.add(item);
    return true;
  }

  @override
  void onOutboxChanged() {}
}

/// One fresh utterance (age zero ⇒ inside the live window, the case where a
/// re-send WOULD be typed), drained once and answered once with [code].
Future<({_Host host, OutboxStore store, DeliveryOutbox box})> _deliverAndAnswer(
  String code,
) async {
  final _Host host = _Host();
  final OutboxStore store = InMemoryOutboxStore();
  final DeliveryOutbox box = DeliveryOutbox(
    store: store,
    blobs: InMemoryOutboxBlobStore(),
    host: host,
    retryLinkUp: () => false,
    capacity: kOutboxCapacity,
    inflightTimeout: kOutboxInflightTimeout,
  );
  await box.enqueueText(
    requestId: 'r1',
    entryId: 'loc_r1',
    wireEntryId: 'loc_r1',
    source: 'stt',
    text: 'hello computer',
    mode: 'realtime',
    createdAt: DateTime.now().toUtc(),
  );
  await box.drain();
  await box.settle(correlationId: 'r1', ok: false, code: code);
  return (host: host, store: store, box: box);
}

void main() {
  group('INJECT_TARGET_ELEVATED · delivered and terminal', () {
    test('it is a PC injection verdict and NOT a transient one', () {
      expect(isPcInjectionVerdictCode(kTargetElevated), isTrue);
      expect(isTransientInjectionVerdictCode(kTargetElevated), isFalse);
      expect(kTransientInjectionVerdictCodes, isNot(contains(kTargetElevated)));
      // Delivered, not refused: `refused` would say 「not delivered」 about a frame
      // the PC received and minted a row for.
      expect(isTerminalRefusalCode(kTargetElevated), isFalse);
    });

    test(
      '🔴 a fresh utterance settles DELIVERED (terminal) and the next drain sends '
      'nothing — while an unknown code (the old-phone path) requeues and re-sends',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) elevated =
            await _deliverAndAnswer(kTargetElevated);
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) unknown =
            await _deliverAndAnswer(kUnknownToThisBuild);

        final OutboxItem afterElevated =
            (await elevated.store.findByRequestId('r1'))!;
        final OutboxItem afterUnknown =
            (await unknown.store.findByRequestId('r1'))!;

        // 🔴 Positive control FIRST: the harness can see a requeue.
        expect(afterUnknown.state, OutboxDeliveryState.queued);
        expect(afterUnknown.isTerminal, isFalse);

        expect(afterElevated.state, OutboxDeliveryState.delivered);
        expect(afterElevated.isTerminal, isTrue);
        expect(afterElevated.state, isNot(OutboxDeliveryState.refused));

        expect(elevated.host.sent.length, 1);
        expect(unknown.host.sent.length, 1);
        await elevated.box.drain();
        await unknown.box.drain();
        // Positive control: an unknown code goes out again under the same id.
        expect(unknown.host.sent.length, 2);
        expect(unknown.host.sent[1].requestId, unknown.host.sent[0].requestId);
        expect(
          elevated.host.sent.length,
          1,
          reason: 'MAIN 2026-10-16: no automatic retry — a re-send after the user '
              'moved on would type the sentence into whatever is in front',
        );

        elevated.box.dispose();
        unknown.box.dispose();
      },
    );
  });
}

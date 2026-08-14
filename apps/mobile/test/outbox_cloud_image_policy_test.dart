// Card B4-17 acceptance — book 15 §6 G-14: the QUEUE obeys owner's cloud image
// policy, and cannot spin on the relay's refusal of it.
//
// WHAT THIS FILE PROVES, and (as this repo requires) what it does NOT:
//
//  · the judgement itself — 「>1 MiB picture + cloud (or unprobeable) ⇒ hold」 — including
//    both boundary sides and the fail-closed reading of an unknown channel;
//  · the DRAIN behaviour: nothing on the wire, item stays `queued` with a named
//    reason, `attempts` untouched (⇒ not one relay round trip spent), and the
//    same item drains by itself the moment the phone is back on the LAN;
//  · that text deliveries and under-cap pictures are untouched on either leg.
//
//  ⛔ It does NOT prove the RELAY would have refused the frame — that is
//    `apps/server-core/test/cloud-image-policy.test.ts` plus golden G15, on the
//    other side of the wire. It also does NOT prove the phone MEASURES the
//    channel correctly; `LiveConnection.channel` is handed in here, and the
//    production producer (`session.serverChannel`) is `ptt_session`'s own.
//  ⛔ SIM-MOBILE: this is a unit suite, so it says nothing about a real handset
//    walking out of a building. real-device unproven.
//
// 🔴 ONE REVERSE CONTROL lives here (marked ⟲) and WAS RUN RED before being left
// green — the captured output is in the card report.

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/image_payload.dart'
    show kCloudImageBytesMax;
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_cloud_image_policy.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;

const String kMachine = 'machine-uid-AAAA';

// 🔴 ONE computer, TWO channels — the shape the whole ruling is about. Note the
// pairing prefixes ('standalone|' / 'saas|') deliberately AGREE with `channel`
// in the first two and DISAGREE in `kOnLanButMislabelled`: the queue must read
// the MEASURED field, and that fixture is what makes the difference observable.
const LiveConnection kOnLan = LiveConnection(
  machineUid: kMachine,
  pairingIdentity: 'standalone|instance:inst-lan',
  pcId: 'pc-lan',
  channel: ServerChannel.lan,
);
const LiveConnection kOnCloud = LiveConnection(
  machineUid: kMachine,
  pairingIdentity: 'saas|instance:inst-cloud',
  pcId: 'pc-cloud',
  channel: ServerChannel.cloudRelay,
);
/// The RV-89 shape: connected, addressable, but `/api/health` never answered, so
/// nobody can prove this is the LAN. Fail-closed ⇒ treated as cloud.
const LiveConnection kOnUnknown = LiveConnection(
  machineUid: kMachine,
  pairingIdentity: 'standalone|instance:inst-lan',
  pcId: 'pc-lan',
  channel: null,
);

/// A pairing whose STORED channel word says 'saas' while the measured answer is
/// LAN — i.e. exactly what `_inferChannel` / `cloudInstance` get wrong. If the
/// queue ever goes back to reading the prefix, the picture below stops being
/// delivered on a perfectly good LAN link.
const LiveConnection kOnLanButMislabelled = LiveConnection(
  machineUid: kMachine,
  pairingIdentity: 'saas|instance:inst-lan',
  pcId: 'pc-lan',
  channel: ServerChannel.lan,
);

Uint8List _bytes(int n) => Uint8List.fromList(List<int>.filled(n, 0x41));

class _Sent {
  _Sent(this.item, this.imageBytes);
  final OutboxItem item;
  final Uint8List? imageBytes;
}

class _Host implements OutboxDrainHost {
  /// 🔴 L8 — the stamp the queue handed this send.
  InjectOrigin? lastOrigin;

  _Host(this._connection);
  LiveConnection _connection;
  set connectionIs(LiveConnection c) => _connection = c;

  final List<_Sent> sends = <_Sent>[];

  @override
  LiveConnection get liveConnection => _connection;
  @override
  Future<bool> ensureLink() async => true;
  @override
  Future<void> reseedDestination() async {}
  @override
  Future<bool> send(
    OutboxItem i,
    String pc, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    lastOrigin = origin;
    sends.add(_Sent(i, imageBytes));
    return true;
  }

  @override
  void onOutboxChanged() {}
}

DeliveryOutbox _outbox(_Host host, OutboxStore store, OutboxBlobStore blobs) =>
    DeliveryOutbox(store: store, blobs: blobs, host: host);

Future<OutboxItem?> _enqueueImage(
  DeliveryOutbox box, {
  required String requestId,
  required int size,
}) => box.enqueueImage(
  requestId: requestId,
  entryId: 'row-$requestId',
  bytes: _bytes(size),
  imageMime: 'image/jpeg',
  extension: 'jpg',
  label: '🖼 JPEG',
  mode: 'realtime',
  createdAt: DateTime.utc(2026, 8, 1, 9),
);

void main() {
  group('the judgement itself — cloudImagePolicyHold', () {
    test('a text item (no bytes) is unconstrained by this policy on any channel', () {
      for (final ServerChannel? ch in <ServerChannel?>[
        ServerChannel.lan,
        ServerChannel.cloudRelay,
        null,
      ]) {
        expect(cloudImagePolicyHold(byteLength: null, channel: ch), isNull,
            reason: 'channel=$ch');
      }
    });

    test('on LAN, no picture is held no matter the size (LAN has its own 5.2M b64 budget, not this rule)', () {
      expect(
        cloudImagePolicyHold(
          byteLength: 3900000,
          channel: ServerChannel.lan,
        ),
        isNull,
      );
    });

    test('🔴 both sides of the boundary: exactly 1 MiB is let through, +1 byte is held (same shape as the server\'s `>`)', () {
      expect(
        cloudImagePolicyHold(
          byteLength: kCloudImageBytesMax,
          channel: ServerChannel.cloudRelay,
        ),
        isNull,
        reason: 'the one that is exactly at the cap, the relay will accept',
      );
      expect(
        cloudImagePolicyHold(
          byteLength: kCloudImageBytesMax + 1,
          channel: ServerChannel.cloudRelay,
        ),
        const OutboxAddressRefused(OutboxAddressRefusal.cloudImageOverCap),
      );
    });

    test('🔴 fail-closed: when the channel cannot be probed, treat it as cloud', () {
      expect(
        cloudImagePolicyHold(
          byteLength: kCloudImageBytesMax + 1,
          channel: null,
        ),
        const OutboxAddressRefused(OutboxAddressRefusal.cloudImageOverCap),
        reason: '「don\'t know」 must not be read as 「so it is LAN」 — the cost of guessing wrong is the original hitting the relay',
      );
    });
  });

  group('drain — G-14', () {
    late InMemoryOutboxStore store;
    late InMemoryOutboxBlobStore blobs;

    setUp(() {
      store = InMemoryOutboxStore();
      blobs = InMemoryOutboxBlobStore();
    });

    // ⟲ REVERSE CONTROL ───────────────────────────────────────────────────────
    // Delete the `cloudImagePolicyHold(...) ??` clause in `_attempt` and this
    // test goes red on its FIRST assertion: the original's bytes leave for the
    // relay, which is precisely G-14.
    test('⟲ reverse control: an original enqueued on LAN, recovered while on cloud ⇒ not one byte may leave via the cloud',
        () async {
      final _Host host = _Host(kOnLan);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      // Enqueued on the LAN, where the original is legitimately on offer: 3.9 MB, the
      // LAN budget's own ceiling. Nothing about the item says 「original」 — the rule
      // is about bytes on a channel, which is why this is the honest fixture.
      await _enqueueImage(box, requestId: 'orig-1', size: 3900000);

      // The link came back on the RELAY.
      host.connectionIs = kOnCloud;
      final OutboxDrainReport r = await box.drain();

      // Negative half.
      expect(host.sends, isEmpty,
          reason: '🔴 G-14: original bytes went out via the cloud');
      expect(r.sent, 0);
      // Positive companion (a zero must not be a blind probe): the drain really
      // ran, really considered this item, and named why it stayed.
      expect(r.attempted, 1);
      expect(r.linkOk, isTrue);
      expect(r.held['orig-1'], OutboxAddressRefusal.cloudImageOverCap);

      // …and it is HELD, not settled: still pending, still counted, and the
      // reason is on disk for 「why is this one still in the queue」.
      final OutboxItem held = (await store.findByRequestId('orig-1'))!;
      expect(held.state, OutboxDeliveryState.queued);
      expect(held.refusedCode, isNull, reason: 'a hold is not a terminal state');
      expect(held.lastRefusalNote, 'cloudImageOverCap');
      expect(box.pendingCountTotal, 1);

      // …and it drains BY ITSELF the moment the phone is back on its own LAN.
      // This is the whole disposition: wait until back on LAN and it drains by itself, nothing asked of the
      // user, nothing re-compressed.
      host.connectionIs = kOnLan;
      final OutboxDrainReport r2 = await box.drain();
      expect(r2.sent, 1);
      expect(host.sends.single.imageBytes!.length, 3900000,
          reason: '🔴 what goes out must be the original bytes, not a down-scaled recompress');
    });

    test('🔴 the refusal loop is gone: repeated drains on cloud spend not one relay round trip', () async {
      final _Host host = _Host(kOnCloud);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await _enqueueImage(box, requestId: 'loop-1', size: 3900000);

      for (int i = 0; i < 3; i++) {
        await box.drain();
      }

      expect(host.sends, isEmpty);
      // 🔴 THE LOOP ASSERTION. `attempts` only increments at the `inflight`
      // flip, so 0 after three drains proves the item was never handed to the
      // transport — no frame built, no relay connection spent, no
      // INJECT_CLOUD_IMAGE_TOO_LARGE round trip to answer. That is owner's own
      // stated reason for wanting a phone-side gate:「节约服务器的连接」.
      final OutboxItem held = (await store.findByRequestId('loop-1'))!;
      expect(held.attempts, 0);
      expect(held.state, OutboxDeliveryState.queued);
    });

    test('a small picture on cloud is delivered as usual (this rule only touches the over-cap ones)', () async {
      final _Host host = _Host(kOnCloud);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await _enqueueImage(box, requestId: 'small-1', size: 200000);
      final OutboxDrainReport r = await box.drain();
      expect(r.sent, 1);
      expect(host.sends.single.imageBytes!.length, 200000);
    });

    test('a text item on cloud is delivered as usual, no matter how long', () async {
      final _Host host = _Host(kOnCloud);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await box.enqueueText(
        requestId: 'text-1',
        entryId: 'row-text-1',
        wireEntryId: 'row-text-1',
        source: 'manual',
        text: 'x' * (kCloudImageBytesMax + 1),
        mode: 'realtime',
        createdAt: DateTime.utc(2026, 8, 1, 9),
      );
      final OutboxDrainReport r = await box.drain();
      expect(r.sent, 1, reason: 'owner\'s ruling is about pictures and traffic cost, not about long sentences');
      expect(host.sends.single.imageBytes, isNull);
    });

    // 🔴 THE FIXTURE THAT CATCHES A RE-DERIVATION FROM `pairingIdentity`.
    test('🔴 the criterion is the measured channel, not the word in the pairing prefix', () async {
      final _Host host = _Host(kOnLanButMislabelled);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await _enqueueImage(box, requestId: 'label-1', size: 3900000);
      final OutboxDrainReport r = await box.drain();
      expect(
        r.sent,
        1,
        reason: '🔴 pairing says saas, but /api/health says this is standalone. '
            'Reading the prefix ⇒ this picture is held forever on a perfectly usable LAN link',
      );
    });

    test('🔴 when the channel cannot be probed, an over-cap picture is held on the drain side too (the same fail-closed as the send side)',
        () async {
      final _Host host = _Host(kOnUnknown);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await _enqueueImage(box, requestId: 'unk-1', size: 3900000);
      final OutboxDrainReport r = await box.drain();
      expect(host.sends, isEmpty);
      expect(r.held['unk-1'], OutboxAddressRefusal.cloudImageOverCap);
    });

    // 「cannot send」 and 「must not send」 must not collapse into one answer — the two
    // reasons are what a crosstalk investigation reads.
    test('🔴 connected to a different machine ⇒ the reason is still differentMachine, not a policy hold', () async {
      final _Host host = _Host(kOnLan);
      final DeliveryOutbox box = _outbox(host, store, blobs);
      await _enqueueImage(box, requestId: 'other-1', size: 3900000);
      host.connectionIs = const LiveConnection(
        machineUid: 'machine-uid-BBBB',
        pairingIdentity: 'saas|instance:inst-B',
        pcId: 'pc-B-cloud',
        channel: ServerChannel.cloudRelay,
      );
      final OutboxDrainReport r = await box.drain();
      expect(host.sends, isEmpty);
      expect(r.held['other-1'], OutboxAddressRefusal.differentMachine);
    });
  });
}

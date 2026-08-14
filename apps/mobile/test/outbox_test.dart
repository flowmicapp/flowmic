// Window B3-2a acceptance — the mobile persistent delivery outbox.
//
// WHAT EACH GROUP PROVES, and (as required by the card) what it does NOT:
//
//  · Gate 2 (destination) — proves the ADDRESSING LOGIC cannot send a queued
//    delivery to a machine other than the one frozen at enqueue, including the
//    case that motivated the whole ruling (same computer, other channel, so the
//    `pc_id` legitimately differs). It does NOT prove the server accepts the
//    stamped value — only a real two-machine run can, see the report's
//    real-end run.
//  · Gate 1 (request_id) — proves the id is minted once and re-sent unchanged
//    across drain attempts. It does NOT prove the desktop dedups on it (that is
//    INJ-3's own test, on the other side of the wire).
//  · Gate 3 (created_at) — proves a drain carries the SPEAKING instant, never
//    "now". It does NOT prove the PC sorts by it (desktop card).
//  · FSM — proves nothing can stop at `inflight` and that a terminal refusal is
//    always named. It does NOT prove the codes match the server's spelling
//    (that is a protocol-level contract test).
//
// 🔴 TWO REVERSE CONTROLS live here (marked ⟲). Both were RUN RED before being
// left green — see the delivery report for the captured output.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_failure_text.dart';
import 'package:flowmic/src/session/outbox_inject_origin.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show InjectOrigin;

// Card L8 800-line cap — the fixtures and the fake drain host moved VERBATIM to
// outbox_test_harness.dart (a `part` of THIS file, so nothing had to be renamed
// and nothing became public). See that file's header.
part 'outbox_test_harness.dart';
// Card G-9 1200-line test cap — the REAL-SQL group (DDL / migration / round-trip on
// sqflite_common_ffi) moved VERBATIM out, same `part` discipline. See its header.
part 'outbox_test_sqlite.dart';

void main() {
  // ══════════════════════════════════════════════════════════════════════════
  group('Gate 2 — the destination is the "machine"; pc_id is only its alias on one channel', () {
    test('same machine, same channel ⇒ stamp this connection\'s pc_id', () {
      final OutboxAddress a = resolveOutboxTarget(
        destination: const OutboxDestination(
          machineUid: kMachineA,
          pairingIdentity: kPairALan,
          enqueuedPcId: kPcALan,
        ),
        connection: kOnALan,
      );
      expect(a, const OutboxAddressResolved(kPcALan));
    });

    test(
      '🔴 same machine, other channel ⇒ still send, and stamp the LIVE pc_id not the frozen one',
      () {
        // This is the case that sent the card back for a ruling: the frozen
        // alias (`kPcALan`) would be REFUSED by the cloud server, and refused as
        // a CROSSTALK — "reads as if crosstalk was blocked, when not a single id was crossed".
        final OutboxAddress a = resolveOutboxTarget(
          destination: const OutboxDestination(
            machineUid: kMachineA,
            pairingIdentity: kPairALan,
            enqueuedPcId: kPcALan,
          ),
          connection: kOnACloud,
        );
        expect(
          a,
          const OutboxAddressResolved(kPcACloud),
          reason: 'the destination is the MACHINE; the address is per-channel',
        );
      },
    );

    test('🔴 a different machine ⇒ refuse, never reroute', () {
      final OutboxAddress a = resolveOutboxTarget(
        destination: const OutboxDestination(
          machineUid: kMachineA,
          pairingIdentity: kPairALan,
          enqueuedPcId: kPcALan,
        ),
        connection: kOnBLan,
      );
      expect(
        a,
        const OutboxAddressRefused(OutboxAddressRefusal.differentMachine),
      );
    });

    test('🔴 the connection cannot say which machine it is ⇒ refuse ("unknown" must not be read as "it is this one")', () {
      final OutboxAddress a = resolveOutboxTarget(
        destination: const OutboxDestination(
          machineUid: kMachineA,
          pairingIdentity: kPairALan,
          enqueuedPcId: kPcALan,
        ),
        connection: const LiveConnection(
          machineUid: null,
          pairingIdentity: kPairALan,
          pcId: kPcALan, channel: ServerChannel.lan,
        ),
      );
      expect(
        a,
        const OutboxAddressRefused(OutboxAddressRefusal.differentMachine),
      );
    });

    test('legacy pairing with no machine_uid ⇒ drain only on the original pairing (Gate 2 rule 4)', () {
      const OutboxDestination legacy = OutboxDestination(
        machineUid: null,
        pairingIdentity: kPairALan,
        enqueuedPcId: kPcALan,
      );
      expect(
        resolveOutboxTarget(destination: legacy, connection: kOnALan),
        const OutboxAddressResolved(kPcALan),
      );
      // …and NOT on any other pairing, including another uid-less one — two rows
      // that both failed to report a machine are not thereby the same machine.
      expect(
        resolveOutboxTarget(
          destination: legacy,
          connection: const LiveConnection(
            machineUid: null,
            pairingIdentity: kPairBLan,
            pcId: kPcBLan, channel: ServerChannel.lan,
          ),
        ),
        const OutboxAddressRefused(OutboxAddressRefusal.legacyPairingMismatch),
      );
    });

    test('destination is right but the connection reports no pc_id ⇒ refuse rather than invent one', () {
      final OutboxAddress a = resolveOutboxTarget(
        destination: const OutboxDestination(
          machineUid: kMachineA,
          pairingIdentity: kPairALan,
          enqueuedPcId: kPcALan,
        ),
        connection: const LiveConnection(
          machineUid: kMachineA,
          pairingIdentity: kPairALan,
          pcId: null, channel: ServerChannel.lan,
        ),
      );
      expect(
        a,
        const OutboxAddressRefused(OutboxAddressRefusal.addressUnknown),
      );
    });

    // ⟲ REVERSE CONTROL #1 ────────────────────────────────────────────────────
    // "Drain uses the item's own target_pc_id; never derive it from 'who is connected now'".
    // Break `resolveOutboxTarget` to return the live pc_id unconditionally and
    // this test goes red on BOTH assertions.
    test('⟲ reverse control: enqueued for A, now connected to B ⇒ not one frame may leave', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box);

      // The phone is now talking to a DIFFERENT computer.
      host.connectionIs = kOnBLan;
      final OutboxDrainReport r = await box.drain();

      // Negative half: not one frame reached the wire.
      expect(host.sends, isEmpty, reason: '🔴 crosstalk: a frame left for machine B');
      expect(r.sent, 0);
      // Positive companion (the card's rule ②: a negative assertion needs a
      // positive control, or the zero might be a blind probe rather than a
      // correct implementation). The drain DID run and DID consider the item.
      expect(r.attempted, 1);
      expect(r.linkOk, isTrue);
      expect(
        r.held['m0-1'],
        OutboxAddressRefusal.differentMachine,
        reason: 'it must be HELD with a named reason, not dropped',
      );
      // …and it is still deliverable: reconnecting to its own machine sends it.
      host.connectionIs = kOnACloud;
      final OutboxDrainReport r2 = await box.drain();
      expect(r2.sent, 1);
      expect(host.sends.single.targetPcId, kPcACloud);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 The queue's whole reason to exist is the offline window, so the first
  // question asked of it must be: WHEN THE LINK IS DOWN, IS THE FROZEN
  // DESTINATION EMPTY? It is not — and the safety rests on a property nobody had
  // written down until this card: `PttSession.clearConnectedInstance()` (which
  // nulls all three identities) has exactly ONE caller in the repo,
  // `connections_controller.dart:307 leaveRoom()` — the user deliberately
  // leaving. A dropped socket / backgrounded app / EMUI-severed TCP do NOT call
  // it, so the identities survive the outage.
  //
  // These two tests PIN that property. `ptt_session.dart`'s
  // `clearConnectedInstance` names this group in a comment, so if someone later
  // calls it from a disconnect path, that comment is a greppable claim that
  // these tests falsify.
  group('an outage enqueue freezes a complete destination', () {
    test('link already down, session identity still there ⇒ enqueue freezes all three non-empty', () async {
      // The outage shape: the transport is down (so nothing can be sent), but
      // the session still knows who it is paired to.
      final _FakeHost host = _FakeHost(kOnALan)..linkOk = false;
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _outbox(host, store: store);

      final OutboxItem? item = await _enqueueOne(box, requestId: 'off-dest-1');
      expect(item, isNotNull, reason: 'an outage must not block enqueueing');

      final OutboxItem stored = (await store.findByRequestId('off-dest-1'))!;
      expect(stored.destinationMachineUid, kMachineA);
      expect(stored.destinationPairingIdentity, kPairALan);
      expect(stored.enqueuedPcId, kPcALan);
      // …and it really is undeliverable right now, which is the point: it waits
      // with a complete address rather than being lost.
      final OutboxDrainReport r = await box.drain();
      expect(r.sent, 0);
      expect(stored.state, OutboxDeliveryState.queued);
    });

    // ⟲ REVERSE CONTROL #3 — delete the `_hasRedeemableDestination` guard and
    // this goes red: the item is admitted with an empty destination, which is a
    // ticket that can never be redeemed (resolveOutboxTarget refuses it
    // forever) while still being counted as 「未投递」.
    test('⟲ reverse control: after leaveRoom (identities already cleared) ⇒ refuse enqueue and speak', () async {
      // What `clearConnectedInstance()` leaves behind: all three null.
      final _FakeHost host = _FakeHost(const LiveConnection(
        machineUid: null,
        pairingIdentity: null,
        pcId: null, channel: null, // leaveRoom also nulls the channel label
      ));
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _outbox(host, store: store);

      final OutboxItem? item = await _enqueueOne(box, requestId: 'no-dest-1');
      expect(
        item,
        isNull,
        reason: '🔴 an item with no destination is a ticket that never redeems',
      );
      // Positive control: nothing was written, so nothing is counted as pending
      // — the alternative (admitted-but-undeliverable) would inflate 「还有 N 条
      // 未投递」 forever.
      expect(await store.loadAll(), isEmpty);
      expect(box.pendingCountTotal, 0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  group('Gate 1 — request_id is minted once at enqueue and reused on retry', () {
    // ⟲ REVERSE CONTROL #2 ────────────────────────────────────────────────────
    // Re-mint at drain time and this goes red: the two attempts carry different
    // ids, which is precisely the flap that types one sentence twice.
    test('⟲ reverse control: two drain attempts must carry the same request_id', () async {
      final _FakeHost host = _FakeHost(kOnALan)..sendOk = false;
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'm7-42');

      await box.drain(); // attempt 1 — wire refuses, item returns to queued
      host.sendOk = true;
      await box.drain(); // attempt 2 — goes out

      expect(host.sends.length, 2);
      expect(
        host.sends[0].item.requestId,
        host.sends[1].item.requestId,
        reason: '🔴 a retry that re-mints its id is a duplicate delivery',
      );
      expect(host.sends[0].item.requestId, 'm7-42');
      // The attempt counter is the only thing that moved.
      expect(host.sends[0].item.attempts, 1);
      expect(host.sends[1].item.attempts, 2);
    });

    test('request_id is the primary key ⇒ one delivery can physically have only one row', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'dup-1');
      await _enqueueOne(box, requestId: 'dup-1');
      expect((await store.loadAll()).length, 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  group('Gate 3 — a drain = a first delivery ⇒ stamp the speaking instant', () {
    test('an item that sat in the queue for three days still carries the speaking instant when drained', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      final DateTime spoken = DateTime.utc(2026, 7, 25, 8);
      await _enqueueOne(box, createdAt: spoken);
      await box.drain();
      expect(host.sends.single.item.createdAt, spoken);
      // The guard that matters: it is NOT "now" (the deferred-delivery line's
      // stamp, which manual_delivery.dart explicitly tells window B2 not to copy).
      expect(
        host.sends.single.item.createdAt.isBefore(
          DateTime.now().toUtc().subtract(const Duration(days: 1)),
        ),
        isTrue,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  group('FSM — never stop at inflight; a terminal state must be named', () {
    test('drain order is reseed destination → probe live → then send (§3.5 reversed would invent a false failure)', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box);
      await box.drain();
      expect(host.trace, <String>['reseed', 'probe', 'send']);
    });

    test('probe fails ⇒ not one frame sent, and not one item judged failed', () async {
      final _FakeHost host = _FakeHost(kOnALan)..linkOk = false;
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box);
      final OutboxDrainReport r = await box.drain();
      expect(host.sends, isEmpty);
      expect(r.linkOk, isFalse);
      expect((await store.loadPending()).single.state, OutboxDeliveryState.queued);
    });

    test('PC says success ⇒ delivered (only inject:result can flip this card)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'ok-1');
      await box.drain();
      expect((await store.findByRequestId('ok-1'))!.state,
          OutboxDeliveryState.inflight);
      await box.settle(correlationId: 'ok-1', ok: true);
      expect((await store.findByRequestId('ok-1'))!.state,
          OutboxDeliveryState.delivered);
      expect(box.pendingCountTotal, 0);
      expect(box.pendingCountFor(kPairALan), 0);
    });

    test('🔴 INJECT_PC_MISMATCH ⇒ named terminal refused, no more retries (must not retry forever)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'mm-1');
      await box.drain();
      await box.settle(
        correlationId: 'mm-1',
        ok: false,
        code: 'INJECT_PC_MISMATCH',
      );
      final OutboxItem after = (await store.findByRequestId('mm-1'))!;
      expect(after.state, OutboxDeliveryState.refused);
      expect(after.refusedCode, 'INJECT_PC_MISMATCH');
      // The proof it is TERMINAL: another drain does not put it back on the wire.
      final int before = host.sends.length;
      await box.drain();
      expect(host.sends.length, before);
    });

    test('🔴 INJECT_PC_UNSPECIFIED ⇒ named terminal (0.2.33 protocol round 56→57)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'unspec-1');
      await box.drain();
      await box.settle(
        correlationId: 'unspec-1',
        ok: false,
        code: 'INJECT_PC_UNSPECIFIED',
      );
      final OutboxItem after = (await store.findByRequestId('unspec-1'))!;
      expect(after.state, OutboxDeliveryState.refused);
      expect(after.refusedCode, 'INJECT_PC_UNSPECIFIED');
      // Terminal ⇒ a later drain does NOT put it back on the wire. Without this
      // the code would fall through to `_ => false` and be retried forever —
      // exactly what the whitelist exists to prevent.
      final int before = host.sends.length;
      await box.drain();
      expect(host.sends.length, before);
    });

    test('whitelist: the three "not now" codes are not terminal', () {
      expect(isTerminalRefusalCode('INJECT_PC_UNSPECIFIED'), isTrue);
      expect(isTerminalRefusalCode('INJECT_PC_MISMATCH'), isTrue);
      for (final String transient in <String>[
        'INJECT_PC_OFFLINE',
        'PC_BUSY',
        'PC_UNREACHABLE',
        'INJECT_NO_RESULT',
      ]) {
        expect(
          isTerminalRefusalCode(transient),
          isFalse,
          reason: '$transient is "not now"; owner ruled it must keep waiting',
        );
      }
    });

    test('"not now" class of failure ⇒ back to queued (owner: deliver all of them no matter how long)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'off-1');
      await box.drain();
      await box.settle(
        correlationId: 'off-1',
        ok: false,
        code: 'INJECT_PC_OFFLINE',
      );
      expect((await store.findByRequestId('off-1'))!.state,
          OutboxDeliveryState.queued);
      expect(isTerminalRefusalCode('INJECT_PC_OFFLINE'), isFalse);
    });

    test('watchdog: no receipt ⇒ retreat from inflight to queued, never stop at inflight', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(
        host,
        store: store,
        inflight: const Duration(milliseconds: 30),
      );
      await _enqueueOne(box, requestId: 'wd-1');
      await box.drain();
      expect((await store.findByRequestId('wd-1'))!.state,
          OutboxDeliveryState.inflight);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      final OutboxItem after = (await store.findByRequestId('wd-1'))!;
      expect(after.state, OutboxDeliveryState.queued);
      expect(after.lastRefusalNote, 'INJECT_NO_RESULT');
      box.dispose();
    });

    test('restart: inflight left by the previous process is revived to queued, every one', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox first = _outbox(host, store: store);
      await _enqueueOne(first, requestId: 'boot-1');
      await first.drain();
      first.dispose(); // process dies with the item at inflight

      final DeliveryOutbox second = _outbox(_FakeHost(kOnALan), store: store);
      await second.load();
      final OutboxItem after = (await store.findByRequestId('boot-1'))!;
      expect(after.state, OutboxDeliveryState.queued);
      expect(after.lastRefusalNote, 'REVIVED_FROM_INFLIGHT_ON_BOOT');
      expect(second.pendingCountTotal, 1);
      // RV-91: and it comes back on the instance it was enqueued on, not on
      // whichever one happens to be open after the restart.
      expect(second.pendingCountFor(kPairALan), 1);
      expect(second.pendingCountFor(kPairBLan), 0);
    });

    test('refused must carry a named code (structurally impossible to have an anonymous terminal)', () {
      expect(
        () => OutboxItem(
          requestId: 'x',
          entryId: 'e',
          coveredEntryIds: const <String>['e'],
          kind: OutboxPayloadKind.text,
          source: 'manual',
          text: 't',
          mode: 'realtime',
          createdAt: kSpokenAt,
          enqueuedAt: kSpokenAt,
          destinationMachineUid: null,
          destinationPairingIdentity: null,
          enqueuedPcId: null,
        ).copyWith(state: OutboxDeliveryState.refused),
        throwsA(isA<AssertionError>()),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  group('capacity: overflow must speak, and after a restart must not degrade into "it was never there"', () {
    test('over the cap ⇒ the oldest item is kept as a named refused, not vanished', () async {
      DiagLog.instance.clear(); // process-level singleton: other cases' rows would mix in
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan)..linkOk = false;
      final DeliveryOutbox box = _outbox(host, store: store, capacity: 3);
      for (int i = 0; i < 5; i++) {
        await box.enqueueText(
          requestId: 'cap-$i',
          entryId: 'loc-$i',
          wireEntryId: 'loc-$i',
          source: 'manual',
          text: 'x',
          mode: 'realtime',
          createdAt: kSpokenAt.add(Duration(minutes: i)),
        );
      }
      expect(box.pendingCountTotal, 3);
      // Card G-9 ruling: the criterion moved from `box.overflowedCount` onto
      // the diag key `overflowed_total` — that public getter had zero
      // production consumers (the only reader was this line); the diag row
      // is `_overflowed`'s real consumer, the getter is deleted. ⚠️ It is a
      // process-level counter and zeros on restart; the durable answer lives
      // on the `OUTBOX_OVERFLOW` rows below. Do not mix the two.
      final String trail = DiagLog.instance.snapshot().join('\n');
      expect(trail, contains('overflowed_total=2'));
      // 🔴 The dropped ones are STILL THERE with a named terminal reason — that
      // is what makes "it was cleared" survive a restart instead of degrading into
      // "it was never there".
      final OutboxItem oldest = (await store.findByRequestId('cap-0'))!;
      expect(oldest.state, OutboxDeliveryState.refused);
      expect(oldest.refusedCode, 'OUTBOX_OVERFLOW');
      expect((await store.loadAll()).length, 5);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️⚠️ Original name "images: whether the bytes are there IS the fact of
  // whether it can be resent" — that was the rule of owner ①'s
  // "delete on successful delivery" era, revoked 2026-08-01 (RV-93). Bytes
  // now stay forever ⇒ "whether the bytes are there" is constantly true and
  // cannot answer "can it be resent"; the criterion moved onto **delivery
  // state**; the bytes half is left with only R8 (do not give a button that
  // does nothing when pressed). The name follows the fact; the old name
  // stays here as a correction.
  // The "a row can get its own full image without going through the queue"
  // group is in test/row_image_ownership_test.dart.
  group('images: resend only if delivery did not succeed; bytes belong to the row and do not vanish with delivery', () {
    final Uint8List png = Uint8List.fromList(<int>[1, 2, 3, 4]);

    Future<OutboxItem?> enqueueImage(
      DeliveryOutbox box,
      OutboxBlobStore blobs, {
      String requestId = 'i0-1',
    }) => box.enqueueImage(
      requestId: requestId,
      entryId: 'loc_$requestId',
      bytes: png,
      imageMime: 'image/png',
      extension: 'png',
      label: '🖼 PNG · 4 B',
      mode: 'realtime',
      createdAt: kSpokenAt,
      thumbB64: 'dGh1bWI=',
    );

    // 🔴 RV-93 —— ① after successful delivery the **bytes are still there**
    // (owner:「改为存下来」) and ② after successful delivery the **button is
    // gone** must live in the same test: asserting only ①, an
    // implementation that "deletes nothing and judges nothing" stays
    // green, and that is exactly the kind that would grow a resend button
    // on an already-delivered image.
    test('delivery succeeded: bytes stay (new rule), button gone (criterion moved onto delivery state)', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);

      final OutboxItem item = (await enqueueImage(box, blobs))!;
      expect(item.hasImageBytes, isTrue);
      expect(box.resendableImageEntryIds, contains('loc_i0-1'));
      expect(blobs.blobs.length, 1);

      await box.drain();
      await box.settle(correlationId: 'i0-1', ok: true);

      // ① Bytes belong to "that timeline row", not the queue — successful
      // delivery no longer releases them.
      expect(
        blobs.blobs.length,
        1,
        reason: 'owner 2026-08-01: delete-on-successful-delivery is revoked; the full image is left for 「点开大图」',
      );
      final OutboxItem settled = (await store.findByRequestId('i0-1'))!;
      expect(settled.state, OutboxDeliveryState.delivered);
      expect(settled.hasImageBytes, isTrue, reason: 'the path is no longer cleared either');
      // ② And the button must disappear — this is the easiest one to miss
      // this round: the bytes are still there, so the old criterion is
      // constantly true here; only the "already delivered" state criterion
      // can block it.
      expect(
        box.resendableImageEntryIds,
        isNot(contains('loc_i0-1')),
        reason: 'an already-delivered image row must never grow a resend button again (owner ruling)',
      );
    });

    test('image whose delivery did not succeed: bytes stay, still resendable', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, blobs: blobs);
      await enqueueImage(box, blobs);
      await box.drain();
      await box.settle(
        correlationId: 'i0-1',
        ok: false,
        code: 'INJECT_PC_OFFLINE',
      );
      expect(box.resendableImageEntryIds, contains('loc_i0-1'));
      expect(blobs.blobs.length, 1);
    });

    test('disk write fails ⇒ do not enqueue and speak, never pretend it was stored', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore()
        ..failWrites = true;
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);
      expect(await enqueueImage(box, blobs), isNull);
      expect((await store.loadAll()), isEmpty);
    });

    // ── 🔴 G-6 ───────────────────────────────────────────────────────────────
    // A picture item is really drained once, and the frame the queue hands the wire is
    // inspected. Before this, `outboxSend` built `source:'image'` with NO
    // `image_b64`/`image_mime`; every existing image test above passed anyway,
    // because none of them ever looked at what `send` was GIVEN — they only
    // asked what happened to the bytes on disk afterwards. That is the shape
    // this repo keeps paying for: the assertion was one question short.
    test('🔴 G-6 a picture is really drained once: the queue put the bytes in the sender\'s hands', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, blobs: blobs);
      await enqueueImage(box, blobs);

      final OutboxDrainReport report = await box.drain();

      expect(report.sent, 1);
      expect(host.sends.length, 1);
      final _Sent sent = host.sends.single;
      expect(sent.item.kind, OutboxPayloadKind.image);
      // 🔴 THE ASSERTION THE OLD SUITE WAS MISSING. `InjectRequestPayload`'s
      // constructor asserts `(source==image) == (b64!=null && mime!=null)`, so a
      // null here IS the debug crash / `INJECT_FRAME_INVALID` — and that code is
      // terminal, i.e. the picture would never be retried.
      expect(
        sent.imageBytes,
        isNotNull,
        reason: 'an image item must reach the wire WITH its bytes',
      );
      expect(sent.imageBytes, equals(png));
      // The mime rides the item, so both halves of the pairing are available.
      expect(sent.item.imageMime, 'image/png');
    });

    test('a text item carries no image bytes (the pairing is bidirectional; giving one extra half is equally an illegal frame)', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box);
      await box.drain();
      expect(host.sends.single.imageBytes, isNull);
    });

    // ── 🔴 G-4 / stage ③ of the two-stage image model ─────────────────────────
    test('bytes gone ⇒ terminal OUTBOX_IMAGE_BYTES_GONE, neither retry nor send an empty frame', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);
      await enqueueImage(box, blobs);
      // The file vanishes under us (the OS reclaimed the app's cache, the user
      // cleared storage) — the one case the item can never recover from.
      blobs.blobs.clear();

      final OutboxDrainReport report = await box.drain();

      // Not sent, and NOT held: held would promise a retry that cannot succeed.
      expect(host.sends, isEmpty, reason: 'no frame may be built without bytes');
      expect(report.sent, 0);
      expect(report.held, isEmpty);
      expect(report.refused[ 'i0-1'], kOutboxImageBytesGone);

      final OutboxItem after = (await store.findByRequestId('i0-1'))!;
      expect(after.state, OutboxDeliveryState.refused);
      expect(after.refusedCode, kOutboxImageBytesGone);
      // Terminal ⇒ a second drain does not pick it up again.
      await box.drain();
      expect(host.sends, isEmpty);
      // And it is a QUEUE-OWNED terminal, i.e. one the UI has words for
      // (window B3-2b: the sentence itself moved to AppStrings, four languages —
      // see outbox_ui_surface_test.dart for the assertion that it is non-empty
      // in every one of them).
      expect(outboxTerminalOf(kOutboxImageBytesGone), OutboxTerminal.imageBytesGone);
    });

    test('bytes gone but connected to a different machine ⇒ still report "bytes gone", must not hide behind a transient reason', () async {
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);
      await enqueueImage(box, blobs);
      blobs.blobs.clear();
      // Now point the phone at a DIFFERENT machine. Addressing would refuse
      // this item with `differentMachine` — a transient reason that reads as
      // 「等一条到你那台电脑的连接就好了」, which for this item is a lie.
      host.connectionIs = kOnBLan;

      final OutboxDrainReport report = await box.drain();

      expect(report.held, isEmpty);
      expect(report.refused['i0-1'], kOutboxImageBytesGone);
      expect(
        (await store.findByRequestId('i0-1'))!.state,
        OutboxDeliveryState.refused,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Card G-9 (1200-line test cap): the REAL-SQL group moved VERBATIM to
  // outbox_test_sqlite.dart (a `part` of THIS file, so nothing was renamed).
  // See that file's header for the seam and why it was split, not squeezed.
  _sqliteRealSqlGroup();

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 RV-90 — owner 2026-08-01 real device, verbatim:
  //   「云端中继传图全部都是显示未投递，但事实上已传递到 PC 且已注入到焦点输入框，
  //     但手机的转录界面上方仍显示: 还有 X 条未投递……手机的历史时间线上这 2 张图
  //     显示的是已注入」
  //
  // This is the live shape of the 15 册 §2.1 seam: face is decided jointly
  // by the "row" and the "item". The row settled to already-injected, the
  // item never flipped to delivered ⇒ the same batch of pictures, the
  // transcript UI says 「未投递」, the timeline says 「已注入」. Two red
  // lines hit at once: R2 "no silent failure"'s **second direction** (this
  // time saying a thing that was done was not done) and R4 "one value
  // answers one question".
  //
  // ⚠️ The gap is not on the cloud leg, nor in image-path correlation —
  // it is in `_releaseBytes`: settle first writes the new state, then
  // `_releaseBytes(item)` upserts again with the **pre-settle item**
  // (ConflictAlgorithm.replace, primary key request_id) ⇒ the new state
  // is overwritten by the old. Only images hit it, because `_releaseBytes`
  // returns immediately when imagePath==null.
  //
  // ⚠️⚠️ Correction (RV-93): `_releaseBytes` **has been deleted entirely**
  // (owner revoked "delete on successful delivery"). The above is kept as
  // case history. **This group is still fully valid**: they assert "a
  // settled state must not be written back", whoever writes it back —
  // anyone who later adds a disk write after settle (RV-96's clear
  // feature will) trips this red light.
  group('🔴 RV-90 — a settled item must not be written back to the old state by a "release bytes" write', () {
    final Uint8List png = Uint8List.fromList(<int>[9, 8, 7]);

    Future<OutboxItem?> enqueueImage(
      DeliveryOutbox box, {
      String requestId = 'rv90-1',
    }) => box.enqueueImage(
      requestId: requestId,
      entryId: 'loc_$requestId',
      bytes: png,
      imageMime: 'image/png',
      extension: 'png',
      label: '🖼 PNG · 3 B',
      mode: 'realtime',
      createdAt: kSpokenAt,
    );

    test('🔴 cloud-leg picture (emit directly, no drain) ⇒ an ok receipt must land as delivered', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnACloud);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);

      // The cloud image leg's exact shape: `image_send_controller._send`
      // enqueues (persist before send) and then emits on the socket ITSELF — the item
      // never passes through `_attempt`, so it is still `queued` when the PC
      // answers. That is why this test does NOT call drain().
      await enqueueImage(box);
      // A-58: the socket leg's verdict correlates on `entry_id` (InjectResult
      // .correlationId prefers it), not on `request_id`.
      await box.settle(correlationId: 'loc_rv90-1', ok: true);

      final OutboxItem after = (await store.findByRequestId('rv90-1'))!;
      expect(
        after.state,
        OutboxDeliveryState.delivered,
        reason: '🔴 PC said already injected; the item must not still sit at queued — that is the lie owner saw',
      );
      // ⚠️⚠️ Originally "positive control: the bytes really were released"
      // (asserted blobs empty). After RV-93 **the release itself no longer
      // exists**, that control must be replaced not deleted — it was
      // guarding "the test is green because release never ran". It now
      // hangs on the **button**: the only user-visible face that still
      // flips if "the settle was written back to the old state".
      expect(blobs.blobs.length, 1, reason: 'RV-93: the full image stays, no longer released');
      expect(after.hasImageBytes, isTrue);
      expect(
        box.resendableImageEntryIds,
        isNot(contains('loc_rv90-1')),
        reason: 'if the state is written back to queued, a resend button reappears here',
      );
      // …and the banner's number is the same fact, not a second one.
      expect(box.pendingCountFor(kPairACloud), 0);
    });

    test('🔴 a picture that received ok after drain ⇒ must likewise land as delivered', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);
      await enqueueImage(box, requestId: 'rv90-2');
      await box.drain();
      expect((await store.findByRequestId('rv90-2'))!.state,
          OutboxDeliveryState.inflight);
      await box.settle(correlationId: 'rv90-2', ok: true);
      expect((await store.findByRequestId('rv90-2'))!.state,
          OutboxDeliveryState.delivered);
      expect(box.pendingCountFor(kPairALan), 0);
    });

    test('🔴 a picture at a named terminal ⇒ refused + the code must stay, must not be written back to queued', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store, blobs: blobs);
      await enqueueImage(box, requestId: 'rv90-3');
      await box.drain();
      await box.settle(
        correlationId: 'rv90-3',
        ok: false,
        code: 'INJECT_FRAME_TOO_LARGE',
      );
      final OutboxItem after = (await store.findByRequestId('rv90-3'))!;
      // 🔴 The second half of the same bug, and the WORSE half: resurrected to
      // `queued` with its bytes already discarded, the next drain settles it
      // `OUTBOX_IMAGE_BYTES_GONE` — a terminal the user is told about, for a
      // picture whose real terminal was 「帧太大」.
      expect(after.state, OutboxDeliveryState.refused);
      expect(after.refusedCode, 'INJECT_FRAME_TOO_LARGE');
      final int sentBefore = host.sends.length;
      await box.drain();
      expect(host.sends.length, sentBefore, reason: 'a terminal must not go back on the wire');
      expect(box.terminalNotice, isNull, reason: 'must not change the story to "bytes gone"');
    });

    test('🔴 an overflow-dropped picture ⇒ stays in the table as refused, not revived to queued', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final _FakeHost host = _FakeHost(kOnALan)..linkOk = false;
      final DeliveryOutbox box = _outbox(
        host,
        store: store,
        blobs: blobs,
        capacity: 1,
      );
      await enqueueImage(box, requestId: 'cap-img-0');
      await enqueueImage(box, requestId: 'cap-img-1');
      final OutboxItem victim = (await store.findByRequestId('cap-img-0'))!;
      expect(victim.state, OutboxDeliveryState.refused);
      expect(victim.refusedCode, kOutboxOverflow);
      // The cap is only a cap if the dropped item stops being pending.
      expect(box.pendingCountFor(kPairALan), 1);
    });

    test('the same path for a text item (positive control: it has always been right, so the gap is image-only)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host, store: store);
      await _enqueueOne(box, requestId: 'rv90-txt');
      await box.drain();
      await box.settle(correlationId: 'rv90-txt', ok: true);
      expect((await store.findByRequestId('rv90-txt'))!.state,
          OutboxDeliveryState.delivered);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 RV-91 — owner 2026-08-01 real device, verbatim:
  //   「【还有 X 条未投递，连接恢复后会自动投递】这个提示我从云端中继这个实例切换
  //     到本地局域网通道的转录界面上仍然会存在，这不应该在不同的实例上共享，
  //     每个实例的转录界面的状态应该都是隔离的」
  //
  // 🔴 Grouping criterion = **instance (pairing / connectionIdentity), not
  // machine**, and the reason is not "owner said so" — it is **this
  // screen has already been doing it**:
  //   `chat_flow_page.dart:378-380` filters rows with
  //   `entriesForInstance(connectedInstanceId)`; `timeline_store.dart:91-105`
  //   uses `spokenToInstanceId`, i.e. the same `connectionIdentity`. ⇒ The
  //   rows the banner counts are exactly the rows this screen refuses to
  //   show. The queue's **destination** is still the machine (that answers
  //   "where can it be sent"); the banner's **scope** is the instance
  //   (that answers "which conversation are you looking at"). Two
  //   questions, two criteria — this repo's old rule.
  //
  // ⚠️⚠️ Correction (card F2, 2026-08-05) — **the argument above is a
  // stale truth, left in place and not deleted** (anti-façade ④). Two
  // things each changed:
  //  ① the coordinate `chat_flow_page.dart:378-380` drifted long ago
  //     (card F3 moved that file); today that stretch is at `:499-509`,
  //     the anchor is `List<TimelineEntry> _narrowedEntries(String? iid)`;
  //  ② the criterion itself was half-rewritten by ruling ④ (2026-08-04):
  //     **the same computer's two channels** were re-judged from "two
  //     instances" to "one screen", so the banner's scope is now the
  //     **machine** (when a uid is present). **Isolation between
  //     different machines did not change by a single character**, and
  //     the group below asserts exactly that isolation half — a different
  //     machine, the cloud leg (`kPairACloud` is `saas|…`, cloud is not a
  //     machine, never merged), a null identity; all three still hold, so
  //     this group still runs green as written.
  //  ⇒ owner RV-91's original sentence is still the criterion: the
  //     banner must match the screen it sits on; what changed is that
  //     screen, not the "must match" rule. The merge half's control is in
  //     `f2_machine_merge_test.dart`.
  group('🔴 RV-91 — the banner\'s scope is the "instance", matching the screen it sits on', () {
    Future<DeliveryOutbox> boxWith(
      _FakeHost host,
      InMemoryOutboxStore store,
    ) async {
      final DeliveryOutbox box = _outbox(host, store: store);
      host.linkOk = false; // nothing drains; everything stays pending
      return box;
    }

    test('two instances each count their own (the same machine\'s two channels are also two instances)', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnACloud);
      final DeliveryOutbox box = await boxWith(host, store);

      await _enqueueOne(box, requestId: 'cloud-1');
      await _enqueueOne(box, requestId: 'cloud-2');
      host.connectionIs = kOnALan; // switch to the LAN channel — same computer
      await _enqueueOne(box, requestId: 'lan-1');

      expect(box.pendingCountFor(kPairACloud), 2);
      expect(
        box.pendingCountFor(kPairALan),
        1,
        reason: '🔴 owner: 每个实例的转录界面状态应该都是隔离的',
      );
      // Positive control: the queue as a whole still owes three — the scoping is a
      // VIEW, and nothing was dropped to make the number smaller.
      expect(box.pendingCountTotal, 3);
    });

    test('an instance on a different machine ⇒ count not one', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = await boxWith(host, store);
      await _enqueueOne(box, requestId: 'a-1');
      expect(box.pendingCountFor(kPairBLan), 0);
      expect(box.pendingCountFor(kPairALan), 1);
    });

    test('connected to no instance (null) ⇒ do not invent a number', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = await boxWith(host, store);
      await _enqueueOne(box, requestId: 'a-2');
      expect(box.pendingCountFor(null), 0);
    });

    test('only after settle does that instance\'s number go to zero; other instances are unaffected', () async {
      final InMemoryOutboxStore store = InMemoryOutboxStore();
      final _FakeHost host = _FakeHost(kOnACloud);
      final DeliveryOutbox box = await boxWith(host, store);
      await _enqueueOne(box, requestId: 'c-1');
      host.connectionIs = kOnALan;
      await _enqueueOne(box, requestId: 'l-1');
      await box.settle(correlationId: 'c-1', ok: true);
      expect(box.pendingCountFor(kPairACloud), 0);
      expect(box.pendingCountFor(kPairALan), 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  group('🔴 L8 — a deferred delivery must not auto-inject (owner 2026-08-02)', () {
    // Criterion: docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md.
    // What is asserted here is "what stamp the queue put on the frame" and
    // "after the PC's deliberately-did-not-inject reply, does this item
    // count as done". That the PC really does not type is asserted by
    // src-tauri's Rust unit tests (this file cannot reach that layer).

    test('drained right after speaking ⇒ live (positive control: without this, every deferred below might just be "block all")', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'now-1', createdAt: DateTime.now().toUtc());
      await box.drain();
      expect(host.origins, <InjectOrigin>[InjectOrigin.live]);
    });

    test('an item that sat a long time, then drained ⇒ deferred', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      // kSpokenAt is 2026-07-28 — far past kLiveDeliveryWindow.
      await _enqueueOne(box, requestId: 'old-1');
      await box.drain();
      expect(host.origins, <InjectOrigin>[InjectOrigin.deferred]);
    });

    test('🔴 two items in the same drain are judged each on their own — origin is a "per-item" property, not a "this batch" one', () async {
      // ManualDelivery.deliverText is this shape: enqueue the one the user
      // just pressed, then drain the whole queue. A per-drain switch would
      // stamp both with the same mark, and on the dangerous side.
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'old-2');
      await _enqueueOne(box, requestId: 'new-2', createdAt: DateTime.now().toUtc());
      await box.drain();
      expect(host.sends.map((_Sent s) => s.item.requestId).toList(),
          <String>['old-2', 'new-2']);
      expect(host.origins, <InjectOrigin>[InjectOrigin.deferred, InjectOrigin.live]);
    });

    test('🔴 the user pressed resend ⇒ live, however old, time is not consulted (owner: a manual action is unconditionally intended)', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'old-3');   // very old
      await box.drain(userRequestedEntryIds: <String>{'loc_old-3'});
      expect(host.origins, <InjectOrigin>[InjectOrigin.live]);
    });

    test('the user tapped only one of the rows ⇒ only that row is live; the others in the same batch stay deferred', () async {
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'old-4');
      await _enqueueOne(box, requestId: 'old-5');
      await box.drain(userRequestedEntryIds: <String>{'loc_old-5'});
      expect(host.origins, <InjectOrigin>[InjectOrigin.deferred, InjectOrigin.live]);
    });

    test('🔴 PC replies "this is deferred, I deliberately did not inject" ⇒ terminal delivered, the queue no longer owes it', () async {
      // Without this case: this code falls into the retryable branch below
      // ⇒ back to queued ⇒ and "the next drain" is by definition another
      // deferred delivery ⇒ it never converges, every reconnect resends,
      // 「还有 N 条」 counts it forever.
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'd-1');
      await box.drain();
      await box.settle(
        correlationId: 'd-1',
        ok: false,
        code: kInjectDeferredNotAutoinjected,
      );
      expect(box.pendingCountFor(kPairALan), 0, reason: 'delivery succeeded: the frame reached the PC');
      // And it is not refused (that would equal saying 「未投递」, a lie —
      // the message is on the user's PC screen).
      host.origins.clear();
      await box.drain();
      expect(host.sends.where((_Sent s) => s.item.requestId == 'd-1').length, 1,
          reason: 'must not go back on the wire after a terminal');
    });

    test('🔴 reverse control: a cached that is not a PC inject-leg verdict still returns to queued', () async {
      // Otherwise the case above might just be "every cached is treated as
      // terminal", which would terminate the ones still truly owed
      // together — 15 册 requires these two classes to be split; this is
      // the proof they are.
      //
      // ⚠️⚠️ **Card F2 (2026-08-02) changed this case's sample code and
      // title, and that is not a weakening of L8's guarantee, it is
      // correcting its premise.** The original used `INJECT_FOCUS_LOST`
      // as "ordinary cached", and said "tap into the input box and it
      // lands, so it must not terminate" — **the first half is still
      // true, the second half is wrong**: that code is **the PC answering
      // in its own voice**, the frame already reached the PC, the row was
      // already minted ⇒ **the delivery leg is already done** (15 册
      // §2.0.1 first line). Leaving it in queued is exactly the defect
      // owner hit on a real device 2026-08-02 (the phone showed 「待投递」
      // while the message was on the PC screen). "Send again and it
      // lands" is about the **inject** leg; the entry for that is the
      // resend button, not the queue continuing to owe it.
      // The "not every cached terminates" this case must prove now uses
      // the **relay-answered** `INJECT_NOT_IN_ROOM`: it also carries
      // `mode:'cached'`, and the PC never saw that frame.
      final _FakeHost host = _FakeHost(kOnALan);
      final DeliveryOutbox box = _outbox(host);
      await _enqueueOne(box, requestId: 'f-1');
      await box.drain();
      await box.settle(correlationId: 'f-1', ok: false, code: 'INJECT_NOT_IN_ROOM');
      expect(box.pendingCountFor(kPairALan), 1);
    });
  });
}

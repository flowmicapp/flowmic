// 800-line cap — the ENQUEUE half of delivery_outbox.dart, moved VERBATIM into
// a `part` of the same library.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE except the receiver: `enqueueText` /
// `enqueueImage` were instance methods of [DeliveryOutbox] and are now
// library-private-to-public top-level functions taking it explicitly ([box])
// — the same shape delivery_outbox_settle.dart / delivery_outbox_degraded.dart
// established (and chat_outbox_host.dart before them), NOT the extension
// shape delivery_outbox_attempt.dart uses (that one works only because
// `_attempt` is PRIVATE and every caller lives inside this same library; the
// four external enqueue call sites — chat_utterance.dart, manual_delivery.dart,
// manual_delivery_reinject.dart, image_send_controller.dart — import
// delivery_outbox.dart from OUTSIDE it, and an extension on a class the caller
// never imports does not resolve there). A `part` shares the library, so
// `box._host` / `box._blobs` / `box._persistItem` / `box._loadPendingMerged` /
// `box._capacity` / `box._overflowed` / `box._noteTerminal` /
// `box._refreshDerived` / `box._unpersisted` are all still in scope. The class
// keeps one-line delegates under the ORIGINAL names (`enqueueText`,
// `enqueueImage`), so not one external call site had to be edited.
// **Any diff here beyond 「moved」 is a bug.**
//
// WHY THIS IS THE RIGHT CUT. delivery_outbox.dart keeps 「什么时候排空、这一轮
// 要动哪些」("when to drain, which items this round should touch") (drain) and
// 「这一条算完了没有」("is this one done or not") (settle, itself a part); this
// file answers the question BEFORE either of those: 「这一条能不能上到磁盘、上
// 去之后队列还装得下吗」("can this one get onto disk at all, and does the queue
// still have room once it has") — [outboxEnqueueText] / [outboxEnqueueImage]
// build the item, [_hasRedeemableDestination] refuses one born with nowhere to
// go, [_admit] persists it and fans the two effects out, and
// [_enforceCapacity] is the overflow rule that keeps the table bounded. Same
// family, same order they run in.

part of 'delivery_outbox.dart';

/// Put ONE text delivery on disk. Returns the durable item. See
/// [DeliveryOutbox.enqueueText] (the delegate every caller still uses).
///
/// [requestId] is minted by the CALLER and passed in, because the caller also
/// needs it as the row's client id — but it is minted ONCE, at enqueue, and
/// this item will re-send under it for the rest of its life (Gate 1).
Future<OutboxItem?> outboxEnqueueText(
  DeliveryOutbox box, {
  required String requestId,
  required String entryId,
  /// 🔴 Whether this frame stamps `entry_id`. REQUIRED and explicitly nullable
  /// — never defaulted to [entryId]: passing the settle anchor is precisely the
  /// 窗口B3-2a regression (one id on a frame covering N rows ⇒ the PC writes
  /// that row's truth over all N). Answer 「did this delivery itself create
  /// that row」.
  required String? wireEntryId,
  List<String>? coveredEntryIds,
  required String source,
  required String text,
  required String mode,
  required DateTime createdAt,
  String? sourceText,
  String? deviceLabel, int? durationMs,
}) async {
  final OutboxItem item = OutboxItem(
    requestId: requestId,
    entryId: entryId,
    wireEntryId: wireEntryId,
    // Defaults to just the representative — a delivery always settles at
    // least its own row. Never an empty list: a drained item that settles
    // NOTHING leaves the user's row at ⏳ with nobody left to move it.
    coveredEntryIds: coveredEntryIds == null || coveredEntryIds.isEmpty
        ? <String>[entryId]
        : List<String>.unmodifiable(coveredEntryIds),
    kind: OutboxPayloadKind.text,
    source: source,
    text: text,
    mode: mode,
    // 🔴 Gate 3 — the SPEAKING instant, handed in by the caller off the row.
    createdAt: createdAt,
    enqueuedAt: DateTime.now().toUtc(),
    sourceText: sourceText,
    deviceLabel: deviceLabel, durationMs: durationMs,
    // 🔴 Gate 2 — freeze the destination from the CURRENT connection, once.
    destinationMachineUid: box._host.liveConnection.machineUid,
    destinationPairingIdentity: box._host.liveConnection.pairingIdentity,
    enqueuedPcId: box._host.liveConnection.pcId,
  );
  return _admit(box, item);
}

/// 🔴 A queued delivery MUST be born with a destination it can be redeemed at.
///
/// WHY THIS GUARD EXISTS AND WHEN IT CAN FIRE. The queue's whole reason to
/// exist is the offline window, so the first question asked of it is: when the
/// link is down, is the frozen destination empty? It is NOT — and that safety
/// rests on a property nobody had written down: `PttSession
/// .clearConnectedInstance()` (which nulls all three identities) has exactly
/// ONE caller in the repo, `connections_controller.dart:307 leaveRoom()`, i.e.
/// the user deliberately leaving the session. A dropped socket, a
/// backgrounded app and an EMUI-severed TCP do NOT call it, so the identities
/// survive the outage and an enqueue during it freezes a complete address.
///
/// This guard covers the one case where they are genuinely gone (after
/// `leaveRoom`). Freezing an empty destination there would mint a ticket that
/// can never be redeemed: `resolveOutboxTarget` would refuse it forever and it
/// would sit in the queue being counted as 「not delivered」 for the life of the
/// install. Refusing loudly at the door is the honest disposition.
bool _hasRedeemableDestination(OutboxItem item) =>
    (item.destinationMachineUid != null &&
        item.destinationMachineUid!.isNotEmpty) ||
    (item.destinationPairingIdentity != null &&
        item.destinationPairingIdentity!.isNotEmpty);

/// Put ONE picture delivery on disk — BYTES FIRST. See
/// [DeliveryOutbox.enqueueImage] (the delegate every caller still uses).
///
/// Returns null when the bytes could not be written. That is reported, never
/// swallowed: an item enqueued without its payload would be a promise with
/// nothing behind it, and the drain would later refuse it for a reason the
/// user could not act on.
Future<OutboxItem?> outboxEnqueueImage(
  DeliveryOutbox box, {
  required String requestId,
  required String entryId,
  required Uint8List bytes,
  required String imageMime,
  required String extension,
  required String label,
  required String mode,
  required DateTime createdAt,
  String? thumbB64,
  String? deviceLabel,
}) async {
  final String? path = await box._blobs.put(
    requestId: requestId,
    bytes: bytes,
    extension: extension,
  );
  if (path == null) {
    diag('outbox.enqueue_refused', <String, Object?>{
      'request_id': requestId,
      'reason': 'BLOB_WRITE_FAILED',
      'bytes': bytes.length,
    });
    return null;
  }
  final OutboxItem item = OutboxItem(
    requestId: requestId,
    entryId: entryId,
    // A picture send ALWAYS builds its own row, so the frame names it.
    wireEntryId: entryId,
    // A picture is always exactly one row.
    coveredEntryIds: <String>[entryId],
    kind: OutboxPayloadKind.image,
    source: 'image',
    // The protocol requires `text`; a picture carries none. The DESCRIPTOR is
    // kept separately so nothing can accidentally type 「🖼 PNG · 214 KB」 into
    // the user's document and call it a delivery.
    text: '',
    mode: mode,
    createdAt: createdAt,
    enqueuedAt: DateTime.now().toUtc(),
    sourceText: null,
    entryType: 'image',
    thumbB64: thumbB64,
    imagePath: path,
    imageMime: imageMime,
    deviceLabel: deviceLabel,
    destinationMachineUid: box._host.liveConnection.machineUid,
    destinationPairingIdentity: box._host.liveConnection.pairingIdentity,
    enqueuedPcId: box._host.liveConnection.pcId,
  );
  // `label` rides the local row, not the frame — kept out of the item so there
  // is exactly one producer of that string (owner RV-68 ruling).
  assert(label.isNotEmpty, 'an image row always has a descriptor');
  return _admit(box, item);
}

/// Persist a new item, enforce the cap, refresh the count. Null ⇒ refused at
/// the door (see [_hasRedeemableDestination]).
Future<OutboxItem?> _admit(DeliveryOutbox box, OutboxItem item) async {
  if (!_hasRedeemableDestination(item)) {
    diag('outbox.enqueue_refused', <String, Object?>{
      'request_id': item.requestId,
      'reason': 'NO_DESTINATION',
    });
    return null;
  }
  // D9 ②: a failed write parks the item in [_unpersisted] and the enqueue
  // KEEPS GOING — the four call sites' contract is 「degrade durability, never
  // delivery」, and before this card a throw here aborted the whole send.
  await box._persistItem(item, op: 'enqueue');
  // ⚠️ SELF-EXPOSING LINE — 「which parts of this item's addressing are
  // empty」. Ids and booleans
  // only: never the text, never the picture. A queued delivery whose
  // destination fields are all null is deliverable ONLY on its own pairing,
  // and this is the one place that fact is visible before it becomes a
  // mystery three days later.
  diag('outbox.enqueued', <String, Object?>{
    'request_id': item.requestId,
    'entry_id': item.entryId,
    'kind': item.kind.name,
    'source': item.source,
    'has_machine_uid': item.destinationMachineUid != null,
    'has_pairing_identity': item.destinationPairingIdentity != null,
    'has_enqueued_pc_id': item.enqueuedPcId != null,
    // D9 ②: false ⇒ this delivery will not survive a process death — the one
    // honest bit that separates 「queued」 from 「persisted to disk」.
    'persisted': !box._unpersisted.containsKey(item.requestId),
    'created_at_age_ms':
        DateTime.now().toUtc().difference(item.createdAt).inMilliseconds,
  });
  await _enforceCapacity(box);
  await box._refreshDerived();
  box._host.onOutboxChanged();
  return item;
}

/// 🔴 Overflow MUST speak, and must not degrade into 「there was never
/// anything there」.
///
/// The oldest pending item is settled `refused('OUTBOX_OVERFLOW')` — a named
/// terminal state, KEPT IN THE TABLE. It is not deleted, because a row that is
/// gone cannot tell the user (or the next session) that it was ever dropped;
/// that is precisely the degradation the PC timeline's trimming rule already
/// banned. Oldest-first because the newest is what the user just said and is
/// watching for.
Future<void> _enforceCapacity(DeliveryOutbox box) async {
  final List<OutboxItem> pending = await box._loadPendingMerged();
  while (pending.length > box._capacity) {
    final OutboxItem victim = pending.removeAt(0); // oldest
    final OutboxItem dropped = victim.copyWith(
      state: OutboxDeliveryState.refused,
      refusedCode: kOutboxOverflow,
    );
    await box._persistItem(dropped, op: 'overflow');
    // 🔴 RV-93 — the picture is NOT deleted here. Overflow drops the DELIVERY,
    // and the row it belongs to is still on the user's timeline showing that
    // picture; deleting the bytes would empty the tap-to-enlarge view for a row nobody removed.
    box._overflowed++;
    box._noteTerminal(kOutboxOverflow);
    diag('outbox.overflow', <String, Object?>{
      'dropped_request_id': victim.requestId,
      'cap': box._capacity,
      'overflowed_total': box._overflowed,
    });
  }
}

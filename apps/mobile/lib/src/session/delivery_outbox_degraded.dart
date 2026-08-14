// Card D9 ② / 800-line cap — the DISK-DEGRADATION seam of delivery_outbox.dart,
// moved VERBATIM into a `part` of the same library.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE except the receiver: the three members
// below were instance methods of [DeliveryOutbox] and are now library-private
// top-level functions taking it explicitly ([box]) — the same shape
// delivery_outbox_settle.dart established (and chat_outbox_host.dart before
// it), and it works for the same reason: a `part` shares the library, so
// `box._store` / `box._unpersisted` are still in scope. The class keeps
// one-line delegates under the ORIGINAL names, so not one call site — including
// the eight in delivery_outbox_settle.dart — had to be edited.
// **Any diff here beyond 「moved」 is a bug.**
//
// ── D9 ② — a broken disk must not abort a delivery ──────────────────────────
//
// 🔴 THE CONTRACT ALL FOUR ENQUEUE CALL SITES ALREADY STATE (chat_utterance /
// manual_delivery / manual_delivery_reinject / image_send_controller, verbatim
// family: 「That degrades DURABILITY, never delivery」/「A NULL IS NOT FATAL AND
// MUST NOT ABORT THE SEND」) — and which this class broke: a THROW out of
// `_store.upsert` inside `_admit` aborted the entire send at every one of
// them, turning a persistence problem into a failed delivery. The call sites
// wrote the contract; this is the layer that now honours it.
//
// MECHANISM: `DeliveryOutbox._unpersisted` is the in-memory shadow of every
// item whose LATEST state could not be written to disk. A failed write parks
// the item there (loudly — `outbox.persist_degraded`); every read merges the
// shadow over the stored rows (shadow wins: it is strictly newer), so the
// drain, the settle path, the watchdog and the banner all keep working on a
// dead disk. A later successful write for the same request_id evicts the
// shadow — the disk is current again, self-healing per item.
//
// WHAT IS HONESTLY LOST, said out loud rather than papered over: a shadow item
// does not survive a process death — that is what 「persistence degraded」
// MEANS, and it is precisely the loss the diag line exists to make
// attributable. 「落盘先于发送」("write to disk before sending") is unchanged
// whenever the disk works: the write
// is still awaited before any emit; only its FAILURE no longer cancels the
// attempt.
//
// Pinned by outbox_persist_degraded_test.dart (throwing store ⇒ the send still
// goes out and settles; the pre-D9 path throws out of `enqueueText`).

part of 'delivery_outbox.dart';

/// Every write to an item's durable state goes through here. Disk first; on
/// failure the item's truth lives in `_unpersisted` until a later write for
/// the same request_id lands.
Future<void> outboxPersistItem(
  DeliveryOutbox box,
  OutboxItem item, {
  required String op,
}) async {
  try {
    await box._store.upsert(item);
    box._unpersisted.remove(item.requestId);
  } catch (e) {
    box._unpersisted[item.requestId] = item;
    // ⚠️ SELF-EXPOSING LINE — 「这一条现在只活在内存里」("this item now only lives
    // in memory"). If the process dies
    // before a later write lands, THIS is the line that says which delivery
    // the restart will not remember, and why.
    diag('outbox.persist_degraded', <String, Object?>{
      'request_id': item.requestId,
      'op': op,
      'state': item.state.name,
      'error': e,
    });
  }
}

/// Pending items with the shadow merged over the stored rows, oldest first —
/// the ONE pending read every path in this library uses. A read failure
/// degrades to the shadow alone (loudly) instead of aborting the caller:
/// the queue keeps delivering out of RAM on a disk that cannot even be read.
Future<List<OutboxItem>> outboxLoadPendingMerged(DeliveryOutbox box) async {
  List<OutboxItem> stored;
  try {
    stored = await box._store.loadPending();
  } catch (e) {
    stored = const <OutboxItem>[];
    diag('outbox.store_read_degraded', <String, Object?>{
      'op': 'load_pending',
      'shadow_items': box._unpersisted.length,
      'error': e,
    });
  }
  if (box._unpersisted.isEmpty) return stored;
  final Set<String> seen = <String>{};
  final List<OutboxItem> merged = <OutboxItem>[];
  for (final OutboxItem i in stored) {
    seen.add(i.requestId);
    // Shadow wins: a stored row with a shadow is by definition stale (the
    // write that would have replaced it is the one that failed).
    merged.add(box._unpersisted[i.requestId] ?? i);
  }
  merged.addAll(
    box._unpersisted.values.where((OutboxItem i) => !seen.contains(i.requestId)),
  );
  return merged.where((OutboxItem i) => i.isPending).toList()
    ..sort((OutboxItem a, OutboxItem b) => a.enqueuedAt.compareTo(b.enqueuedAt));
}

/// One item by request_id, shadow first — the settle/watchdog lookup.
Future<OutboxItem?> outboxFindItemByRequestId(
  DeliveryOutbox box,
  String requestId,
) async {
  final OutboxItem? shadow = box._unpersisted[requestId];
  if (shadow != null) return shadow;
  try {
    return await box._store.findByRequestId(requestId);
  } catch (e) {
    diag('outbox.store_read_degraded', <String, Object?>{
      'op': 'find_by_request_id',
      'request_id': requestId,
      'error': e,
    });
    return null;
  }
}

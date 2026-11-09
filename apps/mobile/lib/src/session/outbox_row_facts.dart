// SPEC-REF: docs/rebuild/15-RECEIPT-STATES.md §2.0.1-c (the NR-284 block), R11.
//
// NR-284 — what a screen that does not hold the [ChatController] needs to know
// about the phone's one delivery queue in order to say the right word on a row.
//
// 🔴 WHY THIS EXISTS: `deliveryFaceOf` cannot tell 「the computer has not answered
// and the queue is still retrying」 from 「this failed」 without the queue's own
// answer, because a row alone does not carry it. The all-history page held only
// a TimelineStore, passed `queued: false` and `owed: false`, and so drew a red ✗
// on rows the chat page correctly called pending. The layer deciding the word
// did not hold the fact it needed.
//
// It is a narrow value, not the controller, because that page's long-press menu
// withholds its session actions on the grounds that it has no session
// (`sessionActions: false`, entry_context_menu.dart). Handing it the whole
// controller would make that argument false for the sake of two sets.

import 'package:flutter/foundation.dart';

/// The two queue answers a row's face depends on, read live.
///
/// Production builds exactly one, `ChatController.outboxRowFacts`
/// (chat_status_surface.dart), consumed by `main_page_builders.dart`
/// `_buildHistory`. No default and no empty instance in `lib/`: an empty queue
/// is a real claim about a row, and a friendly default would restore this card's
/// defect at whichever call site forgot (13 册 §7 F1 ②).
@immutable
class OutboxRowFacts {
  const OutboxRowFacts({
    required this.changes,
    required Set<String> Function() queuedEntryIds,
    required Set<String> Function() owedEntryIds,
  }) : _queuedEntryIds = queuedEntryIds,
       _owedEntryIds = owedEntryIds;

  /// Fires when either answer may have moved. A screen must repaint on this as
  /// well as on the store: the queue can stop owing a row, or finish loading at
  /// boot, without the row itself being written.
  final Listenable changes;

  final Set<String> Function() _queuedEntryIds;
  final Set<String> Function() _owedEntryIds;

  /// `DeliveryOutbox.queuedEntryIds` for this row.
  bool isQueued(String entryId) => _queuedEntryIds().contains(entryId);

  /// `DeliveryOutbox.owedEntryIds` for this row: queued OR inflight.
  bool isOwed(String entryId) => _owedEntryIds().contains(entryId);
}

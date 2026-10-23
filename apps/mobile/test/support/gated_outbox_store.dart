// NR-279 S4a — an outbox store whose writes can be HELD, so a test can stand
// in the gap between two writes of one verdict and look at what is on screen.
//
// A held write is the stand-in for 「the process was killed here」: whatever
// the row shows while the write is held is what a restart would find on disk
// next to an item that never received the write.

import 'dart:async';

import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';

class GatedOutboxStore extends InMemoryOutboxStore {
  /// Writes for which this returns true wait until [release] is called.
  bool Function(OutboxItem item)? holdWhere;

  final Completer<void> _gate = Completer<void>();
  final Completer<OutboxItem> _held = Completer<OutboxItem>();

  /// Completes with the first write that was held (the write has NOT happened).
  Future<OutboxItem> get firstHeld => _held.future;

  void release() {
    if (!_gate.isCompleted) _gate.complete();
  }

  @override
  Future<void> upsert(OutboxItem item) async {
    final bool Function(OutboxItem)? hold = holdWhere;
    if (hold != null && hold(item) && !_gate.isCompleted) {
      if (!_held.isCompleted) _held.complete(item);
      await _gate.future;
    }
    await super.upsert(item);
  }
}

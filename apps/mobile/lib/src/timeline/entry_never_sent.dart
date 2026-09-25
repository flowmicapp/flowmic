// Card RC-I — 「is this row (and anything re-run from it) never sent?」, asked
// by the copy that would otherwise talk about a PC.
//
// SPEC-REF: docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §5.3 / §7 RC-I

import '../signaling/wire_payloads.dart' show Delivery;
import 'timeline_entry.dart';

extension EntryNeverSent on TimelineEntry {
  /// True when nothing built from this row goes anywhere: a light record (a
  /// cloud-instance row, `origin == 'cloud'`) or a record-only row
  /// (`Delivery.none`).
  ///
  /// 🔴 THE SAME TWO TESTS THE SENDER MAKES, in the same order:
  /// `session/chat_utterance.dart` `_deliverDirect` opens with
  /// `if (entry.origin == 'cloud') return;` and
  /// `if (entry.delivery == Delivery.none) return;`. A re-run inherits both
  /// from the row it was made from (`chat_utterance_processing.dart`
  /// `_deliverRerun`: `delivery: origin.delivery`, `origin: origin.origin`),
  /// which is why the menu asks the ROW and not the screen's destination
  /// switch: on a paired phone switched to record-only, an older row that went
  /// to the PC still re-runs to the PC, and a record-only row still stays here
  /// after the switch is flipped back.
  bool get neverSent => origin == 'cloud' || delivery == Delivery.none;
}

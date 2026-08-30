// owner 2026-08-30: 「时间早的放上面，时间迟的放下面，这一点一定要注意」.
//
// 🔴 THE TRAP IS IN THE OWNER'S OWN WORDS: 「上面的其实是时间最迟的」. The
// full-history page lists newest FIRST, so copying the selection in the order
// the screen hands it over produced a document that read backwards — and
// nothing about it looked wrong, because every line was correct and only their
// order was not.
//
// ⚠️ Sorted inside `selectedRecords`, not at the two call sites, so that 「what
// N records amount to」 keeps the single author its own doc promises.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/selection/batch_actions.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _row(String id, String text, DateTime at) => TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      createdAt: at,
      updatedAt: at,
    );

void main() {
  test('🔴 newest-first on screen becomes oldest-first in the clipboard', () {
    // Exactly what the history page hands over: the latest row is at index 0.
    final SelectedRecords out = selectedRecords(<TimelineEntry>[
      _row('c', '第三句', DateTime.utc(2026, 8, 30, 9, 2)),
      _row('b', '第二句', DateTime.utc(2026, 8, 30, 9, 1)),
      _row('a', '第一句', DateTime.utc(2026, 8, 30, 9, 0)),
    ]);
    expect(out.text, '第一句\n第二句\n第三句');
  });

  test('an already-chronological selection is unchanged', () {
    // The chat page hands rows over oldest-first; the sort must be a no-op
    // there rather than a second opinion about an order that was already right.
    final SelectedRecords out = selectedRecords(<TimelineEntry>[
      _row('a', '第一句', DateTime.utc(2026, 8, 30, 9, 0)),
      _row('b', '第二句', DateTime.utc(2026, 8, 30, 9, 1)),
    ]);
    expect(out.text, '第一句\n第二句');
  });

  test('🔴 identical timestamps keep the order they were given', () {
    // `List.sort` is not stable in Dart, so without an explicit tie-break two
    // rows minted in the same millisecond would land in whatever order the
    // algorithm happened to leave — which is not an order at all. Same
    // reasoning and same fix as PlusPanelSelection.inChronologicalOrder.
    final DateTime same = DateTime.utc(2026, 8, 30, 9);
    final SelectedRecords out = selectedRecords(<TimelineEntry>[
      _row('x', '先给的', same),
      _row('y', '后给的', same),
    ]);
    expect(out.text, '先给的\n后给的');
  });

  test('empty rows are still neither counted nor printed', () {
    // Guarding the pre-existing rule while its loop was edited: an empty line
    // does not count as a record and does not pretend to be one.
    final SelectedRecords out = selectedRecords(<TimelineEntry>[
      _row('b', '   ', DateTime.utc(2026, 8, 30, 9, 1)),
      _row('a', '有字', DateTime.utc(2026, 8, 30, 9, 0)),
    ]);
    expect(out.text, '有字');
    expect(out.textRows, 1);
  });
}

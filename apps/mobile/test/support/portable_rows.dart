// Row builders for the Window C export/import tests.
//
// Deliberately fills EVERY optional field with a distinctive value. A round-trip
// test over rows whose optionals are all null proves nothing about the fields
// that are null — and the fields most likely to be dropped by a mapping bug are
// exactly the ones nobody bothered to set.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';

TimelineEntry testRow({
  required String id,
  required String text,
  String? clientId,
  FlowMode mode = FlowMode.realtime,
  Delivery delivery = Delivery.inject,
  EntryStatus status = EntryStatus.cached,
  String entryType = TimelineEntry.kTranscript,
  String? thumbB64,
  InjectTarget? injectTarget,
  DateTime? createdAt,
  String origin = 'paired',
  // Window C2: a row whose STT never stamped a duration. `null` is a real state
  // (chat_utterance coerces a 0 from the wire to null), and the C2 aggregate has
  // to be able to be handed one — 「unknown」 must never be summed as 「zero seconds」.
  int? durationMs = 3200,
}) {
  final DateTime at = createdAt ?? DateTime.utc(2026, 8, 1, 8);
  return TimelineEntry(
    id: id,
    clientId: clientId ?? id.split('_').last,
    mode: mode,
    delivery: delivery,
    sourceText: text,
    outputText: '$text（面）',
    sourceLang: 'zh',
    outputLang: 'en',
    processMode: mode == FlowMode.realtime ? null : mode.name,
    processedText: mode == FlowMode.realtime ? null : '$text-processed',
    refinedAt: DateTime.utc(2026, 8, 1, 8, 0, 5),
    injectTarget: injectTarget,
    pcName: 'DESKTOP-7',
    spokenToInstanceId: 'instance-7',
    spokenToInstanceName: '书房台式机',
    edited: true,
    status: status,
    createdAt: at,
    updatedAt: at.add(const Duration(seconds: 3)),
    durationMs: durationMs,
    segmentsCount: 2,
    origin: origin,
    entryType: entryType,
    thumbB64: thumbB64,
    failureReason: 'INJECT_FOCUS_LOST',
    cachedByVerdict: true,
    lastResentAt: DateTime.utc(2026, 8, 1, 8, 10),
  );
}

/// N transcript rows, one second apart, oldest first in time.
List<TimelineEntry> testRows(int n, {String prefix = 'loc_dev_u'}) =>
    <TimelineEntry>[
      for (int i = 0; i < n; i++)
        testRow(
          id: '$prefix$i-1',
          clientId: '$prefix$i-1',
          text: '第 $i 句话 hello $i',
          mode: FlowMode.values[i % FlowMode.values.length],
          status: EntryStatus.values[i % EntryStatus.values.length],
          createdAt: DateTime.utc(2026, 8, 1, 8).add(Duration(seconds: i)),
        ),
    ];

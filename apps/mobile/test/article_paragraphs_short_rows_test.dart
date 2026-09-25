// Card RC-E — a long recording's rows can now be 10–30 s long (a >=3 s silence
// ends a row that is >=10 s old, server-side), so the paragraph rule meets rows
// shorter than the 30 s cadence it was written against. This file pins what the
// rule does with them; it changes nothing in the rule.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §3 (the RC-E correction under the section head: the floor, the cap and the
//     unknown-row backstop, one by one), §3.2 `kServerRowMinMs` row
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-E block)
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §3.3 (the check table this
//     file turns into cases), §2.3 (material A simulated: 56–73 s paragraphs)
//
// Run only this file:
//   flutter test test/article_paragraphs_short_rows_test.dart --timeout 90s --reporter compact
//
// Reverse check (run red before it was trusted): drop `_openMs >= kParagraphSoftMinMs &&`
// from `close` in `article_paragraphs.dart` ⇒ case 1 red (every short row its own
// paragraph); drop `|| _openMs >= kParagraphHardMaxMs` ⇒ case 2 red (one paragraph).

import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

const String _kArt = 'a0-1790000000000001';
final DateTime _t0 = DateTime.utc(2026, 9, 24, 9);

/// Rows laid seam to seam, each with its length and the silence in front of it.
List<TimelineEntry> _rows(List<(String, int, int?)> spec) {
  final List<TimelineEntry> out = <TimelineEntry>[];
  int at = 0;
  for (int i = 0; i < spec.length; i++) {
    final (String text, int ms, int? pause) = spec[i];
    out.add(TimelineEntry(
      id: 'r$i',
      clientId: 'r$i',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: text,
      outputText: text,
      status: EntryStatus.noted,
      origin: 'cloud',
      articleId: _kArt,
      articleOffsetMs: at,
      durationMs: ms,
      pauseBeforeMs: pause,
      createdAt: _t0.add(Duration(milliseconds: at + i)),
      updatedAt: _t0.add(Duration(milliseconds: at + i)),
    ));
    at += ms;
  }
  return out;
}

List<List<String>> _ids(List<ArticleParagraph> ps) => <List<String>>[
  for (final ArticleParagraph p in ps)
    <String>[for (final TimelineEntry r in p.rows) r.id],
];

int _ms(ArticleParagraph p) =>
    p.rows.fold<int>(0, (int s, TimelineEntry r) => s + (r.durationMs ?? 0));

void main() {
  test('the designed numbers this file leans on', () {
    // Literals, not the constants: a moved constant must be a visible act here.
    expect(kParagraphSoftMinMs, 40000);
    expect(kParagraphHardMaxMs, 90000);
    expect(kStrongPauseMs, 3000);
  });

  test('1 — 10–30 s rows, each after a 3.6 s silence: paragraphs still close only past the 40 s floor', () {
    // Every edge qualifies (a >=3 s pause figure, the way RC-E rows arrive). Rows
    // shorter than the floor accumulate until the floor is met — no row of 14–22 s
    // becomes a paragraph on its own.
    final List<TimelineEntry> rows = _rows(<(String, int, int?)>[
      ('一', 18000, null),
      ('二', 14000, 3600),
      ('三', 22000, 3600),
      ('四', 16000, 3600),
      ('五', 19000, 3600),
      ('六', 13000, 3600),
      ('七', 21000, 3600),
    ]);
    final List<ArticleParagraph> ps = paragraphsOf(rows);
    expect(_ids(ps), <List<String>>[
      <String>['r0', 'r1', 'r2'],
      <String>['r3', 'r4', 'r5'],
      <String>['r6'],
    ]);
    // Positive control for the floor: both closed-by-rule paragraphs are >= 40 s.
    expect(_ms(ps[0]), 54000);
    expect(_ms(ps[1]), 48000);
  });

  test('2 — 12 s rows with no qualified edge: the 90 s cap still bounds the paragraph', () {
    // No terminator, no pause figure: only the cap can close. It closes at the first
    // edge at or past 90 s, i.e. a paragraph of 96 s here — cap + less than one row.
    final List<TimelineEntry> rows = _rows(<(String, int, int?)>[
      for (int i = 0; i < 10; i++) ('段$i', 12000, null),
    ]);
    final List<ArticleParagraph> ps = paragraphsOf(rows);
    expect(_ids(ps).first, <String>['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(_ms(ps.first), 96000);
    expect(ps.length, 2);
  });
}

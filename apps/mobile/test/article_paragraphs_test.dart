// Card CR-12-A — the paragraph rule and the six properties that make it safe
// to show a paragraph on screen before the recording has finished.
//
// SPEC-REF: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//   §3.5 (P1–P6) and §3.6 (the T0–T12 reverse-check table).
//
// ── HOW TO READ THE REVERSE CHECKS IN THIS FILE ─────────────────────────────
//
// Every case below was run red before it was trusted, by editing
// `article_paragraphs.dart` and running ONLY this file:
//
//   flutter test test/article_paragraphs_test.dart --timeout 90s --reporter compact
//
// The mutation for each case is named in its own comment. They are recorded
// here because "the test is green" says nothing about whether the test can go
// red — this repo's stated头号 failure shape in reverse.
//
// 🔴 FOUR CASES IN THE FIRST VERSION OF THIS FILE COULD NOT FAIL, and the shape
// is worth naming so it is not written a fifth time: an assertion that uses the
// constant it is testing (`greaterThanOrEqualTo(kParagraphSoftMinMs)`) moves
// with the constant, so lowering the floor lowered the ruler. Every threshold
// asserted here is therefore a LITERAL, and the literals are tied to the
// constants in one place ('the numbers are the designed numbers') so that a
// change to either side is a visible act.
//
// 🔴 THE HARD ONE IS P1 (T5), AND IT IS WORTH SPELLING OUT WHY. "A closed
// paragraph never moves" is trivially true of any implementation that never
// closes anything, so the property on its own is not evidence. Two things make
// it real here: (a) a POSITIVE CONTROL — the test counts how many closed
// paragraphs the random corpus actually produced and fails if that probe is
// empty, so "no violations" cannot mean "nothing happened"; and (b) the
// mutation used to run it red is a plausible one a future reader might
// genuinely write — merging a short trailing paragraph back into the one before
// it at `onEnd`, which is exactly the "fix" the short-tail case (T9) invites.
// A truly retro-fitting implementation (splitting the finished article into
// equal-length paragraphs, say) fails the same assertion, and that was checked
// too.
//
// ⚠️ P2 (T6) is a REGRESSION GUARD, NOT A DISCOVERY. `paragraphsOf` is a fold
// over `ArticleParagrapher`, so today the two sides are the same code and the
// property cannot fail. It is written down anyway because the thing it guards
// against is a future edit that gives `paragraphsOf` its own batch loop — which
// is how the live view and the read-back view would silently start disagreeing.
// The red run for T6 was produced by giving it that second loop.

import 'dart:io';
import 'dart:math';

import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flowmic/src/timeline/article_paragraphs.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';

const String _kArt = 'a0-1790000000000000';
final DateTime _t0 = DateTime.utc(2026, 9, 22, 9);

/// A member row of one continuous recording.
///
/// [offsetMs] and [createdAt] are handed in separately from [ms] on purpose:
/// T7 needs to move them around without touching anything the rule is allowed
/// to read.
TimelineEntry _row(
  String id,
  String text, {
  int? ms = 30000,
  int? offsetMs = 0,
  int createdAtMs = 0,
  int? pauseBeforeMs,
}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  origin: 'cloud',
  articleId: _kArt,
  articleOffsetMs: offsetMs,
  durationMs: ms,
  pauseBeforeMs: pauseBeforeMs,
  createdAt: _t0.add(Duration(milliseconds: createdAtMs)),
  updatedAt: _t0.add(Duration(milliseconds: createdAtMs)),
);

/// Lay a list of (text, durationMs) out the way the product does: seam to seam,
/// each row's offset being the sum of the lengths before it (design §1.1 —
/// `ArticleClock.claim` advances by duration, so the gap between rows is zero
/// by construction).
List<TimelineEntry> _seam(List<(String, int?)> spec) {
  final List<TimelineEntry> out = <TimelineEntry>[];
  int at = 0;
  for (int i = 0; i < spec.length; i++) {
    final (String text, int? ms) = spec[i];
    out.add(_row('r$i', text, ms: ms, offsetMs: at, createdAtMs: at + i));
    at += (ms != null && ms > 0) ? ms : 0;
  }
  return out;
}

/// Rows the time arms cannot see: no length, or a length of zero.
int _unknownRows(ArticleParagraph p) => p.rows
    .where((TimelineEntry r) => r.durationMs == null || r.durationMs! <= 0)
    .length;

/// The only shape assertions are made on: which rows landed in which paragraph.
List<List<String>> _ids(List<ArticleParagraph> ps) => <List<String>>[
  for (final ArticleParagraph p in ps)
    <String>[for (final TimelineEntry r in p.rows) r.id],
];

/// A pause source built from row id -> milliseconds, standing in for the
/// production seam `articlePauseBeforeMs` (which reads the persisted field
/// since the CR-12 integration). It lets a case place a figure without laying
/// out codec rows; T12 is the case that goes through the real field instead.
ArticlePauseSource _pauses(Map<String, int> byId) =>
    (TimelineEntry row) => byId[row.id];

void main() {
  // ── T0 — the numbers this layer copies from the server are the server's ──
  //
  // 🔴 D-10: the terminator set and the row minimum are the server's contract,
  // and this file reads them OUT OF THE SERVER SOURCE rather than trusting a
  // comment that says "copied from". If either constant on the server moves,
  // this is the test that says so; if the server file moves, this is red too,
  // which is the right answer (somebody has to re-point the pin).
  //
  // Reverse checks:
  //   (a) drop the trailing `!?` from `kServerSentenceTerminators`
  //       => 'the terminator set is the server's set' …
  //          Expected: '。！？…‼⁇⁈⁉！？!?'  Actual: '。！？…‼⁇⁈⁉！？'
  //   (b) set `kServerRowMinMs` to 25000
  //       => 'the row minimum is the server's cadence' … Expected: <30000>
  //          Actual: <25000>
  // Both restored; green.
  group('T0 pinned to the server source', () {
    String read(String rel) {
      final File f = File(rel);
      expect(f.existsSync(), isTrue, reason: 'server source moved: $rel');
      return f.readAsStringSync();
    }

    test('the terminator set is the server\'s set', () {
      final String src = read('../server-core/src/stt/segment-boundary.ts');
      final RegExpMatch? m = RegExp(
        r"const SENTENCE_TERMINATORS = '([^']*)';",
      ).firstMatch(src);
      expect(m, isNotNull, reason: 'SENTENCE_TERMINATORS not found');
      expect(kServerSentenceTerminators, m!.group(1));
      // The server refuses the ASCII period; the display-layer extension for it
      // is a separate, reasoned decision (T4), not a leak into this set.
      expect(kServerSentenceTerminators.contains('.'), isFalse);
    });

    test('the row minimum is the server\'s cadence', () {
      final String src = read('../server-core/src/stt/orchestrator-types.ts');
      final RegExpMatch? m = RegExp(
        r'DEFAULT_SOFT_SEGMENT_MS = ([0-9_]+);',
      ).firstMatch(src);
      expect(m, isNotNull, reason: 'DEFAULT_SOFT_SEGMENT_MS not found');
      expect(kServerRowMinMs, int.parse(m!.group(1)!.replaceAll('_', '')));
    });

    test('the strong pause is above the server\'s own pause arm', () {
      final String src = read('../server-core/src/stt/segment-boundary.ts');
      final RegExpMatch? m = RegExp(
        r'MIN_PAUSE_MS = ([0-9_]+);',
      ).firstMatch(src);
      expect(m, isNotNull);
      final int serverPause = int.parse(m!.group(1)!.replaceAll('_', ''));
      // A threshold at or below the server's arm would qualify EVERY pause-cut
      // edge, and the 3 s the owner asked for would be a 600 ms rule in
      // disguise.
      expect(kStrongPauseMs, greaterThan(serverPause));
    });
  });

  // ── T1 — the floor gates everything ───────────────────────────────────────
  //
  // Reverse check: delete `_openMs >= kParagraphSoftMinMs &&` from the `close`
  // expression in `article_paragraphs.dart`.
  //   flutter test test/article_paragraphs_test.dart
  //   => T1 negative … Expected: <1>  Actual: <2>   (the 30s sentence closed)
  // Restored; same command green.
  group('T1 soft floor', () {
    test('positive — 45s ending on 。 closes when the next row arrives', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('今天先过两件事。', 45000),
        ('第二件是排期', 30000),
      ]);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0'],
        <String>['r1'],
      ]);
    });

    test('negative — the SAME sentence at 30s does not close', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('今天先过两件事。', 30000),
        ('第二件是排期', 30000),
      ]);
      // Positive control for the negative: the rows are both present and in
      // order, so "one paragraph" is a grouping decision and not a lost row.
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1'],
      ]);
      expect(paragraphsOf(rows).length, 1);
    });

    test('two 30s rows ending on 。 close as one 60s paragraph', () {
      // The everyday shape: a punctuating speaker on 30 s rows lands on the
      // target exactly, and the boundary is the sentence end of r1.
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('第一句。', 30000),
        ('第二句。', 30000),
        ('第三句。', 30000),
        ('第四句。', 30000),
      ]);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1'],
        <String>['r2', 'r3'],
      ]);
    });
  });

  // ── T2 — 「并不是达1分钟就分」 in the TIME direction, and the hard cap ─────
  //
  // 🔴 The first version of this rule closed unconditionally at 60 s, which is
  // the one thing the owner's sentence rules out by name. Now: past the floor
  // an unqualified edge is left alone until the cap.
  //
  // Reverse checks:
  //   (a) add back `|| _openMs >= kParagraphTargetMs` to `close`
  //       => 'negative — 70s of unqualified edges does not close' …
  //          Expected: [[r0, r1, r2]]  Actual: [[r0, r1], [r2]]
  //   (b) delete `|| _openMs >= kParagraphHardMaxMs`
  //       => 'positive — the cap closes at the first edge at/past 90s' …
  //          Expected: [[r0, r1, r2], [r3]]  Actual: [[r0, r1, r2, r3]]
  // Both restored; green.
  group('T2 target is not a trigger, the cap is', () {
    test('negative — 70s of unqualified edges does not close', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('一段没有标点的话', 35000),
        ('接着说下去', 35000),
        ('再接着说', 35000),
      ]);
      // 35 open -> r1 arrives, floor not met -> 70 open -> r2 arrives: floor
      // met, edge not qualified, 70 < 90 -> stays open. The old rule split here.
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
      ]);
    });

    test('positive — the cap closes at the first edge at/past 90s', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('一段没有标点的话', 35000),
        ('接着说下去', 35000),
        ('再接着说', 35000),
        ('还在说', 35000),
      ]);
      // … 105 open -> r3 arrives: past the cap, any edge closes.
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
        <String>['r3'],
      ]);
    });

    test('boundary — exactly 90s closes, 89,940 does not', () {
      final List<TimelineEntry> at = _seam(<(String, int?)>[
        ('没有标点', 45000),
        ('没有标点', 45000),
        ('没有标点', 30000),
      ]);
      expect(_ids(paragraphsOf(at)), <List<String>>[
        <String>['r0', 'r1'],
        <String>['r2'],
      ]);
      final List<TimelineEntry> under = _seam(<(String, int?)>[
        ('没有标点', 45000),
        ('没有标点', 44940),
        ('没有标点', 30000),
      ]);
      expect(_ids(paragraphsOf(under)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
      ]);
    });
  });

  // ── T3 — the strong-pause arm, both paths ────────────────────────────────
  //
  // Reverse checks, one per assertion:
  //   (a) delete the `|| (_pauseSource(row) ?? 0) >= kStrongPauseMs` arm
  //       => 'pause 3200 closes' … Expected: [[r0], [r1]]  Actual: [[r0, r1]]
  //   (b) change `>= kStrongPauseMs` to `> kStrongPauseMs`
  //       => 'exactly 3000 closes' … Expected: [[r0], [r1]]  Actual: [[r0, r1]]
  // Both restored; green.
  group('T3 strong pause', () {
    final List<TimelineEntry> rows = _seam(<(String, int?)>[
      ('没有标点的一段话', 45000),
      ('停过之后又说', 30000),
    ]);

    test('positive — pause 3200 closes although nothing ends a sentence', () {
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 3200})),
        ),
        <List<String>>[
          <String>['r0'],
          <String>['r1'],
        ],
      );
    });

    test('boundary — exactly 3000 closes', () {
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 3000})),
        ),
        <List<String>>[
          <String>['r0'],
          <String>['r1'],
        ],
      );
    });

    test('negative — 2900 does not close', () {
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 2900})),
        ),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('negative — a pause figure of 0 is a figure, and it does not close', () {
      // 0 is what a real frame says when the speaker ran two segments together.
      // It must behave like "no silence", NOT like "no data".
      expect(
        _ids(paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 0}))),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('negative — the server\'s own 600ms pause is a breath, not a break', () {
      // Every pause-cut row edge carries at least this much silence (the
      // server's MIN_PAUSE_MS). If this closed, the 3 s rule would be the 600 ms
      // rule in disguise.
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 600})),
        ),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('negative — one 60ms frame below the threshold does not close', () {
      // The figure arrives quantised to 60ms frames (design §2.4), so 2,940 is
      // the largest value that can actually appear below 3,000 — the real
      // boundary, not a round number chosen for the test.
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 2940})),
        ),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('negative — 「并不是达1分钟就分」 holds in the pause direction too', () {
      // A ten-second silence below the floor still does not close. The owner's
      // sentence has two halves and this is the one a pause-driven rule is
      // most likely to lose.
      final List<TimelineEntry> short = _seam(<(String, int?)>[
        ('开头的一段', 30000),
        ('停了很久之后', 30000),
      ]);
      expect(
        _ids(
          paragraphsOf(short, pauseSource: _pauses(<String, int>{'r1': 10000})),
        ),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('a pause in front of the FIRST row is ignored', () {
      // There is no edge in front of the first row to close, so the figure on
      // it — which is real, the silence before the recording's first word —
      // must not manufacture an empty paragraph.
      expect(
        _ids(
          paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r0': 20000})),
        ),
        <List<String>>[
          <String>['r0', 'r1'],
        ],
      );
    });

    test('a long recording closes repeatedly on pauses alone', () {
      // The primary path end to end: no punctuation anywhere, six 40 s rows,
      // and every paragraph boundary comes from a silence — 40 s rows are used
      // so that no boundary here can be the cap's doing (two rows = 80 s < 90).
      final List<TimelineEntry> long = _seam(<(String, int?)>[
        for (int i = 0; i < 6; i++) ('一直说下去的第$i段', 40000),
      ]);
      expect(
        _ids(
          paragraphsOf(
            long,
            pauseSource: _pauses(<String, int>{
              'r1': 4200,
              'r3': 3600,
              'r4': 5400,
            }),
          ),
        ),
        <List<String>>[
          <String>['r0'],
          <String>['r1', 'r2'],
          <String>['r3'],
          <String>['r4', 'r5'],
        ],
      );
      // Positive control: without the figures the same rows group differently,
      // so the assertion above is about the pause arm and not about the cap.
      expect(_ids(paragraphsOf(long)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
        <String>['r3', 'r4', 'r5'],
      ]);
    });

    test('degraded path — the same rows with NO pause source, which is what '
        'ships today and what a non-Soniox leg always gets', () {
      // 🔴 These rows carry no `pauseBeforeMs`, so `articlePauseBeforeMs`
      // (which reads the field since the CR-12 integration) answers null —
      // the permanent answer for sherpa / FunASR / Deepgram legs, an old relay
      // that strips the additive field, and every row recorded before CR-12-D. Pinning it means a future reader sees the degraded rule
      // (design §3.4) as an assertion rather than a sentence in a document.
      expect(articlePauseBeforeMs(rows.first), isNull);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1'],
      ]);
    });
  });

  // ── T4 — the terminator set, the row-end period, and the ellipsis ────────
  //
  // Reverse checks:
  //   (a) delete the `_kLetter.hasMatch(before)` guard (return true for any
  //       trailing '.')
  //       => 'negative — a decimal or a numbered item' … Expected: false  Actual: true
  //   (b) delete the `if (before == '.') return true;` line
  //       => 'ASCII ... is the ellipsis' … Expected: true  Actual: false
  // Both restored; green.
  group('T4 sentence terminators', () {
    test('positive — ASCII period after a letter ends a sentence', () {
      expect(endsSentence('send me the reports by friday.'), isTrue);
    });

    test(
      'positive — a closing bracket after the terminator is stepped over',
      () {
        expect(endsSentence('他说「走吧。」'), isTrue);
        expect(endsSentence('by friday." '), isTrue);
      },
    );

    test('negative — a decimal or a numbered item does not', () {
      expect(endsSentence('we are on version 3.'), isFalse);
      expect(endsSentence('the ratio was 3.5'), isFalse);
    });

    test('ASCII ... is the ellipsis … — one mark, one answer', () {
      expect(endsSentence('然后就……'), isTrue);
      expect(endsSentence('and then...'), isTrue);
      expect(endsSentence('然后就...'), isTrue);
    });

    test('documented cost — an abbreviation at a row end IS accepted', () {
      // Not a wish, a price: a row that ends in "U.S." was cut by the server's
      // pause arm (the server never cuts on '.'), so the speaker stopped for
      // >= 600 ms after it. Accepting it can close a paragraph one row early at
      // an existing row seam; refusing it would take the sentence arm away
      // from every English recording. If this expectation ever flips, the
      // header of `endsSentence` is where the argument has to be re-had.
      expect(endsSentence('we shipped it to the U.S.'), isTrue);
    });

    test('the full-width set from the server is honoured', () {
      for (final String t in <String>['。', '！', '？', '…', '‼', '⁇', '⁈', '⁉']) {
        expect(endsSentence('说完了$t'), isTrue, reason: t);
      }
      expect(endsSentence('really?'), isTrue);
      expect(endsSentence('stop!'), isTrue);
    });

    test('negative — nothing said yet, or nothing but punctuation', () {
      expect(endsSentence(''), isFalse);
      expect(endsSentence('   '), isFalse);
      expect(endsSentence('.'), isFalse);
    });
  });

  // ── A language with no sentence-final punctuation at all ─────────────────
  //
  // Design §3.2 last row: the rule must not depend on `kSpokenLangs` and must
  // not stop segmenting when the terminator set never fires. The same shape is
  // already reachable today with an engine configured without punctuation.
  test(
    'Thai — no terminator ever fires, and it still segments (at the cap)',
    () {
      const String a = 'ผมกำลังทดสอบระบบบันทึกเสียงอยู่ตอนนี้';
      const String b = 'และผมจะพูดต่อไปอีกสักครู่หนึ่ง';
      const String c = 'ตอนนี้ผมกำลังพูดประโยคที่สาม';
      // Positive control: the terminator set genuinely does not fire on this
      // text, so the segmentation below cannot be coming from the sentence arm.
      for (final String t in <String>[a, b, c]) {
        expect(endsSentence(t), isFalse);
      }
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        (a, 35000),
        (b, 35000),
        (c, 35000),
        (a, 35000),
      ]);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
        <String>['r3'],
      ]);
    },
  );

  // ── T5 — P1, a closed paragraph never moves ──────────────────────────────
  //
  // 🔴 THE QUESTION THIS ANSWERS IS "IF I AM WRONG, WHO TELLS ME". Two
  // mutations were run, both red on this case:
  //   (a) plausible: at `onEnd`, merge a trailing paragraph shorter than
  //       `kParagraphSoftMinMs` into the previous one (the "fix" the short
  //       tail in T9 invites).
  //       => T5 P1 [withPause] … Expected: [[r0], [r1, r2]]  Actual: [[r0], …
  //          (and T9, T6, T8, T10, T11 — 19 cases in all)
  //   (b) retro-fitting: replace `paragraphsOf` with an equal-thirds split of
  //       the finished article.
  //       => same assertion, from the first prefix onward (A-card run).
  // Both restored; green.
  for (final _Corpus corpus in _Corpus.values) {
    test('T5 P1 [${corpus.name}] — closed paragraphs of every prefix are a '
        'prefix of the whole', () {
      final Random rng = Random(20260922);
      int closedSeen = 0;
      int prefixesChecked = 0;
      for (int trial = 0; trial < 200; trial++) {
        final List<TimelineEntry> rows = _randomArticle(rng);
        final ArticlePauseSource src = _sourceFor(
          corpus,
          _randomPauses(rng, rows),
        );
        final List<List<String>> whole = _ids(
          paragraphsOf(rows, pauseSource: src),
        );
        for (int k = 0; k <= rows.length; k++) {
          final ArticleParagrapher p = ArticleParagrapher(pauseSource: src);
          for (int i = 0; i < k; i++) {
            p.onRow(rows[i]);
          }
          final List<List<String>> closed = _ids(
            p.paragraphs.where((ArticleParagraph x) => x.closed).toList(),
          );
          closedSeen += closed.length;
          prefixesChecked++;
          expect(
            whole.take(closed.length).toList(),
            closed,
            reason:
                'trial $trial prefix $k: closed $closed is not a prefix of '
                '$whole',
          );
        }
      }
      // 🔴 POSITIVE CONTROL. Without this, an implementation that closes
      // nothing passes the loop above with a perfect score. These numbers are
      // the corpus actually exercising the thing being asserted.
      expect(prefixesChecked, greaterThan(1000));
      expect(
        closedSeen,
        greaterThan(200),
        reason:
            'the corpus produced almost no closed paragraphs — the '
            'property was not exercised',
      );
    });
  }

  // ── T6 — P2, the live view and the read-back view are one answer ─────────
  //
  // Reverse check: give `paragraphsOf` its own batch loop whose floor drifted
  // to `kParagraphSoftMinMs + 5000`.
  //   => T6 P2 [degraded] … Expected: [[r0, r1], [r2], [r3, r4, r5], [r6, r7], …
  //      (the drifted grouping); T6 [withPause], both T5 cases and the pause-arm
  //      control red on the same run.
  // Restored; green. See the file header for why this case is a guard rather
  // than a discovery.
  //
  // ⚠️ `>` instead of `>=` was tried first and was NOT enough to red it: the
  // random durations practically never sum to exactly 40,000 or 90,000, so the
  // two implementations agreed anyway. A property test only catches a drift the
  // corpus can reach.
  for (final _Corpus corpus in _Corpus.values) {
    test(
      'T6 P2 [${corpus.name}] — streaming equals folding, byte for byte',
      () {
        final Random rng = Random(915);
        for (int trial = 0; trial < 200; trial++) {
          final List<TimelineEntry> rows = _randomArticle(rng);
          final ArticlePauseSource src = _sourceFor(
            corpus,
            _randomPauses(rng, rows),
          );
          final ArticleParagrapher p = ArticleParagrapher(pauseSource: src);
          for (final TimelineEntry r in rows) {
            p.onRow(r);
          }
          final List<ArticleParagraph> streamed = p.onEnd();
          final List<ArticleParagraph> folded = paragraphsOf(
            rows,
            pauseSource: src,
          );
          expect(_ids(streamed), _ids(folded), reason: 'trial $trial');
          expect(
            streamed.map((ArticleParagraph x) => x.closed).toList(),
            folded.map((ArticleParagraph x) => x.closed).toList(),
            reason: 'trial $trial closed flags',
          );
          // What was on screen mid-recording, closed, is exactly the finished
          // view minus the paragraph that was still open.
          final List<List<String>> closedLive = _ids(
            p.paragraphs.where((ArticleParagraph x) => x.closed).toList(),
          );
          expect(closedLive, _ids(folded).take(closedLive.length).toList());
        }
      },
    );
  }

  // 🔴 THE POSITIVE CONTROL FOR THE WHOLE TWO-CORPUS ARRANGEMENT. Every
  // property above is asserted twice, once per corpus — which proves nothing
  // unless the two corpora are actually different inputs to the rule. They are:
  // with a placed silence the pause arm changes the answer on EVERY article.
  // If CR-12-D ever lands a figure that is always below the threshold (the
  // energy-gate outcome design §2.4 rejected: gate open 100% of the time in a
  // room with noise), THIS is the case that says so.
  test(
    'the pause arm changes outcomes — the two corpora are not one corpus',
    () {
      final Random rng = Random(915);

      // ⚠️ BOTH THE CORPUS AND THE PAUSES HERE ARE CHOSEN, NOT RANDOM, AND THE
      // TWO EARLIER VERSIONS OF THIS CONTROL ARE WORTH RECORDING BECAUSE BOTH
      // MEASURED THE GENERATOR INSTEAD OF THE ARM.
      //   * Over the general corpus (durations 5s–120s, random pauses) the arm
      //     changed the grouping on 22 of 200 articles — low, because a single
      //     random row is often already past the cap, so the cap arm closes the
      //     paragraph no matter what the pause says.
      //   * Narrowing durations to 40–59s (floor met, cap not — the only window
      //     where a pause can decide anything) took it to 66 of 200, the rest
      //     being articles whose random pauses never crossed 3,000.
      // Neither number is evidence about the arm, and picking a threshold to fit
      // either of them would have been calibrating the ruler to the reading. So
      // the pauses are placed rather than rolled: every odd row gets a real
      // silence, and the answer must then differ for EVERY article.
      int differed = 0;
      for (int trial = 0; trial < 200; trial++) {
        final int n = 3 + rng.nextInt(6);
        final List<TimelineEntry> rows = _seam(<(String, int?)>[
          for (int i = 0; i < n; i++)
            ('这一段没有句末标点$i', 40000 + rng.nextInt(19000)),
        ]);
        final Map<String, int> pauses = <String, int>{
          for (int i = 0; i < n; i++) 'r$i': i.isOdd ? 3600 : 240,
        };
        final List<List<String>> withPause = _ids(
          paragraphsOf(rows, pauseSource: _pauses(pauses)),
        );
        final List<List<String>> degraded = _ids(paragraphsOf(rows));
        if (withPause.toString() != degraded.toString()) differed++;
      }
      expect(
        differed,
        200,
        reason:
            'a placed 3,600ms silence on every odd row failed to change '
            'the grouping — either the arm is dead or the threshold moved',
      );
    },
  );

  // ── T7 — P5, offsets and arrival times are NOT inputs ────────────────────
  //
  // 🔴 THE FIXTURE HERE IS LOAD-BEARING AND THE FIRST VERSION OF IT WAS USELESS.
  // With 35s rows the floor (`>= 40000`) refuses to close on the second row no
  // matter what `qualified` says, so an implementation that derives a pause
  // from the offset gap produced the SAME paragraphs and the test stayed green
  // while reading a number it is forbidden to read. The rows are 45s so that
  // the floor is met at the second row and the derived value is what decides.
  // This is why the check below is on three layouts, not two.
  //
  // Reverse checks:
  //   (a) OR a derived offset gap into `qualified`:
  //       `((row.articleOffsetMs ?? 0) - prevEnd) >= kStrongPauseMs`
  //       => T7 … Expected: [[r0, r1], [r2]]  Actual: [[r0], [r1], [r2]]
  //   (b) OR a derived arrival gap into `qualified`:
  //       `row.createdAt.difference(_open.last.createdAt).inMilliseconds >= kStrongPauseMs`
  //       => T7 … Expected: [[r0], [r1], [r2]]  Actual: [[r0, r1], [r2]]
  //       (the `tight` variant is the one that disagrees: its rows arrive 1ms
  //       apart, while `seamed`'s arrive 45s apart and fire the derived arm on
  //       every row).
  // Both restored; green.
  test('T7 P5 — same durations and text, different offsets and createdAt', () {
    const List<String> texts = <String>['一段没有标点的话', '接着说下去', '再接着说'];
    const int ms = 45000;

    // (1) How the product actually lays a recording out: seam to seam, each row
    // arriving about when it was said.
    final List<TimelineEntry> seamed = <TimelineEntry>[
      for (int i = 0; i < texts.length; i++)
        _row(
          'r$i',
          texts[i],
          ms: ms,
          offsetMs: ms * i,
          createdAtMs: ms * i + i,
        ),
    ];
    // (2) The same rows with a 10s hole in front of each offset and arrivals ten
    // minutes apart.
    final List<TimelineEntry> holed = <TimelineEntry>[
      for (int i = 0; i < texts.length; i++)
        _row(
          'r$i',
          texts[i],
          ms: ms,
          offsetMs: (ms + 10000) * i + 10000,
          createdAtMs: 600000 * (i + 1),
        ),
    ];
    // (3) The same rows arriving in a burst one millisecond apart — which is
    // what a catch-up backfill looks like on the wire.
    final List<TimelineEntry> tight = <TimelineEntry>[
      for (int i = 0; i < texts.length; i++)
        _row('r$i', texts[i], ms: ms, offsetMs: ms * i, createdAtMs: i),
    ];

    // Positive controls: the three layouts really do differ where the rule is
    // not allowed to look, and the grouping really is non-trivial — otherwise
    // "they all agree" would be a statement about nothing.
    expect(
      seamed.map((TimelineEntry r) => r.articleOffsetMs).toList(),
      isNot(holed.map((TimelineEntry r) => r.articleOffsetMs).toList()),
    );
    expect(
      seamed.map((TimelineEntry r) => r.createdAt).toList(),
      isNot(tight.map((TimelineEntry r) => r.createdAt).toList()),
    );
    expect(paragraphsOf(seamed).length, greaterThan(1));

    expect(_ids(paragraphsOf(holed)), _ids(paragraphsOf(seamed)));
    expect(_ids(paragraphsOf(tight)), _ids(paragraphsOf(seamed)));
  });

  // ── T8 — P3 completeness, P4 the floor, P6 the cap ───────────────────────
  //
  // Reverse checks:
  //   (a) drop the closing row from the new open paragraph (`_open = []` and
  //       `_openMs = 0` on close) =>
  //       Expected: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']
  //         Actual: ['r0', 'r2', 'r4', 'r6']
  //       — every row that closed a paragraph was swallowed. (This mutation is
  //       loud: it reds most of the cases in this file.)
  //   (b) lower `kParagraphSoftMinMs` to `kParagraphTargetMs ~/ 3` (20000) =>
  //       Expected: a value greater than or equal to <40000>  Actual: <37198>
  //       (trial 3 paragraph 3) plus 'the numbers are the designed numbers'.
  //   (c) raise `kParagraphHardMaxMs` to `kParagraphTargetMs * 2` (120000) =>
  //       P6 … Expected: a value less than <90000>  Actual: <101675>
  //       (trial 0 paragraph [[r6, r7]]) plus 'the numbers are the designed
  //       numbers'.
  // All restored; green.
  for (final _Corpus corpus in _Corpus.values) {
    test('T8 P3/P4/P6 [${corpus.name}] — nothing is lost, reordered, closed '
        'under the floor, or carried past the cap', () {
      final Random rng = Random(4242);
      int multiParagraph = 0;
      int capChecked = 0;
      for (int trial = 0; trial < 200; trial++) {
        final List<TimelineEntry> rows = _randomArticle(rng);
        final List<ArticleParagraph> ps = paragraphsOf(
          rows,
          pauseSource: _sourceFor(corpus, _randomPauses(rng, rows)),
        );
        // P3: every row exactly once, in the order it went in.
        expect(
          <String>[for (final List<String> g in _ids(ps)) ...g],
          rows.map((TimelineEntry r) => r.id).toList(),
          reason: 'trial $trial',
        );
        // P4: everything but the tail meets the floor. The tail is exempt
        // because the recording ended, not because the rule bent; a paragraph
        // closed by the unknown-length backstop (three rows with no length,
        // T11) is exempt because its true length is unknowable here — the
        // server's cadence makes those rows >= 30 s each in reality.
        //
        // 🔴 THE 40000 AND THE 3 ARE LITERALS ON PURPOSE (file header): the
        // constant would move the ruler with the thing being measured.
        for (int i = 0; i < ps.length - 1; i++) {
          expect(ps[i].closed, isTrue);
          if (_unknownRows(ps[i]) >= 3) continue;
          expect(
            ps[i].spokenMs,
            greaterThanOrEqualTo(40000),
            reason: 'trial $trial paragraph $i',
          );
        }
        // P6: no paragraph carries a row it should have closed before. For
        // every paragraph of two or more rows, the rows BEFORE its last one
        // sum to less than the cap — otherwise the cap would have fired when
        // that last row arrived — and at most three of them have no length.
        // (The tail is not exempt here: an open paragraph past the cap closes
        // at the next row like any other.)
        for (final ArticleParagraph p in ps) {
          if (p.rows.length < 2) continue;
          int beforeLast = 0;
          for (int i = 0; i < p.rows.length - 1; i++) {
            beforeLast += p.rows[i].durationMs ?? 0;
          }
          capChecked++;
          expect(
            beforeLast,
            lessThan(90000),
            reason: 'trial $trial paragraph ${_ids(<ArticleParagraph>[p])}',
          );
          expect(
            _unknownRows(p),
            lessThanOrEqualTo(3),
            reason: 'trial $trial paragraph ${_ids(<ArticleParagraph>[p])}',
          );
        }
        if (ps.isNotEmpty) expect(ps.last.closed, isTrue);
        if (ps.length > 1) multiParagraph++;
      }
      // Positive controls: P4's loop is empty for a single-paragraph article
      // and P6's for single-row paragraphs, so without these the assertions
      // could be vacuous on the whole corpus.
      expect(
        multiParagraph,
        greaterThan(50),
        reason: 'the corpus barely ever produced more than one paragraph',
      );
      expect(
        capChecked,
        greaterThan(200),
        reason: 'the corpus barely ever produced a multi-row paragraph',
      );
    });
  }

  // ── T9 — the short tail is shown as the tail ─────────────────────────────
  //
  // Design §3.3: the terminal row is the one row the cadence does not bound,
  // and nothing on the row says "I am the last one", so a short tail can stand
  // as its own paragraph. Merging it back would withdraw a boundary already on
  // screen (P1; T5 mutation (a) IS that merge and reds T5). This case pins the
  // chosen shape so it is a decision on record, not an accident.
  //
  // Reverse check: at `onEnd`, merge an open paragraph shorter than the floor
  // into the last closed one.
  //   => T9 … Expected: [[r0], [r1], [r2]]  Actual: [[r0], [r1, r2]]
  // Restored; green.
  test('T9 — a 5s terminal row after two closed paragraphs is its own', () {
    final List<TimelineEntry> rows = _seam(<(String, int?)>[
      ('第一段说完了。', 45000),
      ('第二段也说完了。', 45000),
      ('好的。', 5000),
    ]);
    final List<ArticleParagraph> ps = paragraphsOf(rows);
    expect(_ids(ps), <List<String>>[
      <String>['r0'],
      <String>['r1'],
      <String>['r2'],
    ]);
    expect(ps.last.closed, isTrue);
    expect(ps.last.spokenMs, 5000);
    // And it is labelled with where it really is, not glued to 00:45.
    expect(ps.last.startMs, 90000);
  });

  // ── T10 — labels: null offsets are null, not 00:00 ───────────────────────
  //
  // Reverse check: restore `?? 0` on `startMs` (`rows.first.articleOffsetMs ?? 0`).
  //   => 'unknown offset is null' … Expected: null  Actual: <0>
  // Restored; green.
  group('T10 labels', () {
    test('known offsets label start and end from the rows', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('第一段说完了。', 45000),
        ('第二段', 30000),
      ]);
      final List<ArticleParagraph> ps = paragraphsOf(rows);
      expect(ps.first.startMs, 0);
      expect(ps.first.endMs, 45000);
      expect(ps.last.startMs, 45000);
      expect(ps.last.endMs, 75000);
    });

    test(
      'unknown offset is null — two such paragraphs must not both say 00:00',
      () {
        final List<TimelineEntry> rows = <TimelineEntry>[
          _row('r0', '第一段说完了。', ms: 45000, offsetMs: null),
          _row('r1', '第二段说完了。', ms: 45000, offsetMs: null),
          _row('r2', '第三段', ms: 30000, offsetMs: null),
        ];
        final List<ArticleParagraph> ps = paragraphsOf(rows);
        expect(ps.length, 3);
        for (final ArticleParagraph p in ps) {
          expect(p.startMs, isNull);
          expect(p.endMs, isNull);
        }
      },
    );

    test('unknown last-row length gives no end, and a known start', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('第一段说完了。', 45000),
        ('第二段', null),
      ]);
      final List<ArticleParagraph> ps = paragraphsOf(rows);
      expect(ps.last.startMs, 45000);
      expect(ps.last.endMs, isNull);
    });
  });

  // ── T11 — the duration-free backstop ─────────────────────────────────────
  //
  // 🔴 `duration_ms` is additive and can be absent. Without a length no time
  // arm ever fires — `articleOffsetMs` is accumulated from the same durations
  // and stands still too — so a recording whose rows carry no length would be
  // one paragraph that never closes, `closed:false` for the whole session.
  //
  // Reverse check: delete `|| _openUnknown >= kParagraphMaxUnknownRows`.
  //   => 'seven rows of unknown length' … Expected: [[r0, r1, r2], [r3, r4, r5], [r6]]
  //      Actual: [[r0, r1, r2, r3, r4, r5, r6]]
  //      and 'mid-recording it is closing' … Expected: <2>  Actual: <0>
  // Restored; green.
  group('T11 rows without a length', () {
    test('seven rows of unknown length close every three rows', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        for (int i = 0; i < 7; i++) ('没有时长的第$i行。', null),
      ]);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1', 'r2'],
        <String>['r3', 'r4', 'r5'],
        <String>['r6'],
      ]);
    });

    test('mid-recording it is closing, not one open wall', () {
      final ArticleParagrapher p = ArticleParagrapher();
      for (int i = 0; i < 7; i++) {
        p.onRow(_row('r$i', '没有时长的第$i行', ms: null, offsetMs: null));
      }
      expect(p.paragraphs.where((ArticleParagraph x) => x.closed).length, 2);
    });

    test(
      'rows that carry a length are not counted — five short rows stay open',
      () {
        // 🔴 The first version counted every row and closed three 5 s rows at
        // 15 s, under the floor (T8 caught it). Rows with a length are governed
        // by the floor and the cap, and only by them.
        final List<TimelineEntry> rows = _seam(<(String, int?)>[
          for (int i = 0; i < 5; i++) ('没有标点', 5000),
        ]);
        expect(_ids(paragraphsOf(rows)), <List<String>>[
          <String>['r0', 'r1', 'r2', 'r3', 'r4'],
        ]);
      },
    );

    test('mixed — a known row plus three unknown ones closes on the count', () {
      final List<TimelineEntry> rows = _seam(<(String, int?)>[
        ('有时长', 30000),
        ('没有时长', null),
        ('没有时长', null),
        ('没有时长', null),
        ('下一段', 30000),
      ]);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0', 'r1', 'r2', 'r3'],
        <String>['r4'],
      ]);
    });
  });

  // ── T12 — the persisted field, through the production seam ──────────────
  //
  // Every pause case above injects its figure through `_pauses`. These feed
  // rows whose `pauseBeforeMs` came back out of the payload codec and call
  // `paragraphsOf` with NO source, i.e. through `articlePauseBeforeMs`.
  //
  // Reverse check: `articlePauseBeforeMs` back to `=> null`
  //   => 'a codec-decoded 5,040 ms pause closes' … Expected: [[r0], [r1]]
  //      Actual: [[r0, r1]]
  // Restored; green.
  group('T12 the persisted field', () {
    List<TimelineEntry> viaCodec(int? pause) =>
        <TimelineEntry>[
              _row('r0', '没有标点的一段话', ms: 45000, offsetMs: 0),
              _row(
                'r1',
                '停过之后又说',
                ms: 30000,
                offsetMs: 45000,
                createdAtMs: 1,
                pauseBeforeMs: pause,
              ),
            ]
            .map(
              (TimelineEntry e) =>
                  timelineEntryFromJson(timelineEntryToJson(e))!,
            )
            .toList();

    test('a codec-decoded 5,040 ms pause closes', () {
      final List<TimelineEntry> rows = viaCodec(5040);
      // POSITIVE CONTROL: the figure survived the codec, so a red below is the
      // seam's answer and not a decode that lost the key.
      expect(rows[1].pauseBeforeMs, 5040);
      expect(_ids(paragraphsOf(rows)), <List<String>>[
        <String>['r0'],
        <String>['r1'],
      ]);
    });

    test(
      'an absent field (old relay, non-Soniox leg) degrades, never reads 0',
      () {
        final List<TimelineEntry> rows = viaCodec(null);
        expect(
          timelineEntryToJson(rows[1]).containsKey('pause_before_ms'),
          isFalse,
        );
        expect(articlePauseBeforeMs(rows[1]), isNull);
        expect(_ids(paragraphsOf(rows)), <List<String>>[
          <String>['r0', 'r1'],
        ]);
        // POSITIVE CONTROL: the same rows CAN split — only the figure is missing.
        expect(
          _ids(
            paragraphsOf(rows, pauseSource: _pauses(<String, int>{'r1': 5040})),
          ),
          <List<String>>[
            <String>['r0'],
            <String>['r1'],
          ],
        );
      },
    );
  });

  // The numbers themselves, written out once so that changing one is a visible
  // act rather than a silent re-calibration of every assertion in this file.
  // 🔴 Every threshold above is a LITERAL; this is the one place the literals
  // and the constants meet.
  test('the numbers are the designed numbers', () {
    expect(kParagraphTargetMs, 60000, reason: 'owner: 「1 分钟左右」');
    expect(kServerRowMinMs, 30000, reason: 'server cadence (T0 reads it back)');
    expect(kParagraphSoftMinMs, 40000, reason: 'design §3.2: 2/3 of target');
    expect(kParagraphHardMaxMs, 90000, reason: 'design §3.2: target + one row');
    expect(
      kParagraphMaxUnknownRows,
      3,
      reason: 'design §3.2: the cap in row minimums',
    );
    expect(kStrongPauseMs, 3000, reason: 'owner: 「3秒以上」');
    // The structural requirements behind the numbers, not restatements:
    //  - a floor at or below the row minimum makes one row = one paragraph;
    expect(kParagraphSoftMinMs, greaterThan(kServerRowMinMs));
    //  - the floor is where one row becomes nearer the target than two rows
    //    (|L − T| <= |2L − T| <=> L >= 2T/3);
    expect(kParagraphSoftMinMs * 3, kParagraphTargetMs * 2);
    expect(kParagraphSoftMinMs, lessThan(kParagraphTargetMs));
    expect(kParagraphTargetMs, lessThan(kParagraphHardMaxMs));
    //  - three rows of unknown length are, in truth, at least the cap (each is
    //    >= rowMin by the server's cadence), so the count is the cap restated
    //    and not a second opinion about length.
    expect(
      kParagraphMaxUnknownRows * kServerRowMinMs,
      greaterThanOrEqualTo(kParagraphHardMaxMs),
    );
  });

  test('an empty article has no paragraphs', () {
    expect(paragraphsOf(const <TimelineEntry>[]), isEmpty);
    expect(ArticleParagrapher().onEnd(), isEmpty);
  });

  test('a row of unknown length is carried, and counts as zero', () {
    final List<TimelineEntry> rows = _seam(<(String, int?)>[
      ('开场白', null),
      ('正式开始的一段话。', 45000),
      ('后面还有', 30000),
    ]);
    // r0 contributes 0ms, so the floor is met only after r1 — and the sentence
    // end that closes the paragraph is r1's, not r0's.
    expect(_ids(paragraphsOf(rows)), <List<String>>[
      <String>['r0', 'r1'],
      <String>['r2'],
    ]);
    expect(paragraphsOf(rows).first.spokenMs, 45000);
  });

  // paragraphText — 「同一段录音读成一段」 (cell E-2′); not joinSelectedTexts (owner ruling 3: one record, one '\n').
  group('paragraphText — one paragraph, one passage', () {
    ArticleParagraph para(List<String> texts) => ArticleParagraph(<TimelineEntry>[
        for (int i = 0; i < texts.length; i++) _row('p$i', texts[i], offsetMs: i * 30000)], closed: true);
    test('CJK rows join directly — no newline, no space', () {
      expect(paragraphText(para(<String>['今天先过两件事。', '第一件是库存口径'])), '今天先过两件事。第一件是库存口径');
    });
    test('an ASCII/ASCII seam gets exactly one space', () {
      expect(paragraphText(para(<String>['Done for today.', 'Next is stock.'])), 'Done for today. Next is stock.');
    });
    test('blank rows are dropped', () {
      expect(paragraphText(para(<String>['a', '  ', 'b'])), 'a b');
    });
  });
}

const List<String> _kTails = <String>['。', '！', '？', ' friday.', '', '', ' 3.'];

List<TimelineEntry> _randomArticle(Random rng) {
  final int n = 1 + rng.nextInt(12);
  final List<(String, int?)> spec = <(String, int?)>[];
  for (int i = 0; i < n; i++) {
    final int roll = rng.nextInt(20);
    final int? ms = roll == 0
        ? null
        : roll == 1
        ? 0
        : 5000 + rng.nextInt(115000);
    spec.add(('句子$i${_kTails[rng.nextInt(_kTails.length)]}', ms));
  }
  return _seam(spec);
}

/// The rule has two live configurations, and they are NOT equally important.
enum _Corpus {
  /// 🔴 THE PRIMARY PATH. What ships once CR-12-D lands: the managed engine is
  /// Soniox, every token already carries `start_ms`/`end_ms` (design §2.4,
  /// measured on real `stt-rt-v5` frames), so every row arrives with a pause
  /// figure. Every property below is asserted on THIS corpus first.
  withPause,

  /// The degraded path, and it is permanent rather than temporary: a
  /// non-Soniox leg (sherpa / FunASR / Deepgram send no timestamps), an old
  /// relay that strips the additive field, or a row recorded before CR-12-D.
  degraded,
}

/// Pause figures shaped like the real ones: quantised to the 60 ms frame grid
/// Soniox reports on, mostly ordinary between-word gaps (measured <=480 ms
/// inside speech), occasionally a real silence.
Map<String, int> _randomPauses(Random rng, List<TimelineEntry> rows) {
  final Map<String, int> out = <String, int>{};
  for (final TimelineEntry r in rows) {
    final int roll = rng.nextInt(10);
    final int ms = roll < 6
        ? rng.nextInt(9) *
              60 // 0–480ms: ordinary speech
        : roll < 8
        ? 600 +
              rng.nextInt(40) *
                  60 // 600–2,940ms: a breath, below thresh
        : 3000 + rng.nextInt(100) * 60; // a real silence
    out[r.id] = ms;
  }
  return out;
}

ArticlePauseSource _sourceFor(_Corpus corpus, Map<String, int> byId) =>
    corpus == _Corpus.withPause ? _pauses(byId) : articlePauseBeforeMs;

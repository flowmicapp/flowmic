// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.F③ (the re-transcription channel), §4.D (why a backfilled row's offset
//     comes from a different place than a live one), §6 C3 / C4 / C5
//   apps/mobile/lib/src/timeline/article.dart (ArticleClock, the live cursor)
//
// ── WHY A SECOND CURSOR AND NOT A SECOND CALL ON THE FIRST ONE ──────────────
//
// A backfilled row lands INSIDE a stretch of the recording that has already
// been accounted for. The live clock advanced past that outage the moment the
// link returned — it had to, or every live row spoken afterwards would sit at an
// offset that pretends the outage had no duration.
//
// So when the outage's audio is finally re-transcribed, its rows must be placed
// WITHIN the span already reserved for them, and must not advance anything.
// Handing that to `ArticleClock.claim` would mean one method answering two
// questions — 「where does the next new thing go」 and 「where inside an old gap
// does this go」 — which is the defect shape this repo names first. The replay
// gets its own cursor, and the two can even run at the same time: ruling ⑮
// allows the backfill to lag, so a user can be speaking live while an earlier
// outage is still being caught up.
//
// ⚠️ THE STRETCH'S START IS AN INPUT, NEVER A GUESS. Whoever begins a replay
// must already know where the gap begins — from the live clock if the recording
// is still running, or derived from the rows already filed under that article if
// the app was killed and this is an orphan. Both are measurements; there is no
// third case where it would be reasonable to start at zero.

import 'package:flutter/foundation.dart';

/// Where the rows recovered from one offline stretch belong.
@immutable
class ArticleReplayTarget {
  const ArticleReplayTarget({
    required this.articleId,
    required this.stretchStartMs,
  });

  final String articleId;

  /// Audio-time offset, from the article's first byte, at which this stretch
  /// begins. See the file header on why it is supplied rather than computed.
  final int stretchStartMs;
}

/// The cursor for one offline stretch being replayed.
class ArticleReplayCursor {
  ArticleReplayCursor(this.target);

  final ArticleReplayTarget target;
  int _withinMs = 0;

  String get articleId => target.articleId;

  /// How much of this stretch has been placed so far.
  int get withinMs => _withinMs;

  /// The offset for the next recovered row, advancing by [durationMs].
  ///
  /// Null durations advance nothing, for the same reason the live clock refuses
  /// to guess: a row whose engine reported no length still happened here, but
  /// nothing is known about how long it took, and a default would push every
  /// later row in the stretch wrong by that default.
  int claim(int? durationMs) {
    final int start = target.stretchStartMs + _withinMs;
    if (durationMs != null && durationMs > 0) _withinMs += durationMs;
    return start;
  }
}

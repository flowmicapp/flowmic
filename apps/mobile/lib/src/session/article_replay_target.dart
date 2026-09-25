// Card RC-3 — WHERE ONE RETAINED STRETCH'S RECOVERED ROWS BELONG, asked by
// BOTH recovery legs.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.7 and §5 RC-3
//   apps/mobile/lib/src/audio/article_replay.dart (the cursor this feeds)
//
// MOVED, NOT REWRITTEN. The body below is `BackfillRunner._targetFor` as it
// stood (session/backfill_runner.dart), with its three reads of the runner's
// fields turned into parameters. It moved because a second caller needed the
// same answer: the journal leg (`RecoveryJournalLeg._attempt`) never asked at
// all, so its rows went through `ArticleScribe.claim` with no replay cursor
// open and landed on the LIVE clock — after the recording's end, with the
// whole range's length (root-cause §1.7: 1:57 + 6:38 = 8:36). A copy of the
// derivation in that file would have been two answers to one question the day
// either of them changed.

import '../audio/article_replay.dart';
import '../audio/article_scribe.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';

/// Where one retained session's rows belong, or null when nothing can say.
///
/// 🔴 TWO SOURCES, AND NEITHER IS A DEFAULT OF ZERO.
///   · the recording is still running ⇒ the live clock already accounted for
///     the outage when the link returned, and knows where it started;
///   · the app was killed and this is an orphan ⇒ derive it from the rows
///     already filed under that article: the stretch begins where the last
///     row before it ended.
/// When the key is not an article at all (an ordinary press's retained tail),
/// there is no article and the recovered rows are ordinary rows — which is
/// correct, and the reason this returns null rather than inventing one.
ArticleReplayTarget? articleReplayTargetFor({
  required ArticleScribe articles,
  required TimelineStore timeline,
  required String sessionKey,
  /// Card RC-3 — the same recorded answer as [ArticleScribe.peekStretchStart],
  /// read back from where it was persisted (the journal manifest's transcribed
  /// prefix) when the in-memory one is gone. Null for the legacy leg.
  int? persistedStartMs,
  /// Card RC-K — the placement persisted WITH this stretch (`OwedRange.atMs`):
  /// the same clock value the in-memory start holds, but tied to its own
  /// stretch rather than to a queue position, so a recording with two owed
  /// stretches places each at its own spot, after a relaunch too. Wins.
  int? pinnedStartMs,
}) {
  // 🔴 THE RECORDED ANSWER FIRST. The clock measured this gap at the one
  // instant it was measurable; the derivation below is a fallback for the
  // case where no clock was there to measure it, and using it when a
  // recorded answer exists puts the recovered sentences after the live
  // ones that followed them.
  final int? recorded = pinnedStartMs ??
      articles.peekStretchStart(sessionKey) ??
      persistedStartMs;
  if (recorded != null) {
    return ArticleReplayTarget(
      articleId: sessionKey,
      stretchStartMs: recorded,
    );
  }
  final List<TimelineEntry> members = articleMembersOf(timeline, sessionKey);
  if (members.isEmpty) {
    // No rows under this id: either it is not an article, or the outage
    // swallowed the whole recording. The second case starts at zero and IS
    // measurable — the article has no audio before this stretch.
    final int? accounted =
        articles.articleId == sessionKey ? articles.accountedMs : null;
    if (accounted == null) return null;
    return ArticleReplayTarget(
      articleId: sessionKey,
      stretchStartMs: accounted,
    );
  }
  int end = 0;
  for (final TimelineEntry m in members) {
    final int e = (m.articleOffsetMs ?? 0) + (m.durationMs ?? 0);
    if (e > end) end = e;
  }
  return ArticleReplayTarget(articleId: sessionKey, stretchStartMs: end);
}

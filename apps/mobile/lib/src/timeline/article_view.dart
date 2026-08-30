// Card CR-8 / demo cell E-1 — 「列表里是一张卡，不是四十行」
// ("one card in the list, not forty rows").
//
// SPEC-REF: docs/ui-design/2026-08-29-continuous-recording-demo.html cell E-1
//   (the light-record screen's own list) and cell C-1 (the in-progress face,
//   where the segments of the recording that is running are STILL rows, each
//   carrying its own range 「02:41 – 03:08」).
//
// ── 🔴 WHY THIS FILE EXISTS AT ALL: THE COLLAPSE WAS IN THE WRONG PLACE ──────
//
// 0.3.47 shipped the collapse in `LightRecordQuery.all()` — the 「+」 panel's
// light-record tab — and NOWHERE ELSE. The screen a continuous recording is
// actually made on and read back on is the transcription page, which renders
// `TimelineStore.entriesForOwners(...)` with no collapsing of any kind. So a
// half-hour recording arrived exactly as it always had: one row per segment,
// every thirty seconds, plus a stray head bubble among them.
//
// 🔴 THE ACCEPTANCE TESTS FOR CR-7/CR-8 WERE ALL GREEN WHILE THIS WAS TRUE,
// and they were green honestly: they asserted the MODEL (`articleMembersOf`,
// the head's derived numbers) and the `ArticlePage` RENDER. Nothing on the
// light-record screen routes to `ArticlePage`, and no test asked the screen
// what it was showing. 「契约写对了不等于实现做到了」 in its exact form — and
// the specific lesson is narrower and more useful than that: a feature whose
// deliverable is 「what the user sees on screen X」 is not tested until
// something drives screen X.
//
// ⇒ [collapseArticles] is a PURE function over rows so that the assertion can
// be made on the list the screen is handed, and `article_screen_test.dart`
// additionally drives the real page.

import 'timeline_entry.dart';

/// Every row of [rows] that belongs to [articleId], OLDEST FIRST — the
/// transcript order.
///
/// 🔴 THE ORDER IS THE CONTRACT, AND IT HAS ONE AUTHOR. Three readers need it
/// (`articleMembersOf` over the store, `articleMembersOnDisk` and
/// `LightRecordQuery.membersOf` over storage) and until 2026-08-30 two of them
/// each carried their own copy of this sort. Copy paths now render a recording
/// through whichever reader their screen has, so the sort those readers share
/// is what makes 「the order the page shows」 and 「the order the clipboard
/// gets」 the same fact rather than two that happen to agree.
///
/// Position inside the recording when both rows know it — NOT `createdAt`: a
/// backfilled segment is written to disk long after the live segments that
/// follow it inside the recording, so creation order is the order we HEARD
/// them, and a transcript is the order they were SAID. `createdAt` is the
/// tie-break, and the only order a row with no offset has.
///
/// Excludes the head (a cover is not one of the things that were said) and
/// soft-deleted rows.
List<TimelineEntry> articleMembersIn(
  Iterable<TimelineEntry> rows,
  String articleId,
) {
  final List<TimelineEntry> members = <TimelineEntry>[
    for (final TimelineEntry e in rows)
      if (e.articleId == articleId && !e.isArticle && !e.deleted) e,
  ];
  members.sort((TimelineEntry a, TimelineEntry b) {
    final int? ao = a.articleOffsetMs;
    final int? bo = b.articleOffsetMs;
    if (ao != null && bo != null && ao != bo) return ao.compareTo(bo);
    return a.createdAt.compareTo(b.createdAt);
  });
  return List<TimelineEntry>.unmodifiable(members);
}

/// Replace the member rows of every FINISHED article with its head row.
///
/// [rows] is the screen's own list, in whatever order it already had; the
/// result preserves that order, with each finished article's members removed
/// and its head left standing where it already was (the head's `createdAt` is
/// the recording's start, so the card lands at the moment the user pressed the
/// button rather than at the moment its first sentence settled).
///
/// [liveArticleId] is the recording still being recorded, from
/// `ArticleScribe.liveArticleId` — its members are left ALONE. That is demo
/// cell C-1: while a recording runs, what has been said so far is on screen as
/// it is said. Collapsing the live one would replace the live transcript with
/// a card whose word count ticks upward, which is a worse answer to 「is it
/// hearing me」 than the words themselves.
///
/// 🔴 A HEADLESS MEMBER IS LEFT ALONE, AND IT MUST BE. A member whose head row
/// is not in [rows] is dropped by no rule here — it stays a row. Two real ways
/// that happens: the page is showing a window of history that starts after the
/// recording began (`OwnerTimelinePager` pages upward, so a card can be one
/// scroll above the rows it owns), and a head that was deleted while its
/// members were not. In both, hiding the member would remove words from the
/// screen with nothing to open instead — the collapse may only ever REPLACE.
List<TimelineEntry> collapseArticles(
  List<TimelineEntry> rows, {
  String? liveArticleId,
}) {
  // One pass to learn which articles have a head present, so the second pass
  // can honour the rule above without an O(n²) lookback.
  final Set<String> headed = <String>{};
  for (final TimelineEntry e in rows) {
    final String? id = e.articleId;
    if (e.isArticle && id != null) headed.add(id);
  }
  if (headed.isEmpty) return rows;
  return List<TimelineEntry>.unmodifiable(<TimelineEntry>[
    for (final TimelineEntry e in rows)
      if (!_collapsedAway(e, headed, liveArticleId)) e,
  ]);
}

bool _collapsedAway(
  TimelineEntry e,
  Set<String> headed,
  String? liveArticleId,
) {
  // 🔴 THE LIVE RECORDING'S OWN HEAD IS HIDDEN, not just its members kept.
  //
  // The head is minted on the first segment that settles, so without this a
  // half-built card sits in the list WHILE the recording runs — right beside
  // the in-progress bar, which is already saying 「已成 N 段」 and 「说过的话
  // 已经在这一篇里」. Two faces answering 「how is this recording going」, and
  // the card's numbers are always the staler of the two (recomputed per settle;
  // the bar counts live). Demo cell C-1 shows the bar and no card.
  //
  // Measured, not reasoned: the C-1 case in `article_screen_test.dart` found
  // the card on screen mid-recording.
  if (e.isArticle) return e.articleId == liveArticleId;
  if (!e.isInArticle) return false;
  final String id = e.articleId!;
  if (id == liveArticleId) return false;
  return headed.contains(id);
}

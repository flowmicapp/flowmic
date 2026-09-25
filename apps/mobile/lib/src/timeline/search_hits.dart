// Card CR-12-G — a search that finds words inside a recording answers with the
// RECORDING, once.
//
// SPEC-REF: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//   §11.3 (one result per recording, ordered by its newest matching row),
//   §11.4 (what the result shows), §11.5 (rows are read with a larger limit and
//   cut to results only after grouping).
//
// A recording's parts are ordinary rows, each carrying its own words, so the
// storage search has always found them. What it could not do is say which
// recording a matching row belongs to: half an hour of meeting that mentions a
// topic in twelve parts came back as twelve loose rows and pushed every other
// hit off the first screen. Grouping is done here, over rows, so the two
// screens that search (the full-history page and the 「+」 panel's light-record
// tab) share one rule and one test.

import 'dart:math' as math;

import 'article_paragraphs.dart';
import 'article_view.dart' show articleMembersIn;
import 'timeline_entry.dart';

/// How many RESULTS a search shows. The storage read asks for more ROWS than
/// this (`SqfliteTimelinePersistence.search`), because one recording can own
/// dozens of matching rows and must not crowd out everything else.
const int kSearchResultLimit = 200;

/// Where inside a recording its first match is, in transcript order.
class ArticleHitFocus {
  const ArticleHitFocus({
    required this.paragraphIndex,
    required this.paragraph,
    required this.rowId,
  });

  /// Index into `paragraphsOf(members)` — the same list `ArticlePage` draws.
  final int paragraphIndex;
  final ArticleParagraph paragraph;

  /// The matching row inside [paragraph]. `ArticlePage` is handed this id and
  /// finds the paragraph itself, so the page never trusts an index computed
  /// against a different member list.
  final String rowId;
}

/// One recording in a result list.
class ArticleSearchHit {
  const ArticleSearchHit({
    required this.head,
    required this.hitCount,
    this.focus,
  });

  final TimelineEntry head;

  /// Occurrences of the query word across the member rows that matched — a
  /// row containing the word twice counts two. Zero when only the title
  /// matched. Counted by [matchRanges], so the case rule is the storage
  /// match's own.
  final int hitCount;

  /// Null when no member row matched (a title-only hit).
  final ArticleHitFocus? focus;
}

/// A grouped result list.
class SearchResults {
  const SearchResults(this.rows, this.articles);

  static const SearchResults empty = SearchResults(
    <TimelineEntry>[],
    <String, ArticleSearchHit>{},
  );

  /// Newest first. A recording appears ONCE, as its head row, at the position
  /// of its newest matching row; every other row is itself.
  final List<TimelineEntry> rows;

  /// articleId → the recording's result, for every head in [rows].
  final Map<String, ArticleSearchHit> articles;

  /// The recording [row] stands for in this list, or null for an ordinary row.
  ArticleSearchHit? articleOf(TimelineEntry row) {
    final String? id = row.articleId;
    return (row.isArticle && id != null) ? articles[id] : null;
  }
}

/// The recordings [matches] touch — what the caller must read [groupSearchHits]'s
/// `articleRows` for.
Set<String> articleIdsOf(Iterable<TimelineEntry> matches) => <String>{
  for (final TimelineEntry e in matches)
    if (e.articleId != null) e.articleId!,
};

/// Group [matches] (newest first, as storage returns them) by recording.
///
/// [articleRows] holds every live row — heads and members — of the recordings
/// in [matches]; the heads come from there because a matching part is rarely
/// matched together with its head, and the members because the result shows
/// the first matching PARAGRAPH, which is computed over all of them.
///
/// A member whose head is not in [articleRows] stays an ordinary row, the rule
/// `collapseArticles` states: grouping may only replace rows, never hide words
/// with nothing to open instead.
SearchResults groupSearchHits(
  List<TimelineEntry> matches, {
  required List<TimelineEntry> articleRows,
  required String query,
  int limit = kSearchResultLimit,
}) {
  final Map<String, TimelineEntry> heads = <String, TimelineEntry>{
    for (final TimelineEntry e in <TimelineEntry>[...articleRows, ...matches])
      if (e.isArticle && !e.deleted && e.articleId != null) e.articleId!: e,
  };
  final List<TimelineEntry> order = <TimelineEntry>[];
  final Map<String, Set<String>> hitIds = <String, Set<String>>{};
  final Map<String, TimelineEntry> hitRows = <String, TimelineEntry>{};
  for (final TimelineEntry e in matches) {
    final String? id = e.articleId;
    final TimelineEntry? head = id == null ? null : heads[id];
    if (head == null) {
      order.add(e);
      continue;
    }
    if (!hitIds.containsKey(id)) order.add(head);
    final Set<String> ids = hitIds.putIfAbsent(id!, () => <String>{});
    if (e.isInArticle) {
      ids.add(e.id);
      hitRows[e.id] = e;
    }
  }
  final List<TimelineEntry> rows =
      order.length > limit ? order.sublist(0, limit) : order;
  final Map<String, ArticleSearchHit> articles = <String, ArticleSearchHit>{};
  for (final TimelineEntry r in rows) {
    final String? id = r.articleId;
    if (!r.isArticle || id == null) continue;
    final Set<String> ids = hitIds[id] ?? const <String>{};
    int count = 0;
    for (final String hitId in ids) {
      count += matchRanges(hitRows[hitId]?.displayText ?? '', query).length;
    }
    articles[id] = ArticleSearchHit(
      head: r,
      hitCount: count,
      focus: _firstHit(articleMembersIn(articleRows, id), ids),
    );
  }
  return SearchResults(
    List<TimelineEntry>.unmodifiable(rows),
    Map<String, ArticleSearchHit>.unmodifiable(articles),
  );
}

ArticleHitFocus? _firstHit(List<TimelineEntry> members, Set<String> hitIds) {
  if (hitIds.isEmpty) return null;
  final List<ArticleParagraph> paragraphs = paragraphsOf(members);
  for (int k = 0; k < paragraphs.length; k++) {
    for (final TimelineEntry r in paragraphs[k].rows) {
      if (hitIds.contains(r.id)) {
        return ArticleHitFocus(
          paragraphIndex: k,
          paragraph: paragraphs[k],
          rowId: r.id,
        );
      }
    }
  }
  return null;
}

/// Every `[start, end)` where [query] occurs in [text], case-insensitively —
/// the same case rule the storage match uses (`timelineSearchText` lowercases).
///
/// When lowercasing changes a string's length (a handful of scripts do) the
/// indices of the lowered copy no longer point into the original, so the
/// search falls back to exact case rather than highlighting the wrong letters.
List<(int, int)> matchRanges(String text, String query) {
  final String q = query.trim();
  if (q.isEmpty || text.isEmpty) return const <(int, int)>[];
  final String lt = text.toLowerCase();
  final String lq = q.toLowerCase();
  final bool folded = lt.length == text.length && lq.length == q.length;
  final String hay = folded ? lt : text;
  final String needle = folded ? lq : q;
  final List<(int, int)> out = <(int, int)>[];
  int from = 0;
  while (true) {
    final int at = hay.indexOf(needle, from);
    if (at < 0) break;
    out.add((at, at + needle.length));
    from = at + needle.length;
  }
  return out;
}

/// About [radius] characters either side of the first match of [query] in
/// [text], with 「…」 where text was cut. No match ⇒ the opening of [text].
String searchSnippet(String text, String query, {int radius = 30}) {
  final List<(int, int)> hits = matchRanges(text, query);
  final int start = hits.isEmpty ? 0 : hits.first.$1;
  final int end = hits.isEmpty ? 0 : hits.first.$2;
  int from = hits.isEmpty ? 0 : math.max(0, start - radius);
  int to = math.min(text.length, (hits.isEmpty ? radius * 2 : end + radius));
  from = _notInsidePair(text, from);
  to = _notInsidePair(text, to);
  return '${from > 0 ? '…' : ''}${text.substring(from, to)}'
      '${to < text.length ? '…' : ''}';
}

/// Moves a cut off the low half of a surrogate pair, so an emoji is never
/// split into a replacement character.
int _notInsidePair(String text, int i) {
  if (i <= 0 || i >= text.length) return i;
  final int unit = text.codeUnitAt(i);
  return (unit >= 0xDC00 && unit <= 0xDFFF) ? i - 1 : i;
}

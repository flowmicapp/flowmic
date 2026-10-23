// SPEC-REF:
//   docs/decisions/2026-10-10-owner-rulings-renewal-longrec-billing-eu.md item 2
//     (「文中标出空白」 — the text marks the gap)
//   docs/strategy/2026-10-10-long-recording-app-switch-review.md §3 D3, §4 plan A
//   apps/mobile/lib/src/audio/continuous_away.dart (the producer)
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
//
// D3: a pause for leaving the app left no trace in the article — the time away
// was folded into a neighbouring row's range. Since D6-CATCHUP-DUP the pause is
// trimmed out of the rows' audio time (`ArticleScribe.liveResumed`), which made
// the ranges honest and the gap INVISIBLE: the text simply runs on. This file
// holds the one fact that makes it visible again — 「at this point in the
// recording, this much was not recorded because the user had left」 — and
// places it between paragraphs.
//
// ── 🔴 WHY A SIDE STORE AND NOT A ROW OR A HEAD FIELD ───────────────────────
//
// A row would be a transcript row with no words — it would count as a
// segment, sync, export and be offered for sending (every one of those
// readers would need a guard). The article head is DERIVED from its members
// and recomputed whenever they change (timeline_store_article_rows.dart header),
// so a fact stored there would be overwritten by the next recompute. The gap is
// device-local presentation of a device-local fact, so it lives in local prefs,
// keyed by article id. ⚠️ It is NOT in the FPR export (16 册) — a known limit,
// not an oversight.
//
// ── ⚠️ WHERE THE MARKER SITS IS APPROXIMATE, AND BY HOW MUCH ────────────────
//
// The relay does not close a segment on `audio:pause`: a silence hang-up folds
// the open text back into its accumulators (server-core
// `stt/engine-idle-hangup.ts`, `flushAndCloseLeg`), so the row in progress when
// the user left carries on after the return and can hold words from BOTH sides
// of the gap. The marker goes before the first row that starts at (or within
// [kAwayGapPlacementSlackMs] before) the pause point; a row that straddles the
// pause by more than that is drawn above the marker. Making the place exact is
// the server half of NR-213 (close the segment on a long recording's pause),
// which this card did not do.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../settings/local_prefs.dart';
import 'article_paragraphs.dart';
import 'timeline_entry.dart';

/// One stretch the user was away for, inside one article.
@immutable
class ArticleAwayGap {
  const ArticleAwayGap({required this.atMs, required this.awayMs});

  /// Where in the recording, in ms of recorded audio
  /// (`TimelineEntry.articleOffsetMs`'s unit).
  final int atMs;

  /// How long nothing was recorded.
  final int awayMs;

  Map<String, Object?> toJson() => <String, Object?>{'at': atMs, 'away': awayMs};

  static ArticleAwayGap? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? at = raw['at'];
    final Object? away = raw['away'];
    if (at is! int || away is! int || away <= 0) return null;
    return ArticleAwayGap(atMs: at, awayMs: away);
  }
}

/// A row that starts this much before the pause point still goes after the
/// marker: the phone's audio clock and the relay's row durations differ by
/// sub-second latency, and a row that begins right at the return must not be
/// drawn above the gap it follows.
const int kAwayGapPlacementSlackMs = 1000;

/// How many articles keep their gaps. The store is local prefs, so it is
/// bounded; the oldest recordings lose their markers first.
const int kAwayGapArticlesKept = 64;

/// The paragraphs of [rows] (oldest first, as `articleMembersOf` orders them),
/// broken at every gap, and which gaps are drawn before which paragraph.
///
/// `gapsBefore[k]` lists the gaps drawn above paragraph `k`;
/// `gapsBefore[paragraphs.length]` the ones after the last paragraph.
/// [open] — the recording is still running: the last paragraph stays open
/// (`ArticleParagrapher.paragraphs` rather than `onEnd`).
({List<ArticleParagraph> paragraphs, Map<int, List<ArticleAwayGap>> gapsBefore})
paragraphsWithAwayGaps(
  List<TimelineEntry> rows,
  List<ArticleAwayGap> gaps, {
  bool open = false,
}) {
  final List<ArticleAwayGap> pending = List<ArticleAwayGap>.of(gaps)
    ..sort((ArticleAwayGap a, ArticleAwayGap b) => a.atMs.compareTo(b.atMs));
  final ArticleParagrapher p = ArticleParagrapher();
  final Map<int, List<ArticleAwayGap>> before = <int, List<ArticleAwayGap>>{};
  for (final TimelineEntry r in rows) {
    final int? at = r.articleOffsetMs;
    while (pending.isNotEmpty &&
        at != null &&
        at >= pending.first.atMs - kAwayGapPlacementSlackMs) {
      p.breakHere(); // ⇒ every paragraph so far is closed
      (before[p.paragraphs.length] ??= <ArticleAwayGap>[]).add(pending.removeAt(0));
    }
    p.onRow(r);
  }
  final List<ArticleParagraph> paragraphs = open ? p.paragraphs : p.onEnd();
  if (pending.isNotEmpty) {
    (before[paragraphs.length] ??= <ArticleAwayGap>[]).addAll(pending);
  }
  return (paragraphs: paragraphs, gapsBefore: before);
}

/// The persisted gaps, per article. One instance per chat controller.
class ArticleAwayGapStore extends ChangeNotifier {
  ArticleAwayGapStore({required LocalPrefs prefs}) : _prefs = prefs {
    unawaited(_load());
  }

  final LocalPrefs _prefs;

  /// Insertion-ordered, so the oldest article is the first one dropped.
  final Map<String, List<ArticleAwayGap>> _byArticle =
      <String, List<ArticleAwayGap>>{};

  /// A gap recorded before the load finished; merged in when it lands.
  bool _loaded = false;

  /// The load is async and the controller can be torn down before it lands.
  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  List<ArticleAwayGap> gapsOf(String articleId) =>
      List<ArticleAwayGap>.unmodifiable(
        _byArticle[articleId] ?? const <ArticleAwayGap>[],
      );

  Future<void> _load() async {
    final String raw = await _prefs.articleAwayGapsJson();
    final Map<String, List<ArticleAwayGap>> stored =
        <String, List<ArticleAwayGap>>{};
    try {
      final Object? decoded = raw.isEmpty ? null : jsonDecode(raw);
      if (decoded is Map) {
        for (final MapEntry<Object?, Object?> e in decoded.entries) {
          final Object? list = e.value;
          if (e.key is! String || list is! List) continue;
          stored[e.key! as String] = <ArticleAwayGap>[
            for (final Object? g in list) ?ArticleAwayGap.fromJson(g),
          ];
        }
      }
    } on FormatException {
      // A damaged blob loses the markers, never the recording. Start empty.
    }
    if (_disposed) return;
    // Anything added while loading was recorded after what is on disk.
    final Map<String, List<ArticleAwayGap>> early =
        Map<String, List<ArticleAwayGap>>.of(_byArticle);
    _byArticle
      ..clear()
      ..addAll(stored);
    for (final MapEntry<String, List<ArticleAwayGap>> e in early.entries) {
      (_byArticle[e.key] ??= <ArticleAwayGap>[]).addAll(e.value);
    }
    _loaded = true;
    if (early.isNotEmpty) await _save();
    notifyListeners();
  }

  /// Record one gap and persist it.
  Future<void> add(String articleId, ArticleAwayGap gap) async {
    if (gap.awayMs <= 0 || _disposed) return;
    final List<ArticleAwayGap> list =
        _byArticle.remove(articleId) ?? <ArticleAwayGap>[];
    _byArticle[articleId] = list..add(gap); // re-inserted ⇒ newest
    while (_byArticle.length > kAwayGapArticlesKept) {
      _byArticle.remove(_byArticle.keys.first);
    }
    notifyListeners();
    if (_loaded) await _save();
  }

  Future<void> _save() => _prefs.setArticleAwayGapsJson(
    jsonEncode(<String, Object?>{
      for (final MapEntry<String, List<ArticleAwayGap>> e
          in _byArticle.entries)
        e.key: <Object?>[for (final ArticleAwayGap g in e.value) g.toJson()],
    }),
  );
}

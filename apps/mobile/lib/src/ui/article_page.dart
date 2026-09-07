// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §5-7 (「一篇的呈现」 — the article as a card in the list, and a timestamped
//     body when opened), §4.D (where each timestamp comes from), §6 C2
//   apps/mobile/lib/src/timeline/article.dart (the clock and the summary)
//
// ── 🔴 THE TIMESTAMPS ARE THE PRODUCT HERE ──────────────────────────────────
//
// §5-7 states the constraint that makes this page worth having and also the one
// way to ruin it: 「时间戳格式与真实分段一致 —— 不许为了整齐把它们凑成 10 秒一格」
// (「the timestamps match the real segmentation — they must not be rounded into
// tidy ten-second buckets」). Doing that would turn 「segmented by natural
// speech」, which is the feature, into a decoration.
//
// So every range on this page is `[offset, offset + duration)` off the row
// itself. A row with no duration gets a START and no end, which is the honest
// rendering of 「we know where this began and the engine never told us how long
// it was」 — not a zero-length range, and not an invented one.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/entry_metrics.dart';
import '../timeline/timeline_entry.dart';
import 'tokens.dart';

/// `mm:ss` from milliseconds of audio.
///
/// Deliberately not `formatEntryDuration`: that one answers 「how long is this」
/// and is written for a duration; this answers 「where in the recording are we」
/// and has to stay monotonic past an hour, which it does by letting the minutes
/// field grow rather than rolling into an hours field nobody asked for.
String formatArticleOffset(int ms) {
  final int total = (ms < 0 ? 0 : ms) ~/ 1000;
  final String mm = (total ~/ 60).toString().padLeft(2, '0');
  final String ss = (total % 60).toString().padLeft(2, '0');
  return '$mm:$ss';
}

/// The range one row occupies, or just its start when its length is unknown.
String formatArticleRange(TimelineEntry row) {
  final int start = row.articleOffsetMs ?? 0;
  final int? d = row.durationMs;
  if (d == null || d <= 0) return formatArticleOffset(start);
  return '${formatArticleOffset(start)}–${formatArticleOffset(start + d)}';
}

/// One continuous recording, read as a transcript.
class ArticlePage extends StatelessWidget {
  const ArticlePage({
    super.key,
    required this.head,
    required this.rows,
    required this.strings,
    this.pendingBackfillMs = 0,
    this.pendingBackfillFromOutage = false,
  });

  /// The article's head row — its title, start and totals.
  final TimelineEntry head;

  /// Its members, OLDEST FIRST. The caller reads them through
  /// `articleMembersOf`, which is the one place that ordering is decided.
  final List<TimelineEntry> rows;

  final AppStrings strings;

  /// 🔴 Ruling ⑮ — how much of this recording is still being caught up.
  ///
  /// Zero means nothing is owed. It is passed in rather than read here because
  /// the number belongs to the recovery channel, and a page that reached for it
  /// would be a second reader of a fact with one owner.
  final int pendingBackfillMs;

  /// Card LK-3 — was any of [pendingBackfillMs] recorded while the link was
  /// down?
  ///
  /// 🔴 IT CHOOSES BETWEEN TWO SENTENCES AND THE WRONG ONE IS A CLAIM ABOUT
  /// THE USER'S NETWORK. False is the sentence that says only what is
  /// measured; true adds 「offline」, which the recovery channel is the only
  /// thing able to know (`BackfillProgress.pendingFromOutage`).
  final bool pendingBackfillFromOutage;

  @override
  Widget build(BuildContext context) {
    final String title =
        head.outputText.isEmpty ? strings.articleNoTitle : head.outputText;
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      body: ListView(
        key: const Key('article.body'),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: <Widget>[
          _header(context),
          if (pendingBackfillMs > 0) _pending(),
          const SizedBox(height: 8),
          for (final TimelineEntry row in rows) _row(row),
          if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 24),
              child: Text(
                strings.articleNoTitle,
                key: const Key('article.empty'),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 13),
              ),
            ),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          strings.articleStartedAt(
            MaterialLocalizations.of(context)
                .formatMediumDate(head.createdAt.toLocal()),
          ),
          key: const Key('article.started'),
          style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
        ),
        const SizedBox(height: 2),
        Text(
          // 🔴 The head's own duration — the SUM of its members' audio, which is
          // not (ended − started). A recording that spent four minutes
          // backgrounded produced no audio for them, and this number must not
          // claim it did.
          strings.articleCardMeta(
            formatEntryDuration(head.durationMs ?? 0),
            rows.length,
          ),
          key: const Key('article.meta'),
          style: TextStyle(color: FlowMicColors.t3, fontSize: 12),
        ),
      ],
    ),
  );

  Widget _pending() => Container(
    key: const Key('article.backfill'),
    margin: const EdgeInsets.only(top: 8),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(8),
    ),
    // 🔴 THE KEY IS ON THE TEXT AS WELL AS THE BOX. A key on a line's
    // CONTAINER is not a key on its Text — this repo has already paid for that
    // once, and a test reading the container gets a Container back and fails
    // with a cast error that looks like a widget-tree problem.
    child: Text(
      key: const Key('article.backfill.text'),
      pendingBackfillFromOutage
          ? strings.articleBackfillPending(formatEntryDuration(pendingBackfillMs))
          : strings.articleBackfillUnconfirmed(
              formatEntryDuration(pendingBackfillMs)),
      style: TextStyle(color: FlowMicColors.t2, fontSize: 12),
    ),
  );

  Widget _row(TimelineEntry row) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          formatArticleRange(row),
          // Keyed per row so a test can assert THE RANGE OF THIS ROW rather
          // than 「some range is on screen」 — the difference that made the
          // in-article ordering defect visible in the first place.
          key: Key('article.range.${row.id}'),
          style: TextStyle(
            color: FlowMicColors.t3,
            fontSize: 11,
            fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 2),
        Text(
          row.displayText,
          key: Key('article.text.${row.id}'),
          style: TextStyle(color: FlowMicColors.t1, fontSize: 14.5, height: 1.4),
        ),
      ],
    ),
  );
}

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
//
// ── CR-12-B: THE BODY IS PARAGRAPHS, THE NUMBERS ARE STILL THE ROWS' ─────────
//
// Owner 2026-09-22 replaced cell E-2 (one block per row) with E-2′: the body
// reads as paragraphs of about a minute, grouped by `paragraphsOf`
// (`article_paragraphs.dart`, CR-12 design §3). The grouping sits ABOVE the
// rows — no row is split, merged or re-timed — so a paragraph's label is its
// first row's offset to its last row's offset + duration, through the same
// `formatArticleOffset` a row label uses. Historical articles get the same
// rule for free: it is computed at read time and writes nothing.

import 'dart:async';

import 'package:flutter/material.dart';

import '../ptt/ptt_session.dart'
    show ContinuousOffline, PttSessionContinuous, PttSessionLinkLoss;
import '../session/backfill_runner.dart' show ArticleBackfill;
import '../session/chat_controller.dart';
import '../session/engine_reconnect_state.dart' show EngineReconnectFace; // NR-96-B
import '../settings/app_strings.dart';
import '../signaling/wire_payloads.dart' show Delivery, FlowMode;
import '../timeline/article_paragraphs.dart';
import '../timeline/entry_metrics.dart';
import '../timeline/search_hits.dart' show matchRanges;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart' show articleMembersOf;
import 'chat_message_tile.dart' show LiveDraftTile, entryMetricsLine;
import 'live_health_copy.dart';
import 'search_highlight.dart';
import 'tokens.dart';

part 'article_page_live.dart';

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

/// `start–end`, or just `start` when the end is not known. The one place a
/// range is spelled, for a row and for a paragraph alike.
String _formatSpan(int start, int? end) => end == null
    ? formatArticleOffset(start)
    : '${formatArticleOffset(start)}–${formatArticleOffset(end)}';

/// The range one row occupies, or just its start when its length is unknown.
String formatArticleRange(TimelineEntry row) {
  final int start = row.articleOffsetMs ?? 0;
  final int? d = row.durationMs;
  return _formatSpan(start, (d == null || d <= 0) ? null : start + d);
}

/// The label over one paragraph, or null when there is nothing honest to
/// print.
///
/// 🔴 THE END IS SHOWN ONLY WHEN EVERY MEMBER ROW KNOWS ITS OWN LENGTH.
/// A row without a duration adds nothing to the article clock
/// (`ArticleClock.claim`), so every offset after it inside the paragraph is
/// short by that row's real length, and `last.offset + last.duration` would
/// print an end earlier than the audio really runs — a number that looks
/// exact and is not. Such a paragraph shows its start alone, the answer
/// [formatArticleRange] already gives a single row of unknown length.
///
/// Unlike [formatArticleRange], a missing start is NOT read as 0
/// ([ArticleParagraph.startMs] is null): several paragraphs all labelled
/// 「00:00」 would be one label claiming several positions (R11), so such a
/// paragraph is drawn with no label at all.
String? formatParagraphRange(ArticleParagraph paragraph) {
  final int? start = paragraph.startMs;
  if (start == null) return null;
  // CR-12 design §4.4: the paragraph still being spoken into has no end yet,
  // so it is labelled with its start alone.
  final bool everyLengthKnown =
      paragraph.closed && _everyLengthKnown(paragraph);
  return _formatSpan(start, everyLengthKnown ? paragraph.endMs : null);
}

bool _everyLengthKnown(ArticleParagraph paragraph) =>
    paragraph.rows.every((TimelineEntry r) => (r.durationMs ?? 0) > 0);

/// NR-97 — how many words the paragraph holds: the SUM of its rows'
/// [entryWordCount], the function the timeline row chip and the stats page
/// total (`asset_inventory.dart`) are built on. Not `textWordCount` over
/// [paragraphText]: that join glues 「abc」+「，def」 into one run, so it would
/// disagree with the rows it is made of.
///
/// Only settled rows are members of a paragraph; the live draft is not a row
/// (design §4.4), so interim text can never reach this number. Null when no
/// member row has words to count.
int? paragraphWordCount(ArticleParagraph paragraph) {
  int? total;
  for (final TimelineEntry r in paragraph.rows) {
    final int? n = entryWordCount(r);
    if (n != null) total = (total ?? 0) + n;
  }
  return total;
}

/// NR-97 — how long the paragraph runs: its start to its last row's
/// `offset + duration` ([ArticleParagraph.endMs]). The open paragraph uses
/// the same arithmetic over the rows settled so far, so it only ever grows.
///
/// Null under the rule [formatParagraphRange] applies to the end: a start
/// that is unknown, or any member row without a length (it did not advance
/// the article clock, so the end would read short). No length is guessed.
int? paragraphDurationMs(ArticleParagraph paragraph) {
  final int? start = paragraph.startMs;
  final int? end = paragraph.endMs;
  if (start == null || end == null || !_everyLengthKnown(paragraph)) {
    return null;
  }
  return end - start;
}

/// The header's 「duration · count」 line, spelled by the timeline row's own
/// [entryMetricsLine]. Null when there is no count to show.
String? _paragraphMetrics(ArticleParagraph paragraph, AppStrings strings) {
  final int? words = paragraphWordCount(paragraph);
  if (words == null) return null;
  return entryMetricsLine(paragraphDurationMs(paragraph), words, strings);
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
    this.focusRowId,
    this.highlight,
  }) : _live = null;

  /// Card CR-12-C — the same page while the recording is still running. Only
  /// [_ArticleLiveHost] builds it; see article_page_live.dart.
  const ArticlePage._live({
    required this.head,
    required this.rows,
    required this.strings,
    required _ArticleLiveFace live,
    this.pendingBackfillMs = 0,
    this.pendingBackfillFromOutage = false,
  }) : _live = live,
       focusRowId = null,
       highlight = null;

  /// Card CR-12-C — open [articleId] while it is being recorded (design §4.2:
  /// one page, two forms). The rows are read from [controller]'s store on
  /// every change, so the page turns into the read-back page in place when
  /// the recording stops.
  ///
  /// [bar] builds the dock's `ContinuousLiveBar` — the SAME builder the
  /// light-record dock uses, so both screens share one stop button and one
  /// `onStop`. It returns null once the recording is over.
  static Widget live({
    Key? key,
    required ChatController controller,
    required String articleId,
    required AppStrings strings,
    required Widget? Function() bar,
  }) => _ArticleLiveHost(
    key: key,
    controller: controller,
    articleId: articleId,
    strings: strings,
    bar: bar,
  );

  /// Null on the read-back form.
  final _ArticleLiveFace? _live;

  /// Card CR-12-G — the member row a search matched. The paragraph holding it
  /// is scrolled to the top after the first frame; which paragraph that is,
  /// this page works out from its own `paragraphsOf(rows)`, so the answer
  /// cannot disagree with what it draws. Null ⇒ the page opens at the top.
  final String? focusRowId;

  /// Card CR-12-G — the search words, washed wherever they occur in a
  /// paragraph. Style only; null ⇒ nothing is marked.
  final String? highlight;

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
  ///
  /// 🔴 Card RC-G — THIS PIECE's debt, never the phone's: every caller reads it
  /// through `BackfillProgress.forArticle` (chat_flow_article.dart,
  /// article_page_live.dart, plus_panel_notes_tab.dart).
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
    final List<ArticleParagraph> paragraphs =
        _live?.paragraphs ?? paragraphsOf(rows);
    final int? focus = _focusIndex(paragraphs);
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      appBar: AppBar(
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      bottomNavigationBar: _live?.bar,
      body: _liveFrame(ListView(
        key: const Key('article.body'),
        controller: _live?.scroll,
        // A lazy list never builds a paragraph below the fold, and an unbuilt
        // paragraph cannot be scrolled to; with a focus every paragraph is
        // built (a recording is a few dozen of them).
        cacheExtent: focus == null ? null : _kFocusCacheExtent,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
        children: <Widget>[
          _header(context),
          if (pendingBackfillMs > 0) _pending(),
          const SizedBox(height: 8),
          for (int k = 0; k < paragraphs.length; k++)
            k == focus
                ? _ScrollIntoViewOnce(child: _paragraph(k, paragraphs[k]))
                : _paragraph(k, paragraphs[k]),
          ?_live?.draft,
          if (rows.isEmpty && _live == null)
            Padding(
              padding: const EdgeInsets.only(top: 24),
              child: Text(
                strings.articleNoTitle,
                key: const Key('article.empty'),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 13),
              ),
            ),
        ],
      )),
    );
  }

  /// The body, with the in-progress form's status banner pinned above the
  /// list (design §4.3: a STATUS banner, so it must not scroll away under a
  /// long transcript). The read-back form returns [list] untouched.
  Widget _liveFrame(Widget list) {
    final Widget? banner = _live?.banner;
    if (banner == null) return list;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[banner, Expanded(child: list)],
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

  Widget _paragraph(int k, ArticleParagraph p) {
    final String? range = formatParagraphRange(p);
    final String? metrics = _paragraphMetrics(p, strings);
    final TextStyle headStyle = TextStyle(
      color: FlowMicColors.t3,
      fontSize: 11,
      fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
    );
    return Container(
      // Keyed by position so a test asserts THIS paragraph's label rather
      // than 「some range is on screen」 — the difference that made the
      // in-article ordering defect visible in the first place. Card CR-12-G's
      // screen test asserts its scroll through these keys
      // (search_article_screen_test.dart).
      key: Key('article.paragraph.$k.box'),
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: FlowMicColors.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (range != null || metrics != null) ...<Widget>[
            // A Wrap, not a Row: on a narrow phone in a long locale the
            // metrics move to a second line instead of being cut (NR-97).
            Wrap(
              key: Key('article.paragraph.$k.head'),
              spacing: 10,
              runSpacing: 2,
              children: <Widget>[
                if (range != null)
                  Text(range, key: Key('article.paragraph.$k'), style: headStyle),
                if (metrics != null)
                  Text(
                    metrics,
                    key: Key('article.paragraph.$k.metrics'),
                    style: headStyle,
                  ),
              ],
            ),
            const SizedBox(height: 3),
          ],
          _body(k, p),
        ],
      ),
    );
  }

  /// The paragraph's words. With no [highlight], or none of it in this
  /// paragraph, the plain `Text` it always was.
  Widget _body(int k, ArticleParagraph p) {
    final String text = paragraphText(p);
    final TextStyle style =
        TextStyle(color: FlowMicColors.t1, fontSize: 14.5, height: 1.5);
    final String? q = highlight;
    if (q == null || matchRanges(text, q).isEmpty) {
      return Text(text, key: Key('article.paragraph.$k.text'), style: style);
    }
    return Text.rich(
      highlightedSpan(text, q, style),
      key: Key('article.paragraph.$k.text'),
    );
  }

  int? _focusIndex(List<ArticleParagraph> paragraphs) {
    final String? id = focusRowId;
    if (id == null) return null;
    for (int k = 0; k < paragraphs.length; k++) {
      if (paragraphs[k].rows.any((TimelineEntry r) => r.id == id)) return k;
    }
    return null;
  }
}

const double _kFocusCacheExtent = 1e6;

/// Card CR-12-G — scrolls its child to the top of the page once, after the
/// first frame (before it, nothing has a size to scroll by).
class _ScrollIntoViewOnce extends StatefulWidget {
  const _ScrollIntoViewOnce({required this.child});

  final Widget child;

  @override
  State<_ScrollIntoViewOnce> createState() => _ScrollIntoViewOnceState();
}

class _ScrollIntoViewOnceState extends State<_ScrollIntoViewOnce> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Scrollable.ensureVisible(context, alignment: 0);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

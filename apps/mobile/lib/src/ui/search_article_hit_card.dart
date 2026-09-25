// Card CR-12-G / demo cell G-1 — one recording in a search result list.
//
// SPEC-REF: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//   §11.4 (reuse the recording card; add the match count and the first matching
//   paragraph's range + snippet), docs/ui-design/2026-09-22-cr12-live-article-view-demo.html G-1.
//
// The card IS `ChatArticleTile` — brand ground, rail, 「长程」 chip — because
// that is already how this app says 「this is a recording」. The two lines under
// it answer the search: how many parts hold the word, and where the first one
// is. Both search screens (full history, the 「+」 panel's light-record tab)
// render this widget, so the result looks the same wherever it is found.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/article_paragraphs.dart' show paragraphText;
import '../timeline/search_hits.dart';
import '../timeline/timeline_entry.dart';
import 'article_page.dart' show formatParagraphRange;
import 'chat_article_tile.dart';
import 'search_highlight.dart';
import 'tokens.dart';

class SearchArticleHitCard extends StatelessWidget {
  const SearchArticleHitCard({
    super.key,
    required this.hit,
    required this.query,
    required this.strings,
    this.onOpen,
    this.onLongPress,
  });

  final ArticleSearchHit hit;

  /// The words the user typed, for the snippet's highlight.
  final String query;
  final AppStrings strings;
  final void Function(ArticleSearchHit hit)? onOpen;
  final void Function(TimelineEntry head)? onLongPress;

  @override
  Widget build(BuildContext context) {
    final TimelineEntry head = hit.head;
    final ArticleHitFocus? focus = hit.focus;
    final String? range =
        focus == null ? null : formatParagraphRange(focus.paragraph);
    final TextStyle snippetStyle =
        TextStyle(color: FlowMicColors.t2, fontSize: 11.5, height: 1.4);
    return ChatArticleTile(
      key: ValueKey<String>('search.article.${head.id}'),
      entry: head,
      strings: strings,
      onOpen: onOpen == null ? null : (_) => onOpen!(hit),
      onLongPress: onLongPress,
      footer: (hit.hitCount == 0 && focus == null)
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (hit.hitCount > 0)
                  Text(
                    strings.historyHitsInRecording(hit.hitCount),
                    key: ValueKey<String>('search.article.hits.${head.id}'),
                    style: TextStyle(
                      color: FlowMicColors.brand,
                      fontSize: 10.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                if (focus != null) ...<Widget>[
                  const SizedBox(height: 4),
                  Text.rich(
                    TextSpan(
                      children: <InlineSpan>[
                        if (range != null)
                          TextSpan(
                            text: '$range  ',
                            style: TextStyle(
                              color: FlowMicColors.t3,
                              fontSize: 10.5,
                              fontFeatures: const <FontFeature>[
                                FontFeature.tabularFigures(),
                              ],
                            ),
                          ),
                        highlightedSpan(
                          searchSnippet(paragraphText(focus.paragraph), query),
                          query,
                          snippetStyle,
                        ),
                      ],
                    ),
                    key: ValueKey<String>('search.article.snippet.${head.id}'),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
    );
  }
}

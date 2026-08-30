// Demo cell E-1 — one continuous recording, as it appears in the timeline it
// was made in, plus the stamp its segments carry WHILE it is being made (C-1).
//
// SPEC-REF: docs/ui-design/2026-08-29-continuous-recording-demo.html E-1 / C-1
//   (the row 「…先按财务那边的月结日来对齐。 02:41 – 03:08」).
//
// ── WHY A SEPARATE TILE, THE SAME ARGUMENT ChatControlTile MAKES ─────────────
// Every cell of a message bubble — the status pill, resend, the failure code,
// 「→ PC → window」 — answers a question about ONE utterance's delivery. A head
// row has no utterance and no delivery: its `status` and `mode` are structural
// fillers named as such where it is built (timeline_store_article_rows.dart).
// Asking `deliveryFaceOf` about it would be asking a function to interpret a
// filler, which is how 0.2.49 F2b happened.
//
// ── 🔴 WHY IT DOES NOT LOOK LIKE A MESSAGE (owner, 2026-08-30) ───────────────
// 「当前的话就是太普通了，不确定是什么东西」. The first version of this card was
// a message bubble with an icon: same surface, same border, same radius, same
// ink. It sat in a list of messages and read as one.
//
// A recording is not a message and the card now says so BEFORE it is read —
// three separate signals, on purpose, because any one of them alone is a
// coincidence in a themed UI:
//   · a BRAND-tinted ground and a solid brand RAIL down its leading edge —
//     nothing else in this list has a rail;
//   · a filled round glyph rather than a bare icon;
//   · a 「长程」 chip next to the title, which is the only one of the three that
//     survives a user who cannot distinguish the colours. That is why it is
//     there and why it is not decoration.
//
// ⚠️ Colours are taken from `tokens.dart` (`brand` / `brandSoft`) — no new
// visual language, and they carry the theme swap with everything else.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/entry_metrics.dart';
import '../timeline/timeline_entry.dart';
import 'time_label.dart';
import 'tokens.dart';

/// One finished continuous recording, as a card that opens.
class ChatArticleTile extends StatelessWidget {
  const ChatArticleTile({
    super.key,
    required this.entry,
    required this.strings,
    this.onOpen,
    this.onLongPress,
  });

  final TimelineEntry entry;
  final AppStrings strings;

  /// Opens the piece. Null in surfaces that cannot navigate (the full-history
  /// page renders the same tile), and then the card is still a card — it just
  /// does not pretend to be a button.
  ///
  /// 🔴 The tap target is the whole card and it is the ONLY gesture that does
  /// anything, because the card's members are not in this list: without it the
  /// words would be unreachable. That is the opposite of the 「a control that
  /// changes nothing」 rule — here the control is the only way through.
  final void Function(TimelineEntry head)? onOpen;

  /// Long-press keeps the ordinary menu (delete / multi-select), same reason
  /// `ChatControlTile` keeps it: without it a recording could only be removed
  /// by clearing the whole history.
  final void Function(TimelineEntry entry)? onLongPress;

  @override
  Widget build(BuildContext context) {
    final String title = entry.outputText.isEmpty
        ? strings.articleNoTitle
        : entry.outputText;
    final Widget card = Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: FlowMicColors.brandSoft,
        border: Border.all(color: FlowMicColors.brand.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(14),
      ),
      clipBehavior: Clip.antiAlias,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // The rail. Nothing else in the timeline has one, which is the
            // whole point — it is recognisable at a glance and at any size.
            Container(width: 3, color: FlowMicColors.brand),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(11, 11, 12, 11),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(
                        color: FlowMicColors.brand.withValues(alpha: 0.22),
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: Icon(Icons.graphic_eq,
                          size: 15, color: FlowMicColors.brand),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              // 🔴 The chip FIRST and outside the ellipsis, so a
                              // long title can never push 「what kind of thing
                              // is this」 off the row. 0.2.51 is the precedent:
                              // a name and a badge in one Flexible row means
                              // the badge is the half that disappears.
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 1),
                                decoration: BoxDecoration(
                                  color: FlowMicColors.brand
                                      .withValues(alpha: 0.20),
                                  borderRadius: BorderRadius.circular(99),
                                ),
                                child: Text(
                                  strings.articleBadge,
                                  key: ValueKey<String>(
                                      'entry.article.badge.${entry.id}'),
                                  style: TextStyle(
                                    color: FlowMicColors.brand,
                                    fontSize: 9.5,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 7),
                              Expanded(
                                child: Text(
                                  title,
                                  key: ValueKey<String>(
                                      'entry.article.title.${entry.id}'),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: FlowMicColors.t1,
                                    fontSize: 13.5,
                                    fontWeight: FontWeight.w600,
                                    height: 1.25,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 5),
                          // 🔴 Time FIRST, then the two derived numbers, because
                          // the numbers come from the head and the head is
                          // recomputed from its members (`refreshArticleHeadOf`).
                          // A card showing a stale count would be the one place
                          // a user could catch the model disagreeing with
                          // itself, with nothing on the card to check against.
                          Text(
                            '${timelineTimeLabel(entry.createdAt)} · '
                            '${strings.articleCardMeta(
                              formatEntryDuration(entry.durationMs ?? 0),
                              entry.segmentsCount,
                            )}',
                            key: ValueKey<String>(
                                'entry.article.meta.${entry.id}'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                color: FlowMicColors.t2, fontSize: 10.5),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 6),
                    Icon(Icons.chevron_right,
                        size: 17, color: FlowMicColors.brand),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
    if (onOpen == null && onLongPress == null) return card;
    return InkWell(
      key: ValueKey<String>('entry.article.open.${entry.id}'),
      borderRadius: BorderRadius.circular(14),
      onTap: onOpen == null ? null : () => onOpen!(entry),
      onLongPress: onLongPress == null ? null : () => onLongPress!(entry),
      child: card,
    );
  }
}

/// 🔴 Cell C-1 — WHERE THIS ROW SITS INSIDE THE RECORDING, shown WHILE the
/// recording is still running.
///
/// Owner, 2026-08-30: 「在长程转录的过程中已经上屏的，也需要能够很明显地看到它已经
/// 在哪个位置…而不是现在这样等完成了之后才能去浏览」.
///
/// Before this, the in-article timeline existed only inside `ArticlePage`,
/// which cannot be opened until the recording ends (the card it is reached
/// from is not drawn until then). So the piece was being built in front of the
/// user with no way to see it being built.
///
/// ⚠️ A WRAPPER, NOT A FIELD ON THE BUBBLE. `chat_message_tile.dart` carries a
/// pinned bloat baseline, and more importantly the stamp is not a property of
/// the utterance — it is a property of 「this row, inside that recording」. A
/// row that leaves its article (none do today) would stop having one without
/// the bubble changing at all.
class ArticleRowStamp extends StatelessWidget {
  const ArticleRowStamp({
    super.key,
    required this.entry,
    required this.label,
    required this.child,
  });

  final TimelineEntry entry;

  /// The range, already formatted — `formatArticleRange` lives with the page
  /// that also renders it, so both faces of the same number have ONE author.
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          child,
          Padding(
            padding: const EdgeInsets.only(top: 3, left: 2),
            child: Row(
              children: <Widget>[
                Container(width: 3, height: 3,
                    decoration: BoxDecoration(
                        color: FlowMicColors.brand, shape: BoxShape.circle)),
                const SizedBox(width: 5),
                Text(
                  label,
                  key: ValueKey<String>('entry.articleStamp.${entry.id}'),
                  style: TextStyle(
                    color: FlowMicColors.brand,
                    fontSize: 10,
                    fontFeatures: const <FontFeature>[
                      FontFeature.tabularFigures(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      );
}

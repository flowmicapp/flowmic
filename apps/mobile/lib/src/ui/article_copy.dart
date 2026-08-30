// owner 2026-08-30: 「轻记录的转录历史中复制」/「手机端的全部历史记录中复制」 —
// copying a continuous-recording card copied only what the collapsed card
// SHOWS (its title), not the recording. Expected: the whole recording, with
// each segment's position on the recording's own timeline.
//
// ── 🔴 ROOT CAUSE: THE COPY PATHS READ `displayText`, AND A HEAD'S IS A TITLE ─
//
// Every copy site in the app folded a row down to `TimelineEntry.displayText`
// (`copyEntryToClipboard` for one row, `selectedRecords` for a batch). That is
// right for an utterance — the words on screen ARE the record — and wrong for
// an article head, whose `outputText` is a TITLE derived from the first thing
// said (`ArticleSummary.titleFrom`, `refreshArticleHeadOf`). The head carries
// no words of its own; its words are its members, and none of the copy paths
// ever went and got them. `article_send_to_pc_test` pinned exactly this trap
// for the SEND path one round earlier (「the pick carries the WORDS, not the
// cover」) and the copy paths were not looked at.
//
// ── THE ONE RENDERER ────────────────────────────────────────────────────────
//
// [articleCopyText] is the single place a recording becomes clipboard text:
// every segment in timeline order, each line prefixed with the SAME range label
// `ArticlePage` draws above it ([formatArticleRange] — 「00:30–01:00」, or a
// bare start when the length is unknown). Not a second time format: the label
// the user reads on the page and the label they paste must be one author, or
// the two faces of one number drift apart with nothing on any screen to say
// which one is right.
//
// Ordinary rows keep their existing copy text. The recording is the only kind
// of row whose visible text is not its content.
//
// ⚠️ DELIBERATELY NOT `joinSelectedTexts`. That rule is 「a single newline, no
// decoration」 for text SENT to a PC (owner 2026-08-12 ruling 3), and
// `LightRecordQuery.transcriptOf` still composes the send-to-PC piece through
// it, without timestamps. Copy is a different action with a different owner
// ruling (the times are asked for by name), so it gets its own renderer rather
// than a flag on that one — a flag would make one function answer two rulings.

import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../session/image_clipboard.dart'
    show ImageClipboardPort, ImageCopyOutcome, TextCopy, copyEntryToClipboard;
import '../timeline/timeline_entry.dart';
import 'article_page.dart' show formatArticleRange;

/// The same one line `image_clipboard.dart` keeps private, rewritten here for
/// the reason `batch_actions.dart` gives for doing the same: duplicating one
/// line of `Clipboard.setData` is cheaper than widening a seam someone else
/// owns. The type [TextCopy] is still theirs, so test doubles are one kind.
Future<void> _systemTextCopy(String text) =>
    Clipboard.setData(ClipboardData(text: text));

/// The members of one recording, OLDEST FIRST, by article id — synchronous
/// because the batch surface composes synchronously (`_onBatchOrganizeRouted`
/// may not `await` between its check and its start; see its doc).
typedef ArticleMembers = List<TimelineEntry> Function(String articleId);

/// The same lookup for a surface that has to go to storage for the members
/// (the full-history page: a search hit's members need never have been paged
/// into the store).
typedef ArticleMembersAsync =
    Future<List<TimelineEntry>> Function(String articleId);

/// One recording as clipboard text.
///
/// [membersOldestFirst] is the piece in timeline order — the caller reads it
/// through `articleMembersOf` / `articleMembersOnDisk` / `LightRecordQuery
/// .membersOf`, all of which sort through `articleMembersIn`, so the order
/// here is the order `ArticlePage` shows.
///
/// One line per segment: `<range> <words>`. A segment with no words prints no
/// line (there is nothing to prefix). An empty piece is the empty string, which
/// callers must treat as 「nothing to copy」 rather than write to the clipboard.
String articleCopyText(Iterable<TimelineEntry> membersOldestFirst) {
  final List<String> lines = <String>[];
  for (final TimelineEntry m in membersOldestFirst) {
    final String words = m.displayText.trim();
    if (words.isEmpty) continue;
    lines.add('${formatArticleRange(m)} $words');
  }
  return lines.join('\n');
}

/// Copy ONE row the way its kind deserves — the single-row copy seam every
/// long-press menu goes through.
///
/// A recording head copies its whole piece through [articleCopyText]; every
/// other row is `copyEntryToClipboard`, unchanged. [membersOf] is required
/// rather than defaulted: a default that returned no members would make a
/// recording copy an empty string, and a copy that "succeeds" by wiping the
/// clipboard is the overclaiming half of the fail-loud red line.
///
/// An EMPTY piece leaves the clipboard untouched (same posture as
/// `copyEntrySourceText`), and reports [ImageCopyOutcome.copiedText] because
/// that outcome is the silent one — there is no new sentence to say, and a
/// finished recording with no members cannot exist (`timeline_store_batch
/// _delete` takes the cover with the last member).
Future<ImageCopyOutcome> copyRowToClipboard(
  TimelineEntry entry, {
  required ArticleMembersAsync membersOf,
  ImageClipboardPort? image,
  TextCopy? text,
}) async {
  final String? articleId = entry.isArticle ? entry.articleId : null;
  if (articleId == null) {
    return copyEntryToClipboard(entry, image: image, text: text);
  }
  final String body = articleCopyText(await membersOf(articleId));
  if (body.isNotEmpty) await (text ?? _systemTextCopy)(body);
  return ImageCopyOutcome.copiedText;
}

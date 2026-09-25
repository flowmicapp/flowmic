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
// every paragraph in timeline order, each line prefixed with the SAME range
// label `ArticlePage` draws above it ([formatParagraphRange] — 「00:30–01:00」,
// or a bare start when a length is unknown). Not a second time format: the label
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
//
// ── CR-12-F: ONE PARAGRAPH PER LINE, AND SEND-WITH-TIMES READS THIS TOO ─────
//
// Since CR-12-B the page draws paragraphs (`paragraphsOf`), not rows, so the
// label a user reads is a paragraph's, and copy follows the page (CR-12 design
// §10.6): each line is [formatParagraphRange] + [paragraphText], the two
// functions `ArticlePage._paragraph` draws with. A paragraph whose start is
// unknown has no label on the page and gets none here — its words alone, never
// an invented 「00:00」.
//
// Owner 2026-09-22 then let the user opt into times when FORWARDING too
// (ruling 3's in-place addendum). The 「+」 panel's 「with times」 chip sends
// exactly this function's output, so a pasted recording and a forwarded one
// carry the same labels. Ruling 3 is still the default for sending: with the
// chip off the panel sends `transcriptOf`, byte for byte as before.

import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../session/image_clipboard.dart'
    show ImageClipboardPort, ImageCopyOutcome, TextCopy, copyEntryToClipboard;
import '../timeline/timeline_entry.dart';
import '../timeline/article_paragraphs.dart'
    show ArticleParagraph, paragraphText, paragraphsOf;
import 'article_page.dart' show formatParagraphRange;

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
/// One line per paragraph: `<range> <words>`, or just `<words>` when the
/// paragraph's start is unknown ([formatParagraphRange] answers null). A
/// paragraph with no words prints no line. No title, no header, no blank line.
/// An empty piece is the empty string, which callers must treat as 「nothing to
/// copy」 rather than write to the clipboard.
String articleCopyText(Iterable<TimelineEntry> membersOldestFirst) {
  final List<String> lines = <String>[];
  for (final ArticleParagraph p in paragraphsOf(membersOldestFirst)) {
    final String words = paragraphText(p);
    if (words.isEmpty) continue;
    final String? range = formatParagraphRange(p);
    lines.add(range == null ? words : '$range $words');
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

// SPEC-REF:
//   docs/ui-design/demo/mobile.html (frame 11 .ctxmenu: inject-to-PC / deferred
//     re-delivery [hot] / edit / copy / add to favorites / delete [danger])
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 C (the phone-side
//     deferred re-delivery is always available)
//   docs/ui-design/REDESIGN-PLAN.md §2 F-5 (turning a history row into a
//     favorite), §3 P-1 (favorites' main entry point is the 「+」 panel; the ⭐
//     here just points at the same data source's favorite action, it is not a
//     second home)
//
// Long-press context menu. A styled bottom sheet stands in for the demo's
// centred lifted-card overlay (idiomatic Flutter equivalent); the action set is
// faithful. Returns the chosen action so the page dispatches to ChatController.

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import 'tokens.dart';

/// 🔴 Card FB-7 added [select] (enter multi-select mode). This enum is
/// **closed**, and the page does an exhaustive switch on it ⇒ adding a member
/// without handling it is a **compile error**, not a silently-dead menu item.
/// The full argument for choosing it as the entry point (long-press is already
/// taken by this menu / a single tap is deliberately left unused / two
/// rejected candidates) is in the file header of
/// `ui/selection/entry_selection.dart`.
enum EntryAction { reInject, reprocess, edit, copy, favorite, select, delete }

/// [strings] is required, deliberately — the menu's copy is user-visible, and
/// a zh default would render Chinese to an English user while looking fine
/// (façade rule ②). Never the OS locale.
Future<EntryAction?> showEntryContextMenu(
  BuildContext context,
  TimelineEntry entry, {
  required AppStrings strings,
}) {
  return showModalBottomSheet<EntryAction>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (BuildContext ctx) => _ContextSheet(entry: entry, strings: strings),
  );
}

class _ContextSheet extends StatelessWidget {
  const _ContextSheet({required this.entry, required this.strings});
  final TimelineEntry entry;
  final AppStrings strings;

  /// Deferred re-delivery (补投) is offered only for PC-bound entries. A
  /// cloud-instance record (`origin == 'cloud'`, the R4-2 solo record-only
  /// face) has no PC focus target — the same judgement ChatController.reInject
  /// uses to bail out.
  ///
  /// R6 T-4: an IMAGE row is likewise withheld, and for a sharper reason.
  /// Deferred re-delivery re-sends the STORED ROW'S TEXT as
  /// `inject:request{source:'history'}`. For a picture that text is the
  /// descriptor (`🖼 PNG · 214 KB`) — so a deferred re-delivery would type
  /// those characters into the user's document and report `injected`, i.e.
  /// claim a delivery of something that was never delivered.
  ///
  /// ⚠️ Correction (window-B3-2b): this doc used to end "The bytes are
  /// deliberately not retained anywhere (see ImageSendController), so there is
  /// nothing to re-send." That half is now FALSE — the queue parks the
  /// compressed copy until the delivery succeeds — and it is kept as a
  /// correction rather than deleted, because it is the sentence that would
  /// stop the next reader from checking. The row's INLINE resend (重发) does
  /// offer a picture resend when the bytes survive
  /// (`ChatMessageTile.canResendImage` → `resendImage`).
  ///
  /// 📌 THIS MENU HAS NOT FULLY CAUGHT UP, and the remaining part is a known
  /// gap rather than a judgement: deferred re-delivery here means 「新的一次
  /// 投递」("a new delivery"), which is the wrong action for a queued picture
  /// (still no menu action for a picture at all, landed or not).
  ///
  /// ⚠️ Correction (window-B3-9 / 15册 G-11): the sentence used to end here
  /// saying the two-stage model's second half — telling the user
  /// 「原件已清理，无法重发」("the original has been cleaned up, cannot be
  /// resent") on a picture that DID land — "has no home yet." It now does,
  /// and deliberately NOT in this menu: it lives on the ROW itself
  /// (`ChatMessageTile.explainNoImageResend`), in the exact slot the inline
  /// resend (重发) button would occupy, because that is where a user who
  /// watched the button disappear after delivery is actually looking — a menu
  /// item nobody opens looking for an explanation is 「藏在一个要主动找的地方」
  /// ("hidden somewhere you'd have to go looking for"). G-11 is closed.
  ///
  /// 🔴 REQ-12-13 — POSITIVE ON `kTranscript` NOW, and this is the one that
  /// would have done damage: deferred re-delivery re-delivers a row's text,
  /// and a remote-key row has none (its face is composed at render time).
  /// Under the old open test `!isImage`, the menu offered deferred
  /// re-delivery on a keypress row the day the third kind existed.
  bool get _canReInject =>
      entry.origin != 'cloud' && entry.entryType == TimelineEntry.kTranscript;

  /// Editing an image row would rewrite that same descriptor into arbitrary
  /// text — a row claiming to be a picture while saying something else. The
  /// row's face IS its content here, so it is not editable.
  /// REQ-12-13: a keypress row has nothing to edit — see [_canReInject].
  bool get _canEdit => entry.entryType == TimelineEntry.kTranscript;

  /// GA-13 re-translate/re-organize. Offered only when there is something to re-run: the
  /// ORIGINAL words (source_text is immutable, so a reprocess is never a
  /// translation of a translation) and a row that is not a picture. Whether the
  /// CURRENT mode has an LLM stage is the caller's guard — the mode lives on the
  /// controller, not on the row — and realtime simply produces no action there.
  /// REQ-12-13: the `sourceText` clause already excludes a keypress row (it has
  /// none), but the KIND test is written positively anyway — 「碰巧没内容」("it
  /// just happens to have no content") and 「结构上不是一段话」("structurally
  /// it isn't a piece of speech") are two different reasons, and only the
  /// second one is guaranteed to keep holding.
  bool get _canReprocess =>
      entry.entryType == TimelineEntry.kTranscript &&
      (entry.sourceText ?? '').trim().isNotEmpty;

  /// REQ-12-13 — copy (复制) / favorite (收藏) both act on the row's TEXT. A picture row has a
  /// descriptor (and its own preview-copy wording); a remote-key row has nothing at
  /// all, so both are withheld rather than handed an empty string.
  bool get _canCopy => !entry.isControl;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Container(
        margin: const EdgeInsets.fromLTRB(14, 0, 14, 14),
        decoration: BoxDecoration(
          color: FlowMicColors.surface2,
          border: Border.all(color: FlowMicColors.line),
          borderRadius: BorderRadius.circular(16),
        ),
        // 🔴 Card FB-7 — scrollable, and this is a REAL defect the new
        // multi-select (多选) row exposed rather than a precaution.
        // `showModalBottomSheet` caps a sheet at half the screen; with six rows
        // this Column already sat at ~93 % of that cap on a 600×800 test
        // viewport, so the seventh overflowed by 28 px — measured,
        // `chat_ui_widget_test.dart` went red the moment the row landed.
        // Overflow in a MENU is not cosmetic: the clipped item is the last
        // one, Delete (删除), i.e. an action silently becomes unreachable.
        // The same arithmetic already applied before this card to any phone
        // whose text scale pushed the rows taller; nobody had hit it yet.
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // §6.2-6 / R6 P0-R4: a cloud-instance record (origin:'cloud') has NO
              // PC focus target — deferred re-delivery (补投) is structurally
              // inert there (ChatController.reInject returns early), so we do
              // not offer a dead affordance. The reInject row is shown ONLY
              // for PC-bound (paired) entries.
              if (_canReInject) ...<Widget>[
                _row(
                  context,
                  icon: Icons.bolt,
                  label: strings.entryReInject,
                  sub: strings.entryReInjectSub,
                  color: FlowMicColors.brand,
                  action: EntryAction.reInject,
                ),
                _divider(),
              ],
              if (_canReprocess) ...<Widget>[
                _row(
                  context,
                  icon: Icons.refresh,
                  label: strings.entryReprocess,
                  sub: strings.entryReprocessSub,
                  action: EntryAction.reprocess,
                ),
                _divider(),
              ],
              if (_canEdit) ...<Widget>[
                _row(
                  context,
                  icon: Icons.edit_outlined,
                  label: strings.entryEdit,
                  action: EntryAction.edit,
                ),
                _divider(),
              ],
              // owner 2026-07-27: on a picture row this copies the PICTURE, and
              // the label says which picture. ⚠️ Correction (RV-93): "the phone
              // never kept the original" is no longer the reason — the
              // delivered bytes ARE kept now — but this path still copies the
              // bounded 256 px preview (image_clipboard.dart states why, and
              // what must change if that is ever revisited), so the label is
              // still exact — offering 「复制图片」("copy image") and handing
              // over a thumbnail would be the overclaiming half of "no silent
              // failure" (没有静默失败). The sub-line is
              // [AppStrings.imagePreviewNote], the SAME statement the
              // copy-result toast wraps (one fact, one string).
              // 🔴 REQ-12-13 — copy (复制) and favorite (收藏) are withheld on a
              // remote-key row, and this is R8 rather than tidiness: both act
              // on the row's TEXT, and a keypress row has none (`outputText`
              // is `''`; the face is composed at render time from
              // `controlKind`). Offering them would put two controls on the
              // sheet that copy an empty string and favourite an empty phrase
              // — 「一个改变不了任何东西的控件比没有控件更坏」("a control that
              // changes nothing is worse than no control"), three times paid
              // for.
              // ⚠️ Delete (删除) and multi-select (多选) stay, deliberately:
              // they are the two that still MEAN something on this row, and
              // withholding Delete would make a keypress row impossible to
              // remove one at a time.
              if (_canCopy) ...<Widget>[
                _row(
                  context,
                  icon: entry.isImage ? Icons.image_outlined : Icons.copy_outlined,
                  label: entry.isImage ? strings.entryCopyPreview : strings.entryCopy,
                  sub: entry.isImage ? strings.imagePreviewNote : null,
                  action: EntryAction.copy,
                ),
                _divider(),
              // F-5 turning a history row into a favorite. Local-only (no wire, no timeline mutation), so it
              // is offered for cloud records too — unlike deferred re-delivery
              // (补投) there is no PC dependency to lie about.
                _row(
                  context,
                  icon: Icons.star_outline_rounded,
                  label: strings.favoriteAdd,
                  color: FlowMicColors.amber,
                  action: EntryAction.favorite,
                ),
                _divider(),
              ],
              // 🔴 Card FB-7 multi-select (多选). Offered on EVERY row without
              // exception — unlike deferred-re-delivery/edit/reprocess above,
              // which each withhold themselves for a reason about THIS row.
              // 「进入多选态」("enter multi-select mode") is not an operation
              // on this row at all; it is a mode. A picture row is selectable
              // too: it counts toward the selection and is then explicitly
              // excluded (and COUNTED) by the batch actions, which is a truer
              // answer than making it unselectable and leaving the user to
              // guess why.
              //
              // Sits directly above Delete rather than at the top because the
              // top of this sheet is the 「do something to this one row」
              // cluster; this is the 「now do something to several」 hand-off,
              // and Delete stays last (owner 2026-07-27: the destructive item
              // must not be where a long-press lands).
              _row(
                context,
                icon: Icons.checklist_rounded,
                label: strings.selectionEnter,
                sub: strings.selectionEnterSub,
                action: EntryAction.select,
              ),
              _divider(),
              // Delete (删除) = the destructive timeline-entry delete, i.e. the SAME action
              // the confirm dialog's confirm button commits — so both use
              // [AppStrings.confirmDelete] (Delete), not favoritesRemove (Remove),
              // which is the milder 「从常用清单移除一条短语」("remove a phrase
              // from the favorites list").
              _row(
                context,
                icon: Icons.delete_outline,
                label: strings.confirmDelete,
                color: FlowMicColors.red,
                action: EntryAction.delete,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _divider() =>
      Divider(height: 1, thickness: 1, color: FlowMicColors.line);

  Widget _row(
    BuildContext context, {
    required IconData icon,
    required String label,
    String? sub,
    Color? color,
    required EntryAction action,
  }) {
    final Color fg = color ?? FlowMicColors.t1;
    return InkWell(
      onTap: () => Navigator.of(context).pop(action),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 12),
        child: Row(
          children: <Widget>[
            Icon(icon, size: 16, color: color ?? FlowMicColors.t2),
            const SizedBox(width: 11),
            // Flexible, not a bare Column. The Chinese labels are short enough
            // to fit unaided, so this Row was unconstrained for a year and
            // nobody noticed; the English ones ("Re-run the current mode on the
            // original words (source unchanged)") overflow by ~103 px on a
            // 580 px sheet. Surfacing exactly this is what a second language is
            // FOR — a layout that fits one language is not a layout, and the
            // overflow stripes would have been the user's first sign.
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    label,
                    // The action's own name never truncates — it is what the
                    // user is choosing. Two lines is the right answer here.
                    style: TextStyle(
                      color: fg,
                      fontSize: 13.5,
                      fontWeight: color == FlowMicColors.brand
                          ? FontWeight.w600
                          : FontWeight.w400,
                    ),
                  ),
                  if (sub != null)
                    Text(
                      sub,
                      style: TextStyle(
                        color: FlowMicColors.t3,
                        fontSize: 10,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

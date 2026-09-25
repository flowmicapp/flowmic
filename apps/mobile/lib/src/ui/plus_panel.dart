// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §6.1 (「+」 panel), §6.2 ⑤ (input row [+]),
//     §6.2-6 (cloud-instance home-page difference: no PC focus window ⇒ no
//     injection-type actions),
//     §2 F-5 (favorites (常用) ≤50 "oldest trimmed" / save current buffer
//     (存入当前缓冲) / tap-to-send (点选即发))
//   docs/ui-design/demo/mobile.html frame 5 (.sheet/.grab/.favrow — the frozen
//     bottom-sheet shape mirrored below)
//   docs/archive/strategy/R6-BACKLOG-AND-PLAN.md wave 2 (波2) T-3 ②③, wave 2 T-4 ①
//     (album picture / 相册图片)
//
// The 「+」 panel. It holds EXACTLY what the app actually implements: favorites
// (常用) (Favorites, T-3b) and the album picture (相册图片) (the image chain,
// T-4). The demo also draws a
// screenshot-attachment (截图附件) tile — that one has no implementation and is
// therefore still ABSENT
// rather than present-and-dead. anti-façade: a tile that does nothing when tapped
// is the single worst affordance this project keeps re-learning, so the panel
// grows an entry only when the entry works.
//
// Cloud instance (§6.2-6 + owner 2026-07-31): tap-to-send (点选即发) stays inert
// (no PC to
// inject into). The album picture (相册图片) is LIVE — it saves a local noted
// row on the phone
// (ImageSendController._saveLocal); e2e:v1: cloud blob upload is a different
// engineering and is NOT wired here. Saving/removing a phrase stays available.

import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../favorites/favorites_store.dart';
import '../session/image_send_controller.dart' show ImageOriginalBlock;
import '../settings/app_strings.dart';
import '../settings/local_prefs.dart';
import '../session/backfill_runner.dart';
import '../timeline/cloud/light_record_query.dart';
import '../timeline/timeline_entry.dart';
import 'confirm_dialog.dart';
import 'plus_panel_notes_tab.dart';
import 'plus_panel_selection.dart';
import 'plus_panel_with_times_chip.dart';
import 'tokens.dart';

// 800-line cap: the album-picture (相册图片) tile moved VERBATIM to its own `part` file when
// REQ-12-09 09-D added the tick boxes and the send bar. See its header for why
// it is a `part` (the class is private) and for the 「nothing changed」 claim.
part 'plus_panel_image_tile.dart';
part 'plus_panel_favorites_list.dart';

/// REQ-12-09 09-B — the panel's two halves.
///
/// 🔴 TWO TABS, TWO STORES, NO MERGE. The ruling document (裁定书) forbids
/// folding light-record (轻记录) into the
/// favourites store, and design §4 gives the mechanism: the two differ on
/// identity (a favourite IS its string; a note is a row id), storage, cap,
/// lifetime, whether they touch the wire, and whether they can be a picture.
/// Any two of those six would be enough.
enum PlusPanelTab { favorites, notes }

/// Open the panel. Returns when the sheet closes; every action reports its
/// result through [onFeedback] so nothing the user taps is silent.
Future<void> showPlusPanel(
  BuildContext context, {
  required FavoritesStore favorites,
  required AppStrings strings,

  /// The compose buffer at open time — what 「存入当前缓冲」("save into the
  /// current buffer") saves.
  required String buffer,

  /// True when there is no PC focus window to send to (cloud instance).
  required bool noPcTarget,

  /// Tap-to-send (点选即发). Runs the SAME delivery path as ➤ (ChatController.sendFavorite).
  required void Function(String text) onSend,
  required void Function(String message) onFeedback,

  /// R6 T-4 album picture (相册图片). Runs ChatController.sendImage → the picker → the SAME
  /// delivery machinery as ➤, with an image payload. Absent ⇒ the tile is not
  /// drawn at all (the panel never renders an action it was given no way to
  /// perform).
  ///
  /// The bool is original-image (原图) (owner 2026-08-01). It is decided HERE, before the picker
  /// opens, and travels with the one tap that starts the send.
  Future<void> Function(bool original)? onPickImage,

  /// True while an image send is already in flight — the tile goes inert and
  /// says so, rather than letting a second tap race the first.
  bool imageSending = false,

  /// owner 2026-08-01: null ⇒ original-image (原图) is on offer (LAN); non-null ⇒ it is not, and
  /// the reason stands where the tick box would have been.
  ImageOriginalBlock? originalBlock,

  /// W2.5-E: true while an AI compose run is streaming into [buffer]. Pass
  /// `ChatController.isAiComposing` — the SAME getter `canSend` reads
  /// (chat_controller.dart:343), not a second copy of the same fact.
  bool aiComposing = false,

  /// REQ-12-09 09-A/09-B — the light-record (轻记录) read. **Absent ⇒ no tab bar at all** and
  /// the panel is exactly what it was before this card. Same rule as
  /// [onPickImage] above: the panel never draws a surface it was given no way
  /// to fill.
  LightRecordQuery? lightRecords,

  String? liveArticleId, // Card P2-9 — see [PlusPanel.liveArticleId]'s doc.
  /// CR-8 / ruling ⑮ — how much offline audio is still becoming words. Null ⇒
  /// no recovery channel is wired, and the article page says nothing about it.
  ValueListenable<BackfillProgress>? backfill,

  /// Asked, not snapshotted — see [PlusPanelNotesTab.isSignedIn].
  bool Function()? isSignedIn,

  /// Opens the sign-in sheet from the light-record (轻记录) tab's state A.
  Future<void> Function()? onSignIn,

  /// REQ-12-09 09-F/09-J — deliver what is ticked. **Absent ⇒ no tick boxes at
  /// all**, same rule as [onPickImage] and [lightRecords] above.
  PlusSelectionSender? onSendSelection,

  /// REQ-12-09 09-G — 「这一行的原图字节还在吗」("are this row's original-image
  /// bytes still there"), asked per picture row.
  /// Required whenever [onSendSelection] is given; see [PlusPanel]'s assert.
  Future<bool> Function(TimelineEntry entry)? imageSendable,

  /// CR-12-F — where the send bar's 「with times」 chip remembers its last
  /// state. Required whenever [onSendSelection] is given; see [PlusPanel]'s
  /// assert.
  LocalPrefs? prefs,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (BuildContext ctx) => PlusPanel(
      favorites: favorites,
      strings: strings,
      buffer: buffer,
      noPcTarget: noPcTarget,
      onSend: onSend,
      onFeedback: onFeedback,
      onPickImage: onPickImage,
      imageSending: imageSending,
      originalBlock: originalBlock,
      aiComposing: aiComposing,
      lightRecords: lightRecords,
      liveArticleId: liveArticleId,
      backfill: backfill,
      isSignedIn: isSignedIn,
      onSignIn: onSignIn,
      onSendSelection: onSendSelection,
      imageSendable: imageSendable,
      prefs: prefs,
    ),
  );
}

class PlusPanel extends StatefulWidget {
  const PlusPanel({
    super.key,
    required this.favorites,
    required this.strings,
    required this.buffer,
    required this.noPcTarget,
    required this.onSend,
    required this.onFeedback,
    this.onPickImage,
    this.imageSending = false,
    this.originalBlock,
    this.aiComposing = false,
    this.lightRecords,
    this.liveArticleId,
    this.backfill,
    this.isSignedIn,
    this.onSignIn,
    this.onSendSelection,
    this.imageSendable,
    this.prefs,
  }) : assert(
         lightRecords == null || isSignedIn != null,
         'A light-record (轻记录) tab without a signed-in source would have to '
         'GUESS, and the '
         'cheap guess (false) shows a signed-in user the 「你已退出登录」'
         '("you have been signed out") notice — '
         'a wiring mistake dressed as a product statement. Fail here instead.',
       ),
       assert(
         onSendSelection == null || imageSendable != null,
         'REQ-12-09 09-G: multi-select without a byte probe would have to GUESS '
         'whether a picture row can be sent. Guessing YES offers a tick that can '
         'only fail; guessing NO hides a capability that works. Both are a '
         'wiring mistake dressed as a product statement. Fail here instead.',
       ),
       assert(
         onSendSelection == null || prefs != null,
         'CR-12-F: a 「with times」 chip with nowhere to remember its state '
         'would forget the user\'s choice on every opening while looking like '
         'it kept it. Fail here instead.',
       );

  final FavoritesStore favorites;
  final AppStrings strings;
  final String buffer;
  final bool noPcTarget;
  final void Function(String text) onSend;
  final void Function(String message) onFeedback;
  final Future<void> Function(bool original)? onPickImage;
  final bool imageSending;
  final ImageOriginalBlock? originalBlock;

  /// W2.5-E: true while an AI compose run is streaming into [buffer]. Gates
  /// save-current-buffer (存入当前缓冲) only — see [_saveButton] for why the
  /// send half is untouched.
  final bool aiComposing;

  /// REQ-12-09 09-A. Null ⇒ no light-record (轻记录) tab (see [showPlusPanel]).
  final LightRecordQuery? lightRecords;

  final String? liveArticleId; // Card P2-9 — see LightRecordQuery.all's doc.

  /// CR-8 / ruling ⑮ — how much offline audio is still becoming words, for the
  /// article page the notes tab opens. Null ⇒ no recovery channel is wired.
  final ValueListenable<BackfillProgress>? backfill;
  final bool Function()? isSignedIn;
  final Future<void> Function()? onSignIn;

  /// REQ-12-09 09-F/09-J. Null ⇒ no tick boxes anywhere in the panel.
  final PlusSelectionSender? onSendSelection;

  /// REQ-12-09 09-G. Non-null whenever [onSendSelection] is (see the assert).
  final Future<bool> Function(TimelineEntry entry)? imageSendable;

  /// CR-12-F. Non-null whenever [onSendSelection] is (see the assert).
  final LocalPrefs? prefs;

  @override
  State<PlusPanel> createState() => _PlusPanelState();
}

/// 🔴 REQ-12-09 09-B — WHY THERE IS STATE HERE NOW, AND WHAT IT DID **NOT**
/// CHANGE ABOUT THE SNAPSHOTS.
///
/// This panel was a `StatelessWidget` that `showPlusPanel` built exactly once,
/// rebuilding only on the `favorites` listenable. Tabs need a selected tab, so
/// `State` arrives. Design §2 says not to inherit the old snapshot assumption
/// silently, so here is the re-answer, measured against what actually changed:
///
///   · `buffer` / `noPcTarget` / `imageSending` / `originalBlock` /
///     `aiComposing` are still **exactly as stale as before**. `State` gives
///     this widget a way to rebuild ITSELF (`setState`); it gives it no new way
///     to be rebuilt with new PARAMETERS — `showModalBottomSheet`'s builder
///     still runs once, so `didUpdateWidget` never fires. Nothing about their
///     staleness got better or worse.
///   · That is still adequate for each of them, for the reason [_saveButton]
///     already spells out: none can change while the sheet is open except
///     `aiComposing`'s end edge, whose cost is one refused save and one reopen.
///     Nothing this card adds can change any of them either — the light-record
///     (轻记录) tab
///     neither composes, nor sends, nor picks images.
///   · **One value could not stay a snapshot, and it is the new one.** The
///     signed-in state CAN change inside this sheet, because state A offers a
///     sign-in entry point. So it is passed as a getter and asked on every
///     build (see [PlusPanelNotesTab.isSignedIn]) rather than frozen at open.
///     🔴 That is the whole answer to 「快照还够不够」("is a snapshot still
///     good enough"): it was, until the panel
///     itself gained the power to change one of them.
class _PlusPanelState extends State<PlusPanel> {
  FavoritesStore get favorites => widget.favorites;
  AppStrings get strings => widget.strings;
  String get buffer => widget.buffer;
  bool get noPcTarget => widget.noPcTarget;
  bool get aiComposing => widget.aiComposing;

  /// ASSUMPTION (design §4-1, owner may overturn with one sentence): the panel
  /// opens on favorites (常用). Reason: it is today's behaviour, so no existing
  /// user pays an
  /// extra tap for a tab they did not ask for; and light-record (轻记录) costs a disk read that
  /// nobody who came here for a favourite should wait through.
  PlusPanelTab _tab = PlusPanelTab.favorites;

  bool get _hasNotesTab => widget.lightRecords != null;

  /// 🔴 REQ-12-09 09-D — THE TICK SET, AND WHY IT IS ALSO GATED ON `noPcTarget`.
  ///
  /// Null means 「这块面板上没有勾选框」("this panel has no tick boxes"), and
  /// there are TWO ways to get it:
  ///   · the caller wired no sender (a test shape, or a build where the feature
  ///     is not present) — the same anti-façade rule the image tile and the
  ///     light-record (轻记录)
  ///     tab already follow: no surface without a way to fill it;
  ///   · `noPcTarget` — there is no computer to send to, so a tick box could
  ///     only ever lead to a refusal. Red line R8: a control that cannot work is
  ///     worse than no control, and the caption above the favorites (常用) list
  ///     ([AppStrings.favoritesNoPcTarget]) already states the reason where the
  ///     user is looking.
  ///
  /// ⚠️ That second clause is not a shortcut around the 09-E copy card. Design
  /// §1-3 measured that a light record is written ONLY when there is no PC
  /// target, so 「面板里有轻记录可选」("the panel has a light record available to
  /// pick") and 「没有电脑可投」("there's no computer to deliver to") are the two
  /// sides of one
  /// boolean: this panel offers ticks exactly on the instances where sending is
  /// possible. If that ever stops being true, this is the line to revisit.
  PlusPanelSelection? _selection;

  /// CR-12-F — the 「with times」 chip. Off until the stored choice is read
  /// (design §10.3: off is the default), and the chip always draws this value,
  /// so what is on screen is what a send will use.
  bool _withTimes = false;

  /// Set by the first tap, so a late read of the stored value cannot undo it.
  bool _withTimesTouched = false;

  @override
  void initState() {
    super.initState();
    if (widget.onSendSelection != null && !widget.noPcTarget) {
      _selection = PlusPanelSelection()..addListener(_onSelectionChanged);
      unawaited(_loadWithTimes());
    }
  }

  Future<void> _loadWithTimes() async {
    final bool stored = await widget.prefs!.sendWithTimes();
    if (!mounted || _withTimesTouched || stored == _withTimes) return;
    setState(() => _withTimes = stored);
  }

  void _toggleWithTimes() {
    final bool next = !_withTimes;
    _withTimesTouched = true;
    setState(() => _withTimes = next);
    unawaited(widget.prefs!.setSendWithTimes(next));
  }

  @override
  void dispose() {
    _selection?.removeListener(_onSelectionChanged);
    _selection?.dispose();
    super.dispose();
  }

  /// The count and the send bar are rendered here, while the ticks are made in
  /// the light-record (轻记录) tab (a different widget) — so this listener is
  /// what keeps 「选了
  /// 几条」("how many are ticked") from becoming a second copy of the truth.
  void _onSelectionChanged() {
    if (mounted) setState(() {});
  }

  /// 09-F/09-J — hand the ticked things to the ONE delivery path and close.
  ///
  /// 🔴 The panel neither joins nor addresses nor enqueues anything itself: it
  /// hands over [PlusPanelSelection.composedText] (one string, or null) and the
  /// picture ROWS, and everything after that is the machinery that already
  /// exists. Design §7-3 is the reason and it is a red line, not tidiness —
  /// addressing correctness ('ID crosstalk is never allowed' / 绝不许串号) has
  /// only ever been proven on that one
  /// path, so a second emission point here would make that guarantee expire
  /// silently.
  Future<void> _sendSelection() async {
    final PlusPanelSelection? sel = _selection;
    final PlusSelectionSender? send = widget.onSendSelection;
    if (sel == null || send == null || sel.isEmpty) return;
    // CR-12-F: the chip counts only while it is on screen, i.e. while a
    // recording is ticked. Otherwise this is `composedText`, byte for byte.
    final String? text = sel.composeText(
      withTimes: _withTimes && sel.hasTimedRecording,
    );
    final List<TimelineEntry> images = sel.images;
    // Read BEFORE the pop (the same rule `_ImageTile` states for its original-image (原图) tick):
    // after this widget is gone its State is disposed and the selection with it.
    Navigator.of(context).pop();
    await send(text: text, images: images);
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListenableBuilder(
        listenable: favorites,
        builder: (BuildContext context, _) => Container(
          margin: const EdgeInsets.only(top: 60),
          decoration: BoxDecoration(
            color: FlowMicColors.surface,
            border: Border(top: BorderSide(color: FlowMicColors.line)),
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          ),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 14),
                  decoration: BoxDecoration(
                    color: FlowMicColors.line,
                    borderRadius: BorderRadius.circular(99),
                  ),
                ),
              ),
              // R6 T-4: the image tile sits ABOVE favorites (常用) — REDESIGN
              // §6.1 calls it
              // the panel's B3 signature action (招牌动作), and it is the one
              // action here that is
              // not reachable any other way. REQ-12-09 keeps it above the TAB
              // BAR too, for the same reason: it belongs to the panel, not to
              // either tab.
              if (widget.onPickImage != null) ...<Widget>[
                _ImageTile(
                  strings: strings,
                  noPcTarget: noPcTarget,
                  imageSending: widget.imageSending,
                  onPickImage: widget.onPickImage!,
                  originalBlock: widget.originalBlock,
                ),
                const SizedBox(height: 10),
              ],
              if (_hasNotesTab) ...<Widget>[
                _tabBar(),
                const SizedBox(height: 8),
              ],
              if (_tab == PlusPanelTab.notes)
                // Dropped from the tree when the user goes back to favorites
                // (常用), so
                // reopening the tab re-reads the disk. That is the honest
                // default for a list somebody else's sync can change under us.
                Flexible(
                  child: PlusPanelNotesTab(
                    strings: strings,
                    query: widget.lightRecords!,
                    liveArticleId: widget.liveArticleId,
                    isSignedIn: widget.isSignedIn!,
                    onSignIn: widget.onSignIn,
                    selection: _selection,
                    imageSendable: widget.imageSendable,
                    backfill: widget.backfill,
                  ),
                )
              else ...<Widget>[
                _header(context),
                // W2.5-E: the save button's cause, standing where the button
                // is. Same precedent as `_originalUnavailable` above: a greyed
                // control whose reason is only discoverable by tapping it is
                // the affordance this panel already refuses to ship.
                if (aiComposing) _saveBlocked(),
                const SizedBox(height: 4),
                // §6.2-6: no PC ⇒ no injection-type action, and the reason is
                // on screen rather than discovered by tapping something dead.
                Text(
                  noPcTarget
                      ? strings.favoritesNoPcTarget
                      : strings.favoritesTapToSend,
                  style: TextStyle(
                    color: noPcTarget ? FlowMicColors.amber : FlowMicColors.t3,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 6),
                Flexible(child: _list(context)),
              ],
              // 09-F/09-J — OUTSIDE the tab branch on purpose: a user may tick a
              // favorites (常用) phrase, switch to light-record (轻记录), tick
              // two more, and send. A bar that
              // lived inside one tab would vanish with the other half of what
              // they picked still ticked.
              if (_selection != null && _selection!.isNotEmpty) _sendBar(),
            ],
          ),
        ),
      ),
    );
  }

  /// 09-F/09-J — 「选了 N 条」("N ticked") + the one button that delivers them.
  ///
  /// ⚠️ The sub-line is drawn only when a PICTURE is ticked, and it is there
  /// because owner's ruling has a consequence the user cannot see coming: text
  /// composes into one message, but each picture is 「in new line, not merging
  /// to text line」 ⇒ ticking 3 phrases and 2 pictures produces THREE messages
  /// and three rows, not one. Saying so before the tap is cheaper than an
  /// explanation afterwards, and it carries no number — the count is already on
  /// the line above it (the M5-③ precedent: no digits inside the sentence).
  Widget _sendBar() {
    final PlusPanelSelection sel = _selection!;
    final bool withImages = sel.images.isNotEmpty;
    return Padding(
      key: const ValueKey<String>('plus.selection.bar'),
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  strings.selectionCount(sel.length),
                  style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5),
                ),
                if (withImages) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    strings.plusSelectionImagesSeparate,
                    key: const ValueKey<String>('plus.selection.imagesNote'),
                    style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
                  ),
                ],
              ],
            ),
          ),
          // CR-12-F — beside the send button, and only while a recording is
          // ticked: with none ticked it could change nothing (design §10.2).
          if (sel.hasTimedRecording) ...<Widget>[
            const SizedBox(width: 10),
            SendWithTimesChip(
              on: _withTimes,
              label: strings.selectionSendWithTimes,
              onTap: _toggleWithTimes,
            ),
            const SizedBox(width: 8),
          ] else
            const SizedBox(width: 10),
          InkWell(
            key: const ValueKey<String>('plus.selection.send'),
            onTap: () => unawaited(_sendSelection()),
            borderRadius: BorderRadius.circular(9),
            child: Container(
              height: 32,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: FlowMicColors.brandSoft,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(
                  color: FlowMicColors.brand.withValues(alpha: 0.4),
                ),
              ),
              child: Text(
                strings.plusSelectionSend,
                style: TextStyle(
                  color: FlowMicColors.brand,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 09-B — the two tabs. Drawn only when there is a light-record (轻记录)
  /// source to fill the
  /// second one, so a build without storage wired shows today's panel rather
  /// than a tab that opens onto nothing.
  ///
  /// Labels are the app's EXISTING two names (`favorites` / `cloudInstance`),
  /// not new ones: light-record (轻记录) is already spelled in four languages in
  /// CloudStrings, and a second spelling here would be a second answer to
  /// 「这个东西叫什么」("what is this thing called").
  Widget _tabBar() => Row(
    children: <Widget>[
      _tabButton(PlusPanelTab.favorites, strings.favorites, 'favorites'),
      const SizedBox(width: 8),
      _tabButton(PlusPanelTab.notes, strings.cloudInstance, 'notes'),
    ],
  );

  Widget _tabButton(PlusPanelTab tab, String label, String slug) {
    final bool on = _tab == tab;
    return InkWell(
      key: ValueKey<String>('plus.tab.$slug'),
      onTap: on ? null : () => setState(() => _tab = tab),
      borderRadius: BorderRadius.circular(9),
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 13),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? FlowMicColors.brandSoft : FlowMicColors.surface2,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: on ? const Color(0x66818CF8) : FlowMicColors.line,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: on ? FlowMicColors.brand : FlowMicColors.t2,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

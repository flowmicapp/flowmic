// SPEC-REF:
//   docs/ui-design/demo/mobile.html (frames 2/3/9/12: .devhead header with the
//     destination badge, offline .banner, chat scroll, .composer)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A-D
//   docs/rebuild/08-MOBILE-SPEC.md §2-5
//
// The chat-flow screen. Assembles the header (device + destination badge), the
// offline banner, the timeline scroll (live draft above committed rows), and
// the composer (mode chip + destination mirror + PTT bar). It is a thin view
// over ChatController / TimelineStore / DestinationController — no business
// logic lives here beyond dispatching gestures.
//
// T-5b-mobile: header connection dot uses connDotMeta (four visual states).
// T-6b: PopScope aligns system-back with the header ← (buffer confirm /
//       recording stop-and-keep).
// T-6b-2: stick-to-bottom via ListView(reverse: true). TimelineStore stays
//         newest-first (insert(0)); reverse paints index 0 at the visual
//         bottom so offset==0 is pinned without animateTo on new rows.

import 'dart:async';
// PA-5: the append button's dashed outline painter (chat_flow_edit_sheet.dart)
// walks the path — PathMetric is dart:ui-only, not re-exported by material.
import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/foundation.dart' show setEquals;
import 'dart:typed_data' show Uint8List;

import '../session/chat_controller.dart';
import '../session/compose_gate.dart';
import '../session/image_clipboard.dart';
// Card F2 addendum — see [_onInjectReceipt]: a `mode` fabricated by the
// desktop must never be used as a verdict.
import '../session/outbox_inject_authorship.dart'
    show isPcAdmissionRefusalCode;
import '../session/row_image_lookup.dart' show rowImageBytes;
import '../session/usage_counters.dart';
import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../signaling/album_away.dart';
import '../signaling/inbound_payloads.dart' show InjectResult;
import '../signaling/state_machine.dart';
import '../favorites/favorites_store.dart';
import '../signaling/wire_payloads.dart' show ComposeTask, FlowMode, SendPolicy;
import '../timeline/timeline_entry.dart';
// Card F10: the chat list's own owner-scoped window onto the table. The store's
// page is GLOBAL (newest 60 rows across every instance); this one is the
// narrowed question, asked of storage instead of filtered out of the answer to
// a different question.
import '../timeline/owner_timeline_pager.dart';
import '../timeline/cloud/light_record_query.dart' show LightRecordQuery;
import '../timeline/timeline_persistence.dart' show TimelinePersistence;
// N2: for TimelineStore.kWireModeCached — the receipt observer below and the row
// write-back must recognise the SAME wire word, or they will disagree about the
// same frame (the exact shape of RV-42).
import '../timeline/timeline_store.dart' show TimelineStore;
import 'ai_action_row.dart';
import 'banner_slot.dart';
import 'chat_back_policy.dart';
import 'chat_banner_sources.dart';
import 'chat_header.dart';
import 'chat_message_tile.dart';
import 'chat_retry_targets.dart';
import 'chat_timeline_faces.dart';
import 'compose_band.dart';
import 'confirm_dialog.dart';
import 'edit_entry_page.dart';
import 'entry_context_menu.dart';
import 'haptics.dart';
import 'hold_to_talk_surface.dart';
import 'image_preview_page.dart';
import 'image_transfer_bar.dart';
import 'mic_glyph.dart';
import 'mode_chip.dart';
import 'plus_panel.dart';
import 'ptt_bar.dart';
import 'recording_panel.dart';
// Card FB-7 multi-select / batch copy / hand off to AI to organize. Three
// files, three questions: what is
// ticked (state), what a batch amounts to and may run (pure judgement), and how
// the mode looks (widget). Imported HERE rather than in the part file below
// because a `part` cannot carry its own imports.
import 'selection/batch_actions.dart';
import 'selection/entry_selection.dart';
import 'selection/selection_bar.dart';
import 'tokens.dart';

// Window C-7 (800-line cap): the composer cluster (bottom input bar, 「+」
// button + panel, mode-chip tap confirm) moved out verbatim — see that
// file's header for the exact diff-discipline contract.
part 'chat_flow_composer.dart';
// P3 0.3.1 (800-line cap again — the tablet press-stability skeleton pushed
// the composer file over): the PTT caption family moved out of it verbatim.
// Same contract as above; see that file's header.
part 'chat_flow_dock_caption.dart';
// W5a / FB-7 (800-line cap, this file stood at 797/800): the two families
// that act on an EXISTING row — the long-press menu's dispatcher and the
// send-failure banner's resend — moved out verbatim. Same contract as above.
part 'chat_flow_entry_actions.dart';
// Card FB-7 — the selection mode's own surface (bar + the two batch actions).
// New behaviour in its own file from day one rather than added to this one and
// split later: the split above only just bought the room back.
part 'chat_flow_selection.dart';
// PA-4 (Plan A′ SUP-5) — the ONE edit surface: the bottom sheet that merged
// the ruling-#4 floating card (chat_flow_edit_card.dart, deleted) and the T-3
// expanded compose face (chat_flow_expanded_compose.dart, deleted). Its
// header carries the visibility model and the auto-open detection argument.
part 'chat_flow_edit_sheet.dart';
// PA-5's append machinery — split from the sheet file at the 800-line cap
// (verbatim move; the sheet file's header points here).
part 'chat_flow_edit_sheet_append.dart';
// fix-001 (the cap again, this file stood at 855): the two ways this page leaves
// itself. Same verbatim-move contract as above.
part 'chat_flow_exits.dart';
part 'chat_flow_pager_sync.dart'; // REQ-12-02 — split at the 800-line cap.
// 800-line cap again (this file stood at 796/800): the timeline scroll
// itself — the four faces, the reversed list, the 「回到底部」 ("back to
// bottom") affordance and the floating edit card's hit order. Same
// verbatim-move contract as above.
part 'chat_flow_scroll.dart';

class ChatFlowPage extends StatefulWidget {
  const ChatFlowPage({
    super.key,
    required this.controller,
    this.appSettings,
    this.onOpenSettings,
    this.onClearHistory,
    this.hasUpdate = false,
    this.onBack,
    this.deviceNameOverride,
    this.isCloudInstance = false,
    this.historySource,
    this.isSignedIn,
    this.onSignIn,
  });
  final ChatController controller;

  /// REQ-12-09 09-B — the account state the 「+」 panel's Light-record
  /// (轻记录) tab asks.
  ///
  /// 🔴 A GETTER threaded from the composition root, not a bool, and not read
  /// off the controller: the login layer holds exactly one copy of this
  /// (`LoginController.isLoggedIn`) and a value copied at page-build time would
  /// be stale the moment the user signs in from inside the panel. Null ⇒ the
  /// panel draws no Light-record tab at all (see [showPlusPanel]) rather than guessing.
  final bool Function()? isSignedIn;

  /// Opens the sign-in sheet — the SAME `showLoginSheet` the instance list uses
  /// (connections_page.dart), supplied by the composition root because that is
  /// where the [LoginController] lives. Null ⇒ state A states the fact without
  /// offering a button.
  final Future<void> Function()? onSignIn;

  /// Card F10 — the table this page pages through, owner-scoped.
  ///
  /// 🔴 Threaded from the composition root (`main.dart`, the SAME
  /// `openTimelinePersistence` result [TimelineStore] was built on) rather than
  /// read off the store, because the store does not expose its persistence and
  /// this card does not own that file. Null means 「没有人接线存储」 ("nobody wired storage"): the
  /// page then falls back to the store's own in-memory rows, i.e. exactly the
  /// pre-F10 behaviour — visibly narrower, never blank, and never pretending to
  /// have paged. `chat_history_source_wiring_test.dart` pins the production
  /// wiring so that fallback cannot silently become the shipped path.
  final TimelinePersistence? historySource;

  /// Explicit locale source for the polish-skipped honest-signal copy
  /// (WP-R4-6 ⑦). Null falls back to zh — chat-flow i18n is still incremental.
  final AppSettingsController? appSettings;

  /// Opens the settings screen (wired by the composition root). The gear is a
  /// dead affordance until this is supplied.
  final VoidCallback? onOpenSettings;

  /// REQ-12-02 — opens the existing Stats-and-Clear (统计与清空) sheet. Supplied by main.dart for
  /// the same reason [onOpenSettings] is: this page navigates, it does not own
  /// the [AssetInventory] singleton that sheet must share with export and stats
  /// (settings_page.dart says so in as many words). `null` hides the control.
  final VoidCallback? onClearHistory;

  /// UP-2 —— the small dot on the gear icon when a new version exists. Pure
  /// forwarding, the one true source is
  /// `UpdateController.hasUpdate` (see chat_header.dart's [ChatHeader.hasUpdate]).
  final bool hasUpdate;

  /// Return to the instance list (demo frame 2 back arrow). When supplied, a back
  /// affordance appears in the header; invoking it runs this side effect (the
  /// composition root disconnects the session) before the page pops. Null on the
  /// home-rooted variant.
  final VoidCallback? onBack;

  /// Optional local display label (alias → device name from the remembered
  /// pairing). When non-empty on a LAN chat, the header prefers this over the
  /// session ack field [PttSession.connectedDeviceName] — alias is phone-local
  /// only and must never be written back into that ack truth. Null keeps the
  /// prior header path (ack name / `FlowMic` fallback). Cloud still uses
  /// [AppStrings.cloudInstance] regardless.
  final String? deviceNameOverride;

  /// v0.2.6 — the peer is the virtual cloud light-record (云端轻记录)
  /// instance. Threaded from the
  /// composition root so the header asks the PAIRING, not the destination lock.
  final bool isCloudInstance;

  @override
  State<ChatFlowPage> createState() => _ChatFlowPageState();
}

class _ChatFlowPageState extends State<ChatFlowPage> {
  ChatController get controller => widget.controller;
  VoidCallback? get onOpenSettings => widget.onOpenSettings;
  VoidCallback? get onClearHistory => widget.onClearHistory;
  VoidCallback? get onBack => widget.onBack;

  /// Reversed list: offset 0 = visual bottom. Above this → show 「回到底部」 ("back to bottom").
  static const double _backToBottomThreshold = 240;

  late final ScrollController _scrollCtl;
  bool _showBackToBottom = false;

  /// Card F10 — this screen's owner-scoped window onto the timeline table.
  ///
  /// The store's list stays what it always was: the GLOBAL newest page plus
  /// whatever this session wrote. This pager supplies the owned rows the store
  /// never loaded, and `_narrowedEntries` unions the two.
  late final OwnerTimelinePager _pager;

  /// Last observed size of the store's list. A DECREASE is the one signal a
  /// deletion made elsewhere (full history, range clear — 全部历史, 范围清空) reaches this page by: nothing
  /// else shrinks that list. On a decrease the pager re-asks storage rather
  /// than trusting rows it may still be holding — a deleted row repainted here
  /// would look like the deletion silently failed.
  int _lastStoreCount = 0;

  AppStrings get _strings => AppStrings.of(
    widget.appSettings?.locale ?? AppLocale.zh,
  );

  bool get _hasUnsentBuffer => controller.buffer.trim().isNotEmpty;

  /// owner 2026-07-26 ②: one-shot guard so the pop fires exactly once even
  /// though the controller keeps notifying.
  bool _sessionLostHandled = false;

  /// fix-001 — a SECOND one-shot latch on purpose; the argument is in
  /// chat_flow_exits.dart. Never merge it with [_sessionLostHandled].
  bool _capsuleTakenHandled = false;

  /// Card FB-7 — which rows are ticked, and whether the mode is on at all.
  ///
  /// Owned by the PAGE, not the controller: a selection is view state with no
  /// wire, no storage and no lifetime beyond this screen. On [ChatController]
  /// it would survive a page rebuild and outlive the list it refers to.
  final EntrySelection _selection = EntrySelection();

  /// Ruling #4 — the buffer's ONE edit state; synced by [_syncComposeText].
  final TextEditingController _composeText = TextEditingController();

  /// 🔴 WP8-P0 (device-measured, TB335ZC) — the PttBar's element identity,
  /// held as a page-lifetime GlobalKey because VF-8 moves the bar BETWEEN
  /// PARENTS when a hold begins (two-column idle dock → phone arrangement the
  /// moment the FSM leaves idle). A ValueKey cannot carry an element across a
  /// reparent, so the element owning the in-flight gesture died mid-hold and
  /// the lift never reached the controller — the recording ran unstoppable
  /// through N-1's rolling segments until force-stop. A GlobalKey survives a
  /// same-frame reparent with state and live gesture intact.
  /// Pinned by tablet_hold_reparent_test.dart.
  final GlobalKey _pttBarKey = GlobalKey(debugLabel: 'ptt.bar.widget');

  /// 🔴 PA-4 (SUP-5) — the edit SHEET is up. The one visibility author.
  ///
  /// Owned by the PAGE and nothing else, exactly as the contract requires:
  ///   · it is NOT derived from policy × buffer — the old `composeEditHold`
  ///     author is retired; a collapsed sheet over a manual non-empty draft is
  ///     a legal state (contract §4 A2);
  ///   · it is NOT derived from focus — a focus-derived state collides head-on
  ///     with D4 and with the in-sheet append (ai-pills §1's rationale);
  ///   · it is NOT persisted — leaving the page or any close gesture zeroes it.
  bool _sheetOpen = false;

  /// §5-2 header provenance: true while the draft came from a voice finalize
  /// (「已转录…」 — "transcribed…"), false for a typed draft (「草稿…」 —
  /// "draft…"). Set by the open triggers
  /// in chat_flow_edit_sheet.dart, reset on deliver/discard/mode-switch.
  bool _sheetSrcVoice = false;

  /// PA-5 — recording started from the sheet's append button (dock table A7).
  /// Set by the button's accepted down-edge; cleared by
  /// [_syncSheetOnControllerRouted] once the FSM leaves recording/processing
  /// (the fold — or the cancel — has settled by then).
  bool _sheetAppending = false;

  /// PA-5 — the ONE writer of [_sheetAppending] (same @protected-setState
  /// argument as [_setSheetOpen]).
  void _setSheetAppending(bool value) {
    if (_sheetAppending == value) return;
    setState(() => _sheetAppending = value);
  }

  /// Bottom inset frozen while an append hold is in flight, so dismissing
  /// the IME cannot drop the sheet (and the button under the finger) by
  /// `viewInsets.bottom`. Zero = follow the keyboard as usual.
  double _appendKeyboardLock = 0;

  void _lockAppendGeometry(double inset) {
    if (inset <= 0 || _appendKeyboardLock == inset) return;
    setState(() => _appendKeyboardLock = inset);
  }

  void _unlockAppendGeometry() {
    if (_appendKeyboardLock == 0) return;
    setState(() => _appendKeyboardLock = 0);
  }

  /// Which AI transform the open (or last-open) sheet is showing. Lives HERE
  /// rather than on `_SheetAiRow` so a collapse/reopen does not lose the ✓.
  ComposeTask? _sheetApplied;
  String? _sheetAppliedText;
  ComposeTask? _sheetAiPending;

  /// The auto-open listener's memory ([_syncSheetOnControllerRouted]): the
  /// last buffer/mode this page observed, so 「the buffer CHANGED while the
  /// sheet was closed」 is an edge, not a level.
  String _lastBufferSeen = '';
  FlowMode? _lastModeSeen;

  /// The sheet field's focus node. Lives here (not in the sheet) because the
  /// sheet is rebuilt on every controller notification and a node created in
  /// `build` would drop focus on the first keystroke.
  final FocusNode _composeFocus = FocusNode();

  void _syncComposeText() => _syncComposeTextRouted(this);

  /// PA-4 — the ONE writer of [_sheetOpen].
  ///
  /// An instance method rather than a `setState` inside the part file's `Routed`
  /// functions: `State.setState` is `@protected`, and reaching it through an
  /// explicit receiver is a analyzer warning for a real reason (it is not part
  /// of the object's contract with anybody else). Same shape as
  /// [_onSelectionChanged] above.
  void _setSheetOpen(bool value) {
    if (_sheetOpen == value) return;
    setState(() => _sheetOpen = value);
  }

  /// SUP-5 open/close edges that arrive as controller notifications — see
  /// [_syncSheetOnControllerRouted].
  void _syncSheetOnController() => _syncSheetOnControllerRouted(this);

  /// V2-04: the haptic receipt observer. Listens on the session's inject:result
  /// stream DIRECTLY (presentation layer) — the FSM, the delivery write-back
  /// and the banner queue are untouched.
  StreamSubscription<InjectResult>? _injectReceiptSub;

  @override
  void initState() {
    super.initState();
    _scrollCtl = ScrollController()..addListener(_onScrollOffset);
    _pager = OwnerTimelinePager(persistence: widget.historySource);
    _lastStoreCount = controller.store.entries.length;
    controller.store.addListener(_onStoreChanged);
    controller.addListener(_maybeLeaveOnSessionLost);
    controller.addListener(_maybeLeaveOnCapsuleTaken);
    // fix-001 — ALSO asked once on entry, not only on the edge. Why that is
    // load-bearing: chat_flow_exits.dart, 「推送状态没有拉取」 ("pushed state has no pull path").
    _maybeLeaveOnCapsuleTaken();
    controller.addListener(_syncComposeText);
    _syncComposeText();
    // PA-4: the sheet's controller-notification edges (manual-finalize
    // auto-open, mode-switch close). A LISTENER, not a line in `build` —
    // writing state during build is the markNeedsBuild-during-build crash
    // _syncComposeTextRouted's header records.
    _lastBufferSeen = controller.buffer;
    _lastModeSeen = controller.mode;
    controller.addListener(_syncSheetOnController);
    _injectReceiptSub = controller.session.injectResults.listen(_onInjectReceipt);
    // The connected instance is already known when this page is pushed from the
    // instance list; asking on the first frame keeps the first paint from being
    // a void that fills in later.
    controller.session.scope.addListener(_syncPagerOwners);
    _syncPagerOwners();
    _selection.addListener(_onSelectionChanged);
  }

  /// Card FB-7 — a `setState`, not a merge into `build`'s `Listenable.merge`:
  /// [PopScope.canPop] is computed OUTSIDE that builder, so a repaint-only
  /// update would leave the first back press after entering selection mode
  /// popping the PAGE instead of the mode.
  void _onSelectionChanged() {
    if (mounted) setState(() {});
  }

  // The pager-sync family lives in chat_flow_pager_sync.dart (verbatim move at
  // the 800-line cap); why the three belong together is argued there.
  void _syncPagerOwners() => _syncPagerOwnersRouted(this);
  void _syncPagerOwnersDeferred() => _syncPagerOwnersDeferredRouted(this);
  void _onStoreChanged() => _onStoreChangedRouted(this);

  @override
  void dispose() {
    controller.removeListener(_syncComposeText);
    controller.removeListener(_syncSheetOnController);
    controller.removeListener(_maybeLeaveOnSessionLost);
    controller.removeListener(_maybeLeaveOnCapsuleTaken);
    controller.session.scope.removeListener(_syncPagerOwners);
    controller.store.removeListener(_onStoreChanged);
    unawaited(_injectReceiptSub?.cancel());
    _selection
      ..removeListener(_onSelectionChanged)
      ..dispose();
    _composeText.dispose();
    _composeFocus.dispose();
    _pager.dispose();
    _scrollCtl
      ..removeListener(_onScrollOffset)
      ..dispose();
    super.dispose();
  }

  /// V2-04: the inject:result IS the moment the PC's truth arrives — the one
  /// signal the person watching the PC (not the phone) can actually feel.
  /// ONE pulse = landed, TWO = failed. `cached` is NEITHER (the PC queued the
  /// text for a target it does not have yet): buzzing success would claim an
  /// injection that has not happened, buzzing failure would claim a loss that
  /// did not occur — so it stays silent and the row badge carries the truth.
  ///
  /// 只吵一次 ("makes noise at most once") check: a wire inject:result never coincides with a banner. The
  /// banner sources (connection / auto-stopped / sttStalled / utterance /
  /// send / ai / image failures) all settle WITHOUT an inject:result frame —
  /// the send-side failures mean no frame ever left or returned.
  void _onInjectReceipt(InjectResult r) {
    if (r.ok) {
      unawaited(FlowMicHaptics.injectSuccess());
      // N2: the literal was already here, and this observer was the ONLY place
      // that read the verdict's own word — the row write-back threw it away and
      // called every ok:false a failure, which is how the buzz and the badge came
      // to describe the same frame differently. Same named constant now.
      // 🔴 Card F2 addendum (2026-08-02) — the second clause is **the same
      // leak plugged twice**, see the long comment inside
      // `timeline_store.applyInjectResult`: the `mode` the desktop stamps for
      // `INJECT_NOT_PRIMARY` (another phone is occupying this PC) is
      // **fabricated** (`socket/client.rs`'s `build_inject_result(false,
      // "sendinput", Some(error_codes::INJECT_NOT_PRIMARY), …)` stamps
      // `"sendinput"`, while it never pressed a single key).
      // The passage above already sets its own rule — 「buzzing failure would
      // claim a loss that did not occur」 — and being occupied is **precisely
      // NOT a loss**: the queue still owes it, and it will be delivered the
      // moment the other side leaves.
      // ⇒ Same category as `cached`: **stay silent**, and let the truth be
      // carried by the row's badge and that state-type banner (§2.5d).
    } else if (r.mode != TimelineStore.kWireModeCached &&
        !isPcAdmissionRefusalCode(r.error)) {
      unawaited(FlowMicHaptics.injectFailure());
    }
  }

  // Both exits live in chat_flow_exits.dart (verbatim move at the 800-line cap);
  // why they are two and may never be merged is argued there.
  void _maybeLeaveOnSessionLost() => _maybeLeaveOnSessionLostRouted(this);
  void _maybeLeaveOnCapsuleTaken() => _maybeLeaveOnCapsuleTakenRouted(this);

  void _onScrollOffset() {
    if (!_scrollCtl.hasClients) return;
    _maybeLoadOlder();
    final bool show = _scrollCtl.offset > _backToBottomThreshold;
    if (show == _showBackToBottom) return;
    setState(() => _showBackToBottom = show);
  }

  /// Card F10 — the upper edge actually loads.
  ///
  /// 🔴 Before this card the chat list had NO paging trigger at all: this
  /// listener only toggled 「回到底部」 ("back to bottom"), and `TimelineStore.loadMore()`'s single
  /// caller in the whole app was `history_page.dart`. Scrolling up on the chat
  /// screen therefore hit the end of the first page and simply stopped, with
  /// the rest of the conversation still in the table.
  ///
  /// This list is `reverse: true`, so 「往更早的方向」 ("the direction toward
  /// older") is UP and 「older」 is at
  /// maxScrollExtent — the opposite edge from `history_page._onScroll`, same
  /// intent, and deliberately the same one-screen slack so the next page is
  /// already there rather than stalling at the boundary.
  void _maybeLoadOlder() {
    if (!_pager.hasMore || _pager.loading) return;
    final double remaining =
        _scrollCtl.position.maxScrollExtent - _scrollCtl.position.pixels;
    if (remaining < 600) unawaited(_pager.loadMore());
  }

  void _scrollToBottom() {
    if (!_scrollCtl.hasClients) return;
    _scrollCtl.animateTo(
      0,
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
    );
  }

  /// Shared exit path for header ← and system back (PopScope).
  /// Uses [Navigator.pop] (not maybePop) so canPop:false does not re-enter.
  Future<void> _attemptBack() async {
    final AppStrings strings = _strings;
    // 🔴 Card FB-7 — in selection mode back leaves the MODE, not the page, and
    // is checked FIRST: the two forks below ask 「really leave this screen」,
    // which is not what a back press inside a selection is asking.
    if (_selection.active) {
      _selection.exit();
      return;
    }
    // 🔴 PA-4 / §5-2 close gesture: 「系统返回键 ⇒ 先收编辑面，再走既有序列」
    // ("system back key ⇒ collapse the edit face first, THEN walk the
    // existing sequence").
    // REDESIGN-PLAN §6.4's sequence is collapse panel/overlay (收面板/弹层) →
    // leave instance list (退实例列表) → root-level exit (根级退出), and
    // the sheet is an 「overlay」 (弹层) — so it goes in FRONT, exactly like the selection
    // mode above. Collapse preserves the draft (SUP-5); the confirm-discard
    // fork below still guards the NEXT back press if the draft is unsent.
    if (_sheetOpen) {
      _collapseSheetRouted(this);
      return;
    }
    final ChatBackKind kind = chatBackKind(
      isRecording: controller.isRecording,
      hasUnsentBuffer: _hasUnsentBuffer,
    );

    if (kind == ChatBackKind.stopRecording) {
      // pttUp = stop + keep path. Never pttCancel (silent drop). Stay here.
      await controller.pttUp();
      if (!mounted) return;
      _toast(context, strings.recordingStoppedKept);
      return;
    }

    if (kind == ChatBackKind.confirmDiscard) {
      final bool? discard = await showDialog<bool>(
        context: context,
        builder: (BuildContext ctx) => AlertDialog(
          backgroundColor: FlowMicColors.surface,
          content: Text(
            strings.discardUnsentConfirm,
            style: TextStyle(color: FlowMicColors.t1, fontSize: 14),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(strings.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(
                strings.discardUnsentAction,
                style: TextStyle(color: FlowMicColors.red),
              ),
            ),
          ],
        ),
      );
      if (discard != true || !mounted) return;
    }

    onBack?.call();
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final List<Listenable> listenables = <Listenable>[
      controller,
      controller.store,
      // Card F10: the owner-scoped window repaints on its own schedule (a page
      // landing, the spinner clearing) — without this the older rows would sit
      // in memory until some unrelated notification happened to rebuild.
      _pager,
      controller.destination,
      // F-5: the ⭐ on a history row and the 「+」 panel's list read the SAME
      // store (P-1 「一个功能一个家」 — "one feature, one home"), so the flow
      // rebuilds whenever it moves.
      controller.favorites,
      // RV-60: album-away open/close + the reconnect ladder's climbing bit both
      // change the link banner without an FSM edge.
      AlbumAway.instance,
      controller.session.reconnect.reconnecting,
      // Card U2: the mic-permission face changes without an FSM edge too (the OS
      // dialog resolves off the banner's own action button) — without this, a
      // grant/deny would not repaint until the next controller notification.
      controller.session.micPermission.face,
      ?widget.appSettings,
    ];
    // When onBack is null this page is the root — system back should leave the
    // app / prior route without our intercept. When onBack is set, we own the
    // exit (same as header ←).
    // 🔴 Card FB-7 adds the second term: on the home-rooted variant (`onBack ==
    // null`) back was never intercepted, so entering selection mode there and
    // pressing back would have left the APP with a selection bar on screen.
    // 🔴 PA-4 keeps the third for the identical reason: on that same variant,
    // a back press with the sheet up would have left the APP instead of
    // collapsing the overlay in front of the user.
    final bool interceptBack =
        onBack != null || _selection.active || _sheetOpen;
    return PopScope(
      canPop: !interceptBack,
      onPopInvokedWithResult: (bool didPop, Object? result) async {
        if (didPop || !interceptBack) return;
        await _attemptBack();
      },
      child: Scaffold(
        backgroundColor: FlowMicColors.canvas,
        // While an append hold has frozen the IME inset, the scaffold must
        // NOT shrink with the keyboard — that shrink is what used to slide
        // the append button out from under the finger.
        resizeToAvoidBottomInset: _appendKeyboardLock == 0,
        body: Padding(
          padding: EdgeInsets.only(bottom: _appendKeyboardLock),
          child: SafeArea(
          child: ListenableBuilder(
            listenable: Listenable.merge(listenables),
            builder: (BuildContext context, _) {
              final bool connected =
                  controller.connection == ConnectionState.connected;
              final AppStrings strings = _strings;
              // M2 / RV-15: the rows the send-failure banner's resend would
              // re-deliver — ALL of the ones that failed, not a guess at the
              // newest. Empty ⇒ the banner stays a plain notice.
              final List<TimelineEntry> retryTargets = _sendRetryTargets();
              // Card FB-7 — hoisted out of `_scroll` so the list and the
              // selection bar read the SAME rows: 「已选 3 条」 ("3 selected") answering a
              // different question from the list under it is this repo's #1
              // bug shape.
              final String? iid = controller.session.connectedInstanceId;
              // Identity can change without this State being rebuilt from
              // scratch (reconnect re-enters through the same page). Deferred
              // to after the frame: the pager notifies, this page listens.
              _syncPagerOwnersDeferred();
              final List<TimelineEntry> entries = _narrowedEntries(iid);
              // PA-4: the page is a Stack so the edit sheet can cover the
              // WHOLE column — dock and PTT bar included (§4 A6). The dock
              // keeps rendering underneath (covered, not unmounted), which is
              // what makes 「the sheet covers the PTT bar」 a measurable fact;
              // the scrim above it is what makes it unreachable.
              return Stack(
                children: <Widget>[
                  Column(
                children: <Widget>[
                  _header(context, strings),
                  // Card FB-7 — the selection toolbar: under the header, present
                  // ONLY in the mode (selection_bar.dart's header carries the
                  // width accounting that decided its shape).
                  if (_selection.active)
                    _selectionBarRouted(this, context, strings, entries),
                  // RCA-v3 (owner 2026-07-30): the image-delivery progress
                  // strip — top of the page, real bytes on the http path,
                  // stage words on the socket path, absent when idle.
                  ImageTransferBar(
                    progress: controller.imageSend.progress,
                    // G-20 ⑥: the instance-scoped read — this bar bypasses the
                    // banner table, so it carries its own scope gate.
                    onScreen: () => controller.imageSend.progressOnScreen,
                    strings: strings,
                  ),
                  // R6 T-5 (REDESIGN P-3): ONE banner slot. Both live sources —
                  // the transport edge and the R6 P0-R3 auto-stop notice — are
                  // mapped into a priority queue; whatever loses the priority
                  // contest stays reachable behind 「还有 N 条」 ("N still remaining"), never dropped.
                  // Window B3-2b: WHICH sources feed the slot moved to
                  // chat_banner_sources.dart (800-line cap), verbatim. The page
                  // keeps the slot; the adapter keeps the wiring.
                  BannerSlot(
                    queue: chatBannerSources(
                      controller: controller,
                      strings: strings,
                      // RV-15 corrected this: resend rides ManualDelivery.reInject
                      // (per row), NOT deliverText — a RE-delivery, stamped now.
                      onRetrySendFailure: retryTargets.isEmpty
                          ? null
                          : () => _retryFailedSend(retryTargets),
                    ),
                    strings: strings,
                  ),
                  Expanded(child: _scroll(context, strings, iid, entries)),
                  // PA-3: the recording strip moved INSIDE the composer (the
                  // dock draws it above the PTT bar — Plan A′ §4 A3), so the
                  // dock's top border sits above the strip, not through it.
                  _composer(context, connected, strings),
                ],
                  ),
                  if (_sheetOpen)
                    ..._editSheetOverlayRouted(this, context, strings),
                ],
              );
            },
          ),
        ),
        ),
      ),
    );
  }

  // ── header ─────────────────────────────────────────────────────────────
  // Extracted to chat_header.dart (800-line cap). It is a pure render of
  // controller state, so it moves without carrying any logic with it.
  Widget _header(BuildContext context, AppStrings strings) => ChatHeader(
    controller: controller,
    strings: strings,
    deviceNameOverride: widget.deviceNameOverride,
    isCloudInstance: widget.isCloudInstance,
    onBack: onBack == null ? null : _attemptBack,
    onOpenSettings: onOpenSettings,
    onClearHistory: onClearHistory,
    hasUpdate: widget.hasUpdate,
  );

  // ── recording strip (R6 T-5d → PA-3) ───────────────────────────────────
  // The strip's construction moved to chat_flow_composer.dart
  // (`_recordingStripRouted`) with the strip itself — the dock owns it now,
  // and the edit sheet reuses the SAME constructor for the in-sheet append
  // strip (PA-5), so 「what feeds the meters」 keeps one author.

  /// Card F10 — the rows this screen shows. See [mergeNarrowedRows] for why it is
  /// a union of the store's live view and the pager's pages rather than either
  /// one alone.
  ///
  /// Card F2: both halves are scoped by [OwnerTimelinePager.owners], the machine's
  /// owner set. Reading the set off the pager rather than recomputing it is what
  /// keeps the two halves from ever answering different questions — the pager IS
  /// the cache of 「this screen asked storage for THESE owners」, and a store view
  /// built from a different set would union rows the pages can never reach.
  List<TimelineEntry> _narrowedEntries(String? iid) => iid == null
      ? const <TimelineEntry>[]
      : mergeNarrowedRows(
          controller.store.entriesForOwners(_pager.owners),
          _pager.rows,
        );

  // ── scroll ─────────────────────────────────────────────────────────────
  // Body moved to chat_flow_scroll.dart (800-line cap), VERBATIM, together with
  // the section note that argues `reverse: true`. It is reached from `build()`
  // above under its original name and with its original signature — see that
  // file's header for why it needed no delegator at all.

  // ── long-press menu + send-failure resend ─────────────────────────────────
  // Bodies moved to chat_flow_entry_actions.dart (800-line cap), VERBATIM, as
  // `_onLongPressRouted` / `_sendRetryTargetsRouted` / `_retryFailedSendRouted`.
  // All three keep their original names here as one-line delegations because
  // every call site is elsewhere in this file (`itemBuilder` for the first,
  // `build()` for the other two) — same shape as `_composer` below.
  Future<void> _onLongPress(
    BuildContext context,
    TimelineEntry entry,
    AppStrings strings,
  ) => _onLongPressRouted(this, context, entry, strings);

  List<TimelineEntry> _sendRetryTargets() => _sendRetryTargetsRouted(this);

  void _retryFailedSend(List<TimelineEntry> entries) =>
      _retryFailedSendRouted(this, entries);

  // ── M4 mode-chip confirm + 「+」 panel (T-3b ②③) ───────────────────────────
  // `_onModeChipTap` / `_plusButton` / `_openPlusPanel` moved to
  // chat_flow_composer.dart (800-line cap), verbatim, as `_onModeChipTapRouted` /
  // `_plusButtonRouted` / `_openPlusPanelRouted`. Their only callers were inside
  // the moved `_composer` body, which now calls the Routed versions directly —
  // so unlike `_composer` itself (called from `build()` below), these three
  // have no delegation stub left here to keep working.

  /// Short confirmation for the purely-local favourites actions. Delivery
  /// failures do NOT come through here — those are the banner slot's job (P-3),
  /// which is persistent and dismissible rather than a 2-second flash.
  void _toast(BuildContext context, String message) {
    final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            message,
            style: TextStyle(color: FlowMicColors.t1, fontSize: 12.5),
          ),
          backgroundColor: FlowMicColors.surface2,
          duration: const Duration(seconds: 2),
          behavior: SnackBarBehavior.floating,
        ),
      );
  }

  // ── composer ─────────────────────────────────────────────────────────────
  // Body moved to chat_flow_composer.dart (800-line cap), verbatim, as
  // `_composerRouted`. Kept as a one-line delegation because `build()` below
  // still calls `_composer(context, connected, strings)` — that call site is
  // untouched.
  Widget _composer(BuildContext context, bool connected, AppStrings strings) =>
      _composerRouted(this, context, connected, strings);
}

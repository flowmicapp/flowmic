// VERBATIM MOVE out of chat_flow_page.dart (800-line cap) — the composer
// cluster: the bottom input bar (`_composer`), its 「+」 button and panel
// (`_plusButton` / `_openPlusPanel`), and the mode-chip tap confirm
// (`_onModeChipTap`). These four were only ever called from inside this
// cluster (one call site each, all within it) or from `build()`'s single
// `_composer(...)` call, so the cut boundary is clean.
//
// Same mechanical shape as chat_transient_banner_timers.dart's `Routed`
// functions (see that file's header): each old private INSTANCE method
// becomes a top-level function taking the explicit receiver
// `_ChatFlowPageState s` first — `part of` keeps private-member access
// (`s.controller`, `s._toast`) legal because privacy in Dart is
// per-library, and a part file is the same library as its `part of`
// target. chat_flow_page.dart keeps the four original method names as
// one-line delegations (`_composer(...) => _composerRouted(this, ...)`), so
// every call site elsewhere in that file is untouched.
//
// 🔴 Diff discipline: nothing in any Routed body differs from the original
// method body beyond `controller` → `s.controller`, `_toast(...)` →
// `s._toast(...)`, and the two sibling calls (`_plusButton` /
// `_onModeChipTap`) → their Routed counterparts. Any other diff is a bug.

part of 'chat_flow_page.dart';

// ── 「+」 panel (T-3b ②③) ─────────────────────────────────────────────────
// PA-1 / SUP-8: 38 → 44. The compose-band contract §2-2 had deliberately left
// this at 38 (「owner didn't name it」); Plan A′'s component spec puts every
// dock touch target on the one [kComposeTouchTarget] ruler, and the 38px
// rationale comment was already retired (b1d07803).
//
// WP8 VF-2: the face is the mock's `.rbt{width:44px;height:44px;
// border-radius:13px;background:var(--chipbg);font-size:20px;color:var(--sub)}`
// — a filled chip with NO border. The border is a delete, not an oversight: in
// the mock the bordered thing on this row is the hint strip beside it, and
// giving both an outline made the two read as one control split in half.
Widget _plusButtonRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) => InkWell(
  key: const ValueKey<String>('compose.plus'),
  onTap: () => _openPlusPanelRouted(s, context, strings),
  borderRadius: BorderRadius.circular(13),
  child: Container(
    width: kComposeTouchTarget,
    height: kComposeTouchTarget,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: FlowMicDockColors.chipbg,
      borderRadius: BorderRadius.circular(13),
    ),
    child: Icon(Icons.add, size: 20, color: FlowMicDockColors.sub),
  ),
);

Future<void> _openPlusPanelRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) {
  return showPlusPanel(
    context,
    favorites: s.controller.favorites,
    strings: strings,
    buffer: s.controller.buffer,
    // §6.2-6: cloud ⇒ no PC focus. Favorites' tap-to-send (点选即发) stays
    // inert; the album-picture picker still opens (local noted save — owner
    // 2026-07-31), with honest copy.
    noPcTarget: s.controller.destination.isFixed,
    // Tap-to-send (点选即发) goes through ChatController.sendFavorite → the
    // SAME ManualDelivery.deliverText path as ➤. There is no second emission
    // route.
    onSend: s.controller.sendFavorite,
    onFeedback: (String message) => s._toast(context, message),
    // R6 T-4 album picture. Failures land on the BANNER (persistent, dismissible),
    // not the 2-second toast — a delivery that did not happen must not be
    // something the user can miss by looking away.
    onPickImage: (bool original) async {
      await s.controller.sendImage(original: original);
    },
    imageSending: s.controller.imageSend.isSending,
    // owner 2026-08-01: "original image" (原图) is LAN-only. Read from the
    // controller so the panel and the send apply the SAME expression; the
    // send re-reads the channel afterwards, which is the answer that binds.
    originalBlock: s.controller.imageSend.originalBlock,
    // W2.5-E: "save into the current buffer" (存入当前缓冲) must not bank a
    // half-streamed compose result. SAME source of truth as ➤ —
    // `ChatController.isAiComposing` (chat_controller.dart:551 →
    // `aiCompose.isRunning`), which is the term `canSend` ends in. Not a
    // second bool computed here: two values answering 「AI 在跑吗」("is the
    // AI still running") is how they drift apart.
    //
    // 🔴 This gates the SAVE only. Tap-to-send (点选即发) above (`onSend:`
    // `s.controller.sendFavorite`) is untouched on purpose — see plus_panel's
    // `_saveButton` doc for why the delivery half must not inherit this term.
    aiComposing: s.controller.isAiComposing,
    // REQ-12-09 09-A/09-B — the light-record (轻记录) tab's read, built over
    // the SAME persistence `historySource` already threads for the chat list,
    // so 「这台手机上有哪些行」("which rows exist on this phone") has one
    // answer whichever surface asks.
    //
    // 🔴 It is NOT built from the cloud leg's `BlindStoreTimelineBridge`, and
    // that is deliberate: main.dart only constructs that inside
    // `if (cloudState != null)`, so on the shared_preferences fallback the tab
    // would silently disappear while the rows are still on disk — the exact lie
    // design §3-3 state B forbids. Null here means storage was never wired at
    // all (test shapes), and then no tab is drawn rather than an empty one.
    lightRecords: s.widget.historySource == null
        ? null
        : LightRecordQuery(persistence: s.widget.historySource!),
    isSignedIn: s.widget.isSignedIn,
    onSignIn: s.widget.onSignIn,
    // REQ-12-09 09-F/09-J — the ticked things, delivered through the SAME two
    // legs everything else on this panel uses (`ManualDelivery.deliverText` and
    // `ImageSendController`). A tear-off, not a closure that re-derives
    // anything: the panel supplies WHAT, the controller owns HOW MANY messages
    // that becomes, and there is exactly one implementation of that rule.
    onSendSelection: s.controller.sendPlusSelection,
    // 09-G — 「这一行的原图字节还在吗」("are this row's original image bytes
    // still there"), answered by the ROW's own door (`pathFor(clientId)`),
    // the same one viewing the full image (点开大图) uses on the timeline
    // (`chat_flow_page` → `rowImageBytes`). Not a second notion of 「有没有图」
    // ("is there an image or not"): if these two could ever disagree, the
    // tick box would offer a send that viewing the full image says has
    // nothing behind it.
    imageSendable: (TimelineEntry e) async =>
        await s.controller.rowImages.pathFor(e.clientId) != null,
  );
}

// ── FB-3 Plan A: the mode row (owner D1/D2, 2026-08-06) ────────────────────
/// One tap = that mode. No cycle, no confirm dialog.
///
/// 🔴 WHAT WAS DELETED HERE, AND WHY IT IS NOT A LOST GUARD.
/// M4 put a 「输入框里有未发送内容，切换模式会将其清空」("there is unsent content
/// in the input box; switching modes will clear it") confirm in front of this
/// tap. D1 removed it — 「直达选择不需要确认；带缓冲切换的保护改为缓冲区提示条」
/// ("a direct choice needs no confirmation; the protection for switching with
/// a buffer moved to a buffer-area hint strip"). The protection did not
/// evaporate, it moved and changed KIND: from an after-the-fact modal to a
/// standing sentence that is on screen BEFORE the destructive tap
/// (`_modeSwitchHint` in compose_buffer_row.dart, rendered whenever the
/// buffer is non-empty). A modal that appears after you already decided is
/// the weaker of the two for a one-tap control.
/// ⚠️ And the utterances behind that buffer were never at risk either way:
/// discarding it settles their rows at 📥 noted (`discardBufferedRowsRouted`),
/// which is the mechanism that makes "no silent failure" (没有静默失败) hold
/// here.
///
/// A mode switch still CLEARS the buffer (08 §2 red line — a stale partial must
/// not bleed across modes); that is enforced in `ChatController.setMode`, not
/// here. While recording the FSM ignores the switch anyway (setMode bails).
void _onModeSelectedRouted(_ChatFlowPageState s, FlowMode next) {
  // The usage count fires only on a REAL switch: a tap on the mode already
  // selected, or any tap mid-recording, moves nothing and must not be counted
  // (the same rule M4's handler stated — a cancelled switch is not a switch).
  if (s.controller.isRecording || s.controller.mode == next) return;
  countUsage(UsageEvent.modeSwitch);
  s.controller.setMode(next);
}

/// 🔴 The pttDown ACCEPTANCE edge — the one place the screen reacts to
/// 「这一次说话真的开始了」("this utterance has really begun").
///
/// T-4 design doc §3 (a real gap found in S5): if the user had scrolled away, the live draft
/// row is off-screen, so one animated return to the bottom — edge-triggered on
/// purpose rather than polled off `visual`/`isRecording` in `build`.
///
/// ⚠️ PA-4 removed the 「force-collapse the expanded face」 duty that used to
/// hang here: the main PTT bar is COVERED while the sheet is open (§4 A6), so
/// no accepted press can arrive with the sheet up — except PA-5's in-sheet
/// append, whose whole point is that the sheet STAYS (dock table A7). A
/// collapse here would fight that gesture.
///
/// ⚠️ Gated on `ok`. A REFUSED press (no mic permission, no link, the FSM
/// busy) starts no recording, so nothing is about to appear at the bottom —
/// reacting to it would move the user's view for an utterance that never
/// happened.
///
/// ⚠️ Deliberately NOT a `visual == recording` observer: a state poll fires
/// again on every unrelated rebuild during the hold, and a "return to bottom"
/// (回到底部) that re-triggers mid-sentence would fight a user who scrolled up
/// ON PURPOSE while speaking. The edge happens exactly once per utterance.
Future<bool> _pttDownRouted(
  _ChatFlowPageState s, {
  bool foldIntoBuffer = false,
}) async {
  final bool ok = await s.controller.pttDown(foldIntoBuffer: foldIntoBuffer);
  if (!ok || !s.mounted) return ok;
  // 🔴 T-4 / design doc §3 (a real gap found in S5): the words are about to grow in the live
  // draft row, and that row is at the BOTTOM of a `reverse: true` list — so if
  // the user had scrolled back through history, the one thing this whole card
  // is about would be off screen while they speak.
  // ⚠️ `offset != 0` is the whole condition, and it is deliberately not
  // 「always scroll」: at the bottom already, `animateTo(0)` would still run an
  // animation, and an animation that changes nothing is a flicker.
  // ⚠️ ONE animated return (`_scrollToBottom`, the same 200 ms easeOut the
  // "return to bottom" (回到底部) button uses) — not a stick-to-bottom lock. A
  // user who scrolls up DURING the utterance is doing it on purpose.
  if (s._scrollCtl.hasClients && s._scrollCtl.offset != 0) s._scrollToBottom();
  return ok;
}

// ── Row 1 · mode segmented control + policy chip (PA-1 / SUP-3) ────────────
/// Contract §5-1 row 1: `[mode segments][translate chip]…[policy chip]`,
/// wrapping allowed.
///
/// ── Why a Wrap and what the two children are ────────────────────────────────
/// `WrapAlignment.spaceBetween` with exactly TWO children gives the mock's
/// layout for free when one run fits (segments hard left, chip hard right) and
/// degrades to the contract's rule when it does not: the chip takes its own
/// run instead of squeezing the segments. ⚠️ On its own run the chip lands
/// LEFT-aligned (a Wrap cannot right-align a lone run child) — a deliberate,
/// named deviation from the EN stress mock's right-aligned wrap, recorded in
/// the return report rather than bought with a custom RenderObject.
///
/// The segments + translate chip travel as ONE wrap child so spaceBetween
/// cannot float the translate chip into the middle of the row — it belongs
/// beside the mode it modifies (GA-01 / D4).
///
/// ⚠️ The [IntrinsicWidth] that used to wrap [ModeSegmentedControl] is GONE
/// (WP8 VF-2). It existed for one reason, stated verbatim here: the control was
/// three `Expanded` segments built for a stretched Row, so inside a Wrap it had
/// no intrinsic size of its own and had to be told to take 3 × its widest
/// segment. The mock's segments are CONTENT-sized (`.sgi` carries no flex), so
/// the control now measures itself and the wrapper became a no-op pass — and a
/// no-op that still names a reason is the kind of comment this repo keeps
/// getting caught by. The [Flexible] STAYS: it is what lets the segments be
/// SQUEEZED (their own ellipsis takes over) when a run is genuinely too narrow
/// — e.g. EN + translate at 320dp — instead of overflowing the row.
Widget _modePolicyRowRouted(
  _ChatFlowPageState s,
  AppStrings strings,
  PttVisual visual,
) {
  final Widget segmentsGroup = Row(
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      Flexible(
        child: ModeSegmentedControl(
          mode: s.controller.mode,
          strings: strings,
          onSelect: (FlowMode m) => _onModeSelectedRouted(s, m),
        ),
      ),
      if (s.controller.mode == FlowMode.translate) ...<Widget>[
        const SizedBox(width: 8),
        TranslateTargetChip(
          target: s.controller.translateTarget,
          strings: strings,
          enabled: !s.controller.isProcessingUtterance,
          onTap: s.controller.setTranslateTarget,
        ),
      ],
    ],
  );
  return Row(
    children: <Widget>[
      Expanded(child: segmentsGroup),
      const SizedBox(width: 8),
      // Never wraps onto a second run — EN Realtime|Translate|Organize +
      // Direct send used to overflow a Wrap at 360dp. The segments ellipsis
      // if they must; the chip stays on the same baseline.
      SendPolicyFlashChip(
        policy: s.controller.sendPolicy,
        strings: strings,
        // A-11: record-only ⇒ the neutral face. Read off the SAME `visual`
        // the band and PttBar get, not off `destination.isRecordOnly` again —
        // 「现在是哪张脸」("which face is it right now") has one author
        // (SUP-4's whole point).
        muted: visual == PttVisual.noted,
        onToggle: s.controller.toggleSendPolicy,
      ),
    ],
  );
}

// ── PA-3: the recording strip (Plan A′ §4 A3, §5-1) ────────────────────────
/// The strip's ONE constructor — the dock renders it while recording, and the
/// edit sheet reuses it for the in-sheet append strip (PA-5), so what feeds
/// the meters has one author. Every value below comes from a REAL source
/// (recording_panel.dart's red line); nothing is synthesised for looks.
Widget _recordingStripRouted(_ChatFlowPageState s, AppStrings strings) =>
    RecordingPanel(
      elapsed: s.controller.recordingElapsed,
      amplitudeWindow: s.controller.amplitudeWindow,
      segmentCount: s.controller.observedSegments,
      // §6.3: capture keeps running through a blip, so the link face degrades
      // rather than disappearing.
      // RV-60: album-away / ladder-climbing drops are degraded, not "down" —
      // same posture as the banner (truthful, not panicked).
      link: () {
        if (s.controller.connection == ConnectionState.connected) {
          return RecordingLink.ok;
        }
        final bool soft = AlbumAway.instance.isOpen ||
            s.controller.connection == ConnectionState.connecting ||
            s.controller.connection == ConnectionState.reconnecting ||
            s.controller.session.reconnect.reconnecting.value;
        return soft ? RecordingLink.degraded : RecordingLink.down;
      }(),
      strings: strings,
    );

// ── PA-2: the PTT caption line (Plan A′ §5-1/§5-2, dock table §4) ──────────
/// The ONE selector for the caption under the PTT bar. Public and pure so the
/// processing/justDone branches — unreachable in a widget test without the
/// async PTT chain (the FakeAsync deadlock this repo keeps re-documenting) —
/// are still testable directly, against the same author the composer renders.
///
/// MD-4: every branch promises the DELIVERY half only. MD-1: no branch invents
/// a receipt claim — justDone keeps its existing face wording on the bar
/// itself and carries NO caption here.
String pttCaption({
  required PttVisual visual,
  required SendPolicy nextPolicy,
  required SendPolicy activePolicy,
  required bool recordOnly,
  required String pcName,
  required AppStrings strings,
}) {
  return switch (visual) {
    // A1/A2 — the caption reads the NEXT utterance's policy (the chip's
    // state), because that is what the promise is about.
    PttVisual.idle => nextPolicy == SendPolicy.manual
        ? strings.pttSubManual
        : strings.pttSubDirect,
    PttVisual.noted => strings.pttSubNoted,
    // A4 — the caption reads the IN-FLIGHT utterance's snapshot
    // (`activeSendPolicy`), not the chip: flipping ➤/⚡ mid-sentence must not
    // change what is promised about the sentence already being finalized
    // (§4.0 B fixed once per utterance). A record-only utterance gets the
    // no-promise variant — 「投递到 X」("delivered to X") would be false there.
    PttVisual.processing =>
      activePolicy == SendPolicy.direct && !recordOnly
          ? strings.pttSubProcessingDirect(pcName)
          : strings.pttSubProcessingManual,
    PttVisual.disabled => strings.pttSubDisabled,
    // A3/A5 — recording carries the strip, justDone carries its flash face;
    // neither has a caption (mock ③⑤; empty per state is contract §5-1).
    PttVisual.recording || PttVisual.justDone => '',
  };
}

/// The peer's display name for the processing caption — the SAME three-way
/// expression `ChatHeader.build` resolves (cloud → cloud light record (云端轻记录); alias override;
/// ack name; 'FlowMic' fallback).
///
/// ⚠️ A SECOND COPY of that expression, left deliberately and flagged in the
/// WP7 return report: chat_header.dart is outside this package's touch scope
/// (another lane holds it), so the expression could not be extracted to one
/// author this round. If the header's name rule changes, this must follow.
String _peerNameRouted(_ChatFlowPageState s, AppStrings strings) {
  if (s.widget.isCloudInstance) return strings.cloudInstance;
  final String? override = s.widget.deviceNameOverride;
  if (override != null && override.isNotEmpty) return override;
  final String ack = s.controller.session.connectedDeviceName.value;
  return ack.isNotEmpty ? ack : 'FlowMic';
}

// ── the dock's five pieces, each built once ─────────────────────────────────
// VF-8 gave the dock two ARRANGEMENTS (phone column / tablet two-column), and
// the pieces inside them are identical. They are lifted out rather than written
// into both branches for the obvious reason: a `ComposeBand` configured twice,
// or a `PttBar` wired twice, is two places for the next change to land in one
// of. Each helper below is the ONE construction of its piece.

/// Row 2 — `[+][preview]`, plus (on the phone) the PC key group under it.
/// [part] is what the tablet uses to take the two rows into two columns.
Widget _dockBandRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  PttVisual visual,
  ComposeBandPart part,
) => ComposeBand(
  part: part,
  buffer: s.controller.buffer,
  strings: strings,
  // 🔴 The SAME `visual` the composer computed and hands to PttBar — the
  // answer to 「现在是哪张脸」("which face is it right now") must have ONE
  // author. Passing it down rather than
  // letting the band read `sessionState` itself is the whole point.
  visual: visual,
  // While an AI run streams INTO the buffer, the box is not the user's to type
  // in. ONE shared expression with the edit surface's field
  // (`_composeFieldEnabled`) — the W2.5-1 mine.
  //
  // 🔴 T-2: it also decides the preview strip's S8 face. Same expression on
  // purpose — 「能不能编辑」("can it be edited") and 「这一格接不接点击」("does
  // this cell accept taps") must not be able to disagree,
  // or the strip would invite a tap into a field that refuses the keystroke.
  enabled: _composeFieldEnabled(s),
  // 🔴 T-3 → PA-4: tapping the preview strip (点预览条) ⇒ opens the edit sheet
  // + focuses it, in one step. The page owns the sheet; the
  // band only reports the tap.
  onExpand: () => _openSheetFromPreviewRouted(s),
  onControlKey: s.controller.sendControlKey,
  leading: part == ComposeBandPart.keyColumn
      ? const <Widget>[]
      : <Widget>[
          // §6.2 ⑤ input row [+]. 「＋」("+") answers 「往缓冲里添东西」("add
          // something into the buffer"), the key group answers 「动 PC 焦点」
          // ("act on the PC's focus") — one end, one question, must not be
          // mixed into a single row — which is why it stays in row 2 and did
          // not join the key group's container. On the tablet that separation becomes
          // literal: it rides the speak column and the keys become their own.
          _plusButtonRouted(s, context, strings),
          const SizedBox(width: 8),
        ],
);

/// The speak key itself.
Widget _dockPttRouted(_ChatFlowPageState s, AppStrings strings, PttVisual visual) =>
    PttBar(
      // 🔴 PA-3 (measured, mic_permission_denial_widget_test caught it): the
      // strip/caption conditionals CHANGE this Column's child positions
      // mid-recording, and Flutter's keyless middle-region sync then REBUILDS
      // the PttBar element — killing the in-flight hold's state (_active) so
      // release/cancel never fired and the FSM stayed red.
      // 🔴 WP8-P0 (device-measured): the key is a page-held GLOBAL key, not a
      // ValueKey, because VF-8 adds a second, harsher shape of the same bug —
      // a REPARENT. The tablet branch is idle-only, which means the
      // arrangement flips tablet→phone AT THE START of every hold (the
      // previous note here argued idle-only made a mid-hold flip impossible;
      // the premise refuted itself). A ValueKey pins identity only under the
      // same parent; the GlobalKey carries element, state and the live
      // gesture across the reparent in both directions.
      // Pinned by tablet_hold_reparent_test.dart.
      key: s._pttBarKey,
      visual: visual,
      strings: strings,
      // 🔴 T-3/T-4: the pttDown ACCEPTANCE edge carries two more duties now —
      // see [_pttDownRouted]. Still the same one call into the controller.
      onDown: () => _pttDownRouted(s),
      onUp: s.controller.pttUp,
      onCancel: s.controller.pttCancel,
    );

/// PA-2: the one-line caption under the bar — a SIBLING of PttBar
/// (implementer's choice the contract allows) so the bar's own face, pulse and
/// a11y toggle stay byte-untouched. Same `visual`, one selector ([pttCaption]).
///
/// ⚠️ This used to return null on the captionless faces (A3/A5) and both
/// arrangements dropped the row entirely. That was true to the mock and WRONG
/// under a finger (owner, device, 2026-08-14): the dock is bottom-anchored, so
/// removing the row moved the PTT bar DOWN by the caption's height at the exact
/// moment the user pressed it — the button slid out from under a finger that
/// had not moved. 「按下时需要保持界面的稳定」("the interface needs to stay
/// stable at the moment of press"). So the captionless faces now
/// return an INVISIBLE GHOST of the caption the dock showed just before the
/// press (the idle-family string for the same policy/destination — the chip is
/// off the tree mid-hold, so those inputs cannot change under it), rendered
/// with the byte-identical style via [_captionText] so its laid-out height —
/// including a second line at large text scale — matches the visible one
/// exactly. `Visibility(maintainSize)` keeps geometry and drops paint,
/// semantics and hit-testing: nothing is announced, nothing reads, nothing
/// moves. The mock's 「A3/A5 面无 caption」("faces A3/A5 have no caption")
/// stays true on screen; only the GEOMETRY of the empty slot is now reserved.
///
/// 🔴 VF-8: the caption STAYS on the tablet even though A-TAB's frame elides it.
/// It is not decoration — it is the state copy the mechanics contract owns
/// (「松开即投递到电脑光标」("release delivers straight to the computer's
/// cursor") vs 「松开后只保存在手机」("release only saves on the phone")), and
/// a layout that drops it on a wider screen would be answering
/// 「这一次松手会发生什么」("what happens when you release this time") only on
/// phones.
Widget? _dockCaptionRouted(
  _ChatFlowPageState s,
  AppStrings strings,
  PttVisual visual,
) {
  final SendPolicy nextPolicy = s.controller.sendPolicy;
  final SendPolicy activePolicy = s.controller.activeSendPolicy;
  final bool recordOnly = s.controller.destination.isRecordOnly;
  final String pcName = _peerNameRouted(s, strings);
  final String caption = pttCaption(
    visual: visual,
    nextPolicy: nextPolicy,
    activePolicy: activePolicy,
    recordOnly: recordOnly,
    pcName: pcName,
    strings: strings,
  );
  if (caption.isEmpty) {
    // The ghost: what this dock's caption row read the frame before the hold
    // was accepted (idle, or noted when the destination is record-only).
    final String ghost = pttCaption(
      visual: recordOnly ? PttVisual.noted : PttVisual.idle,
      nextPolicy: nextPolicy,
      activePolicy: activePolicy,
      recordOnly: recordOnly,
      pcName: pcName,
      strings: strings,
    );
    if (ghost.isEmpty) return null;
    return Visibility(
      visible: false,
      maintainSize: true,
      maintainAnimation: true,
      maintainState: true,
      child: _captionText(ghost, key: const ValueKey<String>('ptt.caption.ghost')),
    );
  }
  return _captionText(caption, key: const ValueKey<String>('ptt.caption'));
}

/// ONE author for the caption's Text so the ghost above cannot drift in style
/// (a ghost one font-size off would reserve the wrong height and re-open the
/// press-shift it exists to close).
Widget _captionText(String caption, {required Key key}) => Text(
  caption,
  key: key,
  textAlign: TextAlign.center,
  // Two lines at large text scale rather than a clip: a caption the OS was
  // asked to enlarge is a caption someone wants to read (ptt_bar.dart's own
  // text-scale reasoning, applied here).
  maxLines: 2,
  overflow: TextOverflow.ellipsis,
  style: TextStyle(color: FlowMicDockColors.sub, fontSize: 10.5),
);

/// V2-03: lift the press point off the physical bottom edge. SafeArea above
/// already clears the gesture inset, but on a phone with none (or a small one)
/// the bar still ends flush with the glass, which is the grip the 30 s+ hold is
/// worst at. A floor of 10 keeps a real gap there while adding nothing on top
/// of a device that already has an inset — the goal is 「不贴边」("not flush
/// against the edge"), not 「更多留白」("more empty space").
double _dockBottomLiftRouted(BuildContext context) =>
    MediaQuery.of(context).viewPadding.bottom > 0 ? 4 : 10;

// ── composer ─────────────────────────────────────────────────────────────
Widget _composerRouted(
  _ChatFlowPageState s,
  BuildContext context,
  bool connected,
  AppStrings strings,
) {
  // R6 T-5d: the four FSM faces win over the link face. A sub-30 s blip does
  // NOT stop the capture (§6.3 — chunks keep buffering), so flipping the bar
  // to 「等待网络恢复」("waiting for the network to recover") mid-utterance
  // would be a lie; the panel's 📡 row is what
  // reports the degraded link.
  final PttVisual visual = switch (s.controller.sessionState) {
    SessionState.recording => PttVisual.recording,
    SessionState.processing => PttVisual.processing,
    SessionState.justDone => PttVisual.justDone,
    SessionState.idle || SessionState.disconnected => !connected
        ? PttVisual.disabled
        : s.controller.destination.isRecordOnly
        ? PttVisual.noted
        : PttVisual.idle,
  };

  // 🔴 PA-1 / SUP-4: ONE predicate decides whether the idle rows (row 1, row 2,
  // the PC key group) are on the tree at all — [composeIdleRowsVisible],
  // shared with ComposeBand so row 1 here and the band's own rows cannot
  // disagree. Outside the three idle faces the dock is PTT-only (A3–A5).
  // While the edit sheet is open the whole dock is COVERED (scrim + sheet,
  // §4 A6) — it keeps rendering here untouched.
  final bool idleRows = composeIdleRowsVisible(visual);

  // `.dock{border-top:1px solid var(--line);background:var(--panel);
  //        padding:10px 12px 14px;display:flex;flex-direction:column;gap:9px}`
  // ⚠️ The fill and the border move to the DOCK palette, not the legacy one:
  // the timeline above this border must render byte-identically after WP8
  // (contract §0 D7 / §3), and it reads `FlowMicColors`.
  //
  // 🔴 VF-8: a LayoutBuilder on the DOCK's own width, deliberately not
  // `MediaQuery.sizeOf(context).width`. The question the breakpoint answers is
  // 「is there room for a 430dp speak column and a 92dp key column side by
  // side」, and on a tablet running two apps split-screen the screen width says
  // yes while this dock's real width says no. Reading the constraint we are
  // actually given is the only way to be right in both.
  return LayoutBuilder(
    builder: (BuildContext ctx, BoxConstraints constraints) {
      // ⚠️ IDLE ONLY. Recording / processing / justDone keep the phone
      // rendering on every width: A3's 「一次只做一件主事」("do only one main
      // thing at a time") puts the whole band
      // off the tree and gives the strip + bar the full dock, and the mock
      // draws no tablet frame for any of them. Re-columning a dock whose right
      // column would be empty is an arrangement nobody specified.
      final bool twoColumn =
          idleRows &&
          composePcKeysVisible(visual) &&
          constraints.maxWidth >= kDockTabletMinWidth;
      return Container(
        // Identity for tests. The dock's TOP EDGE is a real acceptance surface
        // — the policy flash has to land above it (mock A-02 draws that pill in
        // the timeline), and 「above it」 can only be measured against a box
        // somebody can find. Locating it by its decoration instead would make
        // the assertion depend on the very colours it is not about.
        key: const ValueKey<String>('compose.dock'),
        // A-TAB overrides `.dock`'s padding inline: `12px 20px 16px`.
        padding: twoColumn
            ? const EdgeInsets.fromLTRB(20, 12, 20, 16)
            : const EdgeInsets.fromLTRB(12, kDockPaddingTop, 12, 14),
        decoration: BoxDecoration(
          color: FlowMicDockColors.panel,
          border: Border(top: BorderSide(color: FlowMicDockColors.line)),
        ),
        child: twoColumn
            ? _dockTabletRouted(s, ctx, strings, visual)
            : _dockPhoneRouted(s, ctx, strings, visual, idleRows: idleRows),
      );
    },
  );
}

/// A-TAB: `flex-direction:row;gap:12` — the speak column limited to 430 and
/// centred in what is left, the PC keys as a 92dp right column.
///
/// ⚠️ The frame's `align-items:stretch` is the one A-TAB value NOT taken
/// literally; the Row below says why, in full.
Widget _dockTabletRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  PttVisual visual,
) {
  final Widget? caption = _dockCaptionRouted(s, strings, visual);
  return Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      // 🔴 `CrossAxisAlignment.start`, NOT `stretch` — MEASURED, see
      // `_pcKeyColumn`'s note in compose_band.dart for the full account.
      // A-TAB's `align-items:stretch` needs a bounded height, this Row has
      // none, and the `IntrinsicHeight` that supplied one made the Row's height
      // a PREDICTION of the speak column rather than a measurement of it —
      // 2.0dp short in en at 800×900, and a `RenderFlex overflowed` with it.
      // ⇒ Both columns size to their own content and hang from the top, which
      //   is what the mock's stretched frame renders anyway: its speak column
      //   is a `gap:9` flex column, so its CONTENT sits at the top of the taller
      //   row either way, and the key column is the taller of the two.
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
              // `margin:0 auto` on a flex:1 column = 「grow, but stop at 430 and
              // sit in the middle of the rest」. The ceiling is what puts the
              // speak key between the thumbs on a 10-inch screen instead of
              // stretching it across one (A-TAB's caption states exactly that).
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxWidth: kDockTabletSpeakMaxWidth,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _modePolicyRowRouted(s, strings, visual),
                      const SizedBox(height: kDockRowGap),
                      _dockBandRouted(
                        s,
                        context,
                        strings,
                        visual,
                        ComposeBandPart.bufferRow,
                      ),
                      const SizedBox(height: kDockRowGap),
                      _dockPttRouted(s, strings, visual),
                      if (caption != null) ...<Widget>[
                        const SizedBox(height: kDockRowGap - 3),
                        caption,
                      ],
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: kDockTabletColumnGap),
            SizedBox(
              // `width:92px;flex:none`.
              width: kDockTabletKeyColumnWidth,
              child: _dockBandRouted(
                s,
                context,
                strings,
                visual,
                ComposeBandPart.keyColumn,
              ),
          ),
        ],
      ),
      // Outside the Row so BOTH columns clear the bottom edge by the same
      // amount — inside the speak column it would only lift the speak key and
      // leave the keys flush.
      SizedBox(height: _dockBottomLiftRouted(context)),
    ],
  );
}

/// A-01…A-11: one column, every dock row full width.
Widget _dockPhoneRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  PttVisual visual, {
  required bool idleRows,
}) {
  final Widget? caption = _dockCaptionRouted(s, strings, visual);
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      // ── Row 1 · mode row + policy chip (PA-1 / SUP-3) ──────────────────
      // The three segments sit side by side, all visible, one tap reaches
      // any of them; the translate-target chip still only sprouts in place
      // when in translate mode (GA-01 / D4). The policy chip moved here from row 2 (SUP-3) and
      // is now the ONLY strategy toggle (SUP-2 killed the send button and
      // its hidden long-press). Contract §5-1: a Wrap, so an EN/JA chip
      // never squeezes the segments — when the run is too narrow the chip
      // drops to its own line instead of starving the mode words.
      if (idleRows) ...<Widget>[
          // 🔴 WP8 VF-2 DELETED THE A8 DIM ON THIS ROW, AGAINST THE MOCK, AND
          // THE REASON IS HONESTY RATHER THAN TASTE.
          // A-10 draws `<div class="seg" style="opacity:.5">` and
          // `<span class="strat" style="opacity:.5">`, and WP7 implemented it.
          // But neither control is inert while the link is down: a mode tap
          // still reaches `ChatController.setMode` and a chip tap still
          // reaches `toggleSendPolicy` — both take effect, and BOTH SHOULD,
          // because what they set is what the NEXT utterance will use once the
          // link is back. Painting a live control as disabled is the
          // fabricated-state lie R11 forbids, read in the other direction, and
          // it is worse than a cosmetic miss: it tells the user to stop trying.
          // Filed as a mock delta in the VF-2 return report.
          // ⚠️ The KEY GROUP keeps its dim (compose_band.dart) — that one is
          // about a destination that really is unreachable, and it is paired
          // with a sentence that says so.
        _modePolicyRowRouted(s, strings, visual),
        const SizedBox(height: kDockRowGap),
      ],
      // ── Row 2 + PC key group ─────────────────────────────────────────
      // PA-1: the band renders `[+][preview]` and the PC key group, and
      // yields entirely (zero height) outside the idle faces — the same
      // [composeIdleRowsVisible] predicate row 1 reads above.
      _dockBandRouted(s, context, strings, visual, ComposeBandPart.stacked),
      const SizedBox(height: kDockRowGap),
      // PA-3 / §4 A3: while recording the idle rows are gone (the band above
      // is zero-height) and the strip takes the slot right above the PTT.
      if (visual == PttVisual.recording) ...<Widget>[
        _recordingStripRouted(s, strings),
        const SizedBox(height: kDockRowGap),
      ],
      _dockPttRouted(s, strings, visual),
      if (caption != null) ...<Widget>[
        // `.psub{font-size:10.5px;color:var(--sub);text-align:center;
        //        margin-top:-3px}` — the caption is the one dock child that
        // does NOT take the uniform 9dp gap: the mock pulls it 3 back up so
        // it reads as part of the bar rather than as the next row.
        const SizedBox(height: kDockRowGap - 3),
        caption,
      ],
      SizedBox(height: _dockBottomLiftRouted(context)),
    ],
  );
}

// Part of chat_flow_page.dart — PA-4: the ONE edit surface (Plan A′ §5-1,
// SUP-5/SUP-6/SUP-7, dock table §4 A6). The floating FB-8 card
// (chat_flow_edit_card.dart) and the T-3 expanded compose face
// (chat_flow_expanded_compose.dart) MERGED into this bottom sheet; both old
// part files are deleted, their surviving semantics re-pinned in
// edit_sheet_test.dart / fb8_confirm_card_test.dart.
//
// SPEC-REF:
//   docs/ui-design/2026-08-13-plan-a-dock-and-edit-sheet-contract.md
//     §2 SUP-5 (one explicit `sheetOpen` UI state — the visibility author;
//     `composeEditHold` is retired), SUP-6 (`+`/policy chip live one collapse
//     away, NOT in the sheet), SUP-7 (AI pills for any non-empty draft,
//     regardless of policy), §5-1 (sheet chrome), §5-2 (header variants)
//   docs/ui-design/2026-08-06-fb8-manual-send-edit-flow.md §3 — every FB-8
//     semantic survives verbatim: deliver = sendBuffer (one frame), discard =
//     local discardBuffer, D4 no auto-keyboard, field inert mid-AI-run
//
// ── The visibility model (SUP-5) ─────────────────────────────────────────────
// `_sheetOpen` is a page-State bool — NOT focus-derived (the ai-pills §1
// rationale stands: a focus-derived state collides with D4 and with append),
// and NOT derived from policy × buffer (the old `composeEditHold`, retired
// with this card — a collapsed sheet over a manual non-empty draft is now a
// legal, load-bearing state: contract §4 A2, where SUP-1's key access lives).
//   open:  (a) a manual voice finalize auto-opens WITHOUT focus (D4);
//          (b) tapping the preview strip opens WITH focus in the same step;
//          (c) re-tapping the preview after a collapse — same as (b).
//   close: collapse control / scrim tap / system back (before the page's back
//          sequence) / deliver / discard / mode switch. Collapse NEVER touches
//          the buffer; the draft shows in the preview strip and reopens on tap.
//
// ── How (a) is detected ──────────────────────────────────────────────────────
// A controller listener, not a hook inside the finalize path: typing, AI
// streaming and restore-original all mutate the buffer ONLY while the sheet is
// already open (the field lives here), so 「the buffer changed while the sheet
// was closed, under manual, to non-empty」 is exactly 「a voice finalize folded
// in」 — no second channel from the utterance layer needed, and the trigger
// stays honest if a new writer appears (the sheet opens, which is the designed
// response to "a manual draft appeared" in general).
//
// 🔴 The card's old header-✕ is GONE and nothing replaced it: the collapse
// control is a chevron / "collapse" (收起) and the ONLY discard is the
// footer button — a ✕ beside an editable draft is the named mis-touch risk
// SUP-1 exists for, and this app already has two ✕ with opposite consequences.

part of 'chat_flow_page.dart';

/// The sheet's ceiling: it may grow to the page top minus this inset
/// (contract §5-1 「top offset ≥96dp from the page top」). Content-driven below
/// that — a one-line draft renders a short sheet.
const double _kSheetTopInset = 96;

/// Mock `.sheet{…gap:11px}` (WP8 VF-4) — the ONE vertical rhythm inside the
/// sheet. Named rather than repeated as a literal so the `SizedBox`es below
/// cannot drift apart the way the 8/8/8/10/10/10/10 mixture it replaces already
/// had (a CSS `gap` is one declaration; a Column's gaps are one per seam, and
/// that asymmetry is exactly how the old mixture happened).
const double _kSheetGap = 11;

/// The deliver button's trailing glyph (`投递 ➤` — "Deliver ➤", mock `.pbtn`).
/// A LAYOUT character concatenated by the widget, deliberately NOT part of
/// [AppStrings.composeCardDeliver] — the copy is frozen and four-locale, and a
/// glyph that belongs to one button's face has no business in a string table.
const String _kDeliverGlyph = '➤';

/// The ONE enabled-expression for the compose FIELD (W2.5-1's mine): while an
/// AI run streams into the buffer the box is not the user's to type in. Also
/// feeds the idle dock's preview strip via the composer, so "can it be
/// edited" and "does this cell accept taps" cannot disagree.
///
/// P4 (0.3.1): the leg split is ALIGNED with [ChatController.canSend], so the
/// field and the footer button can never answer 「能不能提交」 ("can this be
/// committed") differently — the measured defect was exactly that split: the
/// field typed on (`canCompose` only) while the button read a `!isFixed` term
/// and stayed dead forever, with nothing on screen saying why.
///   · fixed destination ([ChatController.noPcTarget]): typing and committing
///     are both LOCAL (a noted row), so neither carries a link term;
///   · paired PC: both carry [ChatController.canCompose] — unchanged.
/// The one remaining difference is deliberate and answers a DIFFERENT
/// question: the button also needs a non-empty draft; an empty field must
/// stay editable, because that is how a draft starts.
bool _composeFieldEnabled(_ChatFlowPageState s) =>
    (s.controller.noPcTarget || s.controller.canCompose) &&
    !s.controller.isAiComposing;

/// Adopt an EXTERNAL buffer move into the page-owned edit controller — at
/// CONTROLLER-NOTIFICATION time (an event handler), never during build: the
/// sheet's field listens to this controller, and a write mid-build is a
/// markNeedsBuild-during-build crash on an element the writer is no ancestor
/// of (measured — the first cut of ruling #4 took 16 tests down that way).
/// When the user is typing, ChatController echoes the same string straight
/// back, so the comparison keeps the caret still.
void _syncComposeTextRouted(_ChatFlowPageState s) {
  final String buffer = s.controller.buffer;
  if (s._composeText.text == buffer) return;
  s._composeText.value = TextEditingValue(
    text: buffer,
    selection: TextSelection.collapsed(offset: buffer.length),
  );
}

/// SUP-5 open/close triggers that arrive as controller notifications:
/// (a) manual voice finalize ⇒ auto-open, no focus (D4);
/// mode switch ⇒ close (the red line already cleared the buffer; a sheet
/// left open over a foreign mode would be editing nothing).
void _syncSheetOnControllerRouted(_ChatFlowPageState s) {
  final String buffer = s.controller.buffer;
  final FlowMode mode = s.controller.mode;
  final bool modeChanged = s._lastModeSeen != null && mode != s._lastModeSeen;
  // 「是不是有一句话正在进行中」 — ONE author, both consumers below. SEG-2 needed
  // the predicate PA-5 already spelled out inline; two copies become two answers.
  final bool utteranceInFlight =
      s.controller.sessionState == SessionState.recording ||
      s.controller.sessionState == SessionState.processing;
  // PA-5: the append face ends when the utterance does — the fold (release)
  // or the discard (swipe-up cancel) has settled once the FSM is out of
  // recording/processing. A LISTENER edge, not a callback from the gesture:
  // the finalize arrives async and the button's up-handler cannot know when.
  if (s._sheetAppending && !utteranceInFlight) s._setSheetAppending(false);
  // 🔴 SEG-2 (owner, 2026-08-15) — 「说话的按钮也没了」. Trigger (a) says 「manual
  // voice FINALIZE ⇒ auto-open」 and never asked whether the finger is still
  // DOWN — correct while a manual utterance grew the buffer once, at release;
  // wrong once the server began settling SOFT SEGMENTS, which fold in MID-HOLD,
  // sliding the sheet over the dock (it COVERS the PTT bar by design). ⇒ anti-
  // façade ④. Account + reverse controls: edit_sheet_not_during_hold_test.dart.
  if (s._sheetOpen && modeChanged) {
    _collapseSheetRouted(s);
    s._sheetSrcVoice = false;
  } else if (!s._sheetOpen &&
      !utteranceInFlight &&
      s.controller.sendPolicy == SendPolicy.manual &&
      buffer.trim().isNotEmpty &&
      buffer != s._lastBufferSeen) {
    // Trigger (a). 🔴 NO focus request anywhere on this path — D4: a surface
    // that appears by itself must not raise the keyboard; only the explicit
    // preview tap focuses.
    s._sheetSrcVoice = true;
    s._setSheetOpen(true);
  }
  // 🔴 SEG-2 — the watermark advances only once the change has been JUDGED.
  // Unconditional (as it was) makes the guard above a WORSE bug: the mid-hold
  // fold records as "seen", so at settle the sheet never opens at all — the
  // manual flow's whole point, deleted, with every "no sheet during a hold"
  // test still green. Freezing it is what makes this a DEFERRAL, not a drop.
  if (!utteranceInFlight) s._lastBufferSeen = buffer;
  s._lastModeSeen = mode;
  _syncSheetAiAppliedRouted(s);
}

/// The applied-✓ mark used to live on `_SheetAiRowState`. Collapsing the
/// sheet unmounted that State, so reopening showed plain pills over a draft
/// that was still an AI product. The restore strip survived (controller-
/// derived); the ✓ did not. The listener is the SAME controller listener
/// the sheet already uses, so the mark survives collapse.
void _syncSheetAiAppliedRouted(_ChatFlowPageState s) {
  final ChatController c = s.controller;
  final ComposeTask? running = c.aiTask;
  if (running != null) {
    s._sheetAiPending = running;
    if (s._sheetApplied != null) s._sheetApplied = null;
    return;
  }
  final ComposeTask? finished = s._sheetAiPending;
  if (finished != null) {
    s._sheetAiPending = null;
    if (c.aiFailure == null) {
      s._sheetApplied = finished;
      s._sheetAppliedText = c.buffer;
      return;
    }
  }
  if (s._sheetApplied != null &&
      (c.buffer != s._sheetAppliedText || c.restorableOriginal == null)) {
    s._sheetApplied = null;
  }
}

/// Trigger (b)/(c): the preview strip's tap — open AND focus, one step
/// (owner Q3㋐, carried over from T-3 verbatim).
///
/// ⚠️ The focus request is deferred to the post-frame callback because the
/// [FocusNode] is attached by the field's own build — asking a detached node
/// to take focus is a no-op, and that no-op is exactly "expanded, but the
/// keyboard never came up" (展开了但键盘没上来).
void _openSheetFromPreviewRouted(_ChatFlowPageState s) {
  // A tapped-open EMPTY sheet is a typed draft starting (mock ⑫); a tapped-
  // open non-empty one keeps whatever origin the draft already has.
  if (s.controller.buffer.trim().isEmpty) s._sheetSrcVoice = false;
  s._setSheetOpen(true);
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!s.mounted || !s._sheetOpen) return;
    s._composeFocus.requestFocus();
  });
}

/// Collapse. The buffer does not change by one character — every close
/// gesture lands here and none touches
/// [ChatController.buffer]; that is the whole reason the control is a chevron
/// and never a third ✕. The focus drops with the sheet: a hidden focused
/// field would keep the system keyboard up over nothing.
void _collapseSheetRouted(_ChatFlowPageState s) {
  if (!s._sheetOpen) return;
  s._composeFocus.unfocus();
  s._setSheetOpen(false);
}

/// The overlay, as TWO children of the page-level Stack (the caller spreads
/// them): the scrim and the sheet. The dock and PTT bar keep rendering
/// UNDERNEATH — covered, not unmounted — so 「the sheet covers the dock and
/// PTT」 (§4 A6) is a measurable geometric fact, and the scrim above them is
/// what makes them unreachable.
List<Widget> _editSheetOverlayRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) => <Widget>[
  Positioned.fill(
    child: GestureDetector(
      key: const ValueKey<String>('compose.sheet.scrim'),
      behavior: HitTestBehavior.opaque,
      onTap: () => _collapseSheetRouted(s),
      child: ColoredBox(color: FlowMicColors.scrim),
    ),
  ),
  Positioned(
    left: 0,
    right: 0,
    top: _kSheetTopInset,
    bottom: 0,
    child: Column(
      mainAxisAlignment: MainAxisAlignment.end,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[Flexible(child: _sheetBody(s, context, strings))],
    ),
  ),
];

Widget _sheetBody(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) {
  // A7: the in-sheet append face. The field's only writer is PA-5's append
  // button — under PA-4 alone it never goes true.
  final bool appending = s._sheetAppending;
  final bool hasDraft = s.controller.buffer.trim().isNotEmpty;
  return Container(
    key: const ValueKey<String>('compose.card'),
    // Mock `.sheet{…border-radius:22px 22px 0 0;padding:10px 16px 14px}` — the
    // geometry was already the mock's; WP8 VF-4 moves the COLOURS onto the
    // dock/sheet palette (contract §1) and the lift onto its own token.
    padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
    decoration: BoxDecoration(
      color: FlowMicDockColors.panel,
      // `border:1px solid var(--line);border-bottom:none` — the bottom edge is
      // off-screen, and a line there would draw a seam across the gesture bar.
      border: Border(
        top: BorderSide(color: FlowMicDockColors.line),
        left: BorderSide(color: FlowMicDockColors.line),
        right: BorderSide(color: FlowMicDockColors.line),
      ),
      borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      // 🔴 The hand-flipped `floatShadow` is GONE. It was this file inventing an
      // upward lift out of a downward token (`Offset(0, -b.offset.dy)` per
      // pass); [FlowMicDockColors.sheetShadow] IS the mock's
      // `0 -10px 30px rgba(28,27,50,.14)` / dark `rgba(0,0,0,.5)`, so the
      // geometry is no longer local knowledge that a palette change can miss.
      boxShadow: FlowMicDockColors.sheetShadow,
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Center(
          child: Container(
            key: const ValueKey<String>('compose.sheet.handle'),
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: FlowMicDockColors.line,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ),
        // Every vertical gap in this Column is [_kSheetGap] — no exceptions.
        const SizedBox(height: _kSheetGap),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Text(
                // §5-2 header variants: appending > voice > typed. The voice
                // header reuses the existing composeCardHeader verbatim.
                appending
                    ? strings.composeSheetHeaderAppending
                    : s._sheetSrcVoice
                        ? strings.composeCardHeader
                        : strings.composeSheetHeaderTyped,
                key: const ValueKey<String>('compose.card.header'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                // Mock `.shh{font-size:12px;font-weight:600;color:var(--sub)}`.
                style: TextStyle(
                  color: FlowMicDockColors.sub,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  height: 1.35,
                ),
              ),
            ),
            // No collapse control while appending (mock ⑦): the hold gesture
            // owns the sheet for that window, and a collapse under a live
            // recording would orphan it.
            if (!appending) ...<Widget>[
              const SizedBox(width: 8),
              _sheetCollapseControl(s, strings),
            ],
          ],
        ),
        if (!appending && s.controller.restorableOriginal != null) ...<Widget>[
          const SizedBox(height: _kSheetGap),
          _sheetRestoreStrip(s, strings),
        ],
        const SizedBox(height: _kSheetGap),
        // The body: the ONE editable field (same key, same page-owned
        // controller as ever) — or, while an in-sheet append is live (PA-5),
        // the read-only draft+live view: a TextField cannot render the live
        // words as a distinguishable highlight, and mid-append the draft is
        // not the user's to type in anyway (their hands are on the button).
        Flexible(
          child: appending
              ? _sheetAppendLiveView(s)
              : ComposeBufferField(
                  controller: s._composeText,
                  // One home now, so the node rides along always; focus still
                  // arrives ONLY through the preview tap's explicit request —
                  // the field itself has no autofocus (D4).
                  focusNode: s._composeFocus,
                  strings: strings,
                  enabled: _composeFieldEnabled(s),
                  buffer: s.controller.buffer,
                  onChanged: s.controller.setBuffer,
                  // No line ceiling — the sheet's Flexible is the ceiling
                  // (T-5's rule, inherited).
                  maxLines: null,
                ),
        ),
        // SUP-7: pills for ANY non-empty draft, regardless of policy — a
        // typed draft under direct policy is a stable buffer by construction.
        // No dead greyed pills on an empty sheet (ai-pills §3 ban stands).
        if (hasDraft) ...<Widget>[
          const SizedBox(height: _kSheetGap),
          // Mock A-07: `<div class="aic" style="opacity:.4">` and the caption
          // span is DROPPED from that row — both halves of "temporarily
          // demoted" (暂时降权) (the frame's own caption). The pointer half is
          // not in the mock's CSS
          // because a static board cannot show it; it is the half that makes
          // the dimming true rather than decorative.
          Opacity(
            opacity: appending ? 0.4 : 1,
            child: IgnorePointer(
              ignoring: appending,
              child: _sheetAiRow(s, context, strings, appending: appending),
            ),
          ),
        ],
        // PA-5: the in-sheet strip (recording only — the SAME constructor the
        // dock uses, so the meters share one feed) and the append button.
        if (appending && s.controller.isRecording) ...<Widget>[
          const SizedBox(height: _kSheetGap),
          _recordingStripRouted(s, strings),
        ],
        const SizedBox(height: _kSheetGap),
        SheetAppendButton(
          // Same element-identity pin as the composer's PttBar: the sheet's
          // children shift while appending (collapse control leaves, the strip
          // arrives), and a keyless rebuild here would drop the hold's own
          // gesture state mid-press.
          key: const ValueKey<String>('compose.sheet.appendBtn'),
          appending: appending,
          strings: strings,
          // 🔴 The SAME acceptance edge as the main PTT bar — no second
          // recording entry point. `foldIntoBuffer` pins the utterance's
          // policy snapshot to manual so release folds into THIS draft. The
          // A7 mark rides the SAME closure so the whole accepted-edge is one
          // production callback (and the tests drive exactly this).
          onDown: () async {
            final bool ok = await _pttDownRouted(s, foldIntoBuffer: true);
            if (ok && s.mounted) s._setSheetAppending(true);
            return ok;
          },
          onUp: s.controller.pttUp,
          onCancel: s.controller.pttCancel,
          onHoldPointerDown: (double inset) {
            if (!s._composeFocus.hasFocus) return;
            s._lockAppendGeometry(inset);
            s._composeFocus.unfocus();
          },
          onHoldPointerSettled: s._unlockAppendGeometry,
        ),
        const SizedBox(height: _kSheetGap),
        // A-07 dims the footer with the pills (`<div class="ftr"
        // style="opacity:.4">`) — same pair, same reason.
        Opacity(
          opacity: appending ? 0.4 : 1,
          child: IgnorePointer(
            ignoring: appending,
            child: Row(
              children: <Widget>[
                Expanded(
                  child: _sheetFooterButton(
                    key: const ValueKey<String>('compose.card.discard'),
                    label: strings.composeCardDiscard,
                    primary: false,
                    onTap: () {
                      // FB-8: local discard — rows settle 📥 noted. NEVER the
                      // remote ✕ (`ControlKeyKind.clear`), which wipes the
                      // PC's focused window.
                      s.controller.discardBuffer();
                      _collapseSheetRouted(s);
                      s._sheetSrcVoice = false;
                    },
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  flex: 2,
                  child: _sheetCommitButton(s, strings),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

/// §5-2 gesture ①: chevron + "collapse" (收起), NEVER ✕ — this app already has two ✕
/// with opposite consequences, and this control's consequence is a third
/// thing entirely (it changes nothing).
Widget _sheetCollapseControl(_ChatFlowPageState s, AppStrings strings) =>
    Tooltip(
      message: strings.composeCollapse,
      child: Semantics(
        label: strings.composeCollapse,
        button: true,
        child: InkWell(
          key: const ValueKey<String>('compose.sheet.collapse'),
          onTap: () => _collapseSheetRouted(s),
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // Mock `.shh > span{font-weight:400}` on "collapse ˅" (收起 ˅) — the header
                // TITLE is 600 and this is not; the weight contrast is what
                // keeps a control from reading as a second title.
                Text(
                  strings.composeCollapse,
                  key: const ValueKey<String>('compose.sheet.collapse.label'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: FlowMicDockColors.sub,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(width: 2),
                // ⚠️ FILED DEVIATION (mock A-06/A-08): the mock's `˅` is a TEXT
                // character inside the same span. Kept as the Material chevron
                // because it is functionally identical, it is the exact inverse
                // of the preview strip's `keyboard_arrow_up` (the two glyphs
                // are one axis — compose_buffer_row.dart says so at that end),
                // and a text caret would not scale with the icon theme.
                Icon(
                  Icons.keyboard_arrow_down,
                  size: 16,
                  color: FlowMicDockColors.sub,
                ),
              ],
            ),
          ),
        ),
      ),
    );

/// T-6's restore-original, in the mock's teal strip face. Same keys, same
/// wiring, same no-stacking semantics — only the face changed.
///
/// Mock A-08 inline: `background:#F0FDFA;border:1px solid #99F6E4;
/// border-radius:10px;padding:7px 11px;font-size:12px;color:#0E9384`, with
/// "restore original text" (恢复原文) as `font-weight:700;text-decoration:underline`.
///
/// 🔴 The leading [Icons.undo] is DELETED — A-08 draws no icon in this strip,
/// and the underline is what marks the words as the pressable thing.
///
/// ⚠️ FILED DEVIATION: the mock's strip carries a BODY sentence to the left of
/// the action ("polished · original text still kept" 「已润色 · 原文仍保留」,
/// `flex:1`). That sentence does not exist in
/// [AppStrings] and VF-4 is under a copy freeze, so this strip still prints the
/// action alone. The "which transform" half of that sentence is instead carried
/// by the applied-✓ pill (mock A-08 draws BOTH), so nothing on screen claims a
/// task that is not the one that ran — it is one fewer statement, not a
/// conflicting one. Adding the sentence is a copy card.
Widget _sheetRestoreStrip(_ChatFlowPageState s, AppStrings strings) =>
    Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(
        color: FlowMicDockColors.restoreBg,
        border: Border.all(color: FlowMicDockColors.restoreBorder),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Tooltip(
              message: strings.aiRestoreOriginalHint,
              child: Semantics(
                label:
                    '${strings.aiRestoreOriginal} · ${strings.aiRestoreOriginalHint}',
                button: true,
                child: InkWell(
                  key: const ValueKey<String>('compose.card.restoreOriginal'),
                  onTap: s.controller.restoreOriginal,
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text(
                      strings.aiRestoreOriginal,
                      key: const ValueKey<String>(
                        'compose.card.restoreOriginal.label',
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: FlowMicDockColors.restoreText,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        decoration: TextDecoration.underline,
                        decorationColor: FlowMicDockColors.restoreText,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );

/// The AI trio, measured into its presentation (ruling #4 §3 "text takes
/// priority" 「有字优先」): labelled iff the SHEET's inner width fits all
/// three labels plus the standing caption. The compact fallback keeps
/// Tooltip/Semantics per pill AND prints the caption on its own line —
/// "acts on the buffer · does not inject" 「作用于缓冲 · 不注入」 is the
/// sentence no layout may spend.
Widget _sheetAiRow(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings, {
  required bool appending,
}) => _SheetAiRow(
  state: s,
  controller: s.controller,
  strings: strings,
  appending: appending,
);

/// The pills row PLUS the one piece of state the mock's A-08 needs and no
/// controller carries: WHICH transform the buffer is currently showing.
///
/// "which one is lit up" is a question about this SCREEN, not about the compose
/// machinery — putting it in [AiComposeController] would add a second writer
/// to the transform path. The fields live on [_ChatFlowPageState] so a
/// collapse (which unmounts this row) cannot lose the ✓; the listener is
/// [_syncSheetAiAppliedRouted], on the same controller notification the
/// sheet already uses.
class _SheetAiRow extends StatelessWidget {
  const _SheetAiRow({
    required this.state,
    required this.controller,
    required this.strings,
    required this.appending,
  });

  final _ChatFlowPageState state;
  final ChatController controller;
  final AppStrings strings;
  final bool appending;

  @override
  Widget build(BuildContext context) {
    final ComposeTask? applied = state._sheetApplied;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints box) {
        final ComposeTask? running = controller.aiTask;
        // 🔴 The fit is measured for the row ABOUT TO BE PAINTED, not for a
        // hypothetical widest one — the two extra glyph slots (spinner / ✓) are
        // real only when their state is. Billing them unconditionally is what
        // made the 360dp sheet render icon-only pills.
        final bool labelled = AiActionRow.labelledRowFits(
          context,
          strings,
          box.maxWidth,
          runningTask: running,
          appliedTask: applied,
        );
        final Widget row = AiActionRow(
          strings: strings,
          compact: !labelled,
          // ONE enable source: `canAiCompose` already contains the non-empty
          // term.
          enabled: controller.canAiCompose,
          runningTask: running,
          appliedTask: applied,
          // Mock A-07 drops the caption while the append hold owns the sheet;
          // the compact branch below drops its own line for the same frame.
          showNote: !appending,
          onTask: (ComposeTask task) => state.controller.startAiCompose(task),
          // The dead-control ban: a greyed pill that swallows the tap teaches
          // the user "this can't be tapped" (点不了).
          onDisabledTap: (ComposeTask _) => state._toast(
            context,
            strings.aiComposeError(
              const AiComposeOutcome(reason: AiComposeFailure.notConnected),
            ),
          ),
        );
        if (labelled) return row;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            row,
            if (!appending) ...<Widget>[
              const SizedBox(height: 4),
              Text(
                running != null ? strings.aiRunning(running) : strings.aiRowNote,
                key: const ValueKey<String>('compose.card.aiNote'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
                style: TextStyle(
                  color: FlowMicDockColors.sub,
                  fontSize: 10.5,
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

// ── PA-5 append machinery ───────────────────────────────────────────────
// `_sheetAppendLiveView`, [SheetAppendButton] and the dashed-outline painter
// live in chat_flow_edit_sheet_append.dart (800-line cap split, moved
// VERBATIM — that file's header carries the contract).

/// The footer's PRIMARY button — 「投递 ➤」 ("deliver") with a PC target,
/// 「保存」 ("save", a LOCAL noted row) on a fixed destination (P4, 0.3.1).
///
/// 🔴 The label swaps WITH the mechanism, not as a synonym: 「投递」 may not
/// stand on a button whose action has no delivery machinery behind it (15
/// §2.0 — the same rule that governs 「待投递」), and the ➤ glyph goes with it
/// (it draws a send; a local save sends nothing). On a fixed destination the
/// tap runs the SAME `sendBuffer`, whose `deliverText` forks to
/// `commitNotedLocal` — one entry point, two honestly-named faces.
///
/// Honest disabled state (P4): with a PC target, a non-empty draft and the
/// link down, the button LOOKS dead (`canSend` false) but still ANSWERS the
/// tap — the PA-1 rule the dock's control keys already follow
/// (compose_band.dart `onControlKey`: 「a DISCONNECTED tap now goes through
/// here too, instead of the key playing dead」). The tap runs the SAME
/// [ChatController.sendBuffer]; its first wire gate raises
/// `ComposeSendFailure.notConnected` on the persistent banner slot (the
/// page's `_toast` doc routes delivery failures THERE, not to a snackbar),
/// and the collapse below keeps that banner readable instead of occluded —
/// the draft survives in the preview strip, exactly like today's race-loss
/// tap. One authority answers 「为什么发不出去」 ("why won't it send"): the
/// gate. A reason recomputed here could drift from it.
Widget _sheetCommitButton(_ChatFlowPageState s, AppStrings strings) {
  final bool noted = s.controller.noPcTarget;
  void commit() {
    s.controller.sendBuffer();
    _collapseSheetRouted(s);
    s._sheetSrcVoice = false;
  }

  // Wired ONLY for the link-down story. The other dead faces already explain
  // themselves on screen: an empty draft has nothing to commit, an AI run
  // shows the pills' spinner (and the field is inert), and a send already in
  // flight owns its own outcome (`sendPending`).
  final bool explainLinkDown = s.controller.buffer.trim().isNotEmpty &&
      !noted &&
      !s.controller.canCompose &&
      !s.controller.delivery.sendPending &&
      !s.controller.isAiComposing;
  return _sheetFooterButton(
    // The key is the BUTTON's identity, not the label's — both faces are the
    // one commit control, so tests and tooling address it the same way.
    key: const ValueKey<String>('compose.card.deliver'),
    label: noted ? strings.composeCardSaveNoted : strings.composeCardDeliver,
    primary: true,
    glyph: noted ? null : _kDeliverGlyph,
    // The SAME gate as ever (`canSend` carries the !isAiComposing term —
    // W2.5-1). Not recomputed here.
    onTap: s.controller.canSend ? commit : null,
    onDisabledTap: explainLinkDown ? commit : null,
  );
}

/// The footer pair — mock `.gbtn` ("discard" 丢弃) and `.pbtn` ("deliver ➤" 投递 ➤).
///
///   `.gbtn{flex:1;height:48;border-radius:14;border:1px solid var(--line);
///          font-size:14;color:var(--sub);font-weight:600}`  ← NO background
///   `.pbtn{flex:2;height:48;border-radius:14;background:var(--pri);color:#fff;
///          font-weight:700;font-size:15;gap:8}`
///
/// 🔴 The discard button has NO fill, and that is a face decision the mock
/// makes on purpose: it sits directly on the sheet panel, so a panel-coloured
/// fill would be an invisible rectangle whose only effect is to make the two
/// buttons look like the same KIND of thing. "Discard is a grey outline...
/// differs in both shape and color from 'Deliver' in the brand color on the
/// right" 「丢弃是灰描边…与右侧品牌色『投递』不同形不同色」 is frame A-06's own
/// caption.
///
/// 🔴 The dark deliver ink is [FlowMicDockColors.onPri] = **#131318, not white**
/// (A-D3 writes `<div class="pbtn" style="color:#131318">投递 ➤</div>` inline
/// — "Deliver ➤").
/// [FlowMicColors.onBrandInk], which stood here, is white in both themes.
Widget _sheetFooterButton({
  required Key key,
  required String label,
  required VoidCallback? onTap,
  required bool primary,
  // P4: the trailing glyph is now the CALLER's statement (the deliver face
  // passes [_kDeliverGlyph], the save face passes null — ➤ draws a send and a
  // local save sends nothing). It used to ride `primary` unconditionally.
  String? glyph,
  // P4: answered even while the button LOOKS disabled — the dead-control ban
  // (PA-1 / the AI pills' `onDisabledTap`). The VISUAL state stays keyed on
  // [onTap] alone, so an explained-dead button never dresses up as live.
  VoidCallback? onDisabledTap,
}) {
  final bool on = onTap != null;
  final Color ink = primary
      ? (on ? FlowMicDockColors.onPri : FlowMicDockColors.sub)
      : FlowMicDockColors.sub;
  // null ⇒ the box paints no fill at all (`.gbtn` declares no background).
  final Color? fill = primary
      ? (on ? FlowMicDockColors.pri : FlowMicDockColors.chipbg)
      : null;
  return InkWell(
    key: key,
    onTap: onTap ?? onDisabledTap,
    borderRadius: BorderRadius.circular(14),
    child: Container(
      height: 48,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: fill,
        border: Border.all(
          color: primary && on ? FlowMicDockColors.pri : FlowMicDockColors.line,
        ),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: ink,
              fontSize: primary ? 15 : 14,
              fontWeight: primary ? FontWeight.w700 : FontWeight.w600,
            ),
          ),
          // `投递 ➤` — a LAYOUT glyph, drawn as its own run so the mock's
          // `gap:8` is exactly 8dp rather than whatever one space measures at
          // 15sp, and so `find.text(composeCardDeliver)` still matches the
          // label alone. The four-locale copy is untouched: [Icons.send], the
          // Material glyph that stood here, is what this replaces.
          if (glyph != null) ...<Widget>[
            const SizedBox(width: 8),
            Text(
              glyph,
              style: TextStyle(color: ink, fontSize: 15),
            ),
          ],
        ],
      ),
    ),
  );
}

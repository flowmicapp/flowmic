// Part of chat_flow_page.dart — PA-5's append machinery, split from
// chat_flow_edit_sheet.dart at the 800-line cap (repo standing move: a
// STRUCTURAL split, evidence intact — every body below moved VERBATIM from
// that file, where its contract lives: §2 SUP-5's A7 row, §5-1 append button,
// MD-1/MD-3 honesty rules, and the one-gesture-chain requirement).

part of 'chat_flow_page.dart';

/// PA-5 / A7: the read-only draft+live view while an append is in flight.
///
/// 🔴 THE SECOND — AND LAST — `liveText` RENDER SITE in the whole app, beside
/// the timeline's LiveDraftTile (chat_flow_scroll.dart). The gate
/// (live_interim_single_render_site_test.dart) enumerates exactly these two by
/// name; a third site anywhere still fails it. This one exists because the
/// timeline's live row is BEHIND the scrim while the sheet is up — the user's
/// eyes are on the draft they are appending to, and the growing words must be
/// visible where they will land (mock ⑦'s highlight).
Widget _sheetAppendLiveView(_ChatFlowPageState s) {
  final String draft = s.controller.buffer;
  final String live = s.controller.liveText;
  return Container(
    key: const ValueKey<String>('compose.sheet.live'),
    constraints: const BoxConstraints(minHeight: 38),
    // 🔴 WP8 VF-4 / contract §0 D5 — NAKED, exactly like the field it replaces.
    // This view and [ComposeBufferField] swap places mid-gesture, so any face
    // difference between them reads to the user as 「the box changed」 in the one
    // window where nothing should move but the words. That is also why the
    // vertical 9 stays and the horizontal 12 goes: 9 is the field's own
    // `contentPadding`, and the field has no horizontal inset any more.
    padding: const EdgeInsets.symmetric(vertical: 9),
    child: SingleChildScrollView(
      reverse: true,
      child: Text.rich(
        TextSpan(
          children: <InlineSpan>[
            TextSpan(text: draft),
            // The live words, highlighted — appended into the SAME paragraph
            // so the user reads one sentence forming, not two boxes. No
            // fabricated caret, no placeholder when the engine has produced
            // nothing yet (silence renders silence).
            //
            // ⚠️ FILED DEVIATION (mock A-07): the mock's appended span is
            // `background:#EEF2FF;border-radius:4px;padding:1px 2px`. A
            // [TextSpan] can carry `backgroundColor` and nothing else — inline
            // spans have no radius and no padding in Flutter. The wash colour
            // is the mock's; the 4px corners and the 1×2 inset are not
            // reproducible without leaving the paragraph (a WidgetSpan would
            // break line-breaking mid-sentence, which is worse than square
            // corners on a highlight).
            if (live.isNotEmpty)
              TextSpan(
                text: draft.isEmpty ? live : ' $live',
                style: TextStyle(
                  backgroundColor: FlowMicDockColors.appendHighlight,
                  color: FlowMicDockColors.ink,
                ),
              ),
          ],
        ),
        // Mock `.bdy{font-size:16px;line-height:1.75}` — the same pair the
        // field now carries, for the same reason.
        style: TextStyle(
          color: FlowMicDockColors.ink,
          fontSize: 16,
          height: 1.75,
        ),
      ),
    ),
  );
}

/// PA-5: the in-sheet hold-to-append button — solid brand fill at rest, red
/// outline while the hold is live (mock ⑥/⑦).
///
/// 🔴 NR-4 (d) OPTION B (2026-08-27, owner ruling ③ of
/// docs/decisions/2026-08-27-owner-web-rulings-batch-2.md; design
/// docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §2.2).
/// The complaint on the ledger was 「the talk button is gone」 when the sheet is
/// up. The sheet's covering geometry is NOT what answered it — that geometry is
/// SEG-2's deliberate design (`chat_flow_edit_sheet.dart:119-124`, and a
/// half-height sheet would put a second, live recording entry point on screen,
/// which this file's own header forbids). What answers it is that THIS button
/// now wears the PTT bar's resting face: the same [kSpeakControlHeight], the
/// same solid [FlowMicDockColors.pri] fill, the same [kSpeakControlRadius], the
/// same [kSpeakControlGlyphSize] mic. The user's question is 「can I still
/// speak」, not 「where did that 46dp rectangle go」, and one glance at a
/// familiar face answers it.
///
/// ⚠️ THE DASHED OUTLINE IS GONE, not kept as a variant. A dashed hairline is
/// this app's 「secondary control」 vocabulary, and the reasoning is the same
/// one owner used on P5→P5b for the bar itself (「土黄色有边框的按钮看起来与整个
/// APP 的设计语言不一致」 — an outlined face read as a label strip rather than
/// the screen's primary action). Keeping both would be keeping the thing that
/// caused the complaint.
///
/// ⚠️ ONLY THE RESTING FACE MOVED. The recording and cancel-armed faces are
/// byte-identical: red/grey outlines are already the loudest thing on the
/// sheet, and re-skinning an alarm to match an idle control would be a
/// regression dressed as consistency. The font size stayed 13.5 too — the
/// bar's 17 is sized for a full sentence across a full-width bar.
///
/// 🔴 SAME GESTURE CHAIN as the PTT bar: hold-to-record, slide-up (60px) to
/// cancel, release to finish — driven through the SAME
/// pttDown/pttUp/pttCancel callbacks. Public (not `_SheetAppendButton`) for
/// the same reason PttBar's callbacks are reachable: the append tests must
/// drive the PRODUCTION-wired `onDown` directly, because a real accepted
/// long-press drags the async PTT chain into testWidgets' FakeAsync zone
/// (the documented deadlock).
///
/// 🔴 NR-4 / 0.3.43 Q5-③ (2026-08-28, owner ruling Q5-③ of
/// docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md):
/// THIS BUTTON HAS A DISABLED FACE NOW. It never had one. The gate it presses
/// (`ChatController.canPtt`) can be false for three reasons — link down, a
/// previous utterance still in PROCESSING, an AI compose run in flight — and in
/// every one of them the button kept its full live face, accepted the hold,
/// swallowed the refusal `pttDown` returned, and did nothing. That is the fake
/// affordance this repo's oldest red line names: 「一个改变不了任何东西的控件比
/// 没有控件更坏」 — a control that can change nothing is worse than no control.
/// The PTT bar has had [PttVisual.disabled] since it was written; this button
/// ran the SAME GESTURE CHAIN and was missing the same half, exactly like the
/// accessible-cancel hole NR-4 (g) found here for the same reason.
class SheetAppendButton extends StatefulWidget {
  const SheetAppendButton({
    super.key,
    required this.appending,
    required this.strings,
    required this.onDown,
    required this.onUp,
    required this.onCancel,
    this.enabled = true,
    this.onDisabledTap,
    this.onHoldPointerDown,
    this.onHoldPointerSettled,
  });

  /// Whether the gate behind [onDown] would accept a press right now
  /// (`ChatController.canPtt`). False ⇒ the disabled face, no hold recognizer,
  /// and [onDisabledTap] on tap.
  ///
  /// ⚠️ READ ONLY AT REST. A live hold owns this control until it settles — see
  /// [_SheetAppendButtonState._disabled] for why re-reading it mid-hold would
  /// break the very gesture it is meant to protect.
  final bool enabled;

  /// Called when a press lands on the disabled face. The sheet renders the
  /// reason; this widget deliberately does not choose the sentence, because the
  /// three reasons behind `canPtt` do not share one.
  final VoidCallback? onDisabledTap;

  /// A7 face: true while the append hold is live (red, release wording).
  final bool appending;
  final AppStrings strings;

  /// The SAME acceptance edge as the PTT bar (`_pttDownRouted`, fold pinned),
  /// plus the page's A7 mark — one closure, wired by the sheet.
  final Future<bool> Function() onDown;

  final Future<void> Function() onUp;
  final Future<void> Function() onCancel;

  /// Fired on the raw pointer-down, BEFORE the long-press is accepted.
  /// The sheet uses this to freeze the IME inset so dismissing the keyboard
  /// cannot slide this button out from under the finger.
  final void Function(double viewInsetBottom)? onHoldPointerDown;

  /// Fired when that pointer leaves (up or OS-cancel), accepted or not.
  final VoidCallback? onHoldPointerSettled;

  @override
  State<SheetAppendButton> createState() => _SheetAppendButtonState();
}

class _SheetAppendButtonState extends State<SheetAppendButton> {
  bool _active = false;
  bool _cancelled = false;
  bool _cancelArmed = false;

  /// 0.3.43 Q5-③ — an accepted hold is waiting on [SheetAppendButton.onDown].
  ///
  /// The gate goes false the instant the FSM enters RECORDING, i.e. roughly two
  /// seconds BEFORE `onDown` returns and `widget.appending` is set. Reading
  /// `widget.enabled` naively would therefore repaint this control as DISABLED
  /// in the middle of the user's own hold and hand the pointer to a tap handler
  /// instead of the release. This flag is what makes 「read only at rest」 true.
  bool _activating = false;

  /// The disabled face — asked at REST only. A hold in flight (`_activating`),
  /// a live hold ([_active]) and the recording face
  /// ([SheetAppendButton.appending]) each keep the control alive regardless of
  /// the gate, because all three mean this button is already mid-gesture.
  bool get _disabled =>
      !widget.enabled && !widget.appending && !_active && !_activating;

  void _onCancelZoneChanged(bool inZone) {
    if (!mounted) return;
    if (_cancelArmed == inZone) return;
    setState(() => _cancelArmed = inZone);
  }

  /// 🔴 NR-4 (g): `_active` is a RENDERED fact now — the accessible cancel
  /// action below is registered off it — so every write schedules a frame.
  /// Before this, none of the three writes did, and the face did not need one
  /// (it is driven by `widget.appending`, which the sheet sets). The action
  /// would therefore have appeared and disappeared only when the PARENT
  /// happened to rebuild. Same setter, same reason, as `PttBar._setActive`.
  void _setActive(bool v) {
    if (_active == v) return;
    if (mounted) {
      setState(() => _active = v);
    } else {
      _active = v;
    }
  }

  Future<void> _handleDown() async {
    _cancelled = false;
    _cancelArmed = false;
    // 0.3.43 Q5-③ — hold the face alive across the await. Set BEFORE it and
    // cleared in a `finally`, so a throw out of the gate cannot leave this
    // button permanently claiming a hold it does not have.
    _activating = true;
    try {
      final bool ok = await widget.onDown();
      if (_cancelled) {
        if (ok) unawaited(widget.onCancel());
        _setActive(false);
        return;
      }
      _setActive(ok);
      if (ok && mounted) {
        countUsage(UsageEvent.pttHold);
        unawaited(FlowMicHaptics.pttDown());
      }
    } finally {
      _activating = false;
    }
  }

  Future<void> _handleSwipeCancel() async {
    if (_cancelled) return;
    _cancelled = true;
    if (!_active) return;
    // NR-4 (g) — same one-line change and same reasoning as
    // `PttBar._handleSwipeCancel`: an accessible cancel has no release behind
    // it, so this is where the hold actually closes.
    _setActive(false);
    countUsage(UsageEvent.pttCancel);
    unawaited(FlowMicHaptics.pttCancel());
    await widget.onCancel();
  }

  Future<void> _handleUp() async {
    if (!_active) return;
    _setActive(false);
    if (_cancelled) return; // swipe-up already cancelled → no fold.
    countUsage(UsageEvent.pttSend);
    unawaited(FlowMicHaptics.pttSend());
    await widget.onUp();
  }

  /// U12's accessible alternative, same toggle contract as PttBar: one
  /// activation starts the hold, a second one ends it.
  Future<void> _handleSemanticActivate() async {
    if (_active) {
      await _handleUp();
    } else {
      await _handleDown();
    }
  }

  @override
  Widget build(BuildContext context) {
    final bool rec = widget.appending;
    final bool disabled = _disabled;
    // WP8 VF-4 — mock `.apnd{height:46;border-radius:13;border:1.5px dashed
    // var(--pri);color:var(--pri);font-size:13.5px;font-weight:600;gap:8}`, and
    // A-07's live face `border-style:solid;border-color:#DC2626;color:#DC2626`.
    // Geometry was already right; only the two inks move onto the dock palette.
    // Cancel-armed uses the same gray as the PTT bar's 「松开 取消」("release
    // to cancel") face
    // (`.ptt.gry` / [FlowMicDockColors.recordOnly]) so the two surfaces
    // answer 「this release will discard」 with one colour.
    final Color ink = _cancelArmed
        ? FlowMicDockColors.recordOnly
        : rec
        ? FlowMicDockColors.rec
        : FlowMicDockColors.pri;
    final String faceLabel = _cancelArmed
        ? widget.strings.appendCancelArmed
        : rec
        ? widget.strings.appendRelease
        : widget.strings.appendHold;
    // NR-4 (d) option B: at rest this is the PTT bar's face, filled and solid.
    // A solid fill carries its own edge, which is why there is no border on it
    // (the same sentence ptt_bar.dart's P5b note makes).
    final bool resting = !rec && !_cancelArmed;
    // 🔴 0.3.43 Q5-③ — the disabled face is the PTT BAR's disabled face, token
    // for token: `.ptt.dis{background:var(--chipbg);color:var(--sub)}`. It is
    // the app's one 「off」 vocabulary and this control must not invent a second.
    // The mic glyph is dropped for the same reason the bar drops it there — the
    // bar's disabled frame is LABEL ONLY — and dropping it is most of what makes
    // 「this cannot be pressed」 readable at a glance rather than a subtle tint.
    final Color labelInk = disabled
        ? FlowMicDockColors.sub
        : resting
        ? FlowMicDockColors.onPri
        : ink;
    final Widget face = Container(
      height: kSpeakControlHeight,
      alignment: Alignment.center,
      decoration: disabled
          ? BoxDecoration(
              color: FlowMicDockColors.chipbg,
              borderRadius: BorderRadius.circular(kSpeakControlRadius),
            )
          : resting
          ? BoxDecoration(
              color: FlowMicDockColors.pri,
              borderRadius: BorderRadius.circular(kSpeakControlRadius),
            )
          : BoxDecoration(
              border: Border.all(color: ink, width: 1.5),
              borderRadius: BorderRadius.circular(13),
            ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // WP8 integration: `MicGlyph` is the 1:1 transcription of the SVG
          // the mock inlines on A-06/A-08's `.apnd` (the same glyph the PTT
          // bar draws at 17). The import lives in chat_flow_page.dart because
          // this file is a `part` and cannot carry its own.
          // ⚠️ The recording face draws NO glyph, and that is the mock: A-07's
          // `.apnd` is the bare sentence `● 松开 结束追加`("release to finish
          // appending").
          if (resting && !disabled) ...<Widget>[
            MicGlyph(size: kSpeakControlGlyphSize, color: labelInk),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Text(
              faceLabel,
              key: const ValueKey<String>('compose.sheet.append.label'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: labelInk,
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
    return Semantics(
      container: true,
      button: true,
      // 0.3.43 Q5-③ — the a11y half of the disabled face. An AT user must not
      // be told this is an enabled button and then get nothing on activation;
      // the activation still fires so the reason is spoken (a silent refusal
      // reads as a broken control, which is the same complaint one layer down).
      enabled: !disabled,
      label: faceLabel,
      liveRegion: true,
      excludeSemantics: true,
      onTap: disabled ? widget.onDisabledTap : _handleSemanticActivate,
      // NR-4 (g) — the accessible discard, same shape and same reasoning as
      // `PttBar`'s (see `AppStrings.pttCancelSemanticAction`'s doc): registered
      // only while `_active`, wired to the very function the swipe gesture
      // calls. The ledger named only the bar; this button had the identical
      // hole, which is unsurprising — its header says it runs the SAME GESTURE
      // CHAIN, and that turned out to include the missing half.
      customSemanticsActions: _active
          ? <CustomSemanticsAction, VoidCallback>{
              CustomSemanticsAction(
                    label: widget.strings.appendCancelSemanticAction,
                  ):
                  () => unawaited(_handleSwipeCancel()),
            }
          : null,
      // 🔴 0.3.43 Q5-③ — a DIFFERENT recognizer, not `HoldToTalkSurface(enabled:
      // false)`. That surface ignores the pointer entirely when disabled, so a
      // tap would produce silence: the control would go from 「looks alive, does
      // nothing」 to 「looks dead, does nothing」, which fixes half the complaint
      // and leaves the user with no way to find out why. A tap has to have an
      // answer, so the disabled face gets its own tap target.
      child: disabled
          ? GestureDetector(
              key: const ValueKey<String>('compose.sheet.append.disabled'),
              behavior: HitTestBehavior.opaque,
              onTap: widget.onDisabledTap,
              child: face,
            )
          : HoldToTalkSurface(
              key: const ValueKey<String>('compose.sheet.append'),
              enabled: true,
              onAccepted: _handleDown,
              onRelease: _handleUp,
              onSwipeCancel: _handleSwipeCancel,
              onCancelZoneChanged: _onCancelZoneChanged,
              onPointerDown: widget.onHoldPointerDown,
              onPointerSettled: widget.onHoldPointerSettled,
              // 🔴 NR-4 (d): the `CustomPaint` + `_DashedRRectPainter` wrapper
              // that stood here is GONE together with the painter class — the
              // resting face paints its own solid fill now. The class had
              // exactly one user, so keeping it would have left a
              // dashed-outline construction lying around for the next control
              // to reach for.
              child: face,
            ),
    );
  }
}


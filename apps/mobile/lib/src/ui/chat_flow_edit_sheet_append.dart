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

/// PA-5: the in-sheet hold-to-append button — 46dp, dashed brand outline at
/// rest, solid red while the hold is live (mock ⑥/⑦).
///
/// 🔴 SAME GESTURE CHAIN as the PTT bar: hold-to-record, slide-up (60px) to
/// cancel, release to finish — driven through the SAME
/// pttDown/pttUp/pttCancel callbacks. Public (not `_SheetAppendButton`) for
/// the same reason PttBar's callbacks are reachable: the append tests must
/// drive the PRODUCTION-wired `onDown` directly, because a real accepted
/// long-press drags the async PTT chain into testWidgets' FakeAsync zone
/// (the documented deadlock).
class SheetAppendButton extends StatefulWidget {
  const SheetAppendButton({
    super.key,
    required this.appending,
    required this.strings,
    required this.onDown,
    required this.onUp,
    required this.onCancel,
    this.onHoldPointerDown,
    this.onHoldPointerSettled,
  });

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

  void _onCancelZoneChanged(bool inZone) {
    if (!mounted) return;
    if (_cancelArmed == inZone) return;
    setState(() => _cancelArmed = inZone);
  }

  Future<void> _handleDown() async {
    _cancelled = false;
    _cancelArmed = false;
    final bool ok = await widget.onDown();
    if (_cancelled) {
      if (ok) unawaited(widget.onCancel());
      _active = false;
      return;
    }
    _active = ok;
    if (ok && mounted) {
      countUsage(UsageEvent.pttHold);
      unawaited(FlowMicHaptics.pttDown());
    }
  }

  Future<void> _handleSwipeCancel() async {
    if (_cancelled) return;
    _cancelled = true;
    if (!_active) return;
    countUsage(UsageEvent.pttCancel);
    unawaited(FlowMicHaptics.pttCancel());
    await widget.onCancel();
  }

  Future<void> _handleUp() async {
    if (!_active) return;
    _active = false;
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
    final Widget face = Container(
      height: 46,
      alignment: Alignment.center,
      decoration: rec || _cancelArmed
          ? BoxDecoration(
              border: Border.all(color: ink, width: 1.5),
              borderRadius: BorderRadius.circular(13),
            )
          : null,
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
          if (!rec && !_cancelArmed) ...<Widget>[
            MicGlyph(size: 15, color: ink),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Text(
              faceLabel,
              key: const ValueKey<String>('compose.sheet.append.label'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: ink,
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
      label: faceLabel,
      liveRegion: true,
      excludeSemantics: true,
      onTap: _handleSemanticActivate,
      child: HoldToTalkSurface(
        key: const ValueKey<String>('compose.sheet.append'),
        enabled: true,
        onAccepted: _handleDown,
        onRelease: _handleUp,
        onSwipeCancel: _handleSwipeCancel,
        onCancelZoneChanged: _onCancelZoneChanged,
        onPointerDown: widget.onHoldPointerDown,
        onPointerSettled: widget.onHoldPointerSettled,
        child: rec
            ? face
            : CustomPaint(
                painter: _DashedRRectPainter(
                  color: ink,
                  strokeWidth: 1.5,
                  radius: 13,
                ),
                child: face,
              ),
      ),
    );
  }
}

/// A dashed rounded-rect outline (6px dash / 4px gap). Only the append button
/// uses it — Flutter's Border has no dash style.
class _DashedRRectPainter extends CustomPainter {
  const _DashedRRectPainter({
    required this.color,
    required this.strokeWidth,
    required this.radius,
  });

  final Color color;
  final double strokeWidth;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth;
    final Path source = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Offset.zero & size,
          Radius.circular(radius),
        ),
      );
    const double dash = 6;
    const double gap = 4;
    for (final PathMetric metric in source.computeMetrics()) {
      double distance = 0;
      while (distance < metric.length) {
        final double next = distance + dash;
        canvas.drawPath(
          metric.extractPath(distance, next.clamp(0, metric.length)),
          paint,
        );
        distance = next + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedRRectPainter oldDelegate) =>
      color != oldDelegate.color ||
      strokeWidth != oldDelegate.strokeWidth ||
      radius != oldDelegate.radius;
}


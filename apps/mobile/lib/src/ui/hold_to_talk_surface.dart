// Shared hold-to-talk pointer routing for [PttBar] and [SheetAppendButton].
//
// After the hold is accepted, swipe-up cancel is tracked from the POINTER's
// global Y (a [Listener]), not from a long-press recognizer. A real swipe
// often rejects Flutter's [LongPressGestureRecognizer] (default slop ~18dp)
// instead of delivering move updates; treating that reject as a RELEASE used
// to send the utterance. The same reject fires when the widget moves under a
// still-down finger (IME inset collapsing, dock yield-while-recording).
//
// Accept is a 500 ms TIMER on pointer-down, not a long-press recognizer:
// movement does not abort the accept. Press-and-immediately-slide (the
// WeChat habit) can still start a recording and still cancel it.
//
// Rules:
//   · global dy from pointer-down < −60 → cancel ZONE (visual armed)
//   · slide back above the threshold → zone clears (recording continues)
//   · pointer up in the zone → swipe-cancel (no send)
//   · pointer up outside the zone → release/send
//   · pointer cancel (OS stole the pointer) in the zone → cancel
//   · pointer cancel outside the zone → release (keep the words)
//
// [onPointerDown] / [onPointerSettled] are geometry hooks for the append
// button: lock the sheet's bottom inset on down so a keyboard dismiss cannot
// slide the control out from under the finger; unlock on up/cancel.

import 'dart:async';

import 'package:flutter/widgets.dart';

class HoldToTalkSurface extends StatefulWidget {
  const HoldToTalkSurface({
    super.key,
    required this.enabled,
    required this.onAccepted,
    required this.onRelease,
    required this.onSwipeCancel,
    required this.child,
    this.onCancelZoneChanged,
    this.onPointerDown,
    this.onPointerSettled,
  });

  final bool enabled;
  final Future<void> Function() onAccepted;
  final Future<void> Function() onRelease;
  final Future<void> Function() onSwipeCancel;

  /// Fired when the finger crosses into / out of the cancel zone. The host
  /// uses this for the gray 「松开 取消」("release to cancel") face. Crossing
  /// the line does NOT
  /// discard the utterance — release while still in the zone does.
  final ValueChanged<bool>? onCancelZoneChanged;

  final void Function(double viewInsetBottom)? onPointerDown;
  final VoidCallback? onPointerSettled;
  final Widget child;

  /// Same 60dp the PTT bar and the append button have always used.
  static const double cancelThreshold = 60;

  /// Same 500 ms Flutter's long-press default uses. Named here so a test
  /// that wants to land exactly on the accept edge does not invent a second
  /// number.
  static const Duration acceptHold = Duration(milliseconds: 500);

  @override
  State<HoldToTalkSurface> createState() => _HoldToTalkSurfaceState();
}

class _HoldToTalkSurfaceState extends State<HoldToTalkSurface> {
  int? _pointer;
  double _originY = 0;
  double _lastY = 0;
  bool _accepted = false;
  bool _inCancelZone = false;
  bool _settled = true;
  Timer? _acceptTimer;

  void _onPointerDown(PointerDownEvent e) {
    if (!widget.enabled) return;
    if (_pointer != null) return;
    _pointer = e.pointer;
    _originY = e.position.dy;
    _lastY = e.position.dy;
    _accepted = false;
    _setCancelZone(false);
    _settled = false;
    widget.onPointerDown?.call(_viewInsetBottom());
    _acceptTimer?.cancel();
    _acceptTimer = Timer(HoldToTalkSurface.acceptHold, _onAcceptTimer);
  }

  void _onAcceptTimer() {
    _acceptTimer = null;
    if (_pointer == null || _settled || _accepted) return;
    if (!widget.enabled) return;
    _accepted = true;
    unawaited(widget.onAccepted());
    // Finger may already be past the threshold (press-and-immediately-slide).
    // Re-announce even if the zone flag did not change: the host resets its
    // armed face on accept, and there may be no further move event.
    if (_inCancelZone) {
      widget.onCancelZoneChanged?.call(true);
    } else {
      _syncCancelZone();
    }
  }

  double _viewInsetBottom() {
    if (!mounted) return 0;
    // Scaffold(resizeToAvoidBottomInset: true) zeroes MediaQuery.viewInsets
    // inside the body — the padding was already applied. The lock has to
    // read the VIEW's inset, which is still the keyboard, or a hold that
    // starts with the IME up freezes 0 and the button drops with the keys.
    final view = View.of(context);
    return view.viewInsets.bottom / view.devicePixelRatio;
  }

  void _onPointerMove(PointerMoveEvent e) {
    if (e.pointer != _pointer) return;
    if (_settled) return;
    _lastY = e.position.dy;
    _syncCancelZone();
  }

  void _syncCancelZone() {
    _setCancelZone(_lastY - _originY < -HoldToTalkSurface.cancelThreshold);
  }

  void _setCancelZone(bool inZone) {
    if (inZone == _inCancelZone) return;
    _inCancelZone = inZone;
    widget.onCancelZoneChanged?.call(inZone);
  }

  void _onPointerUp(PointerUpEvent e) {
    if (e.pointer != _pointer) return;
    _finish(release: true);
  }

  void _onPointerCancel(PointerCancelEvent e) {
    if (e.pointer != _pointer) return;
    // OS stole the pointer (incoming call, etc.). Keep the words = release,
    // unless the finger was already in the cancel zone.
    _finish(release: true);
  }

  void _finish({required bool release}) {
    _acceptTimer?.cancel();
    _acceptTimer = null;
    final bool accepted = _accepted;
    final bool inZone = _inCancelZone;
    _pointer = null;
    _accepted = false;
    _setCancelZone(false);
    if (_settled) return;
    _settled = true;
    widget.onPointerSettled?.call();
    if (!accepted || !release) return;
    if (inZone) {
      unawaited(widget.onSwipeCancel());
    } else {
      unawaited(widget.onRelease());
    }
  }

  @override
  void dispose() {
    _acceptTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _onPointerDown,
      onPointerMove: _onPointerMove,
      onPointerUp: _onPointerUp,
      onPointerCancel: _onPointerCancel,
      child: widget.child,
    );
  }
}

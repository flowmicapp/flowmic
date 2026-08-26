// Card PAIR-SUCCESS, second cut (owner 2026-08-26) — the 「配对成功」 confirmation,
// as a CENTRED floating panel that fades out on its own after about two seconds.
//
// ── WHY THIS REPLACES A BANNER, AND WHY THAT IS NOT A STYLE CHANGE ───────────
//
// The first cut put this fact in the chat page's ONE banner slot. Three things
// were wrong with that, and only the third looks like a bug:
//
//   1. WRONG PLACE. owner: 「在转录界面这个上一层浮动一个就是在屏幕的中央浮动一个
//      窗口，就是相当于叮的一声」. A strip pinned under the header is not the
//      "ding" a pairing deserves; the eye never goes there.
//   2. WRONG FREQUENCY. It rode `_enterChat`, the funnel EVERY entry goes
//      through — tapping a PC you paired last week raised it too. owner, on
//      0.3.35: 「不管是中继或者说本地局域网，还是说第二次进入、第三次进入，它都会
//      显示」. It now rides the pairing entry alone.
//   3. WRONG SLOT, and this is the one that made it invisible when it mattered:
//      the slot renders exactly ONE banner, chosen by severity with a
//      first-pushed tie-break, and this one was pushed LAST. Anything else
//      queued simply kept the slot. Moving off that slot removes the contest
//      entirely rather than trying to win it.
//
// 🔴 The instrumentation added earlier that day (`pairing.success.slot-taken`)
// never got to answer, because the answer turned out to be none of the
// mechanisms it was watching for: the banner WAS appearing, every time, and the
// owner did not recognise it as this feature. Worth keeping in mind — the
// question 「why is it missing」 was the wrong question for two rounds.
//
// It is EVENT-type, so it must end without the user doing anything, and it must
// never take a tap: it sits above the page in the Stack with
// `IgnorePointer`, so a PTT press that lands under it still reaches the button.

import 'dart:async';

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'tokens.dart';

/// How long the panel stays fully visible before it starts fading.
const Duration kPairingToastHold = Duration(milliseconds: 1400);

/// The fade itself. Hold + fade ≈ the 「两秒左右消失掉」 owner asked for.
const Duration kPairingToastFade = Duration(milliseconds: 600);

/// The centred 「已连接」 panel. [ticket] is the occurrence counter from
/// `PairingSuccessNotice`: a CHANGED non-null value is a fresh occurrence, null
/// means nothing is up. Rendering nothing at all when it is null is deliberate —
/// an always-mounted widget with opacity 0 still eats hit-tests on some
/// platforms, and this must never be between the user and the PTT button.
class PairingSuccessToast extends StatefulWidget {
  const PairingSuccessToast({
    super.key,
    required this.ticket,
    required this.strings,
    required this.onExpired,
  });

  final int? ticket;
  final AppStrings strings;

  /// Called when the panel has finished fading — the page clears the ticket.
  /// The SAME callback the ✕ would fire if this were dismissible, so 「it timed
  /// out」 and 「it was dismissed」 stay indistinguishable downstream.
  final void Function() onExpired;

  @override
  State<PairingSuccessToast> createState() => _PairingSuccessToastState();
}

class _PairingSuccessToastState extends State<PairingSuccessToast> {
  int? _shown;
  double _opacity = 0;
  /// 🔴 CANCELLABLE, and owned by dispose(). The first cut used
  /// `Future.delayed`, which cannot be cancelled: leaving the page mid-panel
  /// left two callbacks pending against a dead tree, and the widget tests said
  /// so immediately. This repo has the same account already — a recheck timer
  /// that was never disposed (0.2.51) — so it is one place, one owner, always.
  Timer? _fadeAt;
  Timer? _goneAt;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(PairingSuccessToast old) {
    super.didUpdateWidget(old);
    _sync();
  }

  @override
  void dispose() {
    _fadeAt?.cancel();
    _goneAt?.cancel();
    super.dispose();
  }

  void _sync() {
    final int? t = widget.ticket;
    if (t == null || t == _shown) return;
    _shown = t;
    _fadeAt?.cancel();
    _goneAt?.cancel();
    // Fully visible immediately: this is a confirmation, not an animation, and
    // a fade-IN would delay the very feedback it exists to give.
    _opacity = 1;
    _fadeAt = Timer(kPairingToastHold, () {
      if (!mounted || _shown != t) return;
      setState(() => _opacity = 0);
      _goneAt = Timer(kPairingToastFade, () {
        if (!mounted || _shown != t) return;
        widget.onExpired();
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.ticket == null) return const SizedBox.shrink();
    return IgnorePointer(
      child: Center(
        child: AnimatedOpacity(
          opacity: _opacity,
          duration: kPairingToastFade,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 18),
            constraints: const BoxConstraints(maxWidth: 280),
            decoration: BoxDecoration(
              color: FlowMicColors.surface,
              borderRadius: BorderRadius.circular(16),
              // The shared token, not a hand-mixed colour: on the light palette a
              // dense black shadow reads as a hole, and that reasoning is written
              // once in tokens.dart rather than re-derived per floating surface.
              boxShadow: FlowMicColors.floatShadow,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.check_circle_rounded, size: 40, color: FlowMicColors.green),
                const SizedBox(height: 10),
                Text(
                  widget.strings.pairingSuccessBanner,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 15, height: 1.35, color: FlowMicColors.t1),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

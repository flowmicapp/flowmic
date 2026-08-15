// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 B (record-only PTT is
//     a NEUTRAL full-width bar — strong visual split from the active inject bar)
//   docs/rebuild/08-MOBILE-SPEC.md §2 (PTT down = long-press; up = send; swipe-
//     up = cancel/no-entry). Gate: connected + idle.
//   docs/ui-design/demo/mobile.html (.ptt / .ptt.rec / .ptt.dis / .ptt.noted;
//     @keyframes pulse 1.6s brightness 1 → 1.18)
//   docs/ui-design/REDESIGN-PLAN.md §6.2 ⑤ four-state colour scheme (idle
//     brand gradient / recording red pulse / processing amber / justDone
//     green check)
//
// The push-to-talk bar. The visual states map 1:1 to the demo classes plus the
// two FSM faces the demo never drew (processing / justDone); the swipe-up cancel
// is a 60dp zone: crossing it arms a gray 「松开 取消」("release to cancel") face, sliding back
// disarms, release in the zone discards (utterance never completed → no row).
//
// R6 T-5d: the pulse is a REAL animation now (it used to be a dead binding —
// destructured and never read). It runs only in [PttVisual.recording] and is
// stopped on every other state, so no ticker spins while idle.

// ── WP8 VF-2 (2026-08-14): the face is the mock's, not the demo's ────────────
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §2 「PTT bar」
//   docs/FlowMic 转录页三方案交付/FlowMic 转录页 · 三方案交付.dc.html —
//     `.ptt{height:60px;border-radius:17px;background:var(--pri);color:#fff;
//           gap:10px;font-weight:700;font-size:17px;letter-spacing:1px}`
//     `.ptt.gry{#8B8996}` `.ptt.rec{#DC2626}` `.ptt.amb{#D97706}`
//     `.ptt.dis{background:var(--chipbg);color:var(--sub);letter-spacing:0}`
// Three things went, and each is a delete rather than a retune:
//   · the GRADIENTS — every mock face is one solid colour;
//   · the GLOW shadows (`_shadow`/`_glow`) — the mock draws none anywhere, and
//     contract §1 ends with 「no heavier shadows in dark」; the elevation
//     language it encoded is carried by the dock's border-top + panel now;
//   · `Icons.mic_none` — replaced by [MicGlyph], the mock's own SVG mic, on the
//     two faces that draw one (A-01 idle, A-11 record-only). The recording,
//     processing and disabled frames draw a LABEL ONLY.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter/material.dart' show Icons;

import '../session/usage_counters.dart';
import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import 'haptics.dart';
import 'hold_to_talk_surface.dart';
import 'mic_glyph.dart';
import 'tokens.dart';

enum PttVisual {
  /// idle, inject destination — the default brand bar.
  idle,

  /// idle, record-only destination — the neutral grey bar.
  noted,

  /// RECORDING — the pulsing red bar.
  recording,

  /// PROCESSING — amber; capture ended, awaiting the terminal stt:final.
  processing,

  /// JUST_DONE — green with a ✓; the 1500 ms confirmation window.
  justDone,

  /// link down — disabled grey bar.
  disabled,
}

class PttBar extends StatefulWidget {
  const PttBar({
    super.key,
    required this.visual,
    this.strings,
    this.onDown,
    this.onUp,
    this.onCancel,
  });

  final PttVisual visual;

  /// Explicit locale source. Null falls back to zh (CLAUDE.md red line: the UI
  /// never follows the OS locale), which is byte-identical to the demo copy.
  final AppStrings? strings;

  final Future<bool> Function()? onDown;
  final Future<void> Function()? onUp;
  final Future<void> Function()? onCancel;

  @override
  State<PttBar> createState() => _PttBarState();
}

class _PttBarState extends State<PttBar> with SingleTickerProviderStateMixin {
  bool _cancelled = false;
  bool _active = false;

  /// P6 (0.3.1) — finger is physically down, accept edge not necessarily
  /// reached. Drives the 0 ms pressed tint: before this existed the entire
  /// accept window PLUS the recorder warm-up (measured ~2 s on the owner's
  /// tablet) rendered nothing, so the press felt ignored. Purely visual, and
  /// COLOUR-ONLY on purpose: this bar's geometry must never change under a
  /// finger (the P3 tablet-dock lesson is the same rule one layer up).
  bool _pressed = false;

  /// P6 — the accept edge fired and [_handleDown] is awaiting the data layer
  /// (permission gate + native recorder open). The face swaps its label to
  /// `pttStartingMic` for this window: it claims only 「starting」, which is
  /// true; the recording face, timer and waveform still wait for the real
  /// capture start, because words spoken before the OS mic is open are
  /// physically lost and a face that said 「recording」 here would be a wrong
  /// status word with no failure anywhere (R11).
  bool _starting = false;

  /// Finger is past the swipe-up threshold. Visual only — the utterance is
  /// still live until release (WeChat-style: gray 「松开 取消」("release to
  /// cancel"), slide back
  /// to un-arm). Driven by [HoldToTalkSurface.onCancelZoneChanged].
  bool _cancelArmed = false;

  /// Demo: `@keyframes pulse 1.6s infinite`, brightness 1 → 1.18 at the midpoint.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 800),
  );

  bool get _enabled =>
      widget.visual != PttVisual.disabled &&
      widget.visual != PttVisual.processing &&
      widget.visual != PttVisual.justDone;

  bool get _shouldPulse =>
      widget.visual == PttVisual.recording && !_cancelArmed;

  /// 🔴 `_shadow` / `_glow` STOOD HERE AND ARE DELETED, NOT PARKED.
  /// They ported the frozen demo's `box-shadow:0 6px 18px rgba(79,70,229,.35)`
  /// (and its red / black / amber / green siblings) so the bar would not 「read
  /// as a flat strip of colour next to bordered cards」. The Plan A′ mock draws
  /// NO shadow on any `.ptt` face, and the sentence that argued for one is no
  /// longer true of the surface it argued about: the dock is a bordered panel
  /// now, so the bar sits on a stated edge instead of floating on a page.
  /// Contract §1's last row also forbids adding shadow weight in dark.
  /// `git log -S _glow` is where the old rule lives.

  @override
  void initState() {
    super.initState();
    _syncPulse();
  }

  @override
  void didUpdateWidget(PttBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.visual != widget.visual) _syncPulse();
  }

  void _syncPulse() {
    if (_shouldPulse) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else if (_pulse.isAnimating) {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  void _onCancelZoneChanged(bool inZone) {
    if (!mounted) return;
    if (_cancelArmed == inZone) return;
    setState(() => _cancelArmed = inZone);
    _syncPulse();
  }

  Future<void> _handleDown() async {
    if (!_enabled) return;
    _cancelled = false;
    _cancelArmed = false;
    // P6 — render the 「starting microphone」 window instead of sitting silent
    // through it. The await below covers the permission gate + the native
    // recorder open (the slow half of the owner's measured ~2 s).
    if (mounted) setState(() => _starting = true);
    final bool ok = (await widget.onDown?.call()) ?? false;
    if (mounted) {
      setState(() => _starting = false);
    } else {
      _starting = false;
    }
    // A swipe-cancel can land during this await (the surface tracks the
    // pointer independently of this Future). If it did, the recording that
    // just started must be discarded — `_active` stays false so a later
    // pointer-up cannot send.
    if (_cancelled) {
      if (ok) unawaited(widget.onCancel?.call());
      _active = false;
      return;
    }
    _active = ok;
    // V2-04: confirm ONLY an accepted press — a refused one buzzes nothing.
    // R-UX-09 counts the same edge for the same reason: a refused press is not
    // usage, and counting it would inflate the very number ⑤ is judged on.
    // (P6 deliberately did NOT move this buzz to the accept edge: doing so
    // would confirm presses the gate is about to refuse, which is exactly
    // what V2-04 exists to prevent. The instant feedback is visual —
    // [_pressed] / [_starting].)
    if (ok) {
      _holdStartedAt = DateTime.now();
      countUsage(UsageEvent.pttHold);
      unawaited(FlowMicHaptics.pttDown());
    }
  }

  /// When the current accepted hold began. `null` between holds. Feeds the hold
  /// DURATION histogram — owner's 「说话按钮在最下面其实不太好按」("the talk
  /// button being at the very bottom is actually hard to press") is a claim about
  /// long dictations, and a mean that mixes 30 s holds with 1 s ones says nothing.
  DateTime? _holdStartedAt;

  /// Close the hold measurement exactly once, whichever way the hold ended.
  void _closeHold() {
    final DateTime? started = _holdStartedAt;
    _holdStartedAt = null;
    if (started != null) countHold(DateTime.now().difference(started));
  }

  Future<void> _handleSwipeCancel() async {
    if (_cancelled) return;
    _cancelled = true;
    if (!_active) return;
    _closeHold();
    countUsage(UsageEvent.pttCancel);
    unawaited(FlowMicHaptics.pttCancel());
    await widget.onCancel?.call();
  }

  Future<void> _handleUp() async {
    if (!_active) return;
    _active = false;
    if (_cancelled) return; // swipe-up already cancelled → no send, no row.
    _closeHold();
    countUsage(UsageEvent.pttSend);
    unawaited(FlowMicHaptics.pttSend());
    await widget.onUp?.call();
  }

  /// card U12 — the accessible alternative to the long-press gesture.
  ///
  /// The control's payload is press DURATION: an assistive-technology default
  /// activation (TalkBack/Switch Access double-tap or single-activate) opens
  /// and closes a gesture recognizer in the same frame, so wiring
  /// `Semantics.onTap` straight through to a synthetic down+up pair would
  /// produce a `Semantics(button:true)` that LOOKS accessible and captures an
  /// empty utterance — exactly the fake affordance this project's red line
  /// forbids ("a control that changes nothing is worse than no control").
  ///
  /// So activation here is a TOGGLE, not a synthetic tap: the first
  /// activation starts the hold (same gate, same FSM edge as [_handleDown]),
  /// a SECOND, independent activation ends it (same as [_handleUp]). The
  /// interval between the two real user actions is what carries the
  /// recording — the same contract as press-and-hold, expressed as two
  /// discrete steps instead of one continuous gesture. [_active] is the
  /// single source of truth already used by the touch path, so a touch hold
  /// in flight and an AT-driven hold in flight can never disagree about
  /// which edge happens next.
  ///
  /// 🔴 DOCUMENTED GAP (not fixed by this card): the swipe-up cancel gesture
  /// has no AT-accessible equivalent here. An AT user who starts a hold this
  /// way can only end it by finishing normally (→ sent) — there is no
  /// accessible "discard instead" action. Adding one needs a
  /// `CustomSemanticsAction` with its own reviewed copy (this file does not
  /// own the strings shard), so it is left as an explicit open item rather
  /// than silently reusing a label that does not say "cancel".
  Future<void> _handleSemanticActivate() async {
    if (_active) {
      await _handleUp();
    } else {
      await _handleDown();
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings ?? AppStrings.of(AppLocale.zh);
    // One solid fill + one ink per face, straight off the mock's `.ptt`
    // classes. `onPri` is used ONLY on the pri-filled idle face — it is white
    // in light and #131318 in dark, which is the dark boards' explicit rule
    // (`<div class="ptt" style="color:#131318">`, A-D1). Every other face is a
    // fill the dark mock does not re-tint, so its ink stays white in both
    // themes ([FlowMicColors.onBrandInk]).
    var (Color bg, Color fg, String label) = switch (widget.visual) {
      PttVisual.idle => (
        FlowMicDockColors.pri,
        FlowMicDockColors.onPri,
        s.pttHold,
      ),
      // P5 (0.3.1, owner 2026-08-15) — a LIVE face, no longer the mock's
      // `.ptt.gry` grey: that grey is the dock's 「off」 vocabulary (see
      // [PttVisual.disabled] below) and the owner read this working button as
      // unusable. Amber wash + amber ink = the app's existing light-notes hue;
      // full reasoning at [FlowMicDockColors.notedSoft].
      PttVisual.noted => (
        FlowMicDockColors.notedSoft,
        FlowMicDockColors.notedInk,
        s.pttHoldNoted,
      ),
      // 🔴 `recFill`, NOT `rec`. `.ptt.rec{background:#DC2626}` has no `.dk`
      // override, so the dark board A-D2 draws this bar at the SAME red as the
      // light one; only the accents around it (bars, timer, live dot) go
      // #F87171 in dark, and those are what `rec` answers for. Reading the mock
      // literally is also what keeps this label legible: white on #DC2626 is
      // 4.83:1 in both themes, where white on #F87171 was 2.77:1.
      PttVisual.recording => (
        FlowMicDockColors.recFill,
        FlowMicColors.onBrandInk,
        s.pttRecording,
      ),
      PttVisual.processing => (
        FlowMicDockColors.processing,
        FlowMicColors.onBrandInk,
        s.pttProcessing,
      ),
      PttVisual.justDone => (
        FlowMicDockColors.doneFlash,
        FlowMicColors.onBrandInk,
        s.pttJustDone,
      ),
      PttVisual.disabled => (
        FlowMicDockColors.chipbg,
        FlowMicDockColors.sub,
        s.pttDisabled,
      ),
    };
    // Mock motion table: 位移过阈值时条变灰「松开 取消」("once displacement
    // crosses the threshold, the bar turns gray 'release to cancel'").
    // Overlay, not a
    // sixth FSM face — the session is still RECORDING until release.
    if (_cancelArmed) {
      // Since P5 recoloured the noted face, this grey is unambiguous again:
      // it appears ONLY as the release-to-cancel overlay (the mock's own
      // motion rule) and can no longer be mistaken for a resting face.
      bg = FlowMicDockColors.recordOnly;
      fg = FlowMicColors.onBrandInk;
      label = s.pttCancelArmed;
    } else if (_starting) {
      // P6 — accepted press, recorder not open yet. Label only; the fill
      // stays the resting face's (with the pressed tint below), so the red
      // recording vocabulary is not borrowed for a window that is not
      // recording.
      label = s.pttStartingMic;
    }
    // P6 — the 0 ms acknowledgement: finger down ⇒ the resting fill darkens
    // one step. Gated to the two resting faces so it never repaints the
    // recording/processing faces mid-hold (the finger stays down through the
    // whole recording — a persistent tint there would dim the pulse).
    final bool restingFace =
        widget.visual == PttVisual.idle || widget.visual == PttVisual.noted;
    if (_pressed && !_cancelArmed && restingFace) {
      bg = Color.alphaBlend(fg.withValues(alpha: 0.12), bg);
    }

    // The leading glyph, per mock frame. Three faces deliberately have NONE:
    // A-03/A-04 (`● 松开 结束` "release to finish"), A-05 (`处理中…`
    // "processing…") and A-10
    // (`未连接 · 暂时不能说话` "not connected · can't talk right now") are all
    // label-only — a mic on the recording face
    // would be saying 「speak」 to someone already speaking.
    // ⚠️ justDone has no mock frame at all (the boards never drew the 1.5s
    // confirmation), so it KEEPS its existing ✓ rather than inheriting a rule
    // the design never stated for it.
    final Widget? leading = _cancelArmed
        ? null
        : switch (widget.visual) {
            PttVisual.idle || PttVisual.noted => MicGlyph(size: 17, color: fg),
            PttVisual.justDone => Icon(Icons.check, size: 19, color: fg),
            PttVisual.recording ||
            PttVisual.processing ||
            PttVisual.disabled => null,
          };

    // 🔴 A LAYOUT GLYPH, NOT A COPY EDIT. The mock's recording face reads
    // `● 松开 结束`("release to finish"); our sentence
    // (`AppStrings.pttRecording`) is owner-frozen
    // copy and is NOT touched — the dot is concatenated here, the same way the
    // policy chip's ` ⇄` is. It stays out of the a11y label below, where a
    // screen reader would pronounce it as a symbol name.
    final String painted = widget.visual == PttVisual.recording && !_cancelArmed
        ? '● $label'
        : label;

    final Widget bar = Container(
      // Identity for tests. They used to locate this bar by `maxHeight == 56`,
      // so V2-03's 56 → 64 broke assertions that were only ever about COLOUR —
      // a magic dimension is not identity. Find it by key; resize freely.
      key: const ValueKey<String>('ptt.bar'),
      // V2-03 (owner ⑤: 「说话按钮在最下面其实不太好按」"the talk button
      // being at the very bottom is actually hard to press"). 56 → 64.
      //
      // This is a leverage problem, not a hit-target one. A short tap at the
      // bottom edge is fine — but dictation here runs 30 s+, and holding the
      // very bottom edge means the little finger carries the phone while the
      // thumb presses against the worst possible moment arm, so the grip is
      // least stable exactly when the hold is longest. WeChat puts its voice
      // bar on the edge because it is a SHORT-utterance product; this one is
      // not, so the same placement does not follow.
      //
      // The taller bar plus the safe-area gap below (see chat_flow_page) moves
      // the press point up off the physical edge without changing where the eye
      // expects the control to be.
      //
      // card U12 — the number is a FLOOR, not a fixed size. It used to be
      // `height: 64` (a hard, tight size), and at a 1.5–2.0 OS text-scale
      // factor the label ("Release to send · swipe up to cancel" is the
      // longest) grows wider than the bar while the Row below stayed
      // `mainAxisSize.min` with no flex child — `RenderFlex overflowed … on
      // the right`, the classic yellow/black stripes, reproduced in
      // ptt_bar_a11y_test.dart before that fix (assertion caught via
      // `tester.takeException()`). `minHeight` lets the bar grow when the
      // now-wrapped label needs a second line instead of clipping it — a user
      // who asked the OS for bigger text is asking to read it, not to have it
      // cut off silently.
      //
      // ⚠️ WP8 VF-2 lowered the floor 64 → 60 (`.ptt{height:60px}`). V2-03's
      // reason for raising it (「说话按钮在最下面其实不太好按」"the talk
      // button being at the very bottom is actually hard to press" — a 30 s
      // hold at
      // the worst moment arm) is answered by the composer's bottom gap, which
      // is UNCHANGED; the 4dp came off the bar itself, not off that gap.
      constraints: const BoxConstraints(minHeight: 60),
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(17),
        // P5 — the noted face's wash is translucent, so it borrows the dock
        // panel's lightness; the 1.5px amber outline is what makes it read as
        // a bounded, pressable control rather than a tinted strip. Same
        // border recipe the amber connection-identity card already uses.
        // Absent on every other face (and under the armed overlay), whose
        // solid fills carry their own edge.
        border: widget.visual == PttVisual.noted && !_cancelArmed
            ? Border.all(
                color: FlowMicDockColors.notedInk.withValues(alpha: 0.65),
                width: 1.5,
              )
            : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (leading != null) ...<Widget>[
            leading,
            const SizedBox(width: 10),
          ],
          // Flexible (not a bare Text): at large text-scale the label must be
          // ALLOWED to wrap to a second line instead of forcing the Row wider
          // than its parent — see the constraints comment above for the
          // reproduction. `excludeSemantics` on the wrapping Semantics node
          // (below) means this Text's own auto-generated semantics node is
          // dropped, so wrapping it does not create a second, duplicate
          // announcement.
          Flexible(
            child: Text(
              painted,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: fg,
                fontSize: 17,
                fontWeight: FontWeight.w700,
                // `.ptt{letter-spacing:1px}`, and `.ptt.dis{letter-spacing:0}`
                // — the disabled face is the one the mock does NOT track out.
                letterSpacing:
                    widget.visual == PttVisual.disabled ? 0 : 1,
              ),
            ),
          ),
        ],
      ),
    );

    // card U12 — this GestureDetector had ZERO Semantics anywhere in the file:
    // an assistive-technology user got a mystery unlabelled region that does
    // nothing on its default activation gesture (see [_handleSemanticActivate]
    // for why a naive `onTap` here would be worse — a fake affordance, not a
    // missing one). `excludeSemantics: true` drops the child Text/Icon's own
    // auto-generated nodes so `label` below is the ONE thing announced, not a
    // duplicate.
    return Semantics(
      container: true,
      button: true,
      enabled: _enabled,
      label: label,
      liveRegion: true,
      excludeSemantics: true,
      onTap: _enabled ? _handleSemanticActivate : null,
      child: HoldToTalkSurface(
        enabled: _enabled,
        onAccepted: _handleDown,
        onRelease: _handleUp,
        onSwipeCancel: _handleSwipeCancel,
        onCancelZoneChanged: _onCancelZoneChanged,
        // P6 — the surface's geometry hooks double as the pressed edge: down
        // fires immediately on contact, settled fires exactly once on
        // up/cancel (_finish). This is what makes the 0 ms tint possible
        // without a second gesture layer.
        onPointerDown: (_) {
          if (_enabled && mounted) setState(() => _pressed = true);
        },
        onPointerSettled: () {
          if (_pressed && mounted) setState(() => _pressed = false);
        },
        child: _shouldPulse ? _pulsing(bar) : bar,
      ),
    );
  }

  /// The demo's `brightness(1 → 1.18)` breathe, expressed as a light wash over
  /// the red fill (a ColorFilter would also tint the label).
  ///
  /// 🔴 A REAL-STATE animation, kept: it says 「录音正在进行」("recording is
  /// in progress"), which is a fact
  /// about the machine and not a decoration the mock could drop. Only its
  /// COLOUR moved — the wash was a hard-coded 0xFFFFFFFF white (one of the
  /// four ptt_bar entries the design-token-literals allowlist used to pin,
  /// pruned with WP8) and is now the same [FlowMicColors.onBrandInk] the
  /// recording label wears, so the two whites on this face are one token
  /// instead of two literals.
  Widget _pulsing(Widget bar) => AnimatedBuilder(
    animation: _pulse,
    builder: (BuildContext context, Widget? child) => DecoratedBox(
      position: DecorationPosition.foreground,
      decoration: BoxDecoration(
        color: FlowMicColors.onBrandInk.withValues(
          alpha: 0.14 * _pulse.value,
        ),
        borderRadius: BorderRadius.circular(17),
      ),
      child: child,
    ),
    child: bar,
  );
}

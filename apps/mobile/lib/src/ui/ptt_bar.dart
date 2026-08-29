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
// NR-4 (g): `widgets.dart` re-exports `rendering.dart` for exactly one symbol
// and does not carry the semantics library, so the custom-action type has to be
// asked for by name.
import 'package:flutter/semantics.dart' show CustomSemanticsAction;

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

  /// 🔴 0.3.43 Q5-① — the finger LIFTED while [_starting] was still true.
  ///
  /// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §2 (dated correction: PTT down is
  /// an ASYNC edge, not the ≤50 ms synchronous one the book used to claim) and
  /// docs/rebuild/17-SPEECH-PIPELINE-STATES-AND-FLOW.md §1 (the RECORDING exits
  /// table); ruling
  /// docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q5-①.
  ///
  /// A press is accepted 300 ms in ([HoldToTalkSurface.acceptHold]) and
  /// [_handleDown] then awaits the whole data layer — permission gate + native
  /// recorder open, MEASURED at ~2 s on the owner's tablet. A short press (hold
  /// 1–2 s, release) therefore lifts INSIDE that window, and [_handleUp]'s
  /// `if (!_active) return;` used to drop that release on the floor. Nothing
  /// downstream ever learned the finger was gone: the FSM entered RECORDING a
  /// moment later and had no exit left but the server's 5-minute cap or a link
  /// drop, so the phone said 「转录中」 ("transcribing") forever.
  ///
  /// 🔴 THE ASYMMETRY IS THE WHOLE BUG, AND THE FIX IS ITS MIRROR. The
  /// swipe-cancel path has always been correct in this same window:
  /// [_handleSwipeCancel] sets `_cancelled` BEFORE the identical `!_active`
  /// guard, and [_handleDown] replays it after the await. Release did the
  /// opposite — it read a flag it could not yet be true for, and returned. One
  /// window, two gestures, two different treatments; only one of them was
  /// written down.
  ///
  /// ⚠️ WHAT THIS IS NOT: it is NOT a watchdog on RECORDING. That debt is real
  /// and still open — owner deferred it explicitly (ruling Q5-④), and it needs a
  /// new `SttStallReason` plus new user-visible copy, both of which are his
  /// call. This flag closes the one entry we can name and prove; it does not
  /// claim RECORDING can no longer stick.
  bool _releasedDuringActivation = false;

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

  /// 🔴 NR-4-P1 (a) — `justDone` LEFT this set and that is the whole change.
  ///
  /// The bar is the FIRST of four gates a press meets (this one, then
  /// `ChatController.canPtt`, then `PttSession.pttDown`, then the FSM's
  /// `onPttDown`); the other three now read one shared predicate,
  /// [sessionAcceptsPttDown]. This one cannot — it is handed a [PttVisual],
  /// not a `SessionState`, and it must stay that way: the widget takes a face,
  /// which is what lets every face be driven directly from a test. The mapping
  /// is one line in chat_flow_composer.dart and is 1:1, so 「justDone is
  /// pressable」 is said in exactly two places, both of them here.
  ///
  /// WHY IT WAS WRONG TO BLOCK: `justDone` is a 1500 ms green ✓ over an
  /// utterance that has ALREADY produced its final and its row. Refusing a
  /// press there bought nothing and cost every continuous dictation a pause
  /// (NR-4 ledger §4 row a). `processing` stays in this set — see
  /// [sessionAcceptsPttDown] for why that boundary is a state-machine
  /// question and not a widened set.
  bool get _enabled =>
      widget.visual != PttVisual.disabled &&
      widget.visual != PttVisual.processing;

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

  /// 🔴 NR-4 (g): `_active` became a RENDERED fact the day the cancel action
  /// started keying off it, so every write has to schedule a frame. Before
  /// this, the two writes below happened to be followed by a `setState` for
  /// `_starting`, and the two that end a hold were followed by nothing — so a
  /// finished hold would have kept offering 「cancel this recording」 until
  /// something else rebuilt the bar. Measured by the test that asserts the
  /// action disappears again.
  void _setActive(bool v) {
    if (_active == v) return;
    if (mounted) {
      setState(() => _active = v);
    } else {
      _active = v;
    }
  }

  Future<void> _handleDown() async {
    if (!_enabled) return;
    // 🔴 0.3.43 Q5-① — ONE activation at a time.
    //
    // The accept edge is a timer on the SURFACE, so a release-then-re-press
    // inside the ~2 s activation window opens a SECOND [_handleDown] while the
    // first is still awaiting `audio.start()`. Two things went wrong with that:
    // the second `session.pttDown()` re-entered the native recorder open while
    // the first had not returned, and — once [_releasedDuringActivation]
    // existed — the second activation's flag reset would have EATEN the first
    // press's replayed release, i.e. re-created the very stuck RECORDING this
    // card is closing, in a narrower window.
    //
    // ⚠️ STATED PLAINLY: the second press is then IGNORED. That is a deliberate
    // trade, not an oversight — the first press owns the utterance and its
    // release is what gets replayed. The pressed tint still fires on contact
    // ([_pressed] is driven by the raw pointer, not by this gate), so the
    // second press is not a control that looks alive and does nothing; it is a
    // press that lands on a bar already opening a microphone.
    if (_starting) return;
    _cancelled = false;
    _cancelArmed = false;
    _releasedDuringActivation = false;
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
      _setActive(false);
      return;
    }
    _setActive(ok);
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
    // 🔴 0.3.43 Q5-① — the replay. See [_releasedDuringActivation].
    //
    // Placed AFTER the `_cancelled` fork above on purpose: a swipe-cancel that
    // landed in the same window must still discard, and a release that arrived
    // before it is not a second opinion.
    //
    // `ok == false` needs no branch of its own: [_handleUp] opens with
    // `if (!_active) return;` and `_setActive(false)` has just run, so a
    // refused press replays into a no-op — a press the gate turned down has no
    // release to honour.
    //
    // ⚠️ The hold-duration histogram will record ~0 ms for these, and that is
    // the TRUTH about this hold rather than a rounding artefact: the user let
    // go before the microphone was open. `_holdStartedAt` has always been
    // stamped at the accept-completion edge, not at contact.
    if (_releasedDuringActivation) {
      _releasedDuringActivation = false;
      await _handleUp();
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
    // 🔴 NR-4 (g): closing `_active` HERE, not only in [_handleUp].
    //
    // On the touch path this changes nothing observable — the finger still
    // lifts afterwards, `_handleUp` still refuses to send (it checked
    // `_cancelled`), and `_closeHold` is idempotent. On the ACCESSIBLE path it
    // is the whole difference: an AT cancel has no release to follow it, so
    // leaving `_active` true would (a) keep offering 「cancel this recording」
    // for a recording that is over and (b) make the user's NEXT activation land
    // on [_handleUp] — i.e. 「cancel, then activate again」 would SEND. Measured
    // by the case that asserts the action disappears again.
    _setActive(false);
    _closeHold();
    countUsage(UsageEvent.pttCancel);
    unawaited(FlowMicHaptics.pttCancel());
    await widget.onCancel?.call();
  }

  Future<void> _handleUp() async {
    if (!_active) {
      // 🔴 0.3.43 Q5-① — this used to be the whole story (`if (!_active)
      // return;`), and it is where a short press went to die. The surface only
      // calls this after the hold was ACCEPTED, so reaching here with
      // `_active == false` means one of exactly three things:
      //   · [_starting] — the accept edge fired and the data-layer chain has
      //     not come back yet ⇒ RECORD IT, [_handleDown] replays it;
      //   · [_cancelled] — a swipe-cancel already claimed this hold ⇒ the
      //     cancel wins, nothing to replay;
      //   · neither — the gate refused the press, so there is no utterance and
      //     no release to honour.
      if (_starting && !_cancelled) _releasedDuringActivation = true;
      return;
    }
    _setActive(false);
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
  ///
  /// ✅ **CLOSED 2026-08-27 (NR-4 (g)).** The paragraph above is kept because
  /// it is the record of what was owed and why; the debt itself is paid three
  /// lines down in [build], as a `CustomSemanticsAction` labelled
  /// `AppStrings.pttCancelSemanticAction` and wired to [_handleSwipeCancel] —
  /// the SAME function the finger gesture calls, so the two paths cannot drift
  /// into two different notions of what cancelling does.
  /// SPEC-REF: docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §4
  ///
  /// 🔴 0.3.43 Q5-① — the second term is the AT half of the short-press fix.
  /// An AT user's second activation can land inside the ~2 s activation window
  /// just as a finger can, and without `|| _starting` it would fall into
  /// [_handleDown] — which now refuses a re-entrant activation — leaving the
  /// hold open with no way to end it. Routing it to [_handleUp] instead lets
  /// that function record the release for replay, exactly as the touch path
  /// does. Same single source of truth, same two edges.
  Future<void> _handleSemanticActivate() async {
    if (_active || _starting) {
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
      // ── P5 → P5b, the same control iterated twice in one day ──────────────
      // P5 (0.3.1, owner 2026-08-15) took this face off the mock's `.ptt.gry`
      // grey, because that grey is the dock's 「off」 vocabulary
      // ([PttVisual.disabled] below) and the owner read a working button as
      // unusable. It landed on an amber WASH with a 1.5 px amber outline.
      //
      // 🔴 P5b (owner, same day): 「土黄色有边框的按钮看起来与整个 APP 的设计
      // 语言不一致」 — and he is right in the file's own terms. The rule two
      // comments up is 「One solid fill + one ink per face」, and the outline
      // branch that used to sit in the decoration below said so out loud:
      // 「Absent on every other face, whose solid fills carry their own edge」.
      // A translucent tint with a hairline border is this app's CHIP/BADGE
      // construction (connection cards, status pills). Wearing it, the primary
      // action of the whole screen read as a label strip that had wandered into
      // the dock.
      //
      // ⇒ back to the shared construction, at the SAME `pri` fill as idle. The
      // fill is not where this mode lives: P5's own token note stated the
      // division of labour — 「MODE identity is carried by the label + header
      // dot; the fill only answers 「can this be pressed」」 — and then P5 broke
      // it by making the fill answer both. Record-only is said
      // three times already and none of them is a colour: this button's own
      // label (「按住 说话 · 仅记录」), the caption under it (「松开后只保存在
      // 手机，不发往电脑」), and the header's 「→ 仅记录」 pill.
      //
      // ⚠️ THE TRADE, STATED: idle and record-only now differ by LABEL, not by
      // fill. That is the deliberate half of the change, not a side effect — a
      // fifth fill would have to be either a state colour already spoken for
      // (red recording / amber processing / green flash / grey off) or a hue
      // invented for this one control, and this file's header forbids the
      // second (「the widgets must not invent colours」).
      PttVisual.noted => (
        FlowMicDockColors.pri,
        FlowMicDockColors.onPri,
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
      // 🔴 NR-4-P1 (a) —「label only」 was true while `_starting` could only
      // ever sit on a resting face. A press is now accepted on `justDone`
      // too, and there the untouched fill is the GREEN done flash: the bar
      // would read 「正在启动麦克风」 ("starting the microphone") on a face
      // whose entire meaning is 「上一句已经完成」 ("the previous sentence is
      // finished") — a wrong status word with no failure anywhere (R11).
      // The press dismisses the face at once instead. `pri` is not a fourth
      // colour: P5b made idle and record-only the SAME `pri` fill, so the
      // resting face is unambiguous here even though this widget is not told
      // which of the two it would have returned to.
      if (widget.visual == PttVisual.justDone) {
        bg = FlowMicDockColors.pri;
        fg = FlowMicDockColors.onPri;
      }
    }
    // P6 — the 0 ms acknowledgement: finger down ⇒ the resting fill darkens
    // one step. Gated to the two resting faces so it never repaints the
    // recording/processing faces mid-hold (the finger stays down through the
    // whole recording — a persistent tint there would dim the pulse).
    // 🔴 NR-4-P1 (a) — `justDone` joins the two resting faces here for the
    // same reason it left `_enabled`: it is now a face a press LANDS on, and
    // the whole point of this tint is that a finger down is acknowledged in
    // 0 ms. Left out, the one face the ledger's row (a) is about would be the
    // one face that still looks ignored for the length of the accept window.
    // The excluded faces are unchanged and still excluded for P6's reason:
    // recording/processing hold the finger down for the whole utterance.
    final bool restingFace =
        widget.visual == PttVisual.idle ||
        widget.visual == PttVisual.noted ||
        widget.visual == PttVisual.justDone;
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
    // 🔴 NR-4-P1 (a) — the ✓ is suppressed for the same window the green fill
    // is (`_starting` on the done face): the glyph and the fill say the same
    // thing, so retiring one and keeping the other would leave a checkmark
    // sitting beside 「正在启动麦克风」. DELIBERATELY narrow — the two resting
    // faces keep their mic glyph through `_starting` exactly as before, and
    // ptt_feedback_stages_test.dart pins that.
    final Widget? leading =
        _cancelArmed || (_starting && widget.visual == PttVisual.justDone)
        ? null
        : switch (widget.visual) {
            PttVisual.idle || PttVisual.noted => MicGlyph(
              size: kSpeakControlGlyphSize,
              color: fg,
            ),
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
      //
      // 🔴 NR-4 (d), 2026-08-27: the number is now [kSpeakControlHeight],
      // SHARED with the edit sheet's append button. It is still a floor and
      // still 60 — what changed is that the sheet's button can no longer drift
      // away from it, which is the whole content of option B.
      constraints: const BoxConstraints(minHeight: kSpeakControlHeight),
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(kSpeakControlRadius),
        // 🔴 P5b — NO `border` on any face, and that is the whole point rather
        // than a cleanup. P5 needed one because its noted fill was translucent
        // (a wash borrows the dock panel's lightness and stops reading as a
        // bounded control); P5b's noted fill is the solid `pri` every other
        // resting face uses, and a solid fill carries its own edge. Adding the
        // outline back would re-import the chip vocabulary the owner rejected.
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
      // NR-4 (g) — the accessible half of swipe-up-to-cancel.
      //
      // 🔴 REGISTERED ONLY WHILE A HOLD IS LIVE. An always-present 「cancel
      // this recording」 in the actions rotor, at a moment when there is no
      // recording, is the accessibility form of this repo's oldest red line: a
      // control that cannot change anything is worse than no control. `_active`
      // is the same single source of truth the touch path uses, so the action
      // exists exactly when cancelling is a real thing to do.
      //
      // ⚠️ It does NOT ask how the hold started. There is no cheap way to tell
      // an AT-opened hold from a finger-opened one, and it does not matter:
      // firing it during a touch hold discards that utterance, which is what
      // its label says it does.
      customSemanticsActions: _active
          ? <CustomSemanticsAction, VoidCallback>{
              CustomSemanticsAction(label: s.pttCancelSemanticAction):
                  () => unawaited(_handleSwipeCancel()),
            }
          : null,
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
        borderRadius: BorderRadius.circular(kSpeakControlRadius),
      ),
      child: child,
    ),
    child: bar,
  );
}

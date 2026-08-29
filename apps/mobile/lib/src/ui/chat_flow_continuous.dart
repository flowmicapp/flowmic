// Part of chat_flow_page.dart — CARD CR-9's WIRING: the continuous-recording
// entry, its pre-flight sheet, and the in-progress face.
//
// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.A (where the entry may appear), §5-1..§5-8, §6 C1 / C6 / C7 / C8
//   docs/ui-design/2026-08-29-continuous-recording-demo.html (A / B / C)
//   apps/mobile/lib/src/audio/continuous_offer.dart — the DECISION
//   apps/mobile/lib/src/ptt/ptt_continuous.dart — the LIFECYCLE
//
// A `part` at the 800-line cap, like the eleven before it. What is here is the
// PLUMBING; the decision is pure and lives in `continuousOffer`, the faces are
// plain widgets, and the session lifecycle is one begin / one end. This file
// exists so those three can be joined without any of them knowing about the
// other two.

part of 'chat_flow_page.dart';

/// What the entry should do and say right now, or null when this build does not
/// offer continuous recording at all.
///
/// 🔴 NULL AND `visible: false` ARE DIFFERENT ANSWERS AND BOTH MEAN 「no entry」.
/// The distinction is not pedantry — it is the difference between two questions
/// that must never share a value:
///   · null              — nobody wired an account source: a standalone
///                         instance, a self-hosted relay, this page inside a
///                         test. The feature is not on offer here.
///   · `visible: false`  — the destination injects into a PC. The feature
///                         exists, this dock is not where it lives (ruling ⑧
///                         asks for 零 diff on a paired dock).
/// A third case sits inside [ContinuousOffer] itself: OFFERED, and we could not
/// read the ceiling — which draws, disabled, and says so. Collapsing any two of
/// these would produce a face that is wrong in a way nobody can report.
ContinuousOffer? _continuousOfferRouted(
  _ChatFlowPageState s,
  PttVisual visual,
) {
  final CloudSummaryController? account = s.widget.cloudSummary;
  if (account == null) return null;
  return continuousOffer(
    recordOnly: s.controller.destination.isRecordOnly,
    mode: s.controller.mode,
    // ⚠️ Read off the FACE, not off `ConnectionState` a second time. `visual`
    // is already the composer's one answer to 「is the link up」 (its
    // `PttVisual.disabled` arm), and a second derivation here could disagree
    // with the bar sitting directly underneath this row.
    linkUp: visual != PttVisual.disabled,
    summary: account.summary,
  );
}

/// The entry row, or null when there is nothing to draw.
///
/// ⚠️ Gated on [idleRows] by its caller as well as on the offer: during
/// recording the dock is PTT-only (contract §4 A3–A5), and an entry that
/// survived into that face would be a second control competing with the one
/// thing the user is doing.
Widget? _continuousEntryRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  PttVisual visual,
) {
  final ContinuousOffer? offer = _continuousOfferRouted(s, visual);
  if (offer == null || !offer.visible) return null;
  return ContinuousEntryRow(
    offer: offer,
    strings: strings,
    onStart: () => unawaited(_startContinuousRouted(s, context, strings)),
  );
}

/// Brief the user, then start — or don't.
///
/// 🔴 THE OFFER IS RE-READ AFTER THE SHEET CLOSES, and that is not paranoia: the
/// sheet is modal and stays open for as long as somebody reads it. In that time
/// the link can die, the account can refresh, another phone can take the
/// capsule. Starting on the strength of a decision taken before all that would
/// be acting on a fact we stopped checking — and this is the one place in the
/// flow where a stale 「yes」 turns into a live microphone.
Future<void> _startContinuousRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
) async {
  final PttVisual before = _pttVisualRouted(s);
  final ContinuousOffer? offer = _continuousOfferRouted(s, before);
  if (offer == null || !offer.enabled) return;
  final bool go = await askToStartContinuous(
    context,
    offer: offer,
    strings: strings,
  );
  if (!go || !s.mounted) return;

  final ContinuousOffer? now = _continuousOfferRouted(s, _pttVisualRouted(s));
  final int? cap = now?.capMinutes;
  if (now == null || !now.enabled || cap == null) return;

  // 🔴 THE FLAG GOES UP BEFORE THE CAPTURE STARTS, NOT AFTER. Between these two
  // lines a link death would reach `ptt_link_loss.dart`, and it decides whether
  // to keep the microphone open by reading exactly this flag. Setting it
  // afterwards would leave a window in which a continuous recording is torn
  // down as though it were an ordinary press.
  s.controller.session.beginContinuous(
    cap: Duration(minutes: cap),
    onWarning: () => s.controller.noteContinuousCapWarning(),
  );
  final bool ok = await _pttDownRouted(s);
  if (!ok) {
    // A refused press (permission, FSM, a recorder that would not open) leaves
    // three things switched on for a recording that never began — including a
    // ceiling that would fire minutes later and announce a limit nobody
    // reached. There is no recorder transition to clear the flag for us here,
    // because there was no recorder.
    s.controller.session.endContinuous();
  }
}

/// The in-progress face, or null when this is not a continuous recording.
///
/// It REPLACES the push-to-talk bar rather than sitting above it — §5-8's mutual
/// exclusion, and the plainest form of it: while this is on screen there is no
/// hold surface to press, no mode row (the dock is past its idle faces) and no
/// cancel gesture anywhere.
Widget? _continuousLiveRouted(
  _ChatFlowPageState s,
  AppStrings strings,
  PttVisual visual,
) {
  if (visual != PttVisual.recording) return null;
  final PttSession session = s.controller.session;
  if (!session.continuous.isActive) return null;
  // The ceiling that armed the clock, never the account's current value — see
  // `ContinuousCapTimer.armedCap`. Null would mean the clock is not running, at
  // which point this face has no countdown to show and must not invent one.
  final Duration? cap = session.capTimer.armedCap;
  if (cap == null) return null;
  return ContinuousLiveBar(
    remaining: cap - s.controller.recordingElapsed,
    amplitudeWindow: s.controller.amplitudeWindow,
    segmentCount: session.segments.finalizedCount,
    screenHeld: session.screenWake.isHeld,
    strings: strings,
    onStop: () => unawaited(s.controller.pttUp()),
  );
}

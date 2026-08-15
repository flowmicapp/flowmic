// Part of chat_flow_page.dart — the PTT caption family (PA-2).
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason as chat_flow_pager_sync.dart / chat_flow_scroll.dart /
// ptt_wire_keepalive.dart: chat_flow_composer.dart went over the 800-line cap
// (`verify/lint/file-size.mjs` SRC_MAX=800) when P3 (0.3.1) taught the tablet
// arrangement to hold its two-column skeleton through the recording faces.
// This is a LINE-COUNT split, not an architecture statement.
//
// The family chosen is the caption under the PTT bar — one concern, four
// members, one call seam: [pttCaption] (the ONE selector, public so
// ptt_caption_test.dart can drive the processing/justDone branches directly),
// [_peerNameRouted] (its pcName input), [_dockCaptionRouted] (the dock slot
// renderer, including the press-stability ghost) and [_captionText] (the one
// Text author that ghost shares). The family's only callers outside itself
// are the two arrangement builders in chat_flow_composer.dart
// (`_dockTabletRouted` / `_dockPhoneRouted`), each calling
// `_dockCaptionRouted` once.
//
// 🔴 DIFF DISCIPLINE: all four bodies and every comment moved
// **character-for-character** out of chat_flow_composer.dart. **Any other
// difference in the diff is a bug.**

part of 'chat_flow_page.dart';

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

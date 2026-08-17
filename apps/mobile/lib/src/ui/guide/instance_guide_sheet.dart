// SPEC-REF:
//   the page it narrates: apps/mobile/lib/src/ui/connections_page.dart
//     (the instance list — the app startup home)
//   the vocabulary it explains: apps/mobile/lib/src/session/pc_presence.dart
//     (`InstanceLivenessFace` — one face per status word)
//   design: docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §3 (this
//     guide), §5 W-4 (copy), §6 (the five anti-drift rules)
//   entry choice: docs/decisions/2026-08-06-p-wave-choices-by-first-responsible
//     .md P-7 7-4 — owner took option A, a "?" in the top bar.
//
// P-7 ② — the instance list's 「point to re-read」 guide.
//
// WHY A SHEET AND NOT A FULL-SCREEN PAGE. DataFlowDisclosureEntry, three files
// over, pushes a route; this does not, and the difference is not a preference.
// That page is a document read start to finish, and hiding the app behind it
// costs nothing. This guide is a CAPTION for the list the user is looking at —
// it names rows, status words and gestures that are on screen right now. A
// full-screen route would cover the exact thing every sentence points at.
//
// WHY IT NEVER OPENS BY ITSELF (§3.3). Only a tap on the "?" shows it. The
// first-run onboarding already answers the first-time question, and the same
// content arriving unbidden twice is an interruption, not help.
//
// 🔴 WHAT THIS FILE IS NOT ALLOWED TO CONTAIN, and why each is a rule:
//   · No copied literal for any button name, tab name or status word (§6-1).
//     Every one of them is read from the live getter the real page renders, so
//     a re-wording over there arrives here for free. Where a sentence has to
//     embed one, the sentence takes it as a parameter.
//   · No operable control that does anything (repo red line, 0.2.27: a control
//     that changes nothing is worse than no control). The only tappable things
//     here are 「close」 and 「close」.
//   · No mechanism. 「We reached that PC just now」, not 「GET /api/health plus
//     GET /api/pc/presence」 (§3.2 item 5).
//
// ⚠️ A DELIBERATE DEPARTURE FROM THE DESIGN DOC, stated so it is not read as an
// oversight. §3.2 item 2 sketches the status list with its dot colours (「在线
// （绿点）」("online (green dot)")). This renders the WORDS only, no coloured
// dots. Reproducing the
// colours would mean a second copy of the face→colour mapping that
// connections_page.dart `_statusLabel` owns, and there is no cheap way to pin
// two copies together — a guide that quietly disagreed with the page about
// which face is amber would be exactly the drift §6 exists to prevent. The
// words are the part that carries the meaning, and they are same-sourced.

import 'package:flutter/material.dart';

import '../../session/pc_presence.dart';
import '../../settings/app_strings.dart';
import '../tokens.dart';

/// The "?" in the instance list's top bar. Lives here, next to the thing it
/// opens, so 「the guide exists」 and 「the page mounts it」 are one file's worth
/// of truth to read.
///
/// Sized like its two neighbours (18px glyph in an 8px pad ⇒ a 34dp tap cell)
/// — NOT like the ✕ in the add-pairing sheet, which is a bare 18×18 icon with
/// no padding and therefore a tap target well under the platform minimum.
class InstanceGuideButton extends StatelessWidget {
  const InstanceGuideButton({super.key, required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) => InkWell(
    key: const ValueKey<String>('connections.guide'),
    onTap: () => showInstanceGuide(context, strings: strings),
    borderRadius: BorderRadius.circular(10),
    child: Tooltip(
      message: strings.guideInstancesTitle,
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Icon(Icons.help_outline, size: 18, color: FlowMicColors.t2),
      ),
    ),
  );
}

/// The reading order of the status words. Deliberately NOT
/// `InstanceLivenessFace.values`: that is declaration order (unmeasured first),
/// and a user reads 「what does the green one mean」 before 「what does no colour
/// mean」. Completeness is not left to this list — [_statusNote] switches
/// exhaustively, so a seventh face fails to COMPILE, and a test asserts this
/// list holds every value so a seventh face cannot be silently unrendered.
const List<InstanceLivenessFace> kGuideStatusOrder = <InstanceLivenessFace>[
  InstanceLivenessFace.pcOnline,
  InstanceLivenessFace.unreachable,
  InstanceLivenessFace.pcOffline,
  // Directly after [pcOffline] on purpose: a reader who has just learned what
  // 「电脑已离线」("PC is offline") means is exactly the reader who needs to be
  // told that the next word is a DIFFERENT thing with a different fix.
  InstanceLivenessFace.pcSignedOut,
  InstanceLivenessFace.relayOnlyPcUnknown,
  InstanceLivenessFace.checking,
  InstanceLivenessFace.unmeasured,
];

/// The word the LIST ITSELF prints for [face] — the same getters
/// connections_page.dart renders, never a second copy of the copy.
String guideStatusLabel(AppStrings s, InstanceLivenessFace face) => switch (face) {
  InstanceLivenessFace.pcOnline => s.online,
  InstanceLivenessFace.unreachable => s.offline,
  InstanceLivenessFace.pcOffline => s.pcOfflineChip,
  InstanceLivenessFace.pcSignedOut => s.pcSignedOutChip,
  InstanceLivenessFace.relayOnlyPcUnknown => s.relayUpPcUnknown,
  InstanceLivenessFace.checking => s.checkingReach,
  InstanceLivenessFace.unmeasured => s.tapToConnect,
};

/// The plain-language gloss for [face]. Exhaustive on purpose: adding a face to
/// `InstanceLivenessFace` without deciding what to tell the user about it is a
/// compile error, not a blank line.
String _statusNote(AppStrings s, InstanceLivenessFace face) => switch (face) {
  InstanceLivenessFace.pcOnline => s.guideStatusOnline,
  InstanceLivenessFace.unreachable => s.guideStatusOffline,
  InstanceLivenessFace.pcOffline => s.guideStatusPcOffline,
  InstanceLivenessFace.pcSignedOut => s.guideStatusPcSignedOut,
  InstanceLivenessFace.relayOnlyPcUnknown => s.guideStatusRelayOnly,
  InstanceLivenessFace.checking => s.guideStatusChecking,
  InstanceLivenessFace.unmeasured => s.guideStatusUnmeasured,
};

/// Opens the instance-list guide. Read-only; resolves when it is dismissed.
Future<void> showInstanceGuide(
  BuildContext context, {
  required AppStrings strings,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: FlowMicColors.surface,
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
  ),
  builder: (BuildContext ctx) => InstanceGuideBody(strings: strings),
);

/// The sheet's content, separated from [showInstanceGuide] so a widget test can
/// pump it without a modal route (and so the route's shape stays one line).
class InstanceGuideBody extends StatelessWidget {
  const InstanceGuideBody({super.key, required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final AppStrings s = strings;
    return ConstrainedBox(
      // Capped rather than full-height: the list stays visible above the sheet,
      // which is the whole argument for this being a sheet at all.
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.82,
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _grabber(),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      s.guideInstancesTitle,
                      style: TextStyle(
                        color: FlowMicColors.t1,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  InkWell(
                    key: const ValueKey<String>('guide.instances.close'),
                    onTap: () => Navigator.of(context).pop(),
                    borderRadius: BorderRadius.circular(10),
                    child: Padding(
                      padding: const EdgeInsets.all(8),
                      child: Icon(Icons.close, size: 18, color: FlowMicColors.t3),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Flexible(
                // 🔴 SingleChildScrollView + Column, deliberately NOT a
                // ListView. A ListView builds lazily, so the cards below the
                // fold would not exist — and the legibility sweep that has to
                // prove no sentence is clipped would silently only sweep what
                // happened to be on screen. That is the 0.2.53 defect shape
                // reintroduced in the verification instead of the product.
                // Five fixed cards cost nothing to lay out eagerly.
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                    _card(<Widget>[
                      _sectionTitle(s.guideListTitle),
                      _body(s.guideListBody),
                      // 🔴 The page footer's own sentence, rendered verbatim
                      // (§3.2-1: do not write a second phrasing of a sentence
                      // the page is already saying). Re-typing it here is how
                      // a product ends up telling a user two things.
                      const SizedBox(height: 6),
                      _body(s.startNoAutoConnect),
                    ]),
                    const SizedBox(height: 10),
                    _card(<Widget>[
                      _sectionTitle(s.guideStatusTitle),
                      for (final InstanceLivenessFace f in kGuideStatusOrder)
                        _statusRow(guideStatusLabel(s, f), _statusNote(s, f)),
                    ]),
                    const SizedBox(height: 10),
                    _card(<Widget>[
                      _sectionTitle(s.guideGesturesTitle),
                      _body(s.guideGestureSwipe),
                      const SizedBox(height: 6),
                      _body(s.guideGestureLongPress),
                    ]),
                    const SizedBox(height: 10),
                    _card(<Widget>[
                      // The row's own label, passed in — not spelled again.
                      _sectionTitle(s.guideCloudTitle(s.cloudInstance)),
                      _body(s.guideCloudBody),
                    ]),
                    const SizedBox(height: 10),
                    _card(<Widget>[
                      _sectionTitle(s.guideSameMachineTitle),
                      _body(s.guideSameMachineBody),
                    ]),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _closeButton(context, s.guideClose),
            ],
          ),
        ),
      ),
    );
  }

  Widget _grabber() => Center(
    child: Container(
      width: 36,
      height: 4,
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: FlowMicColors.line,
        borderRadius: BorderRadius.circular(99),
      ),
    ),
  );

  Widget _card(List<Widget> children) => Container(
    padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
    decoration: BoxDecoration(
      color: FlowMicColors.surface2,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: FlowMicColors.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    ),
  );

  Widget _sectionTitle(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text(
      text,
      style: TextStyle(
        color: FlowMicColors.t1,
        fontSize: 13,
        fontWeight: FontWeight.w600,
      ),
    ),
  );

  Widget _body(String text) => Text(
    text,
    style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5, height: 1.65),
  );

  /// One status word and what it means. The word is on its own line rather than
  /// sharing a row with the sentence: 0.2.53 was a status word losing its reason
  /// to a `Flexible` in an already-crowded row, and a two-line layout is how
  /// that stops being possible rather than being tested for.
  Widget _statusRow(String label, String note) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: TextStyle(
            color: FlowMicColors.t1,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          note,
          style: TextStyle(color: FlowMicColors.t3, fontSize: 12, height: 1.6),
        ),
      ],
    ),
  );

  Widget _closeButton(BuildContext context, String label) => Material(
    color: FlowMicColors.surface2,
    borderRadius: BorderRadius.circular(12),
    child: InkWell(
      onTap: () => Navigator.of(context).pop(),
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        height: 44,
        width: double.infinity,
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    ),
  );
}

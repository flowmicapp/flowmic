// SPEC-REF:
//   docs/ui-design/2026-08-14-plan-a-visual-fidelity-contract.md §0 D1 + §2
//     「Mode segmented control」 — WP8 VF-2 replaced this control's LOOK
//     (numbered squarish chips → the mock's chipbg pill with a panel-filled
//     active segment). Its behaviour — one tap per mode, no cycle, no confirm
//     — is untouched.
//   docs/FlowMic transcription page three-plan delivery/FlowMic transcription
//     page · three-plan delivery.dc.html
//     `.seg{background:var(--chipbg);border-radius:99px;padding:3px;gap:2px}`
//     `.sgi{padding:6px 14px;border-radius:99px;font-size:12.5px;
//           color:var(--sub)}`
//     `.sgi.on{background:var(--panel);color:var(--ink);font-weight:600;
//              box-shadow:0 1px 3px rgba(0,0,0,.14)}`
//   docs/rebuild/08-MOBILE-SPEC.md §2 (three locked modes; switch clears buffer)
//   docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md §3 row 1 · the mode row
//   docs/ui-design/2026-08-06-fb3-fb8-demo.html (`segRow()` / `.seg .s` —
//     the three segments side by side, the selected one carrying the mode
//     colour; the owner reviewed THIS artifact before ruling D1/D2)
//   docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md D1 (Plan A ·
//     three-row redivision) / D2 (「three rows」 = the AI action row + the
//     toolbar row + the input row)
//
// FB-3 pain point 2, in the owner's terms: 「the three modes are the product's
// core, yet you can't see them all and can't select directly」.
// The single cycling `ModeChip` that stood here showed ONE mode and needed two
// taps to reach the third; D1 replaced it with all three side by side, one tap
// each. The cycle itself is gone from the whole app, not merely unbound from
// this widget — `ChatController.cycleMode` was deleted in the same card, so a
// future caller cannot resurrect the two-tap path by accident.
//
// The clear-buffer red line is still enforced in `ChatController.setMode`, not
// here. The modeSwitch usage count still lives in the caller's tap handler
// (`_onModeSelectedRouted`) — the segments are dumb buttons, so a tap that was
// ignored mid-recording, or a tap on the mode already selected, is never
// counted as a switch. What DID go with the cycle is the confirm dialog: D1
// says 「a direct selection needs no confirmation; the protection for a switch
// with a buffer changes to a standing buffer hint strip」, and that hint
// strip is `ComposeBand`'s `_modeSwitchHint` (greppable anchor, and
// `compose_three_row_layout_test.dart` pins that it is on screen whenever the
// buffer is non-empty).

import 'package:flutter/widgets.dart';
import 'package:flutter/material.dart'
    show Colors, Icons, InkWell, showModalBottomSheet;

import '../settings/app_strings.dart';
import '../settings/local_prefs.dart' show kTranslateTargets;
import '../signaling/wire_payloads.dart' show FlowMode;
import 'tokens.dart';

/// The permanent left-to-right order of the three locked modes — written down
/// once here rather than re-derived from `FlowMode.values` at each call site.
///
/// ⚠️ It used to be described as 「the ORDER the ①②③ numerals name」. WP8 VF-2
/// deleted those numerals (the mock's `.sgi` spans carry the word alone), so the
/// order is no longer NAMED anywhere on screen — it is only SHOWN, by this list.
/// That makes this constant the single author of 「which mode is on the left」,
/// which is why
/// the numerals could go without the position going with them.
const List<FlowMode> kModeOrder = <FlowMode>[
  FlowMode.realtime,
  FlowMode.translate,
  FlowMode.organize,
];

/// Row 1 · the mode row — all three modes visible, one tap each (D1/D2).
class ModeSegmentedControl extends StatelessWidget {
  const ModeSegmentedControl({
    super.key,
    required this.mode,
    required this.strings,
    required this.onSelect,
  });

  final FlowMode mode;

  /// Required, deliberately — no zh fallback (façade rule ②); the mode word is
  /// user-visible copy resolved from the catalogue, never the OS locale.
  final AppStrings strings;

  final ValueChanged<FlowMode> onSelect;

  /// 🔴 WP8 VF-2 — `inkFor` STOOD HERE AND IS DELETED, NOT PARKED.
  /// It returned `(numeral, ink, fill)` per mode: the ①②③ prefix plus the
  /// brand/teal/amber pair each selected segment used to wear. The mock's
  /// segmented pill has no numerals and exactly ONE selected face
  /// (`.sgi.on{background:var(--panel);color:var(--ink)}`), so all three
  /// members lost their consumer in the same edit. A helper whose only caller
  /// is gone is this repo's cheapest façade (R8 dead content) — `git log -S inkFor`
  /// is where it lives now.

  /// The mock's `.seg` container is 38.6dp. The dock's touch ruler is 44
  /// ([kComposeTouchTarget] in compose_band.dart — not imported here, that
  /// file imports this one). Growing the INNER pill to 44 would fight the
  /// mock; laying a second invisible hit strip over it would give 「where is
  /// this segment」 two authors. The honest move is one box: the control IS 44dp, the
  /// 3dp inset still rides on each item, and the selected face stays a 32dp
  /// pill inside.
  static const double _itemHeight = 32;

  /// The container's inset (`.seg{padding:3px}`) — carried by each ITEM
  /// rather than by the container, so the item's tappable box is the FULL
  /// height of the control.
  static const double _itemInset = 3;

  /// 3 + 32 + 3 = 38 visual track, then extra padding to the 44dp ruler.
  static const double _hitHeight = 44;

  @override
  Widget build(BuildContext context) {
    // `.seg{display:flex;background:var(--chipbg);border-radius:99px;
    //       padding:3px;gap:2px}` — a content-sized pill, no border.
    // ⚠️ The 3px of `padding` is deliberately only HORIZONTAL here; the
    // vertical half rides on each item (see [_itemInset]).
    return SizedBox(
      height: _hitHeight,
      child: Container(
      padding: const EdgeInsets.symmetric(horizontal: _itemInset),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: FlowMicDockColors.chipbg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < kModeOrder.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(width: 2),
            // Flexible, not Expanded: the mock's items are CONTENT-sized
            // (`.sgi` has no flex), so three equal thirds would stretch the
            // English words apart. Flexible still lets a genuinely too-narrow
            // run squeeze them (their own ellipsis takes over) instead of
            // overflowing the row.
            Flexible(child: _segment(kModeOrder[i])),
          ],
        ],
      ),
    ),
    );
  }

  Widget _segment(FlowMode m) {
    // 🔴 THE ①②③ PREFIX IS GONE (mock A-01…A-12: `<span class="sgi on">实时`).
    // It is not a copy change — the numerals were concatenated HERE, never in
    // the catalogue, so [AppStrings.modeLabel] is byte-untouched. What the
    // numeral encoded (the permanent left-to-right position) is still real and
    // still has exactly one author: [kModeOrder].
    final bool on = m == mode;
    return SizedBox(
      height: _hitHeight,
      child: InkWell(
      key: ValueKey<String>('compose.mode.${m.name}'),
      onTap: () => onSelect(m),
      borderRadius: BorderRadius.circular(99),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: _itemInset),
        child: Container(
          constraints: const BoxConstraints(minHeight: _itemHeight),
          // 🔴 NO `alignment:` HERE, AND IT IS NOT A STYLE CHOICE — MEASURED.
          // A `Container` with `alignment` set wraps its child in a
          // factor-less `Align`, and `RenderPositionedBox` takes
          // `constraints.biggest` whenever those constraints are BOUNDED. The
          // first cut of this control used `alignment: Alignment.center`, and
          // each segment then measured the FULL band width (measured: the
          // control spanned 12→348 at 360dp), which pushed the policy chip onto
          // its own Wrap run — the very bug `SendPolicyChip` below this file
          // records for its own box, reproduced one widget over.
          // ⇒ `Align` WITH BOTH FACTORS instead: it shrink-wraps the text and
          //   still centres it inside the 32dp minimum.
          // `.sgi{padding:6px 14px;border-radius:99px}`; `.sgi.on` adds the
          // panel fill and the 0 1 3 rgba(0,0,0,.14) lift.
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: on
              ? BoxDecoration(
                  color: FlowMicDockColors.panel,
                  borderRadius: BorderRadius.circular(99),
                  boxShadow: FlowMicDockColors.segShadow,
                )
              // null, not a transparent literal: an unselected segment paints
              // NO fill, so there is no colour here for a design token to name.
              : null,
          child: Align(
            widthFactor: 1,
            heightFactor: 1,
            child: Text(
              strings.modeLabel(m),
              maxLines: 1,
              // 🔴 The 0.2.53 rule — whether this line gets clipped, the
              // criterion must fall on the **rendered result**, not
              // `Text.data`. `compose_three_row_layout_test.dart` asserts
              // `didExceedMaxLines`/intrinsic width vs. the actual box, not
              // what is written here.
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: on ? FlowMicDockColors.ink : FlowMicDockColors.sub,
                fontSize: 12.5,
                // `.sgi` is regular; only `.sgi.on` is 600.
                fontWeight: on ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    ),
    );
  }
}

/// GA-01 ruling 2: the translate target language, offered right beside the mode
/// chip and ONLY while translate is selected (REDESIGN D4「chosen in place
/// alongside the translate mode」).
///
/// WP3 C12 (2026-08-18): tapping now opens a PICKER SHEET. The cycling tap it
/// replaces argued for itself in this very comment — 「two languages is not a
/// list, and a private-domain build with one owner does not need a language
/// browser」 — and both halves of that sentence have since been reversed by
/// owner rulings (nine targets IS a list; the product ships beyond the
/// private line). Cycling through nine with repeated taps would make the
/// seventh language cost seven taps and a mis-tap cost eight more.
///
/// It is a DEVICE-LOCAL habit, so it is deliberately not in the settings page:
/// the choice belongs next to the mode it modifies.
class TranslateTargetChip extends StatelessWidget {
  const TranslateTargetChip({
    super.key,
    required this.target,
    required this.strings,
    this.onTap,
    this.enabled = true,
  });

  /// The current language tag (e.g. 'en').
  final String target;

  /// See [ModeChip.strings]. The chip's word
  /// ([AppStrings.translateTargetLabel]) is user-visible copy.
  final AppStrings strings;
  final ValueChanged<String>? onTap;

  /// False while an utterance is being transformed — re-aiming the pair
  /// mid-flight would say nothing about the sentence already in the air, so the
  /// chip goes inert rather than accepting a tap that does nothing visible.
  final bool enabled;

  Future<void> _pick(BuildContext context) async {
    final String? chosen = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (BuildContext ctx) => SafeArea(
        child: Container(
          margin: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          decoration: BoxDecoration(
            color: FlowMicColors.surface2,
            border: Border.all(color: FlowMicColors.line),
            borderRadius: BorderRadius.circular(16),
          ),
          // Scrollable for the same measured reason as the entry context
          // menu: showModalBottomSheet caps a sheet at half the screen, and
          // nine rows plus a title do not fit that cap on a short phone.
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(15, 12, 15, 4),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      strings.translateTargetSheetTitle,
                      style: TextStyle(
                        color: FlowMicColors.t3,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                for (final String tag in kTranslateTargets)
                  InkWell(
                    onTap: () => Navigator.of(ctx).pop(tag),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 15,
                        vertical: 11,
                      ),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              strings.translateTargetRowLabel(tag),
                              style: TextStyle(
                                color: tag == target
                                    ? FlowMicColors.teal
                                    : FlowMicColors.t1,
                                fontSize: 13.5,
                                fontWeight: tag == target
                                    ? FontWeight.w600
                                    : FontWeight.w400,
                              ),
                            ),
                          ),
                          if (tag == target)
                            Icon(Icons.check_rounded,
                                size: 16, color: FlowMicColors.teal),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
    // Dismissed with no choice → nothing changes; re-choosing the current one
    // is a no-op at the controller (`ChatController.setTranslateTarget`
    // early-returns on an unchanged or empty value — grep the guard).
    if (chosen != null && onTap != null) onTap!(chosen);
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: enabled && onTap != null ? () => _pick(context) : null,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        height: 38,
        padding: const EdgeInsets.symmetric(horizontal: 9),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: FlowMicColors.tealSoft,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: Text(
            strings.translateTargetLabel(target),
            style: TextStyle(
              color: FlowMicColors.teal,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}

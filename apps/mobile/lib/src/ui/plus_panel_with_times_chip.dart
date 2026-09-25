// Card CR-12-F — the 「with times」 chip on the 「+」 panel's send bar.
//
// SPEC-REF:
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md
//     §10.2 (chosen at the moment of sending, shown only when a recording is
//     ticked), §10.3 (off by default), §10.4 (remembered, and always drawn
//     beside the send button so remembering never becomes a hidden setting)
//   docs/ui-design/2026-09-22-cr12-live-article-view-demo.html phase H
//     (`.chip` / `.chip.on` / `.sw` — the shape mirrored below)
//   docs/decisions/2026-08-12-owner-req1209-multiselect-and-image-rulings.md
//     §1 ruling 3 and its 2026-09-22 addendum
//
// The chip only draws and reports taps. Whether it is on, whether it is shown,
// and what it changes in the composed message all belong to the panel
// (`_PlusPanelState`) and to `PlusPanelSelection.composeText`.

import 'package:flutter/material.dart';

import 'tokens.dart';

/// A pill with a small switch and a label: 「with times」 on or off.
class SendWithTimesChip extends StatelessWidget {
  const SendWithTimesChip({
    super.key,
    required this.on,
    required this.label,
    required this.onTap,
  });

  final bool on;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      toggled: on,
      button: true,
      child: InkWell(
        key: const ValueKey<String>('plus.selection.withTimes'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(99),
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 11),
          decoration: BoxDecoration(
            color: on ? FlowMicColors.brandSoft : FlowMicColors.surface2,
            borderRadius: BorderRadius.circular(99),
            border: Border.all(
              color: on
                  ? FlowMicColors.brand.withValues(alpha: 0.5)
                  : FlowMicColors.line,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _switch(),
              const SizedBox(width: 6),
              Text(
                label,
                key: const ValueKey<String>('plus.selection.withTimes.label'),
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: on ? FlowMicColors.brand : FlowMicColors.t2,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The 22×12 track with an 8 px knob that sits left when off, right when on.
  Widget _switch() => Container(
    key: ValueKey<String>('plus.selection.withTimes.${on ? 'on' : 'off'}'),
    width: 22,
    height: 12,
    padding: const EdgeInsets.all(2),
    alignment: on ? Alignment.centerRight : Alignment.centerLeft,
    decoration: BoxDecoration(
      color: on ? FlowMicColors.brandDeep : FlowMicColors.line,
      borderRadius: BorderRadius.circular(99),
    ),
    child: Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: FlowMicColors.onBrandInk,
        shape: BoxShape.circle,
      ),
    ),
  );
}

// SPEC-REF: docs/ui-design/demo/mobile.html frame 7 (.set-sec / .set-card /
//   .srow / .seg / .toggle / .ctx-chip / .chkrow primitives).
//
// The shared, stateless building blocks of the settings screen (section header,
// card, row, segmented control, toggle, chip, checkbox row, ghost/danger
// buttons) plus the curated scenario presets. Split out of settings_page.dart to
// keep that file under the file-size cap and to make each primitive reusable.

import 'package:flutter/material.dart';

import 'tokens.dart';

// ── scenario presets ────────────────────────────────────────────────────────
// The curated quick-picks MOVED to settings/scenario_taxonomy.dart on
// 2026-09-04 and are not re-exported here on purpose.
//
// They lived here as two `const List<String>` of stored VALUES back when the
// stored value was an English-ish label. It is an id now, paired with an
// English canonical for the wire and nine catalogue labels for the screen —
// three strings that have to be defined together or they drift apart, which is
// precisely how the same profession came to be stored twice in two languages.
// A UI file is the wrong home for a settings contract; the chip order lives
// with it (`ScenarioAxis.professions.ids`).

// ── text styles ──────────────────────────────────────────────────────────────
// Getters, not const: the colours resolve per-read against the active theme
// (V2-07.3). Call sites (`style: kRowTitle`) are unchanged.
TextStyle get kRowTitle => TextStyle(color: FlowMicColors.t1, fontSize: 13.5);
TextStyle get kRowSub => TextStyle(color: FlowMicColors.t3, fontSize: 10.5);

// ── primitives ───────────────────────────────────────────────────────────────
Widget settingsSection(String label) => Padding(
  padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
  child: Text(
    label.toUpperCase(),
    style: TextStyle(
      color: FlowMicColors.t3,
      fontSize: 11,
      fontWeight: FontWeight.w700,
      letterSpacing: 0.5,
    ),
  ),
);

Widget settingsCard({required Widget child}) => Container(
  decoration: BoxDecoration(
    color: FlowMicColors.surface,
    border: Border.all(color: FlowMicColors.line),
    borderRadius: BorderRadius.circular(18),
  ),
  clipBehavior: Clip.antiAlias,
  child: child,
);

Widget settingsRow({required Widget child, bool last = false}) => Container(
  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
  decoration: BoxDecoration(
    border: last ? null : Border(bottom: BorderSide(color: FlowMicColors.line)),
  ),
  child: child,
);

// `settingsToggle` was DELETED 2026-07-31 (0.2.27). It was the settings page's
// switch primitive, and after the「仅记录条目也同步到 PC」("record-only entries
// also sync to the PC") toggle was retired with
// room sync (owner architecture ruling / 架构裁定 no-cloud-sync) it had ZERO
// callers — that toggle was
// its only one, in the whole app. Kept-as-shared-infra was the tempting call, and
// it is the one this repo has paid for repeatedly: a capability defined with no
// production caller is the headline historical bug class here, and「可复用」
// ("reusable") is not
// a consumer. When a real boolean setting appears, this is ~20 lines of Flutter to
// write against that design, not a shape to preserve on spec.
//
// 2026-09-03: that day came. Three real boolean settings moved to the phone
// (AI polish, two-pass refine, the scenario-inference consent —
// settings_general_prefs.dart), so the primitive below is written against
// THEM, and they are its production callers (grep `settingsSwitchRow`).

/// A titled switch row. [sub] renders under the title when non-empty and may
/// wrap — the consent sentence is long in every language, and a row that
/// clipped it would be asking for consent to something the user cannot read.
Widget settingsSwitchRow({
  required String title,
  required bool value,
  required ValueChanged<bool> onChanged,
  String sub = '',
  bool last = false,
  Key? switchKey,
}) => settingsRow(
  last: last,
  child: Row(
    crossAxisAlignment: CrossAxisAlignment.center,
    children: <Widget>[
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title, style: kRowTitle),
            if (sub.isNotEmpty) ...<Widget>[
              const SizedBox(height: 3),
              Text(sub, style: kRowSub.copyWith(height: 1.35)),
            ],
          ],
        ),
      ),
      const SizedBox(width: 10),
      Switch(
        key: switchKey,
        value: value,
        // Applies-and-persists instantly, no save button (red line).
        onChanged: onChanged,
      ),
    ],
  ),
);

Widget settingsDot(Color c) => Container(
  width: 8,
  height: 8,
  decoration: BoxDecoration(color: c, shape: BoxShape.circle),
);

Widget settingsPill(String text, Color fg, Color bg) => Container(
  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
  decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
  // maxLines+ellipsis is load-bearing when a parent ConstrainedBox is
  // narrower than the string (long emails on 320dp). Unconstrained, the
  // text still sizes to content — short pills like 「免费」("free") are unchanged.
  child: Text(
    text,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(color: fg, fontSize: 10, fontWeight: FontWeight.w600),
  ),
);

Widget settingsChip(String label, {required bool on, required VoidCallback onTap}) =>
    GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: on ? FlowMicColors.brandSoft : FlowMicColors.surface2,
          // The on-border was a hard-coded 0x66818CF8 — dark-brand @ .4 alpha,
          // verbatim. Correct in dark, but it stayed indigo-400 in the light
          // theme where brand deepens to indigo-600. Same alpha over the TOKEN
          // keeps dark pixel-identical and makes light hue-consistent.
          border: Border.all(color: on ? FlowMicColors.brand.withValues(alpha: 0.4) : FlowMicColors.line),
          borderRadius: BorderRadius.circular(99),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: on ? FlowMicColors.brand : FlowMicColors.t2,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );

Widget settingsCheckRow({
  required String title,
  required String sub,
  required bool checked,
  required VoidCallback onTap,
  bool last = false,
}) => InkWell(
  onTap: onTap,
  child: settingsRow(
    last: last,
    child: Row(
      children: <Widget>[
        Container(
          width: 20,
          height: 20,
          decoration: BoxDecoration(
            color: checked ? FlowMicColors.brandDeep : Colors.transparent,
            border: Border.all(
              color: checked ? FlowMicColors.brandDeep : FlowMicColors.line,
              width: 1.5,
            ),
            borderRadius: BorderRadius.circular(6),
          ),
          child: checked ? const Icon(Icons.check, size: 13, color: Colors.white) : null,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(title, style: TextStyle(color: FlowMicColors.t1, fontSize: 13)),
              if (sub.isNotEmpty) ...<Widget>[
                const SizedBox(height: 2),
                Text(sub, style: kRowSub),
              ],
            ],
          ),
        ),
      ],
    ),
  ),
);

Widget ghostButton(String label, {VoidCallback? onTap, IconData? icon}) {
  final TextStyle style = TextStyle(
    color: FlowMicColors.t2,
    fontSize: 12,
    fontWeight: FontWeight.w600,
  );
  // Bare [Text] (no wrapping [Row]) so a finite max-width parent can wrap
  // the label instead of overflowing. EN 「Enter Notes (Record only)」 and
  // JA 「メモに入る（記録のみ）」 share this path; a Row(mainAxisSize: min)
  // takes the unwrapped intrinsic width and yellow-stripes at 360dp.
  final Widget labelWidget = Text(label, style: style);
  return Opacity(
    opacity: onTap == null ? 0.5 : 1,
    child: GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: FlowMicColors.surface,
          border: Border.all(color: FlowMicColors.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: icon == null
            ? labelWidget
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(icon, size: 13, color: FlowMicColors.t2),
                  const SizedBox(width: 5),
                  labelWidget,
                ],
              ),
      ),
    ),
  );
}


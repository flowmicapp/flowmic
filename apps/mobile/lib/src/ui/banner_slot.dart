// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §3 P-3 (single banner slot + 「N more」
//     expand), §6.2 ② (the home page's second layer IS the single banner
//     slot), §4.1 palette
//   docs/ui-design/demo/mobile.html .banner (the frozen red offline banner this
//     widget generalises to three severities)
//
// The ONE banner slot. Renders BannerQueue.top and, when anything is queued
// behind it, a 「还有 N 条」("N more") button that opens the full list — so a lower-priority
// error is deferred, never swallowed (CLAUDE.md's no silent failure).

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import 'banner_queue.dart';
import 'tokens.dart';

/// Severity → the frozen palette. blocking reuses the demo's exact offline-banner
/// colours; degraded reuses the amber (cached/attention) token; info the brand.
@immutable
class _BannerFace {
  const _BannerFace(this.fill, this.border, this.ink, this.icon);
  final Color fill;
  final Color border;
  final Color ink;
  final IconData icon;

  static _BannerFace of(BannerSeverity severity) => switch (severity) {
    // owner 2026-07-29: 「the pale red text popping up at the top: the
    // computer isn't responding… this color is hard to read」.
    // A failure notice that is hard to read is a failure half-reported. The hue
    // stays red (§4.1 keeps one colour per role) but the FILL, BORDER and INK
    // are all pushed up: a near-white ink on a solid red-tinted fill reads at a
    // glance on both themes, where #FCA5A5 at 12 px on a 14%-alpha fill did not.
    BannerSeverity.blocking => const _BannerFace(
      Color(0x59F87171), // was 0x24 — a fill you can actually see
      Color(0xB3F87171), // was 0x4D — a border, not a hint
      Color(0xFFFFF1F2), // was 0xFFFCA5A5 — near-white on red reads
      Icons.error_outline,
    ),
    BannerSeverity.degraded => _BannerFace(
      FlowMicColors.amberSoft,
      const Color(0x4DFBBF24),
      FlowMicColors.amber,
      Icons.warning_amber_rounded,
    ),
    BannerSeverity.info => _BannerFace(
      FlowMicColors.brandSoft,
      const Color(0x4D818CF8),
      FlowMicColors.brand,
      Icons.info_outline,
    ),
  };
}

class BannerSlot extends StatelessWidget {
  const BannerSlot({super.key, required this.queue, required this.strings});

  final BannerQueue queue;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final BannerItem? top = queue.top;
    if (top == null) return const SizedBox.shrink();
    final int overflow = queue.overflowCount;
    final _BannerFace face = _BannerFace.of(top.severity);
    final bool blocking = top.severity == BannerSeverity.blocking;
    return Container(
      margin: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      padding: blocking
          ? const EdgeInsets.fromLTRB(13, 12, 8, 12)
          : const EdgeInsets.fromLTRB(13, 10, 8, 10),
      decoration: BoxDecoration(
        color: face.fill,
        border: Border.all(color: face.border),
        borderRadius: BorderRadius.circular(13),
      ),
      child: Row(
        children: <Widget>[
          Icon(face.icon, size: blocking ? 17 : 14, color: face.ink),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              top.message,
              // A blocking banner is the one the user MUST be able to read
              // across the room: bigger, heavier, and with room to breathe.
              style: TextStyle(
                color: face.ink,
                fontSize: blocking ? 13.5 : 12,
                fontWeight: blocking ? FontWeight.w600 : FontWeight.w400,
                height: 1.35,
              ),
            ),
          ),
          if (top.actionLabel != null)
            _TextButtonlet(
              label: top.actionLabel!,
              ink: face.ink,
              onTap: top.onAction,
            ),
          if (overflow > 0)
            _TextButtonlet(
              label: strings.bannerMore(overflow),
              ink: face.ink,
              onTap: () => _showAll(context),
            ),
          if (top.dismissible)
            InkWell(
              // M2: with an action present, ✕ is a pure dismiss ([onDismiss]);
              // without one it fires the item's single callback as before.
              onTap: top.onDismiss ?? top.onAction,
              borderRadius: BorderRadius.circular(8),
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Icon(Icons.close, size: 14, color: face.ink),
              ),
            ),
        ],
      ),
    );
  }

  /// The overflow expansion: every queued banner, in priority order.
  void _showAll(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: FlowMicColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (BuildContext sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                strings.bannerAllTitle,
                style: TextStyle(
                  color: FlowMicColors.t1,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 10),
              for (final BannerItem item in queue.all)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Container(
                        margin: const EdgeInsets.only(top: 5),
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: _BannerFace.of(item.severity).ink,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          item.message,
                          style: TextStyle(
                            color: FlowMicColors.t2,
                            fontSize: 12.5,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A compact inline text affordance (no Material button chrome — the banner is
/// dense and the demo has no button inside it).
class _TextButtonlet extends StatelessWidget {
  const _TextButtonlet({required this.label, required this.ink, this.onTap});

  final String label;
  final Color ink;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(8),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      child: Text(
        label,
        style: TextStyle(
          color: ink,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          decoration: TextDecoration.underline,
          decorationColor: ink,
        ),
      ),
    ),
  );
}

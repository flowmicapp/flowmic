// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7 (the plaintext warning
//     obligation), §8-2 (the estimated size shows live beside the checkbox),
//     §8-3 (an image row is still exported when images are excluded)
//
// The one screen a user sees before a plaintext copy of their history leaves the
// app.
//
// 🔴 THE WARNING IS NOT A DISCLAIMER. §7-1 spells out both halves: say what the
// file IS (「你的原文，谁拿到都能看」 — "your original words, readable by
// whoever gets hold of it") and ⛔ do not write 「请妥善保管」("please keep it
// safe"), which names no consequence. The sentence lives in
// `settings_strings.dart` so all four languages have to state the consequence
// too, and a widget test asserts it is actually on screen (§9's 「导出前那句话
// 真的渲染」("the pre-export sentence really renders") row) — a warning that
// only exists in the catalogue is the same as no warning.
//
// 🔴 THE SIZE NUMBER IS MEASURED. It comes from `PortableController.tally`,
// which is `AssetInventory.tally()` — real file lengths off disk, never an
// estimate (§8-2).

import 'dart:async';

import 'package:flutter/material.dart';

import '../settings/app_strings.dart';
import '../ui/settings_widgets.dart';
import '../ui/tokens.dart';
import 'portable_controller.dart';
import 'portable_export.dart';
import 'portable_import.dart';

/// Opens the export sheet and, if the user goes through with it, reports the
/// outcome on the page beneath.
Future<void> showExportSheet(
  BuildContext context, {
  required PortableController controller,
  required AppStrings strings,
}) async {
  // Measured while the sheet opens, not before: this is the only place the
  // number is needed, and walking the whole timeline every time the settings
  // page rebuilds would be a real cost for a number nobody is looking at.
  unawaited(controller.loadTally());
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: FlowMicColors.surface,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (BuildContext ctx) =>
        _ExportSheet(controller: controller, strings: strings),
  );
}

class _ExportSheet extends StatelessWidget {
  const _ExportSheet({required this.controller, required this.strings});

  final PortableController controller;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListenableBuilder(
        listenable: controller,
        builder: (BuildContext context, _) {
          final tally = controller.tally;
          return Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  strings.exportTitle,
                  style: TextStyle(
                    color: FlowMicColors.t1,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 12),

                // ── §7-1 plaintext warning ────────────────────────────────
                Container(
                  padding: const EdgeInsets.all(11),
                  decoration: BoxDecoration(
                    color: FlowMicColors.amberSoft,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Icon(
                        Icons.lock_open_outlined,
                        size: 16,
                        color: FlowMicColors.amber,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          strings.exportPlaintextWarning,
                          style: TextStyle(
                            color: FlowMicColors.t1,
                            fontSize: 12.5,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // ── §4.1 scope: what's exported is not 「你说过的全部」
                //    ("everything you have ever said") ───────────────────
                Text(strings.exportScopeNote, style: kRowSub),
                const SizedBox(height: 6),
                if (tally == null)
                  Row(
                    children: <Widget>[
                      const SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(strokeWidth: 1.6),
                      ),
                      const SizedBox(width: 8),
                      Text(strings.exportRunning, style: kRowSub),
                    ],
                  )
                else ...<Widget>[
                  Text(
                    strings.exportScopeCount(tally.entryCount),
                    style: kRowTitle,
                  ),
                  if (tally.oldest != null && tally.newest != null) ...<Widget>[
                    const SizedBox(height: 2),
                    Text(
                      strings.exportRange(
                        _day(tally.oldest!),
                        _day(tally.newest!),
                      ),
                      style: kRowSub,
                    ),
                  ],
                  const SizedBox(height: 14),

                  // ── owner ruling 5 + §8-2: checkbox + a genuinely
                  //    computed size ───────────────────────────────────
                  if (tally.imageFileCount == 0)
                    Text(strings.exportNoImages, style: kRowSub)
                  else
                    settingsCheckRow(
                      title: strings.exportIncludeImages(
                        tally.imageFileCount,
                        tally.imageBytes,
                      ),
                      sub: strings.exportWithoutImagesNote,
                      checked: controller.includeImages,
                      onTap: () =>
                          controller.includeImages = !controller.includeImages,
                      last: true,
                    ),
                ],
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: controller.busy || tally == null
                        ? null
                        : () => _run(context),
                    child: Text(
                      controller.busy
                          ? strings.exportRunning
                          : strings.exportAction,
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  static String _day(DateTime t) {
    final DateTime l = t.toLocal();
    String p(int v) => v.toString().padLeft(2, '0');
    return '${l.year}-${p(l.month)}-${p(l.day)}';
  }

  Future<void> _run(BuildContext context) async {
    final NavigatorState nav = Navigator.of(context);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final ExportOutcome outcome = await controller.export(
      // The README says exactly what the header says — the exporter hands over
      // the version IT read, so the human-readable file and the machine-readable
      // header cannot disagree (and a null stays null in both).
      readme:
          ({
            required DateTime exportedAt,
            required int entryCount,
            required int attachmentCount,
            required bool hasAttachments,
            required String? appVersion,
          }) => strings.portableReadme(
        exportedAt: exportedAt.toIso8601String(),
        entryCount: entryCount,
        attachmentCount: attachmentCount,
        hasAttachments: hasAttachments,
        appVersion: appVersion,
      ),
    );
    if (nav.canPop()) nav.pop();
    messenger.showSnackBar(
      SnackBar(content: Text(exportOutcomeText(outcome, strings))),
    );
  }
}

/// The sentence for an outcome. Pulled out of the widget so the wording is
/// testable without pumping a sheet, and so 「取消」("cancelled") provably
/// never reads as a failure.
String exportOutcomeText(ExportOutcome o, AppStrings s) {
  if (o.ok) return s.exportDone(o.entryCount, o.landing!.displayPath);
  if (o.cancelled) return s.exportCancelled;
  return s.exportFailedText(o.failure!, o.detail);
}

/// Same, for an import.
String importReportSentence(ImportReport r, AppStrings s) {
  if (r.cancelled) return s.importCancelled;
  final fileRefusal = r.fileRefusal;
  if (fileRefusal != null) {
    return s.importFileRefusal(fileRefusal, r.otherEnd, r.detail);
  }
  return s.importReportText(r);
}

// CARD-UI — the rows and the harness shared by the two meta fit tests. One
// row per delivery face (the face is a projection of status + verdict code,
// `status_badge.dart` `deliveryFaceOf`), each with the widest count and
// duration a row shows and a PC instance name long enough that it must give
// way.

import 'dart:io';

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/entry_metrics.dart' show entryWordCount;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show entryMetricsLine;
import 'package:flowmic/src/ui/text_scale_scope.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'real_latin_font.dart';
import 'square_fallback_font.dart';

/// `FLOWMIC_META_MATRIX=full` runs the whole matrix: text size 1.0 / 1.15 /
/// 1.3 × 360 / 393 / 412 dp (a narrow Android, iPhone 15/16, a Pixel). The
/// nightly-dispatched `.github/workflows/flutter.yml` step "Card meta full
/// matrix" sets it.
///
/// Without it (every gate) only the DOMINATING cell runs: 360 dp at 1.15.
/// It decides the rule the owner set — every fact on its line at text size
/// <= 1.15 — for the other required cells too: on a wider line, or at 1.0
/// (every text item narrower, the icons unchanged), every item has at least
/// the room it had, so a placement that fits at 360 dp / 1.15 fits there.
/// What only the full run sees: the residual cells at 1.0, 393 / 412 dp and
/// 1.3, which the fixtures pin; a default run checks the pins of the cells it
/// runs and leaves the others as they are.
final bool kMetaFullMatrix =
    Platform.environment['FLOWMIC_META_MATRIX'] == 'full';

final List<AppTextScale> kMetaRungs = <AppTextScale>[
  if (kMetaFullMatrix) AppTextScale.large,
  AppTextScale.xlarge,
  if (kMetaFullMatrix) AppTextScale.xxlarge,
];

final List<double> kMetaWidths = <double>[
  360,
  if (kMetaFullMatrix) ...<double>[393, 412],
];

/// The fixture after an update run: the pins of cells this run did not cover
/// are kept, the covered ones are replaced by what the run saw.
String mergedResidual({
  required String header,
  required Set<String> previous,
  required Set<String> runPrefixes,
  required Iterable<String> seen,
}) {
  bool covered(String cell) => runPrefixes.any(cell.startsWith);
  final List<String> lines = <String>{
    ...previous.where((String c) => !covered(c)),
    ...seen,
  }.toList()..sort();
  return header + lines.map((String l) => '$l\n').join();
}

const String kMetaPc = 'Engineering-Workstation-Floor3-Long-Machine-Name';
const String _kWindow =
    'Quarterly planning notes - a very long document title.txt';

/// 1000 words: a four-digit count. 59:59 is the widest `m:ss` duration.
final String _kText = List<String>.filled(1000, 'a').join(' ');
const int _kDurationMs = 3599000;

/// What else a chat-page card carries besides its facts.
enum MetaExtras {
  /// Nothing.
  plain,

  /// Edited, favourite and re-sent (「Resent 23:59」), outside selection
  /// mode: mode badge, inline Resend, edited mark and star all compete.
  marks,

  /// The same in selection mode: the tick instead of the inline Resend.
  selecting;

  bool get edited => this != plain;
  bool get favourite => this != plain;
  bool get selection => this == selecting;
}

/// Which time stamp format a row shows (`time_label.dart`).
enum MetaStamp {
  today,
  thisYear,
  pastYear;

  /// A local instant that renders in this format, with two-digit month and
  /// day (the widest).
  DateTime at(DateTime now) {
    final DateTime local = now.toLocal();
    switch (this) {
      case MetaStamp.today:
        return DateTime(local.year, local.month, local.day, 23, 59).toUtc();
      case MetaStamp.thisYear:
        final bool clash = local.month == 12 && local.day == 28;
        return DateTime(local.year, clash ? 11 : 12, 28, 23, 59).toUtc();
      case MetaStamp.pastYear:
        return DateTime(local.year - 1, 12, 28, 23, 59).toUtc();
    }
  }
}

class MetaRow {
  const MetaRow(this.id, this.queued, this._build, {this.owed = false});
  final String id;

  /// The tile argument the face needs (`deliveryFaceOf(queued:)`).
  final bool queued;

  /// NR-279 — `deliveryFaceOf(owed:)` (queued OR inflight); only the
  /// `noAnswerYet` row needs it.
  final bool owed;
  final TimelineEntry Function(
    String id,
    DateTime createdAt,
    bool edited,
    DateTime? resentAt,
  )
  _build;

  TimelineEntry build({
    required DateTime createdAt,
    required bool edited,
    String? id,
    DateTime? resentAt,
  }) => _build(id ?? this.id, createdAt, edited, resentAt);
}

List<MetaRow> metaRows(DateTime now) {
  MetaRow r(
    String id,
    EntryStatus status, {
    bool queued = false,
    bool owed = false,
    String? code,
    bool verdict = false,
    Delivery delivery = Delivery.inject,
    bool landed = false,
  }) => MetaRow(
    id,
    queued,
    (String rowId, DateTime createdAt, bool edited, DateTime? resentAt) =>
        TimelineEntry(
          id: rowId,
          clientId: rowId,
          mode: FlowMode.realtime,
          delivery: delivery,
          sourceText: _kText,
          outputText: _kText,
          status: status,
          createdAt: createdAt,
          updatedAt: createdAt,
          durationMs: _kDurationMs,
          edited: edited,
          spokenToInstanceId: 'inst-1',
          spokenToInstanceName: kMetaPc,
          pcName: landed ? kMetaPc : null,
          injectTarget: landed
              ? const InjectTarget(
                  windowTitle: _kWindow,
                  processName: 'notes.exe',
                  injectedAt: '2026-10-14T00:00:00Z',
                )
              : null,
          failureReason: code,
          cachedByVerdict: verdict,
          lastResentAt: resentAt,
        ),
    owed: owed,
  );
  return <MetaRow>[
    r('injected', EntryStatus.injected, landed: true),
    r('queued', EntryStatus.cached, queued: true),
    r('delivering', EntryStatus.cached),
    r(
      'undelivered',
      EntryStatus.cached,
      code: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
      verdict: true,
    ),
    r('refused', EntryStatus.cached, code: 'INJECT_PC_MISMATCH', verdict: true),
    r('failed', EntryStatus.failed, code: 'LINK_DOWN'),
    // NR-279 — the 20 s watchdog's code while the queue still owes the row.
    r('noAnswerYet', EntryStatus.failed, code: 'INJECT_NO_RESULT', owed: true),
    r(
      'uncertain',
      EntryStatus.cached,
      code: 'INJECT_SUBMISSION_UNCERTAIN',
      verdict: true,
    ),
    r('noted', EntryStatus.noted, delivery: Delivery.none),
    r(
      'noFocus',
      EntryStatus.cached,
      code: 'INJECT_NO_TEXT_TARGET',
      verdict: true,
      landed: true,
    ),
    r(
      'deferred',
      EntryStatus.cached,
      code: 'INJECT_DEFERRED_NOT_AUTOINJECTED',
      verdict: true,
      landed: true,
    ),
    r(
      'notInjected',
      EntryStatus.cached,
      code: 'INJECT_SECURE_INPUT_ACTIVE',
      verdict: true,
      landed: true,
    ),
  ];
}

/// The duration + count text the card must show for [e].
String metaMetricsText(TimelineEntry e, AppStrings s) =>
    entryMetricsLine(e.durationMs, entryWordCount(e)!, s);

Future<AppSettingsController> metaSettings(
  AppLocale locale,
  AppTextScale rung,
) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final AppSettingsController settings = AppSettingsController(
    prefs: await SharedPreferences.getInstance(),
  );
  await settings.load();
  settings.setLocale(locale);
  settings.setTextScale(rung);
  return settings;
}

/// The app shell the meta is measured in: the production text-size scope and
/// the two-face ruler (see the fit tests' headers).
Widget metaApp(AppSettingsController settings, Widget home) => MaterialApp(
  theme: ThemeData(
    fontFamily: kRealLatinFamily,
    fontFamilyFallback: const <String>[kSquareFallbackFamily],
  ),
  builder: (BuildContext context, Widget? page) =>
      TextScaleScope(appSettings: settings, child: page!),
  home: home,
);

// AppStrings copy-catalogue shard: stats + clear (window C2, docs/rebuild/16
// §6.1 / §6.2).
// The one external entry point is still ../app_strings.dart.
//
// 🔴 [statsNoDurationCount] is the user-visible face of §6.1's rule 「null
// 绝不当 0」 ("null must never be treated as 0"): the total must always be
// followed by a sentence saying 「另有 N 条没有时长记录」 ("N more rows have
// no duration on record"), otherwise that total looks like it covers
// everything, and it does not.
// ⛔ Do not fold duration-less rows into the total as 0 seconds just to make
// this sentence unnecessary.
//
// 🔴 [clearIrreversible] is §6.2's warning obligation. Clearing deletes
// **bytes**, not a reversible flag.
// ⛔ Do not soften it into something toothless like 「记录将被整理」 ("records
// will be tidied up") that does not convey the consequence (same discipline
// as the plain-language warning on export).
part of '../app_strings.dart';

mixin StatsStrings on AppStringsLeaves {

  // ── stats (16 册 §6.1) ─────────────────────────────────────────────────
  String get statsTitle => _lfStatsTitle;

  String get statsSub => _lfStatsSub;

  String get statsOpen => _lfStatsOpen;

  String get statsDuration =>
      _lfStatsDuration;
  String get statsWords => _lfStatsWords;
  String get statsRows => _lfStatsRows;
  String get statsTranscripts => _lfStatsTranscripts;
  String get statsImages => _lfStatsImages;
  String get statsTextSize =>
      _lfStatsTextSize;
  String get statsImageSize =>
      _lfStatsImageSize;
  String get statsRange => _lfStatsRange;
  String get statsByPc =>
      _lfStatsByPc;
  String get statsUnknownPc =>
      _lfStatsUnknownPc;
  String get statsEmpty => _lfStatsEmpty;

  /// 🔴 「不知道」 ("don't know") must never be counted as 「零秒」 ("zero
  /// seconds") — see the file header.
  String statsNoDurationCount(int n) => _lfStatsNoDurationCount(n);

  /// §9b-6 — 「有图片行、没有图片文件」 ("there's a picture row, but no
  /// picture file") is a genuine piece of history, not a rounding error.
  String statsMissingPictures(int n) => _lfStatsMissingPictures(n);

  /// owner 2026-08-02: word-segmentation differs by language ⇒ figures like
  /// word count can only be approximate — this must be stated plainly to the
  /// user, and both ends' stats pages use the same sentence (the desktop's is
  /// `st_approx` in strings/stats.ts).
  String get statsApprox => _lfStatsApprox;

  String statsRowsUnit(int n) =>
      _lfStatsRowsUnit(n);
  String statsWordsUnit(int n) =>
      _lfStatsWordsUnit(n);

  /// `3:12:05` / `12:30` — a numeric face, the same stance as
  /// recording_panel's formatElapsed (the UI does not follow OS locale, so the
  /// unit words are not translated).
  String statsRange2(String from, String to) => '$from — $to';

  // ── clear (16 册 §6.2) ─────────────────────────────────────────────────
  String get clearTitle =>
      _lfClearTitle;

  String get clearSub => _lfClearSub;

  /// 🔴 §6.2's warning obligation — see the file header.
  String get clearIrreversible => _lfClearIrreversible;

  String get clearKindText =>
      _lfClearKindText;
  String get clearKindImages =>
      _lfClearKindImages;
  String get clearKindBoth => _lfClearKindBoth;

  String get clearWinWeek =>
      _lfClearWinWeek;
  String get clearWinMonth =>
      _lfClearWinMonth;
  String get clearWinQuarter =>
      _lfClearWinQuarter;
  String get clearWinHalfYear =>
      _lfClearWinHalfYear;
  String get clearWinYear =>
      _lfClearWinYear;

  /// ⚠️ 「全部」 ("all") is the coordinator's assumption, not an owner ruling
  /// (B5 pending approval, see
  /// docs/decisions/2026-08-02-b5-stats-list-and-clear-all-options.md §二).
  String get clearWinAll => _lfClearWinAll;

  String clearPreview(int rows, int bytes) => _lfClearPreview(rows, formatBytes(bytes));

  String get clearNothing => _lfClearNothing;

  String get clearAction => _lfClearAction;
  String get clearConfirmTitle =>
      _lfClearConfirmTitle;
  String get clearConfirmOk =>
      _lfClearConfirmOk;
  String get clearCancel => _lfClearCancel;

  String clearDone(int rows, int bytes) => _lfClearDone(rows, formatBytes(bytes));

  /// §6.2-3 cleared ≠ never existed — both statements still hold after a
  /// restart (the marker is persisted to prefs).
  String clearedTextBefore(String when) => _lfClearedTextBefore(when);

  String clearedImagesBefore(String when) => _lfClearedImagesBefore(when);
}

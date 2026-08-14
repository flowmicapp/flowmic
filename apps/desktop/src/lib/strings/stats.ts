// String catalogue shard: stats + clear (window C2, docs/rebuild/16 §6.1 / §6.2). Merged and exported by ../strings.ts.
//
// 🔴 0.2.43 (owner: "voice duration needs to come back"): `st_no_duration`
// retired — delivery frames now carry `duration_ms` (additive optional), so
// the desktop has a real data source. Three new keys, each with its own job:
//   `st_duration` = the tile label (only rendered when withDuration > 0);
//   `st_duration_missing` = "N more rows have no duration (not counted in the
//     total)" — the user-visible face of "null is never treated as 0",
//     mirroring the mobile side's statsNoDurationCount wording;
//   `st_duration_none` = the explanation shown when there is no duration at
//     all (old records / old relay leg); no tile rendered in that case.
// ⛔ Must never be changed into a tile that reads "0 minutes" (that half of
// book 16 §6.1-c still applies).
//
// 🔴 `cl_irreversible` is likewise the §6.2 warning obligation: clearing
// deletes **bytes**, not a reversible marker. ⛔ Must not be softened into
// something like "records will be tidied up" that doesn't convey the
// consequence.
//
// Sentence assembly always happens in the component by concatenating "label +
// number + unit", the same discipline as portable.ts (locale-parity
// automatically guards the S-catalogue key set; function catalogues have to
// be registered by hand).
//
// 🔴 2026-08-02 UI batch-1 rework (design doc 2026-08-02-ui-batch1-rework-design.md §1.3/§1.4):
//   · `st_unknown_mobile` (unlabeled source) removed — now that grouping is
//     merged by machine, rows with no identity fall under `st_early`
//     ("early records"), and rows whose name can't be resolved fall under
//     `st_other` ("N other devices"). **The raw id never reaches the screen.**
//   · `cl_hint` removed — its job is now covered by the clear-entry row's
//     `cl_entry_hint` (the danger zone is collapsed by default, see
//     TimelinePage.vue's clearOpen).
//   · `st_approx` added (owner addendum, 2026-08-02): a small-print note both
//     stats pages need — differences in word-segmentation across languages
//     cause numeric discrepancies that must be explained to the user; **the
//     mobile side's stats_clear_sheet.dart has the matching sentence**.

import { shardCatalogue } from './shard';

export const STATS_KEYS = [
  'st_title',
  'st_hint',
  'st_rows',
  'st_transcripts',
  'st_images',
  'st_words',
  'st_text_size',
  'st_picture_size',
  'st_range',
  'st_range_to',
  'st_duration',
  'st_duration_missing',
  'st_duration_none',
  'st_missing_pictures',
  'st_approx',
  'st_by_mobile',
  'st_early',
  'st_early_tip',
  'st_other',
  'st_other_tip',
  'st_empty',
  'st_unit_rows',
  'st_unit_words',
  'cl_title',
  'cl_entry_hint',
  'cl_irreversible',
  'cl_kind_text',
  'cl_kind_images',
  'cl_kind_both',
  'cl_win_week',
  'cl_win_month',
  'cl_win_quarter',
  'cl_win_halfYear',
  'cl_win_year',
  'cl_win_all',
  'cl_preview',
  'cl_frees',
  'cl_nothing',
  'cl_btn',
  'cl_confirm_title',
  'cl_confirm_ok',
  'cl_confirm_cancel',
  'cl_done',
  'cl_cleared_text',
  'cl_cleared_images',
  'cl_cleared_both',
] as const;

export const STATS_STRINGS = shardCatalogue(STATS_KEYS);

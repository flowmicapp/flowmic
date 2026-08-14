// S string catalogue shard: data (export / import, docs/rebuild/16 FPR v1).
// Merged and exported by ../strings.ts.
//
// 🔴 §7-1's disclosure obligation lands on this one sentence,
// `pd_plain_warning`: owner has accepted the tradeoff that "exporting
// produces one unprotected copy" — **and precisely because it's been
// accepted, the warning must be a plain statement of fact, not a
// disclaimer** — ⛔ do not write something like "please keep this safe,"
// whose consequences can't be inferred. Read 16 册 §7 before changing this
// sentence.
//
// 🔴 §5.2「原因要具名，不许只说『格式错误』」("the reason must be named; you
// may not just say 'malformed file'"): the `pd_ref_*` (per-row) and
// `pd_err_*` / `pd_zip_*` (whole-file) entries below are the copy face of
// that red line. Every tag gets its own sentence — **one missing sentence
// means that path has fallen back to "malformed file."** Where the tags
// come from: lib/portable/fpr.ts (RefusalReason / FileRefusal) and
// src-tauri/src/portable/zip.rs (ZipError::tag).
//
// Sentence composition always happens in the component, assembling "label +
// number + unit"; deliberately not opening a new function catalogue for it:
// locale-parity.test.ts automatically guards the S catalogue's key set,
// while a function catalogue would have to be manually registered into that
// test.

// 🔴 owner 2026-08-02 UI batch-1 ③「PC『数据』组从设置迁到时间线页」("the
// PC's 'Data' group moves from Settings to the Timeline page") — the key
// names moved with it:
//   `set_data_title` / `set_data_hint` → `tl_data_title` / `tl_data_hint`;
//   `set_nav_data` **deleted** (its sole consumer was the sixth item in the
//   settings page's left-hand nav, and that item no longer exists ⇒ a
//   user-visible string with zero producers must be retired along with its producer).
// Why it's worth renaming the key rather than keeping the `set_` prefix:
// this repo's #1 bug shape is "one value answers two questions," and a
// `set_*` string rendering on the timeline page is the smallest possible
// version of it — anyone who greps `set_` looking for settings-page copy
// would get back an answer that isn't on the settings page.

import { shardCatalogue } from './shard';

export const PORTABLE_KEYS = [
  'tl_data_title',
  'tl_data_hint',
  'pd_export_title',
  'pd_export_hint',
  'pd_plain_warning',
  'pd_pick_hint',
  'pd_include_pictures',
  'pd_include_pictures_hint',
  'pd_estimate',
  'pd_export_btn',
  'pd_exporting',
  'pd_export_done',
  'pd_export_failed',
  'pd_export_empty',
  'pd_import_title',
  'pd_import_hint',
  'pd_import_btn',
  'pd_importing',
  'pd_import_done',
  'pd_import_partial',
  'pd_import_failed',
  'pd_r_added',
  'pd_r_skipped',
  'pd_r_refused',
  'pd_r_evicted',
  'pd_r_att_missing',
  'pd_r_no_pictures',
  'pd_r_pictures',
  'pd_r_pictures_failed',
  'pd_r_preserve_failed',
  'pd_r_refused_names',
  'pd_unit_rows',
  'pd_at_line',
  'pd_err_no_header',
  'pd_err_version',
  'pd_err_wrong_end_mobile',
  'pd_err_wrong_end',
  'pd_err_count',
  'pd_ref_not_json',
  'pd_ref_unsupported_version',
  'pd_ref_unknown_kind',
  'pd_ref_no_id',
  'pd_ref_bad_created_at',
  'pd_ref_bad_mode',
  'pd_ref_bad_status',
  'pd_ref_bad_entry_type',
  'pd_ref_no_channel',
  'pd_zip_io',
  'pd_zip_not_a_zip',
  'pd_zip_corrupt',
  'pd_zip_compressed',
  'pd_zip_unsafe_name',
  'pd_zip_no_such_entry',
  'pd_zip_bridge',
  'pd_zip_shape',
  'pd_zip_unknown',
  'pd_readme_title',
  'pd_readme_plain',
  'pd_readme_howto',
  'pd_readme_files',
  'pd_readme_exported',
  'pd_readme_count',
  'pd_readme_device',
] as const;

export const PORTABLE_STRINGS = shardCatalogue(PORTABLE_KEYS);

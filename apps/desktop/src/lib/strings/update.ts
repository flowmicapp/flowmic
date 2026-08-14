// String catalogue shard: in-app update (UP-3b). Merged and exported by ../strings.ts.
//
// 🔴 Unknown ≠ up to date. Across this entire table **only `upd_up_to_date`**
// is allowed to say "already up to date"; every other failure mode has its
// own dedicated sentence. `update-view.ts` has a test asserting this across
// every tag, and the Rust side's `update/failure.rs` has a matching one
// (`no_failure_ever_describes_itself_as_up_to_date`) — each side guards its
// own half, because the strings live here and the judgment logic lives
// there.
//
// 🔴 `upd_last_check_*` is not decoration. Design doc §5.0 flags "showing
// only 'up to date' with no 'last successfully checked at …'" as the
// easiest silent failure to miss on this card: a client that **can never
// successfully check** and a client that **just checked** would look
// identical. ⇒ It is the sole evidence backing the "up to date" statement.
//
// 🔴 Each `upd_fail_*` key corresponds to one return value of Rust's
// `UpdateFailure::tag()`, **one-to-one, with no extras allowed**. The guard
// is not a comment: `update-tag-parity.test.ts` reads
// `src-tauri/src/update/failure.rs` in directly **as data**, parses out the
// match arms of `tag()`, and diffs them against the key set here. This is
// one concrete repayment of the debt CLAUDE.md keeps on record — "there is
// no mechanism binding the protocol registry to the phone's own copy of the
// table" — on this particular chain.
//
// ⚠️ Two wording rules (both carried over from the warnings in `failure.rs`
// itself):
//   ① `upd_fail_hash_mismatch` **must not overstate**. A hash mismatch only
//      means "these bytes are not the ones we published" — it does **not**
//      constitute "someone is attacking you"; design §2.1 explicitly notes
//      a compromised VPS could swap out the hash along with everything else.
//   ② Installing the MSI **must not promise an automatic restart** (§4.3 ⑥:
//      the WiX template has no launch-after-install step at all), so
//      `upd_msi_hint` says "please reopen FlowMic after installation
//      completes."

import { shardCatalogue } from './shard';

export const UPDATE_KEYS = [
  'upd_section',
  'upd_current',
  'upd_available',
  'upd_up_to_date',
  'upd_checking',
  'upd_check_now',
  'upd_auto',
  'upd_auto_off_note',
  'upd_last_check',
  'upd_last_check_never',
  'upd_notes',
  'upd_download',
  'upd_downloading',
  'upd_verified',
  'upd_install_msi',
  'upd_msi_hint',
  'upd_install_portable',
  'upd_portable_hint',
  'upd_open_page',
  'upd_dismiss',
  'upd_retry',
  // package format
  'upd_form_unknown',
  'upd_form_unsupported',
  'upd_no_fetchable',
  // outcome of the last attempt (breadcrumb)
  'upd_done',
  'upd_pending_failed',
  'upd_pending_rolled_back',
  // failure modes — one sentence each
  'upd_fail_unreachable',
  'upd_fail_no_manifest_on_server',
  'upd_fail_service_unavailable',
  'upd_fail_unexpected_status',
  'upd_fail_manifest_unusable',
  'upd_fail_no_build_for_platform',
  'upd_fail_own_version_unreadable',
  'upd_fail_artifact_gone',
  'upd_fail_download_failed',
  'upd_fail_cannot_write',
  'upd_fail_cannot_hash',
  'upd_fail_size_mismatch',
  'upd_fail_hash_mismatch',
  'upd_fail_archive_unreadable',
  'upd_fail_archive_layout_unexpected',
  'upd_fail_archive_unsafe_entry',
  'upd_fail_location_not_updatable',
  'upd_fail_extract_failed',
  'upd_fail_archive_compression_unsupported',
  'upd_fail_staged_tree_incomplete',
  'upd_fail_mover_not_launched',
  'upd_fail_installer_not_launched',
] as const;

export const UPDATE_STRINGS = shardCatalogue(UPDATE_KEYS);

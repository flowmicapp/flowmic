// UP-3b — the pure view model for the About card's update block.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §3 table / §5.0 / §5.2
//
// ── WHY A SEPARATE MODULE INSTEAD OF LOGIC IN THE SFC ───────────────────────
//
// Every rule this card can get wrong is a rule about WHICH SENTENCE, and none of
// them need a DOM. Keeping them here means they are asserted against values
// rather than against rendered markup — and it means the one that matters most
// ("unknown ≠ up to date") can be asserted over EVERY possible input at once, which is
// not a thing you can do through a component.

import { DEFAULT_SAAS_ENDPOINT } from '@flowmic/protocol';

/**
 * Where the authoritative release list lives.
 *
 * 🔴 The VALUE is the same as the default relay endpoint today, and the two are
 * still different QUESTIONS: 「which server am I paired with」 vs 「what is the
 * latest FlowMic」. Design §1.1 makes the second a global fact, independent of
 * the first — a user paired to a self-hosted relay must still learn about
 * releases (and that relay correctly answers 404, which has its own sentence).
 *
 * ⇒ It is declared HERE, from the protocol constant, and never read from the
 * cloud config. `update-view.test.ts` pins that it does not come from a
 * `CloudConfig`-shaped object.
 */
export const UPDATE_MANIFEST_BASE = DEFAULT_SAAS_ENDPOINT;

/** The install forms Rust can report. */
export type UpdateForm = 'dev' | 'msi' | 'portable' | 'unknown' | 'unsupported_platform';

export interface UpdateFailureDto {
  tag: string;
  detail: string;
  blocking: boolean;
}

export interface UpdatePendingDto {
  outcome: 'completed' | 'not_completed' | string;
  from: string;
  to: string;
  detail: string | null;
}

export interface UpdateStateDto {
  current_version: string;
  form: UpdateForm | string;
  auto_check: boolean;
  last_success_check: string | null;
  checking: boolean;
  plan: 'not_checked' | 'up_to_date' | 'available' | 'manual_only' | null;
  latest: string | null;
  notes_url: string | null;
  manual_reason: string | null;
  failure: UpdateFailureDto | null;
  download: { active: boolean; received: number; total: number };
  verified_filename: string | null;
  verified_sha256: string | null;
  verified_size: number | null;
  can_swap_in_place: boolean | null;
  pending: UpdatePendingDto | null;
}

/**
 * 🔴 THE EXHAUSTIVE FAILURE → SENTENCE MAP.
 *
 * One entry per `UpdateFailure::tag()` in
 * `apps/desktop/src-tauri/src/update/failure.rs`. There is no fallback branch
 * and no default sentence — `failureKey` returns `null` for an unknown tag, and
 * the card then shows the tag itself rather than inventing copy for a failure
 * nobody wrote a sentence for.
 *
 * ⚠️ **That degradation is deliberate and it is the LESS bad of two options.**
 * Showing a bare identifier is ugly (this repo shipped exactly that once — the
 * `INJ…` truncation of 0.2.53). Showing a generic "update failed" would be worse:
 * it is a sentence that claims to explain and does not, and the user cannot tell
 * it apart from a real explanation. Ugly-and-honest beats fluent-and-wrong.
 *
 * 🔴 The list is bound to Rust's by `update-tag-parity.test.ts`, which reads
 * `failure.rs` as DATA and parses its `tag()` arms. That is not decoration
 * either: CLAUDE.md carries a standing open account —「没有任何机制把协议注册表与
 * 手机那张表绑在一起 ⇒ 下一个新码会以同样的方式变成用户屏幕上的裸标识符，而所有门禁
 * 全绿」(there is no mechanism binding the protocol registry to the phone's own copy
 * of the table ⇒ the next new code will, in the same way, turn into a bare
 * identifier on the user's screen, while every gate stays green). This is that
 * mechanism, for this one table.
 */
export const FAILURE_KEYS: Readonly<Record<string, string>> = {
  unreachable: 'upd_fail_unreachable',
  no_manifest_on_server: 'upd_fail_no_manifest_on_server',
  service_unavailable: 'upd_fail_service_unavailable',
  unexpected_status: 'upd_fail_unexpected_status',
  manifest_unusable: 'upd_fail_manifest_unusable',
  no_build_for_platform: 'upd_fail_no_build_for_platform',
  own_version_unreadable: 'upd_fail_own_version_unreadable',
  artifact_gone: 'upd_fail_artifact_gone',
  download_failed: 'upd_fail_download_failed',
  cannot_write: 'upd_fail_cannot_write',
  cannot_hash: 'upd_fail_cannot_hash',
  size_mismatch: 'upd_fail_size_mismatch',
  hash_mismatch: 'upd_fail_hash_mismatch',
  archive_unreadable: 'upd_fail_archive_unreadable',
  archive_layout_unexpected: 'upd_fail_archive_layout_unexpected',
  archive_unsafe_entry: 'upd_fail_archive_unsafe_entry',
  location_not_updatable: 'upd_fail_location_not_updatable',
  extract_failed: 'upd_fail_extract_failed',
  archive_compression_unsupported: 'upd_fail_archive_compression_unsupported',
  staged_tree_incomplete: 'upd_fail_staged_tree_incomplete',
  mover_not_launched: 'upd_fail_mover_not_launched',
  installer_not_launched: 'upd_fail_installer_not_launched',
};

/** The string key for a failure tag, or `null` when we have no sentence. */
export function failureKey(tag: string): string | null {
  return FAILURE_KEYS[tag] ?? null;
}

/** What the headline line says. */
export type Verdict =
  | { kind: 'hidden' } //  a dev build: we checked nothing and say nothing
  | { kind: 'unknown' } //  never checked, or the check failed — NOT up to date
  | { kind: 'up_to_date' }
  | { kind: 'available'; latest: string }
  | { kind: 'manual_only'; latest: string; reasonKey: string };

const MANUAL_REASON_KEYS: Readonly<Record<string, string>> = {
  unknown_form: 'upd_form_unknown',
  unsupported_platform: 'upd_form_unsupported',
  no_fetchable_kind: 'upd_no_fetchable',
};

/**
 * 🔴 THE ONE RULE: exactly one input produces `up_to_date`.
 *
 * `plan === 'up_to_date'` and nothing else. A `null` plan (never checked this
 * session), a `not_checked` plan (dev build), and every failure all produce
 * `unknown` — because unknown ≠ up to date, and because a client that has never once
 * reached the server must not look like one that just did.
 */
export function verdict(s: UpdateStateDto): Verdict {
  // A dev build checks nothing at all (design §4.2) — so it claims nothing.
  if (s.form === 'dev' || s.plan === 'not_checked') return { kind: 'hidden' };
  // 🔴 A failure NEVER downgrades to "up to date", whatever else is known.
  if (s.failure) return { kind: 'unknown' };
  if (s.plan === 'up_to_date') return { kind: 'up_to_date' };
  if (s.plan === 'available' && s.latest) return { kind: 'available', latest: s.latest };
  if (s.plan === 'manual_only' && s.latest) {
    return {
      kind: 'manual_only',
      latest: s.latest,
      reasonKey: MANUAL_REASON_KEYS[s.manual_reason ?? ''] ?? 'upd_form_unknown',
    };
  }
  return { kind: 'unknown' };
}

/**
 * Should the whole update block be rendered at all?
 *
 * Only a dev build hides it. Everything else shows it, because "a new version is
 * available" is useful even where we cannot install it for you.
 */
export function showsUpdateBlock(s: UpdateStateDto): boolean {
  return s.form !== 'dev';
}

/**
 * 🔴 Is "last successful check" shown? ALWAYS, wherever the block is shown.
 *
 * Design §5.0 names its absence this card's most likely silent failure: without
 * it, a client that has never once reached the server and one that just checked
 * are indistinguishable. It is the only evidence "up to date" has, so it is
 * expressed as an invariant here rather than as a `v-if` somebody can tighten.
 */
export function showsLastCheck(s: UpdateStateDto): boolean {
  return showsUpdateBlock(s);
}

/** The action the primary button performs, given everything known. */
export type Action =
  | { kind: 'none' }
  | { kind: 'download' }
  | { kind: 'install_msi' }
  | { kind: 'install_portable' }
  | { kind: 'open_page' };

/**
 * 🔴 Install is offered ONLY when a package has passed the hash gate.
 *
 * `verified_sha256` is the evidence, and it comes from a Rust type
 * (`VerifiedPackage`) that has no public constructor — so a truthy value here
 * cannot exist unless the bytes were hashed and matched.
 *
 * 🔴 And for the portable form, `can_swap_in_place === false` means the preflight
 * already told us this location cannot be replaced. Offering the button anyway
 * would promise something we know will fail — and it would fail AFTER the app
 * had exited, which is the one moment nothing can report it.
 */
export function action(s: UpdateStateDto): Action {
  const v = verdict(s);
  if (v.kind === 'manual_only') return { kind: 'open_page' };
  if (v.kind !== 'available') return { kind: 'none' };
  if (s.download.active) return { kind: 'none' };
  if (!s.verified_sha256) return { kind: 'download' };
  if (s.form === 'msi') return { kind: 'install_msi' };
  if (s.form === 'portable') {
    return s.can_swap_in_place === false ? { kind: 'open_page' } : { kind: 'install_portable' };
  }
  return { kind: 'open_page' };
}

/** Download progress as a whole percent, or `null` when nothing is running. */
export function progressPercent(s: UpdateStateDto): number | null {
  if (!s.download.active || s.download.total <= 0) return null;
  const pct = Math.floor((s.download.received / s.download.total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/**
 * The "the last update did not complete" / "updated to x" notice.
 *
 * 🔴 `rolledBack` reads the mover's own `detail`, and the distinction it carries
 * is the difference between "it didn't work" and "it didn't work AND your old
 * copy is back where it was". Those are two different nights for a user, so the
 * second sentence is only shown when the mover actually said so.
 */
export function pendingNotice(
  s: UpdateStateDto,
): { kind: 'done'; to: string } | { kind: 'failed'; to: string; rolledBack: boolean } | null {
  if (!s.pending) return null;
  if (s.pending.outcome === 'completed') return { kind: 'done', to: s.pending.to };
  return {
    kind: 'failed',
    to: s.pending.to,
    // Only the mover writes this, and only when it really performed a rollback.
    rolledBack: (s.pending.detail ?? '').startsWith('rolled_back'),
  };
}

/** A byte count for the download button, e.g. `58.2 MB`. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

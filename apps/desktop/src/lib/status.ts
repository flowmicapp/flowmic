// WP-R2-2 five-state delivery badge mapping (master-plan §4.0 D; demo desktop.html
// timeline rows). status records DELIVERY TRUTH ONLY (injected | cached | failed |
// noted); `edited` is an orthogonal overlay bit, NOT a fifth status color — the
// underlying delivery color is preserved and an "已编辑" ("edited") chip is added on top.

import type { HistoryStatus } from '@flowmic/protocol';
import { S } from './strings';
import type { FocusEvidence } from './types';

export interface StatusBadge {
  /** leading glyph shown before the label */
  glyph: string;
  /** status label (without the injection target) */
  label: string;
  /** css class for the status text (st-g / st-y / st-r / st-n) */
  cls: string;
  /** css class for the leading status dot (dot g / y / r / o / n) */
  dot: string;
}

// V2-07.8a: labels are GETTERS, not init-time snapshots — a `label: S.st_cached`
// capture would freeze the language this module happened to boot with, and the
// badge would stay zh after a switch to English (same bug class as the SettingsPage
// SECS array). Reading S during render is what makes the rows re-render.
const BADGES: Record<HistoryStatus, StatusBadge> = {
  injected: { glyph: '✓', get label() { return S.st_injected; }, cls: 'st-g', dot: 'g' },
  cached: { glyph: '⏳', get label() { return S.st_cached; }, cls: 'st-y', dot: 'y' },
  failed: { glyph: '✗', get label() { return S.st_failed; }, cls: 'st-r', dot: 'r' },
  noted: { glyph: '📥', get label() { return S.st_noted; }, cls: 'st-n', dot: 'n' },
};

/** 🔴 A-3's WEAK half of `injected` (owner 2026-08-07). A SEPARATE constant rather
 *  than `{ ...BADGES.injected, label: … }`: spreading an object whose `label` is a
 *  getter EVALUATES it, freezing the language the spread happened to run in — the
 *  exact bug class the getters above exist to avoid. Everything else (glyph, colour,
 *  dot) is identical on purpose: delivered is not a worse OUTCOME, it is the same
 *  outcome with less evidence, so recolouring it would be a second claim. */
const INJECTED_UNCONFIRMED: StatusBadge = {
  glyph: '✓', get label() { return S.st_delivered; }, cls: 'st-g', dot: 'g',
};

/** The badge for a delivery status (defensive default → cached, never blank).
 *
 *  🔴 `evidence` splits `injected` in two and NOTHING ELSE (owner 2026-08-07 A-3,
 *  design §4-1). The `status` enum still has four values; the enum→face mapping is
 *  untouched; there is deliberately NO branch anywhere that reads evidence and
 *  rewrites `status` — 「evidence 是 unknown 所以判成 failed」("evidence is unknown so it's judged failed") would be this repo's
 *  #1 bug shape (one value answering two questions) committed in a new direction.
 *
 *  🔴 ABSENT EVIDENCE TAKES THE WEAK WORD (§C-2). 「我们没问过」("we never asked") can never license
 *  「已确认」("confirmed"), so `undefined` and `'unknown'` and `'not_editable'` all land on delivered.
 *  They are three DIFFERENT facts (see [[FocusEvidence]]) that happen to share one
 *  rendering, which is not the same as being collapsed into one value. */
export function statusBadge(status: HistoryStatus, evidence?: FocusEvidence | null): StatusBadge {
  if (status === 'injected') {
    return evidence === 'editable' ? BADGES.injected : INJECTED_UNCONFIRMED;
  }
  return BADGES[status] ?? BADGES.cached;
}

/** THE ONE COMPOSITION of a row's status line (design §C-2):
 *
 *      {glyph} {resultWord}{ · namedReason}{ → target}{（evidence）}
 *
 *  · `injected` + `editable`  → `✓ 已注入 → 微信（已确认可输入）`
 *  · `injected` + anything else, INCLUDING absent → `✓ 已送入 → 微信（未确认）`
 *  · `cached`   → `⏳ 未注入 · 已缓存 → chrome`  (never an evidence parenthetical:
 *                 nothing was sent, so there is no landing to be confident about)
 *  · `failed`   → `✗ 未注入 → chrome`, or `✗ 未注入 · <具名原因>` when a reason is
 *                 supplied. ⚠️ NO PRODUCTION CALLER SUPPLIES ONE TODAY and the
 *                 parameter is therefore deliberately ABSENT rather than accepted-
 *                 and-never-passed: a parameter with no caller is 反 façade's #1
 *                 shape. A `failed` row carries no verdict code (TimelineRow
 *                 .cached_cause is written for `cached` only), so §C-2's own stated
 *                 fallback 「无映射则只 ✗ 未注入」("if there's no mapping, render just ✗ not injected") is what this end renders. Reported.
 *  · `noted`    → `📥 仅记录`
 *
 *  🔴 `targetLabel` NOW APPLIES TO EVERY STATUS, not just `injected`. Until
 *  2026-08-07 a non-injected row had no window to name (the wire only carried
 *  `inject_target`, and only on success), so the arrow was gated on `injected` —
 *  that gate encoded a DATA gap as a POLICY. With `focus_window` on the failure path
 *  the data exists, owner addendum① asks for exactly it (「注到哪个窗口」("which window did it inject into")), and the
 *  capsule's own failure face has always had this slot (`CapsuleApp.vue`, the
 *  `v-if="state.injectFailed?.target"` that was permanently false) — rebuild vol. 15 §2.5c
 *  requires the two PC surfaces to say one thing, so they now fill the same slot. */
export function statusLine(
  status: HistoryStatus,
  targetLabel?: string | null,
  evidence?: FocusEvidence | null,
): string {
  const b = statusBadge(status, evidence);
  const arrow = targetLabel && targetLabel.length > 0 ? ` ${S.to} ${targetLabel}` : '';
  // The parenthetical rides `injected` alone (§C-2). It is NOT appended to `cached`
  // /`failed`: those rows sent nothing, and 「未注入（未确认）」("not injected (unconfirmed)") would invite the
  // reading 「不确定有没有注进去」("uncertain whether it went in or not") — the one thing we DO know about them.
  const ev = status === 'injected'
    ? (evidence === 'editable' ? S.ev_confirmed : S.ev_unconfirmed)
    : '';
  return `${b.glyph} ${b.label}${arrow}${ev}`;
}

/** Whether the re-inject / make-up-delivery op applies to a row, BY STATUS. All
 *  delivery states can be re-sent — the demo shows re-inject on injected rows
 *  too (a deliberate re-send) — so every status returns true here and `noted`
 *  merely relabels the op to 补投 (make-up).
 *
 *  R6 T-4: the entry KIND is the other half of the judgement and is NOT visible
 *  from a status alone. TimelinePage.rowCanReinject composes the two and
 *  withholds the op for image rows (re-injecting one would type its descriptor
 *  and call that a delivery). This function is status-only on purpose — it has
 *  no row to inspect. */
export function canReinject(status: HistoryStatus): boolean {
  return status === 'injected' || status === 'cached' || status === 'failed' || status === 'noted';
}

/** noted rows carry a 补投 ("inject to PC") action label; others carry 重新注入 ("re-inject"). */
export function reinjectLabel(status: HistoryStatus): string {
  return status === 'noted' ? S.op_makeup : S.op_reinject;
}

// Timeline inject-provenance tooltip (R6 T-7). Pure — only surfaces real
// inject_target fields already reconciled into TimelineRow.target; never invents
// a window title or a timestamp.

import { formatTimelineLabel } from '@flowmic/protocol';
import type { HistoryStatus } from '@flowmic/protocol';
import type { TimelineRow } from './types';

/** "Injected into {window_title} · {time}" (注入到 {window_title} · {时间}) or null when any required field is absent.
 *
 *  owner 2026-07-27 (the PC timeline page went entirely blank, PC 时间线整页空白): the guard was `target === null`, but the
 *  rows rehydrated from `flowmic.history.cache` are written by whatever build was
 *  running at the time and CAN carry no `target` key at all — i.e. `undefined`,
 *  which is not `=== null`. An `injected` row like that walked straight into
 *  `target.window_title` and threw TypeError DURING RENDER, which blanks the whole
 *  TimelinePage (heading and filter chips included, since one throw kills the
 *  component's render). The web console never hit it because a fresh browser
 *  profile has no such cache. `== null` covers both; the field reads are
 *  defensive for the same reason — a persisted row is untyped data at runtime,
 *  not the TimelineRow the compiler was promised. */
export function injectProvenanceTooltip(
  status: HistoryStatus,
  target: TimelineRow['target'],
): string | null {
  if (status !== 'injected' || target == null) return null;
  const title = (target.window_title ?? '').trim() || (target.process_name ?? '').trim();
  const at = target.injected_at?.trim() ?? '';
  if (title.length === 0 || at.length === 0) return null;
  return `注入到 ${title} · ${formatTimelineLabel(at)}`;
}

/** 🔴 "why didn't this row get injected" (这一行为什么没注进去) (owner 2026-08-02 F1a / docs/rebuild/15 §2.5e-4).
 *
 *  A SECOND function rather than a branch inside the one above, because they answer
 *  two questions — "where did it get injected into" vs "why didn't it get injected" — and only one of them can
 *  ever be true of a row. Composed at the call site (`TimelinePage.vue` `provenanceTip`).
 *
 *  ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 *  `cached` now has THREE causes with three different user actions, and the badge says
 *  only "not injected · cached". owner 2026-08-02 hit ③ (focus on FlowMic's own window) and
 *  had nothing to read. The capsule's flash lasts 1.5s and its unmapped-code fallback
 *  literally reads "see the timeline for details" — so before this, that sentence pointed at a surface
 *  that said nothing. This is the landing it names.
 *
 *  `reasons` is the SHARED per-locale table (`INJECT_FAIL_REASON`), passed in rather
 *  than imported so this module stays pure and the capsule + timeline provably read
 *  ONE definition (book 15 §2.5c). An unmapped code yields null — a raw `INJECT_*` token
 *  on a tooltip is not an explanation, and 卡 L7's rule stands: say something the user
 *  can act on, or say nothing extra. */
export function cachedCauseTooltip(
  status: HistoryStatus,
  cachedCause: string | null | undefined,
  reasons: Record<string, string>,
): string | null {
  if (status !== 'cached') return null;
  const code = (cachedCause ?? '').trim();
  if (code.length === 0) return null;
  const sentence = reasons[code];
  return typeof sentence === 'string' && sentence.length > 0 ? sentence : null;
}

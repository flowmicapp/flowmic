// SPEC-REF:
//   apps/desktop/src/lib/cloud-account.ts (④ the quota gauge — this file's only
//     production caller; the sentence is rendered by
//     main-window/components/CloudAccountLines.vue)
//   apps/server-core/src/billing/usage-period.ts (what `QuotaView.period.end`
//     means: the cycle boundary, a calendar-day boundary in UTC)
//   docs/decisions/2026-09-05-owner-usage-cycle-anchored-per-user.md (option 乙 —
//     one cycle per account, anchored to the day it began)
//
// One sentence: when this allowance starts over.
//
// 🔴 ITS OWN FILE FOR A REASON THAT IS NOT ONLY THE 800-LINE CAP. It takes an
// instant and a clock and returns a sentence — it never sees an account, a plan
// or a meter — so it is the one part of the card that can be reasoned about
// without the card. Leaving it inside cloud-account.ts would also have made that
// file import nothing new while growing a second date convention inside a module
// already carrying two (`formatExpiry` for the subscription row, `formatClock`
// for the as-of line); here the reuse is visible in the import list.

import { S } from './strings';
import { formatExpiry } from './channel';

/**
 * ④-ter The sentence under the rail: when this allowance starts over.
 *
 * 🔴 WHY THE GAUGE NEEDS IT AT ALL. "17 / 20 min" tells somebody they are nearly
 * out and says nothing about whether that matters for another hour or another
 * month — and since 2026-09-05 they cannot work it out either: the cycle is
 * anchored to the account (owner's option 乙), so two people reading this card on
 * the same day reset on different dates. The card's own header still says "This
 * month", which was the last true thing anybody could derive.
 *
 * 🔴 TWO REASONS TO SAY NOTHING, AND BOTH MUST STAY SILENT: the server did not
 * send the field (an older relay), or the boundary it sent has already gone by —
 * which means the numbers above are stale, and printing a past instant as a
 * future one would be a confident claim about an allowance we did not measure.
 *
 * ⚠️ THE COUNT IS A DIFFERENCE OF LOCAL CALENDAR DAYS, NOT OF ELAPSED HOURS. A
 * reset 20 hours out is "tomorrow" or "today" depending on which side of local
 * midnight it lands, and the user reads a calendar. Rounding the duration would
 * put "in 1 day" on a reset that happens this evening.
 *
 * ⚠️ AND NO TRANSLATION IS ASKED FOR A PLURAL. `1` never reaches the counted
 * sentence — it has its own — so no language needs a second form of it, and
 * Russian's few/many split is sidestepped with the invariant "дн." this repo
 * already uses for "мин" and "ч".
 */
export function resetLine(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs === null || !Number.isFinite(nowMs)) return null;
  const at = new Date(resetsAtMs);
  const now = new Date(nowMs);
  // Both local calendar days, re-pinned to a clock with no daylight-saving
  // jumps: subtracting two LOCAL midnights across a DST change gives 23 or 25
  // hours, and the truncation turns that into an off-by-one twice a year.
  const days = Math.round(
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())
      - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
      / 86_400_000,
  );
  if (days < 0) return null;
  const relative = days === 0
    ? S.cloud_usage_reset_today
    : days === 1
      ? S.cloud_usage_reset_tomorrow
      : S.cloud_usage_reset_in_days.replace('{days}', String(days));
  // `formatExpiry` is this product's ONE date shape (`YYYY-MM-DD HH:mm`, local,
  // and deliberately not the OS locale's — see channel.ts). Reusing it is what
  // keeps this card from growing a second convention beside the two dates
  // already on it.
  const at_ = formatExpiry(Math.floor(resetsAtMs / 1000));
  if (at_ === null) return null;
  return S.cloud_usage_reset.replace('{at}', at_).replace('{relative}', relative);
}


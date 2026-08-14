// 2026-07-29 device-page polish (D5): relative labels for the paired table's
// recent-activity (最近活动) column —「3 小时前」("3 hours ago") scans, the full stamp moves to the tooltip.
//
// The timeline page's formatter (protocol's formatTimelineLabel) is a different
// style — same-day clock times, no「N 小时前」("N hours ago")— so this is the device page's own
// small helper, in the timeline's spirit (recent = relative, old = full stamp).
// All words come from the S catalogue (devices shard), hand-built date fallback
// so the fixed surface never picks up an OS locale format (the 「UI 不跟随 OS locale」
// ("UI does not follow OS locale") red line), same discipline as paired-mobiles.formatStamp.
//
// Pure and DOM-free like channel.ts: it READS the reactive S at call time, so a
// language switch re-labels on the next render instead of freezing at import.

import { S } from './strings';

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Relative label for an ISO-8601 stamp:
 *    < 1 min        → 刚刚 / Just now   (negative skew reads as「刚刚」("just now") too —
 *                     a clock a few seconds fast is not the future worth saying)
 *    < 1 h          → {n} 分钟前 ("{n} minutes ago")
 *    < 24 h         → {n} 小时前 ("{n} hours ago")
 *    yesterday      → 昨天 ("yesterday")
 *    older          → the fixed YYYY-MM-DD HH:mm stamp (local time)
 *  null / blank / unparseable → null; the caller picks its fallback (the paired
 *  table shows「从未连接」("never connected"), exactly as it did for a missing last_seen_at). */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null || iso.trim() === '') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return S.dev_time_just_now;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return S.dev_time_minutes_ago.replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return S.dev_time_hours_ago.replace('{n}', String(hours));
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDay(d, yesterday)) return S.dev_time_yesterday;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

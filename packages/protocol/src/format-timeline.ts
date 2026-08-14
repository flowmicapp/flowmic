/**
 * SPEC-REF:
 *   docs/rebuild/01-PRODUCT-OVERVIEW.md (history strip timeline)
 *   docs/rebuild/05-DATA-MODEL.md (history drawer rows)
 *
 * Smart relative timestamp for transcript history surfaces. Recent entries
 * stay compact; older entries gain date context automatically.
 */

export type TimelineLocale = 'zh-CN' | 'en';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

/**
 * Format an ISO-8601 timestamp for a history timeline row.
 *
 * - < 60s ago → "刚刚" / "Just now"
 * - same calendar day → HH:mm:ss
 * - yesterday → 昨天 HH:mm / Yesterday HH:mm
 * - same year → MM-DD HH:mm:ss
 * - otherwise → YYYY-MM-DD HH:mm:ss
 */
export function formatTimelineLabel(
  iso: string,
  now: Date = new Date(),
  locale: TimelineLocale = 'zh-CN',
): string {
  // A timestamp read back from a persisted cache / an older wire shape is untyped
  // data at runtime — `iso` really can be undefined or null despite the signature.
  // The invalid-date branch below calls `iso.slice`, which would THROW on those and
  // (from a Vue template) blank the entire surrounding component. A formatter must
  // degrade to an empty label, never take a page down with it.
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.slice(0, 19);
  }

  const diffMs = now.getTime() - d.getTime();
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());

  if (diffMs >= 0 && diffMs < 60_000) {
    return locale === 'zh-CN' ? '刚刚' : 'Just now';
  }

  if (isSameLocalDay(d, now)) {
    return `${hh}:${mm}:${ss}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDay(d, yesterday)) {
    return locale === 'zh-CN'
      ? `昨天 ${hh}:${mm}`
      : `Yesterday ${hh}:${mm}`;
  }

  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  if (d.getFullYear() === now.getFullYear()) {
    return `${month}-${day} ${hh}:${mm}:${ss}`;
  }

  return `${d.getFullYear()}-${month}-${day} ${hh}:${mm}:${ss}`;
}

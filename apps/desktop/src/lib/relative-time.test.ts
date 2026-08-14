// 2026-07-29 device-page polish (D5) — formatRelativeTime.
//
// The assertions read the zh-CN defaults (the locale leaf defaults to zh-CN when
// no explicit choice was ever persisted — the same arrangement channel.test.ts
// relies on for S-derived card copy).

import { beforeEach, describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relative-time';
import { setLocale } from './strings';

beforeEach(() => {
  setLocale('zh-CN');
});

const NOW = new Date('2026-07-29T12:00:00');

describe('formatRelativeTime — the 最近活动 relative label', () => {
  it('null / blank / unparseable → null (the caller picks its fallback)', () => {
    expect(formatRelativeTime(null, NOW)).toBeNull();
    expect(formatRelativeTime('', NOW)).toBeNull();
    expect(formatRelativeTime('not-a-date', NOW)).toBeNull();
  });

  it('under a minute ago (and slight future skew) → 刚刚', () => {
    expect(formatRelativeTime('2026-07-29T11:59:30', NOW)).toBe('刚刚');
    expect(formatRelativeTime('2026-07-29T12:00:00', NOW)).toBe('刚刚');
    expect(formatRelativeTime('2026-07-29T12:00:20', NOW)).toBe('刚刚');
  });

  it('under an hour → {n} 分钟前', () => {
    expect(formatRelativeTime('2026-07-29T11:55:00', NOW)).toBe('5 分钟前');
    expect(formatRelativeTime('2026-07-29T11:01:00', NOW)).toBe('59 分钟前');
  });

  it('under a day → {n} 小时前', () => {
    expect(formatRelativeTime('2026-07-29T09:00:00', NOW)).toBe('3 小时前');
    expect(formatRelativeTime('2026-07-28T13:00:00', NOW)).toBe('23 小时前');
  });

  it('yesterday (calendar day, even beyond 24 h) → 昨天', () => {
    expect(formatRelativeTime('2026-07-28T08:00:00', NOW)).toBe('昨天');
  });

  it('older → the fixed YYYY-MM-DD HH:mm stamp, no OS locale', () => {
    const d = new Date('2026-07-20T08:00:00');
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatRelativeTime('2026-07-20T08:00:00', NOW)).toBe(expected);
  });
});

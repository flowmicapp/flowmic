// FR-D2 (2026-11-06) — the one place the desktop formats a timeline stamp.
//
// protocol's formatTimelineLabel used to take a locale that defaulted to zh-CN,
// and no caller passed one, so an English timeline said 刚刚 on every fresh row.
// It now takes the words as a required argument and holds no language of its own;
// this wrapper reads them from the live catalogue, so a language switch re-labels
// on the next render. Same two words as the device page's relative labels
// (lib/relative-time.ts): one catalogue entry, not two translations of "just now".

import { formatTimelineLabel } from '@flowmic/protocol';
import { S } from './strings';

export function timelineStamp(iso: string, now: Date = new Date()): string {
  return formatTimelineLabel(iso, { justNow: S.dev_time_just_now, yesterday: S.dev_time_yesterday }, now);
}

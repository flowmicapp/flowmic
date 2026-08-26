// The presence key — extracted from DevicesPage.vue 2026-08-26 and asserted
// here for the first time, which is the point: while it lived inside the SFC
// nothing could reach it, and the defect it now carries the fix for went
// unnoticed for exactly that reason.

import { describe, expect, it } from 'vitest';
import { joinEpochSum, presenceKey } from './per-channel-presence';
import type { ConnectionState } from './types';

const row = (o: Partial<ConnectionState>): ConnectionState =>
  ({ connected: true, mobiles: 0, ...o }) as ConnectionState;

describe('presenceKey: one comparable value per channel', () => {
  it('🔴 changes when the SAME phone re-enters, though the count does not', () => {
    // owner, 0.3.33: 「手机端退出后，重进转录界面，PC端没有胶囊窗口」. The count is a
    // set size, so a returning phone leaves it at 1 — and this key is what the
    // page's watch compares, so an unchanged key meant the paired list was never
    // re-read and the QR modal never closed.
    const before = presenceKey({ lan: row({ mobiles: 1, presence_epoch: 4 }) });
    const after = presenceKey({ lan: row({ mobiles: 1, presence_epoch: 5 }) });
    expect(after).not.toBe(before);
  });

  it('is stable when nothing happened — a watch must not fire on every tick', () => {
    const a = presenceKey({ lan: row({ mobiles: 1, presence_epoch: 5 }) });
    const b = presenceKey({ lan: row({ mobiles: 1, presence_epoch: 5 }) });
    expect(a).toBe(b);
  });

  it('a shell that reports no epoch behaves exactly as it did before', () => {
    // The compatibility arm: a missing field must be a STABLE placeholder, not a
    // fresh value each call, or an older shell would re-fire the watch forever.
    const a = presenceKey({ lan: row({ mobiles: 1 }) });
    const b = presenceKey({ lan: row({ mobiles: 1 }) });
    expect(a).toBe(b);
    expect(a).not.toBe(presenceKey({ lan: row({ mobiles: 2 }) }));
  });

  it('still answers per CHANNEL, and in a stable order', () => {
    // The property the original doc was written for (owner 2026-08-02 batch 1 ②):
    // it must not collapse to the primary channel's count.
    const k = presenceKey({
      cloud: row({ mobiles: 0, presence_epoch: 1 }),
      lan: row({ mobiles: 2, presence_epoch: 9 }),
    });
    expect(k).toBe('cloud:0@1|lan:2@9');
    expect(k).not.toBe(presenceKey({ cloud: row({ mobiles: 1, presence_epoch: 1 }), lan: row({ mobiles: 2, presence_epoch: 9 }) }));
  });
});

describe('joinEpochSum: the QR criterion reads JOINS, never presence events', () => {
  it('sums join_epoch across channels', () => {
    expect(joinEpochSum({ lan: row({ join_epoch: 3 }), cloud: row({ join_epoch: 2 }) })).toBe(5);
  });

  it('🔴 a departure moves presence_epoch and must NOT move this sum', () => {
    // The measured false positive (2026-08-26 review): summing presence_epoch
    // here made another handset backgrounding its app — a LEAVE — close the QR
    // modal with a success face. The shell pins the counter split in
    // reconcile.rs; this pins that the frontend reads the right one.
    const before = joinEpochSum({ lan: row({ presence_epoch: 4, join_epoch: 3 }) });
    const afterLeave = joinEpochSum({ lan: row({ presence_epoch: 5, join_epoch: 3 }) });
    expect(afterLeave).toBe(before);
    // …while a JOIN moves it.
    expect(joinEpochSum({ lan: row({ presence_epoch: 6, join_epoch: 4 }) })).toBeGreaterThan(before);
  });

  it('a shell that reports no join_epoch contributes a stable 0 — old rulers only, no mis-fire', () => {
    expect(joinEpochSum({ lan: row({ mobiles: 1 }) })).toBe(0);
    expect(joinEpochSum({ lan: row({ mobiles: 1, presence_epoch: 9 }) })).toBe(0);
  });
});

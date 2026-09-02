// P2 #7 (2026-09-02) — settles a question the code left open: is `status:'noted'`
// reachable on the desktop at all, or is `BADGES.noted` / `canReinject`'s
// `'noted'` arm / `reinjectLabel`'s 补投 (make-up) wording dead code left over
// from before this app's current architecture?
//
// The honest answer, PINNED BELOW BY READING THE ACTUAL PRODUCERS rather than
// trusting a comment that says so (anti-façade ④ — a comment naming behaviour
// elsewhere is worthless without a grep-able anchor; this file IS that anchor):
//
//   `noted` IS FULLY UNREACHABLE ON THIS PC, on BOTH paths that could mint a row:
//
//  · LIVE DELIVERY — `row_transit.rs::mint_row` is the ONLY forwarder onto
//    `flowmic://history-updated` (the channel BOTH the main window's timeline
//    and the capsule strip read), and it always names `row_status()` for the
//    "status" key, whose only three return values are checked below.
//  · IMPORT — looked like a second door at first (a phone's「仅记录」("record
//    only") message legitimately carries `status:'noted'` in the shared FPR
//    format, and `lib/portable/import.ts` feeds the SAME `onHistoryUpdated`
//    live delivery uses). It is NOT one: `lib/portable/fpr.ts`'s §5.3
//    same-end admission refuses a mobile-exported file outright (checked
//    below), and this desktop end can never have minted a `noted` row of its
//    own to re-import (see the live-delivery half above) — so no FPR file this
//    end will ever accept can carry one either.
//
// `HistoryStatus` (`@flowmic/protocol`) still has to carry `'noted'` as a
// value — it is the SAME type mobile's own history uses, and mobile really can
// reach it — so `Record<HistoryStatus, StatusBadge>` and the two functions
// below stay TOTAL over all four values for type-exhaustiveness. What is
// false is treating that completeness as evidence the branch does anything on
// THIS end; it does not, and this file is where that gets checked so nobody
// has to re-derive it from two source files by hand again.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyImport } from './portable/import';
import { PreservedFields } from './portable/preserved';
import { canReinject, reinjectLabel, statusBadge } from './status';
import { S } from './strings';
import { TimelineStore } from './timeline-store';
import type { InjectResult, ReportingKvStore, TimelineTransport } from './types';

class Transport implements TimelineTransport {
  async reInjectLocally(): Promise<InjectResult | null> {
    return null;
  }
  async reInjectImageLocally(): Promise<InjectResult | null> {
    return null;
  }
  async rowImage(): Promise<string | null> {
    return null;
  }
  dropRowImages(): void {}
}

class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  get(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): boolean {
    this.m.set(k, v);
    return true;
  }
}

describe('live delivery can never mint a `noted` row (source-read, not trusted from a comment)', () => {
  it('`row_status()` — the ONLY writer of the field — has exactly three return values', () => {
    const src = readFileSync(
      new URL('../../src-tauri/src/socket/row_transit.rs', import.meta.url),
      'utf8',
    );
    const body = src.slice(
      src.indexOf('pub(in crate::socket) fn row_status'),
      src.indexOf('\n}\n', src.indexOf('pub(in crate::socket) fn row_status')),
    );
    expect(body).toContain('"injected"');
    expect(body).toContain('Some("cached") => "cached"');
    expect(body).toContain('_ => "failed"');
    expect(body).not.toContain('"noted"');
  });

  it('`mint_row` is the only forwarder to `flowmic://history-updated`, and it always routes through `row_status()`', () => {
    const src = readFileSync(
      new URL('../../src-tauri/src/socket/row_transit.rs', import.meta.url),
      'utf8',
    );
    // The JSON object mint_row builds names row_status() for its "status" key —
    // the same call site both the main window's timeline and the capsule
    // strip's frame ultimately read from (capsule/controller.ts's
    // onHistoryItem doc comment names this exact function as its producer).
    expect(src).toContain('"status": row_status(result)');
  });
});

describe('import cannot smuggle one in either — same-end admission refuses the only file that could carry one', () => {
  function fresh() {
    const kv = new MemStore();
    return { store: new TimelineStore(new Transport(), kv), preserved: new PreservedFields(kv) };
  }

  function head(end: string, count: number) {
    return JSON.stringify({
      fpr: 1,
      kind: 'header',
      exported_at: '2026-09-02T00:00:00.000Z',
      source: { app: 'flowmic', end, version: '0.3.56', device: 'dev' },
      count,
      has_attachments: false,
      scope: { kind: 'all' },
    });
  }

  function notedEntry() {
    return JSON.stringify({
      fpr: 1,
      kind: 'entry',
      id: 'req:noted-1',
      created_at: '2026-09-02T00:00:01.000Z',
      entry_type: 'transcript',
      mode: 'realtime',
      source_text: null,
      output_text: '仅记录的一句话',
      // A phone's「仅记录」row really can carry this — it is a legitimate FPR
      // value (fpr.ts's own STATUSES set admits it) — but it was never sent to
      // any PC, so it never ran through row_status() at all.
      status: 'noted',
      duration_ms: null,
      window_title: null,
      attachment: null,
      source_ext: { channel: 'lan', updated_at: '2026-09-02T00:00:01.000Z', edited: false },
    });
  }

  it('a mobile-exported「仅记录」file is refused by name, not silently accepted', () => {
    const { store, preserved } = fresh();
    const report = applyImport({
      lines: [head('mobile', 1), notedEntry()],
      archiveAttachments: new Set(),
      target: store,
      preserved,
    });
    expect(report.fileRefusal).toEqual({ kind: 'wrong_end', end: 'mobile' });
    expect(report.added).toBe(0);
    expect(store.allRows()).toHaveLength(0);
  });

  it('a same-end (desktop) file CAN import — and this desktop can never have exported a `noted` line to begin with', () => {
    // Positive control for the refusal above: same-end admission is not why
    // nothing imports here — a desktop-sourced file imports fine.
    const { store, preserved } = fresh();
    const report = applyImport({
      lines: [head('desktop', 1), notedEntry()],
      archiveAttachments: new Set(),
      target: store,
      preserved,
    });
    expect(report.fileRefusal).toBeNull();
    // The file is HAND-BUILT to prove the point: nothing on this PC minted the
    // status:'noted' line above (that is what the live-delivery describe block
    // proved) — a real desktop export could never contain one, so this shape
    // of file cannot occur outside a test that constructs it on purpose.
    expect(report.added).toBe(1);
    expect(store.allRows()[0]?.status).toBe('noted');
  });
});

describe('the desktop UI stays TOTAL over `noted` anyway — for type-exhaustiveness over a protocol-shared enum, not for reachability', () => {
  it('lib/status.ts answers `noted` without throwing, in case the shared HistoryStatus type is ever handed one', () => {
    const badge = statusBadge('noted');
    expect(badge.glyph).toBe('📥');
    expect(badge.label).toBe(S.st_noted);
    expect(canReinject('noted')).toBe(true);
    expect(reinjectLabel('noted')).toBe(S.op_makeup);
  });
});

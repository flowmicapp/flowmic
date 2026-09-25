// Task A L-7: drive the production store/controller and render BOTH real screens.
// The storage seam is memory-only; this proves UI/persistence encoding, not XTEST.
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('../lib/storage', () => ({ localKv: {
  get: (key: string) => storage.get(key) ?? null,
  set: (key: string, value: string) => { storage.set(key, value); return true; },
} }));

import TimelinePage from './TimelinePage.vue';
import CapsuleApp from '../capsule/CapsuleApp.vue';
import { timeline } from './store';
import { onInjectResult, fireTickForTest, state } from '../capsule/controller';
import { INJECT_FAIL_REASON, S, setLocale } from '../lib/strings';
import { normalizeCachedRow } from '../lib/timeline-normalize';
import { ROWS_KEY } from '../lib/timeline-hydration';
import { buildHeader, readEntry, rowToEntry } from '../lib/portable/fpr';
import { applyImport } from '../lib/portable/import';
import { PreservedFields } from '../lib/portable/preserved';
import { rowKey } from '../lib/timeline-address';
import { TimelineStore } from '../lib/timeline-store';
import { timelineTransport } from '../lib/bridge';
import { localKv } from '../lib/storage';

describe('Linux native verdicts reach the actual desktop screens', () => {
  it.each([
    ['INJECT_SUBMISSION_UNCERTAIN', 'clipboard', 'cached'],
    ['INJECT_WAYLAND_UNSUPPORTED', 'cached', 'cached'],
    ['INJECT_DISPLAY_UNAVAILABLE', 'cached', 'cached'],
  ] as const)('preserves %s cause through FPR export import reload and real TimelinePage', async (error, mode, status) => {
    setLocale('en');
    for (const row of timeline.allRows()) timeline.remove(row.id, row.channel);
    const id = `req:fpr-${error}`;
    timeline.onHistoryUpdated({ id, mode: 'realtime', status,
      output_text: 'FPR retained content', source_text: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    }, 'lan');
    timeline.onInjectResult({ ok: false, mode, error, row_id: id, channel: 'lan' });
    const entry = rowToEntry(timeline.allRows()[0]!, null, null);
    expect(entry.source_ext.cached_cause).toBe(error);
    entry.source_ext.future_metadata = { retained: true };
    const lines = [JSON.stringify(buildHeader({ now: new Date(), version: 'test', device: null,
      count: 1, hasAttachments: false, truncatedBefore: null })), JSON.stringify(entry)];
    timeline.remove(id, 'lan');
    const preserved = new PreservedFields({ get: key => storage.get(key) ?? null,
      set: (key, value) => { storage.set(key, value); return true; } });
    const input = { lines, archiveAttachments: new Set<string>(), target: timeline, preserved };
    expect(applyImport(input).added).toBe(1);
    expect(applyImport(input).skipped).toBe(1);
    const restored = new TimelineStore(timelineTransport, localKv).allRows()[0];
    expect(restored?.status).toBe(status);
    expect(restored?.cached_cause).toBe(error);
    expect(restored?.output_text).toBe('FPR retained content');
    const page = await renderToString(createSSRApp(TimelinePage));
    expect(page).toContain(INJECT_FAIL_REASON[error]);
    expect(page).toContain(error === 'INJECT_SUBMISSION_UNCERTAIN' ? S.st_uncertain : S.st_cached);
    const saved = preserved.get(rowKey('lan', id));
    expect(rowToEntry(restored!, null, saved).source_ext.future_metadata).toEqual({ retained: true });
    // A later real success clears the reason; preserved import data cannot revive it.
    timeline.onInjectResult({ ok: true, mode: 'clipboard', row_id: id, channel: 'lan' });
    expect(rowToEntry(timeline.allRows()[0]!, null, saved).source_ext.cached_cause).toBeNull();
  });
  it.each([undefined, null, '', 42, {}, ['INJECT_SUBMISSION_UNCERTAIN'], 'FUTURE_CAUSE'])
  ('FPR narrows imported cause %j without accepting it from live bridge items', (cause) => {
    for (const row of timeline.allRows()) timeline.remove(row.id, row.channel);
    const entry = { fpr: 1, kind: 'entry', id: 'req:legacy-fpr', mode: 'realtime', status: 'cached',
      entry_type: 'transcript', output_text: 'legacy content', created_at: '2026-09-21T10:00:00Z',
      source_ext: { channel: 'lan', cached_cause: cause } };
    const parsed = readEntry(JSON.stringify(entry));
    expect('item' in parsed).toBe(true);
    if (!('item' in parsed)) throw new Error('valid same-end record');
    expect(parsed.item).not.toHaveProperty('cached_cause');
    const bridgeItem = { ...parsed.item, cached_cause: 'INJECT_SUBMISSION_UNCERTAIN' };
    timeline.onHistoryUpdated(bridgeItem, 'lan');
    expect(timeline.allRows()[0]?.cached_cause).toBeNull();
    timeline.remove(entry.id, 'lan');
    const report = applyImport({ target: timeline, archiveAttachments: new Set(),
      preserved: new PreservedFields(localKv), lines: [
        JSON.stringify(buildHeader({ now: new Date(), version: 'test', device: null,
          count: 1, hasAttachments: false, truncatedBefore: null })), JSON.stringify(entry),
      ] });
    expect(report.added).toBe(1);
    expect(timeline.allRows()[0]?.cached_cause).toBe(cause === 'FUTURE_CAUSE' ? cause : null);
  });
  it('shows an uncertain control receipt without offering to repeat the key', async () => {
    setLocale('en');
    for (const row of timeline.allRows()) timeline.remove(row.id, row.channel);
    timeline.onHistoryUpdated({ id: 'req:uncertain-control', mode: 'realtime', status: 'cached',
      entry_type: 'control', control_kind: 'enter', control_outcome: 'submission_uncertain',
      output_text: '', source_text: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    }, 'lan');
    const page = await renderToString(createSSRApp(TimelinePage));
    expect(page).toContain(S.st_uncertain);
    expect(page).toContain(INJECT_FAIL_REASON.INJECT_SUBMISSION_UNCERTAIN);
    expect(page).toContain(S.ck_enter);
    expect(page).not.toContain(`title="${S.op_reinject}"`);
  });
  it.each([
    ['INJECT_SUBMISSION_UNCERTAIN', 'clipboard', 'cached'],
    ['INJECT_WAYLAND_UNSUPPORTED', 'cached', 'cached'],
  ] as const)('%s survives storage and renders on timeline and capsule', async (error, mode, status) => {
    setLocale('en');
    for (const row of timeline.allRows()) timeline.remove(row.id, row.channel);
    const id = `req:${error}`;
    timeline.onHistoryUpdated({ id, mode: 'realtime', status,
      output_text: 'Linux verification message', source_text: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    }, 'lan');
    const verdict = { ok: false, mode, error, row_id: id, channel: 'lan' as const,
      focus_evidence: 'unknown' as const,
      focus_window: { process_name: 'gtk-peer', window_title: 'External test target' } };
    timeline.onInjectResult(verdict);
    const persisted = JSON.parse(storage.get(ROWS_KEY)!);
    expect(persisted).toHaveLength(1);
    const restored = normalizeCachedRow(persisted[0]);
    expect(restored?.status).toBe(status);
    expect(restored?.output_text).toBe('Linux verification message');
    expect(restored?.cached_cause).toBe(error);
    const exported = readEntry(JSON.stringify(rowToEntry(restored!, null, null)));
    expect('item' in exported && exported.item.status).toBe(status);
    const page = await renderToString(createSSRApp(TimelinePage));
    expect(page).toContain('Linux verification message');
    expect(page).toContain(INJECT_FAIL_REASON[error]);
    expect(page).toContain(error === 'INJECT_SUBMISSION_UNCERTAIN' ? S.st_uncertain : S.st_cached);
    onInjectResult(verdict);
    fireTickForTest();
    expect(state.form).toBe('inject_failed'); // layout form, not the verdict status
    const capsule = await renderToString(createSSRApp(CapsuleApp));
    expect(capsule).toContain(INJECT_FAIL_REASON[error]);
    expect(capsule).toContain(error === 'INJECT_SUBMISSION_UNCERTAIN' ? S.st_uncertain : S.st_cached);
    if (error === 'INJECT_SUBMISSION_UNCERTAIN') {
      expect(capsule).not.toContain(S.cap_inject_failed);
      expect(capsule).not.toContain(S.cap_cached);
      timeline.onHistoryUpdated({ id, mode: 'realtime', status: 'failed',
        output_text: 'contradicting replay', source_text: null,
        created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
      }, 'lan');
      expect(timeline.entries()[0]!.status).toBe('cached');
    }
  });
});

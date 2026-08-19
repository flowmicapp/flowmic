// Lane L1 (2026-08-19) — the failed row's WHY, asserted on the ROW.
// Split out of timeline-store.test.ts the day it was written: that file sits at a
// pinned file-size debt (verify/lint/file-size.mjs — may shrink, never grow), so
// the new suite lives here and both files read ONE fixture definition from
// ./timeline-store-test-support.ts.

import { describe, expect, it } from 'vitest';
import { TimelineStore } from './timeline-store';
import { MemStore, RecordingTransport, fresh, item, seed, verdict } from './timeline-store-test-support';

// 🔴 2026-08-19 — the verdict CODE stays on the row for BOTH not-injected statuses.
// Until this date `onInjectResult` nulled it for `failed`, defended by the comment
// "the ✗ face already names its own failure" — which was true of the capsule's 1.5s
// flash and never of the row, so the PC user had no durable answer while the phone
// named the reason since 0.2.53 (this lane's whole finding). These assert what the
// ROW ends up carrying, not that any function was called.
//
// NEGATIVE CONTROL, observed red 2026-08-19 (machine: LAN box, this repo): with the
// store line reverted to `result.mode === 'cached' ? (result.error ?? null) : null`,
// TWO of the tests below went red — this one, verbatim:
//     AssertionError: the code must survive onto the failed row — dropping it here
//     re-opens the 2026-08-19 gap: expected null to be 'INJECT_SENDINPUT_FAIL'
//     // Object.is equality
// and the restart test with `expected null to be 'INJECT_CLIPBOARD_FAIL'`. The
// revert was then undone by hand and the file re-ran green (see the lane report).
describe('TimelineStore — a failed row carries WHY, exactly like a cached row', () => {
  it('a failed verdict’s error code survives onto the row (negative control target)', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected' })]);
    store.onInjectResult(verdict('1', { ok: false, mode: 'sendinput', error: 'INJECT_SENDINPUT_FAIL' }));
    const row = store.entries().find((r) => r.id === '1');
    expect(row?.status).toBe('failed');
    expect(
      row?.cached_cause,
      'the code must survive onto the failed row — dropping it here re-opens the 2026-08-19 gap',
    ).toBe('INJECT_SENDINPUT_FAIL');
  });

  it('the cached half is unchanged: a cached verdict keeps its cause too', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected' })]);
    store.onInjectResult(verdict('1', { ok: false, mode: 'cached', error: 'INJECT_SELF_WINDOW_NO_INPUT' }));
    const row = store.entries().find((r) => r.id === '1');
    expect(row?.status).toBe('cached');
    expect(row?.cached_cause).toBe('INJECT_SELF_WINDOW_NO_INPUT');
  });

  it('a failed verdict that names no code leaves null — never an invented cause', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected' })]);
    store.onInjectResult(verdict('1', { ok: false, mode: 'sendinput' }));
    expect(store.entries().find((r) => r.id === '1')?.cached_cause).toBeNull();
  });

  it('a later successful verdict clears the cause (book 15 §2.5e-4: landed ⇒ nothing left to explain)', () => {
    const { store } = fresh();
    seed(store, [item('1', { status: 'injected' })]);
    store.onInjectResult(verdict('1', { ok: false, mode: 'sendinput', error: 'INJECT_SENDINPUT_FAIL' }));
    store.onInjectResult(verdict('1', { ok: true, mode: 'sendinput' }));
    const row = store.entries().find((r) => r.id === '1');
    expect(row?.status).toBe('injected');
    expect(row?.cached_cause).toBeNull();
  });

  it('the failed row’s cause survives a restart — the durable surface is the point', () => {
    const kv = new MemStore();
    const s1 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    seed(s1, [item('1', { status: 'injected' })]);
    s1.onInjectResult(verdict('1', { ok: false, mode: 'clipboard', error: 'INJECT_CLIPBOARD_FAIL' }));
    const s2 = new TimelineStore(new RecordingTransport(), kv, () => 1_000);
    const row = s2.entries().find((r) => r.id === '1');
    expect(row?.status).toBe('failed');
    expect(row?.cached_cause).toBe('INJECT_CLIPBOARD_FAIL');
  });
});

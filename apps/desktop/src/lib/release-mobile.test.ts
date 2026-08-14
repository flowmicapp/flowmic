// GA-08 — the device page's 「断开｜撤销」("disconnect | revoke") action core.
//
// What is worth testing here is not the happy path but the three guards, because
// each of them is the difference between a correct UI and a dangerous one: a
// revoke reachable without confirmation (permanent, irreversible), a failed call
// painted as success, and two overlapping actions racing their refreshes.
//
// The exact wire payload is asserted too — this card is the FIRST production
// emitter of pc:release-mobile, so「which flag did the button actually send」 has
// no prior coverage anywhere.

import { describe, it, expect, vi } from 'vitest';
import {
  askRevoke,
  cancelRevoke,
  newReleaseState,
  performRelease,
  type ReleaseDeps,
} from './release-mobile';

function deps(ok = true): ReleaseDeps & { calls: [string, boolean][]; reloads: number } {
  const calls: [string, boolean][] = [];
  let reloads = 0;
  return {
    calls,
    get reloads() { return reloads; },
    async release(id, revoke) { calls.push([id, revoke]); return ok; },
    async reload() { reloads += 1; },
  };
}

describe('断开 — the payload and the refresh', () => {
  it('sends revoke=false with no confirmation step, then refreshes the table', async () => {
    const s = newReleaseState();
    const d = deps(true);
    expect(await performRelease(s, d, 'pair-1', false)).toBe(true);
    expect(d.calls).toEqual([['pair-1', false]]);
    expect(d.reloads).toBe(1);
    expect(s).toEqual({ confirmId: null, busyId: null, failedId: null });
  });
});

describe('撤销 — gated on a second confirmation', () => {
  it('sends NOTHING until this row has been confirmed', async () => {
    const s = newReleaseState();
    const d = deps(true);
    // Straight to revoke: refused locally, no wire traffic at all.
    expect(await performRelease(s, d, 'pair-1', true)).toBe(false);
    expect(d.calls).toEqual([]);
    // …and it is not reported as a failure: it is a UI precondition, not a
    // server verdict (a loud red row here would be a lie).
    expect(s.failedId).toBeNull();
  });

  it('a confirmation on ANOTHER row does not authorise this one', async () => {
    const s = newReleaseState();
    const d = deps(true);
    askRevoke(s, 'pair-2');
    expect(await performRelease(s, d, 'pair-1', true)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it('sends revoke=true once confirmed, and clears the confirmation', async () => {
    const s = newReleaseState();
    const d = deps(true);
    askRevoke(s, 'pair-1');
    expect(s.confirmId).toBe('pair-1');
    expect(await performRelease(s, d, 'pair-1', true)).toBe(true);
    expect(d.calls).toEqual([['pair-1', true]]);
    expect(d.reloads).toBe(1);
    expect(s.confirmId).toBeNull();
  });

  it('cancelling closes the prompt and re-arms the gate', async () => {
    const s = newReleaseState();
    const d = deps(true);
    askRevoke(s, 'pair-1');
    cancelRevoke(s);
    expect(await performRelease(s, d, 'pair-1', true)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('a refused / timed-out action', () => {
  it('goes loud on that row and does NOT refresh the table', async () => {
    const s = newReleaseState();
    const d = deps(false);
    expect(await performRelease(s, d, 'pair-1', false)).toBe(false);
    expect(d.calls).toEqual([['pair-1', false]]);
    // Re-rendering the same list would be indistinguishable from success.
    expect(d.reloads).toBe(0);
    expect(s.failedId).toBe('pair-1');
  });

  it('keeps the revoke confirmation open so the user can retry the SAME act', async () => {
    const s = newReleaseState();
    const d = deps(false);
    askRevoke(s, 'pair-1');
    await performRelease(s, d, 'pair-1', true);
    expect(s.confirmId).toBe('pair-1');
    expect(s.failedId).toBe('pair-1');
    expect(s.busyId).toBeNull(); // released even on the failure path
  });

  it('a later success clears the stale failure notice', async () => {
    const s = newReleaseState();
    const bad = deps(false);
    await performRelease(s, bad, 'pair-1', false);
    expect(s.failedId).toBe('pair-1');
    const good = deps(true);
    await performRelease(s, good, 'pair-1', false);
    expect(s.failedId).toBeNull();
  });
});

describe('one action at a time', () => {
  it('drops a second click while one is in flight', async () => {
    const s = newReleaseState();
    const calls: [string, boolean][] = [];
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((r) => { unblock = r; });
    const reload = vi.fn(async () => {});
    const d: ReleaseDeps = {
      async release(id, revoke) { calls.push([id, revoke]); await gate; return true; },
      reload,
    };
    const first = performRelease(s, d, 'pair-1', false);
    expect(s.busyId).toBe('pair-1');
    // A second click (even on a different row) is dropped, not queued.
    expect(await performRelease(s, d, 'pair-2', false)).toBe(false);
    expect(calls).toEqual([['pair-1', false]]);
    unblock!();
    expect(await first).toBe(true);
    expect(s.busyId).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// ── v0.2.7 · Revoke must be sent to the server that owns this row ──────────────────────────
//
// owner 2026-07-29:「PC 端这条无法撤销，提示成功，但仍然还在」("on the PC side this one can't be revoked — it reports success, but it's still there"). The two channels
// are two servers with two `mobile_pairings` tables — which is exactly why the
// table has tagged every row with its channel since v0.2.1. The buttons were the
// one place that never passed the tag on, so the frame went to whichever channel
// was PRIMARY: revoking a local-LAN row while cloud was primary asked the relay
// to delete a pairing it had never heard of.
describe('performRelease — the row is revoked on ITS OWN channel', () => {
  it('passes the row channel through to the bridge', async () => {
    const seen: Array<[string, boolean, string | undefined]> = [];
    const state = newReleaseState();
    askRevoke(state, 'p-lan');
    await performRelease(
      state,
      {
        release: async (id, revoke, channel) => {
          seen.push([id, revoke, channel]);
          return true;
        },
        reload: async () => {},
      },
      'p-lan',
      true,
      'lan',
    );
    expect(seen).toEqual([['p-lan', true, 'lan']]);
  });

  it('a revoke the server did not perform stays LOUD and does not refresh', async () => {
    // The symptom, as a test: the old code refreshed the table on `ok`, so the
    // row came back and the user was told it worked. Rule ② already covered a
    // refusal; what changed is that 「ok but revoked 0」 now IS a refusal.
    let reloaded = 0;
    const state = newReleaseState();
    askRevoke(state, 'p-lan');
    const ok = await performRelease(
      state,
      { release: async () => false, reload: async () => { reloaded++; } },
      'p-lan',
      true,
      'lan',
    );
    expect(ok).toBe(false);
    expect(reloaded).toBe(0);
    expect(state.failedId).toBe('p-lan');
    expect(state.confirmId).toBe('p-lan'); // the confirmation stays open to retry
  });
});

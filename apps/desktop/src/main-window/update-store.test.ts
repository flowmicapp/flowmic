// UP-3c — behavior of the app-scope update store.
//
// What these prove, and why here rather than in a component test:
//   · the boot order (push listener BEFORE the snapshot pull — RV-24's rule:
//     a frame arriving between a pull and a listen is lost for good),
//   · the dev-build silence (design §4.2's "a dev build never checks"),
//   · the badge boolean's mapping (available OR manual_only, and NEVER while
//     a failure is standing),
//   · one owner (a second init does not ask again),
//   · the 24 h recheck for a tray-resident window that never restarts, and
//     the states that must SUPPRESS a tick (an active download, a verified
//     package waiting on the user).
// What the user can READ is pinned by update-block.test.ts; this file is
// about when the store talks to Rust and what the badge may claim.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UPDATE_MANIFEST_BASE, type UpdateStateDto } from '../lib/update-view';

/** Every bridge/tauri touch lands here, in call order. */
const seq: string[] = [];
/** What `update_state` (and, by default, every command) answers. */
let stateAnswer: Partial<UpdateStateDto> = {};

function dto(over: Partial<UpdateStateDto> = {}): UpdateStateDto {
  return {
    current_version: '0.3.11',
    form: 'portable',
    auto_check: true,
    last_success_check: null,
    checking: false,
    plan: null,
    latest: null,
    notes_url: null,
    manual_reason: null,
    failure: null,
    download: { active: false, received: 0, total: 0 },
    verified_filename: null,
    verified_sha256: null,
    verified_size: null,
    can_swap_in_place: null,
    pending: null,
    ...over,
  };
}

vi.mock('../lib/bridge', () => ({
  invokeSafe: async (cmd: string, args?: Record<string, unknown>) => {
    const base = args && 'base' in args ? `:${String(args.base)}` : '';
    seq.push(`invoke:${cmd}${base}`);
    return dto(stateAnswer);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string) => {
    seq.push(`listen:${name}`);
    return () => {};
  },
}));

/** A fresh copy of the module per test — `started` is module state on purpose
 *  (one owner per window), so tests must not share an instance. */
async function fresh() {
  vi.resetModules();
  return await import('./update-store');
}

const checksIssued = () => seq.filter((s) => s.startsWith('invoke:update_check')).length;
/** Flush the `void updateCheckNow()` fired inside init (real timers only). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  seq.length = 0;
  stateAnswer = {};
  vi.useRealTimers();
});

describe('initUpdateStore', () => {
  it('🔴 registers the push listener BEFORE pulling the snapshot (RV-24)', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    const listenAt = seq.indexOf('listen:update:state');
    const pullAt = seq.indexOf('invoke:update_state');
    expect(listenAt, 'the update:state listener was never registered').toBeGreaterThanOrEqual(0);
    expect(pullAt, 'the snapshot was never pulled').toBeGreaterThanOrEqual(0);
    expect(listenAt, 'listener must come before the pull').toBeLessThan(pullAt);
  });

  it('fires the automatic check once, against UPDATE_MANIFEST_BASE', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(seq).toContain(`invoke:update_check:${UPDATE_MANIFEST_BASE}`);
    expect(checksIssued()).toBe(1);
  });

  it('🔴 a dev build never checks (design §4.2)', async () => {
    stateAnswer = { form: 'dev' };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(checksIssued()).toBe(0);
  });

  it('auto_check = false means no automatic check — the manual button still works', async () => {
    stateAnswer = { auto_check: false };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(checksIssued()).toBe(0);
    await store.updateCheckNow();
    expect(checksIssued()).toBe(1);
  });

  it('a second init does not ask again (one owner per window)', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    const before = seq.length;
    await store.initUpdateStore();
    await settle();
    expect(seq.length).toBe(before);
  });
});

describe('updateAvailable (the badge boolean)', () => {
  it('lights for `available` — a fetchable new version', async () => {
    stateAnswer = { plan: 'available', latest: '9.9.9' };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(store.updateAvailable.value).toBe(true);
  });

  it('lights for `manual_only` too — "there is news" even where we cannot install', async () => {
    stateAnswer = {
      form: 'unsupported_platform',
      plan: 'manual_only',
      latest: '9.9.9',
      manual_reason: 'unsupported_platform',
    };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(store.updateAvailable.value).toBe(true);
  });

  it('🔴 a standing failure never lights it, whatever the stale plan says', async () => {
    stateAnswer = {
      plan: 'available',
      latest: '9.9.9',
      failure: { tag: 'unreachable', detail: 'x', blocking: false },
    };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(store.updateAvailable.value).toBe(false);
  });

  it('stays dark before Rust has answered anything', async () => {
    const store = await fresh();
    expect(store.updateAvailable.value).toBe(false);
  });
});

describe('the 24 h recheck', () => {
  it('re-asks once per UPDATE_RECHECK_MS while the window lives', async () => {
    vi.useFakeTimers();
    const store = await fresh();
    await store.initUpdateStore();
    await vi.advanceTimersByTimeAsync(0);
    const boot = checksIssued();
    await vi.advanceTimersByTimeAsync(store.UPDATE_RECHECK_MS);
    expect(checksIssued()).toBe(boot + 1);
    await vi.advanceTimersByTimeAsync(store.UPDATE_RECHECK_MS);
    expect(checksIssued()).toBe(boot + 2);
  });

  it('🔴 a tick is suppressed mid-download — and so is the boot check', async () => {
    vi.useFakeTimers();
    stateAnswer = { download: { active: true, received: 1, total: 2 } };
    const store = await fresh();
    await store.initUpdateStore();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(store.UPDATE_RECHECK_MS);
    expect(checksIssued()).toBe(0);
  });

  it('🔴 a tick is suppressed while a verified package waits on the user', async () => {
    vi.useFakeTimers();
    stateAnswer = { plan: 'available', latest: '9.9.9', verified_sha256: 'a'.repeat(64) };
    const store = await fresh();
    await store.initUpdateStore();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(store.UPDATE_RECHECK_MS);
    expect(checksIssued()).toBe(0);
  });
});

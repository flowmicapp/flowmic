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
import {
  UPDATE_MANIFEST_BASE,
  progressPercent,
  type UpdateStateDto,
} from '../lib/update-view';

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

/** The handler the store registered, so a test can push a frame at it. */
let pushed: ((e: { payload: unknown }) => void) | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    seq.push(`listen:${name}`);
    pushed = cb;
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
  pushed = null;
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

describe('the pushed frame', () => {
  /**
   * 🔴 THE THROTTLED PROGRESS FRAGMENT (0.3.33).
   *
   * `update_download` emits two kinds of frame on `update:state`: whole states
   * at the start and the end, and — every 120 ms in between — a fragment shaped
   * `{ progress: { received, total } }`. The handler used to adopt a payload
   * only when it carried `current_version`, which is true of the whole states
   * and false of every fragment ⇒ all of them were dropped.
   *
   * The visible cost was not "no progress bar": the opening whole state sets
   * `active: true, received: 0`, so the card rendered 「正在下载 0%」 and STAYED
   * there for the entire transfer. A 48 MB MSI on a slow line is minutes of a
   * bar that has not moved, which reads as a hang — and the report this round
   * began with was 「点了没反应」-shaped already.
   */
  it('🔴 a progress fragment moves the percent while a download is running', async () => {
    stateAnswer = {
      plan: 'available',
      latest: '9.9.9',
      download: { active: true, received: 0, total: 1000 },
    };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(progressPercent(store.updateState.value)).toBe(0);

    pushed?.({ payload: { progress: { received: 250, total: 1000 } } });
    expect(progressPercent(store.updateState.value)).toBe(25);

    pushed?.({ payload: { progress: { received: 1000, total: 1000 } } });
    expect(progressPercent(store.updateState.value)).toBe(100);
  });

  /**
   * 🔴 A fragment UPDATES a download; it never STARTS one.
   *
   * The progress frames are emitted from the download's own thread while the
   * closing whole state comes from the command thread, so "a late fragment
   * arrives after the finish" is an ordering that can really happen. Letting a
   * fragment set `active` would put the card back into a download that has
   * already completed — inventing a state out of a frame that only ever meant
   * "here is a number".
   */
  it('🔴 a fragment does not resurrect a download that is not running', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();

    pushed?.({ payload: { progress: { received: 250, total: 1000 } } });
    expect(store.updateState.value.download.active).toBe(false);
    expect(progressPercent(store.updateState.value)).toBeNull();
  });

  /** A whole state still replaces the snapshot outright — the original rule. */
  it('adopts a whole state wholesale', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();

    pushed?.({ payload: dto({ current_version: '9.9.9', plan: 'up_to_date' }) });
    expect(store.updateState.value.current_version).toBe('9.9.9');
  });

  /** Junk is discarded rather than merged — neither shape, no adoption. */
  it('ignores a frame that is neither a state nor a progress fragment', async () => {
    stateAnswer = { download: { active: true, received: 7, total: 100 } };
    const store = await fresh();
    await store.initUpdateStore();
    await settle();

    pushed?.({ payload: { progress: { received: 'lots' } } });
    pushed?.({ payload: null });
    pushed?.({ payload: 'nope' });
    expect(store.updateState.value.download.received).toBe(7);
  });
});

describe('the busy verb', () => {
  /**
   * 🔴 The card has to say WHICH thing is running, so the store carries a verb
   * rather than a boolean. `LocalModelCard`'s store already works this way;
   * this follows it instead of inventing a second shape.
   *
   * ⚠️ Asserted by watching the ref DURING the call, not after — the value this
   * feature depends on exists only while the invoke is in flight, and a test
   * that read it afterwards would assert `null` and pass against a store that
   * never set anything at all.
   */
  it('🔴 carries the verb while the command is in flight, and clears it after', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    expect(store.updateBusy.value).toBe(null);

    const seen: (string | null)[] = [];
    const check = store.updateCheckNow();
    seen.push(store.updateBusy.value);
    await check;
    seen.push(store.updateBusy.value);

    const dl = store.updateDownload();
    seen.push(store.updateBusy.value);
    await dl;

    const apply = store.updateApply();
    seen.push(store.updateBusy.value);
    await apply;

    expect(seen).toEqual(['checking', null, 'downloading', 'installing']);
    expect(store.updateBusy.value).toBe(null);
  });

  /**
   * 🔴 The boot snapshot is NOT an activity. A spinner every time the window
   * opens would make the indicator mean "the app is alive" rather than "your
   * click is being worked on", and an indicator that is always on is the same
   * as no indicator — the 0.3.27 `dropped_unrendered` lesson in a smaller key.
   */
  it('🔴 the boot snapshot shows nothing', async () => {
    const store = await fresh();
    stateAnswer = { form: 'dev' }; // …so no auto-check follows to muddy the read
    const boot = store.initUpdateStore();
    expect(store.updateBusy.value).toBe(null);
    await boot;
    await settle();
    expect(store.updateBusy.value).toBe(null);
  });

  /** A settings write is still something in flight — the buttons stay locked. */
  it('a preference write reports itself as busy', async () => {
    const store = await fresh();
    await store.initUpdateStore();
    await settle();
    const p = store.updateSetAutoCheck(false);
    expect(store.updateBusy.value).toBe('saving');
    await p;
    expect(store.updateBusy.value).toBe(null);
  });
});

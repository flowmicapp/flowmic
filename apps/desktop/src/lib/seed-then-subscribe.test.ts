// E7 — seedThenSubscribe: a push landing while the seed's own pull is still in
// flight must win, not the pull's stale answer that resolves after it.
//
// ⚠️ TIMING NOTE FOR THESE TESTS. `seedThenSubscribe`'s `subscribe` argument is
// called and, for these fixtures, resolves SYNCHRONOUSLY (the mock has no
// internal await): the JS engine runs an async function's body eagerly up to
// its first await/return, so by the time `seedThenSubscribe(...)` returns its
// own (still-pending) promise to the caller, the push callback below is
// already captured. That is what lets a test push BEFORE resolving the seed's
// deferred promise without needing to `await` anything in between — awaiting
// the RESULT before resolving the seed would deadlock, since the result
// cannot settle until the seed does.

import { describe, expect, it } from 'vitest';
import { seedThenSubscribe } from './seed-then-subscribe';

/** A deferred promise, so a test can control exactly when `fetchSeed()`
 *  resolves relative to a push. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('seedThenSubscribe', () => {
  it('applies the seed when nothing pushed while it was in flight', async () => {
    const applied: string[] = [];
    const seed = deferred<string>();
    const resultPromise = seedThenSubscribe<string>(
      async (apply) => { void apply; return () => {}; },
      () => seed.promise,
      (v) => applied.push(v),
    );
    seed.resolve('seeded');
    const unlisten = await resultPromise;
    expect(applied).toEqual(['seeded']);
    unlisten();
  });

  // 🔴 THE DEFECT ITSELF. Before this helper, all four call sites wrote
  // `sub(cb); value = await fetchSeed()` with no guard — a push landing during
  // that await was silently overwritten the instant the pull resolved.
  it('REVERSE-CONTROL SHAPE: a push during the in-flight seed wins — the seed is discarded', async () => {
    const applied: string[] = [];
    const seed = deferred<string>();
    let pushCb: ((v: string) => void) | null = null;
    const resultPromise = seedThenSubscribe<string>(
      async (apply) => { pushCb = apply; return () => {}; },
      () => seed.promise,
      (v) => applied.push(v),
    );
    // A push arrives WHILE the seed's fetch is still pending — `pushCb` is
    // already set (see the file-header timing note).
    expect(pushCb).not.toBeNull();
    pushCb!('pushed-while-in-flight');
    expect(applied).toEqual(['pushed-while-in-flight']);
    // The seed NOW resolves, with an answer read before the push above.
    seed.resolve('stale-seed');
    const unlisten = await resultPromise;
    // The stale seed must NOT have overwritten the push.
    expect(applied).toEqual(['pushed-while-in-flight']);
    unlisten();
  });

  it('a push AFTER the seed has already applied is not affected — pushes always win afterwards too', async () => {
    const applied: string[] = [];
    const seed = deferred<string>();
    let pushCb: ((v: string) => void) | null = null;
    const resultPromise = seedThenSubscribe<string>(
      async (apply) => { pushCb = apply; return () => {}; },
      () => seed.promise,
      (v) => applied.push(v),
    );
    seed.resolve('seeded');
    const unlisten = await resultPromise;
    expect(applied).toEqual(['seeded']);
    pushCb!('later-push');
    expect(applied).toEqual(['seeded', 'later-push']);
    unlisten();
  });

  it('registers the listener BEFORE calling fetchSeed (RV-24 order preserved)', async () => {
    const order: string[] = [];
    const unlisten = await seedThenSubscribe<number>(
      async (apply) => { order.push('subscribed'); void apply; return () => {}; },
      async () => { order.push('fetched'); return 1; },
      () => {},
    );
    expect(order).toEqual(['subscribed', 'fetched']);
    unlisten();
  });

  it('returns the real unlisten function from subscribe, untouched', async () => {
    let calledUnlisten = false;
    const unlisten = await seedThenSubscribe<number>(
      async () => () => { calledUnlisten = true; },
      async () => 1,
      () => {},
    );
    unlisten();
    expect(calledUnlisten).toBe(true);
  });

  it('multiple pushes during the in-flight seed still discard it (count-based, not boolean)', async () => {
    const applied: string[] = [];
    const seed = deferred<string>();
    let pushCb: ((v: string) => void) | null = null;
    const resultPromise = seedThenSubscribe<string>(
      async (apply) => { pushCb = apply; return () => {}; },
      () => seed.promise,
      (v) => applied.push(v),
    );
    pushCb!('a');
    pushCb!('b');
    seed.resolve('stale');
    const unlisten = await resultPromise;
    expect(applied).toEqual(['a', 'b']);
    unlisten();
  });
});

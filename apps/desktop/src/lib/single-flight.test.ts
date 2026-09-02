// P3 #18 (2026-09-02) — pins the coalesced-trailing-run contract singleFlight
// exists for. The reverse control is the literal shape the finding named:
// `if (running) return;` (a call during a run vanishes instead of being
// answered by a run that reflects what changed while it waited).

import { describe, expect, it } from 'vitest';

/** A promise plus its resolver, so a test controls exactly when one "fetch"
 *  finishes relative to when the next call to the wrapped function happens. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('singleFlight', () => {
  it('a call with nothing in flight runs immediately', async () => {
    const { singleFlight } = await import('./single-flight');
    let calls = 0;
    const run = singleFlight(async () => {
      calls++;
    });
    await run();
    expect(calls).toBe(1);
  });

  it('🔴 a call that arrives mid-flight is answered by a run that starts AFTER the in-flight one finishes — not dropped', async () => {
    const { singleFlight } = await import('./single-flight');
    const calls: number[] = [];
    let n = 0;
    const gate1 = deferred<void>();
    const run = singleFlight(async () => {
      const my = ++n;
      calls.push(my);
      if (my === 1) await gate1.promise; // hold the first call open
    });

    const first = run(); // starts immediately, awaiting gate1
    const second = run(); // arrives while the first is still in flight

    // The reverse control this test exists to catch: with the finding's
    // `if (running) return;` shape, `second` would already be a resolved
    // no-op promise here, and `calls` would never grow past [1].
    expect(calls).toEqual([1]);

    gate1.resolve(); // let the first run finish
    await first;
    await second; // must not resolve until the SECOND (post-release) run ran

    expect(calls).toEqual([1, 2]);
  });

  it('three calls that all arrive during the same in-flight run share ONE trailing run, not three', async () => {
    const { singleFlight } = await import('./single-flight');
    let calls = 0;
    const gate1 = deferred<void>();
    const run = singleFlight(async () => {
      calls++;
      if (calls === 1) await gate1.promise;
    });

    const a = run();
    const b = run();
    const c = run();
    expect(calls).toBe(1); // only the first call is actually running

    gate1.resolve();
    await Promise.all([a, b, c]);

    // One in-flight run + one coalesced trailing run = 2, never 4.
    expect(calls).toBe(2);
  });

  it('a rejected in-flight run does not skip the trailing run', async () => {
    const { singleFlight } = await import('./single-flight');
    let calls = 0;
    const gate1 = deferred<void>();
    const run = singleFlight(async () => {
      calls++;
      if (calls === 1) {
        await gate1.promise;
        throw new Error('first run failed');
      }
    });

    const first = run();
    const second = run();
    gate1.resolve();
    await expect(first).rejects.toThrow('first run failed');
    await expect(second).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('after a run settles, the next call starts a genuinely new run (not stuck coalescing forever)', async () => {
    const { singleFlight } = await import('./single-flight');
    let calls = 0;
    const run = singleFlight(async () => {
      calls++;
    });
    await run();
    await run();
    await run();
    expect(calls).toBe(3);
  });
});

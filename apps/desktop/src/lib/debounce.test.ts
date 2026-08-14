// REGRESSION GUARD — B3-6 "Illegal invocation" (owner real device (真机) 2026-07-31).
//
// WHY THIS FILE EXISTS, and why a NORMAL vitest test cannot replace it:
//   `KeyedDebouncer` used to take `schedule = setTimeout` / `cancel = clearTimeout`
//   as DI defaults and store them as INSTANCE FIELDS, then call them as
//   `this.schedule(...)`. That hands the native function a receiver of
//   `KeyedDebouncer` instead of `window`. In a real browser (the Tauri WebView,
//   Chromium 150) `setTimeout`/`clearTimeout` are Web IDL operations that brand-
//   check their receiver, so every settings edit threw
//   `TypeError: Illegal invocation` inside the @click handler.
//   In Node / vitest those globals are PLAIN FUNCTIONS with no brand check, so
//   the identical line never throws and the whole suite stayed green — the bug
//   shipped past a full green board.
//
//   ⇒ To catch it we must install a receiver-checking stand-in for the globals,
//     i.e. teach the Node environment the one rule it is missing. `hasBrandCheck`
//     below is the positive control: it proves the stand-in really does reject a
//     bad receiver, so a green in `survives a brand-checking global` cannot be a
//     blind probe.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyedDebouncer } from './debounce';
import { SettingsClient } from './settings-client';
import type { KvStore, SettingsTransport } from './types';

type Handle = ReturnType<typeof setTimeout>;

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

/** Rejects any receiver a real Web IDL brand check would reject. `undefined`
 *  (a bare call in strict/ESM code) and the global itself are the legal ones. */
function assertGlobalReceiver(receiver: unknown): void {
  if (receiver === undefined || receiver === globalThis) return;
  throw new TypeError('Illegal invocation');
}

/** Replace the Node globals with brand-checking stand-ins for the duration of a
 *  test. Deliberately NOT arrow functions — an arrow has no own `this`. */
function installBrandCheckedTimers(): void {
  function brandedSetTimeout(this: unknown, fn: () => void, ms?: number): Handle {
    assertGlobalReceiver(this);
    return nativeSetTimeout(fn, ms);
  }
  function brandedClearTimeout(this: unknown, h?: Handle): void {
    assertGlobalReceiver(this);
    nativeClearTimeout(h);
  }
  globalThis.setTimeout = brandedSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = brandedClearTimeout as unknown as typeof clearTimeout;
}

beforeEach(() => installBrandCheckedTimers());
afterEach(() => {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
});

describe('KeyedDebouncer — native timer receiver (B3-6)', () => {
  // POSITIVE CONTROL for the two negative assertions below: if this test ever
  // fails, the stand-in has stopped brand-checking and every «did not throw»
  // assertion in this file has gone blind.
  it('hasBrandCheck: the stand-in really rejects a non-global receiver', () => {
    const holder = { later: globalThis.setTimeout, stop: globalThis.clearTimeout };
    expect(() => holder.later(() => {}, 0)).toThrow(/Illegal invocation/);
    expect(() => holder.stop(0 as unknown as Handle)).toThrow(/Illegal invocation/);
    // …and the same functions called bare are fine (this is why «aliasing
    // setTimeout is always broken» is NOT the rule — the receiver is).
    const bare = globalThis.setTimeout;
    const h = bare(() => {}, 0);
    globalThis.clearTimeout(h);
  });

  it('run() survives a brand-checking global (the owner-reported crash)', async () => {
    const d = new KeyedDebouncer(1); // DEFAULTS — the production construction site
    let fired = 0;
    expect(() => d.run('k', () => (fired += 1))).not.toThrow();
    // …and re-running the SAME key exercises `cancel` (clearTimeout) too.
    expect(() => d.run('k', () => (fired += 1))).not.toThrow();
    // Positive side: the timer must actually fire, so a debouncer that quietly
    // schedules nothing cannot pass by "not throwing".
    await new Promise((r) => nativeSetTimeout(r, 20));
    expect(fired).toBe(1);
    expect(d.pending('k')).toBe(false);
  });

  it('clearAll() survives a brand-checking global', () => {
    const d = new KeyedDebouncer(50);
    d.run('a', () => {});
    d.run('b', () => {});
    expect(d.pending('a')).toBe(true);
    expect(() => d.clearAll()).not.toThrow();
    expect(d.pending('a')).toBe(false);
  });

  it('an injected scheduler is still honoured (DI is not broken by the fix)', () => {
    const seen: number[] = [];
    const d = new KeyedDebouncer(
      7,
      (fn, ms) => {
        seen.push(ms);
        fn();
        return 0 as unknown as Handle;
      },
      () => {},
    );
    let ran = 0;
    d.run('k', () => (ran += 1));
    expect(seen).toEqual([7]);
    expect(ran).toBe(1);
  });
});

describe('SettingsClient — the real @click path (B3-6 blast radius)', () => {
  class RecordingTransport implements SettingsTransport {
    calls: Array<{ key: string; value: unknown }> = [];
    async settingsUpdate(key: string, value: unknown): Promise<boolean> {
      this.calls.push({ key, value });
      return true;
    }
  }
  class MemStore implements KvStore {
    m = new Map<string, string>();
    get(k: string): string | null {
      return this.m.get(k) ?? null;
    }
    set(k: string, v: string): void {
      this.m.set(k, v);
    }
  }

  // This is the exact chain owner hit: ScenarioCard.vue @click → toggleProfession
  // → settings.setScenarioCard → updateSetting → debouncer.run → BOOM. Under the
  // old code the throw escaped `updateSetting` AFTER persist() had already
  // succeeded, so the value was cached locally, the wire push never happened, and
  // `dirty` was never marked — «saved locally / SETTINGS_SYNC_FAIL» (已存本地/SETTINGS_SYNC_FAIL) could not light up.
  it('setScenarioCard does not throw, and DOES reach the wire', async () => {
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 1);
    expect(() =>
      c.setScenarioCard({ professions: ['法律'], domains: [], packs: [], terms: [] }),
    ).not.toThrow();
    await new Promise((r) => nativeSetTimeout(r, 20));
    expect(t.calls.map((x) => x.key)).toContain('scenario.card');
  });
});

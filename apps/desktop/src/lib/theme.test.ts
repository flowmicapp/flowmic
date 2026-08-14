// V2-07.8a three-state theme test. Covers task self-check ⑦-② / ⑦-③:
//   ② "Follow system" is live — once an OS theme-change event arrives, resolved
//      follows it immediately;
//   ③ When pinned to light/dark, the same OS flip has no effect.
// Also guarded: default = follow system, apply-and-persist-immediately, first
// frame (initTheme synchronously stamps data-theme), cross-window hydrate,
// and matchMediaThemeSource not crashing under node.

import { describe, expect, it } from 'vitest';
import type { KvStore } from './types';
import {
  THEME_KEY,
  getResolvedTheme,
  getThemeMode,
  hydrateTheme,
  initTheme,
  isThemeMode,
  matchMediaThemeSource,
  setThemeMode,
  type ResolvedTheme,
  type SystemThemeSource,
} from './theme';

function memKv(initial?: Record<string, string>): KvStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

/** Fake system theme source: flip() simulates one OS light/dark toggle event. */
function fakeSystem(initial: ResolvedTheme): SystemThemeSource & { flip(t: ResolvedTheme): void } {
  const cbs = new Set<(t: ResolvedTheme) => void>();
  let cur = initial;
  return {
    current: () => cur,
    onChange: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    flip: (t) => {
      cur = t;
      for (const cb of cbs) cb(t);
    },
  };
}

function fakeRoot(): { attrs: Record<string, string>; setAttribute(n: string, v: string): void } {
  return {
    attrs: {},
    setAttribute(n, v) {
      this.attrs[n] = v;
    },
  };
}

describe('theme axis (V2-07.8a)', () => {
  it('nothing stored → mode system, resolved follows the OS, stamped synchronously (first frame)', () => {
    const kv = memKv();
    const sys = fakeSystem('dark');
    const root = fakeRoot();
    initTheme({ kv, system: sys, root });
    // No await, no tick: initTheme itself must have painted — that is the
    // "no first-frame flash" contract (initTheme runs before createApp in the two mains).
    expect(getThemeMode()).toBe('system');
    expect(getResolvedTheme()).toBe('dark');
    expect(root.attrs['data-theme']).toBe('dark');
  });

  it('② live follow: an OS flip event re-resolves and re-stamps immediately', () => {
    const sys = fakeSystem('light');
    const root = fakeRoot();
    initTheme({ kv: memKv(), system: sys, root });
    expect(getResolvedTheme()).toBe('light');
    sys.flip('dark');
    expect(getResolvedTheme()).toBe('dark');
    expect(root.attrs['data-theme']).toBe('dark');
    sys.flip('light');
    expect(root.attrs['data-theme']).toBe('light');
  });

  it('③ pinned light: the same OS flip does NOT take effect', () => {
    const sys = fakeSystem('light');
    const root = fakeRoot();
    initTheme({ kv: memKv(), system: sys, root });
    setThemeMode('light');
    sys.flip('dark');
    expect(getThemeMode()).toBe('light');
    expect(getResolvedTheme()).toBe('light');
    expect(root.attrs['data-theme']).toBe('light');
  });

  it('③ pinned dark: an OS flip to light does NOT take effect', () => {
    const sys = fakeSystem('dark');
    const root = fakeRoot();
    initTheme({ kv: memKv(), system: sys, root });
    setThemeMode('dark');
    sys.flip('light');
    expect(getResolvedTheme()).toBe('dark');
    expect(root.attrs['data-theme']).toBe('dark');
  });

  it('back to system re-arms the live follow', () => {
    const sys = fakeSystem('light');
    const root = fakeRoot();
    initTheme({ kv: memKv(), system: sys, root });
    setThemeMode('dark');
    setThemeMode('system');
    expect(getResolvedTheme()).toBe('light');
    sys.flip('dark');
    expect(root.attrs['data-theme']).toBe('dark');
  });

  it('setThemeMode persists 即改即存; a fresh init re-reads the choice', () => {
    const kv = memKv();
    initTheme({ kv, system: fakeSystem('light'), root: fakeRoot() });
    setThemeMode('dark');
    expect(kv.get(THEME_KEY)).toBe('dark');
    // Next launch / the other window booting off the same store:
    const root2 = fakeRoot();
    initTheme({ kv, system: fakeSystem('light'), root: root2 });
    expect(getThemeMode()).toBe('dark');
    expect(root2.attrs['data-theme']).toBe('dark');
  });

  it('unrecognised stored value falls back to system', () => {
    const root = fakeRoot();
    initTheme({ kv: memKv({ [THEME_KEY]: 'solarized' }), system: fakeSystem('dark'), root });
    expect(getThemeMode()).toBe('system');
    expect(getResolvedTheme()).toBe('dark');
  });

  it('cross-window path: shared store changed elsewhere → hydrateTheme re-reads it', () => {
    const kv = memKv();
    const root = fakeRoot();
    initTheme({ kv, system: fakeSystem('light'), root });
    kv.set(THEME_KEY, 'dark'); // the other window wrote it (prefs-sync event)
    hydrateTheme();
    expect(getThemeMode()).toBe('dark');
    expect(root.attrs['data-theme']).toBe('dark');
  });

  it('no system source (node, missing matchMedia) → system resolves to light, no crash', () => {
    const root = fakeRoot();
    expect(matchMediaThemeSource()).toBeNull();
    initTheme({ kv: memKv(), system: matchMediaThemeSource(), root });
    expect(getThemeMode()).toBe('system');
    expect(getResolvedTheme()).toBe('light');
    expect(root.attrs['data-theme']).toBe('light');
  });

  it('re-init unsubscribes the previous system source (no duplicate listeners)', () => {
    const sys = fakeSystem('light');
    let subs = 0;
    const counting: SystemThemeSource & { flip(t: ResolvedTheme): void } = {
      current: sys.current,
      onChange: (cb) => {
        subs += 1;
        return sys.onChange(cb);
      },
      flip: sys.flip,
    };
    const root = fakeRoot();
    initTheme({ kv: memKv(), system: counting, root });
    initTheme({ kv: memKv(), system: counting, root });
    setThemeMode('system');
    sys.flip('dark');
    // one live subscription → exactly one stamp per flip, resolved once
    expect(subs).toBe(2);
    expect(root.attrs['data-theme']).toBe('dark');
  });

  it('isThemeMode accepts only the three modes', () => {
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('auto')).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
  });
});

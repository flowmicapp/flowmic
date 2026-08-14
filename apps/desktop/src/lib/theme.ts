// V2-07.8a theme state — light / dark / follow system (default: follow system).
//
// Unlike the UI language (which may NEVER follow the OS), the theme MAY — but
// only because the user explicitly picked "follow system"; the default being that
// option is the owner-visible ruling of 2026-07-28 (i18n-four-locales-and-theme).
//
// "Follow system" is live: the injected SystemThemeSource's onChange fires on every
// OS light/dark flip and recompute() re-resolves immediately. A source that
// only read once at startup would be the startup-snapshot fake the card text
// warns about — the subscription here is the feature, not a nicety.
//
// Everything is INJECTED (kv / system source / root element) so the module is
// pure and node-testable — the same KvStore culture as capsule-position.ts.
// Production wiring lives in the two window mains (main window + capsule —
// the capsule is a separate WebView and needs its own initTheme call).

import { ref } from 'vue';
import type { KvStore } from './types';

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
/** What actually gets painted — the value stamped on `data-theme`. */
export type ResolvedTheme = 'light' | 'dark';
/** localStorage key for the persisted mode (device-local, never the wire). */
export const THEME_KEY = 'flowmic.ui.theme';

/** The OS light/dark probe. Production = matchMediaThemeSource(); tests = a
 *  fake firing flips by hand. */
export interface SystemThemeSource {
  current(): ResolvedTheme;
  /** Subscribe to OS flips; returns an unsubscribe. */
  onChange(cb: (t: ResolvedTheme) => void): () => void;
}

/** The element data-theme is stamped on (production: document.documentElement). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

const mode = ref<ThemeMode>('system');
const resolved = ref<ResolvedTheme>('light');
let store: KvStore | null = null;
let system: SystemThemeSource | null = null;
let root: ThemeRoot | null = null;
let unlistenSystem: (() => void) | null = null;

export function getThemeMode(): ThemeMode {
  return mode.value;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved.value;
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v);
}

function recompute(): void {
  resolved.value = mode.value === 'system' ? (system?.current() ?? 'light') : mode.value;
  root?.setAttribute('data-theme', resolved.value);
}

/** Wire store + system source + root, subscribe the LIVE follow, then apply
 *  the persisted mode (absent/invalid → 'system'). Called BEFORE createApp in
 *  each window's main.ts so the first frame already carries data-theme — a
 *  mount-time application would flash the wrong theme. */
export function initTheme(opts: {
  kv?: KvStore | null;
  system?: SystemThemeSource | null;
  root?: ThemeRoot | null;
}): void {
  store = opts.kv ?? null;
  system = opts.system ?? null;
  root = opts.root ?? null;
  unlistenSystem?.();
  unlistenSystem = system?.onChange(() => recompute()) ?? null;
  hydrateTheme();
}

/** Re-read the persisted mode and recompute — the cross-window prefs-sync path
 *  (the other window changed the theme; the shared store is the SSOT). */
export function hydrateTheme(): ThemeMode {
  const v = store?.get(THEME_KEY) ?? null;
  mode.value = isThemeMode(v) ? v : 'system';
  recompute();
  return mode.value;
}

/** The ONLY writer of the theme mode: an explicit user choice (apply-and-persist-immediately). */
export function setThemeMode(m: ThemeMode): void {
  mode.value = m;
  store?.set(THEME_KEY, m);
  recompute();
}

/** The production SystemThemeSource over prefers-color-scheme. Null where
 *  matchMedia is unavailable (node tests, a bare `vite dev` without the API) —
 *  initTheme then resolves 'system' to light rather than crashing. */
export function matchMediaThemeSource(): SystemThemeSource | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  return {
    current: () => (mql.matches ? 'dark' : 'light'),
    onChange: (cb) => {
      const handler = (e: MediaQueryListEvent): void => cb(e.matches ? 'dark' : 'light');
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    },
  };
}

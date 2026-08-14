// WP-R2-2 localStorage-backed KvStore (07 §8/§9: settings cache + durable change
// queue + the timeline's own rows).
//
// `set` REPORTS whether the write landed (ReportingKvStore) instead of only
// swallowing the exception. Both are still true at once and that is the point:
// nothing throws into the UI (private mode / quota must never take a page down),
// AND a caller that owns its data can find out that it did not persist. It used to
// only swallow, which was right while the timeline was a cache of the server's rows
// and wrong the moment it became the owner of them — see ReportingKvStore in
// types.ts for the failure that shape produces.
//
// A boolean-returning `set` still satisfies plain `KvStore` (TypeScript allows any
// return type where `void` is expected), so every other consumer — settings client,
// theme, locale, capsule position — is untouched.

import type { ReportingKvStore } from './types';

export const localKv: ReportingKvStore = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      // Never throws into the UI — but the caller is TOLD, so an owner can state
      // 「这台电脑存不下了」("this PC can't store any more") instead of showing rows it did not save.
      return false;
    }
  },
};

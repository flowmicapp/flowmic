// THE STT ROUTING ROW: its type, its narrowing, and its ORDER.
//
// Split out of settings-model.ts when that file hit the 800-line cap. The three
// belong together and nothing else needs them, so this is a file boundary rather
// than a rewrite: `Routing` / `asRoutings` moved VERBATIM apart from dropping
// two one-line helpers (`isObj` / `asStr`) in favour of the inline `typeof`
// checks they were. `settings-model.ts` re-exports `Routing`, so no importer
// changed.
//
// Owner ruling 2026-08-27 §R2
// (docs/decisions/2026-08-27-owner-persistent-login-and-routing-order.md):
// 「兜底那行始终在最下面，新增行在它上面」— the catch-all row is always at the
// bottom and a new row goes above it.
//
// 🔴 WHAT THIS IS NOT, and it is the half the ruling actually asked about.
// The owner wondered whether row order should carry MATCH PRIORITY. It must
// not. Matching is by LANGUAGE KEY through a three-step ladder (exact → base
// subtag → `*`) inside an AUTHOR layer (user > managed default > seed); row
// order is only ever the tie-break inside one rung of one layer, settled by
// `find`. Giving the order a second meaning would be this repo's #1 shape — one
// value answering two questions — so nothing about matching changed. What
// changed is the DISPLAY: the screen now shows the order the existing rules
// already had, instead of an arrangement that merely looked meaningful. `*` last
// is not a new rule; it is the last rung of the ladder, finally drawn last.
//
// 🔴 WHY THE ARRAY IS ORDERED RATHER THAN THE VIEW. A display-only sort would
// let「what is stored and sent」and「what the screen shows」answer differently,
// which is the same defect one layer down. It would also have needed a
// displayed→array index map at four call sites (`removeRouting`,
// `updateRoutingField`, `setPresetForRouting`, and the template's `:key`), and a
// mapping four callers must remember is a defect waiting for the fifth. With the
// array itself ordered, displayed index == array index BY CONSTRUCTION.
//
// It follows that `addRouting` can stay a bare `push`: the invariant places the
// new row above the catch-all, so there is no second placement rule to keep in
// step with this one.
//
// A STABLE PARTITION, deliberately: specific rows keep their existing relative
// order (a user who arranged them keeps their arrangement), and the catch-all
// rows — plural, because a stored array really can hold two, `addRouting` seeded
// `'*'` before 2026-08-27 §2-1 — go to the end in the order they were already
// in. Nothing is renamed, merged or dropped. A duplicate is SHOWN as a duplicate
// (SttSettings.vue), never silently rewritten: the owner ruled that explicitly,
// and it is the same rule the language cell already keeps — a settings screen
// that corrects a value on render leaves the user unable to see what their
// machine is actually configured with.
//
// APPLIED AT EVERY WRITE, in settings-model.ts: the local-cache load
// (`asOrderedRoutings`), the server hydration arm of `applyServerSettings`, and
// `pushRoutings`, which every mutator funnels through. Re-ordering happens AFTER
// the mutation, so an edit that turns a row into a catch-all moves it to the
// bottom in the same tick the user makes it.
//
// REVERSE CONTROL (executed 2026-08-27). Break: delete the `orderedRoutings`
// call in `pushRoutings` AND the one in `applyServerSettings`. OBSERVED
// `4 failed | 9 passed` in stt-routing-order.test.ts — 「add language」 landing
// after the catch-all, hydration keeping `['*','zh']`, an edit-into-catch-all
// staying put, and the index-mutator case. CONTROL-ON-CONTROL: the pure
// `orderedRoutings` cases and every §R2-2 duplicate case stayed GREEN, so the
// break is exactly the two write sites wide and nothing else was propping the
// order up.

import type { SttEngineId } from '@flowmic/protocol';
import { FALLBACK_LANG } from '../lib/spoken-langs';

export interface Routing {
  language: string;
  engine_id: SttEngineId;
  endpoint?: string;
  api_key?: string;
  model?: string;
}

/** Specific rows first in their existing order, catch-all rows last in theirs.
 *  Generic over「anything with a language」so the ordering rule cannot quietly
 *  acquire an opinion about the rest of a routing row. */
export function orderedRoutings<T extends { language: string }>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const r of rows) if (r.language !== FALLBACK_LANG) out.push(r);
  for (const r of rows) if (r.language === FALLBACK_LANG) out.push(r);
  return out;
}

/** Narrow a cached / hydrated array into real rows. A value that is not an array
 *  returns `null` so the caller falls back to a fresh install's default — the
 *  stance every narrower in settings-model takes, and the reason an older
 *  build's cache cannot blank the settings page. */
export function asRoutings(v: unknown): Routing[] | null {
  if (!Array.isArray(v)) return null;
  return (v as unknown[])
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r))
    .map((r) => {
      const out: Routing = {
        language: typeof r.language === 'string' ? r.language : 'zh-CN',
        engine_id: (typeof r.engine_id === 'string' ? r.engine_id : 'funasr') as SttEngineId,
      };
      if (typeof r.endpoint === 'string') out.endpoint = r.endpoint;
      if (typeof r.api_key === 'string') out.api_key = r.api_key;
      if (typeof r.model === 'string') out.model = r.model;
      return out;
    });
}

/** Narrow AND order in one step, so a cached array from an older build comes
 *  back on screen already obeying the invariant rather than only after the
 *  first edit. */
export function asOrderedRoutings(v: unknown): Routing[] | null {
  const rows = asRoutings(v);
  return rows === null ? null : orderedRoutings(rows);
}

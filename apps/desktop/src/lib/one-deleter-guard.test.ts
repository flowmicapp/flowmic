// 🔴 16 册 §6.2-1 machine guard —「收缩只有一条删除路径」("shrinking has exactly
// one deletion path").
//
// The drift fence for C2's core structural claim. The behaviour tests
// (timeline-purge.test.ts) prove the two triggers agree TODAY; this one fails the
// moment a fourth call site starts removing rows or dropping pictures on its own,
// which is how G-21 happened in the first place — nobody added a second deleter on
// purpose, `remove()` simply never learned about the picture files.
//
// It greps SOURCE, so it costs nothing at runtime and cannot be satisfied by a test
// double. Test files are excluded: a fixture is allowed to fake a transport.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const SRC = path.resolve(LIB, '..');

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...productionFiles(full));
      continue;
    }
    if (!/\.(ts|vue)$/.test(name) || /\.test\.ts$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** Files (relative to src/) that mention a symbol, ignoring comment lines — a
 *  doc-comment naming the function is a reference, not a call site. */
/** Non-comment lines mentioning `symbol(`, per production file. Comment lines are
 *  dropped because a doc comment naming the function is a reference, not a path. */
function mentions(symbol: string): Map<string, number> {
  const re = new RegExp(`\\b${symbol}\\s*\\(`);
  const out = new Map<string, number>();
  for (const f of productionFiles(SRC)) {
    const n = readFileSync(f, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && re.test(line)).length;
    if (n > 0) out.set(path.relative(SRC, f).replaceAll('\\', '/'), n);
  }
  return out;
}

describe('one deleter (16 册 §6.2-1)', () => {
  it('🔴 the deleter has exactly one caller', () => {
    // `purge` is invoked from exactly one place: TimelineStore.drop, which every
    // trigger goes through. A second entry here means a second deletion path.
    // (timeline-purge.ts itself appears once — the declaration.)
    expect([...mentions('purge').keys()].sort()).toEqual(['lib/timeline-purge.ts', 'lib/timeline-store.ts']);
    expect(mentions('purge').get('lib/timeline-store.ts')).toBe(1);
  });

  it('🔴 the verb that unlinks a picture file is reached from ONE line in the app', () => {
    // Three production mentions and no more: the Tauri implementation, the interface
    // it satisfies, and the single forwarding lambda inside TimelineStore.drop.
    const m = mentions('dropRowImages');
    expect([...m.keys()].sort()).toEqual(['lib/bridge.ts', 'lib/timeline-store.ts', 'lib/types.ts']);
    expect(m.get('lib/timeline-store.ts')).toBe(1);
  });

  it('🔴 nothing outside the deleter removes a row from the store map', () => {
    // The store holds rows in a Map keyed by rowKey. `rows.delete(` inside
    // timeline-store.ts would be a removal that skipped purge() — which is exactly
    // the shape of the G-21 defect (`this.rows.delete(rowKey(...)); persist();`).
    const store = readFileSync(path.join(LIB, 'timeline-store.ts'), 'utf8');
    expect(store).not.toMatch(/this\.rows\.delete\(/);
  });

  it('the capacity selector stays pure — it plans a deletion, it does not perform one', () => {
    // planEviction returns rows and nothing else; the deletion is purge's. A planner
    // that touched the transport would be a fourth path hiding inside a selector.
    const src = readFileSync(path.join(LIB, 'timeline-retention.ts'), 'utf8');
    expect(src).not.toMatch(/dropPictures\(|dropRowImages\(/);
  });
});

// The invoke-funnel door (2026-08-26).
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
//
// `bridge.ts` line 1 claims to be the only module that calls `invoke`. That
// sentence is load-bearing: every command crossing into Rust goes through one
// place, which is where the outside-Tauri degradation lives, where failures are
// logged, and where a rejection is turned into a verdict instead of a throw
// (RV-97: a funnel with a second entry point is not a funnel). A second
// `import { invoke }` anywhere would be invisible — it compiles, it works on the
// developer's machine, and it silently opts out of all of that.
//
// ── WHY THE CLAIM NEEDED CORRECTING BEFORE IT COULD BE PINNED ───────────────
//
// It used to read 「the ONLY frontend module that imports @tauri-apps」, and
// measured on 2026-08-26 that was false in three places: bridge-reinject.ts and
// main-window/update-store.ts import `listen`/`emit` from api/event, and
// components/WindowTitlebar.vue imports `getCurrentWindow` from api/window.
// None of them dispatches a command. The rule was right and its sentence was
// too wide, so the sentence rotted — and got copied into bridge-clipboard.ts's
// header on the way. Anti-façade ④: a comment asserting behaviour elsewhere is
// only as true as the last time somebody looked. This test is that look, run
// every time.
//
// ── 🔴 THE SCANNER STRIPS COMMENTS, AND THAT IS NOT HOUSEKEEPING ────────────
//
// The paragraph above NAMES `@tauri-apps/api/event` and `@tauri-apps/api/window`
// in prose, and so does bridge.ts's corrected header. A scanner that read raw
// text would count this very explanation as a violation. That is not
// hypothetical: in the button-skin door, one window earlier, the scanner counted
// class names out of the comment that explained the fix. Same trap, third
// sighting — so comments come out before anything is counted, and a ruler check
// below proves the stripping still works in BOTH directions.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every `.ts` / `.vue` under `apps/desktop/src`, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Test files legitimately `vi.mock('@tauri-apps/api/core')` — replacing the
 *  module is the opposite of opening a second door, so they are out of scope. */
function isTest(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const IMPORT_RE = /from\s+['"](@tauri-apps\/[^'"]+)['"]/g;

/** Which `@tauri-apps/...` subpaths a file imports, comments removed. */
function tauriImportsIn(path: string): string[] {
  const code = stripComments(readFileSync(path, 'utf8'));
  const found = new Set<string>();
  for (const m of code.matchAll(IMPORT_RE)) found.add(m[1] as string);
  return [...found];
}

const files = sourceFiles(SRC).filter((f) => !isTest(f));
const rel = (p: string) => p.slice(SRC.length).split('\\').join('/');

describe('🔴 ruler check — the scanner can see, and is not fooled by prose', () => {
  it('finds @tauri-apps imports at all (a blind scan must not read as a pass)', () => {
    const importers = files.filter((f) => tauriImportsIn(f).length > 0);
    // Measured 2026-08-26: bridge.ts, bridge-reinject.ts, WindowTitlebar.vue,
    // update-store.ts. The exact number is free to move; ZERO would mean the
    // walk or the regex broke, and every assertion below would then be
    // vacuously green.
    expect(importers.length).toBeGreaterThan(1);
  });

  it('does not count a module named inside a comment, and still counts a real import', () => {
    const commented = [
      "// import { invoke } from '@tauri-apps/api/core';",
      "/* from '@tauri-apps/api/event' */",
      'export const x = 1;',
    ].join('\n');
    expect([...stripComments(commented).matchAll(IMPORT_RE)]).toHaveLength(0);
    // The other direction, so the stripper cannot pass by deleting everything.
    const real = "import { invoke } from '@tauri-apps/api/core';";
    expect([...stripComments(real).matchAll(IMPORT_RE)]).toHaveLength(1);
  });

  it("this file's own explanation would trip a raw-text scanner", () => {
    // Proof that the stripping does real work HERE, not just in theory.
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(own).toContain('@tauri-apps/api/event');
    expect(tauriImportsIn(fileURLToPath(import.meta.url))).not.toContain('@tauri-apps/api/event');
  });
});

describe('every command into Rust goes through one funnel', () => {
  it('🔴 only lib/bridge.ts imports @tauri-apps/api/core', () => {
    const offenders = files
      .filter((f) => tauriImportsIn(f).includes('@tauri-apps/api/core'))
      .map(rel)
      .sort();
    expect(offenders).toEqual(['/lib/bridge.ts']);
  });

  it('a sibling that needs the boundary takes a door from bridge.ts, not the module', () => {
    // The bridge-* siblings exist because bridge.ts is at the line cap; they
    // must stay callers, never second entrances.
    for (const sibling of ['/lib/bridge-clipboard.ts', '/lib/bridge-os.ts', '/lib/bridge-portable.ts']) {
      const path = files.find((f) => rel(f) === sibling);
      expect(path, `${sibling} should exist`).toBeTruthy();
      expect(tauriImportsIn(path as string)).not.toContain('@tauri-apps/api/core');
      expect(stripComments(readFileSync(path as string, 'utf8'))).toMatch(/from '\.\/bridge'/);
    }
  });
});

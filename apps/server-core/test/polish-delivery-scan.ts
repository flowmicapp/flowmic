// Which polish delivery does PRODUCTION select? — a source scan, shared by two
// test files that must not be allowed to drift apart.
//
// 🔴 WHY THIS IS A MODULE AND NOT A LOCAL HELPER (POLISH-1, 2026-08-11). It used
// to live inside the ACTIVATION TRIPWIRE describe in stt-session-bridge.test.ts,
// where only a census could reach it. So that file held 「what production
// selects」 and 「what each delivery mode does to the user's text」 in two places
// with nothing joining them — and on 2026-08-08 the selector moved to a mode
// that computes the correction and throws it away, while all 50-odd cases stayed
// green because every one of them states its own mode.
//
// The two consumers, and they fail on different mistakes:
//   · polish-delivery-census.test.ts — the mode production STATES;
//   · stt-session-bridge.test.ts 「THE DELIVERY JOIN」 — feeds that same literal
//     to a real bridge and asserts the polished text reaches the client.
// The join is the one that speaks for the user. It is only worth anything
// because it reads the mode from here instead of naming one.
//
// NOT a `.test.ts`: vitest collects `test/**/*.test.ts`, so this module is
// imported, never run.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = fileURLToPath(new URL('../src', import.meta.url));
// ⚠️ `new URL('.', …)` keeps a trailing separator, which made the relative-path
// slice below eat a character ('tt-session-bridge.test.ts'). Caught by the
// can-it-fail case in the census, which is the whole reason that case exists.
export const TESTS = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Every `polishDelivery: '<mode>'` SELECTION under `root`, with the file making
 *  it. Line comments are stripped first — the bridge's doc block and the test
 *  file's prose name both modes constantly. The optional-property declarations
 *  (`polishDelivery?: 'sync' | 'detached'`) do not match either: the `?` sits
 *  where the pattern requires the colon. */
export function deliverySelections(root: string): { file: string; mode: 'sync' | 'detached' }[] {
  return walk(root)
    .flatMap((f) => {
      const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      const rel = f.slice(root.length + 1).replace(/\\/g, '/');
      return [...code.matchAll(/polishDelivery\s*:\s*'(sync|detached)'/g)]
        .map((m) => ({ file: rel, mode: m[1] as 'sync' | 'detached' }));
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.mode.localeCompare(b.mode));
}

/** Files under `root` selecting `mode`, deduped — the census's unit is a FILE,
 *  because 「two or more」 means the delivery mode has two authors. */
export function selectors(root: string, mode: 'sync' | 'detached'): string[] {
  return [...new Set(deliverySelections(root).filter((s) => s.mode === mode).map((s) => s.file))].sort();
}

/**
 * The delivery PRODUCTION selects, READ OUT OF `src/` instead of restated.
 *
 * 🔴 The point of reading it: a test that names the mode it expects can only ever
 * prove that mode works, which is exactly what the bridge suite did on the day
 * the selector moved. `undefined` means no src file states one and the accessor
 * default in stt-session.ts decides — a legal arrangement, and one the join still
 * covers, because passing `undefined` to the bridge asks that accessor.
 *
 * Throws rather than picking one when src/ states two: a caller asking 「what does
 * production do」 must not be handed one of two answers.
 */
export function productionDelivery(): 'sync' | 'detached' | undefined {
  const modes = [...new Set(deliverySelections(SRC).map((s) => s.mode))];
  if (modes.length > 1) throw new Error(`src/ selects more than one polish delivery: ${modes.join(', ')}`);
  return modes[0];
}

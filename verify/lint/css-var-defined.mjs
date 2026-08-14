// verify/lint/css-var-defined.mjs
// Lint 11/11 — every `var(--x)` the desktop renders must name a variable that is
// actually declared. Added 2026-08-02 (owner UI batch 1 ③).
//
// WHY THIS EXISTS — a real defect that shipped, not a hypothetical:
//   The 0.2.39 data group (TimelineStats.vue / TimelineClear.vue) referenced FOUR
//   variables that do not exist anywhere: `--s2`, `--b1`, `--danger`, `--ok`. CSS
//   does not error on an undefined custom property — the whole declaration becomes
//   invalid at computed-value time and falls back to the property's initial value.
//   So `background: var(--s2)` renders TRANSPARENT and
//   `border-left: 3px solid var(--danger)` renders NO BORDER. The result on screen
//   was a padded box with nothing in it: owner's screenshot called them
//   "two blank strips", and one of them was the standing "clear is irreversible" warning — the
//   one sentence on that card that must never be invisible.
//
//   Nothing in the gate could see it. design-token-literals (lint 10) scans for
//   #hex / rgb() LITERALS, which is the opposite failure (a colour that bypasses
//   the tokens); `verify:types` does not read CSS at all; and the components' unit
//   tests assert numbers and copy, never a background. ⇒ "a discipline that depends on people remembering it should be automated".
//
// WHAT IT CHECKS
//   Sources scanned: apps/desktop/src/**/*.{vue,css,ts} (the two windows share one
//   token file, so one scan covers both).
//   A name is DEFINED if it is declared as `--x:` anywhere in the scanned tree —
//   tokens.css is where they all live today, but a component that declares its own
//   local custom property is legitimate and must not be a hit.
//   Fallback forms count as a use of the FIRST name only: `var(--a, var(--b))`
//   registers both (the regex finds each `var(--` independently), which is correct —
//   a fallback chain naming a dead variable is still a dead reference.
//
// DELIBERATELY NOT A BASELINE/ALLOWLIST lint (unlike lint 10): the debt at the
// moment this gate was added was exactly four entries and all four were fixed in
// the same round, so it goes in GREEN. CLAUDE.md's rule: a gate that starts red will be
// ignored by everyone the next day — a gate that starts with a pinned list of "known broken" invites the
// next one to be pinned too.

import path from 'node:path';
import { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';

export const name = 'css-var-defined';

const DESKTOP_ROOT = path.join(ROOT, 'apps', 'desktop', 'src');

/** `var(--foo` — the name only; the closing paren / fallback is irrelevant here. */
const USE_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g;
/** `--foo:` in a declaration position (start of line or after `{` / `;`). */
const DEF_RE = /(?:^|[{;])\s*(--[A-Za-z0-9_-]+)\s*:/gm;

/** Blank out comment bodies (keeping newlines so reported line numbers stay true).
 *
 *  Necessary, and found the hard way: the very first run of this lint FAILED on the
 *  comment that explains it — a `/* … var(--s2) … *\/` note naming the dead variable it
 *  had just retired. A variable mentioned in prose renders nothing, so counting it is a
 *  false positive, and the alternative (never writing the name you are warning about)
 *  makes the codebase less readable to satisfy a linter.
 *
 *  `//` is stripped ONLY for whole-line comments. A trailing `// …` after code would be
 *  cheap to match too, but the same pattern eats the `//` in `https://…`, and losing the
 *  rest of a real line is a SILENT under-scan — the exact failure mode this lint exists
 *  to prevent, one layer up.
 *
 *  ORDER IS LOAD-BEARING: `//` lines are stripped FIRST, block comments SECOND. Doing
 *  block comments first, over the raw text, is position-blind — a `/*` sitting inside a
 *  `//` line (e.g. a `.ts` header reading `// /api/ops/* — …`) opens a comment that
 *  swallows everything up to the next unrelated `*\/`, including real code (measured
 *  2026-08-12 on server-core's src/http/ops-routes.ts under the sibling test-file copy
 *  of this same helper: 45% of the file deleted, 7 real code lines gone). Stripping `//`
 *  lines first removes the trigger before the block regex ever sees it. */
function stripComments(text) {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function skipDir(basename) {
  return DEFAULT_SKIP_DIRS.has(basename);
}

export default async function run() {
  /** @type {Set<string>} */
  const defined = new Set();
  /** @type {{ file: string, line: number, varName: string }[]} */
  const uses = [];

  for (const abs of await walk(DESKTOP_ROOT, { skipDir })) {
    const r = rel(abs);
    if (!/\.(vue|css|ts)$/.test(r)) continue;
    const raw = await readText(abs);
    if (raw == null) continue;
    const text = stripComments(raw);

    DEF_RE.lastIndex = 0;
    let d;
    while ((d = DEF_RE.exec(text))) defined.add(d[1]);

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      USE_RE.lastIndex = 0;
      let m;
      while ((m = USE_RE.exec(lines[i]))) {
        uses.push({ file: r, line: i + 1, varName: m[1] });
      }
    }
  }

  const missing = uses.filter((u) => !defined.has(u.varName));

  if (missing.length > 0) {
    // Name every distinct variable (not just the first few hits): the point of the
    // message is that the reader can fix them all in one pass.
    const names = [...new Set(missing.map((u) => u.varName))].sort();
    const sample = missing
      .slice(0, 8)
      .map((u) => `${u.file}:${u.line} ${u.varName}`)
      .join('; ');
    return {
      status: 'FAIL',
      detail:
        `${missing.length} use(s) of ${names.length} undefined custom propert${names.length === 1 ? 'y' : 'ies'} ` +
        `[${names.join(', ')}] — an undefined var() renders as the property's INITIAL value ` +
        `(transparent background / no border), silently. Declare it in ` +
        `apps/desktop/src/styles/tokens.css or point at the existing token: ${sample}`,
    };
  }

  return {
    status: 'PASS',
    detail: `${uses.length} var() use(s) across ${defined.size} declared custom properties — all resolve`,
  };
}

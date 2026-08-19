// verify/lint/i18n-error-keys.mjs
// Lint 5/12 — bilingual error-code completeness.
// (🔴 CORRECTED 2026-08-07: header used to say "5/9". The suite has grown to
// 12 lint modules — see verify/lint/run-all.mjs, which imports and registers
// all twelve — and this file's own denominator was never bumped as later
// lints (10, 11, 12) were added. The same stale "/9" was found in eight
// sibling headers and fixed in the same pass: protocol-whitelist.mjs (1/9),
// no-cloud-keys.mjs (2/9), settings-key-drift.mjs (3/9),
// module-reachability.mjs (4/9), circular.mjs (6/9), version-sync.mjs (7/9),
// file-size.mjs (8/9), timeline-e2e-prefix.mjs (9/9). design-token-literals.mjs
// (10/10), css-var-defined.mjs (11/11) and coordinate-anchors.mjs (12/12) were
// each already correct for the count at the time they were added.)
//
// Parses packages/protocol/src/error-codes.ts and asserts every code carries
// both a non-empty zh_CN and en message. Count is read dynamically from the
// file (never hardcoded). Any missing/empty half -> FAIL.

import path from 'node:path';
import { ROOT, readText } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/i18n-error-keys.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'i18n-error-keys';

const ERROR_CODES_TS = path.join(ROOT, 'packages', 'protocol', 'src', 'error-codes.ts');

// Parse the ERROR_CODES object literal. Returns { entries, error }.
// entries: [{ code, zh_CN|null, en|null }]
export function parseErrorCodes(src) {
  const startKey = src.indexOf('ERROR_CODES');
  if (startKey === -1) return { entries: [], error: 'ERROR_CODES not found' };
  const open = src.indexOf('{', startKey);
  const end = src.indexOf('} as const', open);
  if (open === -1 || end === -1) return { entries: [], error: 'ERROR_CODES block not delimited' };
  const block = src.slice(open + 1, end);

  const entries = [];
  // Each entry: KEY: { ...inner... }
  const entryRe = /([A-Z][A-Z0-9_]*)\s*:\s*\{([^}]*)\}/g;
  for (const m of block.matchAll(entryRe)) {
    const code = m[1];
    const inner = m[2];
    // 🔴 Both quote styles, and that is a correction rather than generosity.
    // These two regexes used to accept ONLY single-quoted strings, so a valid
    // entry written with double quotes — the natural choice when the copy itself
    // contains an apostrophe, e.g. en: "The AI's answer …" — was reported as
    // `missing en`. Measured 2026-08-07 when error code 62 was registered: the
    // message was present and complete, and this gate said it was absent.
    //
    // The failure direction was safe (it cried wolf; it could not pass an entry
    // that was really missing), but that is exactly how a rule gets loosened
    // until it stops firing: the obvious "fix" is to reword the copy to avoid an
    // apostrophe, i.e. to let the ruler dictate the product's words. The gate has
    // to answer 「is there an en message」, not 「is there a single-quoted en
    // message」.
    const zh = /zh_CN\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(inner);
    const en = /\ben\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(inner);
    entries.push({
      code,
      zh_CN: zh ? (zh[1] ?? zh[2]) : null,
      en: en ? (en[1] ?? en[2]) : null,
    });
  }
  return { entries, error: null };
}

export function validate(src) {
  const { entries, error } = parseErrorCodes(src);
  if (error) return { status: 'FAIL', detail: error };
  if (entries.length === 0) return { status: 'FAIL', detail: 'parsed 0 error codes (parser drift?)' };

  const bad = [];
  for (const e of entries) {
    const missing = [];
    if (!e.zh_CN || e.zh_CN.trim() === '') missing.push('zh_CN');
    if (!e.en || e.en.trim() === '') missing.push('en');
    if (missing.length) bad.push(`${e.code}(missing ${missing.join('+')})`);
  }

  const total = entries.length;
  const complete = total - bad.length;
  if (bad.length > 0) {
    return {
      status: 'FAIL',
      detail: `${bad.length}/${total} incomplete: ${bad.slice(0, 10).join(', ')}`,
    };
  }
  // count guard: complete count must equal total parsed count.
  if (complete !== total) {
    return { status: 'FAIL', detail: `count mismatch: complete=${complete} total=${total}` };
  }
  return { status: 'PASS', detail: `${total} codes, all bilingual (zh_CN+en)` };
}

export async function validateFile(absPath) {
  const src = await readText(absPath);
  if (src == null) return { status: 'FAIL', detail: `cannot read ${absPath}` };
  return validate(src);
}

export default async function run() {
  return validateFile(ERROR_CODES_TS);
}

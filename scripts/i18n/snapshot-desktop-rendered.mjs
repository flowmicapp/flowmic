#!/usr/bin/env node
// scripts/i18n/snapshot-desktop-rendered.mjs
//
// The safety net for the desktop-webview migration (architecture doc §8, P2:
// 「判据是生成物逐字节等于今天的字符串」).
//
// 🔴 WHAT THIS PROVES AND WHAT IT DOES NOT. The generator copies its values
// VERBATIM out of the pre-migration source (extract-desktop-strings.mjs keeps
// the original literal, quotes and escapes included), so 「the strings are
// unchanged」 is true by construction and re-proving it would be measuring the
// copy against itself. The risks that are REAL are elsewhere:
//   · a key could end up wired to the WRONG value — two sentences swap, both
//     still exist, nothing looks missing. This is the failure that would ship;
//   · a same-source ALIAS could quietly become a copy (cap_injected was in that
//     state for a whole version — IJ-02 §C-3);
//   · the derived tables (MODE_BADGE / SIDECAR_LABEL / INJECT_FAIL_REASON) read
//     the catalogue through getters, and a rewrite could leave one reading the
//     wrong locale;
//   · a count-bearing MESSAGE could lose a `${…}` hole, which a string diff of
//     the source would show but a diff of the DATA would not.
// All four are invisible to a compile and to a diff of the tables. They are only
// visible by CALLING every surface and comparing what comes out.
//
// So this emits a vitest harness that walks every catalogue key in every locale,
// calls every function catalogue with fixed arguments, and reads every derived
// table — then writes the result as JSON. Capture before, migrate, capture
// after, diff. A swapped or damaged entry fails BY NAME.
//
// ⚠️ The harness is a temporary artefact, not a permanent test: after the
// migration the two captures are equal and the golden's only remaining job
// would be to be re-blessed on every copy edit. Same decision the mobile
// migration made (its golden lives in .local/, gitignored).
//
// Usage:
//   node scripts/i18n/snapshot-desktop-rendered.mjs --emit <label>
//     (writes the harness; then run:
//      pnpm --filter @flowmic/desktop exec vitest run src/lib/strings/i18n-render-snapshot.gen.test.ts)
//   node scripts/i18n/snapshot-desktop-rendered.mjs --diff before after

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, SHARD_DIR } from './extract-desktop-strings.mjs';

const HARNESS = path.join(SHARD_DIR, 'i18n-render-snapshot.gen.test.ts');
const OUT_DIR = path.join(ROOT, '.local', 'i18n');

/** Arguments for the count-bearing message catalogues.
 *
 *  🔴 TWO CALLS PER FUNCTION, AND ONE OF THEM PASSES 1. English pluralises
 *  inside two of these arms (`${skipped === 1 ? 'picture' : 'pictures'}`), so a
 *  single sample would walk one branch and vouch for both. `aliases` is the one
 *  non-numeric parameter in the catalogue (it is `.join`ed), so it is keyed by
 *  NAME — a wrong guess here shows up as a thrown error, never as a silent pass. */
const ARG_SETS = ['single', 'plural'];

function argFor(name, set) {
  if (name === 'aliases') return set === 'single' ? "['a']" : "['a', 'b']";
  if (name === 'when') return set === 'single' ? "'2026-01-01'" : "'2026-08-14'";
  return set === 'single' ? '1' : '3';
}

function emit(label) {
  const leaves = JSON.parse(readFileSync(path.join(ROOT, 'i18n', 'desktop', 'leaves.json'), 'utf8')).leaves;
  const fns = leaves.filter((l) => l.kind === 'fn');
  const tables = [...new Set(fns.map((l) => l.key.split('.')[0]))];
  const tableImport = {
    injectFail: null,
    settingsMsg: 'SETTINGS_MSG_CATALOGUES',
    tlBatchMsg: 'TL_BATCH_MSG_CATALOGUES',
    tlRetentionMsg: 'TL_RETENTION_MSG_CATALOGUES',
    tlMetricsMsg: 'TL_METRICS_MSG_CATALOGUES',
  };

  const calls = [];
  for (const leaf of fns) {
    const [table, name] = leaf.key.split('.');
    for (const set of ARG_SETS) {
      const args = (leaf.params ?? []).map((p) => argFor(p, set)).join(', ');
      calls.push(
        `      out['${leaf.key}#${set}@' + loc] = ${tableImport[table]}[loc].${name}(${args});`,
      );
    }
  }

  return `// GENERATED — DO NOT EDIT BY HAND, DO NOT COMMIT.
// Source: node scripts/i18n/snapshot-desktop-rendered.mjs --emit ${label}
//
// Temporary migration harness (architecture doc §8, P2). It writes a rendered
// capture of every locale surface to .local/i18n/desktop-rendered-${label}.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { it } from 'vitest';

import { S_BY_LOCALE, UI_LOCALES, type UiLocale } from './index-for-snapshot';
import { SETTINGS_MSG_CATALOGUES } from './settings';
import { TL_BATCH_MSG_CATALOGUES, TL_RETENTION_MSG_CATALOGUES, TL_METRICS_MSG_CATALOGUES, MODE_BADGE } from './timeline';
import { INJECT_FAIL_REASON, INJECT_FAIL_REASON_CATALOGUES } from './capsule';
import { SIDECAR_LABEL } from './sidecar';
import { setLocale, wireLocaleStore } from './locale';

it('capture', () => {
  const out: Record<string, unknown> = {};
  for (const loc of UI_LOCALES as readonly UiLocale[]) {
    for (const [k, v] of Object.entries(S_BY_LOCALE[loc])) out['S.' + k + '@' + loc] = v;
    for (const [k, v] of Object.entries(INJECT_FAIL_REASON_CATALOGUES[loc])) {
      out['injectFail.' + k + '@' + loc] = v;
    }
${calls.join('\n')}
  }
  // The derived tables resolve getLocale() at READ time — the property that
  // makes a language switch re-render without touching a call site. Read them
  // under each locale in turn, which is the only way that property is visible.
  wireLocaleStore(null);
  for (const loc of UI_LOCALES as readonly UiLocale[]) {
    setLocale(loc);
    for (const [k, v] of Object.entries(SIDECAR_LABEL)) out['SIDECAR_LABEL.' + k + '@' + loc] = v;
    for (const [k, v] of Object.entries(MODE_BADGE)) out['MODE_BADGE.' + k + '@' + loc] = v.label;
    for (const k of Object.keys(INJECT_FAIL_REASON)) {
      out['INJECT_FAIL_REASON.' + k + '@' + loc] = INJECT_FAIL_REASON[k];
    }
  }
  mkdirSync(${JSON.stringify(OUT_DIR.replaceAll('\\', '/'))}, { recursive: true });
  writeFileSync(
    ${JSON.stringify(path.join(OUT_DIR, `desktop-rendered-${label}.json`).replaceAll('\\', '/'))},
    JSON.stringify(out, Object.keys(out).sort(), 2) + '\\n',
  );
});
`;
}

/** The harness imports `S_BY_LOCALE` + `UI_LOCALES` through a one-line shim so
 *  the same file works before and after the migration (before: they come from
 *  ../strings; after: same, but strings.ts is rewritten). Emitted rather than
 *  imported directly from '../strings' because that module is itself under the
 *  knife and a mid-migration import cycle would be reported as a snapshot
 *  difference that is not one. */
function shim() {
  return `// GENERATED — DO NOT EDIT BY HAND, DO NOT COMMIT. Snapshot harness shim.
export { S_BY_LOCALE, UI_LOCALES, type UiLocale } from '../strings';
`;
}

function diff(a, b) {
  const pa = path.join(OUT_DIR, `desktop-rendered-${a}.json`);
  const pb = path.join(OUT_DIR, `desktop-rendered-${b}.json`);
  for (const p of [pa, pb]) {
    if (!existsSync(p)) throw new Error(`missing capture: ${path.relative(ROOT, p)}`);
  }
  const A = JSON.parse(readFileSync(pa, 'utf8'));
  const B = JSON.parse(readFileSync(pb, 'utf8'));
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const diffs = [];
  for (const k of keys) {
    if (!(k in A)) diffs.push(`+ ${k} = ${JSON.stringify(B[k])}`);
    else if (!(k in B)) diffs.push(`- ${k} = ${JSON.stringify(A[k])}`);
    else if (A[k] !== B[k]) diffs.push(`~ ${k}\n    ${a}: ${JSON.stringify(A[k])}\n    ${b}: ${JSON.stringify(B[k])}`);
  }
  console.log(`${a}: ${Object.keys(A).length} rendered value(s)`);
  console.log(`${b}: ${Object.keys(B).length} rendered value(s)`);
  console.log(`differences: ${diffs.length}`);
  for (const d of diffs.slice(0, 40)) console.log(`  ${d}`);
  if (diffs.length > 40) console.log(`  … and ${diffs.length - 40} more`);
  process.exitCode = diffs.length === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit') {
    const label = args[1] ?? 'before';
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(HARNESS, emit(label));
    writeFileSync(path.join(SHARD_DIR, 'index-for-snapshot.ts'), shim());
    console.log(`wrote ${path.relative(ROOT, HARNESS)} (label=${label})`);
    console.log(`run : pnpm --filter @flowmic/desktop exec vitest run src/lib/strings/i18n-render-snapshot.gen.test.ts`);
    return;
  }
  if (args[0] === '--clean') {
    for (const p of [HARNESS, path.join(SHARD_DIR, 'index-for-snapshot.ts')]) {
      if (existsSync(p)) rmSync(p);
    }
    console.log('harness removed');
    return;
  }
  if (args[0] === '--diff') {
    diff(args[1] ?? 'before', args[2] ?? 'after');
    return;
  }
  console.error('usage: --emit <label> | --diff <a> <b> | --clean');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

// verify/eval/eval-corpus.mjs
//
// Corpus loading and schema validation. Extracted VERBATIM from run-eval.mjs in
// the 800-line split.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CASES_DIR, SUITES, ROOT } from './eval-paths.mjs';

/**
 * The shipped UI locales, DERIVED rather than copied.
 *
 * The registry SSOT is `packages/protocol/src/locales.ts`, which this JS harness
 * cannot import. The obvious workaround — retyping the nine codes here — is the
 * thing this repo keeps paying for: a second answer to one question, correct on
 * the day it is written and silently stale the day a locale is added. So the
 * list is read off the i18n data directory instead, which the generator builds
 * one file per registry row. It cannot drift, because adding a locale means
 * adding one of these files.
 *
 * ⚠️ `leaves.json` and `coverage.json` live in the same directory and are not
 * locales. They are excluded by name, which is the one hand-maintained fact
 * here; a third non-locale file would need adding to this list. That is a much
 * smaller and much louder surface than a copied array (a missed exclusion makes
 * every case fail validation immediately, rather than one locale silently
 * vanishing from a report).
 */
const NON_LOCALE_FILES = new Set(['leaves.json', 'coverage.json']);
const UI_LOCALES = readdirSync(join(ROOT, 'i18n', 'desktop'))
  .filter((f) => f.endsWith('.json') && !NON_LOCALE_FILES.has(f))
  .map((f) => f.slice(0, -'.json'.length))
  .sort();
// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function loadSuite(suite) {
  const p = join(CASES_DIR, `${suite}.jsonl`);
  if (!existsSync(p)) return { suite, path: p, cases: [], error: 'file missing' };
  const cases = [];
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    try {
      cases.push({ ...JSON.parse(raw), __line: i + 1 });
    } catch (e) {
      return { suite, path: p, cases: [], error: `line ${i + 1} is not valid JSON: ${e.message}` };
    }
  }
  return { suite, path: p, cases, error: null };
}

const REQUIRED = ['id', 'suite', 'family', 'input', 'note', 'golden_good'];
// golden_bad is required to EXIST but is allowed to be the empty string: for
// some cases (an empty frame wiping the accumulator) the failure literally is
// "nothing came out", and judgeCase already rejects empty output by name.
const REQUIRED_PRESENT = ['golden_bad'];

function schemaProblems(all) {
  const problems = [];
  const seen = new Map();
  for (const k of all) {
    for (const f of REQUIRED) {
      if (typeof k[f] !== 'string' || k[f] === '') problems.push(`${k.id ?? '(no id)'}: missing/empty field '${f}'`);
    }
    for (const f of REQUIRED_PRESENT) {
      if (typeof k[f] !== 'string') problems.push(`${k.id ?? '(no id)'}: missing field '${f}'`);
    }
    if (!SUITES.includes(k.suite)) problems.push(`${k.id}: unknown suite '${k.suite}'`);
    if (seen.has(k.id)) problems.push(`duplicate id '${k.id}' (lines ${seen.get(k.id)} and ${k.__line})`);
    else seen.set(k.id, k.__line);
    if (k.golden_good === k.golden_bad) problems.push(`${k.id}: golden_good and golden_bad are identical`);
    // W2-14: `known_open` was accepted with no stated reason. An open account
    // whose justification is blank is indistinguishable from a case someone
    // silenced because it was inconvenient — and the field exists precisely so
    // that a later reader can decide whether the account may be closed. Nothing
    // validated it, so nothing stopped the empty version.
    if (k.known_open && (typeof k.open_reason !== 'string' || k.open_reason.trim() === '')) {
      problems.push(`${k.id}: known_open with no open_reason — an account nobody can evaluate is a silenced failure, not an account`);
    }
    // ─── card C8: the language axis ─────────────────────────────────────────
    //
    // 🔴 REQUIRED ON `realtime`, AND THE REASON IS THAT "IT WORKS IN NINE
    // LANGUAGES" WAS NOT MERELY UNMEASURED — IT WAS UNMEASURABLE. Before this,
    // no case in any suite carried a language at all, so no report could be
    // broken down per language even in principle; a run could be 100% green
    // while every case in it was Chinese. An optional field would not have
    // fixed that: the next case added would omit it, the per-language table
    // would quietly stop covering it, and nothing would say so.
    //
    // ⚠️ Scoped to `realtime` deliberately. That is the suite the polish layer
    // runs on, so it is the one whose per-language claim this card is
    // responsible for. `translate` already carries its languages as
    // src_lang/tgt_lang; `organize` and `merge` have no such axis yet, and
    // backfilling ~200 cases whose language nobody has verified would be
    // asserting a fact rather than recording one.
    if (k.suite === 'realtime' && (typeof k.lang !== 'string' || k.lang === '')) {
      problems.push(`${k.id}: realtime case with no 'lang' — the per-language report cannot cover a case that does not say what language it is`);
    }
    if (typeof k.lang === 'string' && !UI_LOCALES.includes(k.lang)) {
      problems.push(`${k.id}: lang '${k.lang}' is not one of the shipped locales (${UI_LOCALES.join(', ')})`);
    }
  }
  return problems;
}
export { loadSuite, REQUIRED, REQUIRED_PRESENT, schemaProblems, UI_LOCALES };

// verify/eval/eval-corpus.mjs
//
// Corpus loading and schema validation. Extracted VERBATIM from run-eval.mjs in
// the 800-line split.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CASES_DIR, SUITES } from './eval-paths.mjs';
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
  }
  return problems;
}
export { loadSuite, REQUIRED, REQUIRED_PRESENT, schemaProblems };

// verify/eval/eval-paths.mjs
//
// Paths and the suite list, shared by every mode. Extracted VERBATIM from
// run-eval.mjs when that file crossed the repo's 800-line cap; the expressions
// below are byte-identical to the originals, which is only true because this
// module sits in the SAME directory — `HERE` therefore still resolves to
// verify/eval and no path literal had to be re-derived. Moving it into a
// lib/ subdirectory would have forced an edit to every one of them, and an
// edit is exactly what a pure-move commit must not contain.

import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CASES_DIR = join(HERE, 'cases');
const TMP = join(tmpdir(), 'flowmic-eval');
const SUITES = ['translate', 'organize', 'realtime', 'merge'];

export { HERE, ROOT, CASES_DIR, TMP, SUITES };

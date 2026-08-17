// verify/eval/eval-paths.mjs
//
// Paths and the suite list, shared by every mode. Extracted VERBATIM from
// run-eval.mjs when that file crossed the repo's 800-line cap; the expressions
// below are byte-identical to the originals, which is only true because this
// module sits in the SAME directory — `HERE` therefore still resolves to
// verify/eval and no path literal had to be re-derived. Moving it into a
// lib/ subdirectory would have forced an edit to every one of them, and an
// edit is exactly what a pure-move commit must not contain.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CASES_DIR = join(HERE, 'cases');

/**
 * Where the production bundle (eval-prod-bundle.mjs) is written.
 *
 * 🔴 IT HAS TO SIT WHERE `apps/server-core` SITS, AND THE REASON IS A TRAP THAT
 * WAS LATENT FOR MONTHS. This was `join(tmpdir(), 'flowmic-eval')`. The bundle
 * is built with `--packages=external`, so every bare specifier the production
 * source imports is resolved AT RUNTIME, by walking up from the directory the
 * bundle sits in. Under the OS temp directory that walk finds no `node_modules`
 * at all, and the harness dies with ERR_MODULE_NOT_FOUND.
 *
 * ⚠️ The repo root is NOT far enough, and this is the part that is easy to get
 * wrong twice: pnpm uses a strict layout, so `@flowmic/protocol` is linked into
 * `apps/server-core/node_modules/@flowmic/` and does NOT exist in the root
 * `node_modules/` (measured). The bundle is server-core's own code, so it has to
 * resolve its dependencies from where server-core resolves them.
 *
 * It worked anyway, right up until it didn't, for a reason that has nothing to
 * do with the harness: every `@flowmic/protocol` import on the bundled path
 * happened to be an `import type`, and esbuild ERASES those. So the bundle had
 * no runtime dependency to resolve. The first production line to import a
 * VALUE from the protocol package (card C8 imports `DEFAULT_POLISH_STRENGTH`)
 * broke a file nobody had touched.
 *
 * ⚠️ The failure mode is what makes this worth a paragraph: it does not look
 * like "the eval harness has a path bug", it looks like "your new import is
 * wrong". The fix belongs here rather than in the production file — a source
 * file must not have to know that some harness bundles it into a directory
 * where its dependencies do not exist.
 *
 * `node_modules/` is already gitignored wholesale, so nothing new is ignored.
 */
const TMP = join(ROOT, 'apps', 'server-core', 'node_modules', '.cache', 'flowmic-eval');
const SUITES = ['translate', 'organize', 'realtime', 'merge'];

export { HERE, ROOT, CASES_DIR, TMP, SUITES };

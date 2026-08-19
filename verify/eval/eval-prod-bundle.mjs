// verify/eval/eval-prod-bundle.mjs
//
// The bundle step that imports PRODUCTION TypeScript into this JS harness.
// Extracted VERBATIM from run-eval.mjs in the 800-line split. Shared by
// --mode=live, --mode=replay and --mode=guard, which is why it is its own
// module rather than living with any one of them.
//
// ---------------------------------------------------------------------------
// THE ESBUILD LOOKUP, AND WHY THE GATE THAT DEPENDS ON IT HAD NEVER RUN
// ---------------------------------------------------------------------------
//
// This file used to name the bundler by a hard-coded path literal:
//
//     apps/server-core/node_modules/.bin/esbuild   (+ '.CMD' on win32)
//
// That string describes a HOISTED npm layout. This repo installs with pnpm,
// whose layout is strict: a package appears in a `node_modules` directory only
// when something declared it as a dependency. Nothing in this repo declares
// esbuild -- it arrives as a dependency of `tsup`, which apps/server-core does
// declare (apps/server-core/package.json, devDependencies."tsup"), and it is
// reachable only from tsup's own directory inside the virtual store.
//
// Measured on a fully installed tree: `apps/server-core/node_modules/.bin/`
// holds tsc, tsserver, tsup, tsup-node and vitest -- and no esbuild of any
// kind. There is no `node_modules/esbuild` at the repo root either. The path
// literal named a file that has never existed here.
//
// The cost was not a red gate. It was a GREEN one: the caller
// (scripts/w2-eval-corpus.test.mjs) probed that same literal with existsSync,
// found nothing, printed SKIP and exited 2, and `pnpm verify:scripts` filed the
// whole suite under "skip". Both sections that import production source -- the
// merge replay and the compose output-guard eval -- had therefore never
// executed once. This is the repo's "measure your ruler" shape with the ruler
// replaced by a path string: the assumption could not be caught being wrong,
// because nothing ever reached it.
//
// WHY resolveEsbuild() DOES NOT SIMPLY CALL require.resolve('esbuild').
// That is the obvious fix and it does not work here -- MEASURED, all three
// plausible anchors, on a fully installed tree:
//
//     createRequire(import.meta.url).resolve('esbuild')             MODULE_NOT_FOUND
//     createRequire(<root>/package.json).resolve('esbuild')         MODULE_NOT_FOUND
//     createRequire(<server-core>/package.json).resolve('esbuild')  MODULE_NOT_FOUND
//
// because none of those packages declares esbuild. It is kept as the FIRST
// attempt anyway, so that the day someone adds esbuild as a real dependency
// this file needs no edit; the tsup route is the fallback that works today.
//
// Resolving through tsup is not a workaround that happens to find A copy of
// esbuild -- it finds THE copy `pnpm --filter @flowmic/server-core build` runs,
// which is what the comment on loadProductionPrompts() below has always
// claimed ("the SAME esbuild the product's own tsup build uses"). Until now
// that sentence was aspirational: the literal pointed at a `.bin` shim that
// would have been whatever the installer hoisted, if it had existed at all.
//
// REVERSE CONTROL (recorded here so the next reader need not take it on trust).
// Route 2's `resolve('tsup/package.json')` was temporarily changed to
// `resolve('tsup-does-not-exist/package.json')`, i.e. both routes made to fail,
// and the gate re-run. Verbatim, from scripts/w2-eval-corpus.test.mjs (one
// line, wrapped here only to fit the column):
//
//     SKIP: esbuild could not be resolved (direct: MODULE_NOT_FOUND; via
//     tsup: MODULE_NOT_FOUND) - run pnpm install — merge replay and guard
//     eval could not run
//     ACCOUNTING: sections run 1/1 — selftest: ...
//     EXIT=2
//
// Restored by hand; the suite went back to `sections run 3/3` and EXIT=0. The
// point of the drill is that the skip path is still REACHABLE and still says
// something true -- an unreachable skip branch would be its own kind of lie.
// Note the direct route reports MODULE_NOT_FOUND in BOTH readings: it fails on
// the green path too, and route 2 is what carries this gate today.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, TMP } from './eval-paths.mjs';

const requireHere = createRequire(import.meta.url);

/** Repo-relative rendering, so nothing this module prints carries an absolute
 *  path off this machine (verify/lint/oss-absent-sweep.mjs refuses those). */
const showRepoRelative = (abs) => relative(ROOT, abs).split('\\').join('/');

/**
 * Find esbuild wherever the package manager actually put it.
 *
 * @returns {{ok: true, entry: string, where: string, via: string}
 *          | {ok: false, reason: string}}
 *   `entry` is esbuild's JS API module, not a CLI shim -- see
 *   loadProductionPrompts() for why the API is called in-process. `where` is
 *   that path rendered repo-relative so a caller can PRINT which esbuild
 *   actually ran without leaking an absolute path
 *   (verify/lint/oss-absent-sweep.mjs refuses those). Printing it is the cheap
 *   half of the lesson in this file's header: the old shape's answer to
 *   "which bundler?" never appeared in any output, so nobody could notice it
 *   was wrong.
 */
function resolveEsbuild() {
  const tried = [];

  // 1. The declared-dependency route. Fails today (see the header), kept so a
  //    future `pnpm add -D esbuild` needs no edit here.
  try {
    const entry = requireHere.resolve('esbuild');
    return { ok: true, entry, where: showRepoRelative(entry), via: 'declared dependency' };
  } catch (err) {
    tried.push(`direct: ${err?.code ?? err?.message ?? 'failed'}`);
  }

  // 2. Through tsup, anchored at apps/server-core -- the exact esbuild that
  //    package's own `build` script runs.
  try {
    const fromServerCore = createRequire(
      pathToFileURL(join(ROOT, 'apps', 'server-core', 'package.json')).href,
    );
    const fromTsup = createRequire(fromServerCore.resolve('tsup/package.json'));
    const entry = fromTsup.resolve('esbuild');
    return {
      ok: true,
      entry,
      where: showRepoRelative(entry),
      via: "tsup's esbuild (the one apps/server-core builds with)",
    };
  } catch (err) {
    tried.push(`via tsup: ${err?.code ?? err?.message ?? 'failed'}`);
  }

  return { ok: false, reason: `esbuild could not be resolved (${tried.join('; ')}) - run pnpm install` };
}

/**
 * The system prompts come from PRODUCTION SOURCE, imported, never re-typed
 * here. A copy would drift and this runner would then be measuring a prompt
 * the product does not use — the exact "measure your ruler" failure this repo
 * keeps paying for.
 */
async function loadProductionPrompts() {
  // Bundled with the SAME esbuild the product's own `tsup` build uses, from the
  // SAME source files, rather than re-typed here. `apps/server-core/dist` is a
  // single bundle that exports only its entry point, and the raw .ts cannot be
  // imported directly because stt-polish.ts resolves a directory specifier that
  // TypeScript accepts and Node's ESM loader does not — so a bundle step is the
  // only faithful route to these symbols.
  //
  // The JS API is invoked in-process rather than by spawning a CLI. The old
  // shape spawned a `.bin` shim with `shell: true` on win32; resolving the
  // package itself makes the shim, the platform-specific '.CMD' suffix and the
  // shell hop all unnecessary, and removes the second place a layout assumption
  // could hide.
  const found = resolveEsbuild();
  if (!found.ok) throw new Error(found.reason);
  const esbuild = await import(pathToFileURL(found.entry).href);
  const src = (rel) => join(ROOT, 'apps/server-core/src', rel).replace(/\\/g, '/');
  const entry = join(TMP, 'eval-prod-entry.ts');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    entry,
    [
      `export { renderSystemPrompt, renderTaskTemplate } from '${src('compose/prompt')}';`,
      // 🔴 `polishSystemPrompt` is exported ALONGSIDE the constant, not instead
      // of it, and the distinction is the whole reason this line is a comment.
      // Card C8 made the prompt a function of the correction strength. If this
      // harness kept sending only the constant, it would still be measuring a
      // real prompt — but only ONE of the two the product now sends, while
      // reporting a number that reads as "realtime". The function is what
      // production calls, so it is what the harness calls; the constant stays
      // because `strict` resolves to it by identity and other assertions depend
      // on that being true.
      `export { POLISH_SYSTEM_PROMPT, POLISH_SMOOTH_SYSTEM_PROMPT, polishSystemPrompt } from '${src('stt/stt-polish')}';`,
      `export { normalizeFinalText } from '${src('stt/final-text-normalizer')}';`,
      `export { checkMeaningPreserved } from '${src('stt/stt-polish-guard')}';`,
      `export { mergeOnlineDraft, mergeOverlap, overlapLen, foldConfirmedWithDraft } from '${src('stt/text-merge')}';`,
      `export { guardComposeOutput } from '${src('compose/output-guard')}';`,
    ].join('\n'),
    'utf8',
  );
  const outfile = join(TMP, 'eval-prod-bundle.mjs');
  try {
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      outfile,
    });
  } catch (err) {
    throw new Error(`esbuild failed: ${String(err?.message ?? err).slice(0, 400)}`);
  }
  return import(`file:///${outfile.replace(/\\/g, '/')}?t=${Date.now()}`);
}

export { loadProductionPrompts, resolveEsbuild };

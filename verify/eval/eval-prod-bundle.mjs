// verify/eval/eval-prod-bundle.mjs
//
// The bundle step that imports PRODUCTION TypeScript into this JS harness.
// Extracted VERBATIM from run-eval.mjs in the 800-line split. Shared by
// --mode=live, --mode=replay and --mode=guard, which is why it is its own
// module rather than living with any one of them.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, TMP } from './eval-paths.mjs';

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
  const bin = join(ROOT, 'apps/server-core/node_modules/.bin/esbuild' + (process.platform === 'win32' ? '.CMD' : ''));
  if (!existsSync(bin)) throw new Error(`esbuild not found at ${bin} — run pnpm install`);
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
  const r = spawnSync(bin, [entry, '--bundle', '--format=esm', '--platform=node', '--packages=external', `--outfile=${outfile}`], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`esbuild failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  return import(`file:///${outfile.replace(/\\/g, '/')}?t=${Date.now()}`);
}

export { loadProductionPrompts };

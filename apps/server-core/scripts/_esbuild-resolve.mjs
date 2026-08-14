// scripts/_esbuild-resolve.mjs
// Robustly resolve esbuild's `build` across pnpm layouts: try a bare import
// first, then fall back to globbing the workspace's pnpm virtual store. esbuild
// is a transitive dev dependency (via tsup + vitest); it is not a runtime dep of
// the shipped server, only of the LAN smoke tooling.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

async function resolveBuild() {
  try {
    const m = await import('esbuild');
    if (typeof m.build === 'function') return m.build;
  } catch {
    /* fall through to store glob */
  }
  const store = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(store)) {
    const dirs = fs.readdirSync(store).filter((d) => /^esbuild@/.test(d)).sort().reverse();
    for (const d of dirs) {
      const main = path.join(store, d, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (fs.existsSync(main)) {
        const m = await import(pathToFileURL(main).href);
        if (typeof m.build === 'function') return m.build;
      }
    }
  }
  throw new Error('esbuild not found (bare import + pnpm store glob both failed)');
}

export const build = await resolveBuild();

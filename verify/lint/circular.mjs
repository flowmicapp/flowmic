// verify/lint/circular.mjs
// Lint 6/12 — circular import detection (Tarjan SCC).
// (🔴 CORRECTED 2026-08-07: was "6/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Builds the relative-import graph over workspace TS sources (packages/*/src,
// apps/*/src) and runs Tarjan's strongly-connected-components. Any SCC with
// more than one node, or a self-import, is an import cycle -> FAIL.
//
// packages/protocol/src is the live target today.

import path from 'node:path';
import { ROOT, walk, readText, rel, isFile, stripJsComments } from './_util.mjs';

export const name = 'circular';

const SRC_GLOBS = ['packages', 'apps'];
const TS_EXT = new Set(['.ts', '.tsx']);

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?(['"])((?:\.|\.\.)\/[^'"]+)\1|import\s*\(\s*(['"])((?:\.|\.\.)\/[^'"]+)\3/g;

async function resolveImport(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const cands = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const c of cands) if (await isFile(c)) return c;
  return null;
}

// Only consider files that live under a */src/ directory.
function isWorkspaceSrc(relPath) {
  return /(^|\/)src\//.test(relPath) && TS_EXT.has(path.extname(relPath));
}

async function buildGraph() {
  const files = [];
  for (const g of SRC_GLOBS) {
    for (const abs of await walk(path.join(ROOT, g))) {
      const r = rel(abs);
      if (isWorkspaceSrc(r) && TS_EXT.has(path.extname(abs))) {
        files.push(abs);
      }
    }
  }
  const adj = new Map();
  for (const f of files) adj.set(f, []);
  for (const f of files) {
    const src = await readText(f);
    if (src == null) continue;
    // Same ADM-P0-1 rule as module-reachability: a commented-out import is
    // not an edge. Shared stripper lives in _util.mjs.
    for (const m of stripJsComments(src).matchAll(IMPORT_RE)) {
      const spec = m[2] || m[4];
      if (!spec) continue;
      const target = await resolveImport(f, spec);
      if (target && adj.has(target)) adj.get(f).push(target);
    }
  }
  return adj;
}

// Iterative Tarjan SCC.
function tarjan(adj) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const nodes = [...adj.keys()];

  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work = [{ node: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.node;
      if (frame.i === 0) {
        idx.set(v, index);
        low.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
      }
      const neighbors = adj.get(v) || [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i];
        frame.i++;
        if (!idx.has(w)) {
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
  }
  return sccs;
}

function selfLoops(adj) {
  const loops = [];
  for (const [v, ns] of adj) if (ns.includes(v)) loops.push(v);
  return loops;
}

export default async function run() {
  const adj = await buildGraph();
  if (adj.size === 0) {
    return { status: 'SKIP', detail: 'no workspace TS sources under */src' };
  }
  const cycles = tarjan(adj).filter((c) => c.length > 1);
  const self = selfLoops(adj);
  if (cycles.length > 0 || self.length > 0) {
    const parts = [];
    for (const c of cycles.slice(0, 5)) parts.push(c.map(rel).join(' -> '));
    for (const s of self.slice(0, 5)) parts.push(`self: ${rel(s)}`);
    return { status: 'FAIL', detail: `${cycles.length + self.length} cycle(s): ${parts.join(' | ')}` };
  }
  return { status: 'PASS', detail: `${adj.size} module(s), no import cycles` };
}

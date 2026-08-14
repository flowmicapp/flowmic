// verify/lint/module-reachability.mjs
// Lint 4/12 — SPEC-named module reachability.
// (🔴 CORRECTED 2026-08-07: was "4/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Anti-façade guard for whole modules: a module named in the SPEC must be
// reachable from a real runtime entry point via the import graph (BFS).
// Unreachable SPEC module -> FAIL (capability defined but nobody wires it).
//
// The import-graph builder is written now; ENTRY_POINTS is intentionally empty
// until apps/* land, so the lint SKIPs. Fill ENTRY_POINTS (and SPEC_MODULES)
// as runtime entries are created.
//
// 🔴 ADM-P0-1 (2026-08-10): the scanner MUST strip comments before matching
// import edges. A retired `// import … from './x'` left behind as an explanation
// used to count as a live edge — false green, the failure direction this gate
// exists to prevent. Shared stripper = stripJsComments in _util.mjs.

import path from 'node:path';
import { ROOT, readText, exists, isFile, stripJsComments } from './_util.mjs';

export const name = 'module-reachability';

// Runtime entry files, repo-relative. Filled by WP-R1-2 as server-core lands
// (the one verify/ change that card sanctions).
const ENTRY_POINTS = ['apps/server-core/src/index.ts'];

// SPEC-mandated modules that must be reachable from a runtime entry via the
// import graph — the anti-façade guard for whole modules ("capability defined
// but nobody wires it", 13-LESSONS §3 D1). Each must be import-reachable from
// index.ts or the lint fails.
const SPEC_MODULES = [
  'apps/server-core/src/bootstrap.ts',
  'apps/server-core/src/db/connection.ts',
  'apps/server-core/src/billing/billing-service.ts',
  'apps/server-core/src/settings/defaults.ts',
  'apps/server-core/src/socket/handlers/pc.handler.ts',
  'apps/server-core/src/socket/handlers/mobile.handler.ts',
  'apps/server-core/src/socket/handlers/settings.handler.ts',
  'apps/server-core/src/socket/handlers/timeline.handler.ts',
  'apps/server-core/src/socket/handlers/audio.handler.ts',
  'apps/server-core/src/socket/handlers/compose.handler.ts',
  'apps/server-core/src/socket/handlers/relay.handler.ts',
  // GA-07 (04 §3.2 liveness): both are anti-façade-critical — a heartbeat
  // consumer or a sys:ping emitter that nobody wires is worse than none.
  'apps/server-core/src/socket/handlers/heartbeat.handler.ts',
  'apps/server-core/src/room/liveness.ts',
  'apps/server-core/src/http/router.ts',
];

export const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?(['"])((?:\.|\.\.)\/[^'"]+)\1|import\s*\(\s*(['"])((?:\.|\.\.)\/[^'"]+)\3/g;

/** Relative import/export specs after comment stripping (test surface). */
export function collectImportSpecs(src) {
  const cleaned = stripJsComments(src);
  const out = [];
  for (const m of cleaned.matchAll(IMPORT_RE)) {
    const spec = m[2] || m[4];
    if (spec) out.push(spec);
  }
  return out;
}

async function resolveImport(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const cands = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.mjs',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ];
  for (const c of cands) {
    if (await isFile(c)) return c;
  }
  return null;
}

/**
 * BFS import closure from entry points; report which SPEC modules are missing.
 * Parameterised so drills can drive a disposable fixture tree (ADM-P0-1).
 *
 * @param {{ root: string, entryPoints: string[], specModules: string[] }} opts
 * @returns {Promise<{ status: 'PASS'|'FAIL'|'SKIP', detail: string, visited: Set<string>, unreachable: string[] }>}
 */
export async function checkReachability({ root, entryPoints, specModules }) {
  if (entryPoints.length === 0) {
    return {
      status: 'SKIP',
      detail: 'no runtime entry points yet (ENTRY_POINTS empty until apps/*)',
      visited: new Set(),
      unreachable: [],
    };
  }

  const visited = new Set();
  const queue = [];
  for (const e of entryPoints) {
    const abs = path.join(root, e);
    if (await exists(abs)) queue.push(abs);
  }
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const src = await readText(cur);
    if (src == null) continue;
    for (const spec of collectImportSpecs(src)) {
      const target = await resolveImport(cur, spec);
      if (target && !visited.has(target)) queue.push(target);
    }
  }

  const unreachable = specModules.filter((m) => !visited.has(path.join(root, m)));
  if (unreachable.length > 0) {
    return {
      status: 'FAIL',
      detail: `${unreachable.length} unreachable SPEC module(s): ${unreachable.join(', ')}`,
      visited,
      unreachable,
    };
  }
  return {
    status: 'PASS',
    detail: `${visited.size} module(s) reachable, all ${specModules.length} SPEC modules wired`,
    visited,
    unreachable: [],
  };
}

export default async function run() {
  const result = await checkReachability({
    root: ROOT,
    entryPoints: ENTRY_POINTS,
    specModules: SPEC_MODULES,
  });
  return { status: result.status, detail: result.detail };
}

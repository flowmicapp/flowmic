#!/usr/bin/env node
// Drill for verify/lint/circular.mjs — Tarjan SCC over the relative-import
// graph. Until this file existed it had no fixture test: `tarjan`/`selfLoops`
// are a from-scratch iterative implementation (recursion would blow the stack
// on a real workspace), and nothing proved the two together actually convict
// a real cycle rather than merely running without throwing.
//
// `tarjan` and `selfLoops` gained `export` on 2026-09-02 (B2-A) — pure
// functions over an adjacency Map, no refactor needed. `buildGraphFrom(rootsAbs)`
// is a parameterised extraction of the old `buildGraph()`, letting this drill
// build a real fixture tree with real import statements and prove the WHOLE
// pipeline (walk -> comment-stripping -> import resolution -> graph -> SCC),
// not just the graph algorithm on a hand-built Map.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tarjan, selfLoops, buildGraphFrom } from '../verify/lint/circular.mjs';
import circular from '../verify/lint/circular.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

console.log('=== §1 tarjan: a 3-node cycle A->B->C->A is one SCC of size 3 (positive control) ===');
{
  const adj = new Map([
    ['A', ['B']],
    ['B', ['C']],
    ['C', ['A']],
  ]);
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 1 && sccs[0].length === 3, 'exactly one 3-node SCC is found', JSON.stringify(sccs));
}

console.log('=== §2 negative control: a DAG (A->B->C, no back edge) has no multi-node SCC ===');
{
  const adj = new Map([
    ['A', ['B']],
    ['B', ['C']],
    ['C', []],
  ]);
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 0, 'a linear chain has zero cycles', JSON.stringify(sccs));
}

console.log('=== §3 selfLoops: A importing itself is caught, and tarjan alone does NOT catch it ===');
{
  const adj = new Map([['A', ['A']]]);
  const loops = selfLoops(adj);
  check(loops.length === 1 && loops[0] === 'A', 'the self-loop is reported', JSON.stringify(loops));
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 0, 'REVERSE CONTROL: tarjan alone reports zero multi-node SCCs for a 1-node self-loop — selfLoops is load-bearing, not redundant', JSON.stringify(sccs));
}

console.log('=== §4 negative control: two disjoint DAGs share no false cycle ===');
{
  const adj = new Map([
    ['A', ['B']], ['B', []],
    ['X', ['Y']], ['Y', []],
  ]);
  check(tarjan(adj).filter((c) => c.length > 1).length === 0, 'two disjoint chains produce zero cycles');
  check(selfLoops(adj).length === 0, 'and zero self-loops');
}

console.log('=== §5 buildGraphFrom: a real fixture tree with a genuine A<->B import cycle is caught end-to-end (positive control) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmcirc-cycle-'));
  put(T, 'packages/fix/src/a.ts', "import { b } from './b';\nexport const a = 1;\n");
  put(T, 'packages/fix/src/b.ts', "import { a } from './a';\nexport const b = 1;\n");
  const adj = await buildGraphFrom([T]);
  check(adj.size === 2, 'both files are nodes in the graph', `size=${adj.size}`);
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 1 && sccs[0].length === 2, 'a.ts <-> b.ts is caught as a real 2-node cycle', JSON.stringify(sccs.map((c) => c.length)));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §6 REVERSE CONTROL: the SAME two files with the back-import removed have no cycle ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmcirc-nocycle-'));
  put(T, 'packages/fix/src/a.ts', "import { b } from './b';\nexport const a = 1;\n");
  put(T, 'packages/fix/src/b.ts', "export const b = 1;\n"); // no import back to a.ts
  const adj = await buildGraphFrom([T]);
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 0, 'removing the back-import removes the cycle — the drill actually distinguishes the two trees', JSON.stringify(sccs));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §7 a commented-out import is NOT an edge (ADM-P0-1 rule, shared stripJsComments) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmcirc-commented-'));
  put(T, 'packages/fix/src/a.ts', "// import { b } from './b'; -- disabled, do not re-enable\nexport const a = 1;\n");
  put(T, 'packages/fix/src/b.ts', "import { a } from './a';\nexport const b = 1;\n");
  const adj = await buildGraphFrom([T]);
  const sccs = tarjan(adj).filter((c) => c.length > 1);
  check(sccs.length === 0, 'a commented-out import does not create a false cycle', JSON.stringify(sccs));
  check(adj.get([...adj.keys()].find((k) => k.endsWith('a.ts'))).length === 0, 'a.ts has zero real edges out despite the comment naming b.ts');
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §8 only files under a */src/ directory are counted (isWorkspaceSrc) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmcirc-outside-'));
  put(T, 'packages/fix/scripts/tool.ts', "import { x } from './helper';\n"); // NOT under src/
  put(T, 'packages/fix/scripts/helper.ts', "export const x = 1;\n");
  const adj = await buildGraphFrom([T]);
  check(adj.size === 0, 'files outside */src/ are not counted at all', `size=${adj.size}`);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §9 the lint itself runs on the real workspace and answers ===');
{
  const res = await circular();
  check(res.status === 'PASS', 'the real workspace has no import cycles', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} circular drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);

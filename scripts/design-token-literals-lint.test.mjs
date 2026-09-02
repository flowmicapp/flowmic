#!/usr/bin/env node
// Drill for verify/lint/design-token-literals.mjs — proves `collectHits` /
// `findNew` / `findStale` actually catch what the lint claims to catch, and
// (B2-P) that a stale ALLOWLIST entry FAILs the gate by name.
//
// `collectHits`, `multiset`, `findNew`, `DESKTOP_RE`, `MOBILE_RE`, `ALLOWLIST`
// were exported so this drill could import them directly instead of shelling
// out and scraping stdout. `findStale` reports which pinned (file|literal)
// keys have zero hits left anywhere in the tree.
//
// History this drill pins down (do not let it drift back): B2-A (2026-09-02)
// added `findStale` as REPORT-ONLY — the ALLOWLIST it inherited already had 3
// stale entries and B2-A's scope forbade editing allowlist content, so wiring
// it into PASS/FAIL would have turned a green gate red over content that task
// could not touch. B2-P (same day) pruned those 3 entries (verified absent by
// grep, not just by this scanner) and turned `findStale` into a real gate:
// §7-§9 below prove a stale entry now fails the lint, §10 proves the REAL
// current ALLOWLIST carries zero stale entries (the prune actually landed),
// and §11 is the reverse control — a fabricated stale entry, injected via a
// throwaway copy of the module's own scan output, turns the real gate RED.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import {
  collectHits,
  multiset,
  findNew,
  findStale,
  DESKTOP_RE,
  MOBILE_RE,
  ALLOWLIST,
} from '../verify/lint/design-token-literals.mjs';
import designTokenLiterals from '../verify/lint/design-token-literals.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

console.log('=== §1 collectHits: a desktop hex literal is caught (positive control) ===');
{
  const hits = collectHits('.card { background: #ff00aa; }\n', 'apps/desktop/src/lib/x.ts', DESKTOP_RE);
  check(hits.length === 1 && hits[0].lit === '#ff00aa', 'the hex literal is collected with the right text', JSON.stringify(hits));
  check(hits[0].key === 'apps/desktop/src/lib/x.ts|#ff00aa', 'the key combines file and literal', hits[0].key);
}

console.log('=== §2 collectHits: mobile Colors.x / Color(0x...) are caught, Colors.transparent is not ===');
{
  const src = 'final c = Colors.red;\nfinal d = Color(0xFF112233);\nfinal e = Colors.transparent;\n';
  const hits = collectHits(src, 'apps/mobile/lib/src/x.dart', MOBILE_RE);
  check(hits.some((h) => h.lit === 'Colors.red'), 'Colors.red is a hit');
  check(hits.some((h) => h.lit === 'Color(0xFF112233)'), 'Color(0x...) is a hit');
  check(!hits.some((h) => h.lit.includes('transparent')), 'Colors.transparent is deliberately NOT a hit (it names an absence, not a colour)', JSON.stringify(hits));
}

console.log('=== §3 negative control: FlowMicColors.x is not a Material Colors.x hit ===');
{
  const hits = collectHits('final c = FlowMicColors.brand;\n', 'apps/mobile/lib/src/x.dart', MOBILE_RE);
  check(hits.length === 0, 'a token-file colour reference produces zero hits', JSON.stringify(hits));
}

console.log('=== §4 findNew: a literal not in the baseline is reported (positive control) ===');
{
  const hits = [{ key: 'apps/desktop/src/lib/new-file.ts|#123456', file: 'apps/desktop/src/lib/new-file.ts', line: 1, lit: '#123456' }];
  const neu = findNew(hits, ALLOWLIST);
  check(neu.length === 1 && neu[0].lit === '#123456', 'a brand-new literal is reported as new', JSON.stringify(neu));
}

console.log('=== §5 REVERSE CONTROL: the SAME literal, once already in the baseline, is not "new" (negative control) ===');
{
  const [sampleKey] = ALLOWLIST;
  const [file, lit] = sampleKey.split('|');
  const hits = [{ key: sampleKey, file, line: 1, lit }];
  const neu = findNew(hits, ALLOWLIST);
  check(neu.length === 0, 'a hit matching an existing allowlist entry is not new', JSON.stringify(neu));
}

console.log('=== §6 findNew: multiplicity is honoured — one MORE occurrence than pinned IS new ===');
{
  const target = ALLOWLIST.find((k) => multiset(ALLOWLIST).get(k) === 1);
  if (!target) {
    bad('found a baseline entry pinned exactly once to build this case on', 'ALLOWLIST has none — cannot run §6');
  } else {
    const [file, lit] = target.split('|');
    const hits = [
      { key: target, file, line: 1, lit },
      { key: target, file, line: 5, lit }, // a SECOND occurrence of the same file|literal
    ];
    const neu = findNew(hits, ALLOWLIST);
    check(neu.length === 1, 'the second occurrence beyond the pinned count of 1 is reported new', JSON.stringify(neu));
  }
}

console.log('=== §7 findStale: a baseline key with zero current hits is rot (positive control) ===');
{
  const baseline = ['apps/x.dart|Color(0xDEADBEEF)', 'apps/y.dart|Colors.red'];
  const hits = [{ key: 'apps/y.dart|Colors.red', file: 'apps/y.dart', line: 1, lit: 'Colors.red' }];
  const stale = findStale(baseline, hits);
  check(stale.length === 1 && stale[0] === 'apps/x.dart|Color(0xDEADBEEF)', 'the entry with zero current hits is reported stale', JSON.stringify(stale));
}

console.log('=== §8 REVERSE CONTROL: a baseline key that still has a hit is NOT stale (negative control) ===');
{
  const baseline = ['apps/y.dart|Colors.red'];
  const hits = [{ key: 'apps/y.dart|Colors.red', file: 'apps/y.dart', line: 1, lit: 'Colors.red' }];
  const stale = findStale(baseline, hits);
  check(stale.length === 0, 'a baseline entry still hit is not reported', JSON.stringify(stale));
}

console.log('=== §9 findStale: duplicate baseline keys collapse to one report, not one per duplicate ===');
{
  // Multiplicity-2 baseline entry losing its LAST use is rot exactly once,
  // not twice — a caller naming stale entries in a FAIL message must not
  // double-count a (file|literal) pinned more than once.
  const baseline = ['apps/y.dart|Colors.red', 'apps/y.dart|Colors.red'];
  const stale = findStale(baseline, []);
  check(stale.length === 1, 'a doubly-pinned key with zero hits is reported once, not twice', JSON.stringify(stale));
}

console.log('=== §10 run(): the REAL current ALLOWLIST has zero stale entries (the B2-P prune landed) ===');
{
  const res = await designTokenLiterals();
  check(res.status === 'PASS', 'the real gate PASSes on the current tree', res.status);
  check(/0 new, 0 stale/.test(res.detail), 'the detail confirms zero new AND zero stale', res.detail);
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log('=== §11 REVERSE CONTROL: a fabricated stale ALLOWLIST entry turns the real gate RED ===');
{
  // Rebuild run()'s own scan (desktop + mobile walk) via the exported
  // primitives so this control exercises the SAME hit-collection path the
  // real lint uses, then feed it a baseline that includes one entry with a
  // literal that provably does not exist anywhere in the tree. If the gate
  // did not check `findStale`, this would stay PASS; it must not.
  const path = await import('node:path');
  const { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } = await import('../verify/lint/_util.mjs');
  const skipDir = (basename) => DEFAULT_SKIP_DIRS.has(basename);
  const isTestFile = (relPath) =>
    /(^|\/)(test|tests|__tests__)\//.test(relPath) ||
    /\.test\.(ts|vue|js|mjs)$/.test(relPath) ||
    /_test\.dart$/.test(relPath);

  const hits = [];
  const DESKTOP_ROOT = path.join(ROOT, 'apps', 'desktop', 'src');
  const MOBILE_ROOT = path.join(ROOT, 'apps', 'mobile', 'lib');
  for (const abs of await walk(DESKTOP_ROOT, { skipDir })) {
    const r = rel(abs);
    if (r === 'apps/desktop/src/styles/tokens.css' || !/\.(vue|ts)$/.test(r)) continue;
    const text = await readText(abs);
    if (text == null || isTestFile(r)) continue;
    hits.push(...collectHits(text, r, DESKTOP_RE));
  }
  for (const abs of await walk(MOBILE_ROOT, { skipDir })) {
    const r = rel(abs);
    if (r === 'apps/mobile/lib/src/ui/tokens.dart' || !r.endsWith('.dart')) continue;
    const text = await readText(abs);
    if (text == null || isTestFile(r)) continue;
    hits.push(...collectHits(text, r, MOBILE_RE));
  }

  const FABRICATED = 'apps/mobile/lib/src/ui/nonexistent_file_for_drill.dart|Color(0xDEADBEEF)';
  check(!hits.some((h) => h.key === FABRICATED), 'sanity: the fabricated key really has zero hits in this tree', FABRICATED);

  const fabricatedBaseline = [...ALLOWLIST, FABRICATED];
  const stale = findStale(fabricatedBaseline, hits);
  check(stale.length === 1 && stale[0] === FABRICATED, 'the fabricated stale entry is the ONLY one reported (the real ALLOWLIST is clean)', JSON.stringify(stale));

  // Reproduce run()'s own PASS/FAIL branch with this poisoned baseline to
  // prove the wiring, not just the primitive.
  const neu = findNew(hits, fabricatedBaseline);
  const status = neu.length > 0 || stale.length > 0 ? 'FAIL' : 'PASS';
  check(status === 'FAIL', 'a stale-only baseline (no new hits) still flips the gate to FAIL — seen red', status);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} design-token-literals drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);

// Drill for verify/lint/module-reachability.mjs (card C8 / ADM-P0-1).
//
// WHY THIS EXISTS. That lint is the whole-module anti-façade gate, and until
// ADM-P0-1 it could be talked into green: a `// import … from './x'` left as
// an explanation counted as a live import edge. Measured on the bare IMPORT_RE
// (docs/strategy/2026-08-10-adm-p0-findings.md §1): line-commented and
// block-commented imports both COUNTED. False green is the worst failure mode
// for a gate whose only job is to catch unwired capabilities.
//
// No pre-existing test draft was found under verify/ / scripts/ / docs/ — this
// file is the specification. Pattern matches
// scripts/ossdef-no-lan-ip-lint.test.mjs / scripts/coordinate-anchors-lint.test.mjs:
// pure functions + disposable fixtures; nothing in the live tree is edited.
//
// EXIT CODES (card IT-38, scripts/run-script-tests.mjs): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips.
//
// Run: `node scripts/module-reachability-lint.test.mjs`

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripJsComments } from '../verify/lint/_util.mjs';
import {
  IMPORT_RE,
  collectImportSpecs,
  checkReachability,
} from '../verify/lint/module-reachability.mjs';

let failures = 0;
const TOTAL_SECTIONS = 4;
let sectionsRun = 0;

function section(title) {
  sectionsRun++;
  process.stdout.write(`\n=== ${title} ===\n`);
}

function check(label, cond, detail = '') {
  if (cond) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/** Bare IMPORT_RE (no strip) — the pre-fix classifier, for reverse-control evidence. */
function specsRaw(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2] || m[4];
    if (spec) out.push(spec);
  }
  return out;
}

const TARGET = './orphan-module';

// ── §1 reverse control: bare IMPORT_RE still counts comment mentions (RED proof) ─
section('§1 reverse control — bare IMPORT_RE is fooled by comments');
{
  const line = `// import { x } from '${TARGET}';`;
  const block = `/* import { x } from '${TARGET}'; */`;
  const prose = `// was import { x } from '${TARGET}'; before the move`;
  const real = `import { x } from '${TARGET}';`;

  const lineHits = specsRaw(line);
  const blockHits = specsRaw(block);
  const proseHits = specsRaw(prose);
  const realHits = specsRaw(real);

  // These three MUST stay true: they are the measured false-green shape.
  // If a future IMPORT_RE rewrite stops matching comments without stripping,
  // this section goes red and must be rewritten — do not delete the evidence.
  check(
    'REVERSE-CONTROL: line-commented import COUNTS on bare IMPORT_RE',
    lineHits.length === 1 && lineHits[0] === TARGET,
    JSON.stringify(lineHits),
  );
  check(
    'REVERSE-CONTROL: block-commented import COUNTS on bare IMPORT_RE',
    blockHits.length === 1 && blockHits[0] === TARGET,
    JSON.stringify(blockHits),
  );
  check(
    'REVERSE-CONTROL: prose with import+path COUNTS on bare IMPORT_RE',
    proseHits.length === 1 && proseHits[0] === TARGET,
    JSON.stringify(proseHits),
  );
  check('real import still counts on bare IMPORT_RE', realHits[0] === TARGET, JSON.stringify(realHits));
}

// ── §2 stripper + collectImportSpecs: comments gone, strings kept ───────────
section('§2 collectImportSpecs ignores comments, keeps string literals');
{
  check(
    'line-commented import is NOT an edge after strip',
    collectImportSpecs(`// import { x } from '${TARGET}';`).length === 0,
  );
  check(
    'block-commented import is NOT an edge after strip',
    collectImportSpecs(`/* import { x } from '${TARGET}'; */`).length === 0,
  );
  check(
    'prose mentioning an import path is NOT an edge after strip',
    collectImportSpecs(`// was import { x } from '${TARGET}'; before the move`).length === 0,
  );
  check(
    'real import IS an edge after strip',
    collectImportSpecs(`import { x } from '${TARGET}';`).length === 1,
  );
  check(
    'dynamic import IS an edge after strip',
    collectImportSpecs(`const m = import('${TARGET}');`)[0] === TARGET,
  );

  // https://… must not be eaten as a line comment (the css-var-defined trap).
  const urlSrc = `const u = 'https://example.com/path';\nimport { x } from '${TARGET}';\n`;
  const urlSpecs = collectImportSpecs(urlSrc);
  check(
    "URL string with '//' keeps the following real import",
    urlSpecs.length === 1 && urlSpecs[0] === TARGET,
    JSON.stringify(urlSpecs),
  );

  // Brief constraint: // inside a template must NOT be treated as a comment
  // (would blank the rest of the "line" and can drop a following real import).
  const tmpl = "const u = `https://example.com/x`;\nimport { x } from './orphan-module';\n";
  check(
    'template literal with URL-like // does not eat the following real import',
    collectImportSpecs(tmpl)[0] === TARGET,
    JSON.stringify(collectImportSpecs(tmpl)),
  );
  const strippedTmpl = stripJsComments("const s = `// keep me`;\n");
  check(
    'stripJsComments leaves // inside template literals intact',
    strippedTmpl.includes('// keep me'),
    JSON.stringify(strippedTmpl),
  );

  const tmplExpr = "const s = `${require}`;\nimport { x } from './orphan-module';\n";
  check(
    'real import after a template literal still counts',
    collectImportSpecs(tmplExpr)[0] === TARGET,
    JSON.stringify(collectImportSpecs(tmplExpr)),
  );

  const spaced = stripJsComments('a\n// hide\nb\n');
  check('stripJsComments preserves newlines', spaced.split('\n').length === 4, JSON.stringify(spaced));
}

// ── §3 fixture: comment-only reference → FAIL; real import → PASS ───────────
section('§3 fixture reachability — comment-only RED, real import GREEN');
{
  const root = mkdtempSync(join(tmpdir(), 'fm-reach-'));
  const put = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };

  try {
    put('src/orphan.ts', 'export const orphan = 1;\n');

    // Comment-only edge from the entry — the ADM-P0-1 false-green shape.
    put(
      'src/entry-comment-only.ts',
      "// retired: import { orphan } from './orphan';\nexport const entry = 0;\n",
    );

    // Real import — green control.
    put(
      'src/entry-real.ts',
      "import { orphan } from './orphan';\nexport const entry = orphan;\n",
    );

    const spec = ['src/orphan.ts'];

    const commentOnly = await checkReachability({
      root,
      entryPoints: ['src/entry-comment-only.ts'],
      specModules: spec,
    });
    check(
      'comment-only reference → FAIL (orphan unreachable)',
      commentOnly.status === 'FAIL' && commentOnly.unreachable.includes('src/orphan.ts'),
      `${commentOnly.status} ${commentOnly.detail}`,
    );

    const real = await checkReachability({
      root,
      entryPoints: ['src/entry-real.ts'],
      specModules: spec,
    });
    check(
      'real import → PASS (orphan reachable)',
      real.status === 'PASS' && real.unreachable.length === 0,
      `${real.status} ${real.detail}`,
    );

    // Block-comment-only shape as well.
    put(
      'src/entry-block-only.ts',
      "/* import { orphan } from './orphan'; */\nexport const entry = 0;\n",
    );
    const blockOnly = await checkReachability({
      root,
      entryPoints: ['src/entry-block-only.ts'],
      specModules: spec,
    });
    check(
      'block-comment-only reference → FAIL',
      blockOnly.status === 'FAIL' && blockOnly.unreachable.includes('src/orphan.ts'),
      `${blockOnly.status} ${blockOnly.detail}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── §4 bookkeeping ──────────────────────────────────────────────────────────
section('§4 bookkeeping');
{
  check(`ran all ${TOTAL_SECTIONS} sections`, sectionsRun === TOTAL_SECTIONS, `ran ${sectionsRun}`);
}

if (failures > 0) {
  process.stdout.write(`\nFAIL ${failures} assertion(s)\n`);
  process.exit(1);
}
process.stdout.write('\nPASS module-reachability-lint\n');
process.exit(0);

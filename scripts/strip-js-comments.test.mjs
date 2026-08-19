// Drill for stripJsComments in verify/lint/_util.mjs — REGEX LITERAL handling.
//
// WHY THIS EXISTS. The stripper is a state machine over string/template
// contexts, and until 2026-08-19 it did not model regex literals at all. A
// regex holding an ODD number of quote characters therefore opened a string
// context that never closed, and from that character to the end of the file
// EVERY comment survived stripping. The reported repro was a verbatim line of
// production code in scripts/publish-apk-gates.mjs (the versionName matcher).
//
// The consequence is a false green in the worst possible direction. Two lints
// consume this stripper to decide which imports are REAL:
//   - verify/lint/module-reachability.mjs  (whole-module anti-façade gate)
//   - verify/lint/circular.mjs
// If comments survive, a commented-out `import … from './x'` counts as a live
// edge, so a module that nothing actually imports is reported reachable — a
// false green in the gate whose entire job is to catch capabilities with no
// production caller.
//
// MEASURED IMPACT AT THE TIME OF THE FIX (2026-08-19, this repo, whole tree):
//   - 858 JS/TS files scanned; the old and new strippers disagree on 68 of
//     them; in 43 the OLD stripper left a `//` comment standing.
//   - 3 of those 43 are inside module-reachability's own reachable set
//     (apps/server-core/src/compose/output-guard-text.ts,
//      apps/server-core/src/compose/scenario-inference.ts,
//      apps/server-core/src/stt/final-text-normalizer.ts) — so the bug WAS
//     firing on that lint's real input.
//   - Reachable-module count was 197 before the fix and 197 after; repo-wide
//     import-edge delta was 0 lost / 0 gained. All three affected modules have
//     no relative imports at all, commented or otherwise, so there was no
//     ghost edge to inflate the graph.
//   => The bug was real and live, but INERT for the reachability count today.
//      It was one commented-out import in one of those files away from being a
//      false green. That is why it is fixed and pinned rather than shrugged at.
//
// SCOPE. This drill tests stripJsComments only. Import-edge behaviour of the
// consuming lint is covered by scripts/module-reachability-lint.test.mjs.
//
// EXIT CODES (card IT-38, scripts/run-script-tests.mjs): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips.
//
// Run: `node scripts/strip-js-comments.test.mjs`
//
// ─── REVERSE CONTROL (performed 2026-08-19, restored by hand) ───────────────
// The regex-literal branch in verify/lint/_util.mjs was reverted (the
// `if (c === '/' && regexAllowed())` block deleted from the code/expr context)
// and this drill was re-run. VERBATIM READING:
//
//   === §1 the reported repro — a regex with an odd number of quotes ===
//     FAIL repro: the line comment after the regex is stripped — "const m = badging.match(/versionName='([^']*)'/);\n// callMe(1)\ncallMe(2);"
//   === §2 regex vs division ===
//     FAIL regex literal: following comment is stripped — "const re = /a'b/; // GHOST_ONE\nkeep;"
//     FAIL `return /re/` is a regex, not a division — "function f() { return /a'b/; } // GHOST_RET\nkeep;"
//   === §3 regex containing // and a string containing /* ===
//     FAIL regex with // inside a character class does not start a comment (keeps "/a[//]'b/") — "const re = /a[                      \nkeep;"
//     FAIL escaped \/\/ inside a regex does not start a comment — "const re = /https:\\/\\/'x/; // GHOST_FOUR\nkeep;"
//   === §4 template literals ===
//     FAIL regex inside a ${} hole does not desynchronise — "const t = `${ /a'b/.source }`; // GHOST_EIGHT\nkeep;"
//   === §5 KNOWN LIMITS — pinned so a green run is never read as "parser" ===
//     FAIL KNOWN LIMIT 2: `}` allows a regex, so a same-line comment survives — "const y = {}/2;                  \nkeep;"
//
//   FAILED: 7 check(s) across 5 section(s)
//
// (`ok` lines elided above; the 7 FAIL lines are quoted verbatim.)
//
// TWO THINGS THAT READING TEACHES, both of which contradicted the guess made
// before running it — recorded because the guess is the part worth distrusting:
//   - KNOWN LIMIT 1 stayed GREEN under the revert. It asserts that `)` forces
//     division and the regex desynchronises — which is true both with and
//     without the fix, so that case can never testify that the fix is present.
//   - KNOWN LIMIT 2 went RED under the revert, because that limit is CREATED
//     by the fix: with no regex branch at all, `const y = {}/2; // …` strips
//     correctly. A pinned limit is not always a pre-existing wart; this one is
//     a cost the fix introduces, and the pin is what keeps that cost visible.
// If someone later teaches the stripper real grammar, §5 goes red on purpose
// and the KNOWN LIMITS block in verify/lint/_util.mjs must be updated in the
// same change.

import { stripJsComments } from '../verify/lint/_util.mjs';

let failures = 0;
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

/**
 * Table-driven case runner.
 *
 * `gone`  — substrings that MUST NOT survive stripping (comment bodies).
 * `kept`  — substrings that MUST survive verbatim (real code).
 * Comment bodies are blanked to spaces, so "gone" is an exact absence test.
 */
function runCases(cases) {
  for (const c of cases) {
    const out = stripJsComments(c.src);
    for (const g of c.gone || []) {
      check(`${c.name}`, !out.includes(g), JSON.stringify(out));
    }
    for (const k of c.kept || []) {
      check(`${c.name} (keeps ${JSON.stringify(k)})`, out.includes(k), JSON.stringify(out));
    }
  }
}

// ── §1 the reported repro ───────────────────────────────────────────────────
section('§1 the reported repro — a regex with an odd number of quotes');
{
  // Verbatim shape of scripts/publish-apk-gates.mjs's versionName matcher.
  const repro =
    "const m = badging.match(/versionName='([^']*)'/);\n// callMe(1)\ncallMe(2);";
  const out = stripJsComments(repro);
  check(
    'repro: the line comment after the regex is stripped',
    !out.includes('callMe(1)'),
    JSON.stringify(out),
  );
  check(
    'repro: code after the regex survives verbatim',
    out.includes('callMe(2);') && out.includes("/versionName='([^']*)'/"),
    JSON.stringify(out),
  );
  // The control the bug report used: replacing the regex with `1` always worked.
  const control = 'const m = 1;\n// callMe(1)\ncallMe(2);';
  check(
    'repro control: same source with the regex replaced by `1` strips',
    !stripJsComments(control).includes('callMe(1)'),
    JSON.stringify(stripJsComments(control)),
  );
  check(
    'repro: stripping is now idempotent with the control (both blank the comment)',
    stripJsComments(repro).includes('callMe(2);'),
    JSON.stringify(out),
  );
}

// ── §2 regex vs division ────────────────────────────────────────────────────
section('§2 regex vs division');
runCases([
  {
    name: 'regex literal: following comment is stripped',
    src: "const re = /a'b/; // GHOST_ONE\nkeep;",
    gone: ['GHOST_ONE'],
    kept: ["/a'b/", 'keep;'],
  },
  {
    name: 'division: following comment is stripped',
    src: "const q = total / count; // GHOST_TWO\nconst s = 'x';",
    gone: ['GHOST_TWO'],
    kept: ['total / count', "const s = 'x';"],
  },
  {
    name: 'x++ / y is a division, not a regex',
    // If `+` were read as "regex allowed", the scan would swallow to the next
    // slash and the trailing comment body would survive.
    src: "let z = x++ / y; const w = a / b; // GHOST_PLUS\nkeep;",
    gone: ['GHOST_PLUS'],
    kept: ['x++ / y', 'keep;'],
  },
  {
    name: '`return /re/` is a regex, not a division',
    src: "function f() { return /a'b/; } // GHOST_RET\nkeep;",
    gone: ['GHOST_RET'],
    kept: ["return /a'b/;"],
  },
  {
    name: 'property named `return` is a division, not a regex',
    // Guards the `beforeWord !== '.'` rule: without it the trailing word
    // `return` would be taken for the keyword.
    src: "const v = o.return / 2; const u = c / d; // GHOST_PROP\nkeep;",
    gone: ['GHOST_PROP'],
    kept: ['o.return / 2'],
  },
]);

// ── §3 regex containing //, and a string containing /* ──────────────────────
section('§3 regex containing // and a string containing /*');
runCases([
  {
    name: 'regex with // inside a character class does not start a comment',
    // The odd quote is deliberate: it is what desynchronised the old stripper.
    src: "const re = /a[//]'b/; // GHOST_THREE\nkeep;",
    gone: ['GHOST_THREE'],
    kept: ["/a[//]'b/", 'keep;'],
  },
  {
    name: 'escaped \\/\\/ inside a regex does not start a comment',
    src: "const re = /https:\\/\\/'x/; // GHOST_FOUR\nkeep;",
    gone: ['GHOST_FOUR'],
    kept: ['keep;'],
  },
  {
    name: 'string containing /* does not open a block comment',
    src: "const s = '/*'; // GHOST_FIVE\nkeep;",
    gone: ['GHOST_FIVE'],
    kept: ["'/*'", 'keep;'],
  },
  {
    name: 'string containing // is preserved verbatim',
    src: "const u = 'https://example.com/p'; // GHOST_SIX\nkeep;",
    gone: ['GHOST_SIX'],
    kept: ["'https://example.com/p'", 'keep;'],
  },
]);

// ── §4 template literals ────────────────────────────────────────────────────
section('§4 template literals');
runCases([
  {
    name: 'template literal with ${} holding a quote: comment still stripped',
    src: 'const t = `x${ q["\'"] }y`; // GHOST_SEVEN\nkeep;',
    gone: ['GHOST_SEVEN'],
    kept: ['`x${ q["\'"] }y`', 'keep;'],
  },
  {
    name: '// inside a template literal is NOT treated as a comment',
    src: 'const s = `// keep me`;\nkeep;',
    kept: ['// keep me', 'keep;'],
  },
  {
    name: 'regex inside a ${} hole does not desynchronise',
    src: "const t = `${ /a'b/.source }`; // GHOST_EIGHT\nkeep;",
    gone: ['GHOST_EIGHT'],
    kept: ['keep;'],
  },
]);
{
  const spaced = stripJsComments('a\n// hide\nb\n');
  check(
    'newlines are preserved (line numbers stay stable)',
    spaced.split('\n').length === 4 && !spaced.includes('hide'),
    JSON.stringify(spaced),
  );
}

// ── §5 KNOWN LIMITS ─────────────────────────────────────────────────────────
//
// 🔴 READ THIS BEFORE TRUSTING A GREEN RUN. The cases below assert the
// documented WRONG behaviour of the stripper. They exist so that nobody reads
// this file's green as "stripJsComments understands JavaScript" — it does not,
// it is a one-character-lookback heuristic. The full rule and the full limit
// list live in the header block of verify/lint/_util.mjs; if you improve the
// stripper these cases go red ON PURPOSE and both places must be updated
// together.
section('§5 KNOWN LIMITS — pinned so a green run is never read as "parser"');
{
  // LIMIT 1: `)` is always treated as division, so a regex in statement
  // position after `if (…)` is scanned as code — and this one carries an odd
  // quote, so it desynchronises exactly like the original bug did.
  const limit1 = "if (ok) /a'b/.test(x); // STILL_HERE_BY_DESIGN\nkeep;";
  check(
    'KNOWN LIMIT 1: `)` forces division, so this regex desynchronises',
    stripJsComments(limit1).includes('STILL_HERE_BY_DESIGN'),
    JSON.stringify(stripJsComments(limit1)),
  );

  // LIMIT 2: `}` always allows a regex. Here `{}/2` is a division, but the
  // scan treats the slash as a regex opener and closes on the first slash of
  // the following `//`, leaving the comment body standing.
  const limit2 = 'const y = {}/2; // STILL_HERE_TOO\nkeep;';
  check(
    'KNOWN LIMIT 2: `}` allows a regex, so a same-line comment survives',
    stripJsComments(limit2).includes('STILL_HERE_TOO'),
    JSON.stringify(stripJsComments(limit2)),
  );

  // The bound on both limits: a candidate that does not close before the end
  // of the line is abandoned, so a wrong guess can never eat a whole file.
  const healed = 'const y = {}/2;\n// GONE_NEXT_LINE\nkeep;';
  check(
    'KNOWN LIMIT: an unterminated candidate self-heals within one line',
    !stripJsComments(healed).includes('GONE_NEXT_LINE'),
    JSON.stringify(stripJsComments(healed)),
  );
}

process.stdout.write(
  failures === 0
    ? `\nPASS: all checks across ${sectionsRun} section(s)\n`
    : `\nFAILED: ${failures} check(s) across ${sectionsRun} section(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);

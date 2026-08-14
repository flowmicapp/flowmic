// Drill for verify/lint/no-lan-ip.mjs (card OSS-DEFAULTS follow-up, W5O).
//
// WHY THIS EXISTS. That lint is the gate standing between「someone hardcodes an
// address again」and a public release, and it had NO TEST — `scanText` was
// exported with zero consumers. The repo has the precedent verbatim:
// scripts/coordinate-anchors-lint.test.mjs was written because that door was
// "the only gate with no test of its own". Same argument, one door over.
//
// 🔴 THE POINT IS THE CLASSIFIER, NOT THE COUNT. A miscount here does not fail
// loudly; it fails as a WAIVER THAT LOOKS LIKE A CENSUS. The lint's own header
// records the first draft doing exactly that: it read six live endpoint literals
// as documentation (`0 code / 8 comments`) because a URL scheme contains `//`,
// and would have waived, in perpetuity, precisely the lines it exists to count.
// Every fixture below is a shape that produced, or could produce, that outcome.
//
// SAFETY: pure functions over in-memory strings. Nothing is written, no file in
// the tree is edited, nothing is walked. The module is import-pure (it exports;
// `run()` is only called where this file says so).
//
// EXIT CODES (card IT-38, scripts/run-script-tests.mjs): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips.
//
// Run: `node scripts/ossdef-no-lan-ip-lint.test.mjs`

import { RANGES, scanText, auditFile, WAIVERS } from '../verify/lint/no-lan-ip.mjs';

let failures = 0;
const TOTAL_SECTIONS = 5;
let sectionsRun = 0;

function section(title) {
  sectionsRun++;
  process.stdout.write(`${title}\n`);
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
 * scanText on a one-line .ts file, since most fixtures are one line.
 *
 * 🔴 BARE BASENAMES, NO DIRECTORIES, AND THAT IS DELIBERATE. `scanText` echoes
 * the path back inside its `samples` as `<path>:<line>` — and a
 * `<dir>/<file>.<ext>` followed by a colon and a line number is exactly what
 * `verify/lint/coordinate-anchors.mjs` treats as a coordinate reference to check.
 * Fixture paths under `apps/…` therefore MINTED TWO FAKE ANCHORS pointing at
 * files that do not exist, and that lint failed with 2 new rotted refs — measured,
 * not predicted, on the first run of this file. (The first version of THIS
 * comment then re-minted one by spelling such a path out, which is why it now
 * describes the shape instead of writing one.) A test fixture must not look like
 * a claim about the tree. Only the extension matters to `scanText`, so dropping
 * the directories costs the fixtures nothing.
 */
function scan(line, relPath = 'fixture.ts') {
  return scanText(relPath, line);
}

// ── §1 the `://` trap — the bug that actually happened ──────────────────────
section('§1 the :// trap');
{
  // A URL scheme contains `//`. A naive comment detector reads this whole line
  // as documentation and waives a live endpoint forever.
  const live = "  { id: 'lan-funasr-ws', endpoint: 'ws://100.64.7.68:10095' },";
  const r = scan(live);
  check('a live endpoint literal counts as CODE, not a comment', r.code === 1 && r.comments === 0, JSON.stringify(r));
  check('…and the sample names the file and line', r.samples[0]?.startsWith('fixture.ts:1') === true, r.samples[0]);

  // The same line with a REAL trailing comment: the hit is left of the comment
  // opener, so it is still code. This is the half that a "skip all // " fix
  // would break, which is why the detector skips only a `//` preceded by `:`.
  const both = "  const e = 'http://100.64.7.68:8200'; // the FunASR box";
  const r2 = scan(both);
  check('a code hit LEFT of a real trailing comment stays code', r2.code === 1 && r2.comments === 0, JSON.stringify(r2));

  // …and a hit RIGHT of the comment opener is documentation.
  const after = "  const e = getEndpoint(); // was 100.64.7.68 before the card";
  const r3 = scan(after);
  check('a hit RIGHT of the comment opener is a comment', r3.code === 0 && r3.comments === 1, JSON.stringify(r3));
}

// ── §2 comment leaders ──────────────────────────────────────────────────────
section('§2 comment leaders');
{
  // The continuation `*` of a block comment. Every long comment in this tree is
  // written this way, so getting it wrong would misclassify most of the debt.
  const star = ' * The VPS reaches the same box at 10.0.0.68 over the VPN.';
  const rs = scan(star);
  check('a `*` block-comment continuation line is a comment', rs.code === 0 && rs.comments === 1, JSON.stringify(rs));

  for (const [label, line] of [
    ['`//` leader', '// see 100.64.7.68'],
    ['`#` leader (dart/py/sh)', '# host: 100.64.7.68'],
    ['indented `///` doc comment', '   /// dials 100.64.7.68'],
  ]) {
    const r = scan(line);
    check(`${label} is a comment`, r.code === 0 && r.comments === 1, JSON.stringify(r));
  }

  // 🔴 THE FAIL-LOUD DIRECTION. A hit that is not PROVABLY in a comment must
  // count as code: a wrong guess has to land on the side that fails the gate,
  // not the side that waives silently.
  const ambiguous = "  const host = '100.64.7.68';";
  const ra = scan(ambiguous);
  check('an unmarked line counts as CODE (wrong guesses fail loud)', ra.code === 1, JSON.stringify(ra));
}

// ── §3 both ranges, and counting ────────────────────────────────────────────
section('§3 ranges and counting');
{
  check('exactly two ranges are declared', RANGES.length === 2, JSON.stringify(RANGES));

  // Two hits on ONE line: the scanner advances by range.length, so a line with
  // two addresses must report two, not one.
  const two = "  const pair = ['100.64.7.68', '100.64.7.179'];";
  const r = scan(two);
  check('two hits on one line count as two', r.code === 2, JSON.stringify(r));

  const mixed = "  const a = '100.64.7.68'; const b = '10.0.0.68';";
  const rm = scan(mixed);
  check('both ranges are counted independently', rm.code === 2, JSON.stringify(rm));

  // 🔴 The negative half. The lint is deliberately NOT a generic "private IP"
  // rule: these appear all over the tree as documentation and as legitimate
  // runtime values, and a rule that fired on them would be off within a week.
  // ⚠️ 10.1.2.3, NOT 10.0.0.x/10.7.7.x (card OSSDEF-C1): this test ships publicly,
  // where REDACTIONS rewrite the two ranges into exactly those 10.x replacement
  // segments, so an "innocent" sample in one of them would be a real hit on a
  // public checkout and fail here — the defect this relocation closes.
  const innocent = "  const h = 'http://127.0.0.1:41879'; // or 192.168.1.5 or 10.1.2.3";
  const ri = scan(innocent);
  check('legitimate private addresses are NOT flagged', ri.code === 0 && ri.comments === 0, JSON.stringify(ri));
}

// ── §4 the Rust `#[cfg(test)]` truncation ───────────────────────────────────
section('§4 #[cfg(test)] truncation');
{
  const rust = [
    'fn dial() -> &str { "shipped" }',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    const BOX: &str = "100.64.7.68";',
    '}',
  ].join('\n');

  const r = scan(rust, 'fixture.rs');
  check('a hit AFTER #[cfg(test)] is not counted (not in the shipped binary)', r.code === 0 && r.comments === 0, JSON.stringify(r));

  // Positive control: the SAME text before the marker is still counted, so the
  // assertion above is measuring the truncation and not a scanner that went blind.
  const rustLive = 'const BOX: &str = "100.64.7.68";\n#[cfg(test)]\nmod tests { const X: &str = "100.64.7.179"; }';
  const rl = scan(rustLive, 'fixture.rs');
  check('…while a hit BEFORE the marker is still counted', rl.code === 1, JSON.stringify(rl));

  // 🔴 The truncation is `.rs`-ONLY. The identical text in a .ts file must be
  // counted in full — otherwise the string "#[cfg(test)]" in any language would
  // become a way to hide an address from this gate.
  const asTs = scan(rustLive, 'fixture.ts');
  check('the truncation applies to .rs only — a .ts file is scanned whole', asTs.code === 2, JSON.stringify(asTs));
}

// ── §5 the declaration verdict (undeclared / drifted / exact) ───────────────
section('§5 declaration verdict');
{
  const found = { code: 1, comments: 2, samples: ['fixture.ts:9 100.64.7.'] };

  // An unlisted file with ANY hit fails outright — the branch this gate exists
  // for, and the one `run()` cannot be made to take with fixtures.
  const undeclared = auditFile('fixture.ts', found, undefined);
  check('an UNDECLARED file with hits produces a finding', typeof undeclared === 'string');
  check('…and the finding says NOT DECLARED', undeclared?.includes('NOT DECLARED') === true, undeclared);
  check('…and it names a sample so the reader can go look', undeclared?.includes('100.64.7.') === true, undeclared);

  // Exact match in BOTH columns ⇒ silence.
  check('an exactly-declared file produces NO finding', auditFile('a.ts', found, { file: 'a.ts', code: 1, comments: 2 }) === null);

  // More hits than declared ⇒ new debt, the thing the gate is for.
  const more = auditFile('a.ts', found, { file: 'a.ts', code: 0, comments: 2 });
  check('MORE code hits than declared is a finding', typeof more === 'string', String(more));
  check('…and it reports declared vs found', more?.includes('declared 0 code / 2 comment, found 1 / 2') === true, more);

  // 🔴 FEWER hits than declared ⇒ ALSO a finding. A stale waiver reads as
  // evidence that somebody checked, which is worse than an undeclared file.
  // This is the direction the whole-address redaction broke in the exported
  // tree, so it is pinned here rather than left to the header prose.
  const fewer = auditFile('a.ts', { code: 0, comments: 0, samples: [] }, { file: 'a.ts', code: 0, comments: 5 });
  check('FEWER hits than declared is a finding (stale waiver)', typeof fewer === 'string', String(fewer));

  // A comment-count drift alone is a finding too: the two columns are separate
  // debts and are declared separately.
  const commentDrift = auditFile('a.ts', found, { file: 'a.ts', code: 1, comments: 9 });
  check('a comment-only drift is a finding', typeof commentDrift === 'string', String(commentDrift));

  // The shipped table must have no duplicate rows — two entries for one file
  // would make `byFile` silently drop one, and its debt would go uncounted.
  const files = WAIVERS.map((w) => w.file);
  check('no duplicate file in WAIVERS', new Set(files).size === files.length, `${files.length} entries`);
}

console.log(
  `\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s), ` +
    `${WAIVERS.length} waiver row(s) declared`,
);

process.stdout.write(
  failures === 0
    ? '\nOK — no-lan-ip lint drill: all sections passed\n'
    : `\nFAILED — ${failures} check(s) red\n`,
);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
// Drill for verify/lint/outward-voice.mjs — the gate behind owner rulings D3
// and D7 (2026-09-01) on outward copy.
//
// WHY A DRILL AND NOT JUST THE LINT: on the day this gate landed, the copy it
// was built to catch had already been rewritten. A lint that is green because
// the tree happens to be clean proves the tree, not the gate. So the judgement
// lives in exported pure functions (the three maskers plus the term matcher)
// and this file feeds them the sentences that were really on README.md before
// the rewrite. If the gate ever stops catching one, §2 goes red here rather
// than on the day somebody ships a landing page written in the internal
// register again.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import outwardVoice, {
  maskMarkdown,
  maskTs,
  maskDart,
  termRegex,
  isIdentifierLiteral,
} from '../verify/lint/outward-voice.mjs';
import { BANNED, META_PATTERNS, CONTROL_STRING } from '../verify/lint/outward-voice-terms.mjs';
import { KNOWN_HITS } from '../verify/lint/outward-voice-baseline.mjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let sections = 0;
const ok = (name) => console.log(`  ok  ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

const banned = (surface, text) =>
  BANNED.filter((e) => e.surfaces.includes(surface)).some((e) => termRegex(e).test(text));
const meta = (text) => META_PATTERNS.some((p) => new RegExp(p.re.source, p.re.flags).test(text));

console.log('=== §1 the maskers keep copy and drop everything else ===');
sections += 1;
{
  const md = [
    'Real prose mentions golden paths.',
    '',
    '<!-- a golden path in an HTML comment -->',
    '',
    '```bash',
    'pnpm verify:delivery',
    '```',
    '',
    'Inline `pnpm verify:delivery` and a [link](https://example.com/golden-path).',
  ].join('\n');
  const masked = maskMarkdown(md);
  check(masked.length === md.length, 'markdown masking preserves offsets, so line numbers stay true');
  check(/golden paths/.test(masked), 'prose survives the mask (positive control)');
  check(!/HTML comment/.test(masked), 'an HTML comment is not copy');
  check(!/verify:delivery/.test(masked), 'a fenced command block is a literal to type, not our voice');
  check(!/golden-path/.test(masked), 'a link target is not copy');

  const ts = [
    "// a comment saying golden path",
    "export const C = { key_with_probe_in_it: 'Start check', note: 'This is a probe' };",
  ].join('\n');
  const mts = maskTs(ts);
  check(mts.length === ts.length, 'TS masking preserves offsets');
  check(!/golden path/.test(mts), 'a TS comment is not copy');
  check(!/key_with_probe_in_it/.test(mts), 'an object KEY is an identifier, not copy');
  check(/This is a probe/.test(mts), 'the string VALUE survives (positive control)');

  const dart = [
    "/// a doc comment about a probe",
    "/* nested /* block */ still a comment about a probe */",
    "const a = 'Start check';",
    "const b = '''a triple-quoted probe''';",
    "const c = r'a raw probe';",
    "const d = 'LLM_PROBE_FAIL';",
  ].join('\n');
  const mdart = maskDart(dart);
  check(mdart.length === dart.length, 'Dart masking preserves offsets');
  check(!/doc comment/.test(mdart), 'a Dart doc comment is not copy');
  check(!/still a comment/.test(mdart), 'a NESTED Dart block comment closes where Dart says it does');
  check(/triple-quoted probe/.test(mdart), "a ''' string is copy (this is where a JS scanner desynchronises)");
  check(/a raw probe/.test(mdart), 'a raw string is copy');
  check(!/LLM_PROBE_FAIL/.test(mdart), 'a SCREAMING_SNAKE literal is a protocol identifier, not copy');
  check(
    isIdentifierLiteral('LLM_PROBE_FAIL') && !isIdentifierLiteral('Start probe') && !isIdentifierLiteral('OK'),
    'the identifier test needs an underscore or a digit run, so a shouted two-letter word is still copy'
  );
}

console.log('=== §2 REVERSE CONTROL: the ten sentences the owner rejected must be caught ===');
sections += 1;
{
  // Verbatim from README.md as it stood on 2026-09-01, before the rewrite.
  const rejected = [
    ['we would rather show you a blank than a 404', 'meta'],
    ["counts drift; the runner's own output is the truth", 'meta'],
    ['if that file and this table ever disagree, the file is right', 'meta'],
    ['and this table is stale', 'meta'],
    ['One thing that is not true yet, stated plainly because you would', 'meta'],
    ['We would rather name an open gap than imply it is shut.', 'meta'],
    ['the language probe and the Mandarin bake-off', 'term'],
    ['the end-to-end golden paths, run against a real server', 'term'],
    ['Decision log. Why the obvious refactor is usually wrong', 'term'],
    ['| English | correct | to be evaluated | correct |', 'meta'],
  ];
  for (const [sentence, kind] of rejected) {
    const caught = kind === 'meta' ? meta(sentence) : banned('readme', sentence);
    check(caught, `caught (${kind}): ${sentence.slice(0, 52)}`);
  }
  check(
    banned('readme', 'the median CER was 1.1 %'),
    'CER is caught as an acronym the reader has to look up'
  );
  check(
    !banned('readme', 'the certificate is renewed automatically'),
    'REVERSE OF THE REVERSE: case-sensitive CER does not fire on "certificate"'
  );
  check(
    banned('app', 'Not probed') && banned('app', 'Start probe'),
    'inflections are caught: the first version of this gate missed "Not probed" and "golden paths"'
  );
  check(
    !meta('If you would rather not sign, open an issue'),
    'REVERSE OF THE REVERSE: "you would rather" addresses the reader and is not a meta-statement'
  );
}

console.log('=== §3 routing: contributor documents are exempt from VOCABULARY only ===');
sections += 1;
{
  check(banned('readme', 'run pnpm verify:delivery'), 'verify: is a dirty word on the visitor surface');
  check(
    BANNED.every((e) => !e.surfaces.includes('contrib')),
    'no term is routed to the contributor surface at all (amendment M2)'
  );
  check(
    meta('we would rather not say'),
    'meta-statements are NOT surface-routed: a contributor is owed plain prose too'
  );
  check(
    !banned('readme', 'the desktop app spawns it as a local sidecar'),
    'sidecar is accurate in an architecture diagram and is not banned on readme (M2 uses this exact word)'
  );
  check(banned('app', 'the sidecar is starting'), 'and it IS jargon in an app string');
}

console.log('=== §4 the pins and the waivers cannot outlive what they cover ===');
sections += 1;
{
  // 🔴 THIS DRILL MUST NOT REQUIRE A NON-EMPTY REGISTER, and the first version of
  // it did. It asserted `KNOWN_HITS.length > 0` "so the drill is not vacuous",
  // which was true on the branch that wrote it — card 4 had not landed yet and
  // six "probe" values were pinned. Card 4 then replaced those six values, the
  // pin went stale, the register emptied, and the assertion went red against the
  // SUCCESS STATE the register's own header describes. That is this repository's
  // recorded worst case for a control: it does not miss a defect, it writes one
  // into the acceptance criteria and then fails the day the fix arrives.
  //
  // What actually has to be proved is that the pin MACHINERY rejects a malformed
  // pin. A fixture proves that whether or not anything is pinned today.
  const FIXTURE_PINS = [
    { term: 'probe', surface: 'app', count: 6, ruling: 'D6 2026-09-01', owner: 'owner', why: 'x' },
    { term: 'probe', surface: 'app', count: 0, ruling: 'D6 2026-09-01', owner: 'owner', why: 'x' },
    { term: 'probe', surface: 'app', count: 6, ruling: '', owner: 'owner', why: 'x' },
  ];
  const wellFormed = (k) => Boolean(k.ruling && k.owner && k.count > 0);
  check(
    wellFormed(FIXTURE_PINS[0]) && !wellFormed(FIXTURE_PINS[1]) && !wellFormed(FIXTURE_PINS[2]),
    'a pin without a ruling, an owner and a non-zero count is rejected (fixture, so this holds with an empty register)'
  );
  check(
    KNOWN_HITS.every(wellFormed),
    'every pin in the live register names a ruling, an owner, and an exact count — vacuously true while nothing is pinned, which is the register header stated success state'
  );
  const forensic = BANNED.find((e) => e.term === 'forensic');
  check(
    (forensic.allow || []).length === 1 && /window-forensics/.test(forensic.allow[0].re.source),
    'the one waiver in the term list is the file name a user has to find on disk'
  );
  check(
    banned('app', 'see the forensic log') && !banned('contrib', 'see the forensic log'),
    'the waiver does not disable the term itself'
  );
  check(
    forensic.surfaces.some((s) => ['readme', 'app'].includes(s)),
    'that waiver sits on a term this repository can actually scan — a waiver on a '
      + 'site-only or console-only term would be unexercisable here, and the gate '
      + 'must not report it stale (see the staleness loop)'
  );
}

console.log('=== §5 the gate runs on this tree and answers ===');
sections += 1;
{
  const res = await outwardVoice();
  check(['PASS', 'FAIL', 'SKIP'].includes(res.status), 'gate returned a known status', res.status);
  check(typeof res.detail === 'string' && res.detail.length > 0, 'gate returned a human-readable detail');
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
  check(
    !res.detail.includes('routing matched 0 tracked files'),
    'the routing found the outward surfaces (check your ruler first)',
    res.detail
  );
  check(
    !res.detail.startsWith('blind scan'),
    'the blind-scan control found the control string, so a zero would have meant something',
    res.detail
  );
}

console.log('=== §6 the gate is wired, and its header says what it does not decide ===');
sections += 1;
{
  const runAll = await readFile(join(ROOT, 'verify/lint/run-all.mjs'), 'utf8');
  check(/from '\.\/outward-voice\.mjs'/.test(runAll), "run-all.mjs imports the gate");
  check(/name: 'outward-voice'/.test(runAll), 'run-all.mjs registers it in the LINTS table');
  const src = await readFile(join(ROOT, 'verify/lint/outward-voice.mjs'), 'utf8');
  check(
    /DOES \*NOT\* DECIDE/.test(src),
    'the file header states what the gate cannot decide (amendment M4), the way worktree-location does'
  );
  check(
    src.includes('opposite actions'),
    'the blind-scan branch says the two verdicts call for opposite actions'
  );
  check(CONTROL_STRING.length > 0, 'a control string is declared');
}

console.log(`ACCOUNTING: sections run ${sections}/6, ${failures} assertion failure(s)`);
console.log(
  `\n${failures === 0 ? '✔' : '✗'} outward-voice — sections run ${sections}/6, ` +
    `${failures} assertion failure(s), ${BANNED.length} term(s), ${META_PATTERNS.length} meta pattern(s)`
);
process.exit(failures === 0 ? 0 : 1);

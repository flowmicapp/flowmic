#!/usr/bin/env node
// Drill for verify/lint/i18n-error-keys.mjs — the gate that keeps every
// protocol error code bilingual (zh_CN + en). Until this file existed it had
// no fixture test, despite the gate's own header documenting a real incident
// where its OWN regex was too strict (single-quote only) and cried wolf on a
// valid double-quoted `en` message.
//
// No refactor was needed: `parseErrorCodes(src)` and `validate(src)` already
// take a source-text string directly, so every case here is driven against
// synthetic ERROR_CODES literals, never the real
// packages/protocol/src/error-codes.ts.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { parseErrorCodes, validate, validateFile } from '../verify/lint/i18n-error-keys.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const wrap = (body) => `export const ERROR_CODES = {\n${body}\n} as const;\n`;

console.log('=== §1 negative control: a fully bilingual registry PASSes ===');
{
  const src = wrap(`  FOO_BAR: { zh_CN: '中文', en: 'English' },`);
  const res = validate(src);
  check(res.status === 'PASS', 'a complete bilingual code passes', JSON.stringify(res));
  check(res.detail.includes('1 codes'), 'the PASS detail names the parsed count', res.detail);
}

console.log('=== §2 REVERSE CONTROL: a code missing `en` FAILs (positive control) ===');
{
  const src = wrap(`  FOO_BAR: { zh_CN: '中文' },`);
  const res = validate(src);
  check(res.status === 'FAIL', 'a code missing en fails', JSON.stringify(res));
  check(res.detail.includes('FOO_BAR') && res.detail.includes('en'), 'the FAIL detail names the code and the missing language', res.detail);
}

console.log('=== §3 a code missing `zh_CN` FAILs the same way ===');
{
  const src = wrap(`  FOO_BAR: { en: 'English only' },`);
  const res = validate(src);
  check(res.status === 'FAIL', 'a code missing zh_CN fails', JSON.stringify(res));
  check(res.detail.includes('zh_CN'), 'the FAIL detail names the missing language', res.detail);
}

console.log('=== §4 an empty-string message counts as missing, not merely present ===');
{
  const src = wrap(`  FOO_BAR: { zh_CN: '', en: 'English' },`);
  const res = validate(src);
  check(res.status === 'FAIL', 'an empty zh_CN string fails, not just an absent key', JSON.stringify(res));
}

console.log('=== §5 REGRESSION PIN (the incident this gate\'s own header documents): double-quoted messages are accepted ===');
{
  // "The AI's answer ..." — the apostrophe is exactly why this message would
  // naturally be written with double quotes, and the original single-quote-only
  // regex reported it as `missing en` despite it being present and complete.
  const src = wrap(`  AI_ANSWER: { zh_CN: "中文回答", en: "The AI's answer was rejected" },`);
  const res = validate(src);
  check(res.status === 'PASS', 'a double-quoted en message containing an apostrophe is recognised', JSON.stringify(res));
}

console.log('=== §6 negative control: escaped quotes inside a message do not break the parser ===');
{
  const src = wrap(`  ESCAPED: { zh_CN: 'has \\'escaped\\' quotes', en: "has \\"escaped\\" quotes" },`);
  const res = validate(src);
  check(res.status === 'PASS', 'escaped quotes inside either quote style still parse', JSON.stringify(res));
}

console.log('=== §7 parser-drift guard: 0 parsed entries FAILs rather than vacuously passing ===');
{
  const res = validate('export const NOT_ERROR_CODES = { X: 1 } as const;\n');
  check(res.status === 'FAIL', 'source with no ERROR_CODES block reports FAIL', JSON.stringify(res));
  check(res.detail.includes('not found') || res.detail.includes('0 error codes'), 'the FAIL detail explains why nothing parsed', res.detail);
}

console.log('=== §8 multiple codes: one bad entry among several good ones is still caught ===');
{
  const src = wrap([
    `  A: { zh_CN: 'a', en: 'a' },`,
    `  B: { zh_CN: 'b' },`,
    `  C: { zh_CN: 'c', en: 'c' },`,
  ].join('\n'));
  const res = validate(src);
  check(res.status === 'FAIL', 'one incomplete entry among clean ones still fails the whole gate', JSON.stringify(res));
  check(res.detail.includes('1/3') && res.detail.includes('B('), 'the FAIL detail names the count and the specific offender', res.detail);
}

console.log('=== §9 validateFile: a nonexistent path FAILs with a readable reason, not a thrown exception ===');
{
  const res = await validateFile('Z:/definitely/not/a/real/path/error-codes.ts');
  check(res.status === 'FAIL', 'a missing file reports FAIL rather than throwing', JSON.stringify(res));
}

console.log('=== §10 the lint itself runs on the real registry and answers ===');
{
  const mod = await import('../verify/lint/i18n-error-keys.mjs');
  const res = await mod.default();
  check(res.status === 'PASS', 'the real registry is fully bilingual', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} i18n-error-keys drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);

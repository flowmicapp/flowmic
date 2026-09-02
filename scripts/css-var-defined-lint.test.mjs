#!/usr/bin/env node
// Drill for verify/lint/css-var-defined.mjs — the gate born from a real shipped
// defect (0.2.39's TimelineStats.vue/TimelineClear.vue referenced FOUR CSS
// custom properties that were never declared anywhere; CSS does not error on
// this, it silently falls back to the initial value, and the on-screen result
// was two blank strips including the "clear is irreversible" warning). Until
// this file existed the gate that exists specifically to catch that class of
// defect had never itself been drilled.
//
// `collectVars(raw)` and `stripComments(text)` were extracted/exported on
// 2026-09-02 (B2-A): pure functions over one file's text, no filesystem
// access needed. The header's own claims about comment-stripping — a `var()`
// mentioned in prose is not a use, order (line-comments before block
// comments) is load-bearing — are drilled directly.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { collectVars, stripComments } from '../verify/lint/css-var-defined.mjs';
import cssVarDefined from '../verify/lint/css-var-defined.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

console.log('=== §1 collectVars: a declared, then used, custom property round-trips (negative control) ===');
{
  const { defined, uses } = collectVars(':root { --brand: #123456; }\n.card { background: var(--brand); }\n');
  check(defined.has('--brand'), '--brand is recorded as defined', JSON.stringify([...defined]));
  check(uses.length === 1 && uses[0].varName === '--brand', 'the one use is recorded', JSON.stringify(uses));
}

console.log('=== §2 REGRESSION PIN (the real 0.2.39 defect): a use with no matching declaration ANYWHERE is a miss ===');
{
  const { defined, uses } = collectVars('.card { background: var(--s2); border-left: 3px solid var(--danger); }\n');
  check(defined.size === 0, 'nothing is declared in this file', JSON.stringify([...defined]));
  check(uses.length === 2, 'both dead references are recorded as uses', JSON.stringify(uses));
  const missing = uses.filter((u) => !defined.has(u.varName));
  check(missing.length === 2, 'both --s2 and --danger are undefined-use candidates (this is exactly the shipped defect)', JSON.stringify(missing));
}

console.log('=== §3 a fallback chain var(--a, var(--b)) registers BOTH names as uses ===');
{
  const { uses } = collectVars('.x { color: var(--a, var(--b)); }\n');
  check(uses.some((u) => u.varName === '--a') && uses.some((u) => u.varName === '--b'), 'both the primary and the fallback name are uses — a dead fallback is still a dead reference', JSON.stringify(uses));
}

console.log('=== §4 REGRESSION PIN: a var() name mentioned only in prose (a `//` comment) is NOT a use ===');
{
  // The lint's own header: its first run failed on the comment explaining it,
  // which named the dead variable it had just retired.
  const { uses } = collectVars('// retired var(--old-token), do not reintroduce\n.x { color: red; }\n');
  check(uses.length === 0, 'a var() mentioned only in a line comment produces zero uses', JSON.stringify(uses));
}

console.log('=== §5 a var() name mentioned only in a /* block comment */ is NOT a use ===');
{
  const { uses } = collectVars('/* legacy: used to be var(--old-block-token) */\n.x { color: red; }\n');
  check(uses.length === 0, 'a var() mentioned only in a block comment produces zero uses', JSON.stringify(uses));
}

console.log('=== §6 REGRESSION PIN: order matters — a `/*` inside a `//` line must not swallow real code ===');
{
  // Mirrors the measured 45%-of-file-deleted incident this lint's header
  // documents for a sibling stripper: doing block-comment stripping BEFORE
  // line-comment stripping lets a `/*`-shaped substring inside a `//` line
  // open a comment that swallows real code up to the next unrelated `*/`.
  const text = '// header: this file lists routes under /api/ops/* — internal only\n.real { color: var(--kept); }\n*/ .never-reached { color: var(--ghost); }\n';
  const { uses } = collectVars(text);
  check(uses.some((u) => u.varName === '--kept'), 'the real declaration after the comment survives stripping', JSON.stringify(uses));
}

console.log('=== §7 a trailing `//` after real code is NOT stripped (documented limit, pinned as behaviour) ===');
{
  // The lint's own header states this is a DELIBERATE limit, not a bug: a
  // trailing comment stripper would also eat the `//` in an https URL. Pinned
  // here so a change to this behaviour is visible rather than silent.
  const { uses } = collectVars('.x { background: url(https://example.test/x) var(--kept-anyway); }\n');
  check(uses.some((u) => u.varName === '--kept-anyway'), 'code containing "//" as part of a URL is not corrupted by the stripper', JSON.stringify(uses));
}

console.log('=== §8 stripComments: line numbers are preserved (comments become blank, not deleted) ===');
{
  const stripped = stripComments('line1\n// a whole comment line\nline3\n');
  const lines = stripped.split('\n');
  check(lines.length === 4 && lines[1] === '' && lines[2] === 'line3', 'the comment line (index 1) becomes empty but stays a line, keeping line numbers stable', JSON.stringify(lines));
}

console.log('=== §9 the lint itself runs on the real desktop tree and answers ===');
{
  const res = await cssVarDefined();
  check(res.status === 'PASS', 'every var() use in the real desktop tree resolves', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} css-var-defined drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);

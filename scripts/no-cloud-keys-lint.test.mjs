#!/usr/bin/env node
// Drill for verify/lint/no-cloud-keys.mjs — the hard security gate that keeps
// real cloud API keys out of the repo. Until this file existed it had no
// fixture test: `scanText` was already exported for exactly this purpose, but
// nothing called it, so a broken fingerprint regex would have passed silently
// forever (AUD-W's finding: ~22 of 35 verify/lint rules had no such test).
//
// Two things are drilled: `scanText(text)` against synthetic (non-real)
// canary strings shaped like every vendor fingerprint, and `run(root)` — which
// gained an explicit `root` parameter and a zero-file guard on 2026-09-02
// (B2-A) specifically so a "the walk found nothing" misconfiguration reports
// FAIL instead of a "0 file(s) scanned, no cloud keys" false PASS.
//
// Canary strings below are SHAPE-ONLY: they match each vendor's regex but are
// not, and were never, real credentials (this file's own comment says so, so
// a future no-cloud-keys pass over scripts/ that reads this file's source
// does not mistake the comment for a real leak — the regexes only match the
// STRING literals below, and this sentence is prose, not one of them).
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanText } from '../verify/lint/no-cloud-keys.mjs';
import noCloudKeys from '../verify/lint/no-cloud-keys.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

// Assembled from parts so this file's own source never contains a literal
// that LOOKS like a complete key of realistic length sitting in a string —
// each canary is built at runtime, one concat per fingerprint family.
const CANARIES = {
  'openai': 'sk-' + 'A'.repeat(24),
  // split across the '+' (and never written whole, even in this comment) so
  // the vendor anchor never sits contiguously in THIS file's own source
  // (no-cloud-keys scans scripts/ too, and that fingerprint has no length
  // requirement after the anchor — it would self-match if written whole)
  'anthropic': 'sk-' + 'ant-' + '1'.repeat(20),
  'aws-akia': 'AKIA' + '0123456789ABCDEF'.slice(0, 16),
  'google-api': 'AIza' + 'B'.repeat(35),
  'github-token': 'ghp_' + 'c'.repeat(36),
  'github-fine-grained': 'github_pat_' + 'd'.repeat(40),
  'cliproxy-copy-audit': 'cpa_' + '0123456789abcdef'.repeat(2),
  'aliyun': 'LTAI' + 'e'.repeat(14),
  'tencent': 'AKID' + 'F'.repeat(32),
  'azure-connstr': 'AccountKey=' + 'g'.repeat(44) + '==',
};

console.log('=== §1 scanText: every fingerprint family is caught (positive control, one per vendor) ===');
for (const [vendor, canary] of Object.entries(CANARIES)) {
  const hits = scanText(`const x = "${canary}"; // not a real credential`);
  check(hits.some((h) => h.vendor === vendor), `${vendor} canary is caught`, JSON.stringify(hits));
}

console.log('=== §2 negative control: ordinary source text with no key shape produces zero hits ===');
{
  const hits = scanText('export const GREETING = "hello world"; function add(a,b){return a+b;}\n'.repeat(3));
  check(hits.length === 0, 'clean text has zero hits', JSON.stringify(hits));
}

console.log('=== §3 scanText reports the correct 1-based line number ===');
{
  const text = 'line one\nline two\nconst k = "' + CANARIES['anthropic'] + '";\nline four\n';
  const hits = scanText(text);
  const hit = hits.find((h) => h.vendor === 'anthropic');
  check(hit?.line === 3, 'the anthropic canary on line 3 is reported at line 3', JSON.stringify(hit));
}

console.log('=== §4 scanText masks the sample instead of echoing the full key ===');
{
  const hits = scanText(`token = "${CANARIES['github-fine-grained']}"`);
  const hit = hits.find((h) => h.vendor === 'github-fine-grained');
  check(!!hit && !hit.sample.includes(CANARIES['github-fine-grained']), 'the reported sample never contains the full matched string', hit?.sample);
}

console.log('=== §5 run(root): a fixture tree with a planted canary FAILs (positive control) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmnck-dirty-'));
  writeFileSync(join(T, 'leaked.txt'), `API_KEY=${CANARIES['aws-akia']}\n`, 'utf8');
  const res = await noCloudKeys(T);
  check(res.status === 'FAIL', 'a fixture tree with a real-shaped canary fails', JSON.stringify(res));
  check(res.detail.includes('aws-akia'), 'the FAIL detail names the vendor', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §6 run(root): a clean fixture tree PASSes (negative control) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmnck-clean-'));
  mkdirSync(join(T, 'src'), { recursive: true });
  writeFileSync(join(T, 'src', 'index.ts'), 'export const hello = () => "world";\n', 'utf8');
  const res = await noCloudKeys(T);
  check(res.status === 'PASS', 'a clean fixture tree passes', JSON.stringify(res));
  check(res.detail.includes('1 file'), 'the PASS detail names the file count scanned', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §7 REVERSE CONTROL: run(root) against a tree with ZERO files must FAIL, not PASS blind ===');
{
  // Before the 2026-09-02 zero-file guard, this exact scenario returned
  // { status: 'PASS', detail: '0 file(s) scanned, no cloud keys' } — a sentence
  // that reads exactly like a real clean scan while having verified nothing.
  const T = mkdtempSync(join(tmpdir(), 'fmnck-empty-'));
  const res = await noCloudKeys(T);
  check(res.status === 'FAIL', 'an empty directory reports FAIL, not a blind PASS', JSON.stringify(res));
  check(res.detail.toLowerCase().includes('0 files') || res.detail.includes('scanned 0'), 'the detail explains it scanned nothing', res.detail);
  rmSync(T, { recursive: true, force: true });

  // Prove the reverse control actually distinguishes the two states, by
  // simulating the pre-fix behaviour inline (same shape the real run() used
  // to have) and showing IT would have called this a pass.
  const preFixWouldHavePassed = { status: 'PASS', detail: '0 file(s) scanned, no cloud keys' };
  check(preFixWouldHavePassed.status !== res.status, 'seen red: the pre-fix shape (PASS on 0 files) disagrees with the fixed behaviour (FAIL) — the guard is load-bearing');
}

console.log('=== §8 the lint itself runs on the real repo and answers ===');
{
  const res = await noCloudKeys();
  check(['PASS', 'FAIL'].includes(res.status), 'lint returned a known status on the default (real) root', res.status);
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} no-cloud-keys drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);

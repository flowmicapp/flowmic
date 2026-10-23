#!/usr/bin/env node
// Drill for scripts/latency-report.mjs, card POL-1 (design
// docs/strategy/2026-10-14-two-stage-polish-design.md §4.1): the polish-by-unit
// table buckets by `stage` and by `ctx_chars` band, a record that does not carry
// a field lands in the `absent` row/band (never in the 0 band), and logs written
// before POL-1 keep their existing output.
//
// Runs the REAL script as a child process on synthetic logs, so what is asserted
// is what a person running it reads.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'latency-report.mjs');
const dir = mkdtempSync(join(tmpdir(), 'pol1-latency-report-'));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}${detail ? `\n${detail}` : ''}`); }
};
const line = (msg, fields) => `[2026-10-14T00:00:00.000Z] INFO ${msg} ${JSON.stringify(fields)}`;
const run = (name, lines) => {
  const p = join(dir, `${name}.log`);
  writeFileSync(p, `${lines.join('\n')}\n`);
  return spawnSync(process.execPath, [SCRIPT, p], { encoding: 'utf8' });
};
/** One unit-table row: stage, band, metric, n (columns are whitespace-separated). */
const row = (out, stage, band, metric, n) =>
  new RegExp(`^${stage}\\s+${band.replace(/[>]/g, '\\$&')}\\s+${metric}\\s+${n}\\s`, 'm').test(out);

const SEGMENT = { stt_ms: 900, phone_turnaround_ms: 20, inject_ms: 30, server_total_ms: 950, engine_final_ms: 700, polish_wait_ms: 200, polish_path: 'whole', polish_chars: 40 };

try {
  console.log('§1 a log written before POL-1 keeps its output; its polish records land in the absent row');
  {
    const r = run('old', [
      line('latency.segment', SEGMENT),
      line('stt.polish.final', { tcorr: 'abcdef', is_segment: false, path: 'whole', wait_ms: 200, engine_final_ms: 700, chars: 40 }),
    ]);
    check('exit 0', r.status === 0, r.stderr);
    check('existing per-length row still printed', /polish wait whole, <=60 chars\s+1\s+200/.test(r.stdout), r.stdout);
    check('no stage ⇒ absent row, no ctx ⇒ absent band', row(r.stdout, 'absent', 'absent', 'wait', 1), r.stdout);
  }

  console.log('§2 stage x ctx_chars band; a measured 0 is not absent');
  {
    const r = run('new', [
      line('latency.segment', SEGMENT),
      line('stt.polish.final', { is_segment: false, stage: 'whole', wait_ms: 300 }),
      line('stt.polish.final', { is_segment: true, stage: 'segment', wait_ms: 800 }),
      line('stt.polish.final', { is_segment: false, stage: 'tail', wait_ms: 1000 }),
      line('stt.polish.final', { is_segment: false, stage: 'tail', wait_ms: 1100, ctx_chars: 0, ctx_pending: false }),
      line('stt.polish.final', { is_segment: false, stage: 'tail', wait_ms: 1200, ctx_chars: 150, ctx_pending: true }),
      line('stt.polish.final', { is_segment: false, stage: 'tail', wait_ms: 1300, ctx_chars: 500, ctx_pending: false }),
      line('stt.polish.timing', { is_segment: false, phase: 'whole', stage: 'tail', ttfb_ms: 400, ctx_chars: null }),
      line('stt.polish.timing', { is_segment: false, phase: 'spec', ttfb_ms: 999, ctx_chars: 120 }),
    ]);
    check('exit 0', r.status === 0, r.stderr);
    check('whole / absent / wait n=1', row(r.stdout, 'whole', 'absent', 'wait', 1), r.stdout);
    check('segment / absent / wait n=1', row(r.stdout, 'segment', 'absent', 'wait', 1), r.stdout);
    check('🔴 tail without ctx_chars ⇒ absent band (n=1), not the 0-200 band', row(r.stdout, 'tail', 'absent', 'wait', 1), r.stdout);
    check('🔴 tail with ctx_chars 0 and 150 ⇒ 0-200 band n=2', row(r.stdout, 'tail', '0-200', 'wait', 2), r.stdout);
    check('tail with ctx_chars 500 ⇒ 200-800 band n=1', row(r.stdout, 'tail', '200-800', 'wait', 1), r.stdout);
    check('ttfb of the unit call: tail / absent n=1', row(r.stdout, 'tail', 'absent', 'ttfb', 1), r.stdout);
    check('a piece requested while speaking is not a unit (its ttfb is not counted)', !/\b999\b/.test(r.stdout), r.stdout);
    check('ctx_pending counted over the records that carry it', /ctx_pending: true in 1 of 3 records that carry it/.test(r.stdout), r.stdout);
    check('hold_cap_hit absent everywhere ⇒ no line for it', !/hold_cap_hit/.test(r.stdout), r.stdout);
  }

  console.log('§3 no latency.segment: polish records still report; nothing at all still exits 2');
  {
    const r = run('notes', [line('stt.polish.final', { is_segment: false, stage: 'whole', wait_ms: 300 })]);
    check('exit 0 with the unit table', r.status === 0 && row(r.stdout, 'whole', 'absent', 'wait', 1), `${r.status}\n${r.stdout}\n${r.stderr}`);
    const e = run('empty', ['nothing here']);
    check('empty log ⇒ exit 2 (unchanged)', e.status === 2, `${e.status}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) { console.log(`latency-report drill: ${failures} FAILED`); process.exit(1); }
console.log('latency-report drill: PASS');

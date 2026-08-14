#!/usr/bin/env node
// V2-05 (需求⑥) — the reproducible benchmark script master-plan §3.2 promised
// alongside the on-screen timer, and which never existed.
//
// Reads `latency.segment` lines out of a server log and prints p50/p95 per
// segment. Deliberately a READER, not a collector: the server writes plain log
// lines and this computes over them, so percentiles cannot drift from the raw
// record, cannot be reset by a restart, and can be recomputed from any old log.
//
//   node scripts/latency-report.mjs [path-to-server.log]
//
// Default path is the desktop's own sink: %LOCALAPPDATA%\FlowMic\server.log.
//
// ── acceptance-criterion reminder ────────────────────────────────────────────
// 需求⑥ says the fix is accepted on a BEFORE/AFTER p95 comparison from the same
// real machine —「感觉快了」is explicitly not evidence, since「感觉慢」is what
// opened the requirement. Run this once before touching anything and keep the
// output; that first run is the baseline, and there is no way to reconstruct it
// afterwards.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LOG = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'FlowMic', 'server.log')
  : 'server.log';
const path = process.argv[2] ?? DEFAULT_LOG;

/** Percentile over a sorted array, nearest-rank. Returns null for no samples —
 *  an empty set has no p95, and printing 0 would be a fabricated datum. */
function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`cannot read log: ${path}\n${err.message}`);
  console.error('hint: the server only writes a file when FLOWMIC_LOG_PATH is set (the desktop sets it when it launches the sidecar).');
  process.exit(1);
}

const SEGMENTS = ['stt_ms', 'phone_turnaround_ms', 'inject_ms', 'server_total_ms'];
const samples = Object.fromEntries(SEGMENTS.map((s) => [s, []]));
let rows = 0;
let incomplete = 0;
let droppedMax = 0;

for (const raw of text.split('\n')) {
  const at = raw.indexOf('latency.segment ');
  if (at === -1) continue;
  let rec;
  try {
    rec = JSON.parse(raw.slice(at + 'latency.segment '.length));
  } catch {
    continue; // a torn line (rollover mid-write) is skipped, not guessed at
  }
  rows += 1;
  if (typeof rec.dropped_so_far === 'number') droppedMax = Math.max(droppedMax, rec.dropped_so_far);
  let missing = false;
  for (const s of SEGMENTS) {
    if (typeof rec[s] === 'number') samples[s].push(rec[s]);
    else missing = true;
  }
  if (missing) incomplete += 1;
}

if (rows === 0) {
  console.error(`no latency.segment records found in ${path}.`);
  console.error('Speak once and let it inject into the PC, then run again. No samples means no conclusion — do not treat an empty table as "fast".');
  process.exit(2);
}

const label = {
  stt_ms: 'STT (audio:stop → stt:final)',
  phone_turnaround_ms: 'phone turnaround (stt:final → inject:request)',
  inject_ms: 'inject (inject:request → inject:result)',
  server_total_ms: 'server total (t0 → t3)',
};

console.log(`log: ${path}`);
console.log(`samples: ${rows} rows (${incomplete} of them missing a segment), dropped unattributed in-session: ${droppedMax}`);
console.log('All timestamps come from a single server clock; the phone-side "release → uplink" and "receipt → seen" are not in this table.\n');
console.log('segment'.padEnd(42) + 'n'.padStart(6) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'max'.padStart(9));
for (const s of SEGMENTS) {
  const sorted = [...samples[s]].sort((a, b) => a - b);
  const n = sorted.length;
  const fmt = (v) => (v === null ? '—' : `${v}`);
  console.log(
    label[s].padEnd(38) +
      String(n).padStart(6) +
      fmt(pct(sorted, 50)).padStart(9) +
      fmt(pct(sorted, 95)).padStart(9) +
      fmt(n ? sorted[n - 1] : null).padStart(9),
  );
}
console.log('\nUnit ms. The public promise is 「LAN ≤300ms 可复现」(master-plan §3.4) — that is perceived end-to-end,');
console.log('longer than this table\'s server total; do not hold this row against that promise.');

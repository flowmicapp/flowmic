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
/** WP2-6a — additive split of stt_ms. Old logs omit these keys; they must
 *  NOT join SEGMENTS or every pre-split log would count as incomplete. */
const OPTIONAL_SEGMENTS = ['stt_to_flush_ms', 'stt_from_flush_ms', 'engine_final_ms', 'polish_wait_ms']; // INC-1c: the last two
/** INC-1c — polish wait by delivered length; the averages hide the gain (design §5.4). */
const BUCKETS = [['<=60', 0, 60], ['60-160', 61, 160], ['>160', 161, Infinity]];
const byBucket = Object.fromEntries(BUCKETS.map(([k]) => [k, { whole: [], spec: [] }]));
const samples = Object.fromEntries([...SEGMENTS, ...OPTIONAL_SEGMENTS].map((s) => [s, []]));
let rows = 0;
let incomplete = 0;
let droppedMax = 0;

// ── card POL-1 — polish by UNIT (design docs/strategy/2026-10-14-two-stage-polish-design.md §4.1) ──
// `latency.segment` only ever sees a press's terminal final, so a soft segment's
// HOLD is invisible there. The unit table reads the two polish lines instead:
// `stt.polish.final` (wait_ms, every polished final) and `stt.polish.timing`
// (ttfb_ms, unit calls only: a piece requested while speaking is not a unit).
// Records written before POL-1 carry no `stage` and land in the `absent` row; a
// record with no numeric `ctx_chars` lands in the `absent` band. Neither is
// guessed: "not measured" is its own row, never folded into 0.
const STAGES = ['whole', 'tail', 'segment', 'absent'];
const CTX_BANDS = ['absent', '0-200', '200-800', '>800'];
/** The ctx_chars band a record falls in; a non-number is `absent`, never 0. */
function ctxBand(rec) {
  if (typeof rec.ctx_chars !== 'number') return 'absent';
  if (rec.ctx_chars <= 200) return '0-200';
  if (rec.ctx_chars <= 800) return '200-800';
  return '>800';
}
const unitKey = (rec) => `${STAGES.includes(rec.stage) ? rec.stage : 'absent'}|${ctxBand(rec)}`;
const unitWait = new Map();
const unitTtfb = new Map();
let unitRecords = 0;
/** The two flags are counted only over records that CARRY them (absent ⇒ not in `of`). */
const flags = { ctx_pending: { yes: 0, of: 0 }, hold_cap_hit: { yes: 0, of: 0 } };
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
/** The JSON after `tag`: undefined when the line is not that record, null when torn. */
const after = (raw, tag) => {
  const at = raw.indexOf(tag);
  if (at === -1) return undefined;
  try { return JSON.parse(raw.slice(at + tag.length)); } catch { return null; } // torn line: skipped, not guessed at
};

for (const raw of text.split('\n')) {
  const fin = after(raw, 'stt.polish.final ');
  if (fin !== undefined) {
    if (fin !== null && typeof fin.wait_ms === 'number') { unitRecords += 1; push(unitWait, unitKey(fin), fin.wait_ms); }
    if (fin !== null && typeof fin.ctx_pending === 'boolean') { flags.ctx_pending.of += 1; if (fin.ctx_pending) flags.ctx_pending.yes += 1; }
    if (fin !== null && typeof fin.hold_cap_hit === 'boolean') { flags.hold_cap_hit.of += 1; if (fin.hold_cap_hit) flags.hold_cap_hit.yes += 1; }
    continue;
  }
  const tim = after(raw, 'stt.polish.timing ');
  if (tim !== undefined) {
    if (tim !== null && typeof tim.ttfb_ms === 'number' && (tim.phase === undefined || tim.phase === 'whole')) {
      unitRecords += 1; push(unitTtfb, unitKey(tim), tim.ttfb_ms);
    }
    continue;
  }
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
  for (const s of OPTIONAL_SEGMENTS) {
    if (typeof rec[s] === 'number') samples[s].push(rec[s]);
  }
  if (typeof rec.polish_wait_ms === 'number' && typeof rec.polish_chars === 'number') {
    const b = BUCKETS.find(([, lo, hi]) => rec.polish_chars >= lo && rec.polish_chars <= hi);
    if (b) byBucket[b[0]][rec.polish_path === 'spec' ? 'spec' : 'whole'].push(rec.polish_wait_ms);
  }
}

/** Card POL-1 — the unit table; prints nothing when the log has no unit records. */
function printUnitTable() {
  if (unitRecords === 0) return;
  console.log('\npolish by unit: stage x ctx_chars band (wait = stt.polish.final wait_ms, ttfb = stt.polish.timing ttfb_ms)');
  console.log('stage'.padEnd(9) + 'ctx'.padEnd(9) + 'metric'.padEnd(8) + 'n'.padStart(6) + 'p50'.padStart(9) + 'p90'.padStart(9) + 'p95'.padStart(9) + 'max'.padStart(9));
  for (const st of STAGES) for (const band of CTX_BANDS) for (const [metric, m] of [['wait', unitWait], ['ttfb', unitTtfb]]) {
    const sorted = [...(m.get(`${st}|${band}`) ?? [])].sort((a, b) => a - b);
    if (sorted.length === 0) continue;
    console.log(st.padEnd(9) + band.padEnd(9) + metric.padEnd(8) + String(sorted.length).padStart(6)
      + String(pct(sorted, 50)).padStart(9) + String(pct(sorted, 90)).padStart(9) + String(pct(sorted, 95)).padStart(9) + String(sorted[sorted.length - 1]).padStart(9));
  }
  for (const [k, f] of Object.entries(flags)) if (f.of > 0) console.log(`${k}: true in ${f.yes} of ${f.of} records that carry it`);
}

if (rows === 0) {
  console.error(`no latency.segment records found in ${path}.`);
  if (unitRecords > 0) {
    // POL-1: a press that never reached a PC (Notes) still leaves polish records.
    console.error('Printing the polish-by-unit table only.');
    printUnitTable();
    process.exit(0);
  }
  console.error('Speak once and let it inject into the PC, then run again. No samples means no conclusion — do not treat an empty table as "fast".');
  process.exit(2);
}

const label = {
  stt_ms: 'STT (audio:stop → stt:final)',
  stt_to_flush_ms: 'STT to flush (audio:stop → flush sent)',
  stt_from_flush_ms: 'STT from flush (flush sent → stt:final)',
  engine_final_ms: 'engine (audio:stop → final at bridge)',
  polish_wait_ms: 'polish wait (final at bridge → stt:final)',
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
const optionalPresent = OPTIONAL_SEGMENTS.some((s) => samples[s].length > 0);
if (optionalPresent) {
  for (const s of OPTIONAL_SEGMENTS) {
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
}
for (const [k] of BUCKETS) for (const p of ['whole', 'spec']) {
  const sorted = [...byBucket[k][p]].sort((a, b) => a - b);
  if (sorted.length) console.log(`polish wait ${p}, ${k} chars`.padEnd(38) + String(sorted.length).padStart(6) + String(pct(sorted, 50)).padStart(9) + String(pct(sorted, 95)).padStart(9) + String(sorted[sorted.length - 1]).padStart(9));
}
printUnitTable();
console.log('\nUnit ms. The public promise is 「LAN ≤300ms 可复现」(master-plan §3.4) — that is perceived end-to-end,');
console.log('longer than this table\'s server total; do not hold this row against that promise.');

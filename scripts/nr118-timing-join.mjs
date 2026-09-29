#!/usr/bin/env node
// NR118-1. journalctl -o cat input; node label is supplied by the operator.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const spans = ['stt_ms', 'stt_to_flush_ms', 'stt_from_flush_ms', 'phone_turnaround_ms', 'inject_ms', 'server_total_ms', 'audio_ms', 'uplink_lag_ms', 'backlog_ms', 'V1d', 'V1e'];
const finishReasons = ['stop', 'length', 'content_filter', 'none', 'other'];
const countFinishReasons = (records) => Object.fromEntries(finishReasons.map(reason => [reason, records.filter(r => r.finish_reason === reason).length]));
export function summarize(text, node = 'unknown') {
  const rows = [], polish = [], guards = [], compose = [], summaries = [];
  const buckets = { 'latency.segment': rows, 'latency.summary': summaries, 'stt.polish.timing': polish, 'stt.polish.guard': guards, 'compose.timing': compose };
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(latency\.(?:segment|summary)|stt\.polish\.(?:timing|guard)|compose\.timing) (\{.*)$/);
    if (!match) continue;
    try { buckets[match[1]].push(JSON.parse(match[2])); } catch { malformed++; }
  }
  const stats = (values) => {
    const a = values.filter(Number.isFinite).sort((a, b) => a - b);
    return { n: a.length, p50: a[Math.ceil(a.length * .5) - 1] ?? null, p90: a[Math.ceil(a.length * .9) - 1] ?? null, max: a.at(-1) ?? null };
  };
  // Same relay clock; never attach an untagged stt.cut by timestamp/adjoining line.
  const segmentsByTag = index(rows), polishByTag = index(polish);
  for (const row of rows) {
    const measured = segmentsByTag.get(row.tcorr)?.length === 1 && polishByTag.get(row.tcorr)?.length === 1
      ? polishByTag.get(row.tcorr)[0] : null;
    row.V1d = delta(row.stt_from_flush_ms, measured?.elapsed_ms);
    row.V1e = finite(measured?.elapsed_ms) ? measured.elapsed_ms : null;
  }
  const table = [];
  for (const mode of new Set(rows.map(r => r.mode ?? 'unknown'))) {
    for (const span of spans) table.push({ node, mode, span, ...stats(rows.filter(r => (r.mode ?? 'unknown') === mode).map(r => r[span])) });
  }
  const nStop = summaries.length ? summaries.reduce((n, r) => n + (r.n_stop ?? 0), 0) : null;
  const outcomes = Object.fromEntries([...new Set(polish.map(r => r.outcome))].map(outcome => {
    const n = polish.filter(r => r.outcome === outcome).length;
    return [outcome, { n, n_stop: nStop, rate: nStop ? n / nStop : null }];
  }));
  const categories = Object.fromEntries(['numeral', 'digit', 'modal', 'negation', 'quantifier'].map(c => [c, guards.filter(r => r[`d_${c}`] > 0).length]));
  const rowKeys = rows.map(r => r.tcorr).filter(Boolean), polishKeys = polish.map(r => r.tcorr).filter(Boolean);
  const unmatched = {
    malformed, segment_without_polish: rows.filter(r => !r.tcorr || !polishKeys.includes(r.tcorr)).length,
    polish_without_segment: polish.filter(r => !r.tcorr || !rowKeys.includes(r.tcorr)).length,
    guard_without_polish: guards.filter(r => !r.tcorr || !polishKeys.includes(r.tcorr)).length,
    ambiguous_tcorr: [...new Set(rowKeys)].filter(k => rowKeys.filter(v => v === k).length > 1 || polishKeys.filter(v => v === k).length > 1).length,
    stops_without_closed_segment: nStop === null ? null : Math.max(0, nStop - rows.length),
    incomplete_segment: rows.filter(r => ['stt_ms', 'phone_turnaround_ms', 'inject_ms'].some(k => !Number.isFinite(r[k]))).length,
  };
  return { table, n_stop: nStop, outcomes, categories, unmatched,
    polish_elapsed_ms: stats(polish.map(r => r.elapsed_ms)), compose_elapsed_ms: stats(compose.map(r => r.elapsed_ms)),
    finish_reasons: { compose: countFinishReasons(compose), polish: countFinishReasons(polish) },
    shadow: { n: guards.filter(r => r.v2_verdict).length, unmeasured: guards.filter(r => !r.v2_verdict).length, skipped_len: guards.filter(r => r.v2_family === 'skipped_len').length,
      newly_accepted_by_rule: Object.fromEntries(['r1', 'r2', 'r3'].map(rule => [rule, guards.filter(r => r.verdict === 'reject' && r.v2_verdict === 'ok' && r.v2_explained?.[rule] > 0).length])),
      newly_accepted: guards.filter(r => r.verdict === 'reject' && r.v2_verdict === 'ok').length,
      regressions: guards.filter(r => r.verdict === 'ok' && r.v2_verdict === 'reject').length } };
}

const tag = /^[0-9a-f]{6}$/;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const delta = (a, b) => finite(a) && finite(b) ? a - b : null;
export function parseLogs(text, phone = false) {
  const records = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (phone) {
      const at = line.indexOf('FMTIMING utt.timing ');
      if (at < 0) continue;
      const fields = Object.create(null);
      let bad = false;
      for (const pair of line.slice(at + 20).trim().split(/\s+/)) {
        const m = /^([a-z_]+)=([^\s=]+)$/.exec(pair);
        if (!m || Object.hasOwn(fields, m[1])) { bad = true; break; }
        fields[m[1]] = /^-?\d+$/.test(m[2]) ? Number(m[2]) : m[2] === 'null' ? null : m[2];
        // A digits-only tcorr is still a string, including leading zeros.
        if (m[1] === 'tcorr') fields[m[1]] = m[2];
      }
      if (bad || !Object.hasOwn(fields, 'tcorr')) malformed++;
      else records.push({ event: 'utt.timing', ...fields });
    } else {
      const m = /\b(latency\.(?:segment|summary)|stt\.polish\.(?:timing|guard)|stt\.cut|compose\.timing)\s+(\{.*\})\s*$/.exec(line);
      if (!m) {
        if (/\b(?:latency\.(?:segment|summary)|stt\.polish\.(?:timing|guard)|stt\.cut|compose\.timing)\s/.test(line)) malformed++;
        continue;
      }
      try { records.push({ ...JSON.parse(m[2]), event: m[1] }); }
      catch { malformed++; }
    }
  }
  return { records, malformed };
}

function index(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!tag.test(row.tcorr ?? '')) continue;
    const bucket = map.get(row.tcorr) ?? [];
    bucket.push(row);
    map.set(row.tcorr, bucket);
  }
  return map;
}

export function joinTiming(phoneText, relayText, node = 'unknown') {
  const phone = parseLogs(phoneText, true), relay = parseLogs(relayText);
  const legs = relay.records.filter((r) => r.event === 'latency.segment');
  const phones = index(phone.records), relays = index(legs);
  const polishes = index(relay.records.filter((r) => r.event === 'stt.polish.timing'));
  const rows = [];
  let matched = 0, ambiguous = 0, negativeNetwork = 0;
  for (const p of phone.records) {
    const candidates = relays.get(p.tcorr) ?? [];
    const unique = phones.get(p.tcorr)?.length === 1 && candidates.length === 1;
    if ((phones.get(p.tcorr)?.length ?? 0) > 1 || candidates.length > 1) ambiguous++;
    const r = unique ? candidates[0] : null;
    if (r) matched++;
    const polish = unique && polishes.get(p.tcorr)?.length === 1 ? polishes.get(p.tcorr)[0] : null;
    const network = delta(delta(p.final_rx_ms, p.stop_emit_ms), r?.stt_ms);
    if (finite(network) && network < 0) negativeNetwork++;
    rows.push({ node: r?.node ?? node, mode: p.mode ?? 'unknown',
      V1: delta(p.final_rx_ms, p.release_ms),
      V2: delta(p.painted_ms, p.final_rx_ms),
      V3: delta(p.inject_emit_ms, p.final_rx_ms),
      V4: delta(p.result_rx_ms, p.inject_emit_ms),
      V1a: delta(p.stop_emit_ms, p.release_ms), V1b: network,
      V1c: r?.stt_to_flush_ms ?? null, V1d: delta(r?.stt_from_flush_ms, polish?.elapsed_ms),
      V1e: finite(polish?.elapsed_ms) ? polish.elapsed_ms : null,
      polish_ms: polish?.elapsed_ms ?? null,
      compose_ms: delta(p.compose_done_ms, p.compose_start_ms),
      enqueue_ms: delta(p.enqueue_done_ms, p.enqueue_start_ms),
      persist_ms: delta(p.persisted_ms, p.enqueue_start_ms),
      uplink_lag_ms: r?.uplink_lag_ms ?? null,
    });
  }
  return { rows, counts: { phone: phone.records.length, relay: legs.length, matched,
    unmatched_phone: phone.records.length - matched, unmatched_relay: legs.length - matched,
    ambiguous_phone: ambiguous, malformed_phone: phone.malformed, malformed_relay: relay.malformed,
    open_phone: phone.records.filter((p) => p.open != null).length,
    // Retained count: cuts are deliberately never correlation inputs.
    unmatched_stop_cut: relay.records.filter((r) => r.event === 'stt.cut' && r.kind === 'stop').length,
    negative_network: negativeNetwork,
    finish_reasons: {
      compose: countFinishReasons(relay.records.filter(r => r.event === 'compose.timing')),
      polish: countFinishReasons(relay.records.filter(r => r.event === 'stt.polish.timing')),
    } } };
}

export function renderReport(result) {
  const lines = [JSON.stringify(result.counts), 'node mode span n p50 p90 max (ms)'];
  const groups = new Map();
  for (const row of result.rows) {
    const key = `${row.node} ${row.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [group, rows] of groups) {
    for (const span of Object.keys(rows[0]).filter((s) => !['node', 'mode'].includes(s))) {
      const values = rows.map((r) => r[span]).filter(finite).sort((a, b) => a - b);
      const pct = (p) => values.length ? values[Math.ceil(values.length * p) - 1] : 'N/A';
      lines.push(`${group} ${span} ${values.length} ${pct(.5)} ${pct(.9)} ${pct(1)}`);
    }
  }
  lines.push('V1b retains negative differences for diagnosis; clocks are never subtracted across devices.',
    'V1d = stt_from_flush_ms - polish.elapsed_ms; V1e = polish.elapsed_ms. Unique tcorr only; cuts carry no correlation.',
    'Node is the relay process label (--node when absent); percentiles must not be added.');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--relay', '--phone', '--node'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[arg]) throw new Error(`Missing or duplicate ${arg}`);
      options[arg] = args[++i];
    } else if (arg.startsWith('--')) throw new Error('Unknown option');
    else positional.push(arg);
  }
  const file = options['--relay'] ?? positional[0], node = options['--node'] ?? positional[1] ?? 'unknown';
  if (!file || positional.length > (options['--relay'] ? 0 : 2)) {
    throw new Error('Usage: node scripts/nr118-timing-join.mjs <relay-file> [node] [--phone phone-file] OR --relay relay-file [--node node] [--phone phone-file]');
  }
  const relay = readFileSync(file, 'utf8');
  if (options['--phone']) console.log(renderReport(joinTiming(readFileSync(options['--phone'], 'utf8'), relay, node)));
  else {
    const result = summarize(relay, node);
    console.table(result.table);
    console.log(JSON.stringify({ ...result, table: undefined }, null, 2));
    console.log('n_stop uses summary windows; boundary windows may straddle the dump. Missing data and unmatched counts are not zero latency.');
  }
}

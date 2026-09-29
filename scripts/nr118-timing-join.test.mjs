import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { summarize, joinTiming, parseLogs, renderReport } from './nr118-timing-join.mjs';
const line = (name, obj) => `[INFO] ${name} ${JSON.stringify(obj)}`;
const sample = [line('latency.summary', { n_stop: 4 }),
  ...[10, 20, 100].map((n, i) => line('latency.segment', { mode: 'realtime', tcorr: `abc00${i}`, stt_ms: n })),
  line('stt.polish.timing', { outcome: 'guard_reject', tcorr: 'abc000', elapsed_ms: 12 }),
  line('stt.polish.guard', { d_modal: 2 }), 'stt.polish.timing {broken'];
const r = summarize(sample.join('\n'), 'jp');
assert.deepEqual(r.table.find(r => r.span === 'stt_ms'), { node: 'jp', mode: 'realtime', span: 'stt_ms', n: 3, p50: 20, p90: 100, max: 100 });
assert.deepEqual(r.outcomes.guard_reject, { n: 1, n_stop: 4, rate: .25 });
assert.equal(r.categories.modal, 1);
assert.equal(r.unmatched.malformed, 1);
assert.equal(r.unmatched.segment_without_polish, 2);
assert.equal(r.unmatched.stops_without_closed_segment, 1);
assert.equal(r.unmatched.incomplete_segment, 3);
assert.equal(summarize('').n_stop, null);
const finishCounts = summarize([
  line('compose.timing', { finish_reason: 'length' }),
  line('compose.timing', { finish_reason: 'stop' }),
  line('stt.polish.timing', { finish_reason: 'length' }),
  line('stt.polish.timing', { finish_reason: 'content_filter' }),
].join('\n')).finish_reasons;
assert.deepEqual(finishCounts.compose, { stop: 1, length: 1, content_filter: 0, none: 0, other: 0 });
assert.deepEqual(finishCounts.polish, { stop: 0, length: 1, content_filter: 1, none: 0, other: 0 });
const joinedFinishCounts = joinTiming('', [
  line('compose.timing', { finish_reason: 'length' }),
  line('stt.polish.timing', { finish_reason: 'length' }),
].join('\n')).counts.finish_reasons;
assert.equal(joinedFinishCounts.compose.length, 1);
assert.equal(joinedFinishCounts.polish.length, 1);
const shadow = summarize(line('stt.polish.guard', { verdict: 'reject', v2_verdict: 'ok', v2_explained: { r1: 1, r2: 0, r3: 0 } })).shadow;
assert.deepEqual(shadow.newly_accepted_by_rule, { r1: 1, r2: 0, r3: 0 });
assert.equal(shadow.regressions, 0);
console.log('PASS: NR118 journal reader, nearest rank, stop denominator, unmatched records');

// Phone branch fixtures and compatibility checks, retained verbatim.
const phonePath = new URL('./fixtures/nr118-phone.txt', import.meta.url);
const relayPath = new URL('./fixtures/nr118-relay.txt', import.meta.url);
const phone = readFileSync(phonePath, 'utf8'), relay = readFileSync(relayPath, 'utf8');
const result = joinTiming(phone, relay, 'jp');
assert.equal(result.counts.matched, 2);
assert.equal(result.counts.unmatched_phone, 1);
assert.equal(result.counts.unmatched_relay, 1);
assert.equal(result.counts.unmatched_stop_cut, 1);
assert.equal(result.counts.open_phone, 1);
assert.deepEqual(Object.fromEntries(Object.entries(result.rows[0]).filter(([k]) => /^V/.test(k))),
  { V1: 1600, V2: 16, V3: 200, V4: 500, V1a: 10, V1b: 390, V1c: 20, V1d: 80, V1e: 1100 });
assert.equal(result.rows[1].V1d, null);
assert.equal(result.rows[1].V1e, null);
assert.match(renderReport(result), /jp realtime V1 2 1600 2600 2600/);
assert.match(renderReport(result), /V1d 1 80 80 80/);
assert.equal(joinTiming(phone + phone, relay).counts.matched, 0);
assert.equal(joinTiming(phone, relay + relay).counts.matched, 0);
assert.equal(parseLogs('FMTIMING utt.timing tcorr=000123 final_rx_ms=5', true).records[0].tcorr, '000123');
assert.equal(parseLogs('latency.segment {torn').malformed, 1);
assert.equal(parseLogs('FMTIMING utt.timing tcorr=abcdef broken', true).malformed, 1);
assert.equal(joinTiming(phone, relay.replace('"stt_ms":1200', '"stt_ms":1800')).counts.negative_network, 1);
const cli = execFileSync(process.execPath, ['scripts/nr118-timing-join.mjs',
  '--phone', phonePath.pathname.replace(/^\/(\w:)/, '$1'),
  '--relay', relayPath.pathname.replace(/^\/(\w:)/, '$1'), '--node', 'jp'], { encoding: 'utf8' });
assert.match(cli, /"matched":2/);
assert.ok(!cli.includes('private-entry-id'));
console.log('PASS NR118 timing join: synthetic fixtures, clock-free split, ambiguity and unmatched counts');

// Real relay envelopes: stt.cut is untagged and may interleave another session.
const realistic = [
  line('stt.cut', { kind: 'stop', segment_idx: 0, boundary_seq: 52, flush_ms: 9999, backlog_ms: 80, timed_out: false }),
  line('stt.polish.timing', { tcorr: 'abcdef', outcome: 'applied', elapsed_ms: 1100, ttfb_ms: 200, budget_ms: 2000, chars_in: 30, chars_out: 31, strength: 'strict', lang: 'zh', llm_source: 'user', model: 'byok' }),
  line('latency.segment', { entry_id: null, tcorr: 'abcdef', mode: 'realtime', stt_ms: 1200, stt_to_flush_ms: 20, stt_from_flush_ms: 1180, phone_turnaround_ms: 220, inject_ms: 400 }),
].join('\n');
const split = summarize(realistic, 'jp');
assert.deepEqual(split.table.find(r => r.span === 'V1d'), { node: 'jp', mode: 'realtime', span: 'V1d', n: 1, p50: 80, p90: 80, max: 80 });
assert.equal(split.table.find(r => r.span === 'V1e').p50, 1100);
assert.equal(joinTiming(phone, realistic).rows[0].V1d, 80);
assert.equal(joinTiming(phone, realistic).rows[0].V1e, 1100);
assert.deepEqual(summarize(realistic.split('\n').reverse().join('\n')).table.map(r => [r.span, r.p50]),
  split.table.map(r => [r.span, r.p50]));
assert.equal(summarize(realistic + '\n' + realistic).table.find(r => r.span === 'V1d').n, 0);
assert.equal(joinTiming(phone, realistic + '\n' + realistic).rows[0].V1d, null);
const noPolish = realistic.split('\n').filter(l => !l.includes('stt.polish.timing')).join('\n');
assert.equal(summarize(noPolish).table.find(r => r.span === 'V1e').n, 0);
assert.equal(joinTiming(phone, noPolish).rows[0].V1d, null);
assert.equal(summarize(line('stt.polish.guard', { v2_family: 'skipped_len', v2_verdict: null })).shadow.skipped_len, 1);
const relayFile = relayPath.pathname.replace(/^\/(\w:)/, '$1');
for (const args of [[relayFile, 'jp'], ['--relay', relayFile, '--node', 'jp']]) {
  const text = execFileSync(process.execPath, ['scripts/nr118-timing-join.mjs', ...args], { encoding: 'utf8' });
  assert.match(text, /V1d/);
  assert.match(text, /polish_elapsed_ms/);
  assert.ok(!text.includes('private-entry-id'));
}
const combined = execFileSync(process.execPath, ['scripts/nr118-timing-join.mjs', relayFile, 'jp', '--phone', phonePath.pathname.replace(/^\/(\w:)/, '$1')], { encoding: 'utf8' });
assert.match(combined, /"matched":2/);
assert.match(combined, /jp realtime V1b 2 390 780 780/);
console.log('PASS NR118 unified reader: relay default, phone CLI compatibility, realistic untagged cuts, unique correlation split');

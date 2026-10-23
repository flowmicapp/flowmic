#!/usr/bin/env node
// scripts/eval/speech-quality/run-relay.mjs — card EVAL-2: stream the corpus
// through a LOCAL relay end to end (simulated phone + simulated PC), so the
// numbers include our own pipeline: VAD gate + pre-roll, idle hang-up/redial,
// draft merge, final-text normalizer, dictionary replace, realtime polish.
//
//   node scripts/eval/speech-quality/run-relay.mjs --dry-run          # plan + cost
//   node scripts/eval/speech-quality/run-relay.mjs --prefix relay     # the baseline plan
//   node scripts/eval/speech-quality/run-relay.mjs --scenarios onset3 --ids en-jar-01 --strengths strict
//   node scripts/eval/speech-quality/score-relay.mjs --prefix relay   # -> <results>/relay-report.md
//
// ⚠️ Latency is only trustworthy at --concurrency 1 (the default). Measured
// 2026-10-13 on a loaded machine: with 3 workers, 34 of 136 utterances showed
// the relay's `phone_turnaround_ms` (final emitted -> inject:request received,
// which a simulated phone makes ~0) at 80-1800 ms; the same items at
// concurrency 1 read 1-6 ms. Text results did not depend on it; latency did.
// Every record carries `harness_loop_delay_max_ms` to check the ruler.
//
// What it does, per worker: start ONE local server-core
// (relay-server.mjs: standalone, 127.0.0.1, throwaway home + DB, managed
// Soniox TEST key + DeepSeek set only in that child's env), pair a PC and a
// phone with the golden-path helpers (verify/golden/harness.mjs
// `registerAndPair`), then run its share of the jobs one at a time.
//
// The phone is simulated the way apps/mobile sends audio:
//   · audio:start {16 kHz, mono, pcm_s16le, mode:'realtime', delivery:'inject',
//     source_lang, prefs:{'stt.polish':{enabled:true,strength}}}
//     (apps/mobile/lib/src/ptt/ptt_edges.dart, `pttDown`; prefs shape =
//     packages/protocol/src/phone-prefs.ts);
//   · 200 ms chunks at real-time pace, each emitted when its 200 ms has been
//     "captured", `audio:chunk {seq, ts_ms, data_b64}` with ts_ms = wall clock
//     at emission (audio_capture.dart `_emitChunk`, audio_emitter.dart);
//   · on release: the < 200 ms residual tail, then `audio:stop {}`
//     (ptt_edges.dart `pttUp`);
//   · the row text = finals joined by segment_idx, later final for the same
//     idx replacing the earlier one, CJK-aware joiner (stt/segment_buffer.dart
//     `joinedFrom`); on the TERMINAL final (is_segment:false) one
//     `inject:request {text, source:'stt', mode:'realtime', inject_origin:'live',
//     target_pc_id}` (session/chat_utterance.dart `_deliverDirect`).
//   The real phone also writes the outbox to disk before that emit; the
//   simulated one does not, so phone turnaround here is a lower bound.
// The PC is simulated as: timestamp `inject:request`, inject NOTHING, answer
// `inject:result {ok:true, mode:'sendinput'}` so the relay's latency leg closes
// and prints `latency.segment` (obs/latency.ts `markInjectResult`). That reply
// is synthetic; it is never scored as a delivery.
//
// 🔴 LOCAL ONLY: never points at a production relay, never registers accounts
// anywhere. Soniox TEST key (JP region endpoint), see README "Keys".
// NOT A GATE — it spends Soniox seconds and DeepSeek calls.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { REPO, RESULTS_DIR, gitHead, langTag, loadCorpus, parseArgs, pool, readEnvFile, recordUsage, usageTotals } from './lib.mjs';
import { startLlmTap } from './llm-tap.mjs';
import { BYTES_PER_MS, scenarioPcm } from './relay-audio.mjs';
import { RowSettler, joinSegments } from './relay-rows.mjs';
import { startRelay } from './relay-server.mjs';

// INC-1: a card may start its own relay ledger (the default name is unchanged).
const LEDGER = process.env.FLOWMIC_EVAL_RELAY_LEDGER ?? 'relay-usage-ledger.jsonl';
const CHUNK_MS = 200;
const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS;
const args = parseArgs();
const corpus = loadCorpus();
const R = RESULTS_DIR();
const prefix = args.prefix ?? 'relay';
const out = resolve(args.out ?? join(R, `${prefix}-runs.jsonl`));
const serverCore = resolve(args['server-core'] ?? join(REPO, 'apps', 'server-core'));
const sttCloud = resolve(args['stt-cloud'] ?? join(serverCore, '..', '..', 'packages', 'stt-cloud'));
const capSec = Number(process.env.FLOWMIC_EVAL_SONIOX_CAP_SEC ?? 1200);
const capLlm = Number(process.env.FLOWMIC_EVAL_LLM_CAP ?? 500);
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

// ── the plan ────────────────────────────────────────────────────────────────
// Default ("baseline"): every third corpus item plus the variant ids, Strict
// and Smooth, plain; the variant ids also with quiet onsets 1.5/3/5 s, a 4 s
// mid-utterance pause (crosses the 3 s idle hang-up) and 20 dB noise, Strict.
// The TTS files have no leading silence (first 10 ms frame is already above
// -45 dBFS), so `base` IS the "speech at t=0" case.
const variantIds = new Set(corpus.variants.ids);
const baseSet = corpus.items.filter((it, i) => i % 3 === 0 || variantIds.has(it.id));
const PLAN = [
  { scenario: 'base', items: baseSet, strengths: ['strict', 'smooth'] },
  { scenario: 'onset1.5', items: corpus.items.filter((it) => variantIds.has(it.id)), strengths: ['strict'] },
  { scenario: 'onset3', items: corpus.items.filter((it) => variantIds.has(it.id)), strengths: ['strict'] },
  { scenario: 'onset5', items: corpus.items.filter((it) => variantIds.has(it.id)), strengths: ['strict'] },
  { scenario: 'midpause4', items: corpus.items.filter((it) => variantIds.has(it.id)), strengths: ['strict'] },
  { scenario: 'noise20', items: corpus.items.filter((it) => variantIds.has(it.id)), strengths: ['strict'] },
];
const onlyScen = list(args.scenarios), onlyIds = list(args.ids), onlyStr = list(args.strengths), onlyLang = list(args.lang);
const jobs = [];
// --jobs <file.json>: an explicit [{id, scenario, strength}] list that REPLACES the
// plan, in that order (cross-build comparisons pin the same jobs on both builds).
const jobList = typeof args.jobs === 'string' ? JSON.parse(readFileSync(args.jobs, 'utf8')) : null;
if (jobList) for (const j of jobList) {
  const it = corpus.items.find((x) => x.id === j.id);
  if (!it) throw new Error(`--jobs: no corpus item ${j.id}`);
  const a = scenarioPcm(it, j.scenario);
  if (!a) { console.warn(`[run-relay] skip ${it.id}/${j.scenario}: audio or EVAL-1 timing missing`); continue; }
  jobs.push({ item: it, scenario: j.scenario, strength: j.strength, path: j.path, kind: j.kind, ...a });
}
for (const p of jobList ? [] : PLAN) {
  if (onlyScen && !onlyScen.includes(p.scenario)) continue;
  for (const it of p.items) {
    if (onlyIds && !onlyIds.includes(it.id)) continue;
    if (onlyLang && !onlyLang.includes(it.lang)) continue;
    // --strengths REPLACES the plan's strengths (so `--strengths off` runs a
    // scenario with polish disabled, which shows the raw relay text).
    for (const strength of onlyStr ?? p.strengths) {
      const a = scenarioPcm(it, p.scenario);
      if (!a) { console.warn(`[run-relay] skip ${it.id}/${p.scenario}: audio or EVAL-1 timing missing`); continue; }
      jobs.push({ item: it, scenario: p.scenario, strength, ...a });
    }
  }
}
// Extra scenarios outside the plan (e.g. --scenarios onset0 or midpause6) for --ids.
if (onlyScen && !jobList) for (const s of onlyScen) {
  if (PLAN.some((p) => p.scenario === s)) continue;
  for (const it of corpus.items) {
    if (!onlyIds?.includes(it.id)) continue;
    for (const strength of onlyStr ?? ['strict']) { const a = scenarioPcm(it, s); if (a) jobs.push({ item: it, scenario: s, strength, ...a }); }
  }
}
const audioSec = jobs.reduce((a, j) => a + j.pcm.length / 32000, 0);
const used = usageTotals(LEDGER);
console.log(`[run-relay] ${jobs.length} utterances, ${(audioSec / 60).toFixed(1)} audio-min streamed (upper bound on Soniox: the VAD gate withholds silence), <= ${jobs.length} polish calls; relay ledger so far ${(used.soniox_audio_sec / 60).toFixed(1)} min / ${used.llm_calls} calls (caps ${capSec / 60} min / ${capLlm})`);
if (args['dry-run']) {
  const by = {};
  for (const j of jobs) { const k = `${j.scenario}/${j.strength}`; by[k] = (by[k] ?? 0) + 1; }
  console.log(by);
  process.exit(0);
}
if (!args['allow-over'] && (used.soniox_audio_sec + audioSec > capSec || used.llm_calls + jobs.length > capLlm)) {
  console.error('[run-relay] refusing: this run would pass the card budget (relay ledger). Pass --allow-over deliberately.');
  process.exit(2);
}
for (const f of [join(serverCore, 'dist', 'index.js'), join(sttCloud, 'dist', 'index.cjs')]) if (!existsSync(f)) throw new Error(`${f} missing — run node scripts/refresh-derived.mjs --lane`);

const soniox = readEnvFile('soniox.env');
const ds = readEnvFile('deepseek.env');
if (!soniox.SONIOX_API_KEY || !ds.FLOWMIC_DEEPSEEK_API_KEY) throw new Error('.local/soniox.env or .local/deepseek.env is missing its key');
const keys = {
  sonioxKey: soniox.SONIOX_API_KEY,
  sonioxEndpoint: args.endpoint ?? soniox.SONIOX_WS_ENDPOINT ?? 'wss://stt-rt.jp.soniox.com/transcribe-websocket',
  deepseekKey: ds.FLOWMIC_DEEPSEEK_API_KEY,
  deepseekModel: args.model ?? ds.FLOWMIC_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
};
// --relay-env K=V;K2=V2 : extra environment for every relay this run starts (e.g.
// FLOWMIC_STT_SOFT_SEGMENT_MS=12000 to make a soft-segment cut reachable).
const relayEnv = {};
for (const kv of (typeof args['relay-env'] === 'string' ? args['relay-env'].split(';') : [])) { const i = kv.indexOf('='); if (i > 0) relayEnv[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
// --llm-tap : put a local recording proxy between the relay and DeepSeek, so each
// record carries the exact text the relay asked the model to polish (the raw STT)
// and the model's own output (before the guard). Never prints the key.
// POL-2: ONE TAP PER WORKER. A tap shared by several relays hands each utterance
// every call made in its time window, other workers' included (measured
// 2026-10-14 at --concurrency 3: raw text from another press and tokens counted
// three times). Each worker's relays point at that worker's own tap.
const useTap = !!args['llm-tap'];
const taps = new Map();
async function tapFor(wi) {
  if (!taps.has(wi)) taps.set(wi, await startLlmTap({ upstream: 'https://api.deepseek.com/v1' }));
  return taps.get(wi);
}
const { registerAndPair } = await import(pathToFileURL(join(REPO, 'verify', 'golden', 'harness.mjs')).href);

const runDir = join(R, 'relay-runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(runDir, { recursive: true });
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify({ meta: {
  at: new Date().toISOString(), server_core: serverCore, server_core_head: gitHead(serverCore), stt_cloud: sttCloud, endpoint: keys.sonioxEndpoint,
  model: keys.deepseekModel, relay_env: Object.fromEntries(Object.entries(relayEnv).map(([k, v]) => [k, /KEY/i.test(k) ? '<set>' : v])), llm_tap: useTap, chunk_ms: CHUNK_MS, workers: Number(args.concurrency ?? 1), run_dir: runDir,
} }) + '\n');

const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - performance.now())));
// stt/segment_buffer.dart `joinedFrom` lives in relay-rows.mjs (card POL-2 moved it there unchanged).
// --record-finals (card POL-2): the phone settles rows the way apps/mobile does in
// realtime mode (relay-rows.mjs RowSettler) and, on the PC path, sends one
// inject:request PER ROW as each row settles, instead of one joined request at the
// end; every record then carries `rows` (per-row delivered text, polish flag, raw
// text from the LLM tap) and `interim_times`. Without the flag nothing changes.
const recordFinals = !!args['record-finals'];

const NOTABLE = /idle|hang|dial|pre-?roll|replay|gate|vad|empty|unheard|owed|flush|polish|segment|rollover|spawn|engine|error|refus|latency|cut|pause|stall|backlog/i;

/** --record-finals: the rows as the phone settled them, each with its timing and,
 *  when the LLM tap is on, the text the relay asked the model to polish for it
 *  (the user message of the first call made between the previous row and this
 *  one; with an earlier-speech block the part after CONTEXT_CLOSE,
 *  apps/server-core/src/stt/stt-polish-piece.ts). No call in that window ⇒
 *  raw is null (polish skipped before a call, or off). */
function recordedRows(settler, calls, tPress, rel, ev) {
  const CLOSE = '<<<END EARLIER SPEECH>>>';
  let prev = 0;
  const rows = settler.rows.map((r) => {
    const dt = Math.round(r.t - tPress);
    // The relay's liveness probe also reaches the tap (compose/llm-health.ts PROBE_SYSTEM
    // 'Connectivity probe. ...', user 'ping'); it is not a polish call.
    const call = calls?.find((c) => c.t0 >= prev && c.t0 <= dt && c.status === 200 && typeof c.user === 'string' && !/^Connectivity probe/.test(c.system_head ?? '')) ?? null;
    prev = dt;
    const raw = call ? (call.user.includes(CLOSE) ? call.user.slice(call.user.lastIndexOf(CLOSE) + CLOSE.length).trim() : call.user) : null;
    return {
      idx: r.idx, from_seg: r.from_seg, to_seg: r.to_seg, terminal: r.terminal, text: r.text, raw,
      polish: r.polish, polish_reason: r.polish_reason, dt_press: dt, dt_release: rel(r.t),
      inject_sent_dt: r.inject_sent_t === undefined ? null : Math.round(r.inject_sent_t - tPress),
      inject_at_pc_dt: r.inject_at_pc_t === undefined ? null : Math.round(r.inject_at_pc_t - tPress),
      inject_result: r.inject_result ? { dt: Math.round(r.inject_result.t - tPress), ok: r.inject_result.ok, code: r.inject_result.code } : null,
    };
  });
  return { rows, interim_times: ev.interims.map((i) => [Math.round(i.t - tPress), i.seg ?? null, i.text.length]) };
}

async function runOne(w, job) {
  const { phone, pc, pcId, relay, tap } = w;
  // The wire tag the phone sends (lib.mjs langTag): en, zh-CN for zh and mixed, fr/de/... for ML-0.
  const lang = langTag(job.item.lang);
  const ev = { interims: [], finals: [], errors: [], other: [], pc: [] };
  const segs = new Map();
  const lastInterim = new Map();
  let terminal = null, injectAtPc = null, injectResultAtPhone = null, injectSentAt = null, injectText = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const entryId = randomUUID(), requestId = randomUUID();
  const settler = recordFinals ? new RowSettler() : null;
  const rowByRequest = new Map();
  // --record-finals: one row per settlement; on the PC path each row is sent as it settles.
  const settle = (t, payload) => {
    const row = settler.onFinal(payload);
    if (row) {
      row.t = t;
      if (delivery !== 'none' && row.text.trim()) {
        row.request_id = randomUUID(); row.inject_sent_t = performance.now();
        rowByRequest.set(row.request_id, row);
        if (row.terminal) { injectText = row.text; injectSentAt = row.inject_sent_t; }
        phone.emit('inject:request', { text: row.text, source: 'stt', request_id: row.request_id, entry_id: randomUUID(), mode: 'realtime', inject_origin: 'live', target_pc_id: pcId });
      }
    }
    if (payload.is_segment !== false || terminal !== null) return;
    terminal = { t, ...payload };
    if (delivery === 'none') resolveDone('terminal_final');
    else if (!row || !row.request_id) resolveDone(row ? 'empty_terminal' : 'terminal_no_row');
  };

  const onAny = (event, payload) => {
    const t = performance.now();
    if (event === 'stt:interim') { ev.interims.push({ t, text: payload?.text ?? '', seg: payload?.segment_idx }); if ((payload?.text ?? '').trim()) lastInterim.set(payload?.segment_idx ?? 0, payload.text); }
    else if (event === 'stt:final') {
      ev.finals.push({ t, ...payload });
      segs.set(payload.segment_idx, payload.text ?? '');
      if (settler) settle(t, payload);
      else if (payload.is_segment === false && terminal === null) {
        terminal = { t, ...payload };
        const text = joinSegments(segs);
        if (delivery === 'none') resolveDone('terminal_final'); // a record-only / recovery press sends no inject:request
        else if (text.trim()) {
          injectText = text; injectSentAt = performance.now();
          phone.emit('inject:request', { text, source: 'stt', request_id: requestId, entry_id: entryId, mode: 'realtime', inject_origin: 'live', target_pc_id: pcId });
        } else resolveDone('empty_terminal');
      }
    } else if (event === 'stt:error') {
      ev.errors.push({ t, code: payload?.code, message: payload?.message, retryable: payload?.retryable, unheard_from_ms: payload?.unheard_from_ms });
    } else if (event === 'inject:result') {
      const row = settler ? (rowByRequest.get(payload?.request_id) ?? settler.rows.find((r) => r.request_id && r.inject_result === undefined)) : null;
      if (row) row.inject_result = { t, ok: payload?.ok, mode: payload?.mode, code: payload?.code };
      if (settler && !row?.terminal) return;
      injectResultAtPhone = { t, ok: payload?.ok, mode: payload?.mode, code: payload?.code };
      resolveDone('inject_result');
    } else if (event !== 'stt:level') ev.other.push({ t, event, payload: event === 'stt:engine-status' || event === 'audio:auto-stopped' ? payload : undefined });
  };
  const onPcAny = (event, payload) => {
    const t = performance.now();
    if (event === 'inject:request') {
      const row = rowByRequest.get(payload?.request_id);
      if (row) row.inject_at_pc_t = t;
      if (!settler || row?.terminal) injectAtPc = { t, chars: (payload?.text ?? '').length, text: payload?.text };
      pc.emit('inject:result', { ok: true, mode: 'sendinput', entry_id: payload?.entry_id, request_id: payload?.request_id });
    } else if (event !== 'stt:level' && event !== 'stt:interim') ev.pc.push({ t, event });
  };
  phone.onAny(onAny);
  pc.onAny(onPcAny);

  // The harness is the phone AND the PC: if ITS event loop stalls, a frame
  // the relay sent on time is timestamped late on both ends, and the relay's
  // own `phone_turnaround_ms` grows with it. Measure the ruler: every record
  // carries this process's worst event-loop delay during the utterance.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const pcm = job.pcm;
  const totalMs = pcm.length / BYTES_PER_MS;
  const nFull = Math.floor(pcm.length / CHUNK_BYTES);
  const tPress = performance.now();
  // Per job (--jobs entries) or global: path 'pc' (delivery inject) | 'notes' (delivery none);
  // kind 'live' | 'auto_retry' (a recovery leg: ptt_backfill.dart beginBackfill at v0.3.107 sends
  // RecoveryIdentity.toStartFields + delivery none + send_policy direct).
  const path = job.path ?? (args.delivery === 'none' ? 'notes' : 'pc');
  const kind = job.kind ?? (args['live-stamp'] ? 'live' : null);
  const delivery = kind === 'auto_retry' || path === 'notes' ? 'none' : 'inject';
  const recId = `eval-${randomUUID()}#${Date.now()}`;
  const stamp = kind === 'live' ? { recording_id: recId, attempt_id: randomUUID(), attempt_kind: 'live', range_start_sample: 0, audio_format_version: 1 }
    : kind === 'auto_retry' ? { recording_id: recId, job_id: randomUUID().replace(/-/g, ''), attempt_id: randomUUID(), operation_id: randomUUID().replace(/-/g, ''), attempt_kind: 'auto_retry', range_start_sample: 0, range_end_sample: pcm.length / 2, audio_format_version: 1 } : {};
  phone.emit('audio:start', {
    ...stamp, send_policy: 'direct',
    // --live-stamp (card SEG-1b): what every press of a phone with first-frame
    // retention sends (the default since RC-1) — mobile `liveStartFields`,
    // apps/mobile/lib/src/session/recovery_identity.dart, spread FIRST as
    // `pttDown` does (ptt_edges.dart). Without it this harness sends the stamp
    // of a phone that predates LS-1b, and SEG-1 was A/B'd on exactly that.
    // --delivery none: the Notes (record-only) press (destination_controller.dart).
    sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', delivery, source_lang: lang,
    prefs: { 'stt.polish': job.strength === 'off' ? { enabled: false } : { enabled: true, strength: job.strength } },
  });
  let seq = 0;
  // card IDLE-1 — `stallN`: every chunk captured at or after the stall point is held back
  // N s (relay-audio.mjs), so the backlog leaves in a burst when the "network" comes back.
  const stallAt = job.stall ? job.stall.at_ms : Infinity, stallMs = job.stall ? job.stall.ms : 0;
  const lagFor = (endMs) => (endMs > stallAt ? stallMs : 0);
  for (let k = 0; k < nFull; k++) {
    await sleepUntil(tPress + (k + 1) * CHUNK_MS + lagFor((k + 1) * CHUNK_MS));
    phone.emit('audio:chunk', { seq: seq++, ts_ms: Date.now(), data_b64: pcm.subarray(k * CHUNK_BYTES, (k + 1) * CHUNK_BYTES).toString('base64') });
  }
  await sleepUntil(tPress + totalMs + lagFor(totalMs));
  if (pcm.length > nFull * CHUNK_BYTES) phone.emit('audio:chunk', { seq: seq++, ts_ms: Date.now(), data_b64: pcm.subarray(nFull * CHUNK_BYTES).toString('base64') });
  const tRelease = performance.now();
  phone.emit('audio:stop', {});

  const timeout = setTimeout(() => resolveDone('timeout'), 30_000);
  // A terminal stt:error (retryable:false) with no final: the phone closes PROCESSING on it (ptt_inbound.dart, GA-03 ②).
  const errWatch = setInterval(() => { if (terminal === null && ev.errors.some((e) => e.retryable === false) && performance.now() - tRelease > 2000) resolveDone('terminal_error'); }, 200);
  const endReason = await done;
  clearTimeout(timeout); clearInterval(errWatch);
  await new Promise((r) => setTimeout(r, 400)); // let trailing log lines land
  phone.offAny(onAny); pc.offAny(onPcAny);
  loopDelay.disable();
  const tEnd = performance.now();

  const logs = relay.between(tPress - 50, tEnd).map((l) => ({ dt: Math.round(l.t - tPress), level: l.level, msg: l.msg ?? l.raw, fields: l.fields ?? undefined }));
  const latencySeg = logs.filter((l) => l.msg === 'latency.segment').map((l) => l.fields);
  const counts = {};
  for (const l of logs) counts[l.msg] = (counts[l.msg] ?? 0) + 1;
  const speechAt = tPress + job.speech_at_ms;
  const firstInterim = ev.interims.find((i) => i.text.trim()) ?? null;
  const rel = (t) => (t === null || t === undefined ? null : Math.round(t - tRelease));
  return {
    id: job.item.id, lang: job.item.lang, scenario: job.scenario, strength: job.strength, path, kind, delivery,
    audio_ms: Math.round(totalMs), speech_at_ms: job.speech_at_ms, pause: job.pause ?? null, stall: job.stall ?? null, end: endReason,
    harness_loop_delay_max_ms: Math.round(loopDelay.max / 1e6),
    interims_n: ev.interims.length,
    first_interim_from_speech_ms: firstInterim ? Math.round(firstInterim.t - speechAt) : null,
    first_interims: ev.interims.filter((i) => i.text.trim()).slice(0, 4).map((i) => ({ dt: Math.round(i.t - tPress), seg: i.seg, text: i.text })),
    finals: ev.finals.map((f) => ({ dt_release: rel(f.t), seg: f.segment_idx, is_segment: f.is_segment, text: f.text, polish: f.polish, polish_reason: f.polish_reason, duration_ms: f.duration_ms, empty_reason: f.empty_reason })),
    text: joinSegments(segs),
    last_interims: Object.fromEntries(lastInterim),
    llm_tap: tap ? tap.between(tPress - 50, tEnd) : null,
    ...(settler ? recordedRows(settler, tap ? tap.between(tPress, tEnd) : null, tPress, rel, ev) : {}),
    terminal_text: terminal?.text ?? null,
    polish: terminal?.polish ?? null, polish_reason: terminal?.polish_reason ?? null,
    errors: ev.errors.map((e) => ({ ...e, t: undefined, dt: Math.round(e.t - tPress) })),
    other: ev.other.map((o) => ({ dt: Math.round(o.t - tPress), event: o.event, payload: o.payload })),
    pc_events: ev.pc.map((o) => ({ dt: Math.round(o.t - tPress), event: o.event })),
    release_to_final_ms: rel(terminal?.t),
    release_to_inject_sent_ms: rel(injectSentAt),
    release_to_inject_at_pc_ms: rel(injectAtPc?.t),
    inject_at_pc_text: injectAtPc?.text ?? null,
    inject_text: injectText,
    inject_result: injectResultAtPhone ? { ...injectResultAtPhone, t: undefined } : null,
    latency_segment: latencySeg[0] ?? null,
    polish_timing: logs.find((l) => l.msg === 'stt.polish.timing')?.fields ?? null,
    // INC-1c/1f: every polish call (phase whole | spec | release) and every polished final's wait.
    polish_calls: logs.filter((l) => l.msg === 'stt.polish.timing').map((l) => l.fields),
    polish_finals: logs.filter((l) => l.msg === 'stt.polish.final').map((l) => l.fields),
    polish_guard: logs.find((l) => l.msg === 'stt.polish.guard')?.fields ?? null,
    audio_intake: logs.find((l) => l.msg === 'audio intake')?.fields ?? null,
    cuts: logs.filter((l) => l.msg === 'stt.cut').map((l) => ({ dt: l.dt, ...l.fields })),
    log_counts: counts,
    log_notable: logs.filter((l) => l.level === 'WARN' || l.level === 'ERROR' || NOTABLE.test(l.msg)).slice(0, 200),
  };
}

const workers = Number(args.concurrency ?? 1);
const shards = Array.from({ length: Math.min(workers, jobs.length) }, () => []);
jobs.forEach((j, i) => shards[i % shards.length].push(j));
const started = [];
let failed = 0;
process.on('SIGINT', async () => { for (const r of started) await r.stop(); process.exit(130); });

// 🔴 ONE RELAY PROCESS PER DISTINCT ITEM TEXT. server-core caches polish
// results in process (stt.polish.timing outcome 'cache_hit', measured on the
// first smoke run: the second scenario of the same item came back in 0 ms
// without an LLM call). A worker therefore restarts its relay before it would
// run an item that process has already heard, so every polish in the report
// is a real call. Each record carries relay_seq (0 = that process's first
// utterance, which pays the cold Soniox/DeepSeek connects).
async function openRelay(wi, n) {
  const home = join(runDir, `w${wi}-${n}`);
  const tap = useTap ? await tapFor(wi) : null;
  const relay = startRelay({ serverCoreDir: serverCore, sttCloudDir: sttCloud, home, keys, extraEnv: tap ? { ...relayEnv, FLOWMIC_MANAGED_LLM_ENDPOINT: tap.url } : relayEnv });
  started.push(relay);
  const port = await relay.ready;
  const { pc, mobile, pair, reg } = await registerAndPair(`http://127.0.0.1:${port}`);
  return { phone: mobile, pc, pcId: pair.pc_id ?? reg.pc_id, relay, tap, home, port, seen: new Set(), seq: 0 };
}
async function closeRelay(w) {
  try { w.pc.close(); w.phone.close(); } catch { /* already gone */ }
  await w.relay.stop();
  writeFileSync(join(w.home, 'server.log'), w.relay.lines.map((l) => `${Math.round(l.t)} ${l.raw ?? `[${l.iso}] ${l.level} ${l.msg}${l.fields ? ' ' + JSON.stringify(l.fields) : ''}`}`).join('\n'));
  if (!args['keep-home']) for (const f of ['flowmic-eval.db', 'flowmic-eval.db-wal', 'flowmic-eval.db-shm']) rmSync(join(w.home, f), { force: true });
}

await pool(shards, shards.length, async (shard, wi) => {
  let n = 0;
  let w = null;
  try {
    for (const job of shard) {
      if (w && w.seen.has(job.item.id)) { await closeRelay(w); w = null; }
      if (!w) { w = await openRelay(wi, n++); console.log(`[run-relay] worker ${wi}: local relay pid ${w.relay.pid} on 127.0.0.1:${w.port}`); }
      w.seen.add(job.item.id);
      let rec;
      try { rec = { ...(await runOne(w, job)), relay_seq: w.seq++, relay_pid: w.relay.pid }; } catch (e) { failed++; rec = { id: job.item.id, scenario: job.scenario, strength: job.strength, harness_error: String(e?.stack ?? e) }; }
      // INC-1: count the calls the relay actually made (speculation makes several per utterance).
      const calls = (rec.polish_calls ?? []).filter((c) => c.outcome !== 'cache_hit' && c.outcome !== 'empty_input').reduce((a, c) => a + (c.attempts ?? 1), 0);
      // POL-2: with --llm-tap the ledger also carries the vendor-reported tokens of this utterance's calls.
      const tok = (rec.llm_tap ?? []).reduce((t, c) => ({ in: t.in + (c.usage?.in ?? 0), out: t.out + (c.usage?.out ?? 0) }), { in: 0, out: 0 });
      recordUsage({ kind: 'relay', id: job.item.id, scenario: job.scenario, soniox_audio_sec: +(job.pcm.length / 32000).toFixed(2), llm_calls: rec.polish_calls ? calls : 1, ...(rec.llm_tap ? { llm_in_tokens: tok.in, llm_out_tokens: tok.out } : {}) }, LEDGER);
      appendFileSync(out, JSON.stringify(rec) + '\n');
      const errs = rec.errors?.map((e) => e.code).join(',') || '-';
      console.log(`[run-relay] w${wi} ${job.item.id} ${job.scenario}/${job.strength}: ${rec.end ?? 'harness_error'} rel→final ${rec.release_to_final_ms ?? 'n/a'} ms, rel→PC ${rec.release_to_inject_at_pc_ms ?? 'n/a'} ms, polish ${rec.polish ?? '-'}${rec.polish_reason ? `(${rec.polish_reason})` : ''}, errors ${errs}`);
      await new Promise((res) => setTimeout(res, 300));
    }
  } finally {
    if (w) await closeRelay(w);
  }
});
for (const t of taps.values()) await t.stop();
console.log(`[run-relay] wrote ${out}${failed ? ` (${failed} harness errors)` : ''}; server logs in ${runDir}/w*/server.log`);

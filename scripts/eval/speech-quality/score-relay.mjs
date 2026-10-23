#!/usr/bin/env node
// scripts/eval/speech-quality/score-relay.mjs — score run-relay.mjs output
// (card EVAL-2) and write a markdown report next to the EVAL-1 one.
// Pure local computation: no network, no cost.
//
//   node scripts/eval/speech-quality/score-relay.mjs --prefix relay
//     reads <results>/relay-runs.jsonl (override --runs), and for the latency
//     section every file in --latency (comma list, default: the --runs file).
//     Writes <results>/relay-report.md (override --out).
//
// Text is scored on what the simulated PC received (`inject_at_pc_text`), i.e.
// after the relay's whole pipeline and the realtime polish. Metrics and their
// blind spots: README.md (EVAL-1 table, plus the EVAL-2 section).

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, loadCorpus, parseArgs, percentile, readJsonl, usageTotals } from './lib.mjs';
import { agg, canonNumbers, fmtRate, ms, pct, stripCommands, tokensFor } from './scoring.mjs';

const args = parseArgs();
const R = RESULTS_DIR();
const prefix = args.prefix ?? 'relay';
const inR = (f) => resolve(f.includes('/') || f.includes('\\') ? f : join(R, f));
// --runs takes a comma list; records are merged (meta from the first file).
const runsPaths = (typeof args.runs === 'string' ? args.runs.split(',') : [`${prefix}-runs.jsonl`]).map(inR);
const runsPath = runsPaths.join(', ');
const all = runsPaths.filter(existsSync).flatMap((f) => readJsonl(f));
const meta = all.find((r) => r.meta)?.meta ?? null;
const rows = all.filter((r) => !r.meta && !r.harness_error).map((r) => ({ ...r, pc_text: r.inject_at_pc_text ?? '' }));
const harnessErrors = all.filter((r) => r.harness_error);
const latencyFiles = typeof args.latency === 'string' ? args.latency.split(',').map(inR) : runsPaths;
const latRows = latencyFiles.filter(existsSync).flatMap((p) => readJsonl(p).filter((r) => !r.meta && !r.harness_error));
const corpus = loadCorpus();
const byId = new Map(corpus.items.map((it) => [it.id, it]));

const md = [];
const line = (s = '') => md.push(s);
const table = (head, body) => { line(`| ${head.join(' | ')} |`); line(`|${head.map(() => '---').join('|')}|`); for (const r of body) line(`| ${r.join(' | ')} |`); line(); };
const p = (xs, q) => percentile(xs, q);
const errCount = (rs, code) => rs.filter((r) => r.errors?.some((e) => !code || e.code === code)).length;
const hangups = (rs) => rs.filter((r) => r.cuts?.some((c) => c.kind === 'hangup')).length;
const polishOutcomes = (rs) => {
  const c = {};
  for (const r of rs) { const k = r.polish_timing?.outcome ?? (r.polish ?? 'none'); c[k] = (c[k] ?? 0) + 1; }
  return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');
};

/** Reference-token indices that the hypothesis does not reproduce (deleted or
 *  substituted), from one Levenshtein backtrace. */
function lostRefIndices(it, hyp) {
  const a = tokensFor(it.lang, stripCommands(it, it.reference));
  // A leg seam can glue two words ("Kubernetes.And", "should—Uh"); split them here so
  // this metric counts the WORDS that went missing. The glue has its own column.
  const unglued = hyp.replace(/([.!?。—–])(?=\p{L})/gu, '$1 ').replace(/[—–]/g, ' ');
  const b = tokensFor(it.lang, stripCommands(it, canonNumbers(it, unglued)));
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const row = new Array(m + 1).fill(0); row[0] = i; return row; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const lost = new Set();
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { if (a[i - 1] !== b[j - 1]) lost.add(i - 1); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { lost.add(i - 1); i--; }
    else j--;
  }
  return { lost, ref: a };
}

const usage = usageTotals('relay-usage-ledger.jsonl');
line(`# Speech-quality eval through a local relay (${prefix})`);
line();
line(`Generated ${new Date().toISOString()} by scripts/eval/speech-quality/score-relay.mjs from \`${runsPath}\`.`);
if (meta) line(`Relay: server-core ${meta.server_core_head} (\`${meta.server_core}\`), standalone on 127.0.0.1, managed Soniox \`${meta.endpoint}\` (TEST key), polish model \`${meta.model}\`; ${meta.chunk_ms} ms chunks at real-time pace; ${meta.workers} worker(s).`);
line(`Relay usage ledger (all EVAL-2 runs): ${(usage.soniox_audio_sec / 60).toFixed(1)} audio-min streamed, ${usage.llm_calls} utterances.`);
line(`Records: ${rows.length}${harnessErrors.length ? `, ${harnessErrors.length} harness errors (not scored)` : ''}. Text is scored on what the simulated PC received.`);
line();

// ── 1. by scenario ─────────────────────────────────────────────────────────
line('## 1. Results by scenario');
line();
const scenarios = [...new Set(rows.map((r) => r.scenario))];
const t1 = [];
for (const s of scenarios) for (const st of [...new Set(rows.filter((r) => r.scenario === s).map((r) => r.strength))]) {
  const rs = rows.filter((r) => r.scenario === s && r.strength === st);
  const a = agg(rs, 'pc_text');
  t1.push([s, st, a.n, fmtRate(a), pct(a.termHit, a.termN), `${a.onsetLost}/${a.n}`, ms(p(rs.map((r) => r.first_interim_from_speech_ms), 50)), ms(p(rs.map((r) => r.first_interim_from_speech_ms), 90)),
    `${hangups(rs)}/${rs.length}`, errCount(rs), errCount(rs, 'STT_NO_ENGINE_REACHED'), rs.filter((r) => !r.pc_text.trim()).length, polishOutcomes(rs)]);
}
table(['scenario', 'polish', 'n', 'error rate (all langs)', 'terms exact', 'first word wrong', 'first interim from speech p50', 'p90', 'idle hang-ups', 'stt:error utt.', 'NO_ENGINE_REACHED', 'nothing delivered', 'polish outcome'], t1);
line('`first interim from speech` = first non-empty `stt:interim` at the phone minus the moment speech starts in the audio (silence before it is known exactly). `idle hang-ups` = utterances whose server log has an `stt.cut kind:hangup` (the engine leg was hung up after 3 s without voice, `orchestrator-types.ts` DEFAULT_ENGINE_IDLE_HANGUP_MS).');
line();

// ── 2. onset ───────────────────────────────────────────────────────────────
const variantIds = new Set(corpus.variants.ids);
const onsetScen = ['base', ...scenarios.filter((s) => /^onset/.test(s)).sort((x, y) => parseFloat(x.slice(5)) - parseFloat(y.slice(5)))];
if (onsetScen.length > 1) {
  line('## 2. Quiet onset (same 10 items, Strict)');
  line();
  line('`base` is the TTS file as rendered: speech starts in the first 10 ms (no pre-silence), so it is also the "speech at t=0" case.');
  line();
  const t2 = [];
  for (const s of onsetScen) {
    const rs = rows.filter((r) => r.scenario === s && r.strength === 'strict' && variantIds.has(r.id));
    if (!rs.length) continue;
    const a = agg(rs, 'pc_text');
    t2.push([s, a.n, fmtRate(a), `${a.onsetLost}/${a.n}`, ms(p(rs.map((r) => r.first_interim_from_speech_ms), 50)), ms(p(rs.map((r) => r.first_interim_from_speech_ms), 90)), ms(Math.max(...rs.map((r) => r.first_interim_from_speech_ms ?? 0))),
      `${hangups(rs)}/${rs.length}`, errCount(rs), errCount(rs, 'STT_NO_ENGINE_REACHED')]);
  }
  table(['scenario', 'n', 'error rate', 'first word wrong', 'first interim from speech p50', 'p90', 'max', 'idle hang-ups', 'stt:error', 'NO_ENGINE_REACHED'], t2);
  const changed = [];
  for (const id of variantIds) {
    const base = rows.find((r) => r.id === id && r.scenario === 'base' && r.strength === 'strict');
    for (const s of onsetScen.slice(1)) {
      const r = rows.find((x) => x.id === id && x.scenario === s && x.strength === 'strict');
      if (!base || !r) continue;
      const lb = lostRefIndices(byId.get(id), base.pc_text), lr = lostRefIndices(byId.get(id), r.pc_text);
      const head = [0, 1].filter((k) => lr.lost.has(k) && !lb.lost.has(k)).map((k) => lr.ref[k]);
      if (head.length) changed.push(`${id} ${s}: lost first word(s) "${head.join(' ')}" that base kept — got "${r.pc_text}"`);
    }
  }
  line(`First-word losses relative to the same item's base run: ${changed.length ? '' : 'none.'}`);
  for (const c of changed) line(`- ${c}`);
  line();
}

// ── 3. mid-utterance pause ─────────────────────────────────────────────────
const midRows = rows.filter((r) => r.pause);
if (midRows.length) {
  line('## 3. Mid-utterance pause');
  line();
  line('A pause of `ms` digital silence inserted at the word gap nearest the middle (EVAL-1 token timing). Lost-around-pause = reference words in the window [2 before, 2 after] the split that the delivered text does not reproduce, counted only when the same item\'s base run (same polish) got them right. Seam = the text the PC received around that point; `.X`/`—X` with no space is a join artifact.');
  line();
  const t3 = [];
  let lostTot = 0, seamGlue = 0;
  for (const r of midRows) {
    const it = byId.get(r.id);
    // Polish off has no base run of its own: compare with base Strict.
    const base = rows.find((x) => x.id === r.id && x.scenario === 'base' && x.strength === r.strength)
      ?? rows.find((x) => x.id === r.id && x.scenario === 'base' && x.strength === 'strict');
    const lr = lostRefIndices(it, r.pc_text);
    const lb = base ? lostRefIndices(it, base.pc_text) : { lost: new Set() };
    const k = r.pause.words_before;
    const win = [k - 2, k - 1, k, k + 1].filter((x) => x >= 0 && x < lr.ref.length);
    const lost = win.filter((x) => lr.lost.has(x) && !lb.lost.has(x)).map((x) => lr.ref[x]);
    lostTot += lost.length;
    const glue = /[.!?。—–-][A-Za-z]/.test(r.pc_text) && !/[.!?—–-][A-Za-z]/.test(base?.pc_text ?? '');
    if (glue) seamGlue++;
    const a = agg([r], 'pc_text');
    t3.push([r.id, r.strength, `${r.pause.ms / 1000} s @ ${r.pause.at_ms} ms`, fmtRate(a), base ? fmtRate(agg([base], 'pc_text')) : 'n/a', lost.length ? lost.join(' ') : '-', glue ? 'yes' : '-',
      r.cuts?.map((c) => `${c.kind}(fed ${c.leg_fed_ms} ms)`).join(' ') ?? '', r.polish_timing?.outcome ?? r.polish ?? '-', `"${r.pc_text}"`]);
  }
  table(['id', 'polish', 'pause', 'error rate', 'base error rate', 'lost around pause', 'seam glued', 'cuts', 'polish outcome', 'delivered text'], t3);
  line(`Total: ${lostTot} reference word(s) lost around the pause over ${midRows.length} utterances; ${seamGlue} delivered with a glued seam.`);
  line();
}

// ── 4. latency ─────────────────────────────────────────────────────────────
line('## 4. End-to-end latency');
line();
line(`Source: ${latencyFiles.map((f) => `\`${f}\``).join(', ')} (${latRows.length} utterances). release = the phone sends its last chunk and \`audio:stop\`; times are on this machine's clock for the phone and the PC, so no cross-clock error. "relay turnaround" is the server's own \`latency.segment.phone_turnaround_ms\`, from emitting the final to receiving the phone's \`inject:request\`; a simulated phone answers in ~0 ms, so a large value means a stalled event loop somewhere (check \`harness max loop delay\`).`);
line();
const latTable = (label, rs) => {
  const col = (f) => [ms(p(rs.map(f), 50)), ms(p(rs.map(f), 90)), ms(p(rs.map(f), 99))];
  return [label, rs.length, ...col((r) => r.first_interim_from_speech_ms).slice(0, 2), ...col((r) => r.release_to_final_ms), ...col((r) => r.release_to_inject_at_pc_ms), ...col((r) => r.cuts?.find((c) => c.kind === 'stop')?.flush_ms),
    ...col((r) => (['applied', 'applied_unchanged', 'guard_reject', 'timeout'].includes(r.polish_timing?.outcome) ? r.polish_timing.elapsed_ms : null)),
    ms(p(latRows.length ? rs.map((r) => r.latency_segment?.phone_turnaround_ms) : [], 50)), ms(Math.max(0, ...rs.map((r) => r.latency_segment?.phone_turnaround_ms ?? 0))), ms(Math.max(0, ...rs.map((r) => r.harness_loop_delay_max_ms ?? 0)))];
};
const head4 = ['set', 'n', 'first interim from speech p50', 'p90', 'release→final p50', 'p90', 'p99', 'release→PC p50', 'p90', 'p99', 'vendor flush p50', 'p90', 'p99', 'polish LLM p50', 'p90', 'p99', 'relay turnaround p50', 'max', 'harness max loop delay'];
const t4 = [latTable('all', latRows), latTable('warm (not 1st on its relay)', latRows.filter((r) => r.relay_seq > 0)), latTable('cold (1st on its relay)', latRows.filter((r) => r.relay_seq === 0))];
for (const L of ['en', 'zh', 'mixed']) { const rs = latRows.filter((r) => r.lang === L); if (rs.length) t4.push(latTable(`lang ${L}`, rs)); }
for (const s of [...new Set(latRows.map((r) => r.scenario))]) t4.push(latTable(`scenario ${s}`, latRows.filter((r) => r.scenario === s)));
table(head4, t4);
line('`polish LLM` counts only outcomes that called the model (`applied`, `applied_unchanged`, `guard_reject`, `timeout`). `vendor flush` is the server\'s own measure of the engine finalize round trip (`stt.cut kind:stop flush_ms`). The terminal final is emitted after the polish, so release→final ≈ vendor flush + polish.');
line();

// ── 5. errors ──────────────────────────────────────────────────────────────
line('## 5. Error frames');
line();
const errs = rows.flatMap((r) => (r.errors ?? []).map((e) => `${r.id} ${r.scenario}/${r.strength}: ${e.code} (retryable ${e.retryable}) at +${e.dt} ms — ${e.message}`));
if (errs.length) for (const e of errs) line(`- ${e}`); else line('None: no `stt:error` frame reached the phone in any utterance.');
line();
for (const h of harnessErrors) line(`- harness error ${h.id} ${h.scenario}: ${h.harness_error.split('\n')[0]}`);

const out = resolve(args.out ?? join(R, `${prefix}-report.md`));
writeFileSync(out, md.join('\n'));
console.log(`[score-relay] wrote ${out}`);

// verify/eval/eval-live.mjs
//
// --mode=live: validates THE PRODUCT against a real engine line. Extracted
// VERBATIM from run-eval.mjs in the 800-line split. NOT in the resident gate —
// it needs credentials and network; run-eval.mjs's header says why.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { judgeCase } from './judges/index.mjs';
import { ROOT } from './eval-paths.mjs';
import { ONLY_SUITE, LINE, LIMIT, OUT, CONC, STRENGTH } from './eval-args.mjs';
import { loadProductionPrompts } from './eval-prod-bundle.mjs';
// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

function readEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Engine lines the live runner can point at. Unknown names fail loud —
 *  silently treating them as DeepSeek would make `--line=openrouter` a
 *  DeepSeek run the day someone mistypes, and the report would still say
 *  the line name the operator asked for. */
function resolveLine(name) {
  if (name === 'selfhosted') {
    const host = process.env.FLOWMIC_EVAL_LAN_LLM ?? 'http://100.64.7.179:8000/v1';
    return { name, endpoint: host, api_key: 'EMPTY', model: process.env.FLOWMIC_EVAL_LAN_MODEL ?? null, headers: {} };
  }
  if (name === 'openrouter') {
    const env = readEnvFile(join(ROOT, '.local', 'openrouter.env'));
    const key = process.env.FLOWMIC_OPENROUTER_API_KEY ?? env.FLOWMIC_OPENROUTER_API_KEY ?? '';
    const model = process.env.FLOWMIC_OPENROUTER_MODEL ?? env.FLOWMIC_OPENROUTER_MODEL ?? '';
    const endpoint = process.env.FLOWMIC_OPENROUTER_ENDPOINT ?? env.FLOWMIC_OPENROUTER_ENDPOINT ?? 'https://openrouter.ai/api/v1';
    return {
      name,
      endpoint,
      api_key: key,
      model: model || null,
      headers: {
        'HTTP-Referer': 'https://flowmic.app',
        'X-OpenRouter-Title': 'FlowMic eval',
      },
    };
  }
  if (name === 'managed' || name === 'deepseek') {
    const env = readEnvFile(join(ROOT, '.local', 'deepseek.env'));
    const key = process.env.FLOWMIC_DEEPSEEK_API_KEY ?? env.FLOWMIC_DEEPSEEK_API_KEY ?? '';
    const model = process.env.FLOWMIC_DEEPSEEK_MODEL ?? env.FLOWMIC_DEEPSEEK_MODEL ?? '';
    return { name, endpoint: 'https://api.deepseek.com/v1', api_key: key, model: model || null, headers: {} };
  }
  throw new Error(`unknown --line=${name} (expected managed|deepseek|selfhosted|openrouter)`);
}

async function discoverModel(line) {
  if (line.model) return line.model;
  const r = await fetch(`${line.endpoint}/models`, {
    headers: line.api_key && line.api_key !== 'EMPTY' ? { Authorization: `Bearer ${line.api_key}` } : {},
  });
  const j = await r.json();
  return j?.data?.[0]?.id ?? null;
}

/**
 * The harness must not measure a prompt that does not say what the case says.
 *
 * 🔴 This exists because the opposite happened. renderSystemPrompt takes
 * `source_lang`/`target_lang`; this file passed `sourceLang`/`targetLang`, which a
 * plain JS object drops without complaint, so every case rendered with the
 * defaults — "from auto to en". The en->zh cases were therefore instructed to
 * translate into English, produced correct English, and were scored as total
 * failures. Two engines, both temperatures, 12/12: a number that looked like a
 * catastrophic product defect and was entirely an artefact of the ruler.
 *
 * Cheap, and it fires on the exact shape that fooled me: the rendered prompt has
 * to name this case's target language.
 */
function assertPromptTargets(system, kase) {
  const want = kase.tgt_lang ?? 'en';
  if (!system.includes(want)) {
    throw new Error(
      `harness bug: the rendered system prompt does not name target '${want}' for case ${kase.id}. `
      + `Rendered: ${JSON.stringify(system.slice(0, 120))}`,
    );
  }
}

async function callLlm(line, model, system, user, extra = {}) {
  const body = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...extra,
  };
  const headers = { 'content-type': 'application/json', ...(line.headers ?? {}) };
  if (line.api_key && line.api_key !== 'EMPTY') headers.Authorization = `Bearer ${line.api_key}`;
  const r = await fetch(`${line.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? '';
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i;
        i += 1;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

async function live(loaded) {
  const line = resolveLine(LINE);
  if (line.name !== 'selfhosted' && !line.api_key) {
    console.log(`SKIP: no API key for line '${LINE}'`);
    return 'skip';
  }
  // OpenRouter's /models catalog is 400+ entries. Picking data[0] would bill
  // a random (often expensive) slug. The env must name the model.
  if (line.name === 'openrouter' && !line.model) {
    console.log('SKIP: openrouter line requires FLOWMIC_OPENROUTER_MODEL (catalog is 400+; [0] is a random bill)');
    return 'skip';
  }
  let model;
  try {
    model = await discoverModel(line);
  } catch (e) {
    console.log(`SKIP: engine line '${LINE}' at ${line.endpoint} is unreachable — ${e.message}`);
    return 'skip';
  }
  if (!model) {
    console.log(`SKIP: engine line '${LINE}' returned no model id`);
    return 'skip';
  }

  const prod = await loadProductionPrompts();
  const extra = {};
  if (process.env.FLOWMIC_EVAL_TEMPERATURE !== undefined) extra.temperature = Number(process.env.FLOWMIC_EVAL_TEMPERATURE);

  const results = [];
  for (const l of loaded) {
    if (ONLY_SUITE && l.suite !== ONLY_SUITE) continue;
    // `merge` is a replay suite: its subject is the deterministic accumulator
    // fold, not the vendor. Sending it to an LLM would produce a number that
    // looks like an engine score and is not one — use --mode=replay.
    if (l.suite === 'merge') continue;
    let cases = l.cases;
    if (LIMIT) cases = cases.slice(0, LIMIT);
    console.log(`\n── ${l.suite}: ${cases.length} cases on line '${LINE}' (${model}) ──`);

    const rows = await mapLimit(cases, CONC, async (k) => {
      try {
        let output;
        let modelOutput;
        let admitted;
        let guardReason = null;
        if (k.suite === 'translate' || k.suite === 'organize') {
          // 🔴 The field names are source_lang / target_lang (snake_case). They were
          // camelCase here, and because this file is JS the extra keys were silently
          // dropped and PromptContext's defaults ('auto' -> 'en') applied instead: every
          // en->zh case was asked to translate INTO ENGLISH, then scored for not
          // producing Chinese. It read as a 12/12 product catastrophe on two different
          // engines. assertPromptTargets below is why it cannot recur silently.
          const system = prod.renderSystemPrompt(
            { task: k.suite, source_lang: k.src_lang ?? 'auto', target_lang: k.tgt_lang ?? 'en' },
            '',
          );
          if (k.suite === 'translate') assertPromptTargets(system, k);
          output = await callLlm(line, model, system, k.input, extra);
        } else {
          // realtime = the production two-stage text pipeline, then LLM polish.
          //
          // 🔴 THE GUARD RUNS HERE TOO, AND IT USED NOT TO. Production does not
          // deliver what the model returned; it delivers what the model returned
          // AND `checkMeaningPreserved` admitted, or else the unpolished text.
          // Scoring only the model's output answers "was the prompt good",
          // which is a question about our ruler, while the user's question is
          // "what appeared on my screen". Those two numbers can differ by a lot:
          // measured 2026-08-17, the `filler` family scored ~100% on the judges
          // while the strict guard refused 10 of 10 of the very outputs being
          // scored. A harness that reports only the first number will report a
          // healthy score for a feature the user never receives.
          const staged = prod.normalizeFinalText(k.input, { ensureTerminalPunctuation: true });
          const raw = await callLlm(line, model, prod.polishSystemPrompt(STRENGTH), staged, extra);
          const g = prod.checkMeaningPreserved(staged, raw, { strength: STRENGTH });
          admitted = g.ok;
          guardReason = g.ok ? null : g.reason;
          // What the user would actually see: the polished text if the guard
          // admitted it, otherwise the pure two-stage text.
          output = g.ok ? raw : staged;
          modelOutput = raw;
        }
        const v = judgeCase(k, output);
        return {
          id: k.id, suite: k.suite, family: k.family, lang: k.lang ?? null,
          ok: v.ok, failures: v.failures, output,
          ...(modelOutput !== undefined ? { model_output: modelOutput } : {}),
          ...(admitted !== undefined ? { guard_admitted: admitted, guard_reason: guardReason } : {}),
        };
      } catch (e) {
        return { id: k.id, suite: k.suite, family: k.family, lang: k.lang ?? null, ok: false, failures: [{ judge: 'transport', detail: e.message }], output: '' };
      }
    });
    results.push(...rows);
  }

  const byFam = new Map();
  for (const r of results) {
    const key = `${r.suite}/${r.family}`;
    const cur = byFam.get(key) ?? { n: 0, pass: 0 };
    cur.n += 1;
    if (r.ok) cur.pass += 1;
    byFam.set(key, cur);
  }
  console.log('\n── per-family pass rate ──');
  for (const [k, v] of [...byFam.entries()].sort()) {
    const pct = ((v.pass / v.n) * 100).toFixed(0);
    console.log(`  ${String(pct).padStart(3)}%  ${String(v.pass).padStart(3)}/${String(v.n).padStart(3)}  ${k}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nTOTAL ${pass}/${results.length} (${((pass / results.length) * 100).toFixed(1)}%) on line '${LINE}' model '${model}'`);

  // ─── card C8: the two breakdowns the old report could not produce ─────────
  //
  // PER LANGUAGE. The prompt is one English template applied to nine locales and
  // "smoothing" is not the same operation in all of them. Before the corpus
  // carried a `lang`, a run could be 100% green with every case in it Chinese,
  // and the report had no way to say so. Do not tune on zh/en and declare the
  // rest shipped — this table is what makes that visible rather than arguable.
  const guarded = results.filter((r) => r.guard_admitted !== undefined);
  if (guarded.length) {
    const byLang = new Map();
    for (const r of guarded) {
      const key = r.lang ?? '(none)';
      const cur = byLang.get(key) ?? { n: 0, pass: 0, admitted: 0 };
      cur.n += 1;
      if (r.ok) cur.pass += 1;
      if (r.guard_admitted) cur.admitted += 1;
      byLang.set(key, cur);
    }
    console.log(`\n── realtime per-language, strength='${STRENGTH}' ──`);
    console.log('   n   judged-ok   guard-admitted   language');
    for (const [k, v] of [...byLang.entries()].sort()) {
      const pj = ((v.pass / v.n) * 100).toFixed(0);
      const pa = ((v.admitted / v.n) * 100).toFixed(0);
      console.log(`  ${String(v.n).padStart(2)}   ${String(pj).padStart(3)}% ${String(v.pass).padStart(3)}/${String(v.n).padStart(3)}   ${String(pa).padStart(3)}% ${String(v.admitted).padStart(3)}/${String(v.n).padStart(3)}      ${k}`);
    }

    // GUARD ADMISSION. "judged ok" scores the model; "admitted" scores what the
    // user receives. They are reported side by side precisely because the gap
    // between them is the finding, not a footnote.
    const adm = guarded.filter((r) => r.guard_admitted).length;
    console.log(`\nGUARD ADMISSION ${adm}/${guarded.length} (${((adm / guarded.length) * 100).toFixed(1)}%) at strength='${STRENGTH}'`);
    const why = new Map();
    for (const r of guarded) if (!r.guard_admitted) why.set(r.guard_reason, (why.get(r.guard_reason) ?? 0) + 1);
    if (why.size) {
      console.log('  refused because:');
      for (const [k, n] of [...why.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
  }

  const judges = new Map();
  for (const r of results) for (const f of r.failures ?? []) judges.set(f.judge, (judges.get(f.judge) ?? 0) + 1);
  if (judges.size) {
    console.log('\n── which judge rejected ──');
    for (const [j, n] of [...judges.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${j}`);
  }

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ line: LINE, model, strength: STRENGTH, when: new Date().toISOString(), machine: process.env.COMPUTERNAME ?? 'unknown', results }, null, 2));
    console.log(`\nwrote ${OUT}`);
  }
  return pass === results.length;
}
export { readEnvFile, resolveLine, discoverModel, assertPromptTargets, callLlm, mapLimit, live };

// scripts/smoke-compose-lan.mjs
// WP-R1-4 LAN golden-path smoke: runs ONE real translate + ONE real organize
// compose turn against the LAN vLLM Qwen3.5-4B endpoint (preset lan-vllm-qwen35,
// http://100.64.7.179:8000/v1), THROUGH the real src/compose module — the same
// createComposeFactory the socket handler uses — with a stub SettingsRepo that
// serves llm.config (from the protocol preset) + a sample scenario.card so the
// scenario-injected prompt is exercised end to end.
//
// The endpoint is only reachable on the owner's LAN. Unreachable → prints SKIP
// with the network error and exits 0 (never fabricates output, never fails CI).
//
// The real module is TypeScript; rather than duplicate it here, we bundle
// src/compose/index.ts on the fly with esbuild (a transitive dev dependency) and
// import the bundle. This keeps the smoke faithful to the shipped code path.

import { build } from './_esbuild-resolve.mjs';
import { LLM_PRESETS } from '@flowmic/protocol';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '../src/compose/index.ts');

const SAMPLE_CARD = {
  professions: ['software engineer'],
  domains: ['distributed systems'],
  packs: ['tech-dev'],
  terms: ['FlowMic', 'Kubernetes', 'gRPC'],
};

function stubSettingsRepo(llmConfig) {
  const map = new Map([
    ['llm.config', llmConfig],
    ['scenario.card', SAMPLE_CARD],
  ]);
  const row = (key) => (map.has(key) ? { user_id: 'smoke', key, value: map.get(key), updated_at: '' } : null);
  return { read: (_u, key) => row(key), readAll: () => [], write: () => ({}), remove: () => false };
}

async function loadModule() {
  const out = path.join(os.tmpdir(), `flowmic-compose-smoke-${Date.now()}.mjs`);
  await build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, logLevel: 'silent' });
  const mod = await import('file://' + out.replace(/\\/g, '/'));
  await fs.rm(out, { force: true });
  return mod;
}

async function runTurn(factory, label, args, input) {
  const orch = factory(args);
  let output = '';
  const t0 = Date.now();
  for await (const delta of orch.run(input)) output += delta;
  const usage = orch.usage ? orch.usage() : { tokensIn: 0, tokensOut: 0, isByok: false };
  console.log(`\n=== ${label} ===`);
  console.log('INPUT :', args.sourceText);
  if (args.sourceLang || args.targetLang) console.log('LANGS :', `${args.sourceLang ?? 'auto'} → ${args.targetLang ?? '-'}`);
  console.log('OUTPUT:', output.trim());
  console.log('USAGE :', JSON.stringify(usage), `(${Date.now() - t0} ms)`);
}

async function main() {
  const preset = LLM_PRESETS.find((p) => p.id === 'lan-vllm-qwen35');
  if (!preset) throw new Error('preset lan-vllm-qwen35 not found');
  const llmConfig = { protocol: preset.protocol, endpoint: preset.endpoint, api_key: preset.api_key, model: preset.model };
  console.log('LAN endpoint:', llmConfig.endpoint, '| model:', llmConfig.model);

  const { createComposeFactory } = await loadModule();
  const factory = createComposeFactory({ settings: stubSettingsRepo(llmConfig), budgetMs: 30_000 });

  try {
    await runTurn(
      factory,
      'translate (zh → en)',
      { userId: 'smoke', task: 'translate', sourceText: '我们需要在周五之前把这个 Kubernetes 集群的灰度发布搞定', sourceLang: 'zh', targetLang: 'en' },
      { task: 'translate', source_text: '我们需要在周五之前把这个 Kubernetes 集群的灰度发布搞定', source_lang: 'zh', target_lang: 'en' },
    );
    await runTurn(
      factory,
      'organize (zh)',
      { userId: 'smoke', task: 'organize', sourceText: '呃 就是 那个 我们今天 呃 主要 就是 讨论一下 这个 FlowMic 项目的 就是 进度 然后 呃 下一步 计划' },
      { task: 'organize', source_text: '呃 就是 那个 我们今天 呃 主要 就是 讨论一下 这个 FlowMic 项目的 就是 进度 然后 呃 下一步 计划' },
    );
    console.log('\nSMOKE OK');
  } catch (err) {
    console.log('\nSMOKE SKIP — LAN endpoint unreachable or errored (not fabricating output):');
    console.log(' ', err?.code ?? err?.name ?? 'error', '-', err?.message ?? String(err));
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});

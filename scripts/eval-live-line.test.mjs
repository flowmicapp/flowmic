// Pins verify/eval/eval-live.mjs resolveLine — no network, no real key.
//
// The live runner used to treat every name that was not `selfhosted` as
// DeepSeek. Adding an OpenRouter line without failing unknown names would
// make `--line=openrouter` a DeepSeek run the day the branch is mistyped,
// and the report would still print the name the operator asked for.
//
// EXIT: 0 PASS, 1 FAIL.

import { resolveLine } from '../verify/eval/eval-live.mjs';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`ok    ${msg}`);
  }
}

const saved = {
  FLOWMIC_OPENROUTER_API_KEY: process.env.FLOWMIC_OPENROUTER_API_KEY,
  FLOWMIC_OPENROUTER_MODEL: process.env.FLOWMIC_OPENROUTER_MODEL,
  FLOWMIC_DEEPSEEK_API_KEY: process.env.FLOWMIC_DEEPSEEK_API_KEY,
  FLOWMIC_DEEPSEEK_MODEL: process.env.FLOWMIC_DEEPSEEK_MODEL,
};

process.env.FLOWMIC_OPENROUTER_API_KEY = 'test-openrouter-key-not-a-vendor-prefix';
process.env.FLOWMIC_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';
process.env.FLOWMIC_DEEPSEEK_API_KEY = 'test-deepseek-key-not-a-vendor-prefix';
process.env.FLOWMIC_DEEPSEEK_MODEL = 'deepseek-v4-flash';

try {
  const or = resolveLine('openrouter');
  assert(or.endpoint === 'https://openrouter.ai/api/v1', `openrouter endpoint is the official v1, got ${or.endpoint}`);
  assert(or.model === 'deepseek/deepseek-v4-flash', `openrouter model is the env slug, got ${or.model}`);
  assert(or.api_key === 'test-openrouter-key-not-a-vendor-prefix', 'openrouter key comes from the process env override, not the gitignored file');
  assert(or.headers['HTTP-Referer'] === 'https://flowmic.app', 'openrouter sends the attribution referer');

  const ds = resolveLine('deepseek');
  assert(ds.endpoint === 'https://api.deepseek.com/v1', `deepseek alias hits DeepSeek-direct, got ${ds.endpoint}`);
  assert(ds.model === 'deepseek-v4-flash', `deepseek-direct model is the vendor id, got ${ds.model}`);

  const managed = resolveLine('managed');
  assert(managed.endpoint === ds.endpoint, 'managed is the same pipe as deepseek (the production name)');

  const lan = resolveLine('selfhosted');
  assert(lan.api_key === 'EMPTY', 'selfhosted still uses the platform sentinel, not a cloud key');

  let threw = false;
  try { resolveLine('gemini'); } catch (e) {
    threw = /unknown --line=gemini/.test(e.message);
  }
  assert(threw, 'an unknown line name fails loud instead of silently becoming DeepSeek');
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nPASS');
process.exit(0);

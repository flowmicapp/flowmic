// Mock-billing golden-path smoke (mock-billing §8.3: MUST run UNLOCK_ALL=0):
// free → mockCheckout → mockConfirm → getQuota changes → mockExpire → back to
// free. Drives the HTTP gateway on the built server. Run:
//   node scripts/smoke-mock-billing.mjs   (after `pnpm build`)
//
// 🔴 NOBODY RUNS THIS. It is in no gate: not pre-commit (lint + types only), not
// `pnpm verify:delivery` (lint + types + clippy + golden), not `pnpm test`. It
// only executes when a human types the line above. Stated out loud rather than
// left to be discovered, because a test nobody calls is a façade's runtime
// version — it can be red for months and look fine (G12 was red from 0.2.4 to
// 0.2.17 for exactly this reason).
//
// ⚠️ THAT IS NOT HYPOTHETICAL HERE. Until 0.2.38 the three assertions below still
// pinned a RETIRED fair line and this file did not move with the table, so it
// would have failed on the first line anyone ran it on. The numbers have now been
// re-cut TWICE: 2026-08-01 down (free 10 / pro 60 / max 300) and 2026-08-02 back
// up (free 20 / pro 900 / max 3,000 min; tokens 1M / 20M / 100M — see
// docs/decisions/2026-08-02-b12-plan-minute-quota-resizing-options.md).
// If you change PLAN_LIMITS again, change the literals here too — they are
// literals on purpose (reading them back out of PLAN_LIMITS would make the
// assertion compare the table to itself and pass no matter what it says), which
// is the same discipline test/billing-state-machine.test.ts writes down.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function startServer() {
  return new Promise((resolveFn, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLOWMIC_MODE: 'saas', // saas so quota metering/enforcement is live too
        FLOWMIC_PORT: '0',
        // GA-15 made saas refuse to boot without an explicit db path, and this
        // script had not said one since — so it has been exiting at startup
        // ("server exited early (1)") for anyone who ran it. A hermetic smoke
        // WANTS ephemeral, so it says so out loud (same line the golden runner
        // carries). Found while wiring R4 ④; unrelated to it.
        FLOWMIC_DB_PATH: ':memory:',
        FLOWMIC_JWT_SECRET: 'smoke-secret-32-bytes-minimum-xxx',
        FLOWMIC_MOCK_BILLING: '1',
        FLOWMIC_MOCK_UNLOCK_ALL: '0', // §8.3: unlocked runs don't count as acceptance
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) resolveFn({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
}

const base = (port) => `http://127.0.0.1:${port}/api/billing`;
// R4 ④ (2026-07-31): saas resolves the http caller from the Bearer JWT and
// refuses (401) without one. This script used to drive the gateway anonymously
// and got away with it because every saas request was the constant user
// 'default' — i.e. it was smoke-testing a plan that belonged to nobody. It now
// signs an account in first and acts AS that account, which is also the only way
// the numbers below mean anything.
let AUTH = {};
async function signIn(port) {
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const body = { email: `smoke-${Date.now()}@flowmic.test`, password: 'longenough1' };
  const reg = await fetch(url('/api/register'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (reg.status !== 201) throw new Error(`/api/register status ${reg.status}`);
  const login = await fetch(url('/api/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (login.status !== 200) throw new Error(`/api/login status ${login.status}`);
  AUTH = { authorization: `Bearer ${(await login.json()).token}` };
}
async function get(port, path) {
  return (await fetch(`${base(port)}${path}`, { headers: AUTH })).json();
}
async function post(port, path, body) {
  return (await fetch(`${base(port)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body ?? {}) })).json();
}
const log = (step, data) => console.log(`  ${step.padEnd(26)} ${JSON.stringify(data)}`);

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const { child, port } = await startServer();
  console.log(`[mock-billing] server up on 127.0.0.1:${port} (UNLOCK_ALL=0)`);
  try {
    // The reverse case first — a gate only proves itself by refusing.
    const anon = await fetch(`${base(port)}/quota`);
    assert(anon.status === 401, `anonymous /quota should be 401, got ${anon.status}`);
    await signIn(port);
    console.log('[mock-billing] signed in — every call below acts as that account');

    const p0 = await get(port, '/plan');
    const q0 = await get(port, '/quota');
    log('initial plan', p0);
    log('initial quota', { stt_limit: q0.stt.limit_min, llm_limit: q0.llm.limit });
    // 2026-08-02 fair line: free 20 min / 1M tokens. The llm limit is asserted too
    // — a table edit that moved only one dimension used to slip through here.
    assert(p0.plan === 'free' && q0.stt.limit_min === 20, `starts free @ 20min, got ${q0.stt.limit_min}`);
    assert(q0.llm.limit === 1_000_000, `free llm limit 1M, got ${q0.llm.limit}`);

    const co = await post(port, '/checkout', { cycle: 'yearly' });
    log('mockCheckout(yearly)', co);
    const pPending = await get(port, '/plan');
    assert(pPending.state === 'pending' && pPending.plan === 'free', 'pending is not yet pro');

    const cf = await post(port, '/confirm', { sessionId: co.sessionId });
    log('mockConfirm', cf);
    const qPro = await get(port, '/quota');
    log('quota after confirm', { stt_limit: qPro.stt.limit_min, llm_limit: qPro.llm.limit });
    // 2026-08-02: pro 900 min / 20M tokens. ⚠️ The mock gateway only ever confirms
    // to 'pro' — 'max' has no mock trigger, so this script cannot cover the third
    // tier and does not pretend to.
    assert(cf.plan === 'pro' && qPro.stt.limit_min === 900, `confirmed → pro @ 900min, got ${qPro.stt.limit_min}`);
    assert(qPro.llm.limit === 20_000_000, `pro llm limit 20M, got ${qPro.llm.limit}`);

    const ex = await post(port, '/expire', {});
    log('mockExpire', ex);
    const qFree = await get(port, '/quota');
    log('quota after expire', { stt_limit: qFree.stt.limit_min });
    assert(
      ex.plan === 'free' && ex.state === 'expired' && qFree.stt.limit_min === 20,
      `expired → back to free @ 20min, got plan=${ex.plan} state=${ex.state} limit=${qFree.stt.limit_min}`,
    );

    console.log('[mock-billing] PASS');
  } finally {
    child.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[mock-billing] FAIL', err.message);
    process.exit(1);
  },
);

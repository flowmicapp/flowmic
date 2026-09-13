// G30's FIXTURES — the constants this golden pins and the two local servers it
// needs, VERBATIM out of `g30-payer-matrix.mjs`.
//
// WHY A MODULE: that file crossed the 800-line cap (verify/lint `file-size`)
// when card MP-10 inverted its first four sections and kept both the old
// assertion and the new one on the record. NO ASSERTION AND NO COMMENT WAS
// DELETED to fit; what moved is the part that asserts nothing — numbers with
// their arguments, and two stub servers.
//
// 🔴 THE NUMBERS KEEP THEIR OWN REASONS. Every one of them is pinned rather
// than imported from the product on purpose (`TRIAL_GRANT_MS` says so in as many
// words), and a constant that arrived here without its paragraph would be a
// magic number in a test that exists to measure money.

import { createServer } from 'node:http';
// card MP-11 — `makeBaseEnv` spreads it; the harness owns the file-mail wiring.
import { mailFileEnv } from './harness.mjs';

/** Both accounts sit on this ceiling. Pushed through the PRODUCTION override
 *  (`FLOWMIC_PLAN_LIMITS`, read by config.ts before any socket exists) rather
 *  than taken from the default table, so a relay answering from a compiled-in
 *  literal cannot pass by coincidence. */
export const PLAN_MINUTES = 5;
export const PLAN_MS = PLAN_MINUTES * 60_000;

/** The head-room left on the payer's ledger before the recording — small enough
 *  to spend in a second, large enough for a heartbeat to land inside it. */
export const SEEDED_HEADROOM_MS = 1_500;
/** What is left of the site-demo visitor's own lifetime grant. Deliberately
 *  SMALLER than `SEEDED_HEADROOM_MS`: it is the only thing that makes 「the cap
 *  decided this number」 distinguishable from 「the account did」. */
export const CAP_HEADROOM_MS = 800;
/** `TRIAL_LIFETIME_GRANT_MS` — the per-browser lifetime grant this golden seeds
 *  against. Not imported: a golden runs the built relay, and pinning the value
 *  here means a change to it shows up as a FAILURE to explain rather than as a
 *  test that quietly re-derives whatever the code now says. */
export const TRIAL_GRANT_MS = 120_000;
export const HEARTBEAT_MS = 300;
/** card MP-9 — what the stub vendor reports it billed. Two DIFFERENT numbers, so
 *  a wiring that forwarded one of them twice cannot pass. */
export const LLM_TOKENS_IN = 37;
export const LLM_TOKENS_OUT = 41;

export const OWNER_EMAIL = 'g30-owner-a@flowmic.test';
export const PHONE_EMAIL = 'g30-phone-b@flowmic.test';
/** card MP-6 — the account FlowMic's public site demo is charged to. A REAL
 *  users row: owner §11 asks that the demo's spend be lookup-able, which an
 *  anonymous grant never was. */
export const DEMO_PAYER_EMAIL = 'g30-flowmic-demo@flowmic.test';
/** The browser identities. `wb-…` is what a real page keeps in localStorage. */
export const GUEST_UID = 'wb-a1b2c3d4e5f60718';
export const DEMO_UID = 'wb-fedcba9876543210';
export const SITE_ORIGIN = 'http://localhost:5173';

export const POOL = JSON.stringify([{
  id: 'g30-unreachable', provider: 'custom-openai-compatible', model: 'g30',
  api: 'http://127.0.0.1:9/v1', api_key: 'g30', enabled: true, priority: 1,
}]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);

/** Cloudflare's siteverify, locally — the demo-room arm posts to it. Copied in
 *  shape from G26, which is the golden that owns that arm. */
export function startSiteverifyStub() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: !body.includes('response=bad') }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/**
 * card MP-9 — a minimal openai-compatible SSE endpoint, so this golden can
 * observe a REAL `usage_events` row of `kind:'llm'`.
 *
 * 🔴 IT HAS TO BE A SERVER RATHER THAN A SEAM. Every other LLM endpoint in the
 * golden set points at `http://127.0.0.1:9`, which answers nothing: a compose
 * turn there reports no tokens, `recordLlmUsage` early-returns on the all-zero
 * report, and the row this section is about is never written. The defect MP-9
 * closes lives on a row that only exists when a vendor actually answered.
 *
 * The reply is deliberately IN THE TARGET SCRIPT: an echo of the English source
 * trips the output guard (`target_script_absent`), which bills the same tokens
 * but ends the turn on `compose:error` — and a golden that could not tell those
 * two apart would report the wrong thing when either broke.
 */
export function startLlmStub() {
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: '季度报告周五上午到期。' } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: LLM_TOKENS_IN, completion_tokens: LLM_TOKENS_OUT } }),
    '[DONE]',
  ];
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const f of frames) res.write(`data: ${f}\n\n`);
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/**
 * The ledger probes and the microphone, bound to one open database.
 *
 * 🔴 A FACTORY RATHER THAN FREE FUNCTIONS: this golden restarts its relay
 * onto the SAME sqlite file half way through, and every probe below must go on
 * reading that one handle. Handing them the connection once is what stops a
 * later section from opening a second one and reading a snapshot.
 *
 * VERBATIM out of `g30-payer-matrix.mjs` when card MP-10 pushed that file over
 * the 800-line cap. No behaviour moved with the code.
 */
export function makeProbes(db) {
  const events = (userId) => db.prepare(
    "SELECT * FROM usage_events WHERE user_id=? AND kind='stt' AND outcome='ok' ORDER BY id",
  ).all(userId);
  const anonCount = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get().n;

  const usageOf = (userId) => db.prepare('SELECT * FROM usage_records WHERE user_id=?').all(userId);
  const spentMinutes = (userId) => usageOf(userId)[0]?.stt_minutes ?? 0;
  const periodKeyOf = (userId) => {
    const created = db.prepare('SELECT created_at FROM users WHERE id=?').get(userId).created_at;
    return new Date(`${String(created).replace(' ', 'T')}Z`).toISOString().slice(0, 10);
  };
  const seedUsedMs = (userId, usedMs) => db.prepare(
    `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
     VALUES (?,?,?,0,0,?)
     ON CONFLICT(user_id,month) DO UPDATE SET stt_minutes=excluded.stt_minutes`,
  ).run(userId, periodKeyOf(userId), usedMs / 60_000, new Date().toISOString());
  const pcm = Buffer.alloc(3_200).toString('base64');
  const START = {
    sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
    mode: 'realtime', delivery: 'inject', source_lang: 'en',
  };
  const speak = async (socket, forMs) => {
    let seq = 0;
    const pump = setInterval(() => socket.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
    try {
      socket.emit('audio:start', START);
      await sleep(forMs);
    } finally {
      clearInterval(pump);
    }
  };
  return { events, anonCount, usageOf, spentMinutes, periodKeyOf, seedUsedMs, START, speak };
}

// ── card MP-11 (2026-09-11) — `baseEnv`, VERBATIM out of g30-payer-matrix.mjs
// for the same reason everything above it is here: that file crossed the
// 800-line cap again when MP-11 added `judged_account` to section 5, and this
// is the largest block in it that ASSERTS NOTHING. Not one line of reasoning
// was dropped; `turnstile.port` / `llm.port` / `dbPath` / `mailDir` became
// parameters because they are the only things it read from its old scope.
/**
 * The env both halves of this golden share.
 *
 * 🔴 `FLOWMIC_USAGE_EVENTS_ENABLED` IS ON HERE AND OFF IN PRODUCTION, and
 * that is not a cheat: the switch gates COLLECTION (a privacy promise), not
 * the columns this card adds. With it off the table stays empty and the two
 * new columns would be asserted by nothing at all — which is exactly how a
 * column ships written by nobody.
 */
export function makeBaseEnv({ dbPath, turnstilePort, llmPort, mailDir }) {
  return {
    FLOWMIC_DB_PATH: dbPath,
    FLOWMIC_STT_POOL: POOL,
    FLOWMIC_BUDGET_HEARTBEAT_MS: String(HEARTBEAT_MS),
    FLOWMIC_PLAN_LIMITS: JSON.stringify({ free: { stt_minutes: PLAN_MINUTES } }),
    FLOWMIC_USAGE_EVENTS_ENABLED: '1',
    FLOWMIC_WEB_ANON_ENABLED: '1',
    FLOWMIC_TURNSTILE_SECRET: 'g30-secret',
    FLOWMIC_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${turnstilePort}/siteverify`,
    FLOWMIC_TRIAL_IP_SALT: 'g30-salt',
    // card MP-9 — the PLATFORM's model, which is what makes the AI turn a
    // METERED one: a config the user authored would be judged BYOK
    // (compose/llm-config.ts resolveByokLlm) and move no counter at all.
    FLOWMIC_MANAGED_LLM_ENABLED: '1',
    FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
    FLOWMIC_MANAGED_LLM_ENDPOINT: `http://127.0.0.1:${llmPort}/v1`,
    FLOWMIC_MANAGED_LLM_MODEL: 'g30-llm',
    FLOWMIC_MANAGED_LLM_API_KEY: 'g30-llm-key',
    ...mailFileEnv(mailDir),
  };
}


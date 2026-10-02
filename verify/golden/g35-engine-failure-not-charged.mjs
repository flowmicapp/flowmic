// G35 — NR-138 item 5: a recording our engine FAILED on, with no usable transcript, is not charged; the same
// account's next recording, answered by the same engine, is. §3 (MAIN extension 2026-10-01): a relay killed
// mid-recording debits nothing.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 (the rule, the failure set, the log line)
//   docs/decisions/2026-10-01-owner-engine-failure-no-charge.md (owner ruling 2026-10-01)
//
// 🔴 WHY A GOLDEN ON TOP OF `apps/server-core/test/engine-failure-no-charge.test.ts`. That file proves the
// bridge → allowance → handler → tracker chain in one process, with a scripted orchestrator standing in for the
// engine. This one crosses every boundary production crosses and that file does not: the BUILT relay, the real
// `custom-openai-compatible` adapter speaking HTTP to an engine that answers 503, socket.io, and a sqlite FILE
// read back through a second connection. A no-charge rule that held in the unit chain but was lost in the dist
// (a stale build, an adapter that maps the refusal to a code outside the failure set) is green there and red here.
//
// 🔴 THE ZERO HAS A POSITIVE CONTROL, ON THE SAME LEDGER. Same relay, same account, same engine id switched back
// to answering: that press must be charged. Without it, "0 minutes" could mean "nothing meters in this fixture".
// And the failing press must have REACHED the engine (`engineRequests`): a press the engine never heard proves
// nothing about how a failure is billed.
//
// The engine switch is per case id (`stt-answering-engine.mjs` header): the pool cases share this process.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { answeringPool, setEngineFailing, engineRequests, ANSWERED_TEXT } from './stt-answering-engine.mjs';
import {
  startSaasServer, connect, ack, recordAll, saasJwt,
  mailFileDir, mailFileEnv, verifyRegisteredEmail, PASS, FAIL,
} from './harness.mjs';

const EMAIL = 'g35-not-charged@flowmic.test';
const ENGINE_ID = 'g35-engine';
const POOL = answeringPool(ENGINE_ID);

/** Book 22 §4.10's log line, and the failure codes a refused flush may surface as on this adapter. */
const NOT_CHARGED_LINE = 'usage: not charged — engine failure';
const FAILURE_CODES = new Set(['STT_ENGINE_TIMEOUT', 'STT_NETWORK_DROP']);

const AUDIO_START = {
  sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
  mode: 'realtime', delivery: 'inject', source_lang: 'en',
};
/** How long each press streams. Long enough to be a visible charge (≈ 0.02 min), short enough to stay cheap. */
const PRESS_MS = 1_200;
/** How long a press may take to reach its terminal frame and settle. */
const SETTLE_CEILING_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

export const G35 = {
  id: 'G35',
  name: 'engine failure with no usable transcript is not charged; the same account answered is charged (NR-138 item 5)',
  requires: [
    'apps/server-core/src/engine/stt-engine-failure.ts',
    'apps/server-core/src/engine/stt-session-allowance.ts',
    'apps/server-core/src/billing/usage-tracker.ts',
    'apps/server-core/src/engine/relay-lifecycle.ts',
  ],
  async fn() {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g35-'));
    const dbPath = path.join(dir, 'g35.sqlite');
    const mailDir = mailFileDir();
    let saas;
    let db;
    let pc;
    let mobile;
    let stderr = '';
    try {
      try {
        saas = await startSaasServer({ FLOWMIC_DB_PATH: dbPath, FLOWMIC_STT_POOL: POOL, ...mailFileEnv(mailDir) });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      saas.child.stderr.on('data', (d) => { stderr += d; });
      const url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);

      const jwt = await saasJwt(url, EMAIL);
      await verifyRegisteredEmail(url, jwt, mailDir, EMAIL);
      const userId = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL)?.id;
      if (!userId) return FAIL('the registered account has no users row');
      const usedMinutes = () => db.prepare('SELECT COALESCE(SUM(stt_minutes),0) AS m FROM usage_records WHERE user_id=?')
        .get(userId).m;
      const notChargedLines = () => stderr.split('\n').filter((l) => l.includes(NOT_CHARGED_LINE));

      pc = await connect(url, { jwt });
      const reg = await ack(pc, 'pc:register', { device_name: 'G35 PC', client_instance_id: 'inst-g35-0123456789ab' });
      mobile = await connect(url);
      const rec = recordAll(mobile);
      const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      if (pair.error) return FAIL(`mobile:pair refused: ${JSON.stringify(pair)}`);
      await sleep(200);

      /** One press: stream PRESS_MS of 100 ms frames, stop, wait for the terminal frame. */
      const press = async () => {
        rec.frames.length = 0;
        const pcm = Buffer.alloc(3_200).toString('base64');
        let seq = 0;
        const started = await ack(mobile, 'audio:start', AUDIO_START);
        if (started?.ok === false || started?.error) throw new Error(`audio:start refused: ${JSON.stringify(started)}`);
        const pump = setInterval(() => mobile.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
        try {
          await sleep(PRESS_MS);
        } finally {
          clearInterval(pump);
        }
        mobile.emit('audio:stop', {});
        const ended = await waitFor(
          () => rec.frames.some((f) => f.event === 'stt:error' || (f.event === 'stt:final' && f.args[0]?.is_segment !== true)),
          SETTLE_CEILING_MS,
        );
        if (!ended) throw new Error(`no terminal stt frame within ${SETTLE_CEILING_MS} ms`);
        return {
          errors: rec.frames.filter((f) => f.event === 'stt:error').map((f) => f.args[0]),
          finals: rec.frames.filter((f) => f.event === 'stt:final').map((f) => f.args[0]),
        };
      };

      // ── 1 · the engine refuses: the user gets no transcript and must not pay for it
      setEngineFailing(ENGINE_ID, true);
      const asked0 = engineRequests(ENGINE_ID);
      const failed = await press();
      if (engineRequests(ENGINE_ID) === asked0) {
        return FAIL('the failing press never reached the engine, so its zero below proves nothing about a failure');
      }
      const codes = failed.errors.map((e) => e?.code);
      if (!codes.some((c) => FAILURE_CODES.has(c))) {
        return FAIL(`the failing press surfaced ${JSON.stringify(codes)}, want one of ${[...FAILURE_CODES].join('/')}`);
      }
      if (failed.finals.some((f) => typeof f?.text === 'string' && f.text.trim() !== '')) {
        return FAIL(`the failing press delivered text ${JSON.stringify(failed.finals.map((f) => f.text))}: the fixture did not fail`);
      }
      // The settle is asynchronous to the error frame. Wait for EITHER witness of it — the not-charged line, or a
      // charge — so the persisted ledger, not the log, is the first verdict when the rule is broken.
      await waitFor(() => notChargedLines().length >= 1 || usedMinutes() > 0, SETTLE_CEILING_MS);
      await sleep(300);
      const afterFailure = usedMinutes();
      if (afterFailure !== 0) {
        return FAIL(`the failing press was charged ${afterFailure} min (book 22 §4.10: an engine failure with no usable transcript is not charged)`);
      }
      if (notChargedLines().length !== 1) {
        return FAIL(`want exactly 1 "${NOT_CHARGED_LINE}" line after the failing press, got ${notChargedLines().length}`);
      }

      // ── 2 · positive control: same account, same engine, answering — charged as before
      setEngineFailing(ENGINE_ID, false);
      const answered = await press();
      // `includes`, not equality: the final-text pipeline (normalizer) may punctuate what the engine said.
      if (!answered.finals.some((f) => typeof f?.text === 'string' && f.text.includes(ANSWERED_TEXT))) {
        return FAIL(`the answered press delivered ${JSON.stringify(answered.finals.map((f) => f?.text))}, want it to carry "${ANSWERED_TEXT}"`);
      }
      if (!(await waitFor(() => usedMinutes() > 0, SETTLE_CEILING_MS))) {
        return FAIL('positive control: the answered press was not charged either, so the zero above proves nothing');
      }
      const afterAnswer = usedMinutes();
      if (notChargedLines().length !== 1) {
        return FAIL(`the answered press logged "${NOT_CHARGED_LINE}" (now ${notChargedLines().length} lines)`);
      }

      // ── 3 · the relay dies mid-recording (MAIN extension 2026-10-01, book 22 §4.10): a hard kill never reaches
      // settle, the only debit site, and the allowance hold lives in memory — so nothing is debited. Sections 1–2
      // are this section's controls: the same ledger, read the same way, does move for an answered press.
      rec.frames.length = 0;
      const live = await ack(mobile, 'audio:start', AUDIO_START);
      if (live?.ok === false || live?.error) return FAIL(`§3 audio:start refused: ${JSON.stringify(live)}`);
      const pcm3 = Buffer.alloc(3_200).toString('base64');
      let seq3 = 0;
      const pump3 = setInterval(() => mobile.emit('audio:chunk', { seq: seq3 += 1, data_b64: pcm3, ts_ms: Date.now() }), 80);
      try {
        await sleep(PRESS_MS);
      } finally {
        clearInterval(pump3);
      }
      const exited = new Promise((resolve) => saas.child.once('exit', resolve));
      saas.child.kill('SIGKILL');
      await exited;
      const afterKill = usedMinutes();
      if (afterKill !== afterAnswer) {
        return FAIL(`a relay killed mid-recording moved the ledger ${afterAnswer} -> ${afterKill} min`);
      }

      return PASS(
        `failing press reached the engine, surfaced ${codes.join('/')}, logged "not charged" once and left the ledger at 0 min; `
        + `the answered press ("${ANSWERED_TEXT}") on the same account was charged ${afterAnswer.toFixed(4)} min; `
        + `a relay killed mid-recording (${seq3} chunks in) left it at ${afterKill.toFixed(4)} min`,
      );
    } catch (e) {
      return FAIL(e.message);
    } finally {
      setEngineFailing(ENGINE_ID, false);
      try { pc?.close(); } catch { /* already gone */ }
      try { mobile?.close(); } catch { /* already gone */ }
      try { db?.close(); } catch { /* the process is going away anyway */ }
      try { saas?.child.kill(); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    }
  },
};

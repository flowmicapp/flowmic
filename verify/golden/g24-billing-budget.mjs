// G24 — card S2-02: the transcription budget is PUSHED, it moves while somebody
// is speaking, it reaches zero, and the relay ends the recording itself.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.3 (the
//     four push points) / §1.5 (the `budget` field on a reconnect ack)
//   docs/strategy/2026-09-07-web-client-crosscheck-after-audio-durability.md §4.1
//     (`resets_at`, owner 2026-09-07 ruling (1))
//   apps/server-core/src/billing/budget-push.ts (WHOSE number this is)
//   packages/protocol/src/protocol-schemas-billing.ts (why this is not a second
//     refusal — `stt:error{QUOTA_EXCEEDED}` and `audio:auto-stopped
//     {reason:'quota_exhausted'}` keep that job)
//
// ── WHY THIS IS A GOLDEN AND NOT A UNIT TEST ───────────────────────────────
//
// Every piece of this chain has a unit test somewhere and the chain still had a
// hole nobody could see, because the pieces live in five layers: a socket
// handler reads the account, an AudioSession arms a wall-clock deadline off a
// number the billing guard computed, an emitter turns that deadline firing into
// a verdict, and a ledger written at settle decides whether the NEXT press is
// admitted. `apps/server-core/test/quota-limit-origin.test.ts` says so in as
// many words: "everything below runs on an in-memory database and a fake or
// 60 ms clock". This case runs a real relay process, a real sqlite file, real
// sockets and a real clock, and asserts the frames a client actually receives.
//
// ── WHAT IT DOES NOT NEED, AND WHY THAT MATTERS ────────────────────────────
//
// NO vendor STT engine and no LAN dependency, so this case never SKIPs. The
// route is a batch HTTP engine pointed at a closed port: its `open()` resolves
// without touching the network (stt/engines/custom-openai-compatible.ts), which
// is enough for `SttSessionBridge`'s constructor to reach `session.start()` and
// arm the quota deadline. The engine only fails later, at flush, and that
// failure is a different frame this case does not read.
// ⚠️ The measured ordering matters here: `deps.build(...)` runs BEFORE
// `session.start()`, so a route that fails to RESOLVE (no pool configured at
// all) would throw `SttConfigMissingError` and no session — and therefore no
// deadline — would exist. "No engine reachable" and "no engine configured" are
// two different worlds; this case needs the first one.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt,
  mailFileDir, mailFileEnv, verifyRegisteredEmail, PASS, FAIL,
} from './harness.mjs';

const EMAIL = 'g24-budget@flowmic.test';

/** The seeded head-room, in ms of transcription. Small enough that the whole
 *  case runs in seconds; large enough that the heartbeat below fires several
 *  times inside it, because "the number moves" is the assertion that separates
 *  a live session reading from a stale account reading. */
const SEEDED_BUDGET_MS = 1_500;
/** The while-streaming floor, overridden for this case only. Production is 10 s
 *  (DEFAULT_BUDGET_HEARTBEAT_MS); a golden that waited for it would spend half a
 *  minute proving something a shorter floor proves identically. */
const HEARTBEAT_MS = 300;

const AUDIO_START = {
  sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
  mode: 'realtime',
  // Bound for the PC, so the budget fan-out to the TARGET end applies. The
  // record-only counterpart is asserted separately in section 5 - it is the one
  // case where the target must be told NOTHING.
  delivery: 'inject',
  source_lang: 'en',
};

/** The same press, record-only: the PC was never told it began (GA-02). */
const AUDIO_START_RECORD_ONLY = { ...AUDIO_START, delivery: 'none' };

/** A batch HTTP route pointed at a closed port — see the header. */
const POOL = JSON.stringify([{
  id: 'g24-unreachable', provider: 'custom-openai-compatible', model: 'g24',
  api: 'http://127.0.0.1:9/v1', api_key: 'g24', enabled: true, priority: 1,
}]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);

export const G24 = {
  id: 'G24',
  name: 'billing:budget — pushed at join and at start, moves while streaming, hits zero, and the relay ends the recording',
  requires: [
    'packages/protocol/src/protocol-schemas-billing.ts',
    'apps/server-core/src/billing/budget-push.ts',
    'apps/server-core/src/socket/handlers/budget-frames.ts',
  ],
  async fn() {
    // The protocol package's own parser, read from the dist the relay was built
    // against. Frames are checked THROUGH it rather than by hand: an assertion
    // that reads `payload.remaining_ms` directly would still pass if the event
    // fell out of the whitelist, and the whitelist is half of what this card
    // added.
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent, BudgetViewSchema } = protocol;

    // The OS temp dir, the same place G17 puts its file database. A few KB of
    // sqlite is script output, not a tree - the no-dev-trees-on-the-system-drive
    // rule is about worktrees, dependency trees and build output.
    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g24-'));
    const dbPath = path.join(dir, 'g24.sqlite');
    const mailDir = mailFileDir();
    let saas;
    let db;
    try {
      try {
        saas = await startSaasServer({
          FLOWMIC_DB_PATH: dbPath,
          FLOWMIC_STT_POOL: POOL,
          FLOWMIC_BUDGET_HEARTBEAT_MS: String(HEARTBEAT_MS),
          ...mailFileEnv(mailDir),
        });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      const url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);

      const jwt = await saasJwt(url, EMAIL);
      await verifyRegisteredEmail(url, jwt, mailDir, EMAIL);
      const summary = await (await fetch(`${url}/api/cloud/summary`, {
        headers: { authorization: `Bearer ${jwt}` },
      })).json();
      if (!summary?.quota?.stt) return FAIL(`/api/cloud/summary gave no quota: ${JSON.stringify(summary).slice(0, 200)}`);
      const limitMin = summary.quota.stt.limit_min;
      const periodKey = summary.quota.month;
      // The SECOND source for `resets_at` — the HTTP surface the console reads.
      // Asserting the socket frame against it is the whole point: one fact, two
      // faces, and a mismatch means one of them is making it up.
      const periodEndMs = Date.parse(`${summary.quota.period.end}T00:00:00.000Z`);
      const userId = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL)?.id;
      if (!userId) return FAIL('the registered account has no users row');

      const setUsedMinutes = (min) => db.prepare(
        `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
         VALUES (?,?,?,0,0,?)
         ON CONFLICT(user_id,month) DO UPDATE SET stt_minutes=excluded.stt_minutes, updated_at=excluded.updated_at`,
      ).run(userId, periodKey, min, new Date().toISOString());
      const usedMinutes = () => db.prepare(
        'SELECT stt_minutes FROM usage_records WHERE user_id=? AND month=?',
      ).get(userId, periodKey)?.stt_minutes ?? 0;

      // ── 1 · room build: both ends are told what is left, before anyone speaks
      const pc = await connect(url, { jwt });
      const pcRec = recordAll(pc);
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G24 PC', client_instance_id: 'inst-g24-0123456789ab',
      });
      const mobile = await connect(url);
      const rec = recordAll(mobile);
      const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      if (pair.error) return FAIL(`mobile:pair refused: ${JSON.stringify(pair)}`);
      await sleep(200);

      // EXACTLY ONE on the target end, from its own `pc:register`, and the
      // count is the assertion. A second frame at the moment a microphone pairs
      // in was tried and withdrawn: golden G10 counts every frame reaching a PC
      // across a record-only session, and owner's 「仅记录】条目无条件不同步 PC」
      // line does not have an exception for a number. See pushJoinBudget.
      const pcGranted = budgets(pcRec).filter((b) => b.reason === 'granted');
      if (pcGranted.length !== 1) {
        return FAIL(`the target end got ${pcGranted.length} granted budget frames, want exactly 1 (its own register; pairing must add none - G10)`);
      }
      const joined = budgets(rec).filter((b) => b.reason === 'granted');
      if (joined.length !== 1) return FAIL(`mobile:pair produced ${joined.length} granted budget frames, want exactly 1`);

      // Through the protocol parser, not by hand — see the note above.
      const parsedJoin = safeParseEvent('billing:budget', joined[0]);
      if (!parsedJoin.success) return FAIL(`the join budget frame does not satisfy the protocol schema: ${parsedJoin.error?.message}`);
      if (parsedJoin.data.mode !== 'plan') return FAIL(`join budget mode is ${parsedJoin.data.mode}, want 'plan' (stage two has no other producer)`);
      if (parsedJoin.data.resets_at !== periodEndMs) {
        return FAIL(`join budget resets_at=${parsedJoin.data.resets_at} but /api/cloud/summary says the cycle ends ${periodEndMs} (${summary.quota.period.end})`);
      }
      const expectedFullMs = Math.round((limitMin - summary.quota.stt.used_min) * 60_000);
      if (parsedJoin.data.remaining_ms !== expectedFullMs) {
        return FAIL(`join budget remaining_ms=${parsedJoin.data.remaining_ms} but this account's own ledger says ${expectedFullMs} — the frame is about somebody else`);
      }

      /** One 100 ms frame of silence, the size the phone actually sends. */
      const pcm = Buffer.alloc(3_200).toString('base64');

      // ── 2 · GA-02: a RECORD-ONLY press tells the target end nothing at all
      //
      // 🔴 The one place the "tell both ends" rule bends, and it bends toward the
      // privacy red line. A record-only utterance is one the PC is contractually
      // forbidden to hear anything about - it is never told the recording BEGAN -
      // so a budget frame ticking in step with one would leak that somebody is
      // recording to a device that must not know. The MICROPHONE still gets its
      // reading, which is what makes this a withholding rather than a silence.
      // Run FIRST, on the untouched allowance: later sections spend the ledger
      // to its ceiling and re-pair on a second socket, and a control that shares
      // a fixture with either of those is testing two things at once.
      rec.frames.length = 0;
      pcRec.frames.length = 0;
      let s0 = 0;
      const pump0 = setInterval(() => mobile.emit('audio:chunk', { seq: s0 += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
      try {
        mobile.emit('audio:start', AUDIO_START_RECORD_ONLY);
        await sleep(HEARTBEAT_MS * 4);
        mobile.emit('audio:stop', {});
        await sleep(400);
      } finally {
        clearInterval(pump0);
      }
      if (budgets(rec).length === 0) {
        return FAIL('positive control: the microphone got no budget frame either, so the zero below proves nothing');
      }
      if (budgets(pcRec).length !== 0) {
        return FAIL(`a record-only press sent ${budgets(pcRec).length} budget frame(s) to the target end (GA-02: it was never told the recording began)`);
      }


      // ── 3 · a recording that runs out mid-sentence
      setUsedMinutes(limitMin - SEEDED_BUDGET_MS / 60_000);
      rec.frames.length = 0;
      pcRec.frames.length = 0;
      let seq = 0;
      const pump = setInterval(() => mobile.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
      try {
        mobile.emit('audio:start', AUDIO_START);
        await sleep(SEEDED_BUDGET_MS + 1_500);
      } finally {
        clearInterval(pump);
      }

      const seen = budgets(rec);
      const started = seen.filter((b) => b.reason === 'started');
      if (started.length !== 1) return FAIL(`audio:start produced ${started.length} started budget frames, want exactly 1`);
      if (Math.abs(started[0].remaining_ms - SEEDED_BUDGET_MS) > 200) {
        return FAIL(`started budget says ${started[0].remaining_ms} ms left, seeded ${SEEDED_BUDGET_MS} ms`);
      }

      // 🔴 THE ASSERTION THAT SEPARATES A LIVE READING FROM A STALE ONE. The
      // account ledger does not move during a recording (usage is written at
      // settle), so a heartbeat that read the ACCOUNT would repeat the same
      // number and then jump to zero. Strictly decreasing is what proves the
      // number comes off the session's own deadline.
      const beats = seen.filter((b) => b.reason === 'heartbeat' && b.remaining_ms > 0);
      if (beats.length < 2) return FAIL(`only ${beats.length} while-streaming budget frames above zero, want at least 2`);
      for (let i = 1; i < beats.length; i += 1) {
        if (beats[i].remaining_ms >= beats[i - 1].remaining_ms) {
          return FAIL(`while-streaming budget did not fall: ${beats.map((b) => b.remaining_ms).join(' -> ')}`);
        }
      }

      // 🔴 AND THE SAME READING REACHES THE TARGET END. Stage two draws the
      // minutes bar on the TARGET page, so a heartbeat that arrived only at the
      // microphone would leave that bar frozen for exactly as long as somebody
      // is speaking into it - the one screen it exists for, and the one screen
      // it would not reach. Both ends are one account here, so the numbers are
      // the same numbers, which is what makes this comparable rather than merely
      // present.
      const pcSeen = budgets(pcRec);
      const pcBeats = pcSeen.filter((b) => b.reason === 'heartbeat' && b.remaining_ms > 0);
      if (pcBeats.length < 2) {
        return FAIL(`the target end got ${pcBeats.length} while-streaming budget frames above zero (the microphone got ${beats.length}) - the minutes bar on the target page would not move`);
      }
      for (let i = 1; i < pcBeats.length; i += 1) {
        if (pcBeats[i].remaining_ms >= pcBeats[i - 1].remaining_ms) {
          return FAIL(`the target end's budget did not fall: ${pcBeats.map((b) => b.remaining_ms).join(' -> ')}`);
        }
      }
      if (pcSeen.filter((b) => b.reason === 'started').length !== 1) {
        return FAIL('the target end was not told a recording started');
      }
      const pcExhausted = pcSeen.filter((b) => b.exhausted === true);
      if (pcExhausted.length !== 1 || pcExhausted[0].remaining_ms !== 0) {
        return FAIL(`the target end got ${pcExhausted.length} exhaustion frame(s) ${JSON.stringify(pcExhausted)}`);
      }

      // ── 4 · the meter reaches zero, and THEN the relay ends the recording
      const order = rec.frames
        .map((f, i) => ({ i, f }))
        .filter(({ f }) => (f.event === 'billing:budget' && f.args[0].exhausted === true) || f.event === 'audio:auto-stopped');
      const exhausted = order.find(({ f }) => f.event === 'billing:budget');
      const autoStop = order.find(({ f }) => f.event === 'audio:auto-stopped');
      if (!exhausted) return FAIL(`no billing:budget{exhausted:true}; frames were ${rec.frames.map((f) => f.event).join(' ')}`);
      if (!autoStop) return FAIL('the relay never ended the recording (no audio:auto-stopped)');
      if (autoStop.f.args[0].reason !== 'quota_exhausted') {
        return FAIL(`the relay ended the recording for '${autoStop.f.args[0].reason}', want 'quota_exhausted'`);
      }
      if (exhausted.i > autoStop.i) {
        return FAIL('the budget reached zero AFTER the recording was reported over — a meter that explains nothing');
      }
      if (exhausted.f.args[0].remaining_ms !== 0) {
        return FAIL(`the exhaustion frame says ${exhausted.f.args[0].remaining_ms} ms left`);
      }

      // ── 5 · and the next press is refused by the EXISTING code, with no
      //        budget frame of its own (the push sits after the gate).
      //
      // Short streaming rounds until the ledger reaches the ceiling. It takes
      // more than one because the wall-clock ceiling and the audio-ms meter are
      // deliberately different quantities (stt/audio/session.ts setQuotaBudgetMs:
      // "conservative in one direction only"), so one session spends slightly
      // less than it was allowed. Bounded, and the bound FAILS loudly rather
      // than looping — a meter that never reaches its own ceiling is a defect,
      // not a slow test.
      let rounds = 0;
      while (usedMinutes() < limitMin && rounds < 5) {
        rounds += 1;
        let s2 = 0;
        const pump2 = setInterval(() => mobile.emit('audio:chunk', { seq: s2 += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
        try {
          mobile.emit('audio:start', AUDIO_START);
          await sleep(900);
          mobile.emit('audio:stop', {});
          await sleep(900);
        } finally {
          clearInterval(pump2);
        }
      }
      if (usedMinutes() < limitMin) {
        return FAIL(`the ledger never reached the ceiling after ${rounds} rounds: ${usedMinutes()}/${limitMin} minutes`);
      }

      rec.frames.length = 0;
      mobile.emit('audio:start', AUDIO_START);
      await sleep(600);
      const refusal = rec.frames.find((f) => f.event === 'stt:error');
      if (!refusal) return FAIL(`a press on a spent ledger was not refused; frames were ${rec.frames.map((f) => f.event).join(' ') || '(none)'}`);
      if (refusal.args[0].code !== 'QUOTA_EXCEEDED') {
        return FAIL(`the refusal code is ${refusal.args[0].code}, want the EXISTING QUOTA_EXCEEDED (this card adds no error code)`);
      }
      if (budgets(rec).length !== 0) {
        return FAIL('a refused press still produced a budget frame — the push must sit after the gate');
      }

      // ── 6 · §1.5: a reconnect ack carries the same shape
      const mobile2 = await connect(url);
      const back = await ack(mobile2, 'mobile:reconnect', {
        token: pair.mobile_token, device_uid: 'g24-device-uid-0001',
      });
      if (back.error) return FAIL(`mobile:reconnect refused: ${JSON.stringify(back)}`);
      if (!back.budget) return FAIL('the mobile:reconnect ack carries no budget field (addendum §1.5)');
      const ackParsed = BudgetViewSchema.safeParse(back.budget);
      if (!ackParsed.success) return FAIL(`the reconnect ack budget is not the shared shape: ${ackParsed.error?.message}`);
      if (ackParsed.data.remaining_ms !== 0) {
        return FAIL(`the reconnect ack says ${ackParsed.data.remaining_ms} ms left on a spent ledger`);
      }
      if (ackParsed.data.resets_at !== periodEndMs) {
        return FAIL(`the reconnect ack resets_at=${ackParsed.data.resets_at}, the cycle ends ${periodEndMs}`);
      }

      pc.close();
      mobile.close();
      mobile2.close();
      return PASS(
        `join ${expectedFullMs} ms on both ends; microphone started ${started[0].remaining_ms} -> `
        + `${beats.map((b) => b.remaining_ms).join(' -> ')} -> exhausted 0, and the TARGET end saw `
        + `${pcBeats.map((b) => b.remaining_ms).join(' -> ')} -> exhausted 0 too, then `
        + `audio:auto-stopped{quota_exhausted}; ledger ${usedMinutes().toFixed(4)}/${limitMin} min after ${rounds} round(s); `
        + 'next press refused QUOTA_EXCEEDED with no budget frame; reconnect ack carries the same shape; '
        + 'and a record-only press sent the target end nothing (GA-02)',
      );
    } finally {
      try { db?.close(); } catch { /* the process is going away anyway */ }
      try { saas?.child.kill(); } catch { /* already gone */ }
      // maxRetries, like G17: the relay still holds the database file for a few
      // milliseconds after kill(), and a first-attempt-only delete silently
      // leaves a directory behind on every run.
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    }
  },
};

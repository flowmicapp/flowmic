// G32 — card G-8: the per-tier SITTING LENGTH ceiling is enforced by the relay,
// on a real process, with a real wall clock — not only by a clock in the phone.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4 (gap G-8)
//   owner 2026-08-29 long-recording rulings (`PLAN_LIMITS.continuous_minutes`:
//     free 10 minutes per sitting, pro/max 30)
//   apps/server-core/src/billing/session-cap.ts (why it is NOT a smaller budget)
//   apps/server-core/src/stt/audio/session.ts (`setSessionCapMs`, `nextCeiling`)
//   apps/server-core/src/engine/stt-session-autostop.ts (`session_cap` reason)
//
// ── WHAT THIS ASSERTS THAT THE UNIT TESTS CANNOT ───────────────────────────
//
// `apps/server-core/test/session-cap-ceiling.test.ts` proves the arithmetic on a
// fake clock and the wiring on an in-memory database with a hand-installed plan
// table. Neither of those is the thing that failed: what failed was that the
// number lived in `billing/plans.ts` and NOTHING on the recording path ever read
// it. This case boots a real relay from its own `FLOWMIC_PLAN_LIMITS`, pairs a
// real socket, speaks for a real minute, and reads the frame a client actually
// receives.
//
// ── 🔴 WHY THIS CASE COSTS A MINUTE, SAID OUT LOUD ─────────────────────────
//
// `FLOWMIC_PLAN_LIMITS` accepts INTEGER minutes only (`billing/plans.ts`
// `coerceCell` — a non-integer is a config error, deliberately), so the shortest
// ceiling this deployment can be configured with is 60 seconds, and there is no
// way to shorten it that does not go around the production config path. Going
// around it is exactly what would make this case unable to fail for the original
// reason: the defect was a number that was configured and never read.
// ⇒ The minute is the price of asserting the real path. The sub-second version
// of the same claim is section 3 of the unit test, which installs a table by
// hand and is therefore silent about whether the env ever reaches it.
//
// ── ⚠️ WHAT IT DOES NOT NEED ───────────────────────────────────────────────
//
// No vendor STT engine and no LAN, so it never SKIPs — same route as G24: a
// batch HTTP engine pointed at a closed port, which is enough for the bridge's
// constructor to reach `session.start()` and arm the ceiling. The engine only
// fails later, at flush, on a frame this case does not read.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt,
  mailFileDir, mailFileEnv, verifyRegisteredEmail, PASS, FAIL,
} from './harness.mjs';

const EMAIL = 'g32-sitting-cap@flowmic.test';

/** The sitting ceiling this deployment is configured with, in minutes. The
 *  smallest integer the production override path accepts — see the header. */
const CAP_MINUTES = 1;
const CAP_MS = CAP_MINUTES * 60_000;

/** 🔴 AND THE MONTH IS LEFT RICH ON PURPOSE. The whole claim is 「the sitting
 *  ended while there was plenty of money」, so the monthly budget must be the
 *  ceiling that did NOT bind. Free ships 20 minutes (owner 2026-08-02); this
 *  case does not override it, and asserts below that what was left dwarfs the
 *  minute that was spent. */
const RICH_BUDGET_FLOOR_MS = 10 * 60_000;

/** How long to wait past the ceiling before calling it a miss. Generous: a
 *  Windows CI box under load is slow, and 「it fired late」 and 「it never fired」
 *  want different reports. */
const GRACE_MS = 20_000;

/** Tolerance on the MEASURED stop. One-sided on the early side (a wall that
 *  fires early is a different defect and this case would rather name it than
 *  absorb it) and loose on the late side for the same reason as GRACE_MS. */
const EARLY_TOLERANCE_MS = 1_500;

/** While-streaming budget pushes, so this case gets several readings of 「how
 *  much money is left」 inside the minute. Production is 10 s. */
const HEARTBEAT_MS = 2_000;

const AUDIO_START = {
  sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
  mode: 'realtime', delivery: 'inject', source_lang: 'en',
};

/** A batch HTTP route pointed at a closed port — see the header. */
const POOL = JSON.stringify([{
  id: 'g32-unreachable', provider: 'custom-openai-compatible', model: 'g32',
  api: 'http://127.0.0.1:9/v1', api_key: 'g32', enabled: true, priority: 1,
}]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);

export const G32 = {
  id: 'G32',
  name: 'continuous-minutes cap — the relay ends a sitting at the payer\'s tier ceiling while the month is still rich, says hard_limit (not quota_exhausted), and pushes no exhaustion frame',
  requires: [
    'apps/server-core/src/billing/session-cap.ts',
    'apps/server-core/src/stt/audio/session.ts',
    'apps/server-core/src/engine/stt-session-autostop.ts',
  ],
  async fn() {
    // Frames are checked THROUGH the protocol package's own parser, read from
    // the dist the relay was built against — an assertion that read
    // `payload.reason` by hand would still pass if the event fell out of the
    // whitelist.
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent } = protocol;

    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g32-'));
    const dbPath = path.join(dir, 'g32.sqlite');
    const mailDir = mailFileDir();
    let saas;
    let db;
    try {
      try {
        saas = await startSaasServer({
          FLOWMIC_DB_PATH: dbPath,
          FLOWMIC_STT_POOL: POOL,
          FLOWMIC_BUDGET_HEARTBEAT_MS: String(HEARTBEAT_MS),
          // 🔴 THE PRODUCTION OVERRIDE PATH, not a hand-built table.
          // `config.ts` resolves this before any socket exists, and the whole
          // point of the case is that the number gets from here to the timer.
          FLOWMIC_PLAN_LIMITS: JSON.stringify({ free: { continuous_minutes: CAP_MINUTES } }),
          ...mailFileEnv(mailDir),
        });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      const url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);

      const jwt = await saasJwt(url, EMAIL);
      await verifyRegisteredEmail(url, jwt, mailDir, EMAIL);

      // ── 1 · the number this account is told, on the surface the phone reads
      //
      // The phone arms its OWN clock from this field (`cloud_summary.dart` →
      // `continuous_cap_timer.dart`). Asserting it here is what makes 「both ends
      // enforce the same ceiling」 a measurement rather than a hope: one number,
      // two enforcers.
      const summary = await (await fetch(`${url}/api/cloud/summary`, {
        headers: { authorization: `Bearer ${jwt}` },
      })).json();
      if (summary?.continuous_minutes !== CAP_MINUTES) {
        return FAIL(`/api/cloud/summary says continuous_minutes=${JSON.stringify(summary?.continuous_minutes)}, want ${CAP_MINUTES} — the phone would arm a different ceiling than the relay`);
      }
      const fullBudgetMs = Math.round((summary.quota.stt.limit_min - summary.quota.stt.used_min) * 60_000);
      if (fullBudgetMs < RICH_BUDGET_FLOOR_MS) {
        return FAIL(`this account only has ${fullBudgetMs} ms of month; the case needs a RICH month (>= ${RICH_BUDGET_FLOOR_MS} ms) or it cannot tell the cap apart from the budget`);
      }

      // ── 2 · a real room
      const pc = await connect(url, { jwt });
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G32 PC', client_instance_id: 'inst-g32-0123456789ab',
      });
      const mobile = await connect(url);
      const rec = recordAll(mobile);
      const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      if (pair.error) return FAIL(`mobile:pair refused: ${JSON.stringify(pair)}`);
      await sleep(200);
      rec.frames.length = 0;

      // ── 3 · speak past the ceiling
      //
      // The press is ORDINARY — nothing in this frame mentions a length, and
      // that is the assertion hiding in the setup: a modified client cannot opt
      // out of a ceiling it never sends.
      const startAck = await ack(mobile, 'audio:start', AUDIO_START);
      if (startAck?.error) return FAIL(`audio:start refused: ${JSON.stringify(startAck)} — the account should have been admitted (its month is rich)`);
      const startedAt = Date.now();

      const pcm = Buffer.alloc(3_200).toString('base64');
      let seq = 0;
      const pump = setInterval(() => {
        mobile.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() });
      }, 200);

      let stoppedAt = null;
      try {
        const deadline = startedAt + CAP_MS + GRACE_MS;
        while (Date.now() < deadline) {
          const hit = rec.frames.find((f) => f.event === 'audio:auto-stopped');
          if (hit) { stoppedAt = Date.now(); break; }
          await sleep(250);
        }
      } finally {
        clearInterval(pump);
      }

      if (stoppedAt === null) {
        // 🔴 THE PRE-CARD BEHAVIOUR, NAMED. Before G-8 the relay armed only the
        // monthly deadline, so this loop ran out with the session still live —
        // which is the entire defect: not a late stop, not a wrong sentence, no
        // stop at all.
        return FAIL(`the relay never ended the sitting: ${Math.round((Date.now() - startedAt) / 1000)}s of recording against a ${CAP_MINUTES}-minute continuous_minutes ceiling, and no audio:auto-stopped arrived. Frames seen: ${[...new Set(rec.frames.map((f) => f.event))].join(' ')}`);
      }

      // ── 4 · WHEN it ended, and WHAT it said
      const elapsed = stoppedAt - startedAt;
      if (elapsed < CAP_MS - EARLY_TOLERANCE_MS) {
        return FAIL(`the sitting ended after ${elapsed}ms, EARLIER than the ${CAP_MS}ms ceiling — a wall that fires early is a different defect from a wall that is missing, and this case will not absorb it`);
      }
      const stop = rec.frames.find((f) => f.event === 'audio:auto-stopped');
      const parsed = safeParseEvent('audio:auto-stopped', stop.args[0]);
      if (!parsed.success) {
        return FAIL(`the auto-stop frame does not satisfy the protocol schema: ${parsed.error?.message}`);
      }
      if (parsed.data.reason !== 'hard_limit') {
        // `quota_exhausted` here would be the failure this card's origin→reason
        // argument exists to prevent: it sends a user with 19 minutes of month
        // left away to wait or to pay, when the correct next action is to press
        // the button again.
        return FAIL(`the relay ended the sitting for '${parsed.data.reason}', want 'hard_limit' — the month is not spent, the SITTING is over, and the two sentences send the user somewhere opposite`);
      }

      // ── 5 · 🔴 THE CONTROL THAT MAKES SECTION 4 MEAN ANYTHING: the money was
      //        never the binding constraint.
      //
      // Without this, 「stopped at 60s」 is equally consistent with 「the account
      // ran out at 60s」, and the case would be green on an implementation that
      // never read `continuous_minutes` at all.
      const beats = budgets(rec).filter((b) => b.reason === 'heartbeat' && typeof b.remaining_ms === 'number');
      if (beats.length < 2) {
        return FAIL(`only ${beats.length} while-streaming budget reading(s) — not enough to say whether the money was ever near zero`);
      }
      const lowest = Math.min(...beats.map((b) => b.remaining_ms));
      if (lowest < RICH_BUDGET_FLOOR_MS) {
        return FAIL(`the monthly budget fell to ${lowest}ms during the sitting — this case cannot distinguish the sitting ceiling from the money at that point`);
      }
      const exhausted = budgets(rec).filter((b) => b.exhausted === true);
      if (exhausted.length !== 0) {
        // The exhaustion push is keyed on `reason === 'quota_exhausted'`
        // (`engine/stt-factory.ts`). A frame here would mean a sitting ceiling
        // had been reported to a client as a spent account.
        return FAIL(`the client was sent ${exhausted.length} billing:budget{exhausted:true} frame(s) for a sitting that ended on its LENGTH ceiling — the month is not spent`);
      }

      // ── 6 · and the ledger agrees it cost about a minute, not twenty
      mobile.emit('audio:stop', {});
      await sleep(600);
      const userId = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL)?.id;
      const used = db.prepare('SELECT stt_minutes FROM usage_records WHERE user_id=?').get(userId)?.stt_minutes ?? 0;
      // Loose on purpose: the ceiling is WALL-CLOCK and the meter bills AUDIO ms
      // (`stt/audio/session.ts` `setQuotaBudgetMs` — 「conservative in one
      // direction only」), so these two are not the same quantity and pinning
      // them to each other would be asserting a coincidence. What matters is the
      // order of magnitude: about one minute, nowhere near the month.
      if (used > CAP_MINUTES * 3) {
        return FAIL(`the ledger charged ${used.toFixed(3)} minutes for a sitting capped at ${CAP_MINUTES} — the wall did not bound the spend`);
      }

      return PASS(
        `continuous-minutes cap: /api/cloud/summary and the relay agree on ${CAP_MINUTES} min; `
        + `an ordinary audio:start (no length in the frame) ran ${elapsed}ms and the relay ended it itself `
        + `with audio:auto-stopped{reason:'hard_limit'}; `
        + `the month was never the constraint (lowest of ${beats.length} while-streaming readings was ${lowest}ms, floor ${RICH_BUDGET_FLOOR_MS}ms) `
        + `and zero billing:budget{exhausted:true} frames were sent; ledger charged ${used.toFixed(3)} min`,
      );
    } finally {
      try { db?.close(); } catch { /* the process is going away anyway */ }
      try { saas?.child.kill(); } catch { /* already gone */ }
      // maxRetries, like G17/G24: the relay still holds the database file for a
      // few milliseconds after kill(), and a first-attempt-only delete silently
      // leaves a directory behind on every run.
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    }
  },
};

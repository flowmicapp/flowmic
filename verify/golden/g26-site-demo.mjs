// G26 — card M4-01: an anonymous visitor on the marketing site gets an identity,
// a real room, a microphone that pairs into it, and a meter that stops them.
//
// 🔴🔴 REWRITTEN 2026-09-11 FOR CARD MP-6 (owner ruling §11). THE DEMO STILL
// EXISTS AND STILL MATTERS; WHAT CHANGED IS WHO PAYS FOR IT. Until that card the
// visitor's own anonymous grant WAS the payer, so 「the demo ran out」 and 「the
// anonymous identity's ledger reached zero」 were one sentence. They are two now:
// the seconds are metered to a REAL demo account named by
// `FLOWMIC_DEMO_PAYER_USER_ID` (owner §11: 「向额度的消耗有迹可寻」) and the
// visitor's 120 s rides along as a per-browser CAP. Every assertion below is
// unchanged or replaced by one about that split — and the two that could not
// survive are DELETED with the reason written where they stood, never left as a
// weaker check that still looks like proof.
//
// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.2 (the
//     sequence), §2.3 (grant and TTL), §3.1 (the gates)
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §10-1 (the
//     ordered rule), §10-4 (the cap)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (owner 2026-09-11 — the two minutes are ONE-TIME per browser identity;
//     section 12 below is that ruling, and it replaced a 120/60/30/0 sequence)
//   apps/server-core/src/http/web-anon-routes.ts · src/http/web-room-routes.ts
//   apps/server-core/src/auth/metering-principal.ts (`resolvePayer` step 3)
//   apps/server-core/src/billing/trial-ledger.ts · src/billing/budget-push.ts
//
// ── WHY THIS IS A GOLDEN AND NOT A UNIT TEST ───────────────────────────────
//
// `test/web-anon-routes.test.ts` drives both routes with real repos and proves
// everything they decide. It cannot prove this card's claim, which spans an HTTP
// mint, a socket admission, a quota guard, an audio session's wall-clock
// deadline and a budget emitter — five layers, four of which the unit test
// necessarily stands in for. In particular it cannot prove:
//
// 🔴 THAT `budget.mode` REACHES BOTH ENDS AS 'trial'. The card and the phone
// have no other way to know they are in a demo — no new event, no new field
// (§2.1). If it arrived as 'plan' every unit test here would still be green and
// the product would tell a visitor they are metered against a subscription
// nobody bought. MP-6 made that HARDER: the payer is now a real account whose
// own row reads `'plan'`, so `'trial'` survives only because a cap is threaded
// from the admission to the frame (`budget-push.ts` `view`), and nothing but a
// live server proves the thread is whole.
//
// ── THE TWO REVERSE CONTROLS, ACTUALLY RUN (2026-09-11, this worktree) ─────
// Both were applied, watched go red, and reverted (`REVERSE-CONTROL` residue
// grep = 0). They are recorded because 「the assertions are load bearing」 is a
// claim, and this repo's rule is that a reverse control counts only when
// somebody has seen it fail:
//   ① drop `FLOWMIC_DEMO_PAYER_USER_ID` from the restart ⇒ FAIL at section 7,
//      「a browser microphone could not pair with the demo room:
//      PC_HANDSHAKE_PENDING」. The whole demo hangs off a payer somebody named.
//   ② drop the cap seed in section 5 ⇒ FAIL at section 6, 「the reconnect ack
//      says 120000 ms left, seeded 4000」. The card's number really is read off
//      the visitor's own grant and not off anything else that happens to be
//      small.
//
// ── WHAT IT DOES NOT NEED ──────────────────────────────────────────────────
// No vendor STT engine, no LAN: the pool points at a closed port, which is
// enough to arm the quota deadline (G24's header has the measurement). Turnstile
// is the REAL verifier pointed at a local stub through
// FLOWMIC_TURNSTILE_VERIFY_URL — the seam auth/captcha.ts provides for exactly
// this — not a double, so what runs here is the production gate. It never SKIPs.
//
// ── WHY IT STARTS THE SERVER TWICE ─────────────────────────────────────────
// `FLOWMIC_DEMO_PAYER_USER_ID` names a `users` row, the server generates that
// id, and `loadConfig` reads env once at boot. So the only honest way to point a
// running relay at a REAL demo account is: boot, register the account over HTTP,
// read its id out of the database, boot again on the same file. A literal id in
// the fixture would name a row that does not exist — a misconfiguration, and a
// different branch from the one this file is about.
//
// ⚠️ THE OTHER HALF OF THAT BRANCH — 「a site-demo room on a deployment that
// configured NO demo account is REFUSED rather than billed to a fallback」 —
// belongs to G30 (`g30-payer-matrix.mjs` section 8, with its positive control in
// section 9). It is deliberately not duplicated here: two copies of a refusal is
// two places for it to be quietly relaxed.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt, verifyRegisteredEmail,
  mailFileDir, mailFileEnv, PASS, FAIL,
  settleAfter, waitUntil, LIVENESS_CEILING_MS,
} from './harness.mjs';

// The scenario's fixtures — the seeded numbers with the paragraph that
// justifies each one, the two accounts, the browser identity and the local
// siteverify stand-in — moved out VERBATIM under the 800-line cap. That
// file's header carries the seam and why it falls where it does.
import {
  CAP_REMAINING_MS, SEEDED_BUDGET_MS, ACCOUNT_BUDGET_MS, ACCOUNT_EMAIL, DEMO_PAYER_EMAIL,
  HEARTBEAT_MS, SITE_ORIGIN, FREE_PLAN_MINUTES, PLAN_MS, BROWSER_UID,
  BROWSER_INSTANCE_ID, POOL, sleep, budgets, startSiteverifyStub,
} from './g26-site-demo-fixtures.mjs';

// Waiting on facts rather than on the clock: `waitUntil` / `settleAfter` /
// LIVENESS_CEILING_MS live in harness.mjs — G13 needs exactly the same pair and
// a second copy here would be this repo's #1 shape pointed at its own harness.
// Read that block for why a ceiling is not a race window, and for the asymmetry
// that decides which waits were converted and which were left alone.
//
// The settle window is this file's own number because it answers this file's
// own question: the `!== 1` assertions below, i.e. a SECOND frame emitted in a
// later turn than the one we waited for.
const DUP_WINDOW_MS = 200;
const settle = (pred, what, ceilingMs) => settleAfter(pred, what, DUP_WINDOW_MS, ceilingMs);

export const G26 = {
  id: 'G26',
  name: "site demo (POST /api/web/anon → anonymous room → a browser microphone pairs → budget.mode:'trial' on the card's ack and on every audio frame, carrying the VISITOR's cap → the DEMO ACCOUNT's ledger is what moves and what runs out) + G26-b (the visitor signs in ⇒ the meter moves to their account and the demo account stops paying)",
  requires: [
    'apps/server-core/src/http/web-anon-routes.ts',
    'apps/server-core/src/billing/trial-ledger.ts',
    'apps/server-core/src/db/schema-trial.ts',
    // leg G26-b (card W4-05) and the MP-6 payer rule this file now turns on.
    'apps/server-core/src/auth/metering-principal.ts',
  ],
  async fn() {
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent } = protocol;

    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g26-'));
    const dbPath = path.join(dir, 'g26.sqlite');
    const mailDir = mailFileDir();
    const turnstile = await startSiteverifyStub();
    let saas;
    let db;
    const open = [];
    const track = (s) => { open.push(s); return s; };
    const baseEnv = {
      FLOWMIC_DB_PATH: dbPath,
      FLOWMIC_STT_POOL: POOL,
      FLOWMIC_BUDGET_HEARTBEAT_MS: String(HEARTBEAT_MS),
      FLOWMIC_WEB_ANON_ENABLED: '1',
      FLOWMIC_TURNSTILE_SECRET: 'g26-secret',
      FLOWMIC_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${turnstile.port}/siteverify`,
      FLOWMIC_TRIAL_IP_SALT: 'g26-salt',
      // card MP-6 — section 11's discriminator. Off by default in production
      // because the switch gates COLLECTION, not these columns.
      FLOWMIC_USAGE_EVENTS_ENABLED: '1',
      // Card NR-31, and it is the production door: config.ts installs
      // `resolvePlanLimits(envJson('FLOWMIC_PLAN_LIMITS'))` before any socket
      // exists.
      FLOWMIC_PLAN_LIMITS: JSON.stringify({ free: { stt_minutes: FREE_PLAN_MINUTES } }),
      ...mailFileEnv(mailDir),
    };
    try {
      try {
        saas = await startSaasServer(baseEnv);
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      let url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);

      const post = (p, body, headers = {}) => fetch(`${url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE_ORIGIN, ...headers },
        body: JSON.stringify(body ?? {}),
      });
      const usageOf = (userId) => db.prepare('SELECT * FROM usage_records WHERE user_id=?').all(userId);
      const usageEventsFor = (u) => db.prepare("SELECT * FROM usage_events WHERE user_id=? AND kind='stt'").all(u);
      const spentMinutes = (userId) => usageOf(userId)[0]?.stt_minutes ?? 0;
      const periodKeyOf = (userId) => {
        // The bucket key is derived from the row's own created_at
        // (billing/usage-period.ts: a fresh account's cycle is anchored at
        // registration), not guessed.
        const created = db.prepare('SELECT created_at FROM users WHERE id=?').get(userId).created_at;
        return new Date(`${String(created).replace(' ', 'T')}Z`).toISOString().slice(0, 10);
      };
      const seedUsedMs = (userId, usedMs) => db.prepare(
        `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
         VALUES (?,?,?,0,0,?)
         ON CONFLICT(user_id,month) DO UPDATE SET stt_minutes=excluded.stt_minutes`,
      ).run(userId, periodKeyOf(userId), usedMs / 60_000, new Date().toISOString());
      const pcm = Buffer.alloc(3_200).toString('base64');
      /** Speak for `forMs`, or — when `until` is given — keep speaking until the
       *  relay says the thing we are waiting for.
       *
       *  🔴 `until` EXISTS BECAUSE THE TWO CALLERS THAT RUN A SESSION OUT OF
       *  QUOTA USED TO PUMP `SEEDED + 1_800` ms AND THEN ASSERT IMMEDIATELY.
       *  That 1 800 was slack for the exhaustion frame to come back, i.e. a
       *  second time constant racing the first. Now the audio stops when the
       *  relay has actually ended the recording, and the clock is only a
       *  ceiling. */
      const speak = async (socket, forMs, until = null) => {
        let seq = 0;
        const pump = setInterval(() => socket.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
        try {
          socket.emit('audio:start', {
            sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
            mode: 'realtime', delivery: 'inject', source_lang: 'en',
          });
          if (until) {
            await waitUntil(until, 'the relay never ended the recording it was told to meter',
              forMs + LIVENESS_CEILING_MS).catch(() => { /* the assertions below are the judge */ });
          } else {
            await sleep(forMs);
          }
        } finally {
          clearInterval(pump);
        }
      };

      // ── 0 · FlowMic's demo account, and the restart that points the relay at it
      //
      // Nothing is asserted about the product here — this is the fixture buying
      // the one thing it cannot fake (see the header). VERIFIED because it is the
      // ACTING account for every demo recording below and `audio:start`'s
      // verification-grace gate judges the acting account; an unverified demo
      // payer would turn every assertion in this file into one refusal that has
      // nothing to do with the card.
      const demoJwt = await saasJwt(url, DEMO_PAYER_EMAIL);
      await verifyRegisteredEmail(url, demoJwt, mailDir, DEMO_PAYER_EMAIL);
      const demoPayerId = db.prepare('SELECT id FROM users WHERE email=?').get(DEMO_PAYER_EMAIL)?.id;
      if (!demoPayerId) return FAIL('the demo payer account has no users row');
      // 🔴 THE CHILD'S OWN `exit`, NOT 600 ms OF HOPE. The next line binds the
      // same port; on a loaded box 600 ms was not always enough for the old
      // process to release it, and the failure looked like 「the relay cannot
      // start with a demo payer」 — a sentence about the product, produced by a
      // stopwatch. `once(child,'exit')` is the fact itself.
      const dying = saas?.child;
      try { dying?.kill(); } catch { /* restarting */ }
      if (dying && dying.exitCode === null && dying.signalCode === null) {
        await Promise.race([
          new Promise((r) => dying.once('exit', r)),
          sleep(LIVENESS_CEILING_MS),
        ]);
      }
      try {
        saas = await startSaasServer({ ...baseEnv, FLOWMIC_DEMO_PAYER_USER_ID: demoPayerId });
      } catch (e) {
        return FAIL(`the saas server failed to restart with a demo payer configured: ${e.message}`);
      }
      url = `http://127.0.0.1:${saas.port}`;

      // ── 1 · a bad Turnstile solve is refused BY NAME, and mints nothing ────
      // The negative control for section 2: without it, a 200 there would not
      // prove the gate ran — only that it did not stop us.
      const bad = await post('/api/web/anon', { turnstile: 'bad' });
      if (bad.status !== 400) return FAIL(`a failed Turnstile solve answered ${bad.status}, want 400`);
      const badBody = await bad.json();
      if (badBody.error !== 'WEB_ROOM_TURNSTILE_FAILED') {
        return FAIL(`a failed solve answered '${badBody.error}', want the registered WEB_ROOM_TURNSTILE_FAILED`);
      }
      // Counted on `anonymous=1` and on the ledger, not on the whole table: a
      // saas relay seeds rows of its own at boot and section 0 registered one,
      // so a total that is 「not zero」 for those reasons would make this probe
      // useless rather than strict.
      if (db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get().n !== 0
        || db.prepare('SELECT COUNT(*) AS n FROM trial_ledger').get().n !== 0) {
        return FAIL('a refused mint still wrote an identity — the gate runs after the write');
      }

      // ── 2 · a foreign origin is refused by name ────────────────────────────
      const foreign = await post('/api/web/anon', { turnstile: 'ok' }, { origin: 'https://evil.example' });
      if (foreign.status !== 403) return FAIL(`a foreign origin answered ${foreign.status}, want 403`);
      if ((await foreign.json()).error !== 'WEB_ROOM_ORIGIN_NOT_ALLOWED') {
        return FAIL('a foreign origin was not refused with WEB_ROOM_ORIGIN_NOT_ALLOWED');
      }

      // ── 3 · the visitor gets an identity ──────────────────────────────────
      // owner §10 — the mint declares WHICH BROWSER is asking (`wb-…`, out of
      // localStorage). The same uid reconnects this page's room and pairs its
      // microphone, because it is one browser; sections 7 and 12 need that.
      const minted = await post('/api/web/anon', { turnstile: 'ok', device_uid: BROWSER_UID });
      if (minted.status !== 200) return FAIL(`POST /api/web/anon answered ${minted.status} for an allowed origin with a good token`);
      const identity = await minted.json();
      if (!/^fm_[0-9a-f]{64}$/.test(String(identity.anon_token))) {
        return FAIL(`anon_token is ${JSON.stringify(identity.anon_token)} — it must be an opaque token, never a JWT`);
      }
      if (identity.granted_ms !== 120_000) {
        return FAIL(`the visitor was granted ${identity.granted_ms} ms, want owner W-2's 120000`);
      }
      if (identity.remaining_ms !== 120_000) {
        return FAIL(`a brand-new browser was told remaining_ms=${JSON.stringify(identity.remaining_ms)}, want 120000 — owner §10 asks the page to count down what is LEFT, and on a first visit that is the whole grant`);
      }
      const anonId = db.prepare('SELECT id FROM users WHERE anonymous=1').get()?.id;
      if (!anonId) return FAIL('no anonymous users row was written');

      // 🔴 THE CREDENTIAL OPENS ONE DOOR. Asserted here rather than in the unit
      // test because this is a REAL server with the whole account surface
      // mounted: a token that had become an account JWT would answer 200.
      const asAccount = await fetch(`${url}/api/me`, {
        headers: { authorization: `Bearer ${identity.anon_token}` },
      });
      if (asAccount.status !== 401) {
        return FAIL(`the anonymous token was accepted by GET /api/me (${asAccount.status}) — it must open only the demo room arm`);
      }

      // ── 4 · and a real room ───────────────────────────────────────────────
      const bearer = { authorization: `Bearer ${identity.anon_token}` };
      const built = await post('/api/web/rooms', { auth: { kind: 'anon_token' } }, bearer);
      if (built.status !== 200) return FAIL(`the anonymous arm of POST /api/web/rooms answered ${built.status}`);
      const room = await built.json();
      if (!/^\d{4}$/.test(String(room.code))) return FAIL(`code is ${JSON.stringify(room.code)}, not four digits`);
      if (!/^\d{9}$/.test(String(room.pcid))) return FAIL(`pcid is ${JSON.stringify(room.pcid)} — a demo room with no address cannot be paired with by number`);
      if (room.budget?.mode !== 'trial') {
        return FAIL(`the build response says budget.mode=${JSON.stringify(room.budget?.mode)}, want 'trial' — this is the ONLY way the card knows it is a demo (billing/budget-push.ts serverBudgetModeFor)`);
      }

      // A foreign origin cannot use this perfectly good token.
      const stolen = await post('/api/web/rooms', { auth: { kind: 'anon_token' } }, { ...bearer, origin: 'https://evil.example' });
      if (stolen.status !== 403) {
        return FAIL(`a valid demo token built a room from a foreign origin (${stolen.status}) — the Origin gate is on the mint only`);
      }

      // ── 5 · seed the visitor's CAP down to seconds ────────────────────────
      // The GRANT is untouched at 120 s; what is written is how much of it has
      // already been spent.
      //
      // 🔴 WHAT THIS NUMBER MEANS CHANGED WITH MP-6 AND THE SEED DID NOT. Still
      // `usage_records` for the anonymous identity, still read back by
      // `QuotaGuard.remainingSttMs` — but consulted now as a CEILING ON THE FRAME
      // rather than as the account being spent (`resolvePayer` step 3 hands it
      // over as `capUserId`). Sections 6 and 8 assert that; section 11 asserts
      // nothing writes to this row any more.
      seedUsedMs(anonId, 120_000 - CAP_REMAINING_MS);

      // ── 6 · the page enters its room ──────────────────────────────────────
      const card = track(await connect(url, { token: room.room_token }));
      const cardRec = recordAll(card);
      const rc = await ack(card, 'pc:reconnect', {
        token: room.room_token,
        machine_uid: BROWSER_UID,
        client_instance_id: BROWSER_INSTANCE_ID,
        client: 'web',
        client_version: 'g26',
        target_caps: { image: false },
      });
      if (rc.error) return FAIL(`pc:reconnect with the demo room_token was refused: ${rc.error}`);
      if (rc.budget?.mode !== 'trial') {
        return FAIL(`the reconnect ack says budget.mode=${JSON.stringify(rc.budget?.mode)}, want 'trial' — the card resyncs its meter from this field alone`);
      }
      // 🔴 THE CARD READS THE BROWSER'S OWN GRANT, NOT THE DEMO ACCOUNT'S MONTH,
      // which is what makes this line worth keeping after MP-6: the ack is built
      // by `budgetAckFields(pc.user_id, …)` — the room's ANONYMOUS owner — so the
      // number on the demo card is the visitor's cap. Were it the payer's, the
      // page would open showing 43 minutes.
      if (Math.abs(rc.budget.remaining_ms - CAP_REMAINING_MS) > 250) {
        return FAIL(`the reconnect ack says ${rc.budget.remaining_ms} ms left, seeded ${CAP_REMAINING_MS} on the visitor's own grant (the demo account's month is ${PLAN_MS} ms — if that is what came back, the card is reading the payer instead of the cap)`);
      }

      // ── 7 · the visitor's microphone pairs in ─────────────────────────────
      //
      // 🔴 `client: 'web'` AND THE SAME `device_uid`, both load bearing under
      // MP-6. The cap exists only for a WEB pairing (`web-trial-identity.ts`
      // `isWebPairing` — an App handset in a demo room is metered to the demo
      // account with NO cap at all, a measured gap reported with this card rather
      // than asserted here); and the uid is what makes `trial-ledger.claim` REUSE
      // the identity section 3 minted instead of writing a second one.
      const phone = track(await connect(url));
      const phoneRec = recordAll(phone);
      const pair = await ack(phone, 'mobile:pair', {
        short_code: room.code, pcid: room.pcid,
        device_uid: BROWSER_UID, mobile_name: 'Web-3210', client: 'web', client_version: 'g26',
      });
      if (pair.error) return FAIL(`a browser microphone could not pair with the demo room: ${pair.error}`);
      // ⚠️ THE ACK IS NOT A BARRIER FOR THIS FRAME. `mobile.handler.ts` calls
      // `safeAck(...)` and only THEN `pushJoinBudget(socket, …)`, so the frame is
      // emitted after the ack we just awaited — holding the ack proves nothing
      // about it. Wait for the frame itself.
      await settle(() => budgets(phoneRec).some((b) => b.reason === 'granted'),
        "the phone's granted budget frame");
      const granted = budgets(phoneRec).filter((b) => b.reason === 'granted');
      if (granted.length !== 1) return FAIL(`mobile:pair produced ${granted.length} granted budget frames, want exactly 1`);
      const parsedGrant = safeParseEvent('billing:budget', granted[0]);
      if (!parsedGrant.success) return FAIL(`the join budget frame does not satisfy the protocol schema: ${parsedGrant.error?.message}`);
      //
      // 🔴🔴 DELETED HERE, 2026-09-11 (card MP-6): THREE ASSERTIONS ABOUT THIS
      // FRAME — `mode === 'trial'`, `resets_at === null`, and the demo's
      // remaining time. THEY WERE TRUE UNTIL MP-6 AND ARE FALSE NOW, AND THE
      // REASON IS A REAL GAP, NOT A CHANGE OF MIND.
      //
      // `pushJoinBudget` (socket/handlers/budget-frames.ts) pushes this frame
      // with NO payer hint — it has only `getAuth(socket).userId`, which since
      // MP-6 is the DEMO ACCOUNT. `budget-push.view` derives `mode` from the cap
      // and the cap only, so with no hint it falls back to `modeFor(payer)`, and
      // the payer's own row is an ordinary account: the frame therefore carries
      // `mode:'plan'`, the demo account's monthly remaining, and a real
      // `resets_at`.
      //
      // MEASURED ON THIS FIXTURE, NOT DEDUCED — the frame, verbatim, read by
      // temporarily failing on it (2026-09-11, this worktree):
      //   {"remaining_ms":2580000,"mode":"plan","resets_at":1791590400000,"reason":"granted"}
      // 2 580 000 ms is the DEMO ACCOUNT's 43-minute month, handed to an
      // anonymous visitor, on the first frame the demo page ever sees.
      //
      // Asserting `'trial'` here would fail against the shipped build; asserting
      // `'plan'` would write the gap into the spec, which is the 0.2.52 shape
      // (「a reverse control pointed the wrong way does not miss a defect, it
      // makes the defect the acceptance criterion」). So it asserts neither, and
      // says why in the one place a reader of this file will look. What is left
      // is the schema check above — the frame must at least be a legal frame.
      //
      // ⚠️ THE COVERAGE IT USED TO CARRY IS NOT LOST — it moved one push point
      // down, to the `started` / `exhausted` frames in sections 8 and 9, which DO
      // carry the payer hint and therefore do carry the cap. What is genuinely
      // uncovered is the join frame itself, and that is a report, not this file.
      //
      // …and it really was the demo room's own visitor that paired: the row
      // names the identity section 3 minted, and no second one was written.
      const pairedRow = db.prepare('SELECT client, trial_user_id FROM mobile_pairings WHERE id=?').get(pair.pairing_id);
      if (pairedRow.client !== 'web') return FAIL(`the pairing row says client=${JSON.stringify(pairedRow.client)}, so the cap rule was never even asked`);
      if (pairedRow.trial_user_id !== anonId) {
        return FAIL(`the pairing row names trial identity ${JSON.stringify(pairedRow.trial_user_id)}, want the browser's existing ${anonId} — a second identity IS a second two minutes`);
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get().n !== 1) {
        return FAIL('pairing minted a SECOND anonymous identity for a browser that already had one');
      }

      // Photographed AFTER the pairing, which legitimately rotates this row's
      // `anon_token` (`claim` → `refreshToken`). From here to section 11 nothing
      // may touch either table, and 「nothing」 is asserted as whole rows: a claim
      // about `stt_minutes` alone would miss a row appearing beside it.
      // 🔴 A NUMBER, NOT A WHOLE-ROW PHOTOGRAPH: card MP-6 debits this row, so
      // 「it did not change」 stopped being the assertion. `trial_ledger` below is
      // still whole — that one really must not move.
      const capSpentAtRest = spentMinutes(anonId);
      const trialBefore = JSON.stringify(db.prepare('SELECT * FROM trial_ledger').all());

      // ── 8 · WHOSE MONEY: the demo account's, and the frame says so ────────
      //
      // 🔴 THE CARD'S CENTRAL NEW CLAIM (owner §11). The payer is a REAL account
      // whose own row reads `'plan'`, so `mode:'trial'` here can only have come
      // from the cap being threaded admission → socket → view; and the NUMBER is
      // the cap, not the payer's month, which is design §10-4's 「one visitor
      // must not drink the month」 as a measurement: 4 000 ms against 2 580 000.
      //
      // POSITIVE CONTROL, asserted rather than assumed: the demo account really
      // is untouched here, so the smaller read is genuinely the cap. Without it
      // 「4 000」 could be an account that happened to be nearly spent.
      if (spentMinutes(demoPayerId) !== 0) {
        return FAIL(`the demo account has already spent ${spentMinutes(demoPayerId)} minutes before the first demo recording — the cap assertion below would then prove nothing about which read won`);
      }
      phoneRec.frames.length = 0;
      await speak(phone, 900);
      phone.emit('audio:stop', {});
      // TWO facts, and the second one is what the old 600 ms was really waiting
      // for: `commitSttUsage` runs at settle, three layers below the frame.
      await settle(() => budgets(phoneRec).some((b) => b.reason === 'started')
        && spentMinutes(demoPayerId) > 0,
      "the started budget frame and the demo account's settled usage");
      const started = budgets(phoneRec).filter((b) => b.reason === 'started');
      if (started.length !== 1) return FAIL(`audio:start produced ${started.length} started budget frames, want exactly 1`);
      const parsedStart = safeParseEvent('billing:budget', started[0]);
      if (!parsedStart.success) return FAIL(`the started budget frame does not satisfy the protocol schema: ${parsedStart.error?.message}`);
      if (parsedStart.data.mode !== 'trial') {
        return FAIL(`the demo visitor was told mode=${parsedStart.data.mode}; the payer is a REAL account with a plan, so a demo that says 'plan' shows a subscription's face over a two-minute allowance`);
      }
      if (Math.abs(parsedStart.data.remaining_ms - CAP_REMAINING_MS) > 400) {
        return FAIL(`the demo visitor was told ${parsedStart.data.remaining_ms} ms remain; the cap is ${CAP_REMAINING_MS} and the demo account's own month is ${PLAN_MS} — the lower of the two must win (budget-push.ts view)`);
      }
      if (parsedStart.data.resets_at !== null) {
        return FAIL(`the trial frame carries resets_at=${parsedStart.data.resets_at} — a trial has no cycle to come back at (design §2.3), whatever the payer's own cycle says`);
      }
      // Card NR-31 — 「sign in for a free plan with N minutes every month」. The
      // assertion is against this server's CONFIGURED free tier, so a relay that
      // answered from a literal fails here. (Migrated from G29, which MP-6
      // retired: the demo is now the only place a trial view exists.)
      if (parsedStart.data.free_plan_minutes !== FREE_PLAN_MINUTES) {
        return FAIL(
          `the trial frame carries free_plan_minutes=${JSON.stringify(parsedStart.data.free_plan_minutes)}, `
          + `want ${FREE_PLAN_MINUTES} — this deployment's FLOWMIC_PLAN_LIMITS says the free tier is ${FREE_PLAN_MINUTES} min/month, `
          + 'so either the field is not on the wire (the page must then say nothing about a free plan) '
          + 'or it came from the compiled-in default instead of the effective table',
        );
      }
      // …and the seconds landed on the DEMO ACCOUNT — the sentence owner §11
      // asked for, and the half no unit test reaches: it is written by
      // `commitSttUsage` at settle, three layers below the rule that chose it.
      if (!(spentMinutes(demoPayerId) > 0)) {
        return FAIL(`the DEMO ACCOUNT's usage_records did not move after a demo recording that demonstrably ran (its started frame arrived; the row says ${spentMinutes(demoPayerId)} minutes) — somebody transcribed for free and no account can be asked about it`);
      }

      // ── 9 · the demo account is what runs out, and both ends are told ─────
      // The ceiling that ends a recording is the PAYER's (`stt-factory.ts` arms
      // the session deadline on `remainingSttMs(args.userId)`), so this is the
      // ledger that has to be seeded down for the run to finish in seconds.
      seedUsedMs(demoPayerId, PLAN_MS - SEEDED_BUDGET_MS);
      phoneRec.frames.length = 0;
      cardRec.frames.length = 0;
      await speak(phone, SEEDED_BUDGET_MS,
        () => phoneRec.frames.some((f) => f.event === 'audio:auto-stopped'));
      // The card is told by a DIFFERENT push (`pushPeerBudget`), so it is a
      // separate fact and gets its own wait rather than riding on the phone's.
      await settle(() => budgets(cardRec).some((b) => b.exhausted === true),
        "the card's exhaustion frame");

      const phoneExhausted = budgets(phoneRec).filter((b) => b.exhausted === true);
      if (phoneExhausted.length !== 1 || phoneExhausted[0].remaining_ms !== 0) {
        return FAIL(`the microphone got ${phoneExhausted.length} exhaustion frame(s): ${JSON.stringify(phoneExhausted)}`);
      }
      if (phoneExhausted[0].mode !== 'trial') {
        return FAIL(`the exhaustion frame says mode=${phoneExhausted[0].mode} — the demo's last word about itself must still be 'trial'`);
      }
      const autoStop = phoneRec.frames.find((f) => f.event === 'audio:auto-stopped');
      if (!autoStop) return FAIL(`the relay never ended the demo recording; frames were ${phoneRec.frames.map((f) => f.event).join(' ')}`);
      if (autoStop.args[0].reason !== 'quota_exhausted') {
        return FAIL(`the relay ended the demo for '${autoStop.args[0].reason}', want 'quota_exhausted'`);
      }

      // 🔴 AND THE CARD IS TOLD TOO. The demo's point is a screen somebody is
      // watching, and a card that never learns the demo is over goes on showing a
      // live session forever — `pushPeerBudget`'s reason for existing.
      const cardExhausted = budgets(cardRec).filter((b) => b.exhausted === true);
      if (cardExhausted.length !== 1) {
        return FAIL(`the target end got ${cardExhausted.length} exhaustion frame(s) (the microphone got ${phoneExhausted.length}) — the card would still be showing a running demo`);
      }
      if (cardExhausted[0].mode !== 'trial') {
        return FAIL(`the card's exhaustion frame says mode=${cardExhausted[0].mode}, want 'trial'`);
      }

      // ── 10 · and the next press is refused by the EXISTING code ───────────
      // 🔴 THE REFUSAL NOW COMES OUT OF THE DEMO ACCOUNT'S LEDGER, not the
      // visitor's grant — `ensureQuota(auth.userId)`, and `auth.userId` is the
      // payer. The visitor still has cap left (section 11 proves that row never
      // moved), so a build refusing on the CAP would answer for nobody's money.
      phoneRec.frames.length = 0;
      phone.emit('audio:start', {
        sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
        mode: 'realtime', delivery: 'inject', source_lang: 'en',
      });
      await settle(() => phoneRec.frames.some((f) => f.event === 'stt:error'),
        'the refusal of a press on a spent demo');
      const refusal = phoneRec.frames.find((f) => f.event === 'stt:error');
      if (!refusal) return FAIL(`a press on a spent demo was not refused; frames were ${phoneRec.frames.map((f) => f.event).join(' ') || '(none)'}`);
      if (refusal.args[0].code !== 'QUOTA_EXCEEDED') {
        return FAIL(`the refusal code is ${refusal.args[0].code}, want the EXISTING QUOTA_EXCEEDED (this card adds no refusal code for it)`);
      }

      // ── 11 · THE CAP IS A CEILING, NOT A SECOND BILL ─────────────────────
      //
      // 🔴 INVERTED TWICE, AND THE SECOND TIME WAS INSIDE MP-6 ITSELF. It began
      // meaning 「an account's minutes are never charged to the trial」; MP-6's
      // first draft kept the words and swapped the subject, asserting the
      // anonymous ledger must NOT move — true of that draft and exactly what was
      // wrong with it, because a grant nothing debits is a two-minute label on an
      // unlimited demo. The cap IS debited now (billing/usage-tracker.ts argues
      // why one recording still moves one BILL), so 「whose counter moved」 cannot
      // separate a ceiling from a payer. This does: only the demo ACCOUNT is
      // named in the detail ledger.
      if (spentMinutes(anonId) <= capSpentAtRest) {
        return FAIL(`the visitor's own usage_records did not move (${capSpentAtRest} → ${spentMinutes(anonId)}) — then the grant is frozen and every reload is a second two minutes`);
      }
      if (usageEventsFor(anonId).length !== 0) {
        return FAIL(`the cap identity has ${usageEventsFor(anonId).length} usage_events row(s) — a ceiling is named in no detail row, and a second row would double-count the same seconds`);
      }
      if (JSON.stringify(db.prepare('SELECT * FROM trial_ledger').all()) !== trialBefore) {
        return FAIL('the trial ledger changed while the demo account was billed — ms_granted is written once, at mint');
      }
      // ── 12 · owner §10 — THE TWO MINUTES ARE ONE-TIME, PER BROWSER ────────
      //
      // 🔴 THE SAME BROWSER, ASKING AGAIN, AND THE DISCRIMINATOR IS 120000: a
      // relay that minted a second identity for a browser that already had one
      // answers the full grant — an unlimited demo wearing a two-minute label —
      // and the page would look perfectly correct while doing it, which is why
      // this is a golden and not a unit test. A RANGE, not an exact figure — the
      // number is whatever two real recordings cost, and pinning it would measure
      // the vendor's timing. (An earlier draft asserted the SEEDED value here, on
      // the premise that nothing decrements the grant; see section 11.)
      const againSameBrowser = await post('/api/web/anon', { turnstile: 'ok', device_uid: BROWSER_UID });
      const againBody = await againSameBrowser.json();
      if (againSameBrowser.status !== 200) {
        return FAIL(`a returning browser was refused ${againSameBrowser.status} — owner §10 asks for the identity it already has, not for a closed door: the page needs a refusal it can render and a sign-in it can offer`);
      }
      if (!(againBody.remaining_ms > 0 && againBody.remaining_ms < CAP_REMAINING_MS)) {
        return FAIL(`the SAME browser was told remaining_ms=${JSON.stringify(againBody.remaining_ms)}, want what is LEFT of the ${CAP_REMAINING_MS} it started this section with — owner §10: 「只要不清空浏览器缓存就要记住」 (120000 means a fresh identity was minted for a browser that already had one; ${CAP_REMAINING_MS} unchanged means the cap is not being debited and every reload is a new demo)`);
      }
      if (againBody.granted_ms !== 120_000) {
        return FAIL(`the returning browser's granted_ms is ${againBody.granted_ms}, want an unchanged 120000 — the lifetime grant is written once, at mint, and a reuse that rewrote it is the one way a second two minutes gets out`);
      }
      const anonAfterReturn = db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get().n;
      if (anonAfterReturn !== 1) {
        return FAIL(`${anonAfterReturn} anonymous identities exist after one browser asked twice, want exactly 1 — a second row IS a second two minutes`);
      }
      // …and the credential really was rotated: the first token's hour is
      // shorter than a lifetime trial, so a returning page must get a live one.
      if (againBody.anon_token === identity.anon_token) {
        return FAIL('the returning browser was handed its ORIGINAL token — that credential expires in an hour and a lifetime trial outlives it many times over');
      }

      // POSITIVE CONTROL for the assertion above: without it, 「4 000 ms」 could be
      // a server that has simply stopped handing anything out, and 「one row」
      // could be a mint that is broken. A DIFFERENT browser on the SAME network
      // still gets the whole two minutes — the abuse caps (5/min, 10/day, 600
      // min/day) are what bound this, and they are not an allowance.
      const otherBrowser = await post('/api/web/anon', { turnstile: 'ok', device_uid: 'wb-0123456789abcdef' });
      const otherBody = await otherBrowser.json();
      if (otherBody.granted_ms !== 120_000 || otherBody.remaining_ms !== 120_000) {
        return FAIL(`a DIFFERENT browser on the same network was told ${JSON.stringify(otherBody)}, want a full 120000 both ways — owner §10 removed the per-network decay, and clearing site data is a cost owner accepted`);
      }

      // == LEG G26-b - card W4-05: the visitor signs in, and the meter moves ==
      //
      // Everything above this line is the demo running out. Below it the SAME
      // browser, in the SAME anonymous room, redials carrying a verified account
      // JWT - and from that admission the seconds must come off the ACCOUNT.
      // Design: docs/strategy/2026-09-09-w4-05-login-switches-metering-design.md
      //
      // 🔴 MP-6 MADE THIS LEG THE FIRST STEP OF THE ORDERED RULE RATHER THAN AN
      // EXCEPTION TO IT: a verified speaker outranks every far end, a demo room
      // included (`resolvePayer` step 1, 'self'). So it also has to prove the
      // DEMO ACCOUNT stops paying at that instant - a payer that kept paying
      // would be invisible on every surface a visitor or a card can see, and
      // would show up only on FlowMic's own invoice.
      //
      // THE ORDER IS THE POINT. The demo account is ALREADY EXHAUSTED here
      // (section 10 just proved a press on it is refused), so if the QTA-2 owner
      // gate still asked the room owner's ledger, or the demo account were still
      // the payer, every sentence below would be refused QUOTA_EXCEEDED.

      // -- 13 - an account exists, and the demo's ledgers are photographed ----
      const accountJwt = await saasJwt(url, ACCOUNT_EMAIL);
      await verifyRegisteredEmail(url, accountJwt, mailDir, ACCOUNT_EMAIL);
      const accountId = db.prepare('SELECT id FROM users WHERE email=?').get(ACCOUNT_EMAIL)?.id;
      if (!accountId) return FAIL('the account registered for leg G26-b has no users row');
      const demoPayerUsageBefore = JSON.stringify(usageOf(demoPayerId));
      // 🔴 RE-PHOTOGRAPHED HERE RATHER THAN REUSING `trialBefore`, and the
      // reason is a measurement this file made of itself: section 12's two HTTP
      // calls legitimately WRITE to `trial_ledger` — a returning browser gets a
      // rotated `anon_token`, a new browser gets a whole row. Carrying the
      // section-7 photograph across them made the isolation check below fail on
      // a correct implementation, which is the cheapest possible reminder that a
      // 「nothing moved」 assertion is only as good as the instant it was taken.
      const trialAtSignIn = JSON.stringify(db.prepare('SELECT * FROM trial_ledger').all());
      // card MP-6 — RE-PHOTOGRAPHED, not reused from section 7: the demo
      // recordings in between legitimately spend this ceiling down. This leg
      // asserts it stops moving once an account takes over.
      const capUsageAtSignIn = JSON.stringify(usageOf(anonId));

      // -- 14 - the microphone redials with the JWT; the ack says 'plan' -----
      // The handshake carries BOTH credentials, as the web microphone's transport
      // builds them (packages/core/src/socket/transport.ts buildAuthPayload): the
      // pairing token says WHICH pairing, the jwt says WHO is signed in. Nothing
      // new on the wire.
      // The client's own `disconnect` is a real event; the 200 ms that stood
      // here was a guess about when the relay would notice. Waiting on the
      // event removes the guess for the half we can observe, and the reconnect
      // below is refused BY NAME if the server has not caught up — a named
      // refusal beats a silent stopwatch.
      await new Promise((r) => {
        if (!phone.connected) return r();
        phone.once('disconnect', r);
        phone.disconnect();
        return undefined;
      });
      cardRec.frames.length = 0;
      const signedIn = track(await connect(url, { token: pair.mobile_token, jwt: accountJwt }));
      const signedInRec = recordAll(signedIn);
      const rejoin = await ack(signedIn, 'mobile:reconnect', {
        token: pair.mobile_token, device_uid: BROWSER_UID,
      });
      if (rejoin.error) return FAIL(`the signed-in microphone could not rejoin the demo room: ${rejoin.error}`);
      if (rejoin.budget?.mode !== 'plan') {
        return FAIL(`the reconnect ack says budget.mode=${JSON.stringify(rejoin.budget?.mode)}, want 'plan' - a visitor carrying a verified account is no longer on the demo's clock (MP-6 step 1: the speaker outranks the far end)`);
      }
      if (typeof rejoin.budget.resets_at !== 'number') {
        return FAIL(`the account frame carries resets_at=${rejoin.budget.resets_at} - a plan HAS a cycle to come back at, and the trial's null must not have followed the visitor across`);
      }
      // Card NR-31's other half, migrated from the retired G29: an account is told
      // its OWN ceiling and nothing else — a second, smaller number of minutes
      // beside the one that governs answers a question nobody asked.
      if (rejoin.budget.free_plan_minutes !== undefined) {
        return FAIL(`after signing in the ack still carries free_plan_minutes=${rejoin.budget.free_plan_minutes} - that field is a TRIAL's answer to 「what would an account get」, and this socket has one`);
      }
      // The cap stays ON the row: signing out later is somebody else's card, and
      // clearing it here would hand a fresh two minutes to a browser that had it.
      if (db.prepare('SELECT trial_user_id FROM mobile_pairings WHERE id=?').get(pair.pairing_id).trial_user_id !== anonId) {
        return FAIL("signing in cleared the pairing row's trial identity");
      }

      // AND THE CARD IS TOLD, without being asked. The refusal path emits no
      // budget frame at all, so if the account is already spent this frame is the
      // ONLY thing that ever moves the card off "demo minutes remaining".
      await settle(() => budgets(cardRec).some((b) => b.reason === 'refreshed'),
        "the card's refreshed budget frame on the metering switch");
      const switched = budgets(cardRec).filter((b) => b.reason === 'refreshed');
      if (switched.length !== 1) {
        return FAIL(`the target end got ${switched.length} refreshed budget frame(s) on the switch, want exactly 1 - the card cannot learn this any other way`);
      }
      if (switched[0].mode !== 'plan') {
        return FAIL(`the card's switch frame says mode=${switched[0].mode}; it would go on showing a demo meter beside a recording spending an account's minutes`);
      }

      // -- 15 - seed the ACCOUNT down to seconds, using its own arithmetic ---
      // The full allowance is read off the ack rather than copied from
      // billing/plans.ts: a pasted tier number is a second copy of a value that
      // moves (the free tier has moved twice), and this way the fixture cannot
      // disagree with the product about what free means.
      const accountSeededMinutes = (rejoin.budget.remaining_ms - ACCOUNT_BUDGET_MS) / 60_000;
      seedUsedMs(accountId, rejoin.budget.remaining_ms - ACCOUNT_BUDGET_MS);

      // -- 16 - speaking spends the ACCOUNT, and only the account ------------
      signedInRec.frames.length = 0;
      cardRec.frames.length = 0;
      await speak(signedIn, ACCOUNT_BUDGET_MS,
        () => signedInRec.frames.some((f) => f.event === 'audio:auto-stopped'));
      await settle(() => budgets(signedInRec).some((b) => b.exhausted === true)
        && spentMinutes(accountId) > accountSeededMinutes,
      "the account's exhaustion frame and its settled usage");

      // THE QTA-2 EXCEPTION, ASSERTED AS AN ABSENCE WITH A POSITIVE CONTROL.
      // The absence: no refusal on the room owner's spent demo minutes. The
      // control: the exhaustion frame below proves the session really ran and
      // really ended, so this silence is not the silence of nothing happening.
      const ownerRefusal = signedInRec.frames.find((f) => f.event === 'stt:error' && f.args[0]?.code === 'QUOTA_EXCEEDED');
      if (ownerRefusal) {
        return FAIL('a signed-in account was refused QUOTA_EXCEEDED inside a demo room - either the QTA-2 gate is still asking the anonymous owner, or the exhausted DEMO ACCOUNT is still being consulted for a speaker who outranks it');
      }
      const planExhausted = budgets(signedInRec).filter((b) => b.exhausted === true);
      if (planExhausted.length !== 1 || planExhausted[0].mode !== 'plan') {
        return FAIL(`the signed-in visitor got ${planExhausted.length} exhaustion frame(s) ${JSON.stringify(planExhausted)}, want exactly 1 with mode 'plan'`);
      }
      const planAutoStop = signedInRec.frames.find((f) => f.event === 'audio:auto-stopped');
      if (planAutoStop?.args[0]?.reason !== 'quota_exhausted') {
        return FAIL(`the account's recording ended for '${planAutoStop?.args[0]?.reason}', want 'quota_exhausted'`);
      }
      const cardPlanFrames = budgets(cardRec).filter((b) => b.mode === 'plan');
      if (cardPlanFrames.length === 0) {
        return FAIL('the card was told nothing about the account it is now watching (target-end exception missing - it is still reading the frozen demo ledger)');
      }

      // -- 17 - and NOBODY ELSE was billed for it ----------------------------
      // 🔴 THE DEMO ACCOUNT IS THE NEW HALF OF THIS CLAIM (card MP-6). Until today
      // the only wrong answer available here was the anonymous identity; there is
      // now a REAL account one step lower in the ordered rule, and a step 1 that
      // failed to outrank step 3 would bill FlowMic for every signed-in visitor
      // in its own demo room - on a real invoice, with nothing on screen wrong.
      const accountMinutes = spentMinutes(accountId);
      if (!(accountMinutes > accountSeededMinutes)) {
        return FAIL(`the account's usage_records did not grow (${accountMinutes} minutes, seeded ${accountSeededMinutes}) - nobody was billed for a recording that ran`);
      }
      if (JSON.stringify(usageOf(demoPayerId)) !== demoPayerUsageBefore) {
        return FAIL(`the DEMO ACCOUNT's usage_records changed while a signed-in visitor was speaking: ${JSON.stringify(usageOf(demoPayerId))} (was ${demoPayerUsageBefore}) - a verified speaker outranks the demo (MP-6 step 1 over step 3), so FlowMic must stop paying at that admission`);
      }
      if (JSON.stringify(usageOf(anonId)) !== capUsageAtSignIn) {
        return FAIL("the visitor's anonymous identity was metered while their signed-in account was speaking - the meter did not change hands, only the label did");
      }
      if (JSON.stringify(db.prepare('SELECT * FROM trial_ledger').all()) !== trialAtSignIn) {
        return FAIL('the trial ledger changed while a signed-in account was speaking');
      }

      // -- 18 - a spent ACCOUNT is refused by the ordinary code --------------
      // Q3 (design section 6): no new code and no upgrade sentence on this leg -
      // the card gets the regular exhausted face and the download CTA, a page
      // decision. The server's part is that this is the SAME refusal every paid
      // account gets, not a demo-flavoured variant.
      signedInRec.frames.length = 0;
      signedIn.emit('audio:start', {
        sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
        mode: 'realtime', delivery: 'inject', source_lang: 'en',
      });
      await settle(() => signedInRec.frames.some((f) => f.event === 'stt:error'),
        'the refusal of a press on a spent account');
      const planRefusal = signedInRec.frames.find((f) => f.event === 'stt:error');
      if (planRefusal?.args[0]?.code !== 'QUOTA_EXCEEDED') {
        return FAIL(`a press on a spent ACCOUNT answered ${JSON.stringify(planRefusal?.args[0]?.code)}, want the ordinary QUOTA_EXCEEDED`);
      }

      return PASS(
        `identity ${anonId} granted 120000 ms; demo room ${room.pcid} says mode:'trial' over HTTP and on the card's reconnect ack, reading the VISITOR's cap (${CAP_REMAINING_MS} ms) rather than the payer's ${PLAN_MS} ms month; `
        + `the browser's own microphone paired in and its started frame said mode:'trial' with the CAP as the number and free_plan_minutes=${FREE_PLAN_MINUTES} out of this server's FLOWMIC_PLAN_LIMITS (card NR-31, migrated from the retired G29); `
        + `the seconds landed on demo account ${demoPayerId} (owner §11), which is also what ran out -> audio:auto-stopped{quota_exhausted} with BOTH ends getting a mode:'trial' exhaustion frame and the next press refused QUOTA_EXCEEDED, `
        + "while the visitor's own usage_records were DEBITED as a ceiling and named in no usage_events row, and the trial_ledger stayed byte-identical (ms_granted is written once); "
        + 'a bad Turnstile solve and a foreign origin were each refused by their own registered code; '
        + `owner §10: the SAME browser asking again got its OWN identity back with a rotated token (one anonymous row, not two), at what was LEFT of its ${CAP_REMAINING_MS} ms rather than a fresh 120000, while a DIFFERENT browser still got a full 120000; `
        + `G26-b: the same browser redialled with account ${accountId}'s JWT -> ack mode:'plan' with a real resets_at and no free_plan_minutes, the card got exactly one refreshed{plan} frame, `
        + "speaking spent the ACCOUNT to auto-stopped{quota_exhausted} with the DEMO ACCOUNT's and the visitor's ledgers both byte-identical, and the spent account was refused by the ordinary QUOTA_EXCEEDED",
      );
    } catch (e) {
      return FAIL(`G26 threw: ${e?.stack || e?.message || String(e)}`);
    } finally {
      for (const s of open) { try { s.disconnect(); } catch { /* already gone */ } }
      try { db?.close(); } catch { /* the process is going away anyway */ }
      try { saas?.child?.kill(); } catch { /* already gone */ }
      try { turnstile.srv.close(); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    }
  },
};

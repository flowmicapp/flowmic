// G34 — the anonymous web visitor's 120 s is ENFORCED, not only displayed.
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS NOT A SECTION OF G26 ────────────────
//
// `FLOWMIC_WEB_ANON_ENABLED` is on by default since owner's 2026-09-16 ruling,
// so 「a stranger may talk to our engines without an account」 is now the SHIPPED
// default, and the only thing between it and an unbounded bill is the
// per-browser grant in `billing/trial-ledger.ts` (`TRIAL_LIFETIME_GRANT_MS`).
// A cross-check on 2026-09-16 found that grant asserted on its DISPLAY face
// only — the mint's `remaining_ms`, the frames' `mode:'trial'`, the debit on
// `usage_records` — and nowhere on its ENFORCEMENT face.
//
// 🔴 G26 LOOKS LIKE IT COVERS THIS AND DOES NOT. Its section 10 refusal is a
// press on a spent DEMO ACCOUNT (its own comment says so: 「the visitor still has
// cap left」), i.e. the payer's monthly ceiling under `ensureQuota(auth.userId)`.
// The visitor's own ceiling is a DIFFERENT gate on a DIFFERENT id —
// `audio.handler.ts`'s `gate = 'trial_cap'; ensureQuota(auth.capUserId, 'stt')`
// — and deleting that gate leaves every assertion in G26 green.
//
// So this case is built the OTHER WAY ROUND on purpose: the demo account keeps a
// whole month in hand and only the BROWSER's grant is spent. Then there is
// exactly one ceiling in the room that can refuse anything, and every refusal
// below is about it. Two goldens, two ceilings — not two copies.
//
// SPEC-REF:
//   apps/server-core/src/billing/trial-ledger.ts (`TRIAL_LIFETIME_GRANT_MS`,
//     `trialLimitsFrom` — the 120 s and the limits it becomes)
//   apps/server-core/src/socket/handlers/audio.handler.ts (gate `'trial_cap'`)
//   apps/server-core/src/billing/quota-guard.ts (the one `QUOTA_EXCEEDED` throw)
//   apps/server-core/src/billing/capped-remaining.ts (the session deadline takes
//     the LOWER of payer and cap — which is why the recording below auto-stops
//     at all while the payer still holds 37 minutes)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// ── THE TWO GROUPS, AND WHY THEY ARE JUDGED SEPARATELY ──────────────────────
// This repo's rule for anything tier/quota shaped: assert the NAME and assert
// THE NUMBER THAT ACTUALLY BITES, separately, because a build can get one right
// and the other wrong and the first one is what everybody looks at.
//   · GROUP A (what the visitor is told) — section 6: the exhaustion frames on
//     BOTH ends say `mode:'trial'` with `remaining_ms:0`, and a reload of
//     `POST /api/web/anon` for the same browser answers `remaining_ms:0` on an
//     unchanged `granted_ms:120000`.
//   · GROUP B (what the server does) — section 7: the next `audio:start` is
//     refused `QUOTA_EXCEEDED`, no session starts, and the `usage_events` row
//     names the BROWSER's identity in `refused_user_id` — whose ceiling said no.
// Neither is accepted for the other. A build that renders zero and transcribes
// anyway fails B; a build that refuses while the page still shows time left
// fails A.
//
// ── REVERSE CONTROL, ACTUALLY RUN (2026-09-16, dev-pc-a) ───────────────────
// The `'trial_cap'` gate in `audio.handler.ts` — three lines, and the only
// enforcement of this grant anywhere in the tree — was deleted, server-core
// rebuilt, and this case re-run. GROUP A STAYED GREEN, which is the point of
// counting the two separately: the view reads the cap directly, so the frames
// still said `mode:'trial'` with `remaining_ms:0` and the reload still answered
// 0. GROUP B went red at section 7, verbatim:
//
//   [FAIL] a press by a browser whose 120000 ms grant is spent
//          (120300/120000 ms used) was NOT refused; frames were
//          billing:budget stt:engine-status billing:budget audio:auto-stopped
//          stt:final
//
// — a countdown at zero on both screens, and a relay that opened a session and
// transcribed anyway. The gate was restored, rebuilt, and the case went back to
// PASS. The control was a DELETION, so there is no marker string to grep for:
// `git diff -- apps/server-core` being empty is what says it was put back.
//
// ── WHAT IT DOES NOT NEED ──────────────────────────────────────────────────
// No vendor STT engine (the pool points at a closed port — enough to arm the
// quota deadline; G24's header carries that measurement) and no LAN. Turnstile
// is the REAL verifier pointed at a local stub. It never SKIPs.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt, verifyRegisteredEmail,
  mailFileDir, mailFileEnv, PASS, FAIL, waitUntil, settleAfter, LIVENESS_CEILING_MS,
} from './harness.mjs';
// Cloudflare's siteverify, locally — imported rather than copied. It is not one
// of this scenario's numbers; it is a stand-in for an external service, and two
// copies would be two places that have to keep answering `success` the same way.
// Everything below that DECIDES anything is this file's own.
import { startSiteverifyStub } from './g26-site-demo-fixtures.mjs';

/** The lifetime grant the product hands a browser, restated here as the figure
 *  this case is ABOUT. Deliberately a literal and not an import of
 *  `TRIAL_LIFETIME_GRANT_MS`: a case that reads the constant it is checking
 *  stays green through a change to that constant, which is the one change
 *  owner's ruling says must not happen quietly. */
const GRANT_MS = 120_000;
/**
 * How much of the grant is left after seeding — the only ceiling in the room.
 *
 * 4 000 rather than a round half: `usage_records.stt_minutes` is REAL and the
 * seed writes minutes, so 116 000 ms is exactly 1.933… min and reads back at
 * 4 000 with no float dust for a real drift to hide in (G26's fixture measured
 * that; the number is reused for the reason, not by habit).
 */
const CAP_REMAINING_MS = 4_000;
/**
 * The demo account's month, pushed in through the production override path
 * (`FLOWMIC_PLAN_LIMITS`).
 *
 * 🔴 BIG ON PURPOSE, AND IT IS HALF THE CASE. Every refusal below must be the
 * BROWSER's, so the payer is given a month it cannot come close to spending in
 * four seconds. Were this number small, 「refused」 would have two possible
 * authors and the file would prove neither.
 *
 * 🔴 AND NOT 20 (the compiled-in default) OR 43 (G26's): a fixture using a
 * number some source file already contains passes just as happily against a
 * relay answering from a literal.
 */
const DEMO_PLAN_MINUTES = 37;
const DEMO_PAYER_EMAIL = 'g34-flowmic-demo@flowmic.test';
const SITE_ORIGIN = 'http://localhost:5173';
const HEARTBEAT_MS = 300;
/** The browser that spends its grant, and a second one that never does — the
 *  positive control in section 8. */
const BROWSER_UID = 'wb-34aaaaaaaaaaaaaa';
const FRESH_UID = 'wb-34bbbbbbbbbbbbbb';
const instanceIdOf = (uid) => `web-${uid.replace(/^[a-z]{2}-/, '').slice(0, 8)}`;
const POOL = JSON.stringify([{
  id: 'g34-unreachable', provider: 'custom-openai-compatible', model: 'g34',
  api: 'http://127.0.0.1:9/v1', api_key: 'g34', enabled: true, priority: 1,
}]);
const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);
/** The window a SECOND frame would have to arrive in for the `!== 1` counts
 *  below to be about duplicates rather than about timing. Same role and same
 *  number as G26's, and it answers this file's own question. */
const DUP_WINDOW_MS = 200;
const settle = (pred, what, ceilingMs) => settleAfter(pred, what, DUP_WINDOW_MS, ceilingMs);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export const G34 = {
  id: 'G34',
  name: "the anonymous visitor's 120 s is ENFORCED: with the demo account holding a whole month, the BROWSER's own grant is what arms the auto-stop, both ends are told mode:'trial' remaining_ms:0, a reload of POST /api/web/anon answers 0 on an unchanged granted_ms:120000, and the next audio:start is refused QUOTA_EXCEEDED with the BROWSER named as refused_user_id — while a fresh browser on the same relay is not refused at all",
  requires: [
    'apps/server-core/src/billing/trial-ledger.ts',
    // The gate this file exists for. Named here so that removing it breaks the
    // declaration as well as the assertion.
    'apps/server-core/src/socket/handlers/audio.handler.ts',
    'apps/server-core/src/billing/quota-guard.ts',
    'apps/server-core/src/billing/capped-remaining.ts',
  ],
  async fn() {
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent } = protocol;

    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g34-'));
    const dbPath = path.join(dir, 'g34.sqlite');
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
      FLOWMIC_TURNSTILE_SECRET: 'g34-secret',
      FLOWMIC_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${turnstile.port}/siteverify`,
      FLOWMIC_TRIAL_IP_SALT: 'g34-salt',
      // Section 7 reads the refusal row out of this table. Off by default in
      // production because the switch gates COLLECTION, not the columns.
      FLOWMIC_USAGE_EVENTS_ENABLED: '1',
      FLOWMIC_PLAN_LIMITS: JSON.stringify({ free: { stt_minutes: DEMO_PLAN_MINUTES } }),
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
      const spentMinutes = (userId) => db.prepare('SELECT stt_minutes FROM usage_records WHERE user_id=?').get(userId)?.stt_minutes ?? 0;
      const spentMs = (userId) => spentMinutes(userId) * 60_000;
      // The bucket key is the account's own cycle anchor (billing/usage-period.ts:
      // a fresh account is anchored at registration), read off its row rather
      // than guessed — a seed written to a calendar month the guard never reads
      // is a fixture that silently does nothing.
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
      /** A demo room with a browser microphone in it, built the product's way.
       *  Used twice — once for the browser that runs out and once for the fresh
       *  one in section 8 — because a positive control is only a control if it
       *  walks the SAME path. */
      const openDemo = async (uid) => {
        const minted = await post('/api/web/anon', { turnstile: 'ok', device_uid: uid });
        if (minted.status !== 200) throw new Error(`POST /api/web/anon answered ${minted.status} for ${uid}`);
        const identity = await minted.json();
        const bearer = { authorization: `Bearer ${identity.anon_token}` };
        const built = await post('/api/web/rooms', { auth: { kind: 'anon_token' } }, bearer);
        if (built.status !== 200) throw new Error(`the anonymous arm of POST /api/web/rooms answered ${built.status} for ${uid}`);
        const room = await built.json();
        const card = track(await connect(url, { token: room.room_token }));
        const cardRec = recordAll(card);
        const rc = await ack(card, 'pc:reconnect', {
          token: room.room_token,
          machine_uid: uid,
          client_instance_id: instanceIdOf(uid),
          client: 'web',
          client_version: 'g34',
          target_caps: { image: false },
        });
        if (rc.error) throw new Error(`pc:reconnect with a demo room_token was refused: ${rc.error}`);
        const phone = track(await connect(url));
        const phoneRec = recordAll(phone);
        // `client:'web'` and the SAME device_uid are both load bearing: the cap
        // exists only for a WEB pairing (`auth/web-trial-identity.ts`
        // `isWebPairing`), and the uid is what makes `trial-ledger.claim` REUSE
        // the identity the mint just wrote instead of writing a second one — a
        // second identity IS a second two minutes.
        const pair = await ack(phone, 'mobile:pair', {
          short_code: room.code, pcid: room.pcid,
          device_uid: uid, mobile_name: `Web-${uid.slice(-4)}`, client: 'web', client_version: 'g34',
        });
        if (pair.error) throw new Error(`a browser microphone could not pair with the demo room: ${pair.error}`);
        const anonId = db.prepare('SELECT trial_user_id FROM mobile_pairings WHERE id=?').get(pair.pairing_id)?.trial_user_id;
        if (!anonId) throw new Error(`the pairing row for ${uid} names no trial identity — the cap rule was never even asked`);
        return { identity, room, card, cardRec, phone, phoneRec, anonId };
      };

      // ── 0 · FlowMic's demo account, and the restart that points the relay at it
      //
      // Nothing about the product is asserted here. `FLOWMIC_DEMO_PAYER_USER_ID`
      // names a `users` row, the server generates that id and `loadConfig` reads
      // env once at boot, so the only honest way to point a running relay at a
      // REAL account is: boot, register, read the id, boot again on the same
      // file. VERIFIED because `audio:start`'s verification-grace gate judges the
      // ACTING account, which on every demo press is this one.
      const demoJwt = await saasJwt(url, DEMO_PAYER_EMAIL);
      await verifyRegisteredEmail(url, demoJwt, mailDir, DEMO_PAYER_EMAIL);
      const demoPayerId = db.prepare('SELECT id FROM users WHERE email=?').get(DEMO_PAYER_EMAIL)?.id;
      if (!demoPayerId) return FAIL('the demo payer account has no users row');
      const dying = saas?.child;
      try { dying?.kill(); } catch { /* restarting */ }
      if (dying && dying.exitCode === null && dying.signalCode === null) {
        // The child's own `exit`, not a sleep: the next line binds the same port,
        // and a stopwatch that loses that race produces a sentence about the
        // product ("the relay cannot start with a demo payer") for a reason that
        // has nothing to do with it.
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

      // ── 1 · a visitor, a demo room, and a microphone in it ────────────────
      const visitor = await openDemo(BROWSER_UID);
      const { anonId } = visitor;
      if (visitor.identity.granted_ms !== GRANT_MS || visitor.identity.remaining_ms !== GRANT_MS) {
        return FAIL(`a brand-new browser was granted ${JSON.stringify(visitor.identity)} — want granted_ms and remaining_ms both ${GRANT_MS}; everything below measures what is spent OUT OF that number`);
      }

      // ── 2 · the only ceiling in the room is the browser's ─────────────────
      // Seed the VISITOR down to seconds and leave the PAYER's month untouched.
      // This is the shape that makes the rest of the file mean something: with
      // 37 minutes on the payer, nothing but the browser's own grant can end a
      // four-second recording or refuse the press after it.
      seedUsedMs(anonId, GRANT_MS - CAP_REMAINING_MS);
      if (spentMinutes(demoPayerId) !== 0) {
        return FAIL(`the demo account had already spent ${spentMinutes(demoPayerId)} minutes before the first recording — then a refusal below could be the payer's, and this case separates nothing`);
      }

      // ── 3 · POSITIVE CONTROL: with time left, the press RUNS ──────────────
      //
      // 🔴 WITHOUT THIS, 「refused」 IN SECTION 7 COULD BE A PROBE THAT IS BLIND —
      // a relay refusing every anonymous press, or a microphone that never got
      // into the room, looks exactly like an enforced cap from the far end.
      visitor.phoneRec.frames.length = 0;
      await speak(visitor.phone, CAP_REMAINING_MS,
        () => visitor.phoneRec.frames.some((f) => f.event === 'audio:auto-stopped'));
      // ⚠️ `QUOTA_EXCEEDED` SPECIFICALLY, not 「any stt:error」. The pool points at
      // a closed port on purpose (see the header), so this session also produces
      // an ENGINE error — which is not a refusal at the door and must not be read
      // as one. What this control is about is the gate: a press with time left
      // must get past `ensureQuota`.
      const quotaRefusals = (rec) => rec.frames.filter((f) => f.event === 'stt:error' && f.args[0]?.code === 'QUOTA_EXCEEDED');
      if (quotaRefusals(visitor.phoneRec).length > 0) {
        return FAIL(`a browser with ${CAP_REMAINING_MS} ms of its grant left was refused QUOTA_EXCEEDED at the door — the positive control failed, so nothing this file says about a refusal afterwards means anything`);
      }
      const started = budgets(visitor.phoneRec).filter((b) => b.reason === 'started');
      if (started.length !== 1) return FAIL(`audio:start produced ${started.length} started budget frames, want exactly 1`);
      const parsedStart = safeParseEvent('billing:budget', started[0]);
      if (!parsedStart.success) return FAIL(`the started budget frame does not satisfy the protocol schema: ${parsedStart.error?.message}`);
      // GROUP A, first half: the NAME. The payer is a real account whose own row
      // reads 'plan', so 'trial' here can only have come from the cap being
      // threaded admission → socket → view.
      if (parsedStart.data.mode !== 'trial') {
        return FAIL(`the demo visitor was told mode=${parsedStart.data.mode} — the payer is an ordinary account, so a demo that says 'plan' shows a subscription's face over a two-minute allowance`);
      }
      // …and the NUMBER, which a correct name proves nothing about: 37 minutes
      // of payer would also be a perfectly legal frame.
      if (Math.abs(parsedStart.data.remaining_ms - CAP_REMAINING_MS) > 400) {
        return FAIL(`the demo visitor was told ${parsedStart.data.remaining_ms} ms remain; the browser's cap is ${CAP_REMAINING_MS} and the payer's month is ${DEMO_PLAN_MINUTES * 60_000} — the lower of the two must win (billing/capped-remaining.ts)`);
      }

      // ── 4 · the recording ends on the BROWSER's grant ─────────────────────
      const autoStop = visitor.phoneRec.frames.find((f) => f.event === 'audio:auto-stopped');
      if (!autoStop) {
        return FAIL(`the relay never ended a recording whose cap was ${CAP_REMAINING_MS} ms (the payer held ${DEMO_PLAN_MINUTES} minutes, so the deadline can only have come from the visitor's grant); frames were ${visitor.phoneRec.frames.map((f) => f.event).join(' ') || '(none)'}`);
      }
      if (autoStop.args[0].reason !== 'quota_exhausted') {
        return FAIL(`the relay ended the demo for '${autoStop.args[0].reason}', want 'quota_exhausted'`);
      }
      // The debit is what makes 「spent」 a fact rather than a label: without it
      // every reload is a fresh two minutes with a countdown and nothing behind
      // it. Waited for rather than assumed — `commitSttUsage` runs at settle,
      // three layers below the frame that just arrived.
      await waitUntil(() => spentMs(anonId) >= GRANT_MS,
        "the visitor's own usage_records never reached the grant")
        .catch(() => { /* judged on the next line, with the number in the message */ });
      if (spentMs(anonId) < GRANT_MS) {
        return FAIL(`the visitor's usage_records stand at ${spentMs(anonId)} ms of the ${GRANT_MS} ms grant after the recording auto-stopped — a grant nothing spends is a two-minute label on an unlimited demo`);
      }

      // ── 5 · and the payer is NOT what ran out (positive control) ──────────
      if (spentMinutes(demoPayerId) >= DEMO_PLAN_MINUTES) {
        return FAIL(`the demo account spent ${spentMinutes(demoPayerId)} of its ${DEMO_PLAN_MINUTES} minutes — then the auto-stop above and the refusal below have a second possible author`);
      }
      if (!(spentMinutes(demoPayerId) > 0)) {
        return FAIL('the DEMO ACCOUNT\'s usage_records did not move after a demo recording that demonstrably ran — somebody transcribed for free and no account can be asked about it');
      }

      // ══ GROUP A — WHAT THE VISITOR IS TOLD ═══════════════════════════════
      // ── 6 · zero, on both ends and on the page's own reload ───────────────
      await settle(() => budgets(visitor.cardRec).some((b) => b.exhausted === true),
        "the card's exhaustion frame");
      const phoneExhausted = budgets(visitor.phoneRec).filter((b) => b.exhausted === true);
      if (phoneExhausted.length !== 1) {
        return FAIL(`the microphone got ${phoneExhausted.length} exhaustion frame(s): ${JSON.stringify(phoneExhausted)}`);
      }
      if (phoneExhausted[0].remaining_ms !== 0 || phoneExhausted[0].mode !== 'trial') {
        return FAIL(`the microphone's exhaustion frame is ${JSON.stringify(phoneExhausted[0])} — want remaining_ms:0 with mode:'trial' (the demo's last word about itself is still a trial, whatever the payer's own row says)`);
      }
      // The CARD is the screen somebody is actually watching; a card that never
      // learns the demo is over goes on showing a live session forever.
      const cardExhausted = budgets(visitor.cardRec).filter((b) => b.exhausted === true);
      if (cardExhausted.length !== 1) {
        return FAIL(`the target end got ${cardExhausted.length} exhaustion frame(s) (the microphone got ${phoneExhausted.length}) — the page would still be showing a running demo`);
      }
      if (cardExhausted[0].remaining_ms !== 0 || cardExhausted[0].mode !== 'trial') {
        return FAIL(`the card's exhaustion frame is ${JSON.stringify(cardExhausted[0])} — want remaining_ms:0 with mode:'trial'`);
      }
      // 🔴 AND ON RELOAD, which is the only face a returning visitor sees before
      // any socket exists. `granted_ms` must NOT have moved: a relay that
      // "refreshed" the grant here is the one way a second two minutes gets out,
      // and it would look identical to a correct one on every frame above.
      const reload = await post('/api/web/anon', { turnstile: 'ok', device_uid: BROWSER_UID });
      const reloadBody = await reload.json();
      if (reload.status !== 200) {
        return FAIL(`a returning spent browser was refused ${reload.status} — owner §10 asks for the identity it already has, with zero left, not a closed door: the page needs a refusal it can render and a sign-in it can offer`);
      }
      if (reloadBody.remaining_ms !== 0) {
        return FAIL(`the spent browser was told remaining_ms=${JSON.stringify(reloadBody.remaining_ms)} on reload, want 0 — it has already used ${spentMs(anonId)} ms of a ${GRANT_MS} ms lifetime grant`);
      }
      if (reloadBody.granted_ms !== GRANT_MS) {
        return FAIL(`the returning browser's granted_ms is ${reloadBody.granted_ms}, want an unchanged ${GRANT_MS} — the lifetime grant is written once, at mint`);
      }

      // ══ GROUP B — WHAT THE SERVER DOES ═══════════════════════════════════
      // ── 7 · the next press is REFUSED, and by the browser's ceiling ───────
      //
      // 🔴 THIS IS THE ASSERTION THE FILE EXISTS FOR. Everything in GROUP A is
      // compatible with a relay that transcribes anyway: the view reads the cap,
      // so it would print the same zero either way.
      visitor.phoneRec.frames.length = 0;
      visitor.phone.emit('audio:start', {
        sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
        mode: 'realtime', delivery: 'inject', source_lang: 'en',
      });
      await settle(() => visitor.phoneRec.frames.some((f) => f.event === 'stt:error'),
        'the refusal of a press by a spent browser');
      const refusal = visitor.phoneRec.frames.find((f) => f.event === 'stt:error');
      if (!refusal) {
        return FAIL(`a press by a browser whose ${GRANT_MS} ms grant is spent (${spentMs(anonId)}/${GRANT_MS} ms used) was NOT refused; frames were ${visitor.phoneRec.frames.map((f) => f.event).join(' ') || '(none)'}`);
      }
      if (refusal.args[0].code !== 'QUOTA_EXCEEDED') {
        return FAIL(`the refusal code is ${JSON.stringify(refusal.args[0].code)}, want the EXISTING QUOTA_EXCEEDED (this case adds no refusal code, and a code the phone does not know renders as a bare identifier)`);
      }
      // …and nothing ran. A refusal that still opens a session would bill the
      // payer for audio nobody was allowed to send.
      if (budgets(visitor.phoneRec).some((b) => b.reason === 'started')) {
        return FAIL('the refused press still produced a started budget frame — the session opened anyway, and the refusal is only a message');
      }
      // 🔴 WHOSE CEILING SAID NO — the discriminator between this case and G26's
      // section 10, which answers the same code for the payer's month.
      // `audio.handler.ts` sets `judged = auth.capUserId` on the `'trial_cap'`
      // gate, and that is what lands in `refused_user_id`.
      const refusalRows = db.prepare("SELECT * FROM usage_events WHERE outcome='quota_refused' AND kind='stt'").all();
      if (refusalRows.length !== 1) {
        return FAIL(`${refusalRows.length} quota_refused rows exist, want exactly 1 — a refusal that leaves no row is invisible in the one table an operator aggregates, and two rows double-count one press`);
      }
      if (refusalRows[0].refused_user_id !== anonId) {
        return FAIL(`the refusal row says refused_user_id=${JSON.stringify(refusalRows[0].refused_user_id)}, want the BROWSER's identity ${anonId} — naming the payer would assert that FlowMic's own month ran out, which is false (${spentMinutes(demoPayerId)} of ${DEMO_PLAN_MINUTES} minutes spent) and would send an operator after the wrong ledger`);
      }
      if (refusalRows[0].user_id !== demoPayerId) {
        return FAIL(`the refusal row says user_id=${JSON.stringify(refusalRows[0].user_id)}, want the ACTING account ${demoPayerId} — 「whose attempt」 and 「whose ceiling」 are two columns on purpose`);
      }

      // ── 8 · POSITIVE CONTROL: a FRESH browser is not refused ──────────────
      //
      // 🔴 THE REFUSAL ABOVE MUST BE PER-BROWSER, and by now the relay has been
      // in a refusing mood once. Without this, 「no anonymous press works any
      // more」 — a captcha stub that stopped answering, a demo payer that lost
      // its verification, a room-building gate that closed — reads as an
      // enforced cap.
      const fresh = await openDemo(FRESH_UID);
      if (fresh.anonId === anonId) {
        return FAIL('a different browser was handed the SAME anonymous identity — the control shares the very ceiling it is supposed to be independent of');
      }
      fresh.phoneRec.frames.length = 0;
      await speak(fresh.phone, 700);
      fresh.phone.emit('audio:stop', {});
      await settle(() => budgets(fresh.phoneRec).some((b) => b.reason === 'started'),
        "the fresh browser's started budget frame");
      // Same narrowing as section 3, for the same reason: the engine is a closed
      // port here, and its timeout is not a ceiling saying no.
      if (quotaRefusals(fresh.phoneRec).length > 0) {
        return FAIL('a browser that has never spoken was refused QUOTA_EXCEEDED — the ceiling is not per-browser, so section 7 proves nothing about this visitor\'s own grant');
      }
      const freshStarted = budgets(fresh.phoneRec).filter((b) => b.reason === 'started');
      if (freshStarted.length !== 1 || freshStarted[0].mode !== 'trial') {
        return FAIL(`the fresh browser got ${freshStarted.length} started frame(s) ${JSON.stringify(freshStarted)} — want exactly one, mode:'trial'`);
      }
      if (Math.abs(freshStarted[0].remaining_ms - GRANT_MS) > 400) {
        return FAIL(`the fresh browser was told ${freshStarted[0].remaining_ms} ms remain, want the whole ${GRANT_MS} — a browser that has spent nothing starts at the full grant, and this is also what proves the ${CAP_REMAINING_MS} above was a seeded cap rather than a server that had stopped handing anything out`);
      }

      return PASS(
        `demo account ${demoPayerId} held ${DEMO_PLAN_MINUTES} minutes throughout, so the ONLY ceiling in the room was browser ${BROWSER_UID}'s own grant; `
        + `with ${CAP_REMAINING_MS} ms seeded left the press RAN (one started frame, mode:'trial', ${parsedStart.data.remaining_ms} ms — the cap, not the payer's month) and the relay ended it with audio:auto-stopped{quota_exhausted}, debiting the visitor's usage_records to ${spentMs(anonId)} ms of ${GRANT_MS}; `
        + "GROUP A — both ends got exactly one exhaustion frame at remaining_ms:0 mode:'trial', and a reload of POST /api/web/anon answered remaining_ms:0 on an unchanged granted_ms:120000; "
        + `GROUP B — the next audio:start was refused QUOTA_EXCEEDED with no session started, and the single quota_refused row names the BROWSER (${anonId}) in refused_user_id beside the acting demo account, which had spent only ${spentMinutes(demoPayerId)} of ${DEMO_PLAN_MINUTES} minutes; `
        + `and a FRESH browser on the same relay was not refused at all, opening at the full ${GRANT_MS} ms`,
      );
    } catch (e) {
      return FAIL(`G34 threw: ${e?.stack || e?.message || String(e)}`);
    } finally {
      for (const s of open) { try { s.disconnect(); } catch { /* already gone */ } }
      try { db?.close(); } catch { /* the process is going away anyway */ }
      try { saas?.child?.kill(); } catch { /* already gone */ }
      try { turnstile.srv.close(); } catch { /* already gone */ }
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    }
  },
};

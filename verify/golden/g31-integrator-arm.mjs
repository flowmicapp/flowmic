// G31 — THE THIRD-PARTY HOST ARM, END TO END (card MP-1).
//
// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md
//     §9-1 and the §11 追认 (「已登录用户默认也是扣对端」 — the third-party far end
//     outranks a signed-in speaker; `INTEGRATOR_QUOTA_EXCEEDED` approved)
//   docs/archive/strategy/2026-09-11-metering-principal-matrix-design.md §4 (what may be
//     on the wire), §5 (failure directions), §6 (the reverse controls), §10-6
//
// ── WHY A SEPARATE FILE RATHER THAN FIVE MORE SECTIONS IN G30 ───────────────
// G30 stands at 787 of the 800-line `file-size` cap and this card needs a
// publishable key, a console round trip, two speakers and a sub-quota that runs
// out. It is also a different QUESTION: G30 asks 「which of the five branches
// chose this payer」, and this one asks 「does the third-party ARM exist, and does
// its ceiling actually stop a recording」.
//
// ── WHAT THIS GOLDEN IS FOR ────────────────────────────────────────────────
// Every one of these assertions is about a fact NO unit test in this repo can
// reach, because each of them spans two processes: an HTTP route mints a row, a
// socket admission reads it, a recording settles into a counter, and the next
// admission is refused by that counter. The unit tests
// (`test/integrator-keys.test.ts`) pin the arithmetic; this pins that the
// arithmetic is WIRED.

import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT, startSaasServer, connect, ack, recordAll, saasJwt, verifyRegisteredEmail,
  mailFileDir, mailFileEnv, PASS, FAIL,
} from './harness.mjs';

/** The integrator's ceiling, pushed through the production override so a relay
 *  answering from a compiled-in literal cannot pass by coincidence. Generous:
 *  the whole point of the sub-quota assertion is that T's PLAN is still rich
 *  when the KEY runs out. */
const PLAN_MINUTES = 30;
/**
 * The per-key sub-quota. WHOLE MINUTES, because that is what the console field
 * takes and what the column stores — a golden that could pass a fractional
 * minute would be exercising a shape the product does not accept.
 *
 * 🔴 SO THE EXHAUSTION CASE SEEDS THE COUNTER RATHER THAN SPEAKING FOR A MINUTE:
 * section 6 writes `used_ms` to within `KEY_HEADROOM_MS` of this ceiling, which
 * is the same technique G30 uses on `usage_records` and for the same reason (a
 * golden must not take a minute of wall clock to reach a limit).
 */
const KEY_QUOTA_MINUTES = 1;
const KEY_QUOTA_MS = KEY_QUOTA_MINUTES * 60_000;
/** How much of that sub-quota is left when the exhaustion case starts. */
const KEY_HEADROOM_MS = 800;
const HEARTBEAT_MS = 300;

const T_EMAIL = 'g31-integrator-t@flowmic.test';
const B_EMAIL = 'g31-signed-in-b@flowmic.test';
/**
 * What T calls this key in their console — and, since card MP-13, what a visitor
 * on that page sees as the room's name on their phone.
 *
 * Deliberately NOT 'g31' or anything FlowMic-shaped: the assertion is that a
 * SITE'S OWN name travels, and a fixture that happened to look like a product
 * string would pass against a room still named `INTEGRATOR_ROOM_PC_NAME`.
 */
const KEY_LABEL = 'Acme Docs g31';

/** The page that embedded FlowMic, and one that did not. */
const HOST_ORIGIN = 'https://host.g31.test';
const OTHER_ORIGIN = 'https://not-the-host.g31.test';
const GUEST_UID = 'wb-1111222233334444';
const SIGNED_UID = 'wb-5555666677778888';
/** The third visitor — the one whose press runs into the exhausted sub-quota.
 *  Named rather than inlined because card MP-12 asserts it comes back out of
 *  `usage_events.speaker_ref` on the refusal row. */
const HUNGRY_UID = 'wb-9999888877776666';

/** An engine that cannot be reached. Every recording here is about MONEY and
 *  never about transcript text, so a real engine would only add flakiness. */
const POOL = JSON.stringify([{
  id: 'g31-unreachable', provider: 'custom-openai-compatible', model: 'g31',
  api: 'http://127.0.0.1:9/v1', api_key: 'g31', enabled: true, priority: 1,
}]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);
const sttErrors = (rec) => rec.frames.filter((f) => f.event === 'stt:error').map((f) => f.args[0]);

export const G31 = {
  id: 'G31',
  name: "the third-party host arm (MP-1: a publishable key from an allowed origin builds an `integrator` room and mints NO trial identity; an unsigned visitor AND a signed-in FlowMic user speaking into it are BOTH billed to the key's owner T with payer_reason='host'; a wrong Origin and a revoked key are refused; the per-key sub-quota — not T's plan — is what stops the next utterance, with `INTEGRATOR_QUOTA_EXCEEDED` to the speaker AND (card MP-11 / G-17) an `exhausted` `billing:budget` frame to the HOST PAGE; and no budget frame carries `resets_at` or a plan tier; card MP-12 — the refused press leaves a `quota_refused` `usage_events` row naming T, the key and the visitor, which the console reads back as `refused_count` for T's own metering cycle; and — card MP-13 — the room is named after the SITE, with that name reaching the speaker on the pairing ack)",
  requires: [
    'apps/server-core/src/billing/integrator-quota.ts',
    'apps/server-core/src/db/repos/integrator-key.repo.ts',
    'apps/server-core/src/room/integrator-room.ts',
    'apps/server-core/src/http/console-integrator-routes.ts',
    'apps/server-core/src/auth/metering-principal.ts',
  ],
  async fn() {
    const protocol = await import(pathToFileURL(path.join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href);
    const { safeParseEvent, ERROR_CODES } = protocol;
    // The code must EXIST in the registry before anything below is worth
    // asserting — a golden that only checks the string on the wire would pass
    // against an unregistered bare identifier, which is the exact defect
    // CLAUDE.md's cross-window note is about.
    if (!ERROR_CODES?.INTEGRATOR_QUOTA_EXCEEDED) {
      return FAIL('INTEGRATOR_QUOTA_EXCEEDED is not in the protocol registry — every assertion below would be about a bare identifier');
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'flowmic-g31-'));
    const dbPath = path.join(dir, 'g31.sqlite');
    const mailDir = mailFileDir();
    let saas;
    let db;
    const open = [];
    const track = (s) => { open.push(s); return s; };
    try {
      try {
        saas = await startSaasServer({
          FLOWMIC_DB_PATH: dbPath,
          FLOWMIC_STT_POOL: POOL,
          FLOWMIC_BUDGET_HEARTBEAT_MS: String(HEARTBEAT_MS),
          FLOWMIC_PLAN_LIMITS: JSON.stringify({ free: { stt_minutes: PLAN_MINUTES } }),
          // 🔴 ON HERE AND OFF IN PRODUCTION, exactly as G30 argues: the switch
          // gates COLLECTION, not the column this card adds, and with it off
          // `usage_events.integrator_key_id` would be asserted by nothing.
          FLOWMIC_USAGE_EVENTS_ENABLED: '1',
          ...mailFileEnv(mailDir),
        });
      } catch (e) {
        return FAIL(`saas server failed to start: ${e.message}`);
      }
      const url = `http://127.0.0.1:${saas.port}`;
      db = new DatabaseSync(dbPath);
      const post = (p, body, headers = {}) => fetch(`${url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}),
      });
      const events = (userId) => db.prepare(
        "SELECT * FROM usage_events WHERE user_id=? AND kind='stt' ORDER BY id",
      ).all(userId);
      const anonCount = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get().n;
      const spentMinutes = (userId) => db.prepare('SELECT stt_minutes FROM usage_records WHERE user_id=?').get(userId)?.stt_minutes ?? 0;
      const keyRow = (id) => db.prepare('SELECT * FROM integrator_keys WHERE id=?').get(id);

      const pcm = Buffer.alloc(3_200).toString('base64');
      const START = {
        sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le',
        mode: 'realtime', delivery: 'inject', source_lang: 'en',
      };
      /**
       * Hold the button for `forMs`, then LET GO.
       *
       * 🔴 THE `audio:stop` IS LOAD-BEARING AND G30's `speak` DELIBERATELY HAS
       * NONE. There, every recording is meant to run into a ceiling, and the
       * quota deadline is what ends it — which is also what settles it and
       * therefore what meters it. Here the FIRST two recordings are meant to
       * succeed well inside a one-minute sub-quota, so nothing would ever end
       * them: the session would still be open when this golden tore the server
       * down, and 「no usage_events row」 would look exactly like 「the payer rule
       * is broken」. Measured on the first run of this file, which failed with
       * precisely that message.
       */
      const speak = async (socket, forMs) => {
        let seq = 0;
        const pump = setInterval(() => socket.emit('audio:chunk', { seq: seq += 1, data_b64: pcm, ts_ms: Date.now() }), 80);
        try {
          socket.emit('audio:start', START);
          await sleep(forMs);
        } finally {
          clearInterval(pump);
        }
        socket.emit('audio:stop', {});
      };

      // ── 1 · T, the integrator, mints a publishable key through the console ─
      const tJwt = await saasJwt(url, T_EMAIL);
      await verifyRegisteredEmail(url, tJwt, mailDir, T_EMAIL);
      const tId = db.prepare('SELECT id FROM users WHERE email=?').get(T_EMAIL)?.id;
      if (!tId) return FAIL('the integrator account has no users row');

      const created = await post('/api/cloud/integrator/keys', {
        origins: [HOST_ORIGIN], quota_minutes: KEY_QUOTA_MINUTES, label: KEY_LABEL,
      }, { authorization: `Bearer ${tJwt}` }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (created.status !== 200) return FAIL(`key creation answered ${created.status}: ${JSON.stringify(created.json)}`);
      const key = created.json.key;
      if (!key?.publishable_key?.startsWith('fmpk_')) {
        return FAIL(`the created key does not carry the fmpk_ prefix: ${JSON.stringify(key)}`);
      }
      // 🔴 THE LIST RETURNS IT IN FULL, and that is a contract rather than an
      // oversight (billing/integrator-quota.ts's header): a publishable key ships
      // inside a page, so 「I lost it」 must be answerable by looking.
      const listed = await fetch(`${url}/api/cloud/integrator/keys`, {
        headers: { authorization: `Bearer ${tJwt}` },
      }).then(async (r) => r.json());
      if (listed.keys?.[0]?.publishable_key !== key.publishable_key) {
        return FAIL(`the console list does not return the key string: ${JSON.stringify(listed)}`);
      }

      // ── 2 · a WRONG ORIGIN is refused, and so is a key that does not exist ─
      const wrongOrigin = await post('/api/web/rooms', { auth: { kind: 'publishable_key' } }, {
        authorization: `Bearer ${key.publishable_key}`, origin: OTHER_ORIGIN,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (wrongOrigin.status !== 403 || wrongOrigin.json.error !== 'WEB_ROOM_ORIGIN_NOT_ALLOWED') {
        return FAIL(`a key used from an origin it does not allow answered ${wrongOrigin.status} ${JSON.stringify(wrongOrigin.json)} — want 403 WEB_ROOM_ORIGIN_NOT_ALLOWED`);
      }
      const noOrigin = await post('/api/web/rooms', { auth: { kind: 'publishable_key' } }, {
        authorization: `Bearer ${key.publishable_key}`,
      }).then(async (r) => r.status);
      if (noOrigin !== 403) {
        return FAIL(`a request with NO Origin header answered ${noOrigin} — an absent Origin must be a refusal, or the allowlist is removable by deleting a header`);
      }
      const unknownKey = await post('/api/web/rooms', { auth: { kind: 'publishable_key' } }, {
        authorization: `Bearer fmpk_${'0'.repeat(32)}`, origin: HOST_ORIGIN,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (unknownKey.status !== 401 || unknownKey.json.error !== 'AUTH_TOKEN_INVALID') {
        return FAIL(`an unknown key answered ${unknownKey.status} ${JSON.stringify(unknownKey.json)} — want 401 AUTH_TOKEN_INVALID`);
      }

      // ── 3 · the host page builds a room, and it is an INTEGRATOR room ──────
      const built = await post('/api/web/rooms', { auth: { kind: 'publishable_key' } }, {
        authorization: `Bearer ${key.publishable_key}`, origin: HOST_ORIGIN,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (built.status !== 200) return FAIL(`the host page could not build a room: ${built.status} ${JSON.stringify(built.json)}`);
      const room = built.json;
      const roomRow = db.prepare('SELECT * FROM pc_devices WHERE short_code=? AND user_id=?').get(room.code, tId);
      if (!roomRow) return FAIL('no pc_devices row was minted for the integrator room');
      if (roomRow.room_kind !== 'integrator') {
        return FAIL(`the minted room is room_kind='${roomRow.room_kind}' — MP-1 is the only writer of 'integrator' and every payer rule reads it`);
      }
      // 🔴 card MP-13 (owner §11 追认 item 6) — THE ROOM IS CALLED WHAT THE SITE
      // IS CALLED. Before this card every integrator room was born
      // `INTEGRATOR_ROOM_PC_NAME` ('FlowMic Web'), so a visitor who tapped a
      // microphone on somebody's website looked at their phone and saw a FlowMic
      // product string — which answers nothing about where their words are going.
      //
      // REVERSE CONTROL (executed 2026-09-11, this worktree): drop
      // `deviceName: integratorRoomName(key.label)` from `handleIntegrator`'s
      // mint call in `http/web-room-routes.ts` and rebuild the server dist.
      // OBSERVED, verbatim: 「the minted room is named 'FlowMic Web' — want the
      // key's own label 'Acme Docs g31'」 — i.e. exactly the pre-card product.
      // Restored from a byte copy and rebuilt; no marker string was inserted.
      if (roomRow.device_name !== KEY_LABEL) {
        return FAIL(`the minted room is named '${roomRow.device_name}' — want the key's own label '${KEY_LABEL}'`);
      }
      const edge = db.prepare('SELECT key_id FROM integrator_rooms WHERE pc_device_id=?').get(roomRow.id);
      if (edge?.key_id !== key.id) {
        return FAIL(`the room→key edge is ${JSON.stringify(edge)} — without it the room is billed to T with NO sub-quota ceiling`);
      }
      // 🔴 THE FIRST RESPONSE ALREADY SAYS `integrator`, AND SAYS NOTHING ELSE.
      // design §4: the sub-quota's remaining and the mode, never `resets_at` and
      // never a plan tier — a page full of strangers must not learn T's
      // commercial facts.
      if (room.budget?.mode !== 'integrator') {
        return FAIL(`the room response's budget.mode is '${room.budget?.mode}' — want 'integrator'`);
      }
      // REVERSE CONTROL (executed 2026-09-11, this worktree): drop
      // `|| mode === 'integrator'` from `budget-push.ts`'s `resets_at` line.
      // OBSERVED, verbatim: 「the room response leaked T's cycle or tier:
      // {"remaining_ms":60000,"mode":"integrator","resets_at":1791590400000}」 —
      // a real date, on a page full of strangers. Restored.
      if (room.budget.resets_at !== null || 'free_plan_minutes' in room.budget) {
        return FAIL(`the room response leaked T's cycle or tier: ${JSON.stringify(room.budget)}`);
      }
      if (room.budget.remaining_ms !== KEY_QUOTA_MS) {
        return FAIL(`the room response quotes ${room.budget.remaining_ms}ms — want the KEY's ${KEY_QUOTA_MS}ms, not T's plan`);
      }

      // ── 4 · an UNSIGNED visitor speaks ⇒ T pays, and NO trial is minted ────
      const anonBefore = anonCount();
      const guest = track(await connect(url, {}));
      const guestRec = recordAll(guest);
      const guestPair = await ack(guest, 'mobile:pair', {
        short_code: room.code, pcid: room.pcid,
        device_uid: GUEST_UID, mobile_name: 'Guest', client: 'web', client_version: 'g31',
      });
      if (guestPair.error) return FAIL(`an unsigned visitor could not pair with the host room: ${JSON.stringify(guestPair)}`);
      // 🔴 card MP-13 — AND IT REACHES THE SPEAKER. The row having the right
      // name proves nothing on its own: `pc_name` on this ack is what a phone
      // stores and puts in its PC list and top bar (`mobile.handler.ts` reads
      // `pc.device_name` for it), and a column nothing carries is a column
      // nobody sees. Asserted on the PAIR leg because that is the one every
      // visitor to a host page takes.
      if (guestPair.pc_name !== KEY_LABEL) {
        return FAIL(`the pairing ack tells the speaker pc_name='${guestPair.pc_name}' — want the site's own name '${KEY_LABEL}'`);
      }
      await sleep(200);
      // 🔴 owner §9-1: FlowMic does not put a single free minute on a third
      // party's page. The trial minter's conjunction has to exclude this room —
      // and a `users.anonymous` row appearing here is what that failing looks
      // like from outside.
      if (anonCount() !== anonBefore) {
        return FAIL('an anonymous trial identity was minted for a visitor on a third-party page — FlowMic must fund none of it');
      }
      if (db.prepare('SELECT trial_user_id FROM mobile_pairings WHERE id=?').get(guestPair.pairing_id)?.trial_user_id !== null) {
        return FAIL('the integrator-room pairing carries a trial identity');
      }

      guestRec.frames.length = 0;
      await speak(guest, 1_200);
      await sleep(900);
      const tEventsAfterGuest = events(tId);
      if (tEventsAfterGuest.length === 0) {
        return FAIL("the unsigned visitor's recording produced no usage_events row on T — nobody was billed for it");
      }
      const guestRow = tEventsAfterGuest[tEventsAfterGuest.length - 1];
      if (guestRow.payer_reason !== 'host') {
        return FAIL(`the guest's row says payer_reason='${guestRow.payer_reason}' — want 'host'`);
      }
      if (guestRow.speaker_ref !== GUEST_UID) {
        return FAIL(`the guest's row says speaker_ref='${guestRow.speaker_ref}' — want the browser uid ${GUEST_UID}`);
      }
      if (guestRow.integrator_key_id !== key.id) {
        return FAIL(`the guest's row says integrator_key_id='${guestRow.integrator_key_id}' — want ${key.id}, or 「which of my pages burned the month」 is unanswerable`);
      }
      // …and the KEY's own counter moved, which is the ceiling's only mechanism.
      if (!(keyRow(key.id).used_ms > 0)) {
        return FAIL('the key counter did not move — the sub-quota would be a number in a console with nothing behind it');
      }
      // The speaker's frame: `far_end`, and no cycle, no tier.
      const guestFrames = budgets(guestRec);
      if (guestFrames.length === 0) return FAIL('the guest received no billing:budget frame at all');
      for (const f of guestFrames) {
        // ⚠️ `.success`, NOT `.ok` — `safeParseEvent` hands back zod's own
        // SafeParseReturn. The first draft of this file read `.ok`, which is
        // `undefined` on every result, so the check failed on a PERFECTLY VALID
        // frame and this golden briefly reported a protocol defect that did not
        // exist. 「先核你的尺子」, on the ruler this very file is built out of.
        const parsed = safeParseEvent('billing:budget', f);
        if (!parsed.success) return FAIL(`a guest budget frame failed protocol validation: ${JSON.stringify(f)}`);
        if (f.mode !== 'integrator') return FAIL(`a guest budget frame says mode='${f.mode}' — want 'integrator'`);
        if (f.resets_at !== null) return FAIL(`a guest budget frame leaked T's cycle end: ${JSON.stringify(f)}`);
        if ('free_plan_minutes' in f) return FAIL(`a guest budget frame leaked a plan figure: ${JSON.stringify(f)}`);
        if (f.payer !== 'far_end') return FAIL(`a guest budget frame says payer='${f.payer}' — the guest is not T, so 'self' would be a claim about the wrong ledger`);
      }
      guest.disconnect();
      await sleep(200);

      // ── 5 · a SIGNED-IN FlowMic user speaks into the SAME room ⇒ still T ───
      // 🔴 THE 追认 CELL (owner §11, 2026-09-11 00:30). This is the one place in
      // the whole matrix where the far end outranks a verified account, and it is
      // the assertion that goes red if `resolvePayer`'s first two steps are ever
      // swapped back.
      //
      // REVERSE CONTROL (executed 2026-09-11, this worktree, at the unit level
      // where the swap is a two-line edit): moving the `room.kind ===
      // 'integrator'` block back BELOW the `speaker.account` block turns
      // `test/metering-principal.test.ts` from 42 passed to 「3 failed」, first
      // message 「- Expected "user-integrator-T" / + Received "user-signed-in"」.
      // Restored from a byte copy — the break was a direct edit, so no marker
      // string was inserted and none is left behind.
      const bJwt = await saasJwt(url, B_EMAIL);
      await verifyRegisteredEmail(url, bJwt, mailDir, B_EMAIL);
      const bId = db.prepare('SELECT id FROM users WHERE email=?').get(B_EMAIL)?.id;
      if (!bId || bId === tId) return FAIL('the fixture collapsed T and B into one account — this section would prove nothing');
      const bSpentBefore = spentMinutes(bId);

      const signedIn = track(await connect(url, { jwt: bJwt }));
      const signedRec = recordAll(signedIn);
      const signedPair = await ack(signedIn, 'mobile:pair', {
        short_code: room.code, pcid: room.pcid,
        device_uid: SIGNED_UID, mobile_name: 'Signed-in B', client: 'web', client_version: 'g31',
      });
      if (signedPair.error) return FAIL(`the signed-in speaker could not pair with the host room: ${JSON.stringify(signedPair)}`);
      await sleep(200);
      signedRec.frames.length = 0;
      await speak(signedIn, 1_200);
      await sleep(900);

      if (spentMinutes(bId) !== bSpentBefore) {
        return FAIL("account B's own ledger moved — on a third-party page the HOST pays, whoever is speaking (owner §11 追认 item 1)");
      }
      const bStt = events(bId);
      if (bStt.length !== 0) return FAIL(`account B holds ${bStt.length} usage_events row(s) for a recording the host paid for`);
      const tEventsAfterSigned = events(tId);
      if (tEventsAfterSigned.length <= tEventsAfterGuest.length) {
        return FAIL("the signed-in speaker's recording produced no new usage_events row on T");
      }
      const signedRow = tEventsAfterSigned[tEventsAfterSigned.length - 1];
      if (signedRow.payer_reason !== 'host' || signedRow.integrator_key_id !== key.id) {
        return FAIL(`the signed-in speaker's row is ${JSON.stringify({ payer_reason: signedRow.payer_reason, integrator_key_id: signedRow.integrator_key_id })} — want host / ${key.id}`);
      }
      // 🔴 AND `speaker_ref` IS B, WHICH IS THE OTHER HALF OF THE SAME SENTENCE:
      // the bill names T and the ledger still says who spoke. One column could
      // not answer both.
      if (signedRow.speaker_ref !== bId) {
        return FAIL(`the signed-in speaker's row says speaker_ref='${signedRow.speaker_ref}' — want B's account id`);
      }
      signedIn.disconnect();
      await sleep(200);

      // ── 6 · THE SUB-QUOTA, not T's plan, is what stops the next utterance ──
      // T's plan is 30 minutes and barely touched; the KEY is seeded to within
      // `KEY_HEADROOM_MS` of its ceiling. So a refusal here can only have come
      // from the min() — which is the whole of what this card adds.
      //
      // REVERSE CONTROL (executed 2026-09-11, this worktree): make
      // `audio-start-quota.ts` `integratorKeyRefusal` answer `null` for a socket
      // that DOES carry a key — i.e. let the admission read only T's plan, which
      // is the shape this card would have if the sub-quota were only a number in
      // a console. OBSERVED, verbatim:
      //   「the utterance after the sub-quota ran out was ADMITTED (frames: [])
      //    — T's plan still has 29.956666666666667 minutes, so the per-key
      //    ceiling did nothing」
      // and the run went PASS=27 FAIL=1. Restored from a byte copy; no marker
      // string was inserted and none is left behind.
      db.prepare('UPDATE integrator_keys SET used_ms=?, used_period=(SELECT used_period FROM integrator_keys WHERE id=?) WHERE id=?')
        .run(KEY_QUOTA_MS - KEY_HEADROOM_MS, key.id, key.id);
      const tPlanLeftMinutes = PLAN_MINUTES - spentMinutes(tId);
      if (!(tPlanLeftMinutes > 20)) {
        return FAIL(`T's plan is down to ${tPlanLeftMinutes} minutes — the exhaustion below could then be the PLAN's doing and this section would prove nothing`);
      }

      // ── card MP-11 / gap G-17 — THE HOST PAGE IS IN THE ROOM FOR THIS ONE ──
      //
      // Nothing in this golden had ever connected a TARGET: every section above
      // is about a speaker and a ledger, so the room's `pc` end was empty and
      // 「what does the host page see」 had no observer. That is not a gap in
      // the test, it is the gap the test then failed to see — MP-2 measured a
      // site whose own interface did not move while the phone showed the
      // refusal, and this golden was green throughout.
      // W6c: the production SDK runs in the host DOM, so its browser sends
      // HOST_ORIGIN. Keep the no-Origin refusal above and the Socket negative
      // in integrator-socket-origin.test.ts; this is a corrected probe input.
      const host = track(await connect(url, { token: room.room_token }, { Origin: HOST_ORIGIN }));
      const hostRec = recordAll(host);
      const hostAck = await ack(host, 'pc:reconnect', {
        token: room.room_token,
        machine_uid: 'wb-host-g31-0000000',
        client_instance_id: 'g31-host-instance-0001',
        client: 'web',
        client_version: 'g31',
        target_caps: { image: false },
      });
      if (hostAck.error) return FAIL(`the host page could not enter its own room: ${hostAck.error}`);
      await sleep(200);

      const hungry = track(await connect(url, {}));
      const hungryRec = recordAll(hungry);
      const hungryPair = await ack(hungry, 'mobile:pair', {
        short_code: room.code, pcid: room.pcid,
        device_uid: HUNGRY_UID, mobile_name: 'Hungry', client: 'web', client_version: 'g31',
      });
      if (hungryPair.error) return FAIL(`the third visitor could not pair: ${JSON.stringify(hungryPair)}`);
      await sleep(200);
      hungryRec.frames.length = 0;
      // Long enough to spend what is left, twice over.
      await speak(hungry, KEY_HEADROOM_MS + 2_500);
      await sleep(900);
      // Now the sub-quota is gone. The NEXT press must be refused, by name.
      hungryRec.frames.length = 0;
      // Cleared TOO, and at the same instant: everything the host page has heard
      // up to here belongs to the utterance that SPENT the quota. A frame left
      // over from that would let 「the host was told」 pass on the strength of a
      // heartbeat, which is the opposite of what G-17 is about.
      hostRec.frames.length = 0;
      await speak(hungry, 400);
      await sleep(900);
      const refusals = sttErrors(hungryRec).filter((e) => e.code === 'INTEGRATOR_QUOTA_EXCEEDED');
      if (refusals.length === 0) {
        return FAIL(`the utterance after the sub-quota ran out was ADMITTED (frames: ${JSON.stringify(sttErrors(hungryRec))}) — T's plan still has ${tPlanLeftMinutes} minutes, so the per-key ceiling did nothing`);
      }
      // 🔴 AND IT MUST NOT BE `QUOTA_EXCEEDED`, which would tell a visitor that
      // THEIR subscription is spent — false in both halves, and it would point
      // them at an upgrade that cannot move this ceiling.
      if (sttErrors(hungryRec).some((e) => e.code === 'QUOTA_EXCEEDED')) {
        return FAIL("the refusal borrowed QUOTA_EXCEEDED — that sentence is about the reader's own plan, which is not what ran out");
      }

      // ── card MP-12 — AND THE REFUSAL LEAVES A ROW ─────────────────────────
      //
      // MP-1 shipped this arm writing NOTHING to `usage_events`, on an argument
      // that is half right (a row must not claim T's PLAN ran out) and whose
      // conclusion was wrong: it left T with no durable record of 「how many
      // visitors did my site turn away this cycle」 at all. The journal line
      // beside it is not that record — it rotates, and it is the operator's
      // surface, not T's. Owner §11 追认 item 3.
      //
      // 🔴 THIS IS THE ONLY PLACE THE FOUR COLUMNS CAN BE CHECKED TOGETHER. The
      // unit test (`test/integrator-refusal-row.test.ts`) pins what the handler
      // HANDS the tracker; only here does a real admission, a real key, a real
      // meter and a real table have to agree.
      const refusedRows = events(tId).filter((r) => r.outcome === 'quota_refused');
      if (refusedRows.length === 0) {
        return FAIL(
          'the refused press left NO usage_events row — the speaker was told and the host page was told, '
          + 'and the one party who needs it weeks later (T, asking how many visitors this site turned away) '
          + 'has only a journal line that rotates',
        );
      }
      const refused = refusedRows[refusedRows.length - 1];
      // 🔴 BOTH IDS ARE T AND NEITHER IS THE VISITOR. `user_id` is whose attempt
      // this ran against and `refused_user_id` is whose ceiling said no; on an
      // integrator room the `'host'` branch made T the account for both. A
      // visitor id in either column would put a stranger in the subject of
      // somebody else's billing row.
      if (refused.user_id !== tId || refused.refused_user_id !== tId) {
        return FAIL(`the refusal row names ${JSON.stringify({ user_id: refused.user_id, refused_user_id: refused.refused_user_id })} — want T (${tId}) in both`);
      }
      if (refused.payer_reason !== 'host') {
        return FAIL(`the refusal row says payer_reason='${refused.payer_reason}' — want 'host', or the row cannot be told from T's own account running out`);
      }
      if (refused.speaker_ref !== HUNGRY_UID) {
        return FAIL(`the refusal row says speaker_ref='${refused.speaker_ref}' — want the refused visitor's browser uid ${HUNGRY_UID}`);
      }
      // 🔴 THE COLUMN THAT KEEPS THE ROW HONEST: with it the row says 「this KEY
      // refused a press」; without it 「T was refused」, which reads as 「T's plan
      // ran out」 — false here, and the exact claim MP-1 refused to make.
      if (refused.integrator_key_id !== key.id) {
        return FAIL(`the refusal row says integrator_key_id='${refused.integrator_key_id}' — want ${key.id}`);
      }
      // …and nothing was charged for it: every counter at its 0 default.
      if (refused.stt_ms !== 0 || refused.tokens_in !== 0 || refused.tokens_out !== 0) {
        return FAIL(`the refusal row carries consumption: ${JSON.stringify({ stt_ms: refused.stt_ms, tokens_in: refused.tokens_in, tokens_out: refused.tokens_out })} — a press that never ran spent nothing`);
      }
      // REVERSE CONTROL (executed 2026-09-11, this worktree, TWICE — once here
      // and once at the unit level): delete
      // `usageTracker.recordQuotaRefusal(...)` from the `integratorKeyRefusal`
      // arm in `socket/handlers/audio.handler.ts`, rebuild the server dist, and
      // re-run this file. OBSERVED here, verbatim: 「the refused press left NO
      // usage_events row — the speaker was told and the host page was told, and
      // the one party who needs it weeks later (T, asking how many visitors this
      // site turned away) has only a journal line that rotates」. OBSERVED in
      // `test/integrator-refusal-row.test.ts` from the same edit: 「expected []
      // to have a length of 1 but got +0」, 2 failed | 2 passed — and the two
      // that stayed green are that file's positive controls, which is what tells
      // the pair apart from a probe that stopped looking. Restored from a byte
      // copy and rebuilt; no marker string was inserted and none is left behind.

      // …and the CONSOLE can read the count back, which is the half an
      // integrator actually sees. Scoped to T's own metering cycle — the same
      // cycle `used_ms` in this very object rolls over on (billing/usage-period.ts,
      // owner 2026-09-05 option 乙), so the two numbers beside each other answer
      // the same period.
      const afterRefusal = await fetch(`${url}/api/cloud/integrator/keys`, {
        headers: { authorization: `Bearer ${tJwt}` },
      }).then(async (r) => r.json());
      const counted = afterRefusal.keys?.find((k) => k.id === key.id);
      if (counted?.refused_count !== refusedRows.length) {
        return FAIL(`the console reports refused_count=${JSON.stringify(counted?.refused_count)} for this key while the log holds ${refusedRows.length} refusal row(s)`);
      }

      // 🔴 card MP-11 / gap G-17 — THE HALF A 「refused」 ASSERTION CANNOT SEE:
      // WHAT THE HOST PAGE WAS TOLD.
      //
      // ⚠️ THIS BLOCK USED TO SAY THE OPPOSITE AND MEASURE NEITHER SIDE. It
      // read `const hostFrames = hungryRec.frames.length` — the SPEAKER's
      // recorder — under a comment claiming 「the HOST PAGE got nothing」, and
      // asserted only that the number was non-zero. So it was a positive
      // control on the speaker's probe wearing the name of an assertion about
      // the other end: it could not have gone red whatever the host page
      // received, including nothing, which is what it received. Kept as a
      // control (below), renamed to what it measures.
      if (hungryRec.frames.length === 0) {
        return FAIL("the SPEAKER's probe recorded nothing at all — every assertion in this section would be vacuous");
      }
      const hostBudgets = budgets(hostRec);
      if (hostBudgets.length === 0) {
        return FAIL(
          'the host page was told NOTHING when its own key ran out — only the speaker got the code. '
          + 'That is gap G-17 verbatim: the exhaustion frame hangs off the AUTO-STOP, and a press refused '
          + 'at the door never starts a recording, so it never auto-stops.',
        );
      }
      const exhaustedFrame = hostBudgets.find((f) => f.exhausted === true);
      if (!exhaustedFrame) {
        return FAIL(`the host page got budget frames but none marked exhausted: ${JSON.stringify(hostBudgets)}`);
      }
      {
        const parsed = safeParseEvent('billing:budget', exhaustedFrame);
        if (!parsed.success) return FAIL(`the host's exhaustion frame failed protocol validation: ${JSON.stringify(exhaustedFrame)}`);
      }
      if (exhaustedFrame.mode !== 'integrator') {
        return FAIL(`the host's exhaustion frame says mode='${exhaustedFrame.mode}' — want 'integrator'`);
      }
      if (exhaustedFrame.remaining_ms !== 0) {
        return FAIL(`the host's exhaustion frame says remaining_ms=${exhaustedFrame.remaining_ms} — a meter that has not reached zero does not explain a refusal`);
      }
      // 🔴 NO NEW REASON WORD. `exhausted` already means 「this ended because the
      // allowance is at zero」 and that is what happened; a sixth value would ask
      // every reader to learn a distinction that changes nothing they do.
      if (exhaustedFrame.reason !== 'exhausted') {
        return FAIL(`the host's exhaustion frame says reason='${exhaustedFrame.reason}' — want the existing 'exhausted', and no new vocabulary`);
      }
      // …and T's own cycle and tier still do not travel to a page of strangers,
      // on this frame as on every other one in this file.
      if (exhaustedFrame.resets_at !== null || 'free_plan_minutes' in exhaustedFrame) {
        return FAIL(`the host's exhaustion frame leaked T's cycle or tier: ${JSON.stringify(exhaustedFrame)}`);
      }
      // REVERSE CONTROL (executed 2026-09-11, this worktree, twice): remove
      // `budgetPushes.refusedExhausted();` from the `integratorKeyRefusal` arm
      // in `socket/handlers/audio.handler.ts` — i.e. put the tree back the way
      // MP-2 measured it. OBSERVED, verbatim:
      //   「the host page was told NOTHING when its own key ran out — only the
      //    speaker got the code. That is gap G-17 verbatim: the exhaustion
      //    frame hangs off the AUTO-STOP, and a press refused at the door never
      //    starts a recording, so it never auto-stops.」
      // Restored by direct edit; no marker string was inserted and none is left
      // behind.
      //
      // ⚠️ AND A SECOND FINDING FROM DOING IT TWICE, recorded because chasing it
      // is how it was settled rather than assumed: both broken runs came back
      // `PASS=26 SKIPPED=2 FAIL=2`, the extra failure being **G10**
      // (「record-only utterance failed on the server but the MOBILE was told
      // nothing」). After the first one that looked like this edit's doing — 2
      // for 2 broken against 0 for 3 clean.
      //
      // 🔴 IT IS NOT. **G10 FAILS ON THE DELIVERED TREE TOO**: across six full
      // `pnpm golden` runs in this worktree it was 4 pass / 1 fail with the
      // push in place and 0 / 2 with it removed, and the very next clean rerun
      // was `PASS=28 SKIPPED=2 FAIL=0`. The isolation argument agrees with the
      // tally, but NOT the way it used to: this comment once said the two could
      // not interact 「because the goldens run SEQUENTIALLY (`for (const g of
      // GOLDEN)`)」. That is no longer true. `verify/golden/scenario-schedule.mjs`
      // puts G31 in the `pool` group and G10 in the `chain` group, so with
      // FLOWMIC_GOLDEN_CONCURRENCY > 1 this file and G10 DO run at the same
      // time on the same machine. What still holds is the reason G31 is
      // poolable at all, and it is a stronger claim than ordering ever was:
      // this case starts its OWN saas server on an ephemeral port with a
      // mkdtemp file db (that is the `why` its schedule entry gives), while G10
      // talks to the shared standalone. They share no port, no database and no
      // room table — only the CPU. **G10 is flaky on its own clock.** Written
      // down rather than rounded off, because the first reading of it — 「my
      // change broke a second golden」 — was wrong, and the thing that corrected
      // it was one more run, not one more argument.
      //
      // 🔴 IN-PLACE CORRECTION (card D2 / NR-28, 2026-09-15, dev-pc-a). THE
      // TALLY ABOVE IS TRUE AND IT IS ABOUT A TREE THAT NO LONGER EXISTS. Read
      // the two timestamps together: this block was written in `77deae36`
      // (2026-09-11 08:57), and `57c56dc1` (2026-09-11 13:35, 「G10 was timing a
      // deadline the frame it waits for cannot obey」) DELETED the very line it
      // quotes —
      //     - const w = terminalFrameWindowMs(STT_SPAWN_SRC,
      //                   'DEFAULT_ENGINE_SPAWN_TIMEOUT_MS');
      //     - if (!(await mobileToldP)) return FAIL('record-only utterance
      //         failed on the server but the MOBILE was told nothing …');
      // — and replaced that ~7 s arithmetic window with an awaited event under
      // a 60 s liveness ceiling. So 4-pass/1-fail measured the window, and the
      // window is gone. (The 2026-09-13 handoff §3-2 restates this block rather
      // than re-measuring it, which is why the claim outlived its subject.)
      //
      // RE-MEASURED 2026-09-15 on today's tree: G10 30/30 alone against a
      // dedicated standalone server; 40/40 with 24 CPU + 8 IO load workers
      // running alongside on 16 cores — a load under which two mobile cases
      // went red 13/20 and 19/20 the same afternoon; and 5/5 clean full
      // `pnpm golden` runs, every one `PASS=30 SKIPPED=2 FAIL=0`. 75 isolated
      // runs and 5 suites, zero failures.
      //
      // ⚠️ WHAT THIS DOES NOT SAY. Under that same load the SUITE does still
      // red — 6 loaded runs gave G26 ×4, G30 ×2, G31 ×1, G20 ×1 — and NOT ONCE
      // G10, G12 or G24. Those four are the cases that measure money against a
      // wall clock, and a box starved this hard cannot hold a 120 s trial
      // budget to a ±250 ms assertion. That is a different finding, it is
      // written up rather than fixed, and it is not evidence about this line.

      // ── 7 · REVOKING the key closes the door, without deleting the record ──
      const revoked = await post('/api/cloud/integrator/keys/revoke', { id: key.id }, {
        authorization: `Bearer ${tJwt}`,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (revoked.status !== 200) return FAIL(`revoke answered ${revoked.status}: ${JSON.stringify(revoked.json)}`);
      const afterRevoke = await post('/api/web/rooms', { auth: { kind: 'publishable_key' } }, {
        authorization: `Bearer ${key.publishable_key}`, origin: HOST_ORIGIN,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
      if (afterRevoke.status !== 401 || afterRevoke.json.error !== 'AUTH_TOKEN_INVALID') {
        return FAIL(`a revoked key answered ${afterRevoke.status} ${JSON.stringify(afterRevoke.json)} — want 401 AUTH_TOKEN_INVALID`);
      }
      // …and the ROW survives, because 「what did this key do」 is exactly the
      // question an integrator asks after revoking one.
      if (!keyRow(key.id)) return FAIL('revoking deleted the key row — the usage log would then name an id nothing explains');

      return PASS(
        `integrator arm: key ${key.id} (fmpk_… ${key.publishable_key.length} chars) built room ${roomRow.id} `
        + `(room_kind=integrator, edge→${edge.key_id}); an unsigned visitor and a signed-in FlowMic user were BOTH `
        + `billed to T with payer_reason='host' and speaker_ref=${GUEST_UID}/B; wrong origin, absent origin, unknown key `
        + `and revoked key all refused by name; the per-key sub-quota (not T's ${tPlanLeftMinutes} remaining plan minutes) `
        + 'stopped the next utterance with INTEGRATOR_QUOTA_EXCEEDED to the speaker AND an exhausted '
        + 'billing:budget frame to the host page (G-17); no anonymous identity was minted; '
        + 'no budget frame carried resets_at or a plan figure; '
        + `and the refusal left a quota_refused row (user_id=refused_user_id=T, payer_reason=host, `
        + `speaker_ref=${HUNGRY_UID}, integrator_key_id=${key.id}, every counter 0) that the console `
        + `reports as refused_count=${counted.refused_count}; `
        + `and the room carried the site's own name ('${KEY_LABEL}') both in pc_devices.device_name `
        + 'and on the pairing ack the speaker reads',
      );
    } finally {
      for (const s of open) { try { s.disconnect(); } catch { /* already gone */ } }
      try { db?.close(); } catch { /* not open */ }
      try { saas?.child.kill(); } catch { /* already dead */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
      try { rmSync(mailDir, { recursive: true, force: true }); } catch { /* windows lock */ }
    }
  },
};

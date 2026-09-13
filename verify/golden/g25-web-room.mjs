// G25 — card S2-04: a browser target's room, minted over HTTP, is a REAL room.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §2.1
//   docs/strategy/2026-09-08-web-client-target-and-self-pairing-state-machine.md
//     §5.1 (the page enters with `pc:reconnect`, never `pc:register`)
//   apps/server-core/src/room/web-room.ts · src/http/web-room-routes.ts
//
// ── WHY THIS IS A GOLDEN AND NOT A UNIT TEST ───────────────────────────────
//
// `test/web-room-routes.test.ts` drives the route with real repos and proves
// everything the route decides. It cannot prove the ONE claim this card is
// actually making, because that claim spans two protocols: a row minted by an
// HTTP POST, with no socket in sight, is a room a phone can pair into and inject
// through. Four separate things have to agree for that — the row's token has to
// be accepted by the socket handshake middleware, its short code has to be live
// in an in-memory governor the HTTP process shares, its PCID has to resolve, and
// the room uuid has to be the one `store.joinPc` uses. Every one of those is a
// different module, and a test that stubs any of them proves the stub.
//
// 🔴 THE ASSERTION THAT MATTERS MOST IS THE PAIRING ONE, and it is here because
// of a near miss. The design register (§3) said a web room should stop counting
// against the PC ceiling by failing `isRealPc`. That same predicate filters BOTH
// pairing-resolution arms and guards `stampPcid`, so that shape would have
// shipped a target with no address that no code could ever reach — while a unit
// test named 「does not eat a slot」 stayed green. This case is what says no.
//
// ── WHAT IT DOES NOT NEED ──────────────────────────────────────────────────
// No STT engine, no LAN, no vendor: nothing here records audio. It therefore
// never SKIPs.

import {
  startSaasServer, connect, ack, once, saasJwt,
  mailFileDir, mailFileEnv, PASS, FAIL,
} from './harness.mjs';

const EMAIL = 'g25-web-room@flowmic.test';
/** The browser's own uid, in the shape `DeviceUid` accepts (`xx-<hex>`). The
 *  page sends it on `pc:reconnect`; today nothing branches on it. */
const BROWSER_UID = 'wb-0123456789abcdef';
/**
 * The `client_instance_id` the BROWSER ACTUALLY SENDS, computed the way the
 * product computes it — flowmic-web `packages/core/src/target/wire.ts`:
 * `web-` + the uid's first 8 hex characters. TWELVE characters.
 *
 * 🔴 THIS LINE IS THE CASE. It used to read `web-${BROWSER_UID}` — 22 characters,
 * a value that looks like the real thing and that the product never produces —
 * and with it this golden passed while every browser target in production was
 * refused `AUTH_TOKEN_INVALID` on `pc:reconnect` (defect D5, 2026-09-08). The
 * refusal was a boundary parse failure on `ClientInstanceId`'s old
 * `z.string().min(16)`, i.e. entirely decided by the LENGTH of this string, and
 * the fixture was the only place in the repo where that length was wrong in the
 * safe direction.
 *
 * That is律 L-② (CLAUDE.md, 0.3.24) a second time: 「测试矩阵里的值必须取自产品自己
 * 的注册表」— the value under test has to be the one the product emits, not one
 * that resembles it. Derived here rather than pasted so it cannot drift again.
 */
const BROWSER_INSTANCE_ID = `web-${BROWSER_UID.replace(/^[a-z]{2}-/, '').slice(0, 8)}`;

export const G25 = {
  id: 'G25',
  name: 'web target room (POST /api/web/rooms → pc:reconnect → a phone pairs and injects)',
  requires: [
    'apps/server-core/src/http/web-room-routes.ts',
    'apps/server-core/src/room/web-room.ts',
    'apps/server-core/src/room/registry-shared.ts',
  ],
  async fn() {
    const mailDir = mailFileDir();
    let saas;
    try {
      saas = await startSaasServer(mailFileEnv(mailDir));
    } catch (e) {
      return FAIL(`saas server failed to start: ${e.message}`);
    }
    const url = `http://127.0.0.1:${saas.port}`;
    const open = [];
    const track = (s) => { open.push(s); return s; };
    try {
      const jwt = await saasJwt(url, EMAIL);
      const post = (body, headers = {}) => fetch(`${url}/api/web/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}),
      });

      // ── 1. an unauthenticated build is refused, and nothing is minted ──────
      const anon = await post({});
      if (anon.status !== 401) {
        return FAIL(`an unauthenticated POST /api/web/rooms answered ${anon.status}, not 401 — this endpoint mints a device row and spends a pairing code`);
      }

      // ── 2. the account builds its room ─────────────────────────────────────
      const built = await post({ mode: 'realtime' }, { authorization: `Bearer ${jwt}` });
      if (built.status !== 200) return FAIL(`POST /api/web/rooms answered ${built.status} for a signed-in account`);
      const room = await built.json();
      for (const key of ['room_token', 'pcid', 'code', 'pair_url', 'endpoint', 'expires_at', 'budget']) {
        if (room[key] === undefined) return FAIL(`the build response is missing '${key}' — addendum §2.1 lists it, and the page reads every one`);
      }
      if (!/^\d{4}$/.test(String(room.code))) return FAIL(`code is ${JSON.stringify(room.code)}, not four digits`);
      // 🔴 A REAL PCID. `stampPcid` skips any row that fails `isRealPc`, so a null
      // here is the exact symptom of the predicate mistake this case guards.
      if (!/^\d{9}$/.test(String(room.pcid))) return FAIL(`pcid is ${JSON.stringify(room.pcid)}, not nine digits — a web room with no address cannot be paired with by number`);
      if (typeof room.expires_at !== 'number' || room.expires_at <= Date.now()) {
        return FAIL(`expires_at is ${JSON.stringify(room.expires_at)} — it must be an epoch-ms instant in the future`);
      }
      if (room.budget?.mode !== 'plan') return FAIL(`budget.mode is ${JSON.stringify(room.budget?.mode)} — a signed-in account's row is not anonymous, so serverBudgetModeFor answers 'plan' (billing/budget-push.ts)`);
      if (!String(room.pair_url).includes(`code=${room.code}`) || !String(room.pair_url).includes(`pcid=${room.pcid}`)) {
        return FAIL(`pair_url does not carry this room's own code and pcid: ${room.pair_url}`);
      }

      // ── 3. asking again returns the SAME room ──────────────────────────────
      const again = await (await post({}, { authorization: `Bearer ${jwt}` })).json();
      if (again.room_token !== room.room_token || again.pcid !== room.pcid) {
        return FAIL('a repeat build handed back a DIFFERENT room — the token is this endpoint\'s idempotency, and rotating it disconnects a page that is already working');
      }

      // ── 4. the page enters its room, by RECONNECT ─────────────────────────
      // State machine §5.1: the row was minted by HTTP, so there is nothing to
      // register; `pc:reconnect` is 「come back to the room I already hold a
      // token for」, and it is the leg a replica can also serve.
      const pc = track(await connect(url, { token: room.room_token }));
      const rc = await ack(pc, 'pc:reconnect', {
        token: room.room_token,
        machine_uid: BROWSER_UID,
        client_instance_id: BROWSER_INSTANCE_ID,
        client: 'web',
        client_version: 'g25',
        // Sent because the page sends it (card S3-02 flips it to true). It rides
        // the same frame, so a schema that refuses the frame refuses this too.
        target_caps: { image: false },
      });
      if (rc.error) {
        return FAIL(`pc:reconnect with the minted room_token was refused: ${rc.error} — the HTTP row and the socket's admission disagree about the same token. Check the FRAME before the row: every field on it is parsed at the boundary, and a boundary refusal is anonymous (pc.handler.ts answers AUTH_TOKEN_INVALID at 'pc:reconnect-parse', which is indistinguishable from 'no such token')`);
      }
      if (rc.short_code !== room.code) return FAIL(`the room's own code is ${JSON.stringify(rc.short_code)} on the socket and ${JSON.stringify(room.code)} over HTTP — one code, two answers`);
      if (rc.pcid !== room.pcid) return FAIL(`the room's pcid differs between the two surfaces: ${rc.pcid} vs ${room.pcid}`);
      if (!rc.budget || rc.budget.mode !== 'plan') return FAIL('the reconnect ack carried no budget (addendum §1.5) — a page that reconnects has no other way to resync its meter');

      // ── 5. a phone pairs into it, by code AND by address ──────────────────
      const phone = track(await connect(url));
      const joined = once(pc, 'pc:mobile-joined', 3000);
      const pair = await ack(phone, 'mobile:pair', {
        short_code: room.code, pcid: room.pcid, client: 'web', client_version: 'g25',
      });
      if (pair.error) {
        return FAIL(`a phone could not pair with the web room: ${pair.error} — a target nobody can reach is not a target (this is what widening isRealPc would have produced)`);
      }
      try {
        await joined;
      } catch {
        return FAIL('the page was never told a phone joined its room (pc:mobile-joined)');
      }

      // ── 6. and the room actually carries an utterance ─────────────────────
      const text = `G25-${Date.now()}`;
      const arrived = once(pc, 'inject:request', 3000);
      phone.emit('inject:request', {
        text, source: 'stt', request_id: `g25-${Date.now()}`, entry_id: `g25-row-${Date.now()}`,
        target_pc_id: pair.pc_id,
      });
      let got;
      try {
        got = await arrived;
      } catch (e) {
        return FAIL(`the phone's sentence never reached the web room: ${e.message}`);
      }
      if (got.text !== text) return FAIL(`the web room received ${JSON.stringify(got.text)}`);
      if (got.target_pc_id !== pair.pc_id) return FAIL(`the address did not survive the relay: ${JSON.stringify(got.target_pc_id)}`);

      return PASS(`room ${room.pcid} minted over HTTP, entered by pc:reconnect, paired and injected`);
    } finally {
      for (const s of open) { try { s.disconnect(); } catch { /* already gone */ } }
      try { saas.child.kill(); } catch { /* already gone */ }
    }
  },
};

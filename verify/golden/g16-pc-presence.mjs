// verify/golden/g16-pc-presence.mjs
//
// G16 — "is the PC I paired with there", asked of a REAL server (RV-98, card B4-14).
//
//   owner 2026-08-01 real-device original wording: 「截图 2 中的云端中继这个实例显示的是『中继可达 · 电脑
//   是否在线未知』，**实际上 PC 是在线的**，这样显示不对，**要能正确显示 PC 端是否在
//   线**」。
//
// WHY THIS PATH EXISTS, given that both halves already have unit tests. The unit
// tests each construct their own world: the server test drives a RoomStore it
// mutates by hand, and the phone test hands the controller a fake reader. Neither
// can answer the question that actually decides whether owner's screen changes —
// "when a real PC socket really leaves a real room, does a real HTTP request to
// the running server start saying so". Between those two halves sit three things
// no fake exercises: bootstrap wiring the route at all, the room store being the
// SAME instance the socket handlers mutate, and the answer surviving a trip over
// a real listener. That seam is exactly the kind this repo has been burned by
// (book 13 P7: the harness doing the phone's job while the product never did it).
//
// WHAT IT DOES NOT COVER, stated rather than glossed:
//   · the PHONE half. The "phone" here is `fetch`, so a pass says nothing about
//     whether the Dart app ever sends this request. That half is
//     apps/mobile/test/connections_controller_test.dart (RV-98 group) and
//     apps/mobile/test/connections_page_widget_test.dart, both `requires`d so the
//     evidence cannot quietly disappear. Same SIM-MOBILE CAVEAT as every other G.
//   · a public relay / nginx. This server is loopback. What is asserted about
//     saas here is that the route is MOUNTED there (the standalone-only routes
//     404 in the same run), not that flowmic.app serves it.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

const PRESENCE = '/api/pc/presence';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET the route with an optional bearer. Returns {status, body}. */
async function askPresence(url, token) {
  const res = await fetch(`${url}${PRESENCE}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** Wait until the route reports `want`, or give up. The PC's `leavePc` runs on
 *  socket close, which is asynchronous from the client's `disconnect()`. */
async function waitForPresence(url, token, want, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await askPresence(url, token);
    if (r.body.pc_online === want) return r;
    if (Date.now() > deadline) return r;
    await sleep(25);
  }
}

export const G16 = {
  id: 'G16',
  name: 'PC presence (RV-98: the list page really asks that PC, both directions + answers only about its own)',
  requires: [
    SERVER_DIST,
    path.join(ROOT, 'apps/mobile/test/connections_controller_test.dart'),
    path.join(ROOT, 'apps/mobile/test/connections_page_widget_test.dart'),
  ],
  async fn(url) {
    const sockets = [];
    let saas = null;
    let saasNode = null;
    try {
      // ── two real PCs on one standalone server, each with its own phone ──
      const pcA = await connect(url); sockets.push(pcA);
      const regA = await ack(pcA, 'pc:register', { device_name: 'G16 PC-A', client_instance_id: 'inst-g16-a-000000' });
      const mobA = await connect(url); sockets.push(mobA);
      const joinedA = once(pcA, 'pc:mobile-joined');
      // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
      // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
      // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
      // One spelling is therefore correct on both, which is also what the real phone
      // does: it sends back whatever the register ack or the QR gave it.
      const pairA = await ack(mobA, 'mobile:pair', { short_code: regA.short_code, pcid: regA.pcid });
      await joinedA;

      const pcB = await connect(url); sockets.push(pcB);
      const regB = await ack(pcB, 'pc:register', { device_name: 'G16 PC-B', client_instance_id: 'inst-g16-b-000000' });
      const mobB = await connect(url); sockets.push(mobB);
      const joinedB = once(pcB, 'pc:mobile-joined');
      const pairB = await ack(mobB, 'mobile:pair', { short_code: regB.short_code, pcid: regB.pcid });
      await joinedB;

      if (pairA.pc_id === pairB.pc_id) return FAIL('the two PCs minted the same pc_id — this run cannot tell them apart');

      // ── ① online, and the answer is about its own PC ───────────────────────────────────────
      const upA = await askPresence(url, pairA.mobile_token);
      if (upA.status !== 200) return FAIL(`presence returned ${upA.status} for a live pairing`);
      if (upA.body.pc_online !== true) return FAIL(`PC-A is in its room but presence said pc_online=${JSON.stringify(upA.body.pc_online)}`);
      if (upA.body.pc_id !== pairA.pc_id) return FAIL(`presence answered about ${upA.body.pc_id}, asked about ${pairA.pc_id} (串号)`);
      // only the three keys it is supposed to have — one token buys the one it asked about, not a list.
      const keys = Object.keys(upA.body).sort().join(',');
      if (keys !== 'ok,pc_id,pc_online') return FAIL(`presence body leaked extra fields: ${keys}`);

      // ── ② 🔴 the reverse of owner's scene: the PC leaves, the same HTTP immediately changes its answer ─────────
      // The server address did not change by one character, `/api/health` is still ok:true — this is exactly the signal
      // that, before RV-92, was treated as "the PC is online", so it must be independently proven here that it "did not change along with it".
      pcA.disconnect();
      const downA = await waitForPresence(url, pairA.mobile_token, false);
      if (downA.body.pc_online !== false) return FAIL(`PC-A left its room but presence still said pc_online=${JSON.stringify(downA.body.pc_online)}`);
      const health = await (await fetch(`${url}/api/health`)).json();
      if (health.ok !== true) return FAIL('/api/health stopped answering — this run cannot prove the two values are independent');

      // ── ③ 🔴 positive control: B was untouched and is still true (②'s "false" is not the whole path being dead) ──
      const stillB = await askPresence(url, pairB.mobile_token);
      if (stillB.body.pc_online !== true) return FAIL('PC-B was untouched but presence said it left — the false above proves nothing');
      if (stillB.body.pc_id !== pairB.pc_id) return FAIL(`presence answered about ${stillB.body.pc_id}, asked about ${pairB.pc_id} (串号)`);

      // ── ④ 🔴 A's token cannot obtain B's answer, even by naming pc_id ────────────
      // Without this one, "answers only about its own" is just a comment.
      const crossed = await (await fetch(`${url}${PRESENCE}?pc_id=${pairB.pc_id}`, {
        headers: { authorization: `Bearer ${pairA.mobile_token}` },
      })).json();
      if (crossed.pc_id !== pairA.pc_id || crossed.pc_online !== false) {
        return FAIL(`naming another PC changed the answer: ${JSON.stringify(crossed)} (enumeration oracle)`);
      }

      // ── ⑤ the credential is a real gate ─────────────────────────────────────────────────
      const anon = await askPresence(url, undefined);
      const bogus = await askPresence(url, `fm_${'f'.repeat(64)}`);
      if (anon.status !== 401 || bogus.status !== 401) {
        return FAIL(`presence answered without a valid credential (anon=${anon.status}, bogus=${bogus.status})`);
      }
      if (anon.body.pc_online !== undefined || bogus.body.pc_online !== undefined) {
        return FAIL('a refusal still carried a presence bit');
      }

      // ── ⑥ the relay mounts it too (the row owner complained about is exactly the relay's) ────────────────────
      saas = await startSaasServer();
      const saasUrl = `http://localhost:${saas.port}`;
      const jwt = await saasJwt(saasUrl);
      const pcC = await connect(saasUrl, { jwt }); sockets.push(pcC);
      const regC = await ack(pcC, 'pc:register', { device_name: 'G16 relay PC', client_instance_id: 'inst-g16-c-000000' });
      const mobC = await connect(saasUrl, { jwt }); sockets.push(mobC);
      const joinedC = once(pcC, 'pc:mobile-joined');
      const pairC = await ack(mobC, 'mobile:pair', { short_code: regC.short_code, pcid: regC.pcid });
      await joinedC;

      const relayUp = await askPresence(saasUrl, pairC.mobile_token);
      if (relayUp.status !== 200 || relayUp.body.pc_online !== true) {
        return FAIL(`the relay does not answer presence (status=${relayUp.status}, body=${JSON.stringify(relayUp.body)}) — owner's row would stay 「不知道」`);
      }
      pcC.disconnect();
      const relayDown = await waitForPresence(saasUrl, pairC.mobile_token, false);
      if (relayDown.body.pc_online !== false) {
        return FAIL(`over the relay, a PC that left still reads online=${JSON.stringify(relayDown.body.pc_online)} — this IS owner's bug`);
      }
      // Same run, same server: the standalone-only image ingress still 404s, so
      // "mounted in saas" above is this route's own property and not a blanket
      // "saas serves everything".
      // ── NR-61 DEGRADE CONTROL — this relay has no node directory, so it must
      //    say NOTHING about nodes ───────────────────────────────────────────
      // The whole safety argument of the additive change is that a deployment
      // with no nodes answers byte-for-byte what it always answered. Asserted on
      // the SAME response the two directions above were read from, so a server
      // that started volunteering node ids everywhere cannot pass this file.
      if (relayUp.body.home_node !== undefined || relayUp.body.node !== undefined) {
        return FAIL(`a relay with no node configuration volunteered node ids (home_node=${JSON.stringify(relayUp.body.home_node)}, node=${JSON.stringify(relayUp.body.node)}) — an old phone would then read 「my PC moved」 on a deployment that has nowhere to move to`);
      }

      const notMounted = await fetch(`${saasUrl}/api/inject/image`, { method: 'POST', body: '{}' });
      if (notMounted.status !== 404) {
        return FAIL(`the standalone-only image ingress answered ${notMounted.status} in saas — the mounting control is broken, so ⑥ proves nothing`);
      }

      // ── ⑧ NR-61: on a NODE-AWARE relay the answer says WHICH node ─────────
      //
      // 🔴 WHAT THIS SEAM ADDS OVER THE UNIT TEST, which is the only reason to
      // spend a second process on it. `http-pc-presence.test.ts` hands the route
      // a `nodeIdFor` of its own and writes `home_node` with a repo call — both
      // halves faked. Here neither is: `nodeIdFor` is whatever
      // bootstrap-http-deps wired, and `home_node` is stamped by the REAL
      // `pc:register` path (pc.handler `stampHomeNode`). A build where the route
      // was given a static process id, or where registration stopped stamping,
      // passes every unit test in this repo and fails here.
      //
      // ⚠️ WHAT IT CANNOT COVER, said rather than glossed: `home_node` and `node`
      // are necessarily EQUAL here — one process cannot be two nodes, and the
      // disagreement this card exists for needs a second node plus replication.
      // The disagreement itself is pinned in the unit test, and the phone acting
      // on it in apps/mobile/test/node_follow_after_presence_test.dart.
      const nodeSaas = await startSaasServer({
        FLOWMIC_NODE_ROLE: 'writer',
        FLOWMIC_NODE_ID: 'g16node',
        FLOWMIC_NODE_SHARED_SECRET: 'golden-node-shared-secret-32-bytes-xx',
      });
      saasNode = nodeSaas;
      const nodeUrl = `http://localhost:${nodeSaas.port}`;
      const nodeJwt = await saasJwt(nodeUrl);
      const pcD = await connect(nodeUrl, { jwt: nodeJwt }); sockets.push(pcD);
      const regD = await ack(pcD, 'pc:register', { device_name: 'G16 node PC', client_instance_id: 'inst-g16-d-000000' });
      const mobD = await connect(nodeUrl, { jwt: nodeJwt }); sockets.push(mobD);
      const joinedD = once(pcD, 'pc:mobile-joined');
      const pairD = await ack(mobD, 'mobile:pair', { short_code: regD.short_code, pcid: regD.pcid });
      await joinedD;

      const nodeAnswer = await askPresence(nodeUrl, pairD.mobile_token);
      if (nodeAnswer.body.node !== 'g16node') {
        return FAIL(`a node-aware relay did not name itself in the presence answer (node=${JSON.stringify(nodeAnswer.body.node)}) — a phone then has no way to tell 「my PC is elsewhere」 from 「there are no nodes」`);
      }
      if (nodeAnswer.body.home_node !== 'g16node') {
        return FAIL(`registration did not stamp home_node on a node-aware relay (home_node=${JSON.stringify(nodeAnswer.body.home_node)}) — the field reaches the wire but says nothing, which is worse than absent`);
      }
      // Positive control for both: the one bit is still the real one, so the
      // two ids above rode a genuine answer and not an error shape.
      if (nodeAnswer.body.pc_online !== true) {
        return FAIL(`the node-aware relay lost the presence bit itself (${JSON.stringify(nodeAnswer.body)})`);
      }

      return PASS('standalone: online→offline tracked while /api/health stayed ok (two values, independently); untouched PC-B still true; naming another pc_id cannot change the subject; anon+bogus tokens 401 with no presence bit; saas relay answers both directions while the standalone-only ingress still 404s there; that relay volunteers no node ids, and a node-aware one names itself in both home_node and node');
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
      if (saasNode) saasNode.child.kill();
    }
  },
};

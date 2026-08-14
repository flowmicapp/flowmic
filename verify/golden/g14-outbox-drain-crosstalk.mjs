// verify/golden/g14-outbox-drain-crosstalk.mjs
//
// G14 — queue "true drain" cross-end regression (card B4-2, 2026-08-01).
//
// G13 (g13-no-crosstalk.mjs) already pins the protocol-level crosstalk gate: two PCs on
// ONE channel at a time, addressed correctly / tampered / unaddressed. What it
// does NOT exercise is the shape a QUEUE drain actually produces, which is the
// gap window B3 left open (docs/strategy/2026-07-31-window-b3-handoff-report.md
// §6.2) and the acceptance the owner's own decision states verbatim
// (docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
// §验收): 「两台 PC × 两条通道＝四个 pc_id，队列项交叉，断言每条只落到自己那台
// 机器；篡改机器身份被拒的反向对照要真的见过红」.
//
// WHAT EACH LAYER PROVES, so nothing here claims another layer's coverage:
//   · THIS FILE — four REAL live sockets (2 PCs × 2 channels = 4 distinct
//     pc_id, all connected AT ONCE, not torn down between channels the way
//     G13 does it) receiving a BURST of drain-shaped frames (several entries
//     per machine, `created_at` several days in the past — the queued item's
//     real speaking moment, not "now") and one cross-channel address that is a
//     REAL pc_id, just the WRONG channel's alias of the SAME machine — the
//     exact mistake window B3's worker caught the lead making in the decision
//     doc's own §Situation. Also the ONE piece of server-side "retry must not
//     duplicate" logic that is real production code reachable from a real
//     wire: the HTTP image ingress's `InjectPendingRegistry` (RV-04).
//   · apps/mobile/test/outbox_test.dart — the CLIENT half: `resolveOutboxTarget`
//     (which channel's own live address a drain actually uses, and the
//     fail-closed "no match ⇒ stays queued, never falls back to 'whoever is
//     connected now'") is Dart, not reachable from here. `requires`d so that
//     evidence cannot quietly disappear.
//   · apps/desktop/src-tauri/src/socket/dedup.rs (inline tests) — INJ-3/INJ-1
//     dedup for the PLAIN SOCKET path (text) is desktop-only (Rust). The "PC"
//     below is a bare socket.io client standing in for the real desktop app
//     (SIM-MOBILE CAVEAT, run-golden.mjs header, applies symmetrically to the
//     PC side here), so it has no dedup layer at all — sending the same
//     request_id twice over the SOCKET path in this file would just arrive
//     twice, and that is not a bug in this file, it is this file's harness not
//     being a real desktop. See the PASS line's NOT-covered note.
//
// WHY BOTH CHANNELS STAY UP AT ONCE (unlike G13's sequential legs): the
// scenario this card guards against is a client whose queue item recorded a
// channel-A address and then genuinely gets drained on channel B (roaming
// between LAN and cloud, or a client bug that reuses the frozen value instead
// of re-resolving one). Proving the server refuses that requires a REAL pc_id
// minted by the OTHER channel's OWN database to exist and be live at the same
// moment — sequential legs (register, use, disconnect, register again) can
// never produce that value.
//
// ⚠️ HONEST LIMIT, stated rather than glossed: the server has ZERO concept of
// "channel" — LAN sidecar and cloud relay are the same binary with two
// separate in-memory registries, so a value from one is structurally never
// found in the other's. The check this file exercises
// (`targetPcId !== auth.deviceId` in relay.handler.ts / `target_pc_id !== pc.id`
// in inject-routes.ts) is a single per-connection string comparison, the SAME
// one G13 and relay-pc-target.test.ts already exercise with same-channel
// values. This file does not discover a new code branch; it pins the exact
// shape the owner's acceptance criteria named, over real sockets, with real
// cross-database values, so a future refactor that tries to special-case
// "same physical machine, different channel" cannot quietly reintroduce a
// bypass.

import path from 'node:path';
import { internalOnly } from './requires.mjs';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, recordAll, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Loopback + synchronous in-handler emits: this is orders of magnitude of
 *  slack for a frame that either arrived or never will (same constant G13
 *  uses, same reasoning). */
const SETTLE_MS = 300;

/** The queued item's real speaking moment — days before this test runs, which is
 *  the whole point of a drain (owner: 「不管时间多久全部都要投递」, and it must
 *  arrive labelled with WHEN it was said, not when it finally left). */
const SPOKEN_AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function drainFrame(marker, targetPcId) {
  return {
    text: marker,
    source: 'stt',
    request_id: `req-${marker}`,
    entry_id: `row-${marker}`,
    target_pc_id: targetPcId,
    created_at: SPOKEN_AT,
  };
}

/** One "physical machine's presence on one channel": a PC socket + its own
 *  phone, paired exactly the way G13 does it (same order, same reason — the
 *  short-code governor hands out one ACTIVE code per PC). Returns the pc_id
 *  this machine is known as ON THIS CONNECTION, plus a frame recorder armed
 *  on the PC socket BEFORE anything is sent.
 */
async function setupMachine(url, label, instTag, pcHandshake = {}) {
  const pc = await connect(url, pcHandshake);
  const reg = await ack(pc, 'pc:register', { device_name: `G14 PC ${label}`, client_instance_id: `inst-g14-${instTag}-0123456789` });
  const mobile = await connect(url);
  const joined = once(pc, 'pc:mobile-joined');
  // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
  // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
  // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
  // One spelling is therefore correct on both, which is also what the real phone
  // does: it sends back whatever the register ack or the QR gave it.
  const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
  await joined;
  if (!reg.pc_id) throw new Error(`pc:register returned no pc_id for ${label}`);
  if (pair.pc_id !== reg.pc_id) {
    throw new Error(`pairing ack pc_id disagrees with pc:register for ${label}: ${JSON.stringify([pair.pc_id, reg.pc_id])}`);
  }
  return { label, pc, mobile, reg, pair, pcId: reg.pc_id, rec: recordAll(pc) };
}

export const G14 = {
  id: 'G14',
  name: '🔴 queue true-drain cross-end regression (two PCs × two channels = four pc_id, drain burst + frozen cross-channel address refused + HTTP retry idempotency)',
  requires: [
    SERVER_DIST,
    internalOnly(path.join(ROOT, 'docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md'),
      'the owner ruling this golden enforces — that a queued item is addressed to a MACHINE, '
      + 'not to whichever connection happens to be up. The open-source export drops the whole '
      + 'documentation tree (owner 2026-08-14), so there this is a name without a file; here it is a '
      + 'hard existence check so the ruling cannot vanish while the test that encodes it stays.'),
    // The CLIENT half: which channel's own address a drain actually uses, and
    // the fail-closed "no match stays queued" rule. Dart, not reachable here.
    path.join(ROOT, 'apps/mobile/test/outbox_test.dart'),
  ],
  async fn(url) {
    const sockets = [];
    const track = (m) => { sockets.push(m.pc, m.mobile); return m; };
    let saas = null;
    try {
      saas = await startSaasServer();
    } catch (e) {
      return FAIL(`cloud server failed to start: ${e.message}`);
    }
    const cloudUrl = `http://127.0.0.1:${saas.port}`;
    try {
      const jwt = await saasJwt(cloudUrl);

      // ── two PCs × two channels, ALL FOUR live at the same time ───────────
      const A_lan = track(await setupMachine(url, 'A-lan', 'a-lan'));
      const B_lan = track(await setupMachine(url, 'B-lan', 'b-lan'));
      const A_cloud = track(await setupMachine(cloudUrl, 'A-cloud', 'a-cloud', { jwt }));
      const B_cloud = track(await setupMachine(cloudUrl, 'B-cloud', 'b-cloud', { jwt }));
      const machines = { A_lan, B_lan, A_cloud, B_cloud };

      const ids = Object.fromEntries(Object.entries(machines).map(([k, m]) => [k, m.pcId]));
      if (new Set(Object.values(ids)).size !== 4) {
        return FAIL(`the four machines did not mint four DISTINCT pc_id — every isolation assertion below would be vacuous: ${JSON.stringify(ids)}`);
      }

      // ── phase 1: drain-SHAPED batch, correctly addressed, interleaved ────
      // Each machine's phone fires a burst of entries (not one) — a drain
      // empties several queued rows in one go, not a single utterance — each
      // stamped with the SPOKEN_AT that a real queue item freezes at enqueue
      // time. Round-robin across all four so the four channels' frames are
      // genuinely interleaved on the wire rather than one machine finishing
      // before the next starts.
      const BURST = 3;
      const markersByMachine = Object.fromEntries(
        Object.keys(machines).map((k) => [k, Array.from({ length: BURST }, (_, i) => `G14-drain-${k}-${i}-${Date.now()}`)]),
      );
      for (let i = 0; i < BURST; i++) {
        for (const [key, m] of Object.entries(machines)) {
          m.mobile.emit('inject:request', drainFrame(markersByMachine[key][i], ids[key]));
        }
      }
      await sleep(SETTLE_MS);

      for (const [key, m] of Object.entries(machines)) {
        for (const marker of markersByMachine[key]) {
          const own = m.rec.carrying(marker);
          if (own.length !== 1) {
            return FAIL(`${key}: expected exactly ONE frame carrying ${marker} on its OWN pc, got ${own.length} — ${own.map((f) => f.event).join(',')}`);
          }
          const payload = own[0].args[0];
          // The queue's whole reason to exist: the row must not claim to have
          // been said "now". A relay that silently restamps created_at would
          // pass every OTHER assertion in this file and still lie about WHEN.
          if (payload?.created_at !== SPOKEN_AT) {
            return FAIL(`${key}/${marker}: created_at did not survive the drain verbatim: ${JSON.stringify(payload?.created_at)} (expected ${SPOKEN_AT})`);
          }
          // 🔴 THE HALF THAT MATTERS: none of the OTHER three machines — same
          // PC on the other channel included — saw one byte of it.
          for (const [otherKey, other] of Object.entries(machines)) {
            if (otherKey === key) continue;
            const leaked = other.rec.carrying(marker);
            if (leaked.length > 0) {
              return FAIL(`${key}'s drain frame ${marker} leaked to ${otherKey}'s pc (${leaked.length} frame(s)) — a drain-shaped batch crossed machines`);
            }
          }
        }
      }

      // ── phase 2: THE scenario the decision doc's §Situation describes ────
      // A queue item was enqueued while addressed to this machine's OTHER
      // channel — a value that is a REAL pc_id (not a made-up string), just
      // not the one THIS connection is bound to. The red line must refuse it
      // exactly as it refuses any other stranger's id, never re-route it to
      // "the same machine, the channel it's actually on".
      for (const [pair, label] of [[['A_cloud', 'A_lan'], 'A: cloud→lan-address'], [['A_lan', 'A_cloud'], 'A: lan→cloud-address'], [['B_cloud', 'B_lan'], 'B: cloud→lan-address'], [['B_lan', 'B_cloud'], 'B: lan→cloud-address']]) {
        const [fromKey, staleKey] = pair;
        const from = machines[fromKey];
        const staleAddress = ids[staleKey];
        const marker = `G14-tamper-${label.replace(/[^a-z0-9]/gi, '')}-${Date.now()}`;
        const verdictP = once(from.mobile, 'inject:result', 3000);
        from.mobile.emit('inject:request', drainFrame(marker, staleAddress));
        let v;
        try {
          v = await verdictP;
        } catch (e) {
          return FAIL(`${label}: a frame frozen with the OTHER channel's address for the SAME machine was dropped WITHOUT a verdict: ${e.message}`);
        }
        if (v.ok !== false || v.error !== 'INJECT_PC_MISMATCH') {
          return FAIL(`${label}: not refused as INJECT_PC_MISMATCH: ${JSON.stringify(v)}`);
        }
        if (v.request_id !== `req-${marker}` || v.entry_id !== `row-${marker}`) {
          return FAIL(`${label}: refusal did not echo both correlation ids: ${JSON.stringify(v)}`);
        }
        await sleep(SETTLE_MS);
        // ⚠️ Checked against ALL FOUR, not just the two in this pair: the
        // failure mode this red line exists for is "delivered to the OTHER
        // machine because the two ids happened to look like the same
        // errand" — checking only the sender's own channel would miss a
        // re-route to the sibling machine or the sibling channel.
        for (const [key, m] of Object.entries(machines)) {
          const hit = m.rec.carrying(marker);
          if (hit.length > 0) {
            return FAIL(`${label}: the REFUSED cross-channel frame still reached ${key}'s pc (${hit.length} frame(s)) — 「排空时用『别的通道上是谁』现推」的那次事故`);
          }
        }
      }
      // ⚠️ THE PROBE'S OWN CONTROL for every zero asserted above: phase 1
      // already proved each `rec` sees a frame that DID arrive on it (its own
      // burst), so the silences in phases 1 and 2 are not a blind recorder.

      // ── phase 3: HTTP image ingress retry idempotency (RV-04, real wire) ──
      // The ONE place server-side "a retry must not duplicate" is real
      // production code reachable over a real socket: InjectPendingRegistry
      // (inject-pending.ts), wired into POST /api/inject/image
      // (inject-routes.ts). This is exactly the path a queued IMAGE drains
      // over on the LAN channel (book 15 §1.1) and exactly the retry a
      // requeued-after-watchdog image produces: same request_id, sent again.
      const httpPost = (frame, token) => fetch(`${url}/api/inject/image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ request: frame }),
      });
      const imgMarker = `G14-http-retry-${Date.now()}`;
      const requestId = `req-${imgMarker}`;
      const entryId = `row-${imgMarker}`;
      const imgFrame = {
        text: '', source: 'image', request_id: requestId, entry_id: entryId,
        target_pc_id: ids.A_lan, entry_type: 'image', entry_caption: '🖼 PNG · 4 B',
        image_b64: 'QUJDRA==', image_mime: 'image/png',
      };
      let sawRelay = false;
      A_lan.pc.once('inject:request', (frame) => {
        if (frame.entry_id === entryId) {
          sawRelay = true;
          A_lan.pc.emit('inject:result', { ok: true, mode: 'clipboard', entry_id: entryId, request_id: requestId });
        }
      });
      const first = await httpPost(imgFrame, A_lan.pair.mobile_token);
      if (first.status !== 200) return FAIL(`HTTP retry idempotency: first POST got HTTP ${first.status}`);
      const firstBody = await first.json();
      if (firstBody.ok !== true) return FAIL(`HTTP retry idempotency: first POST not delivered: ${JSON.stringify(firstBody)}`);
      if (!sawRelay) return FAIL('HTTP retry idempotency: the PC never actually received the FIRST relay — the retry assertion below would be vacuous');
      await sleep(SETTLE_MS);
      const afterFirst = A_lan.rec.carrying(entryId).length;
      if (afterFirst !== 1) return FAIL(`HTTP retry idempotency: after the first POST the pc recorded ${afterFirst} frame(s) carrying the entry (expected exactly 1)`);

      // The retry: BYTE-IDENTICAL request_id, exactly what a phone's own
      // auto-retry sends (image_send_controller mints the id once, outside
      // its retry loop — RV-04's own words).
      const second = await httpPost(imgFrame, A_lan.pair.mobile_token);
      if (second.status !== 200) return FAIL(`HTTP retry idempotency: retry POST got HTTP ${second.status}`);
      const secondBody = await second.json();
      if (secondBody.replayed !== true) return FAIL(`HTTP retry idempotency: retry was not answered as a replay: ${JSON.stringify(secondBody)}`);
      if (secondBody.ok !== true || secondBody.mode !== 'clipboard') {
        return FAIL(`HTTP retry idempotency: the replayed answer diverged from the original verdict: ${JSON.stringify(secondBody)}`);
      }
      await sleep(SETTLE_MS);
      // 🔴 THE assertion this phase exists for: the retry put NO SECOND frame
      // on the wire. An implementation that answers `replayed:true` but
      // relays anyway would pass every check above and still double-paste.
      const afterRetry = A_lan.rec.carrying(entryId).length;
      if (afterRetry !== 1) {
        return FAIL(`HTTP retry idempotency: the RETRY put a SECOND frame on the pc socket (${afterRetry} total carrying the entry) — 「回了 replayed:true 但还是转发了第二次」`);
      }

      return PASS(
        '四台机器（PC-A/PC-B × LAN/cloud = 4 个 distinct pc_id）全程同时在线；drain 形态批量'
        + `（每台 ${BURST} 条，target_pc_id=自己这条连接的 pc_id，created_at=3 天前）交叉发送后每条只落在自己那台`
        + '（正反对照：own 恰好 1 帧且 created_at 逐字未变，其余三台零帧，且 own 的非零已证 probe 非盲）；'
        + '四次跨通道冻结地址尝试（同一物理 PC 的另一条通道的真实 pc_id 当 target）全部 INJECT_PC_MISMATCH + 双 id 回执，'
        + '且四台机器 ZERO 帧命中（不只检查发送方所在的那条通道）；'
        + 'HTTP 图片入口 request_id 重试幂等（RV-04, InjectPendingRegistry, 真实 HTTP + 真实 socket）：'
        + '首次投递 1 帧 + PC 真答；重试拿到 replayed:true 且答案逐字相同，PC 侧仍只有 1 帧，未出双份。'
        + 'NOT covered here: 客户端排空时选哪个地址（resolveOutboxTarget，Dart，见 apps/mobile/test/outbox_test.dart）；'
        + '纯 socket 文字路径的重试去重（INJ-3/INJ-1）——那是桌面 Rust 的 dedup.rs，本文件的「PC」只是裸 socket.io 客户端，'
        + '没有那一层，对同一路重发两次这里只会照单全收两次，这不是本文件的缺陷，是它没有一个真桌面；'
        + '两条通道之间没有共享注册表，所以本文件证明的是同一条相等性检查在跨库真实值下仍然成立，不是发现了新分支。',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

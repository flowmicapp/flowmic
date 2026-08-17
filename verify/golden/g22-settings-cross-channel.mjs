// verify/golden/g22-settings-cross-channel.mjs
//
// G22 — 🔴 cross-channel settings convergence: **a settings row carries WHEN it was
// edited, and the server refuses to move it backwards in time** (G2, 04 §3.7-a).
//
// ── 🔴 what this file proves, and what it does not (both sentences, or the PASS line is lying) ─────
//
// The "phone" here, as in G19/G20, is a **bare socket.io client**: no local KV, no
// reconnect logic, no convergence policy. So:
//   · proved — that TWO REAL SERVERS OF DIFFERENT MODES can hold different copies of one
//     key, that a client can push the newer copy onto the stale one, and that the stale
//     server will NOT accept an older copy over a newer one;
//   · not proved — that the phone actually pushes on the room-join edge, or that it
//     picks the right copy to push. That half is the mobile client's, and it is being
//     built against this contract, not asserted here.
//
// ⚠️ **Neither half is "the acceptance test" alone.** Measured while writing the server
// half: flipping the regress guard's comparison leaves a push-and-re-read client
// entirely green, because such a client cannot observe WHOSE write survived. The
// mobile suite would stay green while the data-loss path was wide open.
//
// ── 🔴 why this needs two servers, and why it is here ────────────────────────────────
//
// The two channels are two INDEPENDENT servers with two INDEPENDENT KVs (05 §5.2). This
// is the only file in the repo where a standalone instance and a saas instance exist at
// the same moment (harness `startServer` / `startSaasServer`), so it is the only place
// the divergence can be built for real instead of simulated.
//
// And the divergence is not hypothetical: `scenario.card` has TWO writers — the phone
// AND the desktop — so two writers × two servers = FOUR copies of one card. Once clients
// converge by pushing their local copy on reconnect, a phone holding a week-old card can
// clobber a desktop edit made five minutes ago. **The regress guard is what stops the
// cure from being worse than the disease**, and step ④ is the assertion that it is armed.
//
// ⚠️ **Every cloud assertion has a same-shape LAN control** — G20's rule. Without it,
// "the cloud leg went red" and "the feature is entirely broken" look identical, while the
// two dispositions are opposite (redeploy the relay / go back and change the code).
//
// 🔴 **STRIP DETECTION doubles as the production canary.** `updated_at` is an ADDITIVE
// optional field, and zod objects silently strip unknown keys — so a server older than
// this feature answers `settings:list` with the frame intact and the stamp quietly gone.
// That is indistinguishable from the bug itself, which is why the failure message names
// the deployment order instead of just reporting a missing key.
//
// ── REVERSE CONTROLS (executed 2026-08-16, this tree; both restored byte-identical) ──
//
//   1. STRIP: stop copying `it.updated_at` in `withEffectiveDefaults` —
//        G22  FAIL  cloud/①: 值对了，但 **updated_at 整个不在帧上**。
//          🔴 部署顺序＝**先中继 + 桌面，最后 APK**。注意服务端有两半 …
//      i.e. the canary fired on the FIRST read, in the intended voice, and named the
//      order — not a bare "expected undefined to be '2026-…'".
//   2. REGRESS: flip the server guard's comparison — asserted in the server suite
//      (apps/server-core/test/settings-updated-at.test.ts, 4 red). Recorded there
//      rather than re-run here because that is where the one-line break lives.
//      🔴 That same break leaves a push-and-re-read MOBILE client entirely green.
//
// Both `requires` docs below are `internalOnly`. The first draft required them
// outright, on a comment claiming docs/rebuild ships in the OSS export — FALSE, the
// manifest excludes `docs/` wholesale, and the runner's drift check caught it before
// this file ever ran. Left as a note because the mistake is cheap to repeat.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, registerAndPair, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';
import { internalOnly } from './requires.mjs';

const KEY = 'scenario.card';

/** Two instants an hour apart. Fixed, not `Date.now()`: the whole point is that the
 *  ORDER is what decides, and a hard-coded pair makes the intended winner readable. */
const T1 = '2026-08-16T10:00:00.000Z';
const T2 = '2026-08-16T11:00:00.000Z';

const card = (tag) => ({ professions: [tag], domains: [], packs: [], terms: [] });
const tagOf = (value) => value?.professions?.[0];

async function listCard(sock) {
  const list = await ack(sock, 'settings:list', {});
  if (!Array.isArray(list?.items)) return { missing: true };
  return list.items.find((i) => i.key === KEY) ?? { absent: true };
}

/** Read the card back and check BOTH halves: the value that won and the stamp it won
 *  with. Returns an error string, or null. */
async function expectCard(label, step, sock, tag, stamp) {
  const item = await listCard(sock);
  if (item.missing) return `${label}/${step}: settings:list 没有 items 数组`;
  if (item.absent) {
    return `${label}/${step}: settings:list 里根本没有 ${KEY} 这个键 —— `
      + '⚠️ 注意「快照里没有」与「服务端说它是空的」在今天的线上是分不清的两件事（05 §5.2）：'
      + '这个键不被播种，所以一台从没被写过的服务端会整个不提它。';
  }
  if (tagOf(item.value) !== tag) {
    return `${label}/${step}: 赢的那一份不对（收到 ${JSON.stringify(tagOf(item.value))}，应为 ${JSON.stringify(tag)}）`;
  }
  // 🔴 STRIP DETECTION — the canary. Said in G19's voice, and naming the order.
  if (item.updated_at === undefined) {
    return `${label}/${step}: 值对了，但 **updated_at 整个不在帧上**。`
      + '\n  🔴 这个键被在途剥掉了 —— 这台服务端跑的 protocol dist 比 G2 旧（zod 会静默剥掉未知键）。'
      + '\n  🔴 部署顺序＝**先中继 + 桌面，最后 APK**。注意服务端有两半：'
      + '云端中继是一半，局域网 sidecar 随**桌面安装包**一起发（tauri.conf.json 的 resources/server.js）'
      + '⇒ 只升中继与 APK、不升桌面的用户会拿到一个「半边武装」的功能。';
  }
  if (item.updated_at !== stamp) {
    return `${label}/${step}: 戳不对（收到 ${JSON.stringify(item.updated_at)}，应为 ${JSON.stringify(stamp)}）`
      + ' —— 服务端存的不是写入方给的那个编辑时刻，跨通道比较会拿它去和别人的真实编辑时间比。';
  }
  return null;
}

/**
 * ④ THE REGRESS CONTROL — the load-bearing one.
 *
 * Push the OLDER copy at a server that already holds the newer one. Three things must
 * be true at once, and each one alone is insufficient:
 *   · the stored row does not move (otherwise the convergence fix is a data-loss path);
 *   · the ack is still ok:true (the sender did nothing wrong — this mints no error code);
 *   · a `settings:updated` carrying the WINNER comes back on the PUSHING socket.
 * That third one is「输家必须被告知」: a silent ok:true would leave the phone believing its
 * stale card is now authoritative, which is 没有静默失败 in the direction that says a
 * thing was done when it was not.
 */
async function regressControl(label, sock) {
  const told = once(sock, 'settings:updated', 3000);
  const res = await ack(sock, 'settings:update', { key: KEY, value: card('v1'), updated_at: T1 });
  if (res?.ok !== true) {
    return `${label}/④: 倒退写被当成了错误（${JSON.stringify(res)}）—— 发起方并没有做错什么，`
      + '它只是拿着一份旧的；这条路刻意不铸错误码。';
  }
  let frame;
  try {
    frame = await told;
  } catch (e) {
    return `${label}/④: **输家没有被告知**（${e.message}）—— 服务端收下了一次注定不生效的写，`
      + '却让发起方以为自己那份已经是权威的了。';
  }
  if (tagOf(frame?.value) !== 'v2' || frame?.updated_at !== T2) {
    return `${label}/④: 回发给输家的不是赢的那一份：${JSON.stringify(frame)}`;
  }
  // …and the row itself really did not move.
  return expectCard(label, '④-after', sock, 'v2', T2);
}

export const G22 = {
  id: 'G22',
  name: '🔴 cross-channel settings: updated_at survives both legs, and an older copy cannot overwrite a newer one',
  requires: [
    SERVER_DIST,
    // The contract this path enforces.
    //
    // ⚠️ MEASURED CORRECTION: the first draft required these two outright, with a
    // comment claiming 「docs/rebuild ships in the OSS export」. That was FALSE — the
    // manifest excludes `docs/` WHOLESALE (owner 2026-08-14 P-1), so in an exported
    // tree this path would have failed forever, on the first command CONTRIBUTING
    // tells a contributor to run. The runner's own drift check caught it, which is
    // the second time that mechanism has paid for itself (G20 was the first).
    // ⇒ evidence cross-links, waived by name; every assertion below still runs in
    //   an exported tree.
    internalOnly(path.join(ROOT, 'docs/rebuild/04-PROTOCOL-SPEC.md'),
      'internal working record: the open-source export EXCLUDEs all of docs/. '
      + '§3.7-a is the wire contract this path enforces (updated_at, the regress rule, '
      + 'the deployment order); it pins the reasoning in the private repo and is not an '
      + 'input to any assertion here.'),
    internalOnly(path.join(ROOT, 'docs/rebuild/05-DATA-MODEL.md'),
      'internal working record: the open-source export EXCLUDEs all of docs/. '
      + '§5.1/§5.2 record that updated_at needed no migration and that two servers = two '
      + 'KVs converged by clients — same role as the file above, an evidence cross-link.'),
    // The server half being asserted. NOT a doc: this one is a hard requirement.
    path.join(ROOT, 'apps/server-core/src/socket/handlers/settings.handler.ts'),
  ],
  async fn(url) {
    const sockets = [];
    let saas = null;
    try {
      // ── LAN leg (the standalone sidecar the desktop ships) ──────────────────────
      const lan = await registerAndPair(url);
      sockets.push(lan.pc, lan.mobile);

      // ── cloud leg (the relay — the only half deployed on its own, hence the only
      //    one that can be stale relative to a phone) ─────────────────────────────
      try {
        saas = await startSaasServer();
      } catch (e) {
        return FAIL(`cloud server failed to start: ${e.message}`);
      }
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const pc = await connect(cloudUrl, { jwt });
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G22 PC', client_instance_id: 'inst-g22-0123456789ab',
      });
      const mobile = await connect(cloudUrl);
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — a saas pairing NAMES its PC; inert on standalone. Same spelling as G20.
      await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      sockets.push(pc, mobile);

      // ── ① the cloud holds v1@T1 ────────────────────────────────────────────────
      await ack(mobile, 'settings:update', { key: KEY, value: card('v1'), updated_at: T1 });
      let err = await expectCard('cloud', '①', mobile, 'v1', T1);
      if (err) return FAIL(`${err}\n  ⚠️ 这是**云端腿**第一步就红了。`);

      // ── ② meanwhile the LAN holds v2@T2 — the divergence, built on two real servers ──
      await ack(lan.mobile, 'settings:update', { key: KEY, value: card('v2'), updated_at: T2 });
      err = await expectCard('lan', '②', lan.mobile, 'v2', T2);
      if (err) return FAIL(`${err}\n  ⚠️ LAN 腿就红了 ⇒ 这不是「中继旧了」，是功能本身坏了。`);

      // ── ③ convergence: the client pushes the NEWER copy at the stale server ─────
      await ack(mobile, 'settings:update', { key: KEY, value: card('v2'), updated_at: T2 });
      err = await expectCard('cloud', '③', mobile, 'v2', T2);
      if (err) return FAIL(`${err}\n  ⚠️ 收敛这一步没成 —— 较新的一份没能覆盖较旧的一份。`);

      // ── ④ the regress control, on BOTH legs (same shape) ───────────────────────
      err = await regressControl('cloud', mobile);
      if (err) return FAIL(`${err}\n  ⚠️ LAN 腿见下；若 LAN 绿而云端红 ⇒ **先部署中继**，别改代码。`);
      err = await regressControl('lan', lan.mobile);
      if (err) return FAIL(`${err}\n  ⚠️ LAN 腿也红了 ⇒ 是实现本身，不是部署。`);

      return PASS(
        '两台真服务端同时在场（standalone ＋ saas，本仓唯一一处）各跑同一组判据：'
        + `① 云端存 v1@${T1} 并如实回读；② 局域网存 v2@${T2} —— **分歧是真造出来的，不是模拟的**`
        + '（两条通道两份独立 KV，05 §5.2）；③ 客户端把较新那份推给陈旧那台，云端收敛到 v2@T2；'
        + '④ **倒退控制**：在两条腿上各把 v1@T1 再推一次 —— 行都没动、ack 仍是 ok:true'
        + '（发起方没做错事，刻意不铸错误码）、且**赢的那一份被回发给输家**那条 socket。'
        + '🔴 ④ 才是承重的那一条：`scenario.card` 有手机与桌面两个写者，两台服务端 ⇒ 四份拷贝，'
        + '没有这道拒收，「重连即推」会造出一条今天并不存在的数据丢失路径。'
        + '🔴 每一步都做 **strip detection**：值对而戳不在 ⇒ 直接点名部署顺序'
        + '（先中继＋桌面、最后 APK；⚠️ 服务端有两半，局域网 sidecar 随桌面安装包发）。'
        + '🔴 NOT covered here：手机到底在不在进房那条边上推、推的是不是该推的那一份 —— '
        + '本文件的「手机」是裸 socket.io 客户端。**这一半绿不代表功能成立**：'
        + '实测把服务端的倒退判据反过来，只推送并回读自己那份的客户端**全绿**。',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

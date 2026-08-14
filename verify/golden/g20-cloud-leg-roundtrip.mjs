// verify/golden/g20-cloud-leg-roundtrip.mjs
//
// G20 — 🔴 the cloud leg's full round trip: **the frame gets through, and the receipt comes back** (owner 2026-08-03).
//
// owner original wording: 「云端腿 你直接增加用例来验证测试就可以，不要再让我真机测。」
// Before this, "cloud leg" in both real-device session sheets stayed 【unverified】, and every real-device run required **switching channels,
// reconnecting, and saying it again** — and the phone-side "upload diagnostics" on the cloud leg **cannot be obtained at all**
// (the relay does not accept that endpoint, returning the named `noSink`) ⇒ on this leg a real device **had little evidence to see to begin with**.
// The machine run is actually stronger: frame-level assertions can see every key.
//
// ── 🔴 what this file proves, and what it does not (both sentences must be said, or the PASS line is lying) ─────────────
//
// The "PC" here, as in G19/G14, is a **bare socket.io client**: no inject pipeline, no focus FSM.
//   · proved — three keys that **only go wrong if stripped in flight**, round-tripped verbatim on a real saas server;
//   · not proved — what the desktop does after it receives the frame. That half lives in Rust's own tests.
//
// ── 🔴 why these three keys deserve a golden path: they are all "silent strip" failures ──────────────
//
// zod objects **silently strip unknown keys**, and the relay forwards `parsed.data`
// (`relay.handler.ts`'s own comment records this costing `duration_ms` a whole release).
// So the manifestation of "the relay is older than the phone" is: **the frame still arrives, the feature quietly vanishes**.
// Every key here corresponds to a real loss we paid for:
//
//   ① `duration_ms`  — added in 0.2.43, production relay was then on 0.2.38 ⇒ **cloud-leg rows never had a duration**,
//                        all falling into "N other rows have no duration record". Session sheet §H-3 was written for this.
//   ② `error` (the code on the receipt) — 0.2.49's F2: whether the phone judges "delivered · not injected" or "awaiting delivery"
//                        depends on **this code**, not `mode`. The criterion's source is pinned in
//                        `packages/protocol/src/inject-verdict-authorship.ts`,
//                        which also writes down **why `mode` cannot be the criterion** (server-authored refusals also stamp
//                        `mode:'cached'` ⇒ the same value has two authors). Lose the code ⇒ the phone reads the PC's own
//                        "cached" answer as "never arrived", redelivery hits dedup, replays the original verdict, and goes back to
//                        queued — **a lifetime loop** (the confirmed case of book 15 R11).
//                        ⚠️ `mode` is also asserted, but it must be said that it is **not the fragile one**: it is a
//                        **required** key of `InjectResultSchema`, zod cannot strip it. Asserting it pins
//                        "the receipt as a whole was not rewritten", not because it can be lost.
//   ③ `retry_after_ms` — 49-2 (owner 2026-08-03 real-device): after the occupying party leaves, the waiting party uses this number
//                        to come back and ask on its own. Strip it in flight ⇒ that timer never winds, and the user has to go back to the instance
//                        list and connect again — **i.e. the symptom this round just fixed, resurrected on the cloud leg**.
//
// ⚠️ **every assertion has a same-shape LAN-leg control**. Without it, "the cloud leg went red" and "the feature is entirely broken"
// look identical, while the two dispositions are completely different (redeploy the relay / go back and change the code).

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, recordAll, registerAndPair, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';
import { internalOnly } from './requires.mjs';

/** Spoken for 4.2 seconds. Not an integer, so "whether it was rounded into something else" is also visible. */
const DURATION_MS = 4213;

/** All assertions for one leg. `label` goes only into error messages; the criteria themselves are verbatim-identical on both legs. */
async function legAssertions(label, pc, mobile, pcId, mobileId) {
  const stamp = `${label}-${Date.now()}`;
  const rec = recordAll(pc);
  const back = recordAll(mobile);

  // ── ① outbound: inject:request carries duration_ms verbatim to the PC ────────────────────
  const marker = `G20-${stamp}-text`;
  const requestId = `req-${marker}`;
  const arrived = once(pc, 'inject:request', 3000);
  mobile.emit('inject:request', {
    text: marker,
    source: 'stt',
    request_id: requestId,
    entry_id: `row-${marker}`,
    target_pc_id: pcId,
    duration_ms: DURATION_MS,
  });
  let req;
  try {
    req = await arrived;
  } catch (e) {
    return `${label}: 去程整帧没到 PC（${e.message}）—— 这条腿是断的，不是丢了某个键`;
  }
  if (req?.duration_ms !== DURATION_MS) {
    return `${label}: duration_ms 没有逐字穿过（收到 ${JSON.stringify(req?.duration_ms)}，`
      + `应为 ${DURATION_MS}）—— 服务端的 protocol dist 比这个字段旧，云端腿的行会没有时长`;
  }
  // positive control that the probe is not blind: this frame was in fact seen by recordAll.
  if (rec.carrying(marker).length !== 1) {
    return `${label}: 帧级探针看见 ${rec.carrying(marker).length} 帧（应为 1）—— 探针瞎了，`
      + `下面每一条「没收到」都不作数`;
  }

  // ── ② return trip: the **code** on inject:result comes back to the phone verbatim ───────────────────────────
  // 🔴 this is the R11 one: `ok:false` but **it is the PC's own answer**, which equally proves the delivery segment succeeded.
  // The phone accordingly says "delivered · not injected"; lose the code and it can only say "awaiting delivery", which is a lie.
  const resultBack = once(mobile, 'inject:result', 3000);
  pc.emit('inject:result', {
    request_id: requestId,
    ok: false,
    error: 'INJECT_NO_TEXT_TARGET',
    mode: 'cached',
  });
  let res;
  try {
    res = await resultBack;
  } catch (e) {
    return `${label}: 回执整个没回来（${e.message}）—— 手机永远等不到结论`;
  }
  if (res?.request_id !== requestId) {
    return `${label}: 回执的 request_id 对不上（${JSON.stringify(res?.request_id)}）—— 串号`;
  }
  if (res?.error !== 'INJECT_NO_TEXT_TARGET') {
    return `${label}: 回执上的码在途丢了/被改了（收到 ${JSON.stringify(res?.error)}）—— 手机会把`
      + ` PC 亲口答的「已缓存」读成「没送到」，重投撞去重、replay 原判决、又回 queued：终身循环`;
  }
  if (res?.mode !== 'cached' || res?.ok !== false) {
    return `${label}: 回执的判决被改写了：${JSON.stringify(res)}`;
  }

  // ── ③ positive control: a successful receipt also comes back ──────────────────────────────────────
  // Without this one, an implementation that "only forwards failure receipts" would be all green above.
  // ⚠️ Use a request_id that actually completed a trip: the relay mirrors a receipt that **parsed successfully**, not any
  // invented id — the first draft got this wrong (`mode:'injected'` is not even in the enum;
  // legal values are sendinput/clipboard/cached, the frame was correctly dropped by zod, and the test went red on itself).
  const okBack = once(mobile, 'inject:result', 3000);
  pc.emit('inject:result', {
    request_id: requestId, ok: true, mode: 'sendinput', target_window: 'Notepad',
  });
  let okRes;
  try {
    okRes = await okBack;
  } catch (e) {
    return `${label}: 成功回执没回来（${e.message}）`;
  }
  if (okRes?.ok !== true || okRes?.mode !== 'sendinput' || okRes?.target_window !== 'Notepad') {
    return `${label}: 成功回执被改写了：${JSON.stringify(okRes)}`;
  }

  // ── ④ 49-2: an occupancy refusal must arrive carrying its budget ────────────────────────────────────
  // The PC kicks this phone with `reason:'busy'` (what the desktop does when a second phone comes to grab the capsule),
  // so its next `mobile:reconnect` is refused by name. **The phone's auto-recheck timer winds from this number**
  // (`pc_busy.dart`'s `note(retryAfterMs:)`) — lose the number, the timer never winds, and the user has to
  // go back to the instance list.
  const kicked = await ack(pc, 'pc:release-mobile', { mobile_id: mobileId, reason: 'busy' });
  if (kicked?.released !== 1) {
    return `${label}: 没能把手机踢下线（${JSON.stringify(kicked)}）—— 这一条测的不是占用`;
  }
  const retry = await connect(mobile.io.uri);
  let refusal;
  try {
    refusal = await ack(retry, 'mobile:reconnect', { token: mobile.__token });
  } finally {
    retry.disconnect();
  }
  if (refusal?.error !== 'PC_BUSY') {
    return `${label}: 占用没有被具名拒收：${JSON.stringify(refusal)}`;
  }
  if (typeof refusal?.retry_after_ms !== 'number' || refusal.retry_after_ms <= 0) {
    return `${label}: PC_BUSY 没带 retry_after_ms（${JSON.stringify(refusal)}）—— 手机的自动`
      + `复检永远不上弦，49-2 的症状在这条腿上原样复活`;
  }
  if (refusal?.retryable !== true) {
    return `${label}: PC_BUSY 没说自己可重试：${JSON.stringify(refusal)}`;
  }

  rec.stop();
  back.stop();
  return null;
}

export const G20 = {
  id: 'G20',
  name: '🔴 cloud-leg full round trip: duration_ms / mode / retry_after_ms three keys survive the relay verbatim (same-shape LAN control)',
  requires: [
    SERVER_DIST,
    // The real-device entries this path replaced, kept in `requires` so they cannot be deleted one day while this still cites them.
    //
    // 🔴 2026-08-06 (card IT-22 acceptance, MEASURED): those two paths live under
    // docs/strategy/, which the open-source export EXCLUDEs wholesale (internal
    // working records) — so in an exported public tree they CANNOT exist, and a
    // plain `requires` made G20 the one red line in that tree's
    // `pnpm verify:delivery`. The reason above is still right and stays; what was
    // wrong is that it was stated as an unconditional requirement.
    //
    // `internalOnly()` says the missing half out loud, and the runner CHECKS the
    // claim against opensource-manifest.mjs's EXCLUDE instead of believing it —
    // both directions, so this and the manifest cannot drift apart. In THIS tree
    // the requirement is exactly as hard as before: delete either sheet and G20
    // fails, naming it. Mechanism + the two drift checks: verify/golden/requires.mjs.
    //
    // ⚠️ What is waived is the EVIDENCE CROSS-LINK, never an assertion: the three
    // cloud-leg keys below run in full in an exported tree. Losing cloud-leg
    // coverage in the public repo would be far worse than losing a doc pointer,
    // and a golden that skipped itself over a missing document would be claiming
    // the second cost to avoid the first.
    internalOnly(path.join(ROOT, 'docs/strategy/2026-08-02-a2-real-device-sheet.md'),
      'internal working record: the open-source export EXCLUDEs all of docs/strategy/. '
      + 'It is the A2 real-device sheet whose 「云端腿」 entries this path replaced; '
      + 'it pins the evidence in the private repo and is not an input to any assertion here.'),
    internalOnly(path.join(ROOT, 'docs/strategy/2026-08-01-real-device-session-sheet.md'),
      'internal working record: the open-source export EXCLUDEs all of docs/strategy/. '
      + 'Same role as the sheet above (the A1 queue/image session sheet) — an evidence '
      + 'cross-link, not a test input.'),
    // the phone-side consumer of the `mode` assertion (R11 / F2).
    path.join(ROOT, 'apps/mobile/lib/src/session/delivery_outbox.dart'),
    // the phone-side consumer of the `retry_after_ms` assertion (49-2).
    path.join(ROOT, 'apps/mobile/lib/src/session/pc_busy.dart'),
  ],
  async fn(url) {
    const sockets = [];
    let saas = null;
    try {
      // ── LAN leg (the standalone sidecar the desktop ships) = the control group ─────────────────
      const lan = await registerAndPair(url);
      lan.mobile.__token = lan.pair.mobile_token;
      sockets.push(lan.pc, lan.mobile);
      const lanFail = await legAssertions('lan', lan.pc, lan.mobile, lan.reg.pc_id, lan.pair.pairing_id);
      if (lanFail) {
        return FAIL(`${lanFail}\n  ⚠️ LAN 腿就红了 ⇒ 这不是「中继旧了」，是功能本身坏了。`);
      }

      // ── cloud leg (the relay — the only one deployed separately, and therefore the only one that can be stale) ───────────
      try {
        saas = await startSaasServer();
      } catch (e) {
        return FAIL(`cloud server failed to start: ${e.message}`);
      }
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const pc = await connect(cloudUrl, { jwt });
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G20 PC', client_instance_id: 'inst-g20-0123456789ab',
      });
      const mobile = await connect(cloudUrl);
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
      // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
      // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
      // One spelling is therefore correct on both, which is also what the real phone
      // does: it sends back whatever the register ack or the QR gave it.
      const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      mobile.__token = pair.mobile_token;
      sockets.push(pc, mobile);
      const cloudFail = await legAssertions('cloud', pc, mobile, reg.pc_id, pair.pairing_id);
      if (cloudFail) {
        return FAIL(`${cloudFail}\n  ⚠️ LAN 腿是绿的而云端腿红了 ⇒ **先部署中继**，别改代码。`);
      }

      return PASS(
        '云端腿（真 saas 服务端）与 LAN 腿（standalone）各跑同一组四条：'
        + `① inject:request 的 duration_ms=${DURATION_MS} 逐字到 PC（additive 键没被 zod 剥掉，`
        + '帧级探针恰好 1 帧⇒非盲）；② inject:result 的**错误码**（INJECT_NO_TEXT_TARGET）'
        + '逐字回到手机——那是 R11 那条「PC 亲答的 cached ≠ 没送到」的判据来源'
        + '（出处 inject-verdict-authorship.ts；⚠️ 判据是码不是 mode，mode 有两个作者），'
        + 'ok/mode/request_id 同时断死以钉住整帧未被改写；'
        + '③ 正向对照：ok:true / mode:sendinput / target_window 的成功回执同样回得来'
        + '（防「只转发失败回执」的实现在②全绿）；'
        + '④ PC 以 reason:busy 踢人后，下一次 mobile:reconnect 被具名拒收且**带着 '
        + 'retry_after_ms 与 retryable**——手机那只自动复检的表（pc_busy.dart，49-2）就靠它上弦。'
        + '🔴 这四条替下了两份真机执行单里长期【未验】的「云端腿」条目，'
        + '而且比真机更强：云端腿上手机的「上传诊断」拿不到（中继返回具名 noSink），'
        + '真机在这条腿上本来就只能看 PC 侧与手机界面。'
        + '🔴 NOT covered here：桌面拿到帧之后打不打字——本文件的「PC」是裸 socket.io 客户端。',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

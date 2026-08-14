// verify/golden/g19-deferred-not-autoinjected.mjs
//
// G19 — 🔴 deferred redelivery must not auto-inject: **does the stamp on the frame actually survive the trip** (card L8, 2026-08-02).
//
// owner ruling (docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md):
// 「之前没发送成功、后面（连上网）补投到 PC 的消息，PC 端不能随便注入……直接注进当前
// 输入窗口可能引起事故。」 The phone stamps `inject:request.inject_origin`, the PC
// refuses to type a `deferred` one.
//
// ── 🔴 WHAT THIS FILE PROVES, AND WHAT IT CANNOT (say both, or the PASS line lies)
//
// The "PC" here is a bare socket.io client (the SIM-MOBILE CAVEAT in
// run-golden.mjs's header, applied to the other end — the same limit G14 states
// for itself). It has no focus FSM, no SendInput, no `inject/pipeline.rs`. So:
//
//   · PROVED HERE — the stamp SURVIVES THE SERVER, verbatim, on BOTH channels, in
//     both directions of the rule, and an UNSTAMPED frame still crosses untouched.
//   · NOT PROVED HERE — that the desktop declines to type. That is Rust and it is
//     asserted where it lives: `inject/pipeline_tests.rs` (the gate as a pure
//     function, plus its positive control) and `socket/inject_ops.rs`'s inline
//     tests (that `run_inject` CONSULTS it, after dedup, before any target is
//     resolved — so "zero injection" is "the focus switcher was never called").
//
// ── 🔴 WHY IT IS WORTH A GOLDEN PATH ANYWAY: IT IS THE DEPLOY GATE ────────────
//
// zod objects STRIP unknown keys, and the relay forwards `parsed.data`
// (relay.handler.ts, whose own comment records this hazard costing `duration_ms` a
// release). A relay whose protocol dist predates this round therefore DELETES
// `inject_origin` in flight — the frame still delivers, the PC reads "didn't say", and a
// deferred redelivery is typed into the user's window exactly as it used to be. **That failure is
// silent on every other test.** This file makes it LOUD: run it against a server
// built from a stale protocol dist and phase 1 goes red on the missing key.
// ⇒ "deploy the relay first, then ship the APK" stops being something a person has to remember.
//
// (`pnpm golden` rebuilds protocol + server-core first — 0.2.29 made that
// unconditional precisely because a stale dist lies in both directions.)

import path from 'node:path';
import { internalOnly } from './requires.mjs';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, recordAll, registerAndPair, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Loopback + synchronous in-handler emits (same constant and reasoning as G13/G14). */
const SETTLE_MS = 300;

/** The queued item's real speaking moment — days old, which is what a drain carries. */
const SPOKEN_AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function frame(marker, targetPcId, origin) {
  return {
    text: marker,
    source: 'stt',
    request_id: `req-${marker}`,
    entry_id: `row-${marker}`,
    target_pc_id: targetPcId,
    created_at: SPOKEN_AT,
    // `undefined` ⇒ the key is absent on the wire, which is the pre-0.2.48 shape.
    ...(origin === undefined ? {} : { inject_origin: origin }),
  };
}

/** One channel's leg: send the three shapes, assert what the PC received. */
async function legAssertions(label, mobile, rec, pcId) {
  const stamp = Date.now();
  const cases = [
    // 🔴 THE ONE THE RULING IS ABOUT.
    ['deferred', 'deferred'],
    // 🔴 THE POSITIVE CONTROL. Without it, a relay that dropped EVERY frame would
    // satisfy "the deferred one was not injected" and this file would be green
    // while the product was dead.
    ['live', 'live'],
    // 🔴 THE "one-size-fits-all" CONTROL. A deferred redelivery the USER pressed is `source:'history'` +
    // `inject_origin:'live'` — the one combination where `source` alone would give
    // the opposite answer. An implementation that keyed the refusal off `source`
    // (the obvious wrong shortcut) would stamp this one deferred.
    ['manual-resend', 'live'],
    // The compatibility floor: a 0.2.47 phone says nothing at all.
    ['unstamped', undefined],
  ];
  const seen = {};
  for (const [name, origin] of cases) {
    const marker = `G19-${label}-${name}-${stamp}`;
    const f = frame(marker, pcId, origin);
    if (name === 'manual-resend') f.source = 'history';
    mobile.emit('inject:request', f);
    seen[name] = marker;
  }
  await sleep(SETTLE_MS);

  for (const [name, origin] of cases) {
    const marker = seen[name];
    // 🔴 FRAME-LEVEL, via `onAny` + a unique marker: "asserting only that one event name arrived or not cannot prove
    // not one character arrived" (G13's lesson). Here it also buys the positive half — we assert
    // on the frame that DID arrive, so a silent probe cannot pass anything below.
    const hits = rec.carrying(marker);
    if (hits.length !== 1) {
      return `${label}/${name}: expected exactly ONE frame carrying ${marker}, got ${hits.length}`;
    }
    const payload = hits[0].args[0];
    if (payload?.inject_origin !== origin) {
      return `${label}/${name}: inject_origin did not cross verbatim — got ${JSON.stringify(payload?.inject_origin)}, expected ${JSON.stringify(origin)}`
        + (origin !== undefined && payload?.inject_origin === undefined
          ? '. 🔴 THE KEY WAS STRIPPED IN FLIGHT — this server is running a protocol dist older than 0.2.48. Deploy the relay BEFORE shipping an APK, or every 补投 keeps auto-injecting.'
          : '');
    }
    // The rest of the frame must be untouched: this is an ADDITIVE field, and an
    // additive field that perturbs its neighbours is not additive.
    if (payload?.created_at !== SPOKEN_AT) {
      return `${label}/${name}: created_at did not survive verbatim: ${JSON.stringify(payload?.created_at)}`;
    }
    if (payload?.request_id !== `req-${marker}` || payload?.entry_id !== `row-${marker}`) {
      return `${label}/${name}: correlation keys did not cross verbatim: ${JSON.stringify(payload)}`;
    }
  }
  return null;
}

export const G19 = {
  id: 'G19',
  name: '🔴 deferred redelivery does not auto-inject: inject_origin crosses both channels verbatim (including unstamped old frames) + a stale relay goes red',
  requires: [
    SERVER_DIST,
    internalOnly(path.join(ROOT, 'docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md'),
      'the owner ruling this golden enforces — a deferred redelivery is delivered but NOT '
      + 'auto-injected. The open-source export excludes the whole documentation tree (owner 2026-08-14), so the '
      + 'file cannot exist there; in this repo it stays a hard existence check.'),
    // The two halves this file deliberately does NOT cover, `requires`d so the
    // evidence cannot quietly disappear (G14's own convention).
    path.join(ROOT, 'apps/desktop/src-tauri/src/inject/pipeline_tests.rs'),
    path.join(ROOT, 'apps/mobile/test/outbox_inject_origin_test.dart'),
  ],
  async fn(url) {
    const sockets = [];
    let saas = null;
    try {
      // ── LAN leg (the standalone sidecar the desktop ships) ───────────────
      const lan = await registerAndPair(url);
      sockets.push(lan.pc, lan.mobile);
      const lanRec = recordAll(lan.pc);
      const lanFail = await legAssertions('lan', lan.mobile, lanRec, lan.reg.pc_id);
      if (lanFail) return FAIL(lanFail);

      // ── CLOUD leg (the relay — the ONLY one that is deployed separately, and
      //    therefore the only one that can be stale) ─────────────────────────
      try {
        saas = await startSaasServer();
      } catch (e) {
        return FAIL(`cloud server failed to start: ${e.message}`);
      }
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const pc = await connect(cloudUrl, { jwt });
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G19 PC', client_instance_id: 'inst-g19-0123456789ab',
      });
      const mobile = await connect(cloudUrl);
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
      // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
      // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
      // One spelling is therefore correct on both, which is also what the real phone
      // does: it sends back whatever the register ack or the QR gave it.
      await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      sockets.push(pc, mobile);
      const cloudRec = recordAll(pc);
      const cloudFail = await legAssertions('cloud', mobile, cloudRec, reg.pc_id);
      if (cloudFail) return FAIL(cloudFail);

      // ── 🔴 the boundary still refuses a value it does not know ────────────
      // Not a third policy: an unknown intent has no safe reading, so it dies at
      // zod and is answered BY NAME rather than being coerced to one of the two.
      const bad = once(mobile, 'inject:result', 3000);
      mobile.emit('inject:request', {
        ...frame(`G19-bad-${Date.now()}`, reg.pc_id, undefined),
        inject_origin: 'whenever',
      });
      let v;
      try {
        v = await bad;
      } catch (e) {
        return FAIL(`an out-of-enum inject_origin was dropped WITHOUT a verdict: ${e.message}`);
      }
      if (v.ok !== false || v.error !== 'INJECT_FRAME_INVALID') {
        return FAIL(`an out-of-enum inject_origin was not refused by name: ${JSON.stringify(v)}`);
      }

      return PASS(
        '两条通道（LAN standalone + 云端 relay）各四种帧：inject_origin=deferred / live / '
        + '(source:history + live，防「按 source 一刀切」) / 完全不盖章（0.2.47 兼容底线）——'
        + '全部逐字穿过服务端，帧级断言（onAny + 每帧唯一 marker，own 恰好 1 帧⇒探针非盲），'
        + '且 created_at / request_id / entry_id 同时逐字未变（additive 不许扰动邻居）；'
        + '枚举外的值在边界具名拒收（INJECT_FRAME_INVALID，带回执，不是静默丢弃）。'
        + '🔴 NOT covered here: PC 端到底打不打字——本文件的「PC」是裸 socket.io 客户端，没有注入管线。'
        + '那一半在 src-tauri/src/inject/pipeline_tests.rs（闸本身 + 正向对照）与 '
        + 'socket/inject_ops.rs 内联测试（run_inject 真的调它、在 dedup 之后、在解析目标之前⇒'
        + '「零注入」＝焦点切换器一次都没被调用）；手机端盖章规则在 '
        + 'apps/mobile/test/outbox_inject_origin_test.dart 与 outbox_test.dart。'
        + '🔴 本文件真正的价值是**部署闸**：中继若跑在 0.2.48 之前的 protocol dist 上，'
        + 'zod 会在途剥掉这个未知键，本用例当场见红——「先部署中继、再出 APK」从此不靠人记得。',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

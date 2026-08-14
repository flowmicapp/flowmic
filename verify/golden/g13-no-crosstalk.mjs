// verify/golden/g13-no-crosstalk.mjs
//
// G13 — 🔴 crosstalk regression (owner 2026-07-31 iron rule, original wording 「生死线，不能触犯」).
//
// 「每条消息都有『投递 id』与『目标 PC 的 id』，这两个必须对应起来，不能串」——
// from which phone it was spoken, via which channel, to which PC, 100% correct. The owner's own acceptance
// wording is what this file executes:
//
//   两台手机 × 两条通道 × 两台 PC 同时在场，排空后每条只落在自己的目的地,
//   并且篡改目标要被拒收（正向 + 反向对照都要有）.
//
// WHAT EACH LAYER PROVES, so nothing here claims another layer's coverage:
//   · THIS FILE — the SERVER halves, over a real server and real sockets, with
//     four live sockets at once (two PCs + two phones) on each channel. It is the
//     only layer where 「两台同时在场」 is a fact rather than a fixture.
//   · apps/server-core/test/relay-pc-target.test.ts — the branches a wire test
//     cannot reach: the fail-CLOSED case (a connection with no bound PC id), the
//     ordering rule (mismatch decided BEFORE the room lookup, so an empty room
//     still says MISMATCH rather than "retry later"), and the once-per-connection
//     compat breadcrumb.
//   · apps/mobile/test/inject_target_pc_id_test.dart — the PHONE half. ⚠️ The
//     SIM-MOBILE CAVEAT in run-golden.mjs's header applies in full: the "phone"
//     below is a socket.io script standing in for the app, so a green run here
//     says NOTHING about whether the real app stamps `target_pc_id`. That is the
//     Dart card's evidence and it is `requires`d so it cannot quietly disappear.
//
// ⚠️ two channels — WHAT "CHANNEL" MEANS HERE, exactly. 07 §6's two channels are the
// LAN sidecar and the cloud relay, and they are THE SAME BINARY in two modes:
// standalone (what the desktop spawns locally) and saas (what flowmic.app
// runs). The desktop registers with `pc:register` on both — the cloud one with a
// Cloud Key JWT in the handshake (src-tauri/socket/channel.rs). So this path runs
// the whole scenario twice, once per mode, with the cloud leg carrying the JWT
// exactly as the product does. What it does NOT cover is stated in the PASS line
// rather than glossed: no public relay, no network between the ends.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, recordAll, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

/** How long a frame gets to arrive at the WRONG destination before the silence
 *  is called real. Everything here is loopback and the relay's emit is
 *  synchronous inside the handler, so this is orders of magnitude of slack. */
const SETTLE_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A base64 blob that is canonical per InjectImageBase64Schema (len % 4 === 0). */
const TINY_PNG_B64 = 'QUJDRA==';
/** The shape the phone's `imageEntryLabel` really produces (image_payload.dart). */
const IMAGE_CAPTION = '🖼 PNG · 4 B';

function injectFrame(text, tag, kind, targetPcId) {
  return {
    text,
    source: 'stt',
    request_id: `req-${tag}-${kind}`,
    entry_id: `row-${tag}-${kind}`,
    target_pc_id: targetPcId,
  };
}

/**
 * Run the whole crosstalk regression against ONE running server (= one channel).
 * Returns `{ note }` on success or `{ reason }` on failure — never throws for a
 * test outcome, so the caller can attribute a failure to the channel it came
 * from.
 *
 * @param {string} url        the server under test
 * @param {object} opts
 * @param {string} opts.tag   channel label, also the per-frame id namespace
 * @param {object} opts.handshake  socket auth for the PC sockets ({} | {jwt})
 * @param {boolean} opts.http whether the HTTP image ingress is mounted (standalone-only)
 */
async function crosstalkLeg(url, { tag, handshake, http }) {
  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };
  const bad = (reason) => ({ reason: `[${tag}] ${reason}` });
  try {
    // ── two real PCs, each with its OWN phone, all four live simultaneously ──
    // Registered/paired in this order (A fully, then B) for the same reason G12
    // uses it: the short-code governor hands out one ACTIVE code per PC, and
    // pairing A before B mints them in an order a real pair of machines would.
    const pcA = track(await connect(url, handshake));
    const regA = await ack(pcA, 'pc:register', { device_name: `G13 PC A (${tag})`, client_instance_id: `inst-g13-${tag}-a-0123456789` });
    const mobA = track(await connect(url));
    const joinedA = once(pcA, 'pc:mobile-joined');
    // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
    // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
    // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
    // One spelling is therefore correct on both, which is also what the real phone
    // does: it sends back whatever the register ack or the QR gave it.
    const pairA = await ack(mobA, 'mobile:pair', { short_code: regA.short_code, pcid: regA.pcid });
    await joinedA;

    const pcB = track(await connect(url, handshake));
    const regB = await ack(pcB, 'pc:register', { device_name: `G13 PC B (${tag})`, client_instance_id: `inst-g13-${tag}-b-0123456789` });
    const mobB = track(await connect(url));
    const joinedB = once(pcB, 'pc:mobile-joined');
    const pairB = await ack(mobB, 'mobile:pair', { short_code: regB.short_code, pcid: regB.pcid });
    await joinedB;

    // ── the two preconditions that decide whether ANY of this means something ──
    // ① Two PCs that collapsed onto one row make every 「只落自己的目的地」
    //    assertion trivially true (G12 carries the same guard for the same
    //    reason).
    if (!regA.pc_id || !regB.pc_id) return bad(`pc:register returned no pc_id: ${JSON.stringify([regA.pc_id, regB.pc_id])}`);
    if (regA.pc_id === regB.pc_id) return bad('the two PCs collapsed onto one device row — every crosstalk assertion below would be vacuous');
    // ② The ADDRESS a phone writes is spec'd as "the `pc_id` it was handed in its
    //    pairing ack" (protocol-schemas-inject.ts). If the ack and pc:register
    //    disagreed, this test would be addressing with a value no real phone
    //    possesses — a measurement off a path the product does not walk.
    if (pairA.pc_id !== regA.pc_id || pairB.pc_id !== regB.pc_id) {
      return bad(`the pairing ack's pc_id is not the PC's own id — the address the phone would write is not the one the server compares: ${JSON.stringify([pairA.pc_id, regA.pc_id, pairB.pc_id, regB.pc_id])}`);
    }

    const recPcA = recordAll(pcA);
    const recPcB = recordAll(pcB);
    const recMobA = recordAll(mobA);
    const recMobB = recordAll(mobB);

    // ── positive: both phones drain at the same time, each into its own PC ────────
    const textAA = `G13-${tag}-AA-${Date.now()}`;
    const textBB = `G13-${tag}-BB-${Date.now()}`;
    const atA = once(pcA, 'inject:request', 3000);
    const atB = once(pcB, 'inject:request', 3000);
    mobA.emit('inject:request', injectFrame(textAA, tag, 'aa', pairA.pc_id));
    mobB.emit('inject:request', injectFrame(textBB, tag, 'bb', pairB.pc_id));
    let gotA;
    let gotB;
    try {
      [gotA, gotB] = await Promise.all([atA, atB]);
    } catch (e) {
      return bad(`a CORRECTLY addressed frame never reached its own PC: ${e.message}`);
    }
    if (gotA.text !== textAA) return bad(`PC-A received the wrong sentence: ${JSON.stringify(gotA.text)}`);
    if (gotB.text !== textBB) return bad(`PC-B received the wrong sentence: ${JSON.stringify(gotB.text)}`);
    // The address itself has to survive the relay: the PC is the end that renders
    // "this one is for me", and a stripped field is silent (zod strips unknown keys).
    if (gotA.target_pc_id !== pairA.pc_id) return bad(`the address did not survive the relay to PC-A: ${JSON.stringify(gotA.target_pc_id)}`);
    if (gotB.target_pc_id !== pairB.pc_id) return bad(`the address did not survive the relay to PC-B: ${JSON.stringify(gotB.target_pc_id)}`);

    await sleep(SETTLE_MS);
    // 🔴 THE HALF A "received" ASSERTION CANNOT SEE: the OTHER PC got nothing.
    // Any event name, any payload — "not one character may reach that PC".
    const aLeakedToB = recPcB.carrying(textAA);
    if (aLeakedToB.length > 0) return bad(`PC-B received ${aLeakedToB.length} frame(s) carrying PHONE-A's sentence: ${aLeakedToB.map((f) => f.event).join(', ')}`);
    const bLeakedToA = recPcA.carrying(textBB);
    if (bLeakedToA.length > 0) return bad(`PC-A received ${bLeakedToA.length} frame(s) carrying PHONE-B's sentence: ${bLeakedToA.map((f) => f.event).join(', ')}`);
    // ⚠️ THE PROBE'S OWN CONTROL. The two silences above are worth exactly what
    // this probe can see, and here it is looking at the socket that SHOULD have
    // the sentence. If this is empty, `carrying()` is blind and the negatives are
    // vacuous — the failure mode that makes a red-line test worse than none.
    if (recPcA.carrying(textAA).length === 0) return bad('the probe cannot see a frame that DID arrive — every 「零帧」 assertion above is vacuous');
    if (recPcB.carrying(textBB).length === 0) return bad('the probe cannot see a frame that DID arrive — every 「零帧」 assertion above is vacuous');
    // A correctly addressed frame is answered by the PC, never refused by us.
    if (recMobA.carrying('INJECT_PC_MISMATCH').length > 0) return bad('a CORRECTLY addressed frame drew INJECT_PC_MISMATCH');
    if (recMobB.carrying('INJECT_PC_MISMATCH').length > 0) return bad('a CORRECTLY addressed frame drew INJECT_PC_MISMATCH');

    // ── reverse (tampered): each phone addresses the OTHER user's machine ───────────
    // This is the failure the red line exists for — a queue item whose address is
    // stale/tampered while the connection it drains on belongs to someone else.
    const crossAB = `G13-${tag}-A2B-TAMPERED-${Date.now()}`;
    const crossBA = `G13-${tag}-B2A-TAMPERED-${Date.now()}`;
    const verdictAP = once(mobA, 'inject:result', 3000);
    const verdictBP = once(mobB, 'inject:result', 3000);
    mobA.emit('inject:request', injectFrame(crossAB, tag, 'a2b', pairB.pc_id));
    mobB.emit('inject:request', injectFrame(crossBA, tag, 'b2a', pairA.pc_id));
    let vA;
    let vB;
    try {
      [vA, vB] = await Promise.all([verdictAP, verdictBP]);
    } catch (e) {
      // no silent failure: a refusal that never reaches the sender leaves the row on ⏳
      // forever, which is indistinguishable from "it worked" to the user.
      return bad(`a mis-addressed frame was dropped WITHOUT a verdict: ${e.message}`);
    }
    for (const [who, v, kind] of [['A→B', vA, 'a2b'], ['B→A', vB, 'b2a']]) {
      if (v.ok !== false) return bad(`the ${who} tamper was answered ok=${v.ok}`);
      if (v.error !== 'INJECT_PC_MISMATCH') return bad(`the ${who} tamper was not refused BY NAME: ${JSON.stringify(v)}`);
      // BOTH echoes, or the phone knows a row was refused but not which one.
      if (v.request_id !== `req-${tag}-${kind}` || v.entry_id !== `row-${tag}-${kind}`) {
        return bad(`the ${who} refusal did not echo both correlation ids: ${JSON.stringify(v)}`);
      }
    }
    await sleep(SETTLE_MS);
    // ⚠️ THIS IS THE ASSERTION THAT MATTERS MORE THAN THE ERROR CODE. An
    // implementation that answers "refused" and delivers anyway passes an
    // error-code-only test and types a stranger's sentence into your machine.
    for (const [needle, who] of [[crossAB, 'A→B'], [crossBA, 'B→A']]) {
      const hitA = recPcA.carrying(needle);
      const hitB = recPcB.carrying(needle);
      if (hitA.length > 0 || hitB.length > 0) {
        return bad(`the REFUSED ${who} frame still reached a PC (PC-A:${hitA.length}, PC-B:${hitB.length}) — 「回了错误码但还是打进了别人的电脑」`);
      }
    }

    // ── unaddressed (0.2.33): a frame with NO address at all ──────────────────────
    // The third verdict on this gate, and it is NOT the tamper case: that one is
    // "the machine you want to send to is not this one" (the sender has an address and it is wrong), this one
    // is "you did not say which machine to send to" (there is no address to check anything against). Until
    // this round an unaddressed frame was FORWARDED — a knowing compat gap for
    // 0.2.28 handsets, i.e. a branch where the red line simply did not apply.
    const noAddr = `G13-${tag}-NOADDR-${Date.now()}`;
    const verdictNA = once(mobA, 'inject:result', 3000);
    mobA.emit('inject:request', {
      text: noAddr,
      source: 'stt',
      request_id: `req-${tag}-noaddr`,
      entry_id: `row-${tag}-noaddr`,
      // …and deliberately no `target_pc_id`.
    });
    let vNA;
    try {
      vNA = await verdictNA;
    } catch (e) {
      return bad(`an unaddressed frame was dropped WITHOUT a verdict: ${e.message}`);
    }
    if (vNA.ok !== false) return bad(`the unaddressed frame was answered ok=${vNA.ok}`);
    // BY NAME, and by the RIGHT name: reusing INJECT_PC_MISMATCH here would tell
    // the user their delivery went to another machine, which is a claim about a
    // target the frame never named.
    if (vNA.error !== 'INJECT_PC_UNSPECIFIED') return bad(`an unaddressed frame was not refused as INJECT_PC_UNSPECIFIED: ${JSON.stringify(vNA)}`);
    if (vNA.request_id !== `req-${tag}-noaddr` || vNA.entry_id !== `row-${tag}-noaddr`) {
      return bad(`the unaddressed refusal did not echo both correlation ids: ${JSON.stringify(vNA)}`);
    }
    await sleep(SETTLE_MS);
    // Same assertion that matters more than the code: "answered with an error code but forwarded anyway" passes
    // an error-code-only test. Frame-level, any event name, both PCs. The probes
    // were proved non-blind above, against frames that DID arrive.
    for (const [rec, name] of [[recPcA, 'PC-A'], [recPcB, 'PC-B']]) {
      const hit = rec.carrying(noAddr);
      if (hit.length > 0) return bad(`the REFUSED unaddressed frame still reached ${name}: ${hit.map((f) => f.event).join(', ')}`);
    }

    if (!http) return { note: `${tag}: socket ingress 正向+篡改+未寻址 all refused, addressed pair delivered` };

    // ── the SECOND entrance to the same red line: POST /api/inject/image ──────
    // "HTTP is another entrance, not a second contract" (0.2.16). A red line with one entrance
    // guarded is not a red line, and this ingress is the one the phone really
    // walks for pictures on the LAN (RCA-v3). standalone-only, so this block runs
    // on the LAN leg only — the cloud relay does not mount the route.
    const httpPost = (frame, token) => fetch(`${url}/api/inject/image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ request: frame }),
    });
    const imgFrame = (kind, targetPcId) => ({
      text: '',
      source: 'image',
      request_id: `req-${tag}-${kind}`,
      entry_id: `row-${tag}-${kind}`,
      ...(targetPcId === undefined ? {} : { target_pc_id: targetPcId }),
      // RV-68 (0.2.33): an image frame's `text` is '' by design, so the row's
      // words ride here. Carried through this ingress on the positive leg below,
      // because a caption that is silently stripped between the phone and the PC
      // reproduces the exact bug this field was added to fix.
      entry_type: 'image',
      entry_caption: IMAGE_CAPTION,
      image_b64: TINY_PNG_B64,
      image_mime: 'image/png',
    });
    // reverse first, and BEFORE any successful upload, so nothing it could be
    // confused with exists yet.
    const refused = await httpPost(imgFrame('http-cross', pairB.pc_id), pairA.mobile_token);
    // 409, not 200+ok:false — grep'd in inject-routes.ts's own header: the phone
    // settles a row off ANY 200 that is not one of two named codes, so a 200 here
    // would make a SERVER refusal look like the PC's verdict.
    if (refused.status !== 409) return bad(`HTTP ingress: a mis-addressed image got HTTP ${refused.status}, must be 409`);
    const refusedBody = await refused.json();
    if (refusedBody.error !== 'INJECT_PC_MISMATCH') return bad(`HTTP ingress refusal not named: ${JSON.stringify(refusedBody)}`);
    if (refusedBody.request_id !== `req-${tag}-http-cross` || refusedBody.entry_id !== `row-${tag}-http-cross`) {
      return bad(`HTTP ingress refusal did not echo both ids: ${JSON.stringify(refusedBody)}`);
    }
    await sleep(SETTLE_MS);
    for (const [rec, name] of [[recPcA, 'PC-A'], [recPcB, 'PC-B']]) {
      const hit = rec.carrying(`row-${tag}-http-cross`);
      if (hit.length > 0) return bad(`the REFUSED http image still reached ${name}: ${hit.map((f) => f.event).join(', ')}`);
    }
    // unaddressed on the same ingress (0.2.33). "HTTP is another entrance, not a second contract": a
    // red line whose second entrance still tolerates address-less frames has a
    // back door. 400 here rather than the mismatch's 409 — nothing CONFLICTS with
    // this endpoint, a required field is simply missing (same verdict an absent
    // request_id gets) — and what matters equally is what they share: NON-200,
    // which is the phone's "the server refused, retrying will not help" branch rather than a 200 it
    // would settle as the PC's own verdict.
    const noAddrRefused = await httpPost(imgFrame('http-noaddr', undefined), pairA.mobile_token);
    if (noAddrRefused.status !== 400) return bad(`HTTP ingress: an unaddressed image got HTTP ${noAddrRefused.status}, must be 400`);
    const noAddrBody = await noAddrRefused.json();
    if (noAddrBody.error !== 'INJECT_PC_UNSPECIFIED') return bad(`HTTP ingress unaddressed refusal not named: ${JSON.stringify(noAddrBody)}`);
    if (noAddrBody.request_id !== `req-${tag}-http-noaddr` || noAddrBody.entry_id !== `row-${tag}-http-noaddr`) {
      return bad(`HTTP ingress unaddressed refusal did not echo both ids: ${JSON.stringify(noAddrBody)}`);
    }
    await sleep(SETTLE_MS);
    for (const [rec, name] of [[recPcA, 'PC-A'], [recPcB, 'PC-B']]) {
      const hit = rec.carrying(`row-${tag}-http-noaddr`);
      if (hit.length > 0) return bad(`the REFUSED unaddressed http image still reached ${name}: ${hit.map((f) => f.event).join(', ')}`);
    }

    // positive on the same ingress — and the control for the silences above: the route
    // DOES deliver, to the addressed PC, when the address is right.
    const okEntry = `row-${tag}-http-ok`;
    let arrivedAtPcA = null;
    pcA.once('inject:request', (frame) => {
      arrivedAtPcA = frame;
      pcA.emit('inject:result', { ok: true, mode: 'clipboard', entry_id: frame.entry_id, request_id: frame.request_id });
    });
    const delivered = await httpPost(imgFrame('http-ok', pairA.pc_id), pairA.mobile_token);
    if (delivered.status !== 200) return bad(`HTTP ingress: a correctly addressed image got HTTP ${delivered.status}`);
    const deliveredBody = await delivered.json();
    if (deliveredBody.ok !== true) return bad(`HTTP ingress: correctly addressed image not delivered: ${JSON.stringify(deliveredBody)}`);
    await sleep(SETTLE_MS);
    if (recPcA.carrying(okEntry).length === 0) return bad('HTTP ingress: the addressed PC never saw the image frame — the refusal assertions above are vacuous');
    if (recPcB.carrying(okEntry).length > 0) return bad('HTTP ingress: the OTHER PC saw an image addressed to PC-A');
    // RV-68: the row's WORDS crossed. Compared against the literal, so a stripped
    // field (zod drops unknown keys — silently) fails here instead of arriving as
    // a picture row with nothing under it.
    if (arrivedAtPcA?.entry_caption !== IMAGE_CAPTION) {
      return bad(`the image row's caption did not survive the ingress: ${JSON.stringify(arrivedAtPcA?.entry_caption)}`);
    }

    return { note: `${tag}: socket ingress 正向+篡改+未寻址; http image ingress 409/400+正向, caption intact` };
  } catch (e) {
    return bad(`threw: ${e.message}`);
  } finally {
    for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
  }
}

export const G13 = {
  id: 'G13',
  name: '🔴 crosstalk regression (no crosstalk: two phones × two channels × two PCs — each lands only on its own destination, tampered targets refused)',
  requires: [
    SERVER_DIST,
    // The branches a wire test cannot reach (fail-closed / ordering / breadcrumb).
    path.join(ROOT, 'apps/server-core/test/relay-pc-target.test.ts'),
    // The PHONE half (SIM-MOBILE CAVEAT): whether the real app stamps
    // target_pc_id on all four emission paths is pinned there, not here.
    path.join(ROOT, 'apps/mobile/test/inject_target_pc_id_test.dart'),
  ],
  async fn(url) {
    // ── channel ①: the LAN sidecar (standalone mode, the shared instance) ──
    const lan = await crosstalkLeg(url, { tag: 'lan', handshake: {}, http: true });
    if (lan.reason) return FAIL(lan.reason);

    // ── channel ②: the cloud relay (saas mode, its own instance + a JWT) ──
    let saas = null;
    try {
      saas = await startSaasServer();
    } catch (e) {
      return FAIL(`cloud leg: saas server failed to start: ${e.message}`);
    }
    try {
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const cloud = await crosstalkLeg(cloudUrl, { tag: 'cloud', handshake: { jwt }, http: false });
      if (cloud.reason) return FAIL(cloud.reason);
      return PASS(
        'BOTH channels (standalone = the LAN sidecar, saas = the cloud relay, the cloud leg admitted by handshake JWT as the desktop does): '
        + 'two PCs + two phones live at once; each phone\'s correctly-addressed inject:request reached ITS OWN PC with target_pc_id intact '
        + 'AND the other PC recorded ZERO frames carrying that sentence (probe self-checked against the PC that DID receive it); '
        + 'each phone\'s TAMPERED frame (addressed to the other machine) was refused ok:false/INJECT_PC_MISMATCH echoing BOTH request_id and entry_id, '
        + 'and BOTH PCs recorded ZERO frames carrying it; an UNADDRESSED frame (0.2.33) was refused ok:false/INJECT_PC_UNSPECIFIED — a DIFFERENT code, '
        + 'because 「你没说要送给哪台」 and 「你要送的那台不是这台」 send the user to two different places — with both echoes and zero frames at either PC. '
        + 'LAN leg additionally drove the second ingress POST /api/inject/image: '
        + 'mis-addressed ⇒ HTTP 409 INJECT_PC_MISMATCH, unaddressed ⇒ HTTP 400 INJECT_PC_UNSPECIFIED (both with both echoes and zero frames at either PC), '
        + 'correctly addressed ⇒ delivered to PC-A only WITH its entry_caption intact (RV-68 — an image frame\'s text is \'\' by design, so a stripped caption is a blank row). '
        + 'NOT covered here: the real phone\'s stamping (apps/mobile/test/inject_target_pc_id_test.dart), the fail-closed / before-room-lookup branches '
        + '(apps/server-core/test/relay-pc-target.test.ts), and any public network between the ends (both servers are loopback).',
      );
    } catch (e) {
      return FAIL(`cloud leg threw: ${e.message}`);
    } finally {
      saas.child.kill();
    }
  },
};

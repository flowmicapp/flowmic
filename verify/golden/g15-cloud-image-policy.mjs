// verify/golden/g15-cloud-image-policy.mjs
//
// G15 — cloud-relay image policy (RV-87, owner 2026-08-01).
//
//   "If it is the relay channel, **the server uniformly intercepts the client**; pictures over 1M are not allowed through, to prevent using the relay as
//    a photo-sync tool"
//   "**Cap it at 200 pictures**, because each send is one picture, and manually sending 200 is annoying work, normally
//    nobody wants to, but **add a limit to exclude machine auto-sends**"
//
// WHY THIS PATH EXISTS AT ALL, given that the policy object and the handler each
// have their own unit tests: both of those construct the policy themselves. The
// question neither can answer is "the SERVER THE PRODUCT RUNS, started in saas
// mode from its own env, actually refuses" — i.e. that bootstrap wires it, that
// `config.mode` is the branch, and that the refusal travels back over a real
// socket instead of the frame vanishing. That is what a real server + real
// sockets buys, and it is the same thing G13 buys for the addressing gates.
//
// WHAT IT DOES NOT COVER, stated rather than glossed:
//   · the PHONE's own ceiling (image_payload.dart `kCloudImageBytesMax`) — the
//     SIM-MOBILE CAVEAT in run-golden.mjs's header applies in full: the "phone"
//     below is a socket.io script, so it proves nothing about what the app sends.
//     That half is apps/mobile/test/image_original_option_test.dart, `requires`d
//     so it cannot quietly disappear. The two halves answer different questions
//     ("whether to allow it" vs "whether to even bother making the trip") and only THIS one is a defence.
//   · a public relay or any network between the ends — this server is loopback.
//   · the 24-hour ROLL. A golden path cannot wait a day; the window's boundary
//     arithmetic is a fake-clock assertion in
//     apps/server-core/test/cloud-image-policy.test.ts. What runs here is the
//     count and the ceiling.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, recordAll, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

/** owner: "must not exceed 1M" → 1 MiB (packages/protocol/src/constants.ts
 *  CLOUD_IMAGE_BYTES_MAX). Repeated as a literal here on purpose: golden runs the
 *  BUILT dist, and a harness that imported the same constant the server imports
 *  could not tell "the ceiling is 1 MiB" from "the ceiling is whatever the
 *  constant happens to say". The protocol test pins the constant to the copy; this
 *  pins the running server to the number owner said. */
const ONE_MIB = 1_048_576;
/** owner: "cap it at 200 pictures" — same reasoning as above for repeating it. */
const QUOTA = 200;

/** How long a refused frame gets to arrive at the PC before the silence is real. */
const SETTLE_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `n` decoded bytes as canonical base64 (InjectImageBase64Schema: len % 4 === 0,
 *  canonical alphabet). */
const b64OfBytes = (n) => Buffer.alloc(n).toString('base64');

function imageFrame({ bytes, tag, targetPcId }) {
  return {
    text: '', // an image frame's text is '' by design (RV-68)
    source: 'image',
    request_id: `req-${tag}`,
    entry_id: `row-${tag}`,
    target_pc_id: targetPcId,
    entry_type: 'image',
    image_b64: b64OfBytes(bytes),
    image_mime: 'image/png',
  };
}

/** Wait until `rec` holds at least `n` frames named `event`, or give up. */
async function waitForFrames(rec, event, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const have = rec.frames.filter((f) => f.event === event).length;
    if (have >= n) return have;
    if (Date.now() > deadline) return have;
    await sleep(25);
  }
}

export const G15 = {
  id: 'G15',
  name: 'cloud-relay image policy (RV-87: >1 MiB refused by name + 200 pictures/24h quota, server uniformly intercepts)',
  requires: [
    SERVER_DIST,
    // The PHONE's own ceiling (SIM-MOBILE CAVEAT): whether the real app declines
    // to PRODUCE an over-size picture on the cloud leg is pinned there, not here.
    path.join(ROOT, 'apps/mobile/test/image_original_option_test.dart'),
    // The 24-hour roll and the judge/record split, on a fake clock.
    path.join(ROOT, 'apps/server-core/test/cloud-image-policy.test.ts'),
  ],
  async fn() {
    // Its OWN saas instance: the ceilings are saas-only by construction, and a
    // 200-picture budget is per-account state that must not leak into another G.
    let saas = null;
    try {
      saas = await startSaasServer();
    } catch (e) {
      return FAIL(`saas server failed to start: ${e.message}`);
    }
    const url = `http://127.0.0.1:${saas.port}`;
    const sockets = [];
    const track = (s) => { sockets.push(s); return s; };
    try {
      const jwt = await saasJwt(url);
      // A real PC + a real phone in one room, exactly as G13's cloud leg does it
      // (the desktop's cloud channel carries the Cloud Key JWT in the handshake).
      const pc = track(await connect(url, { jwt }));
      const reg = await ack(pc, 'pc:register', { device_name: 'G15 PC', client_instance_id: 'inst-g15-0123456789' });
      const mobile = track(await connect(url));
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — the pairing NAMES its PC. Required on a saas leg (owner 2026-08-14:
      // a bare code is refused with PAIR_PCID_REQUIRED) and inert on a standalone one
      // (`reg.pcid` is undefined, JSON drops the key, the LAN resolve never reads it).
      // One spelling is therefore correct on both, which is also what the real phone
      // does: it sends back whatever the register ack or the QR gave it.
      const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      if (!pair.pc_id || pair.pc_id !== reg.pc_id) {
        return FAIL(`the pairing ack's pc_id is not the PC's own id: ${JSON.stringify([pair.pc_id, reg.pc_id])}`);
      }

      const recPc = recordAll(pc);
      const recMob = recordAll(mobile);

      // ── ① POSITIVE CONTROL, first: a picture EXACTLY at the ceiling crosses ──
      // Without this the two silences below would also be satisfied by a relay
      // that refuses every image, and the whole path would be measuring nothing.
      // "over 1M is not allowed through" — at is not over.
      const atCap = once(pc, 'inject:request', 8000);
      mobile.emit('inject:request', imageFrame({ bytes: ONE_MIB, tag: 'at-cap', targetPcId: pair.pc_id }));
      let arrived;
      try {
        arrived = await atCap;
      } catch (e) {
        return FAIL(`a picture EXACTLY at the 1 MiB ceiling never reached the PC: ${e.message}`);
      }
      if (arrived.entry_id !== 'row-at-cap') return FAIL(`the wrong frame arrived: ${JSON.stringify(arrived.entry_id)}`);
      if (recMob.carrying('INJECT_CLOUD_IMAGE').length > 0) {
        return FAIL('a picture AT the ceiling drew a cloud-policy refusal — the boundary is 「超过」, not 「达到」');
      }

      // ── ② over the ceiling ⇒ refused BY NAME, and the PC gets nothing ────────
      const overVerdictP = once(mobile, 'inject:result', 8000);
      mobile.emit('inject:request', imageFrame({ bytes: ONE_MIB + 1, tag: 'over-cap', targetPcId: pair.pc_id }));
      let overVerdict;
      try {
        overVerdict = await overVerdictP;
      } catch (e) {
        // TWO very different defects land here and they must not read the same.
        // Written this way because the first reverse-control run reported "dropped
        // WITHOUT a verdict" for a build whose gate was removed — the frame was not
        // dropped at all, it had been RELAYED, and a failure message that names the
        // wrong defect sends the next reader to the wrong file.
        await sleep(SETTLE_MS);
        if (recPc.carrying('row-over-cap').length > 0) {
          return FAIL('the over-size image was RELAYED to the PC — the 1 MiB ceiling is not being enforced at all (and no verdict came back either)');
        }
        // no silent failure: a refusal that never reaches the sender leaves the row on
        // ⏳ forever, which the user cannot tell from success.
        return FAIL(`an over-size image was dropped WITHOUT a verdict: ${e.message}`);
      }
      if (overVerdict.ok !== false) return FAIL(`the over-size image was answered ok=${overVerdict.ok}`);
      if (overVerdict.error !== 'INJECT_CLOUD_IMAGE_TOO_LARGE') {
        // Specifically NOT INJECT_FRAME_TOO_LARGE: that sentence is about the WIRE
        // cap and holds on both channels, so it would send this user off to find a
        // smaller picture when the LAN would carry the one they have.
        return FAIL(`the over-size image was not refused by the right name: ${JSON.stringify(overVerdict)}`);
      }
      if (overVerdict.request_id !== 'req-over-cap' || overVerdict.entry_id !== 'row-over-cap') {
        return FAIL(`the refusal did not echo both correlation ids: ${JSON.stringify(overVerdict)}`);
      }
      await sleep(SETTLE_MS);
      // ⚠️ THE ASSERTION THAT MATTERS MORE THAN THE CODE (the G13 lesson): an
      // implementation that answers "refused" and relays anyway passes a code-only
      // test while putting the picture on the relay. Frame-level, any event name.
      const leaked = recPc.carrying('row-over-cap');
      if (leaked.length > 0) {
        return FAIL(`the REFUSED over-size image still reached the PC (${leaked.map((f) => f.event).join(', ')}) — 「回了错误码但照样转发」`);
      }
      // …and the probe is not blind: it can see the frame that DID arrive in ①.
      if (recPc.carrying('row-at-cap').length === 0) {
        return FAIL('the probe cannot see a frame that DID arrive — the silence above is vacuous');
      }

      // ── ③ 200 pictures / 24h, driven through the running server ────────────────────
      // ① already spent one slot; the over-size frame in ② must have spent NONE
      // (judge stamps nothing; the count is stamped at the emit). So exactly
      // QUOTA-1 more pictures may cross — and if ② HAD been counted, the last of
      // them would be refused, which is what makes this an assertion about the
      // judge/record split rather than just about the number.
      const tiny = 12;
      for (let i = 1; i < QUOTA; i++) {
        mobile.emit('inject:request', imageFrame({ bytes: tiny, tag: `bulk-${i}`, targetPcId: pair.pc_id }));
      }
      const delivered = await waitForFrames(recPc, 'inject:request', QUOTA);
      if (delivered !== QUOTA) {
        const refusals = recMob.frames.filter((f) => JSON.stringify(f).includes('INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED'));
        return FAIL(
          `only ${delivered}/${QUOTA} pictures crossed before the budget ran out`
          + (refusals.length > 0
            ? ` — ${refusals.length} early quota refusal(s), i.e. something that was NOT relayed still spent a slot`
            : ' (frames lost, not refused)'),
        );
      }
      if (recMob.carrying('INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED').length > 0) {
        return FAIL(`the budget ran out before ${QUOTA} pictures had actually crossed`);
      }

      // …and the next one is refused BY NAME.
      const quotaVerdictP = once(mobile, 'inject:result', 8000);
      mobile.emit('inject:request', imageFrame({ bytes: tiny, tag: 'over-quota', targetPcId: pair.pc_id }));
      let quotaVerdict;
      try {
        quotaVerdict = await quotaVerdictP;
      } catch (e) {
        // Same two-defects-one-symptom split as ② — and this branch has a real
        // reverse control behind it: deleting the `record()` call at the relay's
        // emit leaves `judge` intact and every picture legal, so the budget simply
        // never runs out. That is a ceiling that has silently stopped existing,
        // not a dropped frame.
        await sleep(SETTLE_MS);
        if (recPc.carrying('row-over-quota').length > 0) {
          return FAIL(`the ${QUOTA + 1}-th picture was RELAYED — the ${QUOTA}-picture budget is not being counted (is the relay still calling record() at the emit?)`);
        }
        return FAIL(`the ${QUOTA + 1}-th picture was dropped WITHOUT a verdict: ${e.message}`);
      }
      if (quotaVerdict.ok !== false) return FAIL(`the over-quota picture was answered ok=${quotaVerdict.ok}`);
      if (quotaVerdict.error !== 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED') {
        // Specifically NOT QUOTA_EXCEEDED: that code exists so that PAYING RAISES
        // IT, and no plan raises this one.
        return FAIL(`the over-quota picture was not refused by the right name: ${JSON.stringify(quotaVerdict)}`);
      }
      if (quotaVerdict.request_id !== 'req-over-quota' || quotaVerdict.entry_id !== 'row-over-quota') {
        return FAIL(`the quota refusal did not echo both correlation ids: ${JSON.stringify(quotaVerdict)}`);
      }
      await sleep(SETTLE_MS);
      if (recPc.carrying('row-over-quota').length > 0) {
        return FAIL('the REFUSED over-quota picture still reached the PC — 「回了错误码但照样转发」');
      }
      const totalAtPc = recPc.frames.filter((f) => f.event === 'inject:request').length;
      if (totalAtPc !== QUOTA) {
        return FAIL(`the PC received ${totalAtPc} pictures — the ceiling is ${QUOTA}`);
      }

      // ── ④ TEXT is untouched by an image policy ───────────────────────────────
      // The control for ③: a budget that had swallowed the whole relay would look
      // identical from the assertions above.
      const textP = once(pc, 'inject:request', 5000);
      mobile.emit('inject:request', {
        text: 'G15-text-after-the-image-budget', source: 'stt',
        request_id: 'req-text', entry_id: 'row-text', target_pc_id: pair.pc_id,
      });
      try {
        await textP;
      } catch (e) {
        return FAIL(`the image budget also blocked TEXT — that is a different question entirely: ${e.message}`);
      }

      return PASS(
        `real saas server (bootstrap-wired, mode from its own env): a picture EXACTLY at ${ONE_MIB} B crossed to the PC; `
        + 'one byte over was refused ok:false/INJECT_CLOUD_IMAGE_TOO_LARGE echoing BOTH ids, and the PC recorded ZERO frames of ANY name carrying it '
        + '(probe self-checked against the picture that DID arrive) — deliberately not INJECT_FRAME_TOO_LARGE, whose 「电脑侧未接收」 sentence is about the wire cap and holds on both channels; '
        + `then exactly ${QUOTA} pictures crossed in total — which also proves the refused one spent NO slot (judge stamps nothing, the count is stamped at the emit) — `
        + `and the ${QUOTA + 1}-th was refused ok:false/INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED with both echoes and zero frames at the PC, deliberately not QUOTA_EXCEEDED (that code promises an upgrade would help; no plan raises this one); `
        + 'a text delivery after the budget was exhausted still crossed. '
        + 'NOT covered here: the phone\'s own ceiling (apps/mobile/test/image_original_option_test.dart — the SIM-MOBILE CAVEAT applies in full), '
        + 'the 24-hour roll (fake-clock assertions in apps/server-core/test/cloud-image-policy.test.ts), and any public network between the ends (loopback).',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      saas.child.kill();
    }
  },
};

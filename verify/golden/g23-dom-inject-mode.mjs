// verify/golden/g23-dom-inject-mode.mjs
//
// G23 — 🔴 `inject:result.mode: 'dom'`: a WEB TARGET's receipt crosses the relay
// verbatim, and a mode outside the enum does not cross it at all.
//
// Card S2-03 (FLOWMIC-WEB stage two), owner's 2026-09-06 ruling 2. A web target —
// a page acting as a "virtual computer" — writes the words into the input element
// it is bound to and reports `ok:true, mode:'dom'`, optionally substantiated by
// reading the element back (`focus_evidence:'editable'`, an existing key).
//
// ── 🔴 WHY THIS PATH EXISTS AT ALL: the planning document was wrong about the
//    relay, in the direction that costs a release ───────────────────────────────
//
// `docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md` §1.4 says the
// relay 「透传不校验」 ("forwards transparently, without validating") this frame,
// and concluded from that the only mirror that mattered was the phone's Dart
// reader. MEASURED, it is the other way round:
//
//   · the PHONE's reader is open — `InjectResult.tryFromJson` carries any string
//     verbatim (`j['mode'] is String ? … : null`), so `'dom'` was already
//     surviving that door before the enum existed;
//   · the RELAY is the closed one — `relay.handler.ts` runs every `inject:result`
//     through `safeParseEvent` and, on a failed parse, `logDrop`s it and forwards
//     NOTHING (it mirrors `parsed.data`, never the raw payload).
//
// ⇒ `mode` is a REQUIRED key, so an old relay does not quietly STRIP `'dom'` the
// way it stripped `duration_ms` (G20 ①) — it refuses the whole receipt. The phone
// then hears nothing at all: the row stays at 「待投递」 and the queue keeps owing
// an utterance the page already typed, which is red line R11's forbidden
// direction. ⇒ **DEPLOY THE RELAY BEFORE SHIPPING A WEB TARGET.**
//
// This file is what makes that sentence a measurement rather than a belief:
// assertion ③ sends a frame whose `mode` is outside the enum and shows the phone
// receives nothing, with a positive control proving the probe was not blind.
//
// ── What this proves, and what it does not (both sentences, or the PASS line is
//    lying) ──────────────────────────────────────────────────────────────────────
//
//   · proved — the wire. The "PC" here, as in G19/G20, is a bare socket.io client
//     standing in for a web target; the "phone" is a bare socket.io client too.
//   · NOT proved — that a real page emits this frame (its emitter lives in the
//     FLOWMIC-WEB repository, card S2-06 — there is no producer in this repo), and
//     not what the phone DOES with it. The phone half is pinned by its own test,
//     `apps/mobile/test/inject_result_dom_mode_test.dart`, which is `requires`d
//     below so the evidence cannot quietly disappear. Per the runner's SIM-MOBILE
//     rule: when a path's story needs the phone, cite the phone's own test — do
//     not re-enact it here.
//
// ⚠️ BOTH LEGS RUN THE SAME BUILD IN THIS RUNNER, and that is a different control
// from G20's. There, LAN-green/cloud-red separates 「the deployed relay is stale」
// from 「the feature is broken」, because only the cloud relay is deployed
// separately. Here both legs are this working tree's `server-core`, so the control
// answers a narrower question: does the standalone sidecar's ingress and the saas
// ingress (JWT admission + PCID pairing) treat this receipt identically. The stale
// -deploy hazard is real but lives in production, which is what the deploy-order
// note on `InjectResultSchema.mode` is for.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, neverWithin, recordAll, registerAndPair, startSaasServer, saasJwt,
  PASS, FAIL,
} from './harness.mjs';

/** A mode that is NOT in the enum — deliberately plausible-looking, because a
 *  typo is the realistic way this happens, not a hostile value. */
const OFF_ENUM_MODE = 'webdom';

/** All assertions for one leg. `label` only reaches error messages; the criteria
 *  themselves are verbatim-identical on both legs. */
async function legAssertions(label, pc, mobile) {
  const stamp = `${label}-${Date.now()}`;
  const back = recordAll(mobile);

  // ── ① a dom receipt crosses verbatim ───────────────────────────────────────
  //
  // Every key asserted here answers a question the phone will ask:
  //   · `mode` — the whole card. If it comes back rewritten, the row cannot say
  //     which path typed the words.
  //   · `ok` — with `mode:'dom'` this is 「已注入」, both segments (15 §2.0).
  //   · `focus_evidence` — the page's read-back of the element it wrote into. An
  //     ADDITIVE OPTIONAL key, i.e. the kind zod silently strips when the relay is
  //     older than the sender; that is the `duration_ms` failure shape, and this
  //     is the receipt's only piece of evidence.
  //   · `request_id` — the correlation echo. Lose it and the verdict settles no
  //     row at all (F11 ②: a verdict for a row we cannot resolve settles nothing).
  const goodMarker = `G23-${stamp}-dom`;
  const goodRequestId = `req-${goodMarker}`;
  const arrived = once(mobile, 'inject:result', 3000);
  pc.emit('inject:result', {
    ok: true,
    mode: 'dom',
    request_id: goodRequestId,
    entry_id: `row-${goodMarker}`,
    focus_evidence: 'editable',
    target_window: 'flowmic web target — #compose',
  });
  let res;
  try {
    res = await arrived;
  } catch (e) {
    return `${label}: the dom receipt never came back (${e.message}) — with the enum in place`
      + ` this is the relay refusing a frame it should forward; the phone would keep the row at`
      + ` 「待投递」 for words the page already typed`;
  }
  if (res?.mode !== 'dom') {
    return `${label}: mode did not survive verbatim (got ${JSON.stringify(res?.mode)}) —`
      + ` the server's protocol dist is older than InjectResultSchema's fourth value`;
  }
  if (res?.ok !== true) {
    return `${label}: the verdict itself was rewritten: ${JSON.stringify(res)}`;
  }
  if (res?.request_id !== goodRequestId) {
    return `${label}: the correlation echo is wrong (${JSON.stringify(res?.request_id)}) —`
      + ` this verdict would settle nobody's row`;
  }
  if (res?.focus_evidence !== 'editable') {
    return `${label}: focus_evidence was stripped in flight (got`
      + ` ${JSON.stringify(res?.focus_evidence)}) — the additive-optional failure shape that`
      + ` cost duration_ms a whole release; the receipt keeps its verdict and loses its evidence`;
  }
  // Positive control: the frame-level probe is not blind, so the negative below
  // means something.
  if (back.carrying(goodMarker).length !== 1) {
    return `${label}: the frame probe saw ${back.carrying(goodMarker).length} frames carrying`
      + ` the marker (expected 1) — the probe is blind, so nothing below counts`;
  }

  // ── ② a mode OUTSIDE the enum reaches nobody ────────────────────────────────
  //
  // 🔴 This is the assertion the addendum's 「transparent forwarding」 sentence
  // predicts would FAIL. It is written against the FRAMES as well as the event
  // name: an implementation that refused `inject:result` and mirrored the same
  // payload under another name would satisfy the narrow check and break the rule.
  const badMarker = `G23-${stamp}-offenum`;
  pc.emit('inject:result', {
    ok: true,
    mode: OFF_ENUM_MODE,
    request_id: `req-${badMarker}`,
    entry_id: `row-${badMarker}`,
  });
  const silent = await neverWithin(mobile, 'inject:result', 800);
  if (!silent) {
    return `${label}: a receipt whose mode is outside the enum (${OFF_ENUM_MODE}) was forwarded`
      + ` anyway — the relay is NOT validating this event, and the deploy-order note on`
      + ` InjectResultSchema.mode (and this file's header) is describing a mechanism that does`
      + ` not exist. Re-derive the compatibility story before shipping a web target.`;
  }
  if (back.carrying(badMarker).length !== 0) {
    return `${label}: nothing arrived under 'inject:result', but ${back.carrying(badMarker).length}`
      + ` frame(s) carrying that receipt reached the phone under another name —`
      + ` a refusal that mirrors the payload anyway is not a refusal`;
  }

  // ── ③ the door is still open right after ────────────────────────────────────
  //
  // Without this, an implementation that had simply STOPPED forwarding receipts
  // (a broken socket, a dropped room) would make ② green for the wrong reason —
  // the same trap G20 ③ names for "only forwards failure receipts".
  const secondMarker = `G23-${stamp}-dom2`;
  const again = once(mobile, 'inject:result', 3000);
  pc.emit('inject:result', {
    ok: true, mode: 'dom', request_id: `req-${secondMarker}`, entry_id: `row-${secondMarker}`,
  });
  let second;
  try {
    second = await again;
  } catch (e) {
    return `${label}: after the refused frame, a LEGAL dom receipt no longer gets through`
      + ` (${e.message}) — ② proved nothing; the channel itself is down`;
  }
  if (second?.mode !== 'dom' || second?.request_id !== `req-${secondMarker}`) {
    return `${label}: the follow-up receipt came back wrong: ${JSON.stringify(second)}`;
  }

  back.stop();
  return null;
}

export const G23 = {
  id: 'G23',
  name: "🔴 inject:result mode:'dom' survives the relay verbatim; an off-enum mode is refused (LAN + saas legs)",
  requires: [
    SERVER_DIST,
    // The enum itself. Delete it and this path is asserting a contract nobody owns.
    path.join(ROOT, 'packages/protocol/src/protocol-schemas-inject.ts'),
    // The phone-side reader whose openness this path's story depends on — the
    // measurement that overturned the addendum's premise lives in its doc comment.
    path.join(ROOT, 'apps/mobile/lib/src/signaling/inbound_payloads.dart'),
    // The phone leg, cited rather than re-enacted (runner's SIM-MOBILE rule):
    // what this phone DOES with a dom receipt is asserted there, on the real store.
    path.join(ROOT, 'apps/mobile/test/inject_result_dom_mode_test.dart'),
  ],
  async fn(url) {
    const sockets = [];
    let saas = null;
    try {
      // ── LAN leg (the standalone sidecar the desktop ships) = same-shape control ──
      const lan = await registerAndPair(url);
      sockets.push(lan.pc, lan.mobile);
      const lanFail = await legAssertions('lan', lan.pc, lan.mobile);
      if (lanFail) return FAIL(lanFail);

      // ── saas leg (the ingress a web target will actually arrive on) ────────────
      try {
        saas = await startSaasServer();
      } catch (e) {
        return FAIL(`cloud server failed to start: ${e.message}`);
      }
      const cloudUrl = `http://127.0.0.1:${saas.port}`;
      const jwt = await saasJwt(cloudUrl);
      const pc = await connect(cloudUrl, { jwt });
      const reg = await ack(pc, 'pc:register', {
        device_name: 'G23 web target', client_instance_id: 'inst-g23-0123456789ab',
      });
      const mobile = await connect(cloudUrl);
      const joined = once(pc, 'pc:mobile-joined');
      // 0.2.66 — a saas pairing NAMES its PC (a bare code is refused with
      // PAIR_PCID_REQUIRED); inert on standalone. Same spelling works on both,
      // which is also what the real phone sends back.
      await ack(mobile, 'mobile:pair', { short_code: reg.short_code, pcid: reg.pcid });
      await joined;
      sockets.push(pc, mobile);
      const cloudFail = await legAssertions('cloud', pc, mobile);
      if (cloudFail) {
        return FAIL(`${cloudFail}\n  ⚠️ the LAN leg was green and the saas leg was not ⇒ the`
          + ` difference is in the saas ingress (JWT admission / PCID pairing), not in the enum.`);
      }

      return PASS(
        'both legs ran the same three assertions: '
        + "① ok:true / mode:'dom' / request_id / focus_evidence:'editable' crossed the relay "
        + 'verbatim (frame probe saw exactly 1 frame ⇒ not blind); '
        + `② a receipt whose mode is outside the enum ('${OFF_ENUM_MODE}') reached the phone `
        + 'NEITHER under inject:result NOR under any other event name — MEASURED PROOF that the '
        + 'relay VALIDATES this frame rather than forwarding it transparently, which is what '
        + 'makes the deploy order hard (relay first, web target second: an old relay refuses the '
        + 'whole receipt, and the phone keeps a landed utterance at 「待投递」); '
        + '③ a legal dom receipt still gets through right afterwards, so ② is a refusal and not '
        + 'a dead channel. '
        + '🔴 NOT covered here: that a real page emits this frame (its emitter is card S2-06, in '
        + 'the FLOWMIC-WEB repository — this repo has no producer), and what the phone does with '
        + 'it (apps/mobile/test/inject_result_dom_mode_test.dart).',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

// verify/golden/g33-control-key-receipt.mjs
//
// G33 — 🔴 `control:key-result`: a key the far end could not apply comes BACK to
// the phone that pressed it, carrying the id of that press.
//
// Card MP-14. Owner approved the event on 2026-09-11 (ruling 8 of
// docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §11).
//
// ── WHAT WAS WRONG, AND WHY NOTHING COULD SEE IT ────────────────────────────
//
// `control:key` is one-way by construction. The far end — a desktop PC, or a web
// target page, which is the same `pc` role on this wire — takes the keypress and
// answers nothing. So when it CANNOT honour one (a page asked for Tab or Undo, a
// desktop handed a kind outside its six-key map, nothing focused to press into),
// the only refusal available was silence, and the phone went on saying the key
// was sent. It WAS sent. Nobody ever said it did nothing.
//
// The protocol's own comment on `ControlKeySchema.device_label` stated this as
// settled: 「this event has NO RESULT FRAME, so a mismatched address could only
// be refused SILENTLY, which is the red line itself」. This path is what makes
// the replacement sentence a measurement.
//
// ── WHAT THIS PROVES, AND WHAT IT DOES NOT (both, or the PASS line is lying) ──
//
//   · proved — THE WIRE. The relay routes the receipt from the far end to the
//     phone that pressed the key, with `request_id` intact; `ok:true` crosses
//     too; a phone cannot author one about itself.
//   · NOT proved — that a real desktop or a real page EMITS it. The desktop's
//     emitter is pinned by its own Rust test
//     (`apps/desktop/src-tauri/src/socket/control_row_tests.rs`); the page's
//     lives in the FLOWMIC-WEB repository. Per the runner's SIM-MOBILE rule the
//     "PC" and the "phone" here are bare socket.io clients.
//   · NOT proved — what the phone DRAWS. That is
//     `apps/mobile/test/control_key_refusal_notice_test.dart`, required below so
//     the evidence cannot quietly disappear.
//
// ── 🔴 WHY THE ORDER IS RELAY FIRST, THEN THE CLIENTS ────────────────────────
//
// Assertion ③ is the one that makes that sentence testable rather than
// believed: an event name the relay does not know is refused by the
// unknown-event gate and reaches nobody. A relay older than this round
// therefore swallows every receipt — which is today's product exactly (silence),
// so nothing REGRESSES, but a client shipped ahead of the relay would be
// advertising a receipt that cannot arrive. ③ measures the gate on a name that
// is not on the whitelist; ① and ④ measure that the real one is.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  once, neverWithin, recordAll, registerAndPair,
  PASS, FAIL,
} from './harness.mjs';

/** A kind a web target refuses (FLOWMIC-WEB card TP-1: `notHonourableHere`) —
 *  the realistic subject of the very first receipt this product will ever send. */
const REFUSED_KIND = 'tab';

export const G33 = {
  id: 'G33',
  name: '🔴 control:key-result: a key the far end could not apply comes back to the phone that pressed it',
  requires: [
    SERVER_DIST,
    // The schema. Delete it and this path asserts a contract nobody owns.
    path.join(ROOT, 'packages/protocol/src/protocol-schemas-inject.ts'),
    // The routing leg under test.
    path.join(ROOT, 'apps/server-core/src/socket/handlers/relay.handler.ts'),
    // The phone's face, cited rather than re-enacted (SIM-MOBILE rule).
    path.join(ROOT, 'apps/mobile/test/control_key_refusal_notice_test.dart'),
  ],
  async fn(url) {
    const sockets = [];
    try {
      const { pc, mobile } = await registerAndPair(url);
      sockets.push(pc, mobile);
      const stamp = `G33-${Date.now()}`;
      const back = recordAll(mobile);

      // ── ① the refusal crosses, verbatim, with its correlation echo ─────────
      //
      // Every key here answers a question the phone will ask:
      //   · `ok:false` — the whole card. Without it the press reads as applied.
      //   · `reason` — WHICH of the three, because each leads to a different
      //     move (try another destination / click into a box / try again).
      //   · `kind` — what the notice names. A receipt whose key the phone cannot
      //     name is a receipt it cannot render.
      //   · `request_id` — WHICH press. Two taps of the same key half a second
      //     apart are otherwise indistinguishable.
      const pressId = `k-${stamp}-1`;
      const pressed = once(pc, 'control:key', 3000);
      mobile.emit('control:key', { kind: REFUSED_KIND, request_id: pressId });
      let press;
      try {
        press = await pressed;
      } catch (e) {
        return FAIL(`the press never reached the far end (${e.message}) — nothing below can mean anything`);
      }
      if (press?.request_id !== pressId) {
        return FAIL(
          `the press lost its request_id in flight (got ${JSON.stringify(press?.request_id)}) — the`
          + ` far end cannot echo what it never received, so every receipt would fall back to the`
          + ` weaker kind+recency match. This is the additive-optional strip shape (duration_ms).`,
        );
      }

      const arrived = once(mobile, 'control:key-result', 3000);
      pc.emit('control:key-result', {
        request_id: pressId, kind: REFUSED_KIND, ok: false, reason: 'unsupported_here',
      });
      let res;
      try {
        res = await arrived;
      } catch (e) {
        return FAIL(
          `the receipt never came back (${e.message}). With the event on the whitelist this is the`
          + ` relay refusing to route a frame it should forward — the phone would keep saying the`
          + ` key was sent for a key that did nothing, which is the state this card exists to end.`,
        );
      }
      if (res?.ok !== false || res?.reason !== 'unsupported_here' || res?.kind !== REFUSED_KIND) {
        return FAIL(`the receipt was rewritten in flight: ${JSON.stringify(res)}`);
      }
      if (res?.request_id !== pressId) {
        return FAIL(
          `the receipt's correlation echo is wrong (${JSON.stringify(res?.request_id)}) — this`
          + ` receipt would settle nobody's press`,
        );
      }
      // Positive control: the frame-level probe is not blind, so ③'s silence
      // means something.
      if (back.carrying(pressId).length < 1) {
        return FAIL(
          `the frame probe saw ${back.carrying(pressId).length} frames carrying the press id`
          + ` (expected at least 1) — the probe is blind, so nothing below counts`,
        );
      }

      // ── ② the SUCCESS face crosses too ─────────────────────────────────────
      //
      // 🔴 Not decoration. A receipt that only ever appears on failure cannot be
      // told apart from a relay that dropped it: 「no news」 would mean both 「it
      // worked」 and 「nobody answered」, which is two facts wearing one face —
      // this repo's #1 shape. The clients draw nothing for it; the WIRE must
      // still carry it.
      const okId = `k-${stamp}-2`;
      const okBack = once(mobile, 'control:key-result', 3000);
      pc.emit('control:key-result', { request_id: okId, kind: 'enter', ok: true });
      let okRes;
      try {
        okRes = await okBack;
      } catch (e) {
        return FAIL(
          `an ok:true receipt did not cross (${e.message}) — the relay is forwarding only failures,`
          + ` so silence is once again ambiguous between success and a dropped frame`,
        );
      }
      if (okRes?.ok !== true || okRes?.request_id !== okId) {
        return FAIL(`the success receipt came back wrong: ${JSON.stringify(okRes)}`);
      }

      // ── ③ an event name OUTSIDE the whitelist reaches nobody ───────────────
      //
      // This is the deploy-order measurement. `control:key-refused` is exactly
      // the kind of plausible near-miss an older or a forked relay would be
      // asked to route, and the unknown-event gate is what stops it. It is
      // asserted on the FRAMES as well as the name: a relay that refused the
      // name and mirrored the payload under another one would satisfy a narrow
      // check and break the rule.
      const ghostMarker = `${stamp}-ghost`;
      pc.emit('control:key-refused', { request_id: `k-${ghostMarker}`, kind: 'undo', ok: false });
      const silent = await neverWithin(mobile, 'control:key-refused', 800);
      if (!silent) {
        return FAIL(
          `an event name that is NOT on the whitelist ('control:key-refused') was routed anyway —`
          + ` the unknown-event gate is not doing what the deploy-order note claims. Re-derive the`
          + ` compatibility story before shipping any client that listens for this receipt.`,
        );
      }
      if (back.carrying(ghostMarker).length !== 0) {
        return FAIL(
          `nothing arrived under 'control:key-refused', but ${back.carrying(ghostMarker).length}`
          + ` frame(s) carrying it reached the phone under another name — a refusal that mirrors`
          + ` the payload anyway is not a refusal`,
        );
      }

      // ── ④ the door is still open right after ───────────────────────────────
      //
      // Without this, a relay that had simply STOPPED forwarding receipts would
      // make ③ green for the wrong reason — the same trap G23 ③ names.
      const lastId = `k-${stamp}-3`;
      const again = once(mobile, 'control:key-result', 3000);
      pc.emit('control:key-result', { request_id: lastId, kind: 'undo', ok: false, reason: 'no_target' });
      let last;
      try {
        last = await again;
      } catch (e) {
        return FAIL(
          `after the unknown name, a LEGAL receipt no longer gets through (${e.message}) —`
          + ` ③ proved nothing; the channel itself is down`,
        );
      }
      if (last?.request_id !== lastId || last?.reason !== 'no_target') {
        return FAIL(`the follow-up receipt came back wrong: ${JSON.stringify(last)}`);
      }

      back.stop();
      return PASS(
        '① a press carrying request_id reached the far end with the id intact, and the far end\'s '
        + `refusal (ok:false, reason:'unsupported_here', kind:'${REFUSED_KIND}') came back to the `
        + 'phone verbatim with that same id (frame probe non-empty ⇒ not blind); '
        + '② an ok:true receipt crosses too, so silence is not the success face; '
        + "③ a NEAR-MISS event name that is not on the whitelist ('control:key-refused') reached "
        + 'the phone NEITHER under its own name NOR any other — MEASURED PROOF that the '
        + 'unknown-event gate is what makes the deploy order hard (RELAY FIRST, THEN THE CLIENTS: '
        + 'an older relay swallows every receipt, which is silence, which is the product this card '
        + 'is removing); '
        + '④ a legal receipt still crosses right afterwards, so ③ is a refusal and not a dead '
        + 'channel. '
        + '🔴 NOT covered here: that a real desktop or a real web target EMITS this frame (their '
        + 'tests / the FLOWMIC-WEB repository), nor what the phone DRAWS for it '
        + '(apps/mobile/test/control_key_refusal_notice_test.dart).',
      );
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
    }
  },
};

// G28 — card R-2: how fast the relay frees a room when a web client parks
// (closes its socket on purpose) versus when its connection is merely
// destroyed (a dropped TCP, no close frame) — REAL server, not a unit test.
//
// SPEC-REF:
//   docs/strategy/2026-09-10-web-room-release-and-unsigned-limit-design.md
//     §1 (mechanism) + §1.3 (reverse controls, numbered ①-④ below)
//   apps/server-core/src/socket/handlers/disconnect.handler.ts (the mobile
//     branch: GA-04 grace vs GA-26 `isDeliberateLeave` collapse)
//   apps/server-core/src/engine/audio-registry.ts `beginGrace` /
//     `expireGraceNow` / `mobileLeftOnGraceExpiry`
//   apps/server-core/src/socket/handlers/mobile-room-admission.ts
//     `liveContender` (second-phone admission gate)
//   apps/server-core/src/socket/handlers/mobile-reconnect.ts (the
//     ReleaseSuppression / liveContender ordering a returning A hits)
//   apps/server-core/src/room/release-suppression.ts (BUSY_SUPPRESS_MS,
//     RELEASE_SUPPRESS_MS — read from source, never copied as a literal)
//
// R-1 (the sibling lane touching metering/admission for §2's unsigned-web
// trial limit) is OUT OF SCOPE here — this path deliberately never calls,
// asserts on, or depends on anything §2 introduces. R-2 itself is "zero
// source changes expected" per the design's own table: this golden exists to
// PIN existing behaviour, not to drive new implementation work.
//
// ── WHAT THIS PATH FOUND, MEASURED, NOT ASSUMED ────────────────────────────
//
// The design's §1.3④ real-device wording ("the room is freed only after the
// ping timeout + grace") reads as if a SECOND phone's admission is gated by
// the same clock as the PC's `pc:mobile-left` notice. Measured on this
// harness (`ws.terminate()` on the underlying socket — a real TCP-level
// close the server's kernel notices in well under a second on loopback) the
// two are NOT the same clock:
//   · `pc:mobile-left` (GA-04 grace, `AUDIO_DEFAULTS.mobile_drop_grace_ms`)
//     IS delayed — collapsed to <1s only on a DELIBERATE leave
//     (`isDeliberateLeave`, reason `'client namespace disconnect'`); a
//     `'transport close'` reason runs the full grace window before the PC is
//     told anything.
//   · admission of a DIFFERENT device_uid (`liveContender`,
//     mobile-room-admission.ts) is NOT gated by that grace window at all — it
//     reads the live socket's OWN `.connected` flag, which the destroyed
//     socket already reports `false` the instant the server's transport
//     layer notices the TCP close, seconds before GA-04's grace timer (armed
//     independently, inside the SAME `disconnect` handler) has run its
//     course. A second web client can therefore occupy the room within
//     ~1s of a torn TCP connection — the SAME speed as a deliberate park —
//     even though the PC's own capsule will not hear `pc:mobile-left` for
//     another ~29s.
// Both facts are measured and asserted below (see the `[G28 finding]` log
// line at PART 3) rather than forced to fit the reading above — an assertion
// that "B stays refused until ~50s" would be false against the CURRENT,
// correct-per-its-own-contract admission code, and a golden that asserts a
// falsehood to make the file agree with a prose reading is the exact defect
// CLAUDE.md's "measure your ruler" entry exists to catch.
//
// ── WHY THIS IS A GOLDEN AND NOT A UNIT TEST ───────────────────────────────
// `audio-grace.test.ts` proves `AudioSessionRegistry.beginGrace` /
// `expireGraceNow` in isolation, against a class, not a socket. It cannot
// prove that a REAL web-shaped socket (`client:'web'`) closing for real, over
// the real `mobile:pair` / `mobile:reconnect` wire, produces the SAME
// `pc:mobile-left` the desktop's paired-list actually listens for, nor that a
// genuinely destroyed TCP connection (not a simulated reason string) takes
// the path it claims to. A stub of any one layer proves the stub.
//
// ── WHAT IT DOES NOT NEED ──────────────────────────────────────────────────
// No STT engine, no LAN, no vendor. Never SKIPs.

import {
  SERVER_CORE, SERVER_DIST, ROOT,
  connect, ack, once, neverWithin, productDeadlineMs, PASS, FAIL,
} from './harness.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `mobile_drop_grace_ms` lives as an OBJECT PROPERTY (AUDIO_DEFAULTS), not an
// `export const` — productDeadlineMs's regex only matches the latter, so it
// gets its own tiny reader here rather than a copied literal (the exact
// defect this file's own imports exist to prevent — see harness.mjs's header
// on `connect`/`ack`/`once`).
// `once()` (harness.mjs) resolves on the FIRST frame under an event name —
// this file needs one for C specifically, and D's own deliberate leave
// (vacated a few lines below, in the SAME room) would otherwise win the race
// with C's grace-delayed one. Same shape as `once`, with a predicate.
function onceMatching(socket, event, predicate, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, handler); reject(new Error(`${event} timeout (no match within ${ms}ms)`)); }, ms);
    // eslint-disable-next-line no-shadow
    const handler = (d) => { if (predicate(d)) { clearTimeout(t); socket.off(event, handler); resolve(d); } };
    socket.on(event, handler);
  });
}

function mobileDropGraceMs() {
  const abs = path.join(ROOT, 'packages', 'protocol', 'src', 'constants.ts');
  const src = readFileSync(abs, 'utf8');
  const m = /mobile_drop_grace_ms:\s*([0-9_]+)/.exec(src);
  if (!m) throw new Error('harness: mobile_drop_grace_ms not found in packages/protocol/src/constants.ts — the golden bound has lost its source of truth');
  return Number(m[1].replace(/_/g, ''));
}

export const G28 = {
  id: 'G28',
  name: 'web room release (R-2: a deliberate park frees the room in <1s and never suppresses A\'s own return; a destroyed TCP frees pc:mobile-left only after the GA-04 grace window, though a NEW device is admitted immediately — measured, see [G28 finding])',
  requires: [SERVER_DIST],
  async fn(url) {
    const sockets = [];
    const track = (s) => { sockets.push(s); return s; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vacate = async (s) => { s.disconnect(); await sleep(300); };

    // Config read from source, never copied as a literal (harness.mjs's own
    // rule for `productDeadlineMs` — a copy nobody updates is the one running
    // when it matters).
    const BUSY_SUPPRESS_MS = productDeadlineMs('src/room/release-suppression.ts', 'BUSY_SUPPRESS_MS');
    const GRACE_MS = mobileDropGraceMs();
    // Slack on top of a measured mechanism, same shape as harness.mjs's own
    // TERMINAL_FRAME_GRACE_MS — socket delivery + timer scheduling, nothing
    // more. Measured overshoot on this machine (ws.terminate() → pc:mobile-left)
    // was ~10ms; kept generous for a loaded CI box.
    const GRACE_SLACK_MS = 5_000;
    const BUSY_SLACK_MS = 500;

    try {
      // ════════════════════════ PART 1 — PARK (clean close) ═══════════════
      const pc = track(await connect(url));
      const reg = await ack(pc, 'pc:register', {
        device_name: 'Golden PC G28-1', client_instance_id: 'inst-g28a-pc-012345678',
      });
      if (!reg.short_code) return FAIL(`pc:register produced no short_code: ${JSON.stringify(reg)}`);

      const a = track(await connect(url));
      const joinedA = once(pc, 'pc:mobile-joined', 3000);
      const pairA = await ack(a, 'mobile:pair', {
        short_code: reg.short_code, device_uid: 'wb-aaaa000000000001', mobile_name: 'Web-park1', client: 'web', client_version: 'g28',
      });
      if (pairA.error) return FAIL(`A's pairing was refused: ${pairA.error}`);
      await joinedA;
      if (!pairA.pairing_id || !pairA.mobile_token) return FAIL(`A's pairing produced no usable pairing: ${JSON.stringify(pairA)}`);

      // A parks: a clean client-initiated close (`socket.disconnect()`)
      // reaches the server as `'client namespace disconnect'`
      // (isDeliberateLeave, GA-26/GA-04) — collapses the grace window at
      // once instead of running the full mobile_drop_grace_ms.
      const tPark0 = Date.now();
      const leftOnPark = once(pc, 'pc:mobile-left', 2000);
      a.disconnect();
      const leftEvA = await leftOnPark;
      const parkMs = Date.now() - tPark0;
      if (leftEvA.mobile_id !== pairA.pairing_id) return FAIL(`pc:mobile-left after park named the wrong mobile_id: ${JSON.stringify(leftEvA)}`);
      if (parkMs >= 1000) return FAIL(`a clean close ('client namespace disconnect') took ${parkMs}ms to reach the PC as pc:mobile-left — design §1.3① requires < 1s`);

      // A DIFFERENT web client (B) may now occupy the freed room.
      const b = track(await connect(url));
      const codeForB = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const joinedB = once(pc, 'pc:mobile-joined', 3000);
      const pairB = await ack(b, 'mobile:pair', {
        short_code: codeForB, device_uid: 'wb-bbbb000000000002', mobile_name: 'Web-park2', client: 'web', client_version: 'g28',
      });
      if (pairB.error) return FAIL(`B was refused entry to a room A had just parked out of: ${pairB.error} (expected admission, not PC_BUSY)`);
      await joinedB;

      // ════════ PART 2 — A reconnects WHILE B is live, then B leaves ═══════
      // A's OLD socket is gone (park closed it) — a reconnect is always a
      // FRESH socket carrying the stored token, same shape as G27's `s1b`.
      const a2 = track(await connect(url));
      const reconnectWhileBusy = await ack(a2, 'mobile:reconnect', { token: pairA.mobile_token, device_uid: 'wb-aaaa000000000001' });
      if (reconnectWhileBusy.error !== 'PC_BUSY') {
        return FAIL(`A reconnecting while B occupies the room answered ${JSON.stringify(reconnectWhileBusy)} — expected the honest PC_BUSY refusal (design §1.2d: park never arms ReleaseSuppression, so this must be liveContender's PC_BUSY, not a takeover and not PAIR_RELEASED)`);
      }
      if (typeof reconnectWhileBusy.retry_after_ms !== 'number' || reconnectWhileBusy.retry_after_ms <= 0) {
        return FAIL(`PC_BUSY while B is live carried no usable retry_after_ms: ${JSON.stringify(reconnectWhileBusy)}`);
      }

      // B leaves (clean close, same as A's park above).
      await vacate(b);

      // A's own refusal above stamped an 8s BUSY_SUPPRESS_MS entry on A's OWN
      // pairing_id (mobile-reconnect.ts: `deps.suppression?.suppress(mobile.id,
      // 'busy')` — the requester, not the incumbent, is the key). Wait it out
      // so the next reconnect is judged on room occupancy, not on A's own
      // recent refusal.
      await sleep(BUSY_SUPPRESS_MS + BUSY_SLACK_MS);

      const reconnectAfterBLeft = await ack(a2, 'mobile:reconnect', { token: pairA.mobile_token, device_uid: 'wb-aaaa000000000001' });
      if (reconnectAfterBLeft.error) {
        return FAIL(`A's reconnect after B left answered an error: ${JSON.stringify(reconnectAfterBLeft)} (expected admission with no error — and specifically NOT PAIR_RELEASED, since a park never arms ReleaseSuppression per design §1.2d)`);
      }
      if (reconnectAfterBLeft.error === 'PAIR_RELEASED') return FAIL('unreachable guard tripped: PAIR_RELEASED literal check');
      await sleep(150);

      // SAME pairing row reused, not a new one (G27's own row-count shape).
      const rowsAfterReconnect = (await ack(pc, 'pc:list-mobiles', {})).mobiles;
      const rowsForA = rowsAfterReconnect.filter((m) => m.device_uid === 'wb-aaaa000000000001');
      if (rowsForA.length !== 1) return FAIL(`after A's reconnect, pc:list-mobiles shows ${rowsForA.length} row(s) for A's device_uid (expected exactly 1 — no new row): ${JSON.stringify(rowsForA)}`);
      if (rowsForA[0].pairing_id !== pairA.pairing_id) return FAIL(`A's reconnect landed on a DIFFERENT pairing_id (${rowsForA[0].pairing_id} vs original ${pairA.pairing_id}) — a new row, not a reused one`);
      await vacate(a2);

      // ══════════ PART 3 — POSITIVE CONTROL: a destroyed TCP, not a close ══
      const pc2 = track(await connect(url));
      const reg2 = await ack(pc2, 'pc:register', {
        device_name: 'Golden PC G28-2', client_instance_id: 'inst-g28b-pc-012345678',
      });
      if (!reg2.short_code) return FAIL(`second pc:register produced no short_code: ${JSON.stringify(reg2)}`);

      const c = track(await connect(url));
      const joinedC = once(pc2, 'pc:mobile-joined', 3000);
      const pairC = await ack(c, 'mobile:pair', {
        short_code: reg2.short_code, device_uid: 'wb-cccc000000000003', mobile_name: 'Web-drop1', client: 'web', client_version: 'g28',
      });
      if (pairC.error) return FAIL(`C's pairing was refused: ${pairC.error}`);
      await joinedC;

      const tDrop0 = Date.now();
      const leftOnDrop = onceMatching(pc2, 'pc:mobile-left', (ev) => ev.mobile_id === pairC.pairing_id, GRACE_MS + GRACE_SLACK_MS);
      // "Destroying the underlying socket" per the card, not a graceful
      // close: `ws.terminate()` drops the raw TCP connection with no
      // Socket.IO disconnect packet and no WebSocket close frame — the
      // server only learns via the transport layer, never via
      // `isDeliberateLeave`'s reason string.
      c.io.engine.transport.ws.terminate();

      // ── REVERSE CONTROL ① — the PARK-leg assertion, applied here, must be
      // FALSE: `pc:mobile-left` must NOT arrive within 1s of a destroyed
      // socket (only a deliberate close collapses the grace window).
      const freedWithinOneSecond = !(await neverWithin(pc2, 'pc:mobile-left', 1000));
      if (freedWithinOneSecond) {
        return FAIL('REVERSE CONTROL FAILED TO GO RED: pc:mobile-left arrived within 1s of a destroyed socket — either the grace-collapse guard now fires on a non-deliberate close (a regression this path exists to catch) or this leg failed to actually destroy the connection');
      }

      // ── measured finding (see file header) — a DIFFERENT device_uid is
      // admitted almost immediately after the destroy, well before GRACE_MS:
      // `liveContender` reads the dead socket's own `.connected` flag, which
      // the transport layer already reports false, independent of the GA-04
      // grace timer this same `disconnect` event separately armed.
      const d = track(await connect(url));
      const codeForD = (await ack(pc2, 'pc:refresh-code', {})).short_code;
      const pairD = await ack(d, 'mobile:pair', {
        short_code: codeForD, device_uid: 'wb-dddd000000000004', mobile_name: 'Web-drop2', client: 'web', client_version: 'g28',
      });
      const dAdmittedAt = Date.now() - tDrop0;
      // eslint-disable-next-line no-console
      console.log(`[G28 finding] a second device_uid was ${pairD.error ? `refused (${pairD.error})` : 'ADMITTED'} at +${dAdmittedAt}ms after a destroyed (not closed) socket — liveContender gates on socket.connected, not on the GA-04 grace window pc:mobile-left waits for`);
      if (pairD.error && pairD.error !== 'PC_BUSY') return FAIL(`D's pairing failed for a reason other than room contention: ${pairD.error}`);
      if (dAdmittedAt >= GRACE_MS) return FAIL(`a second device_uid was still refused ${GRACE_MS}ms after the destroy (${JSON.stringify(pairD)}) — this path's own measurement (see header) says admission should not depend on the grace window at all; if this is now red, admission gating has changed and needs re-measuring, not silencing`);
      await vacate(d);

      // `pc:mobile-left` for C must land by the pinned, source-read ceiling
      // — GRACE_MS from the destroy, plus scheduling slack.
      const leftEvC = await leftOnDrop;
      const dropMs = Date.now() - tDrop0;
      if (leftEvC.mobile_id !== pairC.pairing_id) return FAIL(`pc:mobile-left after the destroyed socket named the wrong mobile_id: ${JSON.stringify(leftEvC)}`);
      if (dropMs < GRACE_MS) return FAIL(`pc:mobile-left arrived at +${dropMs}ms, BEFORE the pinned GA-04 grace window (${GRACE_MS}ms) — a non-deliberate close collapsed the grace window early, which is the exact defect GA-26's isDeliberateLeave guard exists to prevent`);

      return PASS(`web room release: park → pc:mobile-left in ${parkMs}ms (<1s) and a different web client admitted; A reconnecting while B is live got the honest PC_BUSY+retry_after_ms (not a takeover, not PAIR_RELEASED); B leaving readmitted A onto the SAME pairing row (not PAIR_RELEASED); reverse control confirmed a destroyed socket does NOT free pc:mobile-left within 1s; pc:mobile-left after a destroyed socket arrived at +${dropMs}ms (>= pinned GRACE_MS=${GRACE_MS}ms); a NEW device_uid was admitted at +${dAdmittedAt}ms regardless (measured, see [G28 finding] — admission is gated by socket.connected, not by the grace window)`);
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
    }
  },
};

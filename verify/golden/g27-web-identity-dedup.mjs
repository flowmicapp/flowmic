// G27 — card ID-3: a web target's `device_uid` is what a re-open of the SAME
// browser tab looks like to the relay — REAL server, not a unit test.
//
// SPEC-REF:
//   docs/strategy/2026-09-10-web-client-identity-and-pair-link-design.md
//     §2 (identity) + §2.6 (revoke/unpair semantics) + §4 (reverse controls #1/#5)
//   apps/server-core/src/room/registry.ts `pairMobile` (uid-first reuse key,
//     `claimedUid` around line 597) + `revokeMobile`
//   apps/server-core/src/socket/handlers/pc.handler.ts `pc:release-mobile`
//   apps/server-core/src/socket/handlers/mobile-room-admission.ts `liveContender`
//     — ONE live phone per room regardless of `device_uid`, which is WHY this
//     case disconnects each occupant before the next one pairs in (a second
//     LIVE socket under a DIFFERENT `pairing_id` is refused `PC_BUSY`, and
//     that refusal is orthogonal to everything this card is about).
//
// ── WHY THIS IS A GOLDEN AND NOT A UNIT TEST ───────────────────────────────
//
// `registry.test.ts` proves `pairMobile` reuses a row by `device_uid` given a
// bare input object. It cannot prove the thing ID-1 (flowmic-web) is actually
// betting on: that a BROWSER TAB that closes its socket and opens a fresh one
// — the only thing a web client can ever do, it has no process to keep alive
// — lands on the SAME pairing row twice in a row, over the real wire format
// (`mobile:pair` with `client:'web'`), read back through the SAME projection
// the desktop's 「已配对手机」 table reads (`pc:list-mobiles`, G12's own eight
// fields). Three separate things have to agree for that: the schema has to
// carry `device_uid` on the short-code arm, `pairMobile`'s reuse key has to
// prefer it over the name fallback, and the projection has to still show one
// row after two independent sockets each ran `mobile:pair`. A stub of any one
// of those proves the stub.
//
// The design's own root cause (§1) is the mirror image of what this asserts:
// a web client that RE-MINTS its uid on every open produces a new row every
// time (four `Phone-xxxx` ghosts in production, one per stale reload). §4's
// reverse control #1 is exactly that defect — reproduced below and asserted
// AS the positive control, then the fixed shape (stable uid) is asserted to
// collapse to one row.
//
// ── WHAT IT DOES NOT NEED ──────────────────────────────────────────────────
// No STT engine, no LAN, no vendor, no ID-1/ID-2 code (flowmic-web and the
// desktop's Rust/Vue layers are OUT OF TREE here) — everything below is a
// simulated web client speaking the wire the design document specifies
// (§0.1, §2.5). It therefore never SKIPs.

import {
  SERVER_DIST,
  connect, ack, once, PASS, FAIL,
} from './harness.mjs';

export const G27 = {
  id: 'G27',
  name: 'web identity dedup (ID-3: same device_uid ⇒ one pc:list-mobiles row across reconnect/re-pair/unpair-then-repair; reverse control on a re-minted uid)',
  requires: [SERVER_DIST],
  async fn(url) {
    const sockets = [];
    const track = (s) => { sockets.push(s); return s; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const listRows = async (pc) => {
      const res = await ack(pc, 'pc:list-mobiles', {});
      if (!Array.isArray(res.mobiles)) throw new Error(`pc:list-mobiles returned no array: ${JSON.stringify(res)}`);
      return res.mobiles;
    };
    // Only one LIVE phone may occupy a room at a time regardless of
    // device_uid (liveContender, mobile-room-admission.ts) — the product's own
    // 「另一台手机占用」 rule, and orthogonal to what this card tests. Every
    // occupant below is disconnected before the next one pairs in.
    const vacate = async (s) => { s.disconnect(); await sleep(300); };
    // The shape flowmic-web's `identity.ts` mints (design §2.1: `wb-<32hex>`,
    // here shortened to 16 hex — DeviceUid's regex accepts 16..48).
    const WEB_UID = 'wb-cafe0123456789ab';
    const WEB_NAME = `Web-${WEB_UID.slice(-4)}`;

    try {
      // ── set up a PC to pair against, same as G12 ────────────────────────
      const pc = track(await connect(url));
      const reg = await ack(pc, 'pc:register', {
        device_name: 'Golden PC G27', client_instance_id: 'inst-g27-pc-0123456789',
      });
      if (!reg.short_code) return FAIL(`pc:register produced no short_code: ${JSON.stringify(reg)}`);

      // ═══ REVERSE CONTROL (design §4 #1) — a uid re-minted per open ═══════
      // This is TODAY'S BUG, reproduced on purpose: two sockets, each with its
      // OWN freshly-minted uid (nothing shared — exactly what identity.ts did
      // before ID-1), pairing with the SAME short code in sequence. Card ID-1
      // is a SIBLING lane (localStorage persistence) that this golden does not
      // depend on and does not exercise; this control instead proves the
      // relay-side symptom the design blames on the absence of ID-1, using the
      // relay exactly as it stands today.
      const ghost1 = track(await connect(url));
      const joinedG1 = once(pc, 'pc:mobile-joined', 3000);
      const pairGhost1 = await ack(ghost1, 'mobile:pair', {
        short_code: reg.short_code, device_uid: 'wb-ghost0000000001', client: 'web', client_version: 'g27',
      });
      if (pairGhost1.error) return FAIL(`reverse-control pairing #1 was refused: ${pairGhost1.error}`);
      await joinedG1;
      await vacate(ghost1); // must leave BEFORE the next pair — a different device_uid is a different pairing_id, and liveContender only excludes the pairing being (re)admitted, not "any web client".
      const codeAfterGhost1 = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const ghost2 = track(await connect(url));
      const joinedG2 = once(pc, 'pc:mobile-joined', 3000);
      const pairGhost2 = await ack(ghost2, 'mobile:pair', {
        short_code: codeAfterGhost1, device_uid: 'wb-ghost0000000002', client: 'web', client_version: 'g27',
      });
      if (pairGhost2.error) return FAIL(`reverse-control pairing #2 was refused: ${pairGhost2.error}`);
      await joinedG2;
      const rowsAfterGhosts = await listRows(pc);
      const ghostRows = rowsAfterGhosts.filter((m) => m.pairing_id === pairGhost1.pairing_id || m.pairing_id === pairGhost2.pairing_id);
      // eslint-disable-next-line no-console
      console.log(`[G27 reverse control] a per-open uid produced ${ghostRows.length} row(s) for two opens of "the same" web client (rows: ${JSON.stringify(ghostRows.map((r) => ({ id: r.pairing_id, uid_tail: r.pairing_id.slice(-4) })))})`);
      if (ghostRows.length < 2) {
        return FAIL(`REVERSE CONTROL DID NOT REPRODUCE THE DEFECT: two web opens with DIFFERENT device_uid collapsed to ${ghostRows.length} row(s) — the registry's reuse key no longer keys on device_uid the way §1 of the design describes, so the fix below is not proving what it claims to`);
      }
      await vacate(ghost2);

      // ═══ THE CLAIM: a STABLE uid across independent sockets ══════════════

      // 1. first pair — mints the row.
      const s1 = track(await connect(url));
      const code2 = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const joined1 = once(pc, 'pc:mobile-joined', 3000);
      const pair1 = await ack(s1, 'mobile:pair', {
        short_code: code2, device_uid: WEB_UID, mobile_name: WEB_NAME, client: 'web', client_version: 'g27',
      });
      if (pair1.error) return FAIL(`first web pairing was refused: ${pair1.error}`);
      await joined1;
      if (!pair1.pairing_id || !pair1.mobile_token) return FAIL(`first pair produced no pairing: ${JSON.stringify(pair1)}`);

      let rows = await listRows(pc);
      let mine = rows.find((m) => m.pairing_id === pair1.pairing_id);
      if (!mine) return FAIL(`the just-paired web client is not listed: ${JSON.stringify(rows)}`);
      if (mine.client !== 'web') return FAIL(`pc:list-mobiles projected client=${JSON.stringify(mine.client)}, not 'web'`);
      if (mine.mobile_name !== WEB_NAME) return FAIL(`pc:list-mobiles projected mobile_name=${JSON.stringify(mine.mobile_name)}, not ${JSON.stringify(WEB_NAME)}`);
      if (mine.device_uid !== WEB_UID) return FAIL(`pc:list-mobiles projected device_uid=${JSON.stringify(mine.device_uid)}, not ${JSON.stringify(WEB_UID)}`);

      // 2. reconnect on a FRESH socket with the SAME uid, via mobile:reconnect
      //    and the stored token — this is a page reload, not a re-pair. The
      //    OLD socket is left open on purpose here: reconnecting as the SAME
      //    pairing_id is excluded from liveContender by construction
      //    (mobile-room-admission.ts), so a lingering old tab must NOT block it.
      const s1b = track(await connect(url));
      const rc = await ack(s1b, 'mobile:reconnect', { token: pair1.mobile_token, device_uid: WEB_UID });
      if (rc.error) return FAIL(`mobile:reconnect with the same uid and its stored token was refused: ${rc.error}`);
      await sleep(150);
      rows = await listRows(pc);
      const oneRowAfterReconnect = rows.filter((m) => m.device_uid === WEB_UID);
      if (oneRowAfterReconnect.length !== 1) {
        return FAIL(`after a fresh-socket mobile:reconnect with the SAME device_uid, pc:list-mobiles shows ${oneRowAfterReconnect.length} row(s) for it (expected exactly 1): ${JSON.stringify(oneRowAfterReconnect)}`);
      }
      if (oneRowAfterReconnect[0].pairing_id !== pair1.pairing_id) return FAIL('reconnect landed on a DIFFERENT pairing_id than the original pair — this is a new row wearing the old uid, not the same row');
      await vacate(s1);
      await vacate(s1b);

      // 3. re-pair (a fresh short-code flow, e.g. the user re-scans) with a
      //    BRAND NEW socket but the SAME uid — still one row (registry.ts
      //    reuses `onThisPc.find(m => m.device_uid === claimedUid)` before it
      //    ever considers minting).
      const s1c = track(await connect(url));
      const code3 = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const pair2 = await ack(s1c, 'mobile:pair', {
        short_code: code3, device_uid: WEB_UID, mobile_name: WEB_NAME, client: 'web', client_version: 'g27',
      });
      if (pair2.error) return FAIL(`re-pairing with the same uid was refused: ${pair2.error}`);
      if (pair2.pairing_id !== pair1.pairing_id) {
        return FAIL(`re-pairing with the SAME device_uid produced a DIFFERENT pairing_id (${pair2.pairing_id} vs ${pair1.pairing_id}) — the registry minted a second row instead of reusing the first`);
      }
      rows = await listRows(pc);
      const oneRowAfterRepair = rows.filter((m) => m.device_uid === WEB_UID);
      if (oneRowAfterRepair.length !== 1) {
        return FAIL(`after re-pairing with the same uid, pc:list-mobiles shows ${oneRowAfterRepair.length} row(s) for it (expected exactly 1): ${JSON.stringify(oneRowAfterRepair)}`);
      }
      await vacate(s1c); // must leave before a DIFFERENT device_uid can occupy the room

      // 4. a SECOND web client, with a DIFFERENT uid, is a SEPARATE row — the
      //    first web client's row survives (offline), same as G12's "a
      //    pairing table, not a presence table".
      const s2 = track(await connect(url));
      const code4 = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const joined2 = once(pc, 'pc:mobile-joined', 3000);
      const pairOther = await ack(s2, 'mobile:pair', {
        short_code: code4, device_uid: 'wb-fedc9876543210ba', mobile_name: 'Web-10ba', client: 'web', client_version: 'g27',
      });
      if (pairOther.error) return FAIL(`the second web client's pairing was refused: ${pairOther.error}`);
      await joined2;
      if (pairOther.pairing_id === pair1.pairing_id) return FAIL('two DIFFERENT device_uid values collapsed onto the SAME pairing_id — that would merge two unrelated browsers');
      // Filtered to THESE TWO pairings, not the total row count: the earlier
      // reverse-control section deliberately left its own two ghost rows on
      // this same PC (rows survive a pairing table, not a presence table, per
      // G12), so the raw total here is 4, not 2 — asserting on the total would
      // make this a reverse-control-order-dependent test rather than one about
      // pair1 vs pairOther specifically.
      rows = await listRows(pc);
      const twoDistinctUidRows = rows.filter((m) => m.pairing_id === pair1.pairing_id || m.pairing_id === pairOther.pairing_id);
      if (twoDistinctUidRows.length !== 2) return FAIL(`two distinct web-uid pairings should leave exactly 2 rows for THEM, found ${twoDistinctUidRows.length}: ${JSON.stringify(rows.map((r) => r.pairing_id))}`);
      await vacate(s2); // clear the room before the revoke/re-pair leg below

      // ── 5. THE PC UNPAIRS THE WEB ROW — the same event the desktop uses ───
      // `pc:release-mobile{revoke:true, mobile_id}`. This leg is marked
      // expected-red per its own task card if a sibling lane's unpair defect
      // is still unmerged at the time this runs; see the FAIL message below,
      // which names the refusal code precisely rather than asserting success.
      const revokeRes = await ack(pc, 'pc:release-mobile', { revoke: true, mobile_id: pair1.pairing_id, reason: 'manual' });
      if (revokeRes.error || revokeRes.revoked !== 1) {
        return FAIL(`EXPECTED-RED (task/unpair-web-instances-20260910 not yet merged, or a genuine regression): pc:release-mobile{revoke:true} for the web row answered ${JSON.stringify(revokeRes)} instead of {ok:true, revoked:1, ...} — the row was not deleted, so the rest of this leg (AUTH_TOKEN_INVALID on reconnect, re-pair with the same uid producing one fresh row) cannot be evaluated. Do not touch pc.handler.ts / registry.revokeMobile from this card; that is the sibling lane's job.`);
      }
      rows = await listRows(pc);
      if (rows.some((m) => m.pairing_id === pair1.pairing_id)) return FAIL('the revoked web row is still listed after pc:release-mobile{revoke:true}');

      // the web client's stored token, on its next reconnect, is refused —
      // the exact sentence §2.6 requires the page to show.
      const s1d = track(await connect(url));
      const afterRevoke = await ack(s1d, 'mobile:reconnect', { token: pair1.mobile_token, device_uid: WEB_UID });
      if (afterRevoke.error !== 'AUTH_TOKEN_INVALID') {
        return FAIL(`EXPECTED-RED (same sibling-lane dependency as above): after revoke, mobile:reconnect with the OLD token answered ${JSON.stringify(afterRevoke)} instead of {error:'AUTH_TOKEN_INVALID'} — a revoked token that still works is the exact defect §2.6 exists to close (「不许因为没票据了就静默重新配对」does not even get a chance to matter if the old token itself is still live)`);
      }

      // ── 6. pairs AGAIN with the SAME uid and a new code — no ghost row ────
      const code5 = (await ack(pc, 'pc:refresh-code', {})).short_code;
      const joined3 = once(pc, 'pc:mobile-joined', 3000);
      const pair3 = await ack(s1d, 'mobile:pair', {
        short_code: code5, device_uid: WEB_UID, mobile_name: WEB_NAME, client: 'web', client_version: 'g27',
      });
      if (pair3.error) return FAIL(`re-pairing after revoke was refused: ${pair3.error}`);
      await joined3;
      rows = await listRows(pc);
      const rowsForUidAfterRevokeRepair = rows.filter((m) => m.device_uid === WEB_UID);
      if (rowsForUidAfterRevokeRepair.length !== 1) {
        return FAIL(`after revoke + re-pair with the same uid, ${rowsForUidAfterRevokeRepair.length} row(s) exist for it (expected exactly 1 — no ghost of the revoked row): ${JSON.stringify(rowsForUidAfterRevokeRepair)}`);
      }
      // the deleted row's id must not have come back — a fresh row was minted,
      // not a soft-deleted one resurrected.
      if (rowsForUidAfterRevokeRepair[0].pairing_id === pair1.pairing_id) {
        return FAIL('the post-revoke re-pair reused the REVOKED pairing_id — a revoked row must not be resurrectable');
      }

      return PASS(`web identity dedup: reverse control reproduced ${ghostRows.length} rows for a per-open uid; a stable uid held 1 row across reconnect/re-pair; a different uid was a separate row (2 total); revoke removed the row + refused the old token (AUTH_TOKEN_INVALID); re-pairing with the same uid afterward produced exactly 1 fresh row with no ghost`);
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
    }
  },
};

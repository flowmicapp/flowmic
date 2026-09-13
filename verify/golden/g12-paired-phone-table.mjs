// verify/golden/g12-paired-phone-table.mjs
//
// G12 — the desktop's 「已配对手机」 table over a REAL server.
//
// MOVED OUT OF run-golden.mjs VERBATIM (2026-09-08, card S2-01) for the 800-line
// `file-size` lint, the same way G13…G22 already live in their own files — NO
// BEHAVIOUR AND NO COMMENT MOVED WITH THE CODE. The case itself is unchanged
// apart from the S2-01 assertions it grew in the same round, which are marked.

import {
  SERVER_DIST,
  connect, ack, once, PASS, FAIL,
} from './harness.mjs';

export const G12 = {
  id: 'G12',
  name: 'paired-phone table (R6 T-8: pc:list-mobiles — projection has no token / ownership isolation / real online state)',
  requires: [SERVER_DIST],
  async fn(url) {
    // The PC-side pairing query the device page reads. Three properties, all
    // security- or honesty-shaped, over the REAL server:
    //   ① the ack projection carries NO token (key or value, at any depth);
    //   ② ownership isolation — PC-A cannot see a phone paired to PC-B, and a mobile-role
    //      socket cannot run the query at all;
    //   ③ `online` is REAL room presence — it flips false when the phone's
    //      socket goes away, while the pairing ROW survives (a pairing table,
    //      not a presence table).
    // SIM-MOBILE CAVEAT applies to the phone half (see the file header): this
    // proves the SERVER + PC halves only.
    const sockets = [];
    const track = (s) => { sockets.push(s); return s; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tokenKeys = (v, path = '$') => {
      const hits = [];
      if (Array.isArray(v)) return v.flatMap((x, i) => tokenKeys(x, `${path}[${i}]`));
      if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (/token|secret|password/i.test(k)) hits.push(`${path}.${k}`);
          hits.push(...tokenKeys(x, `${path}.${k}`));
        }
      }
      return hits;
    };
    try {
      // ── PC-A + its phone ──
      const pcA = track(await connect(url));
      // Card S2-01 — PC-A DECLARES that it can take a picture; PC-B (below)
      // declares nothing, which is what every desktop built before this card
      // sends. The pair acks below hold both answers apart.
      const regA = await ack(pcA, 'pc:register', { device_name: 'Golden PC A', client_instance_id: 'inst-g12-a-0123456789', client: 'app', client_version: '0.3.78', target_caps: { image: true } });
      const mobA = track(await connect(url));
      const joinedA = once(pcA, 'pc:mobile-joined');
      // Card S2-01 — this phone pairs as a BROWSER, so ① below can check that
      // the kind survives the whole round trip (frame → row → projection).
      const pairA = await ack(mobA, 'mobile:pair', { short_code: regA.short_code, client: 'web', client_version: '1.0.0' });
      await joinedA;
      if (!pairA.pairing_id || !pairA.mobile_token) return FAIL(`pair A produced no pairing: ${JSON.stringify(pairA)}`);
      // Card S2-01 — what the TARGET said, read off the ack the phone actually
      // gets. Declared yes.
      if (JSON.stringify(pairA.target_caps) !== JSON.stringify({ image: true }))
        return FAIL(`the target declared image:true and the pair ack says ${JSON.stringify(pairA.target_caps)} — declared on pc:register, stripped before the ack`);

      // ── PC-B + its own phone (the cross-room negative, same user) ──
      const pcB = track(await connect(url));
      const regB = await ack(pcB, 'pc:register', { device_name: 'Golden PC B', client_instance_id: 'inst-g12-b-0123456789' });
      const mobB = track(await connect(url));
      const joinedB = once(pcB, 'pc:mobile-joined');
      // Card S2-01 — the OLD-CLIENT control, and it is the half that matters
      // most: this frame is byte-for-byte what every shipped phone sends, and
      // it must still pair and must still be projected without anyone
      // inventing 'app' for it. `null` says 「nobody told us」; 'app' would say
      // 「the app told us」, and only one of those happened.
      const pairB = await ack(mobB, 'mobile:pair', { short_code: regB.short_code });
      await joinedB;
      if (regA.pc_id === regB.pc_id) return FAIL('the two PCs collapsed onto one device row — the isolation check would be vacuous');
      // 🔴 Card S2-01 — THE UNDECLARED CASE, asserted on the KEY. PC-B never
      // said anything, so the ack must carry NO `target_caps` at all. Not
      // `{image:false}`: that would be a refusal, and every desktop shipped
      // before this card is in exactly this state — reading absence as "no"
      // would stop image delivery for all of them on the day this ships.
      if ('target_caps' in pairB)
        return FAIL(`a target that declared nothing produced target_caps=${JSON.stringify(pairB.target_caps)} — undeclared must stay undeclared`);

      // ① it lists them + projection has no token.
      const listA = await ack(pcA, 'pc:list-mobiles', {});
      const rowsA = listA.mobiles;
      if (!Array.isArray(rowsA)) return FAIL(`pc:list-mobiles returned no mobiles array: ${JSON.stringify(listA)}`);
      const mine = rowsA.find((m) => m.pairing_id === pairA.pairing_id);
      if (!mine) return FAIL(`the just-paired phone is NOT listed: ${JSON.stringify(rowsA)}`);
      const leaked = tokenKeys(listA);
      if (leaked.length > 0) return FAIL(`ack leaked secret-ish key(s): ${leaked.join(', ')}`);
      if (JSON.stringify(listA).includes(pairA.mobile_token)) return FAIL('ack leaked the mobile_token VALUE');
      const fields = Object.keys(mine).sort().join(',');
      // `device_uid` joined the projection in db52ca0 (v0.2.4 machine-level
      // identity, owner-authorised) and this list was never updated — so G12 has
      // been RED since 2026-07-29 and nobody saw it, because `pnpm golden` sits
      // in no gate at all (pre-commit runs verify:lint + verify:types only).
      // Kept as an exact-set assertion on purpose: the guard exists to catch a
      // field APPEARING here, and a loose check would not. A token would still
      // fail it — device_uid is a machine identity, not a secret (tokenKeys above
      // is the separate secret-leak guard, and it still passes).
      //
      // Card S2-01 added `client` / `client_version` (six → eight), so the
      // desktop can mark a browser instead of showing it as an
      // indistinguishable phone.
      if (fields !== 'client,client_version,device_uid,last_seen_at,mobile_name,online,paired_at,pairing_id')
        return FAIL(`unexpected projection fields: ${fields}`);
      if (mine.online !== true) return FAIL(`a phone with a LIVE socket reported online=${mine.online}`);
      // 🔴 CARD S2-01 — THE ROUND TRIP, not the schema. The relay strips any
      // key it does not declare, silently and with both ends convinced they
      // agreed (`duration_ms`, and the stale-dist false green before it), so
      // the only assertion worth making is on a value that went out on a real
      // frame and came back through a real projection.
      if (mine.client !== 'web')
        return FAIL(`a phone that paired as a browser is projected as client=${JSON.stringify(mine.client)} — the field was stripped or dropped between mobile:pair and pc:list-mobiles`);
      if (mine.client_version !== '1.0.0')
        return FAIL(`client_version did not survive the round trip: ${JSON.stringify(mine.client_version)}`);

      // ② ownership isolation: A cannot see B's phone, B cannot see A's.
      if (rowsA.some((m) => m.pairing_id === pairB.pairing_id)) return FAIL('PC-A listed a phone paired to PC-B (跨房泄漏)');
      const listB = await ack(pcB, 'pc:list-mobiles', {});
      const theirs = (listB.mobiles ?? []).find((m) => m.pairing_id === pairB.pairing_id);
      if (!theirs) return FAIL('PC-B cannot see its OWN phone');
      // Card S2-01 old-client control — see the pair call above.
      if (theirs.client !== null || theirs.client_version !== null)
        return FAIL(`a pairing made WITHOUT the field was projected as client=${JSON.stringify(theirs.client)} / version=${JSON.stringify(theirs.client_version)} — the projection invented a value nobody sent`);
      if ((listB.mobiles ?? []).some((m) => m.pairing_id === pairA.pairing_id)) return FAIL('PC-B listed a phone paired to PC-A (跨房泄漏)');

      // ② the query is PC-only — a mobile-role socket is refused, not answered.
      const asMobile = await ack(mobA, 'pc:list-mobiles', {});
      if (asMobile.error !== 'AUTH_TOKEN_INVALID') return FAIL(`a MOBILE socket got an answer instead of AUTH_TOKEN_INVALID: ${JSON.stringify(asMobile)}`);

      // ③ real online state: the phone leaves → online flips false, the ROW stays.
      mobA.disconnect();
      await sleep(300);
      const afterLeave = await ack(pcA, 'pc:list-mobiles', {});
      const stillThere = (afterLeave.mobiles ?? []).find((m) => m.pairing_id === pairA.pairing_id);
      if (!stillThere) return FAIL('the pairing row vanished when the phone disconnected (this is a pairing table, not a presence table)');
      if (stillThere.online !== false) return FAIL(`a disconnected phone still reports online=${stillThere.online} (编造在线态)`);

      return PASS('paired phone listed after pairing; projection = the public eight with NO token key or value; a web pair round-trips as client=web/1.0.0 while a field-less pair stays null (never invented as app); a declaring target puts target_caps{image:true} on the pair ack while an undeclared one omits the key entirely; PC-A/PC-B mutually invisible; mobile-role socket refused (AUTH_TOKEN_INVALID); online flips true→false on disconnect while the pairing row survives');
    } catch (e) {
      return FAIL(`threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
    }
  },
};

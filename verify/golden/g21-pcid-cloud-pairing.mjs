// verify/golden/g21-pcid-cloud-pairing.mjs
//
// G21 — 🔴 PCID addressing on the cloud relay (owner 2026-08-14).
//
// 「云端中继不支持直接输入配对码建立连接，一定是扫码或输入一个 PCID+配对码才行」
// 「本地局域网扫码或输入配对码，没有 PCID」
//   Ruling : docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
//   Design : docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md
//   Wire   : docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (PCID addressing)
//
// WHAT THIS LAYER ADDS over apps/server-core/test/pcid-pairing.test.ts, so it is
// not just the same assertions in a slower harness:
//   · a REAL saas server (spawned dist, real socket.io, real DB), which is the
//     only place the MINT and the ACK PROJECTION are proven to be wired to each
//     other — the unit tests call the registry directly and would stay green if
//     `pcid` never reached the wire at all;
//   · TWO TENANTS on ONE relay at the same time, which is the situation the whole
//     feature exists for and which a single-registry unit test cannot stage;
//   · the STANDALONE control on the same binary in the other mode — the one
//     assertion that would catch "we made the LAN stricter too", which is the
//     most likely way to get this ruling wrong.
//
// ⚠️ SIM-MOBILE CAVEAT (run-golden.mjs header) applies in full: the "phone" below
// is a socket.io script. A green run says the RELAY refuses a bare code; it says
// nothing about whether the real app collects a PCID or renders the refusal.
// That half is apps/mobile/test/* and is `requires`d so it cannot quietly vanish.

import path from 'node:path';
import {
  ROOT, SERVER_DIST,
  connect, ack, once, startServer, startSaasServer, saasJwt, PASS, FAIL,
} from './harness.mjs';

const PCID_RE = /^\d{9}$/;

/** A cloud QR exactly as apps/desktop/src/lib/pairing.ts builds it: `pcid=` is
 *  appended AFTER `code=`, which is what lets the server's `/code=(\d{4})/`
 *  keep working and what makes a pre-0.2.66 phone (which forwards the scanned
 *  link verbatim) able to pair against a new PC without knowing the field. */
const cloudQr = (endpoint, code, pcid) =>
  `flowmic://pair?endpoint=${endpoint}&code=${code}&channel=saas&pcid=${pcid}`;

export const G21 = {
  id: 'G21',
  name: 'PCID cloud pairing (relay: scan / PCID+code succeed, bare code refused by name; LAN unchanged)',
  requires: [
    SERVER_DIST,
    path.join(ROOT, 'apps/server-core/test/pcid-pairing.test.ts'),
    // The phone half, all three files. Named here so that deleting the app-side
    // coverage turns this path red instead of leaving a relay-only claim looking
    // complete: this golden drives a socket script, so it can never show that the
    // real app COLLECTS a PCID or RENDERS the refusal.
    path.join(ROOT, 'apps/mobile/test/pcid_rules_test.dart'),
    path.join(ROOT, 'apps/mobile/test/pcid_field_wiring_test.dart'),
    path.join(ROOT, 'apps/mobile/test/pcid_error_copy_test.dart'),
  ],
  async fn() {
    let saas;
    try {
      saas = await startSaasServer();
    } catch (e) {
      return FAIL(`saas server failed to start: ${e.message}`);
    }
    const url = `http://127.0.0.1:${saas.port}`;
    const sockets = [];
    const track = (s) => { sockets.push(s); return s; };
    try {
      // ── two tenants, one relay ──────────────────────────────────────────────
      const jwtA = await saasJwt(url, 'g21-a@flowmic.test');
      const jwtB = await saasJwt(url, 'g21-b@flowmic.test');
      const pcA = track(await connect(url, { jwt: jwtA }));
      const regA = await ack(pcA, 'pc:register', { device_name: 'G21 PC-A', client_instance_id: 'inst-g21-a123456789' });
      const pcB = track(await connect(url, { jwt: jwtB }));
      const regB = await ack(pcB, 'pc:register', { device_name: 'G21 PC-B', client_instance_id: 'inst-g21-b123456789' });

      // ① the ack really carries a PCID over the wire, for both tenants, and the
      //    two are different. (A mint that returned the same number twice would
      //    make "which PC" ambiguous — the defect this feature removes.)
      if (!PCID_RE.test(regA.pcid || '')) return FAIL(`PC-A register ack has no 9-digit pcid: ${JSON.stringify(regA.pcid)}`);
      if (!PCID_RE.test(regB.pcid || '')) return FAIL(`PC-B register ack has no 9-digit pcid: ${JSON.stringify(regB.pcid)}`);
      if (regA.pcid === regB.pcid) return FAIL(`two PCs were minted the same pcid: ${regA.pcid}`);

      // ② 🔴 THE RULING: a bare 4-digit code is refused BY NAME, and the PC sees
      //    nothing. The "PC saw zero frames" half matters as much as the code — a refusal
      //    that still woke the PC would mean the frame had been processed.
      const barePhone = track(await connect(url));
      let pcAWoke = false;
      pcA.once('pc:mobile-joined', () => { pcAWoke = true; });
      const bare = await ack(barePhone, 'mobile:pair', { short_code: regA.short_code, mobile_name: 'G21-bare' });
      if (bare.error !== 'PAIR_PCID_REQUIRED') {
        return FAIL(`a bare code must be refused with PAIR_PCID_REQUIRED, got ${JSON.stringify(bare)}`);
      }
      if (bare.mobile_token) return FAIL('a refused pairing still minted a token');

      // ③ POSITIVE CONTROL for ②, and the manual path owner asked for: the SAME
      //    code, now addressed. Without this, ② would also pass on a relay that
      //    refuses everything.
      const manualPhone = track(await connect(url));
      const joinedA = once(pcA, 'pc:mobile-joined');
      const manual = await ack(manualPhone, 'mobile:pair', {
        short_code: regA.short_code, pcid: regA.pcid, mobile_name: 'G21-manual',
      });
      if (manual.error) return FAIL(`PCID + code must pair, got ${JSON.stringify(manual)}`);
      if (manual.pc_id !== regA.pc_id) return FAIL(`paired with the wrong PC: ${manual.pc_id} != ${regA.pc_id}`);
      await joinedA;

      // ④ the SCAN path, which owner ruled is 「同一逻辑」 — same relay code path,
      //    reached through a QR payload instead of two fields.
      const scanPhone = track(await connect(url));
      const scan = await ack(scanPhone, 'mobile:pair', {
        qr_payload: cloudQr(`ws://127.0.0.1:${saas.port}`, regB.short_code, regB.pcid),
        mobile_name: 'G21-scan',
      });
      if (scan.error) return FAIL(`a cloud QR carrying pcid must pair, got ${JSON.stringify(scan)}`);
      if (scan.pc_id !== regB.pc_id) return FAIL(`the QR paired with the wrong PC: ${scan.pc_id} != ${regB.pc_id}`);

      // ⑤ 🔴 CROSS-TENANT: B's live code addressed at A pairs with NEITHER. This
      //    is the property the old design could not have — before PCID, holding
      //    any live code on the relay was enough to reach its owner.
      const crossPhone = track(await connect(url));
      const cross = await ack(crossPhone, 'mobile:pair', {
        short_code: regB.short_code, pcid: regA.pcid, mobile_name: 'G21-cross',
      });
      if (cross.error !== 'PAIR_INVALID_CODE') {
        return FAIL(`A's pcid + B's code must be refused with PAIR_INVALID_CODE, got ${JSON.stringify(cross)}`);
      }

      // ⑥ an unknown PCID is its own answer (the action is "re-read the number",
      //    not "re-scan" and not "check the code").
      const unknownPhone = track(await connect(url));
      const unknown = await ack(unknownPhone, 'mobile:pair', {
        short_code: regA.short_code, pcid: '000000000', mobile_name: 'G21-unknown',
      });
      if (unknown.error !== 'PAIR_PCID_UNKNOWN') {
        return FAIL(`an unknown pcid must answer PAIR_PCID_UNKNOWN, got ${JSON.stringify(unknown)}`);
      }

      if (pcAWoke && !manual.pc_id) return FAIL('the refused bare-code attempt reached the PC');

      // ── ⑦ THE LAN CONTROL, same binary in standalone mode ──────────────────
      // The failure this catches: enforcing the relay ruling everywhere, which
      // would break every offline user. It also proves the two verdicts are
      // MODE-dependent rather than accidental — the identical frame that was
      // refused at ② pairs here.
      let lan;
      try {
        lan = await startServer();
      } catch (e) {
        return FAIL(`standalone control server failed to start: ${e.message}`);
      }
      try {
        const lanUrl = `http://127.0.0.1:${lan.port}`;
        const lanPc = track(await connect(lanUrl));
        const lanReg = await ack(lanPc, 'pc:register', { device_name: 'G21 LAN', client_instance_id: 'inst-g21-lan12345' });
        if (lanReg.pcid !== undefined) {
          return FAIL(`standalone must not mint a pcid (there is no PCID on the LAN), got ${JSON.stringify(lanReg.pcid)}`);
        }
        const lanPhone = track(await connect(lanUrl));
        const lanPair = await ack(lanPhone, 'mobile:pair', { short_code: lanReg.short_code, mobile_name: 'G21-lan' });
        if (lanPair.error) {
          return FAIL(`a bare code MUST still pair on the LAN, got ${JSON.stringify(lanPair)}`);
        }
      } finally {
        lan.child.kill();
      }

      return PASS(
        'relay: bare code → PAIR_PCID_REQUIRED (no token minted); PCID+code and pcid-carrying QR both pair; ' +
        "A's pcid + B's code → PAIR_INVALID_CODE; unknown pcid → PAIR_PCID_UNKNOWN. " +
        'LAN control: standalone mints no pcid and a bare code still pairs. ' +
        'SIM-MOBILE: the phone-side collection/rendering is apps/mobile/test/pcid_{rules,field_wiring,error_copy}_test.dart, not this path.',
      );
    } catch (e) {
      return FAIL(`G21 threw: ${e.message}`);
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } }
      if (saas) saas.child.kill();
    }
  },
};

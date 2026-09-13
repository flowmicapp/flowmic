// `client_instance_id` — the LABEL that used to be able to refuse the frame.
//
// SPEC-REF:
//   ../src/protocol-primitives.ts        (ClientInstanceId, and why it degrades)
//   ../src/protocol-schemas-auth.ts §3.1 (PcRegisterSchema / PcReconnectSchema)
//   apps/server-core/src/room/registry-shared.ts (sanitizeClientInstanceId —
//     the check that IS load-bearing, and it reads the value, never the length)
//
// ── WHAT THIS PINS, AND WHY IT IS NOT THE SAME TEST AS machine-uid-fields ──
//
// That file pins the degradation of `machine_uid`. This one pins the SAME
// property for the field beside it, which did not have it until defect D5.
//
// 🔴 THE DEFECT, MEASURED (2026-09-08, production NY relay, evidence
// flowmic-web docs/device-evidence-2026-09-09/README.md §D5): a web target
// minted its room over HTTP (`POST /api/web/rooms` → 200, a real token, a real
// PCID) and was then refused `AUTH_TOKEN_INVALID` by `pc:reconnect` — on every
// node, including the writer that had just minted it seconds earlier. Nothing
// was wrong with the token, the row, the routing or the clock. The frame
// carried `client_instance_id: 'web-<8 hex>'` (twelve characters, which is
// simply what flowmic-web's `webClientInstanceId` returns), the old
// `z.string().min(16)` failed it, `safeParseEvent` returned failure, and
// `pc.handler.ts` answered the whole frame with a CREDENTIAL verdict.
//
// ⇒ the property is not「short ids are allowed」. It is: **a malformed label may
// never decide the fate of the credential on the same frame.** The two
// assertions below that matter most are therefore about what SURVIVES a bad
// label (the token, the machine uid, the caps) — not about the label itself.

import { describe, it, expect } from 'vitest';
import { safeParseEvent } from '../src/protocol-schemas';

const TOKEN = 't'.repeat(32);
const PC_UID = 'pc-00112233445566aa';
const BROWSER_UID = 'wb-0123456789abcdef';

/** Byte-for-byte what flowmic-web `packages/core/src/target/wire.ts`
 *  `webClientInstanceId` produces — `web-` + the uid's first 8 hex. Derived,
 *  not pasted, so a change over there shows up here as a shape change rather
 *  than as a stale literal that keeps passing. */
const WEB_INSTANCE_ID = `web-${BROWSER_UID.replace(/^[a-z]{2}-/, '').slice(0, 8)}`;

describe('client_instance_id degrades to absent instead of refusing the frame', () => {
  it('the exact frame every browser target sends is ADMITTED (defect D5)', () => {
    expect(WEB_INSTANCE_ID).toHaveLength(12); // the whole defect, in one number
    const r = safeParseEvent('pc:reconnect', {
      token: TOKEN,
      machine_uid: BROWSER_UID,
      client_instance_id: WEB_INSTANCE_ID,
      client: 'web',
      client_version: '0.3.78',
      target_caps: { image: false },
    });
    expect(r.success).toBe(true);
  });

  it('and everything the frame is FOR survives the bad label', () => {
    const r = safeParseEvent('pc:reconnect', {
      token: TOKEN,
      machine_uid: BROWSER_UID,
      client_instance_id: WEB_INSTANCE_ID,
      target_caps: { image: false },
    });
    // The credential, the machine identity and the capability declaration are
    // the three things a reconnect exists to carry. Before the fix all three
    // were discarded because a twelve-character label sat beside them.
    expect(r.success && r.data.token).toBe(TOKEN);
    expect(r.success && r.data.machine_uid).toBe(BROWSER_UID);
    expect(r.success && r.data.target_caps).toEqual({ image: false });
    // The label itself is the ONE thing that is allowed to be lost.
    expect(r.success && r.data.client_instance_id).toBeUndefined();
  });

  it('a well-formed id still lands — degrading is not discarding', () => {
    const good = 'pc-instance-0123456789';
    const reg = safeParseEvent('pc:register', {
      device_name: 'Studio PC', machine_uid: PC_UID, client_instance_id: good,
    });
    const rec = safeParseEvent('pc:reconnect', {
      token: TOKEN, machine_uid: PC_UID, client_instance_id: good,
    });
    expect(reg.success && reg.data.client_instance_id).toBe(good);
    expect(rec.success && rec.data.client_instance_id).toBe(good);
  });

  it('every malformed shape degrades, on BOTH admission legs', () => {
    // One primitive, one author: the two legs must not disagree about what a
    // bad label means, or the answer would depend on which event a client
    // happened to be sending.
    for (const bad of [WEB_INSTANCE_ID, '', 'short', 42, null, {}, ['x']]) {
      const reg = safeParseEvent('pc:register', {
        device_name: 'Studio PC', machine_uid: PC_UID, client_instance_id: bad,
      });
      const rec = safeParseEvent('pc:reconnect', {
        token: TOKEN, machine_uid: PC_UID, client_instance_id: bad,
      });
      expect(reg.success, `register ${JSON.stringify(bad)}`).toBe(true);
      expect(rec.success, `reconnect ${JSON.stringify(bad)}`).toBe(true);
      expect(reg.success && reg.data.client_instance_id).toBeUndefined();
      expect(rec.success && rec.data.client_instance_id).toBeUndefined();
    }
  });

  it('the label is still NOT a credential — a reconnect without a token fails', () => {
    // The reverse direction of the same rule. Relaxing a label must not relax
    // the field the frame is actually authorised by.
    expect(safeParseEvent('pc:reconnect', { client_instance_id: 'pc-instance-0123456789' }).success).toBe(false);
    expect(safeParseEvent('pc:reconnect', { token: 'too-short', client_instance_id: 'pc-instance-0123456789' }).success).toBe(false);
  });
});

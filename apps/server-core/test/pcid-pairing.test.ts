// 0.2.66 — PCID addressing on the cloud relay.
//
// owner 2026-08-14: "the cloud relay does not support pairing by typing the code
// alone — it must be a scan, or a PCID + pairing code" and "LAN scan or typed pairing code, no PCID".
//   Ruling  : docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
//   Design  : docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md
//   Contract: docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (PCID addressing)
//   *** HUMAN-AUDIT SENSITIVE (auth/pairing) ***
//
// 🔴 WHAT THIS FILE IS REALLY MEASURING. Before this round the 4-digit code was
// the only addressing the protocol had (short-code.ts says exactly that), and
// `pcs.listByShortCode` is the one PC lookup with no user dimension — so on the
// multi-tenant relay a guessed code paired the guesser with whichever tenant
// happened to be showing that code. Splitting 「which PC」 (pcid, public) from
// 「prove it」 (short code, secret) is the fix. Three properties therefore matter
// more than the happy path, and each has its own case below:
//   ① a bare code no longer resolves ANYTHING on the relay (§ the ruling);
//   ② naming PC A and holding PC B's code pairs with NEITHER — addressing and
//      secret must not be able to rescue one another;
//   ③ attacking A cannot burn B's code — the cross-tenant blast radius IT-39-a
//      bounded with a heuristic is now structurally absent from this path.
// The LAN control (last describe) is not decoration either: the easiest way to
// get this wrong is to make the standalone path stricter too, which would break
// every offline user for a relay-only ruling.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry, PCID_RE, CLOUD_INSTANCE_ID } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';
import { ServerError } from '../src/errors';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

type Db = ReturnType<typeof createDbConnection>;
let db: Db;

function registry(mode: 'standalone' | 'saas', now?: () => number, ttlMs?: number): Registry {
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode,
    now,
    shortCodeTtlMs: ttlMs,
    limitsOf: () => planLimits('max'),
  });
}

/** A saas registry with the DEVICE CEILING lifted, for the two sampling cases
 *  that need dozens of registrations. The plan wall (max = 10 PCs) is a real
 *  and separately-tested rule — device-limits.test.ts owns it — and it would
 *  otherwise stop a draw-distribution sample at ten, measuring the wall instead
 *  of the mint. Nothing else in this file uses it. */
function unlimitedSaas(): Registry {
  return new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    mode: 'saas',
    limitsOf: () => ({ ...planLimits('max'), pcs: Number.POSITIVE_INFINITY }),
  });
}

function newPc(reg: Registry, user_id: string, tag: string) {
  return reg.registerPc({ device_name: `PC-${tag}`, user_id, client_instance_id: `inst-${tag}` }).pc;
}

/** The code this raises is what the phone renders, so every assertion below is
 *  about the CODE and never about the developer message. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServerError) return err.code;
    throw err;
  }
  throw new Error('expected a ServerError, but the call succeeded');
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'max' });
  db.users.insert({ id: 'u2', display_name: 'U2', plan: 'max' });
});
afterEach(() => db.close());

describe('0.2.66 · minting', () => {
  it('a saas registration mints a 9-digit PCID', () => {
    const pc = newPc(registry('saas'), 'u1', 'a');
    expect(pc.pcid).toMatch(PCID_RE);
    // Sampled rather than asserted once: the alphabet and the length are the
    // contract (04 §3.1), and a padStart bug only shows on a small draw.
    const reg = unlimitedSaas();
    for (let i = 0; i < 40; i += 1) {
      const p = newPc(reg, 'u1', `s${i}`);
      expect(p.pcid, `draw ${i}`).toMatch(/^[0-9]{9}$/);
    }
  });

  it('🔴 standalone mints NOTHING — there is no PCID on the LAN', () => {
    const pc = newPc(registry('standalone'), 'u1', 'lan');
    expect(pc.pcid).toBeNull();
  });

  it('the PCID is STABLE across re-registration, while the short code rotates', () => {
    const reg = registry('saas');
    const first = newPc(reg, 'u1', 'a');
    // Same client_instance_id ⇒ the re-register branch, the one a desktop takes
    // every time it restarts.
    const again = reg.registerPc({ device_name: 'PC-a', user_id: 'u1', client_instance_id: 'inst-a' }).pc;
    expect(again.id).toBe(first.id);
    expect(again.pcid).toBe(first.pcid); // the ADDRESS survives…
    expect(again.short_code).not.toBe(first.short_code); // …while the SECRET rotates
  });

  it('a row that predates the column is backfilled on its next registration', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    db.pcs.setPcid(pc.id, null as unknown as string); // simulate a pre-0.2.66 row
    expect(db.pcs.findById(pc.id)?.pcid).toBeNull();
    const back = reg.registerPc({ device_name: 'PC-a', user_id: 'u1', client_instance_id: 'inst-a' }).pc;
    expect(back.pcid).toMatch(PCID_RE);
  });

  it('the virtual cloud-instance row never gets one (it is not a machine)', () => {
    const reg = registry('saas');
    reg.admitCloudInstance('u1');
    const virtual = db.pcs.listByUser('u1').filter((p) => p.client_instance_id === CLOUD_INSTANCE_ID);
    expect(virtual).toHaveLength(1);
    expect(virtual[0]!.pcid).toBeNull();
  });

  it('two PCs never share a PCID (the DB owns that guarantee)', () => {
    const reg = unlimitedSaas();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) seen.add(newPc(reg, 'u1', `u${i}`).pcid!);
    expect(seen.size).toBe(60);
  });
});

describe('0.2.66 · the saas resolve: address first, then the secret', () => {
  it('PCID + the live code pairs', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    const paired = reg.pairMobile({ short_code: pc.short_code, pcid: pc.pcid!, mobile_name: 'Phone' });
    expect(paired.pc.id).toBe(pc.id);
  });

  it('🔴 a BARE code is refused — the ruling, in one assertion', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    expect(codeOf(() => reg.pairMobile({ short_code: pc.short_code }))).toBe('PAIR_PCID_REQUIRED');
    // …and nothing was written by the refused attempt.
    expect(db.mobiles.listByPc(pc.id)).toEqual([]);
  });

  it('an unknown or malformed PCID answers PAIR_PCID_UNKNOWN', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    expect(codeOf(() => reg.pairMobile({ short_code: pc.short_code, pcid: '000000001' }))).toBe('PAIR_PCID_UNKNOWN');
    expect(codeOf(() => reg.pairMobile({ short_code: pc.short_code, pcid: '123' }))).toBe('PAIR_PCID_UNKNOWN');
    expect(codeOf(() => reg.pairMobile({ short_code: pc.short_code, pcid: 'abcdefghi' }))).toBe('PAIR_PCID_UNKNOWN');
  });

  it('the right PCID with a wrong code answers PAIR_INVALID_CODE', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    const wrong = pc.short_code === '0001' ? '0002' : '0001';
    expect(codeOf(() => reg.pairMobile({ short_code: wrong, pcid: pc.pcid! }))).toBe('PAIR_INVALID_CODE');
  });

  it('the right PCID with an EXPIRED code answers PAIR_EXPIRED_CODE', () => {
    let clock = 1_000_000;
    const reg = registry('saas', () => clock, 5 * 60_000);
    const pc = newPc(reg, 'u1', 'a');
    clock += 5 * 60_000 + 1; // past the TTL
    expect(codeOf(() => reg.pairMobile({ short_code: pc.short_code, pcid: pc.pcid! }))).toBe('PAIR_EXPIRED_CODE');
  });

  it('🔴 addressing and secret cannot rescue each other (A\'s PCID + B\'s code)', () => {
    // The property the old design could not have: two tenants, and a caller
    // holding one valid half of each pairs with neither.
    const reg = registry('saas');
    const a = newPc(reg, 'u1', 'a');
    const b = newPc(reg, 'u2', 'b');
    expect(a.short_code).not.toBe(b.short_code); // (the governor avoids live clashes)
    expect(codeOf(() => reg.pairMobile({ short_code: b.short_code, pcid: a.pcid! }))).toBe('PAIR_INVALID_CODE');
    expect(db.mobiles.listByPc(a.id)).toEqual([]);
    expect(db.mobiles.listByPc(b.id)).toEqual([]);
  });
});

describe('0.2.66 · the QR arm takes the SAME path (owner: scan and typed entry are the same logic)', () => {
  const qr = (endpoint: string, code: string, pcid?: string) =>
    `flowmic://pair?endpoint=${endpoint}&code=${code}&channel=saas${pcid ? `&pcid=${pcid}` : ''}`;

  it('a cloud QR carrying pcid= pairs', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    const paired = reg.pairMobile({ qr_payload: qr('wss://relay.example', pc.short_code, pc.pcid!) });
    expect(paired.pc.id).toBe(pc.id);
  });

  it('a QR with no pcid= is refused exactly like a bare code', () => {
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    expect(codeOf(() => reg.pairMobile({ qr_payload: qr('wss://relay.example', pc.short_code) })))
      .toBe('PAIR_PCID_REQUIRED');
  });

  it('🔴 appending pcid= after code= cannot disturb the code extraction', () => {
    // 04 §3.1 rule 4. This is also WHY a phone built before 0.2.66 still works
    // on a new PC's QR: it forwards the scanned link verbatim, so the pcid
    // arrives without that phone knowing the field exists.
    const reg = registry('saas');
    const pc = newPc(reg, 'u1', 'a');
    const legacyForwarded = qr('wss://relay.example', pc.short_code, pc.pcid!);
    expect(legacyForwarded.indexOf('code=')).toBeLessThan(legacyForwarded.indexOf('pcid='));
    expect(reg.pairMobile({ qr_payload: legacyForwarded }).pc.id).toBe(pc.id);
  });
});

describe('0.2.66 · the failure budget is charged to the PC that was NAMED', () => {
  it('🔴 burning A\'s code leaves B\'s budget untouched', () => {
    const reg = registry('saas');
    const a = newPc(reg, 'u1', 'a');
    const b = newPc(reg, 'u2', 'b');
    const wrongFor = (code: string) => (code === '0001' ? '0002' : '0001');

    // 20 wrong guesses aimed at A (SHORT_CODE_FAILURE_BUDGET).
    for (let i = 0; i < 20; i += 1) {
      expect(codeOf(() => reg.pairMobile({ short_code: wrongFor(a.short_code), pcid: a.pcid! })))
        .toBe('PAIR_INVALID_CODE');
    }
    // A is burned: even its REAL code no longer resolves, and says 「refresh」.
    expect(codeOf(() => reg.pairMobile({ short_code: a.short_code, pcid: a.pcid! }))).toBe('PAIR_EXPIRED_CODE');
    // 🔴 B — a different tenant, live the whole time — is completely unaffected.
    // Under the pre-0.2.66 heuristic a spray with no target could reach it; here
    // the guesses named A, so B cannot have been charged.
    expect(reg.pairMobile({ short_code: b.short_code, pcid: b.pcid!, mobile_name: 'B-phone' }).pc.id).toBe(b.id);
  });

  it('guessing at a PC with no live issuance charges nothing to its NEXT code', () => {
    let clock = 1_000_000;
    const reg = registry('saas', () => clock, 5 * 60_000);
    const pc = newPc(reg, 'u1', 'a');
    clock += 5 * 60_000 + 1; // its issuance lapsed
    for (let i = 0; i < 25; i += 1) {
      codeOf(() => reg.pairMobile({ short_code: '0000', pcid: pc.pcid! }));
    }
    // A fresh issuance starts with a full budget — the guesses above had no live
    // code to charge, so they must not have accumulated onto this one.
    const fresh = reg.refreshShortCode(pc.id);
    expect(reg.pairMobile({ short_code: fresh, pcid: pc.pcid!, mobile_name: 'Phone' }).pc.id).toBe(pc.id);
  });
});

describe('0.2.66 · the LAN control — standalone is UNCHANGED', () => {
  it('a bare code still pairs on standalone', () => {
    const reg = registry('standalone');
    const pc = newPc(reg, 'u1', 'lan');
    expect(reg.pairMobile({ short_code: pc.short_code, mobile_name: 'Phone' }).pc.id).toBe(pc.id);
  });

  it('a LAN QR (no pcid=, no channel=saas) still pairs', () => {
    const reg = registry('standalone');
    const pc = newPc(reg, 'u1', 'lan');
    const payload = `flowmic://pair?endpoint=ws://192.168.1.9:41879&code=${pc.short_code}&channel=standalone`;
    expect(reg.pairMobile({ qr_payload: payload }).pc.id).toBe(pc.id);
  });

  it('a stray pcid on a standalone frame is IGNORED, not refused', () => {
    // Forward compatibility in the direction that actually happens: a 0.2.66
    // phone that has learned about PCIDs dials a LAN sidecar. Refusing here
    // would break the LAN for a relay-only ruling.
    const reg = registry('standalone');
    const pc = newPc(reg, 'u1', 'lan');
    expect(reg.pairMobile({ short_code: pc.short_code, pcid: '123456789', mobile_name: 'Phone' }).pc.id).toBe(pc.id);
  });
});

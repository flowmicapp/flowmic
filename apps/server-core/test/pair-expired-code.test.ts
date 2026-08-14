// U3 (0.3.0) — an expired pairing code must say 「expired」, not 「invalid」.
//
// Launch register E4: PAIR_EXPIRED_CODE had ZERO producers — the server threw
// the same PAIR_INVALID_CODE for an aged-out code as for a typo, so the newest
// user's most common failure read as "pairing code invalid" while the correct
// four-language sentence sat two lines away in error-codes.ts, unreachable.
//
// The distinction implemented (registry.ts U3-EXPIRED-VS-INVALID, the greppable
// anchor for the semantics decision):
//   · listByShortCode matched a REAL pc row, but no issuance is ACTIVE
//     ⇒ PAIR_EXPIRED_CODE — the string genuinely was that PC's newest code and
//       its active window lapsed (TTL, or a governor restart).
//   · zero real rows ⇒ PAIR_INVALID_CODE — including a SUPERSEDED code: every
//     re-mint overwrites pc_devices.short_code, so an older code matches zero
//     rows and is physically indistinguishable from one that never existed.
//     That is a documented decision (a code-history table would be a DB
//     migration — an owner gate), pinned by a test below so the limit is spec,
//     not accident.
//   · the F-3140 cloud-instance constant '0000' is excluded via isRealPc — it
//     is never a pairing target, so it must never read 「please refresh」.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../src/room/registry';
import { ServerError } from '../src/errors';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const TTL_MS = 5 * 60_000;

type Db = ReturnType<typeof createDbConnection>;
let db: Db;
let nowMs: number;

function registry(): Registry {
  // Injected clock + TTL: expiry is simulated by moving `nowMs`, never by
  // sleeping — the governor reads the same clock the assertions do.
  return new Registry({ pcs: db.pcs, mobiles: db.mobiles, now: () => nowMs, shortCodeTtlMs: TTL_MS });
}

/** The ServerError.code a call threw, or null when it did not throw. */
function thrownCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServerError) return err.code;
    throw err;
  }
  return null;
}

/** A 4-digit code guaranteed to differ from `code` (first digit flipped), so
 *  「unknown code」 cases can never collide with the one row in the table. */
function otherCode(code: string): string {
  return String((Number(code[0]) + 1) % 10) + code.slice(1);
}

beforeEach(() => {
  nowMs = 1_700_000_000_000;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
});
afterEach(() => db.close());

describe('U3 — expired vs invalid pairing code', () => {
  it('an aged-out code answers PAIR_EXPIRED_CODE, not PAIR_INVALID_CODE', () => {
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    nowMs += TTL_MS; // isActive is strict (`< ttl`), so exactly-TTL is expired
    expect(thrownCode(() => reg.pairMobile({ short_code: pc.short_code, mobile_name: 'P-0001' }))).toBe(
      'PAIR_EXPIRED_CODE',
    );
  });

  it('positive control: one tick inside the TTL the same code still pairs', () => {
    // Without this, 「expired」 could be over-firing and every assertion above
    // would still pass — the distinguishability claim needs a working baseline.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    nowMs += TTL_MS - 1;
    const { mobile } = reg.pairMobile({ short_code: pc.short_code, mobile_name: 'P-0001' });
    expect(mobile.pc_device_id).toBe(pc.id);
  });

  it('an unknown code keeps answering PAIR_INVALID_CODE — before and after expiry', () => {
    // The expired verdict must never widen into an existence oracle: a guess
    // that matches no stored row reads exactly as it always did.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const unknown = otherCode(pc.short_code);
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: unknown }))).toBe('PAIR_INVALID_CODE');
    nowMs += TTL_MS;
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: unknown }))).toBe('PAIR_INVALID_CODE');
  });

  it('a malformed code keeps the format-gate PAIR_INVALID_CODE', () => {
    const reg = registry();
    reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    nowMs += TTL_MS; // even with an expired row in the table the gate fires first
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: 'abcd' }))).toBe('PAIR_INVALID_CODE');
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: '12345' }))).toBe('PAIR_INVALID_CODE');
  });

  it('the QR path reports expiry too — a stale screenshot is the scan-side twin', () => {
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    nowMs += TTL_MS;
    expect(
      thrownCode(() =>
        reg.resolvePcForPair({ qr_payload: `flowmic://pair?endpoint=ws://192.0.2.1:41879&code=${pc.short_code}` }),
      ),
    ).toBe('PAIR_EXPIRED_CODE');
  });

  it('a SUPERSEDED code reads PAIR_INVALID_CODE — the documented limit, pinned as spec', () => {
    // Every re-mint overwrites pc_devices.short_code, so the older code
    // matches zero rows: the server cannot tell it from a code that never
    // existed (registry.ts U3-EXPIRED-VS-INVALID documents the decision).
    // If this ever flips to PAIR_EXPIRED_CODE, someone added code history —
    // re-read that comment before accepting the change.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const codeA = pc.short_code;
    let codeB = reg.refreshShortCode(pc.id);
    // The allocator may legitimately hand the same owner the same code again;
    // refresh until it differs so the assertion below is about SUPERSEDED.
    while (codeB === codeA) codeB = reg.refreshShortCode(pc.id);
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: codeA }))).toBe('PAIR_INVALID_CODE');
    // …and the NEW code resolves (the refresh the expired sentence points at).
    expect(reg.resolvePcForPair({ short_code: codeB }).id).toBe(pc.id);
  });

  it("the cloud-instance constant '0000' never reads as expired", () => {
    // F-3140 rows hold '0000' and are never stamped ACTIVE in the governor, so
    // without the isRealPc filter the one code every probe knows would answer
    // "expired, please refresh" forever — false, and an oracle over a constant.
    const reg = registry();
    reg.admitCloudInstance('u1');
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: '0000' }))).toBe('PAIR_INVALID_CODE');
  });
});

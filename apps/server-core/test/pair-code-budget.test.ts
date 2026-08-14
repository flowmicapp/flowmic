// IT-39 — per-code failure budget (plan A) + the `socketIp()` empty-string
// bucket, put on the record.
//
// WHAT THIS FILE PINS, and why the two subjects share it: both are deliverables
// of the same card, and both are about the SAME question — 「what actually
// bounds a pairing brute-force, and what only looks like it does」.
//
//   ① The per-code budget (short-code.ts, SHORT_CODE_FAILURE_BUDGET). The
//      per-IP window bounds ONE SOURCE; nothing bounded the TARGET. Every burn
//      assertion below carries a CONTROL with the budget lifted, because
//      「the code stopped resolving」 has a second, entirely innocent cause
//      sitting right next to it (the TTL), and without the control a test that
//      merely aged out would read as a test that burned.
//   ② The `''` bucket (mobile.handler.ts / auth.handler.ts `socketIp`). Not a
//      fix — a measurement, so the collapse is a known property rather than an
//      accident nobody has looked at.
//
// The END-TO-END brute-force experiment (real server, real sockets, both
// directions) is a separate file: pair-brute-force-e2e.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ShortCodeGovernor,
  SHORT_CODE_FAILURE_BUDGET,
  SHORT_CODE_SPACE,
  randomShortCode,
} from '../src/room/short-code';
import { PairRateLimiter, PAIR_IP_MAX_FAILURES } from '../src/room/pair-rate-limit';
import { clientIpFromHandshake } from '../src/http/trusted-proxy';
import { Registry } from '../src/room/registry';
import { ServerError } from '../src/errors';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const TTL_MS = 5 * 60_000;
/** Budget large enough that no test here can reach it — the 「no budget」 arm. */
const NO_BUDGET = 1_000_000;

/** The governor only reads `listByShortCode` during `allocate`; every test below
 *  stamps issuances directly, so an empty table is the honest stand-in. */
const NO_ROWS = { listByShortCode: () => [] };

describe('IT-39 ① the code space the budget is defending', () => {
  it('the alphabet is 0-9 and the length is 4 — so the space is exactly SHORT_CODE_SPACE', () => {
    // The brute-force arithmetic in pair-rate-limit.ts and in the card is only
    // as good as this. Measured by sampling rather than asserted by reading the
    // constant, so a change to randomShortCode cannot leave the number behind.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 5_000; i++) {
      const code = randomShortCode();
      expect(code).toMatch(/^[0-9]{4}$/);
      const n = Number(code);
      if (n < min) min = n;
      if (n > max) max = n;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(SHORT_CODE_SPACE - 1);
    expect(SHORT_CODE_SPACE).toBe(10 ** 4);
  });
});

describe('IT-39 ① the per-code failure budget (unit, injected clock)', () => {
  it('an issuance dies at the budget — and the CONTROL proves the budget is what killed it', () => {
    let t = 1_000;
    const gov = new ShortCodeGovernor(NO_ROWS, () => t, TTL_MS);
    gov.stamp('pc-a', '1234');

    // One short of the budget: still perfectly usable.
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET - 1; i++) gov.recordFailedGuess();
    expect(gov.isActive('pc-a')).toBe(true);
    expect(gov.isBurned('pc-a')).toBe(false);
    expect(gov.remainingMs('pc-a')).toBe(TTL_MS);

    // The budget-th miss burns it, with the TTL untouched (t never moved).
    gov.recordFailedGuess();
    expect(gov.isBurned('pc-a')).toBe(true);
    expect(gov.isActive('pc-a')).toBe(false);
    // The countdown and the gate must not disagree about "is it still usable" (R11).
    expect(gov.remainingMs('pc-a')).toBe(0);

    // CONTROL — identical run, budget lifted. Same clock, same misses, alive.
    // Without this, an accidental TTL bug would produce the assertions above.
    let tc = 1_000;
    const control = new ShortCodeGovernor(NO_ROWS, () => tc, TTL_MS, NO_BUDGET);
    control.stamp('pc-a', '1234');
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) control.recordFailedGuess();
    expect(control.isActive('pc-a')).toBe(true);
    expect(control.remainingMs('pc-a')).toBe(TTL_MS);
  });

  it('a NEW issuance restores the budget — the one recovery path, and the one the user already has', () => {
    let t = 1_000;
    const gov = new ShortCodeGovernor(NO_ROWS, () => t, TTL_MS);
    gov.stamp('pc-a', '1234');
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) gov.recordFailedGuess();
    expect(gov.isActive('pc-a')).toBe(false);

    // "Refresh pairing code" / re-register — registry.refreshShortCode stamps a new code.
    gov.stamp('pc-a', '5678');
    expect(gov.isBurned('pc-a')).toBe(false);
    expect(gov.isActive('pc-a')).toBe(true);
    expect(gov.remainingMs('pc-a')).toBe(TTL_MS);
  });

  it('only LIVE issuances are charged: one stamped after the spray starts clean, an expired one is never charged', () => {
    let t = 1_000;
    const gov = new ShortCodeGovernor(NO_ROWS, () => t, TTL_MS);
    gov.stamp('pc-old', '1111');
    t += TTL_MS; // pc-old is aged out before a single guess arrives
    gov.stamp('pc-live', '2222');

    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) gov.recordFailedGuess();
    expect(gov.isBurned('pc-live')).toBe(true);
    // pc-old was expired, so it was skipped rather than charged — and
    // releaseExpired dropped it, which is what keeps the failures map from
    // outliving the issuances it counts.
    expect(gov.isBurned('pc-old')).toBe(false);

    // A PC that shows its dialog AFTER the spray is untouched: this is the
    // 「collateral is bounded to codes live at that moment」 half of the design.
    gov.stamp('pc-new', '3333');
    expect(gov.isActive('pc-new')).toBe(true);
  });
});

describe('IT-39 ① the budget through the real pairing path (Registry)', () => {
  type Db = ReturnType<typeof createDbConnection>;
  let db: Db;
  let nowMs: number;

  const registry = (): Registry =>
    new Registry({ pcs: db.pcs, mobiles: db.mobiles, now: () => nowMs, shortCodeTtlMs: TTL_MS });

  /** The ServerError.code a call threw, or null when it did not throw. */
  const thrownCode = (fn: () => unknown): string | null => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ServerError) return err.code;
      throw err;
    }
    return null;
  };

  /** A 4-digit code guaranteed to differ from `code` (first digit flipped). */
  const otherCode = (code: string): string => String((Number(code[0]) + 1) % 10) + code.slice(1);

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  });
  afterEach(() => db.close());

  it('🔴 the walk is defeated: after the budget of wrong guesses, the CORRECT code no longer pairs', () => {
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const wrong = otherCode(pc.short_code);

    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) {
      expect(thrownCode(() => reg.resolvePcForPair({ short_code: wrong }))).toBe('PAIR_INVALID_CODE');
    }
    // The attacker eventually reaches the right string. It is dead.
    expect(thrownCode(() => reg.pairMobile({ short_code: pc.short_code, mobile_name: 'P-0001' }))).toBe(
      'PAIR_EXPIRED_CODE',
    );
    // ...and the clock never moved, so this is the budget and not the TTL.
    expect(reg.shortCodeExpiresInMs(pc.id)).toBe(0);
    expect(reg.isCodeActive(pc.id)).toBe(false);
  });

  it('POSITIVE CONTROL: one guess short of the budget, the correct code still pairs normally', () => {
    // Without this, a budget of 1 (or a burn on the first miss) would pass every
    // assertion above while breaking every real pairing that follows a typo.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const wrong = otherCode(pc.short_code);
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET - 1; i++) {
      expect(thrownCode(() => reg.resolvePcForPair({ short_code: wrong }))).toBe('PAIR_INVALID_CODE');
    }
    const { mobile } = reg.pairMobile({ short_code: pc.short_code, mobile_name: 'P-0001' });
    expect(mobile.pc_device_id).toBe(pc.id);
  });

  it('the two refusals stay two facts: a burned code reads EXPIRED, an unknown string still reads INVALID', () => {
    // The vocabulary carries "wrong guess" vs "this code is burned" with no new error code.
    // ("burned" vs "expired" is deliberately NOT split — that would tell a
    // sprayer their spray worked; see registry.ts U3-EXPIRED-VS-INVALID.)
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const wrong = otherCode(pc.short_code);
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) thrownCode(() => reg.resolvePcForPair({ short_code: wrong }));

    expect(thrownCode(() => reg.resolvePcForPair({ short_code: pc.short_code }))).toBe('PAIR_EXPIRED_CODE');
    expect(thrownCode(() => reg.resolvePcForPair({ short_code: wrong }))).toBe('PAIR_INVALID_CODE');
  });

  it('🔴 refreshing the code is a real recovery — the burned PC pairs again on its new code', () => {
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    const wrong = otherCode(pc.short_code);
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET; i++) thrownCode(() => reg.resolvePcForPair({ short_code: wrong }));
    expect(reg.isCodeActive(pc.id)).toBe(false);

    const fresh = reg.refreshShortCode(pc.id);
    const { mobile } = reg.pairMobile({ short_code: fresh, mobile_name: 'P-0001' });
    expect(mobile.pc_device_id).toBe(pc.id);
  });

  it('malformed guesses do NOT spend the budget — junk must not be able to burn a code for free', () => {
    // Reachability matters here: these throw BEFORE the code space is probed
    // (registry.resolvePcForPair's format gate), so charging them would hand an
    // attacker a cheaper burn than a real guess.
    const reg = registry();
    const { pc } = reg.registerPc({ device_name: 'office-pc', user_id: 'u1', client_instance_id: 'inst-1' });
    for (let i = 0; i < SHORT_CODE_FAILURE_BUDGET * 3; i++) {
      expect(thrownCode(() => reg.resolvePcForPair({ short_code: 'abcd' }))).toBe('PAIR_INVALID_CODE');
      expect(thrownCode(() => reg.resolvePcForPair({ qr_payload: 'flowmic://pair?nope' }))).toBe(
        'PAIR_INVALID_PAYLOAD',
      );
    }
    const { mobile } = reg.pairMobile({ short_code: pc.short_code, mobile_name: 'P-0001' });
    expect(mobile.pc_device_id).toBe(pc.id);
  });
});

describe('IT-39 ② socketIp() empty-value collapse bucket — recorded, not fixed', () => {
  it('the derivation really does produce `` when there is no address to derive', () => {
    // This is the value both socketIp() definitions hand the limiter as a key.
    // `|| ''` in those functions folds a present-but-empty address onto the same
    // key, so there is exactly ONE unidentifiable bucket, not several.
    expect(clientIpFromHandshake(undefined, ['127.0.0.1'])).toBe('');
    expect(clientIpFromHandshake({}, ['127.0.0.1'])).toBe('');
    expect(clientIpFromHandshake({ address: '' }, ['127.0.0.1'])).toBe('');
  });

  it('🔴 every unidentifiable client SHARES ONE budget — 10 failures / 60 s between them all, not each', () => {
    let t = 0;
    const lim = new PairRateLimiter({ now: () => t });
    const emptyKey = clientIpFromHandshake(undefined, []); // '' — derived, not typed
    let allowed = 0;
    // 40 distinct callers (distinct socket ids, so the per-socket layer never
    // fires) that all failed to yield an address.
    for (let i = 0; i < 40; i++) {
      if (lim.check(`sock-${i}`, emptyKey).allowed) allowed++;
      lim.recordFailure(`sock-${i}`, emptyKey);
      lim.forget(`sock-${i}`); // the disconnect edge, verbatim
    }
    // Fail-SAFE direction: becoming unidentifiable buys no fresh budget.
    expect(allowed).toBe(PAIR_IP_MAX_FAILURES);

    // CONTROL — identical spray with a real address each. All 40 land, which is
    // the fail-HARSH direction stated as a number: what these callers lose by
    // sharing a key is 30 of their 40 attempts.
    t = 0;
    const control = new PairRateLimiter({ now: () => t });
    let controlAllowed = 0;
    for (let i = 0; i < 40; i++) {
      if (control.check(`sock-${i}`, `198.51.100.${i}`).allowed) controlAllowed++;
      control.recordFailure(`sock-${i}`, `198.51.100.${i}`);
      control.forget(`sock-${i}`);
    }
    expect(controlAllowed).toBe(40);
  });
});

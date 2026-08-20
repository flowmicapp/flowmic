// GA-08 — `pc:release-mobile { mobile_id?, revoke? }` (HUMAN-AUDIT: pairing/auth).
//
// The card's wire ruling is「additive field, no new event name」: disconnect and
// revoke are two meanings carried by ONE whitelisted event, so the 56-name
// whitelist and its count guard must be provably untouched by this change.
// That, plus the backward-compat property that makes「additive」 true (a
// payload minted by a pre-GA-08 client still parses, and still means
// disconnect), is what this file pins.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:release-mobile);
//           docs/rebuild/05-DATA-MODEL.md §7 (deleting the row IS the revocation);
//           docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-08

import { describe, it, expect } from 'vitest';
import { EVENT_NAME_SET } from '../src/events';
import { safeParseEvent } from '../src/protocol-schemas';
import { ERROR_CODES } from '../src/error-codes';

describe('GA-08 pc:release-mobile — the additive revoke flag', () => {
  it('is additive: the pre-GA-08 payload still parses and means disconnect', () => {
    const legacy = safeParseEvent('pc:release-mobile', { mobile_id: 'm1' });
    expect(legacy.success).toBe(true);
    // `revoke` absent — NOT defaulted to anything. The handler reads
    // `revoke === true`, so absence is the disconnect meaning by construction.
    expect(legacy.success && legacy.data).toEqual({ mobile_id: 'm1' });
    expect(legacy.success && 'revoke' in legacy.data).toBe(false);
  });

  it('round-trips revoke:true / revoke:false verbatim', () => {
    for (const revoke of [true, false]) {
      const parsed = safeParseEvent('pc:release-mobile', { mobile_id: 'm1', revoke });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.revoke).toBe(revoke);
    }
  });

  it('rejects a non-boolean revoke instead of coercing it', () => {
    // A truthy string must NEVER become a permanent revocation by coercion.
    for (const bad of ['true', 1, {}, []]) {
      expect(safeParseEvent('pc:release-mobile', { mobile_id: 'm1', revoke: bad }).success).toBe(false);
    }
  });

  it('adds NO event name (pc:release-mobile grew only FIELDS)', () => {
    // The number moved to 57 in GA-14 (`stt:refined`, owner-approved) and back
    // down to 54 in the 2026-07-31 stage-5 cleanup. What THIS test guards is
    // unchanged either way: pc:release-mobile grew only FIELDS.
    //
    // 🔴 2026-08-20 — SO THE GLOBAL COUNT ASSERTION IS GONE, AND ITS ABSENCE IS
    // THE FIX. This test had `expect(EVENT_NAMES.length).toBe(54)` directly under
    // a comment saying the count is not what it guards, i.e. it contradicted
    // itself in adjacent lines. It was a SECOND copy of a number whose home is
    // `events-count.test.ts` (CANONICAL_EVENT_COUNT), so it went red today for a
    // reason that has nothing to do with GA-08: owner approved `mobile:released`
    // (54 → 55) for a different card entirely.
    //
    // A duplicated constant that only its owner is expected to update is the same
    // shape as this repo's mirrored-limit gates — except those SWEEP for copies,
    // and this one was a copy nobody knew about until it failed. Deleting it
    // loses no coverage: the count still has exactly one guard, and what is left
    // here is what the test was always about.
    expect(EVENT_NAME_SET.has('pc:release-mobile')).toBe(true);
    for (const invented of ['pc:revoke-mobile', 'pc:disconnect-mobile', 'pc:release']) {
      expect(EVENT_NAME_SET.has(invented as never)).toBe(false);
    }
  });

  it('PAIR_RELEASED is a real bilingual code, distinct from AUTH_TOKEN_INVALID', () => {
    // The distinction is load-bearing: the mobile ladder wipes its pairing on
    // AUTH_TOKEN_INVALID and merely backs off on anything else, which is exactly
    // the difference between disconnect (temporary) and revoke (permanent).
    expect(ERROR_CODES.PAIR_RELEASED.zh_CN.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.PAIR_RELEASED.en.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.PAIR_RELEASED).not.toEqual(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it('GA-29: `reason` is additive and optional — absent parses exactly as before', () => {
    // The pre-GA-29 frame must keep its meaning with no negotiation.
    const legacy = safeParseEvent('pc:release-mobile', { mobile_id: 'm1' });
    expect(legacy.success).toBe(true);
    expect(legacy.success && 'reason' in legacy.data).toBe(false);

    for (const reason of ['manual', 'busy'] as const) {
      const parsed = safeParseEvent('pc:release-mobile', { mobile_id: 'm1', reason });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.reason).toBe(reason);
    }
  });

  it('GA-29: an unknown reason is REFUSED, never coerced to a default', () => {
    // A typo must not silently become 「manual」 and earn a 60 s window the
    // caller never asked for.
    for (const bad of ['BUSY', 'busy ', 'auto', '', 1, null]) {
      expect(safeParseEvent('pc:release-mobile', { mobile_id: 'm1', reason: bad }).success).toBe(false);
    }
  });

  it('GA-29: PC_BUSY is its own bilingual code, distinct from PAIR_RELEASED', () => {
    // Load-bearing: PAIR_RELEASED tells the user someone pressed disconnect. PC_BUSY
    // tells them the machine is taken. Same ladder behaviour, different fact.
    expect(ERROR_CODES.PC_BUSY.zh_CN.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.PC_BUSY.en.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.PC_BUSY).not.toEqual(ERROR_CODES.PAIR_RELEASED);
    expect(ERROR_CODES.PC_BUSY).not.toEqual(ERROR_CODES.AUTH_TOKEN_INVALID);
  });
});

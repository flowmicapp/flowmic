// Window D1 Lane C — billing/paddle/signature.ts, the `Paddle-Signature` verifier.
//
// This is the ONLY thing standing between a public URL and 「free Pro for the
// whole internet」, so every case here is a failure that has actually shipped in
// somebody's integration, not a coverage exercise:
//
//   ① a rotation-period header carries TWO `h1` values, and Paddle's own
//      published Express sample refuses the lot (`parts.length !== 2`);
//   ② `timingSafeEqual` THROWS on unequal lengths — a short h1 must be a 401,
//      not an uncaught exception that becomes a 500;
//   ③ the signed payload is the RECEIVED BYTES, so a body that survives a
//      JSON round-trip unchanged in VALUE must still fail if its BYTES changed;
//   ④ the timestamp window is two-sided (a future stamp is just as unexplainable
//      as an old one);
//   ⑤ 🔴 the secret never appears in anything the function returns.
//
// ⚠️ The expected digest is derived INLINE from node:crypto below, deliberately
// NOT via the module's own `signPaddlePayload`. Signing with the helper and
// verifying with the verifier would only prove the file agrees with itself; it
// would pass just as happily if BOTH sides used the wrong payload format.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPaddlePayload, verifyPaddleSignature } from '../src/billing/paddle/signature';

const SECRET = 'pdl_ntfset_01j0_TESTONLY_not_a_real_secret';
const OTHER_SECRET = 'pdl_ntfset_01j0_ROTATED_other_value_zz';
const BODY = '{"event_id":"evt_1","event_type":"subscription.activated"}';

/** ts=1780000000 → 2026-05-29T…; the exact instant does not matter, only that
 *  the clock and the stamp are related by a number this file controls. */
const TS = 1_780_000_000;
const NOW_MS = TS * 1000;

/** The digest, computed here from the spec sentence 「HMAC-SHA256 of
 *  `${ts}:${rawBody}`, hex」 — not from the module under test. */
function digest(body: string, tsSec: number, secret: string): string {
  return createHmac('sha256', secret).update(`${tsSec}:${body}`).digest('hex');
}

function verify(header: string | undefined, opts: { body?: string; nowMs?: number; toleranceSec?: number } = {}) {
  return verifyPaddleSignature(opts.body ?? BODY, header, SECRET, {
    nowMs: opts.nowMs ?? NOW_MS,
    toleranceSec: opts.toleranceSec ?? 5,
  });
}

describe('paddle signature — the payload format', () => {
  it('accepts a header signed as HMAC-SHA256 of `${ts}:${rawBody}`, hex', () => {
    const v = verify(`ts=${TS};h1=${digest(BODY, TS, SECRET)}`);
    expect(v).toEqual({ ok: true, tsSkewSec: 0 });
  });

  it('the module helper produces exactly that digest (so tests may build valid requests with it)', () => {
    expect(signPaddlePayload(BODY, TS, SECRET)).toBe(digest(BODY, TS, SECRET));
  });

  it('🔴 signs THE BYTES: a value-identical re-serialization does not verify', () => {
    // Same JSON *value*, different bytes (spaces + key order preserved by
    // stringify but whitespace dropped). This is what would happen if the route
    // ever did JSON.parse → JSON.stringify before verifying.
    const spaced = '{ "event_id" : "evt_1", "event_type" : "subscription.activated" }';
    const header = `ts=${TS};h1=${digest(spaced, TS, SECRET)}`;
    // Positive control: against the bytes it was signed over, it passes.
    expect(verify(header, { body: spaced }).ok).toBe(true);
    // And against the re-serialized form of the SAME VALUE, it does not.
    const reserialized = JSON.stringify(JSON.parse(spaced) as unknown);
    expect(reserialized).not.toBe(spaced); // the premise: the bytes really differ
    expect(verify(header, { body: reserialized })).toEqual({ ok: false, reason: 'mismatch', tsSkewSec: 0 });
  });

  it('a body altered by one byte is refused (the tamper case)', () => {
    const header = `ts=${TS};h1=${digest(BODY, TS, SECRET)}`;
    expect(verify(header, { body: `${BODY} ` }).ok).toBe(false);
  });

  it('the wrong secret is refused', () => {
    expect(verify(`ts=${TS};h1=${digest(BODY, TS, OTHER_SECRET)}`)).toEqual({
      ok: false,
      reason: 'mismatch',
      tsSkewSec: 0,
    });
  });
});

describe('paddle signature — ① key rotation puts TWO h1 values in the header', () => {
  it('accepts when ANY h1 matches, whichever position it is in', () => {
    const good = digest(BODY, TS, SECRET);
    const stale = digest(BODY, TS, OTHER_SECRET);
    // Both orders: an implementation that only reads the first (or the last)
    // passes one of these and fails the other.
    expect(verify(`ts=${TS};h1=${good};h1=${stale}`).ok).toBe(true);
    expect(verify(`ts=${TS};h1=${stale};h1=${good}`).ok).toBe(true);
  });

  it('refuses when NO h1 matches — the negative control for the case above', () => {
    const stale = digest(BODY, TS, OTHER_SECRET);
    expect(verify(`ts=${TS};h1=${stale};h1=${stale}`)).toEqual({ ok: false, reason: 'mismatch', tsSkewSec: 0 });
  });

  it('ignores an unknown key rather than refusing the whole header', () => {
    // Paddle adding `h2=` for a future algorithm must not break every webhook.
    expect(verify(`ts=${TS};h1=${digest(BODY, TS, SECRET)};h2=deadbeef`).ok).toBe(true);
  });
});

describe('paddle signature — ② a bad length must not throw', () => {
  it('a short h1 is a mismatch verdict, not an exception', () => {
    // timingSafeEqual throws on unequal buffer lengths. Without the length check
    // this line is an uncaught error → 500 → Paddle retries a request that can
    // never succeed.
    let verdict: ReturnType<typeof verify> | undefined;
    expect(() => {
      verdict = verify(`ts=${TS};h1=abc`);
    }).not.toThrow();
    expect(verdict).toEqual({ ok: false, reason: 'mismatch', tsSkewSec: 0 });
  });

  it('a non-hex h1 of the right length is a mismatch, not a decode accident', () => {
    // 64 characters, none of them hex. Decoding this with Buffer.from(x,'hex')
    // yields an EMPTY buffer — which is how two different garbage values can
    // compare equal. Comparing the ASCII cannot do that.
    expect(verify(`ts=${TS};h1=${'z'.repeat(64)}`).ok).toBe(false);
  });
});

describe('paddle signature — malformed and missing headers are DIFFERENT answers', () => {
  it('names a missing header', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'missing_header' });
    expect(verify('   ')).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('names a header it cannot read, with no skew to report', () => {
    for (const header of ['garbage', 'h1=abc', `ts=${TS}`, 'ts=nope;h1=abc', `ts=${TS};h1=`]) {
      expect(verify(header)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses two DIFFERENT ts values instead of picking one', () => {
    // The ts is part of the signed payload, so two candidates are two payloads;
    // choosing by position would be a guess.
    const good = digest(BODY, TS, SECRET);
    expect(verify(`ts=${TS};ts=${TS + 1};h1=${good}`)).toEqual({ ok: false, reason: 'malformed' });
    // A repeated IDENTICAL ts is not ambiguous and stays acceptable.
    expect(verify(`ts=${TS};ts=${TS};h1=${good}`).ok).toBe(true);
  });
});

describe('paddle signature — ④ the timestamp window is two-sided', () => {
  const header = (tsSec: number) => `ts=${tsSec};h1=${digest(BODY, tsSec, SECRET)}`;

  it('accepts inside the tolerance in both directions', () => {
    expect(verify(header(TS), { nowMs: NOW_MS + 5_000 })).toEqual({ ok: true, tsSkewSec: 5 });
    expect(verify(header(TS), { nowMs: NOW_MS - 5_000 })).toEqual({ ok: true, tsSkewSec: -5 });
  });

  it('🔴 refuses a stamp too far in the PAST', () => {
    expect(verify(header(TS), { nowMs: NOW_MS + 5_001 })).toEqual({ ok: false, reason: 'expired', tsSkewSec: 5.001 });
  });

  it('🔴 refuses a stamp too far in the FUTURE — the half a one-sided check misses', () => {
    expect(verify(header(TS), { nowMs: NOW_MS - 6_000 })).toEqual({ ok: false, reason: 'expired', tsSkewSec: -6 });
  });

  it('honours a configured tolerance rather than a hardcoded 5', () => {
    expect(verify(header(TS), { nowMs: NOW_MS + 30_000, toleranceSec: 60 }).ok).toBe(true);
    expect(verify(header(TS), { nowMs: NOW_MS + 30_000, toleranceSec: 10 }).ok).toBe(false);
  });

  it('an EXPIRED verdict means the signature itself was good — a forged old frame says mismatch', () => {
    // The reason field has to separate 「clocks disagree」 from 「the secret is wrong」, or it is not
    // worth logging. Same instant, same staleness, different secret.
    const forged = `ts=${TS};h1=${digest(BODY, TS, OTHER_SECRET)}`;
    expect(verify(forged, { nowMs: NOW_MS + 60_000 })).toEqual({ ok: false, reason: 'mismatch', tsSkewSec: 60 });
  });
});

describe('paddle signature — ⑤ tsSkewSec is the only ruler for 「why it is occasionally refused」', () => {
  it('is reported on success AND on the failures that have a timestamp', () => {
    const good = `ts=${TS};h1=${digest(BODY, TS, SECRET)}`;
    const bad = `ts=${TS};h1=${digest(BODY, TS, OTHER_SECRET)}`;
    expect(verify(good, { nowMs: NOW_MS + 2_500 })).toHaveProperty('tsSkewSec', 2.5);
    expect(verify(bad, { nowMs: NOW_MS + 2_500 })).toHaveProperty('tsSkewSec', 2.5);
    // …and is ABSENT, not zero, where there was no timestamp to measure.
    // `undefined` says 「there is no timestamp to compare」; a 0 would claim the clocks agreed.
    expect(verify('garbage')).not.toHaveProperty('tsSkewSec');
    expect(verify(undefined)).not.toHaveProperty('tsSkewSec');
  });
});

describe('🔴 paddle signature — the secret never leaves the function', () => {
  it('appears in no verdict, on any branch', () => {
    const verdicts = [
      verify(`ts=${TS};h1=${digest(BODY, TS, SECRET)}`), // ok
      verify(`ts=${TS};h1=${digest(BODY, TS, OTHER_SECRET)}`), // mismatch
      verify(`ts=${TS};h1=abc`), // length mismatch
      verify('garbage'), // malformed
      verify(undefined), // missing
      verify(`ts=${TS};h1=${digest(BODY, TS, SECRET)}`, { nowMs: NOW_MS + 999_000 }), // expired
    ];
    // Positive control FIRST: the branches really were exercised, so 「the secret
    // is absent」 cannot be passing because every verdict is an empty object.
    expect(verdicts.map((v) => (v.ok ? 'ok' : v.reason))).toEqual([
      'ok',
      'mismatch',
      'mismatch',
      'malformed',
      'missing_header',
      'expired',
    ]);
    const serialized = JSON.stringify(verdicts);
    expect(serialized).not.toContain(SECRET);
    // Not even a prefix long enough to be useful.
    expect(serialized).not.toContain(SECRET.slice(0, 16));
  });

  it('a throw from inside would not carry it either (nothing throws at all)', () => {
    // The one branch that CAN throw in a naive implementation is the length
    // mismatch; an exception message built from the buffers would leak the
    // expected digest, which is a secret-derived value.
    for (const header of ['ts=1;h1=a', `ts=${TS};h1=${'0'.repeat(63)}`, 'ts=;h1=;']) {
      expect(() => verify(header)).not.toThrow();
    }
  });
});

// SPEC-REF:
//   apps/server-core/src/billing/creem/signature.ts (every claim in its header
//     is pinned below, including the one that is a WEAKNESS)
//   apps/server-core/test/paddle-signature.test.ts (the sibling this mirrors)
//
// 🔴 THE POINT OF THIS FILE IS THE FOUR REFUSALS BEING FOUR DIFFERENT ANSWERS.
// A verifier that returned `{ok:false}` for everything would pass any test that
// only asserted `ok === false`, and an operator would then be told 「invalid
// signature」 for a missing header, a truncated header, and a wrong secret —
// three different things to go fix.

import { describe, expect, it } from 'vitest';
import { signCreemPayload, verifyCreemSignature, CREEM_SIGNATURE_HEADER } from '../src/billing/creem/signature';

const SECRET = 'whsec_test_2f4a6c8e0b1d3f5a7c9e';
const BODY = JSON.stringify({ id: 'evt_1', eventType: 'subscription.paid', created_at: 1788000000000, object: {} });
const NOW = 1788000000000;

/** Every call goes through the real verifier; only the header varies. */
const verify = (header: string | undefined, body = BODY, secret = SECRET, nowMs = NOW) =>
  verifyCreemSignature(body, header, secret, 5, nowMs);

describe('creem signature — the header name', () => {
  it('is the lower-cased form Node hands us', () => {
    // Pinned because the route reads `req.headers[CREEM_SIGNATURE_HEADER]` and
    // Node lower-cases incoming names: a capitalised constant would look right
    // and match nothing, and the symptom is silence, not an error.
    expect(CREEM_SIGNATURE_HEADER).toBe('creem-signature');
    expect(CREEM_SIGNATURE_HEADER).toBe(CREEM_SIGNATURE_HEADER.toLowerCase());
  });
});

describe('creem signature — accepts what Creem sends', () => {
  it('verifies a header produced over the same bytes and secret', () => {
    expect(verify(signCreemPayload(BODY, SECRET))).toEqual({ ok: true });
  });

  it('tolerates surrounding whitespace', () => {
    expect(verify(`  ${signCreemPayload(BODY, SECRET)}  `)).toEqual({ ok: true });
  });
});

describe('creem signature — the four refusals are four answers', () => {
  it('missing_header: absent, empty, or a non-string', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'missing_header' });
    expect(verify('')).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('malformed: not 64 hex characters', () => {
    // Trap ②: `timingSafeEqual` THROWS on unequal lengths. If the regex guard
    // were removed these would be a 500 — which tells the sender 「retry later」
    // about a request that can never become valid — instead of a 401.
    expect(verify('deadbeef')).toEqual({ ok: false, reason: 'malformed' });
    expect(verify(`${signCreemPayload(BODY, SECRET)}00`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('malformed: right length, but not hex', () => {
    // Trap ③: `Buffer.from(x,'hex')` truncates at the first non-hex character,
    // so if this compared DECODED bytes, `zz…z` and `gg…g` would both become an
    // empty buffer and could compare equal to each other. Comparing the ASCII
    // is what keeps 「not hex at all」 a named refusal.
    expect(verify('z'.repeat(64))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('malformed: upper-case hex is NOT quietly accepted', () => {
    // Creem emits lower-case. Accepting upper-case would widen what we call a
    // valid header on nothing but a guess about a sender we do not control.
    expect(verify(signCreemPayload(BODY, SECRET).toUpperCase())).toEqual({ ok: false, reason: 'malformed' });
  });

  it('mismatch: one flipped byte in the body', () => {
    const header = signCreemPayload(BODY, SECRET);
    expect(verify(header, `${BODY} `)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('mismatch: the wrong secret', () => {
    expect(verify(signCreemPayload(BODY, 'whsec_someone_elses'))).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('mismatch: a well-formed signature of DIFFERENT bytes (replayed header)', () => {
    const other = JSON.stringify({ id: 'evt_2', eventType: 'subscription.canceled', created_at: 1, object: {} });
    expect(verify(signCreemPayload(other, SECRET))).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('creem signature — no separator is invented', () => {
  it('refuses `<goodsig>;anything` instead of splitting it', () => {
    // Trap ① does NOT apply to Creem (no documented rotation form), so nothing
    // is split. If a future change added a split on ';' or ',', this test goes
    // red — which is the point: a splitter would accept a header whose sender
    // only had to get the part before the separator right.
    const good = signCreemPayload(BODY, SECRET);
    expect(verify(`${good};h1=whatever`)).toEqual({ ok: false, reason: 'malformed' });
    expect(verify(`ts=1788000000;h1=${good}`)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('creem signature — 🔴 the weakness, pinned so it cannot be misread', () => {
  it('a body signed for any instant verifies at any other instant', () => {
    // THIS TEST ASSERTS A PROTECTION WE DO NOT HAVE, on purpose.
    //
    // Paddle signs `${ts}:${body}` and ships the ts, so its signature expires.
    // Creem signs the body ALONE, so a captured body is replayable forever and
    // this function is RIGHT to say ok — it is Creem's signature over those
    // bytes. Anyone reading `ok: true` as 「this is happening now」 is wrong, and
    // if someone later adds an expiry check here believing it works, this test
    // turns red and sends them to signature.ts's header, where the actual
    // replay defence (the billing_events primary key) is written down.
    const header = signCreemPayload(BODY, SECRET);
    const tenYears = NOW + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(verifyCreemSignature(BODY, header, SECRET, 5, tenYears)).toEqual({ ok: true });
    expect(verifyCreemSignature(BODY, header, SECRET, 0, 0)).toEqual({ ok: true });
  });

  it('toleranceSec cannot change any verdict', () => {
    const header = signCreemPayload(BODY, SECRET);
    for (const tol of [0, 1, 5, 86_400]) {
      expect(verifyCreemSignature(BODY, header, SECRET, tol, NOW)).toEqual({ ok: true });
    }
  });
});

describe('creem signature — the secret never leaves the function', () => {
  it('appears in no verdict, on either arm', () => {
    // Positive control FIRST, so this cannot pass by serializing an empty
    // object: prove the serialization actually contains something, then prove
    // it does not contain the secret.
    const good = JSON.stringify(verify(signCreemPayload(BODY, SECRET)));
    const bad = JSON.stringify(verify('00'.repeat(32)));
    expect(good).toContain('true');
    expect(bad).toContain('mismatch');
    expect(good).not.toContain(SECRET);
    expect(bad).not.toContain(SECRET);
  });
});

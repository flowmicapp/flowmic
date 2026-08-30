// SPEC-REF:
//   apps/server-core/src/billing/paddle/signature.ts (the sibling; three of its
//     four traps apply here verbatim and are cited by number below)
//   apps/server-core/src/billing/webhook-types.ts (SigVerdict / SigFailReason)
//   https://docs.creem.io/code/webhooks — 「Creem signature is sent in the
//     `creem-signature` header … generated using the HMAC-SHA256 algorithm with
//     the webhook secret as the key, and the request payload as the message」
//     (read 2026-08-29)
//   CLAUDE.md red line: no silent failure
//   *** HUMAN-AUDIT SENSITIVE (billing / crypto) — reviewable in isolation ***
//
// Creem's `creem-signature` header, verified. A PURE function over
// (rawBody, header, secret) — no io, no logging, no config lookup.
//
// THE HEADER: a bare lower-case hex HMAC-SHA256 of the raw body. No timestamp,
// no version tag, no `k=v` structure, no multi-signature rotation form. It is
// the whole header value and nothing else.
//
// ── 🔴 THE ONE THING THAT IS WORSE HERE THAN AT PADDLE, SAID OUT LOUD ───────
//
// PADDLE SIGNS `${ts}:${body}` AND SHIPS THE `ts`. CREEM SIGNS THE BODY ALONE.
// A Paddle signature therefore expires; a Creem signature is valid forever. A
// body captured off the wire today — by anything that ever sees it in the clear:
// a proxy, a log, a WAF, an operator's terminal scrollback — can be POSTed back
// to us in a year and this function will say `ok: true`, correctly, because it
// IS Creem's signature over those bytes.
//
// ⚠️ SO DO NOT READ `ok: true` AS 「THIS EVENT IS HAPPENING NOW」. It means
// 「these bytes were authored by someone holding the webhook secret」 and that is
// all it has ever meant, at either provider. The difference is only that at
// Paddle a second, independent fact (the clock) rode along in the same header
// and here it does not.
//
// 🔴 WHAT ACTUALLY STOPS A REPLAY IS THE IDEMPOTENCY LEDGER, and for Creem that
// stops being hygiene and becomes the security control: `billing_events` has
// `event_id` as its PRIMARY KEY, so the second arrival of any event — honest
// retry or hostile replay — loses the `claimEvent` race and is answered
// 「duplicate」 before a single state write happens. Two consequences that must
// not be traded away by a later change:
//   ① `claimEvent` must stay BEFORE every state write in the pipeline. At
//      Paddle that ordering buys correctness under retries; here it also buys
//      the replay defence, so 「it is only about duplicates」 is no longer a true
//      reason to move it.
//   ② Nothing may be built that PRUNES `billing_events` by age. A retention
//      sweep that dropped rows older than N days would silently re-open the
//      replay window for exactly the events old enough to have leaked. If that
//      table ever needs bounding, the bound has to be 「keep the ids, drop the
//      detail」, not 「drop the row」.
//
// ── TRAPS INHERITED FROM THE PADDLE SIBLING (its numbering) ─────────────────
//
// ② `timingSafeEqual` THROWS on unequal lengths — so a short or garbage header
//    would be an uncaught 500 rather than a 401, and a 500 tells the sender
//    「retry later」 about a request that will never become valid. Length is
//    checked first, and a wrong length is `malformed`, not `mismatch`: they are
//    different operator actions.
//
// ③ COMPARE THE ASCII, NOT THE DECODED BYTES. `Buffer.from(x, 'hex')` silently
//    truncates at the first non-hex character, so two different garbage values
//    can both decode to the same (often empty) buffer and compare EQUAL. The
//    comparison below is over the hex text, and the shape check that precedes
//    it is what makes 「not hex at all」 a named refusal instead of a lucky one.
//
// ① (rotation) DOES NOT APPLY: Creem's header carries exactly one signature and
//    no rotation form is documented. It is therefore NOT split on any separator
//    — inventing one would accept `<goodsig>;anything` from a sender who only
//    ever needs to guess the part before the separator.
//
// ④ (two-sided time window) CANNOT APPLY — see the block above. `toleranceSec`
//    is accepted and ignored, loudly, in one place.
//
// 🔴 THE SECRET NEVER LEAVES THIS FUNCTION. Not in the verdict, not in a
// reason, not in an error message.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SigVerdict } from '../webhook-types';

/** Node lower-cases incoming header names; Creem sends `creem-signature`. */
export const CREEM_SIGNATURE_HEADER = 'creem-signature';

/** A SHA-256 HMAC is 32 bytes ⇒ 64 lower-case hex characters. Anything else is
 *  `malformed` before any comparison is attempted (trap ②). */
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;

/**
 * Verify a `creem-signature` header against the raw body.
 *
 * @param toleranceSec ACCEPTED AND IGNORED. It is on the shared adapter
 *   signature so the pipeline need not know which provider it holds. Ignoring it
 *   is not a silent drop: it is stated here, in the file header, on the adapter
 *   interface, and it is pinned by a test that asserts a wildly stale-looking
 *   body still verifies — because there is no timestamp in a Creem signature to
 *   be stale, and a test that pretended otherwise would be asserting a
 *   protection we do not have.
 * @param nowMs likewise unused; same reason, same pinning.
 */
export function verifyCreemSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  _toleranceSec: number,
  _nowMs: number,
): SigVerdict {
  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, reason: 'missing_header' };
  }

  // Trim only. NOT split, NOT lower-cased-then-reparsed: see trap ① above for
  // why no separator is invented, and the shape test below for why case is not
  // normalised — Creem emits lower-case hex, and quietly accepting upper-case
  // would widen what we call a valid header on nothing but a guess.
  const candidate = header.trim();
  if (!HEX_SIGNATURE.test(candidate)) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  // Both are known-length lower-case hex by construction (`expected` from
  // digest, `candidate` from the regex above), so the lengths are equal and
  // `timingSafeEqual` cannot throw here — trap ② is closed by the regex, not by
  // a try/catch that would hide a future change to it.
  const equal = timingSafeEqual(Buffer.from(candidate, 'ascii'), Buffer.from(expected, 'ascii'));
  return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * The same computation, exposed so tests can produce a header that is valid by
 * construction.
 *
 * 🔴 IT IS THE PRODUCTION FUNCTION'S ONLY INPUT, DELIBERATELY. A test that
 * hand-rolled its own HMAC would be asserting that two implementations agree,
 * and both could be wrong in the same way; a test that hard-coded a hex string
 * would freeze today's bug. What the tests do instead is drive the REAL
 * verifier with this, and prove the negative arms by mutating one byte.
 *
 * ⚠️ Not exported from the package index and not called by any production path
 * — `grep -rn signCreemPayload apps/server-core/src` must only ever find this
 * definition and test files.
 */
export function signCreemPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

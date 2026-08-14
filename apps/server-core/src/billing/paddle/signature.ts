// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §5.2 (this signature —
//     the type and all five requirements are verbatim from there)
//   CLAUDE.md red line: no silent failure; human review for four sensitive-path
//     classes (billing)
//   *** HUMAN-AUDIT SENSITIVE (billing / crypto) — reviewable in isolation ***
//
// Paddle's `Paddle-Signature` header, verified. A PURE function over
// (rawBody, header, secret, clock) — no io, no logging, no config lookup — so
// every branch below is reachable from a unit test, which is the only way the
// four failure reasons can be proven to be four DIFFERENT answers rather than
// one 401 wearing four labels.
//
// THE HEADER: `ts=<unix-seconds>;h1=<hex>`, and the signed payload is
// `${ts}:${rawBody}` HMAC-SHA256'd with the notification-destination secret.
//
// ── FOUR PLACES THE OBVIOUS IMPLEMENTATION IS WRONG ────────────────────────
//
// ① `h1` CAN APPEAR MORE THAN ONCE. Paddle emits every active secret's
//    signature during a key rotation, so the header legitimately reads
//    `ts=…;h1=…;h1=…`. Paddle's own published Express sample splits the header
//    and bails on `parts.length !== 2`, which means that sample REFUSES EVERY
//    WEBHOOK for the whole rotation window. Any one match is a match here.
//
// ② `timingSafeEqual` THROWS on unequal lengths. The same published sample
//    calls it without a length check, so a header carrying a short/garbage h1
//    turns into an uncaught throw — a 500, not a 401. A 500 tells Paddle
//    「retry later」 about a request that will never become valid.
//
// ③ COMPARE THE ASCII, NOT THE DECODED BYTES. `Buffer.from(x, 'hex')` silently
//    truncates at the first non-hex character, so two different garbage values
//    can both decode to the SAME (often empty) buffer. Decoding turns a
//    comparison into a lossy one; comparing the hex text does not.
//
// ④ THE TIMESTAMP WINDOW IS TWO-SIDED. A timestamp far in the FUTURE is just as
//    unexplainable as an old one, and only checking one side leaves a replay
//    window that grows without bound in the other direction.
//
// 🔴 THE SECRET NEVER LEAVES THIS FUNCTION. It is not in the verdict, not in a
// reason, not in an error message. `test/paddle-signature.test.ts` asserts that
// on the serialized verdict, with a positive control so the assertion cannot
// pass by testing an empty object.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Why a header was refused. Four values because they are four different
 *  operator actions: fix the sender / fix the header / fix the clock / the
 *  bytes or the secret are wrong. */
export type SigFailReason = 'missing_header' | 'malformed' | 'expired' | 'mismatch';

export type SigVerdict =
  | { ok: true; tsSkewSec: number }
  /**
   * ⚠️ `tsSkewSec` on the FAILURE arm is ADDITIVE to D1 §5.2's declared type,
   * which lists only `{ ok, reason }`. §5.2's own requirement ⑤ says the skew is
   * "always returned" and is "the only ruler for lining up why we occasionally
   * refuse" — a number that is
   * withheld from exactly the responses that need explaining would be no ruler
   * at all. Optional rather than required because two of the four reasons
   * (`missing_header`, `malformed`) have no timestamp to measure: `undefined`
   * there is 「there was no ts to compare」, which is a different statement from
   * 「the skew was 0」.
   */
  | { ok: false; reason: SigFailReason; tsSkewSec?: number };

/** Parsed header parts. `h1` keeps EVERY value, in order (see ① above). */
interface ParsedHeader {
  ts: number;
  h1: string[];
}

/** `ts=…;h1=…;h1=…` → parts, or null when the header cannot be read.
 *
 *  Rejects a header carrying two DIFFERENT `ts` values rather than picking one:
 *  the timestamp is part of the signed payload, so two candidates would mean two
 *  different payloads, and choosing between them by position is a guess. */
function parseHeader(header: string): ParsedHeader | null {
  const h1: string[] = [];
  let ts: number | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value === '') continue;
    if (key === 'ts') {
      if (!/^\d{1,15}$/.test(value)) return null;
      const parsed = Number(value);
      if (ts !== null && ts !== parsed) return null;
      ts = parsed;
    } else if (key === 'h1') {
      h1.push(value);
    }
    // Any other key is ignored ON PURPOSE: Paddle may add `h2` for a future
    // algorithm, and refusing an unknown key would make every webhook fail the
    // day they do. An unknown key can never make a bad signature good — the
    // verdict still rests entirely on an h1 that matches.
  }
  if (ts === null || h1.length === 0) return null;
  return { ts, h1 };
}

export function verifyPaddleSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: { nowMs: number; toleranceSec: number },
): SigVerdict {
  if (header === undefined || header.trim() === '') {
    return { ok: false, reason: 'missing_header' };
  }
  const parsed = parseHeader(header);
  if (parsed === null) {
    return { ok: false, reason: 'malformed' };
  }

  // Signed exactly as Paddle signs it: the timestamp, a colon, then THE BYTES
  // WE RECEIVED. Never a re-serialized object — `JSON.parse` + `JSON.stringify`
  // reorders nothing but reformats everything (whitespace, unicode escapes,
  // number formatting), and one changed byte is one dead signature.
  const expected = createHmac('sha256', secret).update(`${parsed.ts}:${rawBody}`).digest('hex');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const matched = parsed.h1.some((candidate) => {
    const candidateBytes = Buffer.from(candidate, 'utf8');
    // Length FIRST — see ② above. timingSafeEqual throws on a mismatch, and the
    // length of a hex digest is public anyway (it is always 64 characters), so
    // leaking it costs nothing that was ever secret.
    if (candidateBytes.length !== expectedBytes.length) return false;
    return timingSafeEqual(candidateBytes, expectedBytes);
  });

  // Skew is computed for BOTH outcomes and is signed: positive = the stamp is in
  // our past (we are late, or the clock is behind), negative = it is in our
  // future. The sign is the whole diagnostic — an unsigned 「off by 7s」 cannot
  // tell 「our VPS clock drifted」 from 「someone is replaying」.
  const tsSkewSec = Math.round((opts.nowMs / 1000 - parsed.ts) * 1000) / 1000;

  // ⚠️ HMAC BEFORE WINDOW, deliberately, and it is the one ordering choice here
  // that D1 §5.2 does not pin (it lists five requirements, not a sequence).
  // Reporting `expired` only for a CORRECTLY SIGNED frame makes that reason
  // mean one thing: 「the bytes and the secret are right, the clock is not」 —
  // an operator can act on that. Checked the other way round, `expired` would
  // also swallow every unsigned probe that happened to carry an old ts, and the
  // one genuinely actionable failure would be hiding inside the noise.
  if (!matched) {
    return { ok: false, reason: 'mismatch', tsSkewSec };
  }
  if (Math.abs(tsSkewSec) > opts.toleranceSec) {
    return { ok: false, reason: 'expired', tsSkewSec };
  }
  return { ok: true, tsSkewSec };
}

/** The signature a sender must produce for these bytes at this timestamp.
 *
 *  PRODUCTION HAS NO CALLER FOR THIS — we never send a Paddle webhook, we only
 *  receive them. It exists so tests that need a VALID request
 *  (`test/paddle-webhook-route.test.ts`, `test/paddle-webhook-handler.test.ts`)
 *  build one instead of pasting a digest that silently rots the first time the
 *  fixture body changes by a byte.
 *
 *  ⚠️ IT IS NOT AN INDEPENDENT ORACLE, and no test may use it as one: it runs
 *  the same `createHmac(...).update(`${ts}:${body}`)` the verifier runs, so
 *  「helper agrees with verifier」 proves only that the file agrees with itself.
 *  `test/paddle-signature.test.ts` therefore derives its expected digest inline
 *  from node:crypto, and that is the test that pins the payload format. */
export function signPaddlePayload(rawBody: string, tsSec: number, secret: string): string {
  return createHmac('sha256', secret).update(`${tsSec}:${rawBody}`).digest('hex');
}

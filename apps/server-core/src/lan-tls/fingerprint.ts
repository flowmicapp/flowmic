// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-3 (pin the SPKI;
//     base64url, truncated, and it may contain neither ',' nor '&')
//
// The one definition of "the fingerprint" — the string that rides the pairing QR
// as `fp=` and that the phone recomputes from the certificate the server serves.
//
// 🔴 TRUNCATE THE DIGEST, NOT ITS TEXT. The obvious shortening —
// `sha256(spki).toString('base64url').slice(0, N)` — is wrong for this job even
// though it looks identical from the server's side. This value has to be
// reproduced INDEPENDENTLY, in Dart, on a phone (card D2LAN-B3). A base64 text
// prefix cuts through the middle of a byte whenever N is not a multiple of 4, so
// the second implementation has to agree about a partial byte to get the same
// string; a BYTE prefix has exactly one obvious implementation in any language:
// hash, take the first FP_BYTES bytes, base64url them. The failure this avoids is
// the expensive kind — two implementations that agree on most inputs.
//
// 🔴 IN-PLACE CORRECTION (2026-08-09, W4A, card D2LAN-B3 — measured, and it
// corrects the person who handed the rule down, not the person who implemented
// it). The red line above is TRUE but DORMANT at today's value, and the original
// wording reads as though it were active. At FP_BYTES = 18 the digest prefix
// encodes to exactly 24 base64url characters, and 24 is a multiple of 4 — so a
// text prefix and a byte prefix CANNOT disagree here. No input distinguishes
// them; a Dart implementation that sliced the string would have passed every
// test we could write.
//
// It becomes live the moment FP_BYTES stops being a multiple of 3. Demonstrated
// rather than argued: at FP_BYTES = 16 the two approaches diverge, which is how
// this correction was established [measured].
//
// ⇒ Whoever changes FP_BYTES must read this block FIRST. Today the rule costs
// nothing to honour and buys nothing; on the day that constant moves it silently
// becomes the difference between two implementations that agree on most inputs
// and two that agree on all of them. Keep the byte-prefix form regardless — it is
// free insurance against a change nobody will remember to re-audit.
//
// 🔴 Why the alphabet matters here and not merely aesthetically: `qrAltHosts`
// (apps/desktop/src/lib/pairing.ts) already refuses any host containing ',' or
// '&', because the QR payload is a flat string the phone splits on those. The
// base64url alphabet is A–Z a–z 0–9 '-' '_' and, at a multiple of 3 input bytes,
// carries no '=' padding either — so this encoding cannot produce a separator by
// construction rather than by a filter someone has to remember to apply.

import { createHash } from 'node:crypto';

/** Bytes of the SHA-256 digest that survive into the QR.
 *
 *  18 bytes = 144 bits, encoding to exactly 24 base64url characters with no
 *  padding (18 is divisible by 3). The relevant attack is SECOND preimage — an
 *  attacker must produce a key pair whose SPKI hashes into this same prefix — so
 *  144 bits is the security level, not the 72 bits of collision resistance that
 *  a birthday bound would suggest. (A collision needs two keys the ATTACKER
 *  chose; it buys nothing against a fingerprint the victim's PC already minted
 *  and published.)
 *
 *  The size is bounded from the other side too: the payload is a picture that has
 *  to scan off a monitor from a phone held in someone's hand, which is the same
 *  budget QR_ALT_MAX is spending — 24 characters is roughly one and a half extra
 *  LAN addresses' worth. Full hex (64 chars) was rejected for exactly that. */
export const FP_BYTES = 18;

/** Base64url characters a [FP_BYTES]-byte prefix produces. Derived, not asserted
 *  separately, so the two numbers cannot drift. */
export const FP_CHARS = (FP_BYTES / 3) * 4;

/** The published fingerprint of a DER SubjectPublicKeyInfo. */
export function spkiFingerprint(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest().subarray(0, FP_BYTES).toString('base64url');
}

/** Shape check for a fingerprint read back from a QR / config.
 *
 *  Deliberately NOT used to decide whether a connection is trusted — that is the
 *  phone's pin comparison. This only answers "does this string look like a
 *  fingerprint" (这个串长得像不像一枚指纹) so a
 *  malformed one can be refused where it is read rather than silently compared
 *  and never matching. */
export function isWellFormedFingerprint(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${FP_CHARS}}$`).test(value);
}

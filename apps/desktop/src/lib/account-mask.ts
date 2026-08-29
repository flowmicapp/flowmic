// SPEC-REF:
//   owner 2026-08-27:「所有显示账号的地方都要用星号遮盖」— EVERY render site
//     shows the masked form; no full address is painted anywhere on a client.
//   owner, final adjustment (this is the rule below):「首三位 + 末一位，中间固定
//     星号」— three characters in front and one at the back.
//   apps/mobile/lib/src/auth/account_mask.dart — THE SAME RULE, and the phone
//     got it first. This file is its mirror, not a second design.
//
// The ONE function that turns a signed-in account into something the desktop may
// paint. Pure, synchronous, no imports: the whole point is that every render
// site calls it and none of them gets its own opinion.
//
// 🔴 THIS RULE CHOSE DISTINGUISHABILITY OVER SECRECY, ON PURPOSE.
// An earlier cut of this card showed one character (`b***@gmail.com`). It is
// more private and it fails the question the card exists to answer: a user with
// `bill@gmail.com` and `billing@gmail.com` reads the same line for both, so the
// screen still does not tell them which account they are signed in with. Three
// in front and one at the back is what makes those two lines different. Stated
// here because the tempting "improvement" is to hide more, and hiding more walks
// straight back into the defect.
//
// 🔴 WHY A FIXED-WIDTH `***` AND NOT ONE STAR PER HIDDEN CHARACTER.
// A mask that grows with the address leaks the address's LENGTH, and length is
// what makes a short account guessable from over a shoulder (`bit***a@…` vs
// `bit**********a@…`). Three stars, always. It also bounds the rendered width,
// which matters on a card that has to fit beside a plan badge.
//
// 🔴 THE DOMAIN IS SHOWN IN FULL, DELIBERATELY. The question is 「which of my
// accounts is this」, and for a person with a work address and a personal one the
// domain IS the answer. Hiding it would produce a line that is private and
// useless.
//
// ⚠️ WHAT THIS IS NOT. It is not anonymisation and must never be cited as such:
// anyone who already knows the address can confirm it from the mask. It defends
// against a shoulder, a screenshot and a screen share — the three ways this
// string actually leaves the machine. (A desktop adds a fourth this file cannot
// help with: the screen is often the one being shared in a meeting, which is
// the strongest argument for the rule and the weakest for calling it privacy.)
//
// 🔴 THE RULE IS 「EVERY PLACE THAT PAINTS IT」, NOT 「EVERY PLACE THAT READS IT」.
// The phone's copy of this header names two call sites that must never be masked
// because they are KDF INPUT — masking them would derive a different key and
// every already-sealed record would stop opening. A later sweep for 「places that
// read the account email」 hits render sites and key material the same way, so
// the distinction is written down rather than left to be recognised.
// `account-mask.test.ts` pins the desktop's own answer to that question.

/** The hidden middle. Fixed width by rule (see the header); a caller that wants
 *  a different one is a caller that wants a different rule. */
const MASK_BODY = '***';

/**
 * The shortest local part that still gets the 「first three + last one」 face.
 *
 * Five, and the number is the boundary rather than a preference: at four the two
 * rules would show `abc***d` for `abcd` — every character of the address, with
 * decoration. Below the boundary the mask degrades to one character, which is
 * the only honest thing left to show.
 */
const MIN_LOCAL_FOR_TAIL = 5;

/**
 * `bitbalabala@gmail.com` → `bit***a@gmail.com`.
 *
 * The rule, stated so a test can be written from this paragraph alone:
 *   1. `null`, `undefined`, empty or all-whitespace in ⇒ empty out. There is no
 *      account, and inventing `***@***` would paint an identity that does not
 *      exist.
 *   2. The address splits at its LAST `@` — `a@b@example.com` is a local part
 *      containing an `@`, and splitting at the first one would show more of it
 *      than the rule allows.
 *   3. A local part of {@link MIN_LOCAL_FOR_TAIL} characters or more keeps its
 *      FIRST THREE and its LAST ONE, with {@link MASK_BODY} between them.
 *   4. A shorter local part keeps its FIRST CHARACTER only, then the mask.
 *      `a@x.io` → `a***@x.io`: the mask cannot hide a character that is the
 *      whole answer to 「which account」, and `***@x.io` would hide nothing an
 *      observer could not already infer.
 *   5. The domain, `@` included, is copied through verbatim.
 *   6. A string with no `@` at all is treated as a bare local part
 *      (`someone` → `som***e`). It is not a valid address, but it IS what the
 *      server sent us, and rendering it verbatim would be the one case where the
 *      mask silently stops masking.
 *
 * ⚠️ CHARACTERS ARE COUNTED AS CODE POINTS — `Array.from`, never `.length` or
 * `.slice`. A JS string is UTF-16, so `'😀abc'.slice(0, 3)` cuts an astral
 * character in half and renders a lone surrogate as `�`. A combining mark counts
 * as its own character: the measured cost of not taking a grapheme dependency
 * for this, and harmless — the result is a slightly shorter or longer visible
 * half, never a broken glyph. The phone's copy makes the same trade, in the same
 * words, so the two clients cannot drift on it.
 */
export function maskAccountEmail(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return '';
  const at = value.lastIndexOf('@');
  const local = at < 0 ? value : value.slice(0, at);
  const domain = at < 0 ? '' : value.slice(at);
  const cp = Array.from(local);
  if (cp.length >= MIN_LOCAL_FOR_TAIL) {
    return `${cp.slice(0, 3).join('')}${MASK_BODY}${cp[cp.length - 1]}${domain}`;
  }
  const head = cp.length === 0 ? '' : cp[0];
  return `${head}${MASK_BODY}${domain}`;
}

// SPEC-REF:
//   docs/decisions/2026-08-12-password-policy-medium-complexity.md §1 (the ruled
//     values: min 10 CODE POINTS, at least 2 of 3 character classes, max 32,
//     no blacklist, no retroactive enforcement) and §4-1 (the shared vector
//     table both repos implement)
//   *** HUMAN-AUDIT SENSITIVE (auth: credential policy) — reviewable in isolation ***
//
// The ONE declaration of what makes an account password acceptable. Four
// enforcement points read it — `register` and `setPassword` (auth-service.ts),
// `POST /api/password/reset` (http/password-reset-routes.ts), and
// `POST /api/account/password` (http/account-password-routes.ts) — and
// verify/lint/password-policy-mirror.mjs pins the two numbers against the
// hand-written copy in `@flowmic/web`, which is a separate git repo and cannot
// import this file.
//
// ── WHY A LEAF MODULE RATHER THAN TWO MORE EXPORTS ON auth-service.ts ───────
// `http/password-reset-routes.ts` imports auth-service TYPE-ONLY today
// (`import type { AuthService }`), which erases at compile time. Reading the
// policy off auth-service would convert that into a real runtime import edge
// from the HTTP layer into the audited credential service, in exchange for two
// integers and a pure function. This file imports nothing, so a reader of the
// policy gets the policy and nothing else and can audit it in isolation — the
// same property auth-service.ts's own file header claims for itself.
//
// ── 🔴 THE MEASURE IS CODE POINTS, AND IT IS NOT A DETAIL ──────────────────
// `[...pw].length`, never `pw.length`. The two disagree on every astral
// character, in BOTH directions, and each direction flips a real verdict:
//   · "😀😀😀😀😀1" — 6 code points (REJECTED, too short) but 11 UTF-16 units
//     (a UTF-16 measure would ACCEPT it);
//   · 16 emoji + a digit — 17 code points (ACCEPTED) but 33 UTF-16 units
//     (a UTF-16 measure would REJECT it, over the 32 cap).
// Both cases are pinned in test/password-policy.test.ts. This matters across
// repos and not merely here: the mirror lint can only compare the NUMBERS. It
// cannot see which measure either side used, cannot see the class regexes, and
// must never be read as "the two ends agree" (ruling §3, final paragraph). The
// equivalence that the lint cannot carry is carried by the shared vector table,
// implemented once here and once in @flowmic/web.
//
// ── 🔴 WHAT DELIBERATELY DOES NOT VALIDATE COMPLEXITY: LOGIN ───────────────
// `verifyCredentials` compares a scrypt hash and asks nothing about the shape
// of the password. That is the "no retroactive enforcement" half of the ruling (§1, §4-2 item 1):
// an account created under the old 8-character minimum keeps working until its
// owner changes it. Adding a policy check to the login path would lock those
// users out of their own accounts, so the absence of an import here is the
// feature; test/password-policy.test.ts pins it as an executable fact rather
// than leaving it as a sentence in a comment.

/** Minimum account password length, in CODE POINTS (ruling §1).
 *  Mirrored by hand in `@flowmic/web`; verify/lint/password-policy-mirror.mjs
 *  locates this declaration BY NAME and requires a plain integer literal, so it
 *  must stay a one-line literal — never a computed value or an object field. */
export const MIN_PASSWORD_LENGTH = 10;

/** Maximum account password length, in CODE POINTS.
 *  Human-scale ceiling (password-manager 32-char secrets still fit).
 *  Same mirror and same literal-shape requirement as the minimum. */
export const MAX_PASSWORD_LENGTH = 32;

/** How many of the three character classes a password must use (ruling §1).
 *  Not currently mirrored in @flowmic/web — per the C9 doctrine a mirror is
 *  registered when someone writes one, never because one "should" exist. If the
 *  web side does hand-copy it, the mirror lint's unregistered-copy sweep says
 *  so and the fix is one row in that lint's registry. */
export const MIN_PASSWORD_CLASSES = 2;

/**
 * The three classes, per ruling §1: letters, digits, and everything else
 * (symbols, punctuation, whitespace).
 *
 * 🔴 `\p{L}` COVERS HAN, KANA AND HANGUL, and the product consequence is
 * deliberate rather than overlooked (ruling §1, the red note): a
 * pure-Chinese password counts as ONE class and still needs a digit or a
 * symbol. That burden is identical to the one a pure-English password carries.
 * It is written down here so the next reader does not file it as a bug.
 */
export type PasswordCharClass = 'letter' | 'digit' | 'other';

const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{N}/u;

/**
 * Classify ONE code point. `\p{N}` rather than `\p{Nd}` is the ruled spelling,
 * so Roman numerals and circled digits count as digits — a wider net than
 * ASCII 0-9, and the wider net is the safe direction here (it can only ever
 * move a character out of "other", never invent a class a password lacks).
 *
 * An unpaired surrogate matches neither property and lands in "other". It
 * cannot make a password pass that would otherwise fail on length, and it is
 * unreachable through JSON anyway, so it is classified rather than rejected.
 */
export function classifyPasswordChar(codePoint: string): PasswordCharClass {
  if (LETTER_RE.test(codePoint)) return 'letter';
  if (DIGIT_RE.test(codePoint)) return 'digit';
  return 'other';
}

/** Password length in CODE POINTS — the ruled measure. Never `pw.length`. */
export function passwordCodePointLength(password: string): number {
  return [...password].length;
}

/** How many distinct classes a password uses (0-3). */
export function countPasswordCharClasses(password: string): number {
  const seen = new Set<PasswordCharClass>();
  // Iterating a string with for-of walks CODE POINTS, matching the measure
  // above — a `for (let i…)` loop here would split every emoji into two
  // "other" halves and silently disagree with passwordCodePointLength.
  for (const codePoint of password) {
    seen.add(classifyPasswordChar(codePoint));
    if (seen.size === 3) break;
  }
  return seen.size;
}

/** Which rule a password broke — so the 400 can name it instead of saying
 *  "invalid". Ruling §2-3: a refusal that cannot say WHICH rule failed turns a
 *  solvable problem into an unsolvable one. */
export type PasswordPolicyRule = 'min_length' | 'max_length' | 'char_classes';

/**
 * A verdict carries the broken rule AND a field-agnostic requirement phrase.
 * The phrase is field-agnostic on purpose: `register`/`setPassword` complain
 * about "password" and the reset route complains about "new_password", and
 * before this module those two sentences were written out separately — which is
 * how the route came to say "at least 8" while the service meant something
 * else. One phrase, two subjects, no second place to edit.
 */
export type PasswordPolicyVerdict =
  | { ok: true }
  | { ok: false; rule: PasswordPolicyRule; requirement: string };

/**
 * Check a password against the ruled policy.
 *
 * ORDER IS PART OF THE CONTRACT and is pinned by the shared vector table: LENGTH
 * FIRST, classes second. "abcdefghi" (9 letters) breaks both the minimum and the
 * class rule, and ruling §4-1 requires it be reported as a LENGTH failure —
 * telling someone to add a digit to a password that is too short anyway would
 * send them round the loop twice.
 *
 * Accepts `unknown` so the two `typeof … !== 'string'` guards that used to sit
 * beside the length test do not have to be repeated at every call site. A
 * non-string is reported as `min_length`, which is exactly the sentence those
 * guards produced before this module existed (they were spelled
 * `typeof p !== 'string' || p.length < MIN` — one message for both) — so this
 * is behaviour-preserving, not a new answer. Both HTTP entry points funnel
 * through `str()` and cannot deliver a non-string; the guard is for a direct
 * caller of the AuthService interface.
 */
export function checkPasswordPolicy(password: unknown): PasswordPolicyVerdict {
  const minRequirement = `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (typeof password !== 'string') {
    return { ok: false, rule: 'min_length', requirement: minRequirement };
  }
  const length = passwordCodePointLength(password);
  if (length < MIN_PASSWORD_LENGTH) {
    return { ok: false, rule: 'min_length', requirement: minRequirement };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { ok: false, rule: 'max_length', requirement: `must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  if (countPasswordCharClasses(password) < MIN_PASSWORD_CLASSES) {
    return {
      ok: false,
      rule: 'char_classes',
      requirement:
        `must use at least ${MIN_PASSWORD_CLASSES} kinds of character out of ` +
        'letters, digits, and symbols or punctuation',
    };
  }
  return { ok: true };
}

/**
 * The refusal sentence for one field. Callers pass their own field name
 * ("password" / "new_password") so the wire keeps naming the key the caller
 * actually sent, while the requirement half has exactly one author.
 */
export function passwordPolicyMessage(
  field: string,
  verdict: Extract<PasswordPolicyVerdict, { ok: false }>,
): string {
  return `${field} ${verdict.requirement}`;
}

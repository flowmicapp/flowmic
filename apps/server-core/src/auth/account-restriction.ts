// SPEC-REF:
//   docs/strategy/2026-08-12-a2-3-restricted-use-design.md (THE design — §2 the
//     carrier/enforcer split, §3 what the refusal answers, §4 the two carve-outs)
//   docs/decisions/owner-web-rulings/latest.md:71 (owner, verbatim: "'banned' is too
//     authoritative a word, change it to 'restricted use'; once a user is
//     restricted, they can still log in, but only see the restricted-use
//     notice; the user may clear their own data and delete the account; no
//     appeal channel is provided")
//   src/db/schema.ts `users.restricted_at` (the DDL argues the column)
//   src/auth/email-verification.ts (the shape this file copies, one day older)
//   *** HUMAN-AUDIT SENSITIVE (auth: account-level capability policy) ***
//
// "RESTRICTED USE" POLICY — what a restriction is, and the ONE conversion from
// `users.restricted_at` to a verdict.
//
// ── WHAT A RESTRICTION IS, AND WHAT IT IS NOT ───────────────────────────────
// It is NOT a refusal to sign in. owner ruled that a restricted user "can still
// log in" and sees a notice instead of the product, so:
//   · POST /api/login and mobile:login still succeed and still mint a token;
//   · the CARRIER of the state is the `restricted` flag on `publicUser`, which
//     every login ack and every GET /api/me recomputes FROM THE ROW;
//   · the ENFORCER is a per-route refusal, on the server, named out loud.
// Those are two different questions and this file keeps them apart on purpose:
// the client field is a PAINTBRUSH (it decides what to draw), the route check is
// the GATE (it decides what happens). Using the client's copy as the gate is
// this repo's #1 shape — a stale, forgeable, ignorable value deciding access.
//
// 🔴 WHY THE STATE IS NOT IN THE JWT. `issueToken` bakes `{sub, plan, iat, exp}`
// at signing time, the TTL is 7 days, and there is no jti denylist, no session
// table and no refresh store (auth/jwt.ts, http/console-routes.ts §logout). A
// restriction written into claims would therefore take up to SEVEN DAYS to bite
// on somebody who already holds a token — and, worse, would keep asserting a
// restriction that had already been LIFTED. Both directions wrong. The row is
// re-read per request instead (http/account-auth.ts `accountUserFromBearer`
// does a real `getUser` on every Bearer call), which is what makes "the very
// next request recovers once the restriction is lifted" true rather than hoped
// for.

import type { ErrorCode } from '@flowmic/protocol';

/**
 * The refusal every restriction gate answers with — a REGISTERED protocol
 * `ErrorCode` (69th), not an HTTP-local string.
 *
 * 🔴 IT IS A REAL CODE BECAUSE THE OWNER GATE WAS OPENED, NOT BECAUSE IT WAS
 * CONVENIENT. `auth/email-verification.ts` wrote the rule this file obeys,
 * verbatim: 「the day this string needs to reach the PHONE is the day to ask the
 * owner for a real code, not the day to widen this one」. Owner approved adding
 * a code for "restricted use" (owner-web-rulings/latest.md:71 + the design's §8 gate
 * 2); the lead ruled the NAME on 2026-08-12 [owner ratification pending]. The
 * whole argument — the four near-miss codes and the exact lie each would tell,
 * the 28-character constraint, why `ACCOUNT_SUSPENDED` was rejected — lives at
 * the registration in `packages/protocol/src/error-codes.ts`, because that is
 * where the next person adding a code will be standing.
 *
 * ⚠️ RE-EXPORTED HERE, DELIBERATELY, rather than importing `ERROR_CODES` at each
 * gate: this module is 「what a restriction IS」, so the one name a gate needs
 * comes from the same file as the verdict function it calls beside it. The
 * `satisfies ErrorCode` is not decoration — it is what makes a typo, or a
 * rename in the protocol table, a COMPILE error here instead of a 403 body
 * carrying a string no client has copy for.
 *
 * ⚠️ ITS ONLY PRODUCER TODAY is the saas console REST gate
 * (`http/console-routes.ts` `refuseRestricted`). The phone is NOT refused
 * anything yet: its account identity (`mobile:login`) and its day-to-day
 * identity (`mobile:pair` / `mobile:reconnect`) are socket paths this card does
 * not touch, and the pairing path never reads `users` at all. That is a stated
 * hole, reported with the card — not a silent one.
 *
 * 🔴 THE NEAR-MISSES, AND THE EXACT LIE EACH ONE WOULD TELL, so the next reader
 * does not have to re-derive the refusal:
 *   · `AUTH_TOKEN_INVALID` "Token invalid, please pair again." — the token is FINE, and the
 *     phone's reconnect ladder treats this code as 「wipe the pairing」
 *     (error-codes.ts's own note on PAIR_RELEASED), so a REVERSIBLE restriction
 *     would leave IRREVERSIBLE damage the user never asked for;
 *   · `AUTH_LOGIN_FAILED` "Email or password incorrect." — sign-in SUCCEEDED; this sends the
 *     user to reset a password that works;
 *   · `ADMIN_ONLY` "Only an admin can perform this action." — answers the CALLER'S ROLE, not the
 *     account's standing;
 *   · `QUOTA_EXCEEDED` / `PLAN_UPGRADE_REQUIRED` — says 「pay and it goes away」
 *     about a moderation decision with NO appeal channel (owner ⑤). This is the
 *     most dangerous of the four precisely because it reads plausibly;
 *   · the email-verification gate's own refusal (auth/email-verification.ts) —
 *     its correct next action is 「go fetch a code」, i.e. something the user CAN
 *     do. A restriction is the one thing they cannot fix; the two states are
 *     also independently true, which is why console-routes.ts checks this one
 *     FIRST rather than merging them.
 */
export const ACCOUNT_RESTRICTED = 'ACCOUNT_RESTRICTED' satisfies ErrorCode;

/**
 * 🔴 THE one `users.restricted_at` → verdict conversion, and the mirror of
 * `isEmailVerified`'s single-conversion-site discipline. NULL = not restricted;
 * any timestamp = restricted, from that instant.
 *
 * ⚠️ It must never be read as 「how long have they been restricted」 on a
 * user-facing surface: whether the START TIME is shown to the account holder is
 * an open owner question (design §10-Q3), which is exactly why `publicUser`
 * projects a BOOLEAN and not this number.
 */
export function isAccountRestricted(restrictedAt: number | null): boolean {
  return restrictedAt !== null;
}

/** The slice a gate consumes. Structurally satisfied by `AuthService.getUser`
 *  — deliberately the SAME instance every route already verifies Bearers with,
 *  rather than a second reader wired in beside it: two objects answering
 *  "is this account restricted" is how one of them starts admitting what the other
 *  refuses (the argument account-auth.ts makes for `bearerToken`). */
export interface RestrictionReader {
  getUser(id: string): { restricted_at: number | null; restriction_reason: string | null } | null;
}

/**
 * Q2 — the refusal BODY every restriction gate answers with, built in ONE place.
 *
 * owner 2026-08-12 ruled that a restricted user is shown an ENUMERATED reason
 * and that the operator's free text stays in the audit row. Those are two
 * different values living in two different tables (db/schema.ts:
 * `users.restriction_reason` vs `ops_audit_log.detail`), and this function is
 * what makes the separation hold at the last hop: it reads the enumerated
 * column and nothing else, so a gate CANNOT put the operator's note on the wire
 * — not because each gate remembers not to, but because no gate assembles a
 * refusal body at all.
 *
 * 🔴 THE REASON RIDES BESIDE THE CODE, IT DOES NOT REPLACE IT. `error` stays
 * `ACCOUNT_RESTRICTED` on every frame, because that is the value clients
 * dispatch on (the phone's `isTerminalRefusalCode`, the web console's 403
 * interceptor). A per-reason code would have multiplied the one refusal into
 * five and put every one of them in the 28-character name budget for a
 * distinction nothing branches on.
 *
 * 🔴 `reason` IS ABSENT WHEN NONE WAS RECORDED — never `'other'`, never `''`.
 * A restriction applied before this column existed genuinely has no recorded
 * reason, and substituting the catch-all would be telling a specific person a
 * sentence nobody decided about them. The client renders the notice without a
 * reason line; that is the honest degrade.
 *
 * ⚠️ It returns a NEW OBJECT each call rather than a shared constant: the caller
 * hands it straight to `sendJson`/`safeAck`, and a shared literal is one careless
 * mutation away from leaking one account's reason into another's refusal.
 */
export function restrictionRefusalBody(reason: string | null): { error: typeof ACCOUNT_RESTRICTED; reason?: string } {
  return { error: ACCOUNT_RESTRICTED, ...(reason === null ? {} : { reason }) };
}

/**
 * "is this already-authenticated account restricted right now; if so, which
 * sentence do we tell them" — one real
 * row read, per call, answering BOTH halves from the SAME read.
 *
 * 🔴 ONE READ, NOT TWO. A gate that asked `isRestrictedAccount` and then fetched
 * the reason separately would be two reads of a row that an operator can change
 * between them — and the interleaving that loses is the bad one: restricted
 * with no reason, or worse, a reason attached to a `false`. Returning `null` for
 * 「not restricted」 makes the pair unrepresentable.
 */
export function restrictionVerdict(reader: RestrictionReader, userId: string): { reason: string | null } | null {
  const user = reader.getUser(userId);
  if (user === null || !isAccountRestricted(user.restricted_at)) return null;
  return { reason: user.restriction_reason };
}

/**
 * "is this already-authenticated account restricted right now" — one real row read, per call.
 *
 * 🔴 A VANISHED ROW ANSWERS `false`, NOT `true`, and the direction is argued
 * rather than defaulted. This is the opposite of the verification gate, which
 * fails closed on a missing row — and the asymmetry is correct, because the two
 * `false`s are different sentences. There, closing means 「we cannot confirm you
 * verified」, which is true of an absent row. Here, closing would mean 「an
 * operator restricted this account」 — a claim about an event that provably did
 * not happen (R11: a status word must be able to answer "on what basis"). The race it
 * covers (the account was deleted between the Bearer check one line up and this
 * read) is already answered by that Bearer check's own 401 on the NEXT request.
 */
export function isRestrictedAccount(reader: RestrictionReader, userId: string): boolean {
  const user = reader.getUser(userId);
  return user !== null && isAccountRestricted(user.restricted_at);
}

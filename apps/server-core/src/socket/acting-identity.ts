// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (truthful acting-user resolution)
//   apps/server-core/src/auth/middleware.ts `resolveHandshakeJwt` (the writer)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md NR-18
//
// WHY THIS FILE EXISTS — NR-18, ONE VALUE ANSWERING TWO QUESTIONS.
//
// `bootstrap.ts`'s `resolveActingUser` used to decide with a single ternary:
//
//     getAccountAuthError(socket) === 'AUTH_TOKEN_EXPIRED'
//       ? 'AUTH_TOKEN_EXPIRED'
//       : 'AUTH_TOKEN_INVALID'
//
// and that `else` arm answers TWO different facts with one code. The writer is
// `auth/middleware.ts` `resolveHandshakeJwt`, and it records exactly three
// outcomes:
//   · NO `jwt` on the handshake at all  → it RETURNS EARLY and writes nothing,
//     so `getAccountAuthError` reads `null`;
//   · a `jwt` arrived and did not verify → `'AUTH_TOKEN_INVALID'`;
//   · a `jwt` arrived and had expired    → `'AUTH_TOKEN_EXPIRED'`.
// The ternary's `else` swallows the first two into one answer. The sibling
// consumer never did — `pc.handler.ts`'s zombie-room gate branches on
// `accountAuthError !== null` first — so the two readers of the same field
// disagreed about how many states it has.
//
// WHAT THIS FILE CHANGES. It makes the three states SEPARATE AND NAMED at the
// seam, and it routes them through an exhaustive switch so a fourth state
// cannot be added without the compiler asking what it answers.
//
// 🔴 CORRECTION IN PLACE, 2026-09-15 (the owner granted the code the same day).
// This header used to end 「It does NOT change any code that goes out on the
// wire today: the 'absent' arm still answers AUTH_TOKEN_INVALID」, and as of the
// companion protocol commit that is no longer true. 'absent' now answers
// `AUTH_ACCOUNT_REQUIRED`. The original sentence is not kept as a comment here
// because a stale claim about what goes out on the wire is the one kind of
// comment this repo pays for repeatedly; it is preserved in git and in the
// ledger (§35). `test/acting-identity-nr18.test.ts` pins both halves: that the
// states stay apart, and that each one answers its own code.

import type { Socket } from 'socket.io';

import {
  getAccount,
  getAccountAuthError,
  type AccountContext,
  type ActingIdentity,
  type ActingIdentityError,
} from './wire';

/** What this socket carries by way of an ACCOUNT credential — the three failure
 *  states kept apart, because they are three different facts about the caller
 *  and only one of them is a statement about a credential we were given.
 *
 *  `'authenticated'` wins over any recorded error on purpose: an in-session
 *  `mobile:login` sets `account` on a socket whose handshake JWT had already
 *  failed, and that socket IS authenticated. That precedence is unchanged from
 *  the ternary this replaced (`getAccount` was read first there too). */
export type AccountCredential =
  | { state: 'authenticated'; account: AccountContext }
  /** The handshake carried no account credential at all. Nothing was refused —
   *  nothing was presented. */
  | { state: 'absent' }
  /** A credential arrived and did not verify (wrong secret, malformed, forged). */
  | { state: 'rejected' }
  /** A credential arrived, verified, and its window had passed. */
  | { state: 'expired' };

/** Read the three-state fact off the socket. Pure: it only reads `socket.data`
 *  through `wire.ts`'s accessors, which is what lets the states be asserted
 *  without a server (`test/acting-identity-nr18.test.ts`). */
export function accountCredential(socket: Socket): AccountCredential {
  const account = getAccount(socket);
  if (account) return { state: 'authenticated', account };
  const recorded = getAccountAuthError(socket);
  if (recorded === 'AUTH_TOKEN_EXPIRED') return { state: 'expired' };
  if (recorded === 'AUTH_TOKEN_INVALID') return { state: 'rejected' };
  return { state: 'absent' };
}

/** The answer for 'absent', AND THE REASON THIS IS A NAMED CONSTANT RATHER THAN
 *  A STRING IN THE SWITCH BELOW: it is the one line a reader has to find when
 *  they ask 「what do we tell a caller who never signed in」, and the test pins
 *  the switch to it rather than to a literal.
 *
 *  'absent' means: this saas socket never presented an account credential. The
 *  one action that helps is SIGN IN. `AUTH_ACCOUNT_REQUIRED` says exactly that
 *  and claims nothing was refused (owner approved 2026-09-15; registered in
 *  `packages/protocol/src/error-codes.ts`, where the sentences and their
 *  provenance live). Every neighbour that was available before it existed sends
 *  the user somewhere that cannot help, which is why none of them was borrowed
 *  permanently:
 *    · AUTH_TOKEN_INVALID — registered as 「配对凭证已失效，请重新配对。」 /
 *      "Token invalid, please pair again." There is no pairing to redo, and on
 *      `pc:register` the re-pair IS the verb that just failed. This was the
 *      answer up to 2026-09-15, and it was only cheap because no client path
 *      reaches this branch (see the reachability note below).
 *    · AUTH_TOKEN_EXPIRED — asserts a session existed and ran out. It did not,
 *      and both the phone (`mobile_reconnect_flow.dart`) and the desktop
 *      (`socket/pairing.rs`) treat this family as 「this credential is dead,
 *      delete it」 — deleting a credential that was never presented.
 *    · PC_HANDSHAKE_PENDING — answers 「the ack for THIS socket has not landed
 *      yet」, a race. Nothing here is racing; the caller simply has no account.
 *    · AUTH_TOKEN_UNVERIFIABLE — answers 「we could not ask」. We could; there
 *      was nothing to ask about.
 *
 *  ⚠️ IT IS NOT A WIDER `AUTH_TOKEN_INVALID`: a forged or malformed credential
 *  keeps that code and must keep it. The two states are answered separately or
 *  they are not separated at all.
 *
 *  ⚠️ NO FIRST-PARTY CLIENT CAN REACH THIS ARM TODAY — measured on all three
 *  legs, not assumed: the desktop dials the relay only under
 *  `CloudReadiness::Ready` (which requires a key); the phone's
 *  `ConnectionsController.enterCloud` refuses locally with `NOT_LOGGED_IN`
 *  before dialling; and the web target never emits `pc:register` at all
 *  (pinned by `packages/core/src/target/session.test.ts` in the web-client repo,
 *  which asserts zero such frames). So this is a correctness fix, and the day a
 *  client CAN reach it, the phone's own copy table owes this code an arm —
 *  `cloud_strings.dart`'s `cloudError` falls through to `pairError`'s
 *  `default:`, which renders the raw identifier plus 「check your network」.
 *  Recorded in the ledger (§35) rather than pre-empted here: an arm for a code
 *  no path can deliver is a façade. */
export const NO_ACCOUNT_CREDENTIAL_CODE: ActingIdentityError = 'AUTH_ACCOUNT_REQUIRED';

/** The saas half of `bootstrap.ts`'s `resolveActingUser`: a resolved userId, or
 *  the code to ack. Standalone never reaches here — it collapses to
 *  `STANDALONE_USER_ID` one layer up, before this is called. */
export function resolveSaasActingUser(socket: Socket): ActingIdentity {
  const credential = accountCredential(socket);
  switch (credential.state) {
    case 'authenticated':
      return { userId: credential.account.userId };
    case 'expired':
      return { error: 'AUTH_TOKEN_EXPIRED' };
    case 'rejected':
      return { error: 'AUTH_TOKEN_INVALID' };
    case 'absent':
      return { error: NO_ACCOUNT_CREDENTIAL_CODE };
  }
}

// NR-18 — 「no credential at all」 and 「the credential is forged/broken」 were
// answered by ONE error code in `bootstrap.ts`'s `resolveActingUser`. This file
// guards BOTH halves of the disposition, and they are deliberately different
// kinds of assertion:
//
//   ① THE STATES STAY APART. `accountCredential` must report four distinct
//      facts. Reverse control for it is to make 'absent' answer 'rejected'
//      (the exact pre-fix collapse) and watch these assertions fail.
//
//   ② EACH STATE ANSWERS ITS OWN CODE ON THE WIRE. 'absent' answers
//      `AUTH_ACCOUNT_REQUIRED`, 'rejected' keeps `AUTH_TOKEN_INVALID`, and the
//      third assertion below states the inequality directly rather than trusting
//      two spellings to stay different.
//
// 🔴 CORRECTION IN PLACE, 2026-09-15 — the owner granted the code the same day
// the split landed. ② used to read 「THE PLACEHOLDER IS STILL A PLACEHOLDER」 and
// asserted the opposite of what it asserts now: that `AUTH_ACCOUNT_REQUIRED` was
// absent from `ERROR_CODES` and that the switch still answered
// `AUTH_TOKEN_INVALID`. It was built to go red the day somebody registered the
// code without moving the switch, and it did exactly that — this lane's protocol
// commit turned it red and this commit is the half it was waiting for. The old
// assertions are preserved in git, not carried here as comments.
//
// 🔴 WHAT THIS FILE STILL DOES NOT CLAIM. No user has been shown the new
// sentence. Nothing here runs a server, and no first-party client can reach the
// 'absent' arm today (the desktop dials only with a key, the phone refuses
// locally with NOT_LOGGED_IN, the web target emits no `pc:register` at all). This
// is a correctness fix that takes a false sentence off the wire, not a measured
// improvement to something a user saw.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';

import {
  accountCredential,
  resolveSaasActingUser,
  NO_ACCOUNT_CREDENTIAL_CODE,
} from '../src/socket/acting-identity';
import { ERROR_CODES } from '@flowmic/protocol';

/** A socket is only ever read through `wire.ts`'s `socket.data` accessors here,
 *  so the whole decision is testable without a server — the property the module
 *  was extracted for. */
function socketWith(data: Record<string, unknown>): Socket {
  return { data } as unknown as Socket;
}

describe('NR-18 — the account-credential states are three facts, not one', () => {
  it('reports the four states distinctly', () => {
    // 🔴 THE HEART OF THE CARD. `absent` vs `rejected`: the first socket never
    // presented anything (auth/middleware.ts `resolveHandshakeJwt` returns early
    // and writes nothing), the second presented something that failed to verify.
    expect(accountCredential(socketWith({})).state).toBe('absent');
    expect(accountCredential(socketWith({ accountAuthError: 'AUTH_TOKEN_INVALID' })).state).toBe('rejected');
    expect(accountCredential(socketWith({ accountAuthError: 'AUTH_TOKEN_EXPIRED' })).state).toBe('expired');
    expect(accountCredential(socketWith({ account: { userId: 'u-1', plan: 'free', exp: 1 } })).state)
      .toBe('authenticated');
  });

  it('keeps `account` winning over a recorded handshake failure (unchanged precedence)', () => {
    // An in-session `mobile:login` sets `account` on a socket whose handshake JWT
    // had already failed. That socket IS authenticated, and the ternary this
    // replaced read `getAccount` first for the same reason. A refactor that
    // switched the order would sign a logged-in caller out.
    const socket = socketWith({
      account: { userId: 'u-2', plan: 'pro', exp: 2 },
      accountAuthError: 'AUTH_TOKEN_INVALID',
    });
    expect(accountCredential(socket).state).toBe('authenticated');
    expect(resolveSaasActingUser(socket)).toEqual({ userId: 'u-2' });
  });

  it('answers the two credential-bearing failures with their own frozen codes', () => {
    expect(resolveSaasActingUser(socketWith({ accountAuthError: 'AUTH_TOKEN_EXPIRED' })))
      .toEqual({ error: 'AUTH_TOKEN_EXPIRED' });
    expect(resolveSaasActingUser(socketWith({ accountAuthError: 'AUTH_TOKEN_INVALID' })))
      .toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });
});

describe('NR-18 — 「no credential presented」 has its own code now', () => {
  it('routes 「no credential presented」 through the named constant, not a literal', () => {
    // If someone answers 'absent' with an inline string, the switch and the
    // constant part company and this assertion stops meaning anything — so it is
    // written against the constant, which is where a reader looks the answer up.
    expect(resolveSaasActingUser(socketWith({}))).toEqual({ error: NO_ACCOUNT_CREDENTIAL_CODE });
  });

  it('answers it with AUTH_ACCOUNT_REQUIRED, which is registered and bilingual', () => {
    expect(NO_ACCOUNT_CREDENTIAL_CODE).toBe('AUTH_ACCOUNT_REQUIRED');
    // Not a spelling check: this catches the half-done state in the OTHER
    // direction — a switch pointed at a code that is not in the registry reaches
    // a client as a raw identifier (the 0.2.53 shape).
    expect(Object.keys(ERROR_CODES)).toContain('AUTH_ACCOUNT_REQUIRED');
    expect(ERROR_CODES.AUTH_ACCOUNT_REQUIRED.zh_CN.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.AUTH_ACCOUNT_REQUIRED.en.trim().length).toBeGreaterThan(0);
  });

  it('🔴 does not answer it with the code that sends the caller off to re-pair', () => {
    // THE WHOLE CARD, as one assertion. Both of these used to be
    // AUTH_TOKEN_INVALID, whose sentence is 「配对凭证已失效，请重新配对。」 /
    // "Token invalid, please pair again." — and on `pc:register` the pairing is
    // the verb that just failed, so it named the one action that cannot work.
    // Written as an inequality on purpose: a future re-merge of the two states,
    // in either direction, lands here rather than on a name spelling.
    const absent = resolveSaasActingUser(socketWith({}));
    const rejected = resolveSaasActingUser(socketWith({ accountAuthError: 'AUTH_TOKEN_INVALID' }));
    expect(absent).not.toEqual(rejected);
    expect(absent).not.toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(ERROR_CODES.AUTH_TOKEN_INVALID.en).toContain('pair again');
    expect(ERROR_CODES.AUTH_ACCOUNT_REQUIRED.en).not.toContain('pair');
  });
});

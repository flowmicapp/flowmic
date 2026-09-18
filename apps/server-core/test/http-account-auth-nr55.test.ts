// NR-55 — the HTTP leg of NR-18. 「No Bearer at all」 and 「the Bearer is forged」
// left `accountUserFromBearer` as ONE code (`AUTH_TOKEN_INVALID`), whose sentence
// tells a caller who never signed in that their pairing died and sends them to
// redo it. NR-18 closed that collapse on the socket leg on 2026-09-15; this file
// guards the same split on the HTTP leg, and it is deliberately the same shape:
//
//   ① THE SHARED CONSTANT. 'absent' answers `NO_ACCOUNT_CREDENTIAL_CODE` (the
//      ONE source both legs read from `socket/acting-identity.ts`), never an
//      inline string, so the two legs cannot drift about what 「no credential
//      presented」 answers.
//
//   ② THE INEQUALITY, STATED NOT IMPLIED. 'absent' and 'rejected' share a
//      handler, so the assertion that they differ is written as an inequality
//      rather than trusting two spellings to stay different.
//
//   ③ THE TYPE NAIL. The HTTP leg used to declare its OWN `AccountAuthError`
//      (a second, driftable copy of `socket/wire.ts`'s). It now imports the
//      shared table instead; the assertion reads the source so a second
//      declaration cannot silently reappear.
//
// 🔴 WHAT THIS FILE DOES NOT CLAIM. No user has been shown the new sentence, and
// no server is run here — these are the pure decision functions. The wire-level
// proof (a real 401 body carrying the new code) lives in the existing HTTP suites
// (web-room-routes, account-lifecycle, http-user-identity, usage-events, …), which
// assert the SAME code change this card makes.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { ERROR_CODES } from '@flowmic/protocol';

import {
  accountFromBearer,
  accountUserFromBearer,
  adminFromBearer,
  type AccountVerifier,
} from '../src/http/account-auth';
import { NO_ACCOUNT_CREDENTIAL_CODE } from '../src/socket/acting-identity';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');

/** A request with exactly the headers given — the only thing this module reads. */
function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** A verifier that answers 「this is user u-1」 unless a case overrides it. The
 *  user row is cast because this file never projects it — only the id matters. */
function verifier(over: Partial<AccountVerifier> = {}): AccountVerifier {
  return {
    verifyToken: () => ({ ok: true, sub: 'u-1', plan: 'free', exp: 9_999_999_999 }),
    getUser: (id) => ({ id, email: 'a@b.co', display_name: 'A', plan: 'free', password_hash: 'x' }) as never,
    ...over,
  };
}

describe('NR-55 — 「no Bearer presented」 is its own answer on the HTTP leg', () => {
  it('no Authorization header → AUTH_ACCOUNT_REQUIRED, from the shared constant', () => {
    expect(NO_ACCOUNT_CREDENTIAL_CODE).toBe('AUTH_ACCOUNT_REQUIRED');
    expect(accountUserFromBearer(req(), verifier())).toEqual({ ok: false, error: NO_ACCOUNT_CREDENTIAL_CODE });
  });

  it('a non-Bearer scheme (Basic) → AUTH_ACCOUNT_REQUIRED', () => {
    expect(accountUserFromBearer(req({ authorization: 'Basic dXNlcjpwdw==' }), verifier()))
      .toEqual({ ok: false, error: 'AUTH_ACCOUNT_REQUIRED' });
  });

  it('a forged Bearer → AUTH_TOKEN_INVALID, and NOT the absent code', () => {
    const v = accountUserFromBearer(
      req({ authorization: 'Bearer not-a-jwt' }),
      verifier({ verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }) }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('expected a refusal');
    expect(v.error).toBe('AUTH_TOKEN_INVALID');
    // The inequality, stated rather than implied: these two states share a
    // function and shared an answer until this card.
    expect(v.error).not.toBe(NO_ACCOUNT_CREDENTIAL_CODE);
  });

  it('an expired Bearer → AUTH_TOKEN_EXPIRED', () => {
    const v = accountUserFromBearer(
      req({ authorization: 'Bearer expired-jwt' }),
      verifier({ verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_EXPIRED' }) }),
    );
    expect(v).toEqual({ ok: false, error: 'AUTH_TOKEN_EXPIRED' });
  });

  it('a validly-signed token for a since-deleted user → AUTH_TOKEN_INVALID', () => {
    const v = accountUserFromBearer(
      req({ authorization: 'Bearer ghost-jwt' }),
      verifier({ getUser: () => null }),
    );
    // The signature being good is not the same question as the account being real.
    expect(v).toEqual({ ok: false, error: 'AUTH_TOKEN_INVALID' });
  });

  it('adminFromBearer with no header → { status: 401, error: AUTH_ACCOUNT_REQUIRED }', () => {
    expect(adminFromBearer(req(), verifier())).toEqual({
      ok: false,
      status: 401,
      error: 'AUTH_ACCOUNT_REQUIRED',
    });
  });

  it('accountFromBearer (the id-only face) carries the same absent answer', () => {
    expect(accountFromBearer(req(), verifier())).toEqual({ ok: false, error: NO_ACCOUNT_CREDENTIAL_CODE });
  });

  it('🔴 type nail: http/account-auth.ts no longer declares its own AccountAuthError', () => {
    const src = readFileSync(join(SRC, 'http', 'account-auth.ts'), 'utf8');
    expect(src).not.toContain('export type AccountAuthError');
  });

  it('the code is registered and bilingual (not a raw identifier on the wire)', () => {
    expect(Object.keys(ERROR_CODES)).toContain('AUTH_ACCOUNT_REQUIRED');
    expect(ERROR_CODES.AUTH_ACCOUNT_REQUIRED.zh_CN.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES.AUTH_ACCOUNT_REQUIRED.en.trim().length).toBeGreaterThan(0);
  });
});

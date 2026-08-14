// fix-023 (ledger row REG-V) — a malformed registration email must answer with
// an AUTH-face code (REGISTER_EMAIL_INVALID), not the SETTINGS-namespace code
// (SETTINGS_SCHEMA_INVALID) it borrowed until now. The user is mid-registration
// and used to read a sentence about settings being invalid. Owner approved the
// dedicated code on 2026-08-10 (ruling group #5-d,
// docs/decisions/2026-08-10-owner-ruling-requests-from-lan-window.md), and
// fix-019 registered it in packages/protocol/src/error-codes.ts ahead of this
// card, which wires the producer.
//
// SCOPE: this file drives `auth/auth-service.ts`'s `register()` directly — the
// unit this card owns (files_owned: auth/auth-service.ts + this file).
//
// 🔴 CORRECTION (lead, same round, after fix-011 merged). The paragraph that
// stood here said this file "deliberately does NOT drive the change through
// `POST /api/register`", because that route hard-coded `SETTINGS_SCHEMA_INVALID`
// for every RegisterValidationError and belonged to a concurrently in-flight
// card. Both halves of that were true when written and are false now: fix-011
// landed and released the file, and the route now reads `err.code`.
//
// That gap mattered more than it looked. Between the two cards, the code was
// REGISTERED and TAGGED and still could not reach a single user — a registered
// code with no path to a screen is precisely the facade shape this repo hunts,
// and it was live for exactly as long as the two cards were separately in
// flight. The §RIGHT-THROUGH-THE-ROUTE section below is what closes it, and it
// is the assertion that would go red if someone re-literalised that line.
//
// ⚠️ The original paragraph is not preserved verbatim because it named a
// then-current line number; the fact it recorded is kept here instead. Anchor on
// the symbol (`RegisterValidationError` in auth-routes.ts's register catch), not
// on a line — cross-file line numbers rot and then redden an unrelated window.
//
// Also proves, in the SAME file, per the card's own constraints:
//   · the OTHER two register() refusal paths (short password, duplicate email)
//     are byte-for-byte unchanged — this card's scope is the email-shape
//     refusal ONLY, and it must not re-code either of them;
//   · the malformed-email check cannot become a user-enumeration oracle: it is
//     a pure string-shape test that runs BEFORE any UserRepo call, proven here
//     with a repo double that fails the test if touched.

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { tryHandleAuthRoutes, type AuthRoutesDeps } from '../src/http/auth-routes';
import { makeUserRepo, UserConstraintError, type UserRepo } from '../src/db/repos/user.repo';
import {
  makeAuthService,
  RegisterValidationError,
  type AuthService,
  type RegisterInput,
} from '../src/auth/auth-service';
// A4-3 (2026-08-12): the constant moved to auth/password-policy.ts, the one file
// register, setPassword, the reset route and the cross-repo mirror lint all read.
// auth-service deliberately does NOT re-export it — one import path, no alias.
import { MIN_PASSWORD_LENGTH } from '../src/auth/password-policy';

const SECRET = Buffer.from('reg-email-code-test-secret-32-bytes!', 'utf8');

/** A fresh in-memory DB + real UserRepo per test — same shape as
 *  auth-jwt.test.ts's fixture, but via the real INIT_SQL schema
 *  (db/connection.ts openDatabase) rather than a hand-rolled DDL copy, so
 *  there is nothing here that can drift out of step with the real users table. */
function freshService(): AuthService {
  const db = openDatabase(':memory:');
  return makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET });
}

/** Await a register() call that is expected to REJECT, and hand back the
 *  rejection value. If register() unexpectedly resolves, fail loudly with a
 *  named test-bug error rather than let a later assertion fail on `undefined`
 *  with no clue why — the same "never a quiet stub" discipline as
 *  auth-error-echo.test.ts's neverCalled(). */
async function registerRejection(svc: AuthService, input: RegisterInput): Promise<unknown> {
  try {
    await svc.register(input);
  } catch (err) {
    return err;
  }
  throw new Error(`test bug: register(${JSON.stringify(input)}) unexpectedly resolved instead of rejecting`);
}

describe('fix-023 (REG-V): malformed registration email answers REGISTER_EMAIL_INVALID', () => {
  it.each([
    ['no @ at all', 'not-an-email'],
    ['no domain dot', 'a@b'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['bare @, nothing either side', '@'],
  ])('%s (%j) -> RegisterValidationError(field:"email", code:"REGISTER_EMAIL_INVALID")', async (_label, badEmail) => {
    const svc = freshService();
    const err = await registerRejection(svc, { email: badEmail, password: 'longenough123' });
    expect(err).toBeInstanceOf(RegisterValidationError);
    const rve = err as RegisterValidationError;
    expect(rve.field).toBe('email');
    // The point of this card: the new, specific auth-face code —
    expect(rve.code).toBe('REGISTER_EMAIL_INVALID');
    // — and explicitly NOT the settings-namespace code it used to borrow. This
    // is the negative half the card's evidence list asks for by name; without
    // it, a future edit that reverted `code` to the old default would still
    // pass an assertion that only checked `.toBe('REGISTER_EMAIL_INVALID')` on
    // an unrelated, differently-typed field.
    expect(rve.code).not.toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('positive control: a well-formed, unused email still registers (the malformed-shape assertions above are not over-broad)', async () => {
    const svc = freshService();
    const user = await svc.register({ email: 'ok@example.com', password: 'longenough123' });
    expect(user.email).toBe('ok@example.com');
  });
});

describe('fix-023 scope guard: the other register() refusal paths are unchanged', () => {
  it('short password (valid email) -> still RegisterValidationError(field:"password", code:"SETTINGS_SCHEMA_INVALID", same message) — untouched default', async () => {
    const svc = freshService();
    const err = await registerRejection(svc, { email: 'x@y.co', password: 'short' });
    expect(err).toBeInstanceOf(RegisterValidationError);
    const rve = err as RegisterValidationError;
    expect(rve.field).toBe('password');
    expect(rve.message).toBe(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    // Not re-coded: this card's own scope note says recoding the password
    // refusal is a separate, unruled-on question, so it must still carry the
    // class's old default — the one code every RegisterValidationError
    // answered with before this card.
    expect(rve.code).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('duplicate email (NOCASE) -> still UserConstraintError(field:"email") — a different class this card never touches', async () => {
    const svc = freshService();
    await svc.register({ email: 'dup@example.com', password: 'longenough123' });
    const err = await registerRejection(svc, { email: 'DUP@Example.com', password: 'longenough123' });
    expect(err).toBeInstanceOf(UserConstraintError);
    expect((err as UserConstraintError).field).toBe('email');
    // Never the class this card modified — a duplicate-account refusal must
    // never start reporting itself as a RegisterValidationError (that would be
    // a silent behaviour change on a path this card was told to leave alone).
    expect(err).not.toBeInstanceOf(RegisterValidationError);
  });
});

describe('fix-023 enumeration proof: the malformed-email refusal cannot become an existence oracle', () => {
  it('rejects a malformed email WITHOUT calling any UserRepo method — the check is a pure string-shape test that runs before any account lookup', async () => {
    // Every method throws its own distinctly-worded Error if invoked. If the
    // email-shape check ever grew a DB call (directly, or by falling through to
    // the insert()-then-catch path), THIS test would fail with a "must not be
    // called" error instead of matching RegisterValidationError below — the
    // failure mode names exactly which method leaked.
    const spy: UserRepo = {
      insert: () => { throw new Error('test bug: insert() must not be called for a malformed email'); },
      findByEmail: () => { throw new Error('test bug: findByEmail() must not be called for a malformed email — that would make this an existence oracle'); },
      findById: () => { throw new Error('test bug: findById() must not be called'); },
      setPlan: () => { throw new Error('test bug: setPlan() must not be called'); },
      setPassword: () => { throw new Error('test bug: setPassword() must not be called'); },
      setPermanentFree: () => { throw new Error('test bug: setPermanentFree() must not be called'); },
      // A2-3 — the spy is an exhaustive `UserRepo`, so a new method has to be
      // added here too. That is the instrument working: this literal is the one
      // place a reviewer can see, at a glance, the FULL set of things a repo
      // handed to AuthService could do.
      setRestricted: () => { throw new Error('test bug: setRestricted() must not be called'); },
      remove: () => { throw new Error('test bug: remove() must not be called'); },
      listAll: () => { throw new Error('test bug: listAll() must not be called'); },
      // A2-4 — same story as `setRestricted` above: the exhaustive literal is
      // what forced this line, and the ops account list is emphatically a method
      // registration must never reach.
      listPage: () => { throw new Error('test bug: listPage() must not be called'); },
    };
    const svc = makeAuthService({ users: spy, jwtSecret: SECRET });
    const err = await registerRejection(svc, { email: 'still-not-an-email', password: 'longenough123' });
    expect(err).toBeInstanceOf(RegisterValidationError);
    expect((err as RegisterValidationError).code).toBe('REGISTER_EMAIL_INVALID');
  });
});

/** Drive the REAL route handler and hand back the REAL response body.
 *
 *  Deliberately a REAL AuthService over a real in-memory DB rather than a fake
 *  that throws a hand-built error: the claim under test is "the code the service
 *  chose is the code the client reads", and a fake would let this file assert
 *  its own belief about which code the service chooses. The two halves have to
 *  be joined by production code or the join is what goes untested — which is
 *  exactly the gap this section exists to close.
 *
 *  Body delivery mirrors auth-error-echo.test.ts: readJsonBody consumes the
 *  request as a stream, so 'data'/'end' are emitted AFTER the handler attaches
 *  its listeners, and `done` resolves the moment res.end() runs. */
async function postRegister(body: unknown): Promise<{ status: number; body: unknown }> {
  const db = openDatabase(':memory:');
  const deps: AuthRoutesDeps = {
    service: makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET }),
    limiter: new RegisterRateLimiter(),
  };
  const req = new EventEmitter() as IncomingMessage;
  req.url = '/api/register';
  req.method = 'POST';
  const captured: { status: number; body: unknown } = { status: 0, body: null };
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; resolveDone(); },
  } as unknown as ServerResponse;
  expect(tryHandleAuthRoutes(req, res, deps)).toBe(true);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await done;
  return captured;
}

// ── §RIGHT-THROUGH-THE-ROUTE (lead, fix-023's second half) ──────────────────
//
// Everything above proves `auth-service.ts` TAGS the error. That is not the
// claim a user cares about. `POST /api/register`'s catch used to answer with a
// hard-coded `SETTINGS_SCHEMA_INVALID` for every RegisterValidationError, so
// the tag was invisible on the wire and the whole card would have been a
// no-op that measured green.
//
// These two drive the REAL route handler and assert on the REAL response body,
// because that is the only surface a client ever sees. They are a pair on
// purpose: one proves the new code arrives, the other proves the default still
// does. Re-literalising that line would redden the first; widening it to
// answer REGISTER_EMAIL_INVALID for everything would redden the second.
describe('POST /api/register surfaces the error code the service chose', () => {
  it('a malformed email reaches the client as REGISTER_EMAIL_INVALID', async () => {
    const { status, body } = await postRegister({ email: 'not-an-email', password: 'longenough123' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('REGISTER_EMAIL_INVALID');
  });

  it('a short password still reaches the client as SETTINGS_SCHEMA_INVALID (the untouched default)', async () => {
    const { status, body } = await postRegister({ email: 'fine@example.com', password: 'short' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('SETTINGS_SCHEMA_INVALID');
  });
});

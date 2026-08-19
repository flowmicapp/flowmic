// fix-011 — POST /api/register must never hand an unexpected exception's own
// message to an anonymous caller. sqlite text, schema/column names, driver and
// filesystem detail are all fingerprinting material, and this route needs no
// credential to reach (SPEC-REF: apps/server-core/src/http/auth-routes.ts, the
// `catch` block of the POST /api/register handler).
//
// Drives tryHandleAuthRoutes directly against a FAKE AuthService whose
// register() throws on command — no real server/db needed, and the fake hands
// us something a real db failure could not reliably hand us: an exact,
// unmistakable internal string to look for in the response.
//
// 🔴 Two things this file is careful to keep apart, because a fix that blurred
// them would be a worse bug than the one it closes:
//   ① the UNEXPECTED-error (500) path — this is what changed, and the internal
//      string must never reach the wire, though it must still reach the log;
//   ② the VALIDATION (400) path a few lines above it in auth-routes.ts — this
//      is deliberately UNCHANGED, and still echoes its message on purpose (it
//      describes the CALLER's own input, not a server internal).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryHandleAuthRoutes, type AuthRoutesDeps } from '../src/http/auth-routes';
import type { AuthService } from '../src/auth/auth-service';
import { RegisterValidationError } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { log } from '../src/log';

// A string that could only have come from the thrown exception itself — never a
// word any unrelated code path (routing, JSON encoding, rate limiting) would
// also happen to produce, so finding it (or not finding it) is unambiguous.
const INTERNAL_DETAIL = 'SQLITE_ERROR: no such column: users.shadow_ledger_xyz123';

interface Captured { status: number; body: unknown }

function fakeRes(): { res: ServerResponse; captured: Captured; done: Promise<void> } {
  const captured: Captured = { status: 0, body: null };
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload ? JSON.parse(payload) : null;
      resolveDone();
    },
  } as unknown as ServerResponse;
  return { res, captured, done };
}

function fakeReq(url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.method = 'POST';
  return req;
}

/** POST a JSON body to /api/register through the REAL handler. auth-routes.ts's
 *  readJsonBody reads the request as a stream, so the body is delivered as a
 *  'data'+'end' pair AFTER the handler has attached its listeners — the same
 *  order a real node:http request would deliver them in. `done` resolves the
 *  instant `res.end()` runs, so the await below needs no arbitrary tick count
 *  regardless of how many promise hops the handler takes to get there. */
async function postRegister(deps: AuthRoutesDeps, body: unknown): Promise<Captured> {
  const req = fakeReq('/api/register');
  const { res, captured, done } = fakeRes();
  expect(tryHandleAuthRoutes(req, res, deps)).toBe(true);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await done;
  return captured;
}

/** Every AuthService member except `register` throws if actually invoked. None
 *  of these tests should ever reach them — a quiet stub would hide a routing
 *  mistake instead of failing on it (e.g. the 500 path accidentally minting and
 *  returning a real token). */
function neverCalled(name: string): () => never {
  return () => { throw new Error(`test bug: AuthService.${name} was not expected to be called`); };
}

function depsWithRegister(register: AuthService['register']): AuthRoutesDeps {
  const service: AuthService = {
    register,
    verifyCredentials: neverCalled('verifyCredentials'),
    issueToken: neverCalled('issueToken'),
    verifyToken: neverCalled('verifyToken'),
    getUser: neverCalled('getUser'),
    findByEmail: neverCalled('findByEmail'),
    setPassword: neverCalled('setPassword'),
    publicUser: neverCalled('publicUser'),
    // LOGIN-1 — and it belongs in the "must not be called" set for a reason
    // specific to this file: every case here drives /api/register, and
    // registration is deliberately NOT a sign-in (auth-service.ts `recordSignIn`
    // enumerates why). So this stub is a live assertion of that exclusion — if
    // somebody adds `recordSignIn` to the registration path, these tests fail
    // naming the method, rather than silently changing what `last_login_at`
    // means.
    recordSignIn: neverCalled('recordSignIn'),
  };
  // A fresh limiter per call: production behaviour, isolated from every other
  // test's attempt count (shared state here would make tests order-dependent).
  return { service, limiter: new RegisterRateLimiter() };
}

describe('fix-011: POST /api/register — the 500 path stops echoing internal error text', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🔴 unexpected throw ⇒ 500 with a generic body, AND (positive control) the real detail still reaches log.error', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const captured = await postRegister(
      depsWithRegister(async () => { throw new Error(INTERNAL_DETAIL); }),
      { email: 'a@b.co', password: 'longenough12' },
    );

    // ① The wire response: exact shape, code UNCHANGED, message now generic.
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
    // The negative assertion the card requires: the exception's own text is
    // ABSENT from the response — not in `message`, not anywhere else in it.
    expect(JSON.stringify(captured.body)).not.toContain(INTERNAL_DETAIL);

    // ② The positive control the card requires, in the SAME test: a negative
    // assertion alone cannot tell "we stopped leaking it" apart from "we
    // stopped recording it". This proves the detail was RELOCATED, not
    // deleted — it still reaches the operator-only log sink, verbatim.
    expect(errors).toHaveBeenCalledTimes(1);
    const [msg, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('POST /api/register');
    expect(fields).toMatchObject({ error: INTERNAL_DETAIL });
  });

  it('a non-Error throw (e.g. a rejected plain string) is handled the same way', async () => {
    // Exercises the `String(err)` half of the `err instanceof Error ? … :
    // String(err)` ternary that both the response and the log line went
    // through before this fix, and still go through now (just to different
    // destinations).
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const captured = await postRegister(
      depsWithRegister(async () => { throw INTERNAL_DETAIL; }),
      { email: 'a@b.co', password: 'longenough12' },
    );
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
    expect(JSON.stringify(captured.body)).not.toContain(INTERNAL_DETAIL);
    expect(errors).toHaveBeenCalledTimes(1);
    const [, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ error: INTERNAL_DETAIL });
  });

  it('control: the neighbouring 400 validation path is UNTOUCHED — same code, message still wire-visible, nothing logged', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const captured = await postRegister(
      depsWithRegister(async () => { throw new RegisterValidationError('password', INTERNAL_DETAIL); }),
      { email: 'a@b.co', password: 'short' },
    );
    expect(captured.status).toBe(400);
    // This is the ONE place INTERNAL_DETAIL is expected to reach the wire: it
    // is a complaint about the CALLER's own input, not a server internal —
    // fix-011 explicitly leaves this path alone (see the card).
    expect(captured.body).toEqual({ error: 'SETTINGS_SCHEMA_INVALID', message: INTERNAL_DETAIL });
    // Nothing "unexpected" happened on this path, so nothing should log.
    expect(errors).not.toHaveBeenCalled();
  });
});

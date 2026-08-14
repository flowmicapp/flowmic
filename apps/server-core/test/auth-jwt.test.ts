// WP-R4-1 ① — the ported HS256 JWT signer/verifier (auth/jwt.ts) + the account
// credential service (auth/auth-service.ts). Pure unit coverage: sign→verify
// round-trip, {sub,plan} claims + 7d default TTL, expiry, signature tamper,
// wrong secret, and the no-password_hash public projection.

import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt, JwtError, DEFAULT_TTL_MS } from '../src/auth/jwt';
import { makeAuthService } from '../src/auth/auth-service';
import { makeUserRepo } from '../src/db/repos/user.repo';
import { openDatabase } from '../src/db/connection';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SECRET = Buffer.from('unit-jwt-secret-32-bytes-minimum-xxx', 'utf8');

// STEP-5b (2026-08-12): this used to be a HAND-ROLLED copy of the `users` DDL,
// not INIT_SQL — so it had to be kept in step by hand, and it went stale TWICE
// in the SAME round, both times because makeUserRepo prepares its statements
// EAGERLY at construction time: a users table missing a column any statement
// names makes the repo itself unbuildable, not just that one method unusable.
// 🔴 A2-3 added `restricted_at`: the repo's new `UPDATE users SET
// restricted_at=?` statement made makeUserRepo itself unbuildable against the
// hand-copy, so FOUR tests in this file failed at construction with `no such
// column: restricted_at` — including three that had nothing to do with
// restriction.
// 🔴 AND IT HAPPENED AGAIN, SAME CARD, SAME DAY: Q2 added `restriction_reason`
// to that same UPDATE statement and the same four tests failed the same way
// (`no such column: restriction_reason`). Twice in one round is why this now
// runs the REAL migration path (`openDatabase` → `INIT_SQL` +
// `reconcileSchema`, schema.ts / connection.ts — the same path production
// uses) instead of hand-copying any DDL: a schema change here is now a schema
// change that already landed in schema.ts, because there is no second copy to
// fall behind.
function freshUsersDb(): ReturnType<typeof openDatabase> {
  return openDatabase(':memory:');
}

describe('auth/jwt HS256 sign + verify', () => {
  it('round-trips {sub, plan} with a 7-day default TTL', () => {
    const nowMs = 1_700_000_000_000;
    const token = signJwt({ sub: 'user-1', plan: 'pro' }, { secret: SECRET, now: () => nowMs });
    const claims = verifyJwt(token, { secret: SECRET, now: () => nowMs });
    expect(claims.sub).toBe('user-1');
    expect(claims.plan).toBe('pro');
    expect(claims.exp - claims.iat).toBe(Math.floor(DEFAULT_TTL_MS / 1000));
  });

  it('throws JWT_EXPIRED once now passes exp', () => {
    const t0 = 1_700_000_000_000;
    const token = signJwt({ sub: 'u', plan: 'free' }, { secret: SECRET, ttlMs: 1000, now: () => t0 });
    expect(() => verifyJwt(token, { secret: SECRET, now: () => t0 + 2000 })).toThrow(JwtError);
    try {
      verifyJwt(token, { secret: SECRET, now: () => t0 + 2000 });
    } catch (err) {
      expect((err as JwtError).code).toBe('JWT_EXPIRED');
    }
  });

  it('rejects a tampered signature and a wrong secret', () => {
    const token = signJwt({ sub: 'u', plan: 'free' }, { secret: SECRET });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyJwt(tampered, { secret: SECRET })).toThrow(JwtError);
    expect(() => verifyJwt(token, { secret: Buffer.from('a-different-secret-32-bytes-minimum!', 'utf8') })).toThrow(JwtError);
  });

  it('rejects a non-HS256 alg header (no alg confusion)', () => {
    // Forge a header {"alg":"none"} with the real payload/sig shape.
    const parts = signJwt({ sub: 'u', plan: 'free' }, { secret: SECRET }).split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(() => verifyJwt(`${noneHeader}.${parts[1]}.${parts[2]}`, { secret: SECRET })).toThrow(/HS256/);
  });
});

// 0.2.38 — `Plan` widened to free|pro|max and BOTH hand-written plan guards in
// jwt.ts (sign + verify) were replaced by isPlan(). Widening an accept-list is
// the kind of change that reads as obviously safe and is only actually safe if
// something checks it — the failure mode here is silent and total: every
// already-issued token is a 7-day credential, so a verifier that stopped
// accepting 'pro' would log out every paying user until their token expired.
describe('auth/jwt — three-tier Plan (0.2.38)', () => {
  /** Mint a token the way the OLD two-tier signer did: raw HS256 over
   *  base64url(header).base64url(payload), no import from today's signJwt. This
   *  matters — asserting round-trip through the current signer would only prove
   *  the file is self-consistent, not that a token issued LAST WEEK still opens.
   *  Also the only way to forge a plan the current signer refuses to write. */
  function mintLegacyToken(sub: string, plan: string, iat: number, exp: number): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub, plan, iat, exp });
    const sig = createHmac('sha256', SECRET).update(`${head}.${body}`, 'utf8').digest('base64url');
    return `${head}.${body}.${sig}`;
  }

  const NOW_MS = 1_700_000_000_000;
  const IAT = Math.floor(NOW_MS / 1000);
  const EXP = IAT + 7 * 24 * 60 * 60;

  it("still verifies tokens minted before the widening (plan 'free' and 'pro')", () => {
    for (const plan of ['free', 'pro'] as const) {
      const legacy = mintLegacyToken('legacy-user', plan, IAT, EXP);
      const claims = verifyJwt(legacy, { secret: SECRET, now: () => NOW_MS });
      expect(claims.plan).toBe(plan);
      expect(claims.sub).toBe('legacy-user');
    }
  });

  it("round-trips the new 'max' tier", () => {
    const token = signJwt({ sub: 'u-max', plan: 'max' }, { secret: SECRET, now: () => NOW_MS });
    expect(verifyJwt(token, { secret: SECRET, now: () => NOW_MS }).plan).toBe('max');
  });

  it('sign refuses a plan that is not a tier — including a case variant', () => {
    for (const bad of ['enterprise', 'Pro', 'MAX', '', 'premium']) {
      expect(() => signJwt({ sub: 'u', plan: bad as never }, { secret: SECRET })).toThrow(/claims\.plan/);
    }
  });

  it('verify rejects a CORRECTLY SIGNED token carrying a non-tier plan → JWT_BAD_CLAIMS', () => {
    // The signature is genuine (our own secret); only the claim is bogus. This
    // is the shape that matters: widening must not have widened to "anything".
    const forged = mintLegacyToken('u', 'enterprise', IAT, EXP);
    try {
      verifyJwt(forged, { secret: SECRET, now: () => NOW_MS });
      throw new Error('unreachable — a non-tier plan must not verify');
    } catch (err) {
      expect((err as JwtError).code).toBe('JWT_BAD_CLAIMS');
    }
    // Positive control: the same mint path with a real tier DOES verify, so the
    // rejection above is the claim check and not a broken test fixture.
    expect(verifyJwt(mintLegacyToken('u', 'max', IAT, EXP), { secret: SECRET, now: () => NOW_MS }).plan).toBe('max');
  });

  it('there is no third hand-written plan literal left in jwt.ts', async () => {
    // Rule ④ — the header comment claims both guards now go through isPlan(). That
    // claim is greppable, so grep it: a re-introduced literal would make the
    // comment a façade's defence lawyer, exactly as in RV-48.
    const src = await readFile(new URL('../src/auth/jwt.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf("import {")); // skip the explanatory header
    expect(body).not.toMatch(/!==\s*'free'/);
    expect(body).not.toMatch(/!==\s*'pro'/);
    expect(body).toMatch(/isPlan\(claims\.plan\)/);
    expect(body).toMatch(/isPlan\(payload\.plan\)/);
  });
});

describe('auth/auth-service credentials', () => {
  it('register → verifyCredentials round-trip; wrong password rejected; no email oracle', async () => {
    const db = freshUsersDb();
    const svc = makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET });
    const user = await svc.register({ email: 'A@Example.com', password: 'correct-horse' });
    expect(user.email).toBe('a@example.com'); // normalized NOCASE
    expect(await svc.verifyCredentials('a@example.com', 'correct-horse')).not.toBeNull();
    expect(await svc.verifyCredentials('a@example.com', 'wrong-pass')).toBeNull();
    // Unknown email returns null just like a wrong password (no existence oracle).
    expect(await svc.verifyCredentials('nobody@example.com', 'whatever')).toBeNull();
  });

  it('rejects a password shorter than 8 chars and a malformed email', async () => {
    const db = freshUsersDb();
    const svc = makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET });
    await expect(svc.register({ email: 'x@y.co', password: 'short' })).rejects.toThrow(/password/);
    await expect(svc.register({ email: 'not-an-email', password: 'longenough1' })).rejects.toThrow(/email/);
  });

  it('publicUser NEVER exposes password_hash', async () => {
    const db = freshUsersDb();
    const svc = makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET });
    const user = await svc.register({ email: 'p@q.co', password: 'longenough1', display_name: 'Pat' });
    const pub = svc.publicUser(user) as unknown as Record<string, unknown>;
    // 🔴 `toEqual` on the WHOLE object, not `toMatchObject`: this assertion is
    // the census of what crosses the wire in a user object, and it is what went
    // red when A2-3 added `restricted`. An additive field that nobody had to
    // acknowledge here would be a field that reached every login ack, /api/me
    // and the socket login without a single reviewer seeing it listed.
    // `restricted: false` — a freshly registered account is never restricted;
    // NON-OPTIONAL because the server always computes it (auth-service.ts's
    // field doc argues why the CLIENT type is the one that must allow absence).
    expect(pub).toEqual({ id: user.id, email: 'p@q.co', display_name: 'Pat', plan: 'free', email_verified: false, restricted: false });
    expect('password_hash' in pub).toBe(false);
  });

  it('issueToken mints a JWT verifiable by verifyToken; expired → AUTH_TOKEN_EXPIRED', async () => {
    const db = freshUsersDb();
    const t0 = 1_700_000_000_000;
    const svc = makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET, now: () => t0, ttlMs: 1000 });
    const user = await svc.register({ email: 'z@z.co', password: 'longenough1' });
    const issued = svc.issueToken(user);
    const ok = svc.verifyToken(issued.token);
    expect(ok.ok && ok.sub).toBe(user.id);
    // A service pinned to a later clock sees the same token as expired.
    const later = makeAuthService({ users: makeUserRepo(db), jwtSecret: SECRET, now: () => t0 + 5000 });
    const verdict = later.verifyToken(issued.token);
    expect(verdict).toEqual({ ok: false, error: 'AUTH_TOKEN_EXPIRED' });
  });
});

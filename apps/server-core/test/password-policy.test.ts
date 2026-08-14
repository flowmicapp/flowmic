// A4-3 — the ruled password policy, and the two failure shapes the ruling
// requires be pinned rather than described.
//
// SPEC-REF: docs/decisions/2026-08-12-password-policy-medium-complexity.md
//           §1 (values) · §4-1 (shared vector table) · §4-2 (the two shapes)
//           src/auth/password-policy.ts · src/auth/auth-service.ts
//           src/http/password-reset-routes.ts
//
// ── WHY THE VECTOR TABLE IS COPIED OUT OF THE RULING VERBATIM ──────────────
// @flowmic/web implements the SAME table against its own hand-written copy of
// the rules. The mirror lint (verify/lint/password-policy-mirror.mjs) can only
// compare the two NUMBERS — it cannot see either side's regexes or which length
// measure they used. This table is the half the lint cannot carry: the same
// password must get the same verdict on both ends. Read a change to any row
// here as a change that has to be made in the other repo on the same day.
//
// ── 🔴 THE LAST TWO ROWS ARE NOT MORE OF THE SAME ──────────────────────────
// The ruling's own emoji row (10 emoji + a digit) does NOT actually distinguish
// code points from UTF-16: read as 20 units instead of 10 it is still over the
// minimum, so both measures accept it and a UTF-16 implementation would pass
// that row. The two vectors under 「the measure itself」 below are built so the
// two measures DISAGREE — one in each direction — which is what makes them
// evidence about the measure rather than a coincidence.

import { describe, expect, it, afterEach } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_CLASSES,
  checkPasswordPolicy,
  countPasswordCharClasses,
  passwordCodePointLength,
} from '../src/auth/password-policy';
import { makeAuthService, RegisterValidationError } from '../src/auth/auth-service';
import { hashPassword } from '../src/auth/password';
import { makeUserRepo } from '../src/db/repos/user.repo';
import { openDatabase } from '../src/db/connection';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const SECRET = 'password-policy-test-secret-32-bytes!';

let server: BootstrapHandle | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

// ── the ruled values, asserted as values ────────────────────────────────────
describe('A4-3: the ruled numbers', () => {
  it('are the ones the decision doc §1 ruled', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(MAX_PASSWORD_LENGTH).toBe(32);
    expect(MIN_PASSWORD_CLASSES).toBe(2);
  });
});

// ── §4-1 the shared vector table ────────────────────────────────────────────
/** `rule` is the EXPECTED failure, or null for an accepted password. */
const VECTORS: Array<{ pw: string; rule: 'min_length' | 'max_length' | 'char_classes' | null; why: string }> = [
  { pw: 'abcdefghi', rule: 'min_length', why: '9 letters — the lower boundary' },
  { pw: 'abcdefghij', rule: 'char_classes', why: '10 letters: long enough, one class' },
  { pw: 'abcdefghi1', rule: null, why: 'letters + digit = two classes' },
  { pw: 'abcdefghi!', rule: null, why: 'letters + symbol = two classes' },
  { pw: '1234567890', rule: 'char_classes', why: 'digits only — one class' },
  { pw: '你好世界你好世界你好', rule: 'char_classes', why: '10 han: \\p{L} makes CJK ONE class (ruling §1 red note)' },
  { pw: '你好世界你好世界你1', rule: null, why: 'han + digit = two classes' },
  { pw: `${'a'.repeat(31)}1`, rule: null, why: '32 code points — exactly the ceiling' },
  { pw: `${'a'.repeat(32)}1`, rule: 'max_length', why: '33 code points — over the ceiling' },
  { pw: '😀😀😀😀😀😀😀😀😀😀1', rule: null, why: '10 emoji + digit = 11 code points, two classes' },
];

describe('A4-3 §4-1: the shared vector table (@flowmic/web implements the same rows)', () => {
  for (const v of VECTORS) {
    it(`${v.rule === null ? 'ACCEPT' : `REJECT(${v.rule})`} — ${v.why}`, () => {
      const verdict = checkPasswordPolicy(v.pw);
      if (v.rule === null) {
        expect(verdict).toEqual({ ok: true });
      } else {
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.rule).toBe(v.rule);
      }
    });
  }

  it('length is checked BEFORE classes — a 9-letter password is refused for LENGTH, not for classes', () => {
    // It breaks both rules. Ruling §4-1 requires the length answer: telling
    // someone to add a digit to a password that is too short anyway sends them
    // round the loop twice.
    const verdict = checkPasswordPolicy('abcdefghi');
    expect(verdict.ok === false && verdict.rule).toBe('min_length');
    expect(countPasswordCharClasses('abcdefghi')).toBe(1);
  });

  it('the refusal NAMES the broken rule — no bare 「invalid」 (ruling §2-3)', () => {
    const short = checkPasswordPolicy('abcdefghi');
    const classes = checkPasswordPolicy('abcdefghij');
    const long = checkPasswordPolicy(`${'a'.repeat(32)}1`);
    expect(short.ok === false && short.requirement).toContain('at least 10');
    expect(classes.ok === false && classes.requirement).toContain('kinds of character');
    expect(long.ok === false && long.requirement).toContain('at most 32');
    // The three sentences must be distinguishable from one another, which is the
    // whole point of returning a rule rather than a boolean.
    const said = new Set(
      [short, classes, long].map((v) => (v.ok === false ? v.requirement : 'ok')),
    );
    expect(said.size).toBe(3);
  });
});

// ── the measure itself: code points, not UTF-16 units ───────────────────────
describe('A4-3: the length measure is CODE POINTS (both directions pinned)', () => {
  // 5 emoji + a digit. Code points: 6 → below the minimum → REJECT.
  // UTF-16 units: 11 → above the minimum → a `.length` implementation ACCEPTS.
  const belowMinButLongInUtf16 = '😀😀😀😀😀1';

  // 16 emoji + a digit. Code points: 17 → under the ceiling → ACCEPT.
  // UTF-16 units: 33 → over the 32 ceiling → a `.length` implementation REJECTS.
  const underMaxButOverInUtf16 = `${'😀'.repeat(16)}1`;

  it('the two vectors really do split the measures (else they prove nothing)', () => {
    expect(passwordCodePointLength(belowMinButLongInUtf16)).toBe(6);
    expect(belowMinButLongInUtf16.length).toBe(11); // UTF-16 units
    expect(passwordCodePointLength(underMaxButOverInUtf16)).toBe(17);
    expect(underMaxButOverInUtf16.length).toBe(33); // UTF-16 units
    // Sanity: each is on the opposite side of a limit under the two measures.
    expect(6 < MIN_PASSWORD_LENGTH && 11 >= MIN_PASSWORD_LENGTH).toBe(true);
    expect(17 <= MAX_PASSWORD_LENGTH && 33 > MAX_PASSWORD_LENGTH).toBe(true);
  });

  it('REJECTS a password UTF-16 would call long enough', () => {
    const verdict = checkPasswordPolicy(belowMinButLongInUtf16);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.rule).toBe('min_length');
  });

  it('ACCEPTS a password UTF-16 would call too long', () => {
    expect(checkPasswordPolicy(underMaxButOverInUtf16)).toEqual({ ok: true });
  });

  it('an emoji is 「other」, not a letter and not a digit', () => {
    expect(countPasswordCharClasses('😀😀😀😀😀😀😀😀😀😀')).toBe(1);
    expect(countPasswordCharClasses('😀😀😀😀😀😀😀😀😀😀1')).toBe(2);
  });
});

// ── §4-2 item 1: login NEVER gains complexity validation ────────────────────
//
// 🔴 WHAT THIS PINS, AND WHY IT IS NOT THEATRICAL. `verifyCredentials`
// structurally cannot refuse on complexity today: it reads a row, calls
// verifyPassword, and returns the user or null — the policy module is not in its
// import path at all. So asserting 「it did not validate」 against the current
// code would be asserting the absence of code that is not there, which passes
// forever and notices nothing.
//
// What is asserted instead is the CONSEQUENCE the ruling actually promises: an
// account whose stored password predates the new minimum still authenticates.
// That row is created the way a legacy row exists — a hash written straight
// through the repo — because `register` can no longer mint one. Wiring
// checkPasswordPolicy into verifyCredentials turns this test red immediately,
// which is the reverse control the ruling asks for (§4-2 item 1).
describe('A4-3 §4-2①: no retroactive enforcement — a legacy 8-character password still logs in', () => {
  it('authenticates a stored password that the CURRENT policy would refuse', async () => {
    // The REAL schema (INIT_SQL + reconcileSchema), not a hand-rolled `users`
    // DDL — this test is about a stored credential, so the row it authenticates
    // against should be the shape production actually stores.
    const db = openDatabase(':memory:');
    const users = makeUserRepo(db);
    const auth = makeAuthService({ users, jwtSecret: Buffer.from(SECRET, 'utf8') });

    // The password an account created before 2026-08-12 could legitimately have.
    const legacy = 'hunter88';
    expect(checkPasswordPolicy(legacy).ok).toBe(false); // today's policy refuses it…

    users.insert({
      id: 'legacy-user',
      email: 'legacy@b.co',
      password_hash: await hashPassword(legacy),
      plan: 'free',
    });

    // …and login does not care. This is "non-retroactive" as an executable fact.
    const ok = await auth.verifyCredentials('legacy@b.co', legacy);
    expect(ok?.id).toBe('legacy-user');

    // Control: login still refuses the WRONG password, so the assertion above is
    // 「the policy is not consulted」 and not 「verifyCredentials accepts anything」.
    expect(await auth.verifyCredentials('legacy@b.co', 'hunter89')).toBe(null);

    // And the same account cannot RE-set that password: the ruling stops at the
    // stored value, it does not grandfather future writes.
    await expect(auth.setPassword('legacy-user', legacy)).rejects.toBeInstanceOf(RegisterValidationError);
    db.close();
  });
});

// ── §4-2 item 2: the reset route and setPassword cannot disagree ────────────
describe('A4-3 §4-2②: the reset route refuses a between-the-limits password ITSELF', () => {
  async function saasServer(): Promise<{ url: string; handle: BootstrapHandle }> {
    // fix-010: an in-process server has no proxy in front of it — its direct
    // peer IS the client (config.ts §trustedProxies).
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {});
    return { url: `http://127.0.0.1:${server.port}`, handle: server };
  }
  async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  function mintedReset(handle: BootstrapHandle, userId: string): { reset_token: string } {
    const row = handle.db.settings.read(userId, 'account.password_reset');
    return (row?.value ?? {}) as { reset_token: string };
  }

  it('9 characters → the NAMED 400 from the route, never the last-line guard', async () => {
    const { url, handle } = await saasServer();
    const good = 'goodpass01';
    const created = await post(`${url}/api/register`, { email: 'r@b.co', password: good, display_name: 'R' });
    expect(created.status).toBe(201);
    await post(`${url}/api/password/forgot`, { email: 'r@b.co' });
    const { reset_token } = mintedReset(handle, created.json.user.id as string);

    // 9 code points: over the OLD hard-coded 8 in this route, under the NEW
    // minimum of 10. Before A4-3 wired both sides to one function, this value
    // passed the route's own check and then threw inside `deps.auth.setPassword`
    // — inside a `void (async …)` with no catch, so the caller got NO RESPONSE
    // and the rejection reached installProcessGuards, which treats
    // unhandledRejection as fatal.
    const between = 'between9x';
    expect(passwordCodePointLength(between)).toBe(9);

    const refused = await post(`${url}/api/password/reset`, {
      email: 'r@b.co',
      reset_token,
      new_password: between,
    });

    // ① It answered at all. A hang here IS the bug: the pre-A4-3 shape sent no
    //    response on this path.
    expect(refused.status).toBe(400);
    // ② It answered with the named refusal, naming the field the caller sent and
    //    the rule that was broken — not a bare 「invalid」.
    expect(refused.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(refused.json.message).toBe('new_password must be at least 10 characters');
    // ③ Nothing was written: the old password still works, the reset token is
    //    still live (a refusal is not a spend).
    const stillOld = await post(`${url}/api/login`, { email: 'r@b.co', password: good });
    expect(stillOld.status).toBe(200);
    // ④ The PROCESS is still serving. If the throw had escaped, the fatal guard
    //    would have closed this server out from under the next request.
    const accepted = await post(`${url}/api/password/reset`, {
      email: 'r@b.co',
      reset_token,
      new_password: 'brandnewpass1',
    });
    expect(accepted.status).toBe(200);
    const newLogin = await post(`${url}/api/login`, { email: 'r@b.co', password: 'brandnewpass1' });
    expect(newLogin.status).toBe(200);
  });

  it('the route refuses a CLASS failure too — not only length (it reads the whole policy)', async () => {
    const { url, handle } = await saasServer();
    const created = await post(`${url}/api/register`, { email: 'c@b.co', password: 'goodpass01', display_name: 'C' });
    await post(`${url}/api/password/forgot`, { email: 'c@b.co' });
    const { reset_token } = mintedReset(handle, created.json.user.id as string);
    // 12 letters: long enough, ONE class. A length-only route would let this
    // through to the last-line guard — which is the same failure shape as the
    // 9-character case, just reached by the other rule.
    const refused = await post(`${url}/api/password/reset`, {
      email: 'c@b.co',
      reset_token,
      new_password: 'brandnewpass',
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(refused.json.message).toContain('kinds of character');
  });
});

// ── register: same policy, same wire code (ruling §5: NO new error code) ────
describe('A4-3: register enforces the same policy and the wire code does not move', () => {
  it('refuses a one-class password with SETTINGS_SCHEMA_INVALID and a naming message', async () => {
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {});
    const url = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'n@b.co', password: 'abcdefghij', display_name: 'N' }),
    });
    const json = (await res.json()) as { error?: string; message?: string };
    expect(res.status).toBe(400);
    // Ruling §5: "do not add an error code" — this refusal keeps the code every
    // RegisterValidationError has always carried.
    expect(json.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(json.message).toContain('kinds of character');
  });
});

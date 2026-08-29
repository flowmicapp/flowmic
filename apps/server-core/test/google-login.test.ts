// Card NR-1 — Google sign-in on the console, end-to-end over a REAL in-process
// saas server (startServer, bootstrap wiring included).
// Behaviour contract: docs/strategy/2026-08-27-next-release-feature-and-
// optimization-ledger.md §1; activation docs/decisions/2026-08-27-owner-web-
// rulings-nr-ledger.md item 2.
//
// 🔴 THE VERIFIER UNDER TEST IS THE REAL ONE. What is faked is the KEY FETCH:
// this file generates an RSA keypair, serves its public half as a JWKS, and
// mints tokens with the private half — so the signature check, the issuer check,
// the AUDIENCE check and the expiry check are the things being exercised, not
// assumptions about them. A fake verifier would have made every case here green
// no matter what src/auth/google-id-token.ts does, which is the 0.2.48 L9 shape
// (fifteen green adapter tests all driving a FakeWs that answered the way we
// assumed). The one case that does NOT inject a verifier is the unconfigured
// 503, which drives the production env resolution instead.
//
// The server runs on an injected fake clock (overrides.now) so `exp` is DRIVEN,
// never slept for.
//
// 🔴 REVERSE CONTROL — run red once, then reverted (2026-08-27): the audience
// check in src/auth/google-id-token.ts was deliberately disarmed
// (`const audOk = true;` in place of the `aud === opts.clientId` comparison,
// drill-marked DRILL-NR1-AUD). Red output verbatim (the vitest `❯ file:line`
// pointer lines elided per the coordinate-anchors discipline; the failing
// assertion is named by symbol):
//
//   FAIL  test/google-login.test.ts > refusals: a token that is not ours, and
//     one that is too old > 🔴 a token minted for ANOTHER application's client
//     id is refused (the audience check)
//   AssertionError: a token whose aud is another app's client id was ACCEPTED —
//     the audience check is the only thing standing between us and every
//     Google-issued token on the platform: expected 201 to be 401
//   Tests  1 failed | 12 passed (13)
//
//   (the `expect(r.status, …).toBe(401)` assertion below. The follow-up
//   `expect(r.json.error).toBe(GOOGLE_TOKEN_INVALID)` and the "and it created
//   nothing" assertion would have bitten next had the run continued.) Drill
//   reverted, suite green again, residue grep for DRILL-NR1-AUD = 0.
//
// *** SENSITIVE SURFACE (auth: a new way to become a signed-in account) ***

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject, type JsonWebKey } from 'node:crypto';
import { ERROR_CODES } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { makeGoogleIdTokenVerifier, type GoogleIdTokenVerifier } from '../src/auth/google-id-token';
import {
  GOOGLE_EMAIL_UNVERIFIED,
  GOOGLE_LOGIN_NOT_CONFIGURED,
  GOOGLE_LOGIN_PATH,
  GOOGLE_TOKEN_EXPIRED,
  GOOGLE_TOKEN_INVALID,
} from '../src/http/google-auth-routes';
import { EMAIL_NOT_VERIFIED } from '../src/auth/email-verification';

const SECRET = 'google-login-secret-32-bytes-xxxxxx';
const CLIENT_ID = '1234567890-testclient.apps.googleusercontent.com';
const OTHER_CLIENT_ID = '9999999999-someoneelse.apps.googleusercontent.com';
const KID = 'test-key-1';
const T0 = Date.parse('2026-08-27T00:00:00.000Z');

let NOW = T0;
const clock = (): number => NOW;

let server: BootstrapHandle | null = null;

afterEach(async () => {
  NOW = T0;
  delete process.env.FLOWMIC_GOOGLE_CLIENT_ID;
  if (server) await server.close();
  server = null;
});

// ── the key material: ours, generated here, never Google's ──────────────────
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks: { keys: JsonWebKey[] } = {
  keys: [{ ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: KID, alg: 'RS256', use: 'sig' }],
};
/** A SECOND keypair nobody published — the "signed by somebody else" case. */
const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

interface MintOptions {
  sub?: string;
  email?: string | null;
  emailVerified?: boolean | string;
  name?: string;
  aud?: string;
  iss?: string;
  /** Seconds since epoch. Defaults to one hour after the fake clock's T0. */
  exp?: number;
  kid?: string;
  alg?: string;
  key?: KeyObject;
}

/** Mint an ID token the way Google would. Every field is overridable because
 *  every field is a check somewhere in the verifier. */
function mint(o: MintOptions = {}): string {
  const header = { alg: o.alg ?? 'RS256', kid: o.kid ?? KID, typ: 'JWT' };
  const claims: Record<string, unknown> = {
    iss: o.iss ?? 'https://accounts.google.com',
    aud: o.aud ?? CLIENT_ID,
    sub: o.sub ?? 'google-sub-default',
    exp: o.exp ?? Math.floor(T0 / 1000) + 3600,
    iat: Math.floor(T0 / 1000),
    email_verified: o.emailVerified ?? true,
  };
  if (o.email !== null) claims.email = o.email ?? 'someone@gmail.com';
  if (o.name !== undefined) claims.name = o.name;
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`, 'ascii').sign(o.key ?? privateKey);
  return `${h}.${p}.${sig.toString('base64url')}`;
}

/** The REAL verifier over a fake key fetch. `fetches` counts trips so the cache
 *  can be asserted on rather than assumed. */
function realVerifier(): { verifier: GoogleIdTokenVerifier; fetches: () => number } {
  let n = 0;
  const verifier = makeGoogleIdTokenVerifier({
    clientId: CLIENT_ID,
    now: clock,
    fetchJwks: () => {
      n += 1;
      return Promise.resolve({ keys: jwks.keys });
    },
  });
  return { verifier, fetches: () => n };
}

async function saas(verifier?: GoogleIdTokenVerifier): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, {
    now: clock,
    ...(verifier ? { googleVerifier: verifier } : {}),
  });
  return `http://127.0.0.1:${server.port}`;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
function google(url: string, credential: string): Promise<{ status: number; json: any }> {
  return call('POST', `${url}${GOOGLE_LOGIN_PATH}`, { credential });
}
async function me(url: string, token: string): Promise<any> {
  const r = await call('GET', `${url}/api/me`, undefined, bearer(token));
  expect(r.status).toBe(200);
  return r.json.user;
}

describe('happy path: a Google identity nobody has seen before', () => {
  it('mints an account, returns /api/login’s exact body, and the account is usable', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);

    const r = await google(url, mint({ sub: 'g-new-1', email: 'newcomer@gmail.com', name: 'New Comer' }));
    // 201 — this request created the account (the /api/register distinction).
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // The body is /api/login's, field for field, and NOTHING more: no
    // google_sub, no password_hash. Asserted as an exact key set rather than by
    // spot-checking, because "what leaked" is precisely what spot-checks miss.
    expect(Object.keys(r.json).sort()).toEqual(['token', 'user']);
    expect(Object.keys(r.json.user).sort()).toEqual([
      'display_name', 'email', 'email_verified', 'id', 'plan', 'restricted', 'verify_grace_days_left',
    ]);
    expect(r.json.user.email).toBe('newcomer@gmail.com');
    expect(r.json.user.display_name).toBe('New Comer');
    expect(r.json.user.plan).toBe('free');

    // The token is a real Cloud Key: it opens /api/me…
    const who = await me(url, r.json.token);
    expect(who.id).toBe(r.json.user.id);
    // …and the CONSOLE FEATURE SURFACE, which is the operational point of the
    // card: this account never met the verification gate.
    const summary = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(r.json.token));
    expect(summary.status, 'a Google user hit the email-verification wall').toBe(200);
  });

  it('falls back to the address’ local part when the token carries no name', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);
    const r = await google(url, mint({ sub: 'g-noname', email: 'Quiet.Person@Gmail.com' }));
    expect(r.status).toBe(201);
    // The local part, NOT the whole address — an address rendered as a name is
    // the shape of a field nobody filled in.
    expect(r.json.user.display_name).toBe('Quiet.Person');
    // …and the address itself is stored normalised, the way every other write
    // path stores it (user.repo normalizeEmail).
    expect(r.json.user.email).toBe('quiet.person@gmail.com');
  });
});

describe('the same person, again: the sub is the identity and the email is not', () => {
  it('a second sign-in resolves by google_sub even when the token’s email changed', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);

    const first = await google(url, mint({ sub: 'g-stable', email: 'before@gmail.com' }));
    expect(first.status).toBe(201);

    // Same Google account, new address on it. This must be the SAME FlowMic
    // account — and our email column must not follow Google's.
    const second = await google(url, mint({ sub: 'g-stable', email: 'after@gmail.com' }));
    expect(second.status, 'a repeat sign-in reported 201 — it created a second account').toBe(200);
    expect(second.json.user.id).toBe(first.json.user.id);
    expect(
      second.json.user.email,
      'Google’s address overwrote ours — a person who renamed their Google account would silently move where our password resets go',
    ).toBe('before@gmail.com');
  });

  it('the key set is fetched ONCE across many sign-ins (the cache is real)', async () => {
    const { verifier, fetches } = realVerifier();
    const url = await saas(verifier);
    await google(url, mint({ sub: 'g-cache', email: 'cache@gmail.com' }));
    await google(url, mint({ sub: 'g-cache', email: 'cache@gmail.com' }));
    await google(url, mint({ sub: 'g-cache', email: 'cache@gmail.com' }));
    // A verifier constructed per request would read 3 here, and Google's key
    // endpoint would see one request per sign-in.
    expect(fetches()).toBe(1);
  });
});

describe('binding: an existing password account claims its Google identity', () => {
  it('binds instead of minting a second account, and opens the verification gate on the way in', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);

    // A password account, freshly registered ⇒ the gate is CLOSED.
    const reg = await call('POST', `${url}/api/register`, {
      email: 'both@gmail.com', password: 'longenough1', display_name: 'Both Ways',
    });
    expect(reg.status).toBe(201);
    expect((await me(url, reg.json.token)).email_verified).toBe(false);
    const walled = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(reg.json.token));
    expect(walled.status).toBe(403);
    expect(walled.json).toEqual({ error: EMAIL_NOT_VERIFIED });

    NOW = T0 + 60_000;
    const g = await google(url, mint({ sub: 'g-bound', email: 'both@gmail.com', name: 'Ignored Name' }));
    // 200, not 201: nothing was created.
    expect(g.status, 'the Google sign-in minted a SECOND account for an address we already had').toBe(200);
    expect(g.json.user.id).toBe(reg.json.user.id);
    // The gate is now OPEN — for the ORIGINAL session token too, because the
    // fact lives in the row and not in the token.
    expect(g.json.user.email_verified).toBe(true);
    expect((await me(url, reg.json.token)).email_verified).toBe(true);
    const through = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(reg.json.token));
    expect(through.status).toBe(200);

    // 🔴 THE BIND TOUCHED ONE COLUMN. The display name Google offered was NOT
    // written over the one the person chose, and the password still works.
    expect(g.json.user.display_name).toBe('Both Ways');
    const relogin = await call('POST', `${url}/api/login`, { email: 'both@gmail.com', password: 'longenough1' });
    expect(relogin.status, 'binding a Google identity broke the password sign-in').toBe(200);

    // …and from now on the sub alone resolves the account, with no email match.
    const bySub = await google(url, mint({ sub: 'g-bound', email: 'moved@gmail.com' }));
    expect(bySub.status).toBe(200);
    expect(bySub.json.user.id).toBe(reg.json.user.id);
  });

  it('does not re-close a gate that is already open, and never moves an earlier stamp', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);
    const first = await google(url, mint({ sub: 'g-idem', email: 'idem@gmail.com' }));
    expect(first.json.user.email_verified).toBe(true);
    // A later token on which Google does NOT vouch for the address. The account
    // is already bound (step ①), so it signs in — and stays verified.
    // Ten minutes on — well inside the default token lifetime the helper mints.
    NOW = T0 + 600_000;
    const later = await google(url, mint({ sub: 'g-idem', email: 'idem@gmail.com', emailVerified: false }));
    expect(later.status).toBe(200);
    expect(
      later.json.user.email_verified,
      'a later unverified token CLOSED a gate that was already open',
    ).toBe(true);
  });
});

describe('refusals: a token that is not ours, and one that is too old', () => {
  it('🔴 a token minted for ANOTHER application’s client id is refused (the audience check)', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);
    // Correctly signed by the key we published, correct issuer, not expired —
    // and minted for somebody else's app. Without the aud check this is a valid
    // token and every Google login button on the internet becomes one here.
    const r = await google(url, mint({ sub: 'g-other-app', email: 'victim@gmail.com', aud: OTHER_CLIENT_ID }));
    expect(
      r.status,
      'a token whose aud is another app’s client id was ACCEPTED — the audience check is the only thing standing between us and every Google-issued token on the platform',
    ).toBe(401);
    expect(r.json.error).toBe(GOOGLE_TOKEN_INVALID);
    // …and it created nothing: a following legitimate sign-in for that address
    // reports 201, which it could not do if a row already existed.
    const ok = await google(url, mint({ sub: 'g-other-app', email: 'victim@gmail.com' }));
    expect(ok.status, 'the refused token still minted an account').toBe(201);
  });

  it('an expired token is refused with its OWN code (the client must know to ask Google again)', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);
    const token = mint({ sub: 'g-stale', email: 'stale@gmail.com', exp: Math.floor(T0 / 1000) + 60 });
    // Before: fine.
    NOW = T0;
    // After: the same token, one second past its exp.
    NOW = T0 + 61_000;
    const r = await google(url, token);
    expect(r.status).toBe(401);
    // 🔴 EXPIRED, not INVALID. The two demand opposite things of the console:
    // fetch a fresh token vs. stop trying.
    expect(
      r.json.error,
      'an expired token was reported as INVALID — the console would stop retrying a credential a refresh would fix',
    ).toBe(GOOGLE_TOKEN_EXPIRED);
  });

  it('refuses a token signed by a key Google never published, and one that asks us to skip the signature', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);

    const forged = await google(url, mint({ sub: 'g-forged', email: 'forged@gmail.com', key: impostor.privateKey }));
    expect(forged.status).toBe(401);
    expect(forged.json.error).toBe(GOOGLE_TOKEN_INVALID);

    // `alg: none` is the classic JWT hole: the caller asking us not to check.
    const none = await google(url, mint({ sub: 'g-none', email: 'none@gmail.com', alg: 'none' }));
    expect(none.status).toBe(401);
    expect(none.json.error).toBe(GOOGLE_TOKEN_INVALID);

    // A token from an issuer that is not Google, signed by our own test key
    // (i.e. it would verify if only the signature mattered).
    const iss = await google(url, mint({ sub: 'g-iss', email: 'iss@gmail.com', iss: 'https://evil.example' }));
    expect(iss.status).toBe(401);
    expect(iss.json.error).toBe(GOOGLE_TOKEN_INVALID);

    // Garbage, and an empty body.
    expect((await google(url, 'not-a-jwt')).json.error).toBe(GOOGLE_TOKEN_INVALID);
    const empty = await call('POST', `${url}${GOOGLE_LOGIN_PATH}`, {});
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe(GOOGLE_TOKEN_INVALID);
  });

  it('refuses a genuine token whose address Google will not vouch for — and creates nothing', async () => {
    const { verifier } = realVerifier();
    const url = await saas(verifier);

    // The dangerous case: an existing account's address, on a Google identity
    // that has not verified it. Matching here would be an account takeover.
    const reg = await call('POST', `${url}/api/register`, { email: 'target@gmail.com', password: 'longenough1' });
    expect(reg.status).toBe(201);

    const r = await google(url, mint({ sub: 'g-unverified', email: 'target@gmail.com', emailVerified: false }));
    expect(r.status, 'an unverified Google address was allowed to claim an existing account').toBe(403);
    expect(r.json.error).toBe(GOOGLE_EMAIL_UNVERIFIED);
    // The victim's account is untouched: still unverified, still password-only.
    expect((await me(url, reg.json.token)).email_verified).toBe(false);

    // A token with no email claim at all lands on the same refusal — same
    // question, same answer, one name.
    const noEmail = await google(url, mint({ sub: 'g-noemail', email: null }));
    expect(noEmail.status).toBe(403);
    expect(noEmail.json.error).toBe(GOOGLE_EMAIL_UNVERIFIED);

    // 🔴 And `email_verified` as the STRING "true" — which Google has really
    // sent — must still count as vouched for.
    const stringy = await google(url, mint({ sub: 'g-stringy', email: 'stringy@gmail.com', emailVerified: 'true' }));
    expect(stringy.status).toBe(201);
    expect(stringy.json.user.email_verified).toBe(true);
  });
});

describe('an unconfigured deployment', () => {
  it('answers a named 503 — never a 404, and never a quiet acceptance', async () => {
    // NO injected verifier: this drives the PRODUCTION resolution
    // (resolveGoogleIdTokenVerifier) with FLOWMIC_GOOGLE_CLIENT_ID unset, so
    // what is under test is the wiring an operator actually gets.
    delete process.env.FLOWMIC_GOOGLE_CLIENT_ID;
    const url = await saas();
    const r = await google(url, mint({ sub: 'g-anything', email: 'anything@gmail.com' }));
    // 🔴 NOT 404. "There is no such feature" and "this deployment cannot do that
    // right now" are different sentences and only the second one is actionable.
    expect(r.status, 'an unconfigured deployment 404ed — indistinguishable from a build without the feature').toBe(503);
    expect(r.json.error).toBe(GOOGLE_LOGIN_NOT_CONFIGURED);
    // And above all it did NOT succeed: a verifier with no client id must refuse,
    // never wave a token through for want of something to compare it against.
    expect(r.json.token).toBeUndefined();
  });
});

describe('pins', () => {
  it('🔴 NR-1 added no protocol error code — the refusal names are HTTP-local', () => {
    // The owner-gated ERROR_CODES table did not move for this card. Asserted
    // rather than promised in a comment (the VERIFY-1 precedent).
    const codes = new Set(Object.keys(ERROR_CODES));
    for (const name of [
      GOOGLE_TOKEN_INVALID,
      GOOGLE_TOKEN_EXPIRED,
      GOOGLE_EMAIL_UNVERIFIED,
      GOOGLE_LOGIN_NOT_CONFIGURED,
      'GOOGLE_LOGIN_FAILED',
    ]) {
      expect(codes.has(name), `${name} leaked into the protocol code table`).toBe(false);
    }
  });

  it('🔴 the route is saas-only: standalone leaves the path unhandled', async () => {
    const config = loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, { now: clock });
    const url = `http://127.0.0.1:${server.port}`;
    const r = await google(url, mint({ sub: 'g-lan', email: 'lan@gmail.com' }));
    // 404 is the honest answer HERE, and it is the opposite of the unconfigured
    // case above: standalone has no account layer at all, so there is nothing an
    // operator could switch on.
    expect(r.status).toBe(404);
  });
});

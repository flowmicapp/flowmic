// owner batch-2 item 4, third clause — the GLOBAL daily registration threshold.
//
// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md item 4, verbatim:
//     「控制台也需要控制整体的一个策略，如果当天注册用户太多如达到 50 个以上就
//      需要立即做验证码确认」
//   src/auth/registration-surge.ts (the counter + the four-branch gate)
//   src/auth/captcha.ts (the Turnstile seam)
//
// 🔴 WHAT IS REAL HERE AND WHAT IS FAKE, said up front because the 0.2.48 L9
// lesson was exactly this. The COUNTER, the GATE and both ROUTES are the
// production ones, reached over a real in-process saas server. What is faked is
// the CAPTCHA PROVIDER'S HTTP CALL — and even that is faked at the transport
// (`fetchImpl`), so `makeTurnstileVerifier`'s own body — the form encoding, the
// `success === true` check, every fail-closed arm — is the thing under test and
// not an assumption about it. A fake verifier object would have made every case
// below green no matter what src/auth/captcha.ts does.
//
// The threshold is driven down with FLOWMIC_REGISTER_SURGE_THRESHOLD rather
// than by minting fifty accounts. That env var exists for this reason among
// others (its doc says so): a state a test cannot afford to reach is a state
// whose behaviour nobody ever proves.
//
// ── 🔴 REVERSE CONTROLS — both run RED once, then reverted ─────────────────
//
// (i) THE GATE ITSELF. In src/http/auth-routes.ts the surge guard call was
//     replaced by a pass-through (`const surge = { ok: true } as const;`,
//     drill-marked DRILL-SURGE-BYPASS). Red output, assertion named by symbol:
//
//       FAIL  test/registration-surge.test.ts > at the threshold, registration
//         demands a human check > 🔴 the registration past the threshold is
//         refused by name, and the body says a captcha is required
//       AssertionError: a registration past the daily threshold was minted with
//         NO captcha token — the surge gate is not in the path: expected 201 to
//         be 403
//       FAIL  … > threshold met AND no captcha configured: the door closes,
//         loudly > 🔴 503 by name, nothing minted, and the log line names the
//         env var
//       AssertionError: expected 201 to be 503
//       FAIL  … > every mint path counts, or the gate has its own bypass > 🔴 an
//         account minted through Google counts toward the day's total
//       AssertionError: a Google sign-in minted an account that the day's
//         counter never saw …: expected 201 to be 503
//       Tests  3 failed | 9 passed (12)
//
//     ⚠️ THE THIRD ONE IS THE INTERESTING FAILURE, and it is the reason this
//     drill was worth running rather than reasoned about: a test whose subject
//     is the GOOGLE arm went red from a bypass in the PASSWORD route, because
//     what it actually observes is one shared counter. Drill reverted, suite
//     green (12/12), residue grep for DRILL-SURGE-BYPASS = 0.
//
// (ii) THE GOOGLE ARM'S COUNT. In src/http/google-auth-routes.ts the line
//     `if (resolution.created) deps.surgeGate?.counter.record();` was deleted
//     (drill-marked DRILL-SURGE-GOOGLE). Red output:
//
//       FAIL  test/registration-surge.test.ts > every mint path counts, or the
//         gate has its own bypass > 🔴 an account minted through Google counts
//         toward the day's total
//       AssertionError: a Google sign-in minted an account that the day's
//         counter never saw — the surge gate can be walked past one Google
//         account at a time: expected 201 to be 503
//       Tests  1 failed | 11 passed (12)
//
//     ⚠️ THAT IS THE WHOLE DEFECT IN ONE LINE, and it is worth naming: the
//     failure is NOT under-reporting. An uncounted mint path is a way to raise
//     the day's real total past the threshold while the gate still reads
//     「calm」, i.e. the gate's own bypass, reachable by anyone with Google
//     accounts. Drill reverted, residue grep for DRILL-SURGE-GOOGLE = 0.
//
// *** SENSITIVE SURFACE (auth: it can close account creation) ***

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createSign, type JsonWebKey } from 'node:crypto';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { log } from '../src/log';
import { makeGoogleIdTokenVerifier } from '../src/auth/google-id-token';
import { GOOGLE_LOGIN_PATH } from '../src/http/google-auth-routes';
import {
  REGISTER_CAPTCHA_INVALID,
  REGISTER_CAPTCHA_REQUIRED,
  REGISTER_TEMPORARILY_CLOSED,
  REGISTRATION_SURGE_THRESHOLD,
  RegistrationSurgeCounter,
  guardRegistrationSurge,
  resolveRegistrationSurgeGate,
} from '../src/auth/registration-surge';
import {
  TURNSTILE_VERIFY_URL,
  makeTurnstileVerifier,
  unconfiguredCaptchaVerifier,
  type CaptchaFetch,
} from '../src/auth/captcha';

const SECRET = 'surge-gate-secret-32-bytes-aaaaaaaaa';
const CLIENT_ID = '1234567890-surge.apps.googleusercontent.com';
const KID = 'surge-key-1';
const T0 = Date.parse('2026-09-01T08:00:00.000Z');

let NOW = T0;
const clock = (): number => NOW;
let server: BootstrapHandle | null = null;

afterEach(async () => {
  NOW = T0;
  vi.restoreAllMocks();
  delete process.env.FLOWMIC_REGISTER_SURGE_THRESHOLD;
  delete process.env.FLOWMIC_TURNSTILE_SECRET;
  delete process.env.FLOWMIC_TURNSTILE_VERIFY_URL;
  delete process.env.FLOWMIC_GOOGLE_CLIENT_ID;
  if (server) await server.close();
  server = null;
});

// ── a loopback stand-in for Cloudflare, so the REAL verifier does real work ──
/** Answers siteverify. `accept` decides the verdict; every request is recorded
 *  so the body we send can be asserted rather than assumed. */
function siteverify(accept: (token: string) => boolean): {
  fetchImpl: CaptchaFetch;
  bodies: () => string[];
} {
  const bodies: string[] = [];
  const fetchImpl: CaptchaFetch = (url, init) => {
    expect(url, 'the production endpoint must be the one that is called').toBe(TURNSTILE_VERIFY_URL);
    bodies.push(init.body);
    const token = new URLSearchParams(init.body).get('response') ?? '';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: accept(token), 'error-codes': accept(token) ? [] : ['invalid-input-response'] }),
    });
  };
  return { fetchImpl, bodies: () => bodies };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Boot a REAL saas server. `threshold` goes through the production env var, so
 *  what is exercised is the same resolution a deployment runs. */
async function saas(threshold: number, opts: { turnstileSecret?: string } = {}): Promise<string> {
  process.env.FLOWMIC_REGISTER_SURGE_THRESHOLD = String(threshold);
  if (opts.turnstileSecret !== undefined) process.env.FLOWMIC_TURNSTILE_SECRET = opts.turnstileSecret;
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, { now: clock });
  return `http://127.0.0.1:${server.port}`;
}

/** Distinct XFF is useless here (no trusted proxies), so the PER-IP daily cap
 *  of 2 is the ceiling on how many accounts one test may mint from loopback.
 *  Every scenario below is sized to stay under it — a test that tripped the
 *  per-IP cap would report the wrong refusal and look like a surge. */
function register(url: string, email: string, captchaToken?: string): Promise<{ status: number; json: any }> {
  return post(`${url}/api/register`, {
    email,
    password: 'longenough1',
    ...(captchaToken !== undefined ? { captcha_token: captchaToken } : {}),
  });
}

describe('the counter: one day, one total, every mint', () => {
  it('rolls at UTC midnight and arms at the ruled number', () => {
    let t = Date.parse('2026-09-01T23:00:00.000Z');
    const c = new RegistrationSurgeCounter(() => t, 3);
    expect(c.surging()).toBe(false);
    c.record();
    c.record();
    expect(c.today()).toBe(2);
    expect(c.surging(), 'two mints is not three').toBe(false);
    c.record();
    expect(c.surging(), 'the gate arms AT the threshold, not one past it').toBe(true);

    // 00:00 UTC — a new day, a clean total. Stated as a test because the reset
    // instant is invisible from anywhere else.
    t = Date.parse('2026-09-02T00:00:00.000Z');
    expect(c.today()).toBe(0);
    expect(c.surging()).toBe(false);
  });

  it('the ruled default is 50, and it is the default the resolver uses', () => {
    expect(REGISTRATION_SURGE_THRESHOLD).toBe(50);
    const gate = resolveRegistrationSurgeGate({}, clock);
    expect(gate.counter.armsAt).toBe(50);
    // No secret in that env ⇒ the deployment cannot challenge, and the resolver
    // says so rather than looking armed.
    expect(gate.verifier.configured).toBe(false);
  });

  it('a junk threshold override keeps the ruled default — it never disables the gate', () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    for (const value of ['0', '-5', 'lots', '3.5']) {
      const gate = resolveRegistrationSurgeGate({ FLOWMIC_REGISTER_SURGE_THRESHOLD: value }, clock);
      expect(gate.counter.armsAt, value).toBe(REGISTRATION_SURGE_THRESHOLD);
    }
    expect(errors.mock.calls.length, 'every junk value is reported by name').toBe(4);
  });
});

describe('below the threshold there is zero friction', () => {
  it('an ordinary registration is untouched — no token asked for, no provider contacted', async () => {
    const { fetchImpl, bodies } = siteverify(() => true);
    const gate = {
      counter: new RegistrationSurgeCounter(clock, 50),
      verifier: makeTurnstileVerifier({ secret: 'sk-test', fetchImpl }),
    };
    const verdict = await guardRegistrationSurge(gate, '', '1.2.3.4', 'register');
    expect(verdict.ok).toBe(true);
    // 🔴 The provider is not merely unused, it is never REACHED. A gate that
    // called out to Cloudflare on every calm-day registration would be paid for
    // by every real user in exchange for a threat that arrives rarely.
    expect(bodies().length).toBe(0);
  });

  it('an absent gate (standalone, and every pre-card unit test) changes nothing', async () => {
    expect(await guardRegistrationSurge(undefined, '', '1.2.3.4', 'register')).toEqual({ ok: true });
  });
});

describe('at the threshold, registration demands a human check', () => {
  // ⚠️ THRESHOLD 1, AND THE REASON IS A REAL ORDERING FACT rather than test
  // convenience. In http/auth-routes.ts the PER-IP daily cap is checked before
  // the body is even read, so on a single-address test box the 3rd registration
  // meets REGISTER_RATE_LIMITED (429) and never reaches the surge gate at all.
  // Measured: with threshold 2 this assertion read「expected 429 to be 403」.
  // That order is correct in production — a per-address refusal is cheaper and
  // more specific than a global one — and it means the surge gate is only ever
  // observable on a request that is within its own address's budget.
  it('🔴 the registration past the threshold is refused by name, and the body says a captcha is required', async () => {
    const url = await saas(1, { turnstileSecret: 'sk-live-xxx' });
    expect((await register(url, 'first@v.co')).status).toBe(201);
    // One mint today; the gate arms AT the threshold, so this one meets it —
    // and it is still the SECOND mint from this address, i.e. inside the per-IP
    // cap, so what answers below is the surge gate and nothing else.
    const r = await register(url, 'second@v.co');
    expect(
      r.status,
      'a registration past the daily threshold was minted with NO captcha token — the surge gate is not in the path',
    ).toBe(403);
    expect(r.json.error).toBe(REGISTER_CAPTCHA_REQUIRED);
    // The SIGNAL the console needs: it renders the widget only after being told
    // to, so this flag is the whole difference between a page with a challenge
    // on it and a page without one.
    expect(r.json.captcha_required).toBe(true);
  });

  it('a token the provider will not vouch for gets its OWN name, and still asks for the widget', async () => {
    const { fetchImpl } = siteverify((tok) => tok === 'good-token');
    const gate = {
      counter: new RegistrationSurgeCounter(clock, 1),
      verifier: makeTurnstileVerifier({ secret: 'sk-live-xxx', fetchImpl }),
    };
    gate.counter.record();
    const bad = await guardRegistrationSurge(gate, 'forged-token', '1.2.3.4', 'register');
    expect(bad).toEqual({
      ok: false,
      status: 403,
      body: { error: REGISTER_CAPTCHA_INVALID, captcha_required: true },
    });
    // Two names, not one: 「we need one more step」 and 「that did not work」 are
    // different sentences to the person reading them.
    expect(REGISTER_CAPTCHA_INVALID).not.toBe(REGISTER_CAPTCHA_REQUIRED);
  });

  it('🔴 a solved token lets the registration through, over the REAL verifier', async () => {
    const { fetchImpl, bodies } = siteverify((tok) => tok === 'good-token');
    const gate = {
      counter: new RegistrationSurgeCounter(clock, 1),
      verifier: makeTurnstileVerifier({ secret: 'sk-live-xxx', fetchImpl }),
    };
    gate.counter.record();
    expect(await guardRegistrationSurge(gate, 'good-token', '198.51.100.7', 'register')).toEqual({ ok: true });
    // The wire format is asserted, not assumed: siteverify takes form encoding,
    // and a JSON body would be refused by Cloudflare in a way that looks exactly
    // like a wrong secret key.
    const sent = new URLSearchParams(bodies()[0] as string);
    expect(sent.get('secret')).toBe('sk-live-xxx');
    expect(sent.get('response')).toBe('good-token');
    expect(sent.get('remoteip'), 'the caller address travels as corroboration').toBe('198.51.100.7');
  });

  it('🔴 every failure of the CHECK ITSELF is a refusal, never a pass (fail closed)', async () => {
    const counter = new RegistrationSurgeCounter(clock, 1);
    counter.record();
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const arms: CaptchaFetch[] = [
      // siteverify answered with an HTTP error
      () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
      // the endpoint was unreachable
      () => Promise.reject(new Error('ECONNRESET')),
      // a body that is not the shape we expect
      () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: 'true' }) }),
      // and the honest negative
      () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: false }) }),
    ];
    for (const fetchImpl of arms) {
      const verifier = makeTurnstileVerifier({ secret: 'sk', fetchImpl });
      expect(await verifier.verify('any-token')).toBe(false);
    }
  });
});

describe('threshold met AND no captcha configured: the door closes, loudly', () => {
  it('🔴 503 by name, nothing minted, and the log line names the env var', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    // No FLOWMIC_TURNSTILE_SECRET — the resolver hands back the unconfigured
    // verifier, which is a REAL object that refuses, never a null.
    const url = await saas(1);
    expect((await register(url, 'lucky@v.co')).status).toBe(201);

    const closed = await register(url, 'unlucky@v.co');
    expect(closed.status).toBe(503);
    expect(closed.json.error).toBe(REGISTER_TEMPORARILY_CLOSED);
    // 🔴 NOT `captcha_required`: there is no challenge to solve, and telling the
    // console to draw a widget would send somebody to fail at a puzzle that
    // does not exist.
    expect(closed.json.captcha_required).toBeUndefined();
    // Presenting a token changes nothing — this box cannot check one.
    expect((await register(url, 'unlucky@v.co', 'anything')).status).toBe(503);

    const line = errors.mock.calls.find(([m]) => String(m).includes('REGISTRATION CLOSED'));
    expect(line, 'a closed front door must leave an actionable line').toBeTruthy();
    const fields = (line as [string, Record<string, unknown>])[1];
    expect(fields.env).toBe('FLOWMIC_TURNSTILE_SECRET');
    expect(fields.verifier).toBe('unconfigured');
    expect(fields.threshold).toBe(1);

    // And the trade, asserted rather than described: the account really was not
    // created, so a closed door costs a sign-up and never a silent mint.
    expect((await post(`${url}/api/login`, { email: 'unlucky@v.co', password: 'longenough1' })).status).toBe(401);
  });

  it('the unconfigured verifier refuses every token and reports itself as unconfigured', async () => {
    const v = unconfiguredCaptchaVerifier();
    expect(v.configured).toBe(false);
    expect(await v.verify('anything-at-all')).toBe(false);
  });
});

describe('every mint path counts, or the gate has its own bypass', () => {
  // The REAL Google verifier over a fake KEY FETCH — the google-login.test.ts
  // shape, for the reason stated there.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks: JsonWebKey[] = [
    { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: KID, alg: 'RS256', use: 'sig' },
  ];
  function mint(sub: string, email: string): string {
    const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
    const claims = {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub,
      email,
      email_verified: true,
      exp: Math.floor(T0 / 1000) + 3600,
      iat: Math.floor(T0 / 1000),
    };
    const h = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
    const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sig = createSign('RSA-SHA256').update(`${h}.${p}`, 'ascii').sign(privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
  }

  it('🔴 an account minted through Google counts toward the day’s total', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    process.env.FLOWMIC_REGISTER_SURGE_THRESHOLD = '1';
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {
      now: clock,
      googleVerifier: makeGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        now: clock,
        fetchJwks: () => Promise.resolve({ keys: jwks }),
      }),
    });
    const url = `http://127.0.0.1:${server.port}`;

    // ① One account, minted through the GOOGLE door. Nothing has touched
    //    /api/register at all.
    const first = await post(`${url}${GOOGLE_LOGIN_PATH}`, { credential: mint('g-1', 'one@gmail.com') });
    expect(first.status, JSON.stringify(first.json)).toBe(201);

    // ② …and the PASSWORD door is now gated, which is only possible if the two
    //    doors share one counter. No Turnstile secret on this box, so「gated」
    //    presents as the fail-closed 503.
    const blocked = await register(url, 'password-person@v.co');
    expect(
      blocked.status,
      'a Google sign-in minted an account that the day’s counter never saw — the surge gate can be walked past one Google account at a time',
    ).toBe(503);
    expect(blocked.json.error).toBe(REGISTER_TEMPORARILY_CLOSED);

    // ③ And the Google door gates ITSELF on the same total.
    const second = await post(`${url}${GOOGLE_LOGIN_PATH}`, { credential: mint('g-2', 'two@gmail.com') });
    expect(second.status).toBe(503);

    // ④ 🔴 A RETURNING Google user is NOT a mint. Signing in again with the
    //    SAME sub must not push the total further — otherwise a busy deployment
    //    would arm the gate on ordinary sign-ins, which is a self-inflicted
    //    outage rather than an anti-abuse measure. (This box is closed, so the
    //    observable is the count in the refusal line, not a 200.)
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await post(`${url}${GOOGLE_LOGIN_PATH}`, { credential: mint('g-1', 'one@gmail.com') });
    const line = errors.mock.calls.find(([m]) => String(m).includes('REGISTRATION CLOSED'));
    expect((line as [string, Record<string, unknown>])[1].minted_today).toBe(1);
  });
});

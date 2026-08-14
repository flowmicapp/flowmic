// Card VERIFY-1 — the console email-verification gate, end-to-end over a REAL
// in-process saas server (startServer, bootstrap wiring included), with the
// mail transport replaced by an injected fake PROVIDER so the real template,
// the real routes and the real store all run (the mail-password-reset harness
// shape). Behavior contract:
// docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md.
//
// The server runs on an injected fake clock (overrides.now) so the 15-minute
// TTL, the 60-second resend cooldown and the 3-per-15-min budget are DRIVEN,
// never slept for.
//
// 🔴 REVERSE CONTROL (a) — run red once, then reverted (2026-08-11): the
// constant-time compare in src/auth/email-verification.ts
// `verificationCodeMatches` was deliberately replaced with a bare string
// equality over the hashes (`return hashVerificationCode(presentedCode) ===
// storedHashHex;`, drill-marked DRILL-VERIFY1-A) — FUNCTIONALLY IDENTICAL, so
// all 19 behavioral cases here stayed green, which is exactly why the
// source-tree pin below has to exist: timing is not observable to a vitest
// assertion. Red output verbatim (the vitest `❯ file:line` pointer lines
// elided per the coordinate-anchors discipline; the failing assertion is named
// by symbol):
//
//   FAIL  test/email-verification.test.ts > pins: the compare is
//     hash-compare-only, constant-time, and the route uses it > 🔴
//     verificationCodeMatches goes through timingSafeEqual (source-tree pin)
//   AssertionError: verificationCodeMatches no longer goes through
//     timingSafeEqual — a string compare exits at the first differing
//     character, which is a per-digit oracle: expected false to be true
//     // Object.is equality
//   Tests  1 failed | 19 passed (20)
//
//   (the `expect(fnBody.includes('timingSafeEqual('), …).toBe(true)` assertion
//   below.) Drill reverted, suite green again, residue grep for the drill
//   marker = 0.
//
// 🔴 REVERSE CONTROL (b) — run red once, then reverted (2026-08-11): the
// attempts cap was deliberately disarmed in the confirm route (the death
// branch guarded with `if (false && attempts >= …)`, drill-marked
// DRILL-VERIFY1-B), i.e. a code that absorbs unlimited guesses. Red output
// verbatim (same elision):
//
//   FAIL  test/email-verification.test.ts > confirm: wrong guesses count down
//     to the code's death > 🔴 the 5th wrong guess kills the code
//     (VERIFY_TOO_MANY_ATTEMPTS), and even the RIGHT code is dead after
//   AssertionError: expected 400 to be 429 // Object.is equality
//   Tests  1 failed | 19 passed (20)
//
//   (the `expect(fifth.status).toBe(429)` assertion below — the 5th wrong
//   guess kept answering 400 VERIFY_CODE_INVALID, i.e. the code never died;
//   the follow-up error-name and 「right code after death」 assertions would
//   have bitten next had the run continued.) Drill reverted, suite green
//   again, residue grep = 0.
//
// *** HUMAN-AUDIT SENSITIVE (auth: account verification) ***

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ERROR_CODES, TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { hashPassword } from '../src/auth/password';
import {
  EMAIL_NOT_VERIFIED,
  EMAIL_VERIFICATION_CODE_TTL_MS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
} from '../src/auth/email-verification';
import {
  EMAIL_VERIFICATION_CONFIRM_PATH,
  EMAIL_VERIFICATION_SEND_PATH,
  VERIFY_ALREADY_VERIFIED,
  VERIFY_CODE_EXPIRED,
  VERIFY_CODE_INVALID,
  VERIFY_COOLDOWN,
  VERIFY_RATE_LIMITED,
  VERIFY_SEND_FAILED,
  VERIFY_TOO_MANY_ATTEMPTS,
} from '../src/http/email-verification-routes';
import { makeEmailVerificationMailer, type MailMessage, type MailProvider } from '../src/mail';
import { KEYMETA_NOT_FOUND, TIMELINE_KEYMETA_PATH } from '../src/http/timeline-keymeta-routes';
import { TIMELINE_GRANTS_PATH } from '../src/http/timeline-grants-routes';

const SECRET = 'email-verification-secret-32-bytes-xxx';
const T0 = Date.parse('2026-08-11T00:00:00.000Z');

let NOW = T0;
const clock = (): number => NOW;

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'flowmic-verify1-'));

afterEach(async () => {
  NOW = T0;
  delete process.env.FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO;
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});
// tmp dir cleanup piggybacks on the last afterEach of the process; vitest
// worker teardown removes it either way, and rmSync tolerates absence.
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

/** A recording transport: the real template runs, the bytes land here. */
function recordingProvider(): { provider: MailProvider; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    provider: {
      id: 'fake-recorder',
      send(message: MailMessage): Promise<void> {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

/** A transport whose vendor is having a bad minute — every send rejects. */
function failingProvider(): MailProvider {
  return {
    id: 'fake-failing',
    send(): Promise<void> {
      return Promise.reject(new Error('vendor answered 500'));
    },
  };
}

async function saas(provider: MailProvider, dbPath = ':memory:'): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath, trustedProxies: [] });
  server = await startServer(config, {
    now: clock,
    // The REAL product mailer over the fake transport, so buildEmailVerificationEmail
    // actually runs — a fake at the mailer level would leave the template untested.
    verificationMail: makeEmailVerificationMailer({ provider }),
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
async function registerUser(url: string, email: string): Promise<{ id: string; token: string }> {
  const r = await call('POST', `${url}/api/register`, { email, password: 'longenough1', display_name: 'V' });
  expect(r.status, `register ${email}`).toBe(201);
  return { id: r.json.user.id as string, token: r.json.token as string };
}

/** The code as the USER gets it — regexed out of the dispatched mail body, so
 *  the assertion chain is 「what was mailed opens the gate」, never 「what the
 *  server remembers matches what the server remembers」. */
function codeFromMail(msg: MailMessage): string {
  const m = /\b(\d{6})\b/.exec(msg.text);
  if (!m) throw new Error(`no 6-digit code in the mail body:\n${msg.text}`);
  return m[1] as string;
}
/** A guaranteed-wrong code derived from the right one (first digit flipped). */
function wrongCodeFrom(code: string): string {
  const d = code[0] === '9' ? '0' : String(Number(code[0]) + 1);
  return d + code.slice(1);
}

function send(url: string, token: string): Promise<{ status: number; json: any }> {
  return call('POST', `${url}${EMAIL_VERIFICATION_SEND_PATH}`, {}, bearer(token));
}
function confirm(url: string, token: string, code: string): Promise<{ status: number; json: any }> {
  return call('POST', `${url}${EMAIL_VERIFICATION_CONFIRM_PATH}`, { code }, bearer(token));
}
async function me(url: string, token: string): Promise<any> {
  const r = await call('GET', `${url}/api/me`, undefined, bearer(token));
  expect(r.status).toBe(200);
  return r.json.user;
}

// ── socket helpers (web-grant-preview harness shape) ────────────────────────
function connect(url: string, auth: Record<string, unknown>): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
function ack<T = any>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}

describe('happy path: send → mail carries the code → confirm → the product unlocks', () => {
  it('the whole chain, driven by the bytes the fake transport received', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'happy@v.co');

    // Before: /api/me says unverified, and a feature route refuses BY NAME.
    expect((await me(url, token)).email_verified).toBe(false);
    const walled = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(token));
    expect(walled.status).toBe(403);
    expect(walled.json).toEqual({ error: EMAIL_NOT_VERIFIED });

    // Send: 200, and the response NEVER carries the code (echo flag dark).
    const s = await send(url, token);
    expect(s.status).toBe(200);
    expect(s.json).toEqual({
      ok: true,
      expires_in_ms: EMAIL_VERIFICATION_CODE_TTL_MS,
      resend_cooldown_ms: EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
    });
    expect(sent).toHaveLength(1);
    const msg = sent[0] as MailMessage;
    expect(msg.to).toBe('happy@v.co');
    expect(msg.subject).toContain('verification code');
    // The template names the expiry instant persisted with the hash.
    expect(msg.text).toContain(new Date(NOW + EMAIL_VERIFICATION_CODE_TTL_MS).toISOString());

    // Confirm with the MAILED code.
    const code = codeFromMail(msg);
    const c = await confirm(url, token, code);
    expect(c.status).toBe(200);
    expect(c.json).toEqual({ ok: true, email_verified: true });

    // After: /api/me flips, the feature route admits, the code is single-use.
    expect((await me(url, token)).email_verified).toBe(true);
    expect((await call('GET', `${url}/api/cloud/summary`, undefined, bearer(token))).status).toBe(200);
    const replay = await confirm(url, token, code);
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe(VERIFY_ALREADY_VERIFIED);
    // …and a fresh send on a verified account is refused by name too.
    const resend = await send(url, token);
    expect(resend.status).toBe(409);
    expect(resend.json.error).toBe(VERIFY_ALREADY_VERIFIED);
  });
});

describe('confirm: wrong guesses count down to the code\'s death', () => {
  it('🔴 the 5th wrong guess kills the code (VERIFY_TOO_MANY_ATTEMPTS), and even the RIGHT code is dead after', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'attempts@v.co');
    await send(url, token);
    const code = codeFromMail(sent[0] as MailMessage);
    const wrong = wrongCodeFrom(code);

    // Four wrong guesses: refused by name, with the remaining budget counted
    // DOWN on the wire (4, 3, 2, 1) — a UI can warn before the cliff.
    for (let i = 1; i <= 4; i++) {
      const r = await confirm(url, token, wrong);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: VERIFY_CODE_INVALID, attempts_remaining: 5 - i });
    }
    // The 5th kills the row.
    const fifth = await confirm(url, token, wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.json.error).toBe(VERIFY_TOO_MANY_ATTEMPTS);
    // 🔴 The RIGHT code no longer opens anything — the row really died, this
    // was not a counter that keeps refusing while the code stays live.
    const late = await confirm(url, token, code);
    expect(late.status).toBe(400);
    expect(late.json.error).toBe(VERIFY_CODE_INVALID);
    expect(late.json.message).toContain('request a new one');
    expect((await me(url, token)).email_verified).toBe(false);

    // Recovery: a fresh send (past the cooldown) mints a NEW code with a full
    // budget, and it works.
    NOW += EMAIL_VERIFICATION_RESEND_COOLDOWN_MS + 1;
    const s2 = await send(url, token);
    expect(s2.status).toBe(200);
    const code2 = codeFromMail(sent[1] as MailMessage);
    expect((await confirm(url, token, code2)).status).toBe(200);
    expect((await me(url, token)).email_verified).toBe(true);
  });
});

describe('confirm: expiry', () => {
  it('a code past its 15-minute TTL is refused by name and burned', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'expiry@v.co');
    await send(url, token);
    const code = codeFromMail(sent[0] as MailMessage);

    NOW += EMAIL_VERIFICATION_CODE_TTL_MS; // exactly at expiry ⇒ dead (>=)
    const r = await confirm(url, token, code);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(VERIFY_CODE_EXPIRED);
    // Burned on read: the second confirm sees NO code, not 「expired」 again.
    const again = await confirm(url, token, code);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe(VERIFY_CODE_INVALID);
    expect(again.json.message).toContain('request a new one');
  });
});

describe('send: cooldown and budget', () => {
  it('a resend inside 60 s → VERIFY_COOLDOWN with the exact remaining wait; after it, a resend REPLACES the code', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'cooldown@v.co');
    await send(url, token);
    const first = codeFromMail(sent[0] as MailMessage);

    NOW += 10_000;
    const tooSoon = await send(url, token);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.json).toEqual({ error: VERIFY_COOLDOWN, retry_after_ms: EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 10_000 });
    expect(sent).toHaveLength(1); // nothing was mailed

    NOW += EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 10_000 + 1;
    expect((await send(url, token)).status).toBe(200);
    expect(sent).toHaveLength(2);
    const second = codeFromMail(sent[1] as MailMessage);
    // ONE active code per account: the replaced first code is dead even though
    // its own TTL has not passed — and the refusal costs one attempt, which is
    // the honest price of guessing against the live row.
    if (first !== second) {
      const stale = await confirm(url, token, first);
      expect(stale.status).toBe(400);
      expect(stale.json.error).toBe(VERIFY_CODE_INVALID);
    }
    expect((await confirm(url, token, second)).status).toBe(200);
  });

  it('the 4th send inside 15 min → VERIFY_RATE_LIMITED; the window really slides', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'budget@v.co');

    expect((await send(url, token)).status).toBe(200); // t=0
    NOW += 61_000;
    expect((await send(url, token)).status).toBe(200); // t=61 s
    NOW += 61_000;
    expect((await send(url, token)).status).toBe(200); // t=122 s
    NOW += 61_000;
    const fourth = await send(url, token); // t=183 s — 3 sends in the window
    expect(fourth.status).toBe(429);
    expect(fourth.json.error).toBe(VERIFY_RATE_LIMITED);
    expect(sent).toHaveLength(3);

    // Slide: once the FIRST send leaves the 15-minute window, one slot opens.
    NOW = T0 + 15 * 60 * 1000 + 1;
    expect((await send(url, token)).status).toBe(200);
    expect(sent).toHaveLength(4);
  });
});

describe('send: transport failure is a NAMED failure — never a silent 200', () => {
  it('a throwing provider → 502 VERIFY_SEND_FAILED, nothing stored, no cooldown started, no budget spent', async () => {
    const url = await saas(failingProvider());
    const { token } = await registerUser(url, 'sendfail@v.co');

    const r = await send(url, token);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe(VERIFY_SEND_FAILED);
    expect(typeof r.json.message).toBe('string');

    // Nothing was stored: confirm finds NO active code (not a wrong-code count).
    const c = await confirm(url, token, '000000');
    expect(c.status).toBe(400);
    expect(c.json.error).toBe(VERIFY_CODE_INVALID);
    expect(c.json.message).toContain('no active verification code');
    // No cooldown was started and no budget spent: an IMMEDIATE retry is not
    // refused as VERIFY_COOLDOWN/VERIFY_RATE_LIMITED — it fails only because
    // the vendor is still down.
    const retry = await send(url, token);
    expect(retry.status).toBe(502);
    expect(retry.json.error).toBe(VERIFY_SEND_FAILED);
  });
});

describe('the internal code echo (the goldens\' fixture) — dark by default, named when lit', () => {
  it('OFF (default): the send body carries NO code key — pinned against the exact key set', async () => {
    const { provider } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'dark@v.co');
    const s = await send(url, token);
    expect(s.status).toBe(200);
    expect(Object.keys(s.json).sort()).toEqual(['expires_in_ms', 'ok', 'resend_cooldown_ms']);
  });

  it('ON: the code is echoed, works, and a failed dispatch says dispatched:false instead of lying', async () => {
    process.env.FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO = '1';
    const url = await saas(failingProvider());
    const { token } = await registerUser(url, 'echo@v.co');
    const s = await send(url, token);
    expect(s.status).toBe(200);
    expect(s.json.code).toMatch(/^\d{6}$/);
    expect(s.json.dispatched).toBe(false); // the transport DID fail, and the body says so
    expect((await confirm(url, token, s.json.code)).status).toBe(200);
    expect((await me(url, token)).email_verified).toBe(true);
  });
});

describe('enforcement matrix — gated refuses unverified, admits verified; exempt admits unverified', () => {
  /** Every Bearer-gated CONSOLE FEATURE surface (decision doc D3's census).
   *  Route + method + a body that gets past parsing where one is needed. */
  const GATED: Array<[string, string, unknown?]> = [
    ['GET', '/api/cloud/summary'],
    ['GET', '/api/cloud/subscription'],
    ['GET', '/api/cloud/billing/events'],
    ['GET', '/api/cloud/devices'],
    ['GET', '/api/cloud/stt-routings'],
    ['POST', '/api/cloud/stt-routings', { routings: [] }],
    ['POST', '/api/cloud/stt-routings/test', { routing: { language: 'en', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:9/v1' } }],
    ['POST', '/api/cloud/devices/revoke', { pairing_id: 'p-x' }],
    // /api/account/export and /api/account/delete are DELIBERATELY ABSENT:
    // lead ruling on review (2026-08-11) exempts the two GDPR routes — the
    // account that most needs them is the one that cannot verify. Their
    // exemption is pinned in the exempt test below; re-gating them must
    // overturn that pin, not re-add two rows here.
    ['GET', TIMELINE_GRANTS_PATH],
    ['DELETE', `${TIMELINE_GRANTS_PATH}/gid-x`],
  ];

  it('🔴 unverified → 403 EMAIL_NOT_VERIFIED on every gated route; the SAME account verified → never that refusal', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'matrix@v.co');

    for (const [method, path, body] of GATED) {
      const r = await call(method, `${url}${path}`, body, bearer(token));
      expect(r.status, `${method} ${path} for an unverified account`).toBe(403);
      expect(r.json, `${method} ${path} refusal body`).toEqual({ error: EMAIL_NOT_VERIFIED });
    }

    // Verify through the REAL flow (not a repo poke): the matrix's admit half
    // then proves the same wiring end-to-end.
    await send(url, token);
    await confirm(url, token, codeFromMail(sent[0] as MailMessage));

    for (const [method, path, body] of GATED) {
      const r = await call(method, `${url}${path}`, body, bearer(token));
      expect(r.json?.error, `${method} ${path} for a VERIFIED account must not be the gate`).not.toBe(EMAIL_NOT_VERIFIED);
      expect(r.status, `${method} ${path} for a VERIFIED account`).not.toBe(403);
    }
  });

  it('orphans: gate ORDER — an unverified non-admin still reads ADMIN_ONLY (identity verdict first)', async () => {
    const { provider } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'orphans@v.co');
    const r = await call('GET', `${url}/api/cloud/billing/orphans`, undefined, bearer(token));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('ADMIN_ONLY'); // not EMAIL_NOT_VERIFIED — the admin refusal wins
    // …and an unverified ADMIN hits the verification gate (uniform census).
    const admin = server!.db.users.insert({ id: 'u-orph-admin', email: 'orph-admin@v.co', display_name: 'A', is_admin: true });
    const { signJwt } = await import('../src/auth/jwt');
    const adminToken = signJwt({ sub: admin.id, plan: admin.plan }, { secret: Buffer.from(SECRET, 'utf8'), now: clock });
    const r2 = await call('GET', `${url}/api/cloud/billing/orphans`, undefined, bearer(adminToken));
    expect(r2.status).toBe(403);
    expect(r2.json.error).toBe(EMAIL_NOT_VERIFIED);
  });

  it('exempt (unverified account): identity, recovery, the gate\'s own key, health, logout, and the PHONE keymeta surface all admit', async () => {
    const { provider } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'exempt@v.co');

    // GET /api/me — the UI's gate probe itself must never be walled.
    expect((await me(url, token)).email_verified).toBe(false);
    // login — an unverified account can still sign in (the gate is inside).
    expect((await call('POST', `${url}/api/login`, { email: 'exempt@v.co', password: 'longenough1' })).status).toBe(200);
    // password-reset family — recovery must work for EXACTLY the accounts the
    // gate walls (both routes answer without EMAIL_NOT_VERIFIED).
    expect((await call('POST', `${url}/api/password/forgot`, { email: 'exempt@v.co' })).status).toBe(200);
    // the two verification routes themselves (proven throughout, pinned here).
    expect((await send(url, token)).status).toBe(200);
    // health — anonymous, public by necessity.
    expect((await call('GET', `${url}/api/health`)).status).toBe(200);
    // logout — an acknowledgement; walling sign-OUT would trap the user.
    expect((await call('POST', `${url}/api/logout`)).status).toBe(200);
    // keymeta — the PHONE provisioner's surface (SALT-2), a device surface by
    // consumer: admitted (its own 404 = 「not enrolled」, NOT the gate's 403).
    const km = await call('GET', `${url}${TIMELINE_KEYMETA_PATH}`, undefined, bearer(token));
    expect(km.status).toBe(404);
    expect(km.json.error).toBe(KEYMETA_NOT_FOUND);
    const put = await call(
      'PUT',
      `${url}${TIMELINE_KEYMETA_PATH}`,
      { salt_b64: Buffer.from('0123456789abcdef', 'utf8').toString('base64'), sentinel: `${TIMELINE_E2E_PREFIX}s` },
      bearer(token),
    );
    expect(put.status).toBe(201);

    // GDPR pair — lead ruling on review (2026-08-11): export/delete are
    // data-subject rights and stay OPEN to unverified accounts. The account
    // that most needs them is exactly the one whose mailbox never delivers a
    // code; walling them would turn "cannot receive the code" into "cannot retrieve data or close the account".
    // Identity is still required (both 401 anonymously — asserted last).
    const exp = await call('GET', `${url}/api/account/export`, undefined, bearer(token));
    expect(exp.status, 'unverified export must be admitted').toBe(200);
    // delete with an unconfirmed body: the route's own named 400 answers —
    // reaching argument-validation proves the gate is not in front of it.
    const del = await call('POST', `${url}/api/account/delete`, {}, bearer(token));
    expect(del.json?.error, 'unverified delete must reach its own validation').not.toBe(EMAIL_NOT_VERIFIED);
    expect(del.status).not.toBe(403);
    // Signed-in password change — credential hygiene, not a product feature.
    // Wrong current password must reach AUTH_LOGIN_FAILED, not the verify wall.
    const pw = await call(
      'POST',
      `${url}/api/account/password`,
      { current_password: 'wrong-password-1', new_password: 'brandnewpass1' },
      bearer(token),
    );
    expect(pw.json?.error, 'unverified change-password must reach its own check').not.toBe(EMAIL_NOT_VERIFIED);
    expect(pw.status).not.toBe(403);
    expect(pw.status).toBe(401);
    expect(pw.json.error).toBe('AUTH_LOGIN_FAILED');
    expect((await call('GET', `${url}/api/account/export`)).status).toBe(401);
    expect((await call('POST', `${url}/api/account/delete`, {})).status).toBe(401);
    expect((await call('POST', `${url}/api/account/password`, { current_password: 'x', new_password: 'brandnewpass1' })).status).toBe(401);
  });

  it('exempt: EVERY device (pc/mobile kind) surface — an unverified phone pairs, pushes and pulls', async () => {
    const { provider } = recordingProvider();
    const url = await saas(provider);
    const { token } = await registerUser(url, 'phone@v.co');

    // Cloud admission (mobile kind) — the phone is out of scope by the owner's
    // own wording ("console").
    const phone = await connect(url, { jwt: token });
    const pair = await ack(phone, 'mobile:pair', { cloud_instance: true });
    expect(pair.pairing_id, JSON.stringify(pair)).toBeDefined();
    // The blind store read/write path from the phone: both admit.
    const push = await ack(phone, 'timeline:push', {
      entries: [{ id: 'b1', seq: 0, ciphertext: `${TIMELINE_E2E_PREFIX}bytes`, created_at: NOW, schema_ver: 1 }],
    });
    expect(push.ok, JSON.stringify(push)).toBe(true);
    const pull = await ack(phone, 'timeline:pull', {});
    expect(pull.error).toBeUndefined();
    expect(pull.blobs).toHaveLength(1);
  });
});

describe('web socket gates — an unverified web session can neither mint a grant nor pull blobs', () => {
  it('🔴 grant-request and pull answer EMAIL_NOT_VERIFIED; after a real confirm the SAME socket proceeds', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { id, token } = await registerUser(url, 'websock@v.co');

    const web = await connect(url, { jwt: token, client: 'web' });
    const refusedReq = await ack(web, 'timeline:grant-request', {
      web_pubkey: 'k'.repeat(43), session_fingerprint: 'f'.repeat(16), gid: 'gid-unverified', origin: 'https://x.test',
    });
    expect(refusedReq).toEqual({ error: EMAIL_NOT_VERIFIED });
    // pull: the gate outranks the grant check — 「verify first」 is the truthful
    // next action, so the ack must NOT be TIMELINE_GRANT_REQUIRED.
    const refusedPull = await ack(web, 'timeline:pull', {});
    expect(refusedPull).toEqual({ error: EMAIL_NOT_VERIFIED });
    // No pending was created and no grant row exists — the refusals were not
    // cosmetic wrappers around work that happened anyway.
    expect(server!.db.timelineGrants.listFor(id)).toHaveLength(0);

    // Verify through the REAL flow; the SAME socket (no reconnect — the gate
    // reads the DB per frame) is then admitted.
    await send(url, token);
    await confirm(url, token, codeFromMail(sent[0] as MailMessage));
    const admitted = await ack(web, 'timeline:grant-request', {
      web_pubkey: 'k'.repeat(43), session_fingerprint: 'f'.repeat(16), gid: 'gid-verified', origin: 'https://x.test',
    });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    // The pull now falls through the verification gate to the GRANT gate —
    // the pre-existing refusal, proving the two gates stayed distinct.
    const pullNow = await ack(web, 'timeline:pull', {});
    expect(pullNow).toEqual({ error: 'TIMELINE_GRANT_REQUIRED' });
  });
});

describe('grandfather — a pre-VERIFY-1 account stays unlocked (forward-port over a real legacy DB file)', () => {
  it('🔴 an account that predates the gate logs in verified and uses the console; a NEW account on the same server is walled', async () => {
    // A database that really predates the gate: the pre-D1 users shape, one
    // real account with a real scrypt hash (so /api/login truly verifies it).
    const dbPath = join(tmp, 'grandfather.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,
        email           TEXT UNIQUE,
        password_hash   TEXT,
        display_name    TEXT NOT NULL DEFAULT 'User',
        plan            TEXT NOT NULL DEFAULT 'free',
        locale          TEXT NOT NULL DEFAULT 'zh-CN',
        is_admin        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const hash = await hashPassword('longenough1');
    legacy.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES ('u-grandfather', 'old@v.co', ?, 'Old Hand')").run(hash);
    legacy.close();

    // Deploy day: startServer runs the migration on the existing file.
    const { provider } = recordingProvider();
    const url = await saas(provider, dbPath);

    const login = await call('POST', `${url}/api/login`, { email: 'old@v.co', password: 'longenough1' });
    expect(login.status).toBe(200);
    // Verified WITHOUT ever seeing a code: the migration stamp opens the gate
    // (the stamp answers "does the gate admit", not "when was it verified" — schema.ts).
    expect(login.json.user.email_verified).toBe(true);
    const oldToken = login.json.token as string;
    expect((await call('GET', `${url}/api/cloud/summary`, undefined, bearer(oldToken))).status).toBe(200);
    expect((await call('GET', `${url}${TIMELINE_GRANTS_PATH}`, undefined, bearer(oldToken))).status).toBe(200);
    // …and the verification routes refuse a grandfathered account by name —
    // there is nothing left for them to do.
    const s = await send(url, oldToken);
    expect(s.status).toBe(409);
    expect(s.json.error).toBe(VERIFY_ALREADY_VERIFIED);

    // The CONTROL: a registration on this SAME migrated server is walled —
    // the grandfather covered existing rows, not the future.
    const fresh = await registerUser(url, 'new-on-old-db@v.co');
    const walled = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(fresh.token));
    expect(walled.status).toBe(403);
    expect(walled.json.error).toBe(EMAIL_NOT_VERIFIED);
  });
});

describe('standalone mounts NEITHER verification route (saas-only, the keymeta mounting shape)', () => {
  it('send and confirm both answer the router\'s plain 404 on a real standalone server', async () => {
    const config = loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' });
    server = await startServer(config);
    const url = `http://127.0.0.1:${server.port}`;
    const s = await call('POST', `${url}${EMAIL_VERIFICATION_SEND_PATH}`, {});
    expect(s.status).toBe(404);
    expect(s.json?.error).not.toBe(VERIFY_ALREADY_VERIFIED);
    const c = await call('POST', `${url}${EMAIL_VERIFICATION_CONFIRM_PATH}`, { code: '123456' });
    expect(c.status).toBe(404);
    expect(c.json?.error).not.toBe(VERIFY_CODE_INVALID);
  });
});

describe('pins: the compare is hash-compare-only, constant-time, and the route uses it', () => {
  const policySrc = readFileSync(join(__dirname, '..', 'src', 'auth', 'email-verification.ts'), 'utf8');
  const routeSrc = readFileSync(join(__dirname, '..', 'src', 'http', 'email-verification-routes.ts'), 'utf8');

  it('🔴 verificationCodeMatches goes through timingSafeEqual (source-tree pin)', () => {
    // Timing is invisible to a behavioral assertion — swapping the body for a
    // string compare over the same hashes keeps every other test green. So the
    // pin reads the source: the compare FUNCTION must contain the constant-time
    // primitive, the way ops-audit-wiring pins its wiring from the tree.
    const start = policySrc.indexOf('export function verificationCodeMatches');
    expect(start).toBeGreaterThan(-1);
    const end = policySrc.indexOf('export ', start + 1);
    const fnBody = policySrc.slice(start, end === -1 ? undefined : end);
    expect(
      fnBody.includes('timingSafeEqual('),
      'verificationCodeMatches no longer goes through timingSafeEqual — a string compare exits at the first differing character, which is a per-digit oracle',
    ).toBe(true);
    // …and it compares HASHES, never the raw presented code against a stored code.
    expect(fnBody.includes('hashVerificationCode(')).toBe(true);
  });

  it('the confirm route delegates to verificationCodeMatches and never rolls its own equality', () => {
    expect(routeSrc.includes('verificationCodeMatches(')).toBe(true);
    // No hand-rolled equality against the stored hash anywhere in the route
    // (`presented === ''` — the missing-field check — is fine; comparing the
    // HASH with anything outside verificationCodeMatches is not).
    expect(/code_hash\s*===|===\s*[^=]*code_hash/.test(routeSrc)).toBe(false);
  });

  it('functional halves: right code matches, wrong code does not', async () => {
    const { hashVerificationCode, verificationCodeMatches } = await import('../src/auth/email-verification');
    const h = hashVerificationCode('042137');
    expect(verificationCodeMatches(h, '042137')).toBe(true);
    expect(verificationCodeMatches(h, '042138')).toBe(false);
  });
});

describe('pins: the owner-gated tables do not move, and the gate lives in exactly the declared files', () => {
  it('VERIFY_* + EMAIL_NOT_VERIFIED are HTTP/ack-local names, NOT protocol error codes', () => {
    // Same pin keymeta/mail hold for their families: these strings are local
    // diagnostics on the DIAG_*/KEYMETA_* precedent; minting protocol codes is
    // an owner gate this card deliberately never approaches (decision doc D2:
    // zero socket events, zero protocol codes).
    for (const name of [
      EMAIL_NOT_VERIFIED, VERIFY_ALREADY_VERIFIED, VERIFY_COOLDOWN, VERIFY_RATE_LIMITED,
      VERIFY_SEND_FAILED, VERIFY_CODE_INVALID, VERIFY_CODE_EXPIRED, VERIFY_TOO_MANY_ATTEMPTS,
    ]) {
      expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, name), `${name} must stay out of ERROR_CODES`).toBe(false);
    }
  });

  it('🔴 EMAIL_NOT_VERIFIED census: exactly the declared gate/definition files name it — every device surface stays exempt BY CONSTRUCTION', () => {
    // The console-admin-gate-coverage is_admin census shape: an exemption that
    // is 「nobody remembered to add the gate here」 and an exemption that is
    // 「the gate cannot be named here」 look identical at runtime; this pin makes
    // the second true. A sixth file naming the string — say, mobile.handler.ts
    // — fails here and forces the owner conversation the doctrine comments
    // demand (a protocol code for the phone).
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const srcRoot = join(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && readFileSync(p, 'utf8').includes('EMAIL_NOT_VERIFIED')) {
          hits.push(p.slice(srcRoot.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(srcRoot);
    expect(hits.sort()).toEqual([
      'auth/email-verification.ts', // the definition + doctrine
      // 2026-08-14: BYOK editor + TEST split out of console-routes.ts (800-line
      // cap). Same VERIFY-1 gate, not a new exemption. Census going red is
      // what forced this entry — same shape as usage-events-routes below.
      'http/byok-routes.ts',
      'http/console-routes.ts', // D3: console feature family
      'http/timeline-grants-routes.ts', // D3: grants REST
      // A2-5 / REQ-12-08 (2026-08-12): GET /api/cloud/usage/events. A file
      // split from console-routes.ts (800-line cap), not a new exemption.
      'http/usage-events-routes.ts',
      'socket/handlers/grant.handler.ts', // D3: web grant-request
      'socket/handlers/timeline.handler.ts', // D3: web pull
    ]);
  });
});

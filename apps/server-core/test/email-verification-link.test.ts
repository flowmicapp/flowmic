// Card NR-2a — the ONE-CLICK verification link, end-to-end over a REAL
// in-process saas server (startServer, bootstrap wiring included), with the mail
// transport replaced by an injected fake PROVIDER so the real template, the real
// routes and the real store all run. Same harness shape as
// test/email-verification.test.ts, deliberately: the two arms open the SAME gate
// and a second harness would be a second definition of what「verified」means.
//
// Behaviour contract:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 3
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §2
//
// 🔴 REVERSE CONTROL — run red once, then reverted (2026-08-27, dev-pc-a).
// SINGLE USE was disarmed in http/email-verification-routes.ts by deleting the
// `deps.settings.remove(...)` line that burns the row before the gate is opened
// (drill-marked DRILL-NR2A-REUSE), i.e. a link that keeps working forever. Red
// output verbatim (the vitest `❯ file:line` pointer lines elided per the
// coordinate-anchors discipline; the failing assertion is named by symbol):
//
//   FAIL  test/email-verification-link.test.ts > the link is SINGLE USE >
//     🔴 a second click on the same link is refused — the row was burned before
//     the gate was opened
//   AssertionError: expected 200 to be 400 // Object.is equality
//   - Expected  200
//   + Received  400
//
//   (the `expect(second.status).toBe(400)` assertion below; the follow-up
//   `expect(second.json.error).toBe(VERIFY_LINK_INVALID)` would have bitten
//   next had the run continued.) Drill reverted, suite green again, residue
//   grep for the drill marker = 0.
//
// *** HUMAN-AUDIT SENSITIVE (auth: account verification) ***

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ERROR_CODES } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import {
  EMAIL_VERIFICATION_CONFIRM_LINK_PATH,
  EMAIL_VERIFICATION_CONFIRM_PATH,
  EMAIL_VERIFICATION_SEND_PATH,
  VERIFY_CODE_INVALID,
  VERIFY_LINK_EXPIRED,
  VERIFY_LINK_INVALID,
  VERIFY_RATE_LIMITED,
} from '../src/http/email-verification-routes';
import {
  EMAIL_VERIFICATION_LINK_KEY,
  EMAIL_VERIFICATION_LINK_TTL_MS,
  splitVerificationLinkToken,
  verificationLinkMatches,
} from '../src/auth/verification-link';
import { REGISTER_MAX_ATTEMPTS } from '../src/auth/register-rate-limit';
import { EMAIL_VERIFICATION_CODE_TTL_MS } from '../src/auth/email-verification';
import {
  buildEmailVerificationEmail,
  makeEmailVerificationMailer,
  type MailMessage,
  type MailProvider,
} from '../src/mail';
import { log } from '../src/log';

const SECRET = 'nr2a-verification-link-secret-32-bytes';
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const VERIFY_BASE = 'https://flowmic.app/verify';

let NOW = T0;
const clock = (): number => NOW;
let server: BootstrapHandle | null = null;

afterEach(async () => {
  NOW = T0;
  vi.restoreAllMocks();
  if (server) await server.close();
  server = null;
});

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

async function saas(provider: MailProvider): Promise<string> {
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, {
    now: clock,
    // The REAL product mailer over the fake transport, WITH a verify base — so
    // buildEmailVerificationLink really runs and the assertions below read a
    // URL that was built the way production builds it.
    verificationMail: makeEmailVerificationMailer({ provider, verifyBaseUrl: VERIFY_BASE }),
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

/** Register and let the AUTO-SENT verification settle. Returns the account and
 *  the message that registration itself mailed — the very artefact this card
 *  exists to produce, so the assertions below drive the production path rather
 *  than a second send nobody's user performs. */
async function registerAndCollect(
  url: string,
  email: string,
  sent: MailMessage[],
): Promise<{ id: string; token: string; mail: MailMessage }> {
  const r = await call('POST', `${url}/api/register`, { email, password: 'longenough1', display_name: 'V' });
  expect(r.status, `register ${email}`).toBe(201);
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  expect(sent, 'registration must mail a verification by itself (NR-2a auto-send)').toHaveLength(1);
  return { id: r.json.user.id as string, token: r.json.token as string, mail: sent[0] as MailMessage };
}

/** The token as the USER gets it — pulled out of the mailed URL, never out of
 *  the store. The assertion chain has to be 「what was mailed opens the gate」;
 *  reading the row would only prove the server agrees with itself. */
function tokenFromMail(msg: MailMessage): string {
  const m = new RegExp(`${VERIFY_BASE}\\?token=([^\\s]+)`).exec(msg.text);
  if (!m) throw new Error(`no verification link in the mail body:\n${msg.text}`);
  return decodeURIComponent(m[1] as string);
}

function confirmLink(url: string, token: string): Promise<{ status: number; json: any }> {
  return call('POST', `${url}${EMAIL_VERIFICATION_CONFIRM_LINK_PATH}`, { token });
}
async function me(url: string, token: string): Promise<any> {
  const r = await call('GET', `${url}/api/me`, undefined, { authorization: `Bearer ${token}` });
  expect(r.status).toBe(200);
  return r.json.user;
}

describe('the one-click link: registration mails it, one POST opens the gate', () => {
  it('the whole chain, driven by the bytes the fake transport received', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token, mail } = await registerAndCollect(url, 'oneclick@v.co', sent);

    // The mail carries BOTH arms, link first (the conversion argument in
    // mail/email-verification-mailer.ts) and the code as the fallback.
    expect(mail.to).toBe('oneclick@v.co');
    expect(mail.text).toContain(`${VERIFY_BASE}?token=`);
    expect(mail.text).toMatch(/\b\d{6}\b/);
    expect(mail.text.indexOf('http')).toBeLessThan(mail.text.search(/\b\d{6}\b/));

    // 🔴 owner batch-2 item 4 — THE COPY MUST AGREE WITH THE CLOCK. The body is
    // what the person reads; the constant is what the route enforces. Until
    // 2026-08-27 the code's 「15 minutes」 was a hand-typed literal in the
    // template — an assertion about a constant, written where nothing checked
    // it — and the owner's link ruling (24h → 30 min) is exactly the edit that
    // would have left it saying the wrong thing. Both durations are derived
    // now; these two lines are what keeps that true.
    expect(
      mail.text,
      'the link sentence must state the ruled 30-minute window, not an ISO instant alone',
    ).toContain(`(${EMAIL_VERIFICATION_LINK_TTL_MS / 60_000} minutes after it was sent)`);
    expect(mail.text).toContain(`(${EMAIL_VERIFICATION_CODE_TTL_MS / 60_000} minutes after it was sent)`);
    // A positive control on the numbers themselves: this test would still pass
    // if BOTH constants were silently the same value, and 「link and code expire
    // together」 is precisely what the owner ruled against.
    expect(EMAIL_VERIFICATION_LINK_TTL_MS).not.toBe(EMAIL_VERIFICATION_CODE_TTL_MS);

    // Before: unverified, and a console feature route refuses.
    expect((await me(url, token)).email_verified).toBe(false);
    expect((await call('GET', `${url}/api/cloud/summary`, undefined, { authorization: `Bearer ${token}` })).status).toBe(403);

    // 🔴 NO BEARER on the confirm — that is the whole point of this arm.
    const link = tokenFromMail(mail);
    const r = await confirmLink(url, link);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, email_verified: true });

    // After: the gate is open on the SAME account, through the same projection.
    expect((await me(url, token)).email_verified).toBe(true);
    expect((await call('GET', `${url}/api/cloud/summary`, undefined, { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('🔴 the token addresses exactly ONE account — another account cannot be opened with it', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const a = await registerAndCollect(url, 'a@v.co', sent);
    sent.length = 0;
    const b = await registerAndCollect(url, 'b@v.co', sent);

    // A's own link verifies A and leaves B exactly as it was. Without the
    // per-account addressing this would be a global 「verify anybody」 button.
    expect((await confirmLink(url, tokenFromMail(a.mail))).status).toBe(200);
    expect((await me(url, a.token)).email_verified).toBe(true);
    expect((await me(url, b.token)).email_verified).toBe(false);

    // …and A's secret pasted onto B's user id is refused: the compare covers
    // the WHOLE stored token, so a swapped address half matches nothing.
    const aParts = splitVerificationLinkToken(tokenFromMail(a.mail))!;
    const forged = `${b.id}.${aParts.secret}`;
    const bad = await confirmLink(url, forged);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe(VERIFY_LINK_INVALID);
    expect((await me(url, b.token)).email_verified).toBe(false);
  });
});

describe('the link is SINGLE USE', () => {
  it('🔴 a second click on the same link is refused — the row was burned before the gate was opened', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { mail } = await registerAndCollect(url, 'once@v.co', sent);
    const link = tokenFromMail(mail);

    expect((await confirmLink(url, link)).status).toBe(200);

    const second = await confirmLink(url, link);
    expect(second.status).toBe(400);
    expect(second.json.error).toBe(VERIFY_LINK_INVALID);
  });

  it('confirming with the CODE also burns the link — one gate, no orphaned credential', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token, mail } = await registerAndCollect(url, 'both@v.co', sent);
    const code = /\b(\d{6})\b/.exec(mail.text)![1] as string;
    const link = tokenFromMail(mail);

    expect(
      (await call('POST', `${url}${EMAIL_VERIFICATION_CONFIRM_PATH}`, { code }, { authorization: `Bearer ${token}` })).status,
    ).toBe(200);
    // The link that arrived in the same message is now dead. Left alive it
    // would be a single-use credential in a mailbox with nothing left to do.
    const after = await confirmLink(url, link);
    expect(after.status).toBe(400);
    expect(after.json.error).toBe(VERIFY_LINK_INVALID);
    expect(server!.db.settings.read(
      (await me(url, token)).id as string,
      EMAIL_VERIFICATION_LINK_KEY,
    )).toBeNull();
  });

  it('a NEW send replaces the link — the older one stops working', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token, mail } = await registerAndCollect(url, 'replaced@v.co', sent);
    const first = tokenFromMail(mail);

    NOW += 61_000; // past the resend cooldown the auto-send legitimately started
    const s = await call('POST', `${url}${EMAIL_VERIFICATION_SEND_PATH}`, {}, { authorization: `Bearer ${token}` });
    expect(s.status).toBe(200);
    const second = tokenFromMail(sent[1] as MailMessage);
    expect(second).not.toBe(first);

    expect((await confirmLink(url, first)).json.error).toBe(VERIFY_LINK_INVALID);
    expect((await confirmLink(url, second)).status).toBe(200);
  });
});

describe('the link expires, and says so by its own name', () => {
  // owner batch-2 item 4 moved this window from 24 hours to 30 MINUTES. The
  // body reads the constant, so the ruling changed one number and no assertion;
  // the title is spelled out because a test called 「the 24-hour TTL」 that is
  // green against a 30-minute one is a lie told by a passing suite.
  it('past the 30-minute TTL → VERIFY_LINK_EXPIRED, and the row is burned on read', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token, mail } = await registerAndCollect(url, 'stale@v.co', sent);
    const link = tokenFromMail(mail);

    NOW = T0 + EMAIL_VERIFICATION_LINK_TTL_MS; // exactly at the deadline — dead
    const r = await confirmLink(url, link);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(VERIFY_LINK_EXPIRED);
    expect((await me(url, token)).email_verified).toBe(false);

    // Burned on read: the second attempt is now indistinguishable from a
    // stranger's, so an expired credential cannot be probed twice.
    expect((await confirmLink(url, link)).json.error).toBe(VERIFY_LINK_INVALID);
  });

  it('one second BEFORE the deadline it still works — the TTL is a real boundary, not a shape', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { mail } = await registerAndCollect(url, 'justintime@v.co', sent);
    NOW = T0 + EMAIL_VERIFICATION_LINK_TTL_MS - 1_000;
    expect((await confirmLink(url, tokenFromMail(mail))).status).toBe(200);
  });
});

describe('refusals are named, and never an oracle', () => {
  it('garbage / missing / unknown tokens all answer ONE name', async () => {
    const { provider } = recordingProvider();
    const url = await saas(provider);
    for (const body of [{}, { token: '' }, { token: 'no-dot-here' }, { token: 'x.y' }, { token: '.secret' }]) {
      const r = await call('POST', `${url}${EMAIL_VERIFICATION_CONFIRM_LINK_PATH}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error, JSON.stringify(body)).toBe(VERIFY_LINK_INVALID);
    }
  });

  it('a made-up token for a REAL account is refused exactly like one for a made-up account', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { id } = await registerAndCollect(url, 'real@v.co', sent);
    const forReal = await confirmLink(url, `${id}.aaaaaaaaaaaaaaaaaaaaaaaa`);
    const forNobody = await confirmLink(url, 'no-such-user.aaaaaaaaaaaaaaaaaaaaaaaa');
    // Byte-identical: a caller must not be able to learn that an account exists.
    expect(forReal.status).toBe(forNobody.status);
    expect(forReal.json).toEqual(forNobody.json);
  });

  it('the anonymous route is per-IP throttled — and by its OWN bucket, not the sign-in one', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    await registerAndCollect(url, 'throttle@v.co', sent);

    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect((await confirmLink(url, 'nobody.aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(400);
    }
    const over = await confirmLink(url, 'nobody.aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(over.status).toBe(429);
    expect(over.json.error).toBe(VERIFY_RATE_LIMITED);

    // 🔴 THE CONTROL that makes the assertion above mean something: a burned
    // link budget must NOT have spent the login budget. Without this, a shared
    // bucket would pass every line above and lock users out of signing in.
    const login = await call('POST', `${url}/api/login`, { email: 'throttle@v.co', password: 'longenough1' });
    expect(login.status).toBe(200);
  });
});

describe('pins', () => {
  it('🔴 NR-2a added no protocol error code — both link refusals are HTTP-local', () => {
    for (const name of [VERIFY_LINK_INVALID, VERIFY_LINK_EXPIRED, 'EMAIL_VERIFY_GRACE_EXPIRED']) {
      expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, name), `${name} must NOT be a protocol code`).toBe(false);
    }
  });

  it('🔴 the compare is constant-time over the WHOLE token (source-tree pin)', () => {
    // Timing is not observable to a vitest assertion — the same argument
    // test/email-verification.test.ts makes about `verificationCodeMatches`.
    // What IS assertable is that the function goes through timingSafeEqual, and
    // that has to be read off the SOURCE TREE rather than off
    // `Function.prototype.toString`: vitest transpiles the module and renames
    // the import, so the runtime body says `_nodeCrypto.timingSafeEqual` today
    // and could say anything tomorrow. The sibling test reads the file for the
    // same reason.
    const src = readFileSync(new URL('../src/auth/verification-link.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function verificationLinkMatches'));
    expect(
      fn.slice(0, fn.indexOf('\n}')).includes('timingSafeEqual('),
      'verificationLinkMatches no longer goes through timingSafeEqual — a string compare exits at the first differing character, which is a per-character oracle',
    ).toBe(true);
    // …and that it really discriminates, so the pin is not guarding a stub.
    expect(verificationLinkMatches('abc.def', 'abc.def')).toBe(true);
    expect(verificationLinkMatches('abc.def', 'abc.deg')).toBe(false);
    expect(verificationLinkMatches('abc.def', 'abc.de')).toBe(false);
  });

  it('the token is never echoed on the wire and never written to a log line', async () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { mail } = await registerAndCollect(url, 'quiet@v.co', sent);
    const link = tokenFromMail(mail);
    const r = await confirmLink(url, link);
    expect(r.status).toBe(200);
    // The success line exists (a silent success is its own defect) …
    expect(infos.mock.calls.some(([m]) => String(m).includes('one-click link'))).toBe(true);
    // … and carries no credential. A log that quotes the token is a takeover
    // kit with a retention policy.
    expect(JSON.stringify(infos.mock.calls)).not.toContain(link);
    expect(JSON.stringify(r.json)).not.toContain(link);
  });

  it('a mail with NO verify base carries the code alone — never a link to nowhere', () => {
    // mail/config.ts derives the base for every configured deployment, so this
    // is the shape a UNIT caller (or a pre-NR-2a test) produces. The rule it
    // pins: a half-built link must not be rendered at all.
    const msg = buildEmailVerificationEmail({
      to: 'x@v.co',
      code: '123456',
      expiresAt: '2026-09-01T00:15:00.000Z',
      linkToken: 'uid.secret',
    });
    expect(msg.text).not.toContain('http');
    expect(msg.text).toContain('123456');
  });

  it('the confirm-link route answers only to POST — a GET (every mail scanner) changes nothing', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    const { token, mail } = await registerAndCollect(url, 'scanner@v.co', sent);
    const link = tokenFromMail(mail);
    const scanned = await call('GET', `${url}${EMAIL_VERIFICATION_CONFIRM_LINK_PATH}?token=${encodeURIComponent(link)}`);
    expect(scanned.status).toBe(404);
    expect((await me(url, token)).email_verified).toBe(false);
    // …and the human's click still works afterwards: the scan did not spend it.
    expect((await confirmLink(url, link)).status).toBe(200);
  });
});

describe('registration auto-send: the wiring is REAL, and a mail outage is not a 500', () => {
  it('🔴 the production bootstrap really carries the dispatch — one register, one mail', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saas(provider);
    // Nothing here pokes a repo or hand-builds a deps object: this is
    // `startServer` + `POST /api/register`, which is the only way to prove the
    // wire exists (the `loginRecordEnabled` precedent).
    await registerAndCollect(url, 'wired@v.co', sent);
  });

  it('a dead transport still yields 201 + a usable session, and says so by name in the log', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const url = await saas({ id: 'fake-failing', send: () => Promise.reject(new Error('vendor answered 500')) });
    const r = await call('POST', `${url}/api/register`, {
      email: 'mailout@v.co', password: 'longenough1', display_name: 'V',
    });
    // 🔴 The account exists and the person is signed in. A mail outage must not
    // turn account creation into a failure the user can do nothing about.
    expect(r.status).toBe(201);
    expect(typeof r.json.token).toBe('string');
    expect((await me(url, r.json.token)).email_verified).toBe(false);

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    const line = errors.mock.calls.find(([m]) => String(m).includes('registration verification NOT SENT'));
    expect(line, 'the failure must be NAMED in the operator log').toBeTruthy();
    expect((line as [string, Record<string, unknown>])[1].code).toBe('MAIL_SEND_FAILED');

    // Nothing was stored: MINT → SEND → STORE means a failed transport leaves
    // no cooldown and no code behind. The user's first manual send therefore
    // is not refused as a resend.
    const c = await call(
      'POST', `${url}${EMAIL_VERIFICATION_CONFIRM_PATH}`, { code: '000000' },
      { authorization: `Bearer ${r.json.token}` },
    );
    expect(c.json.error).toBe(VERIFY_CODE_INVALID);
    expect(c.json.message).toContain('no active verification code');
  });
});

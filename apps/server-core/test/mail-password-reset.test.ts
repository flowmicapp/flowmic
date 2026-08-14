// MAIL-1 — 「the reset token now reaches a human」, proved end to end against a
// real saas server with an injected FAKE TRANSPORT.
//
// SPEC-REF: src/http/password-reset-routes.ts (the route + dispatchResetMail)
//           src/mail/ (provider seam, template, link builder, unconfigured)
//           CLAUDE.md red line: no silent failure (BOTH directions) / anti-façade ①②③
//
// WHY THE FAKE IS AT THE TRANSPORT LAYER AND NOT AT THE MAILER. A fake
// `PasswordResetMailer` would have let this file pass while the template
// rendered nothing, the link builder dropped the token, or the route called the
// wrong method — every layer this card actually built would have been replaced
// by the test double. So the double is one layer LOWER: a `MailProvider` that
// records the message, with the real `makePasswordResetMailer`, the real
// template and the real URL builder running above it. That is the difference
// between proving the chain and proving the mock (booklet 13 §7 F1 ③: a fully-green
// unit suite proves nothing about "wiring" — the closest a unit test gets is refusing to stub the thing
// under test).
//
// 🔴 WHAT THIS FILE DOES NOT PROVE, said plainly: no email has ever been sent
// from this repo. owner has not handed over the Resend API key, so
// `src/mail/resend.ts` — the one file that talks to a vendor — is [unmeasured].
// Every green below stops at the provider boundary.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { log } from '../src/log';
import { makePasswordResetMailer, unconfiguredPasswordResetMailer } from '../src/mail';
import type { MailMessage, MailProvider } from '../src/mail';
import { stripTsComments as stripComments } from '../../../verify/lint/strip-ts-comments.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');
const SECRET = 'mail-password-reset-secret-32-bytes-x';
const RESET_BASE = 'https://console.flowmic.test/reset-password';

let server: BootstrapHandle | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.FLOWMIC_INTERNAL_RESET_TOKEN_ECHO;
  if (server) await server.close();
  server = null;
});

/** A transport that records what it was handed. The REAL mailer, template and
 *  link builder sit on top of it. */
function recordingProvider(): { provider: MailProvider; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    provider: {
      id: 'fake-recording',
      send(message: MailMessage): Promise<void> {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

/** A transport that refuses, the way a vendor refuses: it throws. */
function throwingProvider(reason: string): MailProvider {
  return {
    id: 'fake-throwing',
    send(): Promise<void> {
      return Promise.reject(new Error(reason));
    },
  };
}

async function saasServer(provider?: MailProvider): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, {
    mail: provider
      ? makePasswordResetMailer({ provider, resetBaseUrl: RESET_BASE })
      : unconfiguredPasswordResetMailer(),
  });
  return `http://127.0.0.1:${server.port}`;
}

async function postRaw(url: string, body: unknown): Promise<{ status: number; raw: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, raw: await res.text() };
}

async function register(url: string, email: string, password = 'longenough1'): Promise<void> {
  await postRaw(`${url}/api/register`, { email, password, display_name: 'M' });
}

/** Delivery is dispatched WITHOUT await (password-reset-routes.ts explains why:
 *  awaiting would turn the constant-response property into a timing oracle), so
 *  the observable arrives just after the HTTP response. Poll for it rather than
 *  sleeping a guessed interval — a fixed sleep is either flaky or slow, and this
 *  is the seam where a 「it passed on my machine」 would come from. */
async function waitFor(what: string, predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

/** The pending reset as PERSISTED — the row the mail is supposed to be carrying.
 *  Read from the DB, not from the wire, so 「the link matches the token」 is a
 *  comparison against the source of truth rather than against itself. */
function persistedToken(email: string): string {
  const handle = server;
  if (!handle) throw new Error('no server');
  const user = handle.db.users.findByEmail(email);
  const id = user?.id;
  if (!id) throw new Error(`no user row for ${email}`);
  const row = handle.db.settings.read(id, 'account.password_reset');
  return ((row?.value ?? {}) as { reset_token?: string }).reset_token ?? '';
}

describe('MAIL-1 ①: the token minted by /api/password/forgot reaches the mail channel', () => {
  it('dispatches ONE message, to the account address, carrying a link with the persisted token', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'chain@mail.test');

    const res = await postRaw(`${url}/api/password/forgot`, { email: 'chain@mail.test' });
    expect(res.status).toBe(200);

    await waitFor('one dispatched message', () => sent.length > 0);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as MailMessage;

    // ① the right person
    expect(msg.to).toBe('chain@mail.test');
    expect(msg.subject).toBe('Reset your FlowMic password');

    // ② a real link, extracted from the rendered body — not from a return value
    //    the template never had to produce.
    const link = /https:\/\/\S+/.exec(msg.text)?.[0];
    expect(link, `no link in the rendered body:\n${msg.text}`).toBeTruthy();
    const parsed = new URL(link as string);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(RESET_BASE);

    // ③ the token in the link IS the token in the database. Compared against the
    //    persisted row, because a link that agrees only with itself proves
    //    nothing.
    const stored = persistedToken('chain@mail.test');
    expect(stored).not.toBe('');
    expect(parsed.searchParams.get('token')).toBe(stored);
    expect(parsed.searchParams.get('email')).toBe('chain@mail.test');

    // ④ 🔴 AND IT ACTUALLY WORKS. Everything above could hold for a token that
    //    the reset route rejects. Drive the real rotation with the values taken
    //    OUT OF THE EMAIL: this is the assertion that means 「a user who got this
    //    message can get back into their account」.
    const reset = await postRaw(`${url}/api/password/reset`, {
      email: parsed.searchParams.get('email'),
      reset_token: parsed.searchParams.get('token'),
      new_password: 'rotated-by-mail-1',
    });
    expect(reset.status).toBe(200);
    expect((await postRaw(`${url}/api/login`, { email: 'chain@mail.test', password: 'longenough1' })).status).toBe(401);
    expect((await postRaw(`${url}/api/login`, { email: 'chain@mail.test', password: 'rotated-by-mail-1' })).status).toBe(200);
  });

  it('the body never contains the raw token on its own — the token travels in the link', async () => {
    // Not cosmetic: a bare token pasted into a body is the thing users forward
    // to support, and the link is what they are meant to click. This also pins
    // that the template did not grow a 「your code is: …」 line.
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'linked@mail.test');
    await postRaw(`${url}/api/password/forgot`, { email: 'linked@mail.test' });
    await waitFor('a dispatched message', () => sent.length > 0);
    const msg = sent[0] as MailMessage;
    const token = persistedToken('linked@mail.test');
    const withoutLink = msg.text.replace(/https:\/\/\S+/g, '');
    expect(withoutLink).not.toContain(token);
  });

  it('🔴 mails the address ON FILE, not the string the request supplied', async () => {
    // `UserRepo.findByEmail` looks up through `normalizeEmail`, so a request can
    // name an address that MATCHES the account without BEING the stored one.
    // Handing the request's string to the MTA would let a caller choose which of
    // several equivalent-under-normalisation strings we actually deliver to.
    // Mailing `user.email` makes that choice unavailable rather than unlikely.
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'Mixed.Case@Mail.Test');

    await postRaw(`${url}/api/password/forgot`, { email: 'MIXED.CASE@MAIL.TEST' });
    await waitFor('a dispatched message', () => sent.length > 0);

    const handle = server;
    if (!handle) throw new Error('no server');
    const stored = handle.db.users.findByEmail('mixed.case@mail.test')?.email;
    expect(stored).toBeTruthy();
    // The discriminating assertion: the recipient is the DB value. If the route
    // ever goes back to forwarding the request string, `to` becomes the
    // all-caps one and this fails.
    expect((sent[0] as MailMessage).to).toBe(stored);
    expect((sent[0] as MailMessage).to).not.toBe('MIXED.CASE@MAIL.TEST');
  });

  it('an UNKNOWN address dispatches nothing (negative, with ① as its positive control)', async () => {
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'known@mail.test');

    const res = await postRaw(`${url}/api/password/forgot`, { email: 'nobody@mail.test' });
    expect(res.status).toBe(200);
    // A quiet 「nothing arrived」 could also mean the probe is blind, so prove the
    // SAME probe sees a real dispatch straight afterwards.
    await postRaw(`${url}/api/password/forgot`, { email: 'known@mail.test' });
    await waitFor('the control message', () => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect((sent[0] as MailMessage).to).toBe('known@mail.test');
  });
});

describe('MAIL-1 ②: the failure direction is NAMED, and never claims success', () => {
  it('a provider that throws → one ERROR line naming MAIL_SEND_FAILED, and NO 「dispatched」 line', async () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const infos = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const url = await saasServer(throwingProvider('resend: refused the message with HTTP 422 Unprocessable'));
    await register(url, 'fails@mail.test');

    const res = await postRaw(`${url}/api/password/forgot`, { email: 'fails@mail.test' });
    // The caller is told nothing about the failure — deliberately, see
    // dispatchResetMail's header (a distinguishable answer here would only ever
    // be produced for an address that EXISTS).
    expect(res.status).toBe(200);
    expect(res.raw).toBe('{"ok":true}');

    await waitFor(
      'the failure log line',
      () => errors.mock.calls.some(([m]) => String(m).includes('NOT delivered')),
    );
    const call = errors.mock.calls.find(([m]) => String(m).includes('NOT delivered')) as [string, Record<string, unknown>];
    const [msg, fields] = call;
    // It says what did NOT happen, and what DID (the token exists and is stranded).
    expect(msg).toContain('NOT delivered');
    expect(msg).toContain('nobody carried it');
    expect(fields.code).toBe('MAIL_SEND_FAILED');
    expect(fields.transport).toBe('fake-throwing');
    expect(fields.reason).toContain('422');
    // 🔴 …and it must not ALSO have said it worked. Without this, a route that
    // logged both lines would pass every assertion above.
    expect(infos.mock.calls.some(([m]) => String(m).includes('dispatched'))).toBe(false);
    // 🔴 The token itself is never in a log line — a log that carries it is an
    // account-takeover kit with a retention policy.
    const token = persistedToken('fails@mail.test');
    expect(token).not.toBe('');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(token);
  });

  it('POSITIVE CONTROL — a working provider logs 「dispatched」 and NO error', async () => {
    // Without this, the assertions above could be measuring a route that logs an
    // error on every request and never logs success at all.
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const infos = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'works@mail.test');

    await postRaw(`${url}/api/password/forgot`, { email: 'works@mail.test' });
    await waitFor('a dispatched message', () => sent.length > 0);
    await waitFor('the success line', () => infos.mock.calls.some(([m]) => String(m).includes('dispatched')));
    expect(errors.mock.calls.some(([m]) => String(m).includes('NOT delivered'))).toBe(false);
    // 「dispatched」, never 「sent」/「delivered」: what we know is that the transport
    // accepted it (MailProvider.send's contract). Pinned so a later 「nicer」
    // wording cannot quietly upgrade the claim.
    const line = String((infos.mock.calls.find(([m]) => String(m).includes('dispatched')) as [string])[0]);
    expect(line).not.toMatch(/\bsent\b|\bdelivered\b/);
  });

  it('an UNCONFIGURED deployment fails by name (MAIL_NOT_CONFIGURED) and names the env keys', async () => {
    // This is the case a no-op mailer would have made invisible: the deployment
    // cannot send anything, and the ONLY place that says so is this line.
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const url = await saasServer(); // no provider → unconfiguredPasswordResetMailer
    await register(url, 'nomail@mail.test');

    const res = await postRaw(`${url}/api/password/forgot`, { email: 'nomail@mail.test' });
    expect(res.raw).toBe('{"ok":true}');

    await waitFor('the failure log line', () => errors.mock.calls.some(([m]) => String(m).includes('NOT delivered')));
    const fields = (errors.mock.calls.find(([m]) => String(m).includes('NOT delivered')) as [string, Record<string, unknown>])[1];
    // 🔴 A DIFFERENT code from MAIL_SEND_FAILED, because it needs a different
    // action from a different person: 「set five env vars」 vs 「the vendor refused
    // this message」. One code for both would be one value answering two questions in the one place
    // an operator goes to find out which it was.
    expect(fields.code).toBe('MAIL_NOT_CONFIGURED');
    expect(fields.transport).toBe('unconfigured');
    expect(String(fields.reason)).toContain('FLOWMIC_MAIL_ENABLED');
    expect(String(fields.reason)).toContain('FLOWMIC_MAIL_RESET_BASE_URL');
  });
});

describe('MAIL-1 ③: the response is BYTE-IDENTICAL whatever happened', () => {
  it('unknown address / delivered / delivery failed all answer the same bytes', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    vi.spyOn(log, 'info').mockImplementation(() => undefined);

    const ok = recordingProvider();
    let url = await saasServer(ok.provider);
    await register(url, 'same@mail.test');
    const unknown = await postRaw(`${url}/api/password/forgot`, { email: 'ghost@mail.test' });
    const delivered = await postRaw(`${url}/api/password/forgot`, { email: 'same@mail.test' });
    await waitFor('the delivered message', () => ok.sent.length > 0);
    await server?.close();
    server = null;

    url = await saasServer(throwingProvider('vendor down'));
    await register(url, 'same@mail.test');
    const failed = await postRaw(`${url}/api/password/forgot`, { email: 'same@mail.test' });

    // 🔴 This is the anti-enumeration property M1 bought and MAIL-1 must not
    // spend. If delivery outcome ever leaks into the body or the status, 「mail
    // failed」 becomes 「this account exists」.
    expect(unknown.status).toBe(200);
    expect(delivered.raw).toBe(unknown.raw);
    expect(failed.raw).toBe(unknown.raw);
    expect(failed.status).toBe(unknown.status);
  });
});

describe('MAIL-1 ④: the echo flag is untouched, and delivery is NOT conditional on it', () => {
  it('with FLOWMIC_INTERNAL_RESET_TOKEN_ECHO=1 the body still echoes AND the mail still goes', async () => {
    // The flag is a developer affordance for reading the token off the wire on a
    // private line. It is not a switch that means 「do not mail this」 — if it
    // were, there would be a configuration in which a token is minted and
    // nothing carries it, which is the exact state this card closed.
    // g11 (verify/golden/g11-console-surface.mjs step 6) drives the echo-ON path
    // against a real server; this pins the half g11 cannot see.
    process.env.FLOWMIC_INTERNAL_RESET_TOKEN_ECHO = '1';
    const { provider, sent } = recordingProvider();
    const url = await saasServer(provider);
    await register(url, 'echo@mail.test');

    const res = await postRaw(`${url}/api/password/forgot`, { email: 'echo@mail.test' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.raw) as { ok: boolean; reset_token?: string; expires_at?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.reset_token).toBe('string');
    expect(typeof body.expires_at).toBe('string');

    await waitFor('a dispatched message', () => sent.length > 0);
    // The echoed token and the mailed token are the same one — one mint, two
    // readers, not two mints.
    expect((sent[0] as MailMessage).text).toContain(encodeURIComponent(body.reset_token as string));
  });
});

// ── ⑤ anti-façade: is any of this WIRED, and did the code table move? ────────
//
// The same instrument test/ops-audit-wiring.test.ts uses, for the same reason:
// 「a capability with no caller」 is this repo's #1 historical bug class, and a
// grep that has to be re-run by hand is a grep that gets run once.

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function srcFilesMatching(re: RegExp): string[] {
  return tsFilesUnder(SRC)
    .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
}

describe('MAIL-1 ⑤: wired, and no error code moved', () => {
  it('the mail channel has a PRODUCTION composition site outside src/mail/', () => {
    const callers = srcFilesMatching(/resolvePasswordResetMailer\s*\(/).filter((f) => !f.startsWith('mail/'));
    expect(callers).toEqual(['bootstrap.ts']);
  });

  it('a production route CALLS it — import-reachable is not called', () => {
    const callers = srcFilesMatching(/\.sendPasswordReset\s*\(/).filter((f) => !f.startsWith('mail/'));
    expect(callers).toEqual(['http/password-reset-routes.ts']);
  });

  it('🔴 no no-op mailer exists: every send/sendPasswordReset in src/ either awaits a transport or rejects', () => {
    // The failure this guards against is a future 「make the tests simpler」
    // commit adding `{ async sendPasswordReset() {} }` somewhere in src/. The
    // ONE implementation that resolves without a transport underneath would be
    // exactly that, so assert the set of implementers is the two we argued for.
    //
    // ⚠️ `mail/index.ts` is deliberately NOT in this list, and the first draft of
    // this assertion had it there — the run corrected the author. That file only
    // re-exports the symbol; it never names `sendPasswordReset(` or `:` after
    // comments are stripped. Left written down because 「I expected four and the
    // instrument said three」 is the one direction in which a wiring grep is
    // allowed to be wrong: it under-counts nothing, so a surprise here is always
    // the author's model, never a missing implementation.
    const implementers = srcFilesMatching(/sendPasswordReset\s*[(:]/);
    expect(implementers.sort()).toEqual([
      'http/password-reset-routes.ts', // caller + the deps type
      'mail/password-reset-mailer.ts', // the real one (delegates to a provider)
      'mail/unconfigured.ts', // the one that always rejects, by name
    ]);
  });

  it('MAIL_NOT_CONFIGURED / MAIL_SEND_FAILED are NOT protocol error codes', () => {
    // They are internal diagnostics for a log line. Adding a protocol code is an
    // owner gate (CLAUDE.md), and this card did not touch the table — asserted
    // rather than promised in a comment.
    const codes = Object.keys(ERROR_CODES);
    expect(codes).not.toContain('MAIL_NOT_CONFIGURED');
    expect(codes).not.toContain('MAIL_SEND_FAILED');
    expect(codes.filter((c) => c.startsWith('MAIL'))).toEqual([]);
  });
});

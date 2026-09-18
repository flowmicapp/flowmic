// NR-14 — nothing a mail transport failure produces may write an unbounded line
// into server.log. The caller is fire-and-forget
// (`http/password-reset-routes.ts` `dispatchResetMail`: `reason: err.message`),
// so the only place a cap can live is the message this file throws.
//
// Three foreign strings can reach that message, and before this card only one
// of them (`res.text()`) was capped. The other two are asserted here:
//   · the message of a REJECTED fetch — the timeout this file arms itself, and
//     every other transport failure (DNS, TLS, refused connection);
//   · `res.statusText`, the server's own reason phrase. It is NOT a constant:
//     any HTTP server may put any bytes there, and a provider having a bad day
//     is exactly the moment this file's cap is supposed to matter.
//
// 🔴 THE POSITIVE CONTROL IS THE FIRST TEST. Every assertion below is about a
// string being SHORT, and "short" is also what a silently broken provider that
// never says anything looks like — so the file first proves that a healthy send
// goes through untouched and that a normal-sized vendor reason survives
// verbatim. Without that, a `capped()` that returned '' would pass the rest.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResendMailProvider } from '../src/mail/resend';
import type { MailConfig } from '../src/mail/config';

const CONFIG: MailConfig = {
  provider: 'resend',
  apiKey: 'test-key-never-logged',
  from: 'FlowMic <noreply@example.test>',
  resetBaseUrl: 'https://example.test/reset-password',
  verifyBaseUrl: 'https://example.test/verify',
  endpoint: 'https://api.example.test/emails',
  fileDir: null,
};

const MESSAGE = { to: 'someone@example.test', subject: 'subject', text: 'body' };

/** The cap `resend.ts` applies. Deliberately re-stated rather than imported:
 *  the constant is private, and a test that imported it would move with it —
 *  which is the one change this file exists to notice. */
const ERROR_BODY_CAP = 400;

/** Comfortably past the cap, and made of one repeated character so a truncation
 *  is unambiguous in a failure message. */
const HUGE = 'x'.repeat(50_000);

function send(): Promise<void> {
  return createResendMailProvider(CONFIG).send(MESSAGE);
}

async function messageOf(promise: Promise<void>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('the send resolved; this test needs it to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NR-14 — positive controls, so the caps below are not proving silence', () => {
  it('a 2xx resolves and throws nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"id":"ok"}', { status: 200 }));
    await expect(send()).resolves.toBeUndefined();
  });

  it('a normal-sized vendor reason survives VERBATIM — the cap only bites when it has to', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"message":"from domain is not verified"}', {
      status: 403,
      statusText: 'Forbidden',
    }));
    const message = await messageOf(send());
    expect(message).toContain('HTTP 403 Forbidden');
    expect(message).toContain('from domain is not verified');
    expect(message).not.toContain('more)');
  });
});

describe('NR-14 — every foreign string in the thrown message is capped', () => {
  it('caps the TIMEOUT rejection, and says which failure it was', async () => {
    // What `AbortSignal.timeout` produces, with a runtime message long enough to
    // matter. `name` is the whole discriminator the production code reads.
    vi.stubGlobal('fetch', async () => {
      const err = new Error(`aborted: ${HUGE}`);
      err.name = 'TimeoutError';
      throw err;
    });
    const message = await messageOf(send());
    expect(message).toContain('gave up after 10000 ms without a response');
    // The count is computed, not typed: a suffix that said the wrong number
    // would be a second way to mislead the operator reading the log line.
    expect(message).toContain(`…(+${`aborted: ${HUGE}`.length - ERROR_BODY_CAP} more)`);
    expect(message.length).toBeLessThan(ERROR_BODY_CAP + 200);
  });

  it('caps a non-timeout transport rejection, and does NOT call it a timeout', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error(`getaddrinfo ENOTFOUND ${HUGE}`);
    });
    const message = await messageOf(send());
    // The two failures send an operator to two different places; collapsing them
    // would be this repo's #1 shape in the one line that explains the outage.
    expect(message).toContain('the request never completed');
    expect(message).not.toContain('gave up after');
    expect(message.length).toBeLessThan(ERROR_BODY_CAP + 200);
  });

  it('caps a huge response BODY', async () => {
    vi.stubGlobal('fetch', async () => new Response(HUGE, { status: 500, statusText: 'Server Error' }));
    const message = await messageOf(send());
    expect(message.length).toBeLessThan(ERROR_BODY_CAP + 200);
  });

  it('caps a huge statusText — the string nothing used to bound', async () => {
    // `Response`'s constructor rejects control characters in statusText but not
    // length; this is the shape a hostile or broken origin can actually send.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500, statusText: HUGE }));
    const message = await messageOf(send());
    expect(message).toContain(`…(+${HUGE.length - ERROR_BODY_CAP} more)`);
    expect(message.length).toBeLessThan(ERROR_BODY_CAP + 200);
  });

  it('never puts the API key in the message, on any failure path', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection reset');
    });
    expect(await messageOf(send())).not.toContain(CONFIG.apiKey);
  });
});

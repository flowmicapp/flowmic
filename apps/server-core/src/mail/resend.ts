// SPEC-REF:
//   src/mail/provider.ts (the interface, and why no no-op implements it)
//   src/mail/config.ts (FLOWMIC_MAIL_* → MailConfig)
//   docs/rebuild/10-OPS-DEPLOY.md §4.1
//
// The Resend HTTP transport: one POST, no SDK.
//
// WHY NO SDK. `resend`'s npm package would add a dependency to a server that
// today has three (protocol, socket.io, ws) for one JSON POST. It also puts a
// vendor's retry/timeout policy inside our process where nobody would read it.
//
// 🔴 NOT SENT ANYWHERE IN THIS FILE'S TESTS, AND NOT IN THIS CARD'S ACCEPTANCE.
// owner has not handed over the API key, so nothing in this repo has ever made
// this function talk to api.resend.com. What IS proven is the layer above it
// (mail/password-reset-mailer.ts + the route) against an injected fake provider.
// The honest status of THIS file is [untested] — written from the vendor's
// documented contract, never once observed. Whoever first sets a real key must
// treat that first send as the measurement, not as a formality.
//
// ✅ THAT FIRST MEASUREMENT HAPPENED — 2026-08-11, owner-supplied key, dev box
// (the paragraph above is kept as the record of the state it described):
//   · this exact function (compiled verbatim, driven through mailConfigFromEnv
//     and makePasswordResetMailer) dispatched the production-shaped reset mail
//     against the real api.resend.com in 756 ms, and the vendor's own status
//     read back `last_event: delivered`;
//   · the error branch was measured too: an unverified from-domain came back
//     HTTP 403 with the vendor's named reason, surfaced by the throw below.
// ⚠️ Account fact with no in-repo enforcement: the VERIFIED sending domain is
//   `mail.flowmic.app` — a FROM under flowmic.app is refused (403). The
//   operator sets FLOWMIC_MAIL_FROM; nothing here can pre-check domain
//   ownership, so a wrong domain fails loud per send, not at boot.
// This measures the TRANSPORT from a dev box. The production deployment
// (VPS env + relay restart + a real forgot-password click) is still unmeasured
// and is scheduled with the 2026-08-11 human-presence batch.

import type { MailConfig } from './config';
import type { MailMessage, MailProvider } from './provider';

/** How long we will wait on the mail API before giving up on ONE message.
 *
 *  A constant, not an env knob: the only sane values are all near this one, and
 *  every knob is a thing that can be set to a number nobody meant. The bound
 *  matters because the caller dispatches without awaiting the HTTP response
 *  (see password-reset-routes.ts) — an unbounded fetch would leave a pending
 *  socket per forgotten password, forever, with nothing to notice it. */
const SEND_TIMEOUT_MS = 10_000;

/** Vendor error bodies are echoed into our log line, so they are capped: a
 *  provider having a bad day must not be able to write megabytes into
 *  server.log through us. */
const ERROR_BODY_CAP = 400;

export function createResendMailProvider(config: MailConfig): MailProvider {
  return {
    id: 'resend',
    async send(message: MailMessage): Promise<void> {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          // 🔴 The key appears HERE and nowhere else — not in a log line, not in
          // the thrown Error below, not in the message. The one place an
          // operator can see anything about it is the boot line in
          // mail/index.ts, which prints its length.
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.from,
          // Resend's API takes an array here; `MailMessage.to` is deliberately
          // one address (see its doc comment) and this is the only place that
          // asymmetry lives.
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Read the body for the reason — a bare "422" sends an operator to the
        // vendor's dashboard to find out what we already had in our hands. The
        // read is best-effort: a failure to read the reason must not replace the
        // failure itself.
        const detail = await res.text().catch(() => '');
        throw new Error(
          `resend: refused the message with HTTP ${res.status} ${res.statusText}` +
            (detail === '' ? '' : ` — ${detail.slice(0, ERROR_BODY_CAP)}`),
        );
      }
      // 🔴 A 2xx means Resend ACCEPTED it, which is not the same as a mailbox
      // receiving it (bounces are asynchronous and arrive on a webhook this repo
      // does not have). `MailProvider.send`'s contract says exactly that, and the
      // caller's log line says "dispatched" for this reason.
    },
  };
}

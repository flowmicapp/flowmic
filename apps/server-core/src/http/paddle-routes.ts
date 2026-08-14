// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §5.1 (the path and the
//     reason it is NOT under /api/billing/ — that paragraph is quoted below
//     because §5.1 explicitly requires it to live in the code), §5.3 step 1
//   apps/server-core/src/billing/paddle/webhook-handler.ts (steps 2-7)
//   CLAUDE.md red line: no silent failure; four sensitive-path classes require
//     human review (billing)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// POST /api/paddle/webhook — Paddle's notification ingress.
//
// ── 🔴 WHY THIS PATH IS NOT UNDER `/api/billing/` (D1 §5.1, verbatim) ───────
// "Deliberately not placed under the /api/billing/ prefix: router.ts has two
// gates on that prefix — ① isLocalRequest, ② resolveUserId's Bearer gate.
// Paddle will not carry our Bearer token, so mounting it there would mean
// 'today it slips through by luck of handler ordering, tomorrow someone moves
// the gate up one line and it's 401 across the board, and a 401 is silent to
// Paddle.' A separate prefix makes this structurally impossible."
//
// In this file's own words, because the next person will be reading English:
// both of those gates would refuse Paddle. Paddle dials in from the public
// internet (so gate ① sees a non-local peer — and in saas, where nginx makes
// every request LOOK loopback, it would pass for the wrong reason) and it
// carries no FlowMic Bearer token (so gate ② has nobody to resolve). Today the
// mock-billing block sits at the BOTTOM of the router, so a webhook mounted
// above it would slip past by ordering alone — and the day someone hoists the
// local-only check to the top of the handler for perfectly good reasons, every
// webhook starts 401ing. Paddle does not tell us that: it just retries, backs
// off, and eventually stops, and the first symptom is a user who paid and never
// got upgraded. A separate prefix makes that failure structurally impossible
// rather than a matter of line order.
//
// WHAT AUTHENTICATES THIS ROUTE INSTEAD is the HMAC over the raw body
// (billing/paddle/signature.ts). That is a stronger credential than either gate
// it replaces: it proves the BYTES came from someone holding the notification
// secret, not merely that a connection came from somewhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePaddleWebhook, type PaddleWebhookDeps } from '../billing/paddle/webhook-handler';
import { log } from '../log';
import { readBounded, sendJson } from './body';

/** Exported for its ONE test consumer (`test/paddle-webhook-route.test.ts`), the
 *  same reason `PC_PRESENCE_PATH` is exported: a hand-copied literal in a test
 *  can drift into passing against a route nobody serves. router.ts does not name
 *  it — it delegates the whole match to `tryHandlePaddleRoutes`. */
export const PADDLE_WEBHOOK_PATH = '/api/paddle/webhook';

/** Node lowercases incoming header names; Paddle sends `Paddle-Signature`. */
export const PADDLE_SIGNATURE_HEADER = 'paddle-signature';

/** 256 KiB (D1 §5.3 step 1). A Paddle notification is a few KB; the cap exists
 *  so an anonymous POST — and this route IS anonymous until the HMAC is checked
 *  — cannot make us buffer megabytes before we have any reason to trust it. */
export const MAX_PADDLE_WEBHOOK_BYTES = 256 * 1024;

export const PADDLE_BODY_TOO_LARGE = 'PADDLE_BODY_TOO_LARGE';
export const PADDLE_BODY_UNREADABLE = 'PADDLE_BODY_UNREADABLE';

export interface PaddleRoutesDeps {
  webhook: PaddleWebhookDeps;
}

/** Returns true iff it handled the request. */
export function tryHandlePaddleRoutes(req: IncomingMessage, res: ServerResponse, deps: PaddleRoutesDeps): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url !== PADDLE_WEBHOOK_PATH) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  void (async () => {
    // ── step 1 · the raw bytes, bounded ───────────────────────────────────
    //
    // 🔴 RAW. `readBounded` hands back the received bytes decoded as UTF-8 and
    // the HMAC re-encodes that same string as UTF-8, which is byte-for-byte
    // lossless for the JSON Paddle sends. Nothing here parses and re-serializes:
    // `JSON.parse` + `JSON.stringify` preserves the VALUES and rewrites the
    // BYTES (whitespace, escapes, number formatting), and one rewritten byte is
    // a signature that can never match. If a body ever did arrive as invalid
    // UTF-8, the round trip would differ and the verdict would be `mismatch` —
    // i.e. it fails CLOSED, which is the direction a signature check must fail.
    const body = await readBounded(req, MAX_PADDLE_WEBHOOK_BYTES).catch(() => null);
    if (body === null) {
      // Peer went away mid-body. Nothing was verified and nothing was written;
      // say so rather than leaving the socket to time out (no silent failure).
      log.warn('paddle webhook: body could not be read');
      sendJson(res, 400, { ok: false, error: PADDLE_BODY_UNREADABLE });
      return;
    }
    if (body === 'TOO_LARGE') {
      // 413 AND A LOG LINE (D1 §5.3 step 1: "over the cap → 413 and speak up").
      // Silence here would look exactly like a delivery that never arrived —
      // and "Paddle says it sent it, we say we never got it" is the single
      // hardest thing to diagnose after the fact, because neither side holds
      // the other's evidence.
      log.warn('paddle webhook: body over the cap — refused unread', { max_bytes: MAX_PADDLE_WEBHOOK_BYTES });
      sendJson(res, 413, { ok: false, error: PADDLE_BODY_TOO_LARGE, max_bytes: MAX_PADDLE_WEBHOOK_BYTES });
      return;
    }

    const rawHeader = req.headers[PADDLE_SIGNATURE_HEADER];
    // A repeated header arrives from Node as one comma-joined string, which
    // cannot parse as `ts=…;h1=…` and lands in `malformed` — an honest 401.
    // The array form only occurs for set-cookie, which this is not; treating it
    // as absent keeps the type narrow without inventing a merge rule.
    const signature = typeof rawHeader === 'string' ? rawHeader : undefined;

    // ── steps 2-7 live in the handler, in one testable sequence ────────────
    const out = handlePaddleWebhook(deps.webhook, { rawBody: body, signature });
    sendJson(res, out.status, out.body);
  })().catch((e) => {
    // A route that dies mid-flight must still answer. 500 is the CORRECT answer
    // here (unlike the 200s the handler gives its own refusals): an exception
    // means we do not know what happened, and Paddle's retry is the recovery —
    // the event's ledger row is either absent or still 'pending', so the retry
    // either claims it fresh or is told 「already seen」, and neither path
    // applies a state write twice.
    log.warn('paddle webhook: route failed', { error: String(e) });
    try {
      sendJson(res, 500, { ok: false, error: 'PADDLE_INTAKE_FAILED' });
    } catch {
      /* headers already sent — nothing more truthful is possible */
    }
  });

  return true;
}

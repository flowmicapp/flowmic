// Window D1 Lane C — POST /api/paddle/webhook, at the router level.
//
// The handler's decisions are covered in paddle-webhook-handler.test.ts. What is
// only observable HERE:
//   ① 🔴 MOUNTING. The route exists only in saas with paddle enabled; in
//      standalone, and in saas with paddle off, the path must fall through to
//      the router's 404 — not to a half-mounted endpoint;
//   ② 🔴 IT IS NOT UNDER `/api/billing/`, so it never meets that prefix's two
//      gates (isLocalRequest + the Bearer resolve). Asserted as a BEHAVIOUR — a
//      webhook from a non-local peer with no Authorization header succeeds —
//      because that is the thing that would break if someone moved it;
//   ③ the 256 KiB cap answers 413 rather than dying quietly;
//   ④ a wrong METHOD is 405, and an unrelated path is not swallowed.
//
// A REAL router (`makeHttpHandler`) over a REAL config (`loadConfig`) and a REAL
// database: the mounting condition lives in router.ts + config.ts, so a fake
// config would only prove this test agrees with itself.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import {
  MAX_PADDLE_WEBHOOK_BYTES,
  PADDLE_BODY_TOO_LARGE,
  PADDLE_BODY_UNREADABLE,
  PADDLE_SIGNATURE_HEADER,
  PADDLE_WEBHOOK_PATH,
} from '../src/http/paddle-routes';
import { PADDLE_SIGNATURE_INVALID } from '../src/billing/paddle/webhook-handler';
import { signPaddlePayload } from '../src/billing/paddle/signature';
import { loadConfig, type ServerConfig } from '../src/config';
import { createDbConnection } from '../src/db/connection';
import { BillingService } from '../src/billing/billing-service';
import { makeAuthService } from '../src/auth/auth-service';
import { deriveKey } from '../src/auth/crypto';
import { resetPlanLimits } from '../src/billing/plans';

const SECRET = 'pdl_ntfset_01j0_TESTONLY_not_a_real_secret';
const DEPLOY_SECRET = 'deploy-secret-32-bytes-or-more-xxxx';
const PRICE_PRO = 'pri_pro_monthly_test';
const TS = 1_780_000_000;
const NOW_MS = TS * 1000;

const BODY = JSON.stringify({
  event_id: 'evt_route_1',
  event_type: 'subscription.activated',
  occurred_at: '2026-08-01T10:00:00.000000Z',
  notification_id: 'ntf_route_1',
  data: {
    id: 'sub_R',
    status: 'active',
    customer_id: 'ctm_1',
    items: [{ price: { id: PRICE_PRO } }],
    current_billing_period: { ends_at: '2026-09-01T00:00:00.000000Z' },
    custom_data: { flowmic_user_id: 'u1' },
  },
});

function request(method: string, url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = headers;
  // A PUBLIC peer — Paddle dials in from the internet. If this route ever grew
  // an isLocalRequest gate, this address is what would fail it.
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '203.0.113.9' };
  return req;
}

function response(): { res: ServerResponse; read(): { status: number; body: Record<string, unknown> } } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      body = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
    },
    once() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

function config(over: { mode?: 'saas' | 'standalone'; enabled?: boolean } = {}): ServerConfig {
  resetPlanLimits(); // loadConfig installs a table as a side effect
  const mode = over.mode ?? 'saas';
  return loadConfig({
    mode,
    secret: DEPLOY_SECRET,
    // fix-010: declared proxy posture — an in-process server has nothing in
    // front of it, so its direct peer IS the client (config.ts §trustedProxies).
    trustedProxies: [],
    ...(mode === 'saas' ? { dbPath: ':memory:' } : {}),
    paddle: {
      enabled: over.enabled ?? true,
      webhookSecret: SECRET,
      toleranceSec: 5,
      priceTiers: { [PRICE_PRO]: 'pro' },
    },
  });
}

/** The router, wired the way bootstrap wires it (paddle present only when the
 *  deployment is saas AND enabled — the same condition, read from the same
 *  resolved config). */
function world(over: { mode?: 'saas' | 'standalone'; enabled?: boolean } = {}) {
  const cfg = config(over);
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(DEPLOY_SECRET) });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing,
    unlockAll: false, now: () => NOW_MS,
  });
  // The REAL saas Bearer verifier, wired exactly as bootstrap wires it. Not a
  // formality: `makeResolveUserId` REFUSES to build a saas resolver without one
  // (it will not fall back to a shared user), so this router carries the full
  // credential machinery — and the first test below still gets a 200 with no
  // Authorization header at all. That is the 「not behind /api/billing/'s gates」
  // claim proven against the gates, rather than against a router that has none.
  const authService = makeAuthService({ users: db.users, jwtSecret: Buffer.from(DEPLOY_SECRET, 'utf8'), now: () => NOW_MS });
  const handler = makeHttpHandler({
    config: cfg,
    billing,
    version: 'test',
    resolveUserId: makeResolveUserId({
      mode: cfg.mode,
      standaloneUserId: 'default',
      ...(cfg.mode === 'saas' ? { account: authService } : {}),
    }),
    ...(cfg.mode === 'saas' && cfg.paddle.enabled
      ? {
          paddle: {
            webhook: {
              repo: db.billing,
              users: db.users,
              secret: cfg.paddle.webhookSecret ?? '',
              toleranceSec: cfg.paddle.toleranceSec,
              priceTiers: cfg.paddle.priceTiers,
              now: () => NOW_MS,
            },
          },
        }
      : {}),
  });
  return { db, handler };
}

/** Dispatch and wait for the async route body to settle. */
async function post(
  handler: ReturnType<typeof world>['handler'],
  body: string,
  opts: { headers?: Record<string, string>; method?: string; url?: string } = {},
) {
  const signed = { [PADDLE_SIGNATURE_HEADER]: `ts=${TS};h1=${signPaddlePayload(body, TS, SECRET)}` };
  const r = response();
  const handled = handler(
    request(opts.method ?? 'POST', opts.url ?? PADDLE_WEBHOOK_PATH, body, opts.headers ?? signed),
    r.res,
  );
  // The route reads the body asynchronously; let the stream drain and the
  // promise chain settle before reading the response.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { handled, ...r.read() };
}

describe('the wire strings themselves', () => {
  it('pins the path and the refusal codes', () => {
    // The tests below assert through the CONSTANTS, which is what stops a
    // hand-copied literal from drifting into passing against a route nobody
    // serves. That trade needs paying for exactly once: if the constants are the
    // only oracle, renaming one silently renames the contract. This is the one
    // place the literal values are written down.
    expect(PADDLE_WEBHOOK_PATH).toBe('/api/paddle/webhook');
    expect(PADDLE_SIGNATURE_HEADER).toBe('paddle-signature'); // Node lowercases `Paddle-Signature`
    expect(PADDLE_SIGNATURE_INVALID).toBe('PADDLE_SIGNATURE_INVALID');
    expect(PADDLE_BODY_TOO_LARGE).toBe('PADDLE_BODY_TOO_LARGE');
    expect(MAX_PADDLE_WEBHOOK_BYTES).toBe(256 * 1024);
  });
});

describe('② 🔴 the route is NOT behind /api/billing/ two gates', () => {
  it('accepts a webhook from a PUBLIC peer carrying no Authorization header', () => {
    // This is the whole argument for the separate prefix, as a behaviour: the
    // `/api/billing/` block refuses a non-local peer AND an unidentified caller,
    // and Paddle is both. A 401/403 here would be invisible to us — Paddle just
    // retries, backs off, gives up, and a user who paid never gets upgraded.
    return post(world().handler, BODY).then((out) => {
      expect(out.handled).toBe(true);
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, outcome: 'applied' });
    });
  });

  it('and the subscription really landed — the positive control for that 200', async () => {
    const { db, handler } = world();
    await post(handler, BODY);
    const row = db.billing.getSubscription('sub_R');
    expect(row?.user_id).toBe('u1');
    expect(row?.tier).toBe('pro');
    expect(row?.current_period_end).toBe('2026-09-01T00:00:00.000Z');
  });

  it('still refuses a bad signature — 「no Bearer gate」 is not 「no gate」', async () => {
    const out = await post(world().handler, BODY, { headers: { [PADDLE_SIGNATURE_HEADER]: `ts=${TS};h1=${'0'.repeat(64)}` } });
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ error: PADDLE_SIGNATURE_INVALID });
  });

  it('a missing Paddle-Signature header is 401, not an accept', async () => {
    const out = await post(world().handler, BODY, { headers: {} });
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ reason: 'missing_header' });
  });
});

describe('① 🔴 mounting', () => {
  it('is NOT mounted in standalone — the path falls through to the router 404', async () => {
    const { db, handler } = world({ mode: 'standalone' });
    const out = await post(handler, BODY);
    // `handled === false` is the router saying 「not mine」, which bootstrap's
    // createServer turns into the shared 404. A `true` here would mean the
    // route answered — the thing that must not happen on a LAN box.
    expect(out.handled).toBe(false);
    expect(db.billing.getSubscription('sub_R')).toBeNull();
  });

  it('is NOT mounted in saas when paddle is disabled', async () => {
    const { db, handler } = world({ enabled: false });
    const out = await post(handler, BODY);
    expect(out.handled).toBe(false);
    expect(db.billing.getSubscription('sub_R')).toBeNull();
  });

  it('IS mounted in saas with paddle enabled — the positive control for both', async () => {
    const out = await post(world().handler, BODY);
    expect(out.handled).toBe(true);
    expect(out.status).toBe(200);
  });

  it('🔴 refuses even when the deps ARE present, if the config says standalone', async () => {
    // Simulates a bootstrap that wired `paddle` where it should not have. This
    // is the case that makes router.ts's own `config.mode === 'saas' &&
    // config.paddle.enabled` test load-bearing rather than decorative: without
    // it, one mis-wired dep opens a webhook endpoint on someone's LAN box.
    const cfg = config({ mode: 'standalone', enabled: false });
    expect(cfg.paddle.enabled).toBe(false); // the premise: config clamped it
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(DEPLOY_SECRET) });
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
    const handler = makeHttpHandler({
      config: cfg,
      billing: new BillingService({
        settings: db.settings, users: db.users, usage: db.usage, billing: db.billing,
        unlockAll: false, now: () => NOW_MS,
      }),
      version: 'test',
      resolveUserId: makeResolveUserId({ mode: cfg.mode, standaloneUserId: 'default' }),
      // The mis-wiring, deliberately, with a perfectly valid secret:
      paddle: {
        webhook: {
          repo: db.billing, users: db.users, secret: SECRET, toleranceSec: 5,
          priceTiers: { [PRICE_PRO]: 'pro' }, now: () => NOW_MS,
        },
      },
    });
    const out = await post(handler, BODY);
    expect(out.handled).toBe(false);
    expect(db.billing.getSubscription('sub_R')).toBeNull();
  });

  it('does not swallow a neighbouring path', async () => {
    const out = await post(world().handler, BODY, { url: '/api/paddle/webhook/extra' });
    expect(out.handled).toBe(false);
  });

  it('answers the same path on a query string (Paddle appends none, but a proxy might)', async () => {
    const out = await post(world().handler, BODY, { url: `${PADDLE_WEBHOOK_PATH}?x=1` });
    expect(out.handled).toBe(true);
    expect(out.status).toBe(200);
  });
});

describe('③④ body cap and method', () => {
  it('🔴 a body over the cap is 413 with the limit named, and nothing is stored', async () => {
    const { db, handler } = world();
    // Valid JSON, correctly signed, simply too big — so the refusal can only be
    // the cap and not some other guard further down.
    const huge = JSON.stringify({
      event_id: 'evt_big', event_type: 'subscription.activated',
      occurred_at: '2026-08-01T10:00:00.000000Z', notification_id: 'ntf_big',
      data: { id: 'sub_BIG', filler: 'x'.repeat(MAX_PADDLE_WEBHOOK_BYTES) },
    });
    expect(huge.length).toBeGreaterThan(MAX_PADDLE_WEBHOOK_BYTES);
    const out = await post(handler, huge);
    expect(out.status).toBe(413);
    expect(out.body).toMatchObject({ error: PADDLE_BODY_TOO_LARGE, max_bytes: MAX_PADDLE_WEBHOOK_BYTES });
    expect(db.billing.getSubscription('sub_BIG')).toBeNull();
  });

  it('a body just under the cap is read normally — the positive control for the cap', async () => {
    const { db, handler } = world();
    const padded = JSON.stringify({
      event_id: 'evt_pad', event_type: 'subscription.activated',
      occurred_at: '2026-08-01T10:00:00.000000Z', notification_id: 'ntf_pad',
      data: {
        id: 'sub_R', status: 'active', items: [{ price: { id: PRICE_PRO } }],
        custom_data: { flowmic_user_id: 'u1' }, filler: 'x'.repeat(1000),
      },
    });
    expect(padded.length).toBeLessThan(MAX_PADDLE_WEBHOOK_BYTES);
    const out = await post(handler, padded);
    expect(out.status).toBe(200);
    expect(db.billing.getSubscription('sub_R')).not.toBeNull();
  });

  it('🔴 a body that never finishes arriving still gets an answer', async () => {
    // Paddle's connection dying mid-upload. Without an answer this is the RV-03
    // shape: the promise never settles, the socket hangs until someone's timeout
    // fires, and the delivery is 「lost」 with nothing written on either side —
    // the exact 「Paddle says it sent it, we say we never received it」 that has no evidence trail.
    const { db, handler } = world();
    const stalled = new Readable({ read() { /* never pushes, never ends */ } });
    const req = stalled as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = PADDLE_WEBHOOK_PATH;
    (req as { headers: Record<string, string> }).headers = {
      [PADDLE_SIGNATURE_HEADER]: `ts=${TS};h1=${signPaddlePayload(BODY, TS, SECRET)}`,
    };
    (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '203.0.113.9' };

    const r = response();
    expect(handler(req, r.res)).toBe(true);
    req.emit('aborted');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.read().status).toBe(400);
    expect(r.read().body).toMatchObject({ ok: false, error: PADDLE_BODY_UNREADABLE });
    // Nothing was verified, so nothing may have been written.
    expect(db.billing.getSubscription('sub_R')).toBeNull();
  });

  it('GET on the webhook path is 405, not a 404 and not an accept', async () => {
    const out = await post(world().handler, '', { method: 'GET' });
    expect(out.handled).toBe(true);
    expect(out.status).toBe(405);
  });
});

describe('the redelivery contract, end to end over the route', () => {
  it('🔴 the second delivery answers 200 duplicate — a non-200 would loop forever', async () => {
    const { db, handler } = world();
    const first = await post(handler, BODY);
    expect(first.body).toMatchObject({ duplicate: false, outcome: 'applied' });
    const before = db.billing.getSubscription('sub_R');

    const second = await post(handler, BODY);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(db.billing.getSubscription('sub_R')).toEqual(before);
    expect(db.billing.listEventsForUser('u1', 50)).toHaveLength(1);
  });
});

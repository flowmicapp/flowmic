// SPEC-REF:
//   apps/server-core/src/billing/paddle/client.ts (the real one)
//   apps/server-core/src/billing/paddle/mock-client.ts (the stand-in)
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §3.2
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Which Paddle client a process gets. Split out of bootstrap.ts on 2026-08-21
// because that file crossed the 800-line cap the moment this function landed in
// it — the same pressure and the same remedy as bootstrap-http-deps.ts and
// db/schema-billing.ts. It sits beside the two implementations it chooses
// between rather than in the wiring root, which is where a reader looks for it.

import type { ServerConfig } from '../../config';
import { createPaddleClient, type PaddleClient } from './client';
import { announceMockPaddle, createMockPaddleClient, lookupFromDb } from './mock-client';

/** What the resolver needs from the database: one lookup, so a mock cannot
 *  reach anything else and this module does not depend on DbConnection. */
export interface PaddleSubscriptionLookup {
  getSubscription(id: string): { current_period_end: string | null; status: string } | null;
}

/**
 * Which Paddle client this process gets: the real one, or the in-process mock.
 *
 * 🔴 THE MOCK IS REFUSED AGAINST `FLOWMIC_PADDLE_ENV=production`, and that
 * refusal is the whole reason this is a function rather than a ternary at the
 * call site. A stand-in that silently substituted for the real API on a
 * production box would report every cancellation as successful while cancelling
 * nothing and every refund as requested while refunding nothing — the worst
 * failure this round exists to prevent, produced by the tool built to prevent
 * it. It throws rather than 「falling back safely」: a box configured to mock
 * production billing is misconfigured, and starting anyway would leave the
 * operator's actual intent unknowable.
 *
 * ⚠️ The mock is SEEDED FROM THE DATABASE, so the subscription ids it knows are
 * the ones the console is showing. A stand-in seeded with invented ids answers
 * 「entity not found」 to every real request and the hour that follows is spent
 * debugging the stand-in.
 */
export function resolvePaddleClient(config: ServerConfig, db: PaddleSubscriptionLookup): PaddleClient {
  // Read here rather than through config.ts on purpose: this is a DEVELOPMENT
  // affordance, not a deployment setting, and putting it in `PaddleConfig` would
  // give it the same standing as the webhook secret and the price map — three
  // places would then have to explain that one of the four fields must never be
  // set in production.
  const mockRequested = (process.env.FLOWMIC_PADDLE_MOCK ?? '') === '1';
  if (!mockRequested) {
    return createPaddleClient({
      writeEnabled: config.paddle.writeEnabled,
      apiKey: config.paddle.apiKey,
      env: config.paddle.env,
    });
  }
  if (config.paddle.env === 'production') {
    throw new Error(
      'config: FLOWMIC_PADDLE_MOCK is on together with FLOWMIC_PADDLE_ENV=production. ' +
        'The mock cancels nothing and refunds nothing while reporting success, so serving it against ' +
        'production billing would hide every failure it is meant to expose. Turn one of the two off.',
    );
  }
  announceMockPaddle();
  return createMockPaddleClient({
    writeEnabled: config.paddle.writeEnabled,
    lookup: lookupFromDb((id) => db.getSubscription(id)),
  });
}


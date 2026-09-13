// SPEC-REF:
//   ./bootstrap-http-deps.ts (the one caller — spread in exactly like
//     `servicePurchaseDeps` / `billingWebhookDeps`, and for the same reason)
//   ./http/web-room-routes.ts (the route these deps mount)
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §2.1
//   verify/lint/file-size.mjs (the 800-line cap that forced the extraction)
//
// Wiring for `POST /api/web/rooms` — card S2-04.
//
// Its own module rather than a block inside `composeHttpDeps` for the reason
// that file already gives for the two beside it: the argument for each dependency
// belongs with the dependency, and that file sits at the cap. Nothing here is
// clever; what it holds is the two decisions.

import type { ServerConfig } from './config';
import type { AuthService } from './auth/auth-service';
import { RegisterRateLimiter } from './auth/register-rate-limit';
import type { BudgetPusher } from './billing/budget-push';
import type { WebRoomRoutesDeps } from './http/web-room-routes';
import { anonDialsFromEnv, ANON_BURST_MAX, ANON_BURST_WINDOW_MS, type WebAnonRoutesDeps } from './http/web-anon-routes';
import { resolveIpBucketSalt } from './billing/trial-ip-bucket';
import type { TrialLedger } from './billing/trial-ledger';
import type { CaptchaVerifier } from './auth/captcha';

/**
 * The two things this route needs that nothing else on the http surface has.
 *
 * · `limiter` — the account-keyed burst brake. Its OWN `RegisterRateLimiter`
 *   instance, and keyed on a `users.id` rather than on an IP; both arguments are
 *   at the `webRoom` field in auth/register-rate-limit.ts.
 * · `budget`  — the SAME `BudgetPusher` the socket handlers push
 *   `billing:budget` from. Passed, never rebuilt: the addendum puts the budget
 *   in the build response so the page's meter and the relay's meter are one
 *   arithmetic, and a second `makeBudgetPusher` would be a second reader of the
 *   quota guard and of the metering cycle — one number with two authors.
 */
export interface WebRoomWiring {
  limiter: RegisterRateLimiter;
  budget: BudgetPusher;
  /** Card M4-01 — the site demo's own pieces. Built at the wiring root so the
   *  ledger instance here is the SAME one `effectiveLimits` and the nightly
   *  sweep hold; a second one over the same file would be two objects answering
   *  「how long may this visitor speak」. */
  trials: TrialLedger;
  /** Its OWN burst brake, keyed on an IP bucket — never the account-keyed one
   *  above, whose budget answers a different question about a different action
   *  (see auth/register-rate-limit.ts's `webRoom` field for the same argument
   *  one level up). */
  anonLimiter: RegisterRateLimiter;
  ipSalt: string;
  /** Card MP-1 — the third-party host arm (key guard + room minter), or absent
   *  on a deployment with no publishable-key store. */
  integrator?: NonNullable<WebRoomRoutesDeps['integrator']>;
}

/**
 * Build the wiring above from the three things bootstrap already holds.
 *
 * A FUNCTION RATHER THAN AN OBJECT LITERAL AT THE WIRING ROOT, for the measured
 * reason `composeHttpDeps` gives for the surge gate: bootstrap.ts stands at its
 * 800-line cap and this file exists to hold what does not fit. The burst brake
 * and the salt are built HERE, once per server, which is the property that
 * matters — `bootstrapServer` runs once per process.
 *
 * ⚠️ `captcha` is deliberately NOT built here: `composeHttpDeps` already
 * resolves one verifier per process for the registration-surge gate, and
 * resolving a second would print the missing-secret warning twice and train the
 * one reader of that log to ignore it.
 */
export function webRoomWiring(args: {
  limiter: RegisterRateLimiter;
  budget: BudgetPusher;
  trials: TrialLedger;
  /** Card MP-1 — the integrator arm, carried through this bundle for the reason
   *  every other field here is: `composeHttpDeps` is the one place that knows
   *  what a route needs, and a second construction site would be a second
   *  answer to 「which key store does this process use」. */
  integrator?: NonNullable<WebRoomRoutesDeps['integrator']>;
  env?: NodeJS.ProcessEnv;
}): WebRoomWiring {
  return {
    limiter: args.limiter,
    budget: args.budget,
    trials: args.trials,
    ...(args.integrator ? { integrator: args.integrator } : {}),
    anonLimiter: new RegisterRateLimiter({ maxAttempts: ANON_BURST_MAX, windowMs: ANON_BURST_WINDOW_MS }),
    ipSalt: resolveIpBucketSalt(args.env),
  };
}

/**
 * `{webRooms}` in saas, `{}` anywhere else.
 *
 * 🔴 saas-ONLY, AND THE ROUTER RE-CHECKS THE MODE. Same two conditions
 * `router-ops-mounts.ts` argues for its six: standalone has no account layer at
 * all (one local owner, no JWT), so there is no identity to hang a room — or a
 * budget — on, and a mis-wire would put a row-minting POST on somebody's LAN box
 * behind an account gate that can never say no.
 *
 * ⚠️ `rooms: registry` hands over the WHOLE registry object, and the narrowing is
 * in the TYPE: `WebRoomRoutesDeps.rooms` is `{ensureWebRoom}`, so the route
 * cannot reach pairing, the device ceilings or the cross-account reaper even
 * though what it holds at runtime is the same instance the socket handlers use.
 * That is the shape `console-device-routes.ts` uses for the room store, and it is
 * why there is one `Registry` in this process rather than two.
 */
export function webRoomDeps(args: {
  mode: ServerConfig['mode'];
  auth: AuthService;
  registry: WebRoomRoutesDeps['rooms'];
  /** Card MP-1 — the integrator arm, or absent when this deployment has no
   *  publishable-key store. Absent makes the arm answer 503 rather than fall
   *  through to another identity, which would bill somebody else. */
  integrator?: NonNullable<WebRoomRoutesDeps['integrator']>;
  limiter: RegisterRateLimiter;
  budget: BudgetPusher;
  trials: TrialLedger;
  anonLimiter: RegisterRateLimiter;
  captcha: CaptchaVerifier;
  ipSalt: string;
  env?: NodeJS.ProcessEnv;
}): { webRooms?: WebRoomRoutesDeps; webAnon?: WebAnonRoutesDeps } {
  if (args.mode !== 'saas') return {};
  // ONE read of the dials, handed to both endpoints. Two reads would be two
  // answers to 「is the demo on」, and the failure would be a switch that is off
  // for the mint and on for the room (or the reverse) — a half-served demo,
  // which is the worst of the three states.
  const dials = anonDialsFromEnv(args.env);
  // The same condition site-collect-routes.ts is wired with, and it is one
  // decision for both demo endpoints: localhost is an allowed origin only where
  // this build is not a production one — vitest and `pnpm dev`. A production
  // relay never accepts a demo request from a page it did not serve.
  const allowLocalhost = (args.env ?? process.env).NODE_ENV !== 'production';
  return {
    webRooms: {
      auth: args.auth,
      rooms: args.registry,
      budget: args.budget,
      limiter: args.limiter,
      // Card MP-1 — spread-or-nothing, so an unwired deployment sends no field
      // at all rather than an object the route would have to interpret. The
      // integrator arm has NO master switch of its own: unlike the site demo
      // (whose dial exists because FlowMic pays for it), every integrator minute
      // is charged to the integrator, so there is nothing here for an operator
      // to be protecting by keeping it off.
      ...(args.integrator ? { integrator: args.integrator } : {}),
      anon: {
        enabled: dials.enabled,
        trials: args.trials,
        allowLocalhost,
        // Design §2.3: ten minutes, and the number is here rather than in the
        // route because it is a deployment's decision about its own rooms.
        ttlMs: DEMO_ROOM_TTL_MS,
      },
    },
    webAnon: {
      enabled: dials.enabled,
      captcha: args.captcha,
      trials: args.trials,
      allowLocalhost,
      limiter: args.anonLimiter,
      ipSalt: args.ipSalt,
      // The registry is never reached from the route; it asks the ledger, which
      // counts the rows. See trial-ledger.repo.ts `countLiveRooms`.
      activeDemoRooms: () => args.trials.liveRooms(Date.now()),
      maxPerIpPerDay: dials.maxPerIpPerDay,
      dailyMinutes: dials.dailyMinutes,
      maxActiveRooms: dials.maxActiveRooms,
    },
  };
}

/** Design §2.3 — a demo room is held for TEN minutes, not the 30 an account room
 *  gets (`room/web-room.ts` WEB_ROOM_TTL_MS). The shorter number is owner ruling
 *  3 of 2026-09-09 read forward: a room is minted because a visitor clicked, and
 *  a visitor who has closed the tab should not keep holding one. */
export const DEMO_ROOM_TTL_MS = 10 * 60_000;

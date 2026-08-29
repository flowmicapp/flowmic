// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY JWT minted by REST
//     /api/login|register)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ② (REST, saas-only:
//     POST /api/register → 201 {token,user} | 409 EMAIL_EXISTS | 429
//     REGISTER_RATE_LIMITED; POST /api/login → {token,user} | 401
//     AUTH_LOGIN_FAILED; GET /api/me (Bearer) → {user}. user = {id,email,
//     display_name,plan} — never password_hash)
//   docs/rebuild/13-LESSONS-LEARNED.md §6.4 (XFF/trusted-proxy DEFERRED to the
//     Cloudflare stage — key the per-IP throttle on the DIRECT peer address)
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// The saas-only account REST surface, mounted from http/router.ts only when the
// `auth` dep is present (standalone leaves these paths unhandled → 404). Every
// response body carries an explicit code — no silent failure. The public user
// object NEVER includes password_hash (auth-service.publicUser is the only
// projection used).
//
// ── 🔴 NR-2a item 3 — THE ANTI-ABUSE FLOOR, AND WHAT IS DELIBERATELY NOT IN IT ─
// owner's concern (2026-08-27 ruling 3) is farming fresh addresses for free
// managed-STT quota. What is built, and nothing more:
//   ① the existing per-IP BURST brake (5 / 10 min), untouched;
//   ② a per-IP DAILY cap on real account mints (`mintLimiter` below,
//      REGISTER_MAX_PER_DAY) — a rate limit cannot bound a total;
//   ③ one structured log line per mint (`auth: account minted`) and one per
//      grace-expiry refusal (socket handlers), so 「被薅了」 is greppable rather
//      than inferred from a bill;
//   ④ 2026-08-27 batch-2 item 4 — a GLOBAL daily threshold: once this
//      deployment has minted ≥50 accounts today, the next registration must
//      carry a solved human check (auth/registration-surge.ts). ② is a price
//      per address and is defeated by rotating addresses; ④ does not care which
//      address a mint came from, which is precisely what rotation cannot buy
//      its way past.
// DELIBERATELY NOT BUILT, recorded so the absence is a decision and not a gap
// somebody later assumes was covered:
//   · NO device / source fingerprinting of any kind (canvas/font/hardware
//     probes). The owner's own sentence names it and marks it unresolved —
//     「同一来源指纹（需要思考如何获取）」, docs/decisions/2026-08-27-owner-web-
//     rulings-batch-2.md item 4 — and it sits next to published promises in
//     docs/legal/privacy-policy.md (no tracker, no advertising identifier). It
//     is RECORDED THERE AND BUILT NOWHERE; shipping it needs a legal review
//     first, which is an owner decision and not a code change;
//   · NO disposable-domain blocklist. It is a list that must be maintained
//     forever, it blocks real users on the day a legitimate provider lands on
//     it, and the failure is invisible to us (they just leave);
//   · NO phone / card / invite gate. Each one converts a free tier into a
//     high-friction one, which is a PRODUCT decision, not an ops decision;
//   · ⚠️ THE PER-IP DAILY CAP STILL DOES NOT COVER THE GOOGLE ARM
//     (http/google-auth-routes.ts). Farming there costs a Google account per
//     FlowMic account, which is the friction this floor is trying to buy in the
//     first place. It IS still an uncapped PER-IP mint path and saying so here
//     is cheaper than someone rediscovering it — but as of batch-2 item 4 it is
//     no longer an ungated one: it counts into, and is gated by, the global
//     surge counter exactly like this route.
// Precedent for the shape (a cheap greppable record beats an unauditable
// mechanism): docs/strategy/2026-08-25-unregistered-trial-allowance-design.md §6.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import { RegisterValidationError } from '../auth/auth-service';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { QrGrantStore } from '../auth/qr-grant';
import { UserConstraintError } from '../db/repos/user.repo';
import type { SiteCountsRepo } from '../db/repos/site-counts.repo';
import { SITE_TOTAL_DIM, SITE_TOTAL_VALUE } from '../db/repos/site-counts.repo';
import { utcDay } from '../site/sanitize';
import { log } from '../log';
import { accountFromBearer, accountUserFromBearer } from './account-auth';
import { clientIpFromRequest } from './trusted-proxy';
import { MailNotConfiguredError, type EmailVerificationMailer } from '../mail';
import type { EmailVerificationRepo } from '../db/repos/email-verification.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { mintVerification, sendVerificationMail, storeVerification } from '../auth/verification-issue';
import { guardRegistrationSurge, type RegistrationSurgeGate } from '../auth/registration-surge';

export interface AuthRoutesDeps {
  service: AuthService;
  /** Per-IP sliding-window throttle shared by /api/register + /api/login. */
  limiter: RegisterRateLimiter;
  /**
   * NR-2a item 3 (i) — the per-IP DAILY cap on ACCOUNT CREATION
   * (auth/register-rate-limit.ts `REGISTER_MAX_PER_DAY` carries the whole
   * argument for why `limiter` above does not already cover this).
   *
   * A second `RegisterRateLimiter` instance with a 24-hour window, not a new
   * class: the counting is identical, only the numbers differ, and a second
   * implementation would be a second place for the bounded-map/eviction
   * reasoning to be got wrong.
   *
   * ⚠️ SPENT ONLY WHEN AN ACCOUNT IS REALLY MINTED (`record` after the insert,
   * never on a 409 or a validation refusal). A day-long budget burned by
   * somebody mistyping their password would lock a whole office out of signing
   * up, and「you already have an account」is not account creation.
   *
   * Absent (unit tests that predate the card) ⇒ burst limiting only, which is
   * exactly the pre-NR-2a behaviour those tests were written against.
   */
  mintLimiter?: RegisterRateLimiter;
  /**
   * 2026-08-27 batch-2 item 4 — the GLOBAL daily surge gate, shared with
   * `/api/auth/google` (auth/registration-surge.ts carries the whole argument
   * for why a per-IP cap cannot answer this question).
   *
   * ⚠️ THE SAME OBJECT AS THE GOOGLE ROUTE'S, always. Two counters would each
   * see half the day's mints, so a deployment minting 80 accounts would read as
   * two calm days of 40 and the gate would never arm — a bypass built out of
   * two things that are each individually correct.
   *
   * Absent (unit tests that predate the card) ⇒ no surge gate, which is exactly
   * the pre-batch-2 behaviour those tests were written against.
   */
  surgeGate?: RegistrationSurgeGate;
  /** GA-31 QR-code login. Absent ⇒ the two QR routes are simply not mounted (404),
   *  which is the honest answer for a build that does not offer the feature —
   *  never a route that accepts a nonce and quietly does nothing. */
  qrGrants?: QrGrantStore;
  /** owner 2026-07-27: seed the new account's default STT/LLM settings the
   *  moment it exists, so it can transcribe on its FIRST session rather than
   *  after the next server restart. bootstrap wires this to
   *  seedDefaultSettings; absent (unit tests) ⇒ registration is unchanged. */
  onUserCreated?: (userId: string) => void;
  /**
   * First-party site analytics — register_ok / login_ok are SERVER-authored.
   * Absent or `enabled: false` ⇒ zero writes (tests that do not care about
   * the site surface stay unchanged). Client-reported kinds of these names
   * are refused at the collect route; only this path may bump them.
   */
  siteCounts?: {
    counts: Pick<SiteCountsRepo, 'bump'>;
    enabled: boolean;
    now?: () => number;
  };
  /**
   * NR-2a — mail the new account its verification the moment it exists, instead
   * of waiting for the person to find the「send me a code」button behind the
   * console gate.
   *
   * ⚠️ OPTIONAL, and this is the one DI default in this file that is allowed to
   * be a quiet absence (13 §7 F1 ② forbids friendly no-op defaults). The reason
   * it is allowed: standalone has no accounts and no mail channel, and the
   * dozens of unit tests that call `tryHandleAuthRoutes` with a hand-built deps
   * object are testing registration, not mail. What the rule actually guards
   * against — a PRODUCTION wire silently missing — is guarded instead by
   * test/verification-autosend.test.ts, which boots the REAL bootstrap and
   * asserts a registration really reaches the mail channel (the
   * `loginRecordEnabled` precedent: pin the wiring with a test, not a comment).
   */
  verificationMail?: {
    mailer: EmailVerificationMailer;
    repo: EmailVerificationRepo;
    settings: SettingsRepo;
    now?: () => number;
  };
}

/**
 * NR-2a — hand a freshly registered account its verification mail. NEVER
 * throws: it is deliberately called without `await`.
 *
 * 🔴 WHY IT IS NOT AWAITED, AND WHY ITS OUTCOME NEVER REACHES THE CALLER. A
 * mail outage must not turn account creation into a 500. The account exists,
 * the token was issued, the person is signed in and can use the product for the
 * whole grace window — telling them「registration failed」because our vendor is
 * down would be a lie about the only thing they care about. The named truth
 * goes to the operator's log, which is the surface with a reader who can act.
 *
 * ⚠️ THIS IS THE `dispatchResetMail` SHAPE FOR A DIFFERENT REASON, stated so
 * nobody carries the wrong argument across. There, non-awaited is an
 * ANTI-ENUMERATION property (awaiting would turn the constant response into a
 * timing oracle). Here the caller is not anonymous and there is nothing to
 * enumerate — it is simply that registration and mail delivery are two events,
 * and the second one failing does not un-happen the first.
 *
 * ⚠️ AND IT IS THE OPPOSITE OF THE SEND ROUTE, which awaits and answers a named
 * 502. That route's caller pressed a button that says「send me a code」and is
 * watching for the result; this one pressed「create account」and got it.
 *
 * MINT → SEND → STORE (verification-issue.ts): nothing is persisted when the
 * transport refuses, so a failed dispatch does not leave the account holding a
 * 60-second resend cooldown for a mail that never left.
 *
 * The log line carries `user_id` and never the address or either credential —
 * the rule `dispatchResetMail` states, for the same reason.
 */
async function dispatchRegistrationVerification(
  wire: NonNullable<AuthRoutesDeps['verificationMail']>,
  userId: string,
  to: string,
): Promise<void> {
  const minted = mintVerification(userId, (wire.now ?? Date.now)());
  try {
    await sendVerificationMail(wire.mailer, to, minted);
  } catch (err) {
    // Two named reasons because they need two different people to do two
    // different things (password-reset's dispatch makes the same split):
    // MAIL_NOT_CONFIGURED is「an operator must set five env vars」,
    // MAIL_SEND_FAILED is「the transport refused this message」.
    log.error(
      'mail: registration verification NOT SENT — the account exists and is usable for the grace window, but nobody has been told how to verify it',
      {
        user_id: userId,
        code: err instanceof MailNotConfiguredError ? err.code : 'MAIL_SEND_FAILED',
        transport: wire.mailer.id,
        reason: err instanceof Error ? err.message : String(err),
      },
    );
    return;
  }
  storeVerification(wire.repo, wire.settings, userId, minted);
  // 「dispatched」, not 「delivered」: what we know is that the transport accepted
  // it. A mailbox receiving it is a later event nobody here observes.
  log.info('mail: registration verification handed to the mail transport', {
    user_id: userId,
    transport: wire.mailer.id,
  });
}

const BODY_CAP = 64_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > BODY_CAP) raw = raw.slice(0, BODY_CAP);
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Per-IP limiter key (0.3.0 M3). No longer the raw direct peer: behind nginx
 *  every peer is 127.0.0.1, so register + login shared ONE global 5/10-min
 *  bucket — 6 requests locked out the whole world. The shared derivation
 *  (http/trusted-proxy.ts) takes the client from the trusted proxy's
 *  X-Forwarded-For (rightmost untrusted hop — the leftmost is client-forgeable);
 *  with FLOWMIC_TRUSTED_PROXIES unset it returns the direct peer unchanged
 *  (13 §6.4's fail-safe). */
function clientIp(req: IncomingMessage): string {
  return clientIpFromRequest(req);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function bumpAuthConversion(
  deps: AuthRoutesDeps,
  kind: 'register_ok' | 'login_ok',
): void {
  const sc = deps.siteCounts;
  if (!sc?.enabled) return;
  const day = utcDay(sc.now?.() ?? Date.now());
  sc.counts.bump({ day, kind, dim: SITE_TOTAL_DIM, dim_value: SITE_TOTAL_VALUE });
}

/** Handle the saas account REST routes. Returns true iff it owned the request. */
export function tryHandleAuthRoutes(req: IncomingMessage, res: ServerResponse, deps: AuthRoutesDeps): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/api/register' && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIp(req);
      if (!deps.limiter.check(ip).allowed) return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      deps.limiter.record(ip);
      // NR-2a item 3 (i) — the DAILY cap, checked here and SPENT below (only if
      // an account is really minted).
      //
      // ⚠️ SAME CODE as the burst refusal above, deliberately: minting a
      // protocol error code is owner-gated, and the caller's move is identical
      // either way (come back later). What tells the two apart is
      // `retry_after_ms`, which this branch carries and the burst branch does
      // not — the burst body stays BYTE-IDENTICAL to what it has always been so
      // no existing client or test has to be re-read.
      const daily = deps.mintLimiter?.check(ip);
      if (daily && !daily.allowed) {
        log.warn('auth: account creation refused — this address is past its daily account cap', {
          ip,
          retry_after_ms: daily.retryAfterMs,
        });
        return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED', retry_after_ms: daily.retryAfterMs });
      }
      const body = await readJsonBody(req);
      // 2026-08-27 batch-2 item 4 — the GLOBAL surge gate, AFTER the body is
      // read because the challenge token rides in it, and BEFORE anything is
      // validated or written because a refusal here must not depend on whether
      // the rest of the payload was any good.
      //
      // ⚠️ It answers `{ok:true}` unchanged on any ordinary day: below the
      // threshold nothing is demanded and no provider is contacted, so the
      // normal registration path is byte-identical to what it has always been.
      const surge = await guardRegistrationSurge(deps.surgeGate, str(body.captcha_token), ip, 'register');
      if (!surge.ok) return sendJson(res, surge.status, surge.body);
      try {
        const user = await deps.service.register({
          email: str(body.email),
          password: str(body.password),
          ...(typeof body.display_name === 'string' ? { display_name: body.display_name } : {}),
        });
        deps.onUserCreated?.(user.id);
        const issued = deps.service.issueToken(user);
        // 🔴 LOGIN-1 — THE `issueToken` CALL SITE THAT DELIBERATELY DOES **NOT**
        // `recordSignIn`, marked here rather than left as an absence, because an
        // absence is exactly what a later reader would「fix」.
        // Registration is not a login: `users.created_at` already answers "when
        // did this account appear", and stamping `last_login_at` here would make
        // it non-NULL for every account from the instant it exists — destroying
        // the one distinction the field is for ("registered and never came back"
        // vs "has been back"), because both would render as the same date on the
        // operator's screen. auth/auth-service.ts `recordSignIn` carries the full
        // enumeration; test/last-login-record.test.ts pins this exclusion so
        // adding the call here turns a test RED rather than quietly changing what
        // the column means.
        bumpAuthConversion(deps, 'register_ok');
        // NR-2a item 3 (i) — the daily budget is spent HERE, after the account
        // really exists, for the reason `mintLimiter`'s doc states.
        deps.mintLimiter?.record(ip);
        // 2026-08-27 batch-2 item 4 — and the DAY'S GLOBAL TOTAL is counted on
        // the same line of reasoning: a mint, not an attempt. Counting attempts
        // would let anyone arm the gate against everybody else by POSTing
        // rubbish fifty times, which is a denial of registration handed to the
        // internet.
        deps.surgeGate?.counter.record();
        // 🔴 NR-2a item 3 (ii) — ONE STRUCTURED LINE PER ACCOUNT MINT.
        //
        // owner's concern, verbatim (2026-08-27 ruling 3): 「会不会出现狂刷邮箱来
        // 套取免费额度的情况」. The per-IP caps below it are the floor; this line is
        // how anyone would ever FIND OUT that the floor is being walked around.
        // Precedent: docs/strategy/2026-08-25-unregistered-trial-allowance-design.md
        // §6 (the three gates), whose whole argument is that a cheap, greppable
        // record beats an expensive mechanism nobody can audit.
        //
        // NO EMAIL ADDRESS in the line — `user_id` identifies the account
        // without writing an address into a file that outlives it (the rule
        // password-reset-routes.ts states). The IP IS carried: it is the only
        // dimension that makes 「40 accounts in an hour」 visible, and it is
        // already what the limiter above keys on.
        log.info('auth: account minted', {
          user_id: user.id,
          ip,
          plan: user.plan,
          source: 'register',
        });
        sendJson(res, 201, { token: issued.token, user: deps.service.publicUser(user) });
        // NR-2a — auto-send, AFTER the response has been written. Not awaited
        // (see dispatchRegistrationVerification): a mail outage must not turn
        // account creation into a 500, and it never rejects, so there is no
        // unhandled rejection to lose.
        //
        // 🔴 THE RECIPIENT IS `user.email` — THE ADDRESS ON FILE — not the
        // request string, for the reason password-reset-routes.ts spells out:
        // 「matched」 and 「identical」 are not the same relation. A null email is
        // unreachable through this route (register validates the shape) but is
        // checked rather than asserted.
        if (deps.verificationMail && user.email !== null) {
          void dispatchRegistrationVerification(deps.verificationMail, user.id, user.email);
        }
      } catch (err) {
        if (err instanceof UserConstraintError && err.field === 'email') {
          return sendJson(res, 409, { error: 'EMAIL_EXISTS' });
        }
        // fix-023 (owner ruling group #5-d, 2026-08-10): the code comes from the
        // error itself, not from a literal here. A malformed registration email
        // used to be refused with `SETTINGS_SCHEMA_INVALID` — a SETTINGS-namespace
        // code answering an AUTH-face question, so somebody halfway through
        // creating an account read a sentence about settings being invalid.
        //
        // `RegisterValidationError.code` defaults to `SETTINGS_SCHEMA_INVALID`, so
        // every OTHER validation refusal (password length, in `register` and in
        // `setPassword`) is byte-identical to before; only the email-shape throw
        // carries `REGISTER_EMAIL_INVALID`. That default is deliberate — it makes
        // this line a pass-through rather than a second place where "which code
        // does this refusal use" gets decided, which is how the two answers drift.
        //
        // ⚠️ This is the half `auth-service.ts` could not reach: it tags the error,
        // and until this line read `err.code` the tag was invisible on the wire —
        // a registered code with no way to reach a user is the facade shape this
        // repo hunts, and it was live for exactly as long as these two cards were
        // in flight separately.
        if (err instanceof RegisterValidationError) {
          return sendJson(res, 400, { error: err.code, message: err.message });
        }
        // fix-011: /api/register is anonymous-reachable, so an UNEXPECTED failure
        // (sqlite text, schema/column names, driver/filesystem detail) must never
        // be echoed to the caller — that is fingerprinting material handed to
        // whoever asked. The detail is not dropped, only relocated: it still goes
        // out, to the operator-only log sink, same as every other log.error in
        // this file's neighbours. Contrast the 400 above: that message is about
        // the CALLER's own input (a validation complaint) and stays wire-visible
        // on purpose. Code unchanged (SETTINGS_SYNC_FAIL) — a rename here would
        // collide with the separately-ledgered owner ruling on that code.
        log.error('auth: POST /api/register failed unexpectedly', { error: err instanceof Error ? err.message : String(err) });
        sendJson(res, 500, { error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
      }
    })();
    return true;
  }

  if (url === '/api/login' && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIp(req);
      if (!deps.limiter.check(ip).allowed) return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      deps.limiter.record(ip);
      const body = await readJsonBody(req);
      const user = await deps.service.verifyCredentials(str(body.email), str(body.password));
      if (!user) return sendJson(res, 401, { error: 'AUTH_LOGIN_FAILED' });
      const issued = deps.service.issueToken(user);
      // LOGIN-1 — SIGN-IN #1 of 3. Credential presented, credential verified,
      // session minted: the archetype of「登录」. AFTER the token exists, so a
      // record can never be written for a sign-in that did not complete, and
      // `recordSignIn` never throws (its own contract) so it cannot turn this
      // 200 into a 500. No-op unless FLOWMIC_LOGIN_RECORD_ENABLED=1.
      deps.service.recordSignIn(user);
      bumpAuthConversion(deps, 'login_ok');
      sendJson(res, 200, { token: issued.token, user: deps.service.publicUser(user) });
    })();
    return true;
  }

  // ── GA-31 QR-code login (the WEB-side scope owner ruled on 2026-07-26) ────
  // The console — ALREADY SIGNED IN — draws a QR; the phone scans it and lands in
  // the same account without typing an email and password on a phone keyboard.
  //
  // Mint. Bearer-authenticated: the grant is bound to the caller's user id here,
  // so redemption can never name a different account. See auth/qr-grant.ts for
  // why the window is 60 s and single-use.
  if (url === '/api/auth/qr-grant' && method === 'POST') {
    if (!deps.qrGrants) return false;
    // Shared 「is this Bearer good」 (account-auth.ts): parse → verify signature and
    // exp → load the user (a validly-signed token for a since-deleted user grants
    // nothing). One definition, so this route and /api/me cannot drift apart.
    const who = accountFromBearer(req, deps.service);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    const grant = deps.qrGrants.issue(who.userId);
    // The nonce goes in the BODY and nowhere else — never a log line, never a
    // URL the browser or a proxy would keep.
    sendJson(res, 200, grant);
    return true;
  }

  // Redeem. The SECOND door onto the SAME single-use grant store, opened for the
  // PC (owner 2026-08-27 UAT correction block in
  // docs/decisions/2026-08-27-owner-no-password-login-on-clients.md): the desktop
  // signs in through the system browser and the browser hands the nonce back to a
  // loopback listener, so the person never copies a Cloud Key by hand.
  //
  // 🔴 THE SAME `redeem` CALL AS THE SOCKET ARM, deliberately, and this is the
  // whole reason this route is here rather than in a store of its own. Two stores
  // would each be single-use on their own and the PAIR would not be: a nonce
  // consumed over the socket would still be live over REST. One store, one
  // `redeem`, so single-use is a property of the GRANT and not of the door it is
  // pushed through. test/qr-exchange.test.ts spends a nonce through one door and
  // asserts the other refuses it — in both orders.
  //
  // 🔴 ONE OUTCOME FOR unknown / expired / already-used, and it is NOT the naming
  // the card asked for. The card named GRANT_INVALID *and* GRANT_EXPIRED;
  // auth/qr-grant.ts states「NO ORACLE … A caller must not be able to learn that a
  // nonce once existed」, and `redeem` is written to make that structural — it
  // deletes an expired grant before returning null, so the two cases are not even
  // distinguishable in memory by the time this line runs. Emitting two names here
  // would (a) rebuild the oracle that file removed and (b) make the two doors onto
  // one store answer the same question differently, which is this repo's headline
  // bug shape. The user-facing sentence「your sign-in window ran out」is not lost:
  // the DESKTOP owns its own 3-minute deadline and says so locally, without asking
  // the server anything (cloud/browser_signin.rs `Expired`).
  //
  // ⚠️ TTL: QR_GRANT_TTL_MS (60 s) is NOT widened for this flow, and it does not
  // need to be. The grant is minted by the console AFTER the sign-in completes and
  // the redirect to 127.0.0.1 is the very next thing the browser does — the window
  // covers one redirect, not a human hunting for a phone. The 3-minute number in
  // the desktop bounds a DIFFERENT interval (how long we wait for the person to
  // finish signing in), and the two must not be conflated.
  if (url === '/api/auth/qr-exchange' && method === 'POST') {
    if (!deps.qrGrants) return false;
    const grants = deps.qrGrants;
    void (async (): Promise<void> => {
      // Same shared per-IP budget as /api/login and the socket arm — a nonce
      // endpoint is not an unthrottled guessing surface just because guessing it
      // is infeasible.
      const ip = clientIp(req);
      if (!deps.limiter.check(ip).allowed) return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      deps.limiter.record(ip);
      const body = await readJsonBody(req);
      const userId = grants.redeem(str(body.nonce));
      if (userId === null) return sendJson(res, 401, { error: 'GRANT_INVALID' });
      const user = deps.service.getUser(userId);
      // A grant minted for an account that has since been deleted redeems to
      // nothing, and says the same thing a made-up nonce says. The grant is
      // already spent by this point — `redeem` deletes before it validates — so
      // this arm cannot be used to keep probing.
      if (!user) return sendJson(res, 401, { error: 'GRANT_INVALID' });
      const issued = deps.service.issueToken(user);
      // LOGIN-1 — SIGN-IN #4. Same reasoning as the socket QR arm verbatim: a
      // redemption IS a sign-in (single-use, 60 s, minted by an
      // already-authenticated console FOR THIS ACCOUNT), so omitting this would
      // leave every browser-signed-in PC reading「never signed in」on the ops card.
      deps.service.recordSignIn(user);
      bumpAuthConversion(deps, 'login_ok');
      // Byte-identical to /api/login's success body, so the desktop stores the
      // token through exactly the path a pasted Cloud Key already takes.
      sendJson(res, 200, { token: issued.token, user: deps.service.publicUser(user) });
    })();
    return true;
  }

  if (url === '/api/me' && method === 'GET') {
    // The row-returning face of the shared verdict — this is the one route that
    // projects the user, and publicUser is still the only projection used (never
    // password_hash). A since-deleted user's validly-signed token is invalid.
    const who = accountUserFromBearer(req, deps.service);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    sendJson(res, 200, { user: deps.service.publicUser(who.user) });
    return true;
  }

  return false;
}

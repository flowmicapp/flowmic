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

export interface AuthRoutesDeps {
  service: AuthService;
  /** Per-IP sliding-window throttle shared by /api/register + /api/login. */
  limiter: RegisterRateLimiter;
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
      const body = await readJsonBody(req);
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
        sendJson(res, 201, { token: issued.token, user: deps.service.publicUser(user) });
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

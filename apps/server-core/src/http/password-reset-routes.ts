// SPEC-REF:
//   docs/strategy/R5-WEB-TASK-CARDS.md WP-W1 ② (password reset surface)
//   docs/rebuild/05-DATA-MODEL.md §5 (account.password_reset {reset_token,
//     expires_at} 30-min TTL; account.* is on the mobile-broadcast deny-list, so
//     writing it never fans out to a phone)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure — explicit codes)
//   *** HUMAN-AUDIT SENSITIVE (auth: password reset) — reviewable in isolation ***
//
// POST /api/password/forgot and POST /api/password/reset, VERBATIM out of
// `console-routes.ts` (card MAIL-1, 2026-08-09). Mounted through that file, so
// the saas-only gating and the 404-in-standalone answer are unchanged.
//
// WHY THEY MOVED, stated plainly because "the file got too long" is not a reason anyone
// should have to guess at: `console-routes.ts` stood at 775 lines against the
// 800-line cap `verify/lint/file-size.mjs` enforces, i.e. 25 lines of headroom,
// and MAIL-1 has to add a delivery leg to the forgot route. Squeezing it in
// would have bought one round and then forced somebody else to do this move
// under time pressure — and this repo's standing answer to that cap is a
// STRUCTURAL split that deletes no evidence (0.2.52 §5 did the same to two Dart
// files; verify/golden/g11-console-surface.mjs did it to the golden runner).
// Every comment below travelled with its code.
//
// ── 🔴 THE "NO MAIL TRANSPORT" BOX IN console-routes.ts IS NOW ANSWERED ──────
// That box (still there, kept as the record) said: "the token exists only in
// user_settings and nobody carries it to the user … M1 does NOT make reset
// usable". As of card MAIL-1 there IS a transport (src/mail/), the forgot route
// hands every minted token to it, and a deployment without mail configured gets
// a mailer that FAILS BY NAME rather than one that quietly succeeds.
//
// ⚠️ WHAT IS AND IS NOT PROVEN, because "the code exists" is not a measurement:
//   · [unit-tested] the whole chain from HTTP request to a rendered, token-bearing
//     link handed to a provider — driven through an INJECTED FAKE provider, so
//     the template, the URL builder and the route all really run;
//   · [unit-tested] the failure direction: a provider that throws produces a NAMED
//     ERROR log line and no claim of success, on a byte-identical response;
//   · 🔴 [not measured against a real address] a real email. owner has not handed over the Resend API key,
//     so nothing in this repo has ever talked to api.resend.com. Do not read the
//     green tests as 「password reset works in production」 — they prove every
//     layer up to the vendor boundary and nothing across it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthService } from '../auth/auth-service';
import { checkPasswordPolicy, passwordPolicyMessage } from '../auth/password-policy';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { SettingsRepo } from '../db/repos/settings.repo';
import { MailNotConfiguredError, type PasswordResetMailer } from '../mail';
import { readJsonBody, sendJson, str } from './console-http';
import { clientIpFromRequest } from './trusted-proxy';
import { log } from '../log';

/** The user_settings KV key holding the pending reset (05 §5). account.* is on
 *  the mobile-broadcast deny-list, so writing it here never leaks to a phone. */
export const PASSWORD_RESET_KEY = 'account.password_reset';

/** 0.3.0 M1 — the flag that turns the forgot-route reset_token echo back on.
 *  STRICT '1'/'true' only; every other value (unset, '0', 'TRUE', 'yes', …) is
 *  OFF, so a mangled env line fails toward the safe side. Read per request, not
 *  at module load: tests flip it, and a server must not need a restart to go
 *  dark. */
const RESET_TOKEN_ECHO_ENV = 'FLOWMIC_INTERNAL_RESET_TOKEN_ECHO';
function resetTokenEchoEnabled(): boolean {
  const v = process.env[RESET_TOKEN_ECHO_ENV];
  return v === '1' || v === 'true';
}

/** Reset-token time-to-live (05 §5: 30 minutes). */
const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * What these two routes need, and nothing else.
 *
 * A structural SUBSET of `ConsoleRoutesDeps`, so the caller hands its own deps
 * object straight through — one dependency list, not two that can drift.
 */
export interface PasswordResetRoutesDeps {
  auth: AuthService;
  settings: SettingsRepo;
  /** Per-IP throttle for the password reset surface — same discipline as the
   *  register/login limiter (5 / 10-min), a SEPARATE bucket so a legitimate
   *  reset never starves the login budget (and vice-versa). */
  passwordLimiter: RegisterRateLimiter;
  /**
   * 🔴 MAIL-1 — the channel that carries the reset token to the human.
   *
   * REQUIRED, with no `?` and no default, and that is the whole point (book 13 §7
   * F1 ②, the same argument `ConsoleRoutesDeps.opsAudit` makes). An optional
   * mailer would mean a bootstrap missing one line still MOUNTS
   * `/api/password/forgot`, which would then mint a token, persist it, answer
   * 200, and deliver nothing — the exact state this card exists to end, back
   * again with no new symbol to grep and nothing red to notice. Making it
   * required turns that omission into a compile error at every object literal
   * that builds these deps.
   *
   * ⚠️ 「Required」 is about the DEPENDENCY, not about the deployment: a box with
   * no mail env still boots and still serves everything else. What it gets is
   * `unconfiguredPasswordResetMailer()`, which rejects by name every time — see
   * mail/unconfigured.ts for why that is the shape rather than a quiet no-op or
   * a refusal to start.
   */
  mail: PasswordResetMailer;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for TTL tests. */
  now?: () => number;
}

/** Per-IP limiter key (0.3.0 M3). No longer the raw direct peer: behind nginx
 *  every peer is 127.0.0.1, which used to fold the whole internet into ONE
 *  password-limiter bucket — 6 requests locked out the world. The shared
 *  derivation (http/trusted-proxy.ts) takes the client from the trusted
 *  proxy's X-Forwarded-For (rightmost untrusted hop); with
 *  FLOWMIC_TRUSTED_PROXIES unset it returns the direct peer unchanged, same
 *  as auth-routes.ts. */
function clientIp(req: IncomingMessage): string {
  return clientIpFromRequest(req);
}

/** Constant-time string compare (equal-length only; unequal lengths short-circuit
 *  false without a timing tell beyond length — and length is public: every minted
 *  token is randomBytes(18) → 24 base64url chars). Used for the reset-token
 *  check; since 0.3.0 M1 darkened the echo by default this is no longer merely
 *  defence-in-depth. */
function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface StoredReset {
  reset_token?: unknown;
  expires_at?: unknown;
}

/**
 * Hand the freshly minted link to the mail channel and say — precisely — what
 * happened. Never throws: it is deliberately called without `await`.
 *
 * 🔴 WHY IT IS NOT AWAITED, WHICH IS A SECURITY DECISION AND NOT A PERFORMANCE
 * ONE. `POST /api/password/forgot` answers the same bytes for a known and an
 * unknown address (0.3.0 M1 closed that oracle). Awaiting a mail round-trip
 * would re-open it through the clock instead of the body: known address ⇒ answer
 * after ~a few hundred ms of vendor RTT, unknown ⇒ answer immediately. An
 * enumeration oracle you have to time is still an enumeration oracle, and it
 * would be one nobody looking at the response would see.
 *
 * 🔴 AND WHY THE OUTCOME NEVER REACHES THE CALLER, EITHER. For the same reason:
 * a 500 (or any other distinguishable answer) when delivery fails would only
 * ever be produced for an address that EXISTS — 「mail failed」 would become
 * 「this account is real」. So the wire answer stays constant and the named truth
 * goes to the operator's log, which is the surface that has a reader who can act
 * on it. `test/mail-password-reset.test.ts` pins the three bodies (unknown /
 * known+delivered / known+failed) byte-equal so this cannot drift.
 *
 * ⚠️ Consequence, stated rather than discovered later: a user whose reset mail
 * fails sees exactly what a user whose reset mail succeeded sees. The place that
 * knows is `server.log`. That is a real cost of the anti-enumeration property,
 * accepted here with its name on it.
 *
 * The log line NEVER carries the token (it would turn the log into a takeover
 * kit) and never carries the email address (`user_id` identifies the account
 * without writing an address into a file that outlives the account — the same
 * rule the account-deletion line in console-routes.ts follows).
 */
async function dispatchResetMail(
  mail: PasswordResetMailer,
  userId: string,
  to: string,
  resetToken: string,
  expiresAt: string,
): Promise<void> {
  try {
    await mail.sendPasswordReset({ to, resetToken, expiresAt });
    // 「dispatched」, not 「sent」/「delivered」: what we know is that the transport
    // accepted it. A mailbox receiving it is a later, separate event nobody here
    // observes (MailProvider.send's contract says so in as many words).
    log.info('mail: password reset link dispatched to the account address', {
      user_id: userId,
      transport: mail.id,
      expires_at: expiresAt,
    });
  } catch (err) {
    // TWO named reasons, because they need two different people to do two
    // different things: MAIL_NOT_CONFIGURED is "an operator must set five env
    // vars" (mail/unconfigured.ts names them in the message), MAIL_SEND_FAILED is
    // "the transport refused this message". Collapsing them would be one value
    // answering two questions in the one place an operator goes to find out which it was.
    //
    // ⚠️ Neither string is a protocol error code. They are internal diagnostics:
    // they never cross a socket or an HTTP body, and `ERROR_CODES` did not move
    // for this card — test/mail-password-reset.test.ts asserts that absence.
    const code = err instanceof MailNotConfiguredError ? err.code : 'MAIL_SEND_FAILED';
    log.error(
      'mail: password reset link NOT delivered — the token was minted and persisted, and nobody carried it to the user',
      {
        user_id: userId,
        code,
        transport: mail.id,
        reason: err instanceof Error ? err.message : String(err),
        expires_at: expiresAt,
      },
    );
  }
}

/** Handle the two password-reset routes. Returns true iff it owned the request. */
export function tryHandlePasswordResetRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PasswordResetRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── ② POST /api/password/forgot ───────────────────────────────────────────
  if (url === '/api/password/forgot' && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIp(req);
      if (!deps.passwordLimiter.check(ip).allowed) return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      deps.passwordLimiter.record(ip);
      const body = await readJsonBody(req);
      const email = str(body.email);
      if (email.trim() === '') return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'email required' });
      const user = deps.auth.findByEmail(email);
      // Constant response SHAPE for the unknown-email path (ok:true, no token) so
      // HTTP status never distinguishes existence. With the echo flag OFF (the
      // default since 0.3.0 M1) the known-email path answers the SAME bytes —
      // full anti-enumeration; console-routes.test.ts pins the two raw bodies
      // equal. With the flag ON the old internal trade-off returns: token-present
      // ⇔ email-exists, acceptable only on the private line and still behind the
      // per-IP limiter above.
      if (!user || user.email === null) return sendJson(res, 200, { ok: true });
      const reset_token = randomBytes(18).toString('base64url');
      const expires_at = new Date(now() + RESET_TTL_MS).toISOString();
      deps.settings.write(user.id, PASSWORD_RESET_KEY, { reset_token, expires_at });
      // 🔴 MAIL-1 — DELIVERY, and it happens on BOTH branches below.
      //
      // Unconditional on purpose: the echo flag is a developer affordance for
      // reading the token off the wire on a private line, NOT a switch that means
      // 「do not mail this」. Making delivery conditional on it would create a
      // configuration in which the route mints a token and nothing carries it —
      // which is the precise state this card closed, rebuilt behind a flag.
      //
      // Not awaited: see dispatchResetMail's header (awaiting would turn the
      // anti-enumeration property into a timing oracle). It never rejects, so
      // there is no unhandled rejection to lose.
      //
      // 🔴 THE RECIPIENT IS `user.email` — THE ADDRESS ON FILE — NOT `email`, the
      // string this request supplied. They look interchangeable here because
      // `findByEmail` just matched them, but 「matched」 and 「identical」 are not
      // the same relation: any normalisation in that lookup (trim, case, unicode)
      // means an attacker can pick which of several strings that resolve to one
      // account we actually hand to the MTA. Mailing the stored value makes that
      // choice unavailable rather than merely unlikely — the same technique
      // `checkDeleteConfirmation` uses to keep a confirmation from becoming a
      // selector.
      void dispatchResetMail(deps.mail, user.id, user.email, reset_token, expires_at);
      if (resetTokenEchoEnabled()) {
        // FLAG-GATED INTERNAL ECHO (see console-routes.ts file-head redline):
        // return the token directly. Private-internal affordance only — the flag
        // must never be set on a deployment a stranger can reach.
        // BYTE-IDENTICAL to what this branch answered before MAIL-1; g11 step 6
        // drives it and console-routes.test.ts pins both halves of the flag.
        return sendJson(res, 200, { ok: true, reset_token, expires_at });
      }
      // Echo dark (default): the response says nothing about whether this address
      // exists, whether a token was minted, or whether the mail went out. All
      // three answers live in the log line dispatchResetMail writes — see its
      // header for why the wire cannot carry them without becoming an oracle.
      //
      // BYTE-IDENTICAL to the unknown-email response above — same status, same
      // single-key body — so this route is not an existence oracle.
      sendJson(res, 200, { ok: true });
    })();
    return true;
  }

  // ── ② POST /api/password/reset ────────────────────────────────────────────
  if (url === '/api/password/reset' && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIp(req);
      if (!deps.passwordLimiter.check(ip).allowed) return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      deps.passwordLimiter.record(ip);
      const body = await readJsonBody(req);
      const email = str(body.email);
      const token = str(body.reset_token);
      const newPassword = str(body.new_password);
      if (email.trim() === '' || token === '') {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'email and reset_token required' });
      }
      // 🔴 A4-3 (2026-08-12) — THIS LINE USED TO READ `newPassword.length < 8`,
      // a hard-coded literal beside a `MIN_PASSWORD_LENGTH` it did not reference.
      // That is not a tidiness complaint; it had a mechanism. This check runs
      // BEFORE `deps.auth.setPassword` (below), and setPassword carries a
      // last-line guard that THROWS. While both numbers were 8 the throw was
      // unreachable, so the drift was invisible. Raising one side without the
      // other arms it: a password between the two limits passes here, reaches
      // setPassword, and throws a RegisterValidationError inside this
      // `void (async …)` — which has no catch and no caller. The request gets no
      // response at all, and the rejection reaches installProcessGuards
      // (error-handling.ts), which treats unhandledRejection as FATAL: graceful
      // close, non-zero exit. One person typing a 9-character password into the
      // reset form would end the process for every connected user.
      //
      // Both sides now call checkPasswordPolicy, so they cannot disagree, and
      // test/password-policy.test.ts pins the named 400 for exactly that
      // between-the-limits password rather than trusting this comment.
      const passwordVerdict = checkPasswordPolicy(newPassword);
      if (!passwordVerdict.ok) {
        return sendJson(res, 400, {
          error: 'SETTINGS_SCHEMA_INVALID',
          message: passwordPolicyMessage('new_password', passwordVerdict),
        });
      }
      const user = deps.auth.findByEmail(email);
      const row = user ? deps.settings.read(user.id, PASSWORD_RESET_KEY) : null;
      const stored = (row?.value ?? undefined) as StoredReset | undefined;
      const storedToken = typeof stored?.reset_token === 'string' ? stored.reset_token : '';
      const expiresAt = typeof stored?.expires_at === 'string' ? Date.parse(stored.expires_at) : NaN;
      // ONE code for every failure branch (unknown user / no pending reset / token
      // mismatch / expired) → no enumeration oracle. fail-loud, never silent.
      if (!user || storedToken === '' || !safeStrEqual(storedToken, token) || !(expiresAt > now())) {
        return sendJson(res, 401, { error: 'PASSWORD_RESET_INVALID' });
      }
      // Rotate the password (old password dead on the next verifyCredentials read;
      // already-issued JWTs ride out their TTL — 0.1.0 no-denylist ruling) and
      // burn the single-use reset token.
      await deps.auth.setPassword(user.id, newPassword);
      deps.settings.remove(user.id, PASSWORD_RESET_KEY);
      sendJson(res, 200, { ok: true });
    })();
    return true;
  }

  return false;
}

// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §1
//     (card NR-1 — the plan this file implements, clause by clause)
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 2 (activation:
//     the 2026-08-11 "record only, do not elaborate" seal is lifted)
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md
//     (the verification gate this route's users never see, and ④'s warning that
//     Google sign-in is a new ADMISSION surface, not a convenience route)
//   src/auth/google-id-token.ts (the verifier — this file decides nothing that
//     module owns, and vice versa)
//   src/http/auth-routes.ts — the sibling this route answers exactly like
//   *** SENSITIVE SURFACE (auth: a new way to become a signed-in account) ***
//
// POST /api/auth/google — trade a Google ID token for a FlowMic session.
//
// ── ENVIRONMENT ────────────────────────────────────────────────────────────
//   FLOWMIC_GOOGLE_CLIENT_ID — the OAuth 2.0 Web client id every accepted token
//     must name in its `aud`. UNSET ⇒ this route answers 503
//     GOOGLE_LOGIN_NOT_CONFIGURED. It is PUBLIC (the console ships it in its own
//     JavaScript), it is an audience and never a secret, and there is
//     deliberately no client-SECRET env var — the ID-token flow does not use one.
//   FLOWMIC_GOOGLE_JWKS_URL — optional override of Google's key endpoint, for a
//     test or a staging box.
//   Both are read in src/auth/google-id-token.ts, which is the only module that
//   touches them; this header names them because a route's env dependencies
//   belong where somebody debugging the route will look.
//
// 🔴 THE ROUTE STAYS MOUNTED WHEN GOOGLE SIGN-IN IS OFF, AND ANSWERS BY NAME.
// The tempting alternative — mount it only when the client id is set — makes an
// unconfigured deployment answer 404, i.e. "there is no such feature", which is a
// different and less true sentence than "this deployment cannot do that right
// now", and it is the one nobody can act on. Same argument billing-routes.ts
// makes about BILLING_WRITE_DISABLED, and the same reason the mail module has a
// loud unconfigured channel rather than a null.
//
// ── THE REFUSAL NAMES ARE HTTP-LOCAL ───────────────────────────────────────
// GOOGLE_TOKEN_INVALID / GOOGLE_TOKEN_EXPIRED / GOOGLE_EMAIL_UNVERIFIED /
// GOOGLE_LOGIN_NOT_CONFIGURED / GOOGLE_LOGIN_FAILED are strings on the
// KEYMETA_ / VERIFY_ precedent: they never
// cross a socket, they are not in `packages/protocol` `ERROR_CODES`, the code
// table did not move for NR-1, and the console maps them to its own copy.
// test/google-login.test.ts pins that absence rather than leaving it as a promise
// in a comment.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/auth-service';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import {
  GoogleLoginNotConfiguredError,
  GoogleTokenError,
  type GoogleIdentity,
  type GoogleIdTokenVerifier,
} from '../auth/google-id-token';
import type { EmailVerificationRepo } from '../db/repos/email-verification.repo';
import { UserConstraintError, type UserRecord, type UserRepo } from '../db/repos/user.repo';
import { readJsonBody, sendJson, str } from './console-http';
import { clientIpFromRequest } from './trusted-proxy';
import { guardRegistrationSurge, type RegistrationSurgeGate } from '../auth/registration-surge';
import { log } from '../log';

/** Exported for the tests — a hand-copied literal in a test could drift into
 *  passing against a route nobody serves (the EMAIL_VERIFICATION_*_PATH
 *  precedent). */
export const GOOGLE_LOGIN_PATH = '/api/auth/google';

/** The deployment has no `FLOWMIC_GOOGLE_CLIENT_ID` — 503, nothing done. An
 *  OPERATOR's problem, and the copy the console shows has to send the user to a
 *  password instead of to their own Google account. */
export const GOOGLE_LOGIN_NOT_CONFIGURED = 'GOOGLE_LOGIN_NOT_CONFIGURED';
/** The credential is not a token Google minted for us — 401. Nothing the caller
 *  retries will help. */
export const GOOGLE_TOKEN_INVALID = 'GOOGLE_TOKEN_INVALID';
/** Google signed it, for us, and it is past its `exp` — 401. A fresh token from
 *  Google WILL work, which is the whole reason this is not the code above. */
export const GOOGLE_TOKEN_EXPIRED = 'GOOGLE_TOKEN_EXPIRED';
/** Everything else: the key endpoint was unreachable, or a database write lost a
 *  race — 502/500. OUR failure, said out loud rather than dressed up as a bad
 *  credential, which would send the user to debug a Google account that is fine. */
export const GOOGLE_LOGIN_FAILED = 'GOOGLE_LOGIN_FAILED';
/**
 * The token is genuine, and Google will not vouch for an address on it — 403.
 *
 * 🔴 ONE NAME FOR ONE QUESTION: "does Google vouch for an email address for this
 * person". Both ways of answering no — the token carries no `email` claim at
 * all, or it carries one with `email_verified` false — land here, because they
 * have the same consequence and the same next action: this Google account cannot
 * be used to reach a FlowMic account, sign in another way.
 *
 * 🔴 AND IT IS A REFUSAL RATHER THAN A DEGRADED SUCCESS, which is the part worth
 * arguing. The two "helpful" alternatives are both worse:
 *   · MATCH ANYWAY on the unverified address — that is a full account takeover.
 *     Anyone able to create a Google identity asserting somebody else's address
 *     would land inside that person's console;
 *   · MINT AN ACCOUNT with the address unusable or absent — either it collides
 *     with the existing row (a 500 dressed up as a product), or it creates an
 *     account with no address, i.e. no password reset, no receipts, and a
 *     verification gate whose only key does not exist.
 * This is only reachable for a Google account that has not verified its own
 * address, or for a token minted without the `email` scope. It is NOT reachable
 * for an account already bound to this `sub` — that binding was established
 * earlier, and this claim is not what re-establishes it.
 */
export const GOOGLE_EMAIL_UNVERIFIED = 'GOOGLE_EMAIL_UNVERIFIED';

/** Thrown by the resolution step, turned into {@link GOOGLE_EMAIL_UNVERIFIED} by
 *  the handler. A type rather than a return-value arm so the resolution function
 *  keeps ONE success shape. */
class GoogleEmailUnverifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleEmailUnverifiedError';
  }
}

/**
 * Thrown at the ONE point this route can create an account, turned into the
 * same 429 `/api/register` answers. Carries the budget so the refusal can say
 * when a slot frees.
 *
 * 🔴 WHY IT IS AN EXCEPTION FROM INSIDE `resolveAccount` RATHER THAN A CHECK AT
 * THE DOOR, which is where it used to live and where it caused a production
 * lockout on 2026-09-07 (NY origin, ip 183.158.73.135: two
 * `auth: account minted` lines at 04:06:35Z and 04:07:08Z spent the address's
 * two daily slots, then `google login: account creation refused` at 04:59:14Z
 * and 05:40:19Z refused an account that had existed since 2026-08-14). The door
 * does not know -- and cannot know without verifying the token -- whether the
 * request in front of it will CREATE an account or merely sign an existing one
 * in. Refusing there refuses both, so a per-IP ACCOUNT-CREATION budget spent by
 * somebody else on that address takes away a returning user's Google sign-in
 * for the rest of the day. The cap bounds mints; it must therefore refuse mints
 * and nothing else, and the only place that distinction exists is step 4 below.
 *
 * WHY THE PASSWORD FORM DID NOT SHOW THE SAME SYMPTOM, which is what made this
 * look like an account-specific problem: `/api/login` (auth-routes.ts) never
 * consults `mintLimiter` at all -- it is not a mint path. Only the Google
 * button was dead, and only from that address.
 *
 * THE COST OF MOVING IT, recorded because the old comment named it as the
 * reason for the old position: a caller who WILL be refused now costs us one
 * outbound round trip to Google's key endpoint before we say so. That is real
 * and it is accepted -- the alternative was paying for it with sign-ins that
 * should have succeeded. The two cheap IP-only brakes that ARE safe to hold at
 * the door (the 5/10-min burst window and the global surge gate) are untouched
 * and still run first, so this route is not newly unthrottled: an address that
 * wants to spend our round trips still gets five of them per ten minutes.
 */
class GoogleMintCapError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`this address is past its daily account cap (retry_after_ms=${retryAfterMs})`);
    this.name = 'GoogleMintCapError';
  }
}

export interface GoogleAuthRoutesDeps {
  /** The SAME AuthService instance every other account surface mints and
   *  verifies with — a second one would be a second answer to "what is a
   *  session here". */
  service: AuthService;
  /** The account rows. Needs the Google lookup, the bind and the insert; handed
   *  over whole like `console`'s `users`, because all three are on it. */
  users: UserRepo;
  /**
   * The email-verification store, sliced to its ONE write method.
   *
   * 🔴 THIS ROUTE MUST NOT BE A SECOND WRITER OF `users.email_verified_at`. The
   * column has exactly one writer outside the migration (`markVerified`), whose
   * SQL carries the "first verification wins" rule in its WHERE clause; a second
   * UPDATE written here would be a second place that rule could be forgotten.
   */
  verifiedEmail: Pick<EmailVerificationRepo, 'markVerified'>;
  /** The SHARED per-IP sliding window `/api/register` and `/api/login` already
   *  use. Deliberately not a bucket of its own: a third door into the same
   *  account layer with its own budget is a third door an attacker gets to knock
   *  on for free. */
  limiter: RegisterRateLimiter;
  /**
   * 2026-08-27 batch-2 item 4 — the GLOBAL daily surge gate, THE SAME OBJECT
   * `/api/register` holds (auth/registration-surge.ts).
   *
   * 🔴 THIS ROUTE IS A MINT PATH, AND UNTIL THIS CARD IT WAS NOT COUNTED
   * ANYWHERE. http/auth-routes.ts's header had already written that down as a
   * known hole in the per-IP floor; for an AGGREGATE counter the same hole is
   * strictly worse than under-reporting, because a mint that is not counted is
   * a way to walk the day's total past the threshold while the gate still reads
   * 「calm」 — i.e. the gate's own bypass, reachable by anyone with Google
   * accounts. Closing it is the reason this dep exists.
   *
   * ⚠️ THE COUNT IS NOT THE SAME AS THE GATE. This route is gated on EVERY
   * request once the surge is on, and counts only when `created` — the same
   * split `/api/register` makes between「refuse an attempt」and「record a
   * mint」. A returning Google user signing in on a surging day does have to
   * solve one challenge; that is the cost of not being able to tell「this
   * credential will create an account」from「this one will not」before verifying
   * it, and verifying it first would mean spending our own Google round-trip on
   * every attacker's request.
   *
   * Absent (unit tests that predate the card) ⇒ unchanged behaviour.
   */
  surgeGate?: RegistrationSurgeGate;
  /**
   * P2-5 (2026-09-01 audit) — the SAME per-IP DAILY mint cap `/api/register`
   * holds (`AuthRoutesDeps.mintLimiter`, auth/register-rate-limit.ts).
   *
   * 🔴 THIS ROUTE IS A MINT PATH TWICE OVER: it was already the surge gate's
   * own bypass (the field above closes that), and it was ALSO the per-IP
   * daily-cap's bypass — an address that spent its two register-route mints
   * could keep minting accounts through Google all day, on a budget that read
   * as untouched.
   *
   * 🔴 IT IS NOT THE SAME SPLIT AS THE SURGE GATE, AND THE DIFFERENCE COST US A
   * PRODUCTION LOCKOUT (2026-09-07 — see `GoogleMintCapError`). The surge gate
   * may fairly gate EVERY request, because what it imposes is a CHALLENGE that
   * a real person passes. This cap imposes a 24-hour hard refusal, so gating
   * every request means refusing sign-ins by accounts that already exist. It is
   * now checked and recorded at the SAME point: the mint itself.
   *
   * Absent (unit tests that predate the card, or a deployment with no cap
   * configured) ⇒ unchanged behaviour — the account layer is not gated by
   * something that does not exist.
   */
  mintLimiter?: RegisterRateLimiter;
  /**
   * The token verifier. REQUIRED, and never nullable.
   *
   * An unconfigured deployment passes the LOUD unconfigured verifier
   * (auth/google-id-token.ts), which rejects by name — not a null, and above all
   * not a permissive default. See that module's header: on this surface a
   * friendly DI default is an authentication bypass.
   */
  verifier: GoogleIdTokenVerifier;
  /** The same seeding hook `/api/register` runs, so an account minted here can
   *  transcribe on its FIRST session rather than after the next server restart.
   *  Absent (unit tests) ⇒ creation is unchanged. */
  onUserCreated?: (userId: string) => void;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  // 🔴 THERE IS DELIBERATELY NO `siteCounts` HERE, AND IT IS MARKED RATHER THAN
  // LEFT AS AN ABSENCE — an absence is exactly what a later reader would "fix".
  // `/api/register` and `/api/login` bump `register_ok` / `login_ok` for the
  // first-party site funnel; this route does not, so from 2026-08-27 those two
  // numbers mean "conversions THROUGH THE PASSWORD FORMS" and no longer "all
  // conversions". That is a known, recorded under-count and NOT a claim that
  // Google sign-ins do not happen. Wiring it is a one-line dep — the reason it
  // is not done here is that card NR-1 did not ask for it, and quietly changing
  // what an operator's two existing numbers count is a worse default than
  // leaving them counting what they have always counted. Whoever adds it must
  // decide FIRST which of the two kinds a Google sign-in that minted an account
  // is (it is both, on one request), because that is the question this route
  // makes newly ambiguous.
}

/** Everything the route needs to know about what it just did, so the four
 *  outcomes are decided in one function and rendered in another. */
interface Resolution {
  user: UserRecord;
  /** true = this sign-in minted the account. */
  created: boolean;
  /** true = an existing password account has just had this Google identity
   *  attached to it. */
  bound: boolean;
  /** true = Google's `email_verified` opened our gate on this request. */
  verifiedNow: boolean;
}

/** A display name for a brand-new row: what Google says, else the local part of
 *  the address, else the column default. NOT the whole address — the console
 *  greets people by this string, and "you@company.com" as a name is the shape of
 *  a field nobody filled in. */
function displayNameFor(identity: GoogleIdentity): string | undefined {
  const fromToken = identity.name?.trim();
  if (fromToken) return fromToken;
  const local = identity.email?.split('@')[0]?.trim();
  return local && local !== '' ? local : undefined;
}

/**
 * Turn a verified Google identity into the FlowMic account it belongs to.
 *
 * 🔴 EVERY STEP HERE IS SYNCHRONOUS, AND THAT IS THE CONCURRENCY ARGUMENT. The
 * lookup that says "no account carries this sub" and the write that binds it are
 * not separated by an `await`, so nothing can interleave between them on this
 * single-threaded runtime. The database's partial UNIQUE index is still what
 * GUARANTEES the answer is unique (a guarantee that survives a second process);
 * this ordering is what keeps the guarantee from ever having to fire.
 */
function resolveAccount(
  deps: GoogleAuthRoutesDeps,
  identity: GoogleIdentity,
  nowMs: number,
  /** Called at step 4 and ONLY at step 4 -- the single line in this file that
   *  creates an account. Throws {@link GoogleMintCapError} when the caller's
   *  address has no daily slot left. Synchronous, so it does not open a gap
   *  between the lookup above and the insert below (see this function's
   *  concurrency argument). Absent in the unit tests that predate the cap. */
  mintGuard?: () => void,
): Resolution {
  // ① The stable identity. Every sign-in after the first lands here.
  const byGoogle = deps.users.findByGoogleSub(identity.sub);
  if (byGoogle) return applyGoogleVerification(deps, byGoogle, identity, nowMs, { created: false, bound: false });

  // ② A FIRST binding needs an address Google vouches for, and this gate covers
  // BOTH remaining steps — the match below and the creation after it.
  //
  // 🔴 IT IS CHECKED HERE AND NOT IN THE VERIFIER because it is an
  // AUTHORIZATION decision, not a token-validity one: the token is perfectly
  // genuine. And it guards the CREATE as well as the MATCH, which is the half
  // that is easy to get wrong — matching on an unverified address is an account
  // takeover, and creating on one silently collides with the row it just refused
  // to match (or mints an addressless account). See GOOGLE_EMAIL_UNVERIFIED.
  //
  // ⚠️ Reached only on a FIRST sign-in: step ① returned already for any account
  // that carries this `sub`, so a binding once established is never re-judged by
  // a later token's claims.
  const email = identity.email;
  if (!email || !identity.emailVerified) {
    throw new GoogleEmailUnverifiedError(
      `google sub ${identity.sub} has no verified email claim (email=${email === null ? 'absent' : 'present'}, verified=${String(identity.emailVerified)})`,
    );
  }

  // ③ Does this address already have a FlowMic account? Without this step, a
  // person who registered with a password and later clicks the Google button
  // gets a SECOND, empty account carrying their own address — and the two are
  // indistinguishable on the sign-in screen.
  const byEmail = deps.users.findByEmail(email);
  if (byEmail) {
    deps.users.bindGoogleSub(byEmail.id, identity.sub);
    const rebound = deps.users.findById(byEmail.id);
    if (rebound) return applyGoogleVerification(deps, rebound, identity, nowMs, { created: false, bound: true });
  }

  // ④ Nobody: mint the account. THIS is the account creation the per-IP daily
  // cap exists to bound, so this is where it is asked -- after both lookups
  // above have failed to find an existing account, which is the only moment
  // "this request will create an account" is a fact rather than a guess.
  mintGuard?.();
  // `password_hash` stays NULL — the schema has
  // always allowed a password-less row, and `verifyCredentials` refuses one
  // outright, so a Google-only account cannot be signed into with a blank
  // password. Such a person can still SET a password later through the ordinary
  // forgot-password flow, which needs only a mailbox.
  const created = deps.users.insert({
    id: randomUUID(),
    email,
    password_hash: null,
    plan: 'free',
    google_sub: identity.sub,
    ...(displayNameFor(identity) ? { display_name: displayNameFor(identity) as string } : {}),
  });
  deps.onUserCreated?.(created.id);
  return applyGoogleVerification(deps, created, identity, nowMs, { created: true, bound: false });
}

/**
 * NR-1's operational payoff: a Google user never meets the email-verification
 * gate.
 *
 * The gate exists because a self-declared address proves nothing (owner ruling
 * docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md).
 * When Google says `email_verified: true` it is asserting the same fact the
 * 6-digit code exists to establish — the person controls that mailbox — and it
 * is asserting it about an address Google itself administers. Making that person
 * fetch a code from the same mailbox would be asking them to prove twice, and it
 * costs a registration step at exactly the moment conversions are lost.
 *
 * ⚠️ IT IS AN OPENING AND NEVER A CLOSING. There is no branch here that CLEARS
 * `email_verified_at`: an unverified Google address leaves an
 * already-verified FlowMic account exactly as it was. `markVerified`'s own SQL
 * ("first verification wins") means an earlier stamp is never moved either.
 */
function applyGoogleVerification(
  deps: GoogleAuthRoutesDeps,
  user: UserRecord,
  identity: GoogleIdentity,
  nowMs: number,
  flags: { created: boolean; bound: boolean },
): Resolution {
  if (!identity.emailVerified || user.email_verified_at !== null) {
    return { user, created: flags.created, bound: flags.bound, verifiedNow: false };
  }
  const changed = deps.verifiedEmail.markVerified(user.id, nowMs);
  // Re-read rather than patching the record in memory: the row is the truth, and
  // a hand-assembled copy is how the response and the database start disagreeing
  // about what just happened.
  const fresh = deps.users.findById(user.id) ?? user;
  return { user: fresh, created: flags.created, bound: flags.bound, verifiedNow: changed };
}

/** Handle POST /api/auth/google. Returns true iff it owned the request. Any
 *  other method on the path falls through to the router's 404. */
export function tryHandleGoogleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GoogleAuthRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  if (url !== GOOGLE_LOGIN_PATH || (req.method ?? 'GET') !== 'POST') return false;

  void (async (): Promise<void> => {
    const now = deps.now ?? Date.now;
    // The shared per-IP window, keyed by the SAME derivation its two siblings
    // use (http/trusted-proxy.ts — behind nginx every peer is 127.0.0.1, so the
    // client comes from the trusted proxy's X-Forwarded-For). Re-deriving it
    // here with a second rule would give this door a different notion of "who
    // is knocking" than the two next to it, and the shared bucket would then be
    // counting two different things.
    // The refusal reuses `/api/register`'s REGISTER_RATE_LIMITED verbatim
    // BECAUSE IT IS THE SAME BUDGET — a second name for one window would read
    // as a second window.
    const ip = clientIpFromRequest(req);
    if (!deps.limiter.check(ip).allowed) {
      return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
    }
    deps.limiter.record(ip);

    // P2-5 — the SAME per-IP daily mint cap /api/register enforces is NOT asked
    // here. It is asked at the one place that creates an account, from inside
    // `resolveAccount`; the full argument (and the production lockout that made
    // it necessary) is at `GoogleMintCapError`.

    const body = await readJsonBody(req);
    // 2026-08-27 batch-2 item 4 — the GLOBAL surge gate, the SAME function
    // /api/register runs, on the SAME counter. Placed BEFORE the credential is
    // verified: verifying first would mean spending an outbound round trip to
    // Google's key endpoint on every request during exactly the period we are
    // trying to make expensive for the caller and cheap for us.
    const surge = await guardRegistrationSurge(deps.surgeGate, str(body.captcha_token), ip, 'google');
    if (!surge.ok) return sendJson(res, surge.status, surge.body);

    const credential = str(body.credential);
    if (credential === '') {
      // A missing field is not a "server error" and not a mystery: it is the
      // same answer a garbage token gets, because from here they are the same
      // fact — we were not handed something Google signed.
      return sendJson(res, 400, { error: GOOGLE_TOKEN_INVALID });
    }

    let identity: GoogleIdentity;
    try {
      identity = await deps.verifier.verify(credential);
    } catch (err) {
      if (err instanceof GoogleLoginNotConfiguredError) {
        // 503, and the log line names the env var — the operator reading it can
        // act, and the user is not sent off to debug their own Google account.
        log.error('google login: refused, this deployment has no client id', {
          env: 'FLOWMIC_GOOGLE_CLIENT_ID',
          verifier: deps.verifier.id,
        });
        return sendJson(res, 503, { error: GOOGLE_LOGIN_NOT_CONFIGURED });
      }
      if (err instanceof GoogleTokenError) {
        // The reason string goes to the operator log and NOT onto the wire: an
        // anonymous caller learning exactly which check failed is being handed a
        // tuning signal for the next attempt.
        log.warn('google login: credential refused', { code: err.code, reason: err.message });
        return sendJson(res, 401, { error: err.code });
      }
      // Neither: the key endpoint was unreachable, or its answer was nonsense.
      // 🔴 THIS MUST NOT BE REPORTED AS AN INVALID TOKEN. The credential may
      // well be perfect; we could not check it. Telling the user their token is
      // bad here is the "no silent failure" red line in its second direction —
      // not swallowing a failure, but describing it as somebody else's.
      log.error('google login: could not verify (our side failed)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return sendJson(res, 502, { error: GOOGLE_LOGIN_FAILED });
    }

    let resolution: Resolution;
    try {
      resolution = resolveAccount(deps, identity, now(), () => {
        const dailyMint = deps.mintLimiter?.check(ip);
        if (dailyMint && !dailyMint.allowed) throw new GoogleMintCapError(dailyMint.retryAfterMs);
      });
    } catch (err) {
      if (err instanceof GoogleMintCapError) {
        // Byte-for-byte `/api/register`'s refusal, because it IS that refusal:
        // one budget, one answer. The log line is the same sentence too, so an
        // operator grepping for the cap finds both doors.
        log.warn('google login: account creation refused — this address is past its daily account cap', {
          ip,
          retry_after_ms: err.retryAfterMs,
        });
        return sendJson(res, 429, { error: 'REGISTER_RATE_LIMITED', retry_after_ms: err.retryAfterMs });
      }
      if (err instanceof GoogleEmailUnverifiedError) {
        // Genuine token, unusable identity. 403 rather than 401: the credential
        // was accepted, the account it points at is the thing we will not open.
        log.warn('google login: refused, no verified email claim', { reason: err.message });
        return sendJson(res, 403, { error: GOOGLE_EMAIL_UNVERIFIED });
      }
      // The only other typed failure reachable here is the partial UNIQUE index
      // firing under a race the synchronous resolution above is designed to
      // exclude. Named honestly rather than dressed up as a bad credential; the
      // detail stays in the operator log, because this route is
      // anonymous-reachable and sqlite text is fingerprinting material
      // (auth-routes.ts fix-011).
      log.error('google login: account resolution failed', {
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof UserConstraintError ? { field: err.field } : {}),
      });
      return sendJson(res, 500, { error: GOOGLE_LOGIN_FAILED });
    }

    // LOGIN-1 — SIGN-IN #4. A credential was presented (Google's, verified
    // against Google's keys), and a session was minted: the same event
    // /api/login records, so it is recorded the same way. `recordSignIn` is
    // called AFTER the token exists, so nothing is stamped for a sign-in that
    // did not complete, and it never throws (its own contract) so it cannot turn
    // this 200 into a 500. No-op unless FLOWMIC_LOGIN_RECORD_ENABLED=1.
    //
    // ⚠️ AND IT IS RECORDED EVEN WHEN THIS REQUEST CREATED THE ACCOUNT, which is
    // the OPPOSITE of what /api/register does — deliberately, and the difference
    // is not an inconsistency. There, registration and the first sign-in are two
    // separate acts, and stamping the first would destroy the "registered and
    // never came back" distinction. Here they are ONE act: the person did sign
    // in, and there is no later moment to record.
    //
    // 🔴 THE TWO CALLS ARE ADJACENT ON PURPOSE. test/last-login-record.test.ts
    // scans for an `issueToken` site with no `recordSignIn` within a
    // handler-sized window; a long comment wedged between them made this site
    // read as silent (measured — the scan went red before this reflow).
    const issued = deps.service.issueToken(resolution.user);
    deps.service.recordSignIn(resolution.user);

    // 2026-08-27 batch-2 item 4 — count the mint, and ONLY the mint. `created`
    // is the same fact the 201 below is drawn from, so「the day's total」and
    // 「how many 201s this route answered」can never disagree. A sign-in by an
    // existing account is not an account creation and must not push a calm day
    // towards the threshold.
    if (resolution.created) {
      deps.surgeGate?.counter.record();
      // P2-5 — the daily budget is spent HERE, after the account really
      // exists, same reasoning as auth-routes.ts's mintLimiter doc: an
      // attempt that resolved to an existing user's sign-in must not cost
      // that address one of its two daily mints.
      deps.mintLimiter?.record(ip);
    }

    log.info('google login: session issued', {
      user_id: resolution.user.id,
      created: resolution.created,
      bound: resolution.bound,
      verified_now: resolution.verifiedNow,
    });

    // 🔴 THE BODY IS BYTE-FOR-BYTE `/api/login`'s: `{token, user}`, with
    // `publicUser` as the only projection (never `password_hash`, and never the
    // `google_sub` this route just wrote — the console has no question that
    // needs it). The console's Google button therefore reuses `setSession`
    // unchanged; a body shaped even slightly differently here would be a second
    // definition of "a signed-in user" for one button.
    //
    // 201 when the account was minted, 200 otherwise — the same distinction
    // /api/register and /api/login already draw, so a caller that cares can tell
    // "welcome back" from "welcome" without a second field to keep in sync.
    sendJson(res, resolution.created ? 201 : 200, {
      token: issued.token,
      user: deps.service.publicUser(resolution.user),
    });
  })();
  return true;
}
